import Foundation

/// The one request-identity space a participant host shares between its
/// two lanes (participant contract section 3; Codex Q5, Q20, Q22). Every
/// id that may not be reused across lanes is reserved here, and every
/// cross-lane check-and-claim is one atomic step under this index's own
/// lock, so the workspace lane (`DeskHostProtocol`) and the participant
/// lane can never both admit the same request id from two separate views.
///
/// What it holds:
/// - Workspace identities the store shows (`observeStore`): commit
///   results, identity records and dispatch receipts, durable or visible
///   but not yet flushed. Fed by `ProofStore` after each replacement.
/// - The workspace barrier holder's id (`claimHolder`, `releaseHolder`).
/// - Bind and unbind results of the current document (`claimEphemeral`,
///   `forgetEphemerals`).
/// - Starts still `starting`: claimed by the participant lane before its
///   first await and kept while the start record's write is in flight or
///   undetermined (`claimStarting`, `recordStart`, `releaseStarting`).
/// - Starts the store shows a record for (`observeStore`), durable or not.
///
/// This is reservation, not durability (Codex Q5). A reserved start never
/// proves its record durable: only `ProofStore.publishedRuns` does, so a
/// start replays `ok` only from that copy, and `.recorded` here alone is
/// never an `ok`. A start reservation is released only by authority: the
/// participant lane knowing nothing was written (a refusal before the
/// write, or a definite `startNotApplied`), or the store's authoritative
/// re-read (`ProofStore.rereadRuns`) no longer showing the record. Never by
/// a timeout, and never by an older or partial view.
///
/// Lock order: `ProofStore`'s lock, then this one, never the reverse. The
/// store reports to the index while holding its lock; nothing here calls
/// out, so a lane that only asks the index never waits for a store write.
public final class RequestIdentityIndex: @unchecked Sendable {
    /// What `claimStarting` found for a start's request id (section 7
    /// step 4).
    public enum StartClaim: Equatable, Sendable {
        /// The id was free; it is now `starting` under the given hash.
        case claimed
        /// A workspace identity holds the id: a commit result or identity
        /// record, a dispatch receipt, a bind or unbind result, or the
        /// barrier holder. The start is `payload-mismatch`.
        case v1Identity
        /// A start under this id is still `starting` (in flight or
        /// undetermined), claimed with this hash. Its exact bytes are
        /// `unknown`; other bytes are `payload-mismatch`.
        case starting(payloadHash: String)
        /// The store shows a start record under this id, with this hash.
        /// Other bytes are `payload-mismatch`. The same bytes replay `ok`
        /// only when `ProofStore.publishedRuns` holds that start durably;
        /// otherwise they are `unknown` (Codex Q5).
        case recorded(payloadHash: String)
    }

    private let lock = NSLock()
    /// Commit results, identity records and dispatch receipts the store
    /// shows, replaced by each report.
    private var workspaceIds: Set<UUID> = []
    /// Bind and unbind results the workspace lane still replays.
    private var ephemeralIds: Set<UUID> = []
    /// The workspace barrier holder's id.
    private var holderId: UUID?
    /// Starts claimed and not yet settled, with their payload hashes.
    private var startingIds: [UUID: String] = [:]
    /// Starts the store shows a record for, with their payload hashes.
    private var recordedIds: [UUID: String] = [:]

    public init() {}

    // MARK: Workspace lane

    // Internal: only `DeskHostProtocol`, in this module, takes or drops the
    // barrier's and the bind results' reservations, so code outside it (a
    // coordinator target, the WebKit glue) can never pull the index out of
    // step with the workspace actor. Outside DeskHost the index offers only
    // the participant lane's claims and `isStartId`.

