import Foundation
import Testing
@testable import DeskHost

/// Invented values in the shape of the shared participant vectors: run `n`
/// uses the vectors' id prefixes with `n` as its last digits, and run 1 is
/// exactly `prepared-r5`'s run.
private enum Prep {
    static let pin = ParticipantPin(id: "claude-code", label: "Claude Code", model: "invented-pinned-model", executionHost: "this-mac")!
    static let earlierPin = ParticipantPin(id: "claude-code", label: "Claude Code", model: "invented-newer-pinned-model",
                                           executionHost: "this-mac")!
    static let createdAt = "2026-10-09T00:01:00.000Z"
    static let question = "Invented question: \"two plus two?\"\nReply in one line. \u{1F600}"
    static let questionHash = "cf80a9a67dce714646fd2d8751d6eb5a4914a4fc17410b7d06a204df01998876"

    static func id(_ prefix: String, _ n: Int) -> String { "\(prefix)-0000-4000-8abc-" + String(format: "%012d", n) }
    static func runId(_ n: Int) -> String { id("71abcdef", n) }
    static func sessionId(_ n: Int) -> String { id("52abcdef", n) }

    static func run(_ n: Int = 1, chunks: [JSONValue]? = nil, _ edit: (inout [String: JSONValue]) -> Void = { _ in }) -> JSONValue {
        var run: [String: JSONValue] = [
            "version": .number(1),
            "runId": .string(runId(n)),
            "sessionId": .string(sessionId(n)),
            "userMessageId": .string(id("72abcdef", n)),
            "assistantMessageId": .string(id("73abcdef", n)),
            "participant": pin.jsonValue,
            "inputChunks": .array(chunks ?? [.string(question)]),
            "outputChunks": .array([]),
            "lastSequence": .number(0),
            "phase": .string("prepared"),
            "createdAt": .string(createdAt),
            "updatedAt": .string(createdAt)
        ]
        edit(&run)
        return .object(run)
    }

    static func record(revision: Int = 5, schemaVersion: Int = 2, runs: JSONValue? = .array([run()])) -> [String: JSONValue] {
        var record: [String: JSONValue] = ["schemaVersion": .number(Double(schemaVersion)), "revision": .number(Double(revision)),
                                           "label": .string("invented prepare record")]
        if let runs { record["conversationRuns"] = runs }
        return record
    }

    static func claimFields(_ n: Int = 1) -> [String: JSONValue] {
        [
            "runId": .string(runId(n)),
            "sessionId": .string(sessionId(n)),
            "userMessageId": .string(id("72abcdef", n)),
            "assistantMessageId": .string(id("73abcdef", n)),
            "participantId": .string("claude-code"),
            "createdAt": .string(createdAt)
        ]
    }

    static func claim(_ n: Int = 1, _ edit: (inout [String: JSONValue]) -> Void = { _ in }) -> JSONValue {
        var fields = claimFields(n)
        edit(&fields)
        return .object(fields)
    }

    static func prepare(_ claim: JSONValue = claim(), record: [String: JSONValue] = record(), pin: ParticipantPin = pin,
                        inputBound: Int? = nil) -> ParticipantCheck<ParticipantPreparedRun> {
        ParticipantPrepare.prepare(claim: claim, record: record, pin: pin, inputBound: inputBound)
    }

    /// Run `n`'s prepared fields as the store records them.
    static func preparedRun(_ n: Int = 1) -> ParticipantPreparedRun? {
        ParticipantPreparedRun(runId: runId(n), sessionId: sessionId(n), userMessageId: id("72abcdef", n), assistantMessageId: id("73abcdef", n),
                               participant: pin, createdAt: createdAt, inputHash: questionHash, inputBytes: 58, preparedBytes: 554)
    }

    /// An invented start under `requestId`.
    static func start(_ requestId: String) -> ParticipantRunStart? {
        ParticipantRunStart(requestId: requestId, payloadHash: String(repeating: "a", count: 64), at: "2026-10-09T00:01:01.000Z",
                            launchId: "75abcdef-0000-4000-8abc-000000000002", cliVersion: "invented-cli-version")
    }

    static func reason(_ check: ParticipantCheck<ParticipantPreparedRun>) -> HostRefusal? {
        if case .refused(let reason) = check { return reason }
        return nil
    }

    /// Text of exactly `bytes` UTF-8 bytes in `characters` characters, from
    /// ASCII, two-byte é and four-byte 😀 (the vectors' trial alphabet), with
    /// one three-byte € when the byte count needs it.
    static func text(bytes: Int, prefix: String = "Invented trial question near the limit: ") -> String {
        var text = prefix
        while text.utf8.count + 6 <= bytes { text += "\u{E9}\u{1F600}" }
        while text.utf8.count + 2 <= bytes { text += "\u{E9}" }
        if text.utf8.count < bytes { text += "a" }
        return text
    }
}

/// A participant host (or, with `participants: false`, a v1 host) on a
/// fresh store whose committed record is `seed`.
private final class PrepareHost {
    let fixture: DeskHostFixture
    let store: ProofStore
    let connections = ConnectionRegistry()
    let sink = RecordingSink()
    let host: DeskHostProtocol
    let connection: HostConnection

    init(seed: [String: JSONValue] = ["schemaVersion": .number(1), "revision": .number(4)], participants: Bool = true,
         inputBound: Int? = nil, executor: MutationExecutor = BackgroundMutationExecutor(), faults: AtomicWriteFaults? = nil) throws {
        fixture = try DeskHostFixture()
        store = try fixture.makeStore(seed: WorkspaceSeed(workspaceHandle: "invented-workspace-handle", record: seed), faults: faults)
        let configuration = participants ? ParticipantHostConfiguration(pin: Prep.pin, inputBound: inputBound) : nil
        host = DeskHostProtocol(store: store, connections: connections, drafts: DraftBindingRegistry(), info: HostHarness.info,
                                events: sink, executor: executor, participants: configuration)
        connection = connections.issue()
    }

    func clean() {
        store.close()
        fixture.clean()
    }

