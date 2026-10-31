import AppKit
import DeskHost
@testable import DeskWindowKit
import Foundation
import XCTest

/// Section 21.4's approval as a plain fake (the store adapter is tested with
/// the participant modules): a state, an answer for each write, and counts.
@MainActor
final class FakeHostApprovalControls: DeskHostApprovalControlling {
    var state: DeskHostApprovalState = .notApproved
    var onChange: (@MainActor () -> Void)?
    var answer: DeskHostApprovalResult?
    private(set) var approvals = 0
    private(set) var withdrawals = 0

    func approve() -> DeskHostApprovalResult {
        approvals += 1
        let result = answer ?? .approved
        if result != .failed { state = .approved(at: Date(timeIntervalSince1970: 1_793_244_600)) }
        onChange?()
        return result
    }

    func withdraw() -> DeskHostApprovalResult {
        withdrawals += 1
        let result = answer ?? .withdrawn
        if result != .failed { state = .notApproved }
        onChange?()
        return result
    }
}

/// The approval's statement sheet as a fake: answers as told, or waits until
/// dismissed, and records which statement it showed.
@MainActor
final class FakeHostApprovalStatement: DeskHostApprovalStatementPrompting {
    var answer: Bool?
    private(set) var asked: [DeskHostApprovalStatement] = []
    private(set) var dismissals = 0
    private var pending: CheckedContinuation<Bool, Never>?

    func ask(_ statement: DeskHostApprovalStatement, in window: NSWindow) async -> Bool {
        asked.append(statement)
        if let answer { return answer }
        return await withCheckedContinuation { pending = $0 }
    }

    func dismiss() {
        dismissals += 1
        pending?.resume(returning: false)
        pending = nil
    }

    var isWaiting: Bool { pending != nil }
}

/// The Desk window's "Approve Anthropic once" control (the Claude Code
/// adapter's PR 4a), offscreen and never shown: nothing new without it; with
/// it, its own row apart from the local checks' line, the statement before
/// any write, the Desk open throughout, and a lock or close answering an
/// open statement Cancel. Invented data only.
@MainActor
final class DeskHostApprovalControlsTests: XCTestCase {
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

    private func make(_ approval: FakeHostApprovalControls?, statement: FakeHostApprovalStatement? = nil,
                      paidUsage: FakePaidUsageControls? = nil) throws -> (DeskWindowController, DeskSession) {
        let session = makeSession(folder, bundle: try anyDeskBundle(folder))
        session.unsavedWorkCheck = { nil }
        let made = DeskWindowController(session: session, verifier: StubUnlockVerifier(.verified), prompt: FakePrompt(),
                                        paidUsage: paidUsage, hostApproval: approval, approvalStatement: statement)
        made.formatTime = { _ in "3:42 PM" }
        made.renderHostApproval()
        controller = made
        return (made, session)
    }

    func testWithoutTheControlTheWindowShowsNothingNew() throws {
        let (made, _) = try make(nil)
        XCTAssertNil(made.hostApproval)
        XCTAssertNil(made.approvalStatement)
        XCTAssertNil(made.hostApprovalRow)
        XCTAssertNil(made.hostApprovalLine.superview)
        XCTAssertNil(made.hostApprovalButton.superview)
        let column = try XCTUnwrap(made.window?.contentView?.subviews.first as? NSStackView)
        XCTAssertEqual(column.arrangedSubviews.count, 5)
    }

