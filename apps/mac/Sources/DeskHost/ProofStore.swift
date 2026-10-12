import Foundation

/// The committed workspace: one opaque record under one revision. The
/// `revision` mirrors `record["revision"]` (the Desk's `DeskState.revision`).
public struct WorkspaceRecord: Codable, Equatable, Sendable {
    /// Key-custody identity. Never on the wire.
    public let workspaceId: UUID
    /// Opaque host-issued handle the page names the workspace by.
    public let workspaceHandle: String
    public let revision: Int
    public let record: [String: JSONValue]
    public let committedAt: Date?
    public let requestId: UUID?

    public init(workspaceId: UUID, workspaceHandle: String, revision: Int, record: [String: JSONValue],
                committedAt: Date?, requestId: UUID?) {
        self.workspaceId = workspaceId
        self.workspaceHandle = workspaceHandle
        self.revision = revision
        self.record = record
        self.committedAt = committedAt
        self.requestId = requestId
    }
}

/// What a fresh store is provisioned with, used only when no store exists.
/// `record` must carry a safe-integer `revision`.
public struct WorkspaceSeed: Equatable, Sendable {
    /// Host-generated when nil.
    public let workspaceHandle: String?
    public let record: [String: JSONValue]

    public init(workspaceHandle: String? = nil, record: [String: JSONValue]) {
        self.workspaceHandle = workspaceHandle
        self.record = record
    }

    /// The host-provisioned invented revision-0 fixture: a Desk workspace in
    /// the shape of the shared vectors with one invented folder ("goal") and
    /// its matching goal draft, no sessions and no selection. The pinned
    /// renderer's `validateState` requires at least one folder, so an empty
    /// `goals` list would never open; everything else may stay empty. Not
    /// validated against the Desk schema here (the pinned client runs
    /// `validateState`); `InventedSeedTests` runs the actual generated seed
    /// through that validator.
    public static func inventedRevisionZero(at now: Date = Date()) -> WorkspaceSeed {
        let stamp = ISO8601DateFormatter.inventedStamp.string(from: now)
        let folderId = UUID().canonicalString
        return WorkspaceSeed(record: [
            "schemaVersion": .number(1),
            "revision": .number(0),
            "updatedAt": .string(stamp),
            "goals": .array([.object([
                "id": .string(folderId),
                "title": .string("Invented first folder"),
                "nextStep": .string("Open a session and try an invented draft."),
                "createdAt": .string(stamp),
                "updatedAt": .string(stamp)
            ])]),
            "sessions": .array([]),
            "messages": .array([]),
            "drafts": .object([:]),
            "goalDrafts": .object([folderId: .object(["nextStep": .null, "workTitle": .string("")])]),
            "workItems": .array([]),
            "notes": .array([]),
            "activity": .array([]),
            "selection": .object(["goalId": .null, "sessionId": .null, "route": .string("sessions")]),
            "preferences": .object(["theme": .string("system")]),
            "capabilities": .object(["mode": .string("synthetic"), "provider": .string("demo-only"), "native": .string("unavailable")])
        ])
    }
}

extension ISO8601DateFormatter {
    /// `toISOString()` form (GMT, three fractional digits), which is the only
    /// timestamp form the pinned renderer accepts.
    static let inventedStamp: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

/// One terminal result. Same identity and hash replays it; same identity with
/// a different hash is refused as a changed payload.
public struct ReplayEntry: Codable, Equatable, Sendable {
    public let requestId: UUID
    public let operation: HostOperation
    public let payloadHash: String
    public let outcome: HostOutcome
    public let revision: Int?
    public let reason: HostRefusal?
    public let bindingId: UUID?
    public let deliveryId: UUID?

    public init(requestId: UUID, operation: HostOperation, payloadHash: String, outcome: HostOutcome,
                revision: Int? = nil, reason: HostRefusal? = nil, bindingId: UUID? = nil, deliveryId: UUID? = nil) {
        self.requestId = requestId
        self.operation = operation
        self.payloadHash = payloadHash
        self.outcome = outcome
        self.revision = revision
        self.reason = reason
        self.bindingId = bindingId
        self.deliveryId = deliveryId
    }

    /// The result reconstructed from its compact identity record once the
    /// full ledger entry has been evicted.
    init(_ identity: RequestIdentity) {
        self.init(requestId: identity.requestId, operation: .workspaceCommitProof, payloadHash: identity.payloadHash,
                  outcome: identity.outcome, revision: identity.revision,
                  reason: identity.outcome == .conflict ? .revisionMismatch : nil, deliveryId: identity.deliveryId)
    }
}

/// Compact, durable identity evidence for every terminal commit result:
/// enough to replay the outcome of an exact retry, refuse a changed payload
/// under a known id, and answer `workspace.reconcile` truthfully. Unlike the
/// bounded full-result lists it is never evicted, so absence from every list
/// really does prove that an id was never dispatched here, and a delivery
/// an `ok` commit saved stays answerable after its full record is evicted.
public struct RequestIdentity: Codable, Equatable, Sendable {
    public let requestId: UUID
    public let payloadHash: String
    /// `ok` or `conflict`; refusals before dispatch leave no identity.
    public let outcome: HostOutcome
    /// The committed revision for `ok`; the revision that won for `conflict`.
    public let revision: Int
    /// The dictation delivery an `ok` commit saved, if it named one.
    public let deliveryId: UUID?

