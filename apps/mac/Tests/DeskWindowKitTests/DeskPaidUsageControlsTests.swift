import AppKit
import DeskHost
@testable import DeskHostWebKit
@testable import DeskWindowKit
import Foundation
import WebKit
import XCTest

/// Section 17's controls as a plain fake (the owner itself is tested with
/// the participant modules): a state, answers for Check Claude and Confirm,
/// and counts. Confirm may be held until the test answers it.
@MainActor
final class FakePaidUsageControls: DeskPaidUsageControlling {
    var state: DeskPaidUsageState = .unconfirmed
    var isConfirming = false
    var onChange: (@MainActor () -> Void)?
    var checkAnswer: DeskClaudeCheck = .passed
    var confirmAnswer: DeskPaidUsageConfirmResult = .confirmed
    var holdConfirm = false
    private(set) var checks = 0
    private(set) var confirms = 0
    private(set) var abandons = 0
    private var pending: CheckedContinuation<DeskPaidUsageConfirmResult, Never>?

    func checkClaude() async -> DeskClaudeCheck {
        checks += 1
        return checkAnswer
    }

    func confirm() async -> DeskPaidUsageConfirmResult {
        confirms += 1
        isConfirming = true
        onChange?()
        let result: DeskPaidUsageConfirmResult
        if holdConfirm {
            result = await withCheckedContinuation { pending = $0 }
        } else {
            result = confirmAnswer
        }
        isConfirming = false
        if result == .confirmed { state = .active(confirmedAt: Date(timeIntervalSince1970: 1_791_000_000), runsLeft: 5) }
        onChange?()
        return result
    }

    func abandonPendingConfirmation() {
        abandons += 1
        pending?.resume(returning: .interrupted)
        pending = nil
    }

    var isHeld: Bool { pending != nil }
}

/// A task's value within `timeout`, else a test failure: never a hang.
@MainActor
func boundedValue<T: Sendable>(_ task: Task<T, Never>, _ what: String, timeout: TimeInterval = 30) async throws -> T {
    let box = TaskValueBox<T>()
    let watcher = Task { box.set(await task.value) }
    defer { watcher.cancel() }
    try await waitUntil(what, timeout: timeout) { box.value != nil }
    return box.value!.value
}

final class TaskValueBox<T: Sendable>: @unchecked Sendable {
    struct Held { let value: T }
    private let lock = NSLock()
    private var held: Held?

    func set(_ value: T) {
        lock.lock(); defer { lock.unlock() }
        held = Held(value: value)
    }

    var value: Held? {
        lock.lock(); defer { lock.unlock() }
        return held
    }
}

/// The statement sheet as a fake: answers as told, or waits until dismissed.
@MainActor
final class FakeStatement: DeskPaidUsageStatementPrompting {
    var answer: Bool?
    private(set) var asked = 0
    private(set) var dismissals = 0
    private var pending: CheckedContinuation<Bool, Never>?

    func ask(in window: NSWindow) async -> Bool {
        asked += 1
        if let answer { return answer }
        return await withCheckedContinuation { pending = $0 }
    }

    func dismiss() {
        dismissals += 1
        pending?.resume(returning: false)
        pending = nil
    }

    /// Answers the open statement, as a click on its button would.
    func answerWaiting(_ proceed: Bool) {
        pending?.resume(returning: proceed)
        pending = nil
    }

    var isWaiting: Bool { pending != nil }
}

/// The Desk window's section 17 controls (plan F4), offscreen and never
/// shown, over the invented one-page Desk (or the real one when
/// `TRUECONVO_DESK_BUNDLE` is set): nothing new without them; with them, the
/// state line, Check Claude before unlock, the statement before the request,
/// first responder after a confirmation, and a lock or close discarding a
/// pending request.
@MainActor
final class DeskPaidUsageControlsTests: XCTestCase {
    private var folder: DeskTestFolder!
    private var controller: DeskWindowController?

    override func setUp() async throws {
        _ = NSApplication.shared
        folder = try DeskTestFolder()
    }

    override func tearDown() async throws {
        if let controller {
            await controller.session.close()
            controller.window?.delegate = nil
        }
        controller = nil
        folder.clean()
    }

