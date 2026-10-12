import AppKit
import DeskHost
@testable import DeskHostWebKit
@testable import DeskWindowKit
import Foundation
import WebKit
import XCTest

/// Answers the unsaved-work question as told, or waits until dismissed.
@MainActor
final class FakePrompt: DeskUnsavedWorkPrompting {
    var answer: Bool?
    private(set) var asked: [DeskUnsavedWorkQuestion] = []
    private(set) var reasons: [DeskUnsavedWork] = []
    private(set) var dismissals = 0
    private var pending: CheckedContinuation<Bool, Never>?

    var isWaiting: Bool { pending != nil }

    func ask(_ question: DeskUnsavedWorkQuestion, reason: DeskUnsavedWork, in window: NSWindow) async -> Bool {
        asked.append(question)
        reasons.append(reason)
        if let answer { return answer }
        return await withCheckedContinuation { pending = $0 }
    }

    func dismissAsKeep() {
        dismissals += 1
        pending?.resume(returning: false)
        pending = nil
    }
}

/// The Desk window, offscreen and never shown: closing asks first when the
/// page holds unsaved work, a lock answers an open question as Keep, and
/// the focus test counts only the Desk window. Uses the invented one-page
/// Desk (or the real one when `TRUECONVO_DESK_BUNDLE` is set); unsaved work
/// is stood in for by the session's seam.
@MainActor
final class DeskWindowControllerTests: XCTestCase {
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

    private func openController(unsaved: DeskUnsavedWork?, prompt: FakePrompt) async throws -> (DeskWindowController, DeskSession, DeskWebViewHost) {
        let session = makeSession(folder, bundle: try anyDeskBundle(folder))
        session.unsavedWorkCheck = { unsaved }
        let made = DeskWindowController(session: session, verifier: StubUnlockVerifier(.verified), prompt: prompt)
        controller = made
        XCTAssertEqual(made.window?.title, "True Convo Desk (invented data)")
        XCTAssertEqual(made.window?.identifier, DeskWindowController.windowIdentifier)
        XCTAssertEqual(made.window?.isRestorable, false)
        XCTAssertFalse(made.lockedOverlay.isHidden, "locked until unlocked")
        XCTAssertNil(made.embeddedWebView)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let host = try XCTUnwrap(session.host)
        XCTAssertTrue(made.embeddedWebView === host.webView)
        XCTAssertFalse(host.webView.isHidden)
        XCTAssertTrue(made.lockedOverlay.isHidden)
        XCTAssertTrue(made.stripLabel.stringValue.hasPrefix("Invented data only · not private · key: invented-in-memory-placeholder"))
        return (made, session, host)
    }

    func testCloseWithoutUnsavedWorkClosesHost() async throws {
        let prompt = FakePrompt()
        let (made, session, host) = try await openController(unsaved: nil, prompt: prompt)
        let run = try XCTUnwrap(session.runFolder)
        let window = try XCTUnwrap(made.window)
        XCTAssertFalse(made.windowShouldClose(window), "the window waits for the Desk to close first")
        try await waitUntil("the Desk to close") { session.state == .closed }
        XCTAssertTrue(host.isClosed)
        XCTAssertNil(session.host)
        XCTAssertNil(made.embeddedWebView)
        XCTAssertEqual(prompt.asked, [], "nothing unsaved, nothing asked")
        XCTAssertNotNil(WriterLockHolder(folder: run), "the store's writer lock is free")
    }

    func testUnsavedKeepEditingLeavesHostOpen() async throws {
        let prompt = FakePrompt()
        prompt.answer = false
        let (made, session, host) = try await openController(unsaved: .unsaved, prompt: prompt)
        await made.closeAfterAsking()
        XCTAssertEqual(prompt.asked, [.closeWindow])
        XCTAssertEqual(prompt.reasons, [.unsaved])
        XCTAssertEqual(session.state, .open)
        XCTAssertFalse(host.isClosed)
        XCTAssertTrue(session.host === host)
        XCTAssertFalse(host.webView.isHidden)
    }

