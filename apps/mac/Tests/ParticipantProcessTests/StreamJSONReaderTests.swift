import DeskHost
import Foundation
@testable import ParticipantProcess
import ParticipantSupervisorCore
import Testing

/// Feeds a reader invented stream-json lines on an invented clock.
struct ReaderHarness {
    var reader: StreamJSONReader
    var outputs: [StreamJSONReader.Output] = []
    var now: UInt64 = 0

    init(inputBytes: Int = 20, preparedBytes: Int = 1_000, limits: StreamJSONReaderLimits = .contract,
         expectation: ParticipantInitExpectation = Invented.expectation) {
        reader = StreamJSONReader(configuration: .init(expectedInit: expectation, inputBytes: inputBytes,
                                                       preparedBytes: preparedBytes, limits: limits))
    }

    mutating func spawned() { outputs += reader.supervisor(.spawned, now: now) }
    mutating func feed(_ lines: [String]) { feedBytes(Data((lines.joined(separator: "\n") + "\n").utf8)) }
    mutating func feedBytes(_ bytes: Data) { outputs += reader.consumeStdout(bytes, now: now) }
    mutating func advance(_ millis: UInt64) { now += millis; outputs += reader.tick(now: now) }
    mutating func exit(_ status: Int32) { outputs += reader.supervisor(.exit(status: status), now: now) }
    mutating func cleared() { outputs += reader.supervisor(.cleared, now: now) }
    mutating func uncleared() { outputs += reader.supervisor(.uncleared, now: now) }
    mutating func stdoutEOF() { outputs += reader.stdoutClosed(now: now) }
    mutating func stderrEOF() { outputs += reader.stderrClosed(now: now) }
    mutating func controlClosed() { outputs += reader.controlClosed(now: now) }
    mutating func stop() { outputs += reader.stopRequested(now: now) }

    /// The CLI exits with `status`, its pipes close and the group clears.
    mutating func ends(_ status: Int32 = 0) {
        exit(status)
        stdoutEOF()
        stderrEOF()
        cleared()
    }

    var texts: [String] { outputs.compactMap { if case .text(let text) = $0 { return text } else { return nil } } }
    var terminals: [StreamJSONReader.Output] { outputs.filter { if case .terminal = $0 { return true } else { return false } } }
    var terminal: StreamJSONReader.Output? { terminals.first }
    var startedCount: Int { outputs.filter { $0 == .started }.count }
    var sentStop: Bool { outputs.contains(.sendStop) }
    var released: Bool { outputs.contains(.cleanupReleased) }
}

@Suite("Stream reader: text, init and overflow rules")
struct StreamJSONReaderTests {
    @Test("A passing run: started, text, then completed once the group clears")
    func completedRun() {
        var run = ReaderHarness()
        run.spawned()
        run.feed(Invented.passingStream(["Hello", ", invented", " world"]))
        #expect(run.outputs == [.started, .text("Hello, invented world")], "text flushes on the result")
        run.exit(0)
        run.stdoutEOF()
        #expect(run.terminal == nil, "the terminal waits for the group's end")
        run.cleared()
        #expect(run.terminal == .terminal(.completed, groupCleared: true))
        #expect(run.released)
        run.stderrEOF()
        run.advance(200_000)
        #expect(run.terminals.count == 1)
        #expect(run.outputs.last == .cleanupReleased)
    }

    @Test("Text is held, never shown, until a rate-limit message passes the overflow rule")
    func textHeldUntilOverflowPasses() {
        var run = ReaderHarness()
        run.spawned()
        run.feed([Invented.initLine(), Invented.messageStart, Invented.blockStart(0), Invented.textDelta("held text")])
        run.advance(5_000)
        #expect(run.texts.isEmpty)
        run.feed([Invented.rateLimit()])
        #expect(run.texts.isEmpty, "released into the buffer, then coalesced")
        run.advance(250)
        #expect(run.texts == ["held text"])
    }

    @Test("A result before any rate-limit message fails paid-overflow and shows nothing")
    func resultFirstIsPaidOverflow() {
        var run = ReaderHarness()
        run.spawned()
        run.feed([Invented.initLine(), Invented.messageStart, Invented.blockStart(0),
                  Invented.textDelta("never shown"), Invented.result()])
        #expect(run.sentStop)
        run.ends(0)
        #expect(run.texts.isEmpty)
        #expect(run.terminal == .terminal(.failed(.paidOverflow), groupCleared: true))
    }

    static let failingRateLimits: [String] = [
        Invented.rateLimit(overageStatus: "allowed"),
        Invented.rateLimit(overageStatus: "allowed_warning"),
        Invented.rateLimit(overageStatus: NSNull()),
        Invented.rateLimit(overageStatus: 5),
        Invented.rateLimit(overageStatus: "invented-new-status"),
        Invented.rateLimit(isUsingOverage: true),
        Invented.rateLimit(overageInUse: true),
        Invented.rateLimit(isUsingOverage: "yes"),
        Invented.rateLimit(overageInUse: NSNull())
    ]

