import Foundation
import Testing
@testable import DeskHost

/// Invented runs in the shape of the shared participant vectors, for the
/// identity-space tests: run `n` uses the vectors' id prefixes with `n` as
/// its last digits, and start ids sit above the prepare ids.
enum IdentityInvented {
    static let pin = ParticipantPin(id: "claude-code", label: "Claude Code", model: "invented-pinned-model", executionHost: "this-mac")!
    static let startHash = "a526c37374ffc71176f10125308cdc53ea97ed6939290d5e4fa443a11ca0ad0c"

    static func id(_ prefix: String, _ n: Int) -> String { "\(prefix)-0000-4000-8abc-" + String(format: "%012d", n) }
    static func runId(_ n: Int) -> String { id("71abcdef", n) }
    static func prepareId(_ n: Int) -> UUID { UUID(uuidString: id("62abcdef", n))! }
    static func startId(_ n: Int) -> UUID { UUID(uuidString: id("62abcdef", 900 + n))! }

    static func prepared(_ n: Int) -> ParticipantPreparedRun {
        ParticipantPreparedRun(runId: runId(n), sessionId: id("52abcdef", n), userMessageId: id("72abcdef", n),
                               assistantMessageId: id("73abcdef", n), participant: pin, createdAt: "2026-10-09T00:01:00.000Z",
                               inputHash: "cf80a9a67dce714646fd2d8751d6eb5a4914a4fc17410b7d06a204df01998876", inputBytes: 58,
                               preparedBytes: 554)!
    }

    static func start(_ n: Int) -> ParticipantRunStart {
        ParticipantRunStart(requestId: startId(n).canonicalString, payloadHash: startHash, at: "2026-10-09T00:01:01.000Z",
                            launchId: "75abcdef-0000-4000-8abc-000000000002", cliVersion: "invented-cli-version")!
    }

    /// Prepares run `n` straight on the store, at revision `revision`.
    static func prepare(_ n: Int, on store: ProofStore, revision: Int) throws {
        let attempt = CommitAttempt(requestId: prepareId(n), payloadHash: "prepare-hash-\(n)", expectedRevision: revision - 1,
                                    recordRevision: revision, record: inventedRecord("prepared \(n)", revision: revision),
                                    preparedRun: prepared(n))
        #expect(try store.commit(attempt) == .committed(revision: revision))
    }

    /// Hand-edits the folder so run `n`'s entry no longer holds its start,
    /// and has the store adopt it through a recovery re-read, which is not
    /// authoritative for starts: memory then no longer shows the start,
    /// while the published copy keeps reserving it (Codex Q5).
    static func dropStartOnDisk(_ n: Int, store: ProofStore) throws {
        var state = try #require(try JSONValue.decode(Data(contentsOf: store.stateURL)).objectValue)
        var runs = try #require(state["runs"]?.arrayValue)
        let index = try #require(runs.firstIndex { $0.objectValue?["runId"] == .string(runId(n)) })
        var entry = try #require(runs[index].objectValue)
        entry["start"] = .null
        runs[index] = .object(entry)
        state["runs"] = .array(runs)
        try JSONEncoder().encode(JSONValue.object(state)).write(to: store.stateURL)
        #expect(try store.withdrawUnresolvedDispatch(UUID()) == .nothingToWithdraw, "a recovery re-read of the hand-edited folder")
    }

    /// A plain commit straight on the store.
    static func commit(_ requestId: UUID, on store: ProofStore, revision: Int) throws -> CommitOutcome {
        try store.commit(CommitAttempt(requestId: requestId, payloadHash: "plain-\(requestId.canonicalString)",
                                       expectedRevision: revision - 1, recordRevision: revision,
                                       record: inventedRecord("plain", revision: revision)))
    }
}

/// Two lanes' answers from one race.
private final class RaceOutcome: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Int: Bool] = [:]

    func set(_ lane: Int, _ won: Bool) {
        lock.lock()
        defer { lock.unlock() }
        values[lane] = won
    }

    subscript(lane: Int) -> Bool? {
        lock.lock()
        defer { lock.unlock() }
        return values[lane]
    }
}

