import Foundation
import Testing
@testable import DeskHost

/// Invented values in the shape of the shared participant vectors
/// (`apps/desk/tests/fixtures/native-participant-v1.json`): run `n` uses the
/// vectors' id prefixes with `n` as its last digits.
private enum Invented {
    static let pin = ParticipantPin(id: "claude-code", label: "Claude Code", model: "invented-pinned-model", executionHost: "this-mac")!
    static let inputHash = "cf80a9a67dce714646fd2d8751d6eb5a4914a4fc17410b7d06a204df01998876"
    static let payloadHash = "a526c37374ffc71176f10125308cdc53ea97ed6939290d5e4fa443a11ca0ad0c"
    static let launchId = "75abcdef-0000-4000-8abc-000000000002"

    static func id(_ prefix: String, _ n: Int) -> String { "\(prefix)-0000-4000-8abc-" + String(format: "%012d", n) }
    static func runId(_ n: Int) -> String { id("71abcdef", n) }
    static func sessionId(_ n: Int) -> String { id("52abcdef", n) }
    static func requestId(_ n: Int) -> UUID { UUID(uuidString: id("62abcdef", n))! }
    /// Start request ids sit above the prepare ids so the two never meet.
    static func startId(_ n: Int) -> String { id("62abcdef", 900 + n) }

    static func prepared(_ n: Int, sessionId: String? = nil, userMessageId: String? = nil,
                         assistantMessageId: String? = nil) -> ParticipantPreparedRun {
        ParticipantPreparedRun(runId: runId(n), sessionId: sessionId ?? self.sessionId(n), userMessageId: userMessageId ?? id("72abcdef", n),
                               assistantMessageId: assistantMessageId ?? id("73abcdef", n), participant: pin,
                               createdAt: "2026-10-09T00:01:00.000Z", inputHash: inputHash, inputBytes: 58, preparedBytes: 554)!
    }

    static func start(_ n: Int, requestId: String? = nil) -> ParticipantRunStart {
        ParticipantRunStart(requestId: requestId ?? startId(n), payloadHash: payloadHash, at: "2026-10-09T00:01:01.000Z",
                            launchId: launchId, cliVersion: "invented-cli-version")!
    }

    static func terminal(_ type: String, _ sequence: Int, _ reason: String?, at: String = "2026-10-09T00:01:05.000Z") -> ParticipantRunTerminal {
        ParticipantRunTerminal(type: type, sequence: sequence, at: at, reason: reason)!
    }

    /// Case #8's `afterRuns`, as the vectors write it.
    static let caseEightRuns = """
    [{"runId":"71abcdef-0000-4000-8abc-000000000001","sessionId":"52abcdef-0000-4000-8abc-000000000001",\
    "userMessageId":"72abcdef-0000-4000-8abc-000000000001","assistantMessageId":"73abcdef-0000-4000-8abc-000000000001",\
    "participant":{"id":"claude-code","label":"Claude Code","model":"invented-pinned-model","executionHost":"this-mac"},\
    "createdAt":"2026-10-09T00:01:00.000Z","inputHash":"cf80a9a67dce714646fd2d8751d6eb5a4914a4fc17410b7d06a204df01998876",\
    "inputBytes":58,"preparedBytes":554,"prepareRequestId":"62abcdef-0000-4000-8abc-000000000001","preparedRevision":5,\
    "start":null,"terminal":null,"groupCleared":null}]
    """

    /// Case #27's entry: a recorded start, `completed` (reason null) and a cleared group.
    static let caseTwentySevenEntry = """
    {"runId":"71abcdef-0000-4000-8abc-000000000001","sessionId":"52abcdef-0000-4000-8abc-000000000001",\
    "userMessageId":"72abcdef-0000-4000-8abc-000000000001","assistantMessageId":"73abcdef-0000-4000-8abc-000000000001",\
    "participant":{"id":"claude-code","label":"Claude Code","model":"invented-pinned-model","executionHost":"this-mac"},\
    "createdAt":"2026-10-09T00:01:00.000Z","inputHash":"cf80a9a67dce714646fd2d8751d6eb5a4914a4fc17410b7d06a204df01998876",\
    "inputBytes":58,"preparedBytes":554,"prepareRequestId":"62abcdef-0000-4000-8abc-000000000001","preparedRevision":5,\
    "start":{"requestId":"62abcdef-0000-4000-8abc-000000000014","payloadHash":"a526c37374ffc71176f10125308cdc53ea97ed6939290d5e4fa443a11ca0ad0c",\
    "at":"2026-10-09T00:01:01.000Z","launchId":"75abcdef-0000-4000-8abc-000000000002","cliVersion":"invented-cli-version"},\
    "terminal":{"type":"completed","sequence":3,"at":"2026-10-09T00:01:01.310Z","reason":null},"groupCleared":true}
    """
}

/// A commit attempt that prepares `run` (or none) at `revision`.
private func prepare(_ run: ParticipantPreparedRun?, requestId: UUID, expected: Int, revision: Int, hash: String = "prepare-hash") -> CommitAttempt {
    CommitAttempt(requestId: requestId, payloadHash: hash, expectedRevision: expected, recordRevision: revision,
                  record: inventedRecord("prepared", revision: revision), preparedRun: run)
}

private func diskState(_ store: ProofStore) throws -> [String: JSONValue] {
    try #require(try JSONValue.decode(store.plainStateForTesting()).objectValue)
}

private func diskRuns(_ store: ProofStore) throws -> [JSONValue] {
    try diskState(store)["runs"]?.arrayValue ?? []
}

private func writeState(_ state: [String: JSONValue], to store: ProofStore) throws -> Data {
    let data = try JSONEncoder().encode(JSONValue.object(state))
    try data.writePlainState(to: store)
    return data
}

/// Edits one entry of `runs` in a decoded state file.
private func editRun(_ state: inout [String: JSONValue], _ index: Int, _ edit: (inout [String: JSONValue]) -> Void) {
    var runs = state["runs"]?.arrayValue ?? []
    var entry = runs[index].objectValue ?? [:]
    edit(&entry)
    runs[index] = .object(entry)
    state["runs"] = .array(runs)
}

/// Three runs and one plain commit, closed on disk:
/// run 1 started and ended `stop-incomplete` (group uncleared), run 2 stopped
/// before it started, run 3 only prepared; the plain commit is revision 4.
private func makeThreeRunStore(_ fixture: DeskHostFixture) throws -> (store: ProofStore, plain: UUID) {
    let store = try fixture.makeStore()
    for n in 1...3 {
        #expect(try store.commit(prepare(Invented.prepared(n), requestId: Invented.requestId(n), expected: n - 1, revision: n)) == .committed(revision: n))
    }
    let plain = UUID()
    #expect(try store.commit(prepare(nil, requestId: plain, expected: 3, revision: 4, hash: "plain")) == .committed(revision: 4))
    try store.recordStart(runId: Invented.runId(1), Invented.start(1))
    try store.recordTerminal(runId: Invented.runId(1), Invented.terminal("stopped", 3, "stop-incomplete"), groupCleared: false)
    try store.recordTerminal(runId: Invented.runId(2), Invented.terminal("stopped", 1, "local-stop"), groupCleared: nil)
    store.close()
    return (store, plain)
}