    func testUnsavedCloseAndLoseClosesHost() async throws {
        let prompt = FakePrompt()
        prompt.answer = true
        let (made, session, host) = try await openController(unsaved: .unsaved, prompt: prompt)
        await made.closeAfterAsking()
        XCTAssertEqual(prompt.asked, [.closeWindow])
        XCTAssertEqual(session.state, .closed)
        XCTAssertTrue(host.isClosed)
    }

    func testLockDismissesOpenPromptAsKeep() async throws {
        let prompt = FakePrompt()
        let (made, session, host) = try await openController(unsaved: .unsaved, prompt: prompt)
        let closing = Task { await made.closeAfterAsking() }
        try await waitUntil("the question to be open") { prompt.isWaiting }
        await session.lock(reason: .screenLocked)
        await closing.value
        XCTAssertGreaterThanOrEqual(prompt.dismissals, 1)
        XCTAssertFalse(prompt.isWaiting)
        XCTAssertEqual(session.state, .locked, "kept, and locked")
        XCTAssertFalse(host.isClosed)
        XCTAssertTrue(host.isLocked)
        XCTAssertTrue(host.webView.isHidden, "the page is hidden")
        XCTAssertFalse(made.lockedOverlay.isHidden, "the Locked overlay shows")
        XCTAssertFalse(made.lockButton.isEnabled)

        // The page's own navigation question is the same sheet.
        prompt.answer = true
        let leave = await session.confirmLeavingUnsavedWork?(nil, .unsaved)
        XCTAssertEqual(leave, true)
        XCTAssertEqual(prompt.asked.last, .leavePage)
    }

    /// Codex W4, the window's side: a page that cannot answer is asked
    /// about like unsaved work, with its own words. Keep Editing keeps the
    /// Desk open; only Close Anyway closes it. Logs say why, nothing more.
    func testCloseAsksWhenThePageCannotAnswer() async throws {
        let prompt = FakePrompt()
        prompt.answer = false
        let logs = DeskLogCollector()
        let session = makeSession(folder, bundle: try anyDeskBundle(folder), logs: logs)
        session.unsavedWorkCheck = { .noAnswer }
        let made = DeskWindowController(session: session, verifier: StubUnlockVerifier(.verified), prompt: prompt, log: logs.log)
        controller = made
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let host = try XCTUnwrap(session.host)
        await made.closeAfterAsking()
        XCTAssertEqual(prompt.asked, [.closeWindow])
        XCTAssertEqual(prompt.reasons, [.noAnswer])
        XCTAssertEqual(session.state, .open, "kept")
        XCTAssertFalse(host.isClosed)
        XCTAssertTrue(logs.all.contains("desk.close.kept reason=no-answer"), "\(logs.all)")

        prompt.answer = true
        await made.closeAfterAsking()
        XCTAssertEqual(prompt.reasons, [.noAnswer, .noAnswer])
        XCTAssertEqual(session.state, .closed, "Close Anyway closes")
        XCTAssertTrue(host.isClosed)
    }

    /// The page's own navigation question (the host's
    /// `confirmLeavingUnsavedWork`) reaches the sheet with the host's
    /// reason; no answer but the lose button lets the page go.
    func testLeavingAPageThatCannotAnswerAsksWithItsReason() async throws {
        let prompt = FakePrompt()
        prompt.answer = false
        let (_, _, host) = try await openController(unsaved: nil, prompt: prompt)
        let ask = try XCTUnwrap(host.confirmLeavingUnsavedWork)
        let kept = try await ask(nil, .noAnswer)
        XCTAssertFalse(kept)
        prompt.answer = true
        let left = try await ask(nil, .unsaved)
        XCTAssertTrue(left)
        XCTAssertEqual(prompt.asked, [.leavePage, .leavePage])
        XCTAssertEqual(prompt.reasons, [.noAnswer, .unsaved])
    }