    private func make(_ controls: FakePaidUsageControls?, statement: FakeStatement? = nil) throws -> (DeskWindowController, DeskSession) {
        let session = makeSession(folder, bundle: try anyDeskBundle(folder))
        session.unsavedWorkCheck = { nil }
        let made = DeskWindowController(session: session, verifier: StubUnlockVerifier(.verified), prompt: FakePrompt(),
                                        paidUsage: controls, statement: statement)
        made.formatTime = { _ in "3:42 PM" }
        made.renderPaidUsage()
        controller = made
        return (made, session)
    }

    func testWithoutControlsTheWindowShowsNothingNew() throws {
        let (made, _) = try make(nil)
        XCTAssertNil(made.paidUsage)
        XCTAssertNil(made.statement)
        XCTAssertNil(made.paidUsageRow)
        XCTAssertNil(made.paidUsageLine.superview)
        XCTAssertNil(made.checkClaudeButton.superview)
        XCTAssertNil(made.confirmPaidUsageButton.superview)
        let column = try XCTUnwrap(made.window?.contentView?.subviews.first as? NSStackView)
        XCTAssertEqual(column.arrangedSubviews.count, 3, "the strip, the stopped banner and the page, as before")
    }

    func testStateLinesAndCheckClaudeBeforeUnlock() async throws {
        let controls = FakePaidUsageControls()
        let (made, session) = try make(controls)
        XCTAssertNotNil(made.paidUsageRow?.superview)
        XCTAssertEqual(session.state, .lockedNoStack)
        XCTAssertEqual(made.paidUsageLine.stringValue, "Paid usage: not yet confirmed in this launch.")
        XCTAssertTrue(made.checkClaudeButton.isEnabled, "Check Claude works before unlock")
        XCTAssertFalse(made.confirmPaidUsageButton.isEnabled, "Confirm needs the Desk open")

        for (answer, line) in [(DeskClaudeCheck.signedOut, "Claude Code is signed out."), (.passed, "Claude checks passed.")] {
            controls.checkAnswer = answer
            let checked = await made.checkClaude()
            XCTAssertEqual(checked, answer)
            XCTAssertEqual(made.paidUsageResult.stringValue, line)
            XCTAssertFalse(made.paidUsageResult.isHidden)
        }
        XCTAssertEqual(controls.checks, 2)
        XCTAssertNil(session.store, "no store was opened")

        controls.state = .active(confirmedAt: Date(), runsLeft: 3)
        controls.onChange?()
        XCTAssertEqual(made.paidUsageLine.stringValue,
                       "You confirmed paid usage was off at 3:42 PM. True Convo cannot see your billing setting. 3 runs left.")
        controls.state = .ended(.sleep)
        controls.onChange?()
        XCTAssertEqual(made.paidUsageLine.stringValue,
                       "Paid usage confirmation ended, the Mac or its screens slept. Send stays off until you confirm again.")
    }

    func testConfirmAsksTheStatementFirstAndCancelAsksNothing() async throws {
        let controls = FakePaidUsageControls()
        let statement = FakeStatement()
        let (made, session) = try make(controls, statement: statement)
        let answer1 = await made.confirmPaidUsage()
        XCTAssertNil(answer1, "nothing while the Desk is locked")
        XCTAssertEqual(statement.asked, 0)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(session.state, .open)
        XCTAssertTrue(made.confirmPaidUsageButton.isEnabled)

        statement.answer = false
        let answer2 = await made.confirmPaidUsage()
        XCTAssertNil(answer2)
        XCTAssertEqual(statement.asked, 1)
        XCTAssertEqual(controls.confirms, 0, "Cancel asks nothing")
        XCTAssertEqual(controls.state, .unconfirmed)

        statement.answer = true
        controls.confirmAnswer = .notAuthenticated
        let answer3 = await made.confirmPaidUsage()
        XCTAssertEqual(answer3, .notAuthenticated)
        XCTAssertEqual(made.paidUsageResult.stringValue,
                       "Not confirmed: confirming it's you was cancelled or did not succeed.")
        XCTAssertEqual(made.paidUsageLine.stringValue, "Paid usage: not yet confirmed in this launch.")

        controls.confirmAnswer = .confirmed
        let answer4 = await made.confirmPaidUsage()
        XCTAssertEqual(answer4, .confirmed)
        XCTAssertEqual(controls.confirms, 2)
        XCTAssertTrue(made.paidUsageLine.stringValue.hasPrefix("You confirmed paid usage was off at 3:42 PM."))
        XCTAssertFalse(made.confirmPaidUsageButton.isEnabled, "never over an active one")
    }