    public init(requestId: UUID, payloadHash: String, outcome: HostOutcome, revision: Int, deliveryId: UUID? = nil) {
        self.requestId = requestId
        self.payloadHash = payloadHash
        self.outcome = outcome
        self.revision = revision
        self.deliveryId = deliveryId
    }
}

/// Written before a durable mutation is dispatched. A receipt without a
/// ledger entry means the outcome was never recorded: in flight, or lost to
/// a crash. It holds the workspace barrier until reconciled.
public struct DispatchReceipt: Codable, Equatable, Sendable {
    public let requestId: UUID
    public let operation: HostOperation
    public let payloadHash: String
    public let dispatchedAt: Date
}

/// A dictation delivery the host pushed to the page (write-ahead, no text),
/// later correlated with the commit that saved it.
public struct DeliveryRecord: Codable, Equatable, Sendable {
    public let deliveryId: UUID
    public let bindingId: UUID
    public let connectionId: String
    public let generation: Int
    public let sessionId: String
    public let expectedRevision: Int
    public let pushedAt: Date
    public var commitRequestId: UUID?
    public var revision: Int?
    public var savedAt: Date?

    public init(deliveryId: UUID, bindingId: UUID, connectionId: String, generation: Int, sessionId: String,
                expectedRevision: Int, pushedAt: Date) {
        self.deliveryId = deliveryId
        self.bindingId = bindingId
        self.connectionId = connectionId
        self.generation = generation
        self.sessionId = sessionId
        self.expectedRevision = expectedRevision
        self.pushedAt = pushedAt
    }

    public var isSaved: Bool { commitRequestId != nil }
}

/// What the store knows about a delivery id: its full write-ahead record
/// while unsaved, or the commit that saved it. Only saved records leave the
/// bounded delivery list, and their identity record keeps them answerable,
/// so `nil` really means this store never pushed that delivery.
public enum DeliveryEvidence: Equatable, Sendable {
    case pending(DeliveryRecord)
    case saved(commitRequestId: UUID, revision: Int)
}

public enum StoreStatus: String, Equatable, Sendable {
    case ready
    /// Established store whose state file is gone. Never re-provisioned.
    case missing
    /// Established store whose state file is unreadable or inconsistent.
    /// Never replaced. Reads and writes refuse until explicit recovery.
    case corrupt
}

public enum ProofStoreError: Error, Equatable, Sendable {
    case invalidDirectory
    case secondWriter
    case keyMissing
    case keyRefused
    /// The store cannot even identify itself (unreadable marker).
    case corruptState
    case missing
    case corrupt
    case locked
    case closed
    /// A write failed before anything became visible: the previous file is
    /// intact and nothing was applied.
    case writeFailed(Int32)
    /// A replacement of `state.json` is visible (the rename succeeded) but
    /// the folder flush that makes it durable failed. Memory matches what
    /// the folder shows; whether that survives power loss is unknown until
    /// a later folder flush succeeds, which every durable answer retries.
    case replacedUnsynced(Int32)
    /// `proof.lock`, the attempted folder or an attempted record is a link or
    /// not the regular file or folder this store makes. Nothing was opened
    /// for writing, truncated or followed.
    case unsafeFile
    /// `recordReplay`/`recordPendingDelivery` was asked to record an identity
    /// the store already holds.
    case replayExists
    /// The seed record has no safe-integer `revision`.
    case invalidSeed
    /// A commit named a delivery the store does not know.
    case unknownDelivery
    /// A commit named a delivery that an earlier commit already saved.
    case duplicateDelivery
    /// A write failed after the dispatch receipt was recorded and the receipt
    /// could not be withdrawn, or the result became visible without a
    /// durable flush. Nothing is proven; the barrier must hold.
    case undetermined(requestId: UUID)
}

public struct CommitAttempt: Equatable, Sendable {
    public let requestId: UUID
    public let payloadHash: String
    public let expectedRevision: Int
    public let recordRevision: Int
    public let record: [String: JSONValue]
    public let deliveryId: UUID?

    public init(requestId: UUID, payloadHash: String, expectedRevision: Int, recordRevision: Int,
                record: [String: JSONValue], deliveryId: UUID? = nil) {
        self.requestId = requestId
        self.payloadHash = payloadHash
        self.expectedRevision = expectedRevision
        self.recordRevision = recordRevision
        self.record = record
        self.deliveryId = deliveryId
    }
}

public enum CommitOutcome: Equatable, Sendable {
    case committed(revision: Int)
    /// The committed record is untouched; the attempted record was kept at
    /// `attemptedRecord` for recovery.
    case conflict(currentRevision: Int, attemptedRecord: URL)
    case replayed(ReplayEntry)
    case payloadMismatch
}

/// What `ProofStore.withdrawUnresolvedDispatch` found on disk.
public enum DispatchWithdrawal: Equatable, Sendable {
    /// The receipt had no result on disk and was withdrawn durably.
    case withdrawn
    /// The ledger or the identity record holds the result: the commit applied
    /// and there is nothing to withdraw. Reconciliation, not recovery.
    case alreadyResolved
    /// Neither a receipt nor a result names the id: nothing to withdraw.
    case nothingToWithdraw
}

/// File-backed invented proof store: one workspace, one writer, atomic
/// compare-and-commit, write-ahead dispatch receipts, durable ledger and
/// delivery receipts.
///
/// Files inside the caller-supplied folder (never a default under the home):
/// - `proof.lock`: held with `flock` for the store's lifetime; a second opener
///   in this or another process is refused. Opened without following links
///   and checked to be the regular, single-link file this store made before
///   anything is truncated or written; a link or any other kind of file
///   refuses the open.
/// - `workspace.json`: the store's identity (workspace id and handle). Its
///   presence makes the store "established": from then on a missing or
///   unreadable `state.json` is reported, never replaced.
/// - `state.json`: workspace record, dispatch receipts, ledger, identity
///   records and delivery receipts, replaced atomically (temp file, full
///   flush to permanent storage, rename, folder flush) so a crash or power
///   loss leaves either the old or the new state and never a torn one.
/// - `attempted/<requestId>.json`: the record of each commit that lost a
///   revision race, kept so the work can be recovered. The folder and each
///   record must be the real folder and regular files this store made; a
///   link in their place refuses the write instead of following it.
///
/// The record is stored as JSON, not as the caller's exact bytes: key order
/// and number formatting may differ, contents never do (request decoding
/// refuses keys that would collapse; see `JSONValue.decode`).
///
/// Receipts, ledger and delivery receipts each keep the newest
/// `ledgerCapacity` entries (512 unless the caller chooses otherwise). The
/// identity records (`RequestIdentity`: id, payload hash, outcome, revision)
/// are never evicted, so a request older than the ledger still replays its
/// one result, still refuses a changed payload under its id, and is never
/// reported as not dispatched. That list is the store's one unbounded file
/// cost, about a hundred bytes per commit.
///
/// Write outcomes are stage-aware (`AtomicWriteStage`). A failure before the
/// rename leaves the old file and applies nothing. A failure of the folder
/// flush after the rename leaves the new file visible but not provably
/// durable: memory adopts it, the caller is told `replacedUnsynced` (or
/// `undetermined` for a commit result), and every answer that claims
/// durability, `read()` included, first retries that flush; only
/// `visibleWorkspace()` serves the unconfirmed record, for recovery. A
/// store opened on an established folder cannot know whether the previous
/// process's last flush completed, so it starts the same way: one
/// successful folder flush before its first durable answer.
/// Recovery never trusts memory over
/// the folder: `withdrawUnresolvedDispatch` re-reads and validates
/// `state.json` before deciding, and no write ever puts an older committed
/// revision over a newer one.
public final class ProofStore: @unchecked Sendable {
    public static let formatVersion = 3
    public static let defaultLedgerCapacity = 512

