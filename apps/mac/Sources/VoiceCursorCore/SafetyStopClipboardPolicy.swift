import Foundation

/// Where the finished text goes after a safety stop (a click, another key,
/// or a different app in front kept it from being typed), and what to tell
/// The owner. Pure rules, so the policy check can prove them.
public enum SafetyStopClipboardPolicy {
    public enum Fallback: Equatable {
        /// Nothing was typed. The text goes on the clipboard, and the note
        /// says to press Cmd+V.
        case clipboardNothingTyped
        /// Nothing was typed, and the owner copied or cut something during the
        /// dictation, so his clipboard is left alone.
        case clipboardKeptNothingTyped
        /// Live words are already in the app. The full version goes on the
        /// clipboard, and the note never says to paste (that would add the
        /// dictation a second time).
        case liveWordsKeptFullVersionOnClipboard
        /// Live words are already in the app, and the owner copied or cut
        /// something during the dictation, so his clipboard is left alone.
        case liveWordsKeptClipboardKept

        public var writesClipboard: Bool {
            self == .clipboardNothingTyped || self == .liveWordsKeptFullVersionOnClipboard
        }
    }

    public static func fallback(
        liveWordsInApp: Bool,
        clipboardChangedDuringDictation: Bool
    ) -> Fallback {
        switch (liveWordsInApp, clipboardChangedDuringDictation) {
        case (false, false): return .clipboardNothingTyped
        case (false, true): return .clipboardKeptNothingTyped
        case (true, false): return .liveWordsKeptFullVersionOnClipboard
        case (true, true): return .liveWordsKeptClipboardKept
        }
    }

    /// Cmd+C or Cmd+X, judged by the letter typed so other keyboard layouts
    /// work too. Such a press may fill the clipboard a moment later, so it
    /// counts as a clipboard change even before the change shows up.
    public static func isCopyOrCutShortcut(characters: String?, commandDown: Bool) -> Bool {
        guard commandDown, let key = characters?.lowercased() else { return false }
        return key == "c" || key == "x"
    }

    /// The clipboard changed during the dictation if its change count moved
    /// since the start (True Convo's own writes move the start mark), or a
    /// copy or cut shortcut was pressed.
    public static func clipboardChangedDuringDictation(
        changeCountAtStart: Int?,
        changeCountNow: Int,
        sawCopyOrCutShortcut: Bool
    ) -> Bool {
        if sawCopyOrCutShortcut { return true }
        guard let changeCountAtStart else { return false }
        return changeCountNow != changeCountAtStart
    }

    /// Pasteboard types (nspasteboard.org conventions) that ask clipboard
    /// managers not to record the text and to treat it as private.
    public static let transientPasteboardType = "org.nspasteboard.TransientType"
    public static let concealedPasteboardType = "org.nspasteboard.ConcealedType"
}
