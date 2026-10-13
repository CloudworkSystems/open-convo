import Foundation

/// Runs durable mutation work off the protocol actor so a second request can
/// be refused while the first is still in flight.
public protocol MutationExecutor: Sendable {
    func run<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T
}

public struct BackgroundMutationExecutor: MutationExecutor {
    public init() {}

    public func run<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        try await Task.detached(priority: .userInitiated) { try work() }.value
    }
}

/// The draft a recording was started for, captured by
/// `DeskHostProtocol.beginRecording` and required again by `deliverFinal`.
/// Final text goes to exactly this binding or nowhere: never to a draft
/// bound later.
public struct CapturedTarget: Equatable, Sendable {
    public let bindingId: UUID
    public let connectionId: String
    public let generation: Int
    /// DeskState session id, case preserved.
    public let sessionId: String
    public let expectedRevision: Int
}

/// Issued at recording start. Carries the captured target (or none), the
/// document generation, and the host lifecycle epoch the recording belongs
/// to. Lock and close revoke every token issued before them.
public struct RecordingToken: Equatable, Sendable {
    public let tokenId: UUID
    public let generation: Int
    public let target: CapturedTarget?
    let lifecycle: Int
}

/// Why a late recorder callback was dropped: nothing was pushed, held or
/// retained.
public enum DropReason: String, Equatable, Sendable {
    /// The token predates a lock or close; every binding and held text of its
    /// time is gone and the text must not come back.
    case revoked
    /// The store is locked or closed right now; nothing may be kept.
    case locked
}

/// What became of final dictation handed to `DeskHostProtocol.deliverFinal`.
public enum FinalDelivery: Equatable, Sendable {
    /// Pushed once to the bound page as `dictation.final`. The host keeps the
    /// text in memory until the page's commit with `dictationDeliveryId` saves it.
    case delivered(deliveryId: UUID, bindingId: UUID, connectionId: String, generation: Int)
    /// Kept natively (see `HeldDelivery.reason`). Never pasted or typed.
    case held(HeldDelivery)
    /// Dropped (see `DropReason`). Nothing was retained.
    case dropped(DropReason)
}

/// What `DeskHostProtocol.recoverUnresolvedDispatch` found.
public enum DispatchRecovery: Equatable, Sendable {
    /// No request holds the barrier.
    case nothingOutstanding
    /// The holder's store work is still running; its outcome is being decided.
    case inFlight(UUID)
    /// The holder has a durable terminal result that its still-valid
    /// connection has not acknowledged (or one not yet provably durable).
    /// `workspace.reconcile` or an exact re-send releases that; a holder
    /// whose connection is gone is released before this is reported.
    case awaitingReconcile(UUID)
    /// The holder's receipt had no terminal result on disk and was withdrawn
    /// (or was already gone): the barrier is free and `workspace.reconcile`
    /// now answers `not-dispatched`.
    case withdrawn(UUID)
}

