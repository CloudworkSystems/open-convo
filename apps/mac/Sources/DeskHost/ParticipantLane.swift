import Foundation

/// The handler for `participant.*` (participant contract section 3): the
/// participant coordinator. Its lifecycle requirements (section 14; plan
/// S10) follow `handle`.
///
/// `HostRouter` hands it a request whose envelope decoded and whose v1
/// preflight passed (`HostPreflight`: nesting depth, connection and
/// generation, the longest text item). The lane then applies the rest of
/// its operation's checks in the contract's order: its own lock flag
/// (`store-locked`), shape and identities, the workspace handle, and the
/// operation's steps. It never takes the workspace barrier, never answers
/// `mutation-outstanding`, and claims a start's request id only through
/// the host configuration's `RequestIdentityIndex`, the one identity space
/// it shares with the workspace lane (Codex Q20, Q22). A lane that can also
/// be reached without the router runs `HostPreflight` itself.
public protocol ParticipantLane: Sendable {
    func handle(_ request: HostRequest) async -> HostResponse

    // MARK: Lifecycle (contract section 14; Codex Q21, Q31-Q33)
    //
    // One lane lives for the whole app launch (Codex Q21); these calls
    // carry it through lock, unlock, window close and quit. Each lane step
    // comes before the matching `DeskHostProtocol` step: `lockNow()` before
    // `lock()`, and `beginShutdown(quitting:)` before `revokeForShutdown()`,
    // so no participant event is pushed after `locked` or `revoked`
    // (section 8: nothing is pushed once lock, window close or quit
    // begins). A reload, a navigation or a new connection needs no lane
    // call: the run goes on, and its later events reach the connections
    // valid when each is pushed.
    //
    // `lockNow()` and `beginShutdown(quitting:)` wait for one thing only: a
    // participant push already under way, until the sink's `push` returns.
    // The sink they were given must therefore never wait on the main
    // thread (`HostEventSink`): the app calls them there.

    /// Lock begins (manual, macOS or inactivity). Synchronous, never
    /// waiting on the lane's own work (only on a push already under way):
    /// the lock flag is set, pushes stop, `stop` goes to every run's
    /// supervisor (its stop sequence finishes in the background), and the
    /// retained event text is dropped (`lost` `locked`). A start in
    /// progress spawns nothing, unless its launch was already under way:
    /// that run is sent `stop` as soon as it is registered, and ends like
    /// any stopped run. Terminals that arrive while locked are kept in
    /// memory, never pushed, and written only after the unlock. Idempotent,
    /// except that `lockEpoch` moves on every call.
    func lockNow()

    /// Moves on every `lockNow()`. A verified unlock that began at one
    /// epoch is applied only if no lock came since (`unlock(ifNoLockSince:)`).
    var lockEpoch: Int { get }

    /// Moves on every `lockNow()` and every `beginShutdown(quitting:)`,
    /// inside the call, before it returns; readable from any thread without
    /// waiting on the lane's work. The WebKit transport reads it when it
    /// admits a request and again, on the main thread, when the answer is
    /// ready, and drops the answer if it moved (contract section 3, S11
    /// follow-through): an answer to a request admitted before a lock,
    /// window close or quit began never reaches the page after it began,
    /// even while the host's own step is still to run.
    var lifecycleEpoch: Int { get }

    /// After a verified unlock that began at `epoch`, and after the host's
    /// own `unlock()`: if no `lockNow()` came since, the lock flag clears,
    /// pushes may go out again (to connections issued from now on), and
    /// the terminal and cleanup writes held while locked are queued to the
    /// same workspace folder, in the background. Nothing restarts. A newer
    /// lock leaves everything locked.
    func unlock(ifNoLockSince epoch: Int) async

    /// A window close (`quitting` false) or the app's quit (true) begins.
    /// Synchronous, like `lockNow()`: no request starts anything from here,
    /// no Desk stack attaches until a close's stack is let go (and none
    /// after a quit), pushes stop, `stop` goes to every run's supervisor,
    /// and the retained event text is dropped (`lost` `closed`), keeping
    /// only text-free run and terminal memory. The one overall bound of
    /// `finishShutdown(quitting:)` starts now (Codex Q33). A quit that
    /// begins during a window close shares that close's bound; one that
    /// begins with no window begins its own. Either way the quit's start
    /// is kept for the launch, so no later detach or call restarts it.
    func beginShutdown(quitting: Bool)