    func testItsOwnRowApartFromTheLocalChecks() async throws {
        let approval = FakeHostApprovalControls()
        let paidUsage = FakePaidUsageControls()
        let (made, session) = try make(approval, paidUsage: paidUsage)
        let column = try XCTUnwrap(made.window?.contentView?.subviews.first as? NSStackView)
        XCTAssertEqual(column.arrangedSubviews.count, 7, "the paid-usage row and the approval row, each its own")
        let row = try XCTUnwrap(made.hostApprovalRow)
        XCTAssertFalse(row === made.paidUsageRow)
        XCTAssertTrue(row.superview === column)

        // Local checks passing says nothing about the approval, which keeps its own line.
        paidUsage.checkAnswer = .passed
        _ = await made.checkClaude()
        XCTAssertEqual(made.paidUsageResult.stringValue, "Claude's local checks passed.")
        XCTAssertEqual(session.state, .lockedNoStack)
        XCTAssertEqual(made.hostApprovalLine.stringValue, "Anthropic: unlock the Desk to see or change the approval.",
                       "a locked Desk shows nothing of the approval")
        XCTAssertFalse(made.hostApprovalButton.isEnabled, "approving needs the Desk open")
        XCTAssertEqual(made.hostApprovalButton.title, "Approve Anthropic once…")
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(made.hostApprovalLine.stringValue,
                       "Anthropic: not approved. Claude can't receive messages until you approve it.")
        XCTAssertTrue(made.hostApprovalButton.isEnabled)

        approval.state = .approved(at: Date())
        approval.onChange?()
        XCTAssertEqual(made.hostApprovalLine.stringValue,
                       "Anthropic: approved 3:42 PM. Messages you send to Claude leave this Mac for Anthropic.")
        XCTAssertEqual(made.hostApprovalButton.title, "Withdraw Approval…")
        approval.state = .unreadable
        approval.onChange?()
        XCTAssertEqual(made.hostApprovalLine.stringValue,
                       "Anthropic: the approval can't be read right now, so Claude stays off.")
        XCTAssertEqual(session.state, .open)
        XCTAssertFalse(made.hostApprovalButton.isEnabled, "nothing to change while it can't be read")
        let answer = await made.changeHostApproval()
        XCTAssertNil(answer)
        XCTAssertEqual(approval.approvals + approval.withdrawals, 0)
    }

    func testTheStatementComesFirstAndCancelWritesNothing() async throws {
        let approval = FakeHostApprovalControls()
        let statement = FakeHostApprovalStatement()
        let (made, session) = try make(approval, statement: statement)
        let locked = await made.changeHostApproval()
        XCTAssertNil(locked, "nothing while the Desk is locked")
        XCTAssertTrue(statement.asked.isEmpty)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertTrue(made.hostApprovalButton.isEnabled)

        statement.answer = false
        let cancelled = await made.changeHostApproval()
        XCTAssertNil(cancelled)
        XCTAssertEqual(statement.asked, [.approve])
        XCTAssertEqual(approval.approvals, 0, "Cancel writes nothing")
        XCTAssertEqual(approval.state, .notApproved)

        statement.answer = true
        approval.answer = .failed
        let failed = await made.changeHostApproval()
        XCTAssertEqual(failed, .failed)
        XCTAssertEqual(made.hostApprovalResult.stringValue, "Nothing changed: the approval could not be saved on this Mac.")
        XCTAssertFalse(made.hostApprovalResult.isHidden)
        XCTAssertEqual(approval.state, .notApproved)

        approval.answer = nil
        let approved = await made.changeHostApproval()
        XCTAssertEqual(approved, .approved)
        XCTAssertEqual(approval.approvals, 2)
        XCTAssertTrue(made.hostApprovalResult.isHidden, "the failure line is gone")
        XCTAssertTrue(made.hostApprovalLine.stringValue.hasPrefix("Anthropic: approved 3:42 PM."))
        XCTAssertEqual(made.hostApprovalButton.title, "Withdraw Approval…")

        let withdrawn = await made.changeHostApproval()
        XCTAssertEqual(withdrawn, .withdrawn)
        XCTAssertEqual(statement.asked, [.approve, .approve, .approve, .withdraw], "withdrawing has its own statement")
        XCTAssertEqual(approval.withdrawals, 1)
        XCTAssertEqual(approval.state, .notApproved)
        XCTAssertEqual(made.hostApprovalButton.title, "Approve Anthropic once…")

        approval.answer = .unsynced
        let unsynced = await made.changeHostApproval()
        XCTAssertEqual(unsynced, .unsynced)
        XCTAssertEqual(made.hostApprovalResult.stringValue,
                       "Changed, but this Mac has not yet confirmed it is saved to disk. Check this line again after a restart.")
    }

