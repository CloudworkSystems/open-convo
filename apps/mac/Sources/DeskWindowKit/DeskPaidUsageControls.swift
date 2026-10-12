import AppKit
import Foundation

// The Desk window's native controls for section 17's confirmation that paid
// usage is off (plan F4). INACTIVE: `DeskWindowController` shows them only
// when it is given a `DeskPaidUsageControlling`, which defaults to nil and
// which the app never gives (F7 composes activation), so the shipping window
// shows nothing new. This module knows nothing of the participant modules:
// the controls see plain values, and the owner behind them
// (`PaidUsageDeskControls`, in `ParticipantDeskControls`) decides
// everything. Nothing here can confirm anything: a confirmation is made only
// inside the owner's own LocalAuthentication request.

/// Why a confirmation ended (section 5's `endedBy`).
public enum DeskPaidUsageEnd: String, Equatable, Sendable, CaseIterable {
    case lock
    case sleep
    case logout
    case cliChanged = "cli-changed"
    case loginChanged = "login-changed"
    case runLimit = "run-limit"
    case paidOverflow = "paid-overflow"
}

/// The confirmation as the window shows it.
public enum DeskPaidUsageState: Equatable, Sendable {
    /// None in this launch.
    case unconfirmed
    case active(confirmedAt: Date, runsLeft: Int)
    case ended(DeskPaidUsageEnd)
}

/// What "Check Claude" found: section 5's local checks only (the first
/// failing one), or that they passed.
public enum DeskClaudeCheck: String, Equatable, Sendable, CaseIterable {
    case passed
    case cliMissing = "cli-missing"
    case cliVersionMismatch = "cli-version-mismatch"
    case providerOverride = "provider-override"
    case signedOut = "signed-out"
    case notSubscription = "not-subscription"
    case checkFailed = "check-failed"
}

/// How one confirmation attempt ended.
public enum DeskPaidUsageConfirmResult: Equatable, Sendable {
    case confirmed
    case alreadyActive
    case inProgress
    case checksFailed(DeskClaudeCheck)
    case notAuthenticated
    case authenticationUnavailable
    /// A lock, sleep, logout, window close, quit, paid-overflow end, or a
    /// change of Claude Code or its login while it was pending: the result
    /// was discarded.
    case interrupted
}

/// The owner, as the window's controls drive it.
@MainActor
public protocol DeskPaidUsageControlling: AnyObject {
    var state: DeskPaidUsageState { get }
    /// An attempt is under way.
    var isConfirming: Bool { get }
    /// Called on the main thread after the state or an attempt changes.
    var onChange: (@MainActor () -> Void)? { get set }
    /// Section 5's local checks, fresh; no Desk, store or Keychain needed.
    func checkClaude() async -> DeskClaudeCheck
    /// The local checks, then one LocalAuthentication request, then the
    /// checks again. Called only after the statement sheet's continue, on
    /// the main actor right after the window's open-Desk check: the attempt
    /// must be under way (`isConfirming`, abandoned by a lock or close)
    /// before its first suspension.
    func confirm() async -> DeskPaidUsageConfirmResult
    /// A Desk lock, window close or quit: discards any pending result.
    func abandonPendingConfirmation()
}

/// The statement the owner reads before macOS's request to confirm it's him.
@MainActor
public protocol DeskPaidUsageStatementPrompting: AnyObject {
    /// True when he chose to continue.
    func ask(in window: NSWindow) async -> Bool
    /// Ends an open statement as Cancel (a lock or close arrived).
    func dismiss()
}

/// The words of the controls. They never say the setting was checked by
/// True Convo, that a run costs nothing, or that it is without charge: True
/// Convo cannot see the billing setting, and says so. Plain words for
/// The owner: macOS's request is "macOS asks you to confirm it's you", never
/// the framework's name.
public enum DeskPaidUsageWording {
    public static let checkButton = "Check Claude"
    public static let confirmButton = "Confirm paid usage is off…"
    public static let checking = "Checking Claude…"
    /// From the statement's continue: the local checks come first, then
    /// macOS's request.
    public static let confirming = "Checking Claude, then macOS asks you to confirm it's you…"

    public static let statementMessage = "Check paid usage yourself first"
    public static let statementDetail = """
        Open claude.ai Settings > Usage and check that paid usage (usage credits) is off. \
        True Convo cannot see your billing setting. \
        Next, macOS asks you to confirm it's you, with your Mac login password \
        or an Apple Watch where your Mac allows it. \
        The confirmation covers at most five runs in this launch. \
        It ends when the screen locks, the Mac or its screens sleep, you log out or quit, \
        Claude Code or its login or account changes, or paid usage may have been used.
        """
    public static let statementContinue = "I Checked, Continue…"
    public static let statementCancel = "Cancel"