    /// Waits for the runs `beginShutdown(quitting:)` stopped, writing their
    /// terminals and cleanup evidence while the stack is attached and not
    /// locked, for at most `ParticipantLimits.shutdownMillis` after the
    /// matching `beginShutdown(quitting:)` in all (a quit's: its own, or the
    /// close's it shared), however late this call comes: one overall bound
    /// for every participant obligation, never one per run or per phase,
    /// and never extended by calling again (Codex Q33). `quitting` also
    /// waits for cleanup-pending groups to clear; a window close leaves
    /// them owned by the lane, which keeps them busy across close and
    /// reopen (Codex Q21). It returns at the bound whatever is unfinished;
    /// the caller then closes the store (or quits) anyway. Nothing is ever
    /// written to stand in for a write that did not happen.
    func finishShutdown(quitting: Bool) async -> ParticipantShutdownReport

    /// Before later workspace store work outside the lane (S9 ruling c;
    /// plan S11): a page's `workspace.commitProof` and the app's dispatch
    /// recovery. One bounded pass of every terminal, cleanup and
    /// never-spawned write this launch owes for the attached stack's
    /// folder (the pass an attach or unlock queues), and it returns once
    /// each of those writes, and each one already in flight, has had its
    /// attempt: at most one per owed write, with no retry loop and no
    /// timer. A write that fails stays owed, and the store work goes on.
    /// Returns at once with no stack attached, with nothing owed, or while
    /// locked: then nothing is attempted (Codex Q32), and the store refuses
    /// the later work once the host's own lock step has run. Never on a
    /// participant request's path, so Stop, status and events never wait on
    /// the store; never on a lifecycle step's path, so no quit bound grows.
    func reconcileBeforeStoreWork() async

    /// The participant work this launch still owes, with or without a Desk
    /// window (Codex Q33): a quit takes the participant bound when this is
    /// not empty, and the plain one only when it is. Read it after
    /// `beginShutdown(quitting: true)`: from then no start is admitted, so
    /// none can begin after the quit chose its path. A confirmation
    /// revocation still with its owner keeps starts busy but is not counted
    /// here (its owner call returns promptly, and nothing is written for
    /// it).
    func obligations() async -> ParticipantObligations
}

/// The participant work a launch still owes (Codex Q33), as text-free
/// counts of runs.
public struct ParticipantObligations: Equatable, Sendable {
    /// Starts between their starting mark and their end.
    public var starting = 0
    /// Spawned runs with no terminal yet: running or stopping.
    public var live = 0
    /// Spawned runs whose terminal is in while their group is not confirmed
    /// gone or released, or their process's updates have not ended.
    public var cleanupPending = 0
    /// Runs whose terminal or cleanup write is not durable yet (a write the
    /// store refused as another run state included: it never resolves this
    /// launch), and store work in flight that may make one.
    public var writesPending = 0

    public init() {}

    /// No participant obligation: a quit may take the plain bound.
    public var isEmpty: Bool { starting == 0 && live == 0 && cleanupPending == 0 && writesPending == 0 }
}

/// What `ParticipantLane.finishShutdown(quitting:)` came to.
public struct ParticipantShutdownReport: Equatable, Sendable {
    /// The overall bound passed with work still owed.
    public let reachedBound: Bool
    /// What was still owed when it returned.
    public let remaining: ParticipantObligations

    public init(reachedBound: Bool, remaining: ParticipantObligations) {
        self.reachedBound = reachedBound
        self.remaining = remaining
    }
}

extension HostOperation {
    /// Whether a router waits for the participant lane's owed writes before
    /// handing this request to the workspace host (S9 ruling c; plan S11):
    /// `workspace.commitProof`, the one page operation that writes the
    /// workspace store. A router checks this first, so every other request
    /// goes on with no hop.
    public var waitsForOwedParticipantWrites: Bool { self == .workspaceCommitProof }
}

extension ParticipantLane {
    /// S9 ruling (c) at a router (`HostRouter`, and the app's WebKit message
    /// handler; plan S11): ahead of a request that
    /// `waitsForOwedParticipantWrites`, once it passed v1's preflight against
    /// `host`'s registry (one refused there reaches no store work), the
    /// lane's `reconcileBeforeStoreWork()`, awaited.
    public func reconcileBeforeStoreWork(ahead request: HostRequest, host: DeskHostProtocol) async {
        guard request.operation.waitsForOwedParticipantWrites,
              HostPreflight.check(request, connections: host.connections) == nil else { return }
        await reconcileBeforeStoreWork()
    }
}