/// The request handler. One actor per host; the app's message handler decodes
/// nothing itself and hands bytes or a request here. The actor serializes
/// requests, holds the one-per-workspace mutation barrier, and maps every
/// store or binding outcome to a fixed response.
///
/// Barrier rules (agreed October 9, corrected after the Codex review):
/// - A durable mutation (`workspace.commitProof`) takes the barrier before
///   its dispatch receipt is written, so no second mutation can slip in
///   between the receipt and the barrier. Any other durable mutation
///   meanwhile is refused `mutation-outstanding`, whichever connection sends
///   it. The ephemeral `dictation.bindDraft` and `dictation.unbindDraft` are
///   not gated by the barrier: a binding captures its expected revision, and
///   a stale one is caught by the commit that names its delivery.
/// - The holder's own id is never another mutation. Its exact bytes get
///   `unknown` while the outcome is undecided (in flight, or a receipt with
///   no result), and replay the one terminal result once there is one; a
///   different payload under that id, on any operation, is refused
///   `payload-mismatch`. A terminal refusal is never claimed for the holder.
/// - The barrier is released when the terminal result reaches a still-valid
///   connection: as the original reply, as the replay of an exact re-send,
///   or through `workspace.reconcile`. If the connection was locked or
///   revoked after the result became durable, the reply is `unknown` and the
///   barrier stays until a fresh document joins (`issueConnection`), explicit
///   recovery runs, or another durable mutation arrives: the revoked document
///   dropped the request, so that result is owed to no one, and the orphaned
///   barrier is released then (`releaseOrphanedBarrier`) exactly as a restart
///   would drop it; the ledger still answers the id truthfully. A failure
///   before the receipt was written, or one that withdrew the receipt, is
///   refused with the barrier free whatever the connection's state: nothing
///   was dispatched, and `reconcile` answers `not-dispatched`. `unknown`
///   from a mutation therefore always means the barrier is held.
///   `workspace.read` answers `unknown` only while a visible replacement is
///   not yet confirmed durable, so a page never marks that record saved.
/// - After a restart the barrier is rebuilt from the receipt log: a receipt
///   without a result (a crash in flight, or a write failure whose receipt
///   could not be withdrawn) restores its holder. A result that was durable
///   but never acknowledged does not survive a restart as a barrier; the
///   revision compare-and-commit refuses a stale re-send and an exact
///   re-send replays its one result, so nothing is lost or doubled.
/// - A receipt-only holder stays `unknown` to `reconcile` until explicit
///   recovery (`recoverUnresolvedDispatch`), which is the app host's call,
///   never the page's. Recovery decides from the store's folder, never from
///   cached memory.
/// - There is no transparent retry: nothing is ever executed twice. After
///   `not-dispatched` the same id is a fresh mutation. Terminal results are
///   remembered durably by identity for as long as the store exists, so a
///   changed payload under any known id stays refused.
///
/// Request identity across lanes (participant contract section 3; Codex
/// Q20, Q22): a participant host claims through its configuration's
/// `RequestIdentityIndex`, the one space it shares with the participant
/// lane. It wires the store to report there, takes the barrier through
/// `claimHolder` and each bind or unbind id through `claimEphemeral`, each
/// before any await and atomically against a start's claim, and releases
/// them as it releases its own. Every host also reads the store's published
/// start reservations (Codex Q5's overlay); a v1 host has no index and reads
/// only those. They hold nothing for a store without runs, so a host
/// without participants answers as before.
public actor DeskHostProtocol {
    private struct Holder: Equatable {
        let requestId: UUID
        let payloadHash: String
        /// The connection that dispatched it; nil when restored from a
        /// receipt after a restart.
        let dispatcher: HostConnection?
    }

    private let store: ProofStore
    /// Read by `HostRouter` for the participant lane's v1 preflight, which
    /// never enters this actor.
    nonisolated let connections: ConnectionRegistry
    private let drafts: DraftBindingRegistry
    private let executor: MutationExecutor
    private let info: HostInfo
    private let events: HostEventSink?
    private let clock: @Sendable () -> Date
    /// The participant gate: nil is a v1 host, byte for byte. Nothing in the
    /// app passes one until the page codec for the longer list is bundled.
    private let participants: ParticipantHostConfiguration?
    /// Whether this host decodes `participant.*`: true exactly when it was
    /// built with `participants`. The one switch every decoder reads, the
    /// byte path here and the WebKit object path alike, so capabilities and
    /// both transports can never disagree.
    public nonisolated let acceptsParticipant: Bool
    /// The participant configuration's identity space; nil on a v1 host.
    private let identities: RequestIdentityIndex?
    /// The request holding the workspace barrier, with its payload hash: in
    /// flight, finished without a connection to answer, or restored from a
    /// receipt-only entry.
    private var holder: Holder?
    /// The request whose store work is running on the executor right now.
    /// Recovery refuses while this is set: the outcome is still being decided.
    private var inFlight: UUID?
    /// Counts lock and close. A recording token from an earlier epoch is
    /// revoked: its late text is dropped, never held or delivered.
    private var lifecycle = 0
    private var closed = false
    /// Per-generation results of bind and unbind, so an exact retry returns
    /// the same binding id and a reused id is caught as a changed payload.
    /// Bounded like the ledger: the oldest entry is forgotten past capacity.
    private var ephemeralReplays: [UUID: ReplayEntry] = [:]
    private var ephemeralOrder: [UUID] = []

    /// `events` may be nil only for a read-only host: without a sink nothing
    /// can be pushed, so `deliverFinal` holds the text instead of consuming
    /// the binding, and lifecycle events go nowhere. `participants` makes a
    /// participant host: capabilities lists the twelve operations, and the
    /// byte path and the WebKit object path decode `participant.*`.
    public init(store: ProofStore, connections: ConnectionRegistry, drafts: DraftBindingRegistry, info: HostInfo,
                events: HostEventSink? = nil, executor: MutationExecutor = BackgroundMutationExecutor(),
                clock: @escaping @Sendable () -> Date = { Date() }, participants: ParticipantHostConfiguration? = nil) {
        self.store = store
        self.connections = connections
        self.drafts = drafts
        self.info = info
        self.events = events
        self.executor = executor
        self.clock = clock
        self.participants = participants
        self.acceptsParticipant = participants != nil
        let identities = participants?.identities
        self.identities = identities
        // The store reports first, so the index knows every stored id
        // before this host claims anything through it.
        if let identities { store.setIdentityObserver(identities) }
        if let restored = store.unresolvedDispatch, let receipt = try? store.dispatchReceipt(for: restored) {
            holder = Holder(requestId: restored, payloadHash: receipt.payloadHash, dispatcher: nil)
            // A receipt's id is never a start's (section 15's load
            // invariants), so this claim holds; the receipt reserves it too.
            _ = identities?.claimHolder(restored)
        }
    }

    // MARK: Host lifecycle

    /// Whether `id` is a live connection of the current generation, as v1's
    /// preflight checks it, read without entering this actor. The WebKit
    /// glue reads it on the main thread when an answer is ready (stale-reply
    /// suppression, participant contract section 3, S11): a reply to a
    /// request admitted on a connection that is no longer valid is not
    /// delivered.
    public nonisolated func checkConnection(_ id: String, generation: Int) -> ConnectionCheck {
        connections.check(id, generation: generation)
    }

    /// The request holding the workspace barrier, if any.
    public var outstandingMutation: UUID? { holder?.requestId }

    /// Whether this is a participant host over exactly `store` and
    /// `connections`, built with `configuration`: the same identity space
    /// (`===`, so both lanes claim through one index: Codex Q20, Q22) and
    /// the same pin and input bound. The participant lane checks this when
    /// it attaches a Desk stack, so it never answers beside a host that
    /// claims through another index or checks another pin. False for a v1
    /// host.
    public nonisolated func isParticipantHost(store: ProofStore, connections: ConnectionRegistry,
                                              configuration: ParticipantHostConfiguration) -> Bool {
        guard let participants else { return false }
        return self.store === store && self.connections === connections
            && participants.identities === configuration.identities && participants == configuration
    }

    /// Explicit invented-store recovery, for the app host only (there is no
    /// page operation for it). A dispatch receipt with no terminal result
    /// holds the barrier and stays `unknown` to `workspace.reconcile`: after
    /// a crash in flight, or a write failure whose receipt could not be
    /// withdrawn. An orphaned barrier (durable result, dispatching connection
    /// revoked) is released first. Otherwise the store re-reads its folder
    /// before deciding: a result on disk means the commit applied and the
    /// barrier waits for the page that can still ask for it
    /// (`awaitingReconcile`); a receipt with no result proves nothing applied,
    /// the store withdraws it and the barrier is released, so the page's next
    /// `reconcile` for that id answers `not-dispatched` and it may resend.
    /// Nothing is touched while the holder's work is running. Throws when the
    /// store refuses (locked, closed, missing, corrupt, or the withdrawal
    /// write fails); the barrier then stays.
    public func recoverUnresolvedDispatch() throws -> DispatchRecovery {
        releaseOrphanedBarrier()
        forgetSavedWords()
        guard let holder else { return .nothingOutstanding }
        if inFlight == holder.requestId { return .inFlight(holder.requestId) }
        switch try store.withdrawUnresolvedDispatch(holder.requestId) {
        case .alreadyResolved:
            return .awaitingReconcile(holder.requestId)
        case .withdrawn, .nothingToWithdraw:
            releaseBarrier(holder.requestId)
            return .withdrawn(holder.requestId)
        }
    }

    /// Called by the app host after it verified its own webview, frame and
    /// origin. The id is the only thing that establishes native trust. Pushes
    /// `host.connection` `ready` for the new connection.
    public func issueConnection() -> HostConnection {
        releaseOrphanedBarrier()
        forgetSavedWords()
        let connection = connections.issue()
        push(.hostConnection(connectionId: connection.id, generation: connection.generation, state: .ready, reason: .ready))
        return connection
    }

    /// `issueConnection()` with a caller-chosen id, for the shared vectors'
    /// `issue-connection` action (contract section 19): the fixed id a case
    /// names is registered in the current generation and `ready` pushed for
    /// it. Reachable only through `@testable import`; the app host only
    /// ever uses `issueConnection()`.
    @discardableResult
    func issueConnection(adopting id: String) -> HostConnection {
        releaseOrphanedBarrier()
        let connection = connections.adopt(id: id)
        push(.hostConnection(connectionId: connection.id, generation: connection.generation, state: .ready, reason: .ready))
        return connection
    }

    /// Navigation or reload: a new document generation. Earlier envelopes are
    /// stale; earlier connections, bindings, pending deliveries and bind
    /// results are gone. Each old connection is told it was revoked. A
    /// recording begun in the old document keeps its token: its final text is
    /// held, never delivered to the new document.
    @discardableResult
    public func beginGeneration() -> Int {
        let old = connections.currentGeneration
        for id in connections.activeConnections {
            push(.hostConnection(connectionId: id, generation: old, state: .revoked, reason: .navigation))
        }
        let generation = connections.advanceGeneration()
        drafts.invalidate(generationsBefore: generation)
        forgetEphemerals()
        return generation
    }

    /// Lock: every connection, binding, pending delivery and held text is
    /// dropped, every recording token is revoked, and the store refuses
    /// reads and writes. In-flight mutations finish as `unknown` with the
    /// barrier held; once their result is durable that barrier is orphaned
    /// and released when a fresh document joins (`releaseOrphanedBarrier`).
    public func lock() {
        revokeAll(state: .locked, reason: .lock)
        store.lockStore()
    }

    /// Verified unlock is the app host's job; this only reopens the store.
    /// Connections are not restored and no `ready` is pushed to an old one:
    /// unlock requires a fresh document and bootstrap, then `issueConnection`.
    /// Tokens revoked by the lock stay revoked.
    public func unlock() {
        store.unlockStore()
    }

    /// Window close or quit: `revokeForShutdown()`, then `closeStore()`.
    /// Unchanged for every existing caller. A participant host's app calls
    /// the two halves itself, in the contract's order (section 14, S10
    /// reading 1): the lane's `beginShutdown(quitting:)` first (its push
    /// suspension must come before `revoked`), then `revokeForShutdown()`,
    /// the lane's `finishShutdown(quitting:)` (it stops every group and
    /// writes their terminals), `closeStore()`, and the lane's detach.
    public func close() {
        revokeForShutdown()
        closeStore()
    }

    /// The first half of `close()`: every connection is told `revoked`
    /// (`shutdown`) and invalidated, every binding, pending delivery and
    /// held text dropped, every recording token revoked, and no recording
    /// is taken from here. The store stays open, so the participant lane
    /// can still write its terminals before `closeStore()`.
    public func revokeForShutdown() {
        revokeAll(state: .revoked, reason: .shutdown)
        closed = true
    }

    /// The second half of `close()`: the store is locked and closed (its
    /// writer lock released), never to be used again.
    public func closeStore() {
        store.lockStore()
        store.close()
    }

    private func revokeAll(state: HostConnectionState, reason: HostConnectionReason) {
        let generation = connections.currentGeneration
        for id in connections.activeConnections {
            push(.hostConnection(connectionId: id, generation: generation, state: state, reason: reason))
        }
        connections.invalidateAll()
        drafts.invalidateAll(keepingWords: state == .locked)
        forgetEphemerals()
        lifecycle += 1
    }

    private func push(_ event: HostEvent) {
        events?.push(event)
    }

    // MARK: Host-pushed dictation

    /// Recording start. Captures the draft that is bound right now (the
    /// newest undelivered binding of the current document, on a valid
    /// connection), or none. The token must come back with the final text.
    /// A recording started while the host is locked or closed gets a token
    /// that is revoked from the start: its text is dropped whenever it comes.
    public func beginRecording() -> RecordingToken {
        let generation = connections.currentGeneration
        guard !closed, !store.isLocked else {
            return RecordingToken(tokenId: UUID(), generation: generation, target: nil, lifecycle: Self.revokedLifecycle)
        }
        var target: CapturedTarget?
        if let binding = drafts.currentBinding(generation: generation),
           connections.check(binding.connectionId, generation: generation) == .valid {
            target = CapturedTarget(bindingId: binding.bindingId, connectionId: binding.connectionId, generation: generation,
                                    sessionId: binding.target.sessionId, expectedRevision: binding.target.expectedRevision)
        }
        return RecordingToken(tokenId: UUID(), generation: generation, target: target, lifecycle: lifecycle)
    }

    /// Never equal to a live epoch.
    private static let revokedLifecycle = -1

    /// Final dictation from the native recorder, for the recording `token`
    /// names. After close the text is dropped. After a lock (now, or since
    /// the recording began) it is held in memory for the owner. Otherwise the
    /// text goes to the captured binding only: if that binding is still
    /// present, undelivered, on its own valid connection in its own document,
    /// the delivery is recorded durably (identities only), the text is kept
    /// in memory until its commit is confirmed, and it is pushed once as
    /// `dictation.final`. If no draft was bound
    /// at recording start, or the captured one was unbound, consumed, or its
    /// connection or document changed, the text is held natively and
    /// surfaced through `DraftBindingRegistry.heldDeliveries`; it is never
    /// retargeted to a draft bound later, never pasted or typed. Without an
    /// event sink nothing can be pushed, so the text is held and the binding
    /// is left untouched.
    public func deliverFinal(_ token: RecordingToken, text: String) -> FinalDelivery {
        // Close drops everything. A lock (now, or since the recording began)
        // keeps the owner's words as held text in memory (owner decision A).
        if closed { return .dropped(.revoked) }
        let now = clock()
        if token.lifecycle != lifecycle || store.isLocked { return hold(text, for: token, reason: .locked, at: now) }
        guard text.utf8.count <= ProofLimits.textItemBytes else { return hold(text, for: token, reason: .textTooLarge, at: now) }
        guard let target = token.target else { return hold(text, for: token, reason: .noBinding, at: now) }
        let generation = connections.currentGeneration
        guard target.generation == generation, connections.check(target.connectionId, generation: generation) == .valid,
              let binding = drafts.binding(target.bindingId), binding.deliveryId == nil,
              binding.connectionId == target.connectionId, binding.generation == target.generation,
              binding.target.sessionId == target.sessionId, binding.target.expectedRevision == target.expectedRevision else {
            return hold(text, for: token, reason: .targetChanged, at: now)
        }
        guard let events else { return hold(text, for: token, reason: .noEventSink, at: now) }
        let deliveryId = drafts.makeDeliveryId()
        let record = DeliveryRecord(deliveryId: deliveryId, bindingId: binding.bindingId, connectionId: binding.connectionId,
                                    generation: generation, sessionId: binding.target.sessionId,
                                    expectedRevision: binding.target.expectedRevision, pushedAt: now)
        do {
            try store.recordPendingDelivery(record)
        } catch {
            return hold(text, for: token, reason: .storeUnavailable, at: now)
        }
        let pending = PendingDelivery(deliveryId: deliveryId, bindingId: binding.bindingId, connectionId: binding.connectionId,
                                      generation: generation, target: binding.target, pushedAt: now)
        guard drafts.reservePending(pending) else { return hold(text, for: token, reason: .targetChanged, at: now) }
        // Kept in memory until the page's commit is confirmed; set aside as held
        // if the binding is released, its document goes, or the Desk locks first.
        drafts.retainUntilSaved(HeldDelivery(deliveryId: deliveryId, generation: generation, reason: .notSaved, text: text, heldAt: now))
        events.push(.dictationFinal(connectionId: binding.connectionId, generation: generation, bindingId: binding.bindingId,
                                    deliveryId: deliveryId, text: text))
        return .delivered(deliveryId: deliveryId, bindingId: binding.bindingId, connectionId: binding.connectionId, generation: generation)
    }

    /// Held text is memory the host keeps for the owner, through a lock;
    /// never after close, and never on disk.
    private func hold(_ text: String, for token: RecordingToken, reason: HeldReason, at now: Date) -> FinalDelivery {
        if closed { return .dropped(.revoked) }
        let held = HeldDelivery(deliveryId: drafts.makeDeliveryId(), generation: token.generation, reason: reason, text: text, heldAt: now)
        drafts.hold(held)
        return .held(held)
    }

    // MARK: Requests

    public func handle(data: Data) async -> HostResponse {
        let request: HostRequest
        do {
            request = try HostRequest.decode(data, acceptsParticipant: acceptsParticipant)
        } catch let rejection as HostRequestRejection {
            return .refused(rejection.refusal, echo: rejection.echo)
        } catch {
            return .refused(.malformedEnvelope, echo: HostEcho())
        }
        return await handle(request)
    }

    /// The typed path. `handle(data:)` enforces `ProofLimits.envelopeBytes`
    /// on the bytes it receives; a caller handing over a decoded request is
    /// trusted for that one limit. Text-item and record limits are enforced
    /// here either way.
    public func handle(_ request: HostRequest) async -> HostResponse {
        let echo = request.echo
        // A host without participants knows no participant name, so a typed
        // one is refused first, as the byte path refuses it while decoding:
        // never a connection or payload answer that would show it was read.
        if !acceptsParticipant, request.operation.isParticipant { return .refused(.unknownOperation, echo: echo) }
        if let refusal = HostPreflight.check(request, connections: connections) { return .refused(refusal, echo: echo) }
        switch request.operation {
        case .capabilities: return capabilities(request)
        case .workspaceRead: return read(request)
        case .workspaceCommitProof: return await commit(request)
        case .workspaceReconcile: return reconcile(request)
        case .dictationBindDraft: return bind(request)
        case .dictationUnbindDraft: return unbind(request)
        case .dictationReceipt: return receipt(request)
        // `HostRouter` hands the participant lane to its own handler before
        // this actor, so it never waits behind the store lock or the
        // barrier. Reaching here is a routing mistake: answer as an unknown
        // name.
        case .participantAvailability, .participantStart, .participantStop, .participantStatus, .participantEvents:
            return .refused(.unknownOperation, echo: echo)
        }
    }

    // MARK: Operations

    private func capabilities(_ request: HostRequest) -> HostResponse {
        let echo = request.echo
        guard request.payload.isEmpty else { return .refused(.unknownField, echo: echo) }
        return .ok(echo, ["capabilities": .object([
            "contractVersion": .number(Double(DeskHost.protocolVersion)),
            "hostBuild": .string(info.hostBuild),
            "appVersion": .string(info.appVersion),
            "store": .string(store.status.rawValue),
            "lock": .string(store.isLocked ? "locked" : "unlocked"),
            "operations": .array((acceptsParticipant ? HostOperation.participantAdvertised : HostOperation.advertised)
                .map { .string($0.rawValue) }),
            "workspaceHandle": .string(store.workspaceHandle),
            "limits": ProofLimits.capabilitiesValue
        ])])
    }

    /// The one answer a page may mark its workspace saved from (the pinned
    /// renderer marks every ready initial load saved), so the record is
    /// confirmed first: `ProofStore.read()` retries a folder flush that
    /// failed after a visible replacement and refuses while it keeps
    /// failing. That reply is `unknown` (base fields only), never ok: the
    /// visible newer record stays on disk for recovery, nothing older is
    /// restored and nothing is regenerated. The pinned client treats an
    /// `unknown` read as unavailable, never as loaded, and reads again
    /// later. `host.capabilities` serves no record and keeps its
    /// codec-pinned store status (October 9 recheck, R2).
    private func read(_ request: HostRequest) -> HostResponse {
        let echo = request.echo
        guard let fields = PayloadFields(request.payload, allowed: ["workspaceHandle"]) else { return .refused(.unknownField, echo: echo) }
        if let refusal = checkHandle(fields) { return .refused(refusal, echo: echo) }
        do {
            let workspace = try store.read()
            return .ok(echo, ["record": .object(workspace.record), "revision": .number(Double(workspace.revision))])
        } catch ProofStoreError.replacedUnsynced {
            return .unknown(echo)
        } catch {
            return .refused(Self.refusal(for: error), echo: echo)
        }
    }

    private static let commitKeys: Set<String> = ["workspaceHandle", "expectedRevision", "record", "dictationDeliveryId"]
    /// A participant host also reads `participantRun` (section 6); a host
    /// without participants refuses it as an unknown field, as v1 does.
    private static let participantCommitKeys = commitKeys.union(["participantRun"])

    /// After v1's checks through exact replay (the holder,
    /// `mutation-outstanding` and the durable results), any host refuses a
    /// start's id (section 3, Codex Q22). On a participant host, section 6
    /// then runs before the delivery check (Codex Q6): the claim beside a
    /// delivery, the attempted `conversationRuns` shape, then the claim's
    /// steps 1-7 (`ParticipantPrepare.check`). Steps 8 and 9 run inside the
    /// store's commit, before its dispatch receipt. A participant host then
    /// takes the barrier through its identity index, before the first
    /// await: a start that claimed the id in between makes it
    /// `payload-mismatch`, exactly as if the start had come first.
    private func commit(_ request: HostRequest) async -> HostResponse {
        let echo = request.echo
        guard let fields = PayloadFields(request.payload, allowed: acceptsParticipant ? Self.participantCommitKeys : Self.commitKeys) else {
            return .refused(.unknownField, echo: echo)
        }
        if let refusal = checkHandle(fields) { return .refused(refusal, echo: echo) }
        guard let expectedRevision = fields.safeInteger("expectedRevision") else { return .refused(.invalidRevision, echo: echo) }
        guard let record = fields.object("record") else { return .refused(.malformedEnvelope, echo: echo) }
        guard let recordRevision = record["revision"]?.safeIntegerValue else { return .refused(.invalidRevision, echo: echo) }
        guard recordRevision > expectedRevision else { return .refused(.revisionNotAdvanced, echo: echo) }
        var deliveryId: UUID?
        if fields.has("dictationDeliveryId") {
            guard let id = fields.canonicalUUIDv4("dictationDeliveryId") else { return .refused(.invalidIdentity, echo: echo) }
            deliveryId = id
        }
        guard JSONValue.object(record).canonicalData().count <= ProofLimits.recordBytes else { return .refused(.payloadTooLarge, echo: echo) }

        if let holder, holder.requestId == request.requestId {
            // The holder's own id: never another mutation, never a terminal
            // refusal. Other bytes are a changed payload; the same bytes get
            // the one result once it exists and `unknown` until then.
            guard holder.payloadHash == request.payloadHash else { return .refused(.payloadMismatch, echo: echo) }
            if inFlight == holder.requestId { return .unknown(echo) }
            guard let entry = try? store.terminalResult(for: request.requestId) else { return .unknown(echo) }
            releaseBarrier(request.requestId)
            // An exact resend that finds the result: saved words go too.
            if deliveryId != nil { forgetSavedWords() }
            return Self.response(for: entry, echo: echo)
        }
        releaseOrphanedBarrier()
        guard holder == nil else { return .refused(.mutationOutstanding, echo: echo) }
        if let replayed = replay(ephemeralReplays[request.requestId], for: request) {
            if deliveryId != nil { forgetSavedWords() }
            return replayed
        }
        do {
            if let replayed = replay(try store.terminalResult(for: request.requestId), for: request) {
                if deliveryId != nil { forgetSavedWords() }
                return replayed
            }
        } catch {
            return .refused(Self.refusal(for: error), echo: echo)
        }
        // A start's id, still `starting`, recorded, or reserved because
        // its write is not yet confirmed, is never a workspace mutation
        // (section 3, Codex Q22): after the holder and exact replay, before
        // any new mutation check. The barrier claim below and the store,
        // under its lock, check again.
        if isStartRequestId(request.requestId) { return .refused(.payloadMismatch, echo: echo) }
        var participantCheck: ParticipantCommitCheck?
        if let participants {
            switch ParticipantPrepare.check(record: record, claim: fields.value("participantRun"), hasDeliveryId: fields.has("dictationDeliveryId"),
                                            pin: participants.pin, inputBound: participants.inputBound) {
            case .refused(let reason): return .refused(reason, echo: echo)
            case .passed(let check): participantCheck = check
            }
        }
        if let deliveryId, let refusal = checkDelivery(deliveryId, request: request, expectedRevision: expectedRevision) {
            return .refused(refusal, echo: echo)
        }

        // One atomic step against the start lane (Codex Q22): a start that
        // claimed this id since the check above wins, and nothing is held.
        if let identities, !identities.claimHolder(request.requestId) { return .refused(.payloadMismatch, echo: echo) }
        holder = Holder(requestId: request.requestId, payloadHash: request.payloadHash,
                        dispatcher: HostConnection(id: request.connectionId, generation: request.generation))
        // `holder == nil` can coexist with a stale marker: a `reconcile`
        // released the previous holder, which needs its durable result, so
        // that store work is finished and the marker is taken over here.
        inFlight = request.requestId
        let attempt = CommitAttempt(requestId: request.requestId, payloadHash: request.payloadHash, expectedRevision: expectedRevision,
                                    recordRevision: recordRevision, record: record, deliveryId: deliveryId,
                                    preparedRun: participantCheck?.preparedRun, attemptedRunIds: participantCheck?.attemptedRunIds)
        let store = store
        let now = clock()
        let result: Result<CommitOutcome, Error>
        do {
            result = .success(try await executor.run { try store.commit(attempt, at: now) })
        } catch {
            result = .failure(error)
        }
        // Only this request's own marker. A `reconcile` may already have
        // released this barrier while the executor was returning, and a
        // later mutation may hold the barrier and the marker now; clearing
        // its marker would let recovery withdraw it as never dispatched and
        // admit another mutation behind it (October 9 recheck, R1).
        if inFlight == request.requestId { inFlight = nil }
        let outcome: CommitOutcome
        switch result {
        case .failure(let error):
            // Nothing proven: the receipt stands without a result (or the
            // result is visible but not durable), so the barrier must stand
            // with it until reconciliation or recovery.
            if let storeError = error as? ProofStoreError, case .undetermined = storeError { return .unknown(echo) }
            // Every other store failure happened before dispatch or withdrew
            // its receipt: nothing applied, nothing logged, so the barrier is
            // free and the refusal is terminal whether or not the connection
            // survived. A lost connection learns the same through
            // `not-dispatched`; `unknown` is reserved for a held barrier.
            releaseBarrier(request.requestId)
            return .refused(Self.refusal(for: error), echo: echo)
        case .success(.payloadMismatch):
            // Refused before any write (a durable result under other bytes,
            // or a start's id): nothing applied and no result exists for
            // `releaseOrphanedBarrier` to find, so, like the failures above,
            // the barrier is free and the refusal terminal whether or not the
            // connection survived.
            releaseBarrier(request.requestId)
            return .refused(.payloadMismatch, echo: echo)
        case .success(let proven):
            outcome = proven
        }
        // The words are on disk: whatever happened to the connection while
        // the commit ran (an unbind, navigation or lock may have set them
        // aside), they are never offered again as unsaved.
        if let deliveryId, case .committed = outcome { drafts.completePending(deliveryId) }
        // The result is on disk, but there is no valid connection to tell:
        // the barrier holds until the result reaches one, or until a fresh
        // document, recovery or the next save finds it orphaned.
        guard connections.check(request.connectionId, generation: request.generation) == .valid else { return .unknown(echo) }
        releaseBarrier(request.requestId)
        switch outcome {
        case .committed(let revision):
            if let deliveryId {
                push(.dictationReceipt(connectionId: request.connectionId, generation: request.generation, deliveryId: deliveryId,
                                       commitRequestId: request.requestId, revision: revision))
            }
            return .ok(echo, ["revision": .number(Double(revision))])
        case .conflict(let currentRevision, _):
            return .conflict(echo, currentRevision: currentRevision)
        case .replayed(let entry):
            return Self.response(for: entry, echo: echo)
        case .payloadMismatch:
            // Answered above, before the connection check; kept for the
            // exhaustive switch.
            return .refused(.payloadMismatch, echo: echo)
        }
    }

    /// Only a request's own completion releases its barrier; a reconcile may
    /// already have released it and a later mutation may hold it now.
    private func releaseBarrier(_ requestId: UUID) {
        guard holder?.requestId == requestId else { return }
        holder = nil
        identities?.releaseHolder(requestId)
    }

    /// A holder whose result is durable but whose dispatching connection has
    /// been revoked (lock, navigation, close) is orphaned: that document was
    /// told it is revoked and dropped the request, so its exact re-send can
    /// never arrive, and the pinned page has no `workspace.reconcile` to send.
    /// Holding on would refuse every later save until a restart, and a
    /// restart drops exactly this barrier (only receipt-only ids are
    /// restored), so it is released here at the same safety: the ledger and
    /// identity records answer any later `reconcile` or re-send of the id
    /// truthfully, a changed payload stays refused, and the revision
    /// compare-and-commit refuses a stale save. Nothing is released while
    /// the result is undecided, not provably durable, restored from a
    /// receipt, or still owed to a connection that can ask for it.
    private func releaseOrphanedBarrier() {
        guard let holder, inFlight != holder.requestId, let dispatcher = holder.dispatcher,
              connections.check(dispatcher.id, generation: dispatcher.generation) != .valid,
              (try? store.terminalResult(for: holder.requestId)) != nil else { return }
        self.holder = nil
        identities?.releaseHolder(holder.requestId)
    }

    /// A bind or unbind under the barrier holder's id is a changed payload
    /// (the hash covers the operation); it is never another mutation and
    /// never a terminal claim about the holder.
    private func holderRefusal(for request: HostRequest) -> HostRefusal? {
        guard let holder, holder.requestId == request.requestId else { return nil }
        return .payloadMismatch
    }

    private func rememberEphemeral(_ entry: ReplayEntry) {
        ephemeralReplays[entry.requestId] = entry
        ephemeralOrder.append(entry.requestId)
        if ephemeralOrder.count > store.ledgerCapacity {
            let evicted = ephemeralOrder.removeFirst()
            ephemeralReplays.removeValue(forKey: evicted)
            identities?.forgetEphemerals([evicted])
        }
    }

    private func forgetEphemerals() {
        identities?.forgetEphemerals(ephemeralReplays.keys)
        ephemeralReplays.removeAll()
        ephemeralOrder.removeAll()
    }

    /// Whether the id is a start's (section 3): one the shared index holds
    /// on a participant host (`starting` or recorded), or one the store's
    /// published copy reserves, recorded or unconfirmed. Every host reads
    /// the copy (Codex Q5's overlay): it keeps a reservation that memory no
    /// longer shows after a non-authoritative reload before the host
    /// registered, so such an id never reads as `not-dispatched`. The copy
    /// is empty for a store without runs, and reading it takes only the
    /// store's `snapshotLock`, never its writer lock.
    private func isStartRequestId(_ requestId: UUID) -> Bool {
        if identities?.isStartId(requestId) == true { return true }
        return isPublishedStart(requestId)
    }

    private func isPublishedStart(_ requestId: UUID) -> Bool {
        store.publishedRuns.reservedStartRequestIds.contains(requestId.canonicalString)
    }

    /// A bind or unbind under a start's id is a changed payload (section 3),
    /// checked beside `checkLedgerReuse` and outside the barrier, against
    /// the published reservations on every host. A participant host then
    /// claims the id, atomically against a start's claim (Codex Q22); a
    /// request refused after this releases it.
    private func claimEphemeral(_ request: HostRequest) -> HostRefusal? {
        if isPublishedStart(request.requestId) { return .payloadMismatch }
        guard let identities else { return nil }
        return identities.claimEphemeral(request.requestId) ? nil : .payloadMismatch
    }

    /// A commit that names a delivery must match the delivery the host
    /// pushed: known and unsaved on disk, pending for this connection and
    /// generation, its binding still present, and the binding's captured
    /// revision equal to the commit's expected revision.
    private func checkDelivery(_ deliveryId: UUID, request: HostRequest, expectedRevision: Int) -> HostRefusal? {
        let evidence: DeliveryEvidence?
        do {
            evidence = try store.deliveryEvidence(for: deliveryId)
        } catch {
            return Self.refusal(for: error)
        }
        guard let evidence else { return .unknownDelivery }
        guard case .pending = evidence else { return .duplicateDelivery }
        guard let pending = drafts.pendingDelivery(deliveryId), pending.connectionId == request.connectionId,
              pending.generation == request.generation, let binding = drafts.binding(pending.bindingId),
              binding.deliveryId == deliveryId, binding.target.expectedRevision == expectedRevision,
              binding.target.workspaceHandle == store.workspaceHandle else { return .bindingStale }
        return nil
    }

    private func bind(_ request: HostRequest) -> HostResponse {
        let echo = request.echo
        guard let fields = PayloadFields(request.payload, allowed: ["workspaceHandle", "sessionId", "expectedRevision", "expectedText", "selection"]) else {
            return .refused(.unknownField, echo: echo)
        }
        if let refusal = checkHandle(fields) { return .refused(refusal, echo: echo) }
        guard let sessionId = fields.recordId("sessionId") else { return .refused(.invalidIdentity, echo: echo) }
        // The next revision must still be a safe integer.
        guard let expectedRevision = fields.safeInteger("expectedRevision"), expectedRevision < ProofLimits.maxSafeInteger else {
            return .refused(.invalidRevision, echo: echo)
        }
        guard let expectedText = fields.string("expectedText"), let selectionFields = fields.object("selection"),
              Set(selectionFields.keys) == ["start", "end"], let start = selectionFields["start"]?.safeIntegerValue,
              let end = selectionFields["end"]?.safeIntegerValue else { return .refused(.malformedEnvelope, echo: echo) }
        let selection = TextSelection(start: start, end: end)
        guard selection.isValid(in: expectedText) else { return .refused(.malformedEnvelope, echo: echo) }

        if let replayed = replay(ephemeralReplays[request.requestId], for: request) { return replayed }
        if let refusal = holderRefusal(for: request) { return .refused(refusal, echo: echo) }
        if let refusal = checkLedgerReuse(request) { return .refused(refusal, echo: echo) }
        if let refusal = claimEphemeral(request) { return .refused(refusal, echo: echo) }
        // Ephemeral: not gated by the durable barrier.

        let target = DraftTarget(workspaceHandle: store.workspaceHandle, sessionId: sessionId, expectedRevision: expectedRevision,
                                 selection: selection, expectedTextUTF16Count: expectedText.utf16.count)
        let binding = drafts.bind(connectionId: request.connectionId, generation: request.generation, target: target)
        let entry = ReplayEntry(requestId: request.requestId, operation: .dictationBindDraft, payloadHash: request.payloadHash,
                                outcome: .ok, revision: expectedRevision, bindingId: binding.bindingId)
        rememberEphemeral(entry)
        return Self.response(for: entry, echo: echo)
    }

    private func unbind(_ request: HostRequest) -> HostResponse {
        let echo = request.echo
        guard let fields = PayloadFields(request.payload, allowed: ["bindingId"]) else { return .refused(.unknownField, echo: echo) }
        guard let bindingId = fields.canonicalUUIDv4("bindingId") else { return .refused(.invalidIdentity, echo: echo) }
        if let replayed = replay(ephemeralReplays[request.requestId], for: request) { return replayed }
        if let refusal = holderRefusal(for: request) { return .refused(refusal, echo: echo) }
        if let refusal = checkLedgerReuse(request) { return .refused(refusal, echo: echo) }
        if let refusal = claimEphemeral(request) { return .refused(refusal, echo: echo) }
        guard drafts.unbind(bindingId: bindingId, connectionId: request.connectionId, generation: request.generation) else {
            // A refusal leaves no identity (section 3).
            identities?.forgetEphemerals([request.requestId])
            return .refused(.unknownBinding, echo: echo)
        }
        rememberEphemeral(ReplayEntry(requestId: request.requestId, operation: .dictationUnbindDraft, payloadHash: request.payloadHash, outcome: .ok))
        return .ok(echo)
    }

    /// Read-only. Answers for the named request from the durable terminal
    /// results (ledger or identity record), the per-generation bind results,
    /// and the dispatch receipt log; releases the barrier only for its own
    /// holder once a terminal result exists. `not-dispatched` is answered
    /// only when no evidence names the id, and identity evidence is never
    /// evicted, so that answer is proof within this store's history.
    ///
    /// A `participant.start` id joins the same identity space (participant
    /// contract section 3) but is never a workspace mutation: its id is
    /// always `unknown` here, never `not-dispatched`, whether its start is
    /// recorded, only reserved because its write is not yet confirmed
    /// (Codex Q5), or still `starting` in memory where no store holds it
    /// yet (the participant host's identity index). A store without runs
    /// reserves nothing, so a host without participants answers as before.
    private func reconcile(_ request: HostRequest) -> HostResponse {
        let echo = request.echo
        guard let fields = PayloadFields(request.payload, allowed: ["workspaceHandle", "targetRequestId"]) else {
            return .refused(.unknownField, echo: echo)
        }
        if let refusal = checkHandle(fields) { return .refused(refusal, echo: echo) }
        guard let target = fields.canonicalUUIDv4("targetRequestId") else { return .refused(.invalidIdentity, echo: echo) }
        if isStartRequestId(target) { return .unknown(echo) }
        guard store.status == .ready else { return .unknown(echo) }
        let entry: ReplayEntry?
        let receipt: DispatchReceipt?
        do {
            entry = try store.terminalResult(for: target)
            receipt = try store.dispatchReceipt(for: target)
        } catch {
            return .unknown(echo)
        }
        let targetField = JSONValue.string(target.canonicalString)
        if let entry {
            releaseBarrier(target)
            forgetSavedWords()
            return .ok(echo, ["targetRequestId": targetField, "original": Self.original(entry)])
        }
        if let entry = ephemeralReplays[target] {
            return .ok(echo, ["targetRequestId": targetField, "original": Self.original(entry)])
        }
        // Dispatched, no terminal result: in flight, or lost to a crash.
        if receipt != nil { return .unknown(echo) }
        if let holder {
            return holder.requestId == target ? .unknown(echo) : .refused(.unknownRequest, echo: echo)
        }
        return .ok(echo, ["targetRequestId": targetField, "original": .object(["outcome": .string("not-dispatched")])])
    }

    private func receipt(_ request: HostRequest) -> HostResponse {
        let echo = request.echo
        guard let fields = PayloadFields(request.payload, allowed: ["deliveryId"]) else { return .refused(.unknownField, echo: echo) }
        guard let deliveryId = fields.canonicalUUIDv4("deliveryId") else { return .refused(.invalidIdentity, echo: echo) }
        let evidence: DeliveryEvidence?
        do {
            evidence = try store.deliveryEvidence(for: deliveryId)
        } catch {
            return .unknown(echo)
        }
        guard let evidence else { return .refused(.unknownDelivery, echo: echo) }
        guard case .saved(let commitRequestId, let revision) = evidence else { return .unknown(echo) }
        drafts.completePending(deliveryId)
        return .ok(echo, [
            "deliveryId": .string(deliveryId.canonicalString),
            "commitRequestId": .string(commitRequestId.canonicalString),
            "revision": .number(Double(revision))
        ])
    }

    /// Words kept in memory whose commit the store shows saved (one that
    /// finished after its connection went, or was recovered) are forgotten,
    /// so saved words are never offered again. A store that cannot answer
    /// leaves them kept: offering saved words twice is better than losing
    /// unsaved ones.
    func forgetSavedWords() {
        let ids = drafts.heldDeliveries.map(\.deliveryId) + drafts.pendingDeliveries.map(\.deliveryId)
        for id in ids {
            guard case .saved? = try? store.deliveryEvidence(for: id) else { continue }
            drafts.completePending(id)
        }
    }

    // MARK: Helpers

    private func checkHandle(_ fields: PayloadFields) -> HostRefusal? {
        guard let handle = fields.opaque("workspaceHandle") else { return .invalidIdentity }
        return handle == store.workspaceHandle ? nil : .unknownHandle
    }

    /// A bind or unbind id that a durable terminal result already holds is a
    /// reused identity with a different operation: a changed payload.
    private func checkLedgerReuse(_ request: HostRequest) -> HostRefusal? {
        do {
            guard let previous = try store.terminalResult(for: request.requestId) else { return nil }
            return previous.payloadHash == request.payloadHash ? nil : .payloadMismatch
        } catch {
            return Self.refusal(for: error)
        }
    }

    /// One request identity spans both replay tables: the durable results
    /// (commits) and the per-generation table (bind, unbind). The payload hash
    /// covers the operation, so an id reused for another operation or payload
    /// is refused as a changed payload; an exact repeat returns its result.
    private func replay(_ previous: ReplayEntry?, for request: HostRequest) -> HostResponse? {
        guard let previous else { return nil }
        guard previous.payloadHash == request.payloadHash else { return .refused(.payloadMismatch, echo: request.echo) }
        return Self.response(for: previous, echo: request.echo)
    }

    private static func response(for entry: ReplayEntry, echo: HostEcho) -> HostResponse {
        switch entry.outcome {
        case .ok:
            var fields: [String: JSONValue] = [:]
            if let revision = entry.revision { fields["revision"] = .number(Double(revision)) }
            if let bindingId = entry.bindingId { fields["bindingId"] = .string(bindingId.canonicalString) }
            return .ok(echo, fields)
        case .conflict:
            return .conflict(echo, currentRevision: entry.revision ?? 0)
        case .refused:
            return .refused(entry.reason ?? .storeCorrupt, echo: echo)
        case .unknown:
            return .unknown(echo)
        }
    }

    private static func original(_ entry: ReplayEntry) -> JSONValue {
        var fields: [String: JSONValue] = ["outcome": .string(entry.outcome.rawValue)]
        if let revision = entry.revision { fields["revision"] = .number(Double(revision)) }
        if let reason = entry.reason { fields["reason"] = .string(reason.rawValue) }
        return .object(fields)
    }

    /// The workspace lane's mapping. `replayExists` is v1's changed payload:
    /// here it only ever comes from a commit or delivery identity. A start's
    /// `replayExists` (`ProofStore.recordStart` under a known id) must never
    /// be answered through this: the participant lane decides a start's
    /// identity first, through `RequestIdentityIndex.claimStarting` and the
    /// durable `publishedRuns` (section 7 step 4: a durably recorded start
    /// replays its `ok`, a reserved or `starting` one is `unknown`), so it
    /// owns its own mapping when starts arrive. `duplicateRun` and
    /// `unknownRun` are a preparing commit's steps 8 and 9 (section 6).
    private static func refusal(for error: Error) -> HostRefusal {
        switch error as? ProofStoreError {
        case .locked, .closed: return .storeLocked
        case .missing: return .storeMissing
        case .replayExists: return .payloadMismatch
        case .unknownDelivery: return .unknownDelivery
        case .duplicateDelivery: return .duplicateDelivery
        case .duplicateRun: return .duplicateRun
        case .unknownRun: return .unknownRun
        default: return .storeCorrupt
        }
    }
}