/// Runs `first` and `second` on two dedicated threads (never the shared
/// pool, which could run them one after the other). Both spin, sharing no
/// lock, until one instant 100 µs away (time for both to start), so their
/// calls begin within about a hundred nanoseconds of each other rather than
/// a thread start apart. Measured on this Mac, a check-then-claim split
/// across two lock sections then loses about 1 round in 100, so 3,000
/// rounds catch it, not only a missing check (a random extra offset only
/// spread the calls further apart and caught less). False when they did not
/// both finish within 30 s.
private func raceOnThreads(_ first: @escaping @Sendable () -> Void, _ second: @escaping @Sendable () -> Void) -> Bool {
    let startAt = DispatchTime.now().uptimeNanoseconds + 100_000
    let finished = DispatchGroup()
    for body in [first, second] {
        finished.enter()
        Thread {
            while DispatchTime.now().uptimeNanoseconds < startAt {}
            body()
            finished.leave()
        }.start()
    }
    return finished.wait(timeout: .now() + 30) == .success
}

/// Holds one write inside the store's lock: blocks before `stage` of the
/// next atomic write until released (at most 10 s, so a broken test
/// cannot hang).
final class StoreWriteBlocker: AtomicWriteFaults, @unchecked Sendable {
    private let lock = NSLock()
    private var armedStage: AtomicWriteStage?
    private var timedOut = false
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)

    func arm(_ stage: AtomicWriteStage) {
        lock.lock()
        defer { lock.unlock() }
        armedStage = stage
    }

    /// True once the 10 s cap freed a write nobody released.
    var releasedByTimeout: Bool {
        lock.lock()
        defer { lock.unlock() }
        return timedOut
    }

    func fault(before stage: AtomicWriteStage, target: URL) -> Int32? {
        lock.lock()
        let blocks = armedStage == stage
        if blocks { armedStage = nil }
        lock.unlock()
        if blocks {
            entered.signal()
            if release.wait(timeout: .now() + 10) == .timedOut {
                lock.lock()
                timedOut = true
                lock.unlock()
            }
        }
        return nil
    }
}

/// Fails the folder flush of chosen writes, leaving the store unsynced, and
/// once armed signals the next flush retry: the store's next durable read,
/// which runs on its caller's thread inside the store lock.
final class FlushRetryProbe: AtomicWriteFaults, @unchecked Sendable {
    private let lock = NSLock()
    private var writeIndex = -1
    private var failingFlushes: Set<Int> = []
    private var signalsRetry = false
    let retried = DispatchSemaphore(value: 0)

    /// Counts writes from here: write 0 is the next one.
    func failFlushes(of writes: Set<Int>) {
        lock.lock()
        defer { lock.unlock() }
        writeIndex = -1
        failingFlushes = writes
    }

    func armRetrySignal() {
        lock.lock()
        defer { lock.unlock() }
        signalsRetry = true
    }

    func fault(before stage: AtomicWriteStage, target: URL) -> Int32? {
        lock.lock()
        defer { lock.unlock() }
        if stage == .target { writeIndex += 1 }
        return stage == .directoryFlush && failingFlushes.contains(writeIndex) ? EIO : nil
    }

    func flushRetryFault(target: URL) -> Int32? {
        lock.lock()
        let signals = signalsRetry
        signalsRetry = false
        lock.unlock()
        if signals { retried.signal() }
        return nil
    }
}

/// Makes a draft registry's delivery ids. Once armed, the next one blocks
/// inside the registry's lock until released (at most 10 s, so a broken
/// test cannot hang), holding that lock for the test.
final class DraftLockHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var armed = false
    private var timedOut = false
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)

    func arm() {
        lock.lock()
        defer { lock.unlock() }
        armed = true
    }

    /// True once the 10 s cap freed a lock nobody released.
    var releasedByTimeout: Bool {
        lock.lock()
        defer { lock.unlock() }
        return timedOut
    }

    func makeDeliveryId() -> UUID {
        lock.lock()
        let blocks = armed
        armed = false
        lock.unlock()
        if blocks {
            entered.signal()
            if release.wait(timeout: .now() + 10) == .timedOut {
                lock.lock()
                timedOut = true
                lock.unlock()
            }
        }
        return UUID()
    }
}

@Suite("Request identity index")
struct RequestIdentityIndexTests {
    @Test("Two threads released at one instant race claimHolder(X) against claimStarting(X) 3,000 times: exactly one wins every time, and the loser sees the winner")
    func holderAgainstStart() {
        var failures: [String] = []
        for round in 0..<3_000 {
            let index = RequestIdentityIndex()
            let id = UUID()
            let outcome = RaceOutcome()
            guard raceOnThreads({ outcome.set(0, index.claimHolder(id)) },
                                { outcome.set(1, index.claimStarting(id, payloadHash: "start-hash") == .claimed) }) else {
                failures.append("#\(round): the race did not finish")
                break
            }
            guard let holderWon = outcome[0], let startWon = outcome[1] else { failures.append("#\(round): a lane did not answer"); continue }
            if holderWon == startWon { failures.append("#\(round): holder \(holderWon), start \(startWon)") }
            if holderWon, index.claimStarting(id, payloadHash: "start-hash") != .v1Identity { failures.append("#\(round): start after holder") }
            if startWon, index.claimHolder(id) || !index.isStartId(id) { failures.append("#\(round): holder after start") }
        }
        #expect(failures.isEmpty, "\(failures.prefix(5))")
    }