    func testAConfirmationMakesThePageFirstResponderEvenWhenItAlreadyWas() async throws {
        let controls = FakePaidUsageControls()
        let statement = FakeStatement()
        statement.answer = true
        let (made, session) = try make(controls, statement: statement)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let window = try XCTUnwrap(made.window)
        let webView = try XCTUnwrap(made.embeddedWebView)
        window.makeFirstResponder(made.confirmPaidUsageButton)
        XCTAssertFalse(window.firstResponder === webView)
        let answer5 = await made.confirmPaidUsage()
        XCTAssertEqual(answer5, .confirmed)
        XCTAssertTrue(window.firstResponder === webView, "the page is first responder after a confirmation")

        // Already first responder: it resigns now and becomes it again on a
        // later turn (one 100 ms step), so the page sees a blur, then a focus.
        let observer = FirstResponderLog(window)
        made.refreshPageAvailability()
        XCTAssertFalse(window.firstResponder === webView, "resigned at once")
        XCTAssertEqual(observer.changes, ["resigned"])
        await made.refocus?.value
        XCTAssertTrue(window.firstResponder === webView)
        XCTAssertEqual(observer.changes, ["resigned", "became"], "the focus comes again")

        // Something else taking the focus meanwhile keeps it; a lock cancels it.
        let other = AcceptingView(frame: NSRect(x: 0, y: 0, width: 10, height: 10))
        window.contentView?.addSubview(other)
        made.refreshPageAvailability()
        XCTAssertTrue(window.makeFirstResponder(other))
        let tookFocus = window.firstResponder
        await made.refocus?.value
        XCTAssertTrue(window.firstResponder === tookFocus, "never stolen back")
        window.makeFirstResponder(webView)
        made.refreshPageAvailability()
        session.lockNow(reason: .lockButton)
        await made.refocus?.value
        XCTAssertFalse(window.firstResponder === webView, "a locked Desk is not focused again")
        await session.unlock(verifier: StubUnlockVerifier(.verified))

        // Anything but a confirmation or an end leaves the focus where it was.
        controls.state = .unconfirmed
        controls.onChange?()   // the window sees the end (and refreshes the page)
        await made.refocus?.value
        window.makeFirstResponder(made.checkClaudeButton)
        controls.confirmAnswer = .interrupted
        let answer6 = await made.confirmPaidUsage()
        XCTAssertEqual(answer6, .interrupted)
        XCTAssertFalse(window.firstResponder === webView)
    }

    func testALockOrCloseDismissesTheStatementAndDiscardsAPendingRequest() async throws {
        let controls = FakePaidUsageControls()
        let statement = FakeStatement()
        let (made, session) = try make(controls, statement: statement)
        await session.unlock(verifier: StubUnlockVerifier(.verified))

        let asking = Task { await made.confirmPaidUsage() }
        try await waitUntil("the statement to be open") { statement.isWaiting }
        XCTAssertFalse(made.confirmPaidUsageButton.isEnabled)
        await session.lock(reason: .lockButton)
        let answer7 = try await boundedValue(asking, "the statement's answer")
        XCTAssertNil(answer7, "a lock answers the statement Cancel")
        XCTAssertEqual(controls.confirms, 0)

        await session.unlock(verifier: StubUnlockVerifier(.verified))
        statement.answer = true
        controls.holdConfirm = true
        let confirming = Task { await made.confirmPaidUsage() }
        try await waitUntil("the request to be pending") { controls.isHeld }
        XCTAssertEqual(made.paidUsageResult.stringValue, DeskPaidUsageWording.confirming)
        let abandonsBefore = controls.abandons
        session.lockNow(reason: .screenLocked)
        let answer8 = try await boundedValue(confirming, "the abandoned request's answer")
        XCTAssertEqual(answer8, .interrupted)
        XCTAssertGreaterThan(controls.abandons, abandonsBefore)
        XCTAssertEqual(made.paidUsageResult.stringValue,
                       "Not confirmed: something changed before it finished (a lock, sleep, the window closing, "
                       + "or a change to Claude Code or its login). Try again.")
        XCTAssertNil(made.window?.firstResponder as? WKWebView)

        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let again = Task { await made.confirmPaidUsage() }
        try await waitUntil("the request to be pending again") { controls.isHeld }
        await made.closeAfterAsking()
        let answer9 = try await boundedValue(again, "the closed window's answer")
        XCTAssertEqual(answer9, .interrupted, "a window close discards it too")
        XCTAssertEqual(session.state, .closed)
    }

