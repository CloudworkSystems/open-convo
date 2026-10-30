import AppKit
import Foundation

// The Desk window's native "Approve Anthropic once" control (the Claude Code
// adapter's PR 4a; contract section 21.4's `host-not-approved`). INACTIVE
// like section 17's controls: `DeskWindowController` shows it only when it is
// given a `DeskHostApprovalControlling`, which defaults to nil and which the
// app never gives before the adapter's PR 4b, so the shipping window shows
// nothing new. Nothing here approves anything by itself: the owner behind it
// writes the protected store, only after the statement sheet's continue,
// with the Desk open. The page can neither give nor withdraw it.

/// The approval as the window shows it, apart from section 5's local checks.
public enum DeskHostApprovalState: Equatable, Sendable {
    case notApproved
    case approved(at: Date)
    /// The protected store could not be read (locked, closed or corrupt):
    /// never approved.
    case unreadable
}

/// How one approve or withdraw ended.
public enum DeskHostApprovalResult: Equatable, Sendable {
    case approved
    case withdrawn
    /// Changed and in effect now, but the Mac could not yet confirm it is
    /// on disk (the store's `replacedUnsynced`).
    case unsynced
    /// The store could not be written: nothing changed.
    case failed
}

/// The owner, as the window's control drives it.
@MainActor
public protocol DeskHostApprovalControlling: AnyObject {
    /// Read on every redraw while the Desk is open; it takes the store's
    /// lock briefly.
    var state: DeskHostApprovalState { get }
    /// Called on the main thread after the state changes.
    var onChange: (@MainActor () -> Void)? { get set }
    /// Saves the approval of Anthropic in the protected store. Called only
    /// after the statement sheet's continue, with the Desk open. It is the
    /// store's durable write, run on the main thread: a one-time owner
    /// action, so a brief wait behind the disk flush is accepted.
    func approve() -> DeskHostApprovalResult
    /// Withdraws it. It stops the next send, never a reply under way.
    func withdraw() -> DeskHostApprovalResult
}

/// Which statement the owner reads first.
public enum DeskHostApprovalStatement: Equatable, Sendable {
    case approve
    case withdraw
}

/// The statement the owner reads before an approval changes.
@MainActor
public protocol DeskHostApprovalStatementPrompting: AnyObject {
    /// True when he chose to continue.
    func ask(_ statement: DeskHostApprovalStatement, in window: NSWindow) async -> Bool
    /// Ends an open statement as Cancel (a lock or close arrived).
    func dismiss()
}

/// The words of the control: what leaves the Mac, where it goes, and what
/// doesn't (the plan's safety model, item 2). They never say a run is free or
/// that True Convo checked the billing setting: paid usage is section 17's,
/// confirmed separately each launch.
public enum DeskHostApprovalWording {
    public static let approveButton = "Approve Anthropic once…"
    public static let withdrawButton = "Withdraw Approval…"

    public static let approveMessage = "Send your Claude conversations to Anthropic?"
    public static let approveDetail = """
        When you send a message to Claude, True Convo sends that message, and the earlier turns of the same \
        conversation counted above the message box, to Anthropic through Claude Code on your Claude plan. \
        They leave this Mac. \
        Nothing else is sent: no files, no other conversations and no memory. \
        This approval stays saved on this Mac until you withdraw it here. \
        Paid usage is confirmed separately, in each launch.
        """
    public static let approveContinue = "Approve Anthropic"
    public static let withdrawMessage = "Stop sending to Anthropic?"
    public static let withdrawDetail = """
        Claude can't receive messages until you approve Anthropic again. \
        Replies already saved stay as they are.
        """
    public static let withdrawContinue = "Withdraw Approval"
    public static let cancel = "Cancel"

    /// The line while the Desk isn't open: nothing of the approval shows.
    public static let lockedLine = "Anthropic: unlock the Desk to see or change the approval."

    /// The state line. `time` formats the approval's time for display.
    public static func stateLine(_ state: DeskHostApprovalState, time: (Date) -> String) -> String {
        switch state {
        case .notApproved:
            return "Anthropic: not approved. Claude can't receive messages until you approve it."
        case .approved(let at):
            return "Anthropic: approved \(time(at)). Messages you send to Claude leave this Mac for Anthropic."
        case .unreadable:
            return "Anthropic: the approval can't be read right now, so Claude stays off."
        }
    }

    /// What an attempt adds below the state line, if anything.
    public static func resultLine(_ result: DeskHostApprovalResult) -> String? {
        switch result {
        case .approved, .withdrawn: return nil
        case .unsynced: return "Changed, but this Mac has not yet confirmed it is saved to disk. Check this line again after a restart."
        case .failed: return "Nothing changed: the approval could not be saved on this Mac."
        }
    }

    /// Every fixed string, for the wording scan.
    static var allFixed: [String] {
        [approveButton, withdrawButton, lockedLine, approveMessage, approveDetail, approveContinue, withdrawMessage, withdrawDetail,
         withdrawContinue, cancel, resultLine(.unsynced)!, resultLine(.failed)!]
    }
}

/// The real statement: a sheet on the Desk window, Cancel the default.
@MainActor
public final class SheetHostApprovalStatement: DeskHostApprovalStatementPrompting {
    private var open: (alert: NSAlert, window: NSWindow)?

    public init() {}

    public func ask(_ statement: DeskHostApprovalStatement, in window: NSWindow) async -> Bool {
        dismiss()
        let alert = NSAlert()
        switch statement {
        case .approve:
            alert.messageText = DeskHostApprovalWording.approveMessage
            alert.informativeText = DeskHostApprovalWording.approveDetail
        case .withdraw:
            alert.messageText = DeskHostApprovalWording.withdrawMessage
            alert.informativeText = DeskHostApprovalWording.withdrawDetail
        }
        alert.addButton(withTitle: DeskHostApprovalWording.cancel)
        alert.addButton(withTitle: statement == .approve ? DeskHostApprovalWording.approveContinue : DeskHostApprovalWording.withdrawContinue)
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
