import AppKit
import DeskHost
@testable import DeskWindowKit
import Foundation
import XCTest

/// Answers the recovery key's dialogs from a script and records what it saw.
@MainActor
final class ScriptedRecoveryPrompt: DeskRecoveryKeyPrompting {
    var showAnswers: [Bool] = []
    var backAnswers: [(RecoveryKeyCheck) -> RecoveryCheckAnswer] = []
    var restoreAnswers: [String?] = []
    private(set) var shown: [String] = []
    private(set) var retries: [Bool] = []
    private(set) var problems: [String?] = []

    func show(_ displayText: String, durable: Bool, in window: NSWindow) async -> Bool {
        shown.append(displayText)
        return showAnswers.isEmpty ? false : showAnswers.removeFirst()
    }

    func askBack(_ check: RecoveryKeyCheck, retry: Bool, in window: NSWindow) async -> RecoveryCheckAnswer {
        retries.append(retry)
        return backAnswers.isEmpty ? .cancel : backAnswers.removeFirst()(check)
    }

    func askRestore(problem: String?, in window: NSWindow) async -> String? {
        problems.append(problem)
        return restoreAnswers.isEmpty ? nil : restoreAnswers.removeFirst()
    }
}

@MainActor
final class DeskRecoveryKeyTests: XCTestCase {
    private var folder: DeskTestFolder!
    private var keychain: InventedInMemoryKeyProvider!
    private var sessions: [DeskSession] = []
    private var controllers: [DeskWindowController] = []

    override func setUp() async throws {
        _ = NSApplication.shared
        folder = try DeskTestFolder()
        keychain = InventedInMemoryKeyProvider()
    }

    override func tearDown() async throws {
        for session in sessions { await session.close() }
        for controller in controllers { controller.window?.delegate = nil }
        sessions.removeAll()
        controllers.removeAll()
        folder.clean()
    }

    private func newRun(logs: DeskLogCollector = DeskLogCollector()) throws -> DeskSession {
        let made = DeskSession(paths: folder.paths, bundle: try anyDeskBundle(folder),
                               info: HostInfo(appVersion: "0.0.0-test", hostBuild: "unit-desk-none"),
                               storage: .kept(keychain), log: logs.log)
        sessions.append(made)
        return made
    }

    private func window(for session: DeskSession, prompt: ScriptedRecoveryPrompt) -> DeskWindowController {
        let made = DeskWindowController(session: session, verifier: StubUnlockVerifier(.verified), recoveryPrompt: prompt)
        controllers.append(made)
        return made
    }

    /// Two groups typed back as asked, optionally in lower case with spaces.
    private func rightAnswer(_ text: String) -> (RecoveryKeyCheck) -> RecoveryCheckAnswer {
        let groups = text.split(separator: "-").map(String.init)
        return { check in .typed(" " + groups[check.asked[0]].lowercased(), groups[check.asked[1]]) }
    }

    // MARK: The check

    func testCheckAsksTwoDifferentGroupsAndForgivesCaseAndLookAlikes() throws {
        let text = try RecoveryKey.generate().displayText
        let groups = text.split(separator: "-").map(String.init)
        let check = RecoveryKeyCheck(displayText: text, pick: { _ in [7, 2] })
        XCTAssertEqual(check.asked, [2, 7])
        XCTAssertEqual(check.prompt, "Type group 3 and group 8 of your recovery key.")
        XCTAssertTrue(check.matches(groups[2].lowercased(), groups[7]))
        let lookAlike = groups[2].replacingOccurrences(of: "0", with: "o").replacingOccurrences(of: "1", with: "l")
        XCTAssertTrue(check.matches(lookAlike, " " + groups[7] + " "))
        XCTAssertFalse(check.matches(groups[7], groups[2]), "order matters")
        XCTAssertFalse(check.matches(groups[2], groups[8]))
        for _ in 0..<200 {
            let pair = RecoveryKeyCheck.randomPair(11)
            XCTAssertNotEqual(pair[0], pair[1])
            XCTAssertTrue(pair.allSatisfy { (0..<11).contains($0) })
        }
    }

    // MARK: The session

    func testAnOpenKeptDeskAsksUntilAKeyIsConfirmedAndAgainAfterANewOne() async throws {
        let desk = try newRun()
        await desk.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertTrue(desk.needsRecoveryKey, "no key yet")
        let made = try XCTUnwrap(desk.makeRecoveryKey())
        XCTAssertTrue(made.isDurable)
        XCTAssertTrue(desk.needsRecoveryKey, "made but not confirmed")
        XCTAssertTrue(desk.confirmRecoveryKey())
        XCTAssertFalse(desk.needsRecoveryKey)
        await desk.close()

        let later = try newRun()
        await later.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertFalse(later.needsRecoveryKey, "confirmation survives a restart")
        _ = try XCTUnwrap(later.makeRecoveryKey())
        XCTAssertTrue(later.needsRecoveryKey, "a new key needs its own confirmation")
    }

    func testThePerRunDeskNeverAsks() async throws {
        let desk = makeSession(folder, bundle: try anyDeskBundle(folder))
        sessions.append(desk)
        await desk.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertFalse(desk.needsRecoveryKey)
        XCTAssertNil(desk.makeRecoveryKey())
    }