/// Holds a write inside the store's lock: blocks before `stage` of the next
/// atomic write until released (at most 10 s, so a broken test cannot hang).
private final class BlockingFaults: AtomicWriteFaults, @unchecked Sendable {
    private let lock = NSLock()
    private var armedStage: AtomicWriteStage?
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)

    func arm(_ stage: AtomicWriteStage) {
        lock.lock()
        defer { lock.unlock() }
        armedStage = stage
    }

    func fault(before stage: AtomicWriteStage, target: URL) -> Int32? {
        lock.lock()
        let blocks = armedStage == stage
        if blocks { armedStage = nil }
        lock.unlock()
        if blocks {
            entered.signal()
            _ = release.wait(timeout: .now() + 10)
        }
        return nil
    }
}

/// One invariant break per case; each must make the whole store corrupt.
enum RunInvariantBreak: String, CaseIterable, Sendable {
    case extraEntryKey, missingEntryKey, idSharedAcrossFields, sessionAliasesRunIgnoringCase, unknownPrepareRequest,
         identityWithoutRunId, identityRunIdWithoutEntry, preparedRevisionDiffers, startIdIsCommitId, startIdSharedByTwoRuns,
         blankParticipantField, overlongParticipantField, extraParticipantKey, createdAtWithoutMilliseconds, impossibleCreatedAt,
         terminalSequenceZero, unstartedRunFailed, unstartedRunStoppedLater, groupClearedWithoutTerminal,
         stopIncompleteWithoutCleanup, terminalReasonOfAnotherType, uppercaseRunId, uppercaseInputHash, runsNotAList, runsNull,
         completedAtSequenceOne, inputBytesZero, inputBytesOverLimit, preparedBytesOverLimit, unstartedRunGroupCleared,
         unstartedRunStopIncomplete
}

@Suite("Participant runs in the proof store")
struct ParticipantRunStoreTests {
    @Test("Case #8's prepared entry and case #27's ended entry round-trip byte for byte: explicit nulls, .000Z milliseconds, lowercase ids, session case kept")
    func entriesRoundTrip() throws {
        let caseEight = try #require(try JSONValue.decode(Data(Invented.caseEightRuns.utf8)).arrayValue?.first)
        let entry = try #require(ParticipantRunEntry(json: caseEight))
        #expect(entry.jsonValue.canonicalData() == caseEight.canonicalData())
        #expect(entry.createdAt == "2026-10-09T00:01:00.000Z")
        #expect(entry.start == nil && entry.terminal == nil && entry.groupCleared == nil)

        // Through the store's own encoder settings: the nulls are written out.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        let encoded = try encoder.encode(entry)
        let text = String(decoding: encoded, as: UTF8.self)
        for key in ["start", "terminal", "groupCleared"] {
            #expect(text.contains("\"\(key)\" : null"), "\(key) is an explicit null")
        }
        #expect(try JSONDecoder().decode(ParticipantRunEntry.self, from: encoded) == entry)
        #expect(try JSONValue.decode(encoded).objectValue?.count == 14)

        let caseTwentySeven = try JSONValue.decode(Data(Invented.caseTwentySevenEntry.utf8))
        let ended = try #require(ParticipantRunEntry(json: caseTwentySeven))
        #expect(ended.jsonValue.canonicalData() == caseTwentySeven.canonicalData())
        #expect(ended.terminal?.reason == nil && ended.terminal?.at == "2026-10-09T00:01:01.310Z")
        #expect(String(decoding: try encoder.encode(ended), as: UTF8.self).contains("\"reason\" : null"))

        // The store writes case #8's entry from the preparing commit itself.
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        #expect(try store.commit(prepare(Invented.prepared(1), requestId: Invented.requestId(1), expected: 0, revision: 5)) == .committed(revision: 5))
        let expected = try JSONValue.decode(Data(Invented.caseEightRuns.utf8))
        #expect(JSONValue.array(try diskRuns(store)).canonicalData() == expected.canonicalData(), "state.json runs equal case #8's afterRuns")
        let identity = try #require(try diskState(store)["identities"]?.arrayValue?.first?.objectValue)
        #expect(identity["runId"] == .string(Invented.runId(1)))

        // An uppercase session id is kept exactly.
        let upper = "52ABCDEF-0000-4000-8ABC-000000000002"
        #expect(try store.commit(prepare(Invented.prepared(2, sessionId: upper), requestId: Invented.requestId(2), expected: 5, revision: 6)) == .committed(revision: 6))
        #expect(try diskRuns(store).last?.objectValue?["sessionId"] == .string(upper))
        store.close()
        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(reopened.status == .ready)
        #expect(try reopened.refreshPublishedRuns().entry(for: Invented.runId(2))?.sessionId == upper)
    }

    @Test("A store without runs writes no runs key and no identity runId, exactly as before; a format-3 file without runs opens ready; runs:null is corrupt")
    func storesWithoutRunsAreUnchanged() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        #expect(try store.commit(prepare(nil, requestId: UUID(), expected: 0, revision: 1)) == .committed(revision: 1))
        let state = try diskState(store)
        #expect(state["runs"] == nil, "a host without participants writes the file it wrote before")
        #expect(Set(state.keys) == ["formatVersion", "workspace", "receipts", "ledger", "identities", "deliveries"])
        #expect(state["identities"]?.arrayValue?.first?.objectValue?["runId"] == nil)
        #expect(store.publishedRuns.durable && store.publishedRuns.runs.isEmpty)
        store.close()

        let reopened = try fixture.makeStore()
        #expect(reopened.status == .ready)
        #expect(try reopened.refreshPublishedRuns().runs.isEmpty)
        reopened.close()

        var explicit = state
        explicit["runs"] = .array([])
        _ = try writeState(explicit, to: store)
        let withEmpty = try fixture.makeStore()
        #expect(withEmpty.status == .ready, "an explicit empty list is also fine")
        withEmpty.close()

