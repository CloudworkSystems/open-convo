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
        /// A newer dictation or a different app took over the target before
        /// the paste ran, so it was not typed (the text went to the clipboard).
        case superseded
    }

    /// The pause between the paste landing and Return, so the app has taken
    /// the pasted text before it is sent.
    public static let settleDelayAfterPaste: TimeInterval = 0.15

    /// Return is pressed only when something was actually put into the app.
    /// Pressing it otherwise could send an empty or half-typed message.
    public static func shouldPressReturn(after step: PasteStep) -> Bool {
        switch step {
        case .insertedThroughAccessibility, .keystrokePosted: return true
        case .clipboardOnly, .notPerformed, .superseded: return false
        }
    }
}

/// Which target (app and text box) a delayed paste or Return belongs to.
///
/// Why: the paste and the Return that follows it run up to about half a
/// second after a dictation finishes. By then the owner may have started a
/// new dictation, or another app may have become the target. Each new target
/// moves the generation on; a delayed step carries the generation it was
/// requested under and only runs if that is still the current one, so it can
/// never type or press Return into the newer target.
public struct PasteTargetGeneration: Equatable {
    public private(set) var value: Int

    public init(value: Int = 0) {
        self.value = value
    }

    /// A new target was chosen (a new dictation or correction, or a different
    /// app became the target).
    public mutating func advance() {
        value &+= 1
    }

    /// True when a step requested under `token` still belongs to the current
    /// target.
    public func isCurrent(_ token: Int) -> Bool {
        token == value
    }

    /// The target changes only when it is a different app (compared by
    /// process ID). Re-choosing the same app (for example when the pill
    /// brings it forward to paste) does not count.
    public static func targetChanged(oldProcessIdentifier: Int32?, newProcessIdentifier: Int32?) -> Bool {
        oldProcessIdentifier != newProcessIdentifier
    }
}

/// How a delayed paste may reach its target app, decided just before it
/// runs. Pure rules, so tests can prove them.
///
/// Why: the paste runs a moment after the target app is brought forward. If
/// that has not finished, or the owner switched apps meanwhile, typing would
/// land in the wrong app, and a text box found earlier might belong to
/// another app. So the text goes into a text box only when it belongs to the
/// target app and that app is in front, and Cmd+V is sent only when the
/// target app is in front.
public enum PasteDeliveryCheck {
    public enum Route: Equatable {
        /// Put the text straight into the text box (Cmd+V if that fails).
        case accessibilityThenKeystroke
        /// No usable text box in the target app, or the app draws its text
        /// boxes with a web engine (see WebEditorDetection): send Cmd+V.
        case keystrokeOnly
        /// The target app is not in front: type nothing, keep the text on
        /// the clipboard for the owner.
        case clipboardOnly
    }

    /// `targetProcessIdentifier` is nil when no target app was captured;
    /// `targetIsRunning` is false when the target app has quit. Either way
    /// nothing is typed: the app now in front is some other app, and Cmd+V
    /// (and a Return after it) must never reach it.
    ///
    /// `targetUsesWebEditor` is true for Electron and Chromium apps. Their
    /// text boxes accept an Accessibility insert and report success without
    /// the page's editor ever seeing the text, so they get Cmd+V only. The
    /// "is it the target, is it in front" checks run first and are unchanged.
    public static func route(
        targetProcessIdentifier: Int32?,
        targetIsRunning: Bool = true,
        frontmostProcessIdentifier: Int32?,
        elementProcessIdentifier: Int32?,
        targetUsesWebEditor: Bool = false
    ) -> Route {
        guard let targetProcessIdentifier, targetIsRunning else { return .clipboardOnly }
        guard frontmostProcessIdentifier == targetProcessIdentifier else { return .clipboardOnly }
        guard !targetUsesWebEditor else { return .keystrokeOnly }
        guard elementProcessIdentifier == targetProcessIdentifier else { return .keystrokeOnly }
        return .accessibilityThenKeystroke
    }
}

/// Tells whether an app draws its text boxes with a web engine (Electron,
/// or Chromium itself). Pure rules, so tests can prove them.
///
/// Why: in these apps the message box is a web page editor (React,
/// ProseMirror and the like). Setting the selected text through
/// Accessibility is handed to the page in the background and reported as
/// a success at once, before the page has done anything with it. The
/// editor keeps its own copy of the text and often never takes the change,
/// so the pill says "pasted" and nothing shows. Cmd+V goes through the
/// page's normal paste handling, which these editors always honour.
///
/// The check reads the app's bundle, not a list of names: every Electron or
/// Chromium app ships a framework holding Chromium's resource pack, even
/// when the framework is renamed (the Codex app ships "Codex Framework").
/// A short list of known apps backs that up.
public enum WebEditorDetection {
    /// A file every Electron and Chromium framework carries in its
    /// Resources folder.
    public static let engineMarkerResource = "chrome_100_percent.pak"

    /// Framework names that are a web engine whatever their contents.
    public static let engineFrameworkNames: Set<String> = [
        "Electron Framework.framework",
        "Chromium Embedded Framework.framework",
    ]

    /// Apps known to be Electron or Chromium, in case the bundle cannot be
    /// read (for example the app moved while it was running).
    public static let knownBundleIdentifiers: Set<String> = [
        "com.anthropic.claudefordesktop", // Claude
        "com.openai.codex", // Codex
        "com.tinyspeck.slackmacgap", // Slack
        "com.microsoft.VSCode", // Visual Studio Code
        "com.todesktop.230313mzl4w4u92", // Cursor
        "com.hnc.Discord", // Discord
        "md.obsidian", // Obsidian
        "com.google.Chrome", // Google Chrome
        "com.brave.Browser", // Brave
        "com.microsoft.edgemac", // Microsoft Edge
        "company.thebrowser.Browser", // Arc
    ]

    /// `frameworkNames` lists the entries in the app's Contents/Frameworks
    /// folder; `frameworkHasEngineMarker` answers whether one of them holds
    /// `engineMarkerResource`. Native apps (TextEdit, Notes, Mail) have no
    /// such framework and keep the Accessibility insert.
    public static func usesWebEditor(
        bundleIdentifier: String?,
        frameworkNames: [String],
        frameworkHasEngineMarker: (String) -> Bool
    ) -> Bool {
        if let bundleIdentifier, knownBundleIdentifiers.contains(bundleIdentifier) { return true }
        for name in frameworkNames where name.hasSuffix(".framework") {
            if engineFrameworkNames.contains(name) || frameworkHasEngineMarker(name) { return true }
        }
        return false
    }
}
