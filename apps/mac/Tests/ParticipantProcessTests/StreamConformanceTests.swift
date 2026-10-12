import Darwin
import DeskHost
import Foundation
@testable import ParticipantProcess
import ParticipantSupervisorCore
import Testing

// F1: the streams PREDICTED for Claude Code 2.1.283 (Fixtures/cli-2.1.283
// and its README: a read-only reading of the program file, never a run),
// replayed through the REAL StreamJSONReader and ParticipantRunCore, and the
// fake CLI's predicted modes. Each reader test asserts what the reader does
// TODAY, as evidence for Codex's rulings on questions 7, 8, 10 and 25; none
// of it changes the reader, and none of it says the outcome is right.
// Invented data only; the real CLI is never run or named.

/// The predicted goldens and the init values they carry.
enum PredictedCLI {
    enum Stream: String, CaseIterable, Sendable, CustomTestStringConvertible {
        case normal
        case noOverageStatus = "no-overage-status"
        case overageAllowed = "overage-allowed"
        case noRateLimit = "no-rate-limit"
        case localSlash = "local-slash"
        case refused429 = "refused-429"

        var testDescription: String { rawValue }
    }

    enum FixtureError: Error { case missing(String) }

    /// The (f) fake's exit code 1 as the raw wait status `waitpid` reports
    /// and the run core reads (`exit code << 8`); a raw 1 would decode as
    /// signal 1 (Codex F1-M2).
    static let exitCodeOne: Int32 = 1 << 8

    static let model = "invented-pinned-model"
    static let reply = "Invented reply about an invented café."
    static let pluginsJSON = #"[{"name":"invented-builtin","path":"builtin","source":"invented-builtin@builtin"}]"#

    /// The seven init-rule values the goldens' init carries (section 11).
    static var expectation: ParticipantInitExpectation {
        ParticipantInitExpectation(model: model, slashCommands: [], skills: [],
                                   plugins: try! JSONValue.decode(Data(pluginsJSON.utf8)), apiKeySource: "none")
    }

    static func data(_ stream: Stream) throws -> Data {
        guard let folder = Bundle.module.resourceURL?.appendingPathComponent("cli-2.1.283", isDirectory: true) else {
            throw FixtureError.missing("cli-2.1.283")
        }
        let file = folder.appendingPathComponent(stream.rawValue + ".jsonl")
        guard FileManager.default.fileExists(atPath: file.path) else { throw FixtureError.missing(file.lastPathComponent) }
        return try Data(contentsOf: file)
    }

    /// The golden's lines, without their newlines.
    static func lines(_ stream: Stream) throws -> [String] {
        let text = String(decoding: try data(stream), as: UTF8.self)
        return text.split(separator: "\n", omittingEmptySubsequences: false).dropLast().map(String.init)
    }

    /// The line's decoded top-level `type`, wherever the key sits: key order
    /// is a guess (the README), and a recorded result may not start with it.
    static func type(of line: String) -> String? {
        guard case .object(let object)? = try? JSONValue.decode(Data(line.utf8)),
              case .string(let type)? = object["type"] else { return nil }
        return type
    }

    /// The first line whose top-level `type` is `type`.
    static func index(of type: String, in lines: [String]) -> Int? {
        lines.firstIndex { self.type(of: $0) == type }
    }

    /// The golden replayed through a run core: spawned, every line in one
    /// read, then the CLI's exit, both EOFs and the group's clearing.
    static func core(_ lines: [String], exit status: Int32 = 0) -> CoreHarness {
        var core = CoreHarness(expectation: expectation)
        core.control(.spawned)
        core.feed(lines)
        core.ends(status)
        return core
    }

    /// "sequence type [reason] [text]" for each event, `at` left out.
    static func summary(_ events: [ParticipantEvent]) -> [String] {
        events.map { event in
            ["\(event.sequence)", event.type.rawValue, event.reason, event.text.map { "text:" + $0 }]
                .compactMap { $0 }.joined(separator: " ")
        }
    }

    /// What today's reader makes of each golden, through the run core.
    static let outcomes: [Stream: (events: [String], overflowObserved: Bool)] = [
        .normal: (["1 started", "2 text text:\(reply)", "3 completed"], false),
        .noOverageStatus: (["1 started", "2 failed paid-overflow"], true),
        .overageAllowed: (["1 started", "2 failed paid-overflow"], true),
        .noRateLimit: (["1 started", "2 failed paid-overflow"], true),
        .localSlash: (["1 started", "2 failed paid-overflow"], true),
        .refused429: (["1 started", "2 failed process-error"], false)
    ]
}

@Suite("Predicted 2.1.283 streams: what today's reader does with each")
struct StreamConformanceTests {
    typealias Output = StreamJSONReader.Output

