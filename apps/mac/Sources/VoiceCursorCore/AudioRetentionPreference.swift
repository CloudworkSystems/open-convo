import Foundation

/// Retaining a dictation recording requires a saved choice to turn it on.
/// Reading the preference never changes an existing choice or recording.
public enum AudioRetentionPreference {
    public static let key = "retainAudioForHarvest"

    public static func isEnabled(in defaults: UserDefaults) -> Bool {
        defaults.bool(forKey: key)
    }

    public static func setEnabled(_ enabled: Bool, in defaults: UserDefaults) {
        defaults.set(enabled, forKey: key)
    }
}