    @Test("Any other overageStatus or a true (or non-false) flag fails paid-overflow", arguments: failingRateLimits)
    func overflowRuleFails(_ line: String) {
        var run = ReaderHarness()
        run.spawned()
        run.feed([Invented.initLine(), Invented.messageStart, Invented.blockStart(0), Invented.textDelta("held"), line])
        #expect(run.sentStop)
        run.ends(SIGTERM)
        #expect(run.texts.isEmpty)
        #expect(run.terminal == .terminal(.failed(.paidOverflow), groupCleared: true))
    }

    static let passingRateLimits: [String] = [
        Invented.rateLimit(),
        Invented.rateLimit(isUsingOverage: nil),
        Invented.rateLimit(isUsingOverage: false, overageInUse: false)
    ]

    @Test("overageStatus rejected with nothing in use passes", arguments: passingRateLimits)
    func overflowRulePasses(_ line: String) {
        var run = ReaderHarness()
        run.spawned()
        run.feed([Invented.initLine(), line, Invented.messageStart, Invented.blockStart(0), Invented.textDelta("shown"),
                  Invented.result()])
        #expect(run.texts == ["shown"])
        run.ends(0)
        #expect(run.terminal == .terminal(.completed, groupCleared: true))
    }

    @Test("A later rate-limit message allowing overflow ends the run, keeping text already shown")
    func laterOverflowFails() {
        var run = ReaderHarness()
        run.spawned()
        run.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0),
                  Invented.textDelta("first")])
        run.advance(250)
        run.feed([Invented.textDelta(" pending"), Invented.rateLimit(overageStatus: "allowed"),
                  Invented.textDelta(" after")])
        run.ends(SIGTERM)
        #expect(run.texts == ["first", " pending"], "accepted text is emitted, later output dropped")
        #expect(run.terminal == .terminal(.failed(.paidOverflow), groupCleared: true))
    }

    @Test("A rate-limit message without overageStatus keeps text held")
    func missingOverageStatusHolds() {
        var run = ReaderHarness()
        run.spawned()
        run.feed([Invented.initLine(), Invented.rateLimit(overageStatus: nil), Invented.messageStart,
                  Invented.blockStart(0), Invented.textDelta("held")])
        run.advance(1_000)
        #expect(run.texts.isEmpty)
        run.feed([Invented.result()])
        run.ends(0)
        #expect(run.terminal == .terminal(.failed(.paidOverflow), groupCleared: true))
    }

    @Test("Only text_delta of text blocks becomes text; thinking and other blocks are ignored")
    func onlyTextBlocks() {
        var run = ReaderHarness()
        run.spawned()
        run.feed([
            Invented.initLine(), Invented.rateLimit(), Invented.messageStart,
            Invented.blockStart(0, type: "thinking"),
            Invented.thinkingDelta("invented private reasoning", index: 0),
            Invented.textDelta("text delta inside a thinking block", index: 0),
            Invented.blockStart(1, type: "tool_use"),
            Invented.textDelta("text delta inside a tool block", index: 1),
            Invented.textDelta("text delta for a block never started", index: 7),
            Invented.streamEvent(["type": "content_block_delta", "index": 2,
                                  "delta": ["type": "text_delta", "text": "a subagent's text"]], parent: "toolu_invented"),
            Invented.blockStart(2),
            Invented.textDelta("visible", index: 2),
            Invented.json(["type": "assistant", "message": ["content": [["type": "text", "text": "repeated whole"]]],
                           "parent_tool_use_id": NSNull()]),
            Invented.result()
        ])
        #expect(run.texts == ["visible"])
    }

    static let failingInits: [String] = [
        Invented.initLine(model: "invented-other-model"),
        Invented.initLine(tools: ["Bash"]),
        Invented.initLine(mcpServers: [["name": "invented", "status": "connected"]]),
        Invented.initLine(slashCommands: []),
        Invented.initLine(slashCommands: ["invented-command", "config"]),
        Invented.initLine(skills: ["invented-skill"]),
        Invented.initLine(plugins: [["name": "invented-plugin", "path": "/invented"]]),
        Invented.initLine(apiKeySource: "ANTHROPIC_API_KEY"),
        Invented.json(["type": "system", "subtype": "init", "model": Invented.model, "tools": [], "mcp_servers": [],
                       "slash_commands": ["invented-command"], "skills": [], "apiKeySource": "none"])
    ]

    @Test("An init that breaks the init rule fails process-error at sequence 1", arguments: failingInits)
    func initRule(_ line: String) {
        var run = ReaderHarness()
        run.spawned()
        run.feed([line] + Array(Invented.passingStream(["never"]).dropFirst()))
        #expect(run.startedCount == 0)
        #expect(run.sentStop)
        run.ends(SIGTERM)
        #expect(run.outputs.first == .sendStop)
        #expect(run.texts.isEmpty)
        #expect(run.terminal == .terminal(.failed(.processError), groupCleared: true))
    }

    @Test("Stream output before init is a process error")
    func streamBeforeInit() {
        for early in [Invented.rateLimit(), Invented.messageStart, Invented.result(),
                      Invented.json(["type": "assistant", "message": [:]])] {
            var run = ReaderHarness()
            run.spawned()
            run.feed([early] + Invented.passingStream(["never"]))
            run.ends(0)
            #expect(run.startedCount == 0)
            #expect(run.terminal == .terminal(.failed(.processError), groupCleared: true))
        }
    }

    @Test("Lines split on \\n only: Unicode line separators stay text; chunks and CRLF are fine")
    func newlineOnly() {
        let tricky = "line\u{2028}separator\u{2029}paragraph\u{85}next\u{0B}tab\u{0C}feed"
        var run = ReaderHarness()
        run.spawned()
        let stream = [Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0),
                      Invented.textDelta(tricky), Invented.result()]
        let bytes = Data((stream.joined(separator: "\r\n") + "\r\n").utf8)
        for byte in bytes { run.feedBytes(Data([byte])) }
        #expect(run.texts == [tricky])
        run.ends(0)
        #expect(run.terminal == .terminal(.completed, groupCleared: true))
    }

    @Test("Unreadable output is a process error", arguments: [
        "not json", "[1,2,3]", "\"a string\"", "{\"no\":\"type\"}", "{\"type\":5}",
        String(repeating: "[", count: 70) + String(repeating: "]", count: 70),
        "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0}}",
        "{\"type\":\"rate_limit_event\"}"
    ])
    func unreadable(_ line: String) {
        var run = ReaderHarness()
        run.spawned()
        run.feed([Invented.initLine(), line])
        #expect(run.sentStop)
        run.ends(SIGTERM)
        #expect(run.terminal == .terminal(.failed(.processError), groupCleared: true))
    }

    @Test("A line over 1 MiB is a process error, even before its newline")
    func lineTooLong() {
        var run = ReaderHarness()
        run.spawned()
        run.feed([Invented.initLine()])
        run.feedBytes(Data(repeating: 0x20, count: 1_048_576))
        #expect(!run.sentStop, "exactly 1 MiB is still a line")
        run.feedBytes(Data([0x20]))
        #expect(run.sentStop)
        run.ends(SIGTERM)
        #expect(run.terminal == .terminal(.failed(.processError), groupCleared: true))
    }

    @Test("Text events stay within 16,384 bytes, cut between scalars, emitted before the buffer passes it")
    func sixteenKiB() {
        let pieces = String(repeating: "€", count: 7_000) + String(repeating: "🙂", count: 3_000) + "end"
        var run = ReaderHarness()
        run.spawned()
        run.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0),
                  Invented.textDelta(pieces)])
        let immediate = run.texts
        #expect(immediate.count == 2, "two full events before any timer")
        run.advance(250)
        let texts = run.texts
        #expect(texts.joined() == pieces)
        for text in texts {
            #expect(text.utf8.count >= 1)
            #expect(text.utf8.count <= 16_384)
        }
        #expect(immediate[0].utf8.count == 16_383, "5,461 three-byte scalars; the next would pass 16,384")
    }

    @Test("Text is emitted 250 ms after the first unemitted byte")
    func coalescing() {
        var run = ReaderHarness()
        run.spawned()
        run.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0),
                  Invented.textDelta("one")])
        run.advance(100)
        run.feed([Invented.textDelta(" two")])
        #expect(run.reader.nextDeadline() == 250)
        run.advance(149)
        #expect(run.texts.isEmpty)
        run.advance(1)
        #expect(run.texts == ["one two"])
        run.advance(1_000)
        #expect(run.texts == ["one two"])
    }

    @Test("Input plus output past 262,144 bytes: the longest prefix that fits, then reply-too-long")
    func replyTooLongBytes() {
        var run = ReaderHarness(inputBytes: 262_144 - 5)
        run.spawned()
        run.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0),
                  Invented.textDelta("aé€ more")])
        run.advance(250)
        #expect(run.texts == ["aé"], "a (1) + é (2) fit in 5; € (3) would not")
        #expect(run.sentStop)
        run.ends(SIGTERM)
        #expect(run.terminal == .terminal(.failed(.replyTooLong), groupCleared: true))
    }

    @Test("Text that cannot fit ends the run when it arrives, not at the next flush: the prefix, then reply-too-long (vector #48)")
    func replyTooLongAtArrival() {
        // Vector #48: 41 bytes of room; é (2 bytes) after 40 would pass it.
        var run = ReaderHarness(inputBytes: 262_144 - 41)
        run.spawned()
        run.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0)])
        run.now = 100
        run.feed([Invented.textDelta("Four. Invented reply with an accent: caf\u{E9}, and more")])
        #expect(run.texts == ["Four. Invented reply with an accent: caf"], "at the delta's millisecond, before any tick")
        #expect(run.sentStop)
        run.ends(SIGTERM)
        #expect(run.terminal == .terminal(.failed(.replyTooLong), groupCleared: true))

        // Text that still fits waits for its 250 ms as before.
        var fits = ReaderHarness(inputBytes: 262_144 - 41)
        fits.spawned()
        fits.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0),
                   Invented.textDelta(String(repeating: "x", count: 41))])
        #expect(fits.texts.isEmpty && !fits.sentStop, "exactly the room: nothing decided yet")
        fits.advance(250)
        #expect(fits.texts == [String(repeating: "x", count: 41)])
        fits.feed([Invented.textDelta("y")])
        #expect(fits.sentStop, "one byte past the room ends it at once")
        #expect(fits.texts.count == 1, "nothing more is emitted")
    }

    @Test("After text that cannot fit, a Stop, a paid-overflow signal or an exit without a result within the old 250 ms leaves reply-too-long")
    func replyTooLongArrivalRaces() {
        func overrun() -> ReaderHarness {
            var run = ReaderHarness(inputBytes: 262_144 - 41)
            run.spawned()
            run.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0)])
            run.now = 100
            run.feed([Invented.textDelta("Four. Invented reply with an accent: caf\u{E9}, and more")])
            run.now = 200
            return run
        }
        var stop = overrun()
        stop.stop()
        stop.ends(SIGTERM)
        #expect(stop.terminal == .terminal(.failed(.replyTooLong), groupCleared: true), "not local-stop")

        var overage = overrun()
        overage.feed([Invented.rateLimit(overageStatus: "allowed", isUsingOverage: true)])
        overage.ends(SIGTERM)
        #expect(overage.terminal == .terminal(.failed(.replyTooLong), groupCleared: true), "not paid-overflow")

        var exited = overrun()
        exited.ends(0)
        #expect(exited.terminal == .terminal(.failed(.replyTooLong), groupCleared: true), "not process-error")
        for run in [stop, overage, exited] {
            #expect(run.texts == ["Four. Invented reply with an accent: caf"] && run.terminals.count == 1)
        }
    }

    @Test("Held text that overruns the budget keeps nothing after the cut, so what is released is a prefix")
    func heldOverrunIsPrefix() {
        // 2 bytes of room: 😀 (4 bytes) is cut, so "ab" after it must not show.
        var emoji = ReaderHarness(inputBytes: 262_144 - 2)
        emoji.spawned()
        emoji.feed([Invented.initLine(), Invented.messageStart, Invented.blockStart(0),
                    Invented.textDelta("😀"), Invented.textDelta("ab"), Invented.rateLimit()])
        #expect(emoji.texts.isEmpty, "the reply was 😀ab; its longest prefix within 2 bytes is empty")
        #expect(emoji.sentStop)
        emoji.ends(SIGTERM)
        #expect(emoji.texts.isEmpty)
        #expect(emoji.terminal == .terminal(.failed(.replyTooLong), groupCleared: true))

        // 5 bytes of room: "abc" fits, 😀 does not, so "de" never closes the gap.
        var middle = ReaderHarness(inputBytes: 262_144 - 5)
        middle.spawned()
        middle.feed([Invented.initLine(), Invented.messageStart, Invented.blockStart(0), Invented.textDelta("abc"),
                     Invented.textDelta("😀"), Invented.textDelta("de"), Invented.rateLimit(), Invented.result()])
        middle.ends(SIGTERM)
        #expect(middle.texts == ["abc"], "the reply was abc😀de; no character is dropped from its middle")
        #expect(middle.terminal == .terminal(.failed(.replyTooLong), groupCleared: true))
    }

    @Test("A text delta after the success result ends the run process-error; nothing after the result shows")
    func textAfterResult() {
        var tail = ReaderHarness()
        tail.spawned()
        tail.feed(Invented.passingStream(["one"]) + [Invented.messageStart, Invented.blockStart(0),
                                                    Invented.textDelta("after-result")])
        #expect(tail.texts == ["one"])
        #expect(tail.sentStop, "the CLI went on after its result")
        tail.ends(0)
        #expect(tail.terminal == .terminal(.failed(.processError), groupCleared: true))

        // Past the budget and decided at the same instant as the exit: never a
        // cut reply recorded as completed.
        var cut = ReaderHarness(inputBytes: 262_144 - 3)
        cut.spawned()
        cut.feed(Invented.passingStream(["ab"]) + [Invented.textDelta("cdef")])
        cut.ends(0)
        #expect(cut.texts == ["ab"])
        #expect(cut.terminal == .terminal(.failed(.processError), groupCleared: true))

        // A delta that is not text (or empty text) after the result changes nothing.
        var quiet = ReaderHarness()
        quiet.spawned()
        quiet.feed(Invented.passingStream(["whole"]) + [Invented.thinkingDelta("invented", index: 0),
                                                       Invented.textDelta("")])
        quiet.ends(0)
        #expect(quiet.texts == ["whole"])
        #expect(quiet.terminal == .terminal(.completed, groupCleared: true))
    }

    @Test("A projected run past 785,408 bytes ends reply-too-long; escapes count")
    func replyTooLongProjected() {
        // projected = prepared + 3 + (escaped + 3) + 64; leave room for 6 escaped bytes.
        let prepared = 785_408 - 3 - 64 - 3 - 6
        var run = ReaderHarness(preparedBytes: prepared)
        run.spawned()
        run.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0),
                  Invented.textDelta("a\"bc")])
        run.advance(250)
        #expect(run.texts == ["a\"b"], "quotes 2 + a 1 + \\\" 2 + b 1 = 6")
        run.ends(SIGTERM)
        #expect(run.terminal == .terminal(.failed(.replyTooLong), groupCleared: true))
    }

    @Test("Escaped widths match the canonical JSON writer")
    func escapedWidths() {
        for text in ["plain", "quote\"back\\slash", "\n\r\t\u{08}\u{0C}", "\u{01}\u{1F}\u{7F}", "é€🙂\u{2028}", ""] {
            let width = 2 + text.unicodeScalars.reduce(0) { $0 + StreamJSONReader.escapedWidth($1) }
            #expect(width == JSONValue.string(text).canonicalData().count, "\(text.debugDescription)")
        }
    }
}