    /// The barrier is taken under `requestId`, atomically with the start
    /// lane's claims: false, and nothing changes, when the id is a start's
    /// (`starting` or recorded). The workspace lane refuses that commit
    /// `payload-mismatch` (section 3; Codex Q22).
    func claimHolder(_ requestId: UUID) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !isStart(requestId) else { return false }
        holderId = requestId
        return true
    }

    /// Releases the barrier only for its own holder: a later mutation may
    /// hold it already.
    func releaseHolder(_ requestId: UUID) {
        lock.lock()
        defer { lock.unlock() }
        if holderId == requestId { holderId = nil }
    }

    /// A bind or unbind takes `requestId`, atomically with the start lane's
    /// claims: false, and nothing changes, when the id is a start's
    /// (`starting` or recorded). The workspace lane refuses it
    /// `payload-mismatch` (section 3).
    func claimEphemeral(_ requestId: UUID) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !isStart(requestId) else { return false }
        ephemeralIds.insert(requestId)
        return true
    }

    /// The workspace lane no longer replays these bind or unbind results (a
    /// new document, a lock or close, eviction past capacity, or a request
    /// refused after its claim), so they are no longer identities.
    func forgetEphemerals<Ids: Sequence>(_ requestIds: Ids) where Ids.Element == UUID {
        lock.lock()
        defer { lock.unlock() }
        for requestId in requestIds { ephemeralIds.remove(requestId) }
    }

    /// Whether `requestId` is a start's: still `starting`, or recorded in
    /// the store, durable or not. `workspace.reconcile` answers such an id
    /// `unknown`, never `not-dispatched`, and a commit, bind or unbind under
    /// it is `payload-mismatch` (section 3).
    public func isStartId(_ requestId: UUID) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return isStart(requestId)
    }

    // MARK: Participant lane

    /// Section 7 step 4, decided and reserved in one step: a start's own
    /// record or claim first, then any workspace identity, else the id is
    /// claimed as `starting` under `payloadHash` before the lane's first
    /// await.
    public func claimStarting(_ requestId: UUID, payloadHash: String) -> StartClaim {
        lock.lock()
        defer { lock.unlock() }
        if let claimed = startingIds[requestId] { return .starting(payloadHash: claimed) }
        if let recorded = recordedIds[requestId] { return .recorded(payloadHash: recorded) }
        if holderId == requestId || workspaceIds.contains(requestId) || ephemeralIds.contains(requestId) { return .v1Identity }
        startingIds[requestId] = payloadHash
        return .claimed
    }

    /// The start record for a `starting` id was written durably (the
    /// store's write returned normally, or an authoritative re-read shows
    /// it): it stays reserved as recorded, under the hash it was claimed
    /// with. An id that is not `starting` is left as it is.
    public func recordStart(_ requestId: UUID) {
        lock.lock()
        defer { lock.unlock() }
        guard let payloadHash = startingIds.removeValue(forKey: requestId) else { return }
        recordedIds[requestId] = payloadHash
    }

    /// Nothing was written for this start: it was refused before its write,
    /// its write definitely failed (`startNotApplied`), or an authoritative
    /// re-read no longer shows it. Only the `starting` claim is dropped; a
    /// record the store shows stays reserved until the store's own
    /// authoritative re-read drops it (Codex Q5).
    public func releaseStarting(_ requestId: UUID) {
        lock.lock()
        defer { lock.unlock() }
        startingIds.removeValue(forKey: requestId)
    }

    // MARK: Store reports (called with ProofStore's lock held)

    /// What the store's memory shows after a replacement or a re-read, its
    /// unflushed writes included (Codex Q5). The workspace identities are
    /// replaced: the store's memory is their authority, and only a receipt
    /// the store itself withdrew leaves them. Starts are added; they leave
    /// only when `releasingStarts` marks an authoritative re-read of the
    /// durable folder (`ProofStore.rereadRuns`). An unreadable store reports
    /// nothing, so it releases nothing.
    func observeStore(workspaceIds: Set<UUID>, starts: [UUID: String], releasingStarts: Bool) {
        lock.lock()
        defer { lock.unlock() }
        self.workspaceIds = workspaceIds
        if releasingStarts {
            recordedIds = starts
        } else {
            recordedIds.merge(starts) { _, reported in reported }
        }
    }

    private func isStart(_ requestId: UUID) -> Bool {
        startingIds[requestId] != nil || recordedIds[requestId] != nil
    }
}
