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
    private(set) var dismissals = 0
    /// When set, `show` waits until dismissed (answering false).
    var holdShow = false
    private var pending: CheckedContinuation<Bool, Never>?
    var isHolding: Bool { pending != nil }

    func dismiss() {
        dismissals += 1
        pending?.resume(returning: false)
        pending = nil
    }

    func show(_ displayText: String, durable: Bool, in window: NSWindow) async -> Bool {
        shown.append(displayText)
        if holdShow { return await withCheckedContinuation { pending = $0 } }
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

    private func newRun(logs: DeskLogCollector = DeskLogCollector(), companion: (any RecoveryCompanion)? = nil) throws -> DeskSession {
        let made = DeskSession(paths: folder.paths, bundle: try anyDeskBundle(folder),
                               info: HostInfo(appVersion: "0.0.0-test", hostBuild: "unit-desk-none"),
                               storage: .kept(keychain), recoveryCompanion: companion, log: logs.log)
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

    // MARK: The companion (step 2, PR 4b)

    func testTheCompanionIsSealedAskedAndRestoredWithTheSameKey() async throws {
        let companion = FakeCompanion()
        companion.uncovered = true
        let first = try newRun(companion: companion)
        await first.unlock(verifier: StubUnlockVerifier(.verified))
        let workspaceId = try XCTUnwrap(first.store?.workspaceId)
        let made = try XCTUnwrap(first.makeRecoveryKey())
        XCTAssertEqual(companion.sealed, [made.key.fingerprint])
        XCTAssertEqual(companion.retiredAllBut, [made.key.fingerprint])
        XCTAssertTrue(first.confirmRecoveryKey())
        XCTAssertTrue(first.needsRecoveryKey, "the companion still asks for a key")
        companion.uncovered = false
        XCTAssertFalse(first.needsRecoveryKey)
        await first.close()
        keychain.forgetKey(for: workspaceId)

        let later = try newRun(companion: companion)
        await later.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(later.restore(typed: made.key.displayText), .restored)
        XCTAssertEqual(companion.restoredWith, [made.key.fingerprint])
        XCTAssertEqual(later.notice, DeskSession.Message.restored)
    }

    func testARestoreTheCompanionDoesntCoverSaysSo() async throws {
        let companion = FakeCompanion()
        companion.restoreAnswer = .notCovered
        let first = try newRun(companion: companion)
        await first.unlock(verifier: StubUnlockVerifier(.verified))
        let workspaceId = try XCTUnwrap(first.store?.workspaceId)
        let text = try XCTUnwrap(first.makeRecoveryKey()).key.displayText
        await first.close()
        keychain.forgetKey(for: workspaceId)

        let later = try newRun(companion: companion)
        await later.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(later.restore(typed: text), .restored)
        XCTAssertEqual(later.notice, DeskSession.Message.restoredDeskOnly)
        XCTAssertEqual(later.state, .lockedNoStack)
    }

    func testACompanionThatRefusesMeansNoKeyIsMade() async throws {
        let companion = FakeCompanion()
        companion.refuses = true
        let desk = try newRun(companion: companion)
        await desk.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertNil(desk.makeRecoveryKey())
        XCTAssertFalse(try XCTUnwrap(desk.store).hasRecoveryCopy)
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

    func testALockEndsTheKeyDialogAtOnceAndNothingIsConfirmed() async throws {
        let desk = try newRun()
        let prompt = ScriptedRecoveryPrompt()
        prompt.holdShow = true
        let controller = window(for: desk, prompt: prompt)
        await desk.unlock(verifier: StubUnlockVerifier(.verified))
        let flow = Task { await controller.runRecoveryKeyFlow() }
        try await waitUntil("the key is showing") { prompt.isHolding }
        await desk.lock(reason: .screenLocked)
        XCTAssertGreaterThanOrEqual(prompt.dismissals, 1, "the lock ended the dialog")
        XCTAssertFalse(prompt.isHolding)
        await flow.value
        XCTAssertEqual(prompt.retries, [], "nothing was asked after the lock")
        XCTAssertFalse(controller.recoveryFlowActive)
        await desk.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertTrue(desk.needsRecoveryKey, "still unconfirmed")
    }

    func testAFailedMakeSaysSoAndShowsNothing() async throws {
        let desk = try newRun()
        let prompt = ScriptedRecoveryPrompt()
        let controller = window(for: desk, prompt: prompt)
        await desk.unlock(verifier: StubUnlockVerifier(.verified))
        // Stand in for a full disk: the store folder no longer takes new files.
        let folderURL = try XCTUnwrap(desk.runFolder)
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: folderURL.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folderURL.path) }
        await controller.runRecoveryKeyFlow()
        XCTAssertEqual(prompt.shown, [], "no key shown")
        XCTAssertEqual(desk.notice, DeskRecoveryWording.makeFailed)
        XCTAssertTrue(desk.needsRecoveryKey)
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

private final class FakeCompanion: RecoveryCompanion, @unchecked Sendable {
    private let lock = NSLock()
    private var state = (sealed: [String](), retired: [String](), restored: [String]())
    var uncovered = false
    var refuses = false
    var restoreAnswer: RecoveryCompanionRestore = .restored

    var sealed: [String] { lock.lock(); defer { lock.unlock() }; return state.sealed }
    var retiredAllBut: [String] { lock.lock(); defer { lock.unlock() }; return state.retired }
    var restoredWith: [String] { lock.lock(); defer { lock.unlock() }; return state.restored }

    func seal(under recovery: RecoveryKey) throws {
        if refuses { throw RecoveryError.randomUnavailable }
        lock.lock(); state.sealed.append(recovery.fingerprint); lock.unlock()
    }
    func discard(_ recovery: RecoveryKey) {}
    func retireAllBut(_ recovery: RecoveryKey) -> Bool { lock.lock(); state.retired.append(recovery.fingerprint); lock.unlock(); return true }
    func restore(with recovery: RecoveryKey) -> RecoveryCompanionRestore {
        lock.lock(); state.restored.append(recovery.fingerprint); lock.unlock()
        return restoreAnswer
    }
    var needsRecoveryKey: Bool { uncovered }
}