        explicit["runs"] = .null
        let nulled = try writeState(explicit, to: store)
        let corrupt = try fixture.makeStore()
        defer { corrupt.close() }
        #expect(corrupt.status == .corrupt)
        #expect(try store.plainStateForTesting() == nulled)
    }

    @Test("Each section 15 load invariant, broken alone, makes the whole store corrupt; the file is left untouched", arguments: RunInvariantBreak.allCases)
    func brokenInvariantIsCorrupt(_ violation: RunInvariantBreak) throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let (store, plain) = try makeThreeRunStore(fixture)
        let control = try fixture.makeStore()
        #expect(control.status == .ready, "the unedited file opens")
        control.close()

        var state = try diskState(store)
        switch violation {
        case .extraEntryKey:
            editRun(&state, 2) { $0["text"] = .string("invented") }
        case .missingEntryKey:
            editRun(&state, 2) { $0.removeValue(forKey: "groupCleared") }
        case .idSharedAcrossFields:
            let taken = state["runs"]?.arrayValue?[0].objectValue?["assistantMessageId"]
            editRun(&state, 2) { $0["userMessageId"] = taken }
        case .sessionAliasesRunIgnoringCase:
            editRun(&state, 2) { $0["sessionId"] = .string(Invented.runId(3).uppercased()) }
        case .unknownPrepareRequest:
            editRun(&state, 2) { $0["prepareRequestId"] = .string(UUID().canonicalString) }
        case .identityWithoutRunId, .identityRunIdWithoutEntry:
            var identities = state["identities"]?.arrayValue ?? []
            let target = violation == .identityWithoutRunId ? Invented.requestId(3) : plain
            let index = try #require(identities.firstIndex { $0.objectValue?["requestId"]?.stringValue?.lowercased() == target.canonicalString })
            var identity = identities[index].objectValue ?? [:]
            if violation == .identityWithoutRunId {
                identity.removeValue(forKey: "runId")
            } else {
                identity["runId"] = .string(UUID().canonicalString)
            }
            identities[index] = .object(identity)
            state["identities"] = .array(identities)
        case .preparedRevisionDiffers:
            editRun(&state, 2) { $0["preparedRevision"] = .number(9) }
        case .startIdIsCommitId:
            editRun(&state, 0) { entry in
                var start = entry["start"]?.objectValue ?? [:]
                start["requestId"] = .string(plain.canonicalString)
                entry["start"] = .object(start)
            }
        case .startIdSharedByTwoRuns:
            let start = state["runs"]?.arrayValue?[0].objectValue?["start"]
            editRun(&state, 2) { $0["start"] = start }
        case .blankParticipantField, .overlongParticipantField, .extraParticipantKey:
            editRun(&state, 2) { entry in
                var participant = entry["participant"]?.objectValue ?? [:]
                switch violation {
                case .blankParticipantField: participant["label"] = .string(" \u{FEFF}")
                case .overlongParticipantField: participant["model"] = .string(String(repeating: "m", count: 257))
                default: participant["account"] = .string("invented")
                }
                entry["participant"] = .object(participant)
            }
        case .createdAtWithoutMilliseconds:
            editRun(&state, 2) { $0["createdAt"] = .string("2026-10-09T00:01:00Z") }
        case .impossibleCreatedAt:
            editRun(&state, 2) { $0["createdAt"] = .string("2026-02-30T00:01:00.000Z") }
        case .terminalSequenceZero, .unstartedRunFailed, .unstartedRunStoppedLater, .unstartedRunStopIncomplete:
            editRun(&state, 1) { entry in
                var terminal = entry["terminal"]?.objectValue ?? [:]
                switch violation {
                case .terminalSequenceZero: terminal["sequence"] = .number(0)
                case .unstartedRunFailed:
                    terminal["type"] = .string("failed")
                    terminal["reason"] = .string("process-error")
                case .unstartedRunStopIncomplete:
                    // With the cleanup evidence stop-incomplete needs, so only the never-started rule breaks.
                    terminal["reason"] = .string("stop-incomplete")
                    entry["groupCleared"] = .bool(false)
                default: terminal["sequence"] = .number(2)
                }
                entry["terminal"] = .object(terminal)
            }
        case .unstartedRunGroupCleared:
            editRun(&state, 1) { $0["groupCleared"] = .bool(true) }
        case .completedAtSequenceOne:
            editRun(&state, 0) { $0["terminal"] = .object(["type": .string("completed"), "sequence": .number(1),
                                                           "at": .string("2026-10-09T00:01:05.000Z"), "reason": .null]) }
        case .inputBytesZero:
            editRun(&state, 2) { $0["inputBytes"] = .number(0) }
        case .inputBytesOverLimit:
            editRun(&state, 2) { $0["inputBytes"] = .number(262_145) }
        case .preparedBytesOverLimit:
            editRun(&state, 2) { $0["preparedBytes"] = .number(785_409) }
        case .groupClearedWithoutTerminal:
            editRun(&state, 2) { $0["groupCleared"] = .bool(true) }
        case .stopIncompleteWithoutCleanup:
            editRun(&state, 0) { $0["groupCleared"] = .null }
        case .terminalReasonOfAnotherType:
            editRun(&state, 0) { entry in
                var terminal = entry["terminal"]?.objectValue ?? [:]
                terminal["reason"] = .string("timeout")
                entry["terminal"] = .object(terminal)
            }
        case .uppercaseRunId:
            editRun(&state, 2) { $0["runId"] = .string(Invented.runId(3).uppercased()) }
        case .uppercaseInputHash:
            editRun(&state, 2) { $0["inputHash"] = .string(Invented.inputHash.uppercased()) }
        case .runsNotAList:
            state["runs"] = .object([:])
        case .runsNull:
            state["runs"] = .null
        }
        let edited = try writeState(state, to: store)

        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(reopened.status == .corrupt, "\(violation.rawValue)")
        #expect(throws: ProofStoreError.corrupt) { try reopened.read() }
        #expect(throws: ProofStoreError.corrupt) { try reopened.refreshPublishedRuns() }
        #expect(throws: ProofStoreError.corrupt) { try reopened.recordStart(runId: Invented.runId(3), Invented.start(3)) }
        #expect(reopened.publishedRuns.status == .corrupt && reopened.publishedRuns.runs.isEmpty && !reopened.publishedRuns.durable)
        #expect(try store.plainStateForTesting() == edited, "never repaired or overwritten")
    }

    @Test("The value types refuse what sections 6 and 8 forbid: completed before sequence 2, inputBytes outside 1-262,144, preparedBytes outside 1-785,408")
    func valueBounds() {
        #expect(ParticipantRunTerminal(type: "completed", sequence: 1, at: "2026-10-09T00:01:05.000Z", reason: nil) == nil)
        #expect(ParticipantRunTerminal(type: "completed", sequence: 2, at: "2026-10-09T00:01:05.000Z", reason: nil) != nil)
        #expect(ParticipantRunTerminal(type: "stopped", sequence: 1, at: "2026-10-09T00:01:05.000Z", reason: "local-stop") != nil)
        func prepared(inputBytes: Int, preparedBytes: Int) -> ParticipantPreparedRun? {
            ParticipantPreparedRun(runId: Invented.runId(1), sessionId: Invented.sessionId(1), userMessageId: Invented.id("72abcdef", 1),
                                   assistantMessageId: Invented.id("73abcdef", 1), participant: Invented.pin,
                                   createdAt: "2026-10-09T00:01:00.000Z", inputHash: Invented.inputHash,
                                   inputBytes: inputBytes, preparedBytes: preparedBytes)
        }
        #expect(prepared(inputBytes: 1, preparedBytes: 1) != nil)
        #expect(prepared(inputBytes: 262_144, preparedBytes: 785_408) != nil)
        #expect(prepared(inputBytes: 0, preparedBytes: 554) == nil)
        #expect(prepared(inputBytes: 262_145, preparedBytes: 554) == nil)
        #expect(prepared(inputBytes: 58, preparedBytes: 0) == nil)
        #expect(prepared(inputBytes: 58, preparedBytes: 785_409) == nil)
    }

    @Test("A preparing commit under a request id that is not a UUIDv4 is corruptState before its receipt, so the store never writes an entry it would load as corrupt")
    func prepareNeedsAVersionFourRequestId() throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        let before = try store.plainStateForTesting()
        for text in ["a1000000-0000-1000-8000-000000000001", "a5000000-0000-5000-8000-000000000001"] {
            let id = try #require(UUID(uuidString: text))
            faults.arm([:])
            #expect(throws: ProofStoreError.corruptState, "\(text)") {
                try store.commit(prepare(Invented.prepared(1), requestId: id, expected: 0, revision: 1))
            }
            #expect(faults.log.isEmpty, "\(text): refused before the receipt")
            #expect(try store.plainStateForTesting() == before)
            #expect(try store.terminalResult(for: id) == nil)
        }
        // A plain commit under such an id is unchanged from before runs existed.
        let plain = try #require(UUID(uuidString: "a1000000-0000-1000-8000-000000000002"))
        #expect(try store.commit(prepare(nil, requestId: plain, expected: 0, revision: 1)) == .committed(revision: 1))
        #expect(try store.commit(prepare(Invented.prepared(1), requestId: Invented.requestId(1), expected: 1, revision: 2)) == .committed(revision: 2))
        store.close()
        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(reopened.status == .ready)
        #expect(try reopened.refreshPublishedRuns().runs.map(\.runId) == [Invented.runId(1)])
    }

    @Test("Load accepts what section 15 allows: a session id shared by two runs, a run that never spawned holding a terminal and groupCleared null")
    func sharedSessionIsAllowed() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        #expect(try store.commit(prepare(Invented.prepared(1), requestId: Invented.requestId(1), expected: 0, revision: 1)) == .committed(revision: 1))
        #expect(try store.commit(prepare(Invented.prepared(2, sessionId: Invented.sessionId(1)), requestId: Invented.requestId(2),
                                         expected: 1, revision: 2)) == .committed(revision: 2), "a session holds many runs (Codex Q4)")
        try store.recordStart(runId: Invented.runId(2), Invented.start(2))
        try store.recordTerminal(runId: Invented.runId(2), Invented.terminal("failed", 1, "process-error"), groupCleared: nil)
        store.close()
        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(reopened.status == .ready)
        let snapshot = try reopened.refreshPublishedRuns()
        #expect(snapshot.runs.map(\.sessionId) == [Invented.sessionId(1), Invented.sessionId(1)])
        #expect(snapshot.entry(for: Invented.runId(2))?.groupCleared == nil)
    }

    @Test("A preparing commit writes its entry and the identity's runId in the result write (still two writes); a conflict writes neither; reused run or message ids are duplicateRun before any receipt")
    func prepareCommit() throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        faults.arm([:])
        let first = prepare(Invented.prepared(1), requestId: Invented.requestId(1), expected: 0, revision: 1)
        #expect(try store.commit(first) == .committed(revision: 1))
        #expect(Set(faults.log.map { $0.write }) == [0, 1], "receipt then result, as for any commit")
        #expect(try store.terminalResult(for: Invented.requestId(1))?.outcome == .ok)
        let entry = try #require(store.publishedRuns.entry(for: Invented.runId(1)))
        #expect(entry.prepareRequestId == Invented.requestId(1).canonicalString && entry.preparedRevision == 1)
        #expect(try store.commit(first) == .replayed(ReplayEntry(requestId: Invented.requestId(1), operation: .workspaceCommitProof,
                                                                payloadHash: "prepare-hash", outcome: .ok, revision: 1)))

        // The same run under a new id, or any of its three ids reused in any field, writes nothing.
        let reuses = [
            Invented.prepared(1),
            Invented.prepared(2, userMessageId: Invented.id("73abcdef", 1)),
            Invented.prepared(2, assistantMessageId: Invented.runId(1))
        ]
        for (offset, reuse) in reuses.enumerated() {
            let id = UUID()
            faults.arm([:])
            #expect(throws: ProofStoreError.duplicateRun) { try store.commit(prepare(reuse, requestId: id, expected: 1, revision: 2)) }
            #expect(faults.log.isEmpty, "reuse \(offset): refused before the receipt")
            #expect(try store.dispatchReceipt(for: id) == nil)
            #expect(try store.terminalResult(for: id) == nil)
        }

        // A stale revision is a conflict: no entry, no runId, and the run can still be prepared.
        let lost = UUID()
        let stale = try store.commit(prepare(Invented.prepared(2), requestId: lost, expected: 0, revision: 1))
        guard case .conflict = stale else {
            Issue.record("expected a conflict, got \(stale)")
            return
        }
        #expect(store.publishedRuns.entry(for: Invented.runId(2)) == nil)
        let identities = try diskState(store)["identities"]?.arrayValue ?? []
        let conflict = identities.first { $0.objectValue?["requestId"]?.stringValue?.lowercased() == lost.canonicalString }
        #expect(conflict?.objectValue?["runId"] == nil)
        #expect(try store.commit(prepare(Invented.prepared(2), requestId: Invented.requestId(2), expected: 1, revision: 2)) == .committed(revision: 2))

        // A claim never rides with a dictation delivery.
        let delivery = DeliveryRecord(deliveryId: UUID(), bindingId: UUID(), connectionId: "c", generation: 0,
                                      sessionId: Invented.sessionId(3), expectedRevision: 2, pushedAt: Date())
        try store.recordPendingDelivery(delivery)
        let withDelivery = CommitAttempt(requestId: UUID(), payloadHash: "d", expectedRevision: 2, recordRevision: 3,
                                         record: inventedRecord("d", revision: 3), deliveryId: delivery.deliveryId, preparedRun: Invented.prepared(3))
        #expect(throws: ProofStoreError.corruptState) { try store.commit(withDelivery) }
        #expect(try store.read().revision == 2)
    }

    @Test("Start is a compare-and-set: a second start is duplicateRun, a known request id replayExists, an unknown run unknownRun, a run stopped first runNotPrepared; a commit under a start id is payloadMismatch")
    func startCompareAndSet() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        #expect(try store.commit(prepare(Invented.prepared(1), requestId: Invented.requestId(1), expected: 0, revision: 1)) == .committed(revision: 1))
        #expect(try store.commit(prepare(Invented.prepared(2), requestId: Invented.requestId(2), expected: 1, revision: 2)) == .committed(revision: 2))

        let started = try store.recordStart(runId: Invented.runId(1), Invented.start(1))
        #expect(started.start == Invented.start(1))
        let snapshot = store.publishedRuns
        #expect(snapshot.durable && !snapshot.uncertain)
        #expect(snapshot.entry(for: Invented.runId(1))?.start == Invented.start(1))
        #expect(snapshot.startRequestIds == [Invented.startId(1)])

        #expect(throws: ProofStoreError.duplicateRun) { try store.recordStart(runId: Invented.runId(1), Invented.start(5)) }
        #expect(throws: ProofStoreError.replayExists) { try store.recordStart(runId: Invented.runId(1), Invented.start(1)) }
        #expect(throws: ProofStoreError.replayExists, "a commit's id is never a start's") {
            try store.recordStart(runId: Invented.runId(2), Invented.start(2, requestId: Invented.requestId(1).canonicalString))
        }
        #expect(throws: ProofStoreError.replayExists, "another run's start id") {
            try store.recordStart(runId: Invented.runId(2), Invented.start(1))
        }
        #expect(throws: ProofStoreError.unknownRun) { try store.recordStart(runId: Invented.runId(7), Invented.start(7)) }
        try store.recordTerminal(runId: Invented.runId(2), Invented.terminal("stopped", 1, "local-stop"), groupCleared: nil)
        #expect(throws: ProofStoreError.runNotPrepared) { try store.recordStart(runId: Invented.runId(2), Invented.start(2)) }

        let startUUID = try #require(UUID(uuidString: Invented.startId(1)))
        #expect(try store.commit(prepare(nil, requestId: startUUID, expected: 2, revision: 3)) == .payloadMismatch)
        #expect(try store.read().revision == 2)
        store.close()

        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(reopened.status == .ready)
        let reread = try reopened.refreshPublishedRuns()
        #expect(reread.entry(for: Invented.runId(1))?.start == Invented.start(1))
        #expect(reread.entry(for: Invented.runId(2))?.start == nil)
    }

    @Test("A start write that fails before its rename is startNotApplied: file, memory and the published copy are unchanged, and a retry writes it",
          arguments: [AtomicWriteStage.target, .create, .write, .sync, .close, .rename])
    func startDefiniteFailure(stage: AtomicWriteStage) throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        #expect(try store.commit(prepare(Invented.prepared(1), requestId: Invented.requestId(1), expected: 0, revision: 1)) == .committed(revision: 1))
        let before = try store.plainStateForTesting()
        let published = store.publishedRuns
        faults.arm([0: stage])
        #expect(throws: ProofStoreError.startNotApplied) { try store.recordStart(runId: Invented.runId(1), Invented.start(1)) }
        #expect(try store.plainStateForTesting() == before, "\(stage): the old file is intact")
        #expect(store.publishedRuns == published)
        #expect(try store.refreshPublishedRuns().entry(for: Invented.runId(1))?.start == nil, "memory did not adopt it")
        #expect(!store.publishedRuns.reservedStartRequestIds.contains(Invented.startId(1)), "a definite failure reserves nothing")
        faults.arm([:])
        #expect(try store.recordStart(runId: Invented.runId(1), Invented.start(1)).start == Invented.start(1))
    }

    @Test("A start whose folder flush fails is undetermined: visible on disk and reserved, not published, and so is its own retry; a pending flush makes any other start startNotApplied and a commit under its id fail; a later successful flush publishes it")
    func startUndetermined() throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        #expect(try store.commit(prepare(Invented.prepared(1), requestId: Invented.requestId(1), expected: 0, revision: 1)) == .committed(revision: 1))
        #expect(try store.commit(prepare(Invented.prepared(2), requestId: Invented.requestId(2), expected: 1, revision: 2)) == .committed(revision: 2))

        faults.arm([0: .directoryFlush])
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.recordStart(runId: Invented.runId(1), Invented.start(1)) }
        #expect(try diskRuns(store).first?.objectValue?["start"]?.objectValue?["requestId"] == .string(Invented.startId(1)), "the folder shows it")
        var snapshot = store.publishedRuns
        #expect(snapshot.entry(for: Invented.runId(1))?.start == nil, "not durable, so not published")
        #expect(snapshot.uncertain)
        #expect(snapshot.startRequestIds.isEmpty, "an unsynced start never replays ok")
        #expect(snapshot.reservedStartRequestIds == [Invented.startId(1)], "but its id is reserved")

        faults.failFlushRetries = true
        let beforeSecond = try store.plainStateForTesting()
        #expect(throws: ProofStoreError.startNotApplied) { try store.recordStart(runId: Invented.runId(2), Invented.start(2)) }
        #expect(throws: ProofStoreError.startNotApplied, "the reserved id is visible on run 1, not on run 2") {
            try store.recordStart(runId: Invented.runId(2), Invented.start(2, requestId: Invented.startId(1)))
        }
        #expect(throws: ProofStoreError.replacedUnsynced(EIO), "the visible start retried is still undetermined, never definitely unwritten") {
            try store.recordStart(runId: Invented.runId(1), Invented.start(1))
        }
        let startUUID = try #require(UUID(uuidString: Invented.startId(1)))
        #expect(throws: ProofStoreError.replacedUnsynced(EIO), "a commit under the reserved start id answers nothing durable") {
            try store.commit(prepare(nil, requestId: startUUID, expected: 2, revision: 3))
        }
        #expect(try store.plainStateForTesting() == beforeSecond, "nothing of the second start or the commit was written")
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.read() }
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.refreshPublishedRuns() }
        #expect(store.publishedRuns == snapshot)

        faults.failFlushRetries = false
        #expect(try store.read().revision == 2)
        snapshot = store.publishedRuns
        #expect(snapshot.durable && !snapshot.uncertain)
        #expect(snapshot.entry(for: Invented.runId(1))?.start == Invented.start(1), "the confirmed flush published it")
        #expect(snapshot.startRequestIds == [Invented.startId(1)])
        #expect(throws: ProofStoreError.replayExists) { try store.recordStart(runId: Invented.runId(1), Invented.start(1)) }
        #expect(throws: ProofStoreError.replayExists) {
            try store.recordStart(runId: Invented.runId(2), Invented.start(2, requestId: Invented.startId(1)))
        }
        #expect(try store.commit(prepare(nil, requestId: startUUID, expected: 2, revision: 3)) == .payloadMismatch)
        #expect(try store.read().revision == 2)
    }

    @Test("Terminals are written once: an identical repeat is a no-op, a different one runEntryConflict; groupCleared only moves false to true; section 15 pairings are enforced on write")
    func terminalsAndGroupCleared() throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        for n in 1...3 {
            #expect(try store.commit(prepare(Invented.prepared(n), requestId: Invented.requestId(n), expected: n - 1, revision: n)) == .committed(revision: n))
        }
        try store.recordStart(runId: Invented.runId(1), Invented.start(1))
        try store.recordStart(runId: Invented.runId(2), Invented.start(2))
        #expect(throws: ProofStoreError.runEntryConflict, "groupCleared waits for the terminal") { try store.markGroupCleared(runId: Invented.runId(1)) }
        #expect(throws: ProofStoreError.runEntryConflict, "stop-incomplete always carries cleanup evidence") {
            try store.recordTerminal(runId: Invented.runId(1), Invented.terminal("stopped", 3, "stop-incomplete"), groupCleared: nil)
        }

        let stopIncomplete = Invented.terminal("stopped", 3, "stop-incomplete")
        #expect(try store.recordTerminal(runId: Invented.runId(1), stopIncomplete, groupCleared: false).groupCleared == false)
        faults.arm([:])
        #expect(try store.recordTerminal(runId: Invented.runId(1), stopIncomplete, groupCleared: false).terminal == stopIncomplete)
        #expect(faults.log.isEmpty, "an identical repeat writes nothing")
        #expect(throws: ProofStoreError.runEntryConflict) {
            try store.recordTerminal(runId: Invented.runId(1), Invented.terminal("failed", 3, "process-error"), groupCleared: false)
        }
        #expect(throws: ProofStoreError.runEntryConflict) { try store.recordTerminal(runId: Invented.runId(1), stopIncomplete, groupCleared: nil) }

        #expect(try store.markGroupCleared(runId: Invented.runId(1)).groupCleared == true)
        #expect(try diskRuns(store).first?.objectValue?["groupCleared"] == .bool(true))
        #expect(try diskRuns(store).first?.objectValue?["terminal"] == stopIncomplete.jsonValue, "the terminal is never rewritten")
        faults.arm([:])
        #expect(try store.markGroupCleared(runId: Invented.runId(1)).groupCleared == true)
        #expect(try store.recordTerminal(runId: Invented.runId(1), stopIncomplete, groupCleared: false).groupCleared == true, "never back to false")
        #expect(faults.log.isEmpty)

        // A retried terminal write carrying newer cleanup evidence upgrades it.
        let timeout = Invented.terminal("failed", 2, "timeout")
        try store.recordTerminal(runId: Invented.runId(2), timeout, groupCleared: false)
        #expect(try store.recordTerminal(runId: Invented.runId(2), timeout, groupCleared: true).groupCleared == true)

        // A run that never started ends only as Stop's stopped at sequence 1, and spawned nothing to clear.
        #expect(throws: ProofStoreError.runEntryConflict) {
            try store.recordTerminal(runId: Invented.runId(3), Invented.terminal("failed", 1, "process-error"), groupCleared: nil)
        }
        #expect(throws: ProofStoreError.runEntryConflict) {
            try store.recordTerminal(runId: Invented.runId(3), Invented.terminal("stopped", 2, "local-stop"), groupCleared: nil)
        }
        for groupCleared in [false, true] {
            #expect(throws: ProofStoreError.runEntryConflict, "never spawned, so nothing to clear: \(groupCleared)") {
                try store.recordTerminal(runId: Invented.runId(3), Invented.terminal("stopped", 1, "local-stop"), groupCleared: groupCleared)
            }
        }
        #expect(throws: ProofStoreError.runEntryConflict, "a never-dispatched Stop is local-stop") {
            try store.recordTerminal(runId: Invented.runId(3), Invented.terminal("stopped", 1, "stop-incomplete"), groupCleared: false)
        }
        try store.recordTerminal(runId: Invented.runId(3), Invented.terminal("stopped", 1, "local-stop"), groupCleared: nil)
        #expect(throws: ProofStoreError.runEntryConflict, "null means nothing was spawned") { try store.markGroupCleared(runId: Invented.runId(3)) }
        #expect(throws: ProofStoreError.unknownRun) { try store.markGroupCleared(runId: Invented.runId(9)) }
        #expect(throws: ProofStoreError.unknownRun) {
            try store.recordTerminal(runId: Invented.runId(9), Invented.terminal("completed", 2, nil), groupCleared: true)
        }

        store.close()
        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(reopened.status == .ready, "everything written here passes the load invariants")
    }

    @Test("Terminal and cleanup write faults: before the rename writeFailed with the file unchanged; a folder-flush failure is replacedUnsynced and unpublished; while that flush still fails, a change not yet visible is writeFailed and a retry of the visible one replacedUnsynced")
    func terminalWriteFaults() throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        for n in 1...2 {
            #expect(try store.commit(prepare(Invented.prepared(n), requestId: Invented.requestId(n), expected: n - 1, revision: n)) == .committed(revision: n))
            try store.recordStart(runId: Invented.runId(n), Invented.start(n))
        }
        let completed = Invented.terminal("completed", 3, nil)
        let before = try store.plainStateForTesting()
        faults.arm([0: .rename])
        #expect(throws: ProofStoreError.writeFailed(EIO)) { try store.recordTerminal(runId: Invented.runId(1), completed, groupCleared: true) }
        #expect(try store.plainStateForTesting() == before)
        #expect(store.publishedRuns.entry(for: Invented.runId(1))?.terminal == nil)

        faults.arm([0: .directoryFlush])
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.recordTerminal(runId: Invented.runId(1), completed, groupCleared: true) }
        #expect(try diskRuns(store).first?.objectValue?["terminal"] == completed.jsonValue)
        #expect(store.publishedRuns.entry(for: Invented.runId(1))?.terminal == nil)
        #expect(store.publishedRuns.uncertain)

        faults.failFlushRetries = true
        let pending = try store.plainStateForTesting()
        // A change the visible state does not hold was definitely not applied.
        #expect(throws: ProofStoreError.writeFailed(EIO)) {
            try store.recordTerminal(runId: Invented.runId(2), Invented.terminal("failed", 2, "timeout"), groupCleared: true)
        }
        #expect(throws: ProofStoreError.writeFailed(EIO), "a different terminal is not visible either") {
            try store.recordTerminal(runId: Invented.runId(1), Invented.terminal("failed", 3, "timeout"), groupCleared: true)
        }
        // A retry of the visible change stays undetermined, as when it first failed.
        #expect(throws: ProofStoreError.replacedUnsynced(EIO), "the identical retry") {
            try store.recordTerminal(runId: Invented.runId(1), completed, groupCleared: true)
        }
        #expect(throws: ProofStoreError.replacedUnsynced(EIO), "older cleanup evidence is already superseded") {
            try store.recordTerminal(runId: Invented.runId(1), completed, groupCleared: false)
        }
        #expect(throws: ProofStoreError.replacedUnsynced(EIO), "groupCleared:true is already visible") {
            try store.markGroupCleared(runId: Invented.runId(1))
        }
        #expect(try store.plainStateForTesting() == pending)
        #expect(store.publishedRuns.entry(for: Invented.runId(1))?.terminal == nil)

        faults.failFlushRetries = false
        #expect(try store.recordTerminal(runId: Invented.runId(1), completed, groupCleared: true).terminal == completed, "the visible write is now confirmed; the retry is a no-op")
        #expect(store.publishedRuns.entry(for: Invented.runId(1))?.terminal == completed)
        #expect(!store.publishedRuns.uncertain)

        // markGroupCleared's own folder flush failing: visible, unpublished, and its retry undetermined until a flush works.
        let timeout = Invented.terminal("failed", 2, "timeout")
        try store.recordTerminal(runId: Invented.runId(2), timeout, groupCleared: false)
        faults.arm([0: .directoryFlush])
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.markGroupCleared(runId: Invented.runId(2)) }
        #expect(try diskRuns(store).last?.objectValue?["groupCleared"] == .bool(true))
        #expect(store.publishedRuns.entry(for: Invented.runId(2))?.groupCleared == false, "not durable, so not published")
        #expect(store.publishedRuns.uncertain)
        faults.failFlushRetries = true
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.markGroupCleared(runId: Invented.runId(2)) }
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.recordTerminal(runId: Invented.runId(2), timeout, groupCleared: true) }
        faults.failFlushRetries = false
        #expect(try store.markGroupCleared(runId: Invented.runId(2)).groupCleared == true)
        #expect(store.publishedRuns.entry(for: Invented.runId(2))?.groupCleared == true)
    }

    @Test("Q29: a never-started run's cancellation whose flush fails stays undetermined on every retry while the flush fails, never a definite failure; it is published once a flush works")
    func cancellationRetryStaysUndetermined() throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        #expect(try store.commit(prepare(Invented.prepared(1), requestId: Invented.requestId(1), expected: 0, revision: 1)) == .committed(revision: 1))
        let cancel = Invented.terminal("stopped", 1, "local-stop")
        faults.arm([0: .directoryFlush])
        #expect(throws: ProofStoreError.replacedUnsynced(EIO), "Stop A") { try store.recordTerminal(runId: Invented.runId(1), cancel, groupCleared: nil) }
        faults.failFlushRetries = true
        for attempt in 1...2 {
            #expect(throws: ProofStoreError.replacedUnsynced(EIO), "Stop B or reconcile retry \(attempt)") {
                try store.recordTerminal(runId: Invented.runId(1), cancel, groupCleared: nil)
            }
        }
        #expect(throws: ProofStoreError.writeFailed(EIO), "a different cancellation time is not the visible one") {
            try store.recordTerminal(runId: Invented.runId(1), Invented.terminal("stopped", 1, "local-stop", at: "2026-10-09T00:01:06.000Z"), groupCleared: nil)
        }
        #expect(store.publishedRuns.entry(for: Invented.runId(1))?.terminal == nil)
        faults.failFlushRetries = false
        #expect(try store.recordTerminal(runId: Invented.runId(1), cancel, groupCleared: nil).terminal == cancel)
        #expect(store.publishedRuns.entry(for: Invented.runId(1))?.terminal == cancel)
        #expect(throws: ProofStoreError.runNotPrepared) { try store.recordStart(runId: Invented.runId(1), Invented.start(1)) }
    }

    @Test("rereadRuns flushes then re-reads the folder: it fails while the flush fails, returns a hand-edited runs list, and a hand-edit that breaks an invariant makes the store corrupt")
    func rereadRuns() throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        for n in 1...2 {
            #expect(try store.commit(prepare(Invented.prepared(n), requestId: Invented.requestId(n), expected: n - 1, revision: n)) == .committed(revision: n))
        }
        faults.arm([0: .directoryFlush])
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.recordStart(runId: Invented.runId(1), Invented.start(1)) }
        let undetermined = store.publishedRuns

        faults.failFlushRetries = true
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.rereadRuns() }
        #expect(store.publishedRuns == undetermined, "a failed re-read changes nothing")

        faults.failFlushRetries = false
        var snapshot = try store.rereadRuns()
        #expect(snapshot.durable && !snapshot.uncertain)
        #expect(snapshot.entry(for: Invented.runId(1))?.start == Invented.start(1), "record present: the start is now known durable")

        // The folder, not memory, is the authority.
        var state = try diskState(store)
        editRun(&state, 1) { entry in
            entry["terminal"] = Invented.terminal("stopped", 1, "local-stop").jsonValue
        }
        _ = try writeState(state, to: store)
        snapshot = try store.rereadRuns()
        #expect(JSONValue.array(snapshot.runs.map(\.jsonValue)).canonicalData() == JSONValue.array(try diskRuns(store)).canonicalData())
        #expect(snapshot.entry(for: Invented.runId(2))?.terminal?.reason == "local-stop")
        #expect(throws: ProofStoreError.runNotPrepared) { try store.recordStart(runId: Invented.runId(2), Invented.start(2)) }

        editRun(&state, 1) { entry in
            var terminal = entry["terminal"]?.objectValue ?? [:]
            terminal["sequence"] = .number(0)
            entry["terminal"] = .object(terminal)
        }
        let broken = try writeState(state, to: store)
        #expect(throws: ProofStoreError.corrupt) { try store.rereadRuns() }
        #expect(store.status == .corrupt)
        #expect(store.publishedRuns.status == .corrupt && store.publishedRuns.runs.isEmpty)
        #expect(store.publishedRuns.reservedStartRequestIds.contains(Invented.startId(1)), "an unreadable folder releases no reservation")
        #expect(throws: ProofStoreError.corrupt) { try store.rereadRuns() }
        #expect(try store.plainStateForTesting() == broken, "left for a person")
    }

    @Test("rereadRuns releases a start's reservation once the durable folder no longer shows that start, and the id can then be recorded")
    func rereadReleasesAbsentReservation() throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        #expect(try store.commit(prepare(Invented.prepared(1), requestId: Invented.requestId(1), expected: 0, revision: 1)) == .committed(revision: 1))
        faults.arm([0: .directoryFlush])
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.recordStart(runId: Invented.runId(1), Invented.start(1)) }
        #expect(store.publishedRuns.reservedStartRequestIds == [Invented.startId(1)])

        // The replacement did not survive: the folder shows the run unstarted.
        var state = try diskState(store)
        editRun(&state, 0) { $0["start"] = .null }
        _ = try writeState(state, to: store)
        let snapshot = try store.rereadRuns()
        #expect(snapshot.durable && !snapshot.uncertain)
        #expect(snapshot.entry(for: Invented.runId(1))?.start == nil)
        #expect(snapshot.reservedStartRequestIds.isEmpty, "record absent: the reservation is released")
        #expect(try store.recordStart(runId: Invented.runId(1), Invented.start(1)).start == Invented.start(1))
        #expect(store.publishedRuns.startRequestIds == [Invented.startId(1)])
    }

    @Test("A locked or closed store refuses run writes and its copy says so (closed holds no runs); lookup proves a run absent only from a ready, durable, settled, open copy")
    func lockCloseAndLookup() throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        #expect(store.publishedRuns.lookup(runId: Invented.runId(1)) == .absent, "a fresh store is durable at once")
        for n in 1...2 {
            #expect(try store.commit(prepare(Invented.prepared(n), requestId: Invented.requestId(n), expected: n - 1, revision: n)) == .committed(revision: n))
        }
        let entry = try #require(store.publishedRuns.entry(for: Invented.runId(1)))
        #expect(store.publishedRuns.lookup(runId: Invented.runId(1)) == .found(entry))
        #expect(store.publishedRuns.lookup(runId: Invented.runId(9)) == .absent)

        store.lockStore()
        let locked = store.publishedRuns
        #expect(locked.locked && !locked.closed && locked.durable)
        #expect(locked.entry(for: Invented.runId(1)) == entry, "the last durable copy stays")
        #expect(locked.lookup(runId: Invented.runId(9)) == .unproven)
        #expect(throws: ProofStoreError.locked) { try store.recordStart(runId: Invented.runId(1), Invented.start(1)) }
        #expect(throws: ProofStoreError.locked) {
            try store.recordTerminal(runId: Invented.runId(2), Invented.terminal("stopped", 1, "local-stop"), groupCleared: nil)
        }
        #expect(throws: ProofStoreError.locked) { try store.markGroupCleared(runId: Invented.runId(1)) }
        #expect(throws: ProofStoreError.locked) { try store.rereadRuns() }
        #expect(throws: ProofStoreError.locked) { try store.refreshPublishedRuns() }
        store.unlockStore()
        #expect(!store.publishedRuns.locked)
        #expect(store.publishedRuns.lookup(runId: Invented.runId(9)) == .absent)

        // A newer write whose flush failed leaves absence unproven; the durable entry is still found.
        faults.arm([0: .directoryFlush])
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try store.recordStart(runId: Invented.runId(1), Invented.start(1)) }
        #expect(store.publishedRuns.lookup(runId: Invented.runId(9)) == .unproven)
        #expect(store.publishedRuns.lookup(runId: Invented.runId(1)) == .found(entry))
        #expect(try store.refreshPublishedRuns().lookup(runId: Invented.runId(9)) == .absent)

        store.close()
        let closed = store.publishedRuns
        #expect(closed.closed && !closed.durable && !closed.uncertain && closed.runs.isEmpty)
        #expect(closed.reservedStartRequestIds == [Invented.startId(1)])
        #expect(closed.lookup(runId: Invented.runId(1)) == .unproven)
        #expect(throws: ProofStoreError.closed) { try store.recordStart(runId: Invented.runId(2), Invented.start(2)) }
        #expect(throws: ProofStoreError.closed) {
            try store.recordTerminal(runId: Invented.runId(2), Invented.terminal("stopped", 1, "local-stop"), groupCleared: nil)
        }
        #expect(throws: ProofStoreError.closed) { try store.markGroupCleared(runId: Invented.runId(1)) }
        #expect(throws: ProofStoreError.closed) { try store.refreshPublishedRuns() }
        #expect(store.publishedRuns == closed)
    }

    @Test("publishedRuns answers within 1 s while another thread holds the store lock inside a blocked write")
    func publishedRunsNeverWaitsForTheWriterLock() throws {
        let faults = BlockingFaults()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(faults: faults)
        defer { store.close() }
        #expect(try store.commit(prepare(Invented.prepared(1), requestId: Invented.requestId(1), expected: 0, revision: 1)) == .committed(revision: 1))
        try store.recordStart(runId: Invented.runId(1), Invented.start(1))

        // Dedicated threads, not GCD's shared pool: under the parallel suite
        // a queued block can wait seconds for a worker, which would time the
        // pool instead of the store.
        faults.arm(.sync)
        defer { faults.release.signal() }
        let writerDone = DispatchSemaphore(value: 0)
        Thread {
            _ = try? store.recordTerminal(runId: Invented.runId(1), Invented.terminal("completed", 3, nil), groupCleared: true)
            writerDone.signal()
        }.start()
        try #require(faults.entered.wait(timeout: .now() + 30) == .success, "the write reached its flush")

        let lockedProbe = DispatchSemaphore(value: 0)
        Thread {
            _ = store.isLocked
            lockedProbe.signal()
        }.start()
        #expect(lockedProbe.wait(timeout: .now() + 0.2) == .timedOut, "the writer really holds the store lock")

        // Read on this thread. Were it to wait for the lock, the hook's
        // 10 s cap would free it and the elapsed time would fail the test.
        let began = DispatchTime.now()
        let seen = store.publishedRuns
        let elapsed = DispatchTime.now().uptimeNanoseconds - began.uptimeNanoseconds
        faults.release.signal()
        #expect(elapsed < 1_000_000_000, "publishedRuns waited \(elapsed / 1_000_000) ms for the writer lock")
        #expect(seen.entry(for: Invented.runId(1))?.start == Invented.start(1))
        #expect(seen.entry(for: Invented.runId(1))?.terminal == nil, "the write in progress is not published")
        #expect(writerDone.wait(timeout: .now() + 30) == .success)
        #expect(lockedProbe.wait(timeout: .now() + 30) == .success)
        #expect(store.publishedRuns.entry(for: Invented.runId(1))?.terminal == Invented.terminal("completed", 3, nil))
    }

    @Test("Runs survive ledger capacity eviction, and reopen; the start id stays refused for commits")
    func runsSurviveEviction() throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(ledgerCapacity: 3)
        #expect(try store.commit(prepare(Invented.prepared(1), requestId: Invented.requestId(1), expected: 0, revision: 1)) == .committed(revision: 1))
        try store.recordStart(runId: Invented.runId(1), Invented.start(1))
        for revision in 2...6 {
            #expect(try store.commit(prepare(nil, requestId: UUID(), expected: revision - 1, revision: revision)) == .committed(revision: revision))
        }
        #expect(try store.ledgerEntry(for: Invented.requestId(1)) == nil, "the full result is evicted")
        #expect(try store.dispatchReceipt(for: Invented.requestId(1)) == nil)
        #expect(try store.terminalResult(for: Invented.requestId(1))?.outcome == .ok, "the identity stays")
        #expect(store.publishedRuns.entry(for: Invented.runId(1))?.start == Invented.start(1), "runs are never evicted")
        store.close()

        let reopened = try ProofStore(directory: fixture.storeDirectory, keys: fixture.keys, ledgerCapacity: 3)
        defer { reopened.close() }
        #expect(reopened.status == .ready)
        #expect(try reopened.refreshPublishedRuns().entry(for: Invented.runId(1))?.start == Invented.start(1))
        let startUUID = try #require(UUID(uuidString: Invented.startId(1)))
        #expect(try reopened.commit(prepare(nil, requestId: startUUID, expected: 6, revision: 7)) == .payloadMismatch)
    }

    @Test("The published copy at open: a fresh store is durable at once; an opened one is not durable (its starts reserved) until a flush succeeds; missing and corrupt stores publish their status")
    func snapshotAtOpen() throws {
        let faults = WriteFaultScript()
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore()
        #expect(store.publishedRuns.durable && store.publishedRuns.status == .ready && store.publishedRuns.runs.isEmpty)
        #expect(try store.commit(prepare(Invented.prepared(1), requestId: Invented.requestId(1), expected: 0, revision: 1)) == .committed(revision: 1))
        try store.recordStart(runId: Invented.runId(1), Invented.start(1))
        store.close()

        faults.failFlushRetries = true
        let reopened = try fixture.makeStore(faults: faults)
        let opened = reopened.publishedRuns
        #expect(opened.status == .ready && !opened.durable && opened.uncertain && opened.runs.isEmpty)
        #expect(opened.reservedStartRequestIds == [Invented.startId(1)])
        #expect(opened.startRequestIds.isEmpty)
        #expect(opened.lookup(runId: Invented.runId(1)) == .unproven, "a prepared run is not proven absent before the first flush")
        #expect(opened.lookup(runId: Invented.runId(9)) == .unproven)
        #expect(throws: ProofStoreError.replacedUnsynced(EIO)) { try reopened.refreshPublishedRuns() }
        #expect(reopened.publishedRuns == opened)
        faults.failFlushRetries = false
        let refreshed = try reopened.refreshPublishedRuns()
        #expect(refreshed.durable && !refreshed.uncertain)
        #expect(refreshed.entry(for: Invented.runId(1))?.start == Invented.start(1))
        #expect(refreshed.lookup(runId: Invented.runId(9)) == .absent)
        reopened.close()

        try fixture.files.removeItem(at: store.stateURL)
        let missing = try fixture.makeStore()
        #expect(missing.publishedRuns.status == .missing && !missing.publishedRuns.durable && missing.publishedRuns.runs.isEmpty)
        #expect(missing.publishedRuns.lookup(runId: Invented.runId(9)) == .unproven)
        missing.close()

        try Data("{".utf8).writePlainState(to: store)
        let corrupt = try fixture.makeStore()
        defer { corrupt.close() }
        #expect(corrupt.publishedRuns.status == .corrupt && !corrupt.publishedRuns.durable)
        #expect(corrupt.publishedRuns.lookup(runId: Invented.runId(9)) == .unproven)
    }
}