    public let directory: URL
    public let stateURL: URL
    public let markerURL: URL
    public let lockURL: URL
    public let attemptedDirectory: URL
    public let keyCustody: String
    public let ledgerCapacity: Int
    public let workspaceId: UUID
    public let workspaceHandle: String

    private struct Marker: Codable {
        var formatVersion: Int
        var workspaceId: UUID
        var workspaceHandle: String
    }

    private struct State: Codable {
        var formatVersion: Int
        var workspace: WorkspaceRecord
        var receipts: [DispatchReceipt]
        var ledger: [ReplayEntry]
        var identities: [RequestIdentity]
        var deliveries: [DeliveryRecord]

        /// Ids with a terminal result, in the ledger or the identity records.
        var resolvedIds: Set<UUID> { Set(ledger.map(\.requestId)).union(identities.map(\.requestId)) }

        func terminalResult(for requestId: UUID) -> ReplayEntry? {
            if let full = ledger.first(where: { $0.requestId == requestId }) { return full }
            return identities.first { $0.requestId == requestId }.map(ReplayEntry.init)
        }

        func deliveryEvidence(for deliveryId: UUID) -> DeliveryEvidence? {
            if let record = deliveries.first(where: { $0.deliveryId == deliveryId }) {
                if let commitRequestId = record.commitRequestId, let revision = record.revision {
                    return .saved(commitRequestId: commitRequestId, revision: revision)
                }
                return .pending(record)
            }
            return identities.first { $0.deliveryId == deliveryId }.map { .saved(commitRequestId: $0.requestId, revision: $0.revision) }
        }
    }

    private let lock = NSLock()
    private let files: FileManager
    private let faults: AtomicWriteFaults?
    private var state: State?
    private var statusValue: StoreStatus
    private let writerLock: WriterLock
    private var locked = false
    private var closed = false
    /// A replacement of `state.json` is visible but its folder flush is not
    /// confirmed: it failed in this process, or the store was just opened on
    /// an established folder and the previous process's last flush is not
    /// known here. The next durable answer flushes the folder first.
    private var unsynced = false

    public convenience init(directory: URL, keys: KeyProvider, seed: WorkspaceSeed = .inventedRevisionZero(),
                            ledgerCapacity: Int = ProofStore.defaultLedgerCapacity, fileManager: FileManager = .default) throws {
        try self.init(directory: directory, keys: keys, seed: seed, ledgerCapacity: ledgerCapacity, fileManager: fileManager, faults: nil)
    }