    /// The questions' words: unsaved changes and a page that gave no answer
    /// read differently, for closing, leaving and quitting; Keep is always
    /// the first (default) button and only the second loses. The no-answer
    /// words name no cause: a listener that threw answers at once, so the
    /// page may be working fine (W4-WORDING-1).
    func testUnsavedWorkWordingSaysWhyAndKeepsKeepFirst() throws {
        XCTAssertEqual(DeskUnsavedWorkWording.unsavedMessage, "You have unsaved changes in the Desk.")
        XCTAssertEqual(DeskUnsavedWorkWording.noAnswerMessage, "The Desk page couldn't confirm your work is saved.")
        XCTAssertFalse(DeskUnsavedWorkWording.noAnswerMessage.lowercased().contains("respond"), "no claim that the page stopped")
        let expected: [(DeskUnsavedWorkQuestion, String, String, String, String)] = [
            (.closeWindow, "Keep Editing", "Close and Lose Changes", "Close Anyway", "Closing the window now"),
            (.leavePage, "Keep Editing", "Leave and Lose Changes", "Leave Anyway", "Leaving this page now"),
            (.quitApp, "Keep", "Quit and Lose Changes", "Quit Anyway", "Quitting now")
        ]
        for (question, keep, loseUnsaved, loseNoAnswer, opening) in expected {
            let unsaved = DeskUnsavedWorkWording(question, .unsaved)
            let noAnswer = DeskUnsavedWorkWording(question, .noAnswer)
            XCTAssertEqual(unsaved.message, DeskUnsavedWorkWording.unsavedMessage)
            XCTAssertEqual(noAnswer.message, DeskUnsavedWorkWording.noAnswerMessage)
            XCTAssertEqual(unsaved.detail, "\(opening) loses them. " + (question == .quitApp ? "Everything in the Desk is invented data." : "Everything here is invented data."))
            XCTAssertEqual(noAnswer.detail, "\(opening) may lose any changes it holds. " + (question == .quitApp ? "Everything in the Desk is invented data." : "Everything here is invented data."))
            XCTAssertEqual([unsaved.keepButton, unsaved.loseButton], [keep, loseUnsaved])
            XCTAssertEqual([noAnswer.keepButton, noAnswer.loseButton], [keep, loseNoAnswer])
            for wording in [unsaved, noAnswer] {
                let alert = wording.makeAlert()
                XCTAssertEqual(alert.messageText, wording.message)
                XCTAssertEqual(alert.informativeText, wording.detail)
                XCTAssertEqual(alert.buttons.map(\.title), [wording.keepButton, wording.loseButton], "Keep first")
            }
        }
    }

    /// A lock (or close) arriving while the page is asked took the page's
    /// work: the session reports nothing unsaved, so no question is shown
    /// over a locked Desk.
    func testHoldsUnsavedWorkIsNilWhenLockedWhileAsked() async throws {
        let session = makeSession(folder, bundle: try anyDeskBundle(folder))
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        var pending: CheckedContinuation<DeskUnsavedWork?, Never>?
        session.unsavedWorkCheck = { await withCheckedContinuation { pending = $0 } }
        async let asked = session.holdsUnsavedWork()
        try await waitUntil("the page to be asked") { pending != nil }
        await session.lock(reason: .lockButton)
        pending?.resume(returning: .noAnswer)
        let answer = await asked
        XCTAssertNil(answer)
        XCTAssertEqual(session.state, .locked)
        await session.close()
    }

