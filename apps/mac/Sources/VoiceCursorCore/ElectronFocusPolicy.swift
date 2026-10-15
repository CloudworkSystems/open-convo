import Foundation

/// Rules for finding the text box in apps built on Electron (Claude, Codex,
/// Grok Bot and others), and for "Paste and Submit" timing. Pure rules, so
/// tests can prove them without touching a real app.
///
/// Why: Electron keeps its Accessibility tree switched off until an assistive
/// app asks for it by setting `AXManualAccessibility` on the app. Until the
/// tree is built, asking for the focused text box fails with "no value"
/// (-25212), so the pill falls back to a blind Cmd+V it cannot confirm.
public enum ElectronFocusPolicy {
    /// The attribute Electron (and Chromium) watch for. Setting it on a native
    /// app is harmless: the app ignores it.
    public static let manualAccessibilityAttribute = "AXManualAccessibility"

    /// Accessibility error codes that can mean "the tree is still waking up",
    /// so one short retry is worth it: no value (-25212), API disabled for
    /// this app (-25211), and cannot complete (-25204, the app was busy).
    public static let retryableStatusCodes: Set<Int32> = [-25212, -25211, -25204]

    /// Waits before each retry, in seconds. Kept short and bounded (0.18 s in
    /// total, under the 0.25 s ceiling) because the capture runs as dictation
    /// starts and the owner should not feel it.
    public static let retryDelays: [TimeInterval] = [0.06, 0.12]

    /// The most extra waiting a capture may add, in seconds.
    public static let maximumTotalRetryWait: TimeInterval = 0.25

    /// How long to wait before retry number `retriesSoFar + 1` after a failed
    /// focus query, or nil to give up. Only "waking up" codes are retried.
    public static func retryDelay(afterFailedStatus status: Int32, retriesSoFar: Int) -> TimeInterval? {
        guard retryableStatusCodes.contains(status) else { return nil }
        guard retriesSoFar >= 0, retriesSoFar < retryDelays.count else { return nil }
        return retryDelays[retriesSoFar]
    }
}

/// When "Paste and Submit" presses Return. Return must follow the paste that
/// actually happened, never a separate timer started when the paste was only
/// requested (the paste itself can land 0.2 s or more later, after the target
/// app is brought forward).
public enum PasteSubmitSequencing {
    /// What the paste step ended up doing.
    public enum PasteStep: Equatable {
        /// The text went straight into the focused text box.
        case insertedThroughAccessibility
        /// Cmd+V was sent (the app could not confirm the paste).
        case keystrokePosted
        /// Nothing was sent to the app; the text only went to the clipboard
        /// (for example, Accessibility is off or the Desk was in front).
        case clipboardOnly
        /// The paste never ran (it was cancelled, or no keystroke could be made).
        case notPerformed
    }

    /// The pause between the paste landing and Return, so the app has taken
    /// the pasted text before it is sent.
    public static let settleDelayAfterPaste: TimeInterval = 0.15

    /// Return is pressed only when something was actually put into the app.
    /// Pressing it otherwise could send an empty or half-typed message.
    public static func shouldPressReturn(after step: PasteStep) -> Bool {
        switch step {
        case .insertedThroughAccessibility, .keystrokePosted: return true
        case .clipboardOnly, .notPerformed: return false
        }
    }
}