    /// Test entry: `faults` injects a failure before any write stage.
    init(directory: URL, keys: KeyProvider, seed: WorkspaceSeed, ledgerCapacity: Int, fileManager: FileManager,
         faults: AtomicWriteFaults?) throws {
        guard directory.isFileURL else { throw ProofStoreError.invalidDirectory }
        precondition(ledgerCapacity >= 1, "the store must remember at least the latest result")
        self.ledgerCapacity = ledgerCapacity
        files = fileManager
        self.faults = faults
        self.directory = directory.standardizedFileURL
        stateURL = self.directory.appendingPathComponent("state.json")
        markerURL = self.directory.appendingPathComponent("workspace.json")
        lockURL = self.directory.appendingPathComponent("proof.lock")
        attemptedDirectory = self.directory.appendingPathComponent("attempted", isDirectory: true)

        if PathNode.inspect(self.directory.path) == .absent {
            try files.createDirectory(at: self.directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        guard PathNode.inspect(self.directory.path) == .directory else { throw ProofStoreError.invalidDirectory }

        writerLock = try Self.acquireWriterLock(at: lockURL)
        do {
            switch PathNode.inspect(markerURL.path) {
            case .absent:
                guard PathNode.inspect(stateURL.path) == .absent else { throw ProofStoreError.corruptState }
                guard let revision = seed.record["revision"]?.safeIntegerValue else { throw ProofStoreError.invalidSeed }
                let workspaceId = UUID()
                let key: StoreKey
                do { key = try keys.createKey(for: workspaceId) } catch { throw ProofStoreError.keyRefused }
                keyCustody = key.custody
                self.workspaceId = workspaceId
                workspaceHandle = seed.workspaceHandle ?? "ws-" + workspaceId.canonicalString
                let marker = Marker(formatVersion: Self.formatVersion, workspaceId: workspaceId, workspaceHandle: workspaceHandle)
                let fresh = State(
                    formatVersion: Self.formatVersion,
                    workspace: WorkspaceRecord(workspaceId: workspaceId, workspaceHandle: workspaceHandle, revision: revision,
                                               record: seed.record, committedAt: nil, requestId: nil),
                    receipts: [], ledger: [], identities: [], deliveries: []
                )
                statusValue = .ready
                // State first, marker last: the marker is what makes a store
                // "established" (never re-provisioned), so it must not exist
                // until the state it vouches for does. If either write fails,
                // the files this open just created are removed again so the
                // next open starts fresh instead of reporting a store that
                // never held anything as missing or corrupt.
                do {
                    try persist(fresh)
                    try AtomicFile.write(try Self.encoder.encode(marker), to: markerURL, files: files, faults: faults)
                } catch {
                    try? files.removeItem(at: markerURL)
                    try? files.removeItem(at: stateURL)
                    throw Self.storeError(error)
                }
            case .regular(links: 1):
                let marker: Marker
                do {
                    marker = try Self.boundedDecode(Marker.self, from: Data(contentsOf: markerURL))
                } catch {
                    throw ProofStoreError.corruptState
                }
                guard marker.formatVersion == Self.formatVersion, !marker.workspaceHandle.isEmpty else { throw ProofStoreError.corruptState }
                // An existing store with no key refuses. Nothing is regenerated.
                guard let key = try keys.existingKey(for: marker.workspaceId) else { throw ProofStoreError.keyMissing }
                keyCustody = key.custody
                workspaceId = marker.workspaceId
                workspaceHandle = marker.workspaceHandle
                switch PathNode.inspect(stateURL.path) {
                case .absent:
                    state = nil
                    statusValue = .missing
                case .regular(links: 1):
                    if let loaded = Self.loadState(at: stateURL, marker: marker, capacity: ledgerCapacity) {
                        state = loaded
                        statusValue = .ready
                        // The folder shows this state, but whether the flush
                        // after its last rename completed is not known to this
                        // process: the previous one may have failed it and then
                        // closed or restarted, and that fact lived only in its
                        // memory. So the first durable answer here (`read()`
                        // included) flushes the folder once before vouching
                        // for the record, and answers `replacedUnsynced` while
                        // that keeps failing (October 9 recheck, R2 across a
                        // reopen).
                        unsynced = true
                    } else {
                        state = nil
                        statusValue = .corrupt
                    }
                default:
                    // A link or another kind of file in place of the state is
                    // not this store's state. Reported, never followed or replaced.
                    state = nil
                    statusValue = .corrupt
                }
            default:
                throw ProofStoreError.corruptState
            }
        } catch {
            // Released here so the lock is free before the error reaches the
            // caller. When every stored property was already set (a failed
            // provisioning write) Swift still runs `deinit`, whose `close()`
            // reaches the same lock: its release is idempotent, so the
            // descriptor number is closed exactly once, never again after
            // another thread may have been handed that number.
            writerLock.release()
            throw error
        }
    }

    deinit { close() }

    private static func loadState(at url: URL, marker: Marker, capacity: Int) -> State? {
        guard let data = try? Data(contentsOf: url), let loaded = try? boundedDecode(State.self, from: data) else { return nil }
        // A hand-edited or damaged file must not serve a revision the Desk
        // cannot represent, a foreign workspace, or a record that disagrees
        // with its own revision.
        guard loaded.formatVersion == formatVersion, loaded.workspace.workspaceId == marker.workspaceId,
              loaded.workspace.workspaceHandle == marker.workspaceHandle, isSafeRevision(loaded.workspace.revision),
              loaded.workspace.record["revision"]?.safeIntegerValue == loaded.workspace.revision,
              loaded.ledger.allSatisfy({ $0.revision.map(isSafeRevision) ?? true }),
              loaded.identities.allSatisfy({ isSafeRevision($0.revision) && ($0.outcome == .ok || $0.outcome == .conflict) }) else { return nil }
        // Identity records are the durable evidence: every ledger entry must
        // have its own, and no id may carry two.
        let identities = Dictionary(loaded.identities.map { ($0.requestId, $0) }, uniquingKeysWith: { first, _ in first })
        guard identities.count == loaded.identities.count,
              loaded.ledger.allSatisfy({ entry in identities[entry.requestId].map { $0.payloadHash == entry.payloadHash && $0.outcome == entry.outcome } ?? false }) else {
            return nil
        }
        // A saved delivery is named by exactly one identity, an `ok` one.
        let savedDeliveries = loaded.identities.compactMap(\.deliveryId)
        guard Set(savedDeliveries).count == savedDeliveries.count,
              loaded.identities.allSatisfy({ $0.deliveryId == nil || $0.outcome == .ok }) else { return nil }
        // At most one dispatch may lack its terminal result (the one in
        // flight at a crash). More than one means the receipt log and the
        // ledger disagree in a way nothing here can explain.
        let resolved = loaded.resolvedIds
        guard loaded.receipts.filter({ !resolved.contains($0.requestId) }).count <= 1 else { return nil }
        return loaded
    }

    // MARK: Status

    public var status: StoreStatus {
        lock.lock()
        defer { lock.unlock() }
        return statusValue
    }

    public var isLocked: Bool {
        lock.lock()
        defer { lock.unlock() }
        return locked
    }

    /// The dispatch receipt without a ledger entry, if any: the request whose
    /// outcome was never recorded. The host restores its workspace barrier
    /// from this after a restart.
    public var unresolvedDispatch: UUID? {
        lock.lock()
        defer { lock.unlock() }
        guard let state else { return nil }
        let resolved = state.resolvedIds
        return state.receipts.last { !resolved.contains($0.requestId) }?.requestId
    }

    // MARK: Reads

    /// The confirmed workspace: the committed record whose replacement is on
    /// disk. Retries a pending folder flush first, like every answer that
    /// claims durability; while that flush keeps failing this throws
    /// `replacedUnsynced` rather than hand out a record the store cannot
    /// vouch for. This is the read behind `workspace.read`, the one answer a
    /// page may mark its workspace saved from. `visibleWorkspace()` serves
    /// the unconfirmed record for recovery.
    public func read() throws -> WorkspaceRecord {
        lock.lock()
        defer { lock.unlock() }
        return try syncedState().workspace
    }

    /// The workspace as the folder shows it, durable or not: after an
    /// unsynced replacement this is the newer record, kept visible for
    /// recovery and diagnostics. Never an answer to the page; `read()` is.
    public func visibleWorkspace() throws -> WorkspaceRecord {
        lock.lock()
        defer { lock.unlock() }
        return try readyState().workspace
    }

    /// The full ledger entry, if it has not been evicted. Tests and
    /// diagnostics; answers use `terminalResult(for:)`.
    public func ledgerEntry(for requestId: UUID) throws -> ReplayEntry? {
        lock.lock()
        defer { lock.unlock() }
        return try readyState().ledger.first { $0.requestId == requestId }
    }

    /// The terminal result for an id, from the ledger or, once the full entry
    /// has been evicted, from its durable identity record. Retries a pending
    /// folder flush first, so a result answered here is on disk.
    public func terminalResult(for requestId: UUID) throws -> ReplayEntry? {
        lock.lock()
        defer { lock.unlock() }
        return try syncedState().terminalResult(for: requestId)
    }

    public func dispatchReceipt(for requestId: UUID) throws -> DispatchReceipt? {
        lock.lock()
        defer { lock.unlock() }
        return try readyState().receipts.first { $0.requestId == requestId }
    }

    /// The full delivery record while it is in the bounded list. Tests and
    /// diagnostics; answers use `deliveryEvidence(for:)`.
    public func delivery(for deliveryId: UUID) throws -> DeliveryRecord? {
        lock.lock()
        defer { lock.unlock() }
        return try syncedState().deliveries.first { $0.deliveryId == deliveryId }
    }

    /// The delivery's pending record, or the commit that saved it (from the
    /// identity records once the full record is evicted). Nil means this
    /// store never pushed it. Retries a pending folder flush first.
    public func deliveryEvidence(for deliveryId: UUID) throws -> DeliveryEvidence? {
        lock.lock()
        defer { lock.unlock() }
        return try syncedState().deliveryEvidence(for: deliveryId)
    }

    // MARK: Writes

    /// Compare-and-commit, in this order under the store lock:
    /// 1. the ledger and the identity records are consulted so an exact retry
    ///    never commits twice and a changed payload under a known id is refused;
    /// 2. the dispatch receipt is written durably (write-ahead);
    /// 3. the expected revision is compared with the committed one;
    /// 4. the new record, the ledger entry, the identity record and (when
    ///    named) the delivery receipt are written in one atomic replacement
    ///    of `state.json`.
    ///
    /// A write failure before step 4 became visible withdraws the receipt so
    /// the refusal is accurate; if even that fails, `undetermined` is thrown
    /// and the caller must keep the barrier. If step 4 became visible but
    /// its folder flush failed, nothing is rolled back (the result is what
    /// the folder shows); `undetermined` is thrown and the barrier holds
    /// until a later durable answer, through `terminalResult(for:)`, settles it.
    public func commit(_ attempt: CommitAttempt, at now: Date = Date()) throws -> CommitOutcome {
        lock.lock()
        defer { lock.unlock() }
        let current = try syncedState()
        if let previous = current.terminalResult(for: attempt.requestId) {
            return previous.payloadHash == attempt.payloadHash ? .replayed(previous) : .payloadMismatch
        }
        guard attempt.recordRevision > attempt.expectedRevision, Self.isSafeRevision(attempt.recordRevision),
              attempt.record["revision"]?.safeIntegerValue == attempt.recordRevision else { throw ProofStoreError.corruptState }
        if let deliveryId = attempt.deliveryId {
            switch current.deliveryEvidence(for: deliveryId) {
            case nil: throw ProofStoreError.unknownDelivery
            case .saved: throw ProofStoreError.duplicateDelivery
            case .pending: break
            }
        }

        var dispatched = current
        dispatched.receipts = Self.append(DispatchReceipt(requestId: attempt.requestId, operation: .workspaceCommitProof,
                                                          payloadHash: attempt.payloadHash, dispatchedAt: now),
                                          to: dispatched.receipts, capacity: ledgerCapacity)
        do {
            try persist(dispatched)
        } catch ProofStoreError.replacedUnsynced {
            // The receipt is visible; the result write's own folder flush
            // settles its durability, or withdrawal removes it again.
        }

        var next = dispatched
        let committed = current.workspace.revision
        guard attempt.expectedRevision == committed else {
            let attempted: URL
            do {
                attempted = try retainAttempt(attempt, currentRevision: committed, at: now)
            } catch {
                try withdrawReceipt(attempt.requestId, after: error)
            }
            next.ledger = Self.append(ReplayEntry(requestId: attempt.requestId, operation: .workspaceCommitProof,
                                                  payloadHash: attempt.payloadHash, outcome: .conflict, revision: committed,
                                                  reason: .revisionMismatch), to: next.ledger, capacity: ledgerCapacity)
            next.identities.append(RequestIdentity(requestId: attempt.requestId, payloadHash: attempt.payloadHash, outcome: .conflict, revision: committed))
            try persistResult(next, for: attempt.requestId)
            return .conflict(currentRevision: committed, attemptedRecord: attempted)
        }
        next.workspace = WorkspaceRecord(workspaceId: workspaceId, workspaceHandle: workspaceHandle, revision: attempt.recordRevision,
                                         record: attempt.record, committedAt: now, requestId: attempt.requestId)
        next.ledger = Self.append(ReplayEntry(requestId: attempt.requestId, operation: .workspaceCommitProof,
                                              payloadHash: attempt.payloadHash, outcome: .ok, revision: attempt.recordRevision,
                                              deliveryId: attempt.deliveryId), to: next.ledger, capacity: ledgerCapacity)
        next.identities.append(RequestIdentity(requestId: attempt.requestId, payloadHash: attempt.payloadHash, outcome: .ok,
                                               revision: attempt.recordRevision, deliveryId: attempt.deliveryId))
        if let deliveryId = attempt.deliveryId, let index = next.deliveries.firstIndex(where: { $0.deliveryId == deliveryId }) {
            next.deliveries[index].commitRequestId = attempt.requestId
            next.deliveries[index].revision = attempt.recordRevision
            next.deliveries[index].savedAt = now
        }
        try persistResult(next, for: attempt.requestId)
        return .committed(revision: attempt.recordRevision)
    }

    /// Records a pushed delivery (identities only, never text) before the
    /// page sees it. Returning normally means the record is on disk, where
    /// it stays until a commit saves it: only saved records are evicted
    /// past capacity, and those stay answerable from their identity record.
    public func recordPendingDelivery(_ record: DeliveryRecord) throws {
        lock.lock()
        defer { lock.unlock() }
        let current = try syncedState()
        guard current.deliveryEvidence(for: record.deliveryId) == nil else { throw ProofStoreError.replayExists }
        var next = current
        next.deliveries = Self.appendDelivery(record, to: next.deliveries, capacity: ledgerCapacity)
        try persist(next)
    }

    /// Explicit invented-store recovery for a dispatch receipt that never got
    /// its terminal result (a crash in flight, or a failed write whose receipt
    /// could not be withdrawn). The folder, not memory, is the authority:
    /// after an uncertain replacement the cached state may be older than what
    /// is on disk, so `state.json` is re-read and validated first. The record,
    /// the ledger entry, the identity record and the delivery receipt of a
    /// commit land in one atomic replacement, so a receipt that no result on
    /// disk resolves proves that commit applied nothing: the receipt is
    /// withdrawn durably and `workspace.reconcile` may answer
    /// `not-dispatched`. A result on disk is never withdrawn and the record
    /// is never written back to an older revision. Throws `corrupt` if the
    /// committed record itself names the id (which this store's own writes
    /// cannot produce) or if the state on disk no longer validates; the
    /// store then reports corrupt until explicit recovery.
    @discardableResult
    public func withdrawUnresolvedDispatch(_ requestId: UUID) throws -> DispatchWithdrawal {
        lock.lock()
        defer { lock.unlock() }
        _ = try readyState()
        let current = try reloadFromDisk()
        guard !current.resolvedIds.contains(requestId) else { return .alreadyResolved }
        guard current.receipts.contains(where: { $0.requestId == requestId }) else { return .nothingToWithdraw }
        guard current.workspace.requestId != requestId else { throw ProofStoreError.corrupt }
        var reverted = current
        reverted.receipts.removeAll { $0.requestId == requestId }
        do {
            try persist(reverted)
        } catch ProofStoreError.replacedUnsynced {
            // The withdrawal is visible; the next durable answer retries the flush.
        }
        return .withdrawn
    }

    /// Lock refuses every read and write until `unlockStore()`. The in-memory
    /// state stays, nothing is flushed or cleared here; the host clears what it
    /// shows.
    public func lockStore() {
        lock.lock()
        defer { lock.unlock() }
        locked = true
    }

    public func unlockStore() {
        lock.lock()
        defer { lock.unlock() }
        locked = false
    }

    /// Releases the writer lock. The store cannot be used again.
    public func close() {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        closed = true
        writerLock.release()
    }

    // MARK: Internals

    private func readyState() throws -> State {
        if closed { throw ProofStoreError.closed }
        if locked { throw ProofStoreError.locked }
        switch statusValue {
        case .missing: throw ProofStoreError.missing
        case .corrupt: throw ProofStoreError.corrupt
        case .ready: break
        }
        guard let state else { throw ProofStoreError.corrupt }
        return state
    }

    /// `readyState()` plus a retry of a folder flush that failed after a
    /// visible replacement, for every answer that claims durability.
    private func syncedState() throws -> State {
        let current = try readyState()
        if unsynced {
            if let code = faults?.flushRetryFault(target: stateURL) { throw ProofStoreError.replacedUnsynced(code) }
            do {
                try AtomicFile.flushDirectory(directory)
            } catch let failure as AtomicWriteError {
                throw ProofStoreError.replacedUnsynced(failure.code)
            }
            unsynced = false
        }
        return current
    }

    /// Re-reads and validates `state.json`; memory then matches the folder.
    /// A file that is gone or no longer validates makes the store missing
    /// or corrupt, as it would on open.
    private func reloadFromDisk() throws -> State {
        let marker = Marker(formatVersion: Self.formatVersion, workspaceId: workspaceId, workspaceHandle: workspaceHandle)
        switch PathNode.inspect(stateURL.path) {
        case .absent:
            state = nil
            statusValue = .missing
            throw ProofStoreError.missing
        case .regular(links: 1):
            guard let loaded = Self.loadState(at: stateURL, marker: marker, capacity: ledgerCapacity) else { fallthrough }
            state = loaded
            return loaded
        default:
            state = nil
            statusValue = .corrupt
            throw ProofStoreError.corrupt
        }
    }

    /// A write failed after the dispatch receipt went to disk. Withdraw the
    /// receipt so the request reads as never dispatched; rethrow the original
    /// error. If the withdrawal also fails before becoming visible, nothing is
    /// proven: `undetermined`.
    private func withdrawReceipt(_ requestId: UUID, after error: Error) throws -> Never {
        guard var reverted = state else { throw Self.storeError(error) }
        reverted.receipts.removeAll { $0.requestId == requestId }
        do {
            try persist(reverted)
        } catch ProofStoreError.replacedUnsynced {
            // The withdrawal is visible: nothing applied, and the next
            // durable answer retries the flush.
        } catch {
            throw ProofStoreError.undetermined(requestId: requestId)
        }
        throw Self.storeError(error)
    }

    /// The terminal write of a commit. Not visible: withdraw the receipt and
    /// refuse. Visible but not flushed: the result stands as the folder
    /// shows it, and the caller learns `undetermined`.
    private func persistResult(_ next: State, for requestId: UUID) throws {
        do {
            try persist(next)
        } catch ProofStoreError.replacedUnsynced {
            throw ProofStoreError.undetermined(requestId: requestId)
        } catch {
            try withdrawReceipt(requestId, after: error)
        }
    }

    private static func storeError(_ error: Error) -> Error {
        if let failure = error as? AtomicWriteError { return ProofStoreError.writeFailed(failure.code) }
        return error
    }

    private static func isSafeRevision(_ revision: Int) -> Bool {
        revision >= 0 && revision <= ProofLimits.maxSafeInteger
    }

    private static func append<Entry>(_ entry: Entry, to list: [Entry], capacity: Int) -> [Entry] {
        var next = list
        next.append(entry)
        if next.count > capacity { next.removeFirst(next.count - capacity) }
        return next
    }

    /// Past capacity the oldest saved deliveries go, never an unsaved one:
    /// its record is the only proof that the delivery was pushed, while a
    /// saved delivery is still answerable from its identity record.
    private static func appendDelivery(_ record: DeliveryRecord, to list: [DeliveryRecord], capacity: Int) -> [DeliveryRecord] {
        var next = list
        next.append(record)
        var excess = next.count - capacity
        guard excess > 0 else { return next }
        next.removeAll { candidate in
            guard excess > 0, candidate.isSaved else { return false }
            excess -= 1
            return true
        }
        return next
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    /// Every file this store reads (the marker and `state.json`, which holds
    /// the receipts, ledger and deliveries) is first parsed by the bounded
    /// `JSONValue.decode`, which refuses anything but UTF-8 and more than
    /// `JSONValue.maxNestingDepth` containers before any parser runs. So a
    /// damaged or hand-made file, re-encoded as UTF-16 or not, reads as
    /// corrupt instead of turning its depth into call depth at open, and
    /// `JSONDecoder` (which sniffs encodings the same way) only ever parses
    /// UTF-8 under the limit. The attempted records are written here and
    /// never read back by the host.
    private static func boundedDecode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        _ = try JSONValue.decode(data)
        return try decoder.decode(type, from: data)
    }

    /// Replaces `state.json`. On success memory adopts `next`. A failure
    /// before the rename leaves both memory and the file as they were
    /// (`writeFailed`). A failure of the folder flush after the rename means
    /// `next` is what the folder shows: memory adopts it and
    /// `replacedUnsynced` is thrown. The committed revision never goes
    /// backwards through this path.
    private func persist(_ next: State) throws {
        if let current = state, next.workspace.revision < current.workspace.revision { throw ProofStoreError.corrupt }
        do {
            try AtomicFile.write(try Self.encoder.encode(next), to: stateURL, files: files, faults: faults)
            state = next
            unsynced = false
        } catch let failure as AtomicWriteError {
            guard failure.stage == .directoryFlush else { throw ProofStoreError.writeFailed(failure.code) }
            state = next
            unsynced = true
            throw ProofStoreError.replacedUnsynced(failure.code)
        }
    }

    private func retainAttempt(_ attempt: CommitAttempt, currentRevision: Int, at now: Date) throws -> URL {
        struct Attempt: Codable {
            let requestId: UUID
            let expectedRevision: Int
            let currentRevision: Int
            let attemptedAt: Date
            let record: [String: JSONValue]
        }
        // The folder and the record must be this store's own: a link in
        // either place is refused, never followed.
        switch PathNode.inspect(attemptedDirectory.path) {
        case .absent:
            try files.createDirectory(at: attemptedDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            guard PathNode.inspect(attemptedDirectory.path) == .directory else { throw ProofStoreError.unsafeFile }
        case .directory:
            break
        default:
            throw ProofStoreError.unsafeFile
        }
        let url = attemptedDirectory.appendingPathComponent("\(attempt.requestId.canonicalString).json")
        let retained = Attempt(requestId: attempt.requestId, expectedRevision: attempt.expectedRevision, currentRevision: currentRevision,
                               attemptedAt: now, record: attempt.record)
        do {
            try AtomicFile.write(try Self.encoder.encode(retained), to: url, files: files, faults: faults)
        } catch let failure as AtomicWriteError {
            throw failure.stage == .target ? ProofStoreError.unsafeFile : ProofStoreError.writeFailed(failure.code)
        }
        return url
    }

    /// `flock` dies with the process, so a crash never leaves a stale lock, and
    /// a second open in the same process conflicts just like another process.
    /// The lock file is opened without following links and must be a regular
    /// file with one link that is still the file at that path; only then is it
    /// locked, truncated and written. Anything else refuses before mutation.
    static func acquireWriterLock(at url: URL) throws -> WriterLock {
        let descriptor = open(url.path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else {
            let code = errno
            if code == ELOOP { throw ProofStoreError.unsafeFile }
            throw ProofStoreError.writeFailed(code)
        }
        var opened = Darwin.stat()
        var named = Darwin.stat()
        guard fstat(descriptor, &opened) == 0, lstat(url.path, &named) == 0,
              (opened.st_mode & S_IFMT) == S_IFREG, opened.st_nlink == 1,
              named.st_ino == opened.st_ino, named.st_dev == opened.st_dev else {
            Darwin.close(descriptor)
            throw ProofStoreError.unsafeFile
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            Darwin.close(descriptor)
            if code == EWOULDBLOCK { throw ProofStoreError.secondWriter }
            throw ProofStoreError.writeFailed(code)
        }
        let note = Data("pid \(getpid())\n".utf8)
        _ = ftruncate(descriptor, 0)
        _ = note.withUnsafeBytes { pwrite(descriptor, $0.baseAddress, $0.count, 0) }
        return WriterLock(descriptor: descriptor)
    }
}

/// Sole owner of the writer-lock descriptor. `release()` unlocks and closes
/// it at most once, whether called from `ProofStore.close()`, from a failed
/// `ProofStore` initializer, or from this deinit; every later call is a
/// no-op. Closing a number twice is never harmless: between the two closes
/// another thread may have been handed the same number for its own file.
final class WriterLock {
    private(set) var descriptor: Int32

    init(descriptor: Int32) { self.descriptor = descriptor }

    deinit { release() }

    var isHeld: Bool { descriptor >= 0 }

    func release() {
        guard descriptor >= 0 else { return }
        flock(descriptor, LOCK_UN)
        Darwin.close(descriptor)
        descriptor = -1
    }
}

/// What `lstat` says a path is, without following a link.
enum PathNode: Equatable {
    case absent
    case regular(links: nlink_t)
    case directory
    /// A link, device, socket or anything else; or a path that cannot be
    /// inspected. Refused wherever a regular file or folder is required.
    case other

    static func inspect(_ path: String) -> PathNode {
        var info = Darwin.stat()
        guard lstat(path, &info) == 0 else { return errno == ENOENT ? .absent : .other }
        switch info.st_mode & S_IFMT {
        case S_IFREG: return .regular(links: info.st_nlink)
        case S_IFDIR: return .directory
        default: return .other
        }
    }
}

/// Where an atomic replacement was when it failed. Everything up to and
/// including `rename` leaves the old file intact; a `directoryFlush` failure
/// means the new file is visible but not provably durable.
public enum AtomicWriteStage: String, Equatable, Sendable {
    /// The target path was inspected: it must be absent or a regular file
    /// with one link, never a link to be followed.
    case target
    /// The temp file was created.
    case create
    /// The bytes were written to the temp file.
    case write
    /// The temp file was flushed to permanent storage.
    case sync
    /// The temp file was closed.
    case close
    /// The temp file was renamed over the target.
    case rename
    /// The folder was flushed so the rename itself is on disk.
    case directoryFlush
}

public struct AtomicWriteError: Error, Equatable, Sendable {
    public let stage: AtomicWriteStage
    public let code: Int32
}

/// Test hook: an errno to inject before a write stage runs, or nil to let
/// it run. `flushRetryFault` governs the folder-flush retry a store makes
/// outside any write after an unsynced replacement.
public protocol AtomicWriteFaults: AnyObject, Sendable {
    func fault(before stage: AtomicWriteStage, target: URL) -> Int32?
    func flushRetryFault(target: URL) -> Int32?
}

public extension AtomicWriteFaults {
    func flushRetryFault(target: URL) -> Int32? { nil }
}

/// Temp file in the same folder, flushed to permanent storage, renamed over
/// the target, then the folder flushed so the rename itself is on disk.
///
/// On macOS `fsync(2)` only pushes to the drive's cache; `F_FULLFSYNC` asks
/// the drive to commit to persistent storage, which is what "durable" means
/// in a reply. Where a file system does not support `F_FULLFSYNC`, plain
/// `fsync` is the fallback; a failure of both is a write failure. Every
/// failure is reported with its `AtomicWriteStage`.
enum AtomicFile {
    static func write(_ data: Data, to url: URL, files: FileManager, faults: AtomicWriteFaults? = nil) throws {
        func check(_ stage: AtomicWriteStage) throws {
            if let code = faults?.fault(before: stage, target: url) { throw AtomicWriteError(stage: stage, code: code) }
        }
        try check(.target)
        switch PathNode.inspect(url.path) {
        case .absent, .regular(links: 1): break
        default: throw AtomicWriteError(stage: .target, code: ELOOP)
        }
        let temporary = url.deletingLastPathComponent()
            .appendingPathComponent(".\(url.lastPathComponent).tmp-\(UUID().uuidString)")
        try check(.create)
        guard files.createFile(atPath: temporary.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw AtomicWriteError(stage: .create, code: errno)
        }
        do {
            try check(.write)
            let handle: FileHandle
            do {
                handle = try FileHandle(forWritingTo: temporary)
            } catch {
                throw AtomicWriteError(stage: .write, code: EIO)
            }
            do {
                do { try handle.write(contentsOf: data) } catch { throw AtomicWriteError(stage: .write, code: EIO) }
                try check(.sync)
                try flush(handle.fileDescriptor, stage: .sync)
                try check(.close)
                do { try handle.close() } catch { throw AtomicWriteError(stage: .close, code: EIO) }
            } catch {
                try? handle.close()
                throw error
            }
            try check(.rename)
            guard rename(temporary.path, url.path) == 0 else { throw AtomicWriteError(stage: .rename, code: errno) }
        } catch {
            try? files.removeItem(at: temporary)
            throw error
        }
        try check(.directoryFlush)
        try flushDirectory(url.deletingLastPathComponent())
    }

    /// `F_FULLFSYNC`, falling back to `fsync` where the file system refuses it.
    static func flush(_ descriptor: Int32, stage: AtomicWriteStage) throws {
        if fcntl(descriptor, F_FULLFSYNC) == 0 { return }
        guard fsync(descriptor) == 0 else { throw AtomicWriteError(stage: stage, code: errno) }
    }

    static func flushDirectory(_ directory: URL) throws {
        let descriptor = open(directory.path, O_RDONLY | O_CLOEXEC)
        guard descriptor >= 0 else { throw AtomicWriteError(stage: .directoryFlush, code: errno) }
        defer { Darwin.close(descriptor) }
        try flush(descriptor, stage: .directoryFlush)
    }
}