/// The front door for Desk requests (participant contract section 3; Codex
/// Q1, Q20): `participant.*` goes to the lane and everything else to
/// `DeskHostProtocol`, so a participant request is answered before the
/// workspace actor, its store lock or its barrier can make it wait. A
/// `workspace.commitProof` that passes v1's preflight first waits for the
/// lane's one bounded pass of the participant writes it owes (S9 ruling c,
/// `reconcileBeforeStoreWork(ahead:host:)`); no other request waits.
///
/// Without a lane the router is the v1 host, byte for byte: every request,
/// bytes or typed, goes straight to `DeskHostProtocol`, and a participant
/// name is `unknown-operation` exactly where it was. A lane is given only
/// to a participant host (`DeskHostProtocol.acceptsParticipant`), so the
/// capabilities list, both transports and the lane always agree. Building a
/// router with a lane stays test-only until the page codec for the longer
/// list is bundled (Codex Q1).
public struct HostRouter: Sendable {
    public let hostProtocol: DeskHostProtocol
    private let lane: (any ParticipantLane)?

    /// `lane` must be given exactly when `hostProtocol` is a participant
    /// host; anything else is a wiring mistake and stops here.
    public init(hostProtocol: DeskHostProtocol, lane: (any ParticipantLane)?) {
        precondition((lane != nil) == hostProtocol.acceptsParticipant,
                     "a participant lane goes with a participant host, and only with one")
        self.hostProtocol = hostProtocol
        self.lane = lane
    }

    /// Whether this router decodes `participant.*`: the host's own switch.
    public var acceptsParticipant: Bool { lane != nil }

    /// The byte path. Decoding refuses exactly as
    /// `DeskHostProtocol.handle(data:)` does, with participant names
    /// accepted only when a lane is wired.
    public func handle(data: Data) async -> HostResponse {
        guard let lane else { return await hostProtocol.handle(data: data) }
        let request: HostRequest
        do {
            request = try HostRequest.decode(data, acceptsParticipant: true)
        } catch let rejection as HostRequestRejection {
            return .refused(rejection.refusal, echo: rejection.echo)
        } catch {
            return .refused(.malformedEnvelope, echo: HostEcho())
        }
        return await route(request, lane: lane)
    }

    /// The typed path, for a request the WebKit glue or a test decoded.
    public func handle(_ request: HostRequest) async -> HostResponse {
        guard let lane else { return await hostProtocol.handle(request) }
        return await route(request, lane: lane)
    }

    private func route(_ request: HostRequest, lane: any ParticipantLane) async -> HostResponse {
        guard request.operation.isParticipant else {
            if request.operation.waitsForOwedParticipantWrites {
                await lane.reconcileBeforeStoreWork(ahead: request, host: hostProtocol)
            }
            return await hostProtocol.handle(request)
        }
        // v1's checks, in v1's order, without entering the workspace actor.
        if let refusal = HostPreflight.check(request, connections: hostProtocol.connections) {
            return .refused(refusal, echo: request.echo)
        }
        return await lane.handle(request)
    }
}

/// What the app's one Desk session needs from its participant lane beyond
/// `ParticipantLane` (Codex Q21; plan S11): the lane lives for the whole
/// launch, and each Desk stack is built for it, attached to it while open,
/// and let go when it closes. The session holds `any DeskParticipantLane`.
///
/// Inactive. The one conforming lane is `ParticipantCoordinator` (Codex's
/// S10 carried requirement 1), whose `makeHost` is the one place in Sources
/// that hands a participant configuration to `DeskHostProtocol`; nothing in
/// the app constructs a coordinator, and that stays so until the page
/// codec for the longer list is bundled (Codex Q1). The app's session is
/// given no lane, so every stack it builds is a v1 host.
public protocol ParticipantStackAttaching: Sendable {
    /// Builds a Desk stack's host over `store` and `connections`, pushing
    /// through `events`: a participant host carrying this lane's
    /// configuration (its pin, input bound and the one identity space both
    /// lanes claim through), so `attach` accepts it.
    func makeHost(store: ProofStore, connections: ConnectionRegistry, drafts: DraftBindingRegistry, info: HostInfo,
                  events: HostEventSink) -> DeskHostProtocol

    /// Attaches the stack: `host` (from `makeHost`), the store and registry
    /// it was built over, and the sink it pushes through, which is the
    /// stack's own (Codex S7). Unless the lane is locked, the terminal and
    /// cleanup writes it owes for the folder are queued once, before the
    /// stack's first request (S9 ruling c). Throws, attaching nothing, when
    /// it refuses the stack: another folder or host, a closed store, a
    /// stack already attached, or a window close or quit under way.
    func attach(host: DeskHostProtocol, store: ProofStore, connections: ConnectionRegistry, sink: HostEventSink) async throws

    /// Lets go of the attached stack: the last step of a window close or
    /// quit, after the host's `closeStore()` (section 14, S10 reading 1).
    func detach() async
}

/// The lane the app's Desk session carries across its stacks: requests and
/// lifecycle (`ParticipantLane`) plus stack attachment.
public typealias DeskParticipantLane = ParticipantLane & ParticipantStackAttaching
