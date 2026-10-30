import Foundation
import Testing
@testable import DeskHost
@testable import ParticipantProcess

/// The Swift side of `native-participant-claude-v1.json` (contract section
/// 21.6) in the Claude Code adapter's PR 3c: the launcher produces every
/// `stdinLayouts` entry byte for byte, native's preparing checks count the
/// earlier turns against the first-trial bound as the vectors do, and every
/// prepared run the page accepts or refuses is accepted or refused here. The
/// availability cases wait for the approval state (`host-not-approved`),
/// which the Mac host does not build yet; they are counted, not run.
private struct ClaudeVectors {
    static let resourceName = "native-participant-claude-v1"
    let data: Data
    let root: [String: JSONValue]

    static func load() throws -> ClaudeVectors {
        guard let url = Bundle.module.url(forResource: resourceName, withExtension: "json") else {
            throw CocoaError(.fileNoSuchFile)
        }
        let data = try Data(contentsOf: url)
        guard let root = try JSONValue.decode(data).objectValue else { throw CocoaError(.fileReadCorruptFile) }
        return ClaudeVectors(data: data, root: root)
    }

    var context: [String: JSONValue] { root["context"]?.objectValue ?? [:] }
    func pin(_ name: String) -> ParticipantPin? { context[name].flatMap(ParticipantPin.init(json:)) }
    var cases: [[String: JSONValue]] { root["cases"]?.listItems?.compactMap(\.objectValue) ?? [] }
    var layouts: [[String: JSONValue]] { root["stdinLayouts"]?.listItems?.compactMap(\.objectValue) ?? [] }
    func runs(_ kind: String) -> [[String: JSONValue]] {
        root["runs"]?.objectValue?[kind]?.listItems?.compactMap(\.objectValue) ?? []
    }
}

private let sessionId = "52abcdef-0000-4000-8abc-000000001101"
private let createdAt = "2026-10-29T04:00:00.000Z"

/// A completed earlier run of the vectors' session: `user` in, `assistant` out.
private func completed(_ runId: String, participant: ParticipantPin, user: String, assistant: String) -> JSONValue {
    let suffix = runId.suffix(12)
    return .object([
        "version": .number(1), "runId": .string(runId), "sessionId": .string(sessionId),
        "userMessageId": .string("72abcdef-0000-4000-8abc-" + suffix), "assistantMessageId": .string("73abcdef-0000-4000-8abc-" + suffix),
        "participant": participant.jsonValue, "inputChunks": .array([.string(user)]), "outputChunks": .array([.string(assistant)]),
        "lastSequence": .number(3), "phase": .string("completed"), "createdAt": .string(createdAt),
        "updatedAt": .string("2026-10-29T04:00:05.000Z")])
}

/// The claim a page would send for `run`.
private func claim(for run: [String: JSONValue]) -> JSONValue {
    var fields: [String: JSONValue] = ["createdAt": run["createdAt"] ?? .null,
                                       "participantId": run["participant"]?.objectValue?["id"] ?? .null]
    for key in ["runId", "sessionId", "userMessageId", "assistantMessageId"] { fields[key] = run[key] }
    return .object(fields)
}

private func record(_ runs: [JSONValue]) -> [String: JSONValue] {
    ["schemaVersion": .number(2), "revision": .number(1), "conversationRuns": .array(runs)]
}

@Suite("Shared Claude Code adapter vectors (contract section 21)")
struct ClaudeVectorTests {
    @Test("The native copy is byte-identical to the authoritative apps/desk vectors")
    func fixtureCopyIsExact() throws {
        let bundled = try ClaudeVectors.load().data
        let authoritative = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("desk/tests/fixtures/native-participant-claude-v1.json")
        let original = try Data(contentsOf: authoritative)
        #expect(original.count > 10_000, "the scan read the real file")
        #expect(bundled == original, "copy apps/desk/tests/fixtures/native-participant-claude-v1.json over the test fixture; never edit the copy")
    }

