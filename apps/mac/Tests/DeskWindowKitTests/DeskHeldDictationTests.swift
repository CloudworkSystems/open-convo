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