/// The checks every request passes after its envelope, in v1's order:
/// nesting depth, then connection and generation, then the longest text
/// item. Shared so the participant lane refuses exactly as v1 does without
/// going through `DeskHostProtocol`.
public enum HostPreflight {
    public static func check(_ request: HostRequest, connections: ConnectionRegistry) -> HostRefusal? {
        // The byte path refuses depth before parsing. A decoded request from
        // the WebKit glue or a test is held to the same limit here, before
        // any walk over its payload (hash, size, text scan): the envelope
        // root is one container above the payload.
        guard JSONValue.object(request.payload).nestingDepth < JSONValue.maxNestingDepth else { return .malformedEnvelope }
        switch connections.check(request.connectionId, generation: request.generation) {
        case .staleGeneration: return .staleGeneration
        case .unknownConnection: return .unknownConnection
        case .valid: break
        }
        guard JSONValue.object(request.payload).longestTextItemBytes <= ProofLimits.textItemBytes else { return .textTooLarge }
        return nil
    }
}

/// Strict payload access: unknown keys refuse, wrong types read as absent.
private struct PayloadFields {
    private let fields: [String: JSONValue]

    init?(_ fields: [String: JSONValue], allowed: Set<String>) {
        guard Set(fields.keys).isSubset(of: allowed) else { return nil }
        self.fields = fields
    }

    func has(_ key: String) -> Bool { fields[key] != nil }
    func value(_ key: String) -> JSONValue? { fields[key] }
    func opaque(_ key: String) -> String? { fields[key]?.opaqueStringValue }
    func recordId(_ key: String) -> String? { fields[key]?.recordIdValue }
    func canonicalUUIDv4(_ key: String) -> UUID? { fields[key]?.canonicalUUIDv4Value }
    func safeInteger(_ key: String) -> Int? { fields[key]?.safeIntegerValue }
    func string(_ key: String) -> String? { fields[key]?.stringValue }
    func object(_ key: String) -> [String: JSONValue]? { fields[key]?.objectValue }
}