    @Test("Every entry is counted: five layouts, four valid and five invalid runs run here; the eight page-level cases wait for the approval state")
    func everyEntryCounted() throws {
        let vectors = try ClaudeVectors.load()
        #expect(vectors.layouts.count == 5)
        #expect(vectors.runs("valid").count == 4 && vectors.runs("invalid").count == 5)
        #expect(vectors.cases.count == 8)
        #expect(vectors.cases.allSatisfy { $0["seed"] == nil }, "no seeded host case yet")
    }

    @Test("The launcher's stdin is each layout's bytes exactly, with the vectors' preamble and counts")
    func stdinLayouts() throws {
        let vectors = try ClaudeVectors.load()
        #expect(vectors.context["stdinPreamble"] == .string(ParticipantLaunchRequest.stdinPreamble))
        for layout in vectors.layouts {
            let name = layout["name"]?.stringValue ?? "?"
            let turns = try #require(layout["turns"]?.listItems).map { value -> LocalTurn in
                let fields = value.objectValue
                return LocalTurn(role: fields?["role"]?.stringValue ?? "", text: fields?["text"]?.stringValue ?? "")
            }
            let message = try #require(layout["message"]?.stringValue)
            let contextBytes = try #require(layout["contextBytes"]?.safeIntegerValue)
            let inputBytes = try #require(layout["inputBytes"]?.safeIntegerValue)
            let request = ParticipantLaunchRequest(
                identity: LauncherFixture.identity, model: Invented.model, context: turns, contextBytes: contextBytes,
                inputChunks: [message], inputBytes: inputBytes, preparedBytes: 2_048)
            #expect(Array(request.stdin) == Array(try #require(layout["stdin"]?.stringValue).utf8), "\(name)")
            #expect(turns.reduce(0) { $0 + $1.text.utf8.count } == contextBytes, "\(name)")
            #expect(request.message.count == inputBytes, "\(name)")
            #expect(layout["countedBytes"]?.safeIntegerValue == contextBytes + inputBytes, "\(name)")
            #expect(layout["firstTrialBound"]?.safeIntegerValue == ParticipantLimits.firstTrialInputBound, "\(name)")
        }
    }

    @Test("Native's preparing checks count the earlier turns against the first-trial bound exactly as each layout says")
    func firstTrialBound() throws {
        let vectors = try ClaudeVectors.load()
        let pin = try #require(vectors.pin("claudeParticipant"))
        for layout in vectors.layouts {
            let name = layout["name"]?.stringValue ?? "?"
            let turns = try #require(layout["turns"]?.listItems).compactMap { $0.objectValue?["text"]?.stringValue }
            try #require(turns.count % 2 == 0)
            var runs: [JSONValue] = []
            var ids: [String] = []
            for pair in stride(from: 0, to: turns.count, by: 2) {
                let id = "71abcdef-0000-4000-8abc-00000000" + String(1201 + pair / 2)
                ids.append(id)
                runs.append(completed(id, participant: pin, user: turns[pair], assistant: turns[pair + 1]))
            }
            let runId = "71abcdef-0000-4000-8abc-000000001299"
            let run: [String: JSONValue] = [
                "version": .number(1), "runId": .string(runId), "sessionId": .string(sessionId),
                "userMessageId": .string("72abcdef-0000-4000-8abc-000000001299"),
                "assistantMessageId": .string("73abcdef-0000-4000-8abc-000000001299"), "participant": pin.jsonValue,
                "inputChunks": .array([layout["message"] ?? .null]), "outputChunks": .array([]), "lastSequence": .number(0),
                "phase": .string("prepared"), "createdAt": .string(createdAt), "updatedAt": .string(createdAt),
                "contextRunIds": .array(ids.map(JSONValue.string))]
            let answer = ParticipantPrepare.prepare(claim: claim(for: run), record: record(runs + [.object(run)]), pin: pin,
                                                    inputBound: ParticipantLimits.firstTrialInputBound)
            if layout["withinFirstTrialBound"] == .bool(true) {
                guard case .passed(let prepared) = answer else { Issue.record("\(name): \(answer)"); continue }
                #expect(prepared.context?.bytes == layout["contextBytes"]?.safeIntegerValue, "\(name)")
                #expect(prepared.context?.runIds == ids, "\(name)")
                #expect(prepared.inputBytes == layout["inputBytes"]?.safeIntegerValue, "\(name)")
            } else {
                #expect(answer == .refused(.textTooLarge), "\(name): \(answer)")
            }
            // Without the bound, every layout prepares: only the bound counted the turns.
            if case .refused(let reason) = ParticipantPrepare.prepare(claim: claim(for: run), record: record(runs + [.object(run)]),
                                                                     pin: pin, inputBound: nil) {
                Issue.record("\(name) without a bound: \(reason)")
            }
        }
    }

    @Test("Every valid run prepares on the host that pins its entry, and every invalid run is refused with the contract's reason")
    func preparedRuns() throws {
        let vectors = try ClaudeVectors.load()
        let claude = try #require(vectors.pin("claudeParticipant"))
        let revision3 = try #require(vectors.pin("revision3Participant"))
        let local = try #require(vectors.pin("localParticipant"))
        let earlier = [
            completed("71abcdef-0000-4000-8abc-000000001101", participant: local, user: "Invented local question.",
                      assistant: "Invented local reply."),
            completed("71abcdef-0000-4000-8abc-000000001102", participant: claude, user: "Invented Claude question.",
                      assistant: "Invented Claude reply.")]
        let catalog = ParticipantLocalPrepare(catalog: .ready([LocalCatalogEntry(participant: local, available: true)]))
        func prepare(_ run: [String: JSONValue], pin: ParticipantPin) -> ParticipantCheck<ParticipantPreparedRun> {
            ParticipantPrepare.prepare(claim: claim(for: run), record: record(earlier + [.object(run)]), pin: pin,
                                       inputBound: ParticipantLimits.firstTrialInputBound, local: catalog)
        }

        for vector in vectors.runs("valid") {
            let name = vector["name"]?.stringValue ?? "?"
            let run = try #require(vector["run"]?.objectValue)
            let named = try #require(run["participant"].flatMap(ParticipantPin.init(json:)))
            let pin = named.isOffMac || named.carriesContext ? claude : revision3
            guard case .passed(let prepared) = prepare(run, pin: pin) else { Issue.record("\(name): \(prepare(run, pin: pin))"); continue }
            #expect((prepared.context != nil) == named.carriesContext, "\(name)")
            if named.isOffMac {
                // A host that pins the revision-3 entry is revision 4 exactly:
                // the thirteenth key is not in its prepared form.
                #expect(prepare(run, pin: revision3) == .refused(.runNotPrepared), "\(name) on a revision-3 host")
            }
        }

        let expected: [String: HostRefusal] = [
            "off-Mac Claude run without contextRunIds": .runNotPrepared,
            "revision-3 Claude Code run with contextRunIds": .runNotPrepared,
            "off-Mac Claude run listing an earlier run twice": .runNotPrepared,
            "off-Mac Claude run naming itself as context": .runMismatch,
            "off-Mac Claude run with an uppercase context id": .runNotPrepared,
        ]
        for vector in vectors.runs("invalid") {
            let name = vector["name"]?.stringValue ?? "?"
            let run = try #require(vector["run"]?.objectValue)
            let reason = try #require(expected[name], "a named reason for \(name)")
            #expect(prepare(run, pin: claude) == .refused(reason), "\(name): \(prepare(run, pin: claude))")
        }
    }
}

private extension JSONValue {
    var listItems: [JSONValue]? {
        if case .array(let items) = self { return items }
        return nil
    }
}
