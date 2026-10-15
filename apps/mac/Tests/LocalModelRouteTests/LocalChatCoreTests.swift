import XCTest
import ParticipantProcess
@testable import LocalModelRoute

final class LocalChatCoreTests: XCTestCase {
    private let identity = ParticipantRunIdentity(runId: "71abcdef-0000-4000-8abc-000000000001",
                                                  sessionId: "52abcdef-0000-4000-8abc-000000000001",
                                                  createdAtMillis: 1_760_500_000_000)
    private let wall: Int64 = 1_760_500_000_000

    private func core(context: Int = 0, input: Int = 10, limits: LocalChatLimits = .contract) -> LocalChatCore {
        var core = LocalChatCore(identity: identity, contextBytes: context, inputBytes: input, limits: limits)
        core.requestSent(monotonic: 0)
        return core
    }

    private func events(_ effects: [LocalChatCore.Effect]) -> [ParticipantEvent] {
        effects.compactMap {
            switch $0 {
            case .update(.event(let event)), .update(.terminal(let event, _)): return event
            default: return nil
            }
        }
    }

    private func bytes(_ data: Data) -> [UInt8] { [UInt8](data) }

    func testHappyPathStartsStreamsCoalescesAndCompletes() {
        var run = core()
        var all = run.response(status: 200, monotonic: 10, wall: wall)
        all += run.bytes(bytes(Invented.chunk("Invented ") + Invented.chunk("bakery")), monotonic: 20, wall: wall)
        XCTAssertEqual(events(all).map(\.type), [.started], "text waits for coalescing")
        all += run.tick(monotonic: 300, wall: wall + 300)
        all += run.bytes(bytes(Invented.chunk(" plan.") + Invented.done), monotonic: 400, wall: wall + 400)
        let list = events(all)
        XCTAssertEqual(list.map(\.type), [.started, .text, .text, .completed])
        XCTAssertEqual(list.map(\.sequence), [1, 2, 3, 4])
        XCTAssertEqual(list.compactMap(\.text).joined(), "Invented bakery plan.")
        XCTAssertEqual(all.last, .cancelRequest, "done cancels the request so nothing holds the run open")
        XCTAssertEqual(run.snapshot.groupCleared, true)
        XCTAssertEqual(run.snapshot.cleanup, .released)
        XCTAssertEqual(run.finished(.closed, monotonic: 500, wall: wall), [], "nothing after the terminal")
    }

    func testTextIsCutIntoEventsOfAtMost16KiBBetweenScalars() {
        var run = core(input: 1)
        _ = run.response(status: 200, monotonic: 0, wall: wall)
        let text = String(repeating: "😀", count: 5_000) // 20,000 bytes, 4 each
        let list = events(run.bytes(bytes(Invented.chunk(text) + Invented.done), monotonic: 1, wall: wall))
        let texts = list.compactMap(\.text)
        XCTAssertEqual(texts.joined(), text)
        XCTAssertTrue(texts.allSatisfy { $0.utf8.count <= 16_384 && !$0.isEmpty })
        XCTAssertEqual(list.last?.type, .completed)
    }

    func testANonOKStatusFailsBeforeStartingAndCancels() {
        var run = core()
        let effects = run.response(status: 404, monotonic: 5, wall: wall)
        XCTAssertEqual(events(effects).map { "\($0.sequence) \($0.type.rawValue) \($0.reason ?? "")" }, ["1 failed process-error"])
        XCTAssertTrue(effects.contains(.cancelRequest))
    }

    func testErrorLinesMalformedLinesAndMissingDoneAreProcessErrors() {
        for body in [Invented.line(["error": "invented failure"]), Data("not json\n".utf8),
                     Invented.line(["message": ["role": "assistant", "content": 7], "done": false])] {
            var run = core()
            _ = run.response(status: 200, monotonic: 0, wall: wall)
            let effects = run.bytes(bytes(body), monotonic: 1, wall: wall)
            XCTAssertEqual(events(effects).last?.reason, "process-error")
            XCTAssertTrue(effects.contains(.cancelRequest))
        }
        var run = core()
        _ = run.response(status: 200, monotonic: 0, wall: wall)
        _ = run.bytes(bytes(Invented.chunk("half a reply")), monotonic: 1, wall: wall)
        let list = events(run.finished(.closed, monotonic: 2, wall: wall))
        XCTAssertEqual(list.map(\.type), [.text, .failed], "accepted text first, then the failure")
        XCTAssertEqual(list.last?.reason, "process-error")
    }

    func testARefusedRedirectAndADroppedConnectionFail() {
        for how in [LocalChatFinish.redirectRefused, .failed] {
            var run = core()
            XCTAssertEqual(events(run.finished(how, monotonic: 1, wall: wall)).map(\.reason), ["process-error"])
        }
    }

    func testALastLineWithoutItsNewlineStillCounts() {
        var run = core()
        _ = run.response(status: 200, monotonic: 0, wall: wall)
        var done = Invented.done
        done.removeLast()
        _ = run.bytes(bytes(Invented.chunk("ok") + done), monotonic: 1, wall: wall)
        XCTAssertEqual(events(run.finished(.closed, monotonic: 2, wall: wall)).map(\.type), [.text, .completed])
    }

    func testStopSendsAcceptedTextThenStoppedAndCancels() {
        var run = core()
        _ = run.response(status: 200, monotonic: 0, wall: wall)
        _ = run.bytes(bytes(Invented.chunk("partial")), monotonic: 1, wall: wall)
        let effects = run.stopRequested(monotonic: 2, wall: wall)
        XCTAssertEqual(events(effects).map(\.type), [.text, .stopped])
        XCTAssertEqual(events(effects).last?.reason, "local-stop")
        XCTAssertEqual(effects.last, .cancelRequest)
        XCTAssertEqual(run.stopRequested(monotonic: 3, wall: wall), [])
    }