    func commitRequest(expected: Int = 4, record: [String: JSONValue], claim: JSONValue? = nil, deliveryId: String? = nil,
                       handle: String = "invented-workspace-handle", requestId: UUID = UUID()) -> HostRequest {
        var payload: [String: JSONValue] = [
            "workspaceHandle": .string(handle), "expectedRevision": .number(Double(expected)), "record": .object(record)
        ]
        if let claim { payload["participantRun"] = claim }
        if let deliveryId { payload["dictationDeliveryId"] = .string(deliveryId) }
        return HostRequest(requestId: requestId, connectionId: connection.id, generation: connection.generation,
                           operation: .workspaceCommitProof, payload: payload)
    }

    func commit(expected: Int = 4, record: [String: JSONValue], claim: JSONValue? = nil, deliveryId: String? = nil,
                handle: String = "invented-workspace-handle", requestId: UUID = UUID()) async -> HostResponse {
        await host.handle(commitRequest(expected: expected, record: record, claim: claim, deliveryId: deliveryId, handle: handle,
                                        requestId: requestId))
    }

    func reconcile(_ target: String) async -> HostResponse {
        await host.handle(HostRequest(requestId: UUID(), connectionId: connection.id, generation: connection.generation,
                                      operation: .workspaceReconcile,
                                      payload: ["workspaceHandle": .string(store.workspaceHandle), "targetRequestId": .string(target)]))
    }

    var diskState: [String: JSONValue] {
        get throws { try #require(try JSONValue.decode(store.plainStateForTesting()).objectValue) }
    }
}

@Suite("Participant preparation (contract section 6)")
struct ParticipantPrepareTests {
    // MARK: Step 1 and its precedence (Codex Q6)

