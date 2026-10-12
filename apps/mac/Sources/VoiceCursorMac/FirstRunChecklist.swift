import AppKit
import ApplicationServices
import AVFoundation
import Speech

final class FirstRunChecklistWindowController: NSWindowController {
    private let textView = NSTextView()
    private let openDiagnostics: () -> Void
    private let openSettings: () -> Void
    private let openScratchpad: () -> Void
    private let openLiveTranscript: () -> Void
    private let openLiveTestGuide: () -> Void
    private let openArchiveHistory: () -> Void
    private let exportDiagnostics: () -> Void
    private let openMicrophoneSettings: () -> Void
    private let openSpeechRecognitionSettings: () -> Void
    private let openAccessibilitySettings: () -> Void
    private let settingsChanged: () -> Void

    init(
        openDiagnostics: @escaping () -> Void,
        openSettings: @escaping () -> Void,
        openScratchpad: @escaping () -> Void,
        openLiveTranscript: @escaping () -> Void,
        openLiveTestGuide: @escaping () -> Void,
        openArchiveHistory: @escaping () -> Void,
        exportDiagnostics: @escaping () -> Void,
        openMicrophoneSettings: @escaping () -> Void,
        openSpeechRecognitionSettings: @escaping () -> Void,
        openAccessibilitySettings: @escaping () -> Void,
        settingsChanged: @escaping () -> Void
    ) {
        self.openDiagnostics = openDiagnostics
        self.openSettings = openSettings
        self.openScratchpad = openScratchpad
        self.openLiveTranscript = openLiveTranscript
        self.openLiveTestGuide = openLiveTestGuide
        self.openArchiveHistory = openArchiveHistory
        self.exportDiagnostics = exportDiagnostics
        self.openMicrophoneSettings = openMicrophoneSettings
        self.openSpeechRecognitionSettings = openSpeechRecognitionSettings
        self.openAccessibilitySettings = openAccessibilitySettings
        self.settingsChanged = settingsChanged

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 570),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "True Convo First Run"
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
        scrollView.heightAnchor.constraint(greaterThanOrEqualToConstant: 430).isActive = true
        stack.addArrangedSubview(scrollView)

        let buttonRows = NSStackView()
        buttonRows.orientation = .vertical
        buttonRows.spacing = 8