    @Test("The goldens are the predicted shapes: one shared init, (b)-(d) differ from (a) only at the rate-limit event, and the deltas spell the reply")
    func fixtureShapes() throws {
        var inits: Set<String> = []
        for stream in PredictedCLI.Stream.allCases {
            let data = try PredictedCLI.data(stream)
            #expect(data.last == 0x0A, "\(stream): ends with a newline")
            let lines = try PredictedCLI.lines(stream)
            #expect(!lines.isEmpty && lines.allSatisfy { !$0.isEmpty })
            for line in lines where PredictedCLI.type(of: line) == nil {
                Issue.record("\(stream): not a typed JSON object: \(line)")
            }
            #expect(PredictedCLI.index(of: "system", in: lines) == 0, "\(stream): init first")
            inits.insert(lines[0])
            let types = lines.map { PredictedCLI.type(of: $0) }
            #expect(types.filter { $0 == "result" }.count == 1, "\(stream): one result, last")
            #expect(types.last == "result")
            // Fields every result builder sampled in the file writes (review F1-R5); values invented.
            if let last = lines.last, case .object(let result)? = try? JSONValue.decode(Data(last.utf8)) {
                for key in ["subtype", "is_error", "duration_ms", "duration_api_ms", "num_turns", "result", "stop_reason",
                            "session_id", "total_cost_usd", "usage", "modelUsage", "permission_denials", "uuid"] {
                    #expect(result[key] != nil, "\(stream): result carries \(key)")
                }
            }
        }
        #expect(inits.count == 1, "every golden carries the same init")

        let normal = try PredictedCLI.lines(.normal)
        let rateLimit = try #require(PredictedCLI.index(of: "rate_limit_event", in: normal))
        #expect(rateLimit == normal.count - 2, "after message_stop, just before the result")
        #expect(normal[rateLimit - 1].contains("\"message_stop\""))
        var without = normal
        without[rateLimit] = normal[rateLimit].replacingOccurrences(of: ",\"overageStatus\":\"rejected\"", with: "")
        #expect(try PredictedCLI.lines(.noOverageStatus) == without, "(b) is (a) without overageStatus")
        var allowed = normal
        allowed[rateLimit] = normal[rateLimit].replacingOccurrences(of: "\"overageStatus\":\"rejected\"",
                                                                    with: "\"overageStatus\":\"allowed\"")
        #expect(try PredictedCLI.lines(.overageAllowed) == allowed, "(c) is (a) with overageStatus allowed")
        var none = normal
        none.remove(at: rateLimit)
        #expect(try PredictedCLI.lines(.noRateLimit) == none, "(d) is (a) without the event")

        let deltas = normal.compactMap { line -> String? in
            guard case .object(let message)? = try? JSONValue.decode(Data(line.utf8)),
                  case .object(let event)? = message["event"], case .object(let delta)? = event["delta"],
                  delta["type"] == .string("text_delta"), case .string(let text)? = delta["text"] else { return nil }
            return text
        }
        #expect(deltas.count == 3)
        #expect(deltas.joined() == PredictedCLI.reply)
        #expect(normal.contains { PredictedCLI.type(of: $0) == "assistant" && $0.contains("\"text\":\"\(PredictedCLI.reply)\"") },
                "the whole assistant message repeats the deltas")
    }

    /// The passing event releases the held text into the coalescing buffer;
    /// it is emitted by the next 250 ms tick or on the result, whichever
    /// comes first. SECTION 8 READING, open: "emitted 250 ms after the first
    /// unemitted byte" could be read as emitting at the event itself, since
    /// the held bytes arrived long before it. The reader restarts the 250 ms
    /// at the release, so with the event just before the result (the
    /// predicted order) the text is in practice emitted on the result.
    @Test("(a) normal: started, the text held through every line until the passing rate-limit event, then completed")
    func normal() throws {
        let lines = try PredictedCLI.lines(.normal)
        let rateLimit = try #require(PredictedCLI.index(of: "rate_limit_event", in: lines))
        let firstText = try #require(lines.firstIndex { $0.contains("\"text_delta\"") })
        #expect(firstText < rateLimit)

        // One line at a time, each followed by 1 s: past the 250 ms
        // coalescing, so any text released earlier would show at once.
        var run = ReaderHarness(expectation: PredictedCLI.expectation)
        run.spawned()
        for (index, line) in lines.enumerated() {
            let before = run.outputs.count
            run.feed([line])
            run.advance(1_000)
            let added = Array(run.outputs[before...])
            switch index {
            case 0:
                #expect(added == [.started])
            case rateLimit:
                #expect(added == [.text(PredictedCLI.reply)],
                        "released into the buffer at the passing event; emitted by the 250 ms tick within the 1 s that follows")
            default:
                #expect(added.isEmpty, "line \(index + 1): \(added)")
            }
            #expect(run.reader.overflowPassed == (index >= rateLimit), "line \(index + 1)")
        }
        run.ends(0)
        #expect(run.outputs == [.started, .text(PredictedCLI.reply), .terminal(.completed, groupCleared: true), .cleanupReleased])

        // The whole stream in one read at one instant: the released text is
        // emitted on the result, the line right after the event (section 8
        // reading above: not at the event, though its bytes are old).
        var instant = ReaderHarness(expectation: PredictedCLI.expectation)
        instant.spawned()
        instant.feed(Array(lines[...rateLimit]))
        #expect(instant.outputs == [.started], "released into the buffer, not yet emitted")
        instant.feed([lines[rateLimit + 1]])
        #expect(instant.outputs == [.started, .text(PredictedCLI.reply)])
        instant.ends(0)
        #expect(instant.terminal == .terminal(.completed, groupCleared: true))

        // Released at the event, then 249 ms with no tick: still held; at 250 ms, emitted.
        var timed = ReaderHarness(expectation: PredictedCLI.expectation)
        timed.spawned()
        timed.feed(Array(lines[...rateLimit]))
        timed.advance(249)
        #expect(timed.outputs == [.started], "249 ms after the release")
        timed.advance(1)
        #expect(timed.outputs == [.started, .text(PredictedCLI.reply)], "250 ms after the release, not after the first byte")

        let core = PredictedCLI.core(lines)
        #expect(PredictedCLI.summary(core.events) == PredictedCLI.outcomes[.normal]?.events)
        #expect(!core.updates.contains(.overflowObserved))

        // Nothing depends on key order: the result with `type` moved last
        // (as one of the file's result builders writes it) replays the same.
        var reordered = lines
        let last = lines.count - 1
        let body = String(lines[last].dropFirst(#"{"type":"result","#.count).dropLast())
        reordered[last] = "{" + body + #","type":"result"}"#
        #expect(reordered[last].hasPrefix(#"{"subtype":"success","#) && PredictedCLI.type(of: reordered[last]) == "result")
        #expect(PredictedCLI.summary(PredictedCLI.core(reordered).events) == PredictedCLI.outcomes[.normal]?.events)
    }

    /// QUESTION 8, the open risk: if a normal subscription reply with extra
    /// usage off carries no overage-status header, every run ends here, and
    /// the paid-overflow end also ends a section 17 confirmation.
    ///
    /// Section 11's rule now (Codex F0 answer 8): a missing `overageStatus`
    /// means unverified, not off; the text stays held and the run fails
    /// closed at the result. The reader does exactly that: the event without
    /// the field (and with no true flag) releases nothing and decides
    /// nothing, and the result that follows ends the run paid-overflow.
    @Test("(b) no overageStatus: the event is silent, the text stays held, and the result first ends paid-overflow (question 8)")
    func noOverageStatus() throws {
        let lines = try PredictedCLI.lines(.noOverageStatus)
        let rateLimit = try #require(PredictedCLI.index(of: "rate_limit_event", in: lines))
        var run = ReaderHarness(expectation: PredictedCLI.expectation)
        run.spawned()
        run.feed(Array(lines[...rateLimit]))
        run.advance(1_000)
        #expect(run.outputs == [.started], "the event without overageStatus releases nothing and decides nothing")
        #expect(!run.reader.overflowPassed)
        run.feed([lines[rateLimit + 1]])
        #expect(run.outputs == [.started, .overflowObserved, .sendStop], "decided at the result")
        run.ends(0)
        #expect(run.outputs == [.started, .overflowObserved, .sendStop, .terminal(.failed(.paidOverflow), groupCleared: true),
                                .cleanupReleased])
        #expect(run.texts.isEmpty, "the reply is never shown")

        let core = PredictedCLI.core(lines)
        #expect(PredictedCLI.summary(core.events) == PredictedCLI.outcomes[.noOverageStatus]?.events)
        #expect(core.updates.contains(.overflowObserved), "a confirmation that paid usage is off would end")
    }

    @Test("(c) overageStatus allowed (extra usage on): paid-overflow at the rate-limit event; the result after it changes nothing")
    func overageAllowed() throws {
        let lines = try PredictedCLI.lines(.overageAllowed)
        let rateLimit = try #require(PredictedCLI.index(of: "rate_limit_event", in: lines))
        var run = ReaderHarness(expectation: PredictedCLI.expectation)
        run.spawned()
        run.feed(Array(lines[..<rateLimit]))
        run.advance(1_000)
        #expect(run.outputs == [.started])
        run.feed([lines[rateLimit]])
        #expect(run.outputs == [.started, .overflowObserved, .sendStop], "decided at the event")
        run.feed([lines[rateLimit + 1]])
        #expect(run.outputs == [.started, .overflowObserved, .sendStop])
        run.ends(0)
        #expect(run.outputs == [.started, .overflowObserved, .sendStop, .terminal(.failed(.paidOverflow), groupCleared: true),
                                .cleanupReleased])

        let core = PredictedCLI.core(lines)
        #expect(PredictedCLI.summary(core.events) == PredictedCLI.outcomes[.overageAllowed]?.events)
        #expect(core.updates.contains(.overflowObserved))
    }

    @Test("(d) no rate-limit event: the result comes first, paid-overflow")
    func noRateLimit() throws {
        let lines = try PredictedCLI.lines(.noRateLimit)
        #expect(PredictedCLI.index(of: "rate_limit_event", in: lines) == nil)
        var run = ReaderHarness(expectation: PredictedCLI.expectation)
        run.spawned()
        run.feed(Array(lines.dropLast()))
        run.advance(1_000)
        #expect(run.outputs == [.started])
        run.feed([lines[lines.count - 1]])
        #expect(run.outputs == [.started, .overflowObserved, .sendStop], "decided at the result")
        run.ends(0)
        #expect(run.outputs == [.started, .overflowObserved, .sendStop, .terminal(.failed(.paidOverflow), groupCleared: true),
                                .cleanupReleased])

        let core = PredictedCLI.core(lines)
        #expect(PredictedCLI.summary(core.events) == PredictedCLI.outcomes[.noRateLimit]?.events)
        #expect(core.updates.contains(.overflowObserved))
    }

    /// An invented `assistant` line, as the program may print for a local
    /// answer or an API error before the result (review F1-3, medium
    /// confidence, unmodelled in the goldens). Its exact fields are not
    /// pinned; the reader only checks that init came first.
    static func assistantLine(_ text: String) -> String {
        #"{"type":"assistant","message":{"id":"msg_invented_aside","type":"message","role":"assistant","#
            + #""content":[{"type":"text","text":"\#(text)"}]},"parent_tool_use_id":null,"#
            + #""session_id":"00000000-0000-4000-8000-00000000f100","uuid":"00000000-0000-4000-8000-00000000f1a1"}"#
    }

    /// QUESTION 25: an input whose first character is "/" (for example a
    /// leading-slash form of the 16.2 `/config` check) gets init and a local
    /// result with no model call. Init passes, so the run starts; the result
    /// comes first, so it ends paid-overflow and ends the confirmation,
    /// though nothing reached the provider. Section 16.2 itself does not
    /// require the input to start with "/" (a `/config` later in the input
    /// is never parsed as a command); the collision is between a
    /// leading-slash acceptance input and section 11's result-first rule.
    @Test("(e) a leading-slash local result: started, then paid-overflow (result first), which ends the confirmation (question 25)")
    func localSlash() throws {
        let lines = try PredictedCLI.lines(.localSlash)
        #expect(lines.count == 2)
        var run = ReaderHarness(expectation: PredictedCLI.expectation)
        run.spawned()
        run.feed([lines[0]])
        run.advance(1_000)
        #expect(run.outputs == [.started], "init passes before the local answer")
        run.feed([lines[1]])
        #expect(run.outputs == [.started, .overflowObserved, .sendStop])
        run.ends(0)
        #expect(run.outputs == [.started, .overflowObserved, .sendStop, .terminal(.failed(.paidOverflow), groupCleared: true),
                                .cleanupReleased])

        let core = PredictedCLI.core(lines)
        #expect(PredictedCLI.summary(core.events) == PredictedCLI.outcomes[.localSlash]?.events)
        #expect(core.updates.contains(.overflowObserved))

        // With the local answer also printed as an `assistant` line between
        // init and the result (review F1-3): the same end.
        let aside = [lines[0], Self.assistantLine("Invented local answer: that command is not available here."), lines[1]]
        let withAside = PredictedCLI.core(aside)
        #expect(PredictedCLI.summary(withAside.events) == PredictedCLI.outcomes[.localSlash]?.events)
        #expect(withAside.updates.contains(.overflowObserved))
    }

    /// The reader never reads the event's `status`: `overageStatus`
    /// "rejected" with no flag set passes, whatever `status` says. The error
    /// result then fails the success-result rule, so the run is a
    /// process-error, not paid-overflow, and no confirmation ends. Which
    /// result subtype a refusal carries is not pinned; both spellings give
    /// the same end. Without `overageStatus` it would be paid-overflow, as (b).
    @Test("(f) a 429-style refusal: the rate-limit event passes, the error result ends process-error, no overflow observed")
    func refused429() throws {
        let lines = try PredictedCLI.lines(.refused429)
        let rateLimit = try #require(PredictedCLI.index(of: "rate_limit_event", in: lines))
        #expect(rateLimit == 1 && lines.count == 3, "the event comes before any text; there is no text")
        #expect(lines[rateLimit].contains("\"status\":\"rejected\""))

        var run = ReaderHarness(expectation: PredictedCLI.expectation)
        run.spawned()
        run.feed([lines[0], lines[1]])
        run.advance(1_000)
        #expect(run.outputs == [.started])
        #expect(run.reader.overflowPassed, "status rejected is not read; overageStatus rejected passes")
        run.feed([lines[2]])
        #expect(run.outputs == [.started, .sendStop], "the error result is not a success")
        let decoded = ParticipantWaitStatus.decode(PredictedCLI.exitCodeOne)
        #expect(decoded.exitCode == 1 && decoded.signal == nil, "the status replayed is an exit with code 1, not a signal")
        run.ends(PredictedCLI.exitCodeOne)
        #expect(run.outputs == [.started, .sendStop, .terminal(.failed(.processError), groupCleared: true), .cleanupReleased])

        let core = PredictedCLI.core(lines, exit: PredictedCLI.exitCodeOne)
        #expect(PredictedCLI.summary(core.events) == PredictedCLI.outcomes[.refused429]?.events)
        #expect(!core.updates.contains(.overflowObserved))

        func replay(_ changed: [String]) -> CoreHarness { PredictedCLI.core(changed, exit: PredictedCLI.exitCodeOne) }
        var otherSubtype = lines
        otherSubtype[2] = lines[2].replacingOccurrences(of: "\"subtype\":\"success\"", with: "\"subtype\":\"error_during_execution\"")
        #expect(otherSubtype[2] != lines[2])
        #expect(PredictedCLI.summary(replay(otherSubtype).events) == ["1 started", "2 failed process-error"])

        var statusAllowed = lines
        statusAllowed[1] = lines[1].replacingOccurrences(of: "\"status\":\"rejected\"", with: "\"status\":\"allowed\"")
        #expect(statusAllowed[1] != lines[1])
        #expect(PredictedCLI.summary(replay(statusAllowed).events) == ["1 started", "2 failed process-error"],
                "the same end: status is not part of the overflow rule")

        var noOverage = lines
        noOverage[1] = lines[1].replacingOccurrences(of: ",\"overageStatus\":\"rejected\"", with: "")
        #expect(noOverage[1] != lines[1])
        let silent = replay(noOverage)
        #expect(PredictedCLI.summary(silent.events) == ["1 started", "2 failed paid-overflow"])
        #expect(silent.updates.contains(.overflowObserved))

        // With the API error also printed as an `assistant` line before the
        // result (review F1-3): the same end; its text is never shown.
        let aside = [lines[0], lines[1], Self.assistantLine("Invented refusal: usage limit reached."), lines[2]]
        let withAside = replay(aside)
        #expect(PredictedCLI.summary(withAside.events) == PredictedCLI.outcomes[.refused429]?.events)
        #expect(!withAside.updates.contains(.overflowObserved))
    }

    struct Drift: Sendable, CustomTestStringConvertible {
        let field: String
        let from: String
        let to: String
        var testDescription: String { "\(field): \(to)" }
    }

    static let drifts: [Drift] = [
        Drift(field: "model", from: #""model":"invented-pinned-model""#, to: #""model":"invented-other-model""#),
        Drift(field: "tools", from: #""tools":[]"#, to: #""tools":["InventedTool"]"#),
        Drift(field: "mcp_servers", from: #""mcp_servers":[]"#,
              to: #""mcp_servers":[{"name":"invented-server","status":"connected"}]"#),
        Drift(field: "slash_commands", from: #""slash_commands":[]"#, to: #""slash_commands":["invented-command"]"#),
        Drift(field: "skills", from: #""skills":[]"#, to: #""skills":["invented-skill"]"#),
        Drift(field: "plugins", from: #""plugins":\#(PredictedCLI.pluginsJSON)"#, to: #""plugins":[]"#),
        Drift(field: "plugins", from: #""plugins":\#(PredictedCLI.pluginsJSON)"#,
              to: #""plugins":[{"name":"invented-builtin","path":"builtin","source":"invented-builtin@builtin"},"#
                + #"{"name":"invented-builtin-two","path":"builtin","source":"invented-builtin-two@builtin"}]"#),
        Drift(field: "apiKeySource", from: #""apiKeySource":"none""#, to: #""apiKeySource":"ANTHROPIC_API_KEY""#)
    ]

    @Test("Init drift: a change to any one init-rule field fails process-error at sequence 1, nothing shown, nothing observed",
          arguments: drifts)
    func initDrift(_ drift: Drift) throws {
        var lines = try PredictedCLI.lines(.normal)
        #expect(lines[0].components(separatedBy: drift.from).count == 2, "\(drift.field) appears once in init")
        lines[0] = lines[0].replacingOccurrences(of: drift.from, with: drift.to)
        #expect(try lines[0] != PredictedCLI.lines(.normal)[0])

        var run = ReaderHarness(expectation: PredictedCLI.expectation)
        run.spawned()
        run.feed(lines)
        #expect(run.outputs.first == .sendStop, "decided at init")
        #expect(run.startedCount == 0)
        run.ends(0)
        #expect(run.outputs == [.sendStop, .terminal(.failed(.processError), groupCleared: true), .cleanupReleased])

        let core = PredictedCLI.core(lines)
        #expect(PredictedCLI.summary(core.events) == ["1 failed process-error"])
        #expect(!core.updates.contains(.overflowObserved), "the passing rate-limit event read after the end signals nothing")
    }

    /// Today the init rule reads seven fields; drift in any other init field
    /// (the CLI version among them, which is section 5's `--version` check)
    /// does not end a run. Recorded as evidence for question 7, not as a rule.
    @Test("Drift outside the seven init-rule fields still completes today")
    func driftOutsideTheRule() throws {
        let changes: [(String, String)] = [
            (#""claude_code_version":"2.1.283""#, #""claude_code_version":"2.1.284""#),
            (#""permissionMode":"default""#, #""permissionMode":"invented-mode""#),
            (#""output_style":"default""#, #""output_style":"invented-style""#),
            (#""agents":["invented-agent"]"#, #""agents":[]"#),
            (#""capabilities":["invented-capability"]"#, #""capabilities":[]"#),
            (#""analytics_disabled":true"#, #""analytics_disabled":false"#),
            (#""product_feedback_disabled":true"#, #""product_feedback_disabled":false"#),
            (#""fast_mode_state":"off""#, #""fast_mode_state":"invented-state""#),
            (#""cwd":"/invented/working-folder""#, #""cwd":"/invented/elsewhere""#)
        ]
        for (from, to) in changes {
            var lines = try PredictedCLI.lines(.normal)
            #expect(lines[0].components(separatedBy: from).count == 2, "\(from) appears once")
            lines[0] = lines[0].replacingOccurrences(of: from, with: to)
            #expect(PredictedCLI.summary(PredictedCLI.core(lines).events) == PredictedCLI.outcomes[.normal]?.events, "\(to)")
        }
    }
}

extension ProcessSuites {
    /// The fake CLI's predicted 2.1.283 modes (`Predicted.swift`), run as a
    /// plain process or behind the real supervisor. Never the real CLI.
    @Suite("Predicted 2.1.283: the fake CLI's modes")
    struct PredictedCLIModes {
        /// One fake invocation outside the supervisor. Its environment is the
        /// final section 11 environment over invented values (the allow-list
        /// and the fixed values, as the supervisor would pass them), or
        /// `environment` exactly as written. Its stdin stays open (and
        /// unwritten) unless `input` is given, so a mode that read stdin would
        /// never finish.
        final class Invocation: @unchecked Sendable {
            let process = Process()
            private let stdin = Pipe()
            private let output: Task<Data, Never>
            private let errors: Task<Data, Never>

            static func finalEnvironment(_ folder: FakeCLIFolder) -> [String] {
                ParticipantEnvironment.build(from: ["HOME": folder.root.appendingPathComponent("home").path,
                                                    "USER": "invented-user", "TMPDIR": folder.temporary.path + "/",
                                                    "LANG": "en_US.UTF-8"])
            }

            init(_ folder: FakeCLIFolder, _ arguments: [String], input: Data? = nil, environment: [String]? = nil) throws {
                process.executableURL = URL(fileURLWithPath: folder.cliPath)
                process.arguments = arguments
                var entries: [String: String] = [:]
                for entry in environment ?? Self.finalEnvironment(folder) {
                    let name = String(entry.prefix { $0 != "=" })
                    entries[name] = String(entry.dropFirst(name.count + 1))
                }
                process.environment = entries
                process.currentDirectoryURL = folder.workParent
                let stdout = Pipe()
                let stderr = Pipe()
                process.standardInput = stdin
                process.standardOutput = stdout
                process.standardError = stderr
                try process.run()
                let outHandle = stdout.fileHandleForReading
                let errHandle = stderr.fileHandleForReading
                output = Task.detached { outHandle.readDataToEndOfFile() }
                errors = Task.detached { errHandle.readDataToEndOfFile() }
                if let input {
                    // The stream modes read stdin to EOF before they write or exit.
                    try stdin.fileHandleForWriting.write(contentsOf: input)
                    try stdin.fileHandleForWriting.close()
                }
            }

            /// The exit status, or nil (and the fake killed) after `seconds`.
            func finish(within seconds: Double) async -> Int32? {
                let process = process
                let done = await Processes.waitUntil(seconds: seconds) { !process.isRunning }
                if done == nil {
                    kill(process.processIdentifier, SIGKILL)
                    _ = await Processes.waitUntil(seconds: 5) { !process.isRunning }
                }
                try? stdin.fileHandleForWriting.close()
                return done == nil ? nil : process.terminationStatus
            }

            func stdout() async -> Data { await output.value }
            func stderr() async -> Data { await errors.value }
        }

        static let input = Data("invented question about invented things".utf8)

        static func folder(stream: String? = nil, authStatus: String? = nil, version: String? = nil,
                           slowMs: Int? = nil) throws -> FakeCLIFolder {
            var scenario = FakeCLIFolder.Scenario()
            scenario.stream = stream
            scenario.authStatus = authStatus
            scenario.version = version
            scenario.slowMs = slowMs
            return try FakeCLIFolder(scenario)
        }

        @Test("Each stream mode prints its golden byte for byte under the section 11 argv; another --model is echoed")
        func streamsMatchGoldens() async throws {
            for stream in PredictedCLI.Stream.allCases {
                let folder = try Self.folder(stream: stream.rawValue)
                defer { folder.clean() }
                let fake = try Invocation(folder, ParticipantCommandLine.arguments(model: PredictedCLI.model), input: Self.input)
                let status = await fake.finish(within: 10)
                let printed = await fake.stdout()
                let errors = await fake.stderr()
                let golden = try PredictedCLI.data(stream)
                #expect(status == (stream == .refused429 ? 1 : 0), "\(stream)")
                #expect(printed == golden, "\(stream): the fake and the golden differ")
                #expect(errors.isEmpty)
                #expect(folder.cliRecord()?["stdin"] as? String == String(decoding: Self.input, as: UTF8.self))
            }

            let folder = try Self.folder(stream: "normal")
            defer { folder.clean() }
            let fake = try Invocation(folder, ParticipantCommandLine.arguments(model: "invented-other-model"), input: Self.input)
            let status = await fake.finish(within: 10)
            #expect(status == 0)
            let printed = String(decoding: await fake.stdout(), as: UTF8.self)
            let golden = String(decoding: try PredictedCLI.data(.normal), as: UTF8.self)
            #expect(printed == golden.replacingOccurrences(of: "\"model\":\"invented-pinned-model\"",
                                                           with: "\"model\":\"invented-other-model\""))
            #expect(printed.components(separatedBy: "invented-other-model").count == 4, "init, message start, assistant")
        }

        @Test("A predicted stream outside section 11's exact argv or environment: nothing on stdout, exit 70")
        func streamNeedsSection11Invocation() async throws {
            let pinned = ParticipantCommandLine.arguments(model: PredictedCLI.model)
            let folder = try Self.folder(stream: "normal")
            defer { folder.clean() }
            let exact = Invocation.finalEnvironment(folder)
            #expect(exact.suffix(5) == Invented.fixedEnvironment)
            let cases: [(String, [String], [String])] = [
                ("no --strict-mcp-config", pinned.filter { $0 != "--strict-mcp-config" }, exact),
                ("an empty --mcp-config added", Array(pinned.dropLast(2)) + ["--mcp-config", #"{"mcpServers":{}}"#]
                    + Array(pinned.suffix(2)), exact),
                ("a fixed switch missing", pinned, exact.filter { !$0.hasPrefix("ENABLE_CLAUDEAI_MCP_SERVERS=") }),
                ("a fixed switch different", pinned,
                 exact.map { $0.hasPrefix("CLAUDE_CODE_DISABLE_ATTACHMENTS=") ? "CLAUDE_CODE_DISABLE_ATTACHMENTS=0" : $0 }),
                ("PATH different", pinned, exact.map { $0.hasPrefix("PATH=") ? "PATH=/invented/bin:/usr/bin" : $0 }),
                ("a dropped name present", pinned, exact + ["ANTHROPIC_API_KEY=invented-not-a-key"]),
                // Codex F1-M3: what section 11 never passes either.
                ("a model argument read as a flag", Array(pinned.dropLast()) + ["--help"], exact),
                ("a blank model argument", Array(pinned.dropLast()) + ["  "], exact),
                ("a model argument with a control character", Array(pinned.dropLast()) + ["invented\nmodel"], exact),
                ("an optional entry with an empty value", pinned,
                 exact.contains { $0.hasPrefix("HOME=") } ? exact.map { $0.hasPrefix("HOME=") ? "HOME=" : $0 } : exact + ["HOME="]),
                ("another optional entry with an empty value", pinned,
                 exact.contains { $0.hasPrefix("LC_ALL=") } ? exact.map { $0.hasPrefix("LC_ALL=") ? "LC_ALL=" : $0 } : exact + ["LC_ALL="])
            ]
            for (name, arguments, environment) in cases {
                let fake = try Invocation(folder, arguments, input: Self.input, environment: environment)
                let status = await fake.finish(within: 10)
                let printed = await fake.stdout()
                let errors = String(decoding: await fake.stderr(), as: UTF8.self)
                #expect(status == 70, "\(name)")
                #expect(printed.isEmpty, "\(name): no predicted line")
                #expect(errors.hasPrefix("invented fake: a predicted stream needs section 11's argv and environment"), "\(name): \(errors)")
            }
            // The control: the same folder, the exact argv and environment.
            let fake = try Invocation(folder, pinned, input: Self.input, environment: exact)
            let status = await fake.finish(within: 10)
            let printed = await fake.stdout()
            let golden = try PredictedCLI.data(.normal)
            #expect(status == 0)
            #expect(printed == golden)
        }

        @Test("Through the real supervisor and run, each stream mode ends exactly as its golden replays")
        func liveRuns() async throws {
            for stream in PredictedCLI.Stream.allCases {
                var scenario = FakeCLIFolder.Scenario()
                scenario.stream = stream.rawValue
                let live = try LiveRun(scenario, expectation: PredictedCLI.expectation)
                let group = try await live.folder.waitForPid("cli.pid")
                try await live.collector.wait(seconds: 10, for: "release (\(stream))") { $0.released }
                let expected = try #require(PredictedCLI.outcomes[stream])
                let lines = try PredictedCLI.lines(stream)
                let replayed = PredictedCLI.summary(PredictedCLI.core(lines, exit: stream == .refused429 ? PredictedCLI.exitCodeOne : 0).events)
                #expect(PredictedCLI.summary(live.collector.events) == expected.events, "\(stream)")
                #expect(PredictedCLI.summary(live.collector.events) == replayed, "\(stream): live and replay agree")
                #expect(live.collector.updates.contains(.overflowObserved) == expected.overflowObserved, "\(stream)")
                #expect(live.collector.terminalUpdate?.groupCleared == true)
                await live.finish(group: group)
            }
        }

        @Test("--version, -v and -V print the predicted line (with --verbose, a commit line), read no stdin and leave cli.pid and cli.json alone")
        func version() async throws {
            let folder = try Self.folder()
            defer { folder.clean() }
            let line = "\(ParticipantCommandLine.pinnedCLIVersion) (Claude Code)\n"
            #expect(line == "2.1.283 (Claude Code)\n")
            for arguments in [["--version"], ["-v"], ["-V"]] {
                let fake = try Invocation(folder, arguments)
                let status = await fake.finish(within: 10)
                let printed = String(decoding: await fake.stdout(), as: UTF8.self)
                let errors = await fake.stderr()
                #expect(status == 0, "\(arguments): exits with its stdin still open")
                #expect(printed == line)
                #expect(errors.isEmpty)
            }
            let verbose = try Invocation(folder, ["--version", "--verbose"])
            let verboseStatus = await verbose.finish(within: 10)
            let verboseText = String(decoding: await verbose.stdout(), as: UTF8.self)
            #expect(verboseStatus == 0)
            #expect(verboseText == line + "Commit: 0000000000000000000000000000000000000000\n")

            #expect(folder.pid("cli.pid") == nil && folder.cliRecord() == nil, "a check is not a run")
            let record = try #require(folder.record("version.json"))
            #expect(record["argv"] as? [String] == ["--version", "--verbose"])
            #expect(record["stdin"] == nil, "stdin was never read")
            #expect(Set(record["env"] as? [String] ?? []) == Set([
                "HOME=\(folder.root.appendingPathComponent("home").path)", "USER=invented-user",
                "TMPDIR=\(folder.temporary.path)/", "LANG=en_US.UTF-8"
            ] + Invented.fixedEnvironment))

            let other = try Self.folder(version: "2.1.284")
            defer { other.clean() }
            let mismatch = try Invocation(other, ["--version"])
            let mismatchStatus = await mismatch.finish(within: 10)
            let mismatchText = String(decoding: await mismatch.stdout(), as: UTF8.self)
            #expect(mismatchStatus == 0)
            #expect(mismatchText == "2.1.284 (Claude Code)\n")
        }

        struct AuthAnswer: Equatable {
            var exit: Int32
            var loggedIn: Bool
            var authMethod: String
            var apiProvider: String
            var apiKeySource: String?
            /// nil when absent; "null" when present as null.
            var subscriptionType: String?
        }

        @Test("auth status variants print the predicted pretty JSON with invented account values and the predicted exit codes")
        func authStatus() async throws {
            let expected: [(String, AuthAnswer)] = [
                ("subscription", AuthAnswer(exit: 0, loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty",
                                            apiKeySource: nil, subscriptionType: "max")),
                ("signed-out", AuthAnswer(exit: 1, loggedIn: false, authMethod: "none", apiProvider: "firstParty",
                                          apiKeySource: nil, subscriptionType: nil)),
                ("console", AuthAnswer(exit: 0, loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty",
                                       apiKeySource: "/login managed key", subscriptionType: "null")),
                ("api-key-env", AuthAnswer(exit: 0, loggedIn: true, authMethod: "api_key", apiProvider: "firstParty",
                                           apiKeySource: "ANTHROPIC_API_KEY", subscriptionType: nil)),
                ("bedrock", AuthAnswer(exit: 0, loggedIn: true, authMethod: "third_party", apiProvider: "bedrock",
                                       apiKeySource: nil, subscriptionType: nil)),
                ("vertex", AuthAnswer(exit: 0, loggedIn: true, authMethod: "third_party", apiProvider: "vertex",
                                      apiKeySource: nil, subscriptionType: nil))
            ]
            var subscriptionLike: [String] = []
            for (variant, answer) in expected {
                let folder = try Self.folder(authStatus: variant)
                defer { folder.clean() }
                for arguments in [["auth", "status"], ["auth", "status", "--json"]] {
                    let fake = try Invocation(folder, arguments)
                    let status = await fake.finish(within: 10)
                    let text = String(decoding: await fake.stdout(), as: UTF8.self)
                    #expect(text.hasPrefix("{\n  \"loggedIn\": ") && text.hasSuffix("\n}\n"), "\(variant): pretty-printed")
                    let object = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
                    let subscription: String? = object.keys.contains("subscriptionType")
                        ? ((object["subscriptionType"] as? String) ?? "null") : nil
                    let actual = AuthAnswer(exit: status ?? -1, loggedIn: object["loggedIn"] as? Bool ?? false,
                                            authMethod: object["authMethod"] as? String ?? "",
                                            apiProvider: object["apiProvider"] as? String ?? "",
                                            apiKeySource: object["apiKeySource"] as? String, subscriptionType: subscription)
                    #expect(actual == answer, "\(variant) \(arguments)")
                    for key in ["analyticsDisabled", "projectsDirectory", "configDirectory"] {
                        #expect(object[key] != nil, "\(variant): \(key) is always present")
                    }
                    let hasAccount = object["authMethod"] as? String == "claude.ai"
                    #expect(object.keys.contains("email") == hasAccount, "\(variant): account fields only for claude.ai")
                    if hasAccount {
                        #expect((object["email"] as? String)?.hasSuffix("@example.invalid") == true, "invented")
                        #expect((object["orgName"] as? String)?.hasPrefix("Invented") == true, "invented")
                    }
                    #expect((object["projectsDirectory"] as? String)?.hasPrefix("/invented/") == true, "invented")
                    // The reading's subscription test, as F3 would apply it.
                    if arguments.count == 2, object["authMethod"] as? String == "claude.ai", object["apiKeySource"] == nil,
                       object["apiProvider"] as? String == "firstParty", object["subscriptionType"] is String {
                        subscriptionLike.append(variant)
                    }
                }
                #expect(folder.record("auth-status.json") != nil)
                #expect(folder.pid("cli.pid") == nil && folder.cliRecord() == nil)
            }
            #expect(subscriptionLike == ["subscription"], "a Console key reads claude.ai too; only the full test tells them apart")

            let garbled = try Self.folder(authStatus: "garbled")
            defer { garbled.clean() }
            let unreadable = try Invocation(garbled, ["auth", "status"])
            let unreadableStatus = await unreadable.finish(within: 10)
            let bytes = await unreadable.stdout()
            #expect(unreadableStatus == 0)
            #expect(!bytes.isEmpty)
            #expect((try? JSONSerialization.jsonObject(with: bytes)) == nil, "not JSON")

            let text = try Invocation(garbled, ["auth", "status", "--text"])
            let textStatus = await text.finish(within: 10)
            let textOutput = await text.stdout()
            #expect(textStatus == 64, "--text is not modelled")
            #expect(textOutput.isEmpty)

            let unset = try Self.folder()
            defer { unset.clean() }
            let refused = try Invocation(unset, ["auth", "status"])
            let refusedStatus = await refused.finish(within: 10)
            let refusedOutput = await refused.stdout()
            #expect(refusedStatus == 70, "no variant chosen: no answer")
            #expect(refusedOutput.isEmpty)
        }

        @Test("The slow auth status answers only after its delay; by default it is still silent past 1 s (it sleeps 6 s, past the 5 s bound)")
        func slowAuthStatus() async throws {
            let short = try Self.folder(authStatus: "slow", slowMs: 400)
            defer { short.clean() }
            let start = ContinuousClock.now
            let timed = try Invocation(short, ["auth", "status"])
            let timedStatus = await timed.finish(within: 10)
            let elapsed = Processes.elapsed(since: start)
            #expect(timedStatus == 0)
            #expect(elapsed >= 0.4, "\(elapsed)")
            let subscription = try Self.folder(authStatus: "subscription")
            defer { subscription.clean() }
            let quick = try Invocation(subscription, ["auth", "status"])
            let quickStatus = await quick.finish(within: 10)
            let late = await timed.stdout()
            let prompt = await quick.stdout()
            #expect(quickStatus == 0)
            #expect(!late.isEmpty && late == prompt, "then the subscription answer")

            let slow = try Self.folder(authStatus: "slow")
            defer { slow.clean() }
            let waiting = try Invocation(slow, ["auth", "status"])
            let waitingStatus = await waiting.finish(within: 1)
            let waitingOutput = await waiting.stdout()
            #expect(waitingStatus == nil, "still running after 1 s; killed")
            #expect(waitingOutput.isEmpty, "nothing printed before it was killed")
            #expect(slow.record("auth-status.json") != nil, "it did start")
            measured("slow auth status", [("400 ms variant", elapsed)])
        }
    }
}

@Suite("No test, fixture or fake names the real CLI's path")
struct RealCLIPathScanTests {
    @Test("Tests (every target, fixtures included) and the test fakes never name the installed CLI's link or versions folder, or any home .local path")
    func noRealCLIPath() throws {
        let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        let roots = ["Tests", "Sources/ParticipantTestFakes"]
        // Every file, this one included, is held to these, so they are built
        // from parts here.
        let paths: [[String]] = [[".local", "bin", "claude"], [".local", "share", "claude"]]
        let local = ".local"
        var needles: [String] = paths.map { $0.joined(separator: "/") }   // as written
        needles += paths.map { $0.joined(separator: "\\/") }               // as JSON escapes it
        needles.append("/\(local)/")                                       // any home .local path
        // Pieces a path could be built from: a .local segment at either end
        // of a literal, a quoted ".local", and the tails after it, however
        // the head is built. Only this file, which defines the needles and
        // spells the pieces below to check them, may hold them.
        let pieceNeedles = ["/.local", ".local/", "\".local\"", "bin/claude", "share/claude", "claude/versions"]
        let ownFile = "Tests/ParticipantProcessTests/StreamConformanceTests.swift"
        // The needles match the real spellings under an invented home.
        for path in paths {
            let spelled = "/users/invented/" + path.joined(separator: "/") + "/versions/2.1.283"
            #expect(needles.filter { spelled.contains($0) }.count == 2, "\(path)")
        }
        // And the piece needles catch paths built from pieces (lowercased, as scanned).
        let built = [#"let link = home + "/.local" + "/bin/claude""#,
                     #"home.appendingPathComponent(".local").appendingPathComponent("share")"#,
                     #"let folder = "~/.local""#,
                     #"let tail = ".local/share" + "/claude""#,
                     #"home + "/x" + "/share/claude/versions/2.1.283""#,
                     #"["bin", "claude"].joined(separator: "/") + "/bin/claude""#]
        for spelling in built {
            #expect(needles.allSatisfy { !spelling.contains($0) }, "only a piece needle: \(spelling)")
            #expect(pieceNeedles.contains { spelling.lowercased().contains($0) }, "caught: \(spelling)")
        }
        var scanned: [String] = []
        var found: [String] = []
        for root in roots {
            let folder = package.appendingPathComponent(root, isDirectory: true)
            let subpaths = try #require(FileManager.default.subpaths(atPath: folder.path))
            for subpath in subpaths {
                let file = folder.appendingPathComponent(subpath)
                var isDirectory: ObjCBool = false
                guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
                    continue
                }
                let relative = root + "/" + subpath
                scanned.append(relative)
                let text = String(decoding: try Data(contentsOf: file), as: UTF8.self).lowercased()
                for needle in needles where text.contains(needle) {
                    found.append("\(relative): \(needle)")
                }
                for needle in pieceNeedles where relative != ownFile && text.contains(needle) {
                    found.append("\(relative): \(needle)")
                }
            }
        }
        #expect(found.isEmpty, "\(found)")
        #expect(scanned.count > 80, "the scan read the tests and fakes: \(scanned.count)")
        for expected in ["Tests/ParticipantProcessTests/StreamConformanceTests.swift",
                         "Tests/ParticipantProcessTests/ProcessTestSupport.swift",
                         "Tests/ParticipantProcessTests/Fixtures/cli-2.1.283/README.md",
                         "Tests/ParticipantProcessTests/Fixtures/cli-2.1.283/normal.jsonl",
                         "Sources/ParticipantTestFakes/FakeCLI/main.swift",
                         "Sources/ParticipantTestFakes/FakeCLI/Predicted.swift"] {
            #expect(scanned.contains(expected), "scanned \(expected)")
        }
    }
}