    func testHoldsFocusIsFalseForOtherWindows() async throws {
        let prompt = FakePrompt()
        let (made, _, _) = try await openController(unsaved: nil, prompt: prompt)
        let desk = try XCTUnwrap(made.window)
        let other = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: true)
        other.isReleasedWhenClosed = false
        func focus(active: Bool = true, visible: Bool = true, key: NSWindow?, main: Bool = false) -> Bool {
            DeskWindowController.holdsFocus(appIsActive: active, windowIsVisible: visible, keyWindow: key, window: desk, windowIsMain: main)
        }
        XCTAssertTrue(focus(key: desk))
        XCTAssertFalse(focus(key: other), "Scratchpad, Settings or any other window key")
        XCTAssertFalse(focus(key: nil))
        XCTAssertTrue(focus(key: nil, main: true), "a panel is key while the Desk is the main window")
        XCTAssertFalse(focus(active: false, key: desk), "True Convo not the active app")
        XCTAssertFalse(focus(visible: false, key: desk), "the window is not on screen")
        XCTAssertFalse(made.holdsFocus, "never shown in tests")
    }

    /// Review finding LC-3: closing the window while the owner check is
    /// still up leaves the Desk shut, even when the owner then verifies.
    func testCloseDuringOwnerCheckLeavesTheDeskShut() async throws {
        let logs = DeskLogCollector()
        let session = makeSession(folder, bundle: try anyDeskBundle(folder), logs: logs)
        let held = HeldVerifier()
        let made = DeskWindowController(session: session, verifier: held, prompt: FakePrompt())
        controller = made
        made.unlockPressed(nil)
        try await waitUntil("the owner check to be up") { held.isWaiting }
        await made.closeAfterAsking()
        held.answer(.verified)
        try await waitUntil("the unlock to end") {
            logs.all.contains { $0.hasPrefix("desk.unlock.") || $0.hasPrefix("desk.opened") }
        }
        XCTAssertEqual(session.state, .lockedNoStack)
        XCTAssertFalse(session.hasStack)
        XCTAssertNil(session.store)
        XCTAssertNil(made.embeddedWebView)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.base.path), "nothing was opened or created")
        XCTAssertEqual(logs.all, ["desk.unlock.superseded from=locked-no-stack now=locked-no-stack reason=window-closed"])
    }

    /// Review finding LC-3, the reopen within a run: closing the window
    /// while the Desk is still opening leaves it closed, with the store's
    /// writer lock released.
    func testCloseWhileReopeningLeavesTheDeskClosed() async throws {
        let logs = DeskLogCollector()
        let session = makeSession(folder, bundle: try anyDeskBundle(folder), logs: logs)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let run = try XCTUnwrap(session.runFolder)
        await session.close()
        XCTAssertEqual(session.state, .closed)
        let reopening = Task { await session.unlock(verifier: StubUnlockVerifier()) }
        await Task.yield()
        await session.close()
        await reopening.value
        XCTAssertEqual(session.state, .closed)
        XCTAssertNil(session.host)
        XCTAssertNil(session.store)
        XCTAssertNotNil(WriterLockHolder(folder: run), "the store's writer lock is free")
        XCTAssertTrue(logs.all.contains("desk.open.abandoned reason=window-closed"), "\(logs.all)")
    }

    /// Review finding LC-4: after a relaunch the quit note stays in the
    /// window through a refused unlock, the next unlock, and a notice.
    func testQuitNoteStaysThroughRefusedUnlockAndNotices() async throws {
        let bundle = try anyDeskBundle(folder)
        let earlier = makeSession(folder, bundle: bundle)
        await earlier.unlock(verifier: StubUnlockVerifier(.verified))
        await earlier.close()

        let session = makeSession(folder, bundle: bundle)
        let made = DeskWindowController(session: session, verifier: StubUnlockVerifier(), prompt: FakePrompt())
        controller = made
        let quitNote = DeskSession.Message.quitNote
        XCTAssertEqual(made.noticeLabel.stringValue, quitNote)
        XCTAssertFalse(made.noticeLabel.isHidden)
        await session.unlock(verifier: StubUnlockVerifier(.refused))
        XCTAssertTrue(made.noticeLabel.stringValue.contains(DeskSession.Message.notUnlocked))
        XCTAssertTrue(made.noticeLabel.stringValue.contains(quitNote), "kept through a refused unlock")
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(session.state, .open)
        XCTAssertEqual(made.noticeLabel.stringValue, quitNote, "after Unlock: the quit note, the refusal gone")
        made.showNotice("Dictation into the Desk comes in the next build. Click another app to dictate there.")
        XCTAssertTrue(made.noticeLabel.stringValue.contains(quitNote), "kept next to a notice")
        XCTAssertTrue(made.noticeLabel.stringValue.contains("Dictation into the Desk comes in the next build"))
    }

    /// Review finding LC-5: when the page's process stops while the Desk is
    /// locked, no "reloading" banner shows over the Locked overlay; nothing
    /// reloads until Unlock, which loads a fresh page anyway.
    func testPageStoppedWhileLockedShowsNoReloadBanner() async throws {
        let logs = DeskLogCollector()
        let session = makeSession(folder, bundle: try anyDeskBundle(folder), logs: logs)
        let made = DeskWindowController(session: session, verifier: StubUnlockVerifier(.verified), prompt: FakePrompt())
        controller = made
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let host = try XCTUnwrap(session.host)
        await session.lock(reason: .lockButton)
        host.webViewWebContentProcessDidTerminate(host.webView)
        try await waitUntil("the stop to be seen") { logs.all.contains("desk.page.stopped reloading=false") }
        XCTAssertTrue(made.stoppedBanner.isHidden, "no reloading banner over a locked Desk")
        XCTAssertFalse(made.lockedOverlay.isHidden)
        session.post(notice: "An invented notice")
        XCTAssertTrue(made.stoppedBanner.isHidden, "a later render keeps it hidden")
    }
}