    func testAChangeMakesThePageFirstResponder() async throws {
        let approval = FakeHostApprovalControls()
        let statement = FakeHostApprovalStatement()
        statement.answer = true
        let (made, session) = try make(approval, statement: statement)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let window = try XCTUnwrap(made.window)
        let webView = try XCTUnwrap(made.embeddedWebView)
        window.makeFirstResponder(made.hostApprovalButton)
        XCTAssertFalse(window.firstResponder === webView)
        let approved = await made.changeHostApproval()
        XCTAssertEqual(approved, .approved)
        XCTAssertTrue(window.firstResponder === webView, "the page reads availability again")

        window.makeFirstResponder(made.hostApprovalButton)
        approval.answer = .failed
        let failed = await made.changeHostApproval()
        XCTAssertEqual(failed, .failed)
        XCTAssertFalse(window.firstResponder === webView, "nothing changed, so nothing to read again")
    }

    func testALockHidesTheApprovalAtOnce() async throws {
        let approval = FakeHostApprovalControls()
        approval.state = .approved(at: Date())
        let statement = FakeHostApprovalStatement()
        statement.answer = true
        approval.answer = .failed
        let (made, session) = try make(approval, statement: statement)
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        _ = await made.changeHostApproval()
        XCTAssertTrue(made.hostApprovalLine.stringValue.hasPrefix("Anthropic: approved 3:42 PM."))
        XCTAssertFalse(made.hostApprovalResult.isHidden)
        session.lockNow(reason: .lockButton)
        // The fake still answers approved, as the store does until its own
        // lock step runs: the window shows none of it.
        XCTAssertEqual(made.hostApprovalLine.stringValue, "Anthropic: unlock the Desk to see or change the approval.")
        XCTAssertTrue(made.hostApprovalResult.isHidden)
        XCTAssertEqual(made.hostApprovalResult.stringValue, "")
        XCTAssertFalse(made.hostApprovalButton.isEnabled)
        approval.onChange?()
        XCTAssertEqual(made.hostApprovalLine.stringValue, "Anthropic: unlock the Desk to see or change the approval.")
    }

    func testALockOrCloseAnswersAnOpenStatementCancel() async throws {
        let approval = FakeHostApprovalControls()
        let statement = FakeHostApprovalStatement()
        let (made, session) = try make(approval, statement: statement)
        await session.unlock(verifier: StubUnlockVerifier(.verified))

        let first = Task { await made.changeHostApproval() }
        try await waitUntil("the statement is open") { statement.isWaiting }
        XCTAssertFalse(made.hostApprovalButton.isEnabled, "one at a time")
        let again = await made.changeHostApproval()
        XCTAssertNil(again)
        XCTAssertEqual(statement.asked.count, 1)
        session.lockNow(reason: .lockButton)
        let lockedAnswer = try await boundedValue(first, "the statement ends on lock")
        XCTAssertNil(lockedAnswer)
        XCTAssertGreaterThanOrEqual(statement.dismissals, 1)
        XCTAssertEqual(approval.approvals, 0, "a lock writes nothing")

        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let second = Task { await made.changeHostApproval() }
        try await waitUntil("the statement is open again") { statement.isWaiting }
        await made.closeAfterAsking()
        let closedAnswer = try await boundedValue(second, "the statement ends on close")
        XCTAssertNil(closedAnswer)
        XCTAssertEqual(approval.approvals, 0, "a close writes nothing")
        XCTAssertFalse(made.hostApprovalButton.isEnabled)
    }

    func testTheWordingSaysWhatLeavesWhereAndWhatDoesNot() {
        let detail = DeskHostApprovalWording.approveDetail
        for phrase in ["that message, and the earlier turns", "to Anthropic", "Claude Code on your Claude plan", "leave this Mac",
                       "no files, no other conversations and no memory", "until you withdraw it", "Paid usage is confirmed separately"] {
            XCTAssertTrue(detail.contains(phrase), phrase)
        }
        let lines = DeskHostApprovalWording.allFixed
            + [DeskHostApprovalState.notApproved, .approved(at: Date()), .unreadable].map { DeskHostApprovalWording.stateLine($0, time: { _ in "3:42 PM" }) }
        for line in lines {
            let lower = line.lowercased()
            for forbidden in ["free", "no charge", "verified", "stays on this mac", "private"] {
                XCTAssertFalse(lower.contains(forbidden), "\(forbidden) in \(line)")
            }
        }
        XCTAssertNil(DeskHostApprovalWording.resultLine(.approved))
        XCTAssertNil(DeskHostApprovalWording.resultLine(.withdrawn))
    }
}