        let rowOne = NSStackView()
        rowOne.orientation = .horizontal
        rowOne.spacing = 8
        rowOne.addArrangedSubview(button("Refresh", #selector(refresh)))
        rowOne.addArrangedSubview(button("Diagnostics", #selector(showDiagnostics)))
        rowOne.addArrangedSubview(button("Settings", #selector(showSettings)))
        rowOne.addArrangedSubview(button("Scratchpad", #selector(showScratchpad)))
        rowOne.addArrangedSubview(button("Live Transcript", #selector(showLiveTranscript)))
        rowOne.addArrangedSubview(button("Live Test Guide", #selector(showLiveTestGuide)))
        rowOne.addArrangedSubview(button("Close", #selector(closeWindow)))
        buttonRows.addArrangedSubview(rowOne)

        let rowTwo = NSStackView()
        rowTwo.orientation = .horizontal
        rowTwo.spacing = 8
        rowTwo.addArrangedSubview(button("Request Mic + Speech", #selector(requestMicAndSpeechPermissions)))
        rowTwo.addArrangedSubview(button("Use Safe Test Settings", #selector(useSafeTestSettings)))
        rowTwo.addArrangedSubview(button("Use Paste Test Settings", #selector(usePasteTestSettings)))
        rowTwo.addArrangedSubview(button("Use Live Paste Test Settings", #selector(useLivePasteTestSettings)))
        buttonRows.addArrangedSubview(rowTwo)

        let rowThree = NSStackView()
        rowThree.orientation = .horizontal
        rowThree.spacing = 8
        rowThree.addArrangedSubview(button("Microphone Pane", #selector(showMicrophonePane)))
        rowThree.addArrangedSubview(button("Speech Pane", #selector(showSpeechPane)))
        rowThree.addArrangedSubview(button("Accessibility Pane", #selector(showAccessibilityPane)))
        rowThree.addArrangedSubview(button("Archive History", #selector(showArchiveHistory)))
        rowThree.addArrangedSubview(button("Export Diagnostics", #selector(exportDiagnosticsReport)))
        buttonRows.addArrangedSubview(rowThree)

        stack.addArrangedSubview(buttonRows)
    }

    private func button(_ title: String, _ action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        return button
    }

    @objc private func refresh() {
        textView.string = Self.report()
    }

    @objc private func showDiagnostics() {
        openDiagnostics()
    }

    @objc private func showSettings() {
        openSettings()
    }

    @objc private func showScratchpad() {
        openScratchpad()
    }

    @objc private func showLiveTranscript() {
        openLiveTranscript()
    }

    @objc private func showLiveTestGuide() {
        openLiveTestGuide()
    }

    @objc private func showArchiveHistory() {
        openArchiveHistory()
    }

    @objc private func exportDiagnosticsReport() {
        exportDiagnostics()
    }

    @objc private func requestMicAndSpeechPermissions() {
        RunLog.write("first-run.permission-request.clicked")
        let group = DispatchGroup()

        group.enter()
        AVCaptureDevice.requestAccess(for: .audio) { allowed in
            RunLog.write("first-run.microphone.result", allowed ? "granted" : "denied")
            group.leave()
        }

        group.enter()
        SFSpeechRecognizer.requestAuthorization { status in
            RunLog.write("first-run.speech.result", String(describing: status))
            group.leave()
        }

        group.notify(queue: .main) { [weak self] in
            self?.refresh()
        }
    }

    @objc private func useSafeTestSettings() {
        Settings.provider = .appleLocal
        Settings.archiveFormat = .flac
        Settings.completionAction = .archiveOnly
        Settings.autoStop = true
        Settings.livePasteAppleFinals = false
        Settings.autoStopDelaySeconds = 2.6
        RunLog.write("first-run.safe-test-settings.applied")
        settingsChanged()
        refresh()
    }

    @objc private func usePasteTestSettings() {
        Settings.provider = .appleLocal
        Settings.archiveFormat = .flac
        Settings.completionAction = .autoPaste
        Settings.autoStop = true
        Settings.livePasteAppleFinals = false
        Settings.autoStopDelaySeconds = 2.6
        RunLog.write("first-run.paste-test-settings.applied")
        settingsChanged()
        refresh()
    }

    @objc private func useLivePasteTestSettings() {
        Settings.provider = .appleLocal
        Settings.archiveFormat = .flac
        Settings.completionAction = .autoPaste
        Settings.autoStop = true
        Settings.livePasteAppleFinals = true
        Settings.autoStopDelaySeconds = 2.6
        RunLog.write("first-run.live-paste-test-settings.applied")
        settingsChanged()
        refresh()
    }

    @objc private func showMicrophonePane() {
        openMicrophoneSettings()
    }

    @objc private func showSpeechPane() {
        openSpeechRecognitionSettings()
    }

    @objc private func showAccessibilityPane() {
        openAccessibilitySettings()
    }

    @objc private func closeWindow() {
        window?.close()
    }

    private static func report() -> String {
        [
            "True Convo First-Run Checklist",
            "",
            "1. Confirm basic readiness",
            "   \(statusLine("Microphone permission", microphoneStatus()))",
            "   \(statusLine("Speech Recognition permission", speechStatus()))",
            "   \(statusLine("Accessibility permission", AXIsProcessTrusted() ? "granted" : "not granted"))",
            "   \(audioInputStatusLine())",
            "   \(statusLine("Whisper binary", FileManager.default.isExecutableFile(atPath: Settings.whisperBinary) ? "ready" : "missing"))",
            "   \(statusLine("ffmpeg binary", FileManager.default.isExecutableFile(atPath: Settings.ffmpegBinary) ? "ready" : "missing"))",
            "",
            "2. Pick the first test provider",
            "   Recommended: Apple Local",
            "   First pass: Use Safe Test Settings archives only, with no paste.",
            "   Second pass: Use Paste Test Settings pastes into Scratchpad.",
            "   Live feel pass: Use Live Paste Test Settings pastes finalized Apple chunks while recording.",
            "   Later passes: use Provider/Model Preset to compare Local Whisper, OpenAI, or Groq.",
            "   Fallback: Local Whisper, OpenAI, and Groq can still record mic audio if Speech Recognition is unavailable; live text appears after stop.",
            "   Current: \(Settings.provider.label)",
            "   After dictation: \(Settings.completionAction.label)",
            "   Live paste Apple finals: \(Settings.livePasteAppleFinals ? "enabled" : "disabled")",
            "   Auto-stop: \(Settings.autoStop ? "enabled" : "disabled") (\(String(format: "%.1f", Settings.autoStopDelaySeconds))s pause)",
            "",
            "3. Open Scratchpad and Live Transcript",
            "   Use Scratchpad as the paste target. Use Cmd+D to start or stop dictation.",
            "   Use Live Transcript to watch live text.",
            "   Use Live Test Guide for the exact marker and verifier commands.",
            "",
            "4. Verify saved text and recording behavior",
            "   History: \(Archive.history.path)",
            "   Audio retention: \(Settings.audioIsRetainedForCurrentProvider ? "on; recordings saved in \(Archive.recordings.path)" : "off for this engine; temporary audio is removed after use")",
            "   Saved recording preference: \(Settings.dictationPreferences.retainAudioForHarvest ? "on" : "off") (existing recordings are unchanged)",
            "   Transcripts: \(Archive.transcripts.path)",
            "   Content packets: \(Archive.packets.path)",
            "   Latest transcript: \(Archive.latestTranscript.path)",
            "   Latest content packet: \(Archive.latestContentPacket.path)",
            "   Latest session JSON: \(Archive.latestSession.path)",
            "   Timing report: \(Archive.timingReport.path)",
            "   Harvest inbox: \(Archive.harvestInbox.path)",
            "   Latest harvest bundle: \(Archive.latestHarvestBundle.path)",
            "   Harvest bundles: \(Archive.harvestBundles.path)",
            "   Live proof JSON: \(Archive.liveProof.path)",
            "   Live proof summary: \(Archive.liveProofSummary.path)",
            "   Latest provider comparison: \(Archive.latestProviderComparison.path)",
            "   Diagnostics: \(Archive.diagnostics.path)",
            "   Run log: \(Archive.runLog.path)",
            "   Use Archive History to browse, copy content packets, and open previous sessions.",
            "",
            "5. After Apple Local works",
            "   Try Local Whisper, then cloud providers only after keys are saved in Settings.",
            "   If you explicitly kept a recording, Compare Latest Audio Across Ready Provider Presets can benchmark models on that recording. Audio retention is optional.",
            "",
            "This checklist does not start recording. Permission requests happen only if you click Request Mic + Speech.",
        ].joined(separator: "\n")
    }

    private static func statusLine(_ label: String, _ value: String, ready: Bool? = nil) -> String {
        let readyValues = ["granted", "ready", "yes"]
        let isReady = ready ?? readyValues.contains(value)
        let marker = isReady ? "[ready]" : "[needed]"
        return "\(marker) \(label): \(value)"
    }

    private static func audioInputStatusLine() -> String {
        let input = currentAudioInput()
        return statusLine("Default audio input", input, ready: input != "none visible")
    }

    private static func microphoneStatus() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not determined"
        @unknown default: return "unknown"
        }
    }

    private static func speechStatus() -> String {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not determined"
        @unknown default: return "unknown"
        }
    }

    private static func currentAudioInput() -> String {
        AVCaptureDevice.default(for: .audio)?.localizedName ?? "none visible"
    }
}