@Suite("Stream reader: stops, exits and the one terminal")
struct StreamJSONReaderEndingTests {
    @Test("Stop emits accepted text at once and drops held text")
    func stopTextHandling() {
        var accepted = ReaderHarness()
        accepted.spawned()
        accepted.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0),
                       Invented.textDelta("accepted")])
        accepted.stop()
        #expect(accepted.texts == ["accepted"])
        #expect(!accepted.sentStop, "the caller already wrote stop")
        accepted.feed([Invented.textDelta(" later")])
        accepted.ends(SIGTERM)
        #expect(accepted.texts == ["accepted"])
        #expect(accepted.terminal == .terminal(.stopped(.localStop), groupCleared: true))

        var held = ReaderHarness()
        held.spawned()
        held.feed([Invented.initLine(), Invented.messageStart, Invented.blockStart(0), Invented.textDelta("held")])
        held.stop()
        held.feed([Invented.rateLimit()])
        held.ends(SIGTERM)
        #expect(held.texts.isEmpty)
        #expect(held.terminal == .terminal(.stopped(.localStop), groupCleared: true))
    }

    @Test("Uncleared gives stop-incomplete; a later clear sets groupCleared without a new terminal")
    func stopIncomplete() {
        var run = ReaderHarness()
        run.spawned()
        run.feed([Invented.initLine()])
        run.stop()
        run.exit(SIGTERM)
        run.uncleared()
        #expect(run.terminal == .terminal(.stopped(.stopIncomplete), groupCleared: false))
        #expect(!run.released)
        run.uncleared()
        run.cleared()
        #expect(run.outputs.suffix(2) == [.groupClearedAfterTerminal, .cleanupReleased])
        #expect(run.terminals.count == 1)
        #expect(run.reader.groupCleared == true)
    }

    @Test("Supervisor lost: process-error, groupCleared false for good, released only at both EOFs")
    func supervisorLost() {
        var run = ReaderHarness()
        run.spawned()
        run.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0),
                  Invented.textDelta("accepted")])
        run.controlClosed()
        #expect(run.texts == ["accepted"])
        #expect(run.terminal == .terminal(.failed(.processError), groupCleared: false))
        run.feed([Invented.textDelta(" drained, never shown")])
        run.stdoutEOF()
        #expect(!run.released)
        run.cleared()
        #expect(run.reader.groupCleared == false, "never later set true")
        run.stderrEOF()
        #expect(run.released)
        #expect(run.texts == ["accepted"])

        var stopping = ReaderHarness()
        stopping.spawned()
        stopping.feed([Invented.initLine()])
        stopping.stop()
        stopping.controlClosed()
        #expect(stopping.terminal == .terminal(.stopped(.stopIncomplete), groupCleared: false))

        var after = ReaderHarness()
        after.spawned()
        after.feed(Invented.passingStream(["done"]))
        after.ends(0)
        after.controlClosed()
        #expect(after.terminals.count == 1)
        #expect(after.terminal == .terminal(.completed, groupCleared: true))
    }

    @Test("Spawn failure: failed process-error with groupCleared null; a Stop first gives stopped")
    func spawnFailure() {
        var run = ReaderHarness()
        run.outputs += run.reader.supervisor(.spawnFailed, now: 0)
        #expect(run.outputs == [.terminal(.failed(.processError), groupCleared: nil), .cleanupReleased])
        run.controlClosed()
        #expect(run.terminals.count == 1)

        var stopped = ReaderHarness()
        stopped.stop()
        stopped.outputs += stopped.reader.supervisor(.spawnFailed, now: 0)
        #expect(stopped.terminal == .terminal(.stopped(.localStop), groupCleared: nil))
    }

    @Test("completed needs a success result, then exit 0", arguments: [
        (Invented.passingStream(["text"]), Int32(256)),
        (Array(Invented.passingStream(["text"]).dropLast()), Int32(0)),
        (Array(Invented.passingStream(["text"]).dropLast()) + [Invented.result(subtype: "error_during_execution", isError: true)], Int32(0)),
        (Array(Invented.passingStream(["text"]).dropLast()) + [Invented.result(isError: true)], Int32(0)),
        (Invented.passingStream(["text"]), Int32(9))
    ])
    func exitDecisions(_ lines: [String], _ status: Int32) {
        var run = ReaderHarness()
        run.spawned()
        run.feed(lines)
        run.ends(status)
        #expect(run.terminal == .terminal(.failed(.processError), groupCleared: true))
    }

    @Test("An exit reported before stdout drains waits for EOF, or for the grace period")
    func exitBeforeEOF() {
        var run = ReaderHarness()
        run.spawned()
        let stream = Invented.passingStream(["late"])
        run.feed(Array(stream.dropLast()))
        run.exit(0)
        run.cleared()
        #expect(run.terminal == nil)
        run.feed([stream.last!])
        run.stdoutEOF()
        #expect(run.texts == ["late"])
        #expect(run.terminal == .terminal(.completed, groupCleared: true))

        var silent = ReaderHarness()
        silent.spawned()
        silent.feed(Array(stream.dropLast()))
        silent.exit(0)
        silent.cleared()
        silent.advance(999)
        #expect(silent.terminal == nil)
        silent.advance(1)
        #expect(silent.terminal == .terminal(.failed(.processError), groupCleared: true))
    }

    @Test("A reply that completed before a Stop stays completed; a lost supervisor turns it into process-error")
    func completedBeforeStop() {
        var run = ReaderHarness()
        run.spawned()
        run.feed(Invented.passingStream(["whole reply"]))
        run.exit(0)
        run.stdoutEOF()
        run.stop()
        run.cleared()
        #expect(run.terminal == .terminal(.completed, groupCleared: true))

        var lost = ReaderHarness()
        lost.spawned()
        lost.feed(Invented.passingStream(["whole reply"]))
        lost.exit(0)
        lost.stdoutEOF()
        lost.controlClosed()
        #expect(lost.terminal == .terminal(.failed(.processError), groupCleared: false))

        var overflow = ReaderHarness()
        overflow.spawned()
        overflow.feed([Invented.initLine(), Invented.result()])
        overflow.controlClosed()
        #expect(overflow.terminal == .terminal(.failed(.paidOverflow), groupCleared: false),
                "a failure native already decided keeps its reason")
    }

    @Test("A Stop after the CLI's exit 0 does not change how it ended, whichever source reports first")
    func stopAfterExitZero() {
        let stream = Invented.passingStream(["done"])

        // exit, cleared, Stop, then stdout EOF.
        var late = ReaderHarness()
        late.spawned()
        late.feed(stream)
        late.exit(0)
        late.cleared()
        late.advance(100)
        late.stop()
        late.stdoutEOF()
        #expect(late.texts == ["done"])
        #expect(late.terminal == .terminal(.completed, groupCleared: true))

        // exit, Stop, stdout EOF, cleared.
        var early = ReaderHarness()
        early.spawned()
        early.feed(stream)
        early.exit(0)
        early.stop()
        early.stdoutEOF()
        early.cleared()
        #expect(early.terminal == .terminal(.completed, groupCleared: true))

        // stdout never closes (a descendant holds it): completed after the grace.
        var open = ReaderHarness()
        open.spawned()
        open.feed(stream)
        open.exit(0)
        open.cleared()
        open.advance(999)
        open.stop()
        open.advance(1)
        #expect(open.terminal == .terminal(.completed, groupCleared: true))

        // The result is still in the pipe when the Stop lands: completed once read.
        var piped = ReaderHarness()
        piped.spawned()
        piped.feed(Array(stream.dropLast()))
        piped.exit(0)
        piped.stop()
        piped.feed([stream.last!])
        piped.stdoutEOF()
        piped.cleared()
        #expect(piped.texts == ["done"])
        #expect(piped.terminal == .terminal(.completed, groupCleared: true))

        // Exit 0 without a success result is the CLI's own failure, not a Stop.
        var noResult = ReaderHarness()
        noResult.spawned()
        noResult.feed(Array(stream.dropLast()))
        noResult.exit(0)
        noResult.stop()
        noResult.stdoutEOF()
        noResult.cleared()
        #expect(noResult.terminal == .terminal(.failed(.processError), groupCleared: true))

        // A Stop before the exit still stops, even after the result.
        var before = ReaderHarness()
        before.spawned()
        before.feed(stream)
        before.stop()
        before.exit(SIGTERM)
        before.stdoutEOF()
        before.cleared()
        #expect(before.terminal == .terminal(.stopped(.localStop), groupCleared: true))
    }

    @Test("A last line without its newline is read at EOF")
    func lastLineAtEOF() {
        var run = ReaderHarness()
        run.spawned()
        let stream = Invented.passingStream(["tail"])
        run.feed(Array(stream.dropLast()))
        run.feedBytes(Data(stream.last!.utf8))
        run.exit(0)
        run.stdoutEOF()
        run.cleared()
        #expect(run.terminal == .terminal(.completed, groupCleared: true))
    }

    @Test("Timeouts: init 30 s, no output 120 s, total 15 min")
    func timeouts() {
        var noInit = ReaderHarness()
        noInit.spawned()
        noInit.advance(29_999)
        #expect(!noInit.sentStop)
        noInit.advance(1)
        #expect(noInit.sentStop)
        noInit.ends(SIGTERM)
        #expect(noInit.terminal == .terminal(.failed(.timeout), groupCleared: true))

        var quiet = ReaderHarness()
        quiet.spawned()
        quiet.feed([Invented.initLine(), Invented.rateLimit()])
        quiet.advance(119_999)
        #expect(!quiet.sentStop)
        quiet.advance(1)
        #expect(quiet.sentStop)

        var long = ReaderHarness()
        long.spawned()
        long.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0)])
        for _ in 0..<14 {
            long.advance(60_000)
            long.feed([Invented.textDelta(".")])
        }
        #expect(!long.sentStop)
        long.advance(60_000)
        #expect(long.sentStop)
        long.ends(SIGTERM)
        #expect(long.terminal == .terminal(.failed(.timeout), groupCleared: true))
        #expect(long.texts.joined() == String(repeating: ".", count: 14))
    }

    @Test("stderr maps to fixed reasons; at most 64 KiB is kept and none reaches an output")
    func stderrReasons() {
        #expect(StderrReason.classify([]) == .none)
        #expect(StderrReason.classify(Array("Invented: Not logged in. Please run /login".utf8)) == .signedOut)
        #expect(StderrReason.classify(Array("invented 429 usage limit".utf8)) == .rateLimited)
        #expect(StderrReason.classify(Array("getaddrinfo ENOTFOUND invented.invalid".utf8)) == .network)
        #expect(StderrReason.classify(Array("invented other trouble".utf8)) == .unrecognized)

        var run = ReaderHarness()
        run.spawned()
        run.reader.consumeStderr(Data(repeating: 0x41, count: 70_000))
        run.reader.consumeStderr(Data("not logged in".utf8))
        #expect(run.reader.stderrBytes == 70_013)
        #expect(run.reader.stderrReason == .unrecognized, "text past 64 KiB is dropped unread")
        run.feed(Invented.passingStream(["reply"]))
        run.ends(0)
        #expect(run.texts == ["reply"])
    }

    @Test("Exactly one terminal, whatever arrives after it")
    func oneTerminal() {
        var run = ReaderHarness()
        run.spawned()
        run.feed(Invented.passingStream(["one"]))
        run.ends(0)
        run.stop()
        run.feed(Invented.passingStream(["two"]))
        run.exit(256)
        run.uncleared()
        run.cleared()
        run.controlClosed()
        run.advance(1_000_000)
        #expect(run.terminals.count == 1)
        #expect(run.texts == ["one"])
        #expect(run.startedCount == 1)
    }
}

