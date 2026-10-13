import AppKit
import ApplicationServices
import AVFoundation
import Carbon.HIToolbox
import CoreAudio
import CryptoKit
import Foundation
import Darwin
import Security
import ServiceManagement
import Speech
import CorrectionMemory
import DeskWindowKit
import TrueConvoIdentity
import VoiceCursorCore

enum DictationProvider: String, CaseIterable {
    case appleLocal = "apple-local"
    case localWhisper = "local-whisper"
    case openAIRealtime = "openai-realtime"
    case openAICloud = "openai-cloud"
    case groqCloud = "groq-cloud"
    // Kept last so the index of every older case stays the same.
    case appleSpeechAnalyzer = "apple-speech-analyzer"

    var label: String {
        switch self {
        case .appleLocal: return "Local Only (Apple On-Device)"
        case .localWhisper: return "Local Whisper"
        case .openAIRealtime: return "OpenAI Realtime"
        case .openAICloud: return "OpenAI Cloud"
        case .groqCloud: return "Groq Cloud"
        case .appleSpeechAnalyzer: return "Apple On-Device (New)"
        }
    }

    /// Apple's new on-device engine (SpeechAnalyzer) needs macOS 26 or newer.
    var isAvailableOnThisMac: Bool {
        guard self == .appleSpeechAnalyzer else { return true }
        if #available(macOS 26, *) { return true }
        return false
    }

    /// The engines offered in menus and the Settings window on this Mac.
    static var selectableCases: [DictationProvider] {
        allCases.filter(\.isAvailableOnThisMac)
    }

    var isPostStopProvider: Bool {
        self == .localWhisper || self == .openAICloud || self == .groqCloud
    }

    var isLiveStreamingProvider: Bool {
        self == .openAIRealtime
    }

    var requiredAPIKeyName: String? {
        switch self {
        case .openAIRealtime, .openAICloud:
            return "OPENAI_API_KEY"
        case .groqCloud:
            return "GROQ_API_KEY"
        case .appleLocal, .localWhisper, .appleSpeechAnalyzer:
            return nil
        }
    }

    var privacyLabel: String {
        switch self {
        case .appleLocal, .appleSpeechAnalyzer:
            return "Local only"
        case .localWhisper:
            return "Local audio transcription"
        case .openAIRealtime:
            return "Cloud streaming"
        case .openAICloud, .groqCloud:
            return "Cloud audio transcription"
        }
    }
}

enum ArchiveFormat: String, CaseIterable {
    case flac
    case wav

    var label: String {
        switch self {
        case .flac: return "FLAC"
        case .wav: return "WAV"
        }
    }
}

enum CompletionAction: String, CaseIterable {
    case autoPaste = "auto-paste"
    case autoSubmit = "auto-submit"
    case clipboard = "clipboard"
    case archiveOnly = "archive-only"

    var label: String {
        switch self {
        case .autoPaste: return "Paste at Cursor"
        case .autoSubmit: return "Paste and Submit"
        case .clipboard: return "Clipboard Only"
        case .archiveOnly: return "Archive Only"
        }
    }
}

enum CaptureMode: String {
    case appleLive = "apple-live-preview"
    case openAIRealtime = "openai-realtime-stream"
    case recordOnlyFallback = "record-only-fallback"
}

enum HotKeyMode: String, CaseIterable {
    case pressToToggle = "press-to-toggle"
    case holdToRecord = "hold-to-record"

    var label: String {
        switch self {
        case .pressToToggle: return "Press Shortcut to Toggle"
        case .holdToRecord: return "Hold Shortcut to Record"
        }
    }
}

enum PillBehavior: String, CaseIterable {
    case oneShot = "one-shot"
    case persistent = "persistent"

    var label: String {
        switch self {
        case .oneShot: return "One Shot"
        case .persistent: return "Persistent Pill"
        }
    }
}

enum WakeSensitivity: String, CaseIterable {
    case quiet = "quiet"
    case normal = "normal"
    case noisy = "noisy"

    var label: String {
        switch self {
        case .quiet: return "Quiet Mic / Soft Voice"
        case .normal: return "Normal"
        case .noisy: return "Noisy Room / Hot Mic"
        }
    }

    var wakeThreshold: Double {
        switch self {
        case .quiet: return 0.045
        case .normal: return 0.075
        case .noisy: return 0.120
        }
    }

    var spikeThreshold: Double {
        switch self {
        case .quiet: return 0.085
        case .normal: return 0.120
        case .noisy: return 0.180
        }
    }

    var resetThreshold: Double {
        switch self {
        case .quiet: return 0.025
        case .normal: return 0.035
        case .noisy: return 0.060
        }
    }

    var framesToWake: Int {
        switch self {
        case .quiet: return 3
        case .normal: return 4
        case .noisy: return 5
        }
    }
}

enum HotKeyShortcut: String, CaseIterable {
    case commandD = "command-d"
    case commandShiftD = "command-shift-d"
    case commandOptionD = "command-option-d"
    case controlOptionD = "control-option-d"
    case controlOptionSpace = "control-option-space"
    // Reserved for the typed-correction hotkey; excluded from the dictation
    // Shortcut Key menu. Three modifiers so it collides with nothing in
    // Claude, Codex, or VS Code.
    case controlOptionCommandC = "control-option-command-c"
    // Reserved for switching between the pill and the Desk (step 1, PR 3);
    // excluded from the dictation Shortcut Key menu like the one above.
    case controlOptionCommandT = "control-option-command-t"

    /// The shortcuts kept for other jobs, never offered for dictation.
    static let reserved: Set<HotKeyShortcut> = [.controlOptionCommandC, .controlOptionCommandT]

    var label: String {
        switch self {
        case .commandD: return "Cmd+D"
        case .commandShiftD: return "Cmd+Shift+D"
        case .commandOptionD: return "Cmd+Option+D"
        case .controlOptionD: return "Control+Option+D"
        case .controlOptionSpace: return "Control+Option+Space"
        case .controlOptionCommandC: return "Control+Option+Cmd+C"
        case .controlOptionCommandT: return DeskSwitchPolicy.shortcutLabel
        }
    }

    var keyCode: UInt32 {
        switch self {
        case .commandD, .commandShiftD, .commandOptionD, .controlOptionD:
            return UInt32(kVK_ANSI_D)
        case .controlOptionSpace:
            return UInt32(kVK_Space)
        case .controlOptionCommandC:
            return UInt32(kVK_ANSI_C)
        case .controlOptionCommandT:
            return UInt32(kVK_ANSI_T)
        }
    }

    var carbonModifiers: UInt32 {
        switch self {
        case .commandD:
            return UInt32(cmdKey)
        case .commandShiftD:
            return UInt32(cmdKey | shiftKey)
        case .commandOptionD:
            return UInt32(cmdKey | optionKey)
        case .controlOptionD, .controlOptionSpace:
            return UInt32(controlKey | optionKey)
        case .controlOptionCommandC, .controlOptionCommandT:
            return UInt32(controlKey | optionKey | cmdKey)
        }
    }

    var eventModifiers: NSEvent.ModifierFlags {
        switch self {
        case .commandD:
            return [.command]
        case .commandShiftD:
            return [.command, .shift]
        case .commandOptionD:
            return [.command, .option]
        case .controlOptionD, .controlOptionSpace:
            return [.control, .option]
        case .controlOptionCommandC, .controlOptionCommandT:
            return [.control, .option, .command]
        }
    }

    func matches(keyCode: UInt16, modifiers: NSEvent.ModifierFlags) -> Bool {
        UInt32(keyCode) == self.keyCode
            && modifiers.intersection([.command, .shift, .control, .option]) == eventModifiers
    }
}

enum InsertionMode: String, CaseIterable {
    case auto = "auto"
    case accessibility = "accessibility"
    case keyboardCompatibility = "keyboard-compatibility"
    case finalPasteOnly = "final-paste-only"

    var label: String {
        switch self {
        case .auto: return "Auto"
        case .accessibility: return "Accessibility"
        case .keyboardCompatibility: return "Keyboard Compatibility"
        case .finalPasteOnly: return "Final Paste Only"
        }
    }
}

enum InsertionTiming: String, CaseIterable {
    case liveTypewriter = "live-typewriter"
    case finalPasteOnly = "final-paste-only"

    var label: String {
        switch self {
        case .liveTypewriter: return "Live Typewriter"
        case .finalPasteOnly: return "Final Paste Only"
        }
    }

    static var current: InsertionTiming {
        if Settings.insertionMode == .finalPasteOnly || !Settings.liveInsertApplePartials {
            return .finalPasteOnly
        }
        return .liveTypewriter
    }

    func apply() {
        switch self {
        case .liveTypewriter:
            Settings.liveInsertApplePartials = true
            Settings.livePasteAppleFinals = false
            if Settings.insertionMode == .finalPasteOnly {
                Settings.insertionMode = .auto
            }
        case .finalPasteOnly:
            Settings.liveInsertApplePartials = false
            Settings.livePasteAppleFinals = false
            Settings.insertionMode = .finalPasteOnly
        }
    }
}

enum FinalRewriteMode: String, CaseIterable {
    case keepLiveText = "keep-live-text"
    case rewriteLiveText = "rewrite-live-text"

    var label: String {
        switch self {
        case .keepLiveText: return "Keep Live Text"
        case .rewriteLiveText: return "Rewrite With Final Transcript"
        }
    }
}

struct ModelPreset {
    let id: String
    let label: String
    let provider: DictationProvider
    let model: String?

    static let all: [ModelPreset] = [
        ModelPreset(id: "apple-local", label: "Local Only / Apple On-Device", provider: .appleLocal, model: nil),
        ModelPreset(id: "apple-speech-analyzer", label: "Local Only / Apple On-Device (New)", provider: .appleSpeechAnalyzer, model: nil),
        ModelPreset(id: "local-whisper:tiny", label: "Local Whisper / tiny", provider: .localWhisper, model: "tiny"),
        ModelPreset(id: "local-whisper:base", label: "Local Whisper / base", provider: .localWhisper, model: "base"),
        ModelPreset(id: "local-whisper:small", label: "Local Whisper / small", provider: .localWhisper, model: "small"),
        ModelPreset(id: "local-whisper:medium", label: "Local Whisper / medium", provider: .localWhisper, model: "medium"),
        ModelPreset(id: "openai-realtime:gpt-realtime-whisper", label: "OpenAI Realtime / gpt-realtime-whisper", provider: .openAIRealtime, model: "gpt-realtime-whisper"),
        ModelPreset(id: "openai-cloud:gpt-4o-mini-transcribe", label: "OpenAI / gpt-4o-mini-transcribe", provider: .openAICloud, model: "gpt-4o-mini-transcribe"),
        ModelPreset(id: "openai-cloud:gpt-4o-transcribe", label: "OpenAI / gpt-4o-transcribe", provider: .openAICloud, model: "gpt-4o-transcribe"),
        ModelPreset(id: "groq-cloud:whisper-large-v3-turbo", label: "Groq / whisper-large-v3-turbo", provider: .groqCloud, model: "whisper-large-v3-turbo"),
        ModelPreset(id: "groq-cloud:whisper-large-v3", label: "Groq / whisper-large-v3", provider: .groqCloud, model: "whisper-large-v3"),
    ]

    /// The presets offered in menus on this Mac.
    static var selectable: [ModelPreset] {
        all.filter { $0.provider.isAvailableOnThisMac }
    }

    static func byId(_ id: String) -> ModelPreset? {
        all.first { $0.id == id }
    }

    static func currentId() -> String {
        switch Settings.provider {
        case .appleLocal:
            return "apple-local"
        case .localWhisper:
            return "local-whisper:\(Settings.localWhisperModel)"
        case .openAIRealtime:
            return "openai-realtime:\(Settings.openAIRealtimeModel)"
        case .openAICloud:
            return "openai-cloud:\(Settings.openAIModel)"
        case .groqCloud:
            return "groq-cloud:\(Settings.groqModel)"
        case .appleSpeechAnalyzer:
            return "apple-speech-analyzer"
        }
    }

    func apply() {
        Settings.provider = provider
        switch provider {
        case .appleLocal:
            break
        case .localWhisper:
            if let model { Settings.localWhisperModel = model }
        case .openAIRealtime:
            if let model { Settings.openAIRealtimeModel = model }
        case .openAICloud:
            if let model { Settings.openAIModel = model }
        case .groqCloud:
            if let model { Settings.groqModel = model }
        case .appleSpeechAnalyzer:
            break
        }
    }
}

enum Settings {
    // `com.trueconvo.voice-cursor` for the real app (and `swift run`); True
    // Convo Test has its own domain, so it never reads or changes these.
    private static let defaults =
        UserDefaults(suiteName: AppIdentity.current.settingsDomain) ?? .standard

    /// When the most recent real dictation (not a typed correction or a
    /// reprocessed copy) was saved. Shown in the menu so a quiet app is noticed.
    static var lastDictationAt: Date? {
        get { defaults.object(forKey: "lastDictationAt") as? Date }
        set { defaults.set(newValue, forKey: "lastDictationAt") }
    }

    static var language: String {
        get {
            defaults.string(forKey: "language") ?? "en-US"
        }
        set {
            defaults.set(newValue, forKey: "language")
        }
    }

    static var provider: DictationProvider {
        get {
            let stored = DictationProvider(rawValue: defaults.string(forKey: "provider") ?? "") ?? .appleLocal
            // Apple On-Device (New) is hidden below macOS 26; fall back to the older Apple engine there.
            return stored.isAvailableOnThisMac ? stored : .appleLocal
        }
        set {
            defaults.set(newValue.rawValue, forKey: "provider")
        }
    }

    static var archiveFormat: ArchiveFormat {
        get {
            ArchiveFormat(rawValue: defaults.string(forKey: "archiveAudioFormat") ?? "") ?? .flac
        }
        set {
            defaults.set(newValue.rawValue, forKey: "archiveAudioFormat")
        }
    }

    // Core owns the production getter and preset, so isolated tests exercise
    // exactly the code used here without reading the owner's preference domain.
    static let dictationPreferences = DictationPreferences(defaults: defaults)

    /// Apple On-Device (New) never writes a recording, whatever Retain Audio says.
    static var providerMakesNoRecording: Bool {
        provider == .appleSpeechAnalyzer
    }

    /// Whether dictations with the current engine keep their audio.
    static var audioIsRetainedForCurrentProvider: Bool {
        dictationPreferences.retainAudioForHarvest && !providerMakesNoRecording
    }

    static var completionAction: CompletionAction {
        get {
            CompletionAction(rawValue: defaults.string(forKey: "completionAction") ?? "") ?? .autoPaste
        }
        set {
            defaults.set(newValue.rawValue, forKey: "completionAction")
        }
    }

    static var autoStop: Bool {
        get {
            defaults.bool(forKey: "autoStop")
        }
        set {
            defaults.set(newValue, forKey: "autoStop")
        }
    }

    static var autoStopDelaySeconds: Double {
        get {
            let value = defaults.double(forKey: "autoStopDelaySeconds")
            return value > 0 ? value : 2.6
        }
        set {
            defaults.set(min(max(newValue, 0.5), 5.0), forKey: "autoStopDelaySeconds")
        }
    }

    static var pillBehavior: PillBehavior {
        get {
            PillBehavior(rawValue: defaults.string(forKey: "pillBehavior") ?? "") ?? .oneShot
        }
        set {
            defaults.set(newValue.rawValue, forKey: "pillBehavior")
        }
    }

    static var wakeSensitivity: WakeSensitivity {
        get {
            WakeSensitivity(rawValue: defaults.string(forKey: "wakeSensitivity") ?? "") ?? .normal
        }
        set {
            defaults.set(newValue.rawValue, forKey: "wakeSensitivity")
        }
    }

    static var pillWindowOrigin: NSPoint? {
        get {
            guard defaults.object(forKey: "pillWindowOriginX") != nil,
                  defaults.object(forKey: "pillWindowOriginY") != nil
            else { return nil }
            return NSPoint(
                x: defaults.double(forKey: "pillWindowOriginX"),
                y: defaults.double(forKey: "pillWindowOriginY")
            )
        }
        set {
            guard let newValue else {
                defaults.removeObject(forKey: "pillWindowOriginX")
                defaults.removeObject(forKey: "pillWindowOriginY")
                return
            }
            defaults.set(Double(newValue.x), forKey: "pillWindowOriginX")
            defaults.set(Double(newValue.y), forKey: "pillWindowOriginY")
        }
    }

    static var livePasteAppleFinals: Bool {
        get {
            defaults.bool(forKey: "livePasteAppleFinals")
        }
        set {
            defaults.set(newValue, forKey: "livePasteAppleFinals")
        }
    }

    static var liveInsertApplePartials: Bool {
        get {
            defaults.bool(forKey: "liveInsertApplePartials")
        }
        set {
            defaults.set(newValue, forKey: "liveInsertApplePartials")
        }
    }

    static var insertionMode: InsertionMode {
        get {
            InsertionMode(rawValue: defaults.string(forKey: "insertionMode") ?? "") ?? .finalPasteOnly
        }
        set {
            defaults.set(newValue.rawValue, forKey: "insertionMode")
        }
    }

    static var audioInputDeviceUID: String {
        get {
            defaults.string(forKey: "audioInputDeviceUID") ?? AudioDeviceInfo.systemDefaultUID
        }
        set {
            defaults.set(newValue, forKey: "audioInputDeviceUID")
        }
    }

    static var finalRewriteMode: FinalRewriteMode {
        get {
            FinalRewriteMode(rawValue: defaults.string(forKey: "finalRewriteMode") ?? "") ?? .keepLiveText
        }
        set {
            defaults.set(newValue.rawValue, forKey: "finalRewriteMode")
        }
    }

    static var captureSelectionCorrections: Bool {
        get {
            if defaults.object(forKey: "captureSelectionCorrections") == nil {
                return false
            }
            return defaults.bool(forKey: "captureSelectionCorrections")
        }
        set {
            defaults.set(newValue, forKey: "captureSelectionCorrections")
        }
    }

    static var spokenPunctuationCommands: Bool {
        get {
            if defaults.object(forKey: "spokenPunctuationCommands") == nil {
                return false
            }
            return defaults.bool(forKey: "spokenPunctuationCommands")
        }
        set {
            defaults.set(newValue, forKey: "spokenPunctuationCommands")
        }
    }

    static var scopeAmplitudeGain: Double {
        get {
            let value = defaults.double(forKey: "scopeAmplitudeGain")
            return value > 0 ? min(max(value, 0.6), 2.4) : 1.25
        }
        set {
            defaults.set(min(max(newValue, 0.6), 2.4), forKey: "scopeAmplitudeGain")
        }
    }

    static var scopeSweepSpeed: Double {
        get {
            let value = defaults.double(forKey: "scopeSweepSpeed")
            return value > 0 ? min(max(value, 0.6), 36.0) : 24.0
        }
        set {
            defaults.set(min(max(newValue, 0.6), 36.0), forKey: "scopeSweepSpeed")
        }
    }

    static var localWhisperModel: String {
        get {
            defaults.string(forKey: "localWhisperModel") ?? "small"
        }
        set {
            defaults.set(newValue, forKey: "localWhisperModel")
        }
    }

    static var openAIModel: String {
        get {
            defaults.string(forKey: "openaiModel") ?? "gpt-4o-mini-transcribe"
        }
        set {
            defaults.set(newValue, forKey: "openaiModel")
        }
    }

    static var openAIRealtimeModel: String {
        get {
            defaults.string(forKey: "openaiRealtimeModel") ?? "gpt-realtime-whisper"
        }
        set {
            defaults.set(newValue, forKey: "openaiRealtimeModel")
        }
    }

    static var openAIRealtimeDelay: String {
        get {
            defaults.string(forKey: "openaiRealtimeDelay") ?? "low"
        }
        set {
            let allowed = ["minimal", "low", "medium", "high", "xhigh"]
            defaults.set(allowed.contains(newValue) ? newValue : "low", forKey: "openaiRealtimeDelay")
        }
    }

    static var groqModel: String {
        get {
            defaults.string(forKey: "groqModel") ?? "whisper-large-v3-turbo"
        }
        set {
            defaults.set(newValue, forKey: "groqModel")
        }
    }

    static var whisperBinary: String {
        get {
            defaults.string(forKey: "whisperBinary") ?? "/opt/homebrew/bin/whisper"
        }
        set {
            defaults.set(newValue, forKey: "whisperBinary")
        }
    }

    static var ffmpegBinary: String {
        get {
            defaults.string(forKey: "ffmpegBinary") ?? "/opt/homebrew/bin/ffmpeg"
        }
        set {
            defaults.set(newValue, forKey: "ffmpegBinary")
        }
    }

    static var hasShownFirstRunChecklist: Bool {
        get {
            defaults.bool(forKey: "hasShownFirstRunChecklist")
        }
        set {
            defaults.set(newValue, forKey: "hasShownFirstRunChecklist")
        }
    }

    static var hotKeyMode: HotKeyMode {
        get {
            HotKeyMode(rawValue: defaults.string(forKey: "hotKeyMode") ?? "") ?? .pressToToggle
        }
        set {
            defaults.set(newValue.rawValue, forKey: "hotKeyMode")
        }
    }

    static var hotKeyShortcut: HotKeyShortcut {
        get {
            HotKeyShortcut(rawValue: defaults.string(forKey: "hotKeyShortcut") ?? "") ?? .commandD
        }
        set {
            defaults.set(newValue.rawValue, forKey: "hotKeyShortcut")
        }
    }

    /// Convo Cursor's old word list. Read once to import into Saved Fixes;
    /// nothing writes it anymore.
    static var personalAutoCorrections: [String: String] {
        (defaults.dictionary(forKey: "personalAutoCorrections") as? [String: String]) ?? [:]
    }

    static var savedFixesLegacyImportDone: Bool {
        get { defaults.bool(forKey: "savedFixesLegacyImportDone") }
        set { defaults.set(newValue, forKey: "savedFixesLegacyImportDone") }
    }
}

/// Saved fixes ("remember this correction"). Backed by the CorrectionMemory
/// engine brought over from Beta Zero. This exists for words a speech engine
/// can never hear right ("Marlowe" and "Marlo" sound the same), so the fix is
/// taught by typing. Fixes apply in every app (The owner's choice, 2026-09-27).
/// A finished dictation gets them once, counting uses (that rewrites the
/// lessons file). Finalized segments pasted live and reprocessed archive text
/// get a no-write preview. Live partial text never gets them.
enum SavedCorrections {
    enum RememberResult {
        case saved
        case updated
        case unchanged
        case failed
    }

    static var directory: URL {
        Archive.root.appendingPathComponent("corrections", isDirectory: true)
    }

    private static let lock = NSLock()
    private static var openedStore: CorrectionLessonStore?

    /// Runs `body` with the store while holding the lock; nil if it can't open.
    private static func withStore<T>(_ body: (CorrectionLessonStore) -> T) -> T? {
        lock.lock()
        defer { lock.unlock() }
        if openedStore == nil {
            do {
                let store = try CorrectionLessonStore(directory: directory)
                openedStore = store
                importLegacyRules(into: store)
            } catch {
                RunLog.write("saved-fixes.open.failed", "error=\(logSafe(error))")
                return nil
            }
        }
        guard let store = openedStore else { return nil }
        return body(store)
    }

    static func remember(wrong: String, right: String) -> RememberResult {
        withStore { store in
            do {
                return try rememberLocked(wrong: wrong, right: right, in: store)
            } catch {
                RunLog.write("saved-fixes.remember.failed", "error=\(logSafe(error))")
                return .failed
            }
        } ?? .failed
    }

    /// Applies saved fixes to a finished dictation and counts each use.
    /// `language` is the language the dictation started with.
    static func applyToFinishedDictation(_ text: String, targetBundleID: String?, language: String) -> String {
        guard !text.isEmpty, let scope = targetScope(targetBundleID, language: language) else { return text }
        return withStore { store in
            do {
                switch try store.applySavedCorrection(to: text, in: scope) {
                case let .applied(draft, lessons):
                    RunLog.write("saved-fixes.applied", "lessons=\(lessons.count)")
                    return draft
                case .requiresReview:
                    RunLog.write("saved-fixes.skipped", "reason=overlapping-fixes")
                    return text
                case .unchanged:
                    return text
                }
            } catch {
                RunLog.write("saved-fixes.apply.failed", "error=\(logSafe(error))")
                return text
            }
        } ?? text
    }

    /// Applies saved fixes without counting uses or writing anything. Used
    /// for reprocessed archive text (with the archived session's app and
    /// language) and for finalized segments pasted live during a dictation
    /// (with the target app and the language the dictation started with).
    /// Never used on live partial text.
    static func preview(_ text: String, targetBundleID: String?, language: String) -> String {
        guard !text.isEmpty, let scope = targetScope(targetBundleID, language: language) else { return text }
        return withStore { $0.preview(text, in: scope) } ?? text
    }

    /// The saved lessons, or nil when the lessons file can't be opened.
    static func lessonsForMenu() -> [CorrectionLesson]? {
        withStore { $0.lessons }
    }

    @discardableResult
    static func forget(lessonID: UUID) -> Bool {
        withStore { store in
            do {
                try store.forget(lessonID: lessonID)
                RunLog.write("saved-fixes.forgotten", "remaining=\(store.lessons.count)")
                return true
            } catch {
                RunLog.write("saved-fixes.forget.failed", "error=\(logSafe(error))")
                return false
            }
        } ?? false
    }

    @discardableResult
    static func resetAll() -> Bool {
        withStore { store in
            do {
                try store.reset()
                RunLog.write("saved-fixes.reset")
                return true
            } catch {
                RunLog.write("saved-fixes.reset.failed", "error=\(logSafe(error))")
                return false
            }
        } ?? false
    }

    /// Teaches an every-app fix. A wrong phrase that differs from a saved one
    /// only in capitals, with the same replacement, is "already saved" and
    /// keeps its use count.
    private static func rememberLocked(
        wrong: String,
        right: String,
        in store: CorrectionLessonStore
    ) throws -> RememberResult {
        let scope = try CorrectionScope.anyApplication(localeIdentifier: Settings.language)
        switch try store.teach(wrong: wrong, right: right, in: scope) {
        case .saved:
            RunLog.write("saved-fixes.saved", "fromChars=\(wrong.count) toChars=\(right.count) total=\(store.lessons.count)")
            return .saved
        case .updated:
            RunLog.write("saved-fixes.updated", "fromChars=\(wrong.count) toChars=\(right.count)")
            return .updated
        case .alreadySaved:
            RunLog.write("saved-fixes.already-saved", "fromChars=\(wrong.count) toChars=\(right.count)")
            return .unchanged
        }
    }

    /// Moves Convo Cursor's old word list into Saved Fixes. It is marked done
    /// only when every valid old rule is in the store; a rule that failed to
    /// save is tried again the next time True Convo starts. Empty or unchanged
    /// rules can never be saved and count as handled. A saved fix for the same
    /// word is kept as it is. The old setting is left in place, unused.
    private static func importLegacyRules(into store: CorrectionLessonStore) {
        guard !Settings.savedFixesLegacyImportDone else { return }
        let rules = Settings.personalAutoCorrections
        let scope: CorrectionScope
        do {
            scope = try CorrectionScope.anyApplication(localeIdentifier: Settings.language)
        } catch {
            RunLog.write("saved-fixes.legacy-import.failed", "rules=\(rules.count) error=\(logSafe(error))")
            return
        }
        let report = store.importLegacyRules(rules, in: scope)
        if report.isComplete {
            Settings.savedFixesLegacyImportDone = true
        }
        RunLog.write(
            "saved-fixes.legacy-import",
            "rules=\(report.rules) saved=\(report.saved) alreadySaved=\(report.alreadySaved) invalid=\(report.invalid) failed=\(report.failed) done=\(report.isComplete)"
        )
    }

    /// The target app's scope in `language`. Unknown targets and True Convo
    /// itself fall back to a placeholder, so only every-app fixes match there.
    private static func targetScope(_ bundleID: String?, language: String) -> CorrectionScope? {
        if let bundleID = bundleID?.trimmingCharacters(in: .whitespacesAndNewlines),
           !bundleID.isEmpty,
           let scope = try? CorrectionScope(
               externalTargetApplicationIdentifier: bundleID,
               localeIdentifier: language
           ) {
            return scope
        }
        return try? CorrectionScope(
            externalTargetApplicationIdentifier: "unknown.target",
            localeIdentifier: language
        )
    }

    private static func logSafe(_ error: Error) -> String {
        String(describing: error).replacingOccurrences(of: " ", with: "_")
    }
}

func cleanedDictationText(_ value: String) -> String {
    let collapsed = value
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    let normalized = Settings.spokenPunctuationCommands
        ? SpokenPunctuationNormalizer.normalize(collapsed)
        : collapsed
    return normalized
}

struct ArchiveEntry: Codable {
    let id: String
    let timestamp: String
    let durationMs: Int
    let text: String
    let audioPath: String?
    let contentPacketPath: String?
    let derivedFromSessionId: String?
    let captureMode: String?
    let timing: ArchiveTiming?
    let provider: String
    let model: String
    let language: String
    let source: String
    let injected: Bool
    let target: TargetContext?
    let processing: ProcessingContext
    let correction: CorrectionContext?

    init(
        id: String,
        timestamp: String,
        durationMs: Int,
        text: String,
        audioPath: String?,
        contentPacketPath: String?,
        derivedFromSessionId: String?,
        captureMode: String?,
        timing: ArchiveTiming?,
        provider: String,
        model: String,
        language: String,
        source: String,
        injected: Bool,
        target: TargetContext? = nil,
        processing: ProcessingContext? = nil,
        correction: CorrectionContext? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.durationMs = durationMs
        self.text = text
        self.audioPath = audioPath
        self.contentPacketPath = contentPacketPath
        self.derivedFromSessionId = derivedFromSessionId
        self.captureMode = captureMode
        self.timing = timing
        self.provider = provider
        self.model = model
        self.language = language
        self.source = source
        self.injected = injected
        self.target = target
        self.processing = processing ?? ProcessingContext.forProvider(provider, captureMode: captureMode)
        self.correction = correction
    }

    enum CodingKeys: String, CodingKey {
        case id
        case timestamp
        case durationMs
        case text
        case audioPath
        case contentPacketPath
        case derivedFromSessionId
        case captureMode
        case timing
        case provider
        case model
        case language
        case source
        case injected
        case target
        case processing
        case correction
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        timestamp = try container.decode(String.self, forKey: .timestamp)
        durationMs = try container.decode(Int.self, forKey: .durationMs)
        text = try container.decode(String.self, forKey: .text)
        audioPath = try container.decodeIfPresent(String.self, forKey: .audioPath)
        contentPacketPath = try container.decodeIfPresent(String.self, forKey: .contentPacketPath)
        derivedFromSessionId = try container.decodeIfPresent(String.self, forKey: .derivedFromSessionId)
        captureMode = try container.decodeIfPresent(String.self, forKey: .captureMode)
        timing = try container.decodeIfPresent(ArchiveTiming.self, forKey: .timing)
        provider = try container.decode(String.self, forKey: .provider)
        model = try container.decode(String.self, forKey: .model)
        language = try container.decode(String.self, forKey: .language)
        source = try container.decode(String.self, forKey: .source)
        injected = try container.decode(Bool.self, forKey: .injected)
        target = try container.decodeIfPresent(TargetContext.self, forKey: .target)
        processing = try container.decodeIfPresent(ProcessingContext.self, forKey: .processing)
            ?? ProcessingContext.forProvider(provider, captureMode: captureMode)
        correction = try container.decodeIfPresent(CorrectionContext.self, forKey: .correction)
    }
}

struct TargetContext: Codable {
    let bundleIdentifier: String
    let name: String
    let processIdentifier: Int?
    let insertionMode: String
    let insertionSource: String
    let insertionProfile: String
    let captureMethod: String

    var jsonObject: [String: Any] {
        [
            "bundleIdentifier": bundleIdentifier,
            "name": name,
            "processIdentifier": processIdentifier ?? NSNull(),
            "insertionMode": insertionMode,
            "insertionSource": insertionSource,
            "insertionProfile": insertionProfile,
            "captureMethod": captureMethod,
        ]
    }

    var logDetail: String {
        [
            "bundle=\(Self.logValue(bundleIdentifier))",
            "name=\(Self.logValue(name))",
            "pid=\(processIdentifier.map(String.init) ?? "unknown")",
            "mode=\(Self.logValue(insertionMode))",
            "source=\(Self.logValue(insertionSource))",
            "profile=\(Self.logValue(insertionProfile))",
            "captureMethod=\(Self.logValue(captureMethod))",
        ].joined(separator: " ")
    }

    private static func logValue(_ value: String) -> String {
        let compact = value
            .replacingOccurrences(of: "\\s+", with: "_", options: .regularExpression)
            .replacingOccurrences(of: "\"", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return compact.isEmpty ? "unknown" : compact
    }
}

struct ProcessingContext: Codable {
    let privacyLane: String
    let cloudProcessed: Bool
    let cloudProvider: String?
    let harvestUse: String
    let trainingEligibility: String
    let trainingPromotionBoundary: String

    static func forProvider(_ provider: String, captureMode: String?) -> ProcessingContext {
        switch provider {
        case "apple-local", "apple-speech-analyzer":
            return ProcessingContext(
                privacyLane: "local-only",
                cloudProcessed: false,
                cloudProvider: nil,
                harvestUse: "local-transcript-and-review-evidence",
                trainingEligibility: "eligible-after-human-review",
                trainingPromotionBoundary: "Local-only session. Convo Engine may review this material as a future private STT adaptation candidate, but must not train or personalize until the owner approves promotion."
            )
        case "local-whisper":
            return ProcessingContext(
                privacyLane: "local-retained-audio-transcription",
                cloudProcessed: false,
                cloudProvider: nil,
                harvestUse: "local-audio-transcript-and-review-evidence",
                trainingEligibility: "eligible-after-human-review",
                trainingPromotionBoundary: "Local transcription session. Retained local audio may support future private STT adaptation after human review and explicit the owner approval."
            )
        case "openai-realtime":
            return ProcessingContext(
                privacyLane: "cloud-streaming",
                cloudProcessed: true,
                cloudProvider: "OpenAI",
                harvestUse: "local-transcript-packet-review-only",
                trainingEligibility: "not-private-training-material",
                trainingPromotionBoundary: "Cloud-processed session. Keep as a local transcript/content packet, but do not use as private voice-training material unless the owner later approves a cloud-processed training exception."
            )
        case "openai-cloud":
            return ProcessingContext(
                privacyLane: "cloud-retained-audio-transcription",
                cloudProcessed: true,
                cloudProvider: "OpenAI",
                harvestUse: "local-transcript-packet-review-only",
                trainingEligibility: "not-private-training-material",
                trainingPromotionBoundary: "Cloud-processed audio transcription. Keep as local review evidence, but do not use as private voice-training material unless the owner later approves a cloud-processed training exception."
            )
        case "groq-cloud":
            return ProcessingContext(
                privacyLane: "cloud-retained-audio-transcription",
                cloudProcessed: true,
                cloudProvider: "Groq",
                harvestUse: "local-transcript-packet-review-only",
                trainingEligibility: "not-private-training-material",
                trainingPromotionBoundary: "Cloud-processed audio transcription. Keep as local review evidence, but do not use as private voice-training material unless the owner later approves a cloud-processed training exception."
            )
        default:
            return ProcessingContext(
                privacyLane: captureMode?.contains("cloud") == true ? "cloud-processed-unknown" : "unknown",
                cloudProcessed: captureMode?.contains("cloud") == true,
                cloudProvider: nil,
                harvestUse: "review-required",
                trainingEligibility: "review-required",
                trainingPromotionBoundary: "Unknown processing lane. Review privacy provenance before any Convo Engine promotion."
            )
        }
    }

    var jsonObject: [String: Any] {
        [
            "privacyLane": privacyLane,
            "cloudProcessed": cloudProcessed,
            "cloudProvider": cloudProvider ?? NSNull(),
            "harvestUse": harvestUse,
            "trainingEligibility": trainingEligibility,
            "trainingPromotionBoundary": trainingPromotionBoundary,
        ]
    }
}

struct CorrectionContext: Codable {
    let selectedText: String
    let replacementText: String
    let targetBundle: String
    let targetName: String
    let captureMethod: String

    var jsonObject: [String: Any] {
        [
            "selectedText": selectedText,
            "replacementText": replacementText,
            "targetBundle": targetBundle,
            "targetName": targetName,
            "captureMethod": captureMethod,
        ]
    }
}

struct ArchiveTiming: Codable {
    let liveFirstPartialMs: Int?
    let liveFirstFinalMs: Int?
    let postStopTranscriptionMs: Int?
    let archiveFinalizeMs: Int?
    let totalStopProcessingMs: Int?

    var jsonObject: [String: Any] {
        var payload: [String: Any] = [:]
        if let liveFirstPartialMs {
            payload["liveFirstPartialMs"] = liveFirstPartialMs
        }
        if let liveFirstFinalMs {
            payload["liveFirstFinalMs"] = liveFirstFinalMs
        }
        if let postStopTranscriptionMs {
            payload["postStopTranscriptionMs"] = postStopTranscriptionMs
        }
        if let archiveFinalizeMs {
            payload["archiveFinalizeMs"] = archiveFinalizeMs
        }
        if let totalStopProcessingMs {
            payload["totalStopProcessingMs"] = totalStopProcessingMs
        }
        return payload
    }
}

enum VoiceCursorError: Error, LocalizedError {
    case missingAPIKey(String)
    case processFailed(String)
    case emptyTranscript(String)
    case unreadableCloudResponse

    var errorDescription: String? {
        switch self {
        case .missingAPIKey(let name):
            return "\(name) is not set."
        case .processFailed(let message):
            return message
        case .emptyTranscript(let provider):
            return "\(provider) returned an empty transcript."
        case .unreadableCloudResponse:
            return "Cloud transcription returned an unreadable response."
        }
    }
}

enum RuntimeEnvironment {
    // API keys come only from the macOS Keychain or the launching process's
    // environment. There is deliberately no plain-text key file.
    static func value(_ name: String) -> String? {
        if let keychainValue = KeychainStore.read(name), !keychainValue.isEmpty {
            return keychainValue
        }
        if let value = ProcessInfo.processInfo.environment[name], !value.isEmpty {
            return value
        }
        return nil
    }

    static func source(_ name: String) -> String {
        if KeychainStore.read(name) != nil {
            return "Keychain"
        }
        if let value = ProcessInfo.processInfo.environment[name], !value.isEmpty {
            return "Process environment"
        }
        return "missing"
    }
}

struct ProviderReadiness {
    let ready: Bool
    let statusText: String
    let menuText: String
    let logDetail: String

    static func current() -> ProviderReadiness {
        forProvider(Settings.provider)
    }

    static func forProvider(_ provider: DictationProvider) -> ProviderReadiness {
        if !provider.isAvailableOnThisMac {
            return ProviderReadiness(
                ready: false,
                statusText: "\(provider.label) needs macOS 26 or newer",
                menuText: "Mode: \(provider.label) - needs macOS 26 or newer",
                logDetail: "provider=\(provider.rawValue) privacy=\"\(provider.privacyLabel)\" key=none source=local missing=\"macOS 26\""
            )
        }
        guard let keyName = provider.requiredAPIKeyName else {
            // Local providers carry no API key, but Local Whisper still depends on
            // tools existing on disk. Gate here so the hotkey refuses with a reason
            // instead of starting a dictation that can never transcribe.
            if provider == .localWhisper {
                let missing = localWhisperMissingTools()
                if !missing.isEmpty {
                    let missingList = missing.joined(separator: ", ")
                    return ProviderReadiness(
                        ready: false,
                        statusText: "\(provider.label) needs \(missingList) in Settings",
                        menuText: "Mode: \(provider.label) - missing \(missingList)",
                        logDetail: "provider=\(provider.rawValue) privacy=\"\(provider.privacyLabel)\" key=none source=local missing=\"\(missingList)\""
                    )
                }
            }
            return ProviderReadiness(
                ready: true,
                statusText: "\(provider.label): \(provider.privacyLabel)",
                menuText: "Mode: \(provider.label) - \(provider.privacyLabel)",
                logDetail: "provider=\(provider.rawValue) privacy=\"\(provider.privacyLabel)\" key=none source=local"
            )
        }

        let source = RuntimeEnvironment.source(keyName)
        let sourceForLog = source
            .replacingOccurrences(of: " ", with: "-")
            .lowercased()
        guard source != "missing" else {
            return ProviderReadiness(
                ready: false,
                statusText: "\(provider.label) needs \(keyName) in Settings",
                menuText: "Mode: \(provider.label) - missing key",
                logDetail: "provider=\(provider.rawValue) privacy=\"\(provider.privacyLabel)\" key=\(keyName) source=missing"
            )
        }

        return ProviderReadiness(
            ready: true,
            statusText: "\(provider.label): \(provider.privacyLabel), key via \(source)",
            menuText: "Mode: \(provider.label) - \(provider.privacyLabel)",
            logDetail: "provider=\(provider.rawValue) privacy=\"\(provider.privacyLabel)\" key=\(keyName) source=\(sourceForLog)"
        )
    }

    // Same facts the Diagnostics panel reports via localWhisperReadiness(),
    // expressed as a checkable list so the readiness gate can act on them.
    private static func localWhisperMissingTools() -> [String] {
        var missing: [String] = []
        if !FileManager.default.isExecutableFile(atPath: Settings.whisperBinary) {
            missing.append("Whisper binary")
        }
        if Settings.archiveFormat != .wav, !FileManager.default.isExecutableFile(atPath: Settings.ffmpegBinary) {
            missing.append("ffmpeg binary for FLAC")
        }
        return missing
    }
}

enum KeychainStore {
    // The real app's service, or True Convo Test's own: the test copy never
    // reads, saves over or deletes the real app's keys.
    private static let service = AppIdentity.current.keychainService

    static func read(_ account: String) -> String? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ value: String, account: String) throws {
        let data = Data(value.utf8)
        let query = baseQuery(account)
        let status = SecItemCopyMatching(query as CFDictionary, nil)

        if status == errSecSuccess {
            let updateStatus = SecItemUpdate(
                query as CFDictionary,
                [kSecValueData as String: data] as CFDictionary
            )
            guard updateStatus == errSecSuccess else {
                throw VoiceCursorError.processFailed("Keychain update failed with status \(updateStatus).")
            }
            return
        }

        var addQuery = query
        addQuery[kSecValueData as String] = data
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw VoiceCursorError.processFailed("Keychain save failed with status \(addStatus).")
        }
    }

    static func delete(_ account: String) throws {
        let status = SecItemDelete(baseQuery(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw VoiceCursorError.processFailed("Keychain delete failed with status \(status).")
        }
    }

    private static func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

enum Archive {
    private static let writeLock = NSLock()

    // `~/.tca-dictate` for the real app (and `swift run`), `~/.tca-dictate-test`
    // for True Convo Test. Every archive path below starts here.
    static var root: URL {
        AppIdentity.current.archiveRoot(home: FileManager.default.homeDirectoryForCurrentUser)
    }

    static var recordings: URL {
        root.appendingPathComponent("recordings")
    }

    // This dedicated directory contains only new retention-off captures. The
    // legacy recordings archive is never swept or migrated.
    static var temporaryRecordings: URL { root.appendingPathComponent("temporary-recordings") }
    static var temporaryAudio: TemporaryAudioStore { TemporaryAudioStore(directory: temporaryRecordings) }

    static func captureRecordingURL(for sessionId: String, retain: Bool) throws -> URL {
        if retain { return recordingURL(for: sessionId) }
        return try temporaryAudio.recordingURL(sessionID: sessionId)
    }

    static func sweepTemporaryAudio() {
        guard !Settings.dictationPreferences.retainAudioForHarvest else { return }
        do {
            let removed = try temporaryAudio.sweep()
            if !removed.isEmpty { RunLog.write("audio.temporary.launch-cleanup", "count=\(removed.count)") }
        } catch { RunLog.write("audio.temporary.launch-cleanup.failed", error.localizedDescription) }
    }

    static func promoteTemporaryAudio(_ url: URL) throws -> URL {
        guard url.standardizedFileURL.deletingLastPathComponent() == temporaryRecordings.standardizedFileURL else { return url }
        let retained = recordings.appendingPathComponent(url.lastPathComponent)
        guard !FileManager.default.fileExists(atPath: retained.path) else { throw VoiceCursorError.processFailed("An existing retained recording must not be replaced.") }
        try FileManager.default.moveItem(at: url, to: retained)
        return retained
    }

    static var transcripts: URL {
        root.appendingPathComponent("transcripts")
    }

    static var packets: URL {
        root.appendingPathComponent("packets")
    }

    static var diagnostics: URL {
        root.appendingPathComponent("diagnostics")
    }

    static var providerComparisons: URL {
        root.appendingPathComponent("provider-comparisons")
    }

    static var harvestBundles: URL {
        root.appendingPathComponent("harvest-bundles")
    }

    static var corrections: URL {
        root.appendingPathComponent("corrections")
    }

    static var history: URL {
        root.appendingPathComponent("history.jsonl")
    }

    static var runLog: URL {
        root.appendingPathComponent("voice-cursor.log")
    }

    static func ensureDirectories() throws {
        try FileManager.default.createDirectory(at: recordings, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: transcripts, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: packets, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: diagnostics, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: providerComparisons, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: harvestBundles, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: corrections, withIntermediateDirectories: true)
    }

    static func recordingURL(for sessionId: String) -> URL {
        recordings.appendingPathComponent("\(sessionId).wav")
    }

    static func transcriptURL(for sessionId: String) -> URL {
        transcripts.appendingPathComponent("\(sessionId).md")
    }

    static func contentPacketURL(for sessionId: String) -> URL {
        packets.appendingPathComponent("\(sessionId).md")
    }

    static var latestTranscript: URL {
        root.appendingPathComponent("latest-transcript.md")
    }

    static var latestContentPacket: URL {
        root.appendingPathComponent("latest-content-packet.md")
    }

    static var latestSession: URL {
        root.appendingPathComponent("latest-session.json")
    }

    static var timingReport: URL {
        root.appendingPathComponent("timing-report.md")
    }

    static var latestProviderComparison: URL {
        root.appendingPathComponent("latest-provider-comparison.md")
    }

    static var harvestInbox: URL {
        root.appendingPathComponent("harvest-inbox.md")
    }

    static var latestHarvestBundle: URL {
        root.appendingPathComponent("latest-harvest-bundle.md")
    }

    static var correctionInbox: URL {
        root.appendingPathComponent("correction-inbox.md")
    }

    static var correctionPairsJSONL: URL {
        corrections.appendingPathComponent("correction-pairs.jsonl")
    }

    static var liveProof: URL {
        root.appendingPathComponent("live-test-proof.json")
    }

    static var liveProofSummary: URL {
        root.appendingPathComponent("live-test-proof-summary.md")
    }

    static var phase2EvidenceReceipt: URL {
        root.appendingPathComponent("phase2-evidence-receipt.md")
    }

    static var startHere: URL {
        root.appendingPathComponent("voice-cursor-start-here.md")
    }

    static var hermesAcceptance: URL {
        root.appendingPathComponent("hermes-acceptance.md")
    }

    static var appCompatibility: URL {
        root.appendingPathComponent("app-compatibility.md")
    }

    static var crossAppTargetCoverage: URL {
        root.appendingPathComponent("cross-app-target-coverage.md")
    }

    static var crossAppTargetMarker: URL {
        root.appendingPathComponent(".cross-app-target-marker.json")
    }

    static func readHistory() -> [ArchiveEntry] {
        guard let data = try? Data(contentsOf: history),
              let text = String(data: data, encoding: .utf8)
        else {
            return []
        }

        let decoder = JSONDecoder()
        return text
            .split(whereSeparator: \.isNewline)
            .compactMap { line -> ArchiveEntry? in
                guard let data = String(line).data(using: .utf8) else {
                    return nil
                }
                return try? decoder.decode(ArchiveEntry.self, from: data)
            }
    }

    static func latestEntry() -> ArchiveEntry? {
        if FileManager.default.fileExists(atPath: latestSession.path),
           let data = try? Data(contentsOf: latestSession),
           let entry = try? JSONDecoder().decode(ArchiveEntry.self, from: data)
        {
            return entry
        }
        return readHistory().last
    }

    /// A spoken dictation: it has recorded audio time and is not a reprocessed
    /// copy. Typed corrections have no audio; spoken corrections still count.
    static func isRealDictation(_ entry: ArchiveEntry) -> Bool {
        entry.durationMs > 0 && entry.derivedFromSessionId == nil
    }

    /// Reads history.jsonl (the last 8 MB at most) to find when the last real
    /// dictation was saved. Used once, when the menu first needs the date.
    static func lastDictationDateFromHistory() -> Date? {
        guard let handle = try? FileHandle(forReadingFrom: history) else { return nil }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let window: UInt64 = 8 * 1024 * 1024
        let offset = size > window ? size - window : 0
        try? handle.seek(toOffset: offset)
        guard let data = try? handle.readToEnd() else { return nil }
        var lines = String(decoding: data, as: UTF8.self).split(separator: "\n")
        if offset > 0, !lines.isEmpty {
            lines.removeFirst()
        }
        let decoder = JSONDecoder()
        for line in lines.reversed() {
            guard let entry = try? decoder.decode(ArchiveEntry.self, from: Data(line.utf8)),
                  isRealDictation(entry)
            else { continue }
            let formatter = ISO8601DateFormatter()
            if let date = formatter.date(from: entry.timestamp) { return date }
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter.date(from: entry.timestamp)
        }
        return nil
    }

    static func append(_ entry: ArchiveEntry) throws {
        writeLock.lock()
        defer { writeLock.unlock() }

        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(entry)
        if !FileManager.default.fileExists(atPath: history.path) {
            FileManager.default.createFile(atPath: history.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: history)
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
            try handle.write(contentsOf: Data("\n".utf8))
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }
        if Archive.isRealDictation(entry) {
            Settings.lastDictationAt = Date()
        }
        let updateLatest = shouldUpdateLatestPointers(for: entry)
        try writeTranscriptFile(entry, updateLatest: updateLatest)
        try writeContentPacketFile(entry, updateLatest: updateLatest)
    }

    private static func shouldUpdateLatestPointers(for entry: ArchiveEntry) -> Bool {
        guard FileManager.default.fileExists(atPath: latestSession.path),
              let data = try? Data(contentsOf: latestSession),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let latestTimestamp = object["timestamp"] as? String,
              let latestId = object["id"] as? String
        else {
            return true
        }

        if latestId == entry.id {
            return true
        }
        return entry.timestamp >= latestTimestamp
    }

    private static func writeTranscriptFile(_ entry: ArchiveEntry, updateLatest: Bool) throws {
        try ensureDirectories()
        let url = transcriptURL(for: entry.id)
        var lines = [
            "# True Convo Session",
            "",
            "- ID: \(entry.id)",
            "- Derived from: \(entry.derivedFromSessionId ?? "none")",
            "- Timestamp: \(entry.timestamp)",
            "- Duration: \(String(format: "%.1f", Double(entry.durationMs) / 1000.0))s",
            "- Provider: \(entry.provider)",
            "- Model: \(entry.model)",
            "- Language: \(entry.language)",
            "- Audio: \(entry.audioPath ?? "none")",
            "- Capture mode: \(entry.captureMode ?? "unknown")",
            "- Injected: \(entry.injected ? "yes" : "no")",
        ]
        lines += processingMetadataLines(entry.processing)
        lines += targetMetadataLines(entry.target)
        lines += timingMetadataLines(entry.timing)
        lines += correctionMetadataLines(entry.correction)
        lines += [
            "",
            "## Transcript",
            "",
            entry.text.isEmpty ? "(empty)" : entry.text,
            "",
        ]
        let body = lines.joined(separator: "\n")
        try body.write(to: url, atomically: true, encoding: .utf8)
        if updateLatest {
            try body.write(to: latestTranscript, atomically: true, encoding: .utf8)
        } else {
            RunLog.write("archive.latest.skipped", "kind=transcript id=\(entry.id) timestamp=\(entry.timestamp)")
        }
    }

    static func contentPacketBody(for entry: ArchiveEntry) -> String {
        var lines = [
            "# True Convo Content Packet",
            "",
            "## Agent Handoff",
            "",
            "This packet is ready to use as source material for Codex, ChatGPT, Claude, or a writing workflow. Treat the transcript as captured speech, not polished copy.",
            "",
            "## Session",
            "",
            "- ID: \(entry.id)",
            "- Derived from: \(entry.derivedFromSessionId ?? "none")",
            "- Timestamp: \(entry.timestamp)",
            "- Duration: \(String(format: "%.1f", Double(entry.durationMs) / 1000.0))s",
            "- Provider: \(entry.provider)",
            "- Model: \(entry.model)",
            "- Language: \(entry.language)",
            "- Capture mode: \(entry.captureMode ?? "unknown")",
            "- Injected: \(entry.injected ? "yes" : "no")",
            "",
            "## Processing & Harvest Boundary",
            "",
        ]
        lines += processingPacketLines(entry.processing)
        lines += [
            "",
            "## Target",
            "",
        ]
        lines += targetPacketLines(entry.target)
        lines += [
            "",
            "## Timing",
            "",
        ]
        lines += timingPacketLines(entry.timing)
        lines += [
            "",
            "## Correction",
            "",
        ]
        lines += correctionPacketLines(entry.correction)
        lines += [
            "",
            "## Local Files",
            "",
            "- History: \(history.path)",
            "- Transcript: \(transcriptURL(for: entry.id).path)",
            "- Content packet: \(entry.contentPacketPath ?? contentPacketURL(for: entry.id).path)",
            "- Latest transcript: \(latestTranscript.path)",
            "- Latest content packet: \(latestContentPacket.path)",
            "- Latest session JSON: \(latestSession.path)",
            "- Audio: \(entry.audioPath ?? "none")",
            "",
            "## Reuse Rules",
            "",
            "- Preserve concrete names, dates, offers, prices, claims, and commitments exactly unless the owner asks you to rewrite them.",
            "- Separate transcript evidence from your interpretation.",
            "- Ask before turning rough dictation into public-facing claims, guarantees, legal wording, pricing, or customer promises.",
            "- If the transcript is unclear, say what is uncertain instead of smoothing over it.",
            "- Cloud-processed sessions are content/review packets only unless the owner explicitly approves a later training exception.",
            "",
            "## Suggested Content Work",
            "",
            "- Extract action items, decisions, and open questions.",
            "- Turn the material into a short memo, outline, email draft, script, post, offer, or task list.",
            "- Pull reusable phrases and proof points into a clearly labeled section.",
            "- Create follow-up prompts for deeper strategy, editing, or implementation work.",
            "",
            "## Transcript",
            "",
            entry.text.isEmpty ? "(empty)" : entry.text,
            "",
        ]
        return lines.joined(separator: "\n")
    }

    static func writeTimingReport() throws -> URL {
        try ensureDirectories()
        let body = timingReportBody(entries: readHistory())
        try body.write(to: timingReport, atomically: true, encoding: .utf8)
        return timingReport
    }

    static func writeHarvestInbox() throws -> URL {
        try ensureDirectories()
        let body = harvestInboxBody(entries: readHistory())
        try body.write(to: harvestInbox, atomically: true, encoding: .utf8)
        return harvestInbox
    }

    static func writeHarvestBundle() throws -> URL {
        try ensureDirectories()
        let generatedAt = ISO8601DateFormatter().string(from: Date())
        let safeTimestamp = generatedAt
            .replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: ".", with: "-")
        let url = harvestBundles.appendingPathComponent("voice-cursor-harvest-\(safeTimestamp).md")
        let body = harvestBundleBody(entries: readHistory(), generatedAt: generatedAt, bundleURL: url)
        try body.write(to: url, atomically: true, encoding: .utf8)
        try body.write(to: latestHarvestBundle, atomically: true, encoding: .utf8)
        return url
    }

    static func writeCorrectionInbox() throws -> URL {
        writeLock.lock()
        defer { writeLock.unlock() }
        try refreshCorrectionHandoffArtifacts()
        return correctionInbox
    }

    static func writeCorrectionPairsJSONL() throws -> URL {
        writeLock.lock()
        defer { writeLock.unlock() }
        try ensureDirectories()
        try writeCorrectionPairsJSONL(entries: readHistory())
        return correctionPairsJSONL
    }

    private static func refreshCorrectionHandoffArtifacts() throws {
        try ensureDirectories()
        let entries = readHistory()
        try writeCorrectionPairsJSONL(entries: entries)
        let body = correctionInboxBody(entries: entries)
        try body.write(to: correctionInbox, atomically: true, encoding: .utf8)
        let correctionCount = entries.filter { $0.correction != nil }.count
        RunLog.write("correction.handoff.refreshed", "pairs=\(correctionCount)")
    }

    static func writeLiveProofSummary() throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let body = liveProofSummaryBody()
        try body.write(to: liveProofSummary, atomically: true, encoding: .utf8)
        return liveProofSummary
    }

    static func writeStartHereReport() throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let body = startHereReportBody()
        try body.write(to: startHere, atomically: true, encoding: .utf8)
        return startHere
    }

    static func writePhase2EvidenceReceipt() throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let body = phase2EvidenceReceiptBody()
        try body.write(to: phase2EvidenceReceipt, atomically: true, encoding: .utf8)
        return phase2EvidenceReceipt
    }

    static func phase2GuidedAcceptanceCommand() -> String {
        let command = "npm run phase2:guided-acceptance"
        guard let repo = reportRepoRoot() else {
            return command
        }
        return "cd \(shellQuoted(repo.path)) && \(command)"
    }

    static func writeHermesAcceptanceReport() throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let body = hermesAcceptanceReportBody()
        try body.write(to: hermesAcceptance, atomically: true, encoding: .utf8)
        return hermesAcceptance
    }

    static func writeAppCompatibilityReport() throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let body = appCompatibilityReportBody()
        try body.write(to: appCompatibility, atomically: true, encoding: .utf8)
        return appCompatibility
    }

    static func writeCrossAppTargetCoverageReport() throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let body = crossAppTargetCoverageReportBody()
        try body.write(to: crossAppTargetCoverage, atomically: true, encoding: .utf8)
        return crossAppTargetCoverage
    }

    static func recordLiveProof(label: String) throws -> URL {
        let normalizedLabel = label.lowercased()
        guard ["safe", "paste", "reprocess", "live-paste", "realtime-target", "correction"].contains(normalizedLabel) else {
            throw liveProofError("Unknown proof label: \(label)")
        }
        guard let entry = latestEntry() else {
            throw liveProofError("No latest session has been archived yet")
        }

        if normalizedLabel == "correction" {
            _ = try writeCorrectionInbox()
        }

        let checks = liveProofChecks(label: normalizedLabel, entry: entry)
        if let failed = checks.first(where: { !($0["ok"] as? Bool ?? false) }) {
            let checkLabel = failed["label"] as? String ?? "proof check"
            let detail = failed["detail"] as? String ?? "missing"
            throw liveProofError("\(checkLabel): \(detail)")
        }

        try ensureDirectories()
        let generatedAt = ISO8601DateFormatter().string(from: Date())
        var proof = readJSONObject(liveProof) ?? [:]
        var proofs = proof["proofs"] as? [String: Any] ?? [:]
        let packetPath = entry.contentPacketPath ?? contentPacketURL(for: entry.id).path

        proofs[normalizedLabel] = [
            "label": normalizedLabel,
            "verifiedAt": generatedAt,
            "marker": NSNull(),
            "session": [
                "id": entry.id,
                "timestamp": entry.timestamp,
                "provider": entry.provider,
                "injected": entry.injected,
                "durationMs": entry.durationMs,
                "audioPath": entry.audioPath ?? NSNull(),
                "derivedFromSessionId": entry.derivedFromSessionId ?? NSNull(),
                "captureMode": entry.captureMode ?? NSNull(),
                "timing": entry.timing?.jsonObject ?? NSNull(),
                "transcriptPath": transcriptURL(for: entry.id).path,
                "contentPacketPath": packetPath,
                "latestTranscriptPath": latestTranscript.path,
                "latestContentPacketPath": latestContentPacket.path,
                "latestSessionPath": latestSession.path,
                "target": entry.target?.jsonObject ?? NSNull(),
                "processing": entry.processing.jsonObject,
                "cloudProcessed": entry.processing.cloudProcessed,
                "trainingEligibility": entry.processing.trainingEligibility,
                "correction": entry.correction?.jsonObject ?? NSNull(),
            ],
            "checks": checks,
        ]

        proof["archiveRoot"] = root.path
        proof["updatedAt"] = generatedAt
        proof["proofs"] = proofs

        let data = try JSONSerialization.data(withJSONObject: proof, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: liveProof, options: .atomic)
        _ = try writeLiveProofSummary()
        RunLog.write("live-proof.recorded", "label=\(normalizedLabel) id=\(entry.id)")
        return liveProof
    }

    private static func liveProofChecks(label: String, entry: ArchiveEntry) -> [[String: Any]] {
        let transcriptPath = transcriptURL(for: entry.id).path
        let packetPath = entry.contentPacketPath ?? contentPacketURL(for: entry.id).path
        let latestSessionObject = readJSONObject(latestSession)
        let latestSessionId = latestSessionObject?["id"] as? String
        let packetText = (try? String(contentsOfFile: packetPath, encoding: .utf8)) ?? ""
        let isRealtimeTarget = label == "realtime-target"
        let expectedInjected = label == "paste" || label == "live-paste" || isRealtimeTarget
        let expectedCaptureMode: String = label == "reprocess"
            ? "reprocess"
            : isRealtimeTarget ? "openai-realtime-cursor-preview" : label == "live-paste" ? "apple-live-paste" : "apple-live-preview"
        let expectedPhrase: String = label == "paste"
            ? "voice cursor paste test"
            : isRealtimeTarget ? "convo cursor realtime target test" : label == "live-paste" ? "voice cursor live paste test" : "voice cursor safe test"
        let normalizedTranscript = normalizeProofText(entry.text)
        let sourceEntry = entry.derivedFromSessionId.flatMap { sourceId in
            readHistory().first { $0.id == sourceId }
        }
        let audio = audioFileStatus(entry.audioPath)

        var checks = [
            proofCheck("history entry", !entry.id.isEmpty, entry.id),
            proofCheck("transcript file", FileManager.default.fileExists(atPath: transcriptPath), transcriptPath),
            proofCheck("content packet", FileManager.default.fileExists(atPath: packetPath), packetPath),
            proofCheck("latest transcript pointer", FileManager.default.fileExists(atPath: latestTranscript.path), latestTranscript.path),
            proofCheck("latest content packet pointer", FileManager.default.fileExists(atPath: latestContentPacket.path), latestContentPacket.path),
            proofCheck("latest session pointer", FileManager.default.fileExists(atPath: latestSession.path), latestSession.path),
            proofCheck("latest session matches history", latestSessionId == entry.id, latestSessionId ?? "missing"),
            proofCheck("content packet has agent handoff", packetText.contains("## Agent Handoff"), packetPath),
            proofCheck("content packet has capture mode", packetText.contains("Capture mode"), packetPath),
            proofCheck("content packet has timing section", packetText.contains("## Timing"), packetPath),
            proofCheck("content packet has reuse rules", packetText.contains("## Reuse Rules"), packetPath),
            proofCheck("content packet has suggested content work", packetText.contains("## Suggested Content Work"), packetPath),
            proofCheck("content packet has transcript section", packetText.contains("## Transcript"), packetPath),
            proofCheck("session has timing", entry.timing?.totalStopProcessingMs != nil, entry.timing == nil ? "missing timing" : "timing present"),
            proofCheck(
                label == "reprocess" ? "retained audio is readable WAV/FLAC" : "retained audio is absent or readable WAV/FLAC",
                label == "reprocess" ? audio.ok : (entry.audioPath == nil || audio.ok),
                entry.audioPath == nil ? "retained audio harvest off" : audio.detail
            ),
        ]

        if label == "correction" {
            let correction = entry.correction
            let selected = correction?.selectedText.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let replacement = correction?.replacementText.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let jsonlText = (try? String(contentsOf: correctionPairsJSONL, encoding: .utf8)) ?? ""
            checks += [
                proofCheck("correction metadata present", correction != nil, correction == nil ? "missing correction" : "present"),
                proofCheck("selected text captured", !selected.isEmpty, selected.isEmpty ? "empty selected text" : selected),
                proofCheck("replacement text captured", !replacement.isEmpty, replacement.isEmpty ? "empty replacement text" : replacement),
                proofCheck("correction target captured", !(correction?.targetBundle.isEmpty ?? true), correction?.targetBundle ?? "missing target bundle"),
                proofCheck("content packet has correction section", packetText.contains("## Correction"), packetPath),
                proofCheck("content packet has selected text", !selected.isEmpty && packetText.contains(selected), selected.isEmpty ? "empty selected text" : packetPath),
                proofCheck("content packet has replacement text", !replacement.isEmpty && packetText.contains(replacement), replacement.isEmpty ? "empty replacement text" : packetPath),
                proofCheck("correction JSONL exists", FileManager.default.fileExists(atPath: correctionPairsJSONL.path), correctionPairsJSONL.path),
                proofCheck("correction JSONL has session", jsonlText.contains(entry.id), entry.id),
                proofCheck("not a derived session", entry.derivedFromSessionId == nil, entry.derivedFromSessionId ?? "none"),
            ]
            return checks
        }

        checks += [
            proofCheck("expected injected status", entry.injected == expectedInjected, "\(entry.injected ? "yes" : "no") expected \(expectedInjected ? "yes" : "no")"),
            proofCheck("expected capture mode", entry.captureMode == expectedCaptureMode, "\(entry.captureMode ?? "missing") expected \(expectedCaptureMode)"),
            proofCheck("expected transcript phrase", normalizedTranscript.contains(normalizeProofText(expectedPhrase)), expectedPhrase),
        ]

        if label == "reprocess" {
            checks += [
                proofCheck("derived source", entry.derivedFromSessionId != nil, entry.derivedFromSessionId ?? "none"),
                proofCheck("derived source history entry", sourceEntry != nil, entry.derivedFromSessionId ?? "missing derivedFromSessionId"),
                proofCheck("derived audio matches source", sourceEntry != nil && entry.audioPath == sourceEntry?.audioPath, "latest=\(entry.audioPath ?? "none") source=\(sourceEntry?.audioPath ?? "none")"),
                proofCheck("derived provider is non-Apple", entry.provider != "apple-local", entry.provider),
            ]
        } else if isRealtimeTarget {
            let postStopTranscriptionMs = entry.timing?.postStopTranscriptionMs
            let totalStopProcessingMs = entry.timing?.totalStopProcessingMs
            checks += [
                proofCheck("expected provider", entry.provider == "openai-realtime", "\(entry.provider) expected openai-realtime"),
                proofCheck("not a derived session", entry.derivedFromSessionId == nil, entry.derivedFromSessionId ?? "none"),
                proofCheck("Realtime tail wait recorded", postStopTranscriptionMs != nil, postStopTranscriptionMs.map { "\($0)ms" } ?? "missing post-stop transcription timing"),
                proofCheck("Realtime tail wait stayed bounded", (postStopTranscriptionMs ?? Int.max) <= 7000, postStopTranscriptionMs.map { "\($0)ms expected <= 7000ms" } ?? "missing post-stop transcription timing"),
                proofCheck("Realtime stop processing stayed bounded", (totalStopProcessingMs ?? Int.max) <= 8500, totalStopProcessingMs.map { "\($0)ms expected <= 8500ms" } ?? "missing total stop processing timing"),
                proofCheck("target metadata present", entry.target != nil, entry.target?.name ?? "missing target"),
                proofCheck("target bundle captured", !(entry.target?.bundleIdentifier.isEmpty ?? true), entry.target?.bundleIdentifier ?? "missing target bundle"),
                proofCheck("target insertion mode captured", !(entry.target?.insertionMode.isEmpty ?? true), entry.target?.insertionMode ?? "missing insertion mode"),
                proofCheck("content packet has target section", packetText.contains("## Target"), packetPath),
            ]
        } else {
            checks += [
                proofCheck("expected provider", entry.provider == "apple-local", "\(entry.provider) expected apple-local"),
                proofCheck("not a derived session", entry.derivedFromSessionId == nil, entry.derivedFromSessionId ?? "none"),
            ]
        }

        return checks
    }

    private static func proofCheck(_ label: String, _ ok: Bool, _ detail: String) -> [String: Any] {
        [
            "label": label,
            "ok": ok,
            "detail": detail,
        ]
    }

    private static func normalizeProofText(_ value: String) -> String {
        value
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func audioFileStatus(_ path: String?) -> (ok: Bool, detail: String) {
        guard let path, !path.isEmpty else {
            return (false, "missing audio path")
        }
        guard FileManager.default.fileExists(atPath: path),
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              data.count > 12
        else {
            return (false, path)
        }
        let header = String(data: data.prefix(12), encoding: .ascii) ?? ""
        let isFlac = header.hasPrefix("fLaC")
        let isWav = header.hasPrefix("RIFF") && header.contains("WAVE")
        return (isFlac || isWav, "\(path) (\(data.count) bytes)")
    }

    private static func liveProofError(_ message: String) -> NSError {
        NSError(domain: "VoiceCursorLiveProof", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private static func harvestInboxBody(entries: [ArchiveEntry]) -> String {
        let recent = entries.suffix(30).reversed()
        var lines = [
            "# True Convo Harvest Inbox",
            "",
            "Generated: \(ISO8601DateFormatter().string(from: Date()))",
            "History: \(history.path)",
            "",
            "This inbox uses local archive metadata only. It does not record audio, call providers, or change transcripts.",
            "",
            "## How To Use",
            "",
            "- Start with the newest rows and open the content packet for anything worth turning into content.",
            "- Treat transcript text as captured speech, not polished copy.",
            "- Preserve concrete names, dates, offers, prices, claims, and commitments exactly unless the owner asks you to rewrite them.",
            "- Use the suggested content work in each packet for memos, outlines, scripts, posts, task lists, and follow-up prompts.",
            "- Cloud-processed rows are usable as local content packets, but they are not private voice-training material by default.",
            "",
            "## Recent Voice Material",
            "",
        ]

        if recent.isEmpty {
            lines.append("No archived voice sessions yet.")
            lines.append("")
        } else {
            lines.append("| Timestamp | Provider | Privacy lane | Training eligibility | Mode | Duration | Text | Packet | Audio |")
            lines.append("| --- | --- | --- | --- | --- | ---: | --- | --- | --- |")
            for entry in recent {
                lines.append(tableRow([
                    entry.timestamp,
                    "\(entry.provider)/\(entry.model)",
                    entry.processing.privacyLane,
                    entry.processing.trainingEligibility,
                    entry.captureMode ?? "unknown",
                    formatSeconds(entry.durationMs),
                    truncateForTable(entry.text),
                    entry.contentPacketPath ?? contentPacketURL(for: entry.id).path,
                    entry.audioPath ?? "none",
                ]))
            }
            lines.append("")
        }

        lines += [
            "## Stable Paths",
            "",
            "- Latest transcript: \(latestTranscript.path)",
            "- Latest content packet: \(latestContentPacket.path)",
            "- Latest session JSON: \(latestSession.path)",
            "- Latest provider comparison: \(latestProviderComparison.path)",
            "- Timing report: \(timingReport.path)",
            "- Recordings: \(recordings.path)",
            "- Transcripts: \(transcripts.path)",
            "- Content packets: \(packets.path)",
            "",
            "## Suggested Harvest Work",
            "",
            "- Pull decisions, open loops, and next actions into a concise work note.",
            "- Convert useful dictation into a rough memo, outline, email draft, short post, or script.",
            "- Compare reprocessed versions when multiple provider/model outputs exist for the same source audio.",
            "- Create follow-up prompts for Codex, ChatGPT, Claude, or an editor before polishing.",
            "- Route only local/private rows toward future voice-engine training review unless the owner explicitly approves a cloud-processed exception.",
            "",
        ]

        return lines.joined(separator: "\n") + "\n"
    }

    private static func correctionInboxBody(entries: [ArchiveEntry]) -> String {
        let corrected = entries
            .filter { $0.correction != nil }
            .suffix(50)
            .reversed()
        var lines = [
            "# True Convo Correction Inbox",
            "",
            "Generated: \(ISO8601DateFormatter().string(from: Date()))",
            "History: \(history.path)",
            "Correction pairs JSONL: \(correctionPairsJSONL.path)",
            "",
            "This inbox is local-only. It collects selected-text correction pairs captured while the owner uses True Convo, so Convo Engine can later review, filter, and use them for speech-to-text adaptation work.",
            "",
            "## How To Use",
            "",
            "- Normal correction path: enable `Convo Engine Harvest Capture`, highlight the wrong text, start dictation, then speak the replacement.",
            "- Strict one-shot path: leave harvest off, highlight the wrong text, choose `Correct Selected Text Once`, then speak the replacement.",
            "- Review the selected text and spoken replacement together.",
            "- Treat these as candidate training/adaptation pairs, not automatic model updates.",
            "- Keep false captures out of future training data; a highlighted selection can be accidental.",
            "- Prefer pairs with retained audio because those can support future local model tuning.",
            "- Cloud-processed correction rows stay review-only unless the owner explicitly approves a cloud-processed training exception.",
            "",
            "## Review Workflow",
            "",
            "1. Capture: True Convo writes a selected-text correction pair with `reviewStatus=needs-human-review` and `promotionStatus=not-promoted`.",
            "2. Current-build candidate check: run `npm run verify:convo-engine-corrections:marked` to validate post-marker rows without writing Convo Engine files.",
            "3. Candidate export: run `npm run convo-engine:corrections:marked` to write post-marker Convo Engine correction candidates.",
            "4. Review queue: run `npm run phase2:correction-handoff:marked` to verify the post-marker correction row, write candidates, and write the local review queue.",
            "5. Human review: confirm the selected text is the actual bad transcript and the spoken replacement is the intended correction.",
            "6. Promotion: only after approval, a future Convo Engine importer may copy accepted rows into a personalization or training dataset.",
            "",
            "## Review Rubric",
            "",
            "- Keep: the highlighted text is wrong, the replacement is clearly better, and the audio/session context is present.",
            "- Review with caveats: the correction is useful but audio is missing, the replacement is long, or surrounding context matters.",
            "- Reject: the selection was accidental, selected and replacement text are the same, or the row captures private/irrelevant material.",
            "",
            "## Captured Corrections",
            "",
        ]

        if corrected.isEmpty {
            lines.append("No selected-text correction pairs have been captured yet.")
            lines.append("")
        } else {
            lines.append("| Timestamp | Target | Privacy lane | Training eligibility | Selected text | Spoken replacement | Packet | Audio |")
            lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
            for entry in corrected {
                guard let correction = entry.correction else { continue }
                lines.append(tableRow([
                    entry.timestamp,
                    "\(correction.targetName) / \(correction.targetBundle)",
                    entry.processing.privacyLane,
                    entry.processing.trainingEligibility,
                    truncateForTable(correction.selectedText),
                    truncateForTable(correction.replacementText),
                    entry.contentPacketPath ?? contentPacketURL(for: entry.id).path,
                    entry.audioPath ?? "none",
                ]))
            }
            lines.append("")
        }

        lines += [
            "## Stable Paths",
            "",
            "- Correction inbox: \(correctionInbox.path)",
            "- Correction pairs JSONL: \(correctionPairsJSONL.path)",
            "- Latest transcript: \(latestTranscript.path)",
            "- Latest content packet: \(latestContentPacket.path)",
            "- Latest session JSON: \(latestSession.path)",
            "- Recordings: \(recordings.path)",
            "- Content packets: \(packets.path)",
            "",
            "## Convo Engine Bridge",
            "",
            "- Each JSONL row uses schema `convo-cursor-correction-pair/v1` and contains the session id, target app, selected text, spoken replacement, provider/model, audio path, and content packet path.",
            "- The shortest current-build handoff command is `npm run phase2:correction-handoff:marked`.",
            "- The current-build dry-run candidate command is `npm run verify:convo-engine-corrections:marked`.",
            "- The current-build write path is `npm run convo-engine:corrections:marked`, then `npm run convo-engine:correction-review:marked`.",
            "- The marked review queue verifier is `npm run verify:convo-engine-correction-review:marked`.",
            "- To review every captured correction regardless of marker, run `npm run verify:convo-engine-corrections -- --dry-run --require-candidates`.",
            "- A future Convo Engine importer can score these pairs, reject bad captures, and promote clean examples into a personalization or training dataset only after approval.",
            "- This file is evidence, not automatic retraining.",
            "",
        ]

        return lines.joined(separator: "\n") + "\n"
    }

    private static func writeCorrectionPairsJSONL(entries: [ArchiveEntry]) throws {
        let lines = entries.compactMap { entry -> String? in
            guard let correction = entry.correction else { return nil }
            let payload: [String: Any] = [
                "schemaVersion": "convo-cursor-correction-pair/v1",
                "sessionId": entry.id,
                "timestamp": entry.timestamp,
                "durationMs": entry.durationMs,
                "provider": entry.provider,
                "model": entry.model,
                "language": entry.language,
                "targetBundle": correction.targetBundle,
                "targetName": correction.targetName,
                "captureMethod": correction.captureMethod,
                "selectedText": correction.selectedText,
                "replacementText": correction.replacementText,
                "audioPath": entry.audioPath ?? NSNull(),
                "contentPacketPath": entry.contentPacketPath ?? contentPacketURL(for: entry.id).path,
                "transcriptPath": transcriptURL(for: entry.id).path,
                "processing": entry.processing.jsonObject,
                "cloudProcessed": entry.processing.cloudProcessed,
                "trainingEligibility": entry.processing.trainingEligibility,
                "source": "convo-cursor-selection-correction",
                "reviewStatus": "needs-human-review",
                "promotionStatus": "not-promoted",
                "promotionBoundary": entry.processing.trainingPromotionBoundary,
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
                  let line = String(data: data, encoding: .utf8)
            else { return nil }
            return line
        }

        let body = lines.isEmpty ? "" : lines.joined(separator: "\n") + "\n"
        try body.write(to: correctionPairsJSONL, atomically: true, encoding: .utf8)
    }

    private static func harvestBundleBody(entries: [ArchiveEntry], generatedAt: String, bundleURL: URL) -> String {
        let recent = Array(entries.suffix(10).reversed())
        var lines = [
            "# True Convo Harvest Bundle",
            "",
            "## Agent Handoff",
            "",
            "This bundle contains recent captured speech from True Convo. Treat each transcript as source evidence, not polished copy.",
            "Cloud-processed sessions can be used as local transcript/content packets, but they are not private voice-training material by default.",
            "",
            "## Bundle",
            "",
            "- Generated: \(generatedAt)",
            "- Bundle: \(bundleURL.path)",
            "- Latest bundle: \(latestHarvestBundle.path)",
            "- History: \(history.path)",
            "- Sessions included: \(recent.count)",
            "",
            "## Reuse Rules",
            "",
            "- Preserve concrete names, dates, offers, prices, claims, and commitments exactly unless the owner asks you to rewrite them.",
            "- Separate transcript evidence from your interpretation.",
            "- Ask before turning rough dictation into public-facing claims, guarantees, legal wording, pricing, or customer promises.",
            "- If a transcript is unclear, say what is uncertain instead of smoothing over it.",
            "- Do not promote cloud-processed sessions into Convo Engine training without a later explicit exception.",
            "",
            "## Suggested Content Work",
            "",
            "- Extract decisions, action items, open loops, reusable language, and follow-up prompts.",
            "- Group related sessions before drafting.",
            "- Compare derived provider/model transcripts against the original source session when both are present.",
            "- Turn useful material into a memo, outline, email draft, script, post, offer, task list, or implementation brief.",
            "",
            "## Session Index",
            "",
        ]

        if recent.isEmpty {
            lines.append("No archived voice sessions yet.")
            lines.append("")
        } else {
            lines.append("| Timestamp | Provider | Privacy lane | Training eligibility | Mode | Duration | Packet | Audio |")
            lines.append("| --- | --- | --- | --- | --- | ---: | --- | --- |")
            for entry in recent {
                lines.append(tableRow([
                    entry.timestamp,
                    "\(entry.provider)/\(entry.model)",
                    entry.processing.privacyLane,
                    entry.processing.trainingEligibility,
                    entry.captureMode ?? "unknown",
                    formatSeconds(entry.durationMs),
                    entry.contentPacketPath ?? contentPacketURL(for: entry.id).path,
                    entry.audioPath ?? "none",
                ]))
            }
            lines.append("")
        }

        lines.append("## Transcripts")
        lines.append("")
        for entry in recent {
            lines += [
                "### \(entry.timestamp) - \(entry.id)",
                "",
                "- Derived from: \(entry.derivedFromSessionId ?? "none")",
                "- Provider: \(entry.provider)",
                "- Model: \(entry.model)",
                "- Capture mode: \(entry.captureMode ?? "unknown")",
                "- Privacy lane: \(entry.processing.privacyLane)",
                "- Cloud processed: \(entry.processing.cloudProcessed ? "yes" : "no")",
                "- Harvest use: \(entry.processing.harvestUse)",
                "- Training eligibility: \(entry.processing.trainingEligibility)",
                "- Training boundary: \(entry.processing.trainingPromotionBoundary)",
                "- Duration: \(formatSeconds(entry.durationMs))",
                "- Language: \(entry.language)",
                "- Injected: \(entry.injected ? "yes" : "no")",
                "- Audio: \(entry.audioPath ?? "none")",
                "- Content packet: \(entry.contentPacketPath ?? contentPacketURL(for: entry.id).path)",
                "",
                "#### Timing",
                "",
            ]
            lines += timingPacketLines(entry.timing)
            lines += [
                "",
                "#### Transcript",
                "",
                entry.text.isEmpty ? "(empty)" : entry.text,
                "",
            ]
        }

        return lines.joined(separator: "\n") + "\n"
    }

    private static func liveProofSummaryBody() -> String {
        let proof = readJSONObject(liveProof)
        let proofs = proof?["proofs"] as? [String: Any] ?? [:]
        let labels = ["safe", "paste", "reprocess", "live-paste", "realtime-target", "correction"]
        var lines = [
            "# True Convo Live Proof Summary",
            "",
            "Generated: \(ISO8601DateFormatter().string(from: Date()))",
            "Proof JSON: \(liveProof.path)",
            "Archive: \(root.path)",
            "",
            "This summary reads local live-test proof data only. It does not record audio, request permissions, paste text, or call providers.",
            "",
            "## Status",
            "",
        ]

        if proof == nil {
            lines.append("No live-test proof file has been written yet.")
            lines.append("")
        } else {
            let missing = ["safe", "paste", "reprocess", "realtime-target"].filter { proofs[$0] == nil }
            lines.append(missing.isEmpty ? "Required proof records are present." : "Missing required proof records: \(missing.joined(separator: ", ")).")
            lines.append("")
        }

        lines += [
            "## Proof Records",
            "",
            "| Pass | Present | Session | Provider | Injected | Capture mode | Audio | Transcript | Packet |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
        for label in labels {
            lines.append(proofSummaryRow(label: label, record: proofs[label]))
        }
        lines += [
            "",
            "## Next Verification",
            "",
            "- If safe, paste, reprocess, and realtime-target are present, the Phase 2 live proof is complete.",
            "- If live-paste is present, the Mac Dictation-like live paste mode has also been proven.",
            "- If realtime-target is present, OpenAI Realtime live insertion and target metadata have also been proven.",
            "- If correction is present, selected-text correction capture plus the post-marker Convo Engine correction export and review queue have also been proven.",
            "- If a row is missing, rerun the matching marker and verifier command from LIVE_TEST.md.",
            "",
        ]

        return lines.joined(separator: "\n") + "\n"
    }

    private static func startHereReportBody() -> String {
        let proof = readJSONObject(liveProof)
        let proofs = proof?["proofs"] as? [String: Any] ?? [:]
        let latest = latestEntry()
        let repoURL = reportRepoRoot()
        let vsixURL = repoURL?.appendingPathComponent("tca-dictate-0.3.0.vsix")
        var lines = [
            "# True Convo Start Here",
            "",
            "Generated: \(ISO8601DateFormatter().string(from: Date()))",
            "Surface: Standalone macOS app",
            "",
            "This report is a local handoff for the next live test. It does not record audio, request permissions, paste text, call providers, or change settings.",
            "",
            "## Recommended Next",
            "",
            "1. Open First Run Checklist.",
            "2. Click Use Safe Test Settings.",
            "3. Click Request Mic + Speech and approve macOS prompts.",
            "4. Open Live Transcript, start dictation, and say exactly `voice cursor safe test`.",
            "5. Choose Record Safe Proof From Latest Session.",
            "6. Continue with paste, reprocess, and optional live-paste passes from LIVE_TEST.md.",
            "7. After installing the newest build, use `npm run phase2:guided-acceptance` for the Phase 2 proof path.",
            "8. Then run `npm run verify:phase2-proof` to refresh the Phase 2 proof summary without replaying the whole guide.",
            "9. Then run `npm run phase2:evidence-bundle` to print the Phase 2 release receipt.",
            "10. From the app, choose Expert Tools > Proof & Diagnostics > Copy Guided Acceptance Command to copy that command with the repo path included.",
            "",
            "## Readiness Snapshot",
            "",
            "- Microphone: \(DiagnosticsReport.microphoneStatus())",
            "- Speech Recognition: \(DiagnosticsReport.speechStatus())",
            "- Accessibility: \(AXIsProcessTrusted() ? "granted" : "not granted")",
            "- Default audio input: \(DiagnosticsReport.currentAudioInput())",
            "- Provider: \(Settings.provider.label)",
            "- Privacy mode: \(Settings.provider.privacyLabel)",
            "- Archive format: \(Settings.archiveFormat.label)",
            "- Retain audio for Harvest: \(Settings.providerMakesNoRecording ? "\(Settings.dictationPreferences.retainAudioForHarvest ? "enabled" : "disabled") - \(Settings.provider.label) makes no recording" : (Settings.dictationPreferences.retainAudioForHarvest ? "enabled - recordings kept locally" : "disabled - temporary recordings deleted after use"))",
            "- After dictation: \(Settings.completionAction.label)",
            "- Auto-stop: \(Settings.autoStop ? "enabled" : "disabled")",
            "- Live paste Apple finals: \(Settings.livePasteAppleFinals ? "enabled" : "disabled")",
            "- Live cursor preview: \(Settings.liveInsertApplePartials ? "enabled" : "disabled")",
            "- Convo Engine Harvest: \(Settings.captureSelectionCorrections ? "enabled - local correction review evidence" : "disabled - local correction review off")",
            "- Spoken punctuation commands: \(Settings.spokenPunctuationCommands ? "enabled" : "disabled - automatic punctuation only")",
            "",
            "## Current Local State",
            "",
            "| Item | Status | Path/Detail |",
            "| --- | --- | --- |",
            tableRow(["Archive root", filePresence(root), root.path]),
            tableRow(["Standalone app", filePresence(Bundle.main.bundleURL), Bundle.main.bundleURL.path]),
            tableRow(["Repo", filePresence(repoURL), repoURL?.path ?? "unknown"]),
            tableRow(["VSIX", filePresence(vsixURL), vsixURL?.path ?? "unknown"]),
            tableRow(["Latest session", latest == nil ? "missing" : "present", latest?.id ?? latestSession.path]),
            tableRow(["Live proof JSON", filePresence(liveProof), liveProof.path]),
            tableRow(["Live proof summary", filePresence(liveProofSummary), liveProofSummary.path]),
            tableRow(["Phase 2 evidence receipt", filePresence(phase2EvidenceReceipt), phase2EvidenceReceipt.path]),
            tableRow(["Cross-app target coverage", filePresence(crossAppTargetCoverage), crossAppTargetCoverage.path]),
            tableRow(["Run log", filePresence(runLog), runLog.path]),
            "",
            "## Proof Status",
            "",
            "| Pass | Present | Expected phrase | Menu action | Terminal verifier |",
            "| --- | --- | --- | --- | --- |",
            tableRow(["safe", proofs["safe"] == nil ? "no" : "yes", "voice cursor safe test", "Record Safe Proof From Latest Session", "npm run verify:live-safe"]),
            tableRow(["paste", proofs["paste"] == nil ? "no" : "yes", "voice cursor paste test", "Record Paste Proof From Latest Session", "npm run verify:live-paste"]),
            tableRow(["reprocess", proofs["reprocess"] == nil ? "no" : "yes", "voice cursor safe test", "Record Reprocess Proof From Latest Session", "npm run verify:live-reprocess"]),
            tableRow(["live-paste", proofs["live-paste"] == nil ? "optional" : "yes", "voice cursor live paste test", "Record Live Paste Proof From Latest Session", "npm run verify:live-paste-mode"]),
            tableRow(["realtime-target", proofs["realtime-target"] == nil ? "phase2" : "yes", "convo cursor realtime target test", "Record OpenAI Realtime Target Proof", "npm run verify:live-realtime-target"]),
            tableRow(["correction", proofs["correction"] == nil ? "optional" : "yes", "highlight wrong word, speak replacement", "Record Correction Proof From Latest Session", "n/a"]),
            "",
            "## Hermes Acceptance Script",
            "",
            "Use this after installing the newest signed app and resetting the Hermes safety marker.",
            "",
            "1. In Hermes, click the active message box.",
            "2. Start True Convo with `Cmd+D`, speak a long passage with normal punctuation pauses, then stop with `Cmd+D`.",
            "3. Type `deecay`, highlight exactly `deecay`, choose `Correct Selected Text Once`, say exactly `decay`, then stop.",
            "4. Wait for final cleanup to finish before submitting or moving to another thread. In Persistent Pill mode, the pill stays visible and returns to ready.",
            "5. Run `npm run verify:hermes-acceptance`.",
            "",
            "The correction row and review queue are local Convo Engine evidence, not automatic training data.",
            "",
            "## Stable Harvest Paths",
            "",
            "- Latest transcript: \(latestTranscript.path)",
            "- Latest content packet: \(latestContentPacket.path)",
            "- Latest session JSON: \(latestSession.path)",
            "- Harvest inbox: \(harvestInbox.path)",
            "- Latest harvest bundle: \(latestHarvestBundle.path)",
            "- Timing report: \(timingReport.path)",
            "- Provider comparison: \(latestProviderComparison.path)",
            "- App compatibility: \(appCompatibility.path)",
            "- Cross-app target coverage: \(crossAppTargetCoverage.path)",
            "- Hermes acceptance: \(hermesAcceptance.path)",
            "- Live proof JSON: \(liveProof.path)",
            "- Live proof summary: \(liveProofSummary.path)",
            "- Phase 2 evidence receipt: \(phase2EvidenceReceipt.path)",
            "",
            "## Recent Sessions",
            "",
        ]

        let recent = Array(readHistory().suffix(5).reversed())
        if recent.isEmpty {
            lines.append("No archived voice sessions yet.")
            lines.append("")
        } else {
            lines.append("| Timestamp | Provider | Mode | Injected | Text |")
            lines.append("| --- | --- | --- | --- | --- |")
            for entry in recent {
                lines.append(tableRow([
                    entry.timestamp,
                    "\(entry.provider)/\(entry.model)",
                    entry.captureMode ?? "unknown",
                    entry.injected ? "yes" : "no",
                    truncateForTable(entry.text),
                ]))
            }
            lines.append("")
        }

        lines += [
            "## Terminal Commands",
            "",
            "For the shortest post-install Phase 2 path, run:",
            "",
            "```bash",
            "npm run phase2:guided-acceptance",
            "```",
            "",
            "After the guided markers exist, rerun the Phase 2 proof summary with:",
            "",
            "```bash",
            "npm run verify:phase2-proof",
            "```",
            "",
            "Print the Phase 2 release receipt with:",
            "",
            "```bash",
            "npm run phase2:evidence-bundle",
            "```",
            "",
            "From the app, choose Expert Tools > Proof & Diagnostics > Copy Guided Acceptance Command to copy the same command with the repo path included.",
            "Use `npm run live-test:phase2-guide` when you only want the read-only guide.",
            "",
            "Full command list:",
            "",
            "```bash",
            "npm run verify:noninvasive",
            "npm run live-test:preflight",
            "npm run live-test:phase2-guide",
            "npm run phase2:guided-acceptance",
            "npm run live-test:mark-safe",
            "npm run verify:live-safe",
            "npm run live-test:mark-paste",
            "npm run verify:live-paste",
            "npm run live-test:mark-reprocess",
            "npm run verify:live-reprocess",
            "npm run live-test:mark-realtime-target",
            "npm run verify:live-realtime-target",
            "npm run live-test:mark-cross-app-targets",
            "npm run verify:cross-app-targets:marked",
            "npm run verify:live-proof",
            "npm run verify:phase2-proof",
            "npm run phase2:evidence-bundle",
            "npm run verify:hermes-live-safety:marked",
            "npm run phase2:correction-handoff:marked",
            "npm run verify:finish-gate",
            "npm run verify:hermes-acceptance",
            "```",
            "",
        ]

        return lines.joined(separator: "\n") + "\n"
    }

    private static func phase2EvidenceReceiptBody() -> String {
        let generatedAt = ISO8601DateFormatter().string(from: Date())
        let proof = readJSONObject(liveProof)
        let proofs = proof?["proofs"] as? [String: Any] ?? [:]
        let requiredProofs = ["safe", "paste", "reprocess", "realtime-target"]
        let missingProofs = requiredProofs.filter { proofs[$0] == nil }
        let entries = readHistory()
        let latest = latestEntry()
        let marker = readJSONObject(crossAppTargetMarker)
        let markerTimestamp = marker?["timestamp"] as? String
        let markerDate = markerTimestamp.flatMap(parseISO8601Date)
        let scannedEntries = markerTimestamp == nil
            ? entries
            : entries.filter { entry in
                if let markerDate, let entryDate = parseISO8601Date(entry.timestamp) {
                    return entryDate > markerDate
                }
                return entry.timestamp > (markerTimestamp ?? "")
            }
        let targetEntries = scannedEntries.filter { $0.target != nil }
        let missingTargets = crossAppTargetRequirements()
            .filter { requirement in
                !targetEntries.contains { entry in
                    targetMatches(entry.target, bundles: requirement.bundles, nameHints: requirement.nameHints)
                }
            }
            .map { $0.label }
        let correctionCount = entries.filter { $0.correction != nil }.count
        let cloudProcessedCount = entries.filter { $0.processing.cloudProcessed }.count
        let localProcessedCount = max(0, entries.count - cloudProcessedCount)
        let phase2Status = missingProofs.isEmpty && missingTargets.isEmpty && correctionCount > 0
            ? "ready for final install/live review"
            : "pending required evidence"

        var lines = [
            "# True Convo Phase 2 Evidence Receipt",
            "",
            "Generated: \(generatedAt)",
            "Archive: \(root.path)",
            "Receipt: \(phase2EvidenceReceipt.path)",
            "",
            "This receipt reads local proof metadata only. It does not print transcript text, record audio, request permissions, paste text, call providers, or change settings.",
            "",
            "## Gate Snapshot",
            "",
            "| Item | Status | Detail |",
            "| --- | --- | --- |",
            tableRow(["Phase 2 status", phase2Status, missingProofs.isEmpty && missingTargets.isEmpty ? "proof rows present" : "missing proof rows or target sessions"]),
            tableRow(["Required live proofs", missingProofs.isEmpty ? "present" : "pending", missingProofs.isEmpty ? requiredProofs.joined(separator: ", ") : missingProofs.joined(separator: ", ")]),
            tableRow(["OpenAI Realtime target proof", proofs["realtime-target"] == nil ? "pending" : "present", "proves cloud streaming plus target metadata"]),
            tableRow(["Cross-app targets", missingTargets.isEmpty ? "present" : "pending", missingTargets.isEmpty ? "Hermes, Codex, Apple Notes, TextEdit" : missingTargets.joined(separator: ", ")]),
            tableRow(["Correction review evidence", correctionCount > 0 ? "present" : "pending", "\(correctionCount) captured correction pair(s)"]),
            tableRow(["Latest session", latest == nil ? "missing" : "present", latest?.id ?? latestSession.path]),
            tableRow(["Current provider", Settings.provider.label, Settings.provider.privacyLabel]),
            tableRow(["Retain audio for Harvest", Settings.dictationPreferences.retainAudioForHarvest ? "enabled" : "disabled", Settings.providerMakesNoRecording ? "\(Settings.provider.label) makes no recording" : (Settings.dictationPreferences.retainAudioForHarvest ? "local recordings may be kept" : "temporary recordings are deleted after use")]),
            tableRow(["Correction capture", Settings.captureSelectionCorrections ? "enabled" : "disabled", Settings.captureSelectionCorrections ? "local review evidence can be captured" : "off by default"]),
            tableRow(["Executable SHA-256", BuildFingerprint.executableSha256Description() == "unknown" ? "missing" : "present", BuildFingerprint.executableSha256Description()]),
            "",
            "## Privacy And Harvest Boundary",
            "",
            "- Local Only and Local Whisper sessions may become local Convo Engine review evidence after human review.",
            "- OpenAI Realtime and other cloud-processed sessions are tagged as cloud processed and remain local transcript/content-packet review material.",
            "- Cloud-processed sessions must not silently become private voice-training material.",
            "- Harvest is off by default; retained audio and correction capture require explicit settings.",
            "",
            "## Session Mix",
            "",
            "| Item | Count | Detail |",
            "| --- | --- | --- |",
            tableRow(["Archived sessions", "\(entries.count)", history.path]),
            tableRow(["Local-processed sessions", "\(localProcessedCount)", "not marked cloud processed"]),
            tableRow(["Cloud-processed sessions", "\(cloudProcessedCount)", "tagged for review-only handling"]),
            tableRow(["Target metadata sessions scanned", "\(targetEntries.count)", crossAppTargetMarker.path]),
            "",
            "## Proof Records",
            "",
            "| Pass | Present | Required For |",
            "| --- | --- | --- |",
            tableRow(["safe", proofs["safe"] == nil ? "no" : "yes", "baseline archive and transcription"]),
            tableRow(["paste", proofs["paste"] == nil ? "no" : "yes", "final insertion"]),
            tableRow(["reprocess", proofs["reprocess"] == nil ? "no" : "yes", "retained local audio path"]),
            tableRow(["realtime-target", proofs["realtime-target"] == nil ? "no" : "yes", "OpenAI Realtime typing and target metadata"]),
            tableRow(["correction", proofs["correction"] == nil ? "optional" : "yes", "selected-text correction capture"]),
            "",
            "## Required Smoke Targets",
            "",
            "| App | Status | Detail |",
            "| --- | --- | --- |",
        ]

        for requirement in crossAppTargetRequirements() {
            let matched = targetEntries.contains { entry in
                targetMatches(entry.target, bundles: requirement.bundles, nameHints: requirement.nameHints)
            }
            lines.append(tableRow([
                requirement.label,
                matched ? "present" : "pending",
                requirement.bundles.joined(separator: ", "),
            ]))
        }

        lines += [
            "",
            "## Related Local Files",
            "",
            "- Start Here: \(startHere.path)",
            "- Live proof JSON: \(liveProof.path)",
            "- Live proof summary: \(liveProofSummary.path)",
            "- Cross-app target coverage: \(crossAppTargetCoverage.path)",
            "- Hermes acceptance: \(hermesAcceptance.path)",
            "- Correction inbox: \(correctionInbox.path)",
            "- Correction JSONL: \(correctionPairsJSONL.path)",
            "- Run log: \(runLog.path)",
            "",
            "## Terminal Verification",
            "",
            "```bash",
            "npm run verify:phase2-proof",
            "npm run phase2:evidence-bundle",
            "npm run verify:finish-gate",
            "```",
            "",
        ]

        return lines.joined(separator: "\n") + "\n"
    }

    private static func appCompatibilityReportBody() -> String {
        let profiles = TextInjector.compatibilityProfiles
        var lines = [
            "# True Convo App Compatibility",
            "",
            "Generated: \(ISO8601DateFormatter().string(from: Date()))",
            "",
            "This report explains how True Convo chooses a text insertion strategy for different apps. It is local and read-only: it does not record audio, request permissions, paste text, call providers, or change settings.",
            "",
            "## Current Target",
            "",
            "| Item | Value |",
            "| --- | --- |",
            tableRow(["Target app", TextInjector.targetDescription]),
            tableRow(["Insertion mode setting", Settings.insertionMode.label]),
            tableRow(["Final rewrite mode", Settings.finalRewriteMode.label]),
            tableRow(["Live cursor preview", Settings.liveInsertApplePartials ? "enabled" : "disabled"]),
            tableRow(["After dictation", Settings.completionAction.label]),
            tableRow(["Provider/model", "\(Settings.provider.label) / \(currentModelName())"]),
            "",
            "## Known App Profiles",
            "",
            "| App | Bundle | Strategy | Why |",
            "| --- | --- | --- | --- |",
        ]

        for profile in profiles {
            lines.append(tableRow([
                profile.name,
                profile.bundleIdentifier,
                profile.mode.label,
                profile.reason,
            ]))
        }

        lines += [
            "",
            "## Strategy Meanings",
            "",
            "- Accessibility: use the focused macOS text element directly. This is cleanest when the target app exposes a normal editable field.",
            "- Keyboard Compatibility: type live text with simulated keystrokes. This is used for apps that do not expose a reliable focused text field.",
            "- Final Paste Only: skip live typing and paste the completed transcript at the end. This is the fallback when live insertion is too disruptive.",
            "",
            "## Safety Rules",
            "",
            "- Keyboard compatibility targets keep the live text on stop and skip the late final rewrite.",
            "- If the user clicks away or presses another shortcut during live insertion, True Convo guards the session and keeps the cleaned final transcript on the clipboard instead of pasting later into an uncertain field.",
            "- Transcripts, content packets, and timing evidence are archived even when insertion is suppressed. Audio is kept only when recording retention is on and the engine makes a recording.",
            "- New troublesome apps should become explicit profiles here instead of relying on trial-and-error every time.",
            "",
            "## Related Local Files",
            "",
            "- Run log: \(runLog.path)",
            "- Latest session: \(latestSession.path)",
            "- Hermes acceptance: \(hermesAcceptance.path)",
            "- Finish gate command: `npm run verify:finish-gate`",
            "",
        ]

        return lines.joined(separator: "\n") + "\n"
    }

    private static func crossAppTargetCoverageReportBody() -> String {
        let marker = readJSONObject(crossAppTargetMarker)
        let markerTimestamp = marker?["timestamp"] as? String
        let markerDate = markerTimestamp.flatMap(parseISO8601Date)
        let entries = readHistory()
        let scannedEntries = markerTimestamp == nil
            ? entries
            : entries.filter { entry in
                if let markerDate, let entryDate = parseISO8601Date(entry.timestamp) {
                    return entryDate > markerDate
                }
                return entry.timestamp > (markerTimestamp ?? "")
            }
        let targetEntries = scannedEntries.filter { $0.target != nil }
        let requiredTargets = crossAppTargetRequirements()
        let missing = requiredTargets
            .filter { requirement in
                !targetEntries.contains { entry in
                    targetMatches(entry.target, bundles: requirement.bundles, nameHints: requirement.nameHints)
                }
            }
            .map { $0.label }
        let status = markerTimestamp == nil
            ? "pending - marker missing"
            : missing.isEmpty ? "ready" : "pending - missing \(missing.joined(separator: ", "))"

        var lines = [
            "# True Convo Cross-App Target Coverage",
            "",
            "Generated: \(ISO8601DateFormatter().string(from: Date()))",
            "History: \(history.path)",
            "Marker: \(crossAppTargetMarker.path)",
            "",
            "This report reads local archive metadata only. It does not print transcript text, record audio, request permissions, paste text, call providers, or change settings.",
            "",
            "## Status",
            "",
            "- Status: \(status)",
            "- Marker timestamp: \(markerTimestamp ?? "missing")",
            "- Total sessions: \(entries.count)",
            "- Scanned sessions: \(scannedEntries.count)",
            "- Scanned sessions with target metadata: \(targetEntries.count)",
            "",
            "## Required Smoke Targets",
            "",
            "| App | Status | Latest session | Timestamp | Provider/model | Capture mode | Target bundle | Insertion mode |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
        ]

        for requirement in requiredTargets {
            let matches = targetEntries.filter { entry in
                targetMatches(entry.target, bundles: requirement.bundles, nameHints: requirement.nameHints)
            }
            if let latest = matches.last, let target = latest.target {
                lines.append(tableRow([
                    requirement.label,
                    "ready",
                    latest.id,
                    latest.timestamp,
                    "\(latest.provider)/\(latest.model)",
                    latest.captureMode ?? "unknown",
                    target.bundleIdentifier,
                    target.insertionMode,
                ]))
            } else {
                lines.append(tableRow([
                    requirement.label,
                    "pending",
                    "missing",
                    "missing",
                    "missing",
                    "missing",
                    requirement.bundles.joined(separator: ", "),
                    "missing",
                ]))
            }
        }

        lines += [
            "",
            "## Recent Target Sessions",
            "",
        ]

        if targetEntries.isEmpty {
            lines.append("No scanned sessions include target metadata yet.")
            lines.append("")
        } else {
            lines.append("| Timestamp | Session | App | Bundle | Insertion mode | Provider/model | Capture mode | Injected |")
            lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
            for entry in targetEntries.suffix(20).reversed() {
                guard let target = entry.target else { continue }
                lines.append(tableRow([
                    entry.timestamp,
                    entry.id,
                    target.name,
                    target.bundleIdentifier,
                    target.insertionMode,
                    "\(entry.provider)/\(entry.model)",
                    entry.captureMode ?? "unknown",
                    entry.injected ? "yes" : "no",
                ]))
            }
            lines.append("")
        }

        lines += [
            "## Live Test Steps",
            "",
            "Run these from the repo path shown in Start Here:",
            "",
            "```bash",
            "npm run live-test:mark-cross-app-targets",
            "npm run verify:cross-app-targets:marked",
            "```",
            "",
            "Between those two commands, click into Hermes, Codex, Apple Notes, and TextEdit, then run a short dictation in each app. The terminal verifier is the stricter gate; this app report is the readable local view.",
            "",
        ]

        return lines.joined(separator: "\n") + "\n"
    }

    private static func crossAppTargetRequirements() -> [(label: String, bundles: [String], nameHints: [String])] {
        [
            ("Hermes", ["com.nousresearch.hermes"], ["hermes"]),
            ("Codex", ["com.openai.codex"], ["codex"]),
            ("Apple Notes", ["com.apple.Notes"], ["notes", "apple notes"]),
            ("TextEdit", ["com.apple.TextEdit"], ["textedit"]),
        ]
    }

    private static func targetMatches(_ target: TargetContext?, bundles: [String], nameHints: [String]) -> Bool {
        guard let target else { return false }
        if bundles.contains(target.bundleIdentifier) {
            return true
        }
        let targetName = target.name.lowercased()
        return nameHints.contains { targetName.contains($0.lowercased()) }
    }

    private static func parseISO8601Date(_ value: String) -> Date? {
        ISO8601DateFormatter().date(from: value)
    }

    private static func hermesAcceptanceReportBody() -> String {
        let latest = latestEntry()
        let repoURL = reportRepoRoot()
        let correctionCount = readHistory().filter { $0.correction != nil }.count
        let lines = [
            "# True Convo Hermes Acceptance",
            "",
            "Generated: \(ISO8601DateFormatter().string(from: Date()))",
            "",
            "This report is a local checklist for proving Hermes live insertion. It does not record audio, request permissions, paste text, call providers, or change settings.",
            "",
            "## Why This Exists",
            "",
            "Hermes is a keyboard-compatibility target, which means True Convo types live text with simulated keystrokes instead of relying on a normal Accessibility text field. The acceptance pass proves the app keeps live text stable, avoids live or late final rewrites, preserves the cleaned transcript, and captures a correction pair for Convo Engine review.",
            "",
            "## Current Readiness",
            "",
            "| Item | Status | Path/Detail |",
            "| --- | --- | --- |",
            tableRow(["Running app", filePresence(Bundle.main.bundleURL), Bundle.main.bundleURL.path]),
            tableRow(["Executable SHA-256", BuildFingerprint.executableSha256Description() == "unknown" ? "missing" : "present", BuildFingerprint.executableSha256Description()]),
            tableRow(["Repo", filePresence(repoURL), repoURL?.path ?? "unknown"]),
            tableRow(["Run log", filePresence(runLog), runLog.path]),
            tableRow(["Latest session", latest == nil ? "missing" : "present", latest?.id ?? latestSession.path]),
            tableRow(["Correction pairs", correctionCount > 0 ? "present" : "missing", "\(correctionCount) captured"]),
            tableRow(["Correction JSONL", filePresence(correctionPairsJSONL), correctionPairsJSONL.path]),
            "",
            "## Acceptance Steps",
            "",
            "1. Run `npm run hermes:acceptance-prep` from the repo.",
            "2. Confirm True Convo relaunches from the newly installed app.",
            "3. Choose Expert Tools > Proof & Diagnostics > Use Hermes Recommended Settings.",
            "4. In Hermes, click the active message box.",
            "5. Start True Convo, speak a long passage with ordinary punctuation pauses, then stop.",
            "6. Confirm the pill returns to ready quickly, the text does not live-rewrite while you are speaking, and the final cleanup does not flash-rewrite into another field.",
            "7. Type `deecay`, highlight exactly `deecay`, choose `Correct Selected Text Once`, say exactly `decay`, then stop.",
            "8. Write and verify the Convo Engine correction candidate and review queue.",
            "9. Run the Hermes acceptance verifier as the final all-clear check.",
            "",
            "## Terminal Commands",
            "",
            "Run these from the repo path above.",
            "",
            "```bash",
            "npm run hermes:acceptance-prep",
            "npm run phase2:guided-acceptance",
            "npm run verify:phase2-proof",
            "npm run phase2:evidence-bundle",
            "npm run phase2:correction-handoff:marked",
            "npm run verify:hermes-acceptance",
            "```",
            "",
            "`hermes:acceptance-prep` builds, installs, launches, and resets the Hermes marker only after the launched app logs the installed executable hash. The Phase 2 correction handoff command writes the current-build candidate files and local review queue. The Hermes acceptance verifier then uses a post-marker dry run plus the strict finish gate as the final all-clear.",
            "",
            "## What Passing Means",
            "",
            "- A post-marker Hermes dictation session exists from the expected executable.",
            "- No live keyboard rewrite happened while speaking.",
            "- No late keyboard final rewrite happened after stop.",
            "- No guarded live-preview session pasted or wrote a clipboard fallback into the wrong field later.",
            "- At least one selected-text correction pair was captured.",
            "- The correction pair is staged for human review, not automatically promoted as training data.",
            "",
        ]

        return lines.joined(separator: "\n") + "\n"
    }

    private static func reportRepoRoot() -> URL? {
        if let repo = packagedRepoRoot() {
            return repo
        }
        let candidate = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("cloudwork-systems/true-convo/convo-engine/extensions/vscode-tca-dictate")
        guard FileManager.default.fileExists(atPath: candidate.appendingPathComponent("package.json").path) else {
            return nil
        }
        return candidate
    }

    private static func shellQuoted(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }

    private static func currentModelName() -> String {
        switch Settings.provider {
        case .appleLocal: return "on-device"
        case .localWhisper: return Settings.localWhisperModel
        case .openAIRealtime: return Settings.openAIRealtimeModel
        case .openAICloud: return Settings.openAIModel
        case .groqCloud: return Settings.groqModel
        case .appleSpeechAnalyzer: return "speech-analyzer"
        }
    }

    private static func packagedRepoRoot() -> URL? {
        let distURL = Bundle.main.bundleURL.deletingLastPathComponent()
        guard distURL.lastPathComponent == "dist" else {
            return nil
        }
        let standaloneURL = distURL.deletingLastPathComponent()
        guard standaloneURL.lastPathComponent == "standalone-mac" else {
            return nil
        }
        return standaloneURL.deletingLastPathComponent()
    }

    private static func filePresence(_ url: URL?) -> String {
        guard let url else {
            return "unknown"
        }
        return FileManager.default.fileExists(atPath: url.path) ? "present" : "missing"
    }

    private static func proofSummaryRow(label: String, record: Any?) -> String {
        guard let record = record as? [String: Any],
              let session = record["session"] as? [String: Any]
        else {
            return tableRow([label, "no", "missing", "unknown", "unknown", "unknown", "none", "none", "none"])
        }
        return tableRow([
            label,
            "yes",
            stringValue(session["id"], fallback: "missing"),
            stringValue(session["provider"], fallback: "unknown"),
            boolValue(session["injected"]),
            stringValue(session["captureMode"], fallback: "unknown"),
            stringValue(session["audioPath"], fallback: "none"),
            stringValue(session["transcriptPath"], fallback: "none"),
            stringValue(session["contentPacketPath"], fallback: "none"),
        ])
    }

    private static func stringValue(_ value: Any?, fallback: String) -> String {
        if let value = value as? String, !value.isEmpty {
            return value
        }
        return fallback
    }

    private static func boolValue(_ value: Any?) -> String {
        guard let value = value as? Bool else {
            return "unknown"
        }
        return value ? "yes" : "no"
    }

    private static func readJSONObject(_ url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any]
        else {
            return nil
        }
        return dictionary
    }

    private static func timingReportBody(entries: [ArchiveEntry]) -> String {
        let timedEntries = entries.filter { $0.timing != nil }
        var lines = [
            "# True Convo Timing Report",
            "",
            "Generated: \(ISO8601DateFormatter().string(from: Date()))",
            "History: \(history.path)",
            "",
            "This report uses local archive metadata only. It does not reprocess audio, call cloud providers, or request permissions.",
            "",
            "## Summary By Provider And Model",
            "",
        ]

        let grouped = Dictionary(grouping: timedEntries) { entry in
            "\(entry.provider)\u{0}\(entry.model)"
        }
        let groups = grouped.values
            .map(Array.init)
            .sorted { left, right in
                let leftAverage = average(left.map { $0.timing?.totalStopProcessingMs }) ?? Double.greatestFiniteMagnitude
                let rightAverage = average(right.map { $0.timing?.totalStopProcessingMs }) ?? Double.greatestFiniteMagnitude
                return leftAverage < rightAverage
            }

        if groups.isEmpty {
            lines.append("No timed sessions have been archived yet.")
            lines.append("")
        } else {
            lines.append("| Provider | Model | Sessions | Avg duration | Avg first partial | Avg first final | Avg provider transcription | Avg archive finalization | Avg stop processing |")
            lines.append("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
            for group in groups {
                guard let first = group.first else { continue }
                lines.append(tableRow([
                    first.provider,
                    first.model,
                    "\(group.count)",
                    formatSecondsAverage(group.map { $0.durationMs }),
                    formatMsAverage(group.map { $0.timing?.liveFirstPartialMs }),
                    formatMsAverage(group.map { $0.timing?.liveFirstFinalMs }),
                    formatMsAverage(group.map { $0.timing?.postStopTranscriptionMs }),
                    formatMsAverage(group.map { $0.timing?.archiveFinalizeMs }),
                    formatMsAverage(group.map { $0.timing?.totalStopProcessingMs }),
                ]))
            }
            lines.append("")
        }

        lines.append("## Recent Timed Sessions")
        lines.append("")
        if timedEntries.isEmpty {
            lines.append("No recent timed sessions yet.")
            lines.append("")
        } else {
            lines.append("| Timestamp | Provider | Model | Derived | Duration | First partial | First final | Provider transcription | Stop processing | Transcript |")
            lines.append("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |")
            for entry in timedEntries.suffix(20).reversed() {
                lines.append(tableRow([
                    entry.timestamp,
                    entry.provider,
                    entry.model,
                    entry.derivedFromSessionId ?? "no",
                    formatSeconds(entry.durationMs),
                    formatMs(entry.timing?.liveFirstPartialMs),
                    formatMs(entry.timing?.liveFirstFinalMs),
                    formatMs(entry.timing?.postStopTranscriptionMs),
                    formatMs(entry.timing?.totalStopProcessingMs),
                    truncateForTable(entry.text),
                ]))
            }
            lines.append("")
        }

        return lines.joined(separator: "\n") + "\n"
    }

    private static func tableRow(_ values: [String]) -> String {
        "| " + values.map(escapeTable).joined(separator: " | ") + " |"
    }

    private static func escapeTable(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "|", with: "\\|")
    }

    private static func truncateForTable(_ value: String) -> String {
        let clean = value
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.isEmpty {
            return "(empty)"
        }
        if clean.count <= 64 {
            return clean
        }
        return String(clean.prefix(61)) + "..."
    }

    private static func average(_ values: [Int?]) -> Double? {
        let numeric = values.compactMap { value -> Double? in
            guard let value, value >= 0 else { return nil }
            return Double(value)
        }
        guard !numeric.isEmpty else { return nil }
        return numeric.reduce(0, +) / Double(numeric.count)
    }

    private static func formatMsAverage(_ values: [Int?]) -> String {
        guard let value = average(values) else {
            return "n/a"
        }
        return "\(Int(value.rounded()))ms"
    }

    private static func formatSecondsAverage(_ values: [Int]) -> String {
        guard let value = average(values.map(Optional.some)) else {
            return "n/a"
        }
        return String(format: "%.1fs", value / 1000.0)
    }

    private static func timingMetadataLines(_ timing: ArchiveTiming?) -> [String] {
        [
            "- First live partial: \(formatMs(timing?.liveFirstPartialMs))",
            "- First live final: \(formatMs(timing?.liveFirstFinalMs))",
            "- Provider transcription: \(formatMs(timing?.postStopTranscriptionMs))",
            "- Archive finalization: \(formatMs(timing?.archiveFinalizeMs))",
            "- Stop processing: \(formatMs(timing?.totalStopProcessingMs))",
        ]
    }

    private static func processingMetadataLines(_ processing: ProcessingContext) -> [String] {
        [
            "- Privacy lane: \(processing.privacyLane)",
            "- Cloud processed: \(processing.cloudProcessed ? "yes" : "no")",
            "- Cloud provider: \(processing.cloudProvider ?? "none")",
            "- Harvest use: \(processing.harvestUse)",
            "- Training eligibility: \(processing.trainingEligibility)",
            "- Training boundary: \(processing.trainingPromotionBoundary)",
        ]
    }

    private static func processingPacketLines(_ processing: ProcessingContext) -> [String] {
        [
            "- Privacy lane: \(processing.privacyLane)",
            "- Cloud processed: \(processing.cloudProcessed ? "yes" : "no")",
            "- Cloud provider: \(processing.cloudProvider ?? "none")",
            "- Harvest use: \(processing.harvestUse)",
            "- Training eligibility: \(processing.trainingEligibility)",
            "- Training boundary: \(processing.trainingPromotionBoundary)",
            "",
            processing.cloudProcessed
                ? "This session can remain in local transcript/content workflows, but it is not private voice-training material by default."
                : "This session stayed on the local/private lane and may be reviewed as a future private STT adaptation candidate.",
        ]
    }

    private static func targetMetadataLines(_ target: TargetContext?) -> [String] {
        guard let target else {
            return ["- Target app: not captured"]
        }
        return [
            "- Target app: \(target.name)",
            "- Target bundle: \(target.bundleIdentifier)",
            "- Target PID: \(target.processIdentifier.map(String.init) ?? "unknown")",
            "- Target insertion mode: \(target.insertionMode)",
            "- Target insertion source: \(target.insertionSource)",
            "- Target insertion profile: \(target.insertionProfile)",
            "- Target capture method: \(target.captureMethod)",
        ]
    }

    private static func timingPacketLines(_ timing: ArchiveTiming?) -> [String] {
        [
            "- First live partial: \(formatMs(timing?.liveFirstPartialMs)) from start.",
            "- First live final: \(formatMs(timing?.liveFirstFinalMs)) from start.",
            "- Provider transcription: \(formatMs(timing?.postStopTranscriptionMs)) after stop.",
            "- Archive finalization: \(formatMs(timing?.archiveFinalizeMs)) after stop.",
            "- Total stop processing: \(formatMs(timing?.totalStopProcessingMs)).",
        ]
    }

    private static func targetPacketLines(_ target: TargetContext?) -> [String] {
        guard let target else { return ["No target app metadata captured."] }
        return [
            "- App: \(target.name)",
            "- Bundle identifier: \(target.bundleIdentifier)",
            "- Process ID: \(target.processIdentifier.map(String.init) ?? "unknown")",
            "- Insertion mode: \(target.insertionMode)",
            "- Insertion source: \(target.insertionSource)",
            "- Insertion profile: \(target.insertionProfile)",
            "- Capture method: \(target.captureMethod)",
        ]
    }

    private static func correctionMetadataLines(_ correction: CorrectionContext?) -> [String] {
        guard let correction else { return [] }
        return [
            "- Correction: yes",
            "- Corrected selection: \(inlineSummary(correction.selectedText))",
            "- Replacement: \(inlineSummary(correction.replacementText))",
            "- Correction target: \(correction.targetName) (\(correction.targetBundle))",
            "- Correction capture: \(correction.captureMethod)",
        ]
    }

    private static func correctionPacketLines(_ correction: CorrectionContext?) -> [String] {
        guard let correction else {
            return ["No selected-text correction captured for this session."]
        }

        return [
            "- Target app: \(correction.targetName) (\(correction.targetBundle))",
            "- Capture method: \(correction.captureMethod)",
            "",
            "### Selected Text",
            "",
            correction.selectedText,
            "",
            "### Spoken Replacement",
            "",
            correction.replacementText,
            "",
            "### Convo Engine Review Note",
            "",
            "Treat this as a correction pair: the selected text is what the owner marked as wrong or undesirable, and the spoken replacement is the preferred wording for future speech-to-text adaptation.",
            "",
            "This is review evidence, not automatic training data. Convo Engine must reject bad captures before anything is promoted.",
        ]
    }

    private static func inlineSummary(_ value: String) -> String {
        let clean = value
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.count <= 80 {
            return clean
        }
        return String(clean.prefix(77)) + "..."
    }

    private static func formatMs(_ value: Int?) -> String {
        guard let value, value >= 0 else {
            return "not captured"
        }
        return "\(value)ms"
    }

    private static func formatSeconds(_ value: Int?) -> String {
        guard let value, value >= 0 else {
            return "n/a"
        }
        return String(format: "%.1fs", Double(value) / 1000.0)
    }

    private static func writeContentPacketFile(_ entry: ArchiveEntry, updateLatest: Bool) throws {
        try ensureDirectories()
        let url = entry.contentPacketPath.map(URL.init(fileURLWithPath:)) ?? contentPacketURL(for: entry.id)
        let body = contentPacketBody(for: entry)
        try body.write(to: url, atomically: true, encoding: .utf8)
        if updateLatest {
            try body.write(to: latestContentPacket, atomically: true, encoding: .utf8)
            try writeLatestSessionFile(entry, contentPacketURL: url)
        } else {
            RunLog.write("archive.latest.skipped", "kind=packet id=\(entry.id) timestamp=\(entry.timestamp)")
        }
    }

    private static func writeLatestSessionFile(_ entry: ArchiveEntry, contentPacketURL: URL) throws {
        let payload: [String: Any] = [
            "id": entry.id,
            "timestamp": entry.timestamp,
            "durationMs": entry.durationMs,
            "text": entry.text,
            "audioPath": entry.audioPath ?? NSNull(),
            "contentPacketPath": contentPacketURL.path,
            "derivedFromSessionId": entry.derivedFromSessionId ?? NSNull(),
            "captureMode": entry.captureMode ?? NSNull(),
            "timing": entry.timing?.jsonObject ?? NSNull(),
            "transcriptPath": transcriptURL(for: entry.id).path,
            "latestTranscriptPath": latestTranscript.path,
            "latestContentPacketPath": latestContentPacket.path,
            "latestSessionPath": latestSession.path,
            "provider": entry.provider,
            "model": entry.model,
            "language": entry.language,
            "source": entry.source,
            "injected": entry.injected,
            "target": entry.target?.jsonObject ?? NSNull(),
            "correction": entry.correction?.jsonObject ?? NSNull(),
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: latestSession, options: .atomic)
    }

    static func finalizeAudio(_ wavURL: URL, format: ArchiveFormat, processes: RecordingProcessOwner? = nil) async throws -> URL {
        guard format == .flac else {
            return wavURL
        }

        let flacURL = wavURL.deletingPathExtension().appendingPathExtension("flac")
        try await ProcessRunner.run(
            executable: Settings.ffmpegBinary,
            arguments: [
                "-i", wavURL.path,
                "-c:a", "flac",
                "-sample_fmt", "s16",
                "-ar", "16000",
                flacURL.path,
                "-y",
                "-loglevel", "quiet",
            ],
            processes: processes
        )
        try? FileManager.default.removeItem(at: wavURL)
        return flacURL
    }
}

enum RunLog {
    static func write(_ event: String, _ detail: String = "") {
        let cleanEvent = clean(event)
        let cleanDetail = redact(clean(detail))
        let suffix = cleanDetail.isEmpty ? "" : " \(cleanDetail)"
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(cleanEvent)\(suffix)\n"

        do {
            try FileManager.default.createDirectory(at: Archive.root, withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: Archive.runLog.path) {
                FileManager.default.createFile(atPath: Archive.runLog.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: Archive.runLog)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: Data(line.utf8))
        } catch {
            // Logging must never break dictation.
        }
    }

    static func tail(maxLines: Int = 8) -> [String] {
        guard let text = try? String(contentsOf: Archive.runLog, encoding: .utf8) else {
            return ["(no run log yet)"]
        }
        let lines = text
            .split(whereSeparator: \.isNewline)
            .map(String.init)
        return Array(lines.suffix(maxLines))
    }

    private static func clean(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func redact(_ value: String) -> String {
        var output = value
        let patterns = [
            #"sk-[A-Za-z0-9_-]{20,}"#,
            #"gsk_[A-Za-z0-9_-]{20,}"#,
            #"Bearer\s+[A-Za-z0-9._~+/=-]{20,}"#,
        ]

        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern) {
                let range = NSRange(location: 0, length: output.utf16.count)
                output = regex.stringByReplacingMatches(
                    in: output,
                    options: [],
                    range: range,
                    withTemplate: "[redacted]"
                )
            }
        }
        return output
    }
}

enum BuildFingerprint {
    static func launchDetail() -> String {
        var parts = [
            "version=\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown")",
            "bundle=\(Bundle.main.bundleIdentifier ?? "unknown")",
            "path=\"\(quotedLogValue(Bundle.main.bundlePath))\"",
        ]

        if let executableURL = Bundle.main.executableURL {
            parts.append("executable=\"\(quotedLogValue(executableURL.path))\"")
            if let modified = executableModifiedDate(executableURL) {
                parts.append("executableModified=\(ISO8601DateFormatter().string(from: modified))")
            }
            if let hash = sha256File(executableURL) {
                parts.append("executableSha256=\(hash)")
            }
        }

        return parts.joined(separator: " ")
    }

    private static func quotedLogValue(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    static func executableModifiedDescription() -> String {
        guard let executableURL = Bundle.main.executableURL,
              let modified = executableModifiedDate(executableURL)
        else {
            return "unknown"
        }
        return ISO8601DateFormatter().string(from: modified)
    }

    static func executableSha256Description() -> String {
        guard let executableURL = Bundle.main.executableURL,
              let hash = sha256File(executableURL)
        else {
            return "unknown"
        }
        return hash
    }

    private static func executableModifiedDate(_ url: URL) -> Date? {
        let values = try? url.resourceValues(forKeys: [.contentModificationDateKey])
        return values?.contentModificationDate
    }

    private static func sha256File(_ url: URL) -> String? {
        guard let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else {
            return nil
        }
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

struct AudioInputDevice {
    let id: AudioObjectID
    let uid: String
    let name: String
}

enum AudioDeviceInfo {
    static let systemDefaultUID = "system-default"

    static func defaultInputDescription() -> String {
        defaultInputDevice()?.name ?? AVCaptureDevice.default(for: .audio)?.localizedName ?? "unknown"
    }

    static func selectedInputLabel() -> String {
        let uid = Settings.audioInputDeviceUID
        guard uid != systemDefaultUID else {
            return "System Default (\(defaultInputDescription()))"
        }
        return inputDevices().first { $0.uid == uid }?.name ?? "Missing input (\(uid))"
    }

    static func inputDevices() -> [AudioInputDevice] {
        allAudioDeviceIDs()
            .filter(hasInputStreams)
            .compactMap { id in
                guard let uid = stringProperty(id, selector: kAudioDevicePropertyDeviceUID) else { return nil }
                let name = stringProperty(id, selector: kAudioObjectPropertyName) ?? uid
                return AudioInputDevice(id: id, uid: uid, name: name)
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    @discardableResult
    static func applySelectedInputIfNeeded() -> Bool {
        let uid = Settings.audioInputDeviceUID
        guard uid != systemDefaultUID else { return true }
        // True Convo Test never changes the Mac's default microphone; it
        // records from whatever input the Mac already uses.
        guard AppIdentity.current.mayChangeSystemDefaultInput else {
            RunLog.write("audio-input.apply.skipped", "reason=test-copy uid=\(uid)")
            return true
        }
        guard let device = inputDevices().first(where: { $0.uid == uid }) else {
            RunLog.write("audio-input.apply.failed", "reason=missing uid=\(uid)")
            return false
        }
        let applied = setDefaultInputDevice(device.id)
        RunLog.write(
            applied ? "audio-input.applied" : "audio-input.apply.failed",
            "name=\"\(device.name)\" uid=\(device.uid)"
        )
        return applied
    }

    static func selectInputDevice(uid: String) -> Bool {
        guard uid == systemDefaultUID || AppIdentity.current.mayChangeSystemDefaultInput else {
            RunLog.write("audio-input.select.refused", "reason=test-copy")
            return false
        }
        Settings.audioInputDeviceUID = uid
        return applySelectedInputIfNeeded()
    }

    /// The sample rate of the input the next dictation will use (the chosen
    /// input, else the system default), or nil if unknown. Reads a device
    /// property only; the microphone is not opened.
    static func dictationInputSampleRate() -> Double? {
        let uid = Settings.audioInputDeviceUID
        let chosen = uid == systemDefaultUID ? nil : inputDevices().first { $0.uid == uid }
        guard let deviceId = chosen?.id ?? defaultInputDevice()?.id else { return nil }
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var rate = Float64(0)
        var size = UInt32(MemoryLayout<Float64>.size)
        let status = AudioObjectGetPropertyData(deviceId, &address, 0, nil, &size, &rate)
        return status == noErr && rate > 0 ? rate : nil
    }

    private static func defaultInputDevice() -> AudioInputDevice? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var deviceId = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            &deviceId
        )
        guard status == noErr, deviceId != kAudioObjectUnknown else { return nil }
        let uid = stringProperty(deviceId, selector: kAudioDevicePropertyDeviceUID) ?? "id-\(deviceId)"
        let name = stringProperty(deviceId, selector: kAudioObjectPropertyName) ?? uid
        return AudioInputDevice(id: deviceId, uid: uid, name: name)
    }

    private static func allAudioDeviceIDs() -> [AudioObjectID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        let sizeStatus = AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size
        )
        guard sizeStatus == noErr, size > 0 else { return [] }

        let count = Int(size) / MemoryLayout<AudioObjectID>.size
        var devices = [AudioObjectID](repeating: AudioObjectID(kAudioObjectUnknown), count: count)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            &devices
        )
        guard status == noErr else { return [] }
        return devices
    }

    private static func hasInputStreams(_ deviceId: AudioObjectID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        let status = AudioObjectGetPropertyDataSize(deviceId, &address, 0, nil, &size)
        return status == noErr && size > 0
    }

    private static func stringProperty(_ deviceId: AudioObjectID, selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(deviceId, &address, 0, nil, &size, &value)
        guard status == noErr else { return nil }
        return value?.takeUnretainedValue() as String?
    }

    private static func setDefaultInputDevice(_ deviceId: AudioObjectID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var mutableDeviceId = deviceId
        let size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectSetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            size,
            &mutableDeviceId
        )
        return status == noErr
    }
}

struct PasteboardSnapshot {
    let items: [[NSPasteboard.PasteboardType: Data]]

    static func capture() -> PasteboardSnapshot {
        let pasteboard = NSPasteboard.general
        let captured = pasteboard.pasteboardItems?.map { item in
            item.types.reduce(into: [NSPasteboard.PasteboardType: Data]()) { dict, type in
                dict[type] = item.data(forType: type)
            }
        } ?? []
        return PasteboardSnapshot(items: captured)
    }

    func restore() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        let restoredItems = items.map { itemData -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in itemData {
                item.setData(data, forType: type)
            }
            return item
        }
        if !restoredItems.isEmpty {
            pasteboard.writeObjects(restoredItems)
        }
    }
}

enum TextInjector {
    private enum LivePreviewInputMode {
        case accessibility
        case keyboardCompatibility

        var logValue: String {
            switch self {
            case .accessibility: return "accessibility"
            case .keyboardCompatibility: return "keyboard-compatibility"
            }
        }
    }

    private struct AppInsertionProfile {
        let name: String
        let livePreviewMode: InsertionMode
        let reason: String
    }

    struct CompatibilityProfile {
        let bundleIdentifier: String
        let name: String
        let mode: InsertionMode
        let reason: String
    }

    private struct LivePreviewDecision {
        let mode: InsertionMode
        let source: String
        let profileName: String
        let reason: String
    }

    enum LivePreviewCompletionResult {
        case inactive
        case inserted
        case committedLiveText
        case committedGuardedLiveText
        case suppressedLateInsertion
        /// Live typing typed nothing (a short phrase) and no safety stop
        /// fired: the final text is typed by the pending swap once ready.
        /// Nothing else may paste it on its own.
        case awaitingFinalText

        var insertedOrCommitted: Bool {
            self == .inserted || self == .committedLiveText || self == .committedGuardedLiveText
        }

        var suppressesLateInsertion: Bool {
            self == .suppressedLateInsertion || self == .committedGuardedLiveText || self == .awaitingFinalText
        }
    }

    private struct PendingCorrectionSelection {
        let selectedText: String
        let targetBundle: String
        let targetName: String
        let captureMethod: String
    }

    private struct PendingKeyboardFinalReconcile {
        let application: NSRunningApplication
        let liveText: String
        let startedWithSelection: Bool
    }

    struct CorrectionCaptureFeedback {
        let captured: Bool
        let statusText: String
    }

    static var targetApplication: NSRunningApplication?
    private static var targetElement: AXUIElement?
    private static var livePreviewElement: AXUIElement?
    private static var livePreviewStartRange: CFRange?
    private static var livePreviewInputMode: LivePreviewInputMode?
    private static var livePreviewAcceptsPartials = false
    private static var livePreviewStartedWithSelection = false
    private static var livePreviewText = ""
    private static var livePreviewKeyboardWorkItem: DispatchWorkItem?
    private static var livePreviewRequiresFinalPaste = false
    private static var livePreviewGuardReason: String?
    private static var livePreviewKeyboardPreviousRecognitionText: String?
    private static var livePreviewKeyboardContinuationBase: String?
    private static var livePreviewKeyboardContinuationFragment: String?
    private static var livePreviewCorrectionReplacementArmed = false
    private static var externalFinalPasteGuardReason: String?
    private static var pendingKeyboardFinalReconcile: PendingKeyboardFinalReconcile?
    private static var pendingKeyboardFinalReconcileGuardReason: String?
    /// The clipboard's change count when the dictation started, moved past
    /// True Convo's own writes. If it moves, the owner copied or cut something.
    private static var clipboardChangeCountAtDictationStart: Int?
    private static var sawCopyOrCutDuringDictation = false
    private static var pendingCorrectionSelection: PendingCorrectionSelection?
    private static var oneShotCorrectionCaptureArmed = false
    private static var hotKeyIsDown = false
    private static var pendingPasteText: String?
    private static var pendingPasteFallbackWorkItem: DispatchWorkItem?
    static var externalLivePreviewGuardHandler: ((String) -> Void)?
    /// The Desk window's last-moment shield (Desk window, build 9), asked
    /// just before a synthetic paste, typing or Return: true while the Desk
    /// window holds the focus, when that input would land in the Desk
    /// instead of the outside app. The app notes what was held back, so the
    /// pill never claims it happened. False until the Desk is first opened.
    static var deskShieldHoldsBack: (DeskDictationPolicy.ShieldedInput) -> Bool = { _ in false }
    private static let correctionSelectionMaxCharacters = 500
    // Electron-backed editors can take a beat to service Copy after a global
    // shortcut releases. This wait only runs during an explicit correction.
    private static let correctionClipboardWaitSeconds: TimeInterval = 0.75
    private static let appInsertionProfiles: [String: AppInsertionProfile] = [
        "com.apple.Notes": AppInsertionProfile(
            name: "Apple Notes",
            livePreviewMode: .keyboardCompatibility,
            reason: "Notes reports Accessibility text updates as successful without reliably updating the visible note body."
        ),
        "com.apple.TextEdit": AppInsertionProfile(
            name: "TextEdit",
            livePreviewMode: .accessibility,
            reason: "TextEdit exposes a normal editable text area through Accessibility."
        ),
        "com.openai.codex": AppInsertionProfile(
            name: "Codex",
            livePreviewMode: .keyboardCompatibility,
            reason: "Codex does not reliably expose its chat input as a focused Accessibility text field."
        ),
        "com.nousresearch.hermes": AppInsertionProfile(
            name: "Hermes",
            livePreviewMode: .keyboardCompatibility,
            reason: "Hermes does not reliably expose its agent input as a focused Accessibility text field."
        ),
    ]

    static var targetDescription: String {
        describe(targetApplication)
    }

    static func currentTargetContext() -> TargetContext? {
        guard let application = targetApplication, !application.isTerminated else { return nil }
        let bundleIdentifier = application.bundleIdentifier ?? "unknown"
        let name = application.localizedName ?? bundleIdentifier
        let decision = livePreviewDecision()
        let captureMethod = targetElement == nil
            ? "frontmost-application"
            : "focused-accessibility-element"
        return TargetContext(
            bundleIdentifier: bundleIdentifier,
            name: name,
            processIdentifier: Int(application.processIdentifier),
            insertionMode: decision.mode.rawValue,
            insertionSource: decision.source,
            insertionProfile: decision.profileName,
            captureMethod: captureMethod
        )
    }

    static var compatibilityProfiles: [CompatibilityProfile] {
        appInsertionProfiles
            .map { bundleIdentifier, profile in
                CompatibilityProfile(
                    bundleIdentifier: bundleIdentifier,
                    name: profile.name,
                    mode: profile.livePreviewMode,
                    reason: profile.reason
                )
            }
            .sorted { $0.name < $1.name }
    }

    static var canAutoPaste: Bool {
        AXIsProcessTrusted()
    }

    /// Accessibility permission allows a keyboard-paste attempt, but only a
    /// writable focused text element lets the app confirm insertion honestly.
    static var canConfirmFinalPaste: Bool {
        guard let targetElement else { return false }
        var settable = DarwinBoolean(false)
        let status = AXUIElementIsAttributeSettable(
            targetElement,
            kAXSelectedTextAttribute as CFString,
            &settable
        )
        return status == .success && settable.boolValue
    }

    static var isLivePreviewActive: Bool {
        livePreviewInputMode != nil
    }

    static var hasPendingFinalReconcile: Bool {
        pendingKeyboardFinalReconcile != nil
    }

    static func rememberFocusedElement() {
        guard accessibilityTrusted(prompt: false) else {
            targetElement = nil
            RunLog.write("cursor-focus.capture.skipped", "accessibility=not-trusted")
            return
        }

        let systemElement = AXUIElementCreateSystemWide()
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(
            systemElement,
            kAXFocusedUIElementAttribute as CFString,
            &value
        )

        if status != .success || value == nil,
           let application = targetApplication
        {
            let appElement = AXUIElementCreateApplication(application.processIdentifier)
            let fallbackStatus = AXUIElementCopyAttributeValue(
                appElement,
                kAXFocusedUIElementAttribute as CFString,
                &value
            )
            if fallbackStatus != .success {
                targetElement = nil
                RunLog.write(
                    "cursor-focus.capture.failed",
                    "status=\(status.rawValue) fallbackStatus=\(fallbackStatus.rawValue)"
                )
                return
            }
        }

        guard let value else {
            targetElement = nil
            RunLog.write("cursor-focus.capture.failed", "status=\(status.rawValue)")
            return
        }

        let element = value as! AXUIElement
        targetElement = element
        RunLog.write("cursor-focus.captured", describe(element))
    }

    /// `allowed: false` (a Desk recording) resets the state and starts nothing.
    static func beginLivePreviewIfNeeded(allowed: Bool = true) {
        livePreviewRequiresFinalPaste = false
        livePreviewGuardReason = nil
        externalFinalPasteGuardReason = nil
        livePreviewKeyboardPreviousRecognitionText = nil
        livePreviewKeyboardContinuationBase = nil
        livePreviewKeyboardContinuationFragment = nil
        livePreviewCorrectionReplacementArmed = pendingCorrectionSelection != nil
        guard allowed else {
            // A Desk recording: whatever an earlier start left behind (a
            // capture that failed after its preview began) is cleared, so no
            // partial can ever reach that old outside target.
            livePreviewAcceptsPartials = false
            clearLivePreviewState()
            return
        }
        guard Settings.liveInsertApplePartials else { return }
        guard Settings.completionAction == .autoPaste || Settings.completionAction == .autoSubmit else { return }
        let decision = livePreviewDecision()
        guard decision.mode != .finalPasteOnly else {
            RunLog.write(
                "completion.live-preview.skipped",
                "reason=final-paste-only source=\(decision.source) profile=\(decision.profileName)"
            )
            return
        }
        guard accessibilityTrusted(prompt: false) else {
            RunLog.write("completion.live-preview.skipped", "reason=accessibility-not-trusted mode=\(decision.mode.rawValue)")
            return
        }

        if decision.mode == .keyboardCompatibility {
            let range = targetElement.flatMap { selectedTextRange(for: $0, logFailure: false) }
            livePreviewElement = targetElement
            livePreviewStartRange = range ?? CFRange(location: 0, length: 0)
            livePreviewInputMode = .keyboardCompatibility
            livePreviewAcceptsPartials = true
            livePreviewStartedWithSelection = livePreviewCorrectionReplacementArmed || (range?.length ?? 0) > 0
            livePreviewText = ""
            RunLog.write(
                "completion.live-preview.started",
                "mode=keyboard-compatibility source=\(decision.source) profile=\(decision.profileName) reason=\(decision.reason) correctionReplacement=\(livePreviewCorrectionReplacementArmed)"
            )
            return
        }
        guard let targetElement else {
            RunLog.write("completion.live-preview.skipped", "reason=no-focused-element profile=\(decision.profileName)")
            return
        }
        guard let range = selectedTextRange(for: targetElement) else {
            RunLog.write("completion.live-preview.skipped", "reason=no-selected-text-range profile=\(decision.profileName)")
            return
        }
        livePreviewElement = targetElement
        livePreviewStartRange = range
        livePreviewInputMode = .accessibility
        livePreviewAcceptsPartials = true
        livePreviewStartedWithSelection = livePreviewCorrectionReplacementArmed || range.length > 0
        livePreviewText = ""
        RunLog.write(
            "completion.live-preview.started",
            "mode=\(livePreviewInputMode?.logValue ?? "unknown") source=\(decision.source) profile=\(decision.profileName) location=\(range.location) length=\(range.length) correctionReplacement=\(livePreviewCorrectionReplacementArmed)"
        )
    }

    static func captureCorrectionContextIfNeeded() -> CorrectionCaptureFeedback {
        pendingCorrectionSelection = nil
        let oneShot = oneShotCorrectionCaptureArmed
        oneShotCorrectionCaptureArmed = false
        let captureScope = oneShot ? "one-shot" : "persistent"
        guard Settings.captureSelectionCorrections || oneShot else {
            return CorrectionCaptureFeedback(captured: false, statusText: "Convo Engine harvest off")
        }
        guard canAutoPaste else {
            RunLog.write("correction.capture.skipped", "scope=\(captureScope) reason=accessibility-not-trusted")
            return CorrectionCaptureFeedback(captured: false, statusText: "Correction capture needs Accessibility")
        }
        guard let targetApplication, !targetApplication.isTerminated else {
            RunLog.write("correction.capture.skipped", "scope=\(captureScope) reason=no-target-application")
            return CorrectionCaptureFeedback(captured: false, statusText: "No correction target")
        }

        let targetBundle = targetApplication.bundleIdentifier ?? "unknown"
        let targetName = targetApplication.localizedName ?? targetBundle

        if let selectedText = targetElement.flatMap(selectedTextForCorrection(in:)) {
            pendingCorrectionSelection = PendingCorrectionSelection(
                selectedText: selectedText,
                targetBundle: targetBundle,
                targetName: targetName,
                captureMethod: oneShot ? "one-shot/accessibility-selected-text" : "persistent/accessibility-selected-text"
            )
            RunLog.write("correction.selection.captured", "scope=\(captureScope) method=accessibility chars=\(selectedText.count)")
            return CorrectionCaptureFeedback(
                captured: true,
                statusText: "Correction armed: \(targetName), \(selectedText.count) chars"
            )
        }

        guard oneShot else {
            RunLog.write("correction.capture.skipped", "scope=\(captureScope) reason=clipboard-probe-skipped-for-normal-dictation")
            return CorrectionCaptureFeedback(captured: false, statusText: "No selected text for correction")
        }

        if let selectedText = copySelectedTextForCorrection(from: targetApplication) {
            pendingCorrectionSelection = PendingCorrectionSelection(
                selectedText: selectedText,
                targetBundle: targetBundle,
                targetName: targetName,
                captureMethod: oneShot ? "one-shot/clipboard-selection-snapshot" : "persistent/clipboard-selection-snapshot"
            )
            RunLog.write("correction.selection.captured", "scope=\(captureScope) method=clipboard chars=\(selectedText.count)")
            return CorrectionCaptureFeedback(
                captured: true,
                statusText: "Correction armed: \(targetName), \(selectedText.count) chars"
            )
        }

        RunLog.write("correction.capture.skipped", "scope=\(captureScope) reason=no-selected-text")
        return CorrectionCaptureFeedback(captured: false, statusText: "No selected text for correction")
    }

    static func armOneShotCorrectionCapture() {
        pendingCorrectionSelection = nil
        oneShotCorrectionCaptureArmed = true
        RunLog.write("correction.capture.once.armed")
    }

    /// The captured selection's text, for showing in the typed-correction
    /// dialog before a replacement exists. Does not consume the capture.
    static var pendingCorrectionSelectedText: String? {
        pendingCorrectionSelection?.selectedText
    }

    static func clearOneShotCorrectionCapture() {
        oneShotCorrectionCaptureArmed = false
    }

    static func consumeCorrectionContext(replacementText: String) -> CorrectionContext? {
        guard let pending = pendingCorrectionSelection else { return nil }
        pendingCorrectionSelection = nil
        return correctionContext(from: pending, replacementText: replacementText)
    }

    static func consumeCorrectionContextBuilder() -> ((String) -> CorrectionContext?)? {
        guard let pending = pendingCorrectionSelection else { return nil }
        pendingCorrectionSelection = nil
        return { replacementText in
            correctionContext(from: pending, replacementText: replacementText)
        }
    }

    private static func correctionContext(
        from pending: PendingCorrectionSelection,
        replacementText: String
    ) -> CorrectionContext? {
        let replacement = normalizedCorrectionText(replacementText)
        guard !replacement.isEmpty else {
            RunLog.write("correction.selection.discarded", "reason=empty-replacement")
            return nil
        }
        RunLog.write(
            "correction.selection.archived",
            "selectedChars=\(pending.selectedText.count) replacementChars=\(replacement.count) target=\(pending.targetBundle)"
        )
        return CorrectionContext(
            selectedText: pending.selectedText,
            replacementText: replacement,
            targetBundle: pending.targetBundle,
            targetName: pending.targetName,
            captureMethod: pending.captureMethod
        )
    }

    static func clearCorrectionContext() {
        pendingCorrectionSelection = nil
        oneShotCorrectionCaptureArmed = false
    }

    static func updateLivePreview(_ text: String) {
        guard Settings.liveInsertApplePartials else { return }
        guard livePreviewAcceptsPartials else { return }
        let cleanText = text
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanText.isEmpty else { return }

        DispatchQueue.main.async {
            if livePreviewInputMode == .keyboardCompatibility {
                let stabilizedText = LiveKeyboardPreviewPolicy.stabilizedPreviewText(
                    previousText: livePreviewKeyboardPreviousRecognitionText,
                    currentText: cleanText,
                    alreadyInsertedText: livePreviewText,
                    holdBackWords: 2
                )
                livePreviewKeyboardPreviousRecognitionText = cleanText
                guard stabilizedText != livePreviewText else { return }
                scheduleKeyboardLivePreviewUpdate(stabilizedText)
                return
            }

            guard let element = livePreviewElement,
                  let startRange = livePreviewStartRange
            else { return }

            let replacementLength = livePreviewText.isEmpty ? startRange.length : utf16Length(livePreviewText)
            let range = CFRange(location: startRange.location, length: replacementLength)
            guard replaceText(cleanText, in: element, range: range, eventPrefix: "completion.live-preview") else {
                cancelLivePreview(removeInserted: false)
                return
            }
            livePreviewText = cleanText
        }
    }

    static func freezeLivePreviewPartials() {
        livePreviewAcceptsPartials = false
        livePreviewKeyboardWorkItem?.cancel()
        livePreviewKeyboardWorkItem = nil
        RunLog.write("completion.live-preview.partials-frozen")
    }

    @discardableResult
    static func commitLivePreviewForImmediateStop(
        suppressDelayedInsertIfNoLiveText: Bool = false
    ) -> LivePreviewCompletionResult {
        guard Settings.liveInsertApplePartials
        else {
            return .inactive
        }
        let keyboardCompatibility = livePreviewInputMode == .keyboardCompatibility
        let shouldCommit = LiveKeyboardPreviewPolicy.shouldCommitLiveTextOnStop(
            keepLiveText: Settings.finalRewriteMode == .keepLiveText,
            keyboardCompatibility: keyboardCompatibility
        )
        guard shouldCommit else { return .inactive }
        guard livePreviewInputMode != nil else {
            RunLog.write("completion.live-preview.commit.skipped", "reason=no-live-preview")
            return .inactive
        }
        guard !livePreviewText.isEmpty else {
            if keyboardCompatibility {
                let application = targetApplication.flatMap { $0.isTerminated ? nil : $0 }
                let plan = LiveKeyboardPreviewPolicy.noLiveTextStopPlan(
                    safetyStopFired: livePreviewRequiresFinalPaste,
                    targetAppAvailable: application != nil
                )
                if plan == .typeFinalWhenReady, let application {
                    // A short phrase: live typing held back its last words,
                    // so nothing is typed yet. Type the final text when it is
                    // ready, with the same checks as the live-words swap.
                    pendingKeyboardFinalReconcile = PendingKeyboardFinalReconcile(
                        application: application,
                        liveText: "",
                        startedWithSelection: livePreviewStartedWithSelection
                    )
                    pendingKeyboardFinalReconcileGuardReason = nil
                    RunLog.write(
                        "completion.live-preview.final-reconcile.pending",
                        "mode=keyboard-compatibility liveChars=0 reason=no-live-text target=\(describe(application))"
                    )
                    clearLivePreviewState()
                    return .awaitingFinalText
                }
            }
            if livePreviewRequiresFinalPaste {
                RunLog.write(
                    "completion.live-preview.late-insertion-suppressed",
                    "reason=\(livePreviewGuardReason ?? "external-guard")-no-live-text mode=\(livePreviewInputMode?.logValue ?? "unknown")"
                )
                clearLivePreviewState()
                return .suppressedLateInsertion
            }
            if keyboardCompatibility {
                let reason = suppressDelayedInsertIfNoLiveText
                    ? "keyboard-compatibility-no-live-text-post-stop-provider"
                    : "keyboard-compatibility-no-live-text"
                RunLog.write(
                    "completion.live-preview.late-insertion-suppressed",
                    "reason=\(reason) mode=keyboard-compatibility"
                )
                clearLivePreviewState()
                return .suppressedLateInsertion
            }
            RunLog.write(
                "completion.live-preview.commit.skipped",
                "reason=no-live-text mode=\(livePreviewInputMode?.logValue ?? "unknown")"
            )
            return .inactive
        }

        let externalGuard = livePreviewRequiresFinalPaste
        if keyboardCompatibility,
           !externalGuard,
           let application = targetApplication,
           !application.isTerminated
        {
            pendingKeyboardFinalReconcile = PendingKeyboardFinalReconcile(
                application: application,
                liveText: livePreviewText,
                startedWithSelection: livePreviewStartedWithSelection
            )
            pendingKeyboardFinalReconcileGuardReason = nil
            RunLog.write(
                "completion.live-preview.final-reconcile.pending",
                "mode=keyboard-compatibility liveChars=\(livePreviewText.count) target=\(describe(application))"
            )
        }
        RunLog.write(
            "completion.live-preview.committed",
            "reason=\(keyboardCompatibility ? "keyboard-compatibility" : "keep-live-text") mode=\(livePreviewInputMode?.logValue ?? "unknown") liveChars=\(livePreviewText.count) externalGuard=\(externalGuard)"
        )
        clearLivePreviewState()
        return externalGuard ? .committedGuardedLiveText : .committedLiveText
    }

    @discardableResult
    static func guardLivePreviewForExternalShortcut(keyCode: UInt16, modifiers: NSEvent.ModifierFlags) -> Bool {
        guard livePreviewInputMode == .keyboardCompatibility,
              livePreviewAcceptsPartials
        else { return false }

        guard let guardReason = livePreviewKeyboardGuardReason(keyCode: keyCode, modifiers: modifiers) else { return false }

        livePreviewAcceptsPartials = false
        livePreviewRequiresFinalPaste = true
        livePreviewGuardReason = guardReason
        livePreviewKeyboardWorkItem?.cancel()
        livePreviewKeyboardWorkItem = nil
        RunLog.write(
            "completion.live-preview.guarded",
            "mode=keyboard-compatibility reason=\(guardReason) keyCode=\(keyCode) key=\(keyDescription(keyCode)) modifiers=\(modifierDescription(modifiers))"
        )
        externalLivePreviewGuardHandler?(guardReason)
        return true
    }

    @discardableResult
    static func guardLivePreviewForExternalPointer(eventType: String) -> Bool {
        guard livePreviewInputMode == .keyboardCompatibility,
              livePreviewAcceptsPartials
        else { return false }

        livePreviewAcceptsPartials = false
        livePreviewRequiresFinalPaste = true
        livePreviewGuardReason = "external-pointer"
        livePreviewKeyboardWorkItem?.cancel()
        livePreviewKeyboardWorkItem = nil
        RunLog.write(
            "completion.live-preview.guarded",
            "mode=keyboard-compatibility reason=external-pointer event=\(eventType)"
        )
        externalLivePreviewGuardHandler?("external-pointer")
        return true
    }

    static var hasExternalFinalPasteGuard: Bool {
        externalFinalPasteGuardReason != nil
    }

    @discardableResult
    static func guardFinalPasteForExternalShortcut(keyCode: UInt16, modifiers: NSEvent.ModifierFlags) -> String? {
        guard livePreviewInputMode == nil,
              let reason = livePreviewKeyboardGuardReason(keyCode: keyCode, modifiers: modifiers)
        else { return nil }
        return guardFinalPasteForExternalInput(reason: reason)
    }

    @discardableResult
    static func guardFinalPasteForExternalPointer(eventType: String) -> String? {
        guard livePreviewInputMode == nil else { return nil }
        return guardFinalPasteForExternalInput(reason: "external-pointer")
    }

    static func consumeExternalFinalPasteGuardReason() -> String? {
        let reason = externalFinalPasteGuardReason
        externalFinalPasteGuardReason = nil
        return reason
    }

    private static func guardFinalPasteForExternalInput(reason: String) -> String {
        if externalFinalPasteGuardReason == nil {
            externalFinalPasteGuardReason = reason
            RunLog.write("completion.final-paste.guarded", "reason=\(reason)")
        }
        return externalFinalPasteGuardReason ?? reason
    }

    /// Called when a new dictation really starts. A swap left pending by an
    /// earlier dictation (for example one that ended with no words) must never
    /// type into this one.
    static func beginDictationSession() {
        discardPendingFinalReconcile(reason: "new-dictation")
        clipboardChangeCountAtDictationStart = NSPasteboard.general.changeCount
        sawCopyOrCutDuringDictation = false
    }

    /// Called for each key pressed in another app while a dictation runs or
    /// finishes. Cmd+C or Cmd+X fills the clipboard a moment later, so it is
    /// noted right away.
    static func noteExternalKeyDownForClipboard(characters: String?, modifiers: NSEvent.ModifierFlags) {
        guard SafetyStopClipboardPolicy.isCopyOrCutShortcut(
            characters: characters,
            commandDown: modifiers.contains(.command)
        ) else { return }
        if !sawCopyOrCutDuringDictation {
            RunLog.write("clipboard.copy-or-cut.seen", "during=dictation")
        }
        sawCopyOrCutDuringDictation = true
    }

    /// Whether the owner copied or cut something since this dictation started.
    static var clipboardChangedDuringDictation: Bool {
        SafetyStopClipboardPolicy.clipboardChangedDuringDictation(
            changeCountAtStart: clipboardChangeCountAtDictationStart,
            changeCountNow: NSPasteboard.general.changeCount,
            sawCopyOrCutShortcut: sawCopyOrCutDuringDictation
        )
    }

    /// True Convo's own clipboard write during a dictation (the paste
    /// fallback) is not the owner's copy; move the start mark past it.
    private static func noteOwnClipboardWrite() {
        guard clipboardChangeCountAtDictationStart != nil else { return }
        clipboardChangeCountAtDictationStart = NSPasteboard.general.changeCount
    }

    /// Drops a pending swap and any guard note about it, for a swap that can
    /// no longer run. Unlike a cancel for outside input, this leaves nothing
    /// behind that could affect a later dictation.
    static func discardPendingFinalReconcile(reason: String) {
        guard pendingKeyboardFinalReconcile != nil || pendingKeyboardFinalReconcileGuardReason != nil else { return }
        pendingKeyboardFinalReconcile = nil
        pendingKeyboardFinalReconcileGuardReason = nil
        RunLog.write("completion.live-preview.final-reconcile.discarded", "reason=\(reason)")
    }

    @discardableResult
    static func cancelPendingFinalReconcileForExternalInput(reason: String) -> Bool {
        guard pendingKeyboardFinalReconcile != nil else { return false }
        pendingKeyboardFinalReconcile = nil
        pendingKeyboardFinalReconcileGuardReason = reason
        externalFinalPasteGuardReason = reason
        RunLog.write("completion.live-preview.final-reconcile.guarded", "reason=\(reason)")
        return true
    }

    @discardableResult
    static func reconcileCommittedKeyboardPreview(finalText: String) -> LivePreviewCompletionResult? {
        if let guardReason = pendingKeyboardFinalReconcileGuardReason {
            pendingKeyboardFinalReconcileGuardReason = nil
            RunLog.write(
                "completion.live-preview.final-reconcile.skipped",
                "reason=\(guardReason)"
            )
            return .suppressedLateInsertion
        }

        guard let pending = pendingKeyboardFinalReconcile else { return nil }
        pendingKeyboardFinalReconcile = nil

        guard !pending.application.isTerminated else {
            RunLog.write("completion.live-preview.final-reconcile.skipped", "reason=target-terminated")
            return .suppressedLateInsertion
        }

        if let frontmost = NSWorkspace.shared.frontmostApplication,
           frontmost.processIdentifier != pending.application.processIdentifier,
           frontmost.bundleIdentifier != Bundle.main.bundleIdentifier
        {
            RunLog.write(
                "completion.live-preview.final-reconcile.skipped",
                [
                    "reason=target-not-frontmost",
                    "targetBundle=\(pending.application.bundleIdentifier ?? "unknown")",
                    "frontmostBundle=\(frontmost.bundleIdentifier ?? "unknown")",
                ].joined(separator: " ")
            )
            return .suppressedLateInsertion
        }

        targetApplication = pending.application
        livePreviewInputMode = .keyboardCompatibility
        livePreviewText = pending.liveText
        livePreviewStartedWithSelection = pending.startedWithSelection
        livePreviewRequiresFinalPaste = false
        livePreviewGuardReason = nil
        livePreviewAcceptsPartials = false
        livePreviewKeyboardWorkItem?.cancel()
        livePreviewKeyboardWorkItem = nil
        RunLog.write(
            "completion.live-preview.final-reconcile.started",
            "mode=keyboard-compatibility liveChars=\(pending.liveText.count)"
        )
        let result = finishLivePreview(
            finalText: finalText,
            allowKeyboardCompatibilityFinalRewrite: true,
            eventPrefix: LiveKeyboardPreviewPolicy.finalReconcileEventPrefix
        )
        if pending.liveText.isEmpty, result != .inserted {
            // Nothing was typed live and typing the final text did not
            // happen, so it must not be reported as typed.
            RunLog.write("completion.live-preview.final-reconcile.skipped", "reason=type-failed-no-live-text")
            return .suppressedLateInsertion
        }
        return result
    }

    /// The swap types with the keyboard, so it must not run while the
    /// dictation key is still held (the letters would act as shortcuts).
    /// Waits up to `timeout` for the release.
    static func waitForHotKeyRelease(timeout: TimeInterval) async {
        let deadline = Date().addingTimeInterval(timeout)
        while await MainActor.run(body: { hotKeyIsDown }), Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    @discardableResult
    static func finishLivePreview(
        finalText: String,
        allowKeyboardCompatibilityFinalRewrite: Bool = false,
        eventPrefix: String = "completion.live-preview.final"
    ) -> LivePreviewCompletionResult {
        guard Settings.liveInsertApplePartials else { return .inactive }
        livePreviewAcceptsPartials = false
        livePreviewKeyboardWorkItem?.cancel()
        livePreviewKeyboardWorkItem = nil
        let cleanText = finalText
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let output = cleanText.isEmpty ? "" : cleanText + (livePreviewStartedWithSelection ? "" : " ")

        if livePreviewInputMode == .keyboardCompatibility,
           !livePreviewText.isEmpty,
           !allowKeyboardCompatibilityFinalRewrite
        {
            let externalGuard = livePreviewRequiresFinalPaste
            RunLog.write(
                "completion.live-preview.final.skipped",
                "reason=keyboard-compatibility-never-rewrites-final mode=keyboard-compatibility liveChars=\(livePreviewText.count) finalChars=\(output.count) externalGuard=\(externalGuard)"
            )
            clearLivePreviewState()
            return externalGuard ? .committedGuardedLiveText : .committedLiveText
        }

        let skipFinalRewrite = LiveKeyboardPreviewPolicy.shouldSkipFinalRewrite(
            keepLiveText: Settings.finalRewriteMode == .keepLiveText,
            keyboardCompatibility: livePreviewInputMode == .keyboardCompatibility
        )
        if skipFinalRewrite, !livePreviewText.isEmpty, !allowKeyboardCompatibilityFinalRewrite {
            let reason = livePreviewInputMode == .keyboardCompatibility
                ? "keyboard-compatibility-keeps-live-text"
                : "keep-live-text"
            let externalGuard = livePreviewRequiresFinalPaste
            RunLog.write(
                "completion.live-preview.final.skipped",
                "reason=\(reason) mode=\(livePreviewInputMode?.logValue ?? "unknown") liveChars=\(livePreviewText.count) finalChars=\(output.count) externalGuard=\(externalGuard)"
            )
            clearLivePreviewState()
            return externalGuard ? .committedGuardedLiveText : .committedLiveText
        }

        if livePreviewRequiresFinalPaste {
            RunLog.write(
                "completion.live-preview.final.skipped",
                "reason=\(livePreviewGuardReason ?? "external-guard") mode=\(livePreviewInputMode?.logValue ?? "unknown") chars=\(output.count)"
            )
            clearLivePreviewState()
            return .suppressedLateInsertion
        }

        if livePreviewInputMode == .keyboardCompatibility {
            let succeeded = replaceKeyboardLivePreview(with: output, eventPrefix: eventPrefix)
            RunLog.write(
                succeeded ? "\(eventPrefix).finalized" : "\(eventPrefix).finalize.failed",
                "mode=keyboard-compatibility chars=\(output.count)"
            )
            clearLivePreviewState()
            return succeeded ? .inserted : .inactive
        }

        guard let element = livePreviewElement,
              let startRange = livePreviewStartRange
        else { return .inactive }

        let replacementLength = livePreviewText.isEmpty ? startRange.length : utf16Length(livePreviewText)
        let range = CFRange(location: startRange.location, length: replacementLength)
        let succeeded = replaceText(output, in: element, range: range, eventPrefix: "completion.live-preview.final")
        RunLog.write(
            succeeded ? "completion.live-preview.finalized" : "completion.live-preview.finalize.failed",
            "mode=accessibility chars=\(output.count)"
        )
        clearLivePreviewState()
        return succeeded ? .inserted : .inactive
    }

    static func cancelLivePreview(removeInserted: Bool) {
        defer {
            clearLivePreviewState()
        }

        guard removeInserted,
              !livePreviewText.isEmpty
        else { return }

        if livePreviewInputMode == .keyboardCompatibility {
            _ = replaceKeyboardLivePreview(with: "", eventPrefix: "completion.live-preview.cancel")
            return
        }

        guard let element = livePreviewElement,
              let startRange = livePreviewStartRange
        else { return }

        let range = CFRange(location: startRange.location, length: utf16Length(livePreviewText))
        _ = replaceText("", in: element, range: range, eventPrefix: "completion.live-preview.cancel")
    }

    private static func livePreviewDecision() -> LivePreviewDecision {
        let setting = Settings.insertionMode
        let bundleIdentifier = targetApplication?.bundleIdentifier ?? "unknown"
        let fallbackName = targetApplication?.localizedName ?? bundleIdentifier
        let profile = appInsertionProfiles[bundleIdentifier]

        if setting != .auto {
            return LivePreviewDecision(
                mode: setting,
                source: "user-override",
                profileName: profile?.name ?? fallbackName,
                reason: "Manual insertion mode override."
            )
        }

        if let profile {
            return LivePreviewDecision(
                mode: profile.livePreviewMode,
                source: "app-profile",
                profileName: profile.name,
                reason: profile.reason
            )
        }

        return LivePreviewDecision(
            mode: .accessibility,
            source: "default",
            profileName: fallbackName,
            reason: "No app-specific profile; using standard Accessibility insertion."
        )
    }

    private static func scheduleKeyboardLivePreviewUpdate(_ text: String) {
        livePreviewKeyboardWorkItem?.cancel()
        let workItem = DispatchWorkItem {
            guard livePreviewInputMode == .keyboardCompatibility,
                  livePreviewAcceptsPartials
            else { return }
            _ = replaceKeyboardLivePreview(with: text, eventPrefix: "completion.live-preview.keyboard")
        }
        livePreviewKeyboardWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.16, execute: workItem)
    }

    @discardableResult
    private static func replaceKeyboardLivePreview(with text: String, eventPrefix: String) -> Bool {
        guard !hotKeyIsDown else {
            RunLog.write("\(eventPrefix).skipped", "mode=keyboard-compatibility reason=hotkey-down")
            return false
        }
        guard let targetApplication,
              !targetApplication.isTerminated
        else {
            RunLog.write("\(eventPrefix).skipped", "mode=keyboard-compatibility reason=no-target-application")
            return false
        }
        guard keyboardPreviewTargetStillOwned(targetApplication, eventPrefix: eventPrefix) else {
            return false
        }

        targetApplication.activate(options: [.activateIgnoringOtherApps])
        let target = keyboardPreviewTargetText(for: text, eventPrefix: eventPrefix)
        let outputText = target.text
        let revision = LiveKeyboardPreviewPolicy.revisionPlan(
            currentText: livePreviewText,
            outputText: outputText,
            eventPrefix: eventPrefix,
            keepLiveText: Settings.finalRewriteMode == .keepLiveText,
            keyboardCompatibility: livePreviewInputMode == .keyboardCompatibility
        )
        let allowsKeyboardRewrite = eventPrefix == LiveKeyboardPreviewPolicy.finalReconcileEventPrefix
        if livePreviewInputMode == .keyboardCompatibility,
           eventPrefix != LiveKeyboardPreviewPolicy.keyboardPreviewEventPrefix,
           !allowsKeyboardRewrite,
           revision.removedCount > 0
        {
            livePreviewRequiresFinalPaste = true
            RunLog.write(
                "\(eventPrefix).rewrite-blocked",
                "mode=keyboard-compatibility reason=keyboard-compatibility-never-rewrites-final removed=\(revision.removedCount) added=\(revision.addedText.count)"
            )
            return false
        }
        if revision.suppressesRevision {
            let appendedText = revision.appendOnlyText
            if !appendedText.isEmpty, !typeTextWithKeyboard(appendedText, eventPrefix: eventPrefix) {
                return false
            }
            livePreviewText += appendedText
            let reason = livePreviewInputMode == .keyboardCompatibility
                ? "keyboard-compatibility-never-rewrites-live"
                : "keep-live-text"
            RunLog.write(
                "\(eventPrefix).revision-suppressed",
                "mode=keyboard-compatibility reason=\(reason) removed=\(revision.removedCount) appended=\(appendedText.count) chars=\(livePreviewText.count)"
            )
            return true
        }

        if target.stitched {
            RunLog.write(
                "completion.live-preview.partial-stitch",
                "mode=keyboard-compatibility originalChars=\(text.count) stitchedChars=\(outputText.count) removed=\(revision.removedCount) added=\(revision.addedText.count)"
            )
        }

        if revision.removedCount > 0, !selectPreviousCharacters(revision.removedCount, eventPrefix: eventPrefix) {
            return false
        }
        if revision.removedCount > 0, revision.addedText.isEmpty, !deleteSelectedText(eventPrefix: eventPrefix) {
            return false
        }
        guard typeTextWithKeyboard(revision.addedText, eventPrefix: eventPrefix) else {
            return false
        }
        livePreviewText = outputText
        RunLog.write(
            "\(eventPrefix).updated",
            "mode=keyboard-compatibility chars=\(outputText.count) removed=\(revision.removedCount) added=\(revision.addedText.count)"
        )
        return true
    }

    private static func keyboardPreviewTargetStillOwned(
        _ targetApplication: NSRunningApplication,
        eventPrefix: String
    ) -> Bool {
        guard let frontmost = NSWorkspace.shared.frontmostApplication else {
            return true
        }
        if frontmost.processIdentifier == targetApplication.processIdentifier {
            return true
        }
        if frontmost.bundleIdentifier == Bundle.main.bundleIdentifier {
            return true
        }

        livePreviewAcceptsPartials = false
        livePreviewRequiresFinalPaste = true
        livePreviewGuardReason = "external-target-changed"
        livePreviewKeyboardWorkItem?.cancel()
        livePreviewKeyboardWorkItem = nil
        RunLog.write(
            "completion.live-preview.guarded",
            [
                "mode=keyboard-compatibility",
                "reason=external-target-changed",
                "eventPrefix=\(eventPrefix)",
                "targetBundle=\(targetApplication.bundleIdentifier ?? "unknown")",
                "targetName=\(targetApplication.localizedName ?? "unknown")",
                "frontmostBundle=\(frontmost.bundleIdentifier ?? "unknown")",
                "frontmostName=\(frontmost.localizedName ?? "unknown")",
            ].joined(separator: " ")
        )
        externalLivePreviewGuardHandler?("external-target-changed")
        return false
    }

    private static func keyboardPreviewTargetText(for text: String, eventPrefix: String) -> (text: String, stitched: Bool) {
        guard eventPrefix == "completion.live-preview.keyboard",
              livePreviewInputMode == .keyboardCompatibility,
              !livePreviewText.isEmpty
        else {
            return (text, false)
        }

        if let base = livePreviewKeyboardContinuationBase {
            if text.hasPrefix(base) {
                livePreviewKeyboardContinuationBase = nil
                livePreviewKeyboardContinuationFragment = nil
                return (text, false)
            }

            if isContinuingSameKeyboardFragment(text) {
                livePreviewKeyboardContinuationFragment = text
                return (stitchedKeyboardPreviewText(base: base, fragment: text), true)
            }

            let prefixLength = LiveKeyboardPreviewPolicy.commonPrefixLength(livePreviewText, text)
            let removedCount = livePreviewText.count - prefixLength
            let addedCount = text.count - prefixLength
            if shouldStitchKeyboardPartialReset(
                prefixLength: prefixLength,
                removedCount: removedCount,
                addedCount: addedCount
            ) {
                livePreviewKeyboardContinuationBase = livePreviewText
                livePreviewKeyboardContinuationFragment = text
                return (stitchedKeyboardPreviewText(base: livePreviewText, fragment: text), true)
            }

            livePreviewKeyboardContinuationFragment = text
            return (stitchedKeyboardPreviewText(base: base, fragment: text), true)
        }

        let prefixLength = LiveKeyboardPreviewPolicy.commonPrefixLength(livePreviewText, text)
        let removedCount = livePreviewText.count - prefixLength
        let addedCount = text.count - prefixLength
        guard shouldStitchKeyboardPartialReset(
            prefixLength: prefixLength,
            removedCount: removedCount,
            addedCount: addedCount
        ) else {
            return (text, false)
        }

        livePreviewKeyboardContinuationBase = livePreviewText
        livePreviewKeyboardContinuationFragment = text
        return (stitchedKeyboardPreviewText(base: livePreviewText, fragment: text), true)
    }

    private static func isContinuingSameKeyboardFragment(_ text: String) -> Bool {
        guard let previous = livePreviewKeyboardContinuationFragment else { return true }
        if text.hasPrefix(previous) || previous.hasPrefix(text) {
            return true
        }
        let sharedPrefix = LiveKeyboardPreviewPolicy.commonPrefixLength(previous, text)
        let shorterCount = min(previous.count, text.count)
        return sharedPrefix >= min(12, max(4, shorterCount / 2))
    }

    private static func stitchedKeyboardPreviewText(base: String, fragment: String) -> String {
        LiveKeyboardPreviewPolicy.stitchedPartialResetText(base: base, fragment: fragment)
    }

    private static func shouldStitchKeyboardPartialReset(
        prefixLength: Int,
        removedCount: Int,
        addedCount: Int
    ) -> Bool {
        let currentCount = livePreviewText.count
        guard currentCount >= 36 else { return false }
        guard prefixLength <= min(12, max(4, currentCount / 8)) else { return false }
        let largeRemoval = removedCount >= max(24, currentCount / 2)
        let shortReplacement = addedCount <= max(24, removedCount / 2)
        let tinyFragment = addedCount <= 16 && removedCount >= max(20, currentCount / 3)
        return largeRemoval && (shortReplacement || tinyFragment)
    }

    @discardableResult
    static func requestAccessibilityPermission() -> Bool {
        let trusted = accessibilityTrusted(prompt: true)
        RunLog.write("permission.accessibility.requested", "trusted=\(trusted)")
        return trusted
    }

    static func markHotKeyPressed() {
        hotKeyIsDown = true
        RunLog.write("hotkey.pressed")
    }

    static func markHotKeyReleased() {
        hotKeyIsDown = false
        RunLog.write("hotkey.released")
        guard let text = pendingPasteText else { return }
        pendingPasteText = nil
        pendingPasteFallbackWorkItem?.cancel()
        pendingPasteFallbackWorkItem = nil
        RunLog.write("completion.paste.resumed", "reason=hotkey-released")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
            performPaste(text)
        }
    }

    static func paste(_ text: String) {
        guard canAutoPaste else {
            writeClipboardFallback(text, reason: "accessibility-not-trusted")
            return
        }

        if hotKeyIsDown {
            pendingPasteText = text
            pendingPasteFallbackWorkItem?.cancel()
            let fallback = DispatchWorkItem {
                guard let text = pendingPasteText else { return }
                pendingPasteText = nil
                pendingPasteFallbackWorkItem = nil
                hotKeyIsDown = false
                RunLog.write("completion.paste.resumed", "reason=hotkey-timeout")
                performPaste(text)
            }
            pendingPasteFallbackWorkItem = fallback
            RunLog.write("completion.paste.deferred", "reason=hotkey-down")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: fallback)
            return
        }

        performPaste(text)
    }

    private static func performPaste(_ text: String) {
        if let targetApplication, !targetApplication.isTerminated {
            RunLog.write("completion.paste.target", describe(targetApplication))
            targetApplication.activate(options: [.activateIgnoringOtherApps])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                restoreFocusedElement()
                targetApplication.activate(options: [.activateIgnoringOtherApps])
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
                    pasteIntoActiveApplication(text)
                }
            }
            return
        }

        RunLog.write("completion.paste.target", "bundle=frontmost name=frontmost")
        restoreFocusedElement()
        pasteIntoActiveApplication(text)
    }

    private static func pasteIntoActiveApplication(_ text: String) {
        if deskShieldHoldsBack(.paste) {
            writeClipboardFallback(text, reason: "desk-window-key")
            return
        }
        if insertUsingAccessibility(text) {
            return
        }

        // Dictated text stays on this Mac (no Universal Clipboard) and clipboard
        // managers are asked not to keep it.
        writePrivateClipboardText(text)
        RunLog.write("completion.pasteboard.prepared", "chars=\(text.count)")

        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            RunLog.write("completion.paste.keystroke.failed", "reason=no-event-source")
            return
        }
        let commandDown = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Command), keyDown: true)
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: true)
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: false)
        let commandUp = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Command), keyDown: false)
        commandDown?.flags = .maskCommand
        keyDown?.flags = .maskCommand
        keyUp?.flags = .maskCommand
        commandUp?.flags = []
        commandDown?.post(tap: .cghidEventTap)
        keyDown?.post(tap: .cghidEventTap)
        keyUp?.post(tap: .cghidEventTap)
        commandUp?.post(tap: .cghidEventTap)
        RunLog.write("completion.paste.keystroke.posted", "style=command-sequence")
        RunLog.write("completion.pasteboard.retained", "reason=manual-paste-fallback")
    }

    private static func insertUsingAccessibility(_ text: String) -> Bool {
        guard let targetElement else {
            RunLog.write("completion.ax-insert.skipped", "reason=no-focused-element")
            return false
        }
        let insertionRange = selectedTextRange(for: targetElement)

        var settable = DarwinBoolean(false)
        let settableStatus = AXUIElementIsAttributeSettable(
            targetElement,
            kAXSelectedTextAttribute as CFString,
            &settable
        )
        guard settableStatus == .success, settable.boolValue else {
            RunLog.write(
                "completion.ax-insert.skipped",
                "reason=selected-text-not-settable status=\(settableStatus.rawValue)"
            )
            return false
        }

        let status = AXUIElementSetAttributeValue(
            targetElement,
            kAXSelectedTextAttribute as CFString,
            text as CFTypeRef
        )
        guard status == .success else {
            RunLog.write("completion.ax-insert.failed", "status=\(status.rawValue)")
            return false
        }

        if let insertionRange {
            let collapsedRange = CFRange(location: insertionRange.location + utf16Length(text), length: 0)
            collapseSelection(to: collapsedRange, in: targetElement, eventPrefix: "completion.ax-insert")
        }
        RunLog.write("completion.ax-insert.succeeded", "chars=\(text.count)")
        return true
    }

    private static func selectedTextRange(for element: AXUIElement, logFailure: Bool = true) -> CFRange? {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            &value
        )
        guard status == .success,
              let value,
              CFGetTypeID(value) == AXValueGetTypeID()
        else {
            if logFailure {
                RunLog.write("cursor-focus.range.failed", "status=\(status.rawValue)")
            }
            return nil
        }

        let axValue = value as! AXValue
        var range = CFRange()
        guard AXValueGetValue(axValue, .cfRange, &range) else {
            if logFailure {
                RunLog.write("cursor-focus.range.failed", "status=unreadable")
            }
            return nil
        }
        return range
    }

    private static func selectedTextForCorrection(in element: AXUIElement) -> String? {
        guard let range = selectedTextRange(for: element, logFailure: false),
              range.length > 0
        else { return nil }

        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(
            element,
            kAXSelectedTextAttribute as CFString,
            &value
        )
        guard status == .success, let text = value as? String else {
            return nil
        }
        return usableCorrectionSelection(text, method: "accessibility-selected-text")
    }

    private static func copySelectedTextForCorrection(from application: NSRunningApplication) -> String? {
        let snapshot = PasteboardSnapshot.capture()
        let pasteboard = NSPasteboard.general
        let beforeChangeCount = pasteboard.changeCount
        let targetBundle = application.bundleIdentifier ?? "unknown"
        let targetName = application.localizedName ?? targetBundle

        application.activate(options: [.activateIgnoringOtherApps])
        guard postCommandKey(CGKeyCode(kVK_ANSI_C)) else {
            RunLog.write("correction.capture.skipped", "reason=copy-keystroke-failed target=\(targetBundle)")
            return nil
        }

        var copied: String?
        var didChangePasteboard = false
        let deadline = Date().addingTimeInterval(correctionClipboardWaitSeconds)
        while Date() < deadline {
            if pasteboard.changeCount != beforeChangeCount {
                didChangePasteboard = true
                if let text = pasteboard.string(forType: .string), !text.isEmpty {
                    copied = text
                    break
                }
            }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }

        defer {
            snapshot.restore()
        }

        guard didChangePasteboard else {
            RunLog.write(
                "correction.capture.skipped",
                "reason=clipboard-copy-timeout target=\(targetBundle) waitMs=\(Int(correctionClipboardWaitSeconds * 1000))"
            )
            return nil
        }
        guard let copied else {
            RunLog.write("correction.capture.skipped", "reason=clipboard-copy-empty target=\(targetBundle) name=\(targetName)")
            return nil
        }
        return usableCorrectionSelection(copied, method: "clipboard-selection-snapshot")
    }

    private static func usableCorrectionSelection(_ text: String, method: String) -> String? {
        let normalized = normalizedCorrectionText(text)
        guard !normalized.isEmpty else {
            RunLog.write("correction.capture.skipped", "reason=empty-selection method=\(method)")
            return nil
        }
        guard normalized.count <= correctionSelectionMaxCharacters else {
            RunLog.write(
                "correction.capture.skipped",
                "reason=selection-too-large method=\(method) chars=\(normalized.count) max=\(correctionSelectionMaxCharacters)"
            )
            return nil
        }
        return normalized
    }

    private static func normalizedCorrectionText(_ text: String) -> String {
        let clean = text
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean.count > 2_000 else { return clean }
        return String(clean.prefix(2_000))
    }

    private static func replaceText(_ text: String, in element: AXUIElement, range: CFRange, eventPrefix: String) -> Bool {
        var mutableRange = range
        guard let rangeValue = AXValueCreate(.cfRange, &mutableRange) else {
            RunLog.write("\(eventPrefix).skipped", "reason=range-create-failed")
            return false
        }

        _ = AXUIElementSetAttributeValue(
            element,
            kAXFocusedAttribute as CFString,
            kCFBooleanTrue
        )
        let rangeStatus = AXUIElementSetAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            rangeValue
        )
        guard rangeStatus == .success else {
            RunLog.write("\(eventPrefix).skipped", "reason=range-not-settable status=\(rangeStatus.rawValue)")
            return false
        }

        var settable = DarwinBoolean(false)
        let settableStatus = AXUIElementIsAttributeSettable(
            element,
            kAXSelectedTextAttribute as CFString,
            &settable
        )
        guard settableStatus == .success, settable.boolValue else {
            RunLog.write(
                "\(eventPrefix).skipped",
                "reason=selected-text-not-settable status=\(settableStatus.rawValue)"
            )
            return false
        }

        let status = AXUIElementSetAttributeValue(
            element,
            kAXSelectedTextAttribute as CFString,
            text as CFTypeRef
        )
        guard status == .success else {
            RunLog.write("\(eventPrefix).failed", "status=\(status.rawValue)")
            return false
        }
        let collapsedRange = CFRange(location: range.location + utf16Length(text), length: 0)
        collapseSelection(to: collapsedRange, in: element, eventPrefix: eventPrefix)
        RunLog.write("\(eventPrefix).updated", "chars=\(text.count)")
        return true
    }

    private static func collapseSelection(to range: CFRange, in element: AXUIElement, eventPrefix: String) {
        var mutableRange = range
        guard let rangeValue = AXValueCreate(.cfRange, &mutableRange) else {
            RunLog.write("\(eventPrefix).selection-collapse.skipped", "reason=range-create-failed")
            return
        }
        let status = AXUIElementSetAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            rangeValue
        )
        if status != .success {
            RunLog.write("\(eventPrefix).selection-collapse.failed", "status=\(status.rawValue)")
        }
    }

    private static func postCommandKey(_ keyCode: CGKeyCode) -> Bool {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            return false
        }
        let commandDown = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Command), keyDown: true)
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
        let commandUp = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Command), keyDown: false)
        commandDown?.flags = .maskCommand
        keyDown?.flags = .maskCommand
        keyUp?.flags = .maskCommand
        commandUp?.flags = []
        commandDown?.post(tap: .cghidEventTap)
        keyDown?.post(tap: .cghidEventTap)
        keyUp?.post(tap: .cghidEventTap)
        commandUp?.post(tap: .cghidEventTap)
        return true
    }

    private static func selectPreviousCharacters(_ count: Int, eventPrefix: String) -> Bool {
        guard count > 0 else { return true }
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            RunLog.write("\(eventPrefix).select-previous.failed", "reason=no-event-source")
            return false
        }

        for _ in 0..<count {
            let keyDown = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_LeftArrow), keyDown: true)
            let keyUp = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_LeftArrow), keyDown: false)
            keyDown?.flags = .maskShift
            keyUp?.flags = .maskShift
            keyDown?.post(tap: .cghidEventTap)
            keyUp?.post(tap: .cghidEventTap)
        }
        return true
    }

    private static func deleteSelectedText(eventPrefix: String) -> Bool {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            RunLog.write("\(eventPrefix).delete-selection.failed", "reason=no-event-source")
            return false
        }

        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Delete), keyDown: true)
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Delete), keyDown: false)
        keyDown?.post(tap: .cghidEventTap)
        keyUp?.post(tap: .cghidEventTap)
        return true
    }

    private static func typeTextWithKeyboard(_ text: String, eventPrefix: String) -> Bool {
        if deskShieldHoldsBack(.typing) {
            RunLog.write("\(eventPrefix).type.skipped", "reason=desk-window-key chars=\(text.count)")
            return false
        }
        guard !text.isEmpty else { return true }
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            RunLog.write("\(eventPrefix).type.failed", "reason=no-event-source")
            return false
        }

        let units = text.utf16.map { UniChar($0) }
        let chunkSize = 24
        var index = 0
        while index < units.count {
            let end = min(index + chunkSize, units.count)
            let chunk = Array(units[index..<end])
            chunk.withUnsafeBufferPointer { buffer in
                let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
                let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
                keyDown?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: buffer.baseAddress)
                keyUp?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: buffer.baseAddress)
                keyDown?.flags = []
                keyUp?.flags = []
                keyDown?.post(tap: .cghidEventTap)
                keyUp?.post(tap: .cghidEventTap)
            }
            index = end
        }
        return true
    }

    private static func clearLivePreviewState() {
        livePreviewKeyboardWorkItem?.cancel()
        livePreviewKeyboardWorkItem = nil
        livePreviewElement = nil
        livePreviewStartRange = nil
        livePreviewInputMode = nil
        livePreviewText = ""
        livePreviewStartedWithSelection = false
        livePreviewRequiresFinalPaste = false
        livePreviewGuardReason = nil
        livePreviewKeyboardPreviousRecognitionText = nil
        livePreviewKeyboardContinuationBase = nil
        livePreviewKeyboardContinuationFragment = nil
        livePreviewCorrectionReplacementArmed = false
    }

    private static func livePreviewKeyboardGuardReason(keyCode: UInt16, modifiers: NSEvent.ModifierFlags) -> String? {
        if Settings.hotKeyShortcut.matches(keyCode: keyCode, modifiers: modifiers) {
            return nil
        }

        let shortcutModifiers = modifiers.intersection([.command, .control, .option])
        if !shortcutModifiers.isEmpty {
            return "external-shortcut"
        }

        if isEditingNavigationKey(keyCode) {
            return "external-editing-key"
        }

        return nil
    }

    private static func isEditingNavigationKey(_ keyCode: UInt16) -> Bool {
        let guardedKeys: Set<UInt16> = [
            UInt16(kVK_Return),
            UInt16(kVK_ANSI_KeypadEnter),
            UInt16(kVK_Tab),
            UInt16(kVK_Escape),
            UInt16(kVK_Delete),
            UInt16(kVK_ForwardDelete),
            UInt16(kVK_LeftArrow),
            UInt16(kVK_RightArrow),
            UInt16(kVK_UpArrow),
            UInt16(kVK_DownArrow),
            UInt16(kVK_Home),
            UInt16(kVK_End),
            UInt16(kVK_PageUp),
            UInt16(kVK_PageDown),
        ]
        return guardedKeys.contains(keyCode)
    }

    private static func keyDescription(_ keyCode: UInt16) -> String {
        switch Int(keyCode) {
        case kVK_Return: return "return"
        case kVK_ANSI_KeypadEnter: return "keypad-enter"
        case kVK_Tab: return "tab"
        case kVK_Escape: return "escape"
        case kVK_Delete: return "delete"
        case kVK_ForwardDelete: return "forward-delete"
        case kVK_LeftArrow: return "left-arrow"
        case kVK_RightArrow: return "right-arrow"
        case kVK_UpArrow: return "up-arrow"
        case kVK_DownArrow: return "down-arrow"
        case kVK_Home: return "home"
        case kVK_End: return "end"
        case kVK_PageUp: return "page-up"
        case kVK_PageDown: return "page-down"
        default: return "key-\(keyCode)"
        }
    }

    private static func modifierDescription(_ modifiers: NSEvent.ModifierFlags) -> String {
        var names: [String] = []
        if modifiers.contains(.command) { names.append("command") }
        if modifiers.contains(.control) { names.append("control") }
        if modifiers.contains(.option) { names.append("option") }
        if modifiers.contains(.shift) { names.append("shift") }
        return names.isEmpty ? "none" : names.joined(separator: "+")
    }

    private static func utf16Length(_ text: String) -> Int {
        (text as NSString).length
    }

    /// Puts dictated text on the clipboard for the owner to paste. It stays on
    /// this Mac (no Universal Clipboard), and clipboard managers are asked
    /// not to keep it (nspasteboard.org transient and concealed markers).
    static func writePrivateClipboardText(_ text: String) {
        let pasteboard = NSPasteboard.general
        _ = pasteboard.prepareForNewContents(with: .currentHostOnly)
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        item.setData(Data(), forType: NSPasteboard.PasteboardType(SafetyStopClipboardPolicy.transientPasteboardType))
        item.setData(Data(), forType: NSPasteboard.PasteboardType(SafetyStopClipboardPolicy.concealedPasteboardType))
        pasteboard.writeObjects([item])
        noteOwnClipboardWrite()
    }

    static func writeClipboardFallback(_ text: String, reason: String, sessionId: String? = nil) {
        writePrivateClipboardText(text)
        pendingPasteText = nil
        pendingPasteFallbackWorkItem?.cancel()
        pendingPasteFallbackWorkItem = nil
        let idPart = sessionId.map { "id=\($0) " } ?? ""
        RunLog.write("completion.clipboard.fallback", "\(idPart)reason=\(reason) chars=\(text.count)")
    }

    static func archiveSuppressedLateInsertion(finalText: String, sessionId: String, reason: String) {
        pendingPasteText = nil
        pendingPasteFallbackWorkItem?.cancel()
        pendingPasteFallbackWorkItem = nil
        RunLog.write(
            "completion.live-preview.late-insertion.archived-only",
            "id=\(sessionId) reason=\(reason) chars=\(finalText.count)"
        )
    }

    static func pressReturn() {
        if deskShieldHoldsBack(.returnKey) {
            RunLog.write("completion.return.skipped", "reason=desk-window-key")
            return
        }
        if let targetApplication, !targetApplication.isTerminated {
            targetApplication.activate(options: [.activateIgnoringOtherApps])
        }
        guard let source = CGEventSource(stateID: .combinedSessionState) else { return }
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Return), keyDown: true)
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Return), keyDown: false)
        keyDown?.post(tap: .cghidEventTap)
        keyUp?.post(tap: .cghidEventTap)
    }

    private static func restoreFocusedElement() {
        guard let targetElement else {
            RunLog.write("cursor-focus.restore.skipped", "reason=no-focused-element")
            return
        }
        let status = AXUIElementSetAttributeValue(
            targetElement,
            kAXFocusedAttribute as CFString,
            kCFBooleanTrue
        )
        RunLog.write("cursor-focus.restore", "\(describe(targetElement)) status=\(status.rawValue)")
    }

    private static func describe(_ application: NSRunningApplication?) -> String {
        guard let application else {
            return "bundle=none name=none"
        }
        return "bundle=\(application.bundleIdentifier ?? "unknown") name=\(application.localizedName ?? "unknown")"
    }

    private static func describe(_ element: AXUIElement) -> String {
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)
        return "pid=\(pid) role=\(attributeString(element, kAXRoleAttribute)) subrole=\(attributeString(element, kAXSubroleAttribute))"
    }

    private static func attributeString(_ element: AXUIElement, _ attribute: String) -> String {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard status == .success, let value else {
            return "none"
        }
        return "\(value)"
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
    }

    private static func accessibilityTrusted(prompt: Bool) -> Bool {
        guard prompt else {
            return AXIsProcessTrusted()
        }
        let options = [
            kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
        ] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }
}

struct TranscriptionResult {
    let text: String
    let model: String
}

struct ProviderComparisonOutcome {
    let preset: ModelPreset
    let succeeded: Bool
    let transcript: String?
    let entryId: String?
    let contentPacketPath: String?
    let durationMs: Int?
    let errorMessage: String?
}

enum ProviderComparisonReport {
    static func write(source: ArchiveEntry, audioURL: URL, outcomes: [ProviderComparisonOutcome]) throws -> URL {
        try Archive.ensureDirectories()
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let safeTimestamp = timestamp
            .replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: ".", with: "-")
        let url = Archive.providerComparisons.appendingPathComponent("provider-comparison-\(source.id)-\(safeTimestamp).md")
        let successes = outcomes.filter(\.succeeded)
        let failures = outcomes.filter { !$0.succeeded }
        var lines = [
            "# True Convo Provider Comparison",
            "",
            "Generated: \(timestamp)",
            "",
            "## Source",
            "",
            "- Source session: \(source.id)",
            "- Source provider: \(source.provider)",
            "- Source model: \(source.model)",
            "- Source audio: \(audioURL.path)",
            "- Source duration: \(String(format: "%.1f", Double(source.durationMs) / 1000.0))s",
            "",
            "## Summary",
            "",
            "- Presets attempted: \(outcomes.count)",
            "- Successful transcripts: \(successes.count)",
            "- Failed transcripts: \(failures.count)",
            "- Fastest successful preset: \(fastest(successes)?.preset.label ?? "none")",
            "",
            "## Results",
            "",
            "| Preset | Status | Duration | Entry | Content packet | Notes |",
            "| --- | --- | ---: | --- | --- | --- |",
        ]

        for outcome in outcomes {
            lines.append(tableRow([
                outcome.preset.label,
                outcome.succeeded ? "success" : "failed",
                outcome.durationMs.map { "\($0)ms" } ?? "n/a",
                outcome.entryId ?? "none",
                outcome.contentPacketPath ?? "none",
                outcome.errorMessage ?? snippet(outcome.transcript ?? ""),
            ]))
        }

        lines += [
            "",
            "## Guidance",
            "",
            "- Use this report as timing evidence, not as the final model decision by itself.",
            "- Compare transcript usefulness in the content packets before changing your default provider.",
            "- Cloud rows mean the app made provider calls because keys were available and you chose this comparison command.",
            "- Local rows use retained audio and the configured local Whisper binary.",
            "",
        ]

        try lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
        try lines.joined(separator: "\n").write(to: Archive.latestProviderComparison, atomically: true, encoding: .utf8)
        RunLog.write("provider-comparison.report.wrote", "source=\(source.id) path=\(url.path)")
        return url
    }

    private static func fastest(_ outcomes: [ProviderComparisonOutcome]) -> ProviderComparisonOutcome? {
        outcomes
            .filter { $0.durationMs != nil }
            .min { ($0.durationMs ?? Int.max) < ($1.durationMs ?? Int.max) }
    }

    private static func tableRow(_ values: [String]) -> String {
        "| " + values.map(escapeTable).joined(separator: " | ") + " |"
    }

    private static func escapeTable(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "|", with: "\\|")
    }

    private static func snippet(_ value: String) -> String {
        let clean = value
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return "" }
        return clean.count <= 80 ? clean : String(clean.prefix(77)) + "..."
    }
}

enum TranscriptionService {
    static func transcribe(
        provider: DictationProvider,
        audioURL: URL,
        language: String,
        modelOverride: String? = nil,
        processes: RecordingProcessOwner? = nil
    ) async throws -> TranscriptionResult {
        try Task.checkCancellation()
        switch provider {
        case .appleLocal:
            return TranscriptionResult(text: "", model: "SFSpeechRecognizer/on-device")
        case .localWhisper:
            return try await transcribeWithLocalWhisper(
                audioURL: audioURL,
                language: language,
                model: modelOverride ?? Settings.localWhisperModel,
                processes: processes
            )
        case .openAIRealtime:
            throw VoiceCursorError.processFailed("OpenAI Realtime is live streaming only; choose OpenAI Cloud to reprocess retained audio.")
        case .openAICloud:
            return try await transcribeWithCloud(
                endpoint: URL(string: "https://api.openai.com/v1/audio/transcriptions")!,
                apiKeyName: "OPENAI_API_KEY",
                model: modelOverride ?? Settings.openAIModel,
                audioURL: audioURL,
                language: normalizeLanguage(language)
            )
        case .groqCloud:
            return try await transcribeWithCloud(
                endpoint: URL(string: "https://api.groq.com/openai/v1/audio/transcriptions")!,
                apiKeyName: "GROQ_API_KEY",
                model: modelOverride ?? Settings.groqModel,
                audioURL: audioURL,
                language: normalizeLanguage(language)
            )
        case .appleSpeechAnalyzer:
            throw VoiceCursorError.processFailed("Apple On-Device (New) transcribes live only; choose Local Whisper, OpenAI Cloud, or Groq to reprocess retained audio.")
        }
    }

    private static func normalizeLanguage(_ language: String) -> String {
        (language.split(separator: "-").first.map(String.init) ?? "en").lowercased()
    }

    private static func audioContentType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "flac":
            return "audio/flac"
        case "mp3":
            return "audio/mpeg"
        case "m4a":
            return "audio/mp4"
        case "wav":
            fallthrough
        default:
            return "audio/wav"
        }
    }

    private static func transcribeWithLocalWhisper(audioURL: URL, language: String, model: String, processes: RecordingProcessOwner?) async throws -> TranscriptionResult {
        let outDir = audioURL.deletingLastPathComponent().appendingPathComponent(".whisper")
        if let processes {
            try processes.performIfOpen { try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true) }
        } else {
            try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        }

        try await ProcessRunner.run(
            executable: Settings.whisperBinary,
            arguments: [
                audioURL.path,
                "--output_format", "txt",
                "--output_dir", outDir.path,
                "--language", normalizeLanguage(language),
                "--model", model,
                "--fp16", "False",
            ],
            processes: processes
        )

        let txtURL = outDir.appendingPathComponent(audioURL.deletingPathExtension().lastPathComponent + ".txt")
        let text = try String(contentsOf: txtURL, encoding: .utf8)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !text.isEmpty else {
            throw VoiceCursorError.emptyTranscript("Local Whisper")
        }
        return TranscriptionResult(text: text, model: model)
    }

    private static func transcribeWithCloud(
        endpoint: URL,
        apiKeyName: String,
        model: String,
        audioURL: URL,
        language: String
    ) async throws -> TranscriptionResult {
        guard let apiKey = RuntimeEnvironment.value(apiKeyName), !apiKey.isEmpty else {
            throw VoiceCursorError.missingAPIKey(apiKeyName)
        }

        let boundary = "----voice-cursor-\(Int(Date().timeIntervalSince1970 * 1000))"
        var body = Data()

        func appendField(_ name: String, _ value: String) {
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(Data("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".utf8))
            body.append(Data("\(value)\r\n".utf8))
        }

        appendField("model", model)
        appendField("language", language)
        appendField("response_format", "json")

        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(
            Data(
                "Content-Disposition: form-data; name=\"file\"; filename=\"\(audioURL.lastPathComponent)\"\r\nContent-Type: \(audioContentType(for: audioURL))\r\n\r\n".utf8
            )
        )
        body.append(try Data(contentsOf: audioURL))
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw VoiceCursorError.processFailed("Cloud transcription failed with HTTP \(code).")
        }

        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let rawText = object["text"] as? String
        {
            let text = rawText
                .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else {
                throw VoiceCursorError.emptyTranscript(endpoint.host ?? "Cloud provider")
            }
            return TranscriptionResult(text: text, model: model)
        }

        if let raw = String(data: data, encoding: .utf8) {
            let text = raw
                .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                return TranscriptionResult(text: text, model: model)
            }
        }

        throw VoiceCursorError.unreadableCloudResponse
    }
}

/// Only child processes owned by the current dictation controller. Shutdown closes
/// the start gate, then reaps these children before their audio files are removed.
final class RecordingProcessOwner: @unchecked Sendable {
    private let lock = NSLock()
    private var closed = false
    private var processes: [ObjectIdentifier: Process] = [:]

    var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }

    func performIfOpen<T>(_ operation: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { throw CancellationError() }
        return try operation()
    }

    func start(_ process: Process) throws {
        try performIfOpen {
            try process.run()
            processes[ObjectIdentifier(process)] = process
        }
    }

    func finished(_ process: Process) {
        lock.lock()
        processes.removeValue(forKey: ObjectIdentifier(process))
        lock.unlock()
    }

    func cancelAndWait() {
        lock.lock()
        closed = true
        let owned = Array(processes.values)
        lock.unlock()
        for process in owned where process.isRunning { process.terminate() }
        let deadline = Date().addingTimeInterval(0.25)
        while owned.contains(where: { $0.isRunning }), Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
        for process in owned where process.isRunning {
            // These PIDs were created by this owner; never signal another app.
            _ = Darwin.kill(process.processIdentifier, SIGKILL)
        }
        for process in owned { process.waitUntilExit() }
    }
}

enum ProcessRunner {
    static func run(executable: String, arguments: [String], processes: RecordingProcessOwner? = nil) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments

            let stderr = Pipe()
            process.standardError = stderr
            process.standardOutput = Pipe()
            let gate = ContinuationGate(continuation)

            process.terminationHandler = { proc in
                processes?.finished(proc)
                let data = stderr.fileHandleForReading.readDataToEndOfFile()
                let message = String(data: data, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if proc.terminationStatus == 0 {
                    gate.resume(.success(()))
                } else {
                    gate.resume(.failure(VoiceCursorError.processFailed(
                        message.isEmpty ? "\(executable) exited with \(proc.terminationStatus)." : message
                    )))
                }
            }

            do {
                if let processes { try processes.start(process) } else { try process.run() }
            } catch {
                gate.resume(.failure(error))
            }
        }
    }
}

final class ContinuationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var didResume = false
    private let continuation: CheckedContinuation<Void, Error>

    init(_ continuation: CheckedContinuation<Void, Error>) {
        self.continuation = continuation
    }

    func resume(_ result: Result<Void, Error>) {
        lock.lock()
        defer { lock.unlock() }
        guard !didResume else { return }
        didResume = true
        switch result {
        case .success:
            continuation.resume()
        case .failure(let error):
            continuation.resume(throwing: error)
        }
    }
}

final class DictationController {
    private let audioEngine = AVAudioEngine()
    private let idleAudioEngine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var audioFile: AVAudioFile?
    private var realtimeTranscriber: OpenAIRealtimeTranscriber?
    /// Apple On-Device (New), macOS 26+. Kept through a protocol because a
    /// stored property can't be limited to macOS 26.
    private var speechAnalyzerEngine: LiveSpeechEngine?
    private var sessionId = ""
    private var startedAt = Date()
    private var recordingURL: URL?
    // Only files newly created by this controller are eligible for stop/quit
    // cleanup. Background finalization remains tracked after the engine stops.
    private let ownedRecordings = OwnedRecordingFiles()
    private let recordingProcesses = RecordingProcessOwner()
    private var finalizationTask: Task<Void, Never>?
    private var latestTranscript = ""
    private var finalizedTranscriptSegments: [String] = []
    private var currentRecognitionTranscript = ""
    private var firstPartialAt: Date?
    /// Loudness slices for the silent-recording guard. Written on the audio
    /// thread, read at stop, so guarded by a lock.
    private var sliceCountTotal = 0
    private var sliceCountAtOrAboveNearSilent = 0
    private var sliceCountAtOrAboveStrictSilent = 0
    private let sliceCountLock = NSLock()
    /// Set when Apple's live listener reports a real error during this dictation.
    private var liveListenerHadError = false
    private var firstFinalAt: Date?
    private var tapInstalled = false
    private var idleTapInstalled = false
    private var idleWakeFrameCount = 0
    private var idleSmoothedLevel = 0.0
    private var idlePeakLevel = 0.0
    private var idleLastLevelLogAt = Date.distantPast
    private var currentProvider: DictationProvider = .appleLocal
    /// The language this dictation started with; saved fixes and the archive
    /// use it even if the setting changes before the dictation finishes.
    private var sessionLanguage = Settings.language
    /// The app this dictation types into, locked when it started.
    private var sessionTargetBundleID: String?
    private var currentCaptureMode: CaptureMode = .appleLive
    private var didLivePasteFinalText = false
    private var isProcessing = false
    private var autoStopWorkItem: DispatchWorkItem?
    private var recognitionRestartWorkItem: DispatchWorkItem?
    private let recognitionRestartInterval: TimeInterval = 55.0
    /// Goes up every time True Convo itself ends an Apple recognition task
    /// (the 55-second restart, or stopping when the dictation key is pressed
    /// to finish). An error from an older task is the result of our own
    /// cancel, not a problem to show.
    private var recognitionGeneration = 0
    /// The last finished dictation's text, for the menu's Copy Last
    /// Dictation. Kept in memory only.
    private(set) var lastDictationText: String?

    var onStatus: (String) -> Void = { _ in }
    var onTranscript: (String) -> Void = { _ in }
    var onOutcome: (DictationOutcome) -> Void = { _ in }
    var onAudioLevel: (Double) -> Void = { _ in }
    var onAudioWaveform: ([CGFloat], Double) -> Void = { _, _ in }
    var onSessionStarted: (DictationProvider) -> Void = { _ in }
    var onSessionFinished: () -> Void = {}
    var onFinalizationFinished: () -> Void = {}
    var onIdleWakeDetected: () -> Void = {}

    /// A Desk recording (step 1, PR 2b): its words go only to the Desk.
    /// Nothing is typed live, pasted, copied, sent with Return, written to
    /// history or kept as audio, and it is not the menu's last dictation;
    /// the final text is handed to `deliver` once, which says where it went.
    struct DeskRoute {
        let deliver: @MainActor (String) async -> DictationOutcome
    }

    /// Set by `start(deskRoute:)` for this recording; nil for every other.
    private var deskRoute: DeskRoute?
    /// Counts starts. A start that waits for a permission answer goes on
    /// only if no later start came meanwhile, so a later start can never
    /// change an earlier one's route or start a second capture (Codex P1
    /// on #9).
    private var startAttempt = 0

    /// Whether the recording now running or finishing is a Desk recording.
    var isDeskRecording: Bool { deskRoute != nil && isBusy }

    var isRecording: Bool {
        audioEngine.isRunning
    }

    var isBusy: Bool {
        isRecording || isProcessing
    }

    var isIdleMonitoring: Bool {
        idleAudioEngine.isRunning
    }

    func toggle() {
        if isRecording {
            stop()
        } else if !isProcessing {
            start()
        }
    }

    func start(deskRoute: DeskRoute? = nil) {
        guard !isBusy, !recordingProcesses.isClosed else { return }
        self.deskRoute = deskRoute
        startAttempt += 1
        let attempt = startAttempt
        stopIdleMonitor()

        let language = Settings.language
        currentProvider = Settings.provider
        let readiness = ProviderReadiness.forProvider(currentProvider)
        RunLog.write(
            "dictation.start.requested",
            "provider=\(currentProvider.rawValue) privacy=\"\(currentProvider.privacyLabel)\" action=\(Settings.completionAction.rawValue) language=\(language)"
        )
        guard readiness.ready else {
            RunLog.write("dictation.start.blocked", "reason=provider-not-ready \(readiness.logDetail)")
            onStatus(readiness.statusText)
            onSessionFinished()
            return
        }
        if currentProvider.isLiveStreamingProvider {
            ensureMicrophonePermission { [weak self] allowed in
                guard let self, allowed, self.isCurrentStart(attempt) else { return }
                self.startCapture(
                    recognizer: nil,
                    language: language,
                    captureMode: .openAIRealtime,
                    fallbackReason: nil
                )
            }
            return
        }
        if currentProvider == .appleSpeechAnalyzer {
            // Apple's new engine doesn't use SFSpeechRecognizer, so it skips
            // the older engine's recognizer check and Speech Recognition request.
            ensureMicrophonePermission { [weak self] allowed in
                guard let self, allowed, self.isCurrentStart(attempt) else { return }
                self.startCapture(
                    recognizer: nil,
                    language: language,
                    captureMode: .appleLive,
                    fallbackReason: nil
                )
            }
            return
        }
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language))
        self.recognizer = recognizer
        ensureMicrophonePermission { [weak self] allowed in
            guard let self else { return }
            guard allowed, self.isCurrentStart(attempt) else { return }
            guard let recognizer else {
                if self.currentProvider.isPostStopProvider {
                    self.startRecordOnlyFallback(language: language, reason: "speech-recognizer-unavailable")
                } else {
                    RunLog.write("dictation.start.blocked", "reason=speech-recognizer-unavailable language=\(language)")
                    self.onPermissionBlocked(
                        "Speech recognizer unavailable",
                        event: "speech-recognizer-unavailable",
                        detail: "No SFSpeechRecognizer was available for language \(language)."
                    )
                }
                return
            }

            guard recognizer.isAvailable else {
                if self.currentProvider.isPostStopProvider {
                    self.startRecordOnlyFallback(language: language, reason: "speech-recognizer-unavailable")
                } else {
                    RunLog.write("dictation.start.blocked", "reason=speech-recognizer-unavailable language=\(language)")
                    self.onPermissionBlocked(
                        "Speech recognizer unavailable",
                        event: "speech-recognizer-unavailable",
                        detail: "SFSpeechRecognizer is not available for language \(language)."
                    )
                }
                return
            }

            self.requestSpeechPermission(recognizer: recognizer, language: language, attempt: attempt)
        }
    }

    /// A Desk start still waiting for a permission answer is called off (the
    /// hold-to-record key was let go): its callback will not start capture.
    /// Returns whether one was pending. Outside starts are left as they are.
    @discardableResult
    func cancelPendingDeskStart() -> Bool {
        guard !isBusy, deskRoute != nil else { return false }
        startAttempt += 1
        deskRoute = nil
        RunLog.write("dictation.desk.start.cancelled", "reason=key-released-before-capture")
        return true
    }

    /// Whether `attempt` is still the latest start and nothing is running.
    private func isCurrentStart(_ attempt: Int) -> Bool {
        guard attempt == startAttempt, !isBusy else {
            RunLog.write("dictation.start.superseded", "attempt=\(attempt) latest=\(startAttempt) busy=\(isBusy)")
            return false
        }
        return true
    }

    func startIdleMonitor() {
        guard !isBusy, !idleAudioEngine.isRunning, !recordingProcesses.isClosed else { return }
        ensureMicrophonePermission { [weak self] allowed in
            guard let self, allowed else { return }
            self.startIdleMonitorAuthorized()
        }
    }

    func stopIdleMonitor() {
        let didRun = idleAudioEngine.isRunning || idleTapInstalled
        let peakLevel = idlePeakLevel
        idleWakeFrameCount = 0
        idleSmoothedLevel = 0
        idlePeakLevel = 0
        idleLastLevelLogAt = .distantPast
        if idleAudioEngine.isRunning {
            idleAudioEngine.stop()
        }
        if idleTapInstalled {
            idleAudioEngine.inputNode.removeTap(onBus: 0)
            idleTapInstalled = false
        }
        if didRun {
            RunLog.write(
                "persistent-pill.idle-monitor.stopped",
                "peak=\(String(format: "%.3f", peakLevel))"
            )
        }
        onAudioLevel(0)
    }

    private func ensureMicrophonePermission(_ completion: @escaping (Bool) -> Void) {
        guard !recordingProcesses.isClosed else { return }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            completion(true)
        case .notDetermined:
            onStatus("Requesting microphone permission")
            RunLog.write("permission.microphone.requested")
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] allowed in
                DispatchQueue.main.async {
                    guard let self, !self.recordingProcesses.isClosed else { return }
                    if !allowed {
                        RunLog.write("permission.microphone.denied")
                        self.onPermissionBlocked(
                            "Microphone permission denied",
                            event: "microphone-denied",
                            detail: "macOS denied microphone access for True Convo."
                        )
                    } else {
                        RunLog.write("permission.microphone.granted")
                    }
                    completion(allowed)
                }
            }
        case .denied:
            RunLog.write("permission.microphone.denied")
            onPermissionBlocked(
                "Microphone permission denied",
                event: "microphone-denied",
                detail: "macOS has microphone access denied for True Convo."
            )
            completion(false)
        case .restricted:
            RunLog.write("permission.microphone.restricted")
            onPermissionBlocked(
                "Microphone permission restricted",
                event: "microphone-restricted",
                detail: "macOS reports microphone access is restricted for True Convo."
            )
            completion(false)
        @unknown default:
            RunLog.write("permission.microphone.unknown")
            onPermissionBlocked(
                "Microphone permission unknown",
                event: "microphone-unknown",
                detail: "macOS returned an unknown microphone authorization status."
            )
            completion(false)
        }
    }

    private func startIdleMonitorAuthorized() {
        guard !recordingProcesses.isClosed else { return }
        do {
            let inputApplied = AudioDeviceInfo.applySelectedInputIfNeeded()
            let inputNode = idleAudioEngine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            guard let speechFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: format.sampleRate,
                channels: 1,
                interleaved: false
            ) else {
                throw VoiceCursorError.processFailed("Could not create idle monitor audio format.")
            }

            let sensitivity = Settings.wakeSensitivity
            idleWakeFrameCount = 0
            idleSmoothedLevel = 0
            idlePeakLevel = 0
            idleLastLevelLogAt = Date()
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                guard let self else { return }
                let speechBuffer = Self.monoSpeechBuffer(from: buffer, targetFormat: speechFormat) ?? buffer
                let level = Self.normalizedInputLevel(from: speechBuffer)
                let spectrum = Self.visualSpectrumSamples(from: speechBuffer, count: 42)
                self.onAudioLevel(level)
                self.onAudioWaveform(spectrum, level)

                self.idleSmoothedLevel = (self.idleSmoothedLevel * 0.72) + (level * 0.28)
                self.idlePeakLevel = max(self.idlePeakLevel, level)
                let smoothed = self.idleSmoothedLevel
                let peak = self.idlePeakLevel
                let isWakeCandidate = smoothed >= sensitivity.wakeThreshold || level >= sensitivity.spikeThreshold
                if isWakeCandidate {
                    let shouldLogCandidate = self.idleWakeFrameCount == 0
                    self.idleWakeFrameCount += 1
                    if shouldLogCandidate {
                        let frames = self.idleWakeFrameCount
                        DispatchQueue.main.async {
                            RunLog.write(
                                "persistent-pill.wake-candidate",
                                "sensitivity=\(sensitivity.rawValue) level=\(String(format: "%.3f", level)) smoothed=\(String(format: "%.3f", smoothed)) peak=\(String(format: "%.3f", peak)) frames=\(frames)"
                            )
                        }
                    }
                } else if smoothed < sensitivity.resetThreshold, level < sensitivity.resetThreshold {
                    self.idleWakeFrameCount = 0
                }

                let now = Date()
                if (level >= 0.04 || smoothed >= 0.04), now.timeIntervalSince(self.idleLastLevelLogAt) >= 2.0 {
                    self.idleLastLevelLogAt = now
                    let frames = self.idleWakeFrameCount
                    DispatchQueue.main.async {
                        RunLog.write(
                            "persistent-pill.idle-monitor.level",
                            "sensitivity=\(sensitivity.rawValue) level=\(String(format: "%.3f", level)) smoothed=\(String(format: "%.3f", smoothed)) peak=\(String(format: "%.3f", peak)) frames=\(frames)"
                        )
                    }
                }

                guard self.idleWakeFrameCount >= sensitivity.framesToWake else { return }
                let wakeFrames = self.idleWakeFrameCount
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.idleAudioEngine.isRunning else { return }
                    self.stopIdleMonitor()
                    RunLog.write(
                        "persistent-pill.wake-detected",
                        "sensitivity=\(sensitivity.rawValue) level=\(String(format: "%.3f", level)) smoothed=\(String(format: "%.3f", smoothed)) peak=\(String(format: "%.3f", peak)) frames=\(wakeFrames) inputApplied=\(inputApplied)"
                    )
                    self.onIdleWakeDetected()
                }
            }
            idleTapInstalled = true

            idleAudioEngine.prepare()
            try idleAudioEngine.start()
            RunLog.write(
                "persistent-pill.idle-monitor.started",
                "sensitivity=\(sensitivity.rawValue) wake=\(String(format: "%.3f", sensitivity.wakeThreshold)) spike=\(String(format: "%.3f", sensitivity.spikeThreshold)) reset=\(String(format: "%.3f", sensitivity.resetThreshold)) frames=\(sensitivity.framesToWake) inputApplied=\(inputApplied) inputDevice=\"\(AudioDeviceInfo.defaultInputDescription())\""
            )
            onStatus("Ready")
        } catch {
            stopIdleMonitor()
            RunLog.write("persistent-pill.idle-monitor.failed", error.localizedDescription)
            onStatus("Ready; mic wake unavailable")
        }
    }

    private func requestSpeechPermission(recognizer: SFSpeechRecognizer, language: String, attempt: Int) {
        guard !recordingProcesses.isClosed else { return }
        onStatus("Requesting speech permission")
        RunLog.write("permission.speech.requested")

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self, !self.recordingProcesses.isClosed else { return }
                guard self.isCurrentStart(attempt) else { return }
                switch status {
                case .authorized:
                    RunLog.write("permission.speech.granted")
                    self.startAuthorized(recognizer: recognizer, language: language)
                case .denied:
                    RunLog.write("permission.speech.denied")
                    if self.currentProvider.isPostStopProvider {
                        self.startRecordOnlyFallback(language: language, reason: "speech-denied")
                        return
                    }
                    self.onPermissionBlocked(
                        "Speech permission denied",
                        event: "speech-denied",
                        detail: "macOS denied Speech Recognition access for True Convo."
                    )
                case .restricted:
                    RunLog.write("permission.speech.restricted")
                    if self.currentProvider.isPostStopProvider {
                        self.startRecordOnlyFallback(language: language, reason: "speech-restricted")
                        return
                    }
                    self.onPermissionBlocked(
                        "Speech permission restricted",
                        event: "speech-restricted",
                        detail: "macOS reports Speech Recognition access is restricted for True Convo."
                    )
                case .notDetermined:
                    RunLog.write("permission.speech.not-determined")
                    if self.currentProvider.isPostStopProvider {
                        self.startRecordOnlyFallback(language: language, reason: "speech-not-determined")
                        return
                    }
                    self.onPermissionBlocked(
                        "Speech permission not determined",
                        event: "speech-not-determined",
                        detail: "Speech Recognition access is still not determined after the request."
                    )
                @unknown default:
                    RunLog.write("permission.speech.unknown")
                    if self.currentProvider.isPostStopProvider {
                        self.startRecordOnlyFallback(language: language, reason: "speech-unknown")
                        return
                    }
                    self.onPermissionBlocked(
                        "Speech permission unknown",
                        event: "speech-unknown",
                        detail: "macOS returned an unknown Speech Recognition authorization status."
                    )
                }
            }
        }
    }

    private func onPermissionBlocked(_ message: String, event: String, detail: String) {
        if let url = exportPermissionDiagnostic(event: event, detail: detail) {
            onStatus("\(message); diagnostics saved")
            RunLog.write("permission.diagnostics.exported", "event=\(event) path=\(url.path)")
        } else {
            onStatus(message)
        }
        onSessionFinished()
    }

    private func exportPermissionDiagnostic(event: String, detail: String) -> URL? {
        do {
            let report = [
                DiagnosticsReport.make(),
                "",
                "Permission Recovery",
                "- Event: \(event)",
                "- Detail: \(detail)",
                "- Next: use First Run Checklist or the True Convo menu to open the matching macOS privacy pane.",
            ].joined(separator: "\n")
            return try DiagnosticsReport.export(report)
        } catch {
            RunLog.write("permission.diagnostics.export.failed", "event=\(event) error=\(error.localizedDescription)")
            return nil
        }
    }

    private func startAuthorized(recognizer: SFSpeechRecognizer, language: String) {
        guard !recordingProcesses.isClosed else { return }
        startCapture(
            recognizer: recognizer,
            language: language,
            captureMode: .appleLive,
            fallbackReason: nil
        )
    }

    private func startRecordOnlyFallback(language: String, reason: String) {
        guard !recordingProcesses.isClosed else { return }
        guard currentProvider.isPostStopProvider else {
            onPermissionBlocked(
                "Speech permission needed",
                event: reason,
                detail: "Apple Local requires Speech Recognition permission."
            )
            return
        }
        RunLog.write(
            "dictation.record-only-fallback",
            "provider=\(currentProvider.rawValue) reason=\(reason)"
        )
        startCapture(
            recognizer: nil,
            language: language,
            captureMode: .recordOnlyFallback,
            fallbackReason: reason
        )
    }

    private func startCapture(
        recognizer: SFSpeechRecognizer?,
        language: String,
        captureMode: CaptureMode,
        fallbackReason: String?
    ) {
        guard !recordingProcesses.isClosed else { return }
        guard !isBusy else {
            RunLog.write("dictation.start.ignored", "reason=capture-already-running")
            return
        }
        do {
            try Archive.ensureDirectories()
            // This recording's choice is fixed before selecting or opening its
            // file. Later Settings changes apply only to future recordings.
            // A Desk recording never keeps its audio (decision A: memory only).
            let retainAudioAtStart = Settings.dictationPreferences.retainAudioForHarvest && deskRoute == nil
            sessionId = "voice-cursor-\(Int(Date().timeIntervalSince1970 * 1000))"
            startedAt = Date()
            sessionLanguage = language
            sessionTargetBundleID = deskRoute == nil ? TextInjector.targetApplication?.bundleIdentifier : nil
            latestTranscript = ""
            finalizedTranscriptSegments = []
            currentRecognitionTranscript = ""
            firstPartialAt = nil
            sliceCountLock.lock()
            sliceCountTotal = 0
            sliceCountAtOrAboveNearSilent = 0
            sliceCountAtOrAboveStrictSilent = 0
            sliceCountLock.unlock()
            liveListenerHadError = false
            firstFinalAt = nil
            currentCaptureMode = captureMode
            didLivePasteFinalText = false
            onSessionStarted(currentProvider)
            onTranscript("")
            onAudioLevel(0)
            // Apple On-Device (New) never writes a recording, so no audio file
            // is created for it and none is kept, whatever Retain Audio says.
            recordingURL = currentProvider == .appleSpeechAnalyzer ? nil : try Archive.captureRecordingURL(for: sessionId, retain: retainAudioAtStart)
            TextInjector.beginDictationSession()
            // A Desk recording resets the live preview's state but never
            // starts it: nothing is typed anywhere while it runs.
            TextInjector.beginLivePreviewIfNeeded(allowed: deskRoute == nil)
            let inputApplied = AudioDeviceInfo.applySelectedInputIfNeeded()

            let inputNode = audioEngine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            let inputDevice = AudioDeviceInfo.defaultInputDescription()
            guard let speechFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: format.sampleRate,
                channels: 1,
                interleaved: false
            ) else {
                throw VoiceCursorError.processFailed("Could not create mono speech audio format.")
            }
            if let recordingURL {
                try recordingProcesses.performIfOpen {
                    guard ownedRecordings.registerCapture(recordingURL, retain: retainAudioAtStart) else {
                        throw VoiceCursorError.processFailed("An existing or unavailable recording path must not be replaced.")
                    }
                    audioFile = try AVAudioFile(forWriting: recordingURL, settings: speechFormat.settings)
                }
            }

            if currentProvider == .openAIRealtime {
                let transcriber = OpenAIRealtimeTranscriber()
                transcriber.onReady = { [weak self] in
                    DispatchQueue.main.async {
                        guard let self, self.currentProvider == .openAIRealtime, self.audioEngine.isRunning else { return }
                        self.onStatus("OpenAI Realtime: streaming")
                    }
                }
                transcriber.onTranscript = { [weak self] text in
                    DispatchQueue.main.async {
                        self?.handleRealtimeTranscript(text, isFinal: false)
                    }
                }
                transcriber.onCompleted = { [weak self] text in
                    DispatchQueue.main.async {
                        self?.handleRealtimeTranscript(text, isFinal: true)
                    }
                }
                transcriber.onError = { [weak self] error in
                    DispatchQueue.main.async {
                        guard let self, self.currentProvider == .openAIRealtime else { return }
                        RunLog.write("openai-realtime.ui-error", error.localizedDescription)
                        if self.audioEngine.isRunning {
                            self.onStatus("OpenAI Realtime failed")
                        }
                    }
                }
                try transcriber.start(
                    language: language,
                    model: Settings.openAIRealtimeModel,
                    delay: Settings.openAIRealtimeDelay
                )
                realtimeTranscriber = transcriber
            }

            if currentProvider == .appleSpeechAnalyzer {
                guard #available(macOS 26, *) else {
                    throw VoiceCursorError.processFailed("\(DictationProvider.appleSpeechAnalyzer.label) needs macOS 26 or newer.")
                }
                let engine = AppleSpeechAnalyzerEngine(language: language, sessionId: sessionId, inputFormat: speechFormat)
                // Callbacks arrive on the main queue. Only the current engine
                // may touch this dictation; a finished or cancelled one is ignored.
                engine.onTranscript = { [weak self, weak engine] text, isFinal in
                    guard let self, let engine, self.speechAnalyzerEngine === engine else { return }
                    self.handleSpeechAnalyzerTranscript(text, isFinal: isFinal)
                }
                engine.onStatus = { [weak self, weak engine] text in
                    guard let self, let engine, self.speechAnalyzerEngine === engine, self.audioEngine.isRunning else { return }
                    self.onStatus(text)
                }
                engine.onError = { [weak self, weak engine] message in
                    guard let self, let engine, self.speechAnalyzerEngine === engine else { return }
                    self.handleSpeechAnalyzerError(message)
                }
                speechAnalyzerEngine = engine
                engine.start()
            }

            if let recognizer {
                startRecognitionSession(recognizer: recognizer)
            }

            // The tap runs on an audio thread. It holds this dictation's Apple
            // On-Device (New) engine itself and never reads the controller's
            // property, which the main thread clears at stop.
            let tapSpeechAnalyzerEngine = speechAnalyzerEngine
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                // Lets the finish wait for this callback if the tap is removed
                // while it is still running, so its audio isn't lost.
                tapSpeechAnalyzerEngine?.tapCallbackBegan()
                defer { tapSpeechAnalyzerEngine?.tapCallbackEnded() }
                guard let self else { return }
                let speechBuffer = Self.monoSpeechBuffer(from: buffer, targetFormat: speechFormat) ?? buffer
                self.request?.append(speechBuffer)
                self.realtimeTranscriber?.append(speechBuffer)
                tapSpeechAnalyzerEngine?.append(speechBuffer)
                if let audioFile = self.audioFile {
                    try? audioFile.write(from: speechBuffer)
                }
                let level = Self.normalizedInputLevel(from: speechBuffer)
                let sliceDBFS = SilentRecordingPolicy.dbfs(fromNormalizedLevel: level)
                self.sliceCountLock.lock()
                self.sliceCountTotal += 1
                if sliceDBFS >= SilentRecordingPolicy.nearSilentThresholdDBFS {
                    self.sliceCountAtOrAboveNearSilent += 1
                }
                if sliceDBFS >= SilentRecordingPolicy.strictSilentThresholdDBFS {
                    self.sliceCountAtOrAboveStrictSilent += 1
                }
                self.sliceCountLock.unlock()
                let spectrum = Self.visualSpectrumSamples(from: speechBuffer, count: 42)
                self.onAudioLevel(level)
                self.onAudioWaveform(spectrum, level)
                self.scheduleRecordOnlyAutoStopIfNeeded(for: level)
            }
            tapInstalled = true

            audioEngine.prepare()
            try audioEngine.start()
            // Evidence for whether Apple's new engine needs Speech Recognition
            // approval: it never asks for it, so this shows what macOS has on file.
            let speechAuthDetail = currentProvider == .appleSpeechAnalyzer
                ? " speechAuth=\"\(DiagnosticsReport.speechStatus())\""
                : ""
            RunLog.write(
                "dictation.started",
                "id=\(sessionId) provider=\(currentProvider.rawValue) privacy=\"\(currentProvider.privacyLabel)\" mode=\(captureMode.rawValue) selectedInput=\"\(AudioDeviceInfo.selectedInputLabel())\" inputApplied=\(inputApplied) inputDevice=\"\(inputDevice)\" inputChannels=\(format.channelCount) archiveChannels=\(speechFormat.channelCount) recording=\(recordingURL?.path ?? "none") reason=\(fallbackReason ?? "none")\(speechAuthDetail)"
            )
            onStatus(captureMode == .recordOnlyFallback
                ? "\(currentProvider.label): recording for post-stop transcription"
                : "\(currentProvider.label): listening")
        } catch {
            stopWithoutArchive()
            RunLog.write("dictation.start.failed", error.localizedDescription)
            onStatus("Start failed: \(error.localizedDescription)")
            onSessionFinished()
        }
    }

    private func startRecognitionSession(recognizer: SFSpeechRecognizer) {
        recognitionRestartWorkItem?.cancel()
        recognitionGeneration += 1
        let generation = recognitionGeneration
        request?.endAudio()
        task?.cancel()

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if #available(macOS 13, *) {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    recordFirstPartialIfNeeded()
                    if result.isFinal {
                        recordFirstFinalIfNeeded()
                    }
                }
                self.currentRecognitionTranscript = text
                if result.isFinal {
                    if let segment = self.promoteCurrentRecognitionTranscript(reason: "final-result") {
                        self.livePasteFinalizedSegmentIfNeeded(segment, reason: "final-result")
                    }
                }
                let combinedText = self.combinedTranscript()
                self.latestTranscript = combinedText
                if self.deskRoute == nil { TextInjector.updateLivePreview(combinedText) }
                self.scheduleAutoStopIfNeeded(for: combinedText)
                self.onTranscript(combinedText)
                self.onStatus(combinedText.isEmpty ? "Listening" : combinedText)

                if result.isFinal {
                    self.scheduleRecognitionRestart(
                        recognizer: recognizer,
                        after: 0.05,
                        reason: "final-result"
                    )
                }
            }

            if let error = error as NSError? {
                self.handleRecognitionError(error, generation: generation)
            }
        }

        scheduleRecognitionRestart(
            recognizer: recognizer,
            after: recognitionRestartInterval,
            reason: "timer"
        )
    }

    /// Every recognizer error is logged with its domain and code. Only a real
    /// problem with the live recognizer is shown: not the "Recognition request
    /// was canceled" that follows our own stop or restart, and not "no speech".
    private func handleRecognitionError(_ error: NSError, generation: Int) {
        let endedByTrueConvo = generation != recognitionGeneration
        let noSpeech = error.code == 203 || error.code == 1110
        let shown = !endedByTrueConvo && !noSpeech
        RunLog.write(
            "speech.recognition.error",
            "id=\(sessionId) domain=\(error.domain) code=\(error.code) endedByTrueConvo=\(endedByTrueConvo) noSpeech=\(noSpeech) shown=\(shown) message=\"\(error.localizedDescription)\""
        )
        if shown {
            liveListenerHadError = true
            onStatus(error.localizedDescription)
        }
    }

    private func handleRealtimeTranscript(_ text: String, isFinal: Bool) {
        guard currentProvider == .openAIRealtime else { return }
        guard audioEngine.isRunning || isProcessing else { return }
        let normalized = text
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalized.isEmpty {
            recordFirstPartialIfNeeded()
            if isFinal {
                recordFirstFinalIfNeeded()
            }
        }
        currentRecognitionTranscript = normalized
        latestTranscript = normalized
        if audioEngine.isRunning {
            if deskRoute == nil { TextInjector.updateLivePreview(normalized) }
            scheduleAutoStopIfNeeded(for: normalized)
        }
        onTranscript(normalized)
        onStatus(normalized.isEmpty ? "OpenAI Realtime: streaming" : normalized)
    }

    /// Rough words from Apple On-Device (New) go to the floating bubble only;
    /// this engine never types them into the app while you talk.
    private func handleSpeechAnalyzerTranscript(_ text: String, isFinal: Bool) {
        guard currentProvider == .appleSpeechAnalyzer, audioEngine.isRunning else { return }
        let normalized = text
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalized.isEmpty {
            recordFirstPartialIfNeeded()
            if isFinal {
                recordFirstFinalIfNeeded()
            }
        }
        currentRecognitionTranscript = normalized
        latestTranscript = normalized
        scheduleAutoStopIfNeeded(for: normalized)
        onTranscript(normalized)
        onStatus(normalized.isEmpty ? "\(currentProvider.label): listening" : normalized)
    }

    private func handleSpeechAnalyzerError(_ message: String) {
        RunLog.write("speech-analyzer.ui-error", "id=\(sessionId) message=\"\(message)\"")
        guard currentProvider == .appleSpeechAnalyzer, audioEngine.isRunning else { return }
        liveListenerHadError = true
        let status = "\(currentProvider.label): \(message)"
        if latestTranscript.isEmpty {
            // Nothing heard yet and no recording is kept, so this dictation
            // can't produce text: stop now with the plain reason.
            RunLog.write("speech-analyzer.dictation.stopped", "id=\(sessionId) reason=engine-error-before-any-words")
            stopWithoutArchive()
            onStatus(status)
            onSessionFinished()
        } else {
            // Apple's engine has stopped, so no more words can arrive. Finish
            // now the normal way and keep the words heard so far; the engine
            // hands back the reason, shown when the finish is done.
            RunLog.write("speech-analyzer.dictation.stopped", "id=\(sessionId) reason=engine-error-after-words")
            stop()
        }
    }

    private func scheduleRecognitionRestart(
        recognizer: SFSpeechRecognizer,
        after delay: TimeInterval,
        reason: String
    ) {
        recognitionRestartWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self, self.audioEngine.isRunning, !self.isProcessing else { return }
            if let segment = self.promoteCurrentRecognitionTranscript(reason: reason) {
                self.livePasteFinalizedSegmentIfNeeded(segment, reason: reason)
            }
            self.latestTranscript = self.combinedTranscript()
            RunLog.write("speech.recognition.restart", "id=\(self.sessionId) reason=\(reason)")
            self.startRecognitionSession(recognizer: recognizer)
        }
        recognitionRestartWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    @discardableResult
    private func promoteCurrentRecognitionTranscript(reason: String) -> String? {
        let text = currentRecognitionTranscript
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            currentRecognitionTranscript = ""
            return nil
        }

        if finalizedTranscriptSegments.last != text {
            finalizedTranscriptSegments.append(text)
            RunLog.write("speech.recognition.segment.finalized", "id=\(sessionId) reason=\(reason)")
            currentRecognitionTranscript = ""
            return text
        }
        currentRecognitionTranscript = ""
        return nil
    }

    /// Pastes a finalized Apple segment while the dictation is still going.
    /// Only finalized segments come here, never live partial text. Saved fixes
    /// are applied as a no-write preview, so what lands in the app already
    /// carries them; the finished transcript counts their uses once at stop.
    private func livePasteFinalizedSegmentIfNeeded(_ segment: String, reason: String) {
        let cleaned = cleanedDictationText(segment)
        guard !cleaned.isEmpty else { return }
        guard Settings.livePasteAppleFinals else { return }
        guard !Settings.liveInsertApplePartials else { return }
        guard currentProvider == .appleLocal, currentCaptureMode == .appleLive else { return }
        guard Settings.completionAction == .autoPaste || Settings.completionAction == .autoSubmit else { return }
        guard deskRoute == nil else { return }

        let text = SavedCorrections.preview(
            cleaned,
            targetBundleID: sessionTargetBundleID,
            language: sessionLanguage
        )
        didLivePasteFinalText = true
        RunLog.write(
            "completion.live-paste.requested",
            "id=\(sessionId) reason=\(reason) savedFixes=\(text == cleaned ? "none" : "applied")"
        )
        DispatchQueue.main.async {
            TextInjector.paste(text + " ")
        }
    }

    private func combinedTranscript() -> String {
        let current = currentRecognitionTranscript
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (finalizedTranscriptSegments + (current.isEmpty ? [] : [current]))
            .joined(separator: " ")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func normalizedInputLevel(from buffer: AVAudioPCMBuffer) -> Double {
        guard let channelData = buffer.floatChannelData else { return 0 }
        let channelCount = Int(buffer.format.channelCount)
        let frameLength = Int(buffer.frameLength)
        guard channelCount > 0, frameLength > 0 else { return 0 }

        var squareSum: Double = 0
        var sampleCount = 0
        for channel in 0..<channelCount {
            let samples = UnsafeBufferPointer(start: channelData[channel], count: frameLength)
            for sample in samples {
                let value = Double(sample)
                squareSum += value * value
                sampleCount += 1
            }
        }
        guard sampleCount > 0 else { return 0 }

        let rms = sqrt(squareSum / Double(sampleCount))
        let decibels = 20 * log10(max(rms, 0.000_001))
        return min(max((decibels + 60) / 60, 0), 1)
    }

    private static func visualSpectrumSamples(from buffer: AVAudioPCMBuffer, count: Int) -> [CGFloat] {
        guard count > 1,
              let channelData = buffer.floatChannelData,
              buffer.format.commonFormat == .pcmFormatFloat32
        else {
            return Array(repeating: 0, count: max(0, count))
        }

        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else {
            return Array(repeating: 0, count: count)
        }

        let sampleRate = max(8_000.0, buffer.format.sampleRate)
        let analysisLength = min(frameLength, 1024)
        let samples = UnsafeBufferPointer(start: channelData[0], count: analysisLength)
        let minFrequency = 85.0
        let maxFrequency = min(5_000.0, sampleRate * 0.42)

        var magnitudes: [Double] = []
        magnitudes.reserveCapacity(count)
        for bin in 0..<count {
            let ratio = Double(bin) / Double(max(1, count - 1))
            let frequency = minFrequency * pow(maxFrequency / minFrequency, ratio)
            let omega = 2.0 * Double.pi * frequency / sampleRate
            let coefficient = 2.0 * cos(omega)
            var q0 = 0.0
            var q1 = 0.0
            var q2 = 0.0

            for frame in 0..<analysisLength {
                let window = 0.5 - 0.5 * cos((2.0 * Double.pi * Double(frame)) / Double(max(1, analysisLength - 1)))
                q0 = coefficient * q1 - q2 + Double(samples[frame]) * window
                q2 = q1
                q1 = q0
            }

            let real = q1 - q2 * cos(omega)
            let imaginary = q2 * sin(omega)
            magnitudes.append(sqrt(real * real + imaginary * imaginary) / Double(analysisLength))
        }

        let maxMagnitude = max(0.000_01, magnitudes.max() ?? 0)
        return magnitudes.map { magnitude in
            let normalized = min(1.0, magnitude / maxMagnitude)
            let lifted = pow(normalized, 0.48)
            return CGFloat(min(1.0, max(0.0, lifted)))
        }
    }

    private static func monoSpeechBuffer(from buffer: AVAudioPCMBuffer, targetFormat: AVAudioFormat) -> AVAudioPCMBuffer? {
        let channelCount = Int(buffer.format.channelCount)
        let frameLength = Int(buffer.frameLength)
        guard channelCount > 0, frameLength > 0,
              let monoBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: buffer.frameCapacity),
              let output = monoBuffer.floatChannelData?[0]
        else {
            return nil
        }
        monoBuffer.frameLength = buffer.frameLength

        if channelCount == 1,
           buffer.format.commonFormat == .pcmFormatFloat32,
           let input = buffer.floatChannelData?[0]
        {
            for frame in 0..<frameLength {
                output[frame] = input[frame]
            }
            return monoBuffer
        }

        guard buffer.format.commonFormat == .pcmFormatFloat32 else {
            return nil
        }

        if buffer.format.isInterleaved {
            let audioBuffer = buffer.audioBufferList.pointee.mBuffers
            guard let data = audioBuffer.mData else {
                return nil
            }
            let input = data.assumingMemoryBound(to: Float.self)
            let selectedChannel = loudestInterleavedChannel(input: input, frameLength: frameLength, channelCount: channelCount)
            for frame in 0..<frameLength {
                output[frame] = input[(frame * channelCount) + selectedChannel]
            }
            return monoBuffer
        }

        guard let channels = buffer.floatChannelData else {
            return nil
        }
        let selectedChannel = loudestPlanarChannel(channels: channels, frameLength: frameLength, channelCount: channelCount)
        for frame in 0..<frameLength {
            output[frame] = channels[selectedChannel][frame]
        }
        return monoBuffer
    }

    private static func loudestInterleavedChannel(input: UnsafePointer<Float>, frameLength: Int, channelCount: Int) -> Int {
        var bestChannel = 0
        var bestEnergy = Double.leastNonzeroMagnitude
        for channel in 0..<channelCount {
            var energy = 0.0
            for frame in 0..<frameLength {
                let value = Double(input[(frame * channelCount) + channel])
                energy += value * value
            }
            if energy > bestEnergy {
                bestEnergy = energy
                bestChannel = channel
            }
        }
        return bestChannel
    }

    private static func loudestPlanarChannel(channels: UnsafePointer<UnsafeMutablePointer<Float>>, frameLength: Int, channelCount: Int) -> Int {
        var bestChannel = 0
        var bestEnergy = Double.leastNonzeroMagnitude
        for channel in 0..<channelCount {
            var energy = 0.0
            for frame in 0..<frameLength {
                let value = Double(channels[channel][frame])
                energy += value * value
            }
            if energy > bestEnergy {
                bestEnergy = energy
                bestChannel = channel
            }
        }
        return bestChannel
    }

    func stop() {
        guard isRecording else { return }

        if let segment = promoteCurrentRecognitionTranscript(reason: "stop") {
            livePasteFinalizedSegmentIfNeeded(segment, reason: "stop")
        }
        latestTranscript = combinedTranscript()
        let fallbackTranscript = latestTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        let url = recordingURL
        let retainAudioForHarvest = url.flatMap { ownedRecordings.retainsCapture($0) } ?? false
        let sessionStartedAt = startedAt
        let durationMs = Int(Date().timeIntervalSince(sessionStartedAt) * 1000)
        let id = sessionId
        let timestamp = ISO8601DateFormatter().string(from: sessionStartedAt)
        let provider = currentProvider
        let modelAtStop = modelName(for: provider)
        let captureMode = currentCaptureMode
        let language = sessionLanguage
        let deskRouteAtStop = deskRoute
        // A Desk recording inserts nothing: its words go only to the Desk.
        let completionActionAtStop = deskRouteAtStop == nil ? Settings.completionAction : .archiveOnly
        let stopProcessingStartedAt = Date()
        let firstPartialAt = self.firstPartialAt
        let firstFinalAt = self.firstFinalAt
        sliceCountLock.lock()
        let slicesTotalAtStop = sliceCountTotal
        let slicesNearAtStop = sliceCountAtOrAboveNearSilent
        let slicesStrictAtStop = sliceCountAtOrAboveStrictSilent
        sliceCountLock.unlock()
        let liveListenerHadErrorAtStop = liveListenerHadError
        let livePasted = didLivePasteFinalText
        let activeRealtimeTranscriber = realtimeTranscriber
        if provider == .openAIRealtime {
            realtimeTranscriber = nil
        }
        RunLog.write("dictation.stop.requested", "id=\(id) provider=\(provider.rawValue) durationMs=\(durationMs)")

        TextInjector.freezeLivePreviewPartials()
        // A Desk recording never started a live preview: nothing to commit.
        let livePreviewStopResult: TextInjector.LivePreviewCompletionResult = deskRouteAtStop == nil
            ? TextInjector.commitLivePreviewForImmediateStop(suppressDelayedInsertIfNoLiveText: provider.isPostStopProvider)
            : .inactive
        let guardedFinalPasteAtStop = deskRouteAtStop == nil && TextInjector.hasExternalFinalPasteGuard
        let correctionBuilderAtStop = TextInjector.consumeCorrectionContextBuilder()
        let correctionBuilder = deskRouteAtStop == nil ? correctionBuilderAtStop : nil
        let targetContext = deskRouteAtStop == nil ? TextInjector.currentTargetContext() : nil
        RunLog.write(
            "cursor-target.archived",
            targetContext.map { "id=\(id) \($0.logDetail)" } ?? "id=\(id) target=missing"
        )
        stopWithoutArchive(
            closeRealtime: provider != .openAIRealtime,
            closeSpeechAnalyzer: provider != .appleSpeechAnalyzer,
            keepRecordingForFinalization: true
        )
        // Order for Apple On-Device (New): the audio engine is stopped and the
        // tap removed just above, so the engine already has the last buffer
        // (the tap holds the engine itself, not this property). Only then,
        // in the task below, does finishAndWait end the analyzer's input,
        // flush the converter, and finish. It is finished, not cancelled.
        let activeSpeechAnalyzerEngine = speechAnalyzerEngine
        speechAnalyzerEngine = nil
        let finalizesInBackground = deskRouteAtStop == nil && (livePreviewStopResult != .inactive || guardedFinalPasteAtStop)
        if finalizesInBackground {
            isProcessing = true
            onStatus("Finishing dictation")
            RunLog.write(
                "dictation.background-finalize.started",
                "id=\(id) provider=\(provider.rawValue) livePreviewResult=\(livePreviewStopResult)"
            )
            if livePreviewStopResult.insertedOrCommitted &&
                !livePreviewStopResult.suppressesLateInsertion &&
                completionActionAtStop == .autoSubmit
            {
                RunLog.write("completion.live-submit.requested", "id=\(id) action=\(completionActionAtStop.rawValue) timing=immediate-stop")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    TextInjector.pressReturn()
                }
            }
        } else {
            isProcessing = true
            onStatus(provider == .openAIRealtime ? "Finalizing OpenAI stream" : (provider.isPostStopProvider ? "Transcribing with \(provider.label)" : "Finalizing"))
        }

        finalizationTask = Task {
            var releasedRecording = false
            defer { if !releasedRecording, let url { self.finishOwnedRecording(url) } }
            guard !Task.isCancelled, !self.recordingProcesses.isClosed else { return }
            var finalText = fallbackTranscript
            var model = modelAtStop
            var postStopTranscriptionMs: Int?
            var archiveFinalizeMs: Int?
            // Apple On-Device (New): whether it produced words itself, its
            // plain reason when it failed, wasn't ready, or didn't finish, and
            // whether its text may be missing words.
            var speechEngineHeardWords = false
            var speechEngineProblem: String?
            var speechEngineIncomplete = false

            if provider == .openAIRealtime, let activeRealtimeTranscriber {
                let transcriptionStartedAt = Date()
                if let streamedText = await activeRealtimeTranscriber.finishAndWait(timeout: 6.0) {
                    finalText = streamedText
                }
                activeRealtimeTranscriber.close(reason: "stop-finished")
                postStopTranscriptionMs = milliseconds(between: transcriptionStartedAt, and: Date())
                model = modelAtStop
            } else if provider == .appleSpeechAnalyzer, let activeSpeechAnalyzerEngine {
                let transcriptionStartedAt = Date()
                let finish = await activeSpeechAnalyzerEngine.finishAndWait(timeout: 6.0)
                // The engine's own text is the answer, even when it is empty.
                // The bubble's rough words from the moment the key was
                // released are never used: Apple's final pass may have taken
                // them back, and they must not be pasted or sent as complete.
                finalText = finish.text ?? ""
                speechEngineHeardWords = finish.text != nil
                if finish.text == nil, !fallbackTranscript.isEmpty {
                    RunLog.write(
                        "speech-analyzer.rough-text-dropped",
                        "id=\(id) roughChars=\(fallbackTranscript.count) complete=\(finish.complete)"
                    )
                }
                speechEngineProblem = finish.problem
                speechEngineIncomplete = !finish.complete
                postStopTranscriptionMs = milliseconds(between: transcriptionStartedAt, and: Date())
                model = activeSpeechAnalyzerEngine.modelName
            } else if provider.isPostStopProvider, let url {
                do {
                    let transcriptionStartedAt = Date()
                    let result = try await TranscriptionService.transcribe(
                        provider: provider,
                        audioURL: url,
                        language: language,
                        modelOverride: modelAtStop,
                        processes: self.recordingProcesses
                    )
                    postStopTranscriptionMs = milliseconds(between: transcriptionStartedAt, and: Date())
                    finalText = result.text
                    model = result.model
                } catch {
                    if !finalizesInBackground {
                        await MainActor.run {
                            self.onStatus(
                                captureMode == .appleLive
                                    ? "Provider failed; using Apple preview"
                                    : "Provider failed; no live preview available"
                            )
                        }
                    } else {
                        RunLog.write("transcription.provider.failed.background", "id=\(id) provider=\(provider.rawValue)")
                    }
                    RunLog.write(
                        "transcription.provider.failed",
                        "id=\(id) provider=\(provider.rawValue) error=\(error.localizedDescription)"
                    )
                }
            }

            guard !Task.isCancelled, !self.recordingProcesses.isClosed else { return }
            var retainedAudioPath: String?
            let archiveFormat = Settings.archiveFormat
            if let url, retainAudioForHarvest {
                do {
                    let archiveStartedAt = Date()
                    if let retainedURL = try self.prepareOwnedRecordingForRetention(url, format: archiveFormat) {
                        retainedAudioPath = try await Archive.finalizeAudio(retainedURL, format: archiveFormat, processes: self.recordingProcesses).path
                    }
                    archiveFinalizeMs = milliseconds(between: archiveStartedAt, and: Date())
                } catch {
                    if !finalizesInBackground {
                        await MainActor.run {
                            self.onStatus("FLAC failed; kept WAV")
                        }
                    }
                    RunLog.write("archive.audio.flac.failed", "id=\(id) error=\(error.localizedDescription)")
                    retainedAudioPath = self.retainedOwnedRecordingPath(url)
                    archiveFinalizeMs = milliseconds(between: stopProcessingStartedAt, and: Date())
                }
            } else if let url {
                let discardStartedAt = Date()
                self.finishOwnedRecording(url)
                RunLog.write("archive.audio.discarded", "id=\(id) reason=retained-audio-harvest-off")
                archiveFinalizeMs = milliseconds(between: discardStartedAt, and: Date())
            }

            if let url {
                // Release this capture before the controller becomes available
                // again. Later changes to retention never delete prior audio.
                if !retainAudioForHarvest { retainedAudioPath = nil }
                self.finishOwnedRecording(url)
            }
            releasedRecording = true
            guard !Task.isCancelled, !self.recordingProcesses.isClosed else { return }

            // Silent-recording guard: Whisper invents text from silence ("Thank you
            // for watching..."). See SilentRecordingPolicy for the rule. Words
            // from Apple On-Device (New) count as heard even when they arrived
            // after the key was released (its model can finish loading late).
            let liveListenerHeardWords = firstPartialAt != nil || speechEngineHeardWords
            if !finalText.isEmpty,
               SilentRecordingPolicy.treatAsNoSpeech(
                   liveListenerRanWithoutError: captureMode == .appleLive && !liveListenerHadErrorAtStop,
                   liveListenerHeardWords: liveListenerHeardWords,
                   recordingSeconds: Double(durationMs) / 1000,
                   slicesAtOrAboveNearSilent: slicesNearAtStop,
                   slicesAtOrAboveStrictSilent: slicesStrictAtStop,
                   totalSlices: slicesTotalAtStop
               ) {
                RunLog.write(
                    "dictation.silent-recording",
                    "id=\(id) slices=\(slicesTotalAtStop) speechLoud=\(slicesNearAtStop) quietSpeech=\(slicesStrictAtStop) listenerError=\(liveListenerHadErrorAtStop) heardWords=\(liveListenerHeardWords) droppedChars=\(finalText.count)"
                )
                finalText = ""
            }
            let cleanedText = SavedCorrections.applyToFinishedDictation(
                cleanedDictationText(finalText),
                targetBundleID: targetContext?.bundleIdentifier,
                language: language
            )
            if cleanedText != finalText.trimmingCharacters(in: .whitespacesAndNewlines) {
                RunLog.write("transcript.punctuation.normalized", "id=\(id)")
            }
            // Apple On-Device (New) failed, wasn't ready, or didn't finish: say
            // why, instead of blaming the microphone.
            let speechEngineProblemStatus: String? = speechEngineProblem.map { problem in
                cleanedText.isEmpty
                    ? "\(provider.label): \(problem)"
                    : "Partial text: \(provider.label) didn't finish (\(problem))"
            }
            let speechEngineNoTextOutcome: DictationOutcome? = cleanedText.isEmpty
                ? speechEngineProblemStatus.map { .engineProblem($0) }
                : nil
            // Text that may be missing words is delivered like any other text
            // (pasted, or copied), but never sent with an automatic Return.
            // The pill says it is partial, and history marks it.
            let deliversPartialText = speechEngineIncomplete && !cleanedText.isEmpty
            if deliversPartialText {
                RunLog.write(
                    "speech-analyzer.partial-text",
                    "id=\(id) chars=\(cleanedText.count) autoSubmit=skipped reason=\"\(speechEngineProblem ?? "unknown")\""
                )
            }
            let completionAction = completionActionAtStop
            let wantsTextInsertion = !cleanedText.isEmpty && (completionAction == .autoPaste || completionAction == .autoSubmit)
            if livePreviewStopResult != .inactive, wantsTextInsertion {
                // A fast finish (Apple speech) can land while the dictation
                // key is still held; the swap below types only after release.
                await TextInjector.waitForHotKeyRelease(timeout: 0.8)
            }
            let livePreviewOutcome = await MainActor.run {
                if livePreviewStopResult != .inactive {
                    let finalPasteGuardReason = TextInjector.consumeExternalFinalPasteGuardReason()
                    if wantsTextInsertion,
                       let reconcileResult = TextInjector.reconcileCommittedKeyboardPreview(finalText: cleanedText)
                    {
                        return (result: reconcileResult, finalPasteGuardReason: finalPasteGuardReason)
                    }
                    // Nothing to type, so a swap still pending would never run.
                    TextInjector.discardPendingFinalReconcile(reason: "no-final-text")
                    return (result: livePreviewStopResult, finalPasteGuardReason: finalPasteGuardReason)
                }
                let finalPasteGuardReason = TextInjector.consumeExternalFinalPasteGuardReason()
                if wantsTextInsertion {
                    return (result: TextInjector.finishLivePreview(finalText: cleanedText), finalPasteGuardReason: finalPasteGuardReason)
                }
                TextInjector.cancelLivePreview(removeInserted: true)
                return (result: TextInjector.LivePreviewCompletionResult.inactive, finalPasteGuardReason: finalPasteGuardReason)
            }
            let livePreviewResult = livePreviewOutcome.result
            // A Desk recording pastes nothing, so no outside input can have
            // made a paste unsafe: no safety-stop clipboard fallback.
            let finalPasteGuardReason = deskRouteAtStop == nil ? livePreviewOutcome.finalPasteGuardReason : nil
            let livePreviewInjected = livePreviewResult.insertedOrCommitted
            // Words already typed into the app before the finish: live typing
            // or live-pasted Apple segments.
            let liveWordsInApp = livePreviewStopResult.insertedOrCommitted || livePreviewInjected || livePasted
            let suppressFinalPasteAfterExternalInput = finalPasteGuardReason != nil && !livePreviewInjected
            let suppressLateInsertion = livePreviewResult.suppressesLateInsertion || suppressFinalPasteAfterExternalInput
            let requestedInjection = !cleanedText.isEmpty && (completionAction == .autoPaste || completionAction == .autoSubmit)
            let injected = requestedInjection && (
                livePreviewInjected || (!suppressLateInsertion && TextInjector.canConfirmFinalPaste)
            )
            let correction = correctionBuilder?(cleanedText)
            let archiveCaptureMode: String
            if livePreviewInjected {
                archiveCaptureMode = provider == .openAIRealtime ? "openai-realtime-cursor-preview" : "apple-live-cursor-preview"
            } else if livePasted && provider == .appleLocal {
                archiveCaptureMode = "apple-live-paste"
            } else {
                archiveCaptureMode = captureMode.rawValue
            }
            // History marks partial text so it's never mistaken for a full dictation.
            let archivedCaptureMode = deliversPartialText ? "\(archiveCaptureMode)-partial" : archiveCaptureMode

            let entry = ArchiveEntry(
                id: id,
                timestamp: timestamp,
                durationMs: durationMs,
                text: cleanedText,
                audioPath: retainedAudioPath,
                contentPacketPath: Archive.contentPacketURL(for: id).path,
                derivedFromSessionId: nil,
                captureMode: archivedCaptureMode,
                timing: ArchiveTiming(
                    liveFirstPartialMs: firstPartialAt.map { milliseconds(between: sessionStartedAt, and: $0) },
                    liveFirstFinalMs: firstFinalAt.map { milliseconds(between: sessionStartedAt, and: $0) },
                    postStopTranscriptionMs: postStopTranscriptionMs,
                    archiveFinalizeMs: archiveFinalizeMs,
                    totalStopProcessingMs: milliseconds(between: stopProcessingStartedAt, and: Date())
                ),
                provider: provider.rawValue,
                model: model,
                language: language,
                source: "voice-cursor-mac-prototype",
                injected: injected,
                target: targetContext,
                correction: correction
            )
            if deskRouteAtStop == nil {
                do {
                    try Archive.append(entry)
                    RunLog.write(
                        "archive.session.wrote",
                        "id=\(id) transcript=\(Archive.transcriptURL(for: id).path) packet=\(Archive.contentPacketURL(for: id).path) audio=\(retainedAudioPath ?? "none")"
                    )
                } catch {
                    RunLog.write("archive.session.failed", "id=\(id) error=\(error.localizedDescription)")
                }
            } else {
                // Desk words stay in memory only (owner decision A).
                RunLog.write("archive.session.skipped", "id=\(id) reason=desk-recording")
            }
            // A Desk recording's words go to the Desk, once, and nowhere else.
            let deskOutcome: DictationOutcome?
            if let deskRouteAtStop, !cleanedText.isEmpty {
                deskOutcome = await deskRouteAtStop.deliver(cleanedText)
            } else {
                deskOutcome = nil
            }

            await MainActor.run {
                if !cleanedText.isEmpty, deskRouteAtStop == nil {
                    self.lastDictationText = cleanedText
                }
                if finalizesInBackground {
                    var safetyStopOutcome: DictationOutcome?
                    if suppressLateInsertion && !cleanedText.isEmpty {
                        self.onTranscript(cleanedText)
                        safetyStopOutcome = self.deliverAfterSafetyStop(
                            cleanedText,
                            liveWordsInApp: liveWordsInApp,
                            finalPasteGuardReason: finalPasteGuardReason,
                            sessionId: id,
                            archiveReasonPrefix: "background-finalize"
                        )
                    }
                    RunLog.write("dictation.background-finalize.finished", "id=\(id) chars=\(cleanedText.count)")
                    self.isProcessing = false
                    if let safetyStopOutcome {
                        self.onStatus(safetyStopOutcome.pillMessage)
                    } else if !self.isRecording {
                        self.onStatus(speechEngineProblemStatus ?? (cleanedText.isEmpty ? "Didn't hear you — check your microphone" : "Archived final transcript"))
                    }
                    if !deliversPartialText,
                       livePreviewStopResult == .awaitingFinalText,
                       livePreviewResult == .inserted,
                       completionActionAtStop == .autoSubmit
                    {
                        // Nothing was typed live, so nothing was sent at the
                        // stop. The final text was just typed; send it now.
                        RunLog.write("completion.live-submit.requested", "id=\(id) action=\(completionActionAtStop.rawValue) timing=after-final-typed")
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                            TextInjector.pressReturn()
                        }
                    }
                    var backgroundOutcome: DictationOutcome
                    if cleanedText.isEmpty {
                        backgroundOutcome = speechEngineNoTextOutcome ?? .noSpeech
                    } else if let safetyStopOutcome {
                        backgroundOutcome = safetyStopOutcome
                    } else if injected {
                        backgroundOutcome = completionActionAtStop == .autoSubmit && !deliversPartialText ? .insertedAndSubmitted : .inserted
                    } else if requestedInjection && !suppressLateInsertion && TextInjector.canAutoPaste {
                        backgroundOutcome = .pasteUnconfirmed
                    } else {
                        backgroundOutcome = .archivedOnly
                    }
                    if deliversPartialText {
                        backgroundOutcome = .partialText(delivered: backgroundOutcome)
                    }
                    RunLog.write("dictation.outcome", "id=\(id) \(backgroundOutcome.logDetail)")
                    self.onOutcome(backgroundOutcome)
                    self.onSessionFinished()
                    self.onFinalizationFinished()
                    return
                }

                self.onTranscript(cleanedText)
                let shouldPasteAtStop = !livePasted && !livePreviewInjected && !suppressLateInsertion && !cleanedText.isEmpty && (completionAction == .autoPaste || completionAction == .autoSubmit)
                let shouldSubmit = !deliversPartialText && !suppressLateInsertion && !cleanedText.isEmpty && completionAction == .autoSubmit
                var safetyStopOutcome: DictationOutcome?
                if shouldPasteAtStop {
                    TextInjector.paste(cleanedText + " ")
                    RunLog.write("completion.paste.requested", "id=\(id) action=\(completionAction.rawValue)")
                    if shouldSubmit {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                            TextInjector.pressReturn()
                        }
                    }
                } else if shouldSubmit {
                    RunLog.write("completion.live-submit.requested", "id=\(id) action=\(completionAction.rawValue)")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        TextInjector.pressReturn()
                    }
                } else if suppressLateInsertion && !cleanedText.isEmpty {
                    safetyStopOutcome = self.deliverAfterSafetyStop(
                        cleanedText,
                        liveWordsInApp: liveWordsInApp,
                        finalPasteGuardReason: finalPasteGuardReason,
                        sessionId: id,
                        archiveReasonPrefix: "foreground-finalize"
                    )
                } else if !cleanedText.isEmpty && completionAction == .clipboard {
                    TextInjector.writePrivateClipboardText(cleanedText)
                    RunLog.write("completion.clipboard.wrote", "id=\(id)")
                } else if completionAction == .archiveOnly {
                    RunLog.write("completion.archive-only", "id=\(id) hasText=\(!cleanedText.isEmpty)")
                }
                self.isProcessing = false
                if let deskOutcome {
                    self.onStatus(deskOutcome.pillMessage)
                } else if let safetyStopOutcome {
                    self.onStatus(safetyStopOutcome.pillMessage)
                } else {
                    self.onStatus(speechEngineProblemStatus ?? self.statusText(for: completionAction, hasText: !cleanedText.isEmpty, injected: injected))
                }
                var outcome: DictationOutcome
                if cleanedText.isEmpty {
                    outcome = speechEngineNoTextOutcome ?? .noSpeech
                } else if let deskOutcome {
                    outcome = deskOutcome
                } else if let safetyStopOutcome {
                    outcome = safetyStopOutcome
                } else if shouldPasteAtStop || livePreviewInjected || livePasted {
                    if injected {
                        outcome = shouldSubmit ? .insertedAndSubmitted : .inserted
                    } else if TextInjector.canAutoPaste {
                        outcome = .pasteUnconfirmed
                    } else {
                        outcome = .copiedNeedsAccessibility
                    }
                } else if completionAction == .clipboard {
                    outcome = .copiedToClipboard
                } else {
                    outcome = .archivedOnly
                }
                if deliversPartialText {
                    outcome = .partialText(delivered: outcome)
                }
                RunLog.write("dictation.outcome", "id=\(id) \(outcome.logDetail)")
                self.onOutcome(outcome)
                self.onSessionFinished()
                self.onFinalizationFinished()
            }
        }
    }

    /// A safety stop (a click, another key, or a different app in front) kept
    /// the finished text from being typed. Nothing is dropped: it is in
    /// history and in the menu's Copy Last Dictation. It goes on the clipboard
    /// unless the owner copied or cut something during the dictation. When live
    /// words are already in the app, the note never says to paste, which
    /// would add the dictation twice.
    private func deliverAfterSafetyStop(
        _ text: String,
        liveWordsInApp: Bool,
        finalPasteGuardReason: String?,
        sessionId id: String,
        archiveReasonPrefix: String
    ) -> DictationOutcome {
        let fallback = SafetyStopClipboardPolicy.fallback(
            liveWordsInApp: liveWordsInApp,
            clipboardChangedDuringDictation: TextInjector.clipboardChangedDuringDictation
        )
        if fallback.writesClipboard {
            TextInjector.writeClipboardFallback(
                text,
                reason: finalPasteGuardReason.map { "final-paste-guard-\($0)" } ?? "live-preview-not-pasted",
                sessionId: id
            )
        } else {
            RunLog.write(
                "completion.clipboard.left-alone",
                "id=\(id) reason=changed-during-dictation liveWordsInApp=\(liveWordsInApp)"
            )
        }
        TextInjector.archiveSuppressedLateInsertion(
            finalText: text,
            sessionId: id,
            reason: finalPasteGuardReason.map { "\(archiveReasonPrefix)-\($0)" } ?? "\(archiveReasonPrefix)-external-guard"
        )
        switch fallback {
        case .clipboardNothingTyped: return .savedNotPasted(clipboardFallback: true)
        case .clipboardKeptNothingTyped: return .savedNotPasted(clipboardFallback: false)
        case .liveWordsKeptFullVersionOnClipboard: return .liveWordsKept(fullVersionOnClipboard: true)
        case .liveWordsKeptClipboardKept: return .liveWordsKept(fullVersionOnClipboard: false)
        }
    }

    private func recordFirstPartialIfNeeded() {
        guard firstPartialAt == nil else { return }
        let now = Date()
        firstPartialAt = now
        RunLog.write("speech.recognition.first-partial", "id=\(sessionId) latencyMs=\(milliseconds(between: startedAt, and: now))")
    }

    private func recordFirstFinalIfNeeded() {
        guard firstFinalAt == nil else { return }
        let now = Date()
        firstFinalAt = now
        RunLog.write("speech.recognition.first-final", "id=\(sessionId) latencyMs=\(milliseconds(between: startedAt, and: now))")
    }

    private func scheduleRecordOnlyAutoStopIfNeeded(for level: Double) {
        guard (currentCaptureMode == .recordOnlyFallback || currentCaptureMode == .openAIRealtime), Settings.autoStop else { return }
        guard level >= 0.05 else { return }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard self.isRecording, !self.isProcessing, Settings.autoStop else { return }
            self.autoStopWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                guard let self else { return }
                guard self.isRecording, !self.isProcessing, Settings.autoStop else { return }
                self.onStatus("Auto-stopping after input pause")
                self.stop()
            }
            self.autoStopWorkItem = workItem
            DispatchQueue.main.asyncAfter(
                deadline: .now() + Settings.autoStopDelaySeconds,
                execute: workItem
            )
        }
    }

    private func statusText(for action: CompletionAction, hasText: Bool, injected: Bool) -> String {
        guard hasText else {
            return "Didn't hear you — check your microphone"
        }
        switch action {
        case .autoPaste:
            return injected ? "Pasted" : "Copied; enable Accessibility"
        case .autoSubmit:
            return injected ? "Pasted and submitted" : "Copied; enable Accessibility"
        case .clipboard:
            return "Copied"
        case .archiveOnly:
            return "Archived"
        }
    }

    private func modelName(for provider: DictationProvider) -> String {
        switch provider {
        case .appleLocal: return "SFSpeechRecognizer/on-device"
        case .localWhisper: return Settings.localWhisperModel
        case .openAIRealtime: return Settings.openAIRealtimeModel
        case .openAICloud: return Settings.openAIModel
        case .groqCloud: return Settings.groqModel
        case .appleSpeechAnalyzer: return "SpeechAnalyzer/SpeechTranscriber"
        }
    }

    private func scheduleAutoStopIfNeeded(for text: String) {
        guard Settings.autoStop else { return }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard self.isRecording, !self.isProcessing, Settings.autoStop else { return }
            self.autoStopWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                guard let self else { return }
                guard self.isRecording, !self.isProcessing, Settings.autoStop else { return }
                self.onStatus("Auto-stopping after pause")
                self.stop()
            }
            self.autoStopWorkItem = workItem
            DispatchQueue.main.asyncAfter(
                deadline: .now() + Settings.autoStopDelaySeconds,
                execute: workItem
            )
        }
    }

    /// Stop without starting delayed transcription during application shutdown.
    func shutdown() {
        finalizationTask?.cancel()
        // No converter may start after this point, and existing owned writers
        // must exit before shutdown removes their input/output files.
        recordingProcesses.cancelAndWait()
        stopIdleMonitor()
        stopWithoutArchive()
        logAudioCleanupFailures(ownedRecordings.shutdown())
    }

    private func logAudioCleanupFailures(_ urls: [URL]) {
        if !urls.isEmpty { RunLog.write("audio.temporary.cleanup.failed", "count=\(urls.count)") }
    }

    private func prepareOwnedRecordingForRetention(_ url: URL, format: ArchiveFormat) throws -> URL? {
        try recordingProcesses.performIfOpen {
            guard ownedRecordings.isOwned(url) else { return nil }
            let destination = Archive.recordings.appendingPathComponent(url.lastPathComponent)
            if destination != url {
                guard ownedRecordings.registerOutput(destination, forCapture: url) else { throw CancellationError() }
            }
            if format == .flac {
                let output = destination.deletingPathExtension().appendingPathExtension("flac")
                guard ownedRecordings.registerOutput(output, forCapture: url) else { throw CancellationError() }
            }
            return try Archive.promoteTemporaryAudio(url)
        }
    }

    private func retainedOwnedRecordingPath(_ url: URL) -> String? {
        let retained = Archive.recordings.appendingPathComponent(url.lastPathComponent)
        return ownedRecordings.isOwned(retained) && FileManager.default.fileExists(atPath: retained.path) ? retained.path : nil
    }

    private func finishOwnedRecording(_ url: URL) {
        logAudioCleanupFailures(ownedRecordings.finishCapture(url))
    }

    private func stopWithoutArchive(closeRealtime: Bool = true, closeSpeechAnalyzer: Bool = true, keepRecordingForFinalization: Bool = false) {
        autoStopWorkItem?.cancel()
        autoStopWorkItem = nil
        recognitionRestartWorkItem?.cancel()
        recognitionRestartWorkItem = nil
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        // Ending the recognizer here is on purpose; its "canceled" error is not
        // shown (see handleRecognitionError).
        recognitionGeneration += 1
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        if closeRealtime {
            realtimeTranscriber?.close(reason: "stop-without-archive")
            realtimeTranscriber = nil
        }
        if closeSpeechAnalyzer {
            speechAnalyzerEngine?.cancel()
            speechAnalyzerEngine = nil
        }
        audioFile = nil
        if !keepRecordingForFinalization, let recordingURL { finishOwnedRecording(recordingURL) }
        recordingURL = nil
        onAudioLevel(0)
    }
}

final class HotKey {
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandlerRef: EventHandlerRef?
    private let hotKeyId: EventHotKeyID
    private let callbackBox: UnsafeMutableRawPointer

    init(id: UInt32, shortcut: HotKeyShortcut, onPressed: @escaping () -> Void, onReleased: @escaping () -> Void) {
        hotKeyId = EventHotKeyID(signature: fourCharCode("vcur"), id: id)
        callbackBox = Unmanaged.passRetained(HotKeyCallbackBox(
            hotKeyId: hotKeyId,
            onPressed: onPressed,
            onReleased: onReleased
        )).toOpaque()
        var eventSpecs = [
            EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventHotKeyPressed)
            ),
            EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventHotKeyReleased)
            ),
        ]

        _ = eventSpecs.withUnsafeMutableBufferPointer { buffer in
            InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
                guard let userData, let event else { return noErr }
                let box = Unmanaged<HotKeyCallbackBox>.fromOpaque(userData).takeUnretainedValue()
                guard box.matches(event: event) else { return OSStatus(eventNotHandledErr) }
                switch GetEventKind(event) {
                case UInt32(kEventHotKeyPressed):
                    box.onPressed()
                case UInt32(kEventHotKeyReleased):
                    box.onReleased()
                default:
                    break
                }
                return noErr
            }, buffer.count, buffer.baseAddress, callbackBox, &eventHandlerRef)
        }

        register(shortcut)
    }

    deinit {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
        }
        if let eventHandlerRef {
            RemoveEventHandler(eventHandlerRef)
        }
        Unmanaged<HotKeyCallbackBox>.fromOpaque(callbackBox).release()
    }

    func update(shortcut: HotKeyShortcut) {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
            self.hotKeyRef = nil
        }
        register(shortcut)
    }

    private func register(_ shortcut: HotKeyShortcut) {
        let status = RegisterEventHotKey(
            shortcut.keyCode,
            shortcut.carbonModifiers,
            hotKeyId,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
        if status == noErr {
            RunLog.write(
                "hotkey.registered",
                "id=\(hotKeyId.id) shortcut=\(shortcut.label) modes=press-to-toggle,hold-to-record"
            )
        } else {
            RunLog.write("hotkey.registration.failed", "shortcut=\(shortcut.label) status=\(status)")
        }
    }
}

final class HotKeyCallbackBox {
    let hotKeyId: EventHotKeyID
    let onPressed: () -> Void
    let onReleased: () -> Void

    init(hotKeyId: EventHotKeyID, onPressed: @escaping () -> Void, onReleased: @escaping () -> Void) {
        self.hotKeyId = hotKeyId
        self.onPressed = onPressed
        self.onReleased = onReleased
    }

    func matches(event: EventRef) -> Bool {
        var eventHotKeyId = EventHotKeyID()
        let status = GetEventParameter(
            event,
            EventParamName(kEventParamDirectObject),
            EventParamType(typeEventHotKeyID),
            nil,
            MemoryLayout<EventHotKeyID>.size,
            nil,
            &eventHotKeyId
        )
        return status == noErr
            && eventHotKeyId.signature == hotKeyId.signature
            && eventHotKeyId.id == hotKeyId.id
    }
}

func fourCharCode(_ value: String) -> OSType {
    value.utf8.reduce(0) { result, char in
        (result << 8) + OSType(char)
    }
}

func milliseconds(between start: Date, and end: Date) -> Int {
    max(0, Int(end.timeIntervalSince(start) * 1000))
}

final class SettingsWindowController: NSWindowController {
    private let providerPopup = NSPopUpButton()
    private let archivePopup = NSPopUpButton()
    private let completionActionPopup = NSPopUpButton()
    private let autoStopButton = NSButton(checkboxWithTitle: "Stop automatically after a speech pause", target: nil, action: nil)
    private let retainAudioButton = NSButton(checkboxWithTitle: "Retain audio for Harvest review", target: nil, action: nil)
    private let recordingsStateLabel = NSTextField(wrappingLabelWithString: "")
    private let livePasteButton = NSButton(checkboxWithTitle: "Paste Apple final chunks while recording", target: nil, action: nil)
    private let liveInsertPartialsButton = NSButton(checkboxWithTitle: "Show live Apple preview at cursor", target: nil, action: nil)
    private let correctionCaptureButton = NSButton(checkboxWithTitle: "Enable Convo Engine Harvest correction capture", target: nil, action: nil)
    private let spokenPunctuationButton = NSButton(checkboxWithTitle: "Convert spoken punctuation commands", target: nil, action: nil)
    private let autoStopDelayField = NSTextField()
    private let wakeSensitivityPopup = NSPopUpButton()
    private let scopeAmplitudeSlider = NSSlider(value: Settings.scopeAmplitudeGain, minValue: 0.6, maxValue: 2.4, target: nil, action: nil)
    private let scopeSweepSlider = NSSlider(value: Settings.scopeSweepSpeed, minValue: 0.6, maxValue: 36.0, target: nil, action: nil)
    private let languageField = NSTextField()
    private let localWhisperModelField = NSTextField()
    private let openAIRealtimeModelField = NSTextField()
    private let openAIModelField = NSTextField()
    private let groqModelField = NSTextField()
    private let whisperBinaryField = NSTextField()
    private let ffmpegBinaryField = NSTextField()
    private let openAIKeyField = NSSecureTextField()
    private let groqKeyField = NSSecureTextField()
    private let statusLabel = NSTextField(labelWithString: "")
    private let onSave: () -> Void

    init(onSave: @escaping () -> Void) {
        self.onSave = onSave
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 784),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "True Convo Settings"
        window.center()
        super.init(window: window)
        buildContent()
        loadValues()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func showWindow(_ sender: Any?) {
        loadValues()
        super.showWindow(sender)
        window?.makeKeyAndOrderFront(sender)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildContent() {
        guard let contentView = window?.contentView else { return }

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -20),
        ])

        providerPopup.addItems(withTitles: DictationProvider.selectableCases.map { "\($0.label) (\($0.privacyLabel))" })
        archivePopup.addItems(withTitles: ArchiveFormat.allCases.map(\.label))
        completionActionPopup.addItems(withTitles: CompletionAction.allCases.map(\.label))
        wakeSensitivityPopup.addItems(withTitles: WakeSensitivity.allCases.map(\.label))
        providerPopup.toolTip = "Choose Local Only for on-device dictation or OpenAI Realtime for live cloud streaming."
        archivePopup.toolTip = "Choose how retained audio recordings are saved."
        retainAudioButton.toolTip = "Off by default. Keep raw recordings only when you explicitly want local Harvest or reprocess evidence."
        completionActionPopup.toolTip = "Choose what happens after dictation stops."
        autoStopButton.toolTip = "Stop automatically after a silence pause. Increase the pause delay if normal sentence breaks stop recording too early."
        livePasteButton.toolTip = "Paste Apple final chunks while recording instead of waiting until dictation stops."
        liveInsertPartialsButton.toolTip = "Experimental: insert Apple's changing partial transcript at the clicked cursor, then replace it with final text after stop."
        correctionCaptureButton.toolTip = "Off by default. When enabled, selected text can become local Convo Engine correction-review evidence; it is not automatic training."
        spokenPunctuationButton.toolTip = "Turn this off if you want automatic punctuation only and do not want spoken words like comma or period converted into symbols."
        autoStopDelayField.toolTip = "Pause delay seconds: how long silence must last before auto-stop ends recording."
        wakeSensitivityPopup.toolTip = "How easily the persistent pill wakes when it hears your voice after a completed dictation."
        scopeAmplitudeSlider.toolTip = "Scope amplitude: how dramatically the pill visualizer responds to your microphone level."
        scopeSweepSlider.toolTip = "Scope sweep speed: how quickly the pill visualizer moves across words."
        languageField.toolTip = "Speech recognition language code, such as en-US."
        localWhisperModelField.toolTip = "Local Whisper model name used when Local Whisper is selected."
        openAIRealtimeModelField.toolTip = "OpenAI model used for live cloud streaming. This streams active microphone audio after dictation starts."
        openAIModelField.toolTip = "OpenAI transcription model used when OpenAI Cloud is selected."
        groqModelField.toolTip = "Groq transcription model used when Groq Cloud is selected."
        whisperBinaryField.toolTip = "Path to the local whisper command."
        ffmpegBinaryField.toolTip = "Path to ffmpeg for FLAC conversion."
        openAIKeyField.toolTip = "Saved to macOS Keychain. Leave blank to keep the existing key."
        groqKeyField.toolTip = "Saved to macOS Keychain. Leave blank to keep the existing key."

        stack.addArrangedSubview(row("Provider", providerPopup))
        stack.addArrangedSubview(row("Archive format", archivePopup))
        stack.addArrangedSubview(row("Retain audio", retainAudioButton))
        recordingsStateLabel.font = NSFont.systemFont(ofSize: 11)
        recordingsStateLabel.textColor = .secondaryLabelColor
        stack.addArrangedSubview(row("Saved recording state", recordingsStateLabel))
        stack.addArrangedSubview(row("After dictation", completionActionPopup))
        stack.addArrangedSubview(row("Auto-stop", autoStopButton))
        stack.addArrangedSubview(row("Live paste", livePasteButton))
        stack.addArrangedSubview(row("Live cursor preview", liveInsertPartialsButton))
        stack.addArrangedSubview(row("Convo Engine Harvest", correctionCaptureButton))
        stack.addArrangedSubview(row("Spoken punctuation", spokenPunctuationButton))
        stack.addArrangedSubview(row("Pause delay seconds", autoStopDelayField))
        stack.addArrangedSubview(row("Wake sensitivity", wakeSensitivityPopup))
        stack.addArrangedSubview(row("Scope amplitude", scopeAmplitudeSlider))
        stack.addArrangedSubview(row("Scope sweep speed", scopeSweepSlider))
        stack.addArrangedSubview(row("Language", languageField))
        stack.addArrangedSubview(separator())
        stack.addArrangedSubview(row("Local Whisper model", localWhisperModelField))
        stack.addArrangedSubview(row("OpenAI Realtime model", openAIRealtimeModelField))
        stack.addArrangedSubview(row("OpenAI model", openAIModelField))
        stack.addArrangedSubview(row("Groq model", groqModelField))
        stack.addArrangedSubview(row("Whisper binary", whisperBinaryField))
        stack.addArrangedSubview(row("ffmpeg binary", ffmpegBinaryField))
        stack.addArrangedSubview(separator())
        stack.addArrangedSubview(row("OpenAI API key", openAIKeyField))
        stack.addArrangedSubview(row("Groq API key", groqKeyField))

        let hint = NSTextField(labelWithString: "API keys are saved to macOS Keychain. Leave a key field blank to keep the existing value.")
        hint.textColor = .secondaryLabelColor
        hint.font = .systemFont(ofSize: 12)
        hint.lineBreakMode = .byWordWrapping
        hint.maximumNumberOfLines = 2
        stack.addArrangedSubview(hint)

        statusLabel.textColor = .secondaryLabelColor
        statusLabel.font = .systemFont(ofSize: 12)

        let buttons = NSStackView()
        buttons.orientation = .horizontal
        buttons.spacing = 8
        buttons.alignment = .centerY

        let saveButton = NSButton(title: "Save", target: self, action: #selector(save))
        saveButton.bezelStyle = .rounded
        let clearKeysButton = NSButton(title: "Clear Cloud Keys", target: self, action: #selector(clearCloudKeys))
        clearKeysButton.bezelStyle = .rounded
        let cancelButton = NSButton(title: "Close", target: self, action: #selector(closeWindow))
        cancelButton.bezelStyle = .rounded

        buttons.addArrangedSubview(saveButton)
        buttons.addArrangedSubview(clearKeysButton)
        buttons.addArrangedSubview(cancelButton)
        buttons.addArrangedSubview(statusLabel)
        stack.addArrangedSubview(buttons)
    }

    private func row(_ label: String, _ control: NSView) -> NSStackView {
        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12

        let labelView = NSTextField(labelWithString: label)
        labelView.alignment = .right
        labelView.widthAnchor.constraint(equalToConstant: 145).isActive = true
        row.addArrangedSubview(labelView)

        control.translatesAutoresizingMaskIntoConstraints = false
        control.widthAnchor.constraint(equalToConstant: 340).isActive = true
        row.addArrangedSubview(control)
        return row
    }

    private func separator() -> NSBox {
        let box = NSBox()
        box.boxType = .separator
        box.widthAnchor.constraint(equalToConstant: 520).isActive = true
        return box
    }

    private func loadValues() {
        providerPopup.selectItem(at: DictationProvider.selectableCases.firstIndex(of: Settings.provider) ?? 0)
        archivePopup.selectItem(at: ArchiveFormat.allCases.firstIndex(of: Settings.archiveFormat) ?? 0)
        retainAudioButton.state = Settings.dictationPreferences.retainAudioForHarvest ? .on : .off
        recordingsStateLabel.stringValue = Settings.dictationPreferences.savedRetentionNotice ?? "Recording retention is off. Temporary audio is removed after use or when the app stops. Existing recordings are unchanged."
        completionActionPopup.selectItem(at: CompletionAction.allCases.firstIndex(of: Settings.completionAction) ?? 0)
        autoStopButton.state = Settings.autoStop ? .on : .off
        livePasteButton.state = Settings.livePasteAppleFinals ? .on : .off
        liveInsertPartialsButton.state = Settings.liveInsertApplePartials ? .on : .off
        correctionCaptureButton.state = Settings.captureSelectionCorrections ? .on : .off
        spokenPunctuationButton.state = Settings.spokenPunctuationCommands ? .on : .off
        autoStopDelayField.stringValue = String(format: "%.1f", Settings.autoStopDelaySeconds)
        wakeSensitivityPopup.selectItem(at: WakeSensitivity.allCases.firstIndex(of: Settings.wakeSensitivity) ?? 1)
        scopeAmplitudeSlider.doubleValue = Settings.scopeAmplitudeGain
        scopeSweepSlider.doubleValue = Settings.scopeSweepSpeed
        languageField.stringValue = Settings.language
        localWhisperModelField.stringValue = Settings.localWhisperModel
        openAIRealtimeModelField.stringValue = Settings.openAIRealtimeModel
        openAIModelField.stringValue = Settings.openAIModel
        groqModelField.stringValue = Settings.groqModel
        whisperBinaryField.stringValue = Settings.whisperBinary
        ffmpegBinaryField.stringValue = Settings.ffmpegBinary
        openAIKeyField.stringValue = ""
        groqKeyField.stringValue = ""
        let openAISource = RuntimeEnvironment.source("OPENAI_API_KEY")
        let groqSource = RuntimeEnvironment.source("GROQ_API_KEY")
        statusLabel.stringValue = [
            openAISource == "missing" ? "OpenAI key missing" : "OpenAI key via \(openAISource)",
            groqSource == "missing" ? "Groq key missing" : "Groq key via \(groqSource)",
        ].compactMap { $0 }.joined(separator: " · ")
    }

    @objc private func save() {
        Settings.provider = DictationProvider.selectableCases[max(0, providerPopup.indexOfSelectedItem)]
        Settings.archiveFormat = ArchiveFormat.allCases[max(0, archivePopup.indexOfSelectedItem)]
        Settings.dictationPreferences.retainAudioForHarvest = retainAudioButton.state == .on
        Settings.completionAction = CompletionAction.allCases[max(0, completionActionPopup.indexOfSelectedItem)]
        Settings.autoStop = autoStopButton.state == .on
        Settings.livePasteAppleFinals = livePasteButton.state == .on
        Settings.liveInsertApplePartials = liveInsertPartialsButton.state == .on
        Settings.captureSelectionCorrections = correctionCaptureButton.state == .on
        Settings.spokenPunctuationCommands = spokenPunctuationButton.state == .on
        if Settings.liveInsertApplePartials {
            Settings.livePasteAppleFinals = false
            // Same as the menu's Live Cursor Preview toggle: live typing can't
            // start while insertion is "Final Paste Only", so checking the box
            // must also leave that mode (to Auto, which uses the app profiles).
            if Settings.insertionMode == .finalPasteOnly {
                Settings.insertionMode = .auto
                RunLog.write("settings.insertion-mode.auto", "reason=live-preview-checked")
            }
        }
        Settings.autoStopDelaySeconds = Double(autoStopDelayField.stringValue) ?? 2.6
        Settings.wakeSensitivity = WakeSensitivity.allCases[max(0, wakeSensitivityPopup.indexOfSelectedItem)]
        Settings.scopeAmplitudeGain = scopeAmplitudeSlider.doubleValue
        Settings.scopeSweepSpeed = scopeSweepSlider.doubleValue
        Settings.language = nonEmpty(languageField.stringValue, fallback: "en-US")
        Settings.localWhisperModel = nonEmpty(localWhisperModelField.stringValue, fallback: "small")
        Settings.openAIRealtimeModel = nonEmpty(openAIRealtimeModelField.stringValue, fallback: "gpt-realtime-whisper")
        Settings.openAIModel = nonEmpty(openAIModelField.stringValue, fallback: "gpt-4o-mini-transcribe")
        Settings.groqModel = nonEmpty(groqModelField.stringValue, fallback: "whisper-large-v3-turbo")
        Settings.whisperBinary = nonEmpty(whisperBinaryField.stringValue, fallback: "/opt/homebrew/bin/whisper")
        Settings.ffmpegBinary = nonEmpty(ffmpegBinaryField.stringValue, fallback: "/opt/homebrew/bin/ffmpeg")

        do {
            if !openAIKeyField.stringValue.isEmpty {
                try KeychainStore.write(openAIKeyField.stringValue, account: "OPENAI_API_KEY")
            }
            if !groqKeyField.stringValue.isEmpty {
                try KeychainStore.write(groqKeyField.stringValue, account: "GROQ_API_KEY")
            }
            statusLabel.stringValue = "Saved"
            openAIKeyField.stringValue = ""
            groqKeyField.stringValue = ""
            RunLog.write(
                "settings.saved",
                "provider=\(Settings.provider.rawValue) privacy=\"\(Settings.provider.privacyLabel)\" action=\(Settings.completionAction.rawValue) archive=\(Settings.archiveFormat.rawValue) retainAudio=\(Settings.dictationPreferences.retainAudioForHarvest) autoStop=\(Settings.autoStop) livePaste=\(Settings.livePasteAppleFinals) livePreview=\(Settings.liveInsertApplePartials) correctionCapture=\(Settings.captureSelectionCorrections) spokenPunctuation=\(Settings.spokenPunctuationCommands) wakeSensitivity=\(Settings.wakeSensitivity.rawValue) scopeAmplitude=\(String(format: "%.2f", Settings.scopeAmplitudeGain)) scopeSweep=\(String(format: "%.2f", Settings.scopeSweepSpeed))"
            )
            onSave()
        } catch {
            statusLabel.stringValue = error.localizedDescription
            RunLog.write("settings.save.failed", error.localizedDescription)
        }
    }

    @objc private func clearCloudKeys() {
        do {
            try KeychainStore.delete("OPENAI_API_KEY")
            try KeychainStore.delete("GROQ_API_KEY")
            openAIKeyField.stringValue = ""
            groqKeyField.stringValue = ""
            statusLabel.stringValue = "Cloud keys cleared"
            RunLog.write("settings.cloud-keys.cleared")
        } catch {
            statusLabel.stringValue = error.localizedDescription
            RunLog.write("settings.cloud-keys.clear.failed", error.localizedDescription)
        }
    }

    @objc private func closeWindow() {
        window?.close()
    }

    private func nonEmpty(_ value: String, fallback: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : trimmed
    }
}

enum DiagnosticsReport {
    static func make() -> String {
        let lines = [
            "True Convo Diagnostics",
            "Generated: \(ISO8601DateFormatter().string(from: Date()))",
            "",
            "Permissions",
            "- Microphone: \(microphoneStatus())",
            "- Speech Recognition: \(speechStatus())",
            "- Accessibility: \(AXIsProcessTrusted() ? "granted" : "not granted")",
            "",
            "Audio Input",
            "- Current default input: \(currentAudioInput())",
            "",
            "Selected Settings",
            "- Provider: \(Settings.provider.label)",
            "- Privacy mode: \(Settings.provider.privacyLabel)",
            "- Archive format: \(Settings.archiveFormat.label)",
            "- Retain audio for Harvest: \(Settings.dictationPreferences.retainAudioForHarvest ? "enabled" : "disabled")",
            "- After dictation: \(Settings.completionAction.label)",
            "- Auto-stop: \(Settings.autoStop ? "enabled" : "disabled")",
            "- Auto-stop delay: \(String(format: "%.1f", Settings.autoStopDelaySeconds))s",
            "- Live paste Apple finals: \(Settings.livePasteAppleFinals ? "enabled" : "disabled")",
            "- Live cursor preview: \(Settings.liveInsertApplePartials ? "enabled" : "disabled")",
            "- Scope amplitude: \(String(format: "%.2f", Settings.scopeAmplitudeGain))",
            "- Scope sweep speed: \(String(format: "%.2f", Settings.scopeSweepSpeed))",
            "- Language: \(Settings.language)",
            "- Local Whisper model: \(Settings.localWhisperModel)",
            "- OpenAI Realtime model: \(Settings.openAIRealtimeModel)",
            "- OpenAI model: \(Settings.openAIModel)",
            "- Groq model: \(Settings.groqModel)",
            "",
            "Provider Readiness",
            "- Apple Local: \(appleLocalReadiness())",
            "- Local Whisper: \(localWhisperReadiness())",
            "- OpenAI Realtime: \(cloudReadiness("OPENAI_API_KEY"))",
            "- OpenAI Cloud: \(cloudReadiness("OPENAI_API_KEY"))",
            "- Groq Cloud: \(cloudReadiness("GROQ_API_KEY"))",
            "- Post-stop capture fallback: \(postStopCaptureFallbackReadiness())",
            "",
            "Local Tools",
            "- Whisper binary: \(fileStatus(Settings.whisperBinary, executable: true))",
            "- ffmpeg binary: \(fileStatus(Settings.ffmpegBinary, executable: true))",
            "",
            "Archive",
            "- Root: \(Archive.root.path)",
            "- Root writable: \(writableStatus(Archive.root))",
            "- Recordings: \(Archive.recordings.path)",
            "- Transcripts: \(Archive.transcripts.path)",
            "- Content packets: \(Archive.packets.path)",
            "- Latest transcript: \(Archive.latestTranscript.path)",
            "- Latest content packet: \(Archive.latestContentPacket.path)",
            "- Latest session JSON: \(Archive.latestSession.path)",
            "- Timing report: \(Archive.timingReport.path)",
            "- Harvest inbox: \(Archive.harvestInbox.path)",
            "- Latest harvest bundle: \(Archive.latestHarvestBundle.path)",
            "- Harvest bundles: \(Archive.harvestBundles.path)",
            "- Start Here: \(Archive.startHere.path)",
            "- Live proof JSON: \(Archive.liveProof.path)",
            "- Live proof summary: \(Archive.liveProofSummary.path)",
            "- Latest provider comparison: \(Archive.latestProviderComparison.path)",
            "- Provider comparisons: \(Archive.providerComparisons.path)",
            "- Diagnostics: \(Archive.diagnostics.path)",
            "- Run log: \(Archive.runLog.path)",
            "- Run log writable: \(writableStatus(Archive.runLog))",
            "",
            "Recent Run Log",
            RunLog.tail().map { "- \($0)" }.joined(separator: "\n"),
            "",
            "Cloud Keys",
            "- OPENAI_API_KEY: \(RuntimeEnvironment.source("OPENAI_API_KEY"))",
            "- GROQ_API_KEY: \(RuntimeEnvironment.source("GROQ_API_KEY"))",
            "",
            "Packaging",
            "- Bundle ID: \(Bundle.main.bundleIdentifier ?? "unknown")",
            "- App version: \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown")",
            "- Executable: \(Bundle.main.executableURL?.path ?? "unknown")",
            "- Executable modified: \(BuildFingerprint.executableModifiedDescription())",
            "- Executable SHA-256: \(BuildFingerprint.executableSha256Description())",
            "",
            "Notes",
            "- Diagnostics do not request microphone or speech permissions.",
            "- Live dictation still requires launching the app and approving macOS prompts.",
            "- Distribution still requires Developer ID signing and notarization.",
        ]
        return lines.joined(separator: "\n")
    }

    static func export(_ report: String? = nil) throws -> URL {
        try Archive.ensureDirectories()
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let safeTimestamp = timestamp
            .replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: ".", with: "-")
        let url = Archive.diagnostics.appendingPathComponent("voice-cursor-diagnostics-\(safeTimestamp).md")
        let body = [
            "# True Convo Diagnostics",
            "",
            "```text",
            report ?? make(),
            "```",
            "",
        ].joined(separator: "\n")
        try body.write(to: url, atomically: true, encoding: .utf8)
        RunLog.write("diagnostics.exported", url.path)
        return url
    }

    static func microphoneStatus() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return "granted"
        case .denied:
            return "denied"
        case .restricted:
            return "restricted"
        case .notDetermined:
            return "not determined"
        @unknown default:
            return "unknown"
        }
    }

    static func speechStatus() -> String {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            return "granted"
        case .denied:
            return "denied"
        case .restricted:
            return "restricted"
        case .notDetermined:
            return "not determined"
        @unknown default:
            return "unknown"
        }
    }

    static func currentAudioInput() -> String {
        AVCaptureDevice.default(for: .audio)?.localizedName ?? "none visible"
    }

    private static func appleLocalReadiness() -> String {
        let mic = microphoneStatus()
        let speech = speechStatus()
        let input = currentAudioInput()
        guard input != "none visible" else {
            return "needs visible audio input"
        }
        if mic == "granted", speech == "granted" {
            return "ready"
        }
        return "needs Microphone=\(mic), Speech=\(speech)"
    }

    private static func localWhisperReadiness() -> String {
        let whisperReady = FileManager.default.isExecutableFile(atPath: Settings.whisperBinary)
        let ffmpegReady = Settings.archiveFormat == .wav || FileManager.default.isExecutableFile(atPath: Settings.ffmpegBinary)
        if whisperReady, ffmpegReady {
            return "ready"
        }

        let missing = [
            whisperReady ? nil : "Whisper binary",
            ffmpegReady ? nil : "ffmpeg binary for FLAC",
        ].compactMap { $0 }
        return "needs \(missing.joined(separator: ", "))"
    }

    private static func postStopCaptureFallbackReadiness() -> String {
        let mic = microphoneStatus()
        let input = currentAudioInput()
        guard input != "none visible" else {
            return "needs visible audio input"
        }
        if mic == "granted" {
            return "ready for Local Whisper/OpenAI/Groq without Speech Recognition live preview"
        }
        return "needs Microphone=\(mic)"
    }

    private static func cloudReadiness(_ keyName: String) -> String {
        let source = RuntimeEnvironment.source(keyName)
        guard source != "missing" else {
            return "needs \(keyName)"
        }
        return "ready via \(source)"
    }

    private static func fileStatus(_ path: String, executable: Bool) -> String {
        let exists = FileManager.default.fileExists(atPath: path)
        guard exists else {
            return "\(path) (missing)"
        }
        if executable, !FileManager.default.isExecutableFile(atPath: path) {
            return "\(path) (exists, not executable)"
        }
        return "\(path) (ready)"
    }

    private static func writableStatus(_ url: URL) -> String {
        if FileManager.default.fileExists(atPath: url.path) {
            return FileManager.default.isWritableFile(atPath: url.path) ? "yes" : "no"
        }
        var candidate = url.deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: candidate.path),
              candidate.path != candidate.deletingLastPathComponent().path
        {
            candidate = candidate.deletingLastPathComponent()
        }
        return FileManager.default.isWritableFile(atPath: candidate.path)
            ? "nearest parent writable: \(candidate.path)"
            : "nearest parent not writable: \(candidate.path)"
    }
}

final class DiagnosticsWindowController: NSWindowController {
    private let textView = NSTextView()
    private let statusLabel = NSTextField(labelWithString: "")

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 560),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "True Convo Diagnostics"
        window.center()
        super.init(window: window)
        buildContent()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func showWindow(_ sender: Any?) {
        refresh()
        super.showWindow(sender)
        window?.makeKeyAndOrderFront(sender)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildContent() {
        guard let contentView = window?.contentView else { return }

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -14),
            stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -14),
        ])

        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .bezelBorder
        textView.isEditable = false
        textView.isRichText = false
        textView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        scrollView.documentView = textView
        scrollView.heightAnchor.constraint(greaterThanOrEqualToConstant: 450).isActive = true
        stack.addArrangedSubview(scrollView)

        statusLabel.textColor = .secondaryLabelColor
        statusLabel.font = .systemFont(ofSize: 12)
        stack.addArrangedSubview(statusLabel)

        let buttons = NSStackView()
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let refreshButton = NSButton(title: "Refresh", target: self, action: #selector(refresh))
        refreshButton.bezelStyle = .rounded
        let copyButton = NSButton(title: "Copy Report", target: self, action: #selector(copyReport))
        copyButton.bezelStyle = .rounded
        let exportButton = NSButton(title: "Export Report", target: self, action: #selector(exportReport))
        exportButton.bezelStyle = .rounded
        let closeButton = NSButton(title: "Close", target: self, action: #selector(closeWindow))
        closeButton.bezelStyle = .rounded
        buttons.addArrangedSubview(refreshButton)
        buttons.addArrangedSubview(copyButton)
        buttons.addArrangedSubview(exportButton)
        buttons.addArrangedSubview(closeButton)
        stack.addArrangedSubview(buttons)
    }

    @objc private func refresh() {
        textView.string = DiagnosticsReport.make()
        statusLabel.stringValue = "Refreshed"
    }

    @objc private func copyReport() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(textView.string, forType: .string)
        statusLabel.stringValue = "Copied report"
    }

    @objc private func exportReport() {
        do {
            let report = textView.string.isEmpty ? DiagnosticsReport.make() : textView.string
            let url = try DiagnosticsReport.export(report)
            statusLabel.stringValue = "Exported \(url.path)"
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } catch {
            statusLabel.stringValue = "Export failed: \(error.localizedDescription)"
            RunLog.write("diagnostics.export.failed", error.localizedDescription)
        }
    }

    @objc private func closeWindow() {
        window?.close()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let controller = DictationController()
    private var statusItem: NSStatusItem?
    private var hotKey: HotKey?
    private var correctionHotKey: HotKey?
    /// Step 1, PR 3: switches between the pill and the Desk.
    private var deskSwitchHotKey: HotKey?
    private var externalShortcutMonitor: Any?
    private let statusMenuItem = NSMenuItem(title: "Idle", action: nil, keyEquivalent: "")
    private let providerReadinessMenuItem = NSMenuItem(title: "Mode: Local Only (Apple On-Device) - Local only", action: nil, keyEquivalent: "")
    private let privacyHarvestMenuItem = NSMenuItem(title: "Harvest: Off | Audio: Not retained | Training: Review only", action: nil, keyEquivalent: "")
    private let lastDictationMenuItem = NSMenuItem(title: "Last dictation: none yet", action: nil, keyEquivalent: "")
    private let openAtLoginMenuItem = NSMenuItem(title: "Open at Login", action: nil, keyEquivalent: "")
    private var mainMenu: NSMenu?
    private var hotKeyTestDeadline: Date?
    private var latestInputLevel = 0.0
    private var providerMenuItems: [NSMenuItem] = []
    private var modelPresetMenuItems: [NSMenuItem] = []
    private var audioInputMenuItems: [NSMenuItem] = []
    private var wakeSensitivityMenuItems: [NSMenuItem] = []
    private var archiveMenuItems: [NSMenuItem] = []
    private var completionActionMenuItems: [NSMenuItem] = []
    private var hotKeyModeMenuItems: [NSMenuItem] = []
    private var hotKeyShortcutMenuItems: [NSMenuItem] = []
    private var pillBehaviorMenuItems: [NSMenuItem] = []
    private var insertionTimingMenuItems: [NSMenuItem] = []
    private var insertionModeMenuItems: [NSMenuItem] = []
    private var finalRewriteMenuItems: [NSMenuItem] = []
    private var autoStopMenuItem: NSMenuItem?
    private var livePasteMenuItem: NSMenuItem?
    private var livePreviewMenuItem: NSMenuItem?
    private var spokenPunctuationMenuItem: NSMenuItem?
    private var retainAudioMenuItem: NSMenuItem?
    private var correctionCaptureMenuItem: NSMenuItem?
    private var correctionOnceMenuItems: [NSMenuItem] = []
    private let personalCorrectionsSubmenu = NSMenu(title: "Saved Fixes")
    private var isComparingProviders = false
    private var workspaceActivationObserver: NSObjectProtocol?
    /// True Convo Test only: watches the running-app list for the real app.
    private var runningApplicationsObservation: NSKeyValueObservation?
    /// True Convo Test only: the bundle ids seen in the running-app list at
    /// the last check, so the real app is warned about once per start.
    private var lastRunningBundleIdentifiers: [String?] = []
    private var realAppWarningShowing = false
    private var cursorTargetLockedForDictation = false
    private var persistentPillActive = false
    private var hotKeySuppressedUntil = Date.distantPast
    // The Desk window (invented data only). Nothing is made until the Desk
    // is first opened from the menu; until then every Desk hook is inert.
    private lazy var deskBundle = DeskBundleLocation.current()
    private var deskSessionStorage: DeskSession?
    private var deskWindowController: DeskWindowController?
    private var deskLockSignals: DeskLockSignals?
    /// Set when the menu's Quit has asked the open Desk's page about unsaved
    /// work (and the person, when needed), so the termination that follows
    /// does not ask the page again.
    private var quitAskedAboutDesk = false
    private let deskMenuItem = NSMenuItem(title: "Desk (invented data)…", action: nil, keyEquivalent: "")
    private let lockDeskMenuItem = NSMenuItem(title: "Lock Desk", action: nil, keyEquivalent: "")
    private let switchDeskMenuItem = NSMenuItem(title: "Switch Desk and Pill (\(DeskSwitchPolicy.shortcutLabel))", action: nil, keyEquivalent: "")
    private static func deskRefusalMessage(_ refusal: DeskDictationPolicy.DeskRefusal) -> String {
        switch refusal {
        case .noDraftReady: return "Click into a Desk draft first, then dictate."
        case .locked: return "The Desk is locked. Unlock it to dictate into it."
        case .unavailable: return "The Desk isn't available, so nothing was recorded."
        case .correctionNotInDesk: return "Corrections aren't available in the Desk."
        }
    }
    // What the Desk shield held back since the current dictation (or typed
    // correction) began, and that dictation's own outcome once it came: the
    // pill never claims a paste, typing or Return the shield stopped.
    private var deskShieldHeldBack = Set<DeskDictationPolicy.ShieldedInput>()
    private var deskShieldDictationOutcome: DictationOutcome?
    private lazy var settingsWindow = SettingsWindowController { [weak self] in
        self?.refreshMenuState()
        self?.updateStatus("Settings saved")
        self?.prepareAppleSpeechAnalyzerIfPicked(Settings.provider)
    }
    private lazy var diagnosticsWindow = DiagnosticsWindowController()
    private lazy var scratchpadWindow = ScratchpadWindowController()
    private lazy var liveTranscriptWindow = LiveTranscriptWindowController()
    private lazy var liveTestGuideWindow = LiveTestGuideWindowController()
    private lazy var proofDashboardWindow = ProofDashboardWindowController(
        openStartHere: { [weak self] in self?.openStartHere() },
        openPhase2EvidenceReceipt: { [weak self] in self?.openPhase2EvidenceReceipt() },
        openCrossAppTargets: { [weak self] in self?.openCrossAppTargetCoverage() },
        openLiveProofSummary: { [weak self] in self?.openLiveProofSummary() },
        openLiveTestGuide: { [weak self] in self?.openLiveTestGuide() },
        openFirstRunChecklist: { [weak self] in self?.openFirstRunChecklist() },
        openScratchpad: { [weak self] in self?.openScratchpad() },
        openLiveTranscript: { [weak self] in self?.openLiveTranscript() },
        copyGuidedAcceptanceCommand: { [weak self] in self?.copyGuidedAcceptanceCommand() },
        recordProof: { [weak self] label in self?.recordLiveProof(label: label) }
    )
    private lazy var archiveHistoryWindow = ArchiveHistoryWindowController(isDictationBusy: { [weak self] in
        self?.controller.isBusy ?? false
    })
    private lazy var firstRunChecklistWindow = FirstRunChecklistWindowController(
        openDiagnostics: { [weak self] in self?.openDiagnostics() },
        openSettings: { [weak self] in self?.openSettings() },
        openScratchpad: { [weak self] in self?.openScratchpad() },
        openLiveTranscript: { [weak self] in self?.openLiveTranscript() },
        openLiveTestGuide: { [weak self] in self?.openLiveTestGuide() },
        openArchiveHistory: { [weak self] in self?.openArchiveHistory() },
        exportDiagnostics: { [weak self] in self?.exportDiagnostics() },
        openMicrophoneSettings: { [weak self] in self?.openMicrophoneSettings() },
        openSpeechRecognitionSettings: { [weak self] in self?.openSpeechRecognitionSettings() },
        openAccessibilitySettings: { [weak self] in self?.openAccessibilitySettings() },
        settingsChanged: { [weak self] in
            self?.refreshMenuState()
            self?.updateStatus("Settings applied")
        }
    )

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        Archive.sweepTemporaryAudio()
        RunLog.write("app.launch", BuildFingerprint.launchDetail())
        RunLog.write("permission.accessibility.status", "trusted=\(TextInjector.canAutoPaste)")
        rememberCursorTarget(NSWorkspace.shared.frontmostApplication)
        workspaceActivationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            self?.rememberCursorTarget(application)
        }
        buildMenu()
        controller.onStatus = { [weak self] text in
            DispatchQueue.main.async {
                self?.updateStatus(text)
                // Refresh state first so a finishing status lands on a pill that
                // is already in its processing state; otherwise the first
                // "Transcribing with …" line arrives one beat early and is dropped.
                self?.refreshDictationControls()
                self?.liveTranscriptWindow.updateStatus(text)
            }
        }
        controller.onTranscript = { [weak self] text in
            DispatchQueue.main.async {
                self?.liveTranscriptWindow.updateTranscript(text)
            }
        }
        controller.onOutcome = { [weak self] outcome in
            DispatchQueue.main.async {
                self?.showDictationOutcome(outcome)
            }
        }
        controller.onAudioLevel = { [weak self] level in
            DispatchQueue.main.async {
                self?.latestInputLevel = level
                if level <= 0 {
                    self?.liveTranscriptWindow.updateInputLevel(level)
                }
                self?.refreshStatusButtonTitle()
            }
        }
        controller.onAudioWaveform = { [weak self] samples, level in
            DispatchQueue.main.async {
                self?.latestInputLevel = level
                self?.liveTranscriptWindow.updateInputWaveform(samples, level: level)
                self?.refreshStatusButtonTitle()
            }
        }
        TextInjector.externalLivePreviewGuardHandler = { [weak self] reason in
            DispatchQueue.main.async {
                self?.stopDictationAfterExternalLivePreviewGuard(reason: reason)
            }
        }
        controller.onSessionStarted = { [weak self] provider in
            DispatchQueue.main.async {
                if Settings.pillBehavior == .persistent {
                    self?.persistentPillActive = true
                }
                self?.beginDeskShieldScope()
                self?.liveTranscriptWindow.reset(provider: provider)
                self?.refreshDictationControls()
            }
        }
        controller.onSessionFinished = { [weak self] in
            DispatchQueue.main.async {
                guard let self else { return }
                self.extendHotKeyCooldown(seconds: 0.35, reason: "session-finished")
                if Settings.pillBehavior == .persistent, self.persistentPillActive {
                    if TextInjector.hasPendingFinalReconcile {
                        self.liveTranscriptWindow.showProcessing()
                    } else {
                        self.liveTranscriptWindow.settleAfterOutcome(returnToReady: true)
                    }
                } else {
                    // Let any outcome badge finish its linger before the pill hides.
                    self.liveTranscriptWindow.settleAfterOutcome(returnToReady: false)
                }
                self.refreshDictationControls()
                self.unlockCursorTargetAfterPasteWindow()
            }
        }
        controller.onFinalizationFinished = { [weak self] in
            DispatchQueue.main.async {
                guard let self else { return }
                guard Settings.pillBehavior == .persistent, self.persistentPillActive else { return }
                guard !self.controller.isRecording, !self.controller.isBusy else { return }
                self.liveTranscriptWindow.settleAfterOutcome(returnToReady: true)
                self.controller.startIdleMonitor()
            }
        }
        controller.onIdleWakeDetected = { [weak self] in
            DispatchQueue.main.async {
                guard let self else { return }
                guard Settings.pillBehavior == .persistent, self.persistentPillActive else { return }
                guard !self.controller.isRecording, !self.controller.isBusy, !self.isHotKeySuppressed() else { return }
                RunLog.write("persistent-pill.wake-start")
                self.startDictation()
            }
        }
        hotKey = HotKey(
            id: 1,
            shortcut: Settings.hotKeyShortcut,
            onPressed: { [weak self] in
                DispatchQueue.main.async { self?.handleHotKeyPressed() }
            },
            onReleased: { [weak self] in
                DispatchQueue.main.async { self?.handleHotKeyReleased() }
            }
        )
        // Typed-correction hotkey: highlight wrong text anywhere — including
        // Claude, Codex, and VS Code, whose custom right-click menus never show
        // macOS Services — and the correction dialog appears.
        correctionHotKey = HotKey(
            id: 2,
            shortcut: .controlOptionCommandC,
            onPressed: { [weak self] in
                DispatchQueue.main.async {
                    self?.updateStatus("Release shortcut to capture selection")
                    RunLog.write("correction.hotkey.pressed")
                }
            },
            onReleased: { [weak self] in
                DispatchQueue.main.async { self?.correctSelectedTextAfterHotKeyRelease() }
            }
        )
        // Pill and Desk, both directions (step 1, PR 3): one shortcut, and a
        // Desk button on the pill. Only in a build with a Desk.
        if deskBundle != nil {
            deskSwitchHotKey = HotKey(
                id: 3,
                shortcut: .controlOptionCommandT,
                onPressed: { [weak self] in
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated { self?.toggleDeskAndPill() }
                    }
                },
                onReleased: {}
            )
            liveTranscriptWindow.onDeskButton = { [weak self] in
                MainActor.assumeIsolated { self?.showDeskFromPill() }
            }
        }
        // Right-click path for native apps (Notes, Mail, Safari, TextEdit):
        // "Correct With True Convo" in the Services menu.
        NSApp.servicesProvider = self
        NSUpdateDynamicServices()
        installExternalShortcutMonitor()
        installDeskHooks()
        if !Settings.hasShownFirstRunChecklist {
            Settings.hasShownFirstRunChecklist = true
            firstRunChecklistWindow.showWindow(nil)
        }
        // Apple On-Device (New) already chosen: load its model now so the
        // first dictation after launch doesn't wait for it. Never downloads.
        prepareAppleSpeechAnalyzerIfPicked(Settings.provider, onlyIfInstalled: true)
        watchForRealAppIfTestCopy()
    }

    // MARK: True Convo Test next to the real app

    /// True Convo Test only: warn when the real True Convo is running, at
    /// launch and whenever it starts later, because both answer the same
    /// dictation key. The warning only asks the owner to quit it from its own
    /// menu bar icon; nothing here ever quits, signals or changes the real
    /// app. The real app returns at once and never looks at other apps.
    ///
    /// "Starts later" watches `NSWorkspace.runningApplications` with
    /// key-value observing, as Apple recommends. The launch notification
    /// (`didLaunchApplicationNotification`) is not posted for menu-bar-only
    /// apps (`LSUIElement`), and the real app is one, so it would never fire.
    private func watchForRealAppIfTestCopy() {
        guard AppIdentity.current.isTest else { return }
        checkWhetherRealAppStarted(trigger: "launch")
        runningApplicationsObservation = NSWorkspace.shared.observe(\.runningApplications, options: []) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.checkWhetherRealAppStarted(trigger: "real-app-started")
            }
        }
    }

    /// Compares the running-app list with the last one seen and warns once
    /// when the real app has appeared in it. Reads bundle ids only.
    private func checkWhetherRealAppStarted(trigger: String) {
        let running = NSWorkspace.shared.runningApplications.map(\.bundleIdentifier)
        let started = AppIdentity.current.shouldWarnRealAppStarted(before: lastRunningBundleIdentifiers, after: running)
        lastRunningBundleIdentifiers = running
        guard started else { return }
        DispatchQueue.main.async { [weak self] in
            self?.showRealAppRunningWarning(trigger: trigger)
        }
    }

    private func showRealAppRunningWarning(trigger: String) {
        guard !realAppWarningShowing else { return }
        realAppWarningShowing = true
        defer { realAppWarningShowing = false }
        RunLog.write("test-copy.real-app-running.warned", "trigger=\(trigger)")
        let alert = NSAlert()
        alert.messageText = RealAppRunningWarning.title
        alert.informativeText = RealAppRunningWarning.message
        alert.alertStyle = .warning
        alert.addButton(withTitle: RealAppRunningWarning.okButton)
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let externalShortcutMonitor {
            NSEvent.removeMonitor(externalShortcutMonitor)
        }
        controller.shutdown()
        TextInjector.externalLivePreviewGuardHandler = nil
    }

    /// No Desk opened in this run: `.terminateNow`, exactly as before. With a
    /// Desk, it closes first (at most 3 s), then the app quits. Never a
    /// question, so a logout or restart is never held up; a page that holds
    /// unsaved work or cannot answer is only logged.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        onMainThread(.terminateNow) { DeskTermination.reply(for: deskSessionStorage, pageAlreadyAsked: quitAskedAboutDesk) }
    }


    private func installExternalShortcutMonitor() {
        externalShortcutMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]
        ) { [weak self] event in
            guard let self, self.controller.isBusy || TextInjector.hasPendingFinalReconcile else { return }
            DispatchQueue.main.async {
                self.handleInputOutsideDictationTarget(.globalEvent(event))
            }
        }
    }

    /// Input that may move the text cursor away from the dictation target: a
    /// key or click in another app (the global monitor), or the Desk window
    /// becoming key (the global monitor never sees our own windows).
    private enum OutsideInput {
        case globalEvent(NSEvent)
        case deskBecameKey
    }

    /// The global monitor's body, moved here unchanged so the Desk window can
    /// reuse it. The menu-bar exemption and key handling apply to global
    /// events only; the Desk becoming key takes the pointer path.
    private func handleInputOutsideDictationTarget(_ source: OutsideInput) {
        if controller.isDeskRecording {
            // A Desk recording types nothing anywhere, so input elsewhere can
            // never collide with it. Only the dictation key's global fallback
            // (stopping it) still applies.
            if case .globalEvent(let event) = source, event.type == .keyDown,
               Settings.hotKeyShortcut.matches(keyCode: event.keyCode,
                                               modifiers: event.modifierFlags.intersection(.deviceIndependentFlagsMask)) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
                    guard let self, self.controller.isRecording else { return }
                    RunLog.write("hotkey.fallback-global.stop", "shortcut=\(Settings.hotKeyShortcut.label) route=desk")
                    self.stopDictation()
                    self.refreshDictationControls()
                }
            }
            return
        }
        guard case .globalEvent(let event) = source else {
            if !self.controller.isRecording {
                if TextInjector.cancelPendingFinalReconcileForExternalInput(reason: "post-stop-external-pointer") {
                    self.updateStatus("Final transcript saved")
                }
                return
            }
            let guarded = TextInjector.guardLivePreviewForExternalPointer(eventType: "desk-became-key")
            if guarded {
                self.liveTranscriptWindow.showGuarded()
            } else if let reason = TextInjector.guardFinalPasteForExternalPointer(eventType: "desk-became-key") {
                self.liveTranscriptWindow.showGuarded()
                self.stopDictationAfterExternalLivePreviewGuard(reason: reason)
            }
            return
        }
        if event.type == .keyDown {
            TextInjector.noteExternalKeyDownForClipboard(
                characters: event.charactersIgnoringModifiers,
                modifiers: event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            )
        }
        if !self.controller.isRecording {
            let reason: String
            switch event.type {
            case .keyDown:
                reason = "post-stop-external-key"
            case .leftMouseDown, .rightMouseDown, .otherMouseDown:
                reason = "post-stop-external-pointer"
            default:
                reason = "post-stop-external-input"
            }
            if TextInjector.cancelPendingFinalReconcileForExternalInput(reason: reason) {
                self.updateStatus("Final transcript saved")
            }
            return
        }
        switch event.type {
        case .keyDown:
            let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if Settings.hotKeyShortcut.matches(keyCode: event.keyCode, modifiers: modifiers) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
                    guard let self, self.controller.isRecording else { return }
                    RunLog.write("hotkey.fallback-global.stop", "shortcut=\(Settings.hotKeyShortcut.label)")
                    self.stopDictation()
                    self.refreshDictationControls()
                }
                return
            }
            let guarded = TextInjector.guardLivePreviewForExternalShortcut(
                keyCode: event.keyCode,
                modifiers: modifiers
            )
            if guarded {
                self.liveTranscriptWindow.showGuarded()
            } else if let reason = TextInjector.guardFinalPasteForExternalShortcut(
                keyCode: event.keyCode,
                modifiers: modifiers
            ) {
                self.liveTranscriptWindow.showGuarded()
                self.stopDictationAfterExternalLivePreviewGuard(reason: reason)
            }
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            // A click in the menu bar (our own icon, the macOS mic
            // indicator, any status item) can never move the text
            // cursor in the target app, so it must not suppress the
            // paste. The owner hit exactly this: clicking the system
            // mic indicator to stop cost him his transcript.
            if Self.isMenuBarClick(NSEvent.mouseLocation) {
                RunLog.write("external-pointer.ignored", "reason=menu-bar-click")
                return
            }
            let guarded = TextInjector.guardLivePreviewForExternalPointer(eventType: String(describing: event.type))
            if guarded {
                self.liveTranscriptWindow.showGuarded()
            } else if let reason = TextInjector.guardFinalPasteForExternalPointer(eventType: String(describing: event.type)) {
                self.liveTranscriptWindow.showGuarded()
                self.stopDictationAfterExternalLivePreviewGuard(reason: reason)
            }
        default:
            break
        }
    }

    /// True when a global click landed in the menu-bar strip of whichever
    /// screen it happened on. visibleFrame excludes the menu bar, so anything
    /// above its top edge is the strip.
    private static func isMenuBarClick(_ location: NSPoint) -> Bool {
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(location, $0.frame, false) }) else {
            return false
        }
        return location.y >= screen.visibleFrame.maxY
    }

    private func buildMenu() {
        // True Convo Test's icon carries the word "Test", so it needs the room.
        let item = NSStatusBar.system.statusItem(
            withLength: AppIdentity.current.isTest ? NSStatusItem.variableLength : NSStatusItem.squareLength
        )
        configureStatusItemButton(item.button)

        let menu = NSMenu()
        menu.delegate = self
        mainMenu = menu
        if AppIdentity.current.isTest {
            let testHeader = NSMenuItem(title: "True Convo Test (test copy)", action: nil, keyEquivalent: "")
            testHeader.isEnabled = false
            testHeader.toolTip = "This is the test copy. It keeps its own settings, keys, archive (~/.tca-dictate-test) and Desk folder, and never changes your real True Convo."
            menu.addItem(testHeader)
        }
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        lastDictationMenuItem.isEnabled = false
        lastDictationMenuItem.toolTip = "When True Convo last saved a dictation. If this gets old, check that True Convo is running and the dictation key works."
        menu.addItem(lastDictationMenuItem)
        let copyLastDictationItem = NSMenuItem(title: "Copy Last Dictation", action: #selector(copyLastDictation), keyEquivalent: "")
        copyLastDictationItem.target = self
        copyLastDictationItem.toolTip = "Put your last finished dictation on the clipboard, for example after a safety stop left your clipboard alone."
        menu.addItem(copyLastDictationItem)
        deskMenuItem.target = self
        deskMenuItem.toolTip = "Open the Desk window. It holds made-up data only and starts locked; unlocking asks for your Mac password or Touch ID."
        menu.addItem(deskMenuItem)
        lockDeskMenuItem.target = self
        lockDeskMenuItem.toolTip = "Hide the Desk at once. Unlocking asks for your Mac password or Touch ID again."
        menu.addItem(lockDeskMenuItem)
        switchDeskMenuItem.target = self
        switchDeskMenuItem.toolTip = "Shrink the Desk to the pill, or bring it back where you left it."
        menu.addItem(switchDeskMenuItem)
        refreshDeskMenuItems()
        providerReadinessMenuItem.isEnabled = false
        menu.addItem(providerReadinessMenuItem)
        privacyHarvestMenuItem.isEnabled = false
        privacyHarvestMenuItem.toolTip = "Current privacy and Convo Engine Harvest state. Cloud sessions are not private training material unless explicitly reviewed and approved."
        menu.addItem(privacyHarvestMenuItem)
        menu.addItem(NSMenuItem.separator())

        let toggleItem = NSMenuItem(title: "Toggle Dictation", action: #selector(toggle), keyEquivalent: "d")
        toggleItem.target = self
        toggleItem.toolTip = "Start or stop dictation with the current shortcut."
        menu.addItem(toggleItem)

        let testKeyItem = NSMenuItem(title: "Test Dictation Key…", action: #selector(testDictationKey), keyEquivalent: "")
        testKeyItem.target = self
        testKeyItem.toolTip = "Checks that your dictation shortcut reaches True Convo. Press it within 10 seconds after choosing this."
        menu.addItem(testKeyItem)
        openAtLoginMenuItem.action = #selector(toggleOpenAtLogin)
        openAtLoginMenuItem.target = self
        openAtLoginMenuItem.toolTip = "Start True Convo automatically when you log in, so dictation is always ready. Off until you turn it on."
        // True Convo Test never offers to start at login.
        if AppIdentity.current.mayRegisterLoginItem {
            menu.addItem(openAtLoginMenuItem)
        }

        let correctionOnceTopItem = NSMenuItem(title: "Correct Selected Text Once", action: #selector(correctSelectedTextOnce), keyEquivalent: "")
        correctionOnceTopItem.target = self
        correctionOnceTopItem.toolTip = "Highlight a wrong word or phrase, choose this, then speak the replacement once."
        correctionOnceMenuItems.append(correctionOnceTopItem)
        menu.addItem(correctionOnceTopItem)
        let typedCorrectionTopItem = NSMenuItem(title: "Correct Selected Text by Typing…", action: #selector(correctSelectedTextByTyping), keyEquivalent: "")
        typedCorrectionTopItem.target = self
        typedCorrectionTopItem.toolTip = "Highlight wrong text, then type the fix. Works when the wrong and right words sound identical — the pair is saved so Convo Engine can learn. Shortcut: Control+Option+Cmd+C from any app."
        correctionOnceMenuItems.append(typedCorrectionTopItem)
        menu.addItem(typedCorrectionTopItem)
        let personalCorrectionsTopItem = NSMenuItem(title: "Saved Fixes", action: nil, keyEquivalent: "")
        personalCorrectionsSubmenu.delegate = self
        personalCorrectionsTopItem.submenu = personalCorrectionsSubmenu
        personalCorrectionsTopItem.toolTip = "Words you have taught True Convo to fix in every app. Click one to forget it."
        menu.addItem(personalCorrectionsTopItem)
        menu.addItem(NSMenuItem.separator())

        let expertToolsItem = NSMenuItem(title: "Expert Tools", action: nil, keyEquivalent: "")
        expertToolsItem.toolTip = "Advanced archive, proof, diagnostics, insertion, and Convo Engine tools."
        let expertMenu = NSMenu()
        let expertInsertionItem = NSMenuItem(title: "Insertion & Models", action: nil, keyEquivalent: "")
        expertInsertionItem.toolTip = "Advanced text insertion, provider, model, and correction settings."
        let expertInsertionMenu = NSMenu()
        let expertArchiveItem = NSMenuItem(title: "Archive & Harvest", action: nil, keyEquivalent: "")
        expertArchiveItem.toolTip = "Recorded audio, transcripts, content packets, harvest bundles, and reprocessing tools."
        let expertArchiveMenu = NSMenu()
        let expertWindowsItem = NSMenuItem(title: "Windows", action: nil, keyEquivalent: "")
        expertWindowsItem.toolTip = "Optional utility windows used while testing or reviewing dictation."
        let expertWindowsMenu = NSMenu()
        let expertProofItem = NSMenuItem(title: "Proof & Diagnostics", action: nil, keyEquivalent: "")
        expertProofItem.toolTip = "Local test guides, proof recorders, logs, and diagnostic reports."
        let expertProofMenu = NSMenu()

        let hotKeyModeItem = NSMenuItem(title: "Shortcut Mode", action: nil, keyEquivalent: "")
        hotKeyModeItem.toolTip = "Choose whether the shortcut toggles dictation or records only while held."
        let hotKeyModeMenu = NSMenu()
        hotKeyModeMenuItems = HotKeyMode.allCases.map { mode in
            let item = NSMenuItem(title: mode.label, action: #selector(selectHotKeyMode(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = mode.rawValue
            hotKeyModeMenu.addItem(item)
            return item
        }
        hotKeyModeItem.submenu = hotKeyModeMenu
        menu.addItem(hotKeyModeItem)

        let hotKeyShortcutItem = NSMenuItem(title: "Shortcut Key", action: nil, keyEquivalent: "")
        hotKeyShortcutItem.toolTip = "Choose the global shortcut that starts and stops True Convo."
        let hotKeyShortcutMenu = NSMenu()
        hotKeyShortcutMenuItems = HotKeyShortcut.allCases.filter { !HotKeyShortcut.reserved.contains($0) }.map { shortcut in
            let item = NSMenuItem(title: shortcut.label, action: #selector(selectHotKeyShortcut(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = shortcut.rawValue
            hotKeyShortcutMenu.addItem(item)
            return item
        }
        hotKeyShortcutItem.submenu = hotKeyShortcutMenu
        menu.addItem(hotKeyShortcutItem)

        let pillBehaviorItem = NSMenuItem(title: "Pill Behavior", action: nil, keyEquivalent: "")
        pillBehaviorItem.toolTip = "Choose whether the dictation pill hides after each dictation or stays ready until the shortcut hides it."
        let pillBehaviorMenu = NSMenu()
        pillBehaviorMenuItems = PillBehavior.allCases.map { behavior in
            let item = NSMenuItem(title: behavior.label, action: #selector(selectPillBehavior(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = behavior.rawValue
            pillBehaviorMenu.addItem(item)
            return item
        }
        pillBehaviorItem.submenu = pillBehaviorMenu
        menu.addItem(pillBehaviorItem)

        let insertionTimingItem = NSMenuItem(title: "Insertion Timing", action: nil, keyEquivalent: "")
        insertionTimingItem.toolTip = "Tune how quickly True Convo types or pastes into the target app."
        let insertionTimingMenu = NSMenu()
        insertionTimingMenuItems = InsertionTiming.allCases.map { timing in
            let item = NSMenuItem(title: timing.label, action: #selector(selectInsertionTiming(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = timing.rawValue
            insertionTimingMenu.addItem(item)
            return item
        }
        insertionTimingItem.submenu = insertionTimingMenu
        expertInsertionMenu.addItem(insertionTimingItem)

        let finalRewriteItem = NSMenuItem(title: "Final Cleanup", action: nil, keyEquivalent: "")
        finalRewriteItem.toolTip = "Choose whether final transcription is allowed to rewrite already typed live text."
        let finalRewriteMenu = NSMenu()
        finalRewriteMenuItems = FinalRewriteMode.allCases.map { mode in
            let item = NSMenuItem(title: mode.label, action: #selector(selectFinalRewriteMode(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = mode.rawValue
            finalRewriteMenu.addItem(item)
            return item
        }
        finalRewriteItem.submenu = finalRewriteMenu
        expertInsertionMenu.addItem(finalRewriteItem)

        let correctionsItem = NSMenuItem(title: "Corrections & Convo Engine", action: nil, keyEquivalent: "")
        correctionsItem.toolTip = "Capture selected-word corrections for later Convo Engine review."
        let correctionsMenu = NSMenu()

        let correctionOnceItem = NSMenuItem(title: "Correct Selected Text Once", action: #selector(correctSelectedTextOnce), keyEquivalent: "")
        correctionOnceItem.target = self
        correctionOnceItem.toolTip = "Highlight a wrong word or phrase, choose this, then speak the replacement once."
        correctionOnceMenuItems.append(correctionOnceItem)
        correctionsMenu.addItem(correctionOnceItem)
        let typedCorrectionItem = NSMenuItem(title: "Correct Selected Text by Typing…", action: #selector(correctSelectedTextByTyping), keyEquivalent: "")
        typedCorrectionItem.target = self
        typedCorrectionItem.toolTip = "Highlight wrong text, then type the fix. Works when the wrong and right words sound identical — the pair is saved so Convo Engine can learn. Shortcut: Control+Option+Cmd+C from any app."
        correctionOnceMenuItems.append(typedCorrectionItem)
        correctionsMenu.addItem(typedCorrectionItem)

        correctionsMenu.addItem(NSMenuItem.separator())

        let correctionCaptureItem = NSMenuItem(title: "Convo Engine Harvest Capture", action: #selector(toggleCorrectionCapture), keyEquivalent: "")
        correctionCaptureItem.target = self
        correctionCaptureItem.toolTip = "Off by default. When enabled, selected text can become local Convo Engine correction-review evidence; it is not automatic training."
        correctionCaptureMenuItem = correctionCaptureItem
        correctionsMenu.addItem(correctionCaptureItem)

        let correctionInboxMainItem = NSMenuItem(title: "Open Correction Inbox", action: #selector(openCorrectionInbox), keyEquivalent: "")
        correctionInboxMainItem.target = self
        correctionInboxMainItem.toolTip = "Open the local list of captured correction examples."
        correctionsMenu.addItem(correctionInboxMainItem)

        let recordCorrectionProofMainItem = NSMenuItem(title: "Record Correction Proof From Latest Session", action: #selector(recordCorrectionProof), keyEquivalent: "")
        recordCorrectionProofMainItem.target = self
        recordCorrectionProofMainItem.toolTip = "Mark the latest session as proof that correction capture worked."
        correctionsMenu.addItem(recordCorrectionProofMainItem)

        correctionsItem.submenu = correctionsMenu
        expertInsertionMenu.addItem(correctionsItem)

        let providerItem = NSMenuItem(title: "Provider", action: nil, keyEquivalent: "")
        providerItem.toolTip = "Choose Local Only, OpenAI Realtime, or another speech-to-text provider."
        let providerMenu = NSMenu()
        providerMenuItems = DictationProvider.selectableCases.map { provider in
            let item = NSMenuItem(title: "\(provider.label) (\(provider.privacyLabel))", action: #selector(selectProvider(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = provider.rawValue
            providerMenu.addItem(item)
            return item
        }
        providerItem.submenu = providerMenu
        expertInsertionMenu.addItem(providerItem)

        let modelPresetItem = NSMenuItem(title: "Provider/Model Preset", action: nil, keyEquivalent: "")
        modelPresetItem.toolTip = "Choose Local Only or a cloud/local model preset."
        let modelPresetMenu = NSMenu()
        modelPresetMenuItems = ModelPreset.selectable.map { preset in
            let item = NSMenuItem(title: preset.label, action: #selector(selectModelPreset(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = preset.id
            modelPresetMenu.addItem(item)
            return item
        }
        modelPresetItem.submenu = modelPresetMenu
        menu.addItem(modelPresetItem)

        let audioInputItem = NSMenuItem(title: "Microphone Input", action: nil, keyEquivalent: "")
        audioInputItem.toolTip = "Choose which microphone True Convo records."
        let audioInputMenu = NSMenu()
        var audioInputItems: [NSMenuItem] = []
        let systemDefaultInputItem = NSMenuItem(title: AudioDeviceInfo.selectedInputLabel(), action: #selector(selectAudioInput(_:)), keyEquivalent: "")
        systemDefaultInputItem.target = self
        systemDefaultInputItem.representedObject = AudioDeviceInfo.systemDefaultUID
        audioInputMenu.addItem(systemDefaultInputItem)
        audioInputItems.append(systemDefaultInputItem)
        audioInputMenu.addItem(NSMenuItem.separator())
        if AppIdentity.current.mayChangeSystemDefaultInput {
            for device in AudioDeviceInfo.inputDevices() {
                let item = NSMenuItem(title: device.name, action: #selector(selectAudioInput(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = device.uid
                audioInputMenu.addItem(item)
                audioInputItems.append(item)
            }
        } else {
            // Picking an input here would change the Mac's default microphone
            // for every app, so the test copy only shows what the Mac uses.
            let note = NSMenuItem(title: "True Convo Test uses the Mac's current input", action: nil, keyEquivalent: "")
            note.isEnabled = false
            note.toolTip = "To use another microphone, choose it in System Settings > Sound > Input. True Convo Test never changes it."
            audioInputMenu.addItem(note)
        }
        audioInputMenuItems = audioInputItems
        audioInputItem.submenu = audioInputMenu
        menu.addItem(audioInputItem)

        let wakeSensitivityItem = NSMenuItem(title: "Wake Sensitivity", action: nil, keyEquivalent: "")
        wakeSensitivityItem.toolTip = "Tune how easily the persistent pill starts a new dictation when your voice returns."
        let wakeSensitivityMenu = NSMenu()
        wakeSensitivityMenuItems = WakeSensitivity.allCases.map { sensitivity in
            let item = NSMenuItem(title: sensitivity.label, action: #selector(selectWakeSensitivity(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = sensitivity.rawValue
            wakeSensitivityMenu.addItem(item)
            return item
        }
        wakeSensitivityItem.submenu = wakeSensitivityMenu
        menu.addItem(wakeSensitivityItem)

        let retainAudioItem = NSMenuItem(title: "Retain Audio for Harvest", action: #selector(toggleRetainAudioForHarvest), keyEquivalent: "")
        retainAudioItem.target = self
        retainAudioItem.toolTip = "Off by default. Keep raw recordings only when you explicitly want local Harvest or reprocess evidence."
        retainAudioMenuItem = retainAudioItem
        expertArchiveMenu.addItem(retainAudioItem)

        let archiveItem = NSMenuItem(title: "Archive Format", action: nil, keyEquivalent: "")
        archiveItem.toolTip = "Choose how retained audio recordings are saved."
        let archiveMenu = NSMenu()
        archiveMenuItems = ArchiveFormat.allCases.map { format in
            let item = NSMenuItem(title: format.label, action: #selector(selectArchiveFormat(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = format.rawValue
            archiveMenu.addItem(item)
            return item
        }
        archiveItem.submenu = archiveMenu
        expertArchiveMenu.addItem(archiveItem)

        let completionActionItem = NSMenuItem(title: "After Dictation", action: nil, keyEquivalent: "")
        completionActionItem.toolTip = "Choose what True Convo does with text after dictation stops."
        let completionActionMenu = NSMenu()
        completionActionMenuItems = CompletionAction.allCases.map { action in
            let item = NSMenuItem(title: action.label, action: #selector(selectCompletionAction(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = action.rawValue
            completionActionMenu.addItem(item)
            return item
        }
        completionActionItem.submenu = completionActionMenu
        menu.addItem(completionActionItem)

        let autoStopItem = NSMenuItem(title: "Auto-stop After Pause", action: #selector(toggleAutoStop), keyEquivalent: "")
        autoStopItem.target = self
        autoStopItem.toolTip = "Stop automatically after silence. Increase pause delay if normal sentence breaks stop too early."
        autoStopMenuItem = autoStopItem
        menu.addItem(autoStopItem)

        let livePasteItem = NSMenuItem(title: "Live Paste Apple Finals", action: #selector(toggleLivePaste), keyEquivalent: "")
        livePasteItem.target = self
        livePasteItem.toolTip = "Paste Apple final chunks while recording instead of waiting for stop."
        livePasteMenuItem = livePasteItem
        expertInsertionMenu.addItem(livePasteItem)

        let livePreviewItem = NSMenuItem(title: "Live Cursor Preview", action: #selector(toggleLivePreview), keyEquivalent: "")
        livePreviewItem.target = self
        livePreviewItem.toolTip = "Type live partial text at the clicked cursor while the pill is visible."
        livePreviewMenuItem = livePreviewItem
        expertInsertionMenu.addItem(livePreviewItem)

        let spokenPunctuationItem = NSMenuItem(title: "Spoken Punctuation Commands", action: #selector(toggleSpokenPunctuation), keyEquivalent: "")
        spokenPunctuationItem.target = self
        spokenPunctuationItem.toolTip = "Convert spoken words like comma, period, and question mark into punctuation symbols."
        spokenPunctuationMenuItem = spokenPunctuationItem
        expertInsertionMenu.addItem(spokenPunctuationItem)

        let insertionModeItem = NSMenuItem(title: "Insertion Mode", action: nil, keyEquivalent: "")
        insertionModeItem.toolTip = "Choose how True Convo inserts text into the target app."
        let insertionModeMenu = NSMenu()
        insertionModeMenuItems = InsertionMode.allCases.map { mode in
            let item = NSMenuItem(title: mode.label, action: #selector(selectInsertionMode(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = mode.rawValue
            insertionModeMenu.addItem(item)
            return item
        }
        insertionModeItem.submenu = insertionModeMenu
        expertInsertionMenu.addItem(insertionModeItem)

        let appCompatibilityItem = NSMenuItem(title: "Open App Compatibility Report", action: #selector(openAppCompatibilityReport), keyEquivalent: "")
        appCompatibilityItem.target = self
        appCompatibilityItem.toolTip = "Show why different apps use different insertion strategies."
        expertInsertionMenu.addItem(appCompatibilityItem)

        let openArchiveItem = NSMenuItem(title: "Open Archive", action: #selector(openArchive), keyEquivalent: "o")
        openArchiveItem.target = self
        expertArchiveMenu.addItem(openArchiveItem)

        let archiveHistoryItem = NSMenuItem(title: "Archive History...", action: #selector(openArchiveHistory), keyEquivalent: "h")
        archiveHistoryItem.target = self
        expertArchiveMenu.addItem(archiveHistoryItem)

        let openTranscriptsItem = NSMenuItem(title: "Open Transcripts", action: #selector(openTranscripts), keyEquivalent: "t")
        openTranscriptsItem.target = self
        expertArchiveMenu.addItem(openTranscriptsItem)

        let latestTranscriptItem = NSMenuItem(title: "Open Latest Transcript", action: #selector(openLatestTranscript), keyEquivalent: "")
        latestTranscriptItem.target = self
        expertArchiveMenu.addItem(latestTranscriptItem)

        let copyLatestTranscriptItem = NSMenuItem(title: "Copy Latest Transcript", action: #selector(copyLatestTranscript), keyEquivalent: "")
        copyLatestTranscriptItem.target = self
        expertArchiveMenu.addItem(copyLatestTranscriptItem)

        let latestPacketItem = NSMenuItem(title: "Open Latest Content Packet", action: #selector(openLatestContentPacket), keyEquivalent: "")
        latestPacketItem.target = self
        expertArchiveMenu.addItem(latestPacketItem)

        let copyLatestPacketItem = NSMenuItem(title: "Copy Latest Content Packet", action: #selector(copyLatestContentPacket), keyEquivalent: "")
        copyLatestPacketItem.target = self
        expertArchiveMenu.addItem(copyLatestPacketItem)

        let harvestInboxItem = NSMenuItem(title: "Open Harvest Inbox", action: #selector(openHarvestInbox), keyEquivalent: "")
        harvestInboxItem.target = self
        expertArchiveMenu.addItem(harvestInboxItem)

        let harvestBundleItem = NSMenuItem(title: "Open Recent Harvest Bundle", action: #selector(openHarvestBundle), keyEquivalent: "")
        harvestBundleItem.target = self
        expertArchiveMenu.addItem(harvestBundleItem)

        let copyHarvestBundleItem = NSMenuItem(title: "Copy Recent Harvest Bundle", action: #selector(copyHarvestBundle), keyEquivalent: "")
        copyHarvestBundleItem.target = self
        expertArchiveMenu.addItem(copyHarvestBundleItem)

        let timingReportItem = NSMenuItem(title: "Open Timing Report", action: #selector(openTimingReport), keyEquivalent: "")
        timingReportItem.target = self
        expertArchiveMenu.addItem(timingReportItem)

        let revealLatestAudioItem = NSMenuItem(title: "Reveal Latest Audio", action: #selector(revealLatestAudio), keyEquivalent: "")
        revealLatestAudioItem.target = self
        expertArchiveMenu.addItem(revealLatestAudioItem)

        let reprocessLatestAudioItem = NSMenuItem(title: "Reprocess Latest Audio With Selected Provider", action: #selector(reprocessLatestAudio), keyEquivalent: "")
        reprocessLatestAudioItem.target = self
        expertArchiveMenu.addItem(reprocessLatestAudioItem)

        let compareLatestAudioItem = NSMenuItem(title: "Compare Latest Audio Across Ready Provider Presets", action: #selector(compareLatestAudioProviders), keyEquivalent: "")
        compareLatestAudioItem.target = self
        expertArchiveMenu.addItem(compareLatestAudioItem)

        let latestComparisonItem = NSMenuItem(title: "Open Latest Provider Comparison", action: #selector(openLatestProviderComparison), keyEquivalent: "")
        latestComparisonItem.target = self
        expertArchiveMenu.addItem(latestComparisonItem)

        let openRunLogItem = NSMenuItem(title: "Open Run Log", action: #selector(openRunLog), keyEquivalent: "")
        openRunLogItem.target = self
        expertProofMenu.addItem(openRunLogItem)

        let scratchpadItem = NSMenuItem(title: "Scratchpad...", action: #selector(openScratchpad), keyEquivalent: "s")
        scratchpadItem.target = self
        expertWindowsMenu.addItem(scratchpadItem)

        let liveTranscriptItem = NSMenuItem(title: "Cursor Widget...", action: #selector(openLiveTranscript), keyEquivalent: "l")
        liveTranscriptItem.target = self
        expertWindowsMenu.addItem(liveTranscriptItem)

        let liveTestGuideItem = NSMenuItem(title: "Live Test Guide...", action: #selector(openLiveTestGuide), keyEquivalent: "")
        liveTestGuideItem.target = self
        expertProofMenu.addItem(liveTestGuideItem)

        let guidedAcceptanceCommandItem = NSMenuItem(title: "Copy Guided Acceptance Command", action: #selector(copyGuidedAcceptanceCommand), keyEquivalent: "")
        guidedAcceptanceCommandItem.target = self
        guidedAcceptanceCommandItem.toolTip = "Copy the Terminal command that walks through the Phase 2 live proof sequence."
        expertProofMenu.addItem(guidedAcceptanceCommandItem)

        let proofDashboardItem = NSMenuItem(title: "Proof Dashboard...", action: #selector(openProofDashboard), keyEquivalent: "")
        proofDashboardItem.target = self
        expertProofMenu.addItem(proofDashboardItem)

        let startHereItem = NSMenuItem(title: "Open Start Here", action: #selector(openStartHere), keyEquivalent: "")
        startHereItem.target = self
        expertProofMenu.addItem(startHereItem)

        let phase2EvidenceReceiptItem = NSMenuItem(title: "Open Phase 2 Evidence Receipt", action: #selector(openPhase2EvidenceReceipt), keyEquivalent: "")
        phase2EvidenceReceiptItem.target = self
        phase2EvidenceReceiptItem.toolTip = "Open a local metadata receipt for the Phase 2 proof gates, privacy state, and Harvest boundary."
        expertProofMenu.addItem(phase2EvidenceReceiptItem)

        let crossAppTargetItem = NSMenuItem(title: "Open Cross-App Target Coverage", action: #selector(openCrossAppTargetCoverage), keyEquivalent: "")
        crossAppTargetItem.target = self
        crossAppTargetItem.toolTip = "Show which named smoke-test apps have archived target metadata."
        expertProofMenu.addItem(crossAppTargetItem)

        let hermesAcceptanceItem = NSMenuItem(title: "Open Hermes Acceptance", action: #selector(openHermesAcceptance), keyEquivalent: "")
        hermesAcceptanceItem.target = self
        expertProofMenu.addItem(hermesAcceptanceItem)

        let hermesSettingsItem = NSMenuItem(title: "Use Hermes Recommended Settings", action: #selector(useHermesRecommendedSettings), keyEquivalent: "")
        hermesSettingsItem.target = self
        hermesSettingsItem.toolTip = "Apply the baseline dictation setup: Local Whisper, final paste, one-shot pill, auto-stop off, and Convo Engine harvest off. Keep your audio-retention choice."
        expertProofMenu.addItem(hermesSettingsItem)

        let recordSafeProofItem = NSMenuItem(title: "Record Safe Proof From Latest Session", action: #selector(recordSafeProof), keyEquivalent: "")
        recordSafeProofItem.target = self
        expertProofMenu.addItem(recordSafeProofItem)

        let recordPasteProofItem = NSMenuItem(title: "Record Paste Proof From Latest Session", action: #selector(recordPasteProof), keyEquivalent: "")
        recordPasteProofItem.target = self
        expertProofMenu.addItem(recordPasteProofItem)

        let recordReprocessProofItem = NSMenuItem(title: "Record Reprocess Proof From Latest Session", action: #selector(recordReprocessProof), keyEquivalent: "")
        recordReprocessProofItem.target = self
        expertProofMenu.addItem(recordReprocessProofItem)

        let recordLivePasteProofItem = NSMenuItem(title: "Record Live Paste Proof From Latest Session", action: #selector(recordLivePasteProof), keyEquivalent: "")
        recordLivePasteProofItem.target = self
        expertProofMenu.addItem(recordLivePasteProofItem)

        let recordRealtimeTargetProofItem = NSMenuItem(title: "Record OpenAI Realtime Target Proof", action: #selector(recordRealtimeTargetProof), keyEquivalent: "")
        recordRealtimeTargetProofItem.target = self
        expertProofMenu.addItem(recordRealtimeTargetProofItem)

        let liveProofSummaryItem = NSMenuItem(title: "Open Live Proof Summary", action: #selector(openLiveProofSummary), keyEquivalent: "")
        liveProofSummaryItem.target = self
        expertProofMenu.addItem(liveProofSummaryItem)

        let settingsItem = NSMenuItem(title: "Settings...", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        settingsItem.toolTip = "Open the full settings window for models, timing, audio, and provider keys."
        menu.addItem(settingsItem)

        let firstRunItem = NSMenuItem(title: "First Run Checklist...", action: #selector(openFirstRunChecklist), keyEquivalent: "?")
        firstRunItem.target = self
        expertProofMenu.addItem(firstRunItem)

        let diagnosticsItem = NSMenuItem(title: "Diagnostics...", action: #selector(openDiagnostics), keyEquivalent: "")
        diagnosticsItem.target = self
        expertProofMenu.addItem(diagnosticsItem)

        let exportDiagnosticsItem = NSMenuItem(title: "Export Diagnostics", action: #selector(exportDiagnostics), keyEquivalent: "")
        exportDiagnosticsItem.target = self
        expertProofMenu.addItem(exportDiagnosticsItem)

        let latestDiagnosticsItem = NSMenuItem(title: "Open Latest Diagnostics", action: #selector(openLatestDiagnostics), keyEquivalent: "")
        latestDiagnosticsItem.target = self
        expertProofMenu.addItem(latestDiagnosticsItem)

        let permissionsItem = NSMenuItem(title: "Permission Settings", action: nil, keyEquivalent: "")
        permissionsItem.toolTip = "Open macOS privacy settings needed for microphone, speech, and text insertion."
        let permissionsMenu = NSMenu()
        let microphoneItem = NSMenuItem(title: "Open Microphone Settings", action: #selector(openMicrophoneSettings), keyEquivalent: "")
        microphoneItem.target = self
        microphoneItem.toolTip = "Grant or review microphone access for True Convo."
        permissionsMenu.addItem(microphoneItem)

        let speechItem = NSMenuItem(title: "Open Speech Recognition Settings", action: #selector(openSpeechRecognitionSettings), keyEquivalent: "")
        speechItem.target = self
        speechItem.toolTip = "Grant or review Apple Speech Recognition access."
        permissionsMenu.addItem(speechItem)

        let accessibilityItem = NSMenuItem(title: "Open Accessibility Settings", action: #selector(openAccessibilitySettings), keyEquivalent: "")
        accessibilityItem.target = self
        accessibilityItem.toolTip = "Grant or review Accessibility access for auto-insertion."
        permissionsMenu.addItem(accessibilityItem)

        let revealAppItem = NSMenuItem(title: "Reveal This App", action: #selector(revealCurrentAppForPermissions), keyEquivalent: "")
        revealAppItem.target = self
        revealAppItem.toolTip = "Reveal the exact app bundle macOS permissions should point to."
        permissionsMenu.addItem(revealAppItem)

        let copyAppPathItem = NSMenuItem(title: "Copy This App Path", action: #selector(copyCurrentAppPath), keyEquivalent: "")
        copyAppPathItem.target = self
        copyAppPathItem.toolTip = "Copy the installed app path for permission troubleshooting."
        permissionsMenu.addItem(copyAppPathItem)
        permissionsItem.submenu = permissionsMenu
        menu.addItem(permissionsItem)

        menu.addItem(NSMenuItem.separator())
        expertInsertionItem.submenu = expertInsertionMenu
        expertMenu.addItem(expertInsertionItem)
        expertArchiveItem.submenu = expertArchiveMenu
        expertMenu.addItem(expertArchiveItem)
        expertWindowsItem.submenu = expertWindowsMenu
        expertMenu.addItem(expertWindowsItem)
        expertProofItem.submenu = expertProofMenu
        expertMenu.addItem(expertProofItem)
        expertToolsItem.submenu = expertMenu
        menu.addItem(expertToolsItem)

        menu.addItem(NSMenuItem.separator())
        let quitItem = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        item.menu = menu
        statusItem = item
        refreshMenuState()
    }

    @objc private func toggle() {
        if Settings.pillBehavior == .persistent {
            togglePersistentPill()
            refreshDictationControls()
            return
        }
        if controller.isRecording {
            stopDictation()
        } else if isHotKeySuppressed() {
            showStillFinishingNote(reason: "post-stop-cooldown")
        } else if controller.isBusy {
            showStillFinishingNote(reason: "processing")
        } else if !controller.isBusy {
            startDictation()
        }
        refreshDictationControls()
    }

    private func togglePersistentPill() {
        if controller.isRecording {
            persistentPillActive = false
            controller.stopIdleMonitor()
            stopDictation(hidePill: true)
            return
        }
        if controller.isBusy {
            persistentPillActive = false
            controller.stopIdleMonitor()
            liveTranscriptWindow.hideNow()
            updateStatus("Hiding after final transcript")
            RunLog.write("persistent-pill.deactivated", "reason=busy")
            return
        }
        if persistentPillActive {
            persistentPillActive = false
            controller.stopIdleMonitor()
            liveTranscriptWindow.hideNow()
            updateStatus("True Convo hidden")
            RunLog.write("persistent-pill.deactivated", "reason=hotkey")
            return
        }

        persistentPillActive = true
        if !Settings.autoStop {
            Settings.autoStop = true
            refreshMenuState()
            RunLog.write("persistent-pill.auto-stop.enabled")
        }
        RunLog.write("persistent-pill.activated")
        startDictation()
    }

    private func handleHotKeyPressed() {
        if hotKeyTestDeadline != nil {
            // Any press while a test is pending proves the key reaches us, even
            // one landing right at the deadline; the timeout then does nothing.
            hotKeyTestDeadline = nil
            let label = Settings.hotKeyShortcut.label
            RunLog.write("hotkey.pressed", "purpose=key-test")
            RunLog.write("hotkey.test.passed", "shortcut=\(label)")
            updateStatus("Key test passed")
            DispatchQueue.main.async { [weak self] in
                self?.showHotKeyTestResult(passed: true, label: label)
            }
            return
        }
        let persistentHideRequested = Settings.pillBehavior == .persistent
            && persistentPillActive
            && !controller.isRecording
        if !controller.isRecording, isHotKeySuppressed(), !persistentHideRequested {
            showStillFinishingNote(reason: "post-stop-cooldown")
            return
        }
        // A press never cancels the last dictation's pending swap (live words
        // replaced by the finished transcript). While that dictation is still
        // finishing, this press can't start a new one, so the swap must go
        // ahead. A leftover swap is dropped only when a new dictation really
        // starts (TextInjector.beginDictationSession).
        TextInjector.markHotKeyPressed()
        switch Settings.hotKeyMode {
        case .pressToToggle:
            toggle()
        case .holdToRecord:
            if controller.isBusy && !controller.isRecording {
                showStillFinishingNote(reason: "processing")
            } else if !controller.isRecording && !controller.isBusy {
                startDictation()
            }
        }
    }

    /// A dictation-key press that can't start a new dictation yet says why on
    /// the pill and in the menu, instead of being silently ignored.
    private func showStillFinishingNote(reason: String) {
        let note = "Still finishing your last dictation…"
        RunLog.write("hotkey.ignored", "reason=\(reason) busy=\(controller.isBusy)")
        updateStatus(note)
        if controller.isBusy {
            // The pill stays in its working state; the finished result
            // replaces this note when it arrives.
            liveTranscriptWindow.showProcessing(detail: note)
        } else {
            // Just finished (the short pause after a dictation). Flash the
            // note, unless a result such as "Saved to clipboard" is showing.
            liveTranscriptWindow.showBriefNote(note)
        }
    }

    private func handleHotKeyReleased() {
        TextInjector.markHotKeyReleased()
        guard Settings.hotKeyMode == .holdToRecord else { return }
        if deskStartPending { deskStartReleased = true }
        // A Desk start may still be waiting for a permission answer: let go
        // now, it never starts (Codex P1 on #9).
        if !controller.isRecording, controller.cancelPendingDeskStart() {
            settlePillAfterRefusedStart()
        }
        if controller.isRecording {
            stopDictation()
        }
    }

    private func startDictation(requireCorrection: Bool = false) {
        let readiness = ProviderReadiness.current()
        guard readiness.ready else {
            RunLog.write("dictation.start.blocked", "reason=provider-not-ready \(readiness.logDetail)")
            updateStatus(readiness.statusText)
            refreshMenuState()
            if Settings.pillBehavior == .persistent, persistentPillActive {
                liveTranscriptWindow.showReady()
            } else {
                liveTranscriptWindow.hideNow()
            }
            return
        }
        // Desk window in front: never the outside path. A dictation into the
        // open Desk takes the Desk's own route; anything else is refused
        // before any cursor target is remembered.
        switch DeskDictationPolicy.decide(requireCorrection ? .correctionOnce : .dictation, focus: deskFocus()) {
        case .refuseDesk(let refusal):
            refuseInDesk(refusal, event: "dictation.start.refused")
            settlePillAfterRefusedStart()
            return
        case .deskDraft:
            startDeskDictation()
            return
        case .externalCursor:
            break
        }
        rememberCursorTarget(NSWorkspace.shared.frontmostApplication, force: true)
        TextInjector.rememberFocusedElement()
        let correctionFeedback = TextInjector.captureCorrectionContextIfNeeded()
        if requireCorrection && !correctionFeedback.captured {
            TextInjector.clearCorrectionContext()
            cursorTargetLockedForDictation = false
            RunLog.write("correction.capture.once.cancelled", correctionFeedback.statusText)
            updateStatus(correctionFeedback.statusText)
            liveTranscriptWindow.hideNow()
            return
        }
        cursorTargetLockedForDictation = true
        RunLog.write("cursor-target.locked", TextInjector.targetDescription)
        liveTranscriptWindow.showPendingStart(
            correctionArmed: correctionFeedback.captured,
            targetApplication: TextInjector.targetApplication
        )
        if correctionFeedback.captured {
            RunLog.write("correction.selection.armed", correctionFeedback.statusText)
            updateStatus(correctionFeedback.statusText)
        }
        controller.start()
    }

    private func settlePillAfterRefusedStart() {
        if Settings.pillBehavior == .persistent, persistentPillActive {
            liveTranscriptWindow.showReady()
        } else {
            liveTranscriptWindow.hideNow()
        }
    }

    /// A Desk recording is being started (the host is asked for the
    /// confirmed draft binding first). A second press meanwhile is ignored.
    private var deskStartPending = false
    /// The dictation key was let go while a hold-to-record Desk start was
    /// still asking the host: that start is called off.
    private var deskStartReleased = false

    /// The Desk route (step 1, PR 2b). No cursor target is remembered or
    /// locked, nothing is typed, pasted, copied or sent, and nothing goes to
    /// history; the final words reach the Desk draft only through the
    /// host's `deliverFinal`. Recording starts only once the host confirms
    /// the draft binding the owner clicked into.
    private func startDeskDictation() {
        guard !deskStartPending, !controller.isBusy, let session = deskSessionStorage else { return }
        deskStartPending = true
        deskStartReleased = false
        TextInjector.clearCorrectionContext()
        liveTranscriptWindow.showPendingStart()
        Task { @MainActor [weak self] in
            guard let self else { return }
            let recording = await session.beginDeskRecording()
            self.deskStartPending = false
            let decision = DeskDictationPolicy.deskStart(hasConfirmedDraft: recording?.hasConfirmedDraft ?? false,
                                                         focusNow: self.deskFocus())
            guard case .deskDraft = decision, let recording else {
                self.settlePillAfterRefusedStart()
                if case .refuseDesk(let refusal) = decision {
                    self.refuseInDesk(refusal, event: "dictation.desk.start.refused")
                    self.liveTranscriptWindow.showBriefNote(Self.deskRefusalMessage(refusal), seconds: 3)
                }
                return
            }
            if self.deskStartReleased {
                RunLog.write("dictation.desk.start.cancelled", "reason=key-released")
                self.settlePillAfterRefusedStart()
                return
            }
            guard !self.controller.isBusy else { return }
            RunLog.write("dictation.desk.started", "route=desk-draft")
            self.controller.start(deskRoute: DictationController.DeskRoute { [weak self, weak session] text in
                guard let self, let session else { return .desk(.notKept) }
                return await self.deliverToDesk(recording, text: text, session: session)
            })
        }
    }

    /// Hands a Desk recording's words to the Desk and says where they went.
    private func deliverToDesk(_ recording: DeskSession.DeskRecording, text: String, session: DeskSession) async -> DictationOutcome {
        guard let delivery = await session.deliverDeskFinal(recording, text: text) else { return .desk(.notKept) }
        switch delivery {
        case .delivered: return .desk(.sentToDraft)
        case .held: return .desk(.setAside)
        case .dropped: return .desk(.notKept)
        }
    }

    private func stopDictation(hidePill: Bool = true) {
        extendHotKeyCooldown(seconds: 0.25, reason: "stop-requested")
        let provider = Settings.provider
        liveTranscriptWindow.showProcessing(
            detail: provider.isPostStopProvider ? "Transcribing (\(provider.label))…" : "Finishing…"
        )
        controller.stop()
    }

    private func stopDictationAfterExternalLivePreviewGuard(reason: String) {
        guard controller.isRecording else { return }
        RunLog.write("dictation.external-guard.stop-requested", "reason=\(reason)")
        liveTranscriptWindow.showGuarded()
        updateStatus("Stopped safely after edit")
        stopDictation()
        refreshDictationControls()
    }

    @objc private func correctSelectedTextOnce() {
        guard !controller.isRecording, !controller.isBusy, !isHotKeySuppressed() else {
            updateStatus("Finishing previous dictation")
            RunLog.write("correction.capture.once.blocked", "reason=dictation-busy")
            return
        }
        TextInjector.armOneShotCorrectionCapture()
        startDictation(requireCorrection: true)
        refreshDictationControls()
    }

    /// The typed correction path. For words a speech engine can never hear
    /// right (Marlowe vs Marlo), speaking the fix is hopeless — the user types
    /// it once, the pair is archived for Convo Engine, and optionally becomes
    /// a standing personal auto-correction.
    private func correctSelectedTextAfterHotKeyRelease(attempt: Int = 0) {
        let heldShortcutModifiers = NSEvent.modifierFlags.intersection([.control, .option, .command])
        guard heldShortcutModifiers.isEmpty else {
            guard attempt < 20 else {
                updateStatus("Release the correction shortcut and try again")
                RunLog.write("correction.hotkey.capture.skipped", "reason=modifiers-still-held")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.correctSelectedTextAfterHotKeyRelease(attempt: attempt + 1)
            }
            return
        }
        RunLog.write("correction.hotkey.capture.started", "afterRelease=true waitSteps=\(attempt)")
        correctSelectedTextByTyping()
    }

    @objc private func correctSelectedTextByTyping() {
        guard !controller.isRecording, !controller.isBusy, !isHotKeySuppressed() else {
            updateStatus("Finishing previous dictation")
            RunLog.write("correction.typed.blocked", "reason=dictation-busy")
            return
        }
        if case .refuseDesk(let refusal) = DeskDictationPolicy.decide(.typedCorrection, focus: deskFocus()) {
            refuseInDesk(refusal, event: "correction.typed.refused")
            return
        }
        rememberCursorTarget(NSWorkspace.shared.frontmostApplication, force: true)
        TextInjector.rememberFocusedElement()
        TextInjector.armOneShotCorrectionCapture()
        let feedback = TextInjector.captureCorrectionContextIfNeeded()
        guard feedback.captured, let selected = TextInjector.pendingCorrectionSelectedText else {
            TextInjector.clearCorrectionContext()
            updateStatus(feedback.statusText)
            return
        }
        runTypedCorrectionDialog(selected: selected) { replacement in
            TextInjector.consumeCorrectionContext(replacementText: replacement)
        }
    }

    /// macOS Services entry: right-click selected text in a native app and
    /// choose "Correct With True Convo". The pasteboard hands us the text.
    @objc(correctSelectedTextService:userData:error:)
    func correctSelectedTextService(_ pboard: NSPasteboard, userData: String?, error: AutoreleasingUnsafeMutablePointer<NSString>) {
        guard !controller.isRecording, !controller.isBusy else {
            updateStatus("Finishing previous dictation")
            return
        }
        if case .refuseDesk(let refusal) = DeskDictationPolicy.decide(.servicesCorrection, focus: deskFocus()) {
            refuseInDesk(refusal, event: "correction.service.refused")
            return
        }
        guard let selected = pboard.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !selected.isEmpty
        else {
            updateStatus("No selected text for correction")
            return
        }
        let frontmost = NSWorkspace.shared.frontmostApplication
        rememberCursorTarget(frontmost, force: true)
        TextInjector.rememberFocusedElement()
        let bundle = frontmost?.bundleIdentifier ?? "unknown"
        let name = frontmost?.localizedName ?? bundle
        RunLog.write("correction.typed.service", "chars=\(selected.count) bundle=\(bundle)")
        runTypedCorrectionDialog(selected: selected) { replacement in
            CorrectionContext(
                selectedText: selected,
                replacementText: replacement,
                targetBundle: bundle,
                targetName: name,
                captureMethod: "service/pasteboard-selection"
            )
        }
    }

    private func runTypedCorrectionDialog(selected: String, makeContext: @escaping (String) -> CorrectionContext?) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Type the correction"
        alert.informativeText = "Replacing: “\(selected)”\nThe before/after pair is saved so Convo Engine can learn from it."
        let field = NSTextField(string: selected)
        field.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
        let checkbox = NSButton(checkboxWithTitle: "Always auto-correct this from now on", target: nil, action: nil)
        // On by default: most corrections are unambiguous (names, product words).
        // The owner unticks it for contextual homophones — 'peaked' can be a real
        // word in one sentence and a mistake in the next.
        checkbox.state = .on
        let stack = NSStackView(views: [field, checkbox])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.frame = NSRect(x: 0, y: 0, width: 300, height: 58)
        field.widthAnchor.constraint(equalToConstant: 300).isActive = true
        alert.accessoryView = stack
        alert.addButton(withTitle: "Replace")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field

        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else {
            TextInjector.clearCorrectionContext()
            updateStatus("Typed correction cancelled")
            RunLog.write("correction.typed.cancelled")
            return
        }
        let replacement = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !replacement.isEmpty, replacement != selected else {
            TextInjector.clearCorrectionContext()
            updateStatus(replacement.isEmpty ? "Empty correction; nothing changed" : "No change typed; nothing learned")
            RunLog.write("correction.typed.discarded", replacement.isEmpty ? "reason=empty" : "reason=unchanged")
            return
        }
        guard let correction = makeContext(replacement) else {
            updateStatus("Typed correction lost its selection")
            RunLog.write("correction.typed.discarded", "reason=missing-selection")
            return
        }

        beginDeskShieldScope()
        TextInjector.paste(replacement)

        let id = "typed-correction-\(Int(Date().timeIntervalSince1970 * 1000))"
        let entry = ArchiveEntry(
            id: id,
            timestamp: ISO8601DateFormatter().string(from: Date()),
            durationMs: 0,
            text: replacement,
            audioPath: nil,
            contentPacketPath: nil,
            derivedFromSessionId: nil,
            captureMode: "typed-correction",
            timing: nil,
            provider: "typed-correction",
            model: "human-typed",
            language: Settings.language,
            source: "voice-cursor-mac-prototype",
            injected: true,
            target: TextInjector.currentTargetContext(),
            processing: ProcessingContext(
                privacyLane: "typed-correction-no-audio",
                cloudProcessed: false,
                cloudProvider: nil,
                harvestUse: "correction-pair-review-evidence",
                trainingEligibility: "eligible-after-human-review",
                trainingPromotionBoundary: "Human-typed correction pair with no audio. Typed pairs are the highest-fidelity correction evidence; Convo Engine may use them as adaptation candidates after review."
            ),
            correction: correction
        )
        do {
            try Archive.append(entry)
            RunLog.write("correction.typed.captured", "id=\(id) fromChars=\(selected.count) toChars=\(replacement.count)")
        } catch {
            RunLog.write("correction.typed.archive-failed", "id=\(id) error=\(error.localizedDescription)")
        }

        if checkbox.state == .on {
            switch SavedCorrections.remember(wrong: selected, right: replacement) {
            case .saved:
                updateStatus("Saved fix: \(selected) → \(replacement)")
            case .updated:
                updateStatus("Updated fix: \(selected) → \(replacement)")
            case .unchanged:
                updateStatus("Already saved: \(selected) → \(replacement)")
            case .failed:
                updateStatus("Couldn't save that fix")
            }
        } else {
            updateStatus("Fixed once: \(selected) → \(replacement)")
        }
        refreshDictationControls()
    }

    func menuWillOpen(_ menu: NSMenu) {
        guard menu === mainMenu else { return }
        refreshLastDictationMenuItem()
        refreshOpenAtLoginMenuItem()
        refreshDeskMenuItems()
    }

    private func refreshLastDictationMenuItem() {
        let saved = Settings.lastDictationAt
        guard let date = saved ?? Archive.lastDictationDateFromHistory() else {
            lastDictationMenuItem.title = "Last dictation: none yet"
            return
        }
        if saved == nil { Settings.lastDictationAt = date }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        lastDictationMenuItem.title = "Last dictation: \(formatter.localizedString(for: date, relativeTo: Date()))"
    }

    private func refreshOpenAtLoginMenuItem() {
        guard AppIdentity.current.mayRegisterLoginItem else { return }
        switch SMAppService.mainApp.status {
        case .enabled:
            openAtLoginMenuItem.title = "Open at Login"
            openAtLoginMenuItem.state = .on
        case .requiresApproval:
            openAtLoginMenuItem.title = "Open at Login (approve in System Settings)"
            openAtLoginMenuItem.state = .mixed
        case .notFound:
            openAtLoginMenuItem.title = "Open at Login (not available for this copy)"
            openAtLoginMenuItem.state = .off
        default:
            openAtLoginMenuItem.title = "Open at Login"
            openAtLoginMenuItem.state = .off
        }
    }

    @objc private func toggleOpenAtLogin() {
        // The item is not in True Convo Test's menu; refused here as well.
        guard AppIdentity.current.mayRegisterLoginItem else {
            RunLog.write("login-item.refused", "reason=test-copy")
            return
        }
        let service = SMAppService.mainApp
        if service.status == .requiresApproval {
            RunLog.write("login-item.approval.opened")
            updateStatus("Approve True Convo in Login Items")
            SMAppService.openSystemSettingsLoginItems()
            return
        }
        do {
            if service.status == .enabled {
                try service.unregister()
                RunLog.write("login-item.disabled")
                updateStatus("Won't open at login")
            } else {
                try service.register()
                RunLog.write("login-item.enabled", "status=\(service.status.rawValue)")
                if service.status == .requiresApproval {
                    updateStatus("Approve in Login Items")
                    SMAppService.openSystemSettingsLoginItems()
                } else {
                    updateStatus("Opens at login")
                }
            }
        } catch {
            let reason = error.localizedDescription.replacingOccurrences(of: " ", with: "_")
            RunLog.write("login-item.failed", "error=\(reason)")
            updateStatus("Open at login failed")
        }
        refreshOpenAtLoginMenuItem()
    }

    @objc private func testDictationKey() {
        guard !controller.isRecording, !controller.isBusy else {
            updateStatus("Finish dictating, then test")
            return
        }
        let deadline = Date().addingTimeInterval(10)
        hotKeyTestDeadline = deadline
        let label = Settings.hotKeyShortcut.label
        RunLog.write("hotkey.test.started", "shortcut=\(label)")
        updateStatus("Press \(label) now to test")
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self, self.hotKeyTestDeadline == deadline else { return }
            self.hotKeyTestDeadline = nil
            RunLog.write("hotkey.test.timeout", "shortcut=\(label)")
            self.updateStatus("Key test: no press seen")
            self.showHotKeyTestResult(passed: false, label: label)
        }
    }

    private func showHotKeyTestResult(passed: Bool, label: String) {
        let alert = NSAlert()
        alert.messageText = passed ? "\(label) reached True Convo" : "True Convo didn't see \(label)"
        alert.informativeText = passed
            ? "Your dictation shortcut works. Press it again any time to dictate."
            : "Nothing arrived within 10 seconds. Another app may be using \(label), or True Convo may need Accessibility permission. You can pick a different shortcut from the menu."
        alert.alertStyle = passed ? .informational : .warning
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === personalCorrectionsSubmenu else { return }
        menu.removeAllItems()
        guard let lessons = SavedCorrections.lessonsForMenu() else {
            let unavailable = NSMenuItem(title: "Saved fixes unavailable (see log)", action: nil, keyEquivalent: "")
            unavailable.isEnabled = false
            menu.addItem(unavailable)
            return
        }
        guard !lessons.isEmpty else {
            let empty = NSMenuItem(title: "Nothing saved yet — use Correct Selected Text by Typing…", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
            return
        }
        let sorted = lessons.sorted {
            $0.phrasePair.sourcePhrase.lowercased() < $1.phrasePair.sourcePhrase.lowercased()
        }
        for lesson in sorted {
            let uses = lesson.useCount == 1 ? "used once" : "used \(lesson.useCount) times"
            let title = "\(lesson.phrasePair.sourcePhrase) → \(lesson.phrasePair.replacementPhrase)  (\(uses); click to forget)"
            let item = NSMenuItem(title: title, action: #selector(forgetSavedFix(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = lesson.id
            menu.addItem(item)
        }
        menu.addItem(NSMenuItem.separator())
        let resetItem = NSMenuItem(title: "Forget All Saved Fixes…", action: #selector(resetSavedFixes), keyEquivalent: "")
        resetItem.target = self
        menu.addItem(resetItem)
    }

    @objc private func forgetSavedFix(_ sender: NSMenuItem) {
        guard let lessonID = sender.representedObject as? UUID else { return }
        updateStatus(SavedCorrections.forget(lessonID: lessonID) ? "Forgot that fix" : "Couldn't forget that fix")
    }

    @objc private func resetSavedFixes() {
        let alert = NSAlert()
        alert.messageText = "Forget all saved fixes?"
        alert.informativeText = "True Convo will stop auto-correcting every word you've taught it. Your dictation history is not affected."
        alert.addButton(withTitle: "Forget All")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        updateStatus(SavedCorrections.resetAll() ? "Forgot all saved fixes" : "Couldn't reset saved fixes")
    }

    private func extendHotKeyCooldown(seconds: TimeInterval, reason: String) {
        let candidate = Date().addingTimeInterval(seconds)
        if candidate > hotKeySuppressedUntil {
            hotKeySuppressedUntil = candidate
            RunLog.write("hotkey.cooldown.extended", "reason=\(reason) seconds=\(String(format: "%.1f", seconds))")
        }
    }

    private func isHotKeySuppressed() -> Bool {
        Date() < hotKeySuppressedUntil
    }

    @objc private func selectProvider(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let provider = DictationProvider(rawValue: raw)
        else { return }
        Settings.provider = provider
        refreshMenuState()
        let readiness = ProviderReadiness.forProvider(provider)
        updateStatus(readiness.ready ? "Mode: \(provider.label) (\(provider.privacyLabel))" : readiness.statusText)
        prepareAppleSpeechAnalyzerIfPicked(provider)
    }

    @objc private func selectModelPreset(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              let preset = ModelPreset.byId(id)
        else { return }
        preset.apply()
        refreshMenuState()
        let model = preset.model ?? "on-device"
        RunLog.write("model-preset.selected", "provider=\(preset.provider.rawValue) privacy=\"\(preset.provider.privacyLabel)\" model=\(model)")
        let readiness = ProviderReadiness.forProvider(preset.provider)
        updateStatus(readiness.ready ? "Preset: \(preset.label) (\(preset.provider.privacyLabel))" : readiness.statusText)
        prepareAppleSpeechAnalyzerIfPicked(preset.provider)
    }

    /// When Apple On-Device (New) is picked, get Apple's model downloaded (once,
    /// from Apple) and loaded now, so the first dictation doesn't wait for it.
    /// `onlyIfInstalled` (app launch) loads it only if it is already on the Mac.
    private func prepareAppleSpeechAnalyzerIfPicked(_ provider: DictationProvider, onlyIfInstalled: Bool = false) {
        guard provider == .appleSpeechAnalyzer else { return }
        guard #available(macOS 26, *) else { return }
        let language = Settings.language
        let inputSampleRate = AudioDeviceInfo.dictationInputSampleRate()
        RunLog.write(
            "speech-analyzer.prewarm.requested",
            "language=\(language) onlyIfInstalled=\(onlyIfInstalled) inputRate=\(inputSampleRate.map { String(Int($0)) } ?? "unknown")"
        )
        Task { [weak self] in
            await AppleSpeechAnalyzerEngine.prepareModel(
                language: language,
                inputSampleRate: inputSampleRate,
                onlyIfInstalled: onlyIfInstalled
            ) { status in
                self?.updateStatus(status)
            }
        }
    }

    @objc private func selectArchiveFormat(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let format = ArchiveFormat(rawValue: raw)
        else { return }
        Settings.archiveFormat = format
        refreshMenuState()
        updateStatus("Archive: \(format.label)")
    }

    @objc private func toggleRetainAudioForHarvest() {
        Settings.dictationPreferences.retainAudioForHarvest.toggle()
        refreshMenuState()
        RunLog.write("retained-audio-harvest.toggled", "enabled=\(Settings.dictationPreferences.retainAudioForHarvest)")
        updateStatus(Settings.dictationPreferences.retainAudioForHarvest ? "Retained audio harvest enabled" : "Retained audio harvest disabled")
    }

    @objc private func selectAudioInput(_ sender: NSMenuItem) {
        guard let uid = sender.representedObject as? String else { return }
        let applied = AudioDeviceInfo.selectInputDevice(uid: uid)
        refreshMenuState()
        updateStatus(applied ? "Input: \(AudioDeviceInfo.selectedInputLabel())" : "Input not available")
    }

    @objc private func selectWakeSensitivity(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let sensitivity = WakeSensitivity(rawValue: raw)
        else { return }
        Settings.wakeSensitivity = sensitivity
        refreshMenuState()
        RunLog.write("wake-sensitivity.selected", sensitivity.rawValue)
        updateStatus("Wake sensitivity: \(sensitivity.label)")
    }

    @objc private func selectCompletionAction(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let action = CompletionAction(rawValue: raw)
        else { return }
        Settings.completionAction = action
        refreshMenuState()
        updateStatus("After dictation: \(action.label)")
    }

    @objc private func selectHotKeyMode(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let mode = HotKeyMode(rawValue: raw)
        else { return }
        Settings.hotKeyMode = mode
        if mode == .holdToRecord, Settings.pillBehavior == .persistent {
            Settings.pillBehavior = .oneShot
            persistentPillActive = false
            controller.stopIdleMonitor()
        }
        refreshMenuState()
        updateStatus("Shortcut: \(mode.label)")
    }

    @objc private func selectHotKeyShortcut(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let shortcut = HotKeyShortcut(rawValue: raw)
        else { return }
        Settings.hotKeyShortcut = shortcut
        hotKey?.update(shortcut: shortcut)
        refreshMenuState()
        updateStatus("Shortcut key: \(shortcut.label)")
    }

    @objc private func selectPillBehavior(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let behavior = PillBehavior(rawValue: raw)
        else { return }
        Settings.pillBehavior = behavior
        if behavior == .persistent {
            Settings.hotKeyMode = .pressToToggle
            Settings.autoStop = true
        } else {
            persistentPillActive = false
            controller.stopIdleMonitor()
            if !controller.isRecording {
                liveTranscriptWindow.hideNow()
            }
        }
        refreshMenuState()
        RunLog.write("pill-behavior.selected", behavior.rawValue)
        updateStatus("Pill: \(behavior.label)")
    }

    @objc private func selectInsertionTiming(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let timing = InsertionTiming(rawValue: raw)
        else { return }
        timing.apply()
        refreshMenuState()
        RunLog.write("insertion-timing.selected", timing.rawValue)
        updateStatus("Insertion timing: \(timing.label)")
    }

    @objc private func selectInsertionMode(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let mode = InsertionMode(rawValue: raw)
        else { return }
        Settings.insertionMode = mode
        if mode == .finalPasteOnly {
            Settings.liveInsertApplePartials = false
            Settings.livePasteAppleFinals = false
        } else if !Settings.liveInsertApplePartials {
            Settings.liveInsertApplePartials = true
            Settings.livePasteAppleFinals = false
        }
        refreshMenuState()
        updateStatus("Insertion: \(mode.label)")
    }

    @objc private func selectFinalRewriteMode(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let mode = FinalRewriteMode(rawValue: raw)
        else { return }
        Settings.finalRewriteMode = mode
        refreshMenuState()
        RunLog.write("final-rewrite-mode.selected", mode.rawValue)
        updateStatus("Final cleanup: \(mode.label)")
    }

    @objc private func useHermesRecommendedSettings() {
        Settings.dictationPreferences.applyHermesRecommendedSettings()
        refreshMenuState()
        RunLog.write(
            "hermes.recommended-settings.applied",
            "provider=local-whisper model=small action=auto-paste insertion=final-paste-only livePreview=false finalRewrite=keep-live-text autoStop=false pillBehavior=one-shot retainAudio=\(Settings.dictationPreferences.retainAudioForHarvest) correctionCapture=false hotKeyMode=press-to-toggle wakeSensitivity=quiet spokenPunctuation=false"
        )
        updateStatus("Baseline dictation settings applied")
    }

    @objc private func toggleCorrectionCapture() {
        Settings.captureSelectionCorrections.toggle()
        refreshMenuState()
        updateStatus(Settings.captureSelectionCorrections ? "Convo Engine harvest capture enabled" : "Convo Engine harvest capture disabled")
    }

    @objc private func toggleAutoStop() {
        Settings.autoStop.toggle()
        refreshMenuState()
        updateStatus(Settings.autoStop ? "Auto-stop enabled" : "Auto-stop disabled")
    }

    @objc private func toggleLivePaste() {
        Settings.livePasteAppleFinals.toggle()
        if Settings.livePasteAppleFinals {
            Settings.liveInsertApplePartials = false
        }
        refreshMenuState()
        updateStatus(Settings.livePasteAppleFinals ? "Live paste enabled" : "Live paste disabled")
    }

    @objc private func toggleLivePreview() {
        Settings.liveInsertApplePartials.toggle()
        if Settings.liveInsertApplePartials {
            Settings.livePasteAppleFinals = false
            if Settings.insertionMode == .finalPasteOnly {
                Settings.insertionMode = .auto
            }
        } else {
            Settings.insertionMode = .finalPasteOnly
        }
        refreshMenuState()
        updateStatus(Settings.liveInsertApplePartials ? "Live cursor preview enabled" : "Live cursor preview disabled")
    }

    @objc private func toggleSpokenPunctuation() {
        Settings.spokenPunctuationCommands.toggle()
        refreshMenuState()
        updateStatus(Settings.spokenPunctuationCommands ? "Spoken punctuation commands enabled" : "Automatic punctuation only")
    }

    @objc private func openArchive() {
        NSWorkspace.shared.open(Archive.root)
    }

    @objc private func openArchiveHistory() {
        archiveHistoryWindow.showWindow(nil)
    }

    @objc private func openTranscripts() {
        try? Archive.ensureDirectories()
        NSWorkspace.shared.open(Archive.transcripts)
    }

    @objc private func openLatestTranscript() {
        openLatestFile(Archive.latestTranscript, missingStatus: "No latest transcript yet")
    }

    @objc private func openLatestContentPacket() {
        openLatestFile(Archive.latestContentPacket, missingStatus: "No latest content packet yet")
    }

    @objc private func copyLastDictation() {
        guard let text = controller.lastDictationText, !text.isEmpty else {
            updateStatus("No dictation yet since True Convo opened — see Archive History")
            return
        }
        TextInjector.writePrivateClipboardText(text)
        RunLog.write("last-dictation.copied", "chars=\(text.count)")
        updateStatus("Copied last dictation")
    }

    @objc private func copyLatestTranscript() {
        guard FileManager.default.fileExists(atPath: Archive.latestTranscript.path),
              let transcript = try? String(contentsOf: Archive.latestTranscript, encoding: .utf8)
        else {
            updateStatus("No latest transcript yet")
            return
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(transcript, forType: .string)
        RunLog.write("latest-transcript.copied", Archive.latestTranscript.path)
        updateStatus("Copied latest transcript")
    }

    @objc private func copyLatestContentPacket() {
        guard FileManager.default.fileExists(atPath: Archive.latestContentPacket.path),
              let packet = try? String(contentsOf: Archive.latestContentPacket, encoding: .utf8)
        else {
            updateStatus("No latest content packet yet")
            return
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(packet, forType: .string)
        RunLog.write("latest-packet.copied", Archive.latestContentPacket.path)
        updateStatus("Copied latest content packet")
    }

    @objc private func openHarvestInbox() {
        do {
            let url = try Archive.writeHarvestInbox()
            RunLog.write("harvest-inbox.open.requested", url.path)
            NSWorkspace.shared.open(url)
            updateStatus("Opened harvest inbox")
        } catch {
            RunLog.write("harvest-inbox.open.failed", error.localizedDescription)
            updateStatus("Harvest inbox failed")
        }
    }

    @objc private func openCorrectionInbox() {
        do {
            let url = try Archive.writeCorrectionInbox()
            RunLog.write("correction-inbox.open.requested", url.path)
            NSWorkspace.shared.open(url)
            updateStatus("Opened correction inbox")
        } catch {
            RunLog.write("correction-inbox.open.failed", error.localizedDescription)
            updateStatus("Correction inbox failed")
        }
    }

    @objc private func openHarvestBundle() {
        do {
            let url = try Archive.writeHarvestBundle()
            RunLog.write("harvest-bundle.open.requested", url.path)
            NSWorkspace.shared.open(url)
            updateStatus("Opened harvest bundle")
        } catch {
            RunLog.write("harvest-bundle.open.failed", error.localizedDescription)
            updateStatus("Harvest bundle failed")
        }
    }

    @objc private func copyHarvestBundle() {
        do {
            let url = try Archive.writeHarvestBundle()
            let bundle = try String(contentsOf: url, encoding: .utf8)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(bundle, forType: .string)
            RunLog.write("harvest-bundle.copied", url.path)
            updateStatus("Copied harvest bundle")
        } catch {
            RunLog.write("harvest-bundle.copy.failed", error.localizedDescription)
            updateStatus("Harvest bundle copy failed")
        }
    }

    @objc private func openTimingReport() {
        do {
            let url = try Archive.writeTimingReport()
            RunLog.write("timing-report.open.requested", url.path)
            NSWorkspace.shared.open(url)
            updateStatus("Opened timing report")
        } catch {
            RunLog.write("timing-report.open.failed", error.localizedDescription)
            updateStatus("Timing report failed")
        }
    }

    @objc private func revealLatestAudio() {
        guard let audioURL = latestAudioURL() else {
            updateStatus("No latest audio yet")
            return
        }
        RunLog.write("latest-audio.reveal.requested", audioURL.path)
        NSWorkspace.shared.activateFileViewerSelecting([audioURL])
    }

    @objc private func reprocessLatestAudio() {
        guard !controller.isBusy else {
            updateStatus("Stop dictation before reprocessing")
            return
        }

        let provider = Settings.provider
        guard provider != .appleLocal, provider != .appleSpeechAnalyzer else {
            updateStatus("Choose Local Whisper, OpenAI Cloud, or Groq to reprocess audio")
            RunLog.write("reprocess.latest.blocked", "reason=\(provider.rawValue)-provider")
            return
        }
        guard provider != .openAIRealtime else {
            updateStatus("OpenAI Realtime is live only")
            RunLog.write("reprocess.latest.blocked", "reason=openai-realtime-provider")
            return
        }

        guard let latest = Archive.latestEntry(),
              let audioPath = latest.audioPath,
              !audioPath.isEmpty
        else {
            updateStatus("No retained audio to reprocess")
            return
        }

        let audioURL = URL(fileURLWithPath: audioPath)
        guard FileManager.default.fileExists(atPath: audioURL.path) else {
            updateStatus("Latest audio file is missing")
            RunLog.write("reprocess.latest.blocked", "reason=missing-audio path=\(audioURL.path)")
            return
        }

        let language = latest.language.isEmpty ? Settings.language : latest.language
        updateStatus("Reprocessing with \(provider.label)")
        RunLog.write("reprocess.latest.requested", "from=\(latest.id) provider=\(provider.rawValue) audio=\(audioURL.path)")

        Task { @MainActor [weak self] in
            do {
                let reprocessStartedAt = Date()
                let result = try await TranscriptionService.transcribe(
                    provider: provider,
                    audioURL: audioURL,
                    language: language
                )
                let transcriptionMs = milliseconds(between: reprocessStartedAt, and: Date())
                let cleanedText = SavedCorrections.preview(
                    cleanedDictationText(result.text),
                    targetBundleID: latest.target?.bundleIdentifier,
                    language: language
                )
                let id = "voice-cursor-reprocess-\(Int(Date().timeIntervalSince1970 * 1000))"
                let entry = ArchiveEntry(
                    id: id,
                    timestamp: ISO8601DateFormatter().string(from: Date()),
                    durationMs: latest.durationMs,
                    text: cleanedText,
                    audioPath: audioURL.path,
                    contentPacketPath: Archive.contentPacketURL(for: id).path,
                    derivedFromSessionId: latest.id,
                    captureMode: "reprocess",
                    timing: ArchiveTiming(
                        liveFirstPartialMs: nil,
                        liveFirstFinalMs: nil,
                        postStopTranscriptionMs: transcriptionMs,
                        archiveFinalizeMs: nil,
                        totalStopProcessingMs: milliseconds(between: reprocessStartedAt, and: Date())
                    ),
                    provider: provider.rawValue,
                    model: result.model,
                    language: language,
                    source: "voice-cursor-mac-prototype",
                    injected: false,
                    target: latest.target,
                    correction: nil
                )
                try Archive.append(entry)
                RunLog.write(
                    "reprocess.latest.wrote",
                    "id=\(id) from=\(latest.id) provider=\(provider.rawValue) packet=\(Archive.contentPacketURL(for: id).path)"
                )
                self?.liveTranscriptWindow.updateTranscript(cleanedText)
                self?.updateStatus("Reprocessed with \(provider.label)")
            } catch {
                RunLog.write("reprocess.latest.failed", "provider=\(provider.rawValue) error=\(error.localizedDescription)")
                self?.updateStatus("Reprocess failed: \(error.localizedDescription)")
            }
        }
    }

    @objc private func compareLatestAudioProviders() {
        guard !controller.isBusy, !isComparingProviders else {
            updateStatus("Stop current work before comparing providers")
            return
        }

        guard let latest = Archive.latestEntry(),
              let audioPath = latest.audioPath,
              !audioPath.isEmpty
        else {
            updateStatus("No retained audio to compare")
            return
        }

        let audioURL = URL(fileURLWithPath: audioPath)
        guard FileManager.default.fileExists(atPath: audioURL.path) else {
            updateStatus("Latest audio file is missing")
            RunLog.write("provider-comparison.blocked", "reason=missing-audio path=\(audioURL.path)")
            return
        }

        let presets = readyComparisonPresets()
        guard !presets.isEmpty else {
            updateStatus("No ready provider presets to compare")
            RunLog.write("provider-comparison.blocked", "reason=no-ready-presets")
            return
        }

        guard confirmProviderComparison(presets: presets) else {
            RunLog.write("provider-comparison.cancelled", "source=\(latest.id)")
            return
        }

        isComparingProviders = true
        updateStatus("Comparing \(presets.count) provider presets")
        RunLog.write(
            "provider-comparison.started",
            "source=\(latest.id) presets=\(presets.map(\.id).joined(separator: ",")) audio=\(audioURL.path)"
        )
        let language = latest.language.isEmpty ? Settings.language : latest.language

        Task { @MainActor [weak self] in
            guard let self else { return }
            var outcomes: [ProviderComparisonOutcome] = []

            for preset in presets {
                self.updateStatus("Comparing \(preset.label)")
                let startedAt = Date()
                do {
                    let result = try await TranscriptionService.transcribe(
                        provider: preset.provider,
                        audioURL: audioURL,
                        language: language,
                        modelOverride: preset.model
                    )
                    let elapsedMs = milliseconds(between: startedAt, and: Date())
                    let cleanedText = SavedCorrections.preview(
                        cleanedDictationText(result.text),
                        targetBundleID: latest.target?.bundleIdentifier,
                        language: language
                    )
                    let id = "voice-cursor-compare-\(Int(Date().timeIntervalSince1970 * 1000))-\(self.safePresetId(preset.id))"
                    let entry = ArchiveEntry(
                        id: id,
                        timestamp: ISO8601DateFormatter().string(from: Date()),
                        durationMs: latest.durationMs,
                        text: cleanedText,
                        audioPath: audioURL.path,
                        contentPacketPath: Archive.contentPacketURL(for: id).path,
                        derivedFromSessionId: latest.id,
                        captureMode: "comparison-reprocess",
                        timing: ArchiveTiming(
                            liveFirstPartialMs: nil,
                            liveFirstFinalMs: nil,
                            postStopTranscriptionMs: elapsedMs,
                            archiveFinalizeMs: nil,
                            totalStopProcessingMs: elapsedMs
                        ),
                        provider: preset.provider.rawValue,
                        model: result.model,
                        language: language,
                        source: "voice-cursor-mac-prototype",
                        injected: false,
                        target: latest.target,
                        correction: nil
                    )
                    try Archive.append(entry)
                    outcomes.append(ProviderComparisonOutcome(
                        preset: preset,
                        succeeded: true,
                        transcript: cleanedText,
                        entryId: id,
                        contentPacketPath: Archive.contentPacketURL(for: id).path,
                        durationMs: elapsedMs,
                        errorMessage: nil
                    ))
                    RunLog.write(
                        "provider-comparison.preset.wrote",
                        "id=\(id) source=\(latest.id) preset=\(preset.id) durationMs=\(elapsedMs)"
                    )
                } catch {
                    outcomes.append(ProviderComparisonOutcome(
                        preset: preset,
                        succeeded: false,
                        transcript: nil,
                        entryId: nil,
                        contentPacketPath: nil,
                        durationMs: nil,
                        errorMessage: error.localizedDescription
                    ))
                    RunLog.write(
                        "provider-comparison.preset.failed",
                        "source=\(latest.id) preset=\(preset.id) error=\(error.localizedDescription)"
                    )
                }
            }

            do {
                let reportURL = try ProviderComparisonReport.write(
                    source: latest,
                    audioURL: audioURL,
                    outcomes: outcomes
                )
                NSWorkspace.shared.open(reportURL)
                self.updateStatus("Provider comparison complete")
            } catch {
                RunLog.write("provider-comparison.report.failed", "source=\(latest.id) error=\(error.localizedDescription)")
                self.updateStatus("Comparison report failed")
            }

            self.isComparingProviders = false
        }
    }

    @objc private func openLatestProviderComparison() {
        openLatestFile(Archive.latestProviderComparison, missingStatus: "No provider comparison yet")
    }

    private func readyComparisonPresets() -> [ModelPreset] {
        ModelPreset.all.filter { preset in
            switch preset.provider {
            case .appleLocal:
                return false
            case .localWhisper:
                return FileManager.default.isExecutableFile(atPath: Settings.whisperBinary)
            case .openAIRealtime:
                return false
            case .openAICloud:
                return RuntimeEnvironment.source("OPENAI_API_KEY") != "missing"
            case .groqCloud:
                return RuntimeEnvironment.source("GROQ_API_KEY") != "missing"
            case .appleSpeechAnalyzer:
                return false
            }
        }
    }

    private func confirmProviderComparison(presets: [ModelPreset]) -> Bool {
        let cloudPresets = presets.filter { $0.provider == .openAICloud || $0.provider == .groqCloud }
        let alert = NSAlert()
        alert.messageText = "Compare latest retained audio?"
        alert.informativeText = [
            "True Convo will reprocess the newest retained audio through \(presets.count) ready provider/model presets and archive each successful transcript.",
            cloudPresets.isEmpty
                ? "No cloud presets are ready, so this comparison will stay local."
                : "Cloud presets are ready and may call OpenAI or Groq because keys are available.",
            "No new microphone recording will start."
        ].joined(separator: "\n\n")
        alert.addButton(withTitle: "Run Comparison")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func safePresetId(_ id: String) -> String {
        id.replacingOccurrences(of: "[^A-Za-z0-9_-]+", with: "-", options: .regularExpression)
    }

    private func latestAudioURL() -> URL? {
        guard FileManager.default.fileExists(atPath: Archive.latestSession.path),
              let data = try? Data(contentsOf: Archive.latestSession),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let audioPath = object["audioPath"] as? String,
              !audioPath.isEmpty
        else {
            return nil
        }
        let url = URL(fileURLWithPath: audioPath)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    private func openLatestFile(_ url: URL, missingStatus: String) {
        guard FileManager.default.fileExists(atPath: url.path) else {
            updateStatus(missingStatus)
            return
        }
        RunLog.write("latest-file.open.requested", url.path)
        NSWorkspace.shared.open(url)
    }

    @objc private func openRunLog() {
        RunLog.write("run-log.open.requested")
        NSWorkspace.shared.open(Archive.runLog)
    }

    @objc private func openSettings() {
        settingsWindow.showWindow(nil)
    }

    @objc private func openFirstRunChecklist() {
        firstRunChecklistWindow.showWindow(nil)
    }

    @objc private func openScratchpad() {
        scratchpadWindow.showWindow(nil)
    }

    // MARK: Desk window (invented data)

    /// This run's Desk session, made on first use: one in-memory key and one
    /// store folder for the whole run.
    @MainActor
    private var deskSession: DeskSession? {
        if let deskSessionStorage { return deskSessionStorage }
        guard deskBundle != nil, let paths = DeskPaths.standard(identity: AppIdentity.current) else { return nil }
        let session = DeskSession(paths: paths, bundle: deskBundle, info: DeskSession.hostInfo(), log: { RunLog.write($0, $1) })
        deskSessionStorage = session
        return session
    }

    /// Desk objects live on the main thread, and every caller here is already
    /// on it (menu actions, the hotkey's main-queue hops, launch, Services).
    /// Should one ever not be, the Desk is left alone and `fallback` returned.
    private func onMainThread<T: Sendable>(_ fallback: T, _ work: @MainActor () -> T) -> T {
        guard Thread.isMainThread else { return fallback }
        return MainActor.assumeIsolated(work)
    }

    /// Opens or fronts the Desk window. It starts locked; unlocking asks the
    /// Mac's owner.
    @MainActor
    @objc private func openDesk() {
        guard let session = deskSession else {
            updateStatus("The Desk isn't in this build")
            refreshDeskMenuItems()
            return
        }
        let windowController: DeskWindowController
        if let existing = deskWindowController {
            windowController = existing
        } else {
            windowController = DeskWindowController(session: session, verifier: MacOwnerVerifier(), log: { RunLog.write($0, $1) })
            // Clicking into the Desk during an outside dictation is input
            // outside the target, like a click in another app.
            windowController.onBecameKey = { [weak self] in
                guard let self, self.controller.isBusy || TextInjector.hasPendingFinalReconcile else { return }
                self.handleInputOutsideDictationTarget(.deskBecameKey)
            }
            windowController.onStateChange = { [weak self] in self?.refreshDeskMenuItems() }
            windowController.onShrinkToPill = { [weak self] in self?.showPillAfterShrink() }
            // Set-aside dictation: the pill says where the words went; the
            // words themselves are only in the Desk window's row.
            var heldShown = 0
            windowController.onHeldDictationChange = { [weak self] count in
                defer { heldShown = count }
                guard let self, count > heldShown else { return }
                self.liveTranscriptWindow.showBriefNote("Words kept in the Desk window", seconds: 3)
            }
            deskWindowController = windowController
        }
        RunLog.write("desk.window.open", "state=\(session.state.logName)")
        windowController.showDesk()
        refreshDeskMenuItems()
    }

    /// The switching shortcut and menu item: a Desk holding the focus
    /// shrinks to the pill; otherwise the Desk comes back where it was left.
    @MainActor
    @objc private func toggleDeskAndPill() {
        let holdsFocus = deskWindowController?.holdsFocus ?? false
        switch DeskSwitchPolicy.toggle(hasDesk: deskBundle != nil, deskWindowHoldsFocus: holdsFocus) {
        case .shrinkToPill:
            RunLog.write("desk.switch", "to=pill via=shortcut")
            deskWindowController?.shrinkToPill()
        case .showDesk:
            RunLog.write("desk.switch", "to=desk via=shortcut")
            openDesk()
            hideIdlePillForDesk()
        case .noDesk:
            updateStatus("The Desk isn't in this build")
        }
    }

    /// The pill's Desk button.
    @MainActor
    private func showDeskFromPill() {
        guard case .showDesk = DeskSwitchPolicy.pillDeskButton(hasDesk: deskBundle != nil) else { return }
        RunLog.write("desk.switch", "to=desk via=pill")
        openDesk()
        hideIdlePillForDesk()
    }

    /// Back to the Desk: an idle pill steps aside (Codex P2 on #10). It
    /// stays while a dictation runs or finishes, while an outcome still
    /// lingers on it, and when the owner keeps the pill on screen.
    @MainActor
    private func hideIdlePillForDesk() {
        let pillKeptOnScreen = Settings.pillBehavior == .persistent && persistentPillActive
        // An outcome still lingering finishes, then the pill hides rather
        // than coming back over the Desk (Codex P2 on #10, round 4).
        if liveTranscriptWindow.isShowingOutcome, !controller.isBusy, !pillKeptOnScreen {
            liveTranscriptWindow.settleAfterOutcome(returnToReady: false)
        }
        guard DeskSwitchPolicy.hidesPillWhenShowingDesk(
            dictationBusy: controller.isBusy,
            pillShowingOutcome: liveTranscriptWindow.isShowingOutcome,
            pillKeptOnScreen: pillKeptOnScreen
        ) else { return }
        liveTranscriptWindow.hideNow()
    }

    /// After Shrink to Pill: the pill shows, ready, unless a dictation is
    /// running or finishing (its own state stays on the pill).
    @MainActor
    private func showPillAfterShrink() {
        guard !controller.isBusy else { return }
        // An outcome still lingering (a warning such as set-aside words)
        // stays readable; the pill turns ready once it has had its time
        // (Codex P2 on #10).
        if liveTranscriptWindow.isShowingOutcome {
            liveTranscriptWindow.settleAfterOutcome(returnToReady: true)
            return
        }
        liveTranscriptWindow.showReady()
    }

    /// The menu's Desk item: the same as the pill's Desk button, so an idle
    /// pill steps aside however the Desk comes back (Codex P2 on #10).
    @MainActor
    @objc private func openDeskFromMenu() {
        openDesk()
        hideIdlePillForDesk()
    }

    @MainActor
    @objc private func lockDesk() {
        guard let session = deskSessionStorage, session.isOpen else { return }
        session.lockNow(reason: .menu)
    }

    private func refreshDeskMenuItems() {
        let hasDesk = deskBundle != nil
        deskMenuItem.title = hasDesk ? "Desk (invented data)…" : "Desk (not in this build)"
        deskMenuItem.action = hasDesk ? #selector(openDeskFromMenu) : nil
        deskMenuItem.isEnabled = hasDesk
        let open = onMainThread(false) { deskSessionStorage?.isOpen ?? false }
        lockDeskMenuItem.action = open ? #selector(lockDesk) : nil
        lockDeskMenuItem.isEnabled = open
        switchDeskMenuItem.action = hasDesk ? #selector(toggleDeskAndPill) : nil
        switchDeskMenuItem.isEnabled = hasDesk
        switchDeskMenuItem.isHidden = !hasDesk
    }

    /// Whether the Desk window holds the focus, and in what state. Not
    /// focused until the Desk was first opened.
    private func deskFocus() -> DeskDictationPolicy.DeskFocus {
        onMainThread(.notFocused) {
            guard let deskWindowController, let session = deskSessionStorage else { return .notFocused }
            let availability: DeskDictationPolicy.DeskAvailability
            switch session.state {
            case .open: availability = .open
            case .unavailable: availability = .unavailable
            case .locked, .lockedNoStack, .closed: availability = .locked
            }
            return DeskDictationPolicy.focus(deskWindowHoldsFocus: deskWindowController.holdsFocus, availability: availability)
        }
    }

    /// A dictation or correction started with the Desk window in front:
    /// nothing is recorded, typed, pasted, copied or sent, and no outside app
    /// is targeted. Logs identifiers only.
    private func refuseInDesk(_ refusal: DeskDictationPolicy.DeskRefusal, event: String) {
        RunLog.write(event, "reason=desk-\(refusal.logName)")
        let message = Self.deskRefusalMessage(refusal)
        updateStatus(message)
        onMainThread(()) { deskWindowController?.showNotice(message) }
        TextInjector.clearCorrectionContext()
    }

    /// The shield closure and the lock signals. Both do nothing until the
    /// Desk is first opened.
    private func installDeskHooks() {
        TextInjector.deskShieldHoldsBack = { [weak self] input in
            guard Thread.isMainThread else { return false }
            return MainActor.assumeIsolated {
                guard let self,
                      DeskDictationPolicy.shieldBlocksSyntheticInput(deskWindowIsKey: self.deskWindowController?.holdsFocus ?? false)
                else { return false }
                self.noteDeskShieldHeldBack(input)
                return true
            }
        }
        onMainThread(()) {
            // The Desk hides at once on a signal, without waiting for the
            // main queue (an alert may be holding it).
            let lockSignals = DeskLockSignals.locking { [weak self] in self?.deskSessionStorage }
            lockSignals.start()
            deskLockSignals = lockSignals
        }
    }

    /// A new dictation or typed correction: nothing held back yet.
    private func beginDeskShieldScope() {
        deskShieldHeldBack = []
        deskShieldDictationOutcome = nil
    }

    /// Shows a dictation's outcome, or the Desk shield's note when the shield
    /// held back what the outcome claims. The controller has already logged
    /// its own outcome, so the replacement is logged as a correction.
    private func showDictationOutcome(_ outcome: DictationOutcome) {
        deskShieldDictationOutcome = outcome
        if let corrected = outcome.correctedForDeskShield(deskShieldHeldBack) {
            RunLog.write("dictation.outcome.corrected", "\(corrected.logDetail) reason=desk-window-key")
            liveTranscriptWindow.showOutcome(corrected)
        } else {
            liveTranscriptWindow.showOutcome(outcome)
        }
    }

    /// The Desk shield just held input back. While the dictation is still
    /// running or finishing, its outcome is corrected when it comes. After
    /// it, an outcome already shown is corrected now; with no dictation
    /// outcome (a typed correction's paste) the note shows on its own.
    private func noteDeskShieldHeldBack(_ input: DeskDictationPolicy.ShieldedInput) {
        deskShieldHeldBack.insert(input)
        guard !controller.isBusy else { return }
        if let outcome = deskShieldDictationOutcome {
            guard let corrected = outcome.correctedForDeskShield(deskShieldHeldBack) else { return }
            RunLog.write("dictation.outcome.corrected", "\(corrected.logDetail) reason=desk-window-key")
            liveTranscriptWindow.showOutcome(corrected)
        } else if let note = DeskDictationPolicy.shieldNote(heldBack: deskShieldHeldBack) {
            RunLog.write("desk.shield.note", note.logDetail)
            liveTranscriptWindow.showOutcome(.deskInFront(note))
        }
    }

    /// Asked before quitting while the open Desk page holds unsaved work or
    /// cannot say (the reason picks the words). Only the second button quits.
    @MainActor
    private func confirmQuitLosingDeskChanges(_ reason: DeskUnsavedWork) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        return DeskUnsavedWorkWording(.quitApp, reason).makeAlert().runModal() == .alertSecondButtonReturn
    }

    @objc private func openLiveTranscript() {
        liveTranscriptWindow.showWindow(nil)
    }

    @objc private func openLiveTestGuide() {
        liveTestGuideWindow.showWindow(nil)
    }

    @objc private func copyGuidedAcceptanceCommand() {
        let command = Archive.phase2GuidedAcceptanceCommand()
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
        RunLog.write("phase2-guided-acceptance-command.copied")
        updateStatus("Copied guided acceptance command")
    }

    @objc private func openProofDashboard() {
        proofDashboardWindow.showWindow(nil)
    }

    @objc private func openStartHere() {
        do {
            let url = try Archive.writeStartHereReport()
            RunLog.write("start-here.open.requested", url.path)
            NSWorkspace.shared.open(url)
            updateStatus("Opened Start Here")
        } catch {
            RunLog.write("start-here.open.failed", error.localizedDescription)
            updateStatus("Start Here failed")
        }
    }

    @objc private func openPhase2EvidenceReceipt() {
        do {
            let url = try Archive.writePhase2EvidenceReceipt()
            RunLog.write("phase2-evidence-receipt.open.requested", url.path)
            NSWorkspace.shared.open(url)
            updateStatus("Opened Phase 2 evidence receipt")
        } catch {
            RunLog.write("phase2-evidence-receipt.open.failed", error.localizedDescription)
            updateStatus("Phase 2 receipt failed")
        }
    }

    @objc private func openCrossAppTargetCoverage() {
        do {
            let url = try Archive.writeCrossAppTargetCoverageReport()
            RunLog.write("cross-app-target-coverage.open.requested", url.path)
            NSWorkspace.shared.open(url)
            updateStatus("Opened cross-app targets")
        } catch {
            RunLog.write("cross-app-target-coverage.open.failed", error.localizedDescription)
            updateStatus("Cross-app targets failed")
        }
    }

    @objc private func openHermesAcceptance() {
        do {
            let url = try Archive.writeHermesAcceptanceReport()
            RunLog.write("hermes-acceptance.open.requested", url.path)
            NSWorkspace.shared.open(url)
            updateStatus("Opened Hermes Acceptance")
        } catch {
            RunLog.write("hermes-acceptance.open.failed", error.localizedDescription)
            updateStatus("Hermes Acceptance failed")
        }
    }

    @objc private func openAppCompatibilityReport() {
        do {
            let url = try Archive.writeAppCompatibilityReport()
            RunLog.write("app-compatibility.open.requested", url.path)
            NSWorkspace.shared.open(url)
            updateStatus("Opened app compatibility")
        } catch {
            RunLog.write("app-compatibility.open.failed", error.localizedDescription)
            updateStatus("App compatibility failed")
        }
    }

    @objc private func openLiveProofSummary() {
        do {
            let url = try Archive.writeLiveProofSummary()
            RunLog.write("live-proof-summary.open.requested", url.path)
            NSWorkspace.shared.open(url)
            updateStatus("Opened live proof summary")
        } catch {
            RunLog.write("live-proof-summary.open.failed", error.localizedDescription)
            updateStatus("Live proof summary failed")
        }
    }

    @objc private func recordSafeProof() {
        recordLiveProof(label: "safe")
    }

    @objc private func recordPasteProof() {
        recordLiveProof(label: "paste")
    }

    @objc private func recordReprocessProof() {
        recordLiveProof(label: "reprocess")
    }

    @objc private func recordLivePasteProof() {
        recordLiveProof(label: "live-paste")
    }

    @objc private func recordRealtimeTargetProof() {
        recordLiveProof(label: "realtime-target")
    }

    @objc private func recordCorrectionProof() {
        recordLiveProof(label: "correction")
    }

    private func recordLiveProof(label: String) {
        do {
            _ = try Archive.recordLiveProof(label: label)
            let summary = try Archive.writeLiveProofSummary()
            RunLog.write("live-proof.menu-recorded", "label=\(label) summary=\(summary.path)")
            NSWorkspace.shared.open(summary)
            updateStatus("Recorded \(label) proof")
        } catch {
            RunLog.write("live-proof.record.failed", "label=\(label) error=\(error.localizedDescription)")
            updateStatus("Proof failed: \(error.localizedDescription)")
        }
    }

    @objc private func openDiagnostics() {
        diagnosticsWindow.showWindow(nil)
    }

    @objc private func exportDiagnostics() {
        do {
            let url = try DiagnosticsReport.export()
            updateStatus("Diagnostics exported")
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } catch {
            updateStatus("Diagnostics export failed")
            RunLog.write("diagnostics.export.failed", error.localizedDescription)
        }
    }

    @objc private func openLatestDiagnostics() {
        guard let url = latestDiagnosticsURL() else {
            updateStatus("No diagnostics report yet")
            return
        }
        RunLog.write("diagnostics.latest.open.requested", url.path)
        NSWorkspace.shared.open(url)
    }

    private func latestDiagnosticsURL() -> URL? {
        guard let children = try? FileManager.default.contentsOfDirectory(
            at: Archive.diagnostics,
            includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            return nil
        }

        return children
            .filter { url in
                url.pathExtension.lowercased() == "md" &&
                    ((try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) ?? false)
            }
            .max { lhs, rhs in
                let left = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let right = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return left < right
            }
    }

    @objc private func openMicrophoneSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func openSpeechRecognitionSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func openAccessibilitySettings() {
        _ = TextInjector.requestAccessibilityPermission()
        revealCurrentAppForPermissions()
        if !TextInjector.canAutoPaste {
            showAccessibilityInstructions()
        } else {
            updateStatus("Accessibility granted")
        }
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func revealCurrentAppForPermissions() {
        let appURL = Bundle.main.bundleURL
        NSWorkspace.shared.activateFileViewerSelecting([appURL])
        RunLog.write("permission.app.revealed", "path=\(appURL.path)")
        updateStatus("Revealed \(AppIdentity.current.appBundleName)")
    }

    @objc private func copyCurrentAppPath() {
        let path = Bundle.main.bundleURL.path
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(path, forType: .string)
        RunLog.write("permission.app-path.copied", "path=\(path)")
        updateStatus("Copied app path")
    }

    private func showAccessibilityInstructions() {
        let alert = NSAlert()
        if AppIdentity.current.isTest {
            alert.messageText = "Enable Accessibility for True Convo Test"
            alert.informativeText = [
                "Finder is highlighting True Convo Test, the app that is currently running.",
                "In System Settings > Privacy & Security > Accessibility, add or enable True Convo Test.",
                "Leave the True Convo entry exactly as it is: that is your real app. If an older True Convo Test entry is there, remove only that one, then add the highlighted app and relaunch True Convo Test."
            ].joined(separator: "\n\n")
        } else {
            alert.messageText = "Enable Accessibility for this exact True Convo app"
            alert.informativeText = [
                "Finder is highlighting the app that is currently running.",
                "In System Settings > Privacy & Security > Accessibility, add or enable that exact app.",
                "If you see older entries (Convo Cursor, Voice Cursor, or an earlier True Convo), remove them first, then add the highlighted app and relaunch True Convo."
            ].joined(separator: "\n\n")
        }
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Open Settings")
        alert.runModal()
        RunLog.write("permission.accessibility.instructions-shown", "trusted=\(TextInjector.canAutoPaste)")
    }

    @objc private func quit() {
        // Asked before shutdown, because shutdown makes dictation refuse for
        // the rest of the run.
        if let session = onMainThread(nil, { deskSessionStorage.flatMap { $0.isOpen ? $0 : nil } }) {
            // The question and the quit run outside any task, so the Desk's
            // lock, its close and the 3-second limit keep running (quitting
            // from inside a task hung with the Desk open).
            onMainThread(()) {
                DeskTermination.quitAfterAsking(
                    session: session,
                    confirmLosingChanges: { [weak self] reason in self?.confirmQuitLosingDeskChanges(reason) ?? false },
                    kept: { reason in RunLog.write("app.quit.kept", "reason=desk-\(reason.logName)") },
                    quit: { [weak self] in
                        self?.quitAskedAboutDesk = true
                        self?.quitNow()
                    }
                )
            }
            return
        }
        quitNow()
    }

    private func quitNow() {
        controller.shutdown()
        NSApp.terminate(nil)
    }

    private func refreshMenuState() {
        for item in providerMenuItems {
            item.state = (item.representedObject as? String) == Settings.provider.rawValue ? .on : .off
        }
        for item in modelPresetMenuItems {
            item.state = (item.representedObject as? String) == ModelPreset.currentId() ? .on : .off
        }
        for item in audioInputMenuItems {
            item.state = (item.representedObject as? String) == Settings.audioInputDeviceUID ? .on : .off
            if (item.representedObject as? String) == AudioDeviceInfo.systemDefaultUID {
                item.title = AudioDeviceInfo.selectedInputLabel()
            }
        }
        for item in wakeSensitivityMenuItems {
            item.state = (item.representedObject as? String) == Settings.wakeSensitivity.rawValue ? .on : .off
        }
        for item in archiveMenuItems {
            item.state = (item.representedObject as? String) == Settings.archiveFormat.rawValue ? .on : .off
        }
        for item in completionActionMenuItems {
            item.state = (item.representedObject as? String) == Settings.completionAction.rawValue ? .on : .off
        }
        for item in hotKeyModeMenuItems {
            item.state = (item.representedObject as? String) == Settings.hotKeyMode.rawValue ? .on : .off
        }
        for item in hotKeyShortcutMenuItems {
            item.state = (item.representedObject as? String) == Settings.hotKeyShortcut.rawValue ? .on : .off
        }
        for item in pillBehaviorMenuItems {
            item.state = (item.representedObject as? String) == Settings.pillBehavior.rawValue ? .on : .off
        }
        for item in insertionTimingMenuItems {
            item.state = (item.representedObject as? String) == InsertionTiming.current.rawValue ? .on : .off
        }
        for item in insertionModeMenuItems {
            item.state = (item.representedObject as? String) == Settings.insertionMode.rawValue ? .on : .off
        }
        for item in finalRewriteMenuItems {
            item.state = (item.representedObject as? String) == Settings.finalRewriteMode.rawValue ? .on : .off
        }
        autoStopMenuItem?.state = Settings.autoStop ? .on : .off
        livePasteMenuItem?.state = Settings.livePasteAppleFinals ? .on : .off
        livePreviewMenuItem?.state = Settings.liveInsertApplePartials ? .on : .off
        spokenPunctuationMenuItem?.state = Settings.spokenPunctuationCommands ? .on : .off
        retainAudioMenuItem?.state = Settings.dictationPreferences.retainAudioForHarvest ? .on : .off
        correctionCaptureMenuItem?.state = Settings.captureSelectionCorrections ? .on : .off
        let readiness = ProviderReadiness.current()
        providerReadinessMenuItem.title = readiness.menuText
        providerReadinessMenuItem.toolTip = readiness.ready
            ? readiness.statusText
            : "Open Settings and save the required cloud API key before using this provider."
        privacyHarvestMenuItem.title = privacyHarvestSummaryTitle()
        privacyHarvestMenuItem.toolTip = privacyHarvestSummaryTooltip()
        for item in correctionOnceMenuItems {
            item.isEnabled = !controller.isBusy && !isHotKeySuppressed()
        }
        liveTranscriptWindow.refreshSettingsControls()
    }

    private func privacyHarvestSummaryTitle() -> String {
        let harvest = Settings.captureSelectionCorrections ? "Harvest: Review on" : "Harvest: Off"
        let audio = Settings.audioIsRetainedForCurrentProvider ? "Audio: Retained locally" : "Audio: Not retained"
        let savedPreference = Settings.dictationPreferences.retainAudioForHarvest ? " | Saved retention: On" : ""
        let training: String
        switch Settings.provider {
        case .appleLocal, .localWhisper, .appleSpeechAnalyzer:
            training = "Training: Review only"
        case .openAIRealtime, .openAICloud, .groqCloud:
            training = "Training: Cloud blocked"
        }
        return "\(harvest) | \(audio)\(savedPreference) | \(training)"
    }

    private func privacyHarvestSummaryTooltip() -> String {
        let processing = ProcessingContext.forProvider(Settings.provider.rawValue, captureMode: nil)
        let harvest = Settings.captureSelectionCorrections
            ? "Convo Engine Harvest correction capture is on; captured rows still require human review."
            : "Convo Engine Harvest correction capture is off."
        let audio = Settings.providerMakesNoRecording
            ? "No audio is recorded or kept with this engine."
            : (Settings.dictationPreferences.retainAudioForHarvest
                ? "Raw audio is retained locally for Harvest/reprocess review."
                : "Temporary raw audio is deleted after transcription.")
        let savedNotice = Settings.dictationPreferences.savedRetentionNotice.map { " \($0)" } ?? ""
        return "\(Settings.provider.label): \(Settings.provider.privacyLabel). \(harvest) \(audio)\(savedNotice) \(processing.trainingPromotionBoundary)"
    }

    private func refreshDictationControls() {
        scratchpadWindow.updateDictationState(
            isRecording: controller.isRecording,
            isBusy: controller.isBusy
        )
        liveTranscriptWindow.updateDictationState(
            isRecording: controller.isRecording,
            isBusy: controller.isBusy,
            keepVisible: Settings.pillBehavior == .persistent && persistentPillActive
        )
    }

    private func rememberCursorTarget(_ application: NSRunningApplication?, force: Bool = false) {
        guard force || !cursorTargetLockedForDictation else {
            return
        }
        guard let application,
              !application.isTerminated,
              application.bundleIdentifier != Bundle.main.bundleIdentifier,
              // True Convo Test also skips the real app's windows; the real
              // app skips only itself, as before.
              !AppIdentity.current.isOtherTrueConvoCopy(bundleIdentifier: application.bundleIdentifier)
        else {
            return
        }
        TextInjector.targetApplication = application
        RunLog.write(
            "cursor-target.remembered",
            "bundle=\(application.bundleIdentifier ?? "unknown") name=\(application.localizedName ?? "unknown")"
        )
    }

    private func unlockCursorTargetAfterPasteWindow() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            guard let self else { return }
            self.cursorTargetLockedForDictation = false
            RunLog.write("cursor-target.unlocked", TextInjector.targetDescription)
        }
    }

    private func updateStatus(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let short = trimmed.count > 42 ? String(trimmed.suffix(42)) : trimmed
        statusMenuItem.title = short.isEmpty ? "Idle" : short
        refreshStatusButtonTitle()
    }

    private func refreshStatusButtonTitle() {
        if !controller.isRecording {
            latestInputLevel = 0
        }
        configureStatusItemButton(statusItem?.button)
    }

    private func configureStatusItemButton(_ button: NSStatusBarButton?) {
        guard let button else { return }
        let name = AppIdentity.current.displayName
        button.title = AppIdentity.current.isTest ? "Test" : ""
        button.image = statusItemImage()
        button.imagePosition = AppIdentity.current.isTest ? .imageLeft : .imageOnly
        button.toolTip = controller.isRecording
            ? "\(name) is recording"
            : controller.isBusy ? "\(name) is finishing transcription" : name
    }

    private func statusItemImage() -> NSImage? {
        if let url = Bundle.main.url(forResource: "TrueConvoIcon", withExtension: "png"),
           let image = NSImage(contentsOf: url) {
            image.size = NSSize(width: 18, height: 18)
            image.isTemplate = true
            return image
        }
        if #available(macOS 11.0, *),
           let image = NSImage(systemSymbolName: "waveform", accessibilityDescription: AppIdentity.current.displayName) {
            image.size = NSSize(width: 18, height: 18)
            image.isTemplate = true
            return image
        }
        return nil
    }
}

// True Convo Test only: refuse an archive folder that is not its own, and
// quit, before anything (even the run log) reads or writes it.
TestArchiveLaunchCheck.quitIfTestArchiveIsNotItsOwn()

OpenAIRealtimeSmoke.runIfRequested()

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
