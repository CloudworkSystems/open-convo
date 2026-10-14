import CryptoKit
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
    /// The participant run an `ok` commit prepared, if any (participant
    /// contract section 6), canonical lowercase. Absent from the file when
    /// nil, so identities written before runs existed read unchanged.
    public let runId: String?

    public init(requestId: UUID, payloadHash: String, outcome: HostOutcome, revision: Int, deliveryId: UUID? = nil,
                runId: String? = nil) {
        self.requestId = requestId
        self.payloadHash = payloadHash
        self.outcome = outcome
        self.revision = revision
        self.deliveryId = deliveryId
        self.runId = runId
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
    /// the store already holds, or `recordStart` a request id it already
    /// knows. For a start this is not v1's payload mismatch: the
    /// participant lane answers from `publishedRuns` (section 7 step 4).
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
    /// A prepared run reuses a run or message id another entry holds, or a
    /// run id the committed record holds (ignoring case; section 6 step 8),
    /// or a start names a run that already has one.
    case duplicateRun
    /// No run entry has that run id, or a commit introduces a run it does
    /// not prepare (section 6 step 9).
    case unknownRun
    /// The run already ended without starting (Stop before Start).
    case runNotPrepared
    /// A run write would contradict the entry: a different terminal, a
    /// cleared group with no spawn, or a state section 15 forbids.
    case runEntryConflict
    /// The start record was definitely not written: the write failed before
    /// its rename, or an earlier replacement's folder flush still fails and
    /// the visible state holds no start with this request id on that run.
    /// The previous file is intact (section 7 step 14's definite failure).
    case startNotApplied
}

public struct CommitAttempt: Equatable, Sendable {
    public let requestId: UUID
    public let payloadHash: String
    public let expectedRevision: Int
    public let recordRevision: Int
    public let record: [String: JSONValue]
    public let deliveryId: UUID?
    /// The run this commit prepares (participant contract section 6), whose
    /// steps 1-7 the caller has already passed. On `ok` its entry lands in
    /// the same replacement as the record; a conflict writes none.
    public let preparedRun: ParticipantPreparedRun?
    /// The attempted record's `conversationRuns` run ids for section 6's
    /// introduced-runs rule (step 9), read strictly by the caller (empty for
    /// a record without the list). Nil skips that rule: a host without
    /// participants never passes it, so its commits run exactly as v1's. A
    /// participant host passes it on every commit.
    public let attemptedRunIds: [String]?

