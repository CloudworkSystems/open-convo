import Foundation

/// Step 1, PR 3: moving between the pill and the Desk. The pill has a Desk
/// button, the Desk has a Shrink to Pill button, and one shortcut toggles
/// between them. Shrinking only hides the Desk window: the Desk stays as it
/// was (open with its draft, or locked), so the Desk button brings it back
/// where it was left. Pure rules, so the policy check and the unit tests can
/// prove them without AppKit.
public enum DeskSwitchPolicy {
    public enum Action: Equatable, Sendable {
        /// Show the Desk window in front, as it was left.
        case showDesk
        /// Hide the Desk window and leave the pill showing.
        case shrinkToPill
        /// This build has no Desk: say so, change nothing.
        case noDesk
    }

    /// What the toggle shortcut does: with the Desk window holding the
    /// focus it shrinks to the pill; otherwise (hidden, behind another
    /// app, or never opened) it shows the Desk.
    public static func toggle(hasDesk: Bool, deskWindowHoldsFocus: Bool) -> Action {
        guard hasDesk else { return .noDesk }
        return deskWindowHoldsFocus ? .shrinkToPill : .showDesk
    }

    /// The pill's Desk button always shows the Desk (when the build has one).
    public static func pillDeskButton(hasDesk: Bool) -> Action {
        hasDesk ? .showDesk : .noDesk
    }

    /// Showing the Desk hides an idle pill, so it does not float over the
    /// Desk; it stays while a dictation runs or finishes, and when the
    /// owner keeps the pill on screen.
    public static func hidesPillWhenShowingDesk(dictationBusy: Bool, pillKeptOnScreen: Bool) -> Bool {
        !dictationBusy && !pillKeptOnScreen
    }

    /// The shortcut's label, shown in the menu.
    public static let shortcutLabel = "Control+Option+Cmd+T"
}
