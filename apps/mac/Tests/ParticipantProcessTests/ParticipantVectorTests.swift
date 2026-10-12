import Foundation
import Testing
@testable import DeskHost

/// The shared participant vectors replayed through DeskHost
/// (`ParticipantVectorHarness.swift`). Every case is enumerated; the ones a
/// slice can drive are listed in `enabled` and run, the rest are counted as
/// not yet enabled, so the execution count is explicit (Codex Q10).
@Suite("Shared participant vectors")
struct ParticipantVectorTests {
    /// The cases this slice runs: case numbers (1-based positions in
    /// `cases`) with their names, checked against the fixture so a moved or
    /// renamed case fails here instead of silently running something else.
    static let enabled: [(number: Int, name: String)] = [
        (1, "host.capabilities on a participant host"),
        (6, "workspace.commitProof ordinary schema-1 edit on a participant host"),
        (7, "workspace.commitProof malformed conversationRuns (element without runId)"),
        (8, "workspace.commitProof prepares a run"),
        (9, "workspace.commitProof prepare exact retry replays"),
        (10, "workspace.commitProof prepare retry with a reconstructed record under the same id"),
        (11, "workspace.commitProof prepare metadata mismatch"),
        (12, "workspace.commitProof prepare createdAt mismatch"),
        (13, "workspace.commitProof prepare run missing from record"),
        (14, "workspace.commitProof prepare run not in prepared state"),
        (15, "workspace.commitProof prepare refused: the new run already carries a closure"),
        (16, "workspace.commitProof prepare refused: the new run already carries a reason (deliberately malformed record)"),
        (17, "workspace.commitProof prepare refused: record names an earlier participant pin"),
        (18, "workspace.commitProof introduces a run without participantRun"),
        (19, "workspace.commitProof introduces two runs under one claim"),
        (20, "workspace.commitProof participantRun with dictationDeliveryId"),
        (21, "workspace.commitProof prepare duplicate run"),
        (22, "workspace.commitProof prepare stale revision"),
        // Native ignores closures; the seeded memory of #92 is not read by a commit.
        (90, "workspace.commitProof saves a user-closed run (native ignores closures)"),
        (92, "workspace.commitProof saves an interrupted closure"),
        (102, "workspace.commitProof trial bound: exactly 4,096 UTF-8 bytes prepares"),
        (103, "workspace.commitProof trial bound: 4,097 UTF-8 bytes with the same character count is text-too-large"),
        (104, "workspace.commitProof trial bound: two chunks totalling 4,097 bytes are text-too-large"),
        // Added with this slice (contract section 19; Codex Q8 and Q9).
        (106, "workspace.commitProof prepare refused: a non-string input chunk is text-too-large (deliberately malformed record)"),
        (107, "workspace.commitProof repairs a legacy committed record: its malformed conversationRuns is read leniently, so a kept run is not introduced"),
        // S7, the coordinator's read side: availability, events, status, and
        // Stop of a run with no live process.
        (2, "participant.availability available (test fake)"),
        (3, "participant.availability overflow unverified (shipping default)"),
        (4, "participant.availability provider override"),
        (5, "participant.availability after an app update changed the pin"),
        (49, "participant.events first page"),
        (50, "participant.events second page"),
        (51, "participant.events of a finished run while unavailable"),
        (52, "participant.events lost after lock"),
        (53, "participant.events after restart without exit"),
        (54, "participant.events unknown: store unreadable, nothing in memory"),
        (59, "participant.status not dispatched after restart"),
        (60, "participant.status unknown after restart"),
        (61, "participant.status unknown run"),
        (62, "restart after a pin change: status of a completed run while unavailable"),
        (63, "restart after a pin change: stop of a completed run while unavailable"),
        (64, "restart after a pin change: stop of a run with no recorded exit is not owned"),
        (65, "restart after a pin change: events of a completed run give lost restarted plus the terminal"),
        (75, "participant.stop after restart: an earlier incomplete stop is not owned"),
        (85, "participant.stop before start"),
        (87, "participant.stop after restart (not owned)"),
        (89, "participant.stop unknown: store unreadable, nothing in memory"),
        (91, "participant.status after a user closure is unchanged"),
        (98, "participant.availability confirmation: not yet confirmed this launch"),
        (99, "participant.availability confirmation: active, confirmed this launch (test fake)"),
        (100, "participant.availability confirmation: ended when the fifth run started"),
        (101, "participant.availability confirmation: active, but an earlier check fails first"),
        // S8, participant.start (section 7) and basic run ownership: the
        // start steps, in-flight requests held at a fault, the undetermined
        // start record and its re-reads, and started runs settled.
        (23, "participant.stop while the preparing commit is still being written (not prepared)"),
        (24, "participant.stop again after the late preparing commit lands"),
        (25, "participant.start after the late-prepare Stop"),
        (26, "participant.start while the preparing commit is still being written (unknown-run, no entry yet)"),
        (27, "participant.start accepted"),
        (28, "participant.start exact retry replays"),
        (29, "participant.start same request changed payload"),
        (30, "participant.start new request after dispatch"),
        (31, "workspace.commitProof under a start request id"),
        (32, "workspace.reconcile for a start request id"),
        (33, "participant.start not started: unavailable"),
        (35, "participant.start not started: unknown run"),
        (36, "participant.start not started: input hash mismatch"),
        (37, "participant.start not started: participant label differs from the prepared binding"),
        (38, "participant.start unknown: start record write undetermined"),
        (39, "participant.status after undetermined start"),
        (40, "participant.status after undetermined start: the re-read finds the start record (nothing ran)"),
        (41, "participant.status after undetermined start: the re-read finds no start record"),
        (42, "participant.stop while the start record write is in flight"),
        (43, "participant.stop during the start availability recheck"),
        (44, "participant.start second request while the first is starting"),
        (45, "participant.start init mismatch fails at sequence 1"),
        (46, "participant.start paid overflow in the stream"),
        (47, "participant.start idle timeout"),
        (48, "participant.start reply too long ends after the longest fitting prefix"),
        (86, "participant.start after stop before start"),
        (88, "participant.stop after completion"),
        (95, "restart: explicit start after status reports not-dispatched (same runId, new request id)"),
        (96, "restart: start of a run an earlier launch dispatched is duplicate-run"),
        (97, "restart after a pin change: a never-dispatched run is refused participant-changed"),
        (105, "participant.start trial bound: a run prepared above 4,096 bytes is text-too-large, nothing spawned"),
        // S9, Stop, cleanup-pending and supervisor loss for live runs:
        // running and cleanup-pending memory seeds replayed, the actions
        // run-script, group-clears, supervisor-dies and pipes-close, and the
        // pushes-fail fault.
        (34, "participant.start not started: busy"),
        (55, "participant.status running"),
        (56, "participant.events while running"),
        (57, "participant.events continues after lastSequence grows"),
        (58, "participant.status returns the terminal when pushes failed"),
        (66, "participant.stop running"),
        (67, "participant.stop running while unavailable"),
        (68, "participant.stop incomplete: the group survives SIGKILL"),
        (69, "participant.status while an incomplete stop is cleaning up"),
        (70, "participant.stop again while the group still survives"),
        (71, "participant.status after the surviving group clears"),
        (72, "participant.stop after the surviving group clears"),
        (73, "participant.start another run while an incomplete stop group survives"),
        (74, "participant.start another run after the group clears"),
        (76, "participant.start after restart is not blocked by an earlier launch group"),
        (77, "participant.start idle timeout whose group survives SIGKILL records groupCleared false"),
        (78, "participant.status after a native end with a surviving group is cleanup-pending"),
        (79, "participant.start another run while a timed-out run group survives"),
        (80, "supervisor lost mid-run: the run fails process-error and cleanup stays pending"),
        (81, "supervisor lost: another run is busy while the CLI pipes stay open"),
        (82, "supervisor lost: stop signals nothing and stays cleanup-pending"),
        (83, "supervisor lost: once the pipes close the run is exited with groupCleared false"),
        (84, "supervisor lost: another run starts once the pipes close"),
        // S10, the lifecycle: the actions lock, unlock, begin-generation
        // and issue-connection.
        (93, "lock stops the run and pushes nothing after"),
        (94, "reload keeps the run")
    ]

