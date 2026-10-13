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
    /// Desk. It stays while a dictation runs or finishes, while it still
    /// shows an outcome (a warning such as set-aside words must be read),
    /// and when the owner keeps the pill on screen.
    public static func hidesPillWhenShowingDesk(dictationBusy: Bool, pillShowingOutcome: Bool, pillKeptOnScreen: Bool) -> Bool {
        !dictationBusy && !pillShowingOutcome && !pillKeptOnScreen
    }

    /// How the menu item and the pill button name the current choice; Off
    /// is named too, so a disabled shortcut never looks like a missing one.
    public static func shortcutDescription(_ choice: DeskSwitchShortcut) -> String {
        choice == .off ? "Shortcut off" : choice.label
    }

    /// The four-key shortcut's label (kept as a choice in the menu).
    public static let shortcutLabel = "Control+Option+Cmd+T"
}

/// Which shortcut switches between the pill and the Desk (the owner chose
/// double-tapping Right Option on October 13: the four-key shortcut was too
/// far to reach). Chosen in the menu; stored by raw value.
public enum DeskSwitchShortcut: String, CaseIterable, Sendable {
    case doubleTapRightOption = "double-tap-right-option"
    case controlOptionCommandT = "control-option-command-t"
    case off = "off"

    public static let defaultChoice: DeskSwitchShortcut = .doubleTapRightOption

    public var label: String {
        switch self {
        case .doubleTapRightOption: return "Double-Tap Right Option"
        case .controlOptionCommandT: return DeskSwitchPolicy.shortcutLabel
        case .off: return "Off"
        }
    }

    /// A stored value that is missing or unknown falls back to the default.
    public static func stored(_ raw: String?) -> DeskSwitchShortcut {
        raw.flatMap(DeskSwitchShortcut.init(rawValue:)) ?? defaultChoice
    }
}

/// Recognizes a double tap of one modifier key (Right Option): press and
/// release, then press and release again, quickly, with nothing else in
/// between. Holding the key to type (Option+letter), pressing another key or
/// modifier, or pausing too long never counts. Pure, so tests drive it with
/// invented times.
public struct ModifierDoubleTap: Sendable {
    public enum Input: Equatable, Sendable {
        /// The watched modifier went down or up.
        case down(TimeInterval)
        case up(TimeInterval)
        /// Any other key, or another modifier changing.
        case other
    }

    /// The longest a press may be held and still count as a tap.
    public let maxHold: TimeInterval
    /// The longest gap between the first release and the second press.
    public let maxGap: TimeInterval

    private enum State: Equatable, Sendable {
        case idle
        case firstDown(TimeInterval)
        case firstTapped(TimeInterval)
        case secondDown(TimeInterval)
    }
    private var state: State = .idle

    public init(maxHold: TimeInterval = 0.3, maxGap: TimeInterval = 0.35) {
        self.maxHold = maxHold
        self.maxGap = maxGap
    }

    /// Feeds one input; true exactly when it completes a double tap (on the
    /// second release).
    public mutating func handle(_ input: Input) -> Bool {
        switch (state, input) {
        case (_, .other):
            state = .idle
        case (.idle, .down(let t)):
            state = .firstDown(t)
        case (.firstDown(let pressed), .up(let t)):
            state = t - pressed <= maxHold ? .firstTapped(t) : .idle
        case (.firstTapped(let released), .down(let t)):
            state = t - released <= maxGap ? .secondDown(t) : .firstDown(t)
        case (.secondDown(let pressed), .up(let t)):
            state = .idle
            return t - pressed <= maxHold
        case (_, .down(let t)):
            state = .firstDown(t)
        case (_, .up):
            state = .idle
        }
        return false
    }
}