    public init(requestId: UUID, payloadHash: String, expectedRevision: Int, recordRevision: Int,
                record: [String: JSONValue], deliveryId: UUID? = nil, preparedRun: ParticipantPreparedRun? = nil,
                attemptedRunIds: [String]? = nil) {
        self.requestId = requestId
        self.payloadHash = payloadHash
        self.expectedRevision = expectedRevision
        self.recordRevision = recordRevision
        self.record = record
        self.deliveryId = deliveryId
        self.preparedRun = preparedRun
        self.attemptedRunIds = attemptedRunIds
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
///
/// Participant runs (`docs/desk-native-participant-contract.md` section 15)
/// live in `state.json`'s `runs`, outside the receipt log and never evicted.
/// Each entry is text-free: ids, the prepared participant, hashes, byte
/// counts, the start record and the one terminal. A store with no runs
/// writes no `runs` key, so a host without participants writes exactly the
/// file it wrote before. A run entry or identity link that breaks a section
/// 15 rule makes the whole store corrupt, like any other damage: never
/// reseeded, repaired or overwritten (Codex Q2). Reads for the participant
/// lane use `publishedRuns`, a copy published after each durable write
/// under its own lock (`snapshotLock`), so they never wait for `lock`,
/// which a write holds through its full flush. Lock order: `lock`, then
/// `snapshotLock`, never the reverse.
///
/// A participant host's `RequestIdentityIndex` is told what memory shows
/// (`setIdentityObserver`): the workspace identities and the recorded
/// starts, unflushed writes included, after every replacement and re-read,
/// before the runs copy is published. It is called under `lock`, and the
/// index never calls back: lock order `lock`, then the index's lock.
public final class ProofStore: @unchecked Sendable {
    /// Still 3 with `runs` (section 15). That holds only while participant
    /// hosts are inactive and every store with runs holds invented data: an
    /// older build reads such a file, ignores `runs` and the identities'
    /// `runId`, and drops both on its next write. Downgrading a format-3
    /// store that holds runs is unsupported; keep those stores away from
    /// older writable builds. Before any enabled or reusable-store build, a
    /// reviewed forward-only format marker that older writers refuse must
    /// replace this, with downgrade tests (Codex Q3). Existing stores are
    /// never migrated silently: a store without runs is written as before.
    public static let formatVersion = 3
    public static let defaultLedgerCapacity = 512

    public let directory: URL
    public let stateURL: URL
    public let markerURL: URL
    public let lockURL: URL
    public let attemptedDirectory: URL
    public let keyCustody: String
    /// Seals and opens this store's files (step 2, PR 2). Holds the key; never
    /// printed, logged or encoded.
    let cipher: StoreCipher
    public let ledgerCapacity: Int
    public let workspaceId: UUID
    public let workspaceHandle: String

    private struct Marker: Codable {
        var formatVersion: Int
        var workspaceId: UUID
        var workspaceHandle: String
    }

    /// The marker checks the store's open and a recovery share: this
    /// format, and a handle.
    private static func isUsableMarker(_ marker: Marker) -> Bool {
        marker.formatVersion == formatVersion && !marker.workspaceHandle.isEmpty
    }

    private struct State: Codable {
        var formatVersion: Int
        var workspace: WorkspaceRecord
        var receipts: [DispatchReceipt]
        var ledger: [ReplayEntry]
        var identities: [RequestIdentity]
        var deliveries: [DeliveryRecord]
        /// Participant runs, in preparation order. Never evicted.
        var runs: [ParticipantRunEntry]

        private enum CodingKeys: String, CodingKey {
            case formatVersion, workspace, receipts, ledger, identities, deliveries, runs
        }

        init(formatVersion: Int, workspace: WorkspaceRecord, receipts: [DispatchReceipt], ledger: [ReplayEntry],
             identities: [RequestIdentity], deliveries: [DeliveryRecord], runs: [ParticipantRunEntry] = []) {
            self.formatVersion = formatVersion
            self.workspace = workspace
            self.receipts = receipts
            self.ledger = ledger
            self.identities = identities
            self.deliveries = deliveries
            self.runs = runs
        }

        /// A file without `runs` (every file written before runs existed)
        /// decodes as `[]`. A present `runs` must be a list of valid
        /// entries; `null` or anything else fails, and the store is corrupt.
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            formatVersion = try container.decode(Int.self, forKey: .formatVersion)
            workspace = try container.decode(WorkspaceRecord.self, forKey: .workspace)
            receipts = try container.decode([DispatchReceipt].self, forKey: .receipts)
            ledger = try container.decode([ReplayEntry].self, forKey: .ledger)
            identities = try container.decode([RequestIdentity].self, forKey: .identities)
            deliveries = try container.decode([DeliveryRecord].self, forKey: .deliveries)
            runs = container.contains(.runs) ? try container.decode([ParticipantRunEntry].self, forKey: .runs) : []
        }

        /// No `runs` key while there are none, so a store that never
        /// prepared a run keeps its pre-runs bytes (Codex Q3).
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(formatVersion, forKey: .formatVersion)
            try container.encode(workspace, forKey: .workspace)
            try container.encode(receipts, forKey: .receipts)
            try container.encode(ledger, forKey: .ledger)
            try container.encode(identities, forKey: .identities)
            try container.encode(deliveries, forKey: .deliveries)
            if !runs.isEmpty { try container.encode(runs, forKey: .runs) }
        }

        /// Ids with a terminal result, in the ledger or the identity records.
        var resolvedIds: Set<UUID> { Set(ledger.map(\.requestId)).union(identities.map(\.requestId)) }

        /// Every request id the store knows, canonical lowercase: commit
        /// results, identities, dispatch receipts and recorded starts. One
        /// request-identity space (section 3).
        var knownRequestIds: Set<String> {
            var ids = Set(ledger.map(\.requestId.canonicalString))
            ids.formUnion(identities.map(\.requestId.canonicalString))
            ids.formUnion(receipts.map(\.requestId.canonicalString))
            ids.formUnion(startRequestIds)
            return ids
        }

        var startRequestIds: Set<String> { Set(runs.compactMap { $0.start?.requestId }) }

        /// The run and message ids every entry holds, lowercased: one
        /// namespace across all three fields (Codex Q4).
        var runNamespace: Set<String> { Set(runs.flatMap { $0.namespacedIds.map { $0.lowercased() } }) }

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
    /// Guards `published` only. Taken inside `lock` when publishing, alone
    /// when reading; never held while waiting for `lock`.
    private let snapshotLock = NSLock()
    private var published = ParticipantRunsSnapshot.unopened
    /// The shared request-identity space this store reports to, if any.
    /// Guarded by `lock`.
    private var identityObserver: RequestIdentityIndex?

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
                switch PathNode.inspect(stateURL.path) {
                case .absent:
                    break
                case .regular(links: 1):
                    // A state file with no marker: provisioning was cut off
                    // between the two writes (state first, marker last), so
                    // this store was never established and nothing was ever
                    // committed to it. The file is set aside under a new name,
                    // never deleted or overwritten, and the store is
                    // provisioned fresh.
                    try Self.setAsideUnprovisionedState(stateURL, in: self.directory)
                default:
                    throw ProofStoreError.corruptState
                }
                guard let revision = seed.record["revision"]?.safeIntegerValue else { throw ProofStoreError.invalidSeed }
                let workspaceId = UUID()
                let key: StoreKey
                // A Keychain that can't be reached stays `unavailable`, so the
                // caller can tell it apart from a refused key.
                do { key = try keys.createKey(for: workspaceId) } catch KeyProviderError.unavailable {
                    throw KeyProviderError.unavailable
                } catch { throw ProofStoreError.keyRefused }
                keyCustody = key.custody
                // A key that is not 32 bytes would run a weaker AES; refused
                // before anything is written.
                do { cipher = try StoreCipher(material: key.material, workspaceId: workspaceId) } catch {
                    throw ProofStoreError.keyRefused
                }
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
                guard Self.isUsableMarker(marker) else { throw ProofStoreError.corruptState }
                // An existing store with no key refuses. Nothing is regenerated.
                guard let key = try keys.existingKey(for: marker.workspaceId) else { throw ProofStoreError.keyMissing }
                keyCustody = key.custody
                do { cipher = try StoreCipher(material: key.material, workspaceId: marker.workspaceId) } catch {
                    throw ProofStoreError.keyRefused
                }
                workspaceId = marker.workspaceId
                workspaceHandle = marker.workspaceHandle
                switch PathNode.inspect(stateURL.path) {
                case .absent:
                    state = nil
                    statusValue = .missing
                case .regular(links: 1):
                    if let loaded = Self.loadState(at: stateURL, marker: marker, capacity: ledgerCapacity, cipher: cipher) {
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
        // A fresh store published its durable first state when it was
        // written. An opened one proves nothing durable until its first
        // folder flush (`refreshPublishedRuns`), but its visible starts are
        // reserved from the start (Codex Q5).
        switch statusValue {
        case .ready:
            if unsynced, let state { publishUnsynced(state) }
        case .missing, .corrupt:
            publishUnavailable(statusValue)
        }
    }

    deinit { close() }

    /// The prefix of a state file set aside after an interrupted first
    /// provisioning (`state.unprovisioned-<uuid>.json`).
    static let unprovisionedStatePrefix = "state.unprovisioned-"

    /// Renames an orphan `state.json` to a fresh name in the same folder,
    /// refusing to replace anything already there (RENAME_EXCL).
    private static func setAsideUnprovisionedState(_ stateURL: URL, in directory: URL) throws {
        let aside = directory.appendingPathComponent("\(unprovisionedStatePrefix)\(UUID().canonicalString).json")
        guard renamex_np(stateURL.path, aside.path, UInt32(RENAME_EXCL)) == 0 else {
            throw ProofStoreError.writeFailed(errno)
        }
    }

    private static func loadState(at url: URL, marker: Marker, capacity: Int, cipher: StoreCipher) -> State? {
        // A file that does not open under this store's key and purpose
        // (wrong key, another store's file, a flipped byte, a truncation,
        // plaintext) reads as corrupt: reported, never reset or rewritten.
        guard let sealed = try? Data(contentsOf: url), let data = try? cipher.open(sealed, as: .state),
              let loaded = try? boundedDecode(State.self, from: data) else { return nil }
        // A hand-edited or damaged file must not serve a revision the Desk
        // cannot represent, a foreign workspace, or a record that disagrees
        // with its own revision.
        guard loaded.formatVersion == formatVersion, loaded.workspace.workspaceId == marker.workspaceId,
              loaded.workspace.workspaceHandle == marker.workspaceHandle, isSafeRevision(loaded.workspace.revision),
              loaded.workspace.record["revision"]?.safeIntegerValue == loaded.workspace.revision,
              loaded.ledger.allSatisfy({ $0.revision.map(isSafeRevision) ?? true }),
              loaded.identities.allSatisfy({ isSafeRevision($0.revision) && ($0.outcome == .ok || $0.outcome == .conflict) }) else { return nil }
        // The participant lane never holds the barrier, and a start is kept
        // in `runs`, outside the receipt log (participant contract sections
        // 3 and 15). So a ledger entry or receipt naming a participant
        // operation is damage, read as corrupt as it was before the names
        // existed.
        guard !loaded.ledger.contains(where: { $0.operation.isParticipant }),
              !loaded.receipts.contains(where: { $0.operation.isParticipant }) else { return nil }
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
        guard runsAreConsistent(loaded, identities: identities) else { return nil }
        return loaded
    }

    /// Section 15's load invariants across entries and identities (each
    /// entry's own shape was checked as it decoded). Any failure makes the
    /// whole store corrupt (Codex Q2).
    private static func runsAreConsistent(_ loaded: State, identities: [UUID: RequestIdentity]) -> Bool {
        // One namespace, ignoring case, for every entry's run and message
        // ids; a session id may recur across runs (Codex Q4).
        var namespace = Set<String>()
        for entry in loaded.runs {
            for id in entry.namespacedIds {
                guard namespace.insert(id.lowercased()).inserted else { return false }
            }
        }
        // Each entry's `prepareRequestId` names the `ok` identity that
        // carries its run id and prepared revision, and each identity run id
        // names exactly that entry: one bijection (Codex Q11).
        var byRunId: [String: ParticipantRunEntry] = [:]
        for entry in loaded.runs {
            guard let prepareId = UUID(uuidString: entry.prepareRequestId), let identity = identities[prepareId],
                  identity.outcome == .ok, identity.runId == entry.runId, identity.revision == entry.preparedRevision else { return false }
            byRunId[entry.runId] = entry
        }
        for identity in loaded.identities {
            guard let runId = identity.runId else { continue }
            guard identity.outcome == .ok, byRunId[runId]?.prepareRequestId == identity.requestId.canonicalString else { return false }
        }
        // A start's request id is its own: never a commit result, identity
        // or receipt, and never a second run's start (section 3).
        var commitIds = Set(loaded.ledger.map(\.requestId.canonicalString))
        commitIds.formUnion(loaded.identities.map(\.requestId.canonicalString))
        commitIds.formUnion(loaded.receipts.map(\.requestId.canonicalString))
        var starts = Set<String>()
        for case let start? in loaded.runs.map(\.start) {
            guard !commitIds.contains(start.requestId), starts.insert(start.requestId).inserted else { return false }
        }
        return true
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

    /// The participant lane's runs copy: durable entries only, published
    /// after each durable write and each confirmed folder flush. Takes only
    /// `snapshotLock`, never `lock`, so it answers while a write holds the
    /// store through its flush (section 7 concurrency; Codex Q5). Right
    /// after an open it is not yet durable; `refreshPublishedRuns()` fixes
    /// that. It says `locked` while the store is locked, and `closed`,
    /// with no runs, once it is closed.
    public var publishedRuns: ParticipantRunsSnapshot {
        snapshotLock.lock()
        defer { snapshotLock.unlock() }
        return published
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

    /// Reports this store's identities to `index` from now on (nil stops),
    /// starting with what memory shows now: commit results, identity
    /// records, dispatch receipts and recorded starts, unflushed ones
    /// included (participant contract section 3; Codex Q5). Each later
    /// replacement or re-read reports again, under `lock`, before its runs
    /// copy is published, so the index never trails the copy. A store with
    /// no readable state reports nothing, which releases nothing.
    public func setIdentityObserver(_ index: RequestIdentityIndex?) {
        lock.lock()
        defer { lock.unlock() }
        identityObserver = index
        if let state { reportIdentities(state) }
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
    /// A commit that prepares a participant run (`preparedRun`) is refused
    /// before its receipt: `corruptState` beside a delivery or when its
    /// request id is not a UUIDv4 (its entry would not load), and
    /// `duplicateRun` (section 6 step 8) when any entry already holds one
    /// of its run or message ids, or the committed record already holds its
    /// run id, both ignoring case (Codex Q4). With `attemptedRunIds` (every
    /// commit of a participant host), step 9 follows: a run id in the
    /// attempted list but not in the committed record's is introduced, and
    /// any introduced run other than the prepared one, or any at all
    /// without one, is `unknownRun`. The committed record's list is read
    /// leniently (Codex Q9, `ParticipantPrepare.committedRunIds`). Both
    /// steps throw before the receipt, so nothing is written and the
    /// caller's barrier is free. On `ok` the run entry and the identity's
    /// `runId` join the same step-4 replacement, and a conflict writes
    /// neither. A commit under a recorded start's id is `payloadMismatch`
    /// (section 3).
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
        // A start's id is in the same identity space as commits; recording a
        // commit under it would also make the next load corrupt.
        if current.startRequestIds.contains(attempt.requestId.canonicalString) { return .payloadMismatch }
        guard attempt.recordRevision > attempt.expectedRevision, Self.isSafeRevision(attempt.recordRevision),
              attempt.record["revision"]?.safeIntegerValue == attempt.recordRevision else { throw ProofStoreError.corruptState }
        if let deliveryId = attempt.deliveryId {
            switch current.deliveryEvidence(for: deliveryId) {
            case nil: throw ProofStoreError.unknownDelivery
            case .saved: throw ProofStoreError.duplicateDelivery
            case .pending: break
            }
        }
        var preparedEntry: ParticipantRunEntry?
        // Read only when there is something to compare: one pass over the
        // committed record's list, never on a host without participants and
        // never for a record without runs (schema 1).
        let committedRunIds = attempt.preparedRun != nil || !(attempt.attemptedRunIds ?? []).isEmpty
            ? ParticipantPrepare.committedRunIds(in: current.workspace.record) : []
        if let prepared = attempt.preparedRun {
            // The host refuses a claim beside a delivery as malformed first;
            // the store never records the two on one identity.
            guard attempt.deliveryId == nil else { throw ProofStoreError.corruptState }
            // Built before the receipt: a request id that is not a UUIDv4
            // would write an entry the next load refuses (section 15).
            guard let entry = ParticipantRunEntry(prepared: prepared, prepareRequestId: attempt.requestId,
                                                  preparedRevision: attempt.recordRevision) else { throw ProofStoreError.corruptState }
            // Step 8: a run or message id any entry holds, or a run the
            // committed record already holds, ignoring case.
            let taken = current.runNamespace
            guard prepared.namespacedIds.allSatisfy({ !taken.contains($0.lowercased()) }),
                  !committedRunIds.contains(where: { $0.lowercased() == prepared.runId.lowercased() }) else {
                throw ProofStoreError.duplicateRun
            }
            preparedEntry = entry
        }
        if let attempted = attempt.attemptedRunIds {
            // Step 9: only the prepared run may be introduced. Byte for byte,
            // so a spelling the committed record does not hold counts as new.
            let introduced = ParticipantPrepare.introducedRunIds(attempted: attempted, committed: committedRunIds)
            guard introduced.allSatisfy({ id in attempt.preparedRun.map { ParticipantPin.sameBytes(id, $0.runId) } ?? false }) else {
                throw ProofStoreError.unknownRun
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
                                               revision: attempt.recordRevision, deliveryId: attempt.deliveryId,
                                               runId: attempt.preparedRun?.runId))
        if let preparedEntry { next.runs.append(preparedEntry) }
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

    // MARK: Participant runs

    /// Section 7 step 14: records `start` on the run as one compare-and-set
    /// under the store lock. Refused, writing nothing, when the request id
    /// is already known (`replayExists`: a commit, receipt or any recorded
    /// start), the run has no entry (`unknownRun`), already has a start
    /// (`duplicateRun`) or ended before starting (`runNotPrepared`).
    ///
    /// Outcomes for the caller, who spawns only after a normal return:
    /// - `startNotApplied` is definite: this write failed before its rename,
    ///   or an earlier replacement's folder flush still fails and the
    ///   visible state holds no start with this request id on this run. The
    ///   file and memory are as they were.
    /// - `replacedUnsynced` is undetermined: the start is visible and in
    ///   memory but not provably durable, so it is reserved and not
    ///   published until a later flush or `rereadRuns()` confirms it. A
    ///   retry while that flush still fails answers the same, because its
    ///   start is the one visible.
    @discardableResult
    public func recordStart(runId: String, _ start: ParticipantRunStart) throws -> ParticipantRunEntry {
        lock.lock()
        defer { lock.unlock() }
        let current: State
        do {
            current = try syncedState()
        } catch ProofStoreError.replacedUnsynced(let code) {
            if let visible = state, visible.runs.first(where: { $0.runId == runId })?.start?.requestId == start.requestId {
                throw ProofStoreError.replacedUnsynced(code)
            }
            throw ProofStoreError.startNotApplied
        }
        guard !current.knownRequestIds.contains(start.requestId) else { throw ProofStoreError.replayExists }
        guard let index = current.runs.firstIndex(where: { $0.runId == runId }) else { throw ProofStoreError.unknownRun }
        let entry = current.runs[index]
        guard entry.start == nil else { throw ProofStoreError.duplicateRun }
        guard entry.terminal == nil else { throw ProofStoreError.runNotPrepared }
        guard let started = entry.recording(start: start) else { throw ProofStoreError.runEntryConflict }
        var next = current
        next.runs[index] = started
        do {
            try persist(next)
        } catch ProofStoreError.writeFailed {
            throw ProofStoreError.startNotApplied
        }
        return started
    }

    /// Records the run's one terminal with its cleanup evidence (sections 8
    /// and 10). A repeat of the recorded terminal changes nothing, except
    /// that `groupCleared` may move from false to true (a retried write
    /// after the group cleared); it never moves back. A different terminal,
    /// or a pairing section 15 forbids (a never-started run ending other
    /// than `stopped` `local-stop` at sequence 1 with `groupCleared` null,
    /// `stop-incomplete` without cleanup evidence), is `runEntryConflict`.
    ///
    /// `writeFailed` is definite: nothing of this write was applied (it
    /// failed before its rename, or an earlier replacement's flush still
    /// fails and the visible entry does not already hold this change).
    /// `replacedUnsynced` is undetermined and not published: this write's
    /// own flush failed, or a retry finds this change already visible while
    /// that flush still fails (section 7 step 14; Codex Q28, Q29).
    @discardableResult
    public func recordTerminal(runId: String, _ terminal: ParticipantRunTerminal, groupCleared: Bool?) throws -> ParticipantRunEntry {
        lock.lock()
        defer { lock.unlock() }
        return try applyRunChange { try Self.terminalChange(in: $0, runId: runId, terminal: terminal, groupCleared: groupCleared) }
    }

    /// Section 10: the run's group, recorded uncleared, is now confirmed
    /// empty. The terminal is never rewritten. Already true is a no-op; a
    /// run without a terminal, or one that spawned nothing (`null`), is
    /// `runEntryConflict`. Errors as `recordTerminal`.
    @discardableResult
    public func markGroupCleared(runId: String) throws -> ParticipantRunEntry {
        lock.lock()
        defer { lock.unlock() }
        return try applyRunChange { try Self.groupClearedChange(in: $0, runId: runId) }
    }

    /// Flushes any pending folder flush, then publishes the runs copy. The
    /// coordinator calls this on its executor when it attaches, because an
    /// opened store publishes nothing durable before its first flush.
    @discardableResult
    public func refreshPublishedRuns() throws -> ParticipantRunsSnapshot {
        lock.lock()
        defer { lock.unlock() }
        publishDurable(try syncedState())
        return publishedRuns
    }

    /// Section 7's authoritative re-read after an undetermined start: one
    /// folder flush (so what is read is durable), then `state.json` re-read
    /// and validated as at open, then published. Memory never outranks the
    /// folder here. A flush failure throws `replacedUnsynced` and changes
    /// nothing; a file that is gone or no longer validates makes the store
    /// missing or corrupt, published as such.
    @discardableResult
    public func rereadRuns() throws -> ParticipantRunsSnapshot {
        lock.lock()
        defer { lock.unlock() }
        _ = try readyState()
        try flushFolder()
        let reloaded = try reloadFromDisk(authoritative: true)
        unsynced = false
        publishDurable(reloaded, replacingReservations: true)
        return publishedRuns
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
        publishFlags()
    }

    public func unlockStore() {
        lock.lock()
        defer { lock.unlock() }
        locked = false
        publishFlags()
    }

    /// Releases the writer lock. The store cannot be used again; its runs
    /// copy says so, with no runs (Codex Q21).
    public func close() {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        closed = true
        writerLock.release()
        snapshotLock.lock()
        defer { snapshotLock.unlock() }
        published = ParticipantRunsSnapshot(status: published.status, durable: false, uncertain: false, runs: [],
                                            reservedStartRequestIds: published.reservedStartRequestIds, locked: locked, closed: true)
    }

    // MARK: Recovery key (step 2, PR 3)

    /// Where the store keeps its key's copy sealed under the recovery key.
    public var recoveryCopyURL: URL { directory.appendingPathComponent(RecoveryCopy.fileName) }

    /// Whether the store holds a recovery copy of its key.
    public var hasRecoveryCopy: Bool { PathNode.inspect(recoveryCopyURL.path) == .regular(links: 1) }

    /// A recovery key just made, and whether its copy is known to be durable.
    public struct MadeRecoveryKey: Sendable {
        public let key: RecoveryKey
        /// False when the new copy replaced the old one (so only `key` opens
        /// what the folder shows) but the folder flush after the rename
        /// failed: power loss could still bring the earlier copy back.
        /// Show the key anyway, and make another once the folder flushes.
        public let isDurable: Bool
    }

    /// Makes a fresh recovery key and atomically replaces the store's sealed
    /// copy with one under it, so an earlier recovery key stops working. The
    /// recovery key is returned to be shown once; it is never written,
    /// logged or kept. A failure before the rename leaves the earlier copy
    /// in place and throws; once the rename happened the new key is always
    /// returned (`isDurable` false if the flush failed), since it alone
    /// opens the copy the folder now shows. Refused while the store is
    /// closed or locked.
    public func makeRecoveryKey() throws -> MadeRecoveryKey {
        lock.lock()
        defer { lock.unlock() }
        if closed { throw ProofStoreError.closed }
        if locked { throw ProofStoreError.locked }
        let recovery = try RecoveryKey.generate()
        let sealed = try RecoveryCopy.seal(storeKey: cipher.material, under: recovery, workspaceId: workspaceId)
        do {
            try AtomicFile.write(sealed, to: recoveryCopyURL, files: files, faults: faults)
        } catch let failure as AtomicWriteError {
            if failure.stage == .directoryFlush { return MadeRecoveryKey(key: recovery, isDurable: false) }
            throw failure.stage == .target ? ProofStoreError.unsafeFile : ProofStoreError.writeFailed(failure.code)
        }
        return MadeRecoveryKey(key: recovery, isDurable: true)
    }

    /// Where the store notes that the owner confirmed writing the current
    /// recovery key down: the SHA-256 of the sealed copy it vouches for
    /// (nothing secret). A new copy no longer matches, so it reads as
    /// unconfirmed without anything being deleted.
    public var recoveryConfirmationURL: URL { directory.appendingPathComponent("recovery-key.confirmed") }

    /// Whether the owner confirmed the recovery key whose copy is in place.
    public var recoveryCopyConfirmed: Bool {
        guard hasRecoveryCopy, PathNode.inspect(recoveryConfirmationURL.path) == .regular(links: 1),
              let copy = try? Data(contentsOf: recoveryCopyURL),
              let noted = try? Data(contentsOf: recoveryConfirmationURL) else { return false }
        return noted == Self.confirmationNote(for: copy)
    }

    /// Notes that the owner confirmed the recovery key whose copy is in
    /// place now. Refused while closed or locked, or with no copy.
    public func confirmRecoveryCopy() throws {
        lock.lock()
        defer { lock.unlock() }
        if closed { throw ProofStoreError.closed }
        if locked { throw ProofStoreError.locked }
        guard PathNode.inspect(recoveryCopyURL.path) == .regular(links: 1), let copy = try? Data(contentsOf: recoveryCopyURL) else {
            throw RecoveryError.noRecoveryCopy
        }
        do {
            try AtomicFile.write(Self.confirmationNote(for: copy), to: recoveryConfirmationURL, files: files, faults: faults)
        } catch let failure as AtomicWriteError {
            if failure.stage == .directoryFlush { return }
            throw failure.stage == .target ? ProofStoreError.unsafeFile : ProofStoreError.writeFailed(failure.code)
        }
    }

    static func confirmationNote(for copy: Data) -> Data {
        Data(("confirmed " + SHA256.hash(data: copy).map { String(format: "%02x", $0) }.joined() + "\n").utf8)
    }

    /// Opens a store's recovery copy with the typed recovery key and hands
    /// the store key back to `keys` (a wiped Keychain, or a new Mac with the
    /// folder restored). Holds the store's writer lock meanwhile, so no
    /// writer has it open. A wrong key, a changed copy, a missing copy or an
    /// unreadable marker refuses with nothing imported; `keys` refuses to
    /// replace a key it already holds (`keyExists`). Returns the store's id.
    @discardableResult
    public static func restoreKey(directory: URL, recoveryKey: RecoveryKey, into keys: any KeyImporting) throws -> UUID {
        let directory = directory.standardizedFileURL
        guard PathNode.inspect(directory.path) == .directory else { throw RecoveryError.storeUnreadable }
        let writerLock = try acquireWriterLock(at: directory.appendingPathComponent("proof.lock"))
        defer { writerLock.release() }
        let markerURL = directory.appendingPathComponent("workspace.json")
        guard PathNode.inspect(markerURL.path) == .regular(links: 1),
              let marker = try? boundedDecode(Marker.self, from: Data(contentsOf: markerURL)),
              isUsableMarker(marker) else { throw RecoveryError.storeUnreadable }
        let copyURL = directory.appendingPathComponent(RecoveryCopy.fileName)
        guard PathNode.inspect(copyURL.path) == .regular(links: 1), let sealed = try? Data(contentsOf: copyURL) else {
            throw RecoveryError.noRecoveryCopy
        }
        let material = try RecoveryCopy.open(sealed, under: recoveryKey, workspaceId: marker.workspaceId)
        _ = try keys.importKey(material, for: marker.workspaceId)
        return marker.workspaceId
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
    /// visible replacement, for every answer that claims durability. A
    /// retry that succeeds makes the visible state durable, so it is
    /// published.
    private func syncedState() throws -> State {
        let current = try readyState()
        if unsynced {
            try flushFolder()
            unsynced = false
            publishDurable(current)
        }
        return current
    }

    /// What a terminal or cleanup write would do to one state.
    private enum RunChange {
        /// The state already holds it: nothing to write.
        case unchanged(ParticipantRunEntry)
        case replace(index: Int, with: ParticipantRunEntry)

        var isUnchanged: Bool {
            if case .unchanged = self { return true }
            return false
        }
    }

    /// Plans a terminal or cleanup write against the durable state and
    /// writes it. When an earlier replacement's folder flush still fails,
    /// the visible state decides the answer: if it already holds exactly
    /// this change (that earlier write was this one, now retried), the
    /// answer is undetermined, `replacedUnsynced`, as it was when that
    /// write first failed; otherwise nothing of it was applied and the
    /// answer is the definite `writeFailed`.
    private func applyRunChange(_ plan: (State) throws -> RunChange) throws -> ParticipantRunEntry {
        let current: State
        do {
            current = try syncedState()
        } catch ProofStoreError.replacedUnsynced(let code) {
            if let visible = state, (try? plan(visible))?.isUnchanged == true { throw ProofStoreError.replacedUnsynced(code) }
            throw ProofStoreError.writeFailed(code)
        }
        switch try plan(current) {
        case .unchanged(let entry):
            return entry
        case .replace(let index, let entry):
            var next = current
            next.runs[index] = entry
            try persist(next)
            return entry
        }
    }

    private static func terminalChange(in state: State, runId: String, terminal: ParticipantRunTerminal,
                                       groupCleared: Bool?) throws -> RunChange {
        guard let index = state.runs.firstIndex(where: { $0.runId == runId }) else { throw ProofStoreError.unknownRun }
        let entry = state.runs[index]
        guard let recorded = entry.terminal else {
            guard let ended = entry.recording(terminal: terminal, groupCleared: groupCleared) else { throw ProofStoreError.runEntryConflict }
            return .replace(index: index, with: ended)
        }
        guard recorded == terminal else { throw ProofStoreError.runEntryConflict }
        switch (entry.groupCleared, groupCleared) {
        case let (stored, given) where stored == given: return .unchanged(entry)
        case (true?, false?): return .unchanged(entry)
        case (false?, true?):
            guard let cleared = entry.clearingGroup() else { throw ProofStoreError.runEntryConflict }
            return .replace(index: index, with: cleared)
        default: throw ProofStoreError.runEntryConflict
        }
    }

    private static func groupClearedChange(in state: State, runId: String) throws -> RunChange {
        guard let index = state.runs.firstIndex(where: { $0.runId == runId }) else { throw ProofStoreError.unknownRun }
        let entry = state.runs[index]
        guard entry.terminal != nil, let cleared = entry.groupCleared else { throw ProofStoreError.runEntryConflict }
        if cleared { return .unchanged(entry) }
        guard let next = entry.clearingGroup() else { throw ProofStoreError.runEntryConflict }
        return .replace(index: index, with: next)
    }

    /// One folder flush outside a write, honouring the test hook. Changes
    /// nothing on failure.
    private func flushFolder() throws {
        if let code = faults?.flushRetryFault(target: stateURL) { throw ProofStoreError.replacedUnsynced(code) }
        do {
            try AtomicFile.flushDirectory(directory)
        } catch let failure as AtomicWriteError {
            throw ProofStoreError.replacedUnsynced(failure.code)
        }
    }

    /// Re-reads and validates `state.json`; memory then matches the folder.
    /// A file that is gone or no longer validates makes the store missing
    /// or corrupt, as it would on open, and is published as such.
    /// `authoritative` (only `rereadRuns`, after its folder flush) lets the
    /// identity report release start reservations the folder no longer
    /// shows (Codex Q5).
    private func reloadFromDisk(authoritative: Bool = false) throws -> State {
        let marker = Marker(formatVersion: Self.formatVersion, workspaceId: workspaceId, workspaceHandle: workspaceHandle)
        switch PathNode.inspect(stateURL.path) {
        case .absent:
            state = nil
            statusValue = .missing
            publishUnavailable(.missing)
            throw ProofStoreError.missing
        case .regular(links: 1):
            guard let loaded = Self.loadState(at: stateURL, marker: marker, capacity: ledgerCapacity, cipher: cipher) else { fallthrough }
            state = loaded
            reportIdentities(loaded, releasingStarts: authoritative)
            return loaded
        default:
            state = nil
            statusValue = .corrupt
            publishUnavailable(.corrupt)
            throw ProofStoreError.corrupt
        }
    }

    // MARK: Identity report (called with `lock` held)

    /// Tells the identity index what `visible` (the state memory now holds)
    /// shows. Starts the folder may hold are reserved, never released,
    /// unless `releasingStarts` marks an authoritative re-read.
    private func reportIdentities(_ visible: State, releasingStarts: Bool = false) {
        guard let identityObserver else { return }
        var workspaceIds = Set(visible.ledger.map(\.requestId))
        workspaceIds.formUnion(visible.identities.map(\.requestId))
        workspaceIds.formUnion(visible.receipts.map(\.requestId))
        var starts: [UUID: String] = [:]
        for case let start? in visible.runs.map(\.start) {
            // A loaded or written start id is a canonical UUIDv4.
            if let requestId = UUID(uuidString: start.requestId) { starts[requestId] = start.payloadHash }
        }
        identityObserver.observeStore(workspaceIds: workspaceIds, starts: starts, releasingStarts: releasingStarts)
    }

    // MARK: Published runs copy (called with `lock` held)

    /// `durable` is what the folder durably holds: publish its runs. Start
    /// ids already reserved stay reserved unless this is an authoritative
    /// re-read (Codex Q5: a reservation is released only that way).
    private func publishDurable(_ durable: State, replacingReservations: Bool = false) {
        snapshotLock.lock()
        defer { snapshotLock.unlock() }
        published = ParticipantRunsSnapshot(status: .ready, durable: true, uncertain: false, runs: durable.runs,
                                            reservedStartRequestIds: replacingReservations ? [] : published.reservedStartRequestIds,
                                            locked: locked, closed: closed)
    }

    /// `visible` is shown by the folder but not provably durable: keep the
    /// last durable runs, flag them uncertain and reserve every visible start.
    private func publishUnsynced(_ visible: State) {
        snapshotLock.lock()
        defer { snapshotLock.unlock() }
        published = ParticipantRunsSnapshot(status: .ready, durable: published.durable, uncertain: true, runs: published.runs,
                                            reservedStartRequestIds: published.reservedStartRequestIds.union(visible.startRequestIds),
                                            locked: locked, closed: closed)
    }

    /// No readable state: no runs, nothing durable. Reservations stay;
    /// an unreadable folder releases nothing.
    private func publishUnavailable(_ status: StoreStatus) {
        snapshotLock.lock()
        defer { snapshotLock.unlock() }
        published = ParticipantRunsSnapshot(status: status, durable: false, uncertain: false, runs: [],
                                            reservedStartRequestIds: published.reservedStartRequestIds, locked: locked, closed: closed)
    }

    /// The same copy with the store's current lock flag.
    private func publishFlags() {
        snapshotLock.lock()
        defer { snapshotLock.unlock() }
        published = ParticipantRunsSnapshot(status: published.status, durable: published.durable, uncertain: published.uncertain,
                                            runs: published.runs, reservedStartRequestIds: published.reservedStartRequestIds,
                                            locked: locked, closed: closed)
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

    /// Replaces `state.json`. On success memory adopts `next`, the identity
    /// index is told, and its runs are published. A failure before the
    /// rename leaves memory, the file, the index and the published runs as
    /// they were (`writeFailed`). A failure of the folder flush after the
    /// rename means `next` is what the folder shows: memory adopts it, the
    /// index reserves its ids, its starts are reserved but its runs are not
    /// published, and `replacedUnsynced` is thrown. The committed revision
    /// never goes backwards through this path.
    private func persist(_ next: State) throws {
        if let current = state, next.workspace.revision < current.workspace.revision { throw ProofStoreError.corrupt }
        do {
            try AtomicFile.write(try cipher.seal(Self.encoder.encode(next), as: .state), to: stateURL, files: files, faults: faults)
            state = next
            unsynced = false
            reportIdentities(next)
            publishDurable(next)
        } catch let failure as AtomicWriteError {
            guard failure.stage == .directoryFlush else { throw ProofStoreError.writeFailed(failure.code) }
            state = next
            unsynced = true
            reportIdentities(next)
            publishUnsynced(next)
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
            try AtomicFile.write(try cipher.seal(Self.encoder.encode(retained), as: .attempted(attempt.requestId)), to: url,
                                 files: files, faults: faults)
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