@Suite("Stream reader: a cleanup retry that ends uncleared")
struct StreamJSONReaderRetryTests {
    @Test("After an uncleared terminal, each further uncleared is one cleanupRetryUncleared; the first is the terminal itself")
    func retryUncleared() {
        var run = ReaderHarness()
        run.spawned()
        run.feed([Invented.initLine()])
        run.stop()
        run.exit(SIGTERM)
        run.uncleared()
        #expect(run.terminal == .terminal(.stopped(.stopIncomplete), groupCleared: false))
        #expect(!run.outputs.contains(.cleanupRetryUncleared), "the first uncleared ends the run; it is not a retry")

        let before = run.outputs.count
        run.stop()
        #expect(run.outputs.count == before, "the retry's stop records nothing in the reader")
        run.uncleared()
        #expect(run.outputs.suffix(1) == [.cleanupRetryUncleared])
        run.advance(60_000)
        #expect(run.outputs.count == before + 1, "time alone reports nothing")
        run.stop()
        run.uncleared()
        #expect(run.outputs.filter { $0 == .cleanupRetryUncleared }.count == 2, "one per retry")
        #expect(run.reader.groupCleared == false)
        #expect(!run.released)

        run.cleared()
        #expect(run.outputs.suffix(2) == [.groupClearedAfterTerminal, .cleanupReleased])
        run.uncleared()
        #expect(run.outputs.filter { $0 == .cleanupRetryUncleared }.count == 2, "nothing once the group is cleared")
        #expect(run.terminals.count == 1)
        #expect(run.reader.groupCleared == true)
    }