    static let totalCases = 107
    static let expectedExecuted = 107

    @Test("Every case is enumerated: 107 cases, all 107 executed and passing in this slice, none left disabled; 15 page cases and 4 hash vectors")
    func everyEnabledCaseReplays() async throws {
        let vectors = try ParticipantVectors.load()
        #expect(vectors.cases.count == Self.totalCases)
        #expect(Set(vectors.cases.map(\.name)).count == vectors.cases.count, "case names are unique: afterCase names them")
        #expect(vectors.pageCaseCount == 15)
        #expect(vectors.hashVectors.count == 4)
        #expect(Self.enabled.count == Self.expectedExecuted)
        #expect(Set(Self.enabled.map(\.number)).count == Self.enabled.count, "no case is listed twice")
        for (number, name) in Self.enabled {
            #expect(vectors.cases[number - 1].name == name, "#\(number) is still the case this slice enabled")
        }

        let enabledNumbers = Set(Self.enabled.map(\.number))
        var executed: [Int] = []
        var passed: [Int] = []
        var notEnabled: [Int] = []
        for vector in vectors.cases {
            guard enabledNumbers.contains(vector.number) else {
                notEnabled.append(vector.number)
                continue
            }
            executed.append(vector.number)
            do {
                try await VectorReplay.run(vector, in: vectors)
                passed.append(vector.number)
            } catch {
                Issue.record("#\(vector.number) \(vector.name): \(error)")
            }
        }
        print("[participant vectors] \(vectors.cases.count) cases: \(executed.count) executed, \(passed.count) passed, "
            + "\(notEnabled.count) not yet enabled; executed \(executed.map { "#\($0)" }.joined(separator: " "))")
        #expect(executed.count == Self.expectedExecuted)
        #expect(passed == executed, "every executed case passes")
        #expect(notEnabled.count == Self.totalCases - Self.expectedExecuted)
        #expect(executed.count + notEnabled.count == vectors.cases.count, "every case is accounted for")
    }

    @Test("The four hashVectors: native's canonical JSON of inputChunks and its SHA-256, the 4,096-byte multibyte entry included")
    func hashVectors() throws {
        let vectors = try ParticipantVectors.load()
        #expect(vectors.hashVectors.count == 4)
        for vector in vectors.hashVectors {
            let chunks = JSONValue.array(vector.inputChunks.map(JSONValue.string))
            #expect(String(decoding: chunks.canonicalData(), as: UTF8.self) == vector.canonicalJson)
            #expect(chunks.canonicalData() == Data(vector.canonicalJson.utf8), "byte for byte")
            #expect(PayloadHash.hex(of: chunks) == vector.sha256)
        }
        let bounded = try #require(vectors.hashVectors.last)
        #expect(bounded.inputChunks.map(\.utf8.count) == [ParticipantLimits.firstTrialInputBound], "exactly the first-trial bound, in bytes")
        #expect(bounded.inputChunks[0].count < ParticipantLimits.firstTrialInputBound, "multibyte: fewer characters than bytes")
    }

    @Test("The native copy is byte-identical to the authoritative apps/desk vectors")
    func fixtureCopyIsExact() throws {
        let bundled = try ParticipantVectors.load().data
        let authoritative = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("desk/tests/fixtures/native-participant-v1.json")
        let original = try Data(contentsOf: authoritative)
        #expect(original.count > 1_000_000, "the scan read the real file")
        #expect(bundled == original, "copy apps/desk/tests/fixtures/native-participant-v1.json over the test fixture; never edit the copy")
    }

    @Test("The harness compares bytes: an NFC/NFD pair, the Kelvin sign and K, and a one-byte change all differ; equal bytes do not")
    func differenceIsBytes() {
        let precomposed = "invented caf\u{E9}"
        let decomposed = "invented cafe\u{301}"
        #expect(precomposed == decomposed && Array(precomposed) == Array(decomposed), "String and [Character] == are canonical equivalence")
        #expect(JSONValue.string(precomposed) == JSONValue.string(decomposed), "and so is JSONValue's ==")

        let nfc = VectorReplay.difference(.object(["text": .string(precomposed)]), .object(["text": .string(decomposed)]))
        #expect(nfc?.hasPrefix("differs at byte 21: actual 0xC3 ") == true && nfc?.contains(" expected 0x65 ") == true, "\(nfc ?? "nil")")
        let kelvin = VectorReplay.difference(.string("invented-\u{212A}"), .string("invented-K"))
        #expect(kelvin?.hasPrefix("differs at byte 10: actual 0xE2 ") == true && kelvin?.contains(" expected 0x4B ") == true, "\(kelvin ?? "nil")")
        let oneByte = VectorReplay.difference(.array([.string("invented a")]), .array([.string("invented b")]))
        #expect(oneByte?.hasPrefix("differs at byte 11: actual 0x61 ") == true && oneByte?.contains(" expected 0x62 ") == true, "\(oneByte ?? "nil")")
        let longer = VectorReplay.difference(.array([.number(1)]), .array([.number(1), .number(2)]))
        #expect(longer?.hasPrefix("differs at byte 2: actual 0x5D ") == true, "a prefix still differs: \(longer ?? "nil")")

        let same: JSONValue = .object(["text": .string(precomposed + " \u{1F600}"), "runs": .array([.string(decomposed), .null])])
        #expect(VectorReplay.difference(same, same) == nil)
    }

    @Test("A refusal's folder check sees a file changed, added or removed")
    func folderChangeIsSeen() async throws {
        let vectors = try ParticipantVectors.load()
        let world = try await VectorWorld(root: try vectors.named("workspace.commitProof prepare run missing from record"), vectors: vectors)
        defer { world.clean() }
        let before = try world.folderSnapshot()
        #expect(before["/state.json"] == world.stateBytes())
        #expect(VectorReplay.folderChange(before, try world.folderSnapshot()) == nil)

        var changed = before
        changed["/state.json"]?.append(0x20)
        #expect(VectorReplay.folderChange(before, changed) == "/state.json")
        var removed = before
        removed.removeValue(forKey: "/state.json")
        #expect(VectorReplay.folderChange(before, removed) == "/state.json")
        try Data("invented leftover".utf8).write(to: world.storeDirectory.appendingPathComponent(".invented-leftover.tmp"))
        #expect(VectorReplay.folderChange(before, try world.folderSnapshot()) == "/.invented-leftover.tmp", "hidden files count")
    }

    @Test("Codex Q26: the participant write invariant sees another file change, a rewrite with the runs unchanged, and a change beside the runs; a runs-only change passes")
    func participantWriteInvariant() throws {
        func state(_ fields: [String: JSONValue]) -> Data { JSONValue.object(fields).canonicalData() }
        let entry: JSONValue = .object(["runId": .string("invented-run")])
        let ended: JSONValue = .object(["runId": .string("invented-run"), "terminal": .string("invented-terminal")])
        let base: [String: JSONValue] = ["ledger": .array([]), "runs": .array([entry])]
        let before = ["/state.json": state(base), "/proof.lock": Data()]
        func check(_ after: [String: Data], runsAfter: [JSONValue]) -> Bool {
            (try? VectorReplay.checkParticipantWrites(before: before, after: after, runsBefore: [entry], runsAfter: runsAfter)) != nil
        }
        #expect(check(before, runsAfter: [entry]), "nothing changed")
        var withRuns = base
        withRuns["runs"] = .array([ended])
        #expect(check(["/state.json": state(withRuns), "/proof.lock": Data()], runsAfter: [ended]), "only the runs changed")

        #expect(!check(["/state.json": state(base), "/proof.lock": Data("x".utf8)], runsAfter: [entry]), "another file changed")
        #expect(!check(["/state.json": state(base), "/proof.lock": Data(), "/leftover.tmp": Data()], runsAfter: [entry]), "a file appeared")
        var spaced = state(base)
        spaced.append(0x20)
        #expect(!check(["/state.json": spaced, "/proof.lock": Data()], runsAfter: [entry]), "rewritten with the runs unchanged")
        var beside = withRuns
        beside["ledger"] = .array([.string("invented-entry")])
        #expect(!check(["/state.json": state(beside), "/proof.lock": Data()], runsAfter: [ended]), "the ledger changed beside the runs")
    }

    @Test("Codex S7 R1: #53's unknown-last restart with the largest safe cursor answers no events and no loss; one below, the loss starts at that largest value")
    func largestCursorWithUnknownLast() async throws {
        let vectors = try ParticipantVectors.load()
        let source = try vectors.named("participant.events after restart without exit")
        #expect(source.number == 53 && source.afterCase == nil)
        #expect(source.reply.objectValue?["lastSequence"] == .null, "the unknown-last branch")
        let largest = Double(ProofLimits.maxSafeInteger)
        func variant(after: Double, lost: JSONValue) throws -> ParticipantVectors.Case {
            var request = try #require(source.request.objectValue)
            var payload = try #require(request["payload"]?.objectValue)
            payload["afterSequence"] = .number(after)
            request["payload"] = .object(payload)
            var reply = try #require(source.reply.objectValue)
            reply["lost"] = lost
            return ParticipantVectors.Case(number: source.number, name: source.name, seed: source.seed, request: .object(request),
                                           reply: .object(reply), pushed: source.pushed, afterRuns: source.afterRuns, keys: source.keys)
        }
        let restarted: JSONValue = .object(["fromSequence": .number(largest), "throughSequence": .null, "reason": .string("restarted")])
        try await VectorReplay.run(try variant(after: largest, lost: .null), in: vectors)
        try await VectorReplay.run(try variant(after: largest - 1, lost: restarted), in: vectors)
        try await VectorReplay.run(source, in: vectors)
    }

    @Test("The replay refuses an action it does not drive and a case key it does not know, instead of running the case without them; S9's four actions, S10's four lifecycle actions and inFlight are driven, and every case runs")
    func unsupportedCaseKeys() async throws {
        let vectors = try ParticipantVectors.load()
        let source = try vectors.named("participant.status not dispatched after restart")
        #expect(source.afterCase == nil)
        try await VectorReplay.run(source, in: vectors)
        func variant(keys: Set<String>, actions: [String]) -> ParticipantVectors.Case {
            ParticipantVectors.Case(number: source.number, name: source.name, seed: source.seed, request: source.request, reply: source.reply,
                                    pushed: source.pushed, afterRuns: source.afterRuns, keys: source.keys.union(keys), actions: actions)
        }
        for (extended, expected) in [(variant(keys: ["actions"], actions: ["invented-action"]), "action invented-action"),
                                     (variant(keys: ["actions"], actions: ["lock", "invented-quit"]), "action invented-quit"),
                                     (variant(keys: ["invented"], actions: []), "case key invented")] {
            do {
                try await VectorReplay.run(extended, in: vectors)
                Issue.record("a case with \(expected) ran")
            } catch VectorHarnessError.unsupported(let text) {
                #expect(text.contains(expected), "\(text)")
            }
        }
        #expect(VectorWorld.actionNames == ["run-script", "group-clears", "supervisor-dies", "pipes-close", "lock", "unlock",
                                            "begin-generation", "issue-connection"])
        #expect(vectors.cases.allSatisfy { $0.keys.isSubset(of: VectorReplay.caseKeys) }, "every case key is driven")
        let withActions = vectors.cases.filter { !$0.actions.isEmpty }.map(\.number)
        #expect(withActions == [57, 58, 71, 80, 83, 84, 93, 94], "\(withActions)")
        let undriven = vectors.cases.filter { !Set($0.actions).isSubset(of: VectorWorld.actionNames) }.map(\.number)
        #expect(undriven == [], "every case's actions are driven: \(undriven)")
        #expect(Set(withActions).isSubset(of: Set(Self.enabled.map(\.number))), "every case with actions runs")
        let inFlight = vectors.cases.filter { $0.inFlight != nil }.map(\.number)
        #expect(inFlight == [23, 26, 42, 43, 44], "\(inFlight)")
        #expect(Set(inFlight).isSubset(of: Set(Self.enabled.map(\.number))), "every inFlight case runs")
    }

    @Test("Seeded prepare identities get a deterministic invented hash and land beside their entries; the store opens ready")
    func seededIdentities() async throws {
        let vectors = try ParticipantVectors.load()
        let seeded = try vectors.named("workspace.commitProof saves an interrupted closure")
        let world = try await VectorWorld(root: seeded, vectors: vectors)
        defer { world.clean() }
        #expect(world.store.status == .ready)
        #expect(world.seededPrepareIds == ["62abcdef-0000-4000-8abc-000000000001"])
        let prepareId = try #require(UUID(uuidString: "62abcdef-0000-4000-8abc-000000000001"))
        let identity = try #require(try world.store.terminalResult(for: prepareId))
        #expect(identity.outcome == .ok && identity.revision == 5)
        #expect(identity.payloadHash == VectorWorld.inventedPayloadHash("62abcdef-0000-4000-8abc-000000000001"))
        #expect(identity.payloadHash == VectorWorld.inventedPayloadHash("62abcdef-0000-4000-8abc-000000000001"), "deterministic")
        #expect(identity.payloadHash.count == 64)
        let runs = try #require(try world.runsOnDisk())
        #expect(VectorReplay.difference(.array(runs), seeded.seed["runs"] ?? .null) == nil)
        #expect(try world.store.refreshPublishedRuns().runs.map(\.runId) == ["71abcdef-0000-4000-8abc-000000000001"])
    }
}