    /// Codex F4-6: an end while the Desk is open refreshes the page as a
    /// confirmation does, so Send and the native line agree; a change that
    /// is not an end leaves the focus alone. Paid overflow says stop and
    /// review (Codex F0 answer 8).
    func testAnEndWhileTheDeskIsOpenMakesThePageReadAgain() async throws {
        let controls = FakePaidUsageControls()
        let statement = FakeStatement()
        statement.answer = true
        let (made, session) = try make(controls, statement: statement)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let window = try XCTUnwrap(made.window)
        let webView = try XCTUnwrap(made.embeddedWebView)
        let confirmed = await made.confirmPaidUsage()
        XCTAssertEqual(confirmed, .confirmed)

        let other = AcceptingView(frame: NSRect(x: 0, y: 0, width: 10, height: 10))
        window.contentView?.addSubview(other)
        await made.refocus?.value
        XCTAssertTrue(window.makeFirstResponder(other))
        XCTAssertFalse(window.firstResponder === webView)
        controls.state = .ended(.loginChanged)
        controls.onChange?()
        XCTAssertTrue(window.firstResponder === webView, "an end makes the page read availability again")
        XCTAssertEqual(made.paidUsageLine.stringValue,
                       "Paid usage confirmation ended, the Claude login or account changed. Send stays off until you confirm again.")
        XCTAssertTrue(made.confirmPaidUsageButton.isEnabled)

        XCTAssertTrue(window.makeFirstResponder(other))
        controls.onChange?()
        XCTAssertFalse(window.firstResponder === webView, "no end, no refresh")

        controls.state = .ended(.paidOverflow)
        controls.onChange?()
        XCTAssertEqual(made.paidUsageLine.stringValue,
                       "Paid usage confirmation ended, paid usage may have been used. Send stays off. "
                       + "Check claude.ai Settings > Usage; the trial needs review before you confirm again.")
    }

    /// Codex F4-2: Confirm stays off from the press to the attempt's result,
    /// the statement and the owner's attempt alike.
    func testConfirmStaysOffThroughTheWholeFlow() async throws {
        let controls = FakePaidUsageControls()
        let statement = FakeStatement()
        let (made, session) = try make(controls, statement: statement)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertTrue(made.confirmPaidUsageButton.isEnabled)
        let flow = Task { await made.confirmPaidUsage() }
        try await waitUntil("the statement to be open") { statement.isWaiting }
        XCTAssertFalse(made.confirmPaidUsageButton.isEnabled, "while the statement is open")
        controls.holdConfirm = true
        statement.answerWaiting(true)
        try await waitUntil("the request to be pending") { controls.isHeld }
        XCTAssertFalse(made.confirmPaidUsageButton.isEnabled, "while the attempt runs")
        let second = await made.confirmPaidUsage()
        XCTAssertNil(second, "a second press does nothing")
        XCTAssertEqual(made.paidUsageResult.stringValue, DeskPaidUsageWording.confirming, "the first attempt's line stays")
        controls.abandonPendingConfirmation()
        let answer = try await boundedValue(flow, "the flow's answer")
        XCTAssertEqual(answer, .interrupted)
        XCTAssertTrue(made.confirmPaidUsageButton.isEnabled, "on again once it ended")
    }
}

/// A view that takes the focus.
final class AcceptingView: NSView {
    override var acceptsFirstResponder: Bool { true }
}

/// Records first-responder changes of one window's web view.
@MainActor
final class FirstResponderLog: NSObject {
    private(set) var changes: [String] = []
    private var token: NSKeyValueObservation?

    init(_ window: NSWindow) {
        super.init()
        var last = window.firstResponder
        token = window.observe(\.firstResponder, options: [.new]) { [weak self] window, _ in
            MainActor.assumeIsolated {
                let now = window.firstResponder
                if last is WKWebView, !(now is WKWebView) { self?.changes.append("resigned") }
                if now is WKWebView, !(last is WKWebView) { self?.changes.append("became") }
                last = now
            }
        }
    }
}
