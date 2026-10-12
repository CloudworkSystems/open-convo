import AppKit
@testable import DeskWindowKit
import Foundation
import XCTest

/// Quitting: no Desk, no wait; an open Desk closes first, at most three
/// seconds, and the app always gets exactly one yes.
@MainActor
final class DeskTerminationTests: XCTestCase {
    func testNoSessionTerminatesNow() throws {
        var replies: [Bool] = []
        let answer = DeskTermination.reply(sessionIsOpen: false, close: { XCTFail("nothing to close") }, replyToApplication: { replies.append($0) })
        XCTAssertEqual(answer, .terminateNow)
        XCTAssertEqual(DeskTermination.reply(for: nil), .terminateNow)
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let neverOpened = makeSession(folder, bundle: try folder.fixtureBundle())
        XCTAssertEqual(DeskTermination.reply(for: neverOpened), .terminateNow)
        XCTAssertEqual(replies, [])
        XCTAssertEqual(DeskTermination.closeTimeout, 3)
    }

    func testOpenSessionRepliesTrueAfterClose() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let session = makeSession(folder, bundle: try anyDeskBundle(folder))
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertTrue(session.hasStack)
        let host = try XCTUnwrap(session.host)
        var replies: [Bool] = []
        let started = Date()
        let answer = DeskTermination.reply(sessionIsOpen: session.hasStack, close: { await session.close() }, timeout: 0.5,
                                           replyToApplication: { replies.append($0) })
        XCTAssertEqual(answer, .terminateLater)
        try await waitUntil("the reply", timeout: 5) { !replies.isEmpty }
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
        XCTAssertEqual(session.state, .closed)
        XCTAssertTrue(host.isClosed)
        try await Task.sleep(nanoseconds: 800_000_000)
        XCTAssertEqual(replies, [true], "exactly one yes")
    }

    func testStuckCloseStillRepliesAfterThreeSeconds() async throws {
        var replies: [Bool] = []
        var stuck: CheckedContinuation<Void, Never>?
        let started = Date()
        let answer = DeskTermination.reply(sessionIsOpen: true, close: { await withCheckedContinuation { stuck = $0 } },
                                           replyToApplication: { replies.append($0) })
        XCTAssertEqual(answer, .terminateLater)
        try await Task.sleep(nanoseconds: 2_500_000_000)
        XCTAssertEqual(replies, [], "still waiting for the Desk")
        try await waitUntil("the timeout reply", timeout: 3) { !replies.isEmpty }
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertGreaterThanOrEqual(elapsed, 3)
        XCTAssertLessThan(elapsed, 4.5)
        stuck?.resume()
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(replies, [true], "exactly one yes")
    }

    /// Review finding LC-1: should `NSApp.terminate` ever be called from a
    /// main-queue job, it waits for the reply in a nested run loop that runs
    /// no main-actor task. The time limit must still fire there.
    func testTimeLimitRepliesEvenInsideABusyMainQueueJob() async throws {
        var replies: [Bool] = []
        var repliedInsideTheJob = false
        var stuck: CheckedContinuation<Void, Never>?
        let done = expectation(description: "the main-queue job ended")
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                let answer = DeskTermination.reply(sessionIsOpen: true, close: { await withCheckedContinuation { stuck = $0 } },
                                                   timeout: 0.3, replyToApplication: { replies.append($0) })
                XCTAssertEqual(answer, .terminateLater)
                // Stands in for terminate's wait for the reply.
                spinNestedRunLoop(upTo: 3) { !replies.isEmpty }
                repliedInsideTheJob = !replies.isEmpty
                done.fulfill()
            }
        }
        await fulfillment(of: [done], timeout: 10)
        XCTAssertTrue(repliedInsideTheJob, "the time limit fired inside terminate's wait")
        XCTAssertEqual(replies, [true])
        try await Task.sleep(nanoseconds: 100_000_000)
        stuck?.resume()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(replies, [true], "exactly one yes")
    }

    /// Review findings LC-1 and LC-2: Quit with an open Desk asks, and
    /// quits, outside any main-actor task. Main-actor work keeps running in
    /// the question's modal loop and in terminate's wait, so the Desk closes
    /// before the reply instead of the app hanging.
    func testQuitAsksAndQuitsOutsideAnyTask() async throws {
        _ = NSApplication.shared
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let session = makeSession(folder, bundle: try anyDeskBundle(folder))
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let host = try XCTUnwrap(session.host)
        session.unsavedWorkCheck = { .unsaved }
        var taskRanDuringQuestion = false
        var replies: [Bool] = []
        var stateAtReply: DeskSession.State?
        var finished = false
        DeskTermination.quitAfterAsking(session: session, confirmLosingChanges: { _ in
            // Stands in for the alert's runModal. A lock signal or any other
            // main-actor task can arrive while it is up.
            var ran = false
            Task { @MainActor in ran = true }
            spinNestedRunLoop(upTo: 2) { ran }
            taskRanDuringQuestion = ran
            return true
        }, kept: { _ in
            XCTFail("the question was answered Quit and Lose Changes")
        }, quit: {
            // Stands in for NSApp.terminate: the app's should-terminate
            // answer, then terminate's wait for the reply.
            let answer = DeskTermination.reply(sessionIsOpen: session.hasStack, close: { await session.close() },
                                               replyToApplication: { replies.append($0); stateAtReply = session.state })
            XCTAssertEqual(answer, .terminateLater)
            spinNestedRunLoop(upTo: 5) { !replies.isEmpty }
            finished = true
        })
        try await waitUntil("the quit to finish", timeout: 20) { finished }
        XCTAssertTrue(taskRanDuringQuestion, "main-actor work ran while the question was up")
        XCTAssertEqual(replies, [true])
        XCTAssertEqual(stateAtReply, .closed, "the Desk closed before the reply")
        XCTAssertTrue(host.isClosed)
    }

    /// Keep on the question leaves the Desk open and the app running; no
    /// unsaved work quits without asking.
    func testQuitKeepsOnKeepAndSkipsTheQuestionWithoutUnsavedWork() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let session = makeSession(folder, bundle: try anyDeskBundle(folder))
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        var events: [String] = []
        session.unsavedWorkCheck = { .unsaved }
        DeskTermination.quitAfterAsking(session: session, confirmLosingChanges: { events.append("asked \($0.logName)"); return false },
                                        kept: { events.append("kept \($0.logName)") }, quit: { events.append("quit") })
        try await waitUntil("the answer") { events.count == 2 }
        XCTAssertEqual(events, ["asked unsaved-work", "kept unsaved-work"])
        XCTAssertEqual(session.state, .open)

        events.removeAll()
        session.unsavedWorkCheck = { nil }
        DeskTermination.quitAfterAsking(session: session, confirmLosingChanges: { events.append("asked \($0.logName)"); return true },
                                        kept: { events.append("kept \($0.logName)") }, quit: { events.append("quit") })
        try await waitUntil("the quit") { !events.isEmpty }
        XCTAssertEqual(events, ["quit"])
        await session.close()
    }

    /// Codex W4, Quit's side: a page that cannot answer is asked about,
    /// with the reason, never quit over silently. Keep keeps the Desk
    /// open; Quit Anyway quits.
    func testQuitAsksWhenThePageCannotAnswer() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let session = makeSession(folder, bundle: try anyDeskBundle(folder))
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        var events: [String] = []
        session.unsavedWorkCheck = { .noAnswer }
        DeskTermination.quitAfterAsking(session: session, confirmLosingChanges: { events.append("asked \($0.logName)"); return false },
                                        kept: { events.append("kept \($0.logName)") }, quit: { events.append("quit") })
        try await waitUntil("the answer") { events.count == 2 }
        XCTAssertEqual(events, ["asked no-answer", "kept no-answer"])
        XCTAssertEqual(session.state, .open)

        events.removeAll()
        DeskTermination.quitAfterAsking(session: session, confirmLosingChanges: { events.append("asked \($0.logName)"); return true },
                                        kept: { events.append("kept \($0.logName)") }, quit: { events.append("quit") })
        try await waitUntil("the quit") { events.count == 2 }
        XCTAssertEqual(events, ["asked no-answer", "quit"])
        await session.close()
    }

    /// A quit the person did not start from the menu (logout, restart):
    /// nobody is asked, even when the page cannot answer or holds unsaved
    /// work; the Desk closes, the app gets its one yes, and the log says
    /// what the page answered (identifiers only).
    func testSystemQuitNeverAsksAndLogsWhatThePageSaid() async throws {
        for answer in [DeskUnsavedWork.noAnswer, .unsaved] {
            let folder = try DeskTestFolder()
            defer { folder.clean() }
            let logs = DeskLogCollector()
            let session = makeSession(folder, bundle: try anyDeskBundle(folder), logs: logs)
            await session.unlock(verifier: StubUnlockVerifier(.verified))
            session.unsavedWorkCheck = { answer }
            var replies: [Bool] = []
            let reply = DeskTermination.reply(for: session, replyToApplication: { replies.append($0) })
            XCTAssertEqual(reply, .terminateLater)
            try await waitUntil("the reply", timeout: 5) { !replies.isEmpty }
            XCTAssertEqual(replies, [true])
            XCTAssertEqual(session.state, .closed)
            XCTAssertTrue(logs.all.contains("desk.terminate.not-asked page=\(answer.logName)"), "\(logs.all)")
            XCTAssertFalse(logs.all.contains { $0.hasPrefix("desk.terminate.cap-reached") }, "closed within the limit")
        }
    }

    /// A page that has not answered when the time limit comes: the app
    /// still quits on time, without a question, and the log says the page
    /// gave no answer.
    func testSystemQuitCapReachedWhileThePageCannotAnswerStillQuitsAndLogs() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let logs = DeskLogCollector()
        let session = makeSession(folder, bundle: try anyDeskBundle(folder), logs: logs)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        var stuck: CheckedContinuation<DeskUnsavedWork?, Never>?
        session.unsavedWorkCheck = { await withCheckedContinuation { stuck = $0 } }
        var replies: [Bool] = []
        let started = Date()
        let reply = DeskTermination.reply(for: session, timeout: 0.3, replyToApplication: { replies.append($0) })
        XCTAssertEqual(reply, .terminateLater)
        try await waitUntil("the time limit's reply", timeout: 5) { !replies.isEmpty }
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
        XCTAssertEqual(replies, [true])
        XCTAssertEqual(logs.all.filter { $0.hasPrefix("desk.terminate.") }, ["desk.terminate.cap-reached limit=0.3s page=no-answer"])
        stuck?.resume(returning: .noAnswer)
        try await waitUntil("the close to finish") { session.state == .closed }
        XCTAssertEqual(replies, [true], "exactly one yes")
    }

    /// After the menu's Quit asked (or found nothing to ask), the
    /// termination that follows does not ask the page again.
    func testTerminationAfterTheMenusQuitDoesNotAskThePageAgain() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let logs = DeskLogCollector()
        let session = makeSession(folder, bundle: try anyDeskBundle(folder), logs: logs)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        var checks = 0
        session.unsavedWorkCheck = { checks += 1; return .noAnswer }
        var replies: [Bool] = []
        let reply = DeskTermination.reply(for: session, pageAlreadyAsked: true, replyToApplication: { replies.append($0) })
        XCTAssertEqual(reply, .terminateLater)
        try await waitUntil("the reply", timeout: 5) { !replies.isEmpty }
        XCTAssertEqual(replies, [true])
        XCTAssertEqual(checks, 0)
        XCTAssertEqual(session.state, .closed)
        XCTAssertFalse(logs.all.contains { $0.hasPrefix("desk.terminate.") }, "\(logs.all)")
    }
}