    public static let unconfirmedLine = "Paid usage: not yet confirmed in this launch."
    public static let billingCaveat = "True Convo cannot see your billing setting."

    /// The state line. `time` formats the confirmation's time for display.
    public static func stateLine(_ state: DeskPaidUsageState, time: (Date) -> String) -> String {
        switch state {
        case .unconfirmed:
            return unconfirmedLine
        case .active(let confirmedAt, let runsLeft):
            let runs = runsLeft == 1 ? "1 run left." : "\(runsLeft) runs left."
            return "You confirmed paid usage was off at \(time(confirmedAt)). \(billingCaveat) \(runs)"
        case .ended(.paidOverflow):
            // Not an invitation to confirm again (Codex F0 answer 8: stop,
            // inspect and review first).
            return "Paid usage confirmation ended, \(why(.paidOverflow)). Send stays off. "
                + "Check claude.ai Settings > Usage; the trial needs review before you confirm again."
        case .ended(let end):
            return "Paid usage confirmation ended, \(why(end)). Send stays off until you confirm again."
        }
    }

    /// Why a confirmation ended, in plain words.
    public static func why(_ end: DeskPaidUsageEnd) -> String {
        switch end {
        case .lock: return "the screen locked or another user took over"
        case .sleep: return "the Mac or its screens slept"
        case .logout: return "the Mac began to log out or power off"
        case .cliChanged: return "Claude Code changed"
        case .loginChanged: return "the Claude login or account changed"
        case .runLimit: return "its five runs have started"
        case .paidOverflow: return "paid usage may have been used"
        }
    }

    /// What "Check Claude" found.
    public static func checkLine(_ check: DeskClaudeCheck) -> String {
        switch check {
        case .passed: return "Claude checks passed."
        case .cliMissing: return "Claude Code 2.1.283 was not found on this Mac."
        case .cliVersionMismatch: return "The installed Claude Code is not version 2.1.283."
        case .providerOverride: return "Claude Code is set to use an API key or another provider."
        case .signedOut: return "Claude Code is signed out."
        case .notSubscription: return "Claude Code is not signed in with a claude.ai plan."
        case .checkFailed: return "The Claude check could not finish."
        }
    }

    /// What a confirmation attempt adds below the state line, if anything.
    public static func resultLine(_ result: DeskPaidUsageConfirmResult) -> String? {
        switch result {
        case .confirmed, .alreadyActive, .inProgress:
            return nil
        case .checksFailed(let check):
            return "Not confirmed. \(checkLine(check))"
        case .notAuthenticated:
            return "Not confirmed: confirming it's you was cancelled or did not succeed."
        case .authenticationUnavailable:
            return "Not confirmed: this Mac cannot ask you to confirm it's you right now."
        case .interrupted:
            return "Not confirmed: something changed before it finished (a lock, sleep, the window closing, "
                + "or a change to Claude Code or its login). Try again."
        }
    }

    /// Every fixed string, for the wording scan.
    static var allFixed: [String] {
        [checkButton, confirmButton, checking, confirming, statementMessage, statementDetail, statementContinue,
         statementCancel, unconfirmedLine, billingCaveat]
    }
}

/// The real statement: a sheet on the Desk window, Cancel the default.
@MainActor
public final class SheetPaidUsageStatement: DeskPaidUsageStatementPrompting {
    private var open: (alert: NSAlert, window: NSWindow)?

    public init() {}

    public func ask(in window: NSWindow) async -> Bool {
        dismiss()
        let alert = NSAlert()
        alert.messageText = DeskPaidUsageWording.statementMessage
        alert.informativeText = DeskPaidUsageWording.statementDetail
        alert.addButton(withTitle: DeskPaidUsageWording.statementCancel)
        alert.addButton(withTitle: DeskPaidUsageWording.statementContinue)
        return await withCheckedContinuation { continuation in
            open = (alert, window)
            alert.beginSheetModal(for: window) { [weak self, weak alert] response in
                MainActor.assumeIsolated {
                    if let self, let alert, self.open?.alert === alert { self.open = nil }
                }
                continuation.resume(returning: response == .alertSecondButtonReturn)
            }
        }
    }

    public func dismiss() {
        guard let (alert, window) = open else { return }
        open = nil
        window.endSheet(alert.window, returnCode: .alertFirstButtonReturn)
    }
}