    @Test("Two threads released at one instant race claimEphemeral(X) against claimStarting(X) 3,000 times: exactly one wins every time, and the loser sees the winner")
    func ephemeralAgainstStart() {
        var failures: [String] = []
        for round in 0..<3_000 {
            let index = RequestIdentityIndex()
            let id = UUID()
            let outcome = RaceOutcome()
            guard raceOnThreads({ outcome.set(0, index.claimEphemeral(id)) },
                                { outcome.set(1, index.claimStarting(id, payloadHash: "start-hash") == .claimed) }) else {
                failures.append("#\(round): the race did not finish")
                break
            }
            guard let bindWon = outcome[0], let startWon = outcome[1] else { failures.append("#\(round): a lane did not answer"); continue }
            if bindWon == startWon { failures.append("#\(round): bind \(bindWon), start \(startWon)") }
            if bindWon, index.claimStarting(id, payloadHash: "start-hash") != .v1Identity { failures.append("#\(round): start after bind") }
            if startWon, index.claimEphemeral(id) { failures.append("#\(round): bind after start") }
        }
        #expect(failures.isEmpty, "\(failures.prefix(5))")
    }

    @Test("Starting and recorded hashes come back as given; a start's own claim answers before any workspace identity; recordStart keeps the claim's hash")
    func hashesComeBackAsGiven() {
        let index = RequestIdentityIndex()
        let starting = UUID()
        #expect(index.claimStarting(starting, payloadHash: "first-hash") == .claimed)
        #expect(index.claimStarting(starting, payloadHash: "first-hash") == .starting(payloadHash: "first-hash"), "the same bytes: still starting")
        #expect(index.claimStarting(starting, payloadHash: "other-hash") == .starting(payloadHash: "first-hash"), "other bytes see the claimed hash")
        #expect(index.isStartId(starting))

        let recorded = UUID()
        #expect(index.claimStarting(recorded, payloadHash: "recorded-hash") == .claimed)
        index.recordStart(recorded)
        #expect(index.claimStarting(recorded, payloadHash: "other-hash") == .recorded(payloadHash: "recorded-hash"))
        index.releaseStarting(recorded)
        #expect(index.claimStarting(recorded, payloadHash: "other-hash") == .recorded(payloadHash: "recorded-hash"),
                "dropping a starting claim never frees a recorded start")