    @Test("A native end whose group survives retries the same way")
    func nativeEndRetry() {
        var run = ReaderHarness()
        run.spawned()
        run.feed([Invented.initLine()])
        run.uncleared()
        #expect(run.terminal == .terminal(.failed(.processError), groupCleared: false))
        run.uncleared()
        #expect(run.outputs.filter { $0 == .cleanupRetryUncleared }.count == 1)
        #expect(run.terminals.count == 1)
    }

    @Test("Never after a cleared terminal, a spawn failure or a lost supervisor")
    func noRetryOtherwise() {
        var cleared = ReaderHarness()
        cleared.spawned()
        cleared.feed(Invented.passingStream(["done"]))
        cleared.ends(0)
        cleared.uncleared()
        cleared.uncleared()
        #expect(!cleared.outputs.contains(.cleanupRetryUncleared))
        #expect(cleared.terminal == .terminal(.completed, groupCleared: true))

        var failed = ReaderHarness()
        failed.outputs += failed.reader.supervisor(.spawnFailed, now: 0)
        failed.uncleared()
        failed.uncleared()
        #expect(!failed.outputs.contains(.cleanupRetryUncleared))
        #expect(failed.terminals.count == 1)

        var lost = ReaderHarness()
        lost.spawned()
        lost.feed([Invented.initLine()])
        lost.controlClosed()
        lost.uncleared()
        lost.uncleared()
        #expect(!lost.outputs.contains(.cleanupRetryUncleared))
        #expect(lost.terminal == .terminal(.failed(.processError), groupCleared: false))
    }