    @Test("Step 1: unknown keys, then the four identities in order, then participantId and createdAt, then distinctness; missing identities are invalid-identity")
    func claimStepOne() {
        func reason(_ claim: JSONValue) -> HostRefusal? {
            if case .refused(let reason) = ParticipantPrepare.claim(claim) { return reason }
            return nil
        }
        #expect(ParticipantPrepare.claim(Prep.claim()) == .passed(ParticipantClaim(
            runId: Prep.runId(1), sessionId: Prep.sessionId(1), userMessageId: Prep.id("72abcdef", 1),
            assistantMessageId: Prep.id("73abcdef", 1), participantId: "claude-code", createdAt: Prep.createdAt)))
        for notObject: JSONValue in [.null, .string("claim"), .array([Prep.claim()]), .number(1)] {
            #expect(reason(notObject) == .malformedEnvelope)
        }

        // Unknown keys win over everything else in the claim.
        #expect(reason(Prep.claim { $0["extra"] = .bool(true) }) == .unknownField)
        #expect(reason(Prep.claim { $0["extra"] = .bool(true); $0["runId"] = .string("bad") }) == .unknownField)
        #expect(reason(.object(["extra": .null])) == .unknownField, "an unknown key beside missing ones")
        #expect(reason(Prep.claim { $0["inputHash"] = .string(Prep.questionHash) }) == .unknownField, "the claim carries no hash")

        // Each identity: missing, wrong type, wrong form.
        for key in ["runId", "sessionId", "userMessageId", "assistantMessageId"] {
            #expect(reason(Prep.claim { $0.removeValue(forKey: key) }) == .invalidIdentity, "missing \(key)")
            #expect(reason(Prep.claim { $0[key] = .number(1) }) == .invalidIdentity, "non-string \(key)")
            #expect(reason(Prep.claim { $0[key] = .string("") }) == .invalidIdentity, "empty \(key)")
            #expect(reason(Prep.claim { $0[key] = .string("6ba7b810-9dad-11d1-80b4-00c04fd430c8x") }) == .invalidIdentity)
        }
        for key in ["runId", "userMessageId", "assistantMessageId"] {
            #expect(reason(Prep.claim { $0[key] = .string(Prep.id("7aabcdef", 9).uppercased()) }) == .invalidIdentity,
                    "\(key) must be canonical lowercase")
            #expect(reason(Prep.claim { $0[key] = .string("6ba7b810-9dad-11d1-80b4-00c04fd430c8") }) == .invalidIdentity,
                    "\(key) must be version 4")
        }
        // A session id is a record id: any of versions 1-5, its case kept.
        if case .passed(let upper) = ParticipantPrepare.claim(Prep.claim { $0["sessionId"] = .string(Prep.sessionId(1).uppercased()) }) {
            #expect(upper.sessionId == Prep.sessionId(1).uppercased())
        } else {
            Issue.record("an uppercase session id is a valid record id")
        }
        #expect(ParticipantPrepare.claim(Prep.claim { $0["sessionId"] = .string("6ba7b810-9dad-11d1-80b4-00c04fd430c8") }) != .refused(.invalidIdentity))

        // participantId and createdAt are malformed-envelope.
        for bad: JSONValue? in [nil, .number(1), .string(""), .string(" \u{3000}"), .string(String(repeating: "x", count: 257))] {
            #expect(reason(Prep.claim { $0["participantId"] = bad }) == .malformedEnvelope, "participantId \(String(describing: bad))")
        }
        if case .passed(let long) = ParticipantPrepare.claim(Prep.claim { $0["participantId"] = .string(String(repeating: "\u{E9}", count: 128)) }) {
            #expect(long.participantId.utf8.count == 256, "256 bytes is a well-formed participant id")
        } else {
            Issue.record("a 256-byte participant id is well formed")
        }
        for bad: JSONValue? in [nil, .number(0), .string("2026-10-09T00:01:00Z"), .string("2026-10-09T00:01:00.000+00:00"),
                                .string("2023-02-30T00:00:00.000Z"), .string("2026-10-09T24:00:00.000Z"), .string("2026-10-09t00:01:00.000z")] {
            #expect(reason(Prep.claim { $0["createdAt"] = bad }) == .malformedEnvelope, "createdAt \(String(describing: bad))")
        }

        // Distinctness, ignoring case, comes last.
        #expect(reason(Prep.claim { $0["sessionId"] = .string(Prep.runId(1).uppercased()) }) == .invalidIdentity,
                "a session id that is the run id in capitals")
        #expect(reason(Prep.claim { $0["assistantMessageId"] = .string(Prep.id("72abcdef", 1)) }) == .invalidIdentity)
        #expect(reason(Prep.claim { $0["userMessageId"] = .string(Prep.runId(1)) }) == .invalidIdentity)

        // Mixed invalid input: the earlier class wins.
        #expect(reason(Prep.claim { $0["runId"] = .null; $0["participantId"] = .number(1) }) == .invalidIdentity,
                "an identity before participantId")
        #expect(reason(Prep.claim { $0.removeValue(forKey: "assistantMessageId"); $0["createdAt"] = .string("never") }) == .invalidIdentity,
                "a missing identity before a malformed createdAt")
        #expect(reason(Prep.claim { $0["createdAt"] = .string("never"); $0["userMessageId"] = .string(Prep.runId(1)) }) == .malformedEnvelope,
                "a malformed createdAt before duplicate ids")
        #expect(reason(Prep.claim { $0["participantId"] = .string(""); $0["sessionId"] = .string(Prep.runId(1)) }) == .malformedEnvelope,
                "a blank participantId before duplicate ids")
    }

    // MARK: Steps 2-7, one failing record per step

    @Test("Prepared-r5's run prepares with inputBytes 58, preparedBytes 554 and the shared input hash; a 256-byte participant id is compared as bytes")
    func preparesTheVectorRun() throws {
        let expected = try #require(ParticipantPreparedRun(
            runId: Prep.runId(1), sessionId: Prep.sessionId(1), userMessageId: Prep.id("72abcdef", 1),
            assistantMessageId: Prep.id("73abcdef", 1), participant: Prep.pin, createdAt: Prep.createdAt,
            inputHash: Prep.questionHash, inputBytes: 58, preparedBytes: 554))
        #expect(Prep.prepare() == .passed(expected))
        #expect(Prep.run().canonicalData().count == 554)
        #expect(Prep.question.utf8.count == 58)
        // A second run beside it, in any position, changes nothing about this one.
        let crowded = Prep.record(runs: .array([Prep.run(2), Prep.run(), Prep.run(3)]))
        #expect(Prep.prepare(record: crowded) == .passed(expected))
    }

    @Test("Step 2 run-not-found: not schema 2, no list, the claimed run absent or twice")
    func stepTwo() {
        #expect(Prep.reason(Prep.prepare(record: Prep.record(schemaVersion: 1))) == .runNotFound)
        var stringVersion = Prep.record()
        stringVersion["schemaVersion"] = .string("2")
        #expect(Prep.reason(Prep.prepare(record: stringVersion)) == .runNotFound)
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: nil))) == .runNotFound)
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([Prep.run(2)])))) == .runNotFound)
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([])))) == .runNotFound)
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([Prep.run(), Prep.run()])))) == .runNotFound, "twice")
        let upper = Prep.run { $0["runId"] = .string(Prep.runId(1).uppercased()) }
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([upper])))) == .runNotFound, "run ids match exactly")
    }

    @Test("Step 3 run-not-prepared: exactly the twelve keys, version 1, phase prepared, lastSequence 0, no output, never updated; reason and closure are later evidence")
    func stepThree() {
        let edits: [(String, (inout [String: JSONValue]) -> Void)] = [
            ("reason", { $0["reason"] = .string("local-stop") }),
            ("closure", { $0["closure"] = .object(["kind": .string("unknown"), "reason": .string("user-closed"), "at": .string(Prep.createdAt)]) }),
            ("extra", { $0["inventedExtra"] = .null }),
            ("missing updatedAt", { $0.removeValue(forKey: "updatedAt") }),
            ("missing outputChunks", { $0.removeValue(forKey: "outputChunks") }),
            ("version 2", { $0["version"] = .number(2) }),
            ("version string", { $0["version"] = .string("1") }),
            ("phase running", { $0["phase"] = .string("running") }),
            ("phase case", { $0["phase"] = .string("Prepared") }),
            ("lastSequence 1", { $0["lastSequence"] = .number(1) }),
            ("output", { $0["outputChunks"] = .array([.string("Four. ")]) }),
            ("output not a list", { $0["outputChunks"] = .null }),
            ("updated later", { $0["updatedAt"] = .string("2026-10-09T00:01:00.001Z") })
        ]
        for (label, edit) in edits {
            #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([Prep.run(1, edit)])))) == .runNotPrepared, "\(label)")
        }
    }

    @Test("Step 4 run-mismatch: the session, message ids and createdAt equal the claim's, as exact strings")
    func stepFour() {
        for key in ["sessionId", "userMessageId", "assistantMessageId"] {
            let other = Prep.run { $0[key] = .string(Prep.id("7fabcdef", 7)) }
            #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([other])))) == .runMismatch, "\(key)")
        }
        let later = Prep.run { $0["createdAt"] = .string("2026-10-09T00:01:00.001Z"); $0["updatedAt"] = .string("2026-10-09T00:01:00.001Z") }
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([later])))) == .runMismatch, "createdAt one millisecond apart")
        #expect(Prep.reason(Prep.prepare(Prep.claim { $0["sessionId"] = .string(Prep.sessionId(1).uppercased()) })) == .runMismatch,
                "a session id differing only in case is another id")
    }

    @Test("Step 5 run-mismatch: the claim's participantId and the run's whole participant are the current pin, byte for byte")
    func stepFive() throws {
        #expect(Prep.reason(Prep.prepare(Prep.claim { $0["participantId"] = .string("claude-codex") })) == .runMismatch)
        #expect(Prep.reason(Prep.prepare(pin: Prep.earlierPin)) == .runMismatch, "the record names an earlier pin")
        for key in ["id", "label", "model", "executionHost"] {
            var fields = Prep.pin.jsonValue.objectValue ?? [:]
            fields[key] = .string("invented-other")
            let run = Prep.run { $0["participant"] = .object(fields) }
            #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([run])))) == .runMismatch, "\(key)")
        }
        let extraKey = Prep.run { $0["participant"] = .object((Prep.pin.jsonValue.objectValue ?? [:]).merging(["extra": .null]) { $1 }) }
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([extraKey])))) == .runMismatch)
        // Canonically equivalent but different bytes is a different pin.
        let composed = try #require(ParticipantPin(id: "claude-code", label: "Caf\u{E9}", model: "invented-pinned-model", executionHost: "this-mac"))
        let decomposed = try #require(ParticipantPin(id: "claude-code", label: "Cafe\u{301}", model: "invented-pinned-model", executionHost: "this-mac"))
        let run = Prep.run { $0["participant"] = decomposed.jsonValue }
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([run])), pin: composed)) == .runMismatch)
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([run])), pin: decomposed)) == nil)
        // The claim's participantId is compared as bytes too: K and the Kelvin sign.
        let kelvinPin = try #require(ParticipantPin(id: "claude-\u{212A}", label: "Claude Code", model: "invented-pinned-model",
                                                    executionHost: "this-mac"))
        let kelvinRun = Prep.run { $0["participant"] = kelvinPin.jsonValue }
        #expect(Prep.reason(Prep.prepare(Prep.claim { $0["participantId"] = .string("claude-K") },
                                         record: Prep.record(runs: .array([kelvinRun])), pin: kelvinPin)) == .runMismatch)
        #expect(Prep.reason(Prep.prepare(Prep.claim { $0["participantId"] = .string("claude-\u{212A}") },
                                         record: Prep.record(runs: .array([kelvinRun])), pin: kelvinPin)) == nil)
    }

    @Test("Step 6 text-too-large: at least one chunk, each a string of 1-16,384 bytes, at most 262,144 together; a non-string chunk is step 6 (Codex Q8)")
    func stepSix() throws {
        func reason(_ chunks: JSONValue, inputBound: Int? = nil) -> HostRefusal? {
            Prep.reason(Prep.prepare(record: Prep.record(runs: .array([Prep.run { $0["inputChunks"] = chunks }])), inputBound: inputBound))
        }
        let full = String(repeating: "x", count: ParticipantLimits.chunkBytes)
        #expect(reason(.array([])) == .textTooLarge, "no chunk")
        #expect(reason(.array([.string("")])) == .textTooLarge, "an empty chunk")
        #expect(reason(.array([.string(full)])) == nil)
        #expect(reason(.array([.string(full + "x")])) == .textTooLarge, "16,385 bytes")
        #expect(reason(.array([.string(String(repeating: "\u{E9}", count: 8_192) + "x")])) == .textTooLarge, "16,385 bytes in 8,193 characters")
        #expect(reason(.array(Array(repeating: .string(full), count: 16))) == nil, "exactly 262,144")
        #expect(reason(.array(Array(repeating: .string(full), count: 16) + [.string("x")])) == .textTooLarge, "262,145")
        #expect(reason(.string(Prep.question)) == .textTooLarge, "not a list")
        #expect(reason(.null) == .textTooLarge)
        // Codex Q8: a non-string element in an otherwise exact prepared run.
        #expect(reason(.array([.string(Prep.question), .number(42)])) == .textTooLarge)
        #expect(reason(.array([.number(42)])) == .textTooLarge)
        #expect(reason(.array([.null])) == .textTooLarge)
        #expect(reason(.array([.array([.string(Prep.question)])])) == .textTooLarge)
        // An earlier step still wins over a non-string chunk.
        let notPrepared = Prep.run { $0["inputChunks"] = .array([.number(42)]); $0["phase"] = .string("running") }
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([notPrepared])))) == .runNotPrepared)
        let mismatched = Prep.run { $0["inputChunks"] = .array([.number(42)]); $0["assistantMessageId"] = .string(Prep.id("7fabcdef", 7)) }
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([mismatched])))) == .runMismatch)
    }

    @Test("Section 17's first-trial bound at preparation: exactly 4,096 bytes prepares; 4,097 bytes in the same characters, or in two chunks, is text-too-large")
    func trialBound() throws {
        let bound = ParticipantLimits.firstTrialInputBound
        let exact = Prep.text(bytes: bound)
        #expect(exact.utf8.count == 4_096)
        // One two-byte é becomes a three-byte €: one byte more, same characters.
        let index = try #require(exact.lastIndex(of: "\u{E9}"))
        var over = exact
        over.replaceSubrange(index...index, with: "\u{20AC}")
        #expect(over.utf8.count == 4_097 && over.count == exact.count)
        let split = over.index(over.startIndex, offsetBy: over.count / 2)
        let halves = [String(over[..<split]), String(over[split...])]
        #expect(halves.map(\.utf8.count).reduce(0, +) == 4_097)

        func prepare(_ chunks: [String], inputBound: Int?) -> ParticipantCheck<ParticipantPreparedRun> {
            Prep.prepare(record: Prep.record(runs: .array([Prep.run(chunks: chunks.map(JSONValue.string))])), inputBound: inputBound)
        }
        guard case .passed(let prepared) = prepare([exact], inputBound: bound) else {
            Issue.record("exactly 4,096 bytes prepares")
            return
        }
        #expect(prepared.inputBytes == 4_096)
        #expect(prepared.inputHash == PayloadHash.hex(of: .array([.string(exact)])))
        #expect(Prep.reason(prepare([over], inputBound: bound)) == .textTooLarge)
        #expect(Prep.reason(prepare(halves, inputBound: bound)) == .textTooLarge)
        #expect(Prep.reason(prepare([over], inputBound: nil)) == nil, "a host without the bound uses the generic ceiling")
        #expect(Prep.reason(prepare(halves, inputBound: 4_097)) == nil)
    }

    @Test("Step 7 payload-too-large: input within its limits whose run's canonical JSON passes 785,408 bytes (escapes count)")
    func stepSeven() throws {
        // Each U+0001 is one input byte and six canonical bytes (\u0001).
        let chunk = String(repeating: "\u{01}", count: 16_000)
        let run = Prep.run(chunks: Array(repeating: .string(chunk), count: 9))
        #expect(run.canonicalData().count > ParticipantLimits.preparedRunBytes)
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([run])))) == .payloadTooLarge)
        let fits = Prep.run(chunks: Array(repeating: .string(chunk), count: 8))
        #expect(fits.canonicalData().count <= ParticipantLimits.preparedRunBytes)
        guard case .passed(let prepared) = Prep.prepare(record: Prep.record(runs: .array([fits]))) else {
            Issue.record("eight escaped chunks fit")
            return
        }
        #expect(prepared.preparedBytes == fits.canonicalData().count)
        #expect(prepared.inputBytes == 128_000)
        // Step 6 before 7.
        let both = Prep.run(chunks: Array(repeating: .string(chunk), count: 9) + [.string("")])
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([both])))) == .textTooLarge)
    }

    @Test("Across steps the first failure answers: 2 before 3, 3 before 4, 4 before 5, 5 before 6")
    func stepPrecedence() {
        let notPreparedAndMismatched = Prep.run { $0["phase"] = .string("running"); $0["sessionId"] = .string(Prep.id("7fabcdef", 7)) }
        #expect(Prep.reason(Prep.prepare(record: Prep.record(schemaVersion: 1, runs: .array([notPreparedAndMismatched])))) == .runNotFound)
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([notPreparedAndMismatched])))) == .runNotPrepared)
        let mismatchedAndTooLong = Prep.run { $0["sessionId"] = .string(Prep.id("7fabcdef", 7)); $0["inputChunks"] = .array([]) }
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([mismatchedAndTooLong])), pin: Prep.earlierPin)) == .runMismatch)
        let earlierPinAndEmpty = Prep.run { $0["inputChunks"] = .array([]) }
        #expect(Prep.reason(Prep.prepare(record: Prep.record(runs: .array([earlierPinAndEmpty])), pin: Prep.earlierPin)) == .runMismatch)
    }

    // MARK: The attempted list (Codex Q7) and the committed list (Codex Q9)

    @Test("Q7: a present attempted conversationRuns must be a list of objects with string runIds, else malformed-envelope, with or without a claim and before step 2; absent is schema 1")
    func attemptedListShape() {
        func check(_ record: [String: JSONValue], claim: JSONValue? = nil, delivery: Bool = false) -> ParticipantCheck<ParticipantCommitCheck> {
            ParticipantPrepare.check(record: record, claim: claim, hasDeliveryId: delivery, pin: Prep.pin, inputBound: nil)
        }
        #expect(check(Prep.record(schemaVersion: 1, runs: nil)) == .passed(ParticipantCommitCheck(preparedRun: nil, attemptedRunIds: [])),
                "schema 1: nothing introduced")
        #expect(check(Prep.record(schemaVersion: 1, runs: nil), claim: Prep.claim()) == .refused(.runNotFound))
        #expect(check(Prep.record(runs: .array([Prep.run(), Prep.run(2)]))) ==
                .passed(ParticipantCommitCheck(preparedRun: nil, attemptedRunIds: [Prep.runId(1), Prep.runId(2)])))
        let malformed: [(String, JSONValue)] = [
            ("null", .null), ("object", .object([:])), ("string", .string("runs")),
            ("element without runId", .array([.object(["phase": .string("prepared")])])),
            ("runId not a string", .array([.object(["runId": .number(7)])])),
            ("element not an object", .array([Prep.run(), .string(Prep.runId(2))])),
            ("null element", .array([Prep.run(), .null]))
        ]
        for (label, list) in malformed {
            #expect(check(Prep.record(runs: list)) == .refused(.malformedEnvelope), "\(label), no claim")
            #expect(check(Prep.record(runs: list), claim: Prep.claim()) == .refused(.malformedEnvelope), "\(label), with a claim")
            #expect(check(Prep.record(runs: list), claim: Prep.claim { $0["extra"] = .null }) == .refused(.malformedEnvelope),
                    "\(label): the list shape before the claim's own keys")
            #expect(check(Prep.record(schemaVersion: 1, runs: list)) == .refused(.malformedEnvelope), "\(label) in a schema-1 record")
        }
        // A claim beside a delivery comes first of all.
        #expect(check(Prep.record(), claim: Prep.claim(), delivery: true) == .refused(.malformedEnvelope))
        #expect(check(Prep.record(), claim: .string("not a claim"), delivery: true) == .refused(.malformedEnvelope))
        #expect(check(Prep.record(), delivery: true) == .passed(ParticipantCommitCheck(preparedRun: nil, attemptedRunIds: [Prep.runId(1)])),
                "a delivery without a claim passes to the store's step 9")
        guard case .passed(let passed) = check(Prep.record(), claim: Prep.claim()) else {
            Issue.record("the vector run prepares")
            return
        }
        #expect(passed.preparedRun?.runId == Prep.runId(1) && passed.attemptedRunIds == [Prep.runId(1)])
    }

    @Test("Q9: the committed record's runs are read leniently: string runIds on objects, malformed siblings and non-lists ignored")
    func committedListLenient() {
        let legacy: JSONValue = .array([
            .object(["phase": .string("prepared")]), Prep.run(), .string("invented legacy note"), .object(["runId": .number(7)]),
            .null, .object(["runId": .string("not-a-uuid")])
        ])
        #expect(ParticipantPrepare.committedRunIds(in: ["conversationRuns": legacy]) == [Prep.runId(1), "not-a-uuid"])
        #expect(ParticipantPrepare.committedRunIds(in: ["conversationRuns": .string("legacy")]) == [])
        #expect(ParticipantPrepare.committedRunIds(in: ["conversationRuns": .null]) == [])
        #expect(ParticipantPrepare.committedRunIds(in: ["revision": .number(1)]) == [])
        // The same list as an attempted record is malformed.
        #expect(ParticipantPrepare.attemptedRunIds(in: ["conversationRuns": legacy]) == .refused(.malformedEnvelope))
    }

    // MARK: The protocol's placement (Codex Q6)

    @Test("A participant host runs v1's checks, the holder and exact replay before any participant check")
    func placementAfterReplay() async throws {
        let executor = GatedExecutor()
        let harness = try PrepareHost(executor: executor)
        defer { harness.clean() }
        let broken = Prep.claim { $0["extra"] = .null }
        #expect(await harness.commit(record: Prep.record(), claim: broken, handle: "invented-other-handle").reason == .unknownHandle)
        #expect(await harness.commit(expected: 5, record: Prep.record(), claim: broken).reason == .revisionNotAdvanced)
        #expect(await harness.commit(record: Prep.record(), claim: broken, deliveryId: "NOT-A-UUID").reason == .invalidIdentity,
                "v1's delivery id form first")

        // The barrier: another mutation is outstanding, whatever its claim.
        let host = harness.host
        let firstRequest = harness.commitRequest(record: Prep.record(), claim: Prep.claim())
        let first = Task { await host.handle(firstRequest) }
        await executor.gate.waitForArrival()
        #expect(await harness.commit(record: Prep.record(runs: .null), claim: broken).reason == .mutationOutstanding)
        await executor.gate.open()
        #expect(await first.value.outcome == .ok)

        // Exact replay: the same id with the same bytes replays; with a
        // changed claim it is a changed payload, never a claim refusal.
        let prepareId = UUID()
        let second = Prep.record(revision: 6, runs: .array([Prep.run(), Prep.run(2)]))
        let request = harness.commitRequest(expected: 5, record: second, claim: Prep.claim(2), requestId: prepareId)
        #expect(await harness.host.handle(request).revision == 6)
        #expect(await harness.host.handle(request).revision == 6, "an exact retry replays")
        let changed = harness.commitRequest(expected: 5, record: second, claim: Prep.claim(2) { $0["extra"] = .null }, requestId: prepareId)
        #expect(await harness.host.handle(changed).reason == .payloadMismatch)
        let withoutClaim = harness.commitRequest(expected: 5, record: second, requestId: prepareId)
        #expect(await harness.host.handle(withoutClaim).reason == .payloadMismatch)
        #expect(try harness.store.read().revision == 6)
        #expect(harness.store.publishedRuns.runs.map(\.runId) == [Prep.runId(1), Prep.runId(2)])
    }

    // MARK: Steps 8 and 9 in the store

    @Test("Steps 8-9 refuse before the receipt: no write, no receipt, no identity, and the barrier is free for the next commit")
    func storeStepsWriteNothing() async throws {
        let faults = WriteFaultScript()
        // The committed record already holds run 1 (no native entry): step 8.
        let harness = try PrepareHost(seed: Prep.record(revision: 4), faults: faults)
        defer { harness.clean() }
        let refusals: [(String, [String: JSONValue], JSONValue?, HostRefusal)] = [
            ("the committed record holds the claimed run", Prep.record(), Prep.claim(), .duplicateRun),
            ("an introduced run without a claim", Prep.record(runs: .array([Prep.run(), Prep.run(2)])), nil, .unknownRun),
            ("two runs under one claim", Prep.record(runs: .array([Prep.run(), Prep.run(2), Prep.run(3)])), Prep.claim(2), .unknownRun)
        ]
        for (label, record, claim, reason) in refusals {
            faults.arm([:])
            let id = UUID()
            let reply = await harness.commit(record: record, claim: claim, requestId: id)
            #expect(reply.reason == reason, "\(label)")
            #expect(faults.log.isEmpty, "\(label): nothing written")
            #expect(try harness.store.dispatchReceipt(for: id) == nil)
            #expect(try harness.store.terminalResult(for: id) == nil)
            #expect(await harness.host.outstandingMutation == nil, "\(label): the barrier is free")
            #expect(await harness.reconcile(id.canonicalString).original?["outcome"] == .string("not-dispatched"))
        }
        #expect(try harness.diskState["runs"] == nil)

        // The next commit is accepted, with v1's two writes: receipt, result.
        faults.arm([:])
        let next = await harness.commit(record: Prep.record(runs: .array([Prep.run(), Prep.run(2)])), claim: Prep.claim(2))
        #expect(next.outcome == .ok && next.revision == 5)
        #expect(Set(faults.log.map { $0.write }) == [0, 1], "a preparing commit writes exactly as many times as any commit")
        let entry = try #require(harness.store.publishedRuns.entry(for: Prep.runId(2)))
        #expect(entry.preparedRevision == 5 && entry.inputHash == Prep.questionHash)
        faults.arm([:])
        #expect(await harness.commit(expected: 5, record: Prep.record(revision: 6, schemaVersion: 1, runs: nil)).revision == 6)
        #expect(Set(faults.log.map { $0.write }) == [0, 1], "a schema-1 commit on a participant host writes as before")
    }

    @Test("Step 8 ignores case against the committed record; step 9 compares exactly, so another spelling counts as introduced")
    func storeStepsCase() async throws {
        let upper = Prep.run { $0["runId"] = .string(Prep.runId(1).uppercased()) }
        let harness = try PrepareHost(seed: Prep.record(revision: 4, runs: .array([upper])))
        defer { harness.clean() }
        #expect(await harness.commit(record: Prep.record(), claim: Prep.claim()).reason == .duplicateRun)
        #expect(await harness.commit(record: Prep.record()).reason == .unknownRun, "the lowercase spelling is new without a claim")
        #expect(await harness.commit(record: Prep.record(runs: .array([upper]))).outcome == .ok, "keeping the same spelling introduces nothing")

        // Byte for byte, not Swift's canonical equivalence: K and the Kelvin sign differ.
        #expect("invented-K" == "invented-\u{212A}", "Swift's String == calls these equal")
        #expect(ParticipantPrepare.introducedRunIds(attempted: ["a", "invented-K", "invented-K"], committed: ["invented-\u{212A}"])
                == ["a", "invented-K", "invented-K"])
        #expect(ParticipantPrepare.introducedRunIds(attempted: ["a", "invented-K"], committed: ["invented-K", "a"]) == [])
        let kelvin = try PrepareHost(seed: Prep.record(revision: 4, runs: .array([.object(["runId": .string("invented-\u{212A}")])])))
        defer { kelvin.clean() }
        #expect(await kelvin.commit(record: Prep.record(runs: .array([.object(["runId": .string("invented-K")])]))).reason == .unknownRun)
        #expect(await kelvin.commit(record: Prep.record(runs: .array([.object(["runId": .string("invented-\u{212A}")])]))).outcome == .ok)
    }

    @Test("Q9 in the store: a legacy committed list is read leniently; a kept run is not introduced, and nothing it lists authorizes a new one")
    func storeLegacyRecord() async throws {
        let legacyList: JSONValue = .array([.object(["phase": .string("prepared")]), Prep.run(), .string("invented legacy note"),
                                            .object(["runId": .number(7)])])
        let legacy = try PrepareHost(seed: Prep.record(revision: 4, runs: legacyList))
        defer { legacy.clean() }
        #expect(await legacy.commit(record: Prep.record(runs: .array([Prep.run(), Prep.run(2)]))).reason == .unknownRun)
        #expect(await legacy.commit(record: Prep.record(runs: .array([Prep.run(), Prep.run(2)])), claim: Prep.claim()).reason == .duplicateRun)
        #expect(await legacy.commit(record: Prep.record()).outcome == .ok, "the valid replacement repairs the record")
        #expect(try legacy.diskState["runs"] == nil, "and creates no entry")

        let nonList = try PrepareHost(seed: Prep.record(revision: 4, runs: .string("legacy")))
        defer { nonList.clean() }
        #expect(await nonList.commit(record: Prep.record()).reason == .unknownRun, "a non-list holds no runs")
        #expect(await nonList.commit(record: Prep.record(), claim: Prep.claim()).outcome == .ok)
        #expect(nonList.store.publishedRuns.runs.map(\.runId) == [Prep.runId(1)])
    }

    @Test("A stale preparing commit is a conflict with no entry; the same run then prepares under a new id at the current revision")
    func staleThenPrepared() async throws {
        let harness = try PrepareHost()
        defer { harness.clean() }
        let stale = await harness.commit(expected: 3, record: Prep.record(), claim: Prep.claim())
        #expect(stale.outcome == .conflict && stale.revision == 4)
        #expect(harness.store.publishedRuns.runs.isEmpty)
        #expect(await harness.commit(record: Prep.record(), claim: Prep.claim()).revision == 5)
        #expect(await harness.commit(expected: 5, record: Prep.record(revision: 6), claim: Prep.claim()).reason == .duplicateRun,
                "a new id for the same run")
    }

    @Test("Step 7 through the protocol: a record within 1 MiB whose run passes 785,408 canonical bytes is payload-too-large")
    func payloadTooLargeThroughProtocol() async throws {
        let harness = try PrepareHost()
        defer { harness.clean() }
        let chunk = String(repeating: "\u{01}", count: 16_000)
        let record = Prep.record(runs: .array([Prep.run(chunks: Array(repeating: .string(chunk), count: 9))]))
        #expect(JSONValue.object(record).canonicalData().count <= ProofLimits.recordBytes)
        #expect(await harness.commit(record: record, claim: Prep.claim()).reason == .payloadTooLarge)
        #expect(try harness.store.read().revision == 4)
    }

    // MARK: A host without participants

    @Test("A v1 host refuses participantRun as an unknown field and ignores conversationRuns: no runs, no runId, its usual two writes")
    func v1HostUnchanged() async throws {
        let faults = WriteFaultScript()
        let harness = try PrepareHost(participants: false, faults: faults)
        defer { harness.clean() }
        #expect(await harness.commit(record: Prep.record(), claim: Prep.claim()).reason == .unknownField)
        #expect(await harness.commit(record: Prep.record(runs: .array([.object(["phase": .string("prepared")])]))).revision == 5,
                "a malformed list commits")
        faults.arm([:])
        #expect(await harness.commit(expected: 5, record: Prep.record(revision: 6, runs: .array([Prep.run(), Prep.run(2)]))).revision == 6,
                "runs introduced without a claim commit")
        #expect(Set(faults.log.map { $0.write }) == [0, 1])
        let state = try harness.diskState
        #expect(state["runs"] == nil, "no runs key")
        let identities = state["identities"]?.arrayValue ?? []
        #expect(identities.count == 2 && identities.allSatisfy { $0.objectValue?["runId"] == nil })
        #expect(harness.store.publishedRuns.runs.isEmpty)
    }

    // MARK: Section 3: start ids in the commit lane

    @Test("workspace.reconcile for a recorded or reserved start id is unknown, never not-dispatched; a commit under it is payload-mismatch")
    func startIdsInTheWorkspaceLane() async throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(seed: WorkspaceSeed(workspaceHandle: "invented-workspace-handle", record: ["revision": .number(4)]))
        let prepared = try #require(Prep.preparedRun())
        #expect(try store.commit(CommitAttempt(requestId: UUID(), payloadHash: "p", expectedRevision: 4, recordRevision: 5,
                                               record: Prep.record(), preparedRun: prepared)) == .committed(revision: 5))
        let startId = Prep.id("62abcdef", 914)
        try store.recordStart(runId: Prep.runId(1), try #require(Prep.start(startId)))

        for participants in [true, false] {
            let connections = ConnectionRegistry()
            let host = DeskHostProtocol(store: store, connections: connections, drafts: DraftBindingRegistry(), info: HostHarness.info,
                                        participants: participants ? ParticipantHostConfiguration(pin: Prep.pin) : nil)
            let connection = connections.issue()
            func send(_ operation: HostOperation, _ payload: [String: JSONValue], id: UUID = UUID()) async -> HostResponse {
                await host.handle(HostRequest(requestId: id, connectionId: connection.id, generation: connection.generation,
                                              operation: operation, payload: payload))
            }
            let handle = JSONValue.string(store.workspaceHandle)
            let reconcile = await send(.workspaceReconcile, ["workspaceHandle": handle, "targetRequestId": .string(startId)])
            #expect(reconcile.outcome == .unknown && reconcile.fields.isEmpty, "participants: \(participants)")
            let never = await send(.workspaceReconcile, ["workspaceHandle": handle, "targetRequestId": .string(UUID().canonicalString)])
            #expect(never.original?["outcome"] == .string("not-dispatched"), "an id nothing names is still not-dispatched")
            let underStart = await send(.workspaceCommitProof, ["workspaceHandle": handle, "expectedRevision": .number(5),
                                                                "record": .object(Prep.record(revision: 6))],
                                        id: try #require(UUID(uuidString: startId)))
            #expect(underStart.reason == .payloadMismatch)
        }
        store.close()

        // Reopened, the start is visible but not yet durable here: reserved,
        // not published. Reconcile still answers unknown before any flush.
        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(reopened.publishedRuns.startRequestIds.isEmpty)
        #expect(reopened.publishedRuns.reservedStartRequestIds == [startId])
        let connections = ConnectionRegistry()
        let host = DeskHostProtocol(store: reopened, connections: connections, drafts: DraftBindingRegistry(), info: HostHarness.info,
                                    participants: ParticipantHostConfiguration(pin: Prep.pin))
        let connection = connections.issue()
        let reply = await host.handle(HostRequest(requestId: UUID(), connectionId: connection.id, generation: connection.generation,
                                                  operation: .workspaceReconcile,
                                                  payload: ["workspaceHandle": .string(reopened.workspaceHandle), "targetRequestId": .string(startId)]))
        #expect(reply.outcome == .unknown)
    }

    @Test("A commit under a recorded or reserved start id is payload-mismatch right after exact replay: before the claim, the attempted list and the delivery check, writing nothing; another holder still answers mutation-outstanding first")
    func commitUnderStartIdPrecedence() async throws {
        let fixture = try DeskHostFixture()
        defer { fixture.clean() }
        let store = try fixture.makeStore(seed: WorkspaceSeed(workspaceHandle: "invented-workspace-handle", record: ["revision": .number(4)]))
        #expect(try store.commit(CommitAttempt(requestId: UUID(), payloadHash: "p", expectedRevision: 4, recordRevision: 5,
                                               record: Prep.record(), preparedRun: try #require(Prep.preparedRun()))) == .committed(revision: 5))
        let startId = Prep.id("62abcdef", 915)
        let startUUID = try #require(UUID(uuidString: startId))
        try store.recordStart(runId: Prep.runId(1), try #require(Prep.start(startId)))

        func commit(_ host: DeskHostProtocol, _ connection: HostConnection, id: UUID, expected: Int = 5,
                    _ fields: [String: JSONValue]) async -> HostResponse {
            var payload = fields
            payload["workspaceHandle"] = .string("invented-workspace-handle")
            payload["expectedRevision"] = .number(Double(expected))
            return await host.handle(HostRequest(requestId: id, connectionId: connection.id, generation: connection.generation,
                                                 operation: .workspaceCommitProof, payload: payload))
        }
        let twoRuns = JSONValue.object(Prep.record(revision: 6, runs: .array([Prep.run(), Prep.run(2)])))
        let delivery = JSONValue.string(UUID().canonicalString)
        // Each defect alone is refused as something else under a fresh id.
        let defects: [(label: String, fields: [String: JSONValue], alone: HostRefusal)] = [
            ("a claim with an unknown key", ["record": twoRuns, "participantRun": Prep.claim(2) { $0["extra"] = .null }], .unknownField),
            ("a malformed attempted list without a claim",
             ["record": .object(Prep.record(revision: 6, runs: .array([.object(["phase": .string("prepared")])])))], .malformedEnvelope),
            ("a claim beside a delivery", ["record": twoRuns, "participantRun": Prep.claim(2), "dictationDeliveryId": delivery], .malformedEnvelope),
            ("an unknown delivery", ["record": .object(Prep.record(revision: 6)), "dictationDeliveryId": delivery], .unknownDelivery),
            ("a claimed run missing from the record", ["record": .object(Prep.record(revision: 6)), "participantRun": Prep.claim(2)], .runNotFound)
        ]

        let executor = GatedExecutor()
        let connections = ConnectionRegistry()
        let host = DeskHostProtocol(store: store, connections: connections, drafts: DraftBindingRegistry(), info: HostHarness.info,
                                    executor: executor, participants: ParticipantHostConfiguration(pin: Prep.pin))
        let connection = connections.issue()
        let before = try store.plainStateForTesting()
        for defect in defects {
            #expect(await commit(host, connection, id: UUID(), defect.fields).reason == defect.alone, "\(defect.label) alone")
            #expect(await commit(host, connection, id: startUUID, defect.fields).reason == .payloadMismatch, "\(defect.label) under a start id")
        }
        #expect(try store.plainStateForTesting() == before, "nothing written")
        #expect(await host.outstandingMutation == nil)

        // Any host: one without participants refuses its own checks first
        // (participantRun is an unknown field there), then the start id.
        let v1Connections = ConnectionRegistry()
        let v1 = DeskHostProtocol(store: store, connections: v1Connections, drafts: DraftBindingRegistry(), info: HostHarness.info)
        let v1Connection = v1Connections.issue()
        #expect(await commit(v1, v1Connection, id: startUUID, defects[0].fields).reason == .unknownField)
        #expect(await commit(v1, v1Connection, id: startUUID, defects[3].fields).reason == .payloadMismatch)

        // Another mutation holding the barrier answers first.
        let held = Task { await commit(host, connection, id: UUID(), ["record": .object(Prep.record(revision: 6))]) }
        await executor.gate.waitForArrival()
        #expect(await commit(host, connection, id: startUUID, defects[0].fields).reason == .mutationOutstanding)
        await executor.gate.open()
        #expect(await held.value.revision == 6)
        store.close()

        // Reopened, the start is reserved but not yet published: still refused.
        let reopened = try fixture.makeStore()
        defer { reopened.close() }
        #expect(reopened.publishedRuns.startRequestIds.isEmpty && reopened.publishedRuns.reservedStartRequestIds == [startId])
        let again = ConnectionRegistry()
        let reserved = DeskHostProtocol(store: reopened, connections: again, drafts: DraftBindingRegistry(), info: HostHarness.info,
                                        participants: ParticipantHostConfiguration(pin: Prep.pin))
        let reservedConnection = again.issue()
        let unsynced = try reopened.plainStateForTesting()
        #expect(await commit(reserved, reservedConnection, id: startUUID, defects[0].fields).reason == .payloadMismatch)
        #expect(try reopened.plainStateForTesting() == unsynced)
    }

    @Test("A commit the store refuses as payload-mismatch frees the barrier even when its connection was revoked meanwhile")
    func storePayloadMismatchFreesTheBarrier() async throws {
        let executor = GatedExecutor()
        let harness = try PrepareHost(executor: executor)
        defer { harness.clean() }
        #expect(try harness.store.commit(CommitAttempt(requestId: UUID(), payloadHash: "p", expectedRevision: 4, recordRevision: 5,
                                                       record: Prep.record(), preparedRun: try #require(Prep.preparedRun())))
                == .committed(revision: 5))
        let racedId = UUID()
        let host = harness.host
        let request = harness.commitRequest(expected: 5, record: Prep.record(revision: 6), requestId: racedId)
        let raced = Task { await host.handle(request) }
        await executor.gate.waitForArrival()
        #expect(await host.outstandingMutation == racedId)
        // While its store work waits, its id becomes a start's (S6's identity
        // index will refuse that pairing up front) and the page goes away.
        try harness.store.recordStart(runId: Prep.runId(1), try #require(Prep.start(racedId.canonicalString)))
        harness.connections.invalidate(harness.connection.id)
        await executor.gate.open()
        #expect(await raced.value.reason == .payloadMismatch, "terminal, not unknown")
        #expect(await host.outstandingMutation == nil, "the barrier is free")
        #expect(try harness.store.dispatchReceipt(for: racedId) == nil)
        #expect(try harness.store.terminalResult(for: racedId) == nil, "no result exists for an orphan release to find")

        let next = harness.connections.issue()
        let reply = await host.handle(HostRequest(requestId: UUID(), connectionId: next.id, generation: next.generation,
                                                  operation: .workspaceCommitProof,
                                                  payload: ["workspaceHandle": .string("invented-workspace-handle"), "expectedRevision": .number(5),
                                                            "record": .object(Prep.record(revision: 6))]))
        #expect(reply.revision == 6, "the next save is accepted, not mutation-outstanding")
    }
}