        let shown = UUID()
        index.observeStore(workspaceIds: [], starts: [shown: "store-hash"], releasingStarts: false)
        #expect(index.claimStarting(shown, payloadHash: "x") == .recorded(payloadHash: "store-hash"), "a start the store shows")
        #expect(index.claimStarting(starting, payloadHash: "x") == .starting(payloadHash: "first-hash"), "a report leaves starting claims alone")
        #expect(index.claimStarting(recorded, payloadHash: "x") == .recorded(payloadHash: "recorded-hash"),
                "a report that does not show a start never releases it")

        let stray = UUID()
        index.recordStart(stray)
        #expect(!index.isStartId(stray), "recordStart for an id that is not starting records nothing")
        #expect(index.claimStarting(stray, payloadHash: "x") == .claimed, "so the id is still free")
    }

    @Test("forgetEphemerals frees exactly the named bind and unbind ids; a start's id is never taken as a bind, an unbind or the holder")
    func forgetEphemerals() {
        let index = RequestIdentityIndex()
        let first = UUID(), second = UUID(), third = UUID()
        for id in [first, second, third] { #expect(index.claimEphemeral(id)) }
        #expect(index.claimEphemeral(first), "an id already claimed by a bind stays claimed")
        index.forgetEphemerals([first, second])
        #expect(index.claimStarting(first, payloadHash: "h") == .claimed, "a forgotten bind id is free")
        #expect(index.claimStarting(second, payloadHash: "h") == .claimed)
        #expect(index.claimStarting(third, payloadHash: "h") == .v1Identity, "an unnamed one is still a bind result")

        #expect(!index.claimEphemeral(first), "a start's id is never a bind or unbind")
        #expect(!index.claimHolder(second), "nor the barrier holder")
        index.forgetEphemerals([UUID()])
        #expect(index.claimStarting(third, payloadHash: "h") == .v1Identity)
    }

    @Test("The holder is released only by its own id; workspace identities are replaced by each store report, starts only by an authoritative one")
    func holderAndReports() {
        let index = RequestIdentityIndex()
        let holder = UUID(), later = UUID()
        #expect(index.claimHolder(holder))
        #expect(index.claimStarting(holder, payloadHash: "h") == .v1Identity)
        index.releaseHolder(later)
        #expect(index.claimStarting(holder, payloadHash: "h") == .v1Identity, "another id releases nothing")
        #expect(index.claimHolder(later), "a later mutation takes the barrier")
        index.releaseHolder(holder)
        #expect(index.claimStarting(later, payloadHash: "h") == .v1Identity, "a late release of the old holder leaves the new one")
        index.releaseHolder(later)
        #expect(index.claimStarting(holder, payloadHash: "h") == .claimed)
        index.releaseStarting(holder)

        let receipt = UUID(), start = UUID()
        index.observeStore(workspaceIds: [receipt], starts: [start: "store-hash"], releasingStarts: false)
        #expect(index.claimStarting(receipt, payloadHash: "h") == .v1Identity)
        index.observeStore(workspaceIds: [], starts: [:], releasingStarts: false)
        #expect(index.claimStarting(receipt, payloadHash: "h") == .claimed, "a receipt the store withdrew is free")
        #expect(index.isStartId(start), "a report without the start is not authority to release it")
        index.observeStore(workspaceIds: [], starts: [:], releasingStarts: true)
        #expect(!index.isStartId(start), "the authoritative re-read releases it")
    }

    @Test("A store reports at registration and after every write what memory shows, unflushed writes included: commit results, identity records, receipts and recorded starts")
    func storeReportsWhatMemoryShows() throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        try IdentityInvented.prepare(1, on: store, revision: 1)
        try IdentityInvented.prepare(2, on: store, revision: 2)
        try store.recordStart(runId: IdentityInvented.runId(1), IdentityInvented.start(1))
        let plain = UUID()
        #expect(try IdentityInvented.commit(plain, on: store, revision: 3) == .committed(revision: 3))

        let index = RequestIdentityIndex()
        store.setIdentityObserver(index)
        #expect(index.claimStarting(IdentityInvented.prepareId(1), payloadHash: "h") == .v1Identity, "a preparing commit's identity")
        #expect(index.claimStarting(plain, payloadHash: "h") == .v1Identity, "a plain commit's identity")
        #expect(index.claimStarting(IdentityInvented.startId(1), payloadHash: "h") == .recorded(payloadHash: IdentityInvented.startHash))
        #expect(!index.claimHolder(IdentityInvented.startId(1)))

        let conflict = UUID()
        guard case .conflict = try IdentityInvented.commit(conflict, on: store, revision: 3) else {
            Issue.record("expected a revision conflict")
            return
        }
        #expect(index.claimStarting(conflict, payloadHash: "h") == .v1Identity, "a conflict is a terminal result too")

        // Write 0 is the receipt, write 1 the result: both are visible and
        // neither flush succeeded, so only the report of a write that
        // replaced the file unsynced can name this id.
        let unflushed = UUID()
        faults.arm([0: .directoryFlush, 1: .directoryFlush])
        #expect(throws: ProofStoreError.undetermined(requestId: unflushed)) { try IdentityInvented.commit(unflushed, on: store, revision: 4) }
        #expect(index.claimStarting(unflushed, payloadHash: "h") == .v1Identity, "an unflushed result is reserved (Codex Q5)")

        faults.arm([0: .directoryFlush])
        faults.failFlushRetries = true
        #expect(throws: ProofStoreError.startNotApplied, "the pending flush makes another start definitely unwritten") {
            try store.recordStart(runId: IdentityInvented.runId(2), IdentityInvented.start(2))
        }
        #expect(!index.isStartId(IdentityInvented.startId(2)), "a definite failure reserves nothing")
        faults.failFlushRetries = false
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) {
            try store.recordStart(runId: IdentityInvented.runId(2), IdentityInvented.start(2))
        }
        #expect(!store.publishedRuns.startRequestIds.contains(IdentityInvented.startId(2).canonicalString), "not durable, never replayed ok")
        #expect(index.claimStarting(IdentityInvented.startId(2), payloadHash: "h") == .recorded(payloadHash: IdentityInvented.startHash),
                "but reserved in the index")
        #expect(try store.read().revision == 4, "a later flush confirms both writes")
        #expect(store.publishedRuns.startRequestIds.contains(IdentityInvented.startId(2).canonicalString))
        #expect(index.isStartId(IdentityInvented.startId(2)))
    }

    @Test("A receipt the store withdrew leaves the index with it, so its id is free again; a start never leaves on a non-authoritative report")
    func withdrawnReceiptLeaves() throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        let index = RequestIdentityIndex()
        store.setIdentityObserver(index)

        // The result write fails before it is visible; the receipt is withdrawn.
        let withdrawn = UUID()
        faults.arm([1: .create])
        #expect(throws: ProofStoreError.writeFailed(EIO)) { try IdentityInvented.commit(withdrawn, on: store, revision: 1) }
        #expect(try store.dispatchReceipt(for: withdrawn) == nil)
        #expect(index.claimStarting(withdrawn, payloadHash: "h") == .claimed, "nothing was dispatched: the id is free")
        index.releaseStarting(withdrawn)

        // Recovery's re-read is the store's authority for receipts, not for starts.
        faults.arm([:])
        try IdentityInvented.prepare(1, on: store, revision: 1)
        try store.recordStart(runId: IdentityInvented.runId(1), IdentityInvented.start(1))
        try IdentityInvented.dropStartOnDisk(1, store: store)
        #expect(index.isStartId(IdentityInvented.startId(1)), "only rereadRuns may release a start")
        #expect(try store.rereadRuns().entry(for: IdentityInvented.runId(1))?.start == nil)
        #expect(!index.isStartId(IdentityInvented.startId(1)), "the authoritative re-read no longer shows it: released")
        #expect(index.claimStarting(IdentityInvented.prepareId(1), payloadHash: "h") == .v1Identity, "workspace identities stay")
    }

    @Test("An unflushed start stays reserved until an authoritative re-read: through flush failures and a folder that turns unreadable")
    func unflushedStartNeedsAuthority() throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        try IdentityInvented.prepare(1, on: store, revision: 1)
        let index = RequestIdentityIndex()
        store.setIdentityObserver(index)

        faults.arm([0: .directoryFlush])
        faults.failFlushRetries = true
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) {
            try store.recordStart(runId: IdentityInvented.runId(1), IdentityInvented.start(1))
        }
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.rereadRuns() }
        #expect(index.isStartId(IdentityInvented.startId(1)), "a failed re-read releases nothing")

        faults.failFlushRetries = false
        try FileManager.default.removeItem(at: store.stateURL)
        #expect(throws: ProofStoreError.missing) { try store.rereadRuns() }
        #expect(store.publishedRuns.status == .missing)
        #expect(index.isStartId(IdentityInvented.startId(1)), "an unreadable folder releases nothing")
        #expect(index.claimStarting(IdentityInvented.prepareId(1), payloadHash: "h") == .v1Identity, "nor any workspace identity")
    }

    @Test("The index answers within 1 s while a store write holds the store lock: the store reports only after its write, and the index never waits for the store")
    func indexNeverWaitsForTheStore() throws {
        let blocker = StoreWriteBlocker()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: blocker)
        defer { store.close() }
        let index = RequestIdentityIndex()
        store.setIdentityObserver(index)
        let writing = UUID()

        blocker.arm(.sync)
        defer { blocker.release.signal() }
        let writerDone = DispatchSemaphore(value: 0)
        Thread {
            _ = try? IdentityInvented.commit(writing, on: store, revision: 1)
            writerDone.signal()
        }.start()
        try #require(blocker.entered.wait(timeout: .now() + 30) == .success, "the receipt write reached its flush")
        let lockedProbe = DispatchSemaphore(value: 0)
        Thread {
            _ = store.isLocked
            lockedProbe.signal()
        }.start()
        #expect(lockedProbe.wait(timeout: .now() + 0.2) == .timedOut, "the writer really holds the store lock")

        let began = DispatchTime.now()
        let unseen = index.claimStarting(writing, payloadHash: "h")
        let elapsed = DispatchTime.now().uptimeNanoseconds - began.uptimeNanoseconds
        index.releaseStarting(writing)
        blocker.release.signal()
        #expect(elapsed < 1_000_000_000, "the index waited \(elapsed / 1_000_000) ms for the store")
        #expect(!blocker.releasedByTimeout)
        #expect(unseen == .claimed, "nothing is reported before the write itself; a host claims the barrier before it starts one")
        #expect(writerDone.wait(timeout: .now() + 30) == .success)
        #expect(lockedProbe.wait(timeout: .now() + 30) == .success)
        #expect(index.claimStarting(writing, payloadHash: "h") == .v1Identity, "reported once written")
    }
}