    func testStopBeforeAnyResponseIsStoppedAtSequenceOne() {
        var run = core()
        let list = events(run.stopRequested(monotonic: 1, wall: wall))
        XCTAssertEqual(list.map { "\($0.sequence) \($0.type.rawValue)" }, ["1 stopped"])
    }

    /// Codex round 4 on #38: context, input and output share one bound.
    func testTheReplyBudgetCountsContextAndInput() {
        var limits = LocalChatLimits()
        limits.maxContextInputOutputBytes = 100
        var run = core(context: 60, input: 30, limits: limits)
        _ = run.response(status: 200, monotonic: 0, wall: wall)
        var effects = run.bytes(bytes(Invented.chunk("1234567890")), monotonic: 1, wall: wall)
        XCTAssertFalse(effects.contains(.cancelRequest), "exactly the 10 bytes left")
        effects = run.bytes(bytes(Invented.chunk("x")), monotonic: 2, wall: wall)
        let list = events(effects)
        XCTAssertEqual(list.map(\.type), [.text, .failed])
        XCTAssertEqual(list.first?.text, "1234567890")
        XCTAssertEqual(list.last?.reason, "reply-too-long")
        XCTAssertTrue(effects.contains(.cancelRequest))
    }

    func testTimeouts() {
        // No first byte within 30 s.
        var run = core()
        XCTAssertEqual(run.nextDeadline(), 30_000)
        XCTAssertEqual(run.tick(monotonic: 29_999, wall: wall), [])
        XCTAssertEqual(events(run.tick(monotonic: 30_000, wall: wall)).map(\.reason), ["timeout"])
        // No output for 120 s.
        run = core()
        _ = run.response(status: 200, monotonic: 1_000, wall: wall)
        _ = run.bytes(bytes(Invented.chunk("a")), monotonic: 2_000, wall: wall)
        _ = run.tick(monotonic: 2_250, wall: wall)
        XCTAssertEqual(run.tick(monotonic: 121_999, wall: wall), [])
        XCTAssertEqual(events(run.tick(monotonic: 122_000, wall: wall)).map(\.reason), ["timeout"])
        // Fifteen minutes in all, even while text keeps coming.
        run = core()
        _ = run.response(status: 200, monotonic: 0, wall: wall)
        var now: UInt64 = 0
        while now < 900_000 {
            now += 60_000
            _ = run.bytes(bytes(Invented.chunk("a")), monotonic: now, wall: wall)
            _ = run.tick(monotonic: now + 250, wall: wall)
        }
        XCTAssertTrue(run.isFinished)
        XCTAssertEqual(run.snapshot.terminal?.reason, "timeout")
    }

    func testAnOverlongLineFails() {
        var limits = LocalChatLimits()
        limits.maxLineBytes = 64
        var run = core(limits: limits)
        _ = run.response(status: 200, monotonic: 0, wall: wall)
        let effects = run.bytes([UInt8](repeating: 0x61, count: 65), monotonic: 1, wall: wall)
        XCTAssertEqual(events(effects).last?.reason, "process-error")
    }

    func testEventTimesNeverGoBackwards() {
        var run = core()
        _ = run.response(status: 200, monotonic: 0, wall: wall + 5_000)
        let list = events(run.bytes(bytes(Invented.chunk("a") + Invented.done), monotonic: 1, wall: wall + 1_000))
        XCTAssertEqual(Set(list.map(\.at)).count, 1, "an earlier wall clock reuses the previous time")
    }

    /// Codex round 1 on #42: the part of a delta that fits is kept, cut
    /// between scalars, before `reply-too-long`.
    func testAnOversizedDeltaKeepsItsFittingPrefix() {
        var limits = LocalChatLimits()
        limits.maxContextInputOutputBytes = 20
        var run = core(context: 0, input: 10, limits: limits)
        _ = run.response(status: 200, monotonic: 0, wall: wall)
        let list = events(run.bytes(bytes(Invented.chunk("abcdefgh😀z")), monotonic: 1, wall: wall))
        XCTAssertEqual(list.map(\.type), [.text, .failed])
        XCTAssertEqual(list.first?.text, "abcdefgh", "the emoji would cross the 10-byte budget")
        XCTAssertEqual(list.last?.reason, "reply-too-long")
    }

    /// Codex round 1 on #42: a valid JSON line without Ollama's shape fails.
    func testLinesWithoutOllamasShapeFail() {
        for body in [Data("{}\n".utf8), Invented.line(["done": false]), Invented.line(["message": ["role": "assistant", "content": "x"]]),
                     Invented.line(["done": "true"]), Invented.line(["done": true, "message": "x"]),
                     Data("{\"done\":1}\n".utf8), Data("{\"done\":0,\"message\":{\"role\":\"assistant\",\"content\":\"x\"}}\n".utf8),
                     Data("\n".utf8), Data("   \n".utf8)] {
            var run = core()
            _ = run.response(status: 200, monotonic: 0, wall: wall)
            XCTAssertEqual(events(run.bytes(bytes(body), monotonic: 1, wall: wall)).last?.reason, "process-error",
                           String(decoding: body, as: UTF8.self))
        }
        var run = core()
        _ = run.response(status: 200, monotonic: 0, wall: wall)
        XCTAssertEqual(events(run.bytes(bytes(Invented.line(["done": true])), monotonic: 1, wall: wall)).last?.type, .completed,
                       "a done line may omit its message")
    }
}