    @Test("A supervisor lost after an uncleared terminal answers a waiting retry: cleanupRetryUncleared while a pipe is open, else only cleanupReleased")
    func lostAfterUnclearedTerminal() {
        // The retry's probe is cut short: the control socket closes while a
        // surviving member still holds stdout open.
        var open = ReaderHarness()
        open.spawned()
        open.feed([Invented.initLine()])
        open.stop()
        open.exit(SIGTERM)
        open.uncleared()
        #expect(open.terminal == .terminal(.stopped(.stopIncomplete), groupCleared: false))
        open.stop()
        open.stderrEOF()
        let before = open.outputs.count
        open.controlClosed()
        #expect(Array(open.outputs.dropFirst(before)) == [.cleanupRetryUncleared])
        #expect(open.reader.supervisorLost)
        #expect(open.reader.groupCleared == false)
        #expect(!open.released)
        open.uncleared()
        open.cleared()
        #expect(open.outputs.count == before + 1, "nothing can follow from a closed socket")
        open.stdoutEOF()
        #expect(open.outputs.suffix(1) == [.cleanupReleased])
        #expect(open.reader.groupCleared == false, "never later set true")
        #expect(open.terminals.count == 1)

        // Both pipes already at EOF: ownership ends at once, and that answers.
        var closed = ReaderHarness()
        closed.spawned()
        closed.feed([Invented.initLine()])
        closed.uncleared()
        #expect(closed.terminal == .terminal(.failed(.processError), groupCleared: false))
        closed.stdoutEOF()
        closed.stderrEOF()
        let settled = closed.outputs.count
        closed.controlClosed()
        #expect(Array(closed.outputs.dropFirst(settled)) == [.cleanupReleased])
        #expect(closed.reader.groupCleared == false)
    }
}
