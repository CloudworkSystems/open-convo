import AppKit
@testable import DeskHost
@testable import DeskWindowKit
import Foundation
import XCTest

/// Set-aside dictation in the Desk window (owner decision A, October 12):
/// words the Desk could not place are shown as a count with Copy and
/// Dismiss, kept through a lock without showing them, and count as unsaved
/// work when the window closes.
@MainActor
final class DeskHeldDictationTests: XCTestCase {
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

    private func open(prompt: FakePrompt) async throws -> (DeskWindowController, DeskSession, DraftBindingRegistry) {
        let session = makeSession(folder, bundle: try anyDeskBundle(folder))
        session.unsavedWorkCheck = { nil }
        let made = DeskWindowController(session: session, verifier: StubUnlockVerifier(.verified), prompt: prompt)
        controller = made
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(session.state, .open)
        XCTAssertTrue(made.heldRow.isHidden, "nothing set aside yet")
        return (made, session, try XCTUnwrap(session.draftRegistry))
    }

    private func hold(_ text: String, in drafts: DraftBindingRegistry, reason: HeldReason = .notSaved) {
        drafts.hold(HeldDelivery(deliveryId: UUID(), generation: 1, reason: reason, text: text, heldAt: Date()))
    }

    func testHeldWordsShowCopyAndDismiss() async throws {
        let (made, session, drafts) = try await open(prompt: FakePrompt())
        var counts: [Int] = []
        made.onHeldDictationChange = { counts.append($0) }
        var copied: [String] = []
        made.copyToClipboard = { copied.append($0) }
        hold("first words", in: drafts)
        try await waitUntil("the row to show") { !made.heldRow.isHidden }
        XCTAssertTrue(made.heldLabel.stringValue.hasPrefix("1 dictation set aside"))
        XCTAssertFalse(made.heldLabel.stringValue.contains("first words"), "the row never shows the words")
        XCTAssertTrue(made.heldCopyButton.isEnabled)
        XCTAssertEqual(counts, [1])

        made.heldCopyPressed(nil)
        XCTAssertEqual(copied, ["first words"])
        XCTAssertEqual(session.heldDictation.count, 1, "Copy keeps the words until dismissed")

        made.heldDismissPressed(nil)
        XCTAssertTrue(session.heldDictation.isEmpty)
        try await waitUntil("the row to hide") { made.heldRow.isHidden }
        XCTAssertEqual(counts, [1, 0])
    }

    func testLockKeepsWordsButHidesThem() async throws {
        let (made, session, drafts) = try await open(prompt: FakePrompt())
        var copied: [String] = []
        made.copyToClipboard = { copied.append($0) }
        hold("private words", in: drafts, reason: .locked)
        try await waitUntil("the row to show") { !made.heldRow.isHidden }
        await session.lock(reason: .lockButton)
        XCTAssertEqual(session.state, .locked)
        XCTAssertEqual(session.heldDictation.map(\.text), ["private words"], "a lock keeps the words in memory")
        XCTAssertFalse(made.heldRow.isHidden)
        XCTAssertTrue(made.heldLabel.stringValue.contains("Unlock to copy"))
        XCTAssertFalse(made.heldCopyButton.isEnabled)
        XCTAssertFalse(made.heldDismissButton.isEnabled)
        made.heldCopyPressed(nil)
        XCTAssertEqual(copied, [], "a locked Desk copies nothing")
        XCTAssertNil(session.takeHeldDictation(session.heldDictation[0].deliveryId), "a locked Desk hands nothing over")
        let unsaved = await session.holdsUnsavedWork()
        XCTAssertEqual(unsaved, .unsaved, "closing a locked Desk would lose them")
    }

    /// Codex P1 on #7: a close right after a lock request, before the
    /// host's lock step sets pushed words aside, still asks.
    func testCloseJustAfterLockAsksForUnconfirmedWords() async throws {
        let (_, session, drafts) = try await open(prompt: FakePrompt())
        drafts.retainUntilSaved(HeldDelivery(deliveryId: UUID(), generation: 1, reason: .notSaved,
                                             text: "pushed, not saved", heldAt: Date()))
        XCTAssertTrue(session.heldDictation.isEmpty, "pushed words are retained, not yet set aside")
        session.lockNow(reason: .menu)
        XCTAssertEqual(session.state, .locked)
        let unsaved = await session.holdsUnsavedWork()
        XCTAssertEqual(unsaved, .unsaved)
    }

    /// Codex P2 on #7: closing lets the stack's registry go.
    func testCloseReleasesTheRegistry() async throws {
        let (made, session, _) = try await open(prompt: FakePrompt())
        weak var gone = session.draftRegistry
        hold("words", in: try XCTUnwrap(gone))
        try await waitUntil("the row to show") { !made.heldRow.isHidden }
        await session.close()
        try await waitUntil("the registry to be released") { gone == nil }
    }

    func testCloseAsksWhenWordsAreSetAside() async throws {
        let keep = FakePrompt()
        keep.answer = false
        let (made, session, drafts) = try await open(prompt: keep)
        hold("kept words", in: drafts)
        await made.closeAfterAsking()
        XCTAssertEqual(keep.asked, [.closeWindow])
        XCTAssertEqual(keep.reasons, [.unsaved])
        XCTAssertEqual(session.state, .open)
        XCTAssertEqual(session.heldDictation.count, 1)

        keep.answer = true
        await made.closeAfterAsking()
        XCTAssertEqual(session.state, .closed)
        XCTAssertTrue(session.heldDictation.isEmpty, "closing drops set-aside words")
        try await waitUntil("the row to hide") { made.heldRow.isHidden }
    }
}

/// Step 1, PR 2b: the Desk route's session calls. The test page binds no
/// draft, so a recording has no confirmed draft and its words are set aside;
/// after a close they reach no stack.
@MainActor
final class DeskRecordingRouteTests: XCTestCase {
    private var folder: DeskTestFolder!

    override func setUp() async throws {
        _ = NSApplication.shared
        folder = try DeskTestFolder()
    }

    override func tearDown() async throws {
        folder.clean()
    }

    func testRecordingWithoutDraftSetsWordsAsideAndCloseDropsLaterWords() async throws {
        let session = makeSession(folder, bundle: try anyDeskBundle(folder))
        session.unsavedWorkCheck = { nil }
        let locked = await session.beginDeskRecording()
        XCTAssertNil(locked, "no recording while the Desk is not open")
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(session.state, .open)

        let begun = await session.beginDeskRecording()
        let recording = try XCTUnwrap(begun)
        XCTAssertFalse(recording.hasConfirmedDraft, "no draft bound: the app refuses to record")
        let delivery = await session.deliverDeskFinal(recording, text: "invented words")
        guard case .held(let held)? = delivery else { return XCTFail("expected held, got \(String(describing: delivery))") }
        XCTAssertEqual(held.reason, .noBinding)
        XCTAssertEqual(session.heldDictation.map(\.text), ["invented words"], "set aside in the Desk window, never elsewhere")

        let begunLater = await session.beginDeskRecording()
        let later = try XCTUnwrap(begunLater)
        await session.close()
        let afterClose = await session.deliverDeskFinal(later, text: "late words")
        XCTAssertNil(afterClose, "a closed stack takes no words")
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertTrue(session.heldDictation.isEmpty, "a reopened stack never receives an earlier stack's words")
        let stale = await session.deliverDeskFinal(later, text: "stale words")
        XCTAssertNil(stale, "a recording begun in an earlier stack never reaches the new one")
        await session.close()
    }
}
