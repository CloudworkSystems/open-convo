import Foundation
import Testing
@testable import VoiceCursorCore

@Suite("Audio retention preference")
struct AudioRetentionPreferenceTests {
    @Test("A fresh preference is off and reading it saves no choice")
    func freshPreferenceIsOff() {
        let suiteName = "AudioRetentionPreferenceTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(defaults.object(forKey: AudioRetentionPreference.key) == nil)
        #expect(!AudioRetentionPreference.isEnabled(in: defaults))
        #expect(defaults.object(forKey: AudioRetentionPreference.key) == nil)
    }

    @Test("An existing audio choice survives reopening preferences", arguments: [true, false])
    func existingChoiceIsPreserved(enabled: Bool) {
        let suiteName = "AudioRetentionPreferenceTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        defaults.set(enabled, forKey: "retainAudioForHarvest")
        let reopened = UserDefaults(suiteName: suiteName)!

        #expect(AudioRetentionPreference.isEnabled(in: reopened) == enabled)
        #expect(reopened.object(forKey: "retainAudioForHarvest") != nil)
        #expect(reopened.bool(forKey: "retainAudioForHarvest") == enabled)
    }

    @Test("Choosing retention writes the existing preference key", arguments: [true, false])
    func explicitChoiceUsesExistingKey(enabled: Bool) {
        let suiteName = "AudioRetentionPreferenceTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        AudioRetentionPreference.setEnabled(enabled, in: defaults)

        #expect(defaults.object(forKey: "retainAudioForHarvest") != nil)
        #expect(defaults.bool(forKey: "retainAudioForHarvest") == enabled)
    }
}
