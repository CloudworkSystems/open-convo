import Foundation

/// Production dictation preferences, injectable without opening the app's domain.
public final class DictationPreferences {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults) { self.defaults = defaults }

    public var retainAudioForHarvest: Bool {
        get { AudioRetentionPreference.isEnabled(in: defaults) }
        set { AudioRetentionPreference.setEnabled(newValue, in: defaults) }
    }

    public var savedRetentionNotice: String? {
        guard defaults.object(forKey: AudioRetentionPreference.key) != nil, retainAudioForHarvest else { return nil }
        return "Recording retention is enabled by a saved setting. Earlier versions may have enabled it; you can turn it off here. Existing recordings are unchanged."
    }

    /// The actual Hermes preset used by the app. Retention is a separate choice.
    public func applyHermesRecommendedSettings() {
        let settings: [String: Any] = [
            "provider": "local-whisper", "localWhisperModel": "small", "archiveAudioFormat": "flac",
            "completionAction": "auto-paste", "hotKeyMode": "press-to-toggle", "pillBehavior": "one-shot",
            "autoStop": false, "livePasteAppleFinals": false, "liveInsertApplePartials": false,
            "insertionMode": "final-paste-only", "finalRewriteMode": "keep-live-text",
            "captureSelectionCorrections": false, "spokenPunctuationCommands": false, "wakeSensitivity": "quiet",
        ]
        for (key, value) in settings { defaults.set(value, forKey: key) }
    }
}