    func testRestoreBringsTheDeskBackAndRefusalsChangeNothing() async throws {
        let first = try newRun()
        await first.unlock(verifier: StubUnlockVerifier(.verified))
        let workspaceId = try XCTUnwrap(first.store?.workspaceId)
        let text = try XCTUnwrap(first.makeRecoveryKey()).key.displayText
        XCTAssertTrue(first.confirmRecoveryKey())
        await first.close()
        keychain.forgetKey(for: workspaceId)

        let logs = DeskLogCollector()
        let later = try newRun(logs: logs)
        XCTAssertFalse(later.canRestoreWithRecoveryKey, "not before the key is found missing")
        await later.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(later.state, .unavailable(DeskSession.Message.keychainKeyMissing))
        XCTAssertTrue(later.canRestoreWithRecoveryKey)

        XCTAssertEqual(later.restore(typed: "not a key"), .malformed)
        XCTAssertEqual(later.restore(typed: try RecoveryKey.generate().displayText), .wrongKey)
        XCTAssertEqual(keychain.heldKeyCount, 0)
        XCTAssertEqual(later.state, .unavailable(DeskSession.Message.keychainKeyMissing))

        XCTAssertEqual(later.restore(typed: text.lowercased().replacingOccurrences(of: "-", with: " ")), .restored)
        XCTAssertEqual(later.state, .lockedNoStack)
        XCTAssertEqual(later.notice, DeskSession.Message.restored)
        await later.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(later.state, .open)
        XCTAssertEqual(later.store?.workspaceId, workspaceId, "the same Desk")
        XCTAssertFalse(later.needsRecoveryKey, "its confirmed key still stands")
        XCTAssertFalse(logs.all.contains { $0.contains(text) || $0.contains(text.replacingOccurrences(of: "-", with: "")) },
                       "the key is never logged")
    }

    // MARK: The window

    func testWindowFlowShowsOnceConfirmsAndHidesTheRow() async throws {
        let desk = try newRun()
        let prompt = ScriptedRecoveryPrompt()
        let controller = window(for: desk, prompt: prompt)
        XCTAssertTrue(controller.recoveryRow.isHidden, "locked: nothing asked")
        await desk.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertFalse(controller.recoveryRow.isHidden)
        XCTAssertEqual(controller.recoveryLabel.stringValue, DeskRecoveryWording.missingLine)

        // Wrong groups once, then Show It Again, then the right groups.
        prompt.showAnswers = [true, true]
        var shownText = ""
        prompt.backAnswers = [
            { _ in .typed("AAAAA", "BBBBB") },
            { _ in .showAgain },
            { [unowned prompt] check in
                shownText = prompt.shown.last ?? ""
                let groups = shownText.split(separator: "-").map(String.init)
                return .typed(groups[check.asked[0]], groups[check.asked[1]].lowercased())
            },
        ]
        await controller.runRecoveryKeyFlow()
        XCTAssertEqual(prompt.shown.count, 2)
        XCTAssertEqual(prompt.shown[0], prompt.shown[1], "Show It Again shows the same key")
        XCTAssertEqual(prompt.retries, [false, true, true])
        XCTAssertFalse(desk.needsRecoveryKey)
        XCTAssertTrue(controller.recoveryRow.isHidden)
    }

    func testCancellingLeavesItUnconfirmedAndSaysSo() async throws {
        let desk = try newRun()
        let prompt = ScriptedRecoveryPrompt()
        let controller = window(for: desk, prompt: prompt)
        await desk.unlock(verifier: StubUnlockVerifier(.verified))
        prompt.showAnswers = [true]
        prompt.backAnswers = [{ _ in .cancel }]
        await controller.runRecoveryKeyFlow()
        XCTAssertTrue(desk.needsRecoveryKey)
        XCTAssertFalse(controller.recoveryRow.isHidden)
        XCTAssertEqual(controller.recoveryLabel.stringValue, DeskRecoveryWording.unconfirmedLine)
        XCTAssertTrue(controller.recoveryButton.isEnabled)
    }

    func testWindowRestoreRetriesWithAReasonThenUnlocksAsUsual() async throws {
        let first = try newRun()
        await first.unlock(verifier: StubUnlockVerifier(.verified))
        let id = try XCTUnwrap(first.store?.workspaceId)
        let text = try XCTUnwrap(first.makeRecoveryKey()).key.displayText
        await first.close()
        keychain.forgetKey(for: id)

        let later = try newRun()
        let prompt = ScriptedRecoveryPrompt()
        let controller = window(for: later, prompt: prompt)
        XCTAssertTrue(controller.restoreButton.isHidden)
        await later.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertFalse(controller.restoreButton.isHidden)

        prompt.restoreAnswers = ["12345", try RecoveryKey.generate().displayText, text]
        await controller.runRestoreFlow()
        XCTAssertEqual(prompt.problems, [nil, DeskRecoveryWording.malformed, DeskRecoveryWording.wrongKey])
        XCTAssertEqual(later.state, .lockedNoStack)
        XCTAssertTrue(controller.restoreButton.isHidden)
        XCTAssertEqual(controller.lockedTitle.stringValue, "Locked")
    }
}