/// The window-only edit keys.
@MainActor
final class DeskWindowEditKeysTests: XCTestCase {
    final class SpyView: NSView {
        var received: [String] = []
        override var acceptsFirstResponder: Bool { true }
        @objc func cut(_ sender: Any?) { received.append("cut:") }
        @objc func copy(_ sender: Any?) { received.append("copy:") }
        @objc func paste(_ sender: Any?) { received.append("paste:") }
        override func selectAll(_ sender: Any?) { received.append("selectAll:") }
        @objc func undo(_ sender: Any?) { received.append("undo:") }
        @objc func redo(_ sender: Any?) { received.append("redo:") }
    }

    private func makeWindow() -> (DeskWindow, SpyView) {
        _ = NSApplication.shared
        let window = DeskWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        let spy = SpyView(frame: NSRect(x: 0, y: 0, width: 200, height: 100))
        window.contentView = spy
        XCTAssertTrue(window.makeFirstResponder(spy))
        return (window, spy)
    }

    private func key(_ characters: String, _ flags: NSEvent.ModifierFlags, in window: NSWindow) throws -> NSEvent {
        try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: window.windowNumber,
                                       context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: 0))
    }

    func testEditKeysReachFirstResponder() throws {
        let (window, spy) = makeWindow()
        let cases: [(String, NSEvent.ModifierFlags, String)] = [
            ("x", .command, "cut:"), ("c", .command, "copy:"), ("v", .command, "paste:"),
            ("a", .command, "selectAll:"), ("z", .command, "undo:"), ("Z", [.command, .shift], "redo:")
        ]
        for (characters, flags, expected) in cases {
            spy.received.removeAll()
            XCTAssertTrue(window.performKeyEquivalent(with: try key(characters, flags, in: window)), expected)
            XCTAssertEqual(spy.received, [expected])
        }
    }

    func testOtherKeyEquivalentsPassThrough() throws {
        let (window, spy) = makeWindow()
        let cases: [(String, NSEvent.ModifierFlags)] = [
            ("k", .command), ("c", [.command, .option]), ("c", .control), ("c", [.command, .control]), ("q", .command), ("w", .command), ("v", [])
        ]
        for (characters, flags) in cases {
            XCTAssertNil(DeskWindow.editAction(for: try key(characters, flags, in: window)), "\(characters) \(flags.rawValue)")
            XCTAssertFalse(window.performKeyEquivalent(with: try key(characters, flags, in: window)), "\(characters) \(flags.rawValue)")
        }
        XCTAssertEqual(spy.received, [])
    }
}
