import AppKit
import ApplicationServices
import AVFoundation
import Speech

enum LiveTestGuide {
    static var url: URL {
        Archive.root.appendingPathComponent("voice-cursor-live-test-guide.md")
    }

    static func make() -> String {
        [
            "# True Convo Live Test Guide",
            "",
            "Generated: \(ISO8601DateFormatter().string(from: Date()))",
            "",
            "This guide is read-only. It does not request permissions, start recording, paste text, call cloud providers, or run local Whisper.",
            "Use Open Start Here if you want one local report with readiness, proof status, stable paths, and the next live-test steps.",
            "",
            "## Current Readiness",
            "",
            "- Microphone: \(microphoneStatus())",
            "- Speech Recognition: \(speechStatus())",
            "- Accessibility: \(AXIsProcessTrusted() ? "granted" : "not granted")",
            "- Default audio input: \(currentAudioInput())",
            "- Provider: \(Settings.provider.label)",
            "- After dictation: \(Settings.completionAction.label)",
            "- Archive format: \(Settings.archiveFormat.label)",
            "- Auto-stop: \(Settings.autoStop ? "enabled" : "disabled") (\(String(format: "%.1f", Settings.autoStopDelaySeconds))s pause)",
            "- Live paste Apple finals: \(Settings.livePasteAppleFinals ? "enabled" : "disabled")",
            "",
            "## Before Launch",
            "",
            "From the repo folder:",
            "",
            "```bash",
            "npm run verify:noninvasive",
            "npm run live-test:preflight",
            "```",
            "",
            "For the shortest post-install Phase 2 path, run:",
            "",
            "```bash",
            "npm run live-test:phase2-guide",
            "npm run phase2:guided-acceptance",
            "npm run verify:phase2-proof",
            "npm run phase2:evidence-bundle",
            "```",
            "",
            "From the app, choose Expert Tools > Proof & Diagnostics > Copy Guided Acceptance Command to copy the guided acceptance command with the repo path included.",
            "",
            "`live-test:phase2-guide` is read-only. `phase2:guided-acceptance` still requires you to click target fields and speak the phrases, but it writes the markers and runs the verifiers in order after the newest app is installed. `verify:phase2-proof` reruns the final Phase 2 proof summary once those markers exist. `phase2:evidence-bundle` prints the concise release receipt.",
            "",
            "## Pass 1: Safe Archive-Only",
            "",
            "1. Open First Run Checklist.",
            "2. Click Use Safe Test Settings.",
            "3. Click Request Mic + Speech and approve macOS prompts.",
            "4. Open Live Transcript.",
            "5. Run:",
            "",
            "```bash",
            "npm run live-test:mark-safe",
            "```",
            "",
            "6. Start dictation and say exactly: voice cursor safe test",
            "7. Stop dictation or wait for auto-stop.",
            "8. Run:",
            "",
            "```bash",
            "npm run verify:live-safe",
            "```",
            "",
            "App shortcut: after this pass, choose Record Safe Proof From Latest Session. The terminal verifier also checks marker freshness.",
            "",
            "## Pass 2: Paste In Scratchpad",
            "",
            "1. Click Use Paste Test Settings.",
            "2. Open Scratchpad and click inside the text area.",
            "3. Run:",
            "",
            "```bash",
            "npm run live-test:mark-paste",
            "```",
            "",
            "4. Start dictation and say exactly: voice cursor paste test",
            "5. Confirm the sentence appears in Scratchpad.",
            "6. Run:",
            "",
            "```bash",
            "npm run verify:live-paste",
            "```",
            "",
            "App shortcut: after this pass, choose Record Paste Proof From Latest Session. The terminal verifier also checks marker freshness.",
            "",
            "## Pass 3: Reprocess Retained Audio",
            "",
            "1. Choose Provider/Model Preset > Local Whisper / small.",
            "2. Run:",
            "",
            "```bash",
            "npm run live-test:mark-reprocess",
            "```",
            "",
            "3. Choose Reprocess Latest Audio With Selected Provider.",
            "4. Wait for the menu status to finish.",
            "5. Run:",
            "",
            "```bash",
            "npm run verify:live-reprocess",
            "```",
            "",
            "App shortcut: after this pass, choose Record Reprocess Proof From Latest Session.",
            "",
            "## Optional Pass 4: Live Paste Feel",
            "",
            "1. Open First Run Checklist.",
            "2. Click Use Live Paste Test Settings.",
            "3. Open Scratchpad and click inside the text area.",
            "4. Run:",
            "",
            "```bash",
            "npm run live-test:mark-live-paste",
            "```",
            "",
            "5. Start dictation and say exactly: voice cursor live paste test",
            "6. Finalized Apple chunks should paste while recording.",
            "7. Run:",
            "",
            "```bash",
            "npm run verify:live-paste-mode",
            "```",
            "",
            "App shortcut: after this pass, choose Record Live Paste Proof From Latest Session.",
            "",
            "## Phase 2 Pass: OpenAI Realtime Target Proof",
            "",
            "Use this after installing the newest signed app. It proves the fast cloud-streaming lane, target metadata, and finishing-tail behavior in the app you actually clicked.",
            "",
            "1. Choose Provider/Model Preset > OpenAI Realtime / gpt-realtime-whisper.",
            "2. Set After Dictation to Auto Paste and keep Live Cursor Preview enabled.",
            "3. Click into Hermes, Codex, Apple Notes, or TextEdit where text should appear.",
            "4. Run:",
            "",
            "```bash",
            "npm run live-test:mark-realtime-target",
            "```",
            "",
            "5. Press Cmd+D and say exactly: convo cursor realtime target test",
            "6. After the last word, wait for auto-stop unless you need Cmd+D as a manual stop. The pill should show its finishing state until the tail is settled.",
            "7. Run:",
            "",
            "```bash",
            "npm run verify:live-realtime-target",
            "npm run verify:live-proof",
            "```",
            "",
            "App shortcut: after this pass, choose Record OpenAI Realtime Target Proof, then Open Live Proof Summary. The terminal verifier also checks marker freshness and target metadata.",
            "",
            "## Phase 2 Pass: Cross-App Target Coverage",
            "",
            "Use this after installing the newest signed app. It proves Hermes, Codex, Apple Notes, and TextEdit have real target metadata in the local archive.",
            "",
            "1. Keep the provider/mode you are qualifying. For the fast Phase 2 lane, use OpenAI Realtime / gpt-realtime-whisper.",
            "2. Run:",
            "",
            "```bash",
            "npm run live-test:mark-cross-app-targets",
            "```",
            "",
            "3. In each app, click the target text field, press Cmd+D, say the phrase, then wait for auto-stop and the finishing state before moving on:",
            "",
            "- Hermes: convo cursor Hermes target check",
            "- Codex: convo cursor Codex target check",
            "- Apple Notes: convo cursor Apple Notes target check",
            "- TextEdit: convo cursor TextEdit target check",
            "",
            "4. Run:",
            "",
            "```bash",
            "npm run verify:cross-app-targets:marked",
            "```",
            "",
            "The verifier reports only app/session metadata, not transcript text or audio.",
            "",
            "## Optional Pass 5: Hermes Live-Insertion Safety",
            "",
            "1. Run:",
            "",
            "```bash",
            "npm run live-test:mark-hermes-safety",
            "```",
            "",
            "2. In Hermes, click the active message box.",
            "3. Start True Convo with Cmd+D, speak a long passage with normal punctuation pauses, then wait for auto-stop unless you need Cmd+D as a manual stop.",
            "4. For the edge-case pass, start another dictation, move the cursor or select a word while True Convo is still open, then stop.",
            "5. Run:",
            "",
            "```bash",
            "npm run verify:hermes-live-safety:marked",
            "```",
            "",
            "This catches live keyboard rewrites, late final rewrites, late pastes or clipboard fallback after clicking away, foreground post-stop lag, and post-stop hotkey blocking.",
            "",
            "## Optional Pass 6: Hermes Correction Capture",
            "",
            "Before speaking, choose Expert Tools > Proof & Diagnostics > Use Hermes Recommended Settings.",
            "",
            "Before the Hermes pass, prepare the signed app and reset the marker:",
            "",
            "```bash",
            "npm run hermes:acceptance-prep",
            "```",
            "",
            "That command builds, installs, launches, and resets the Hermes live-safety marker only after the launched app logs the installed executable hash.",
            "",
            "1. Keep Hermes focused in the active message box.",
            "2. Type this deliberately wrong word: deecay",
            "3. Highlight exactly deecay.",
            "4. Press Cmd+D and speak the replacement. With Hermes Recommended Settings, highlighted text is captured as a correction when dictation starts.",
            "   Alternate strict path: from the True Convo menu, choose Expert Tools > Insertion & Models > Corrections & Convo Engine > Correct Selected Text Once.",
            "5. Say exactly: decay",
            "6. Stop with Cmd+D and wait for the pill to disappear before moving to another Hermes thread.",
            "7. Run:",
            "",
            "```bash",
            "npm run phase2:guided-acceptance",
            "npm run verify:phase2-proof",
            "npm run phase2:evidence-bundle",
            "npm run phase2:correction-handoff:marked",
            "npm run verify:hermes-acceptance",
            "```",
            "",
            "The guided acceptance command walks through the live Realtime, cross-app, and correction proof sequence after install. The Phase 2 proof command reruns the final Realtime target summary after the guided markers exist. The evidence bundle command prints the concise release receipt. The Phase 2 correction handoff command verifies the post-marker correction row, writes post-marker correction candidates, and writes the local review queue. The Hermes acceptance command is the final all-clear check: it runs the Hermes live-safety verifier, the post-marker correction handoff check, a dry-run Convo Engine correction export with --after-marker --dry-run --require-candidates, and the strict finish gate. The finish gate should show Correction evidence: ready. Correction rows and review queues are local evidence, not automatic model training data.",
            "",
            "## Output Paths",
            "",
            "- History: \(Archive.history.path)",
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
            "- Live proof JSON: \(Archive.liveProof.path)",
            "- Live proof summary: \(Archive.liveProofSummary.path)",
            "- Latest provider comparison: \(Archive.latestProviderComparison.path)",
            "- Live test proof: \(Archive.root.appendingPathComponent("live-test-proof.json").path)",
            "- Run log: \(Archive.runLog.path)",
            "",
            "## Recovery",
            "",
            "- If permission prompts do not appear, open the Microphone, Speech Recognition, or Accessibility pane from the True Convo menu.",
            "- If a pass fails, open Diagnostics, Export Diagnostics, and Open Run Log.",
            "- Keep cloud providers for reprocess tests after Apple Local capture and paste are proven.",
            "",
        ].joined(separator: "\n")
    }

    static func write() throws -> URL {
        try Archive.ensureDirectories()
        let body = make()
        try body.write(to: url, atomically: true, encoding: .utf8)
        RunLog.write("live-test-guide.exported", url.path)
        return url
    }

    private static func microphoneStatus() -> String {
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

    private static func speechStatus() -> String {
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

    private static func currentAudioInput() -> String {
        AVCaptureDevice.default(for: .audio)?.localizedName ?? "none visible"
    }
}

final class LiveTestGuideWindowController: NSWindowController {
    private let textView = NSTextView()
    private let statusLabel = NSTextField(labelWithString: "")

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 620),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "True Convo Live Test Guide"
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
        scrollView.heightAnchor.constraint(greaterThanOrEqualToConstant: 510).isActive = true
        stack.addArrangedSubview(scrollView)

        statusLabel.textColor = .secondaryLabelColor
        statusLabel.font = .systemFont(ofSize: 12)
        stack.addArrangedSubview(statusLabel)

        let buttons = NSStackView()
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let refreshButton = NSButton(title: "Refresh", target: self, action: #selector(refresh))
        refreshButton.bezelStyle = .rounded
        let copyButton = NSButton(title: "Copy Guide", target: self, action: #selector(copyGuide))
        copyButton.bezelStyle = .rounded
        let exportButton = NSButton(title: "Export Guide", target: self, action: #selector(exportGuide))
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
        textView.string = LiveTestGuide.make()
        statusLabel.stringValue = "Refreshed"
    }

    @objc private func copyGuide() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(textView.string, forType: .string)
        statusLabel.stringValue = "Copied guide"
    }

    @objc private func exportGuide() {
        do {
            let url = try LiveTestGuide.write()
            statusLabel.stringValue = "Exported \(url.path)"
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } catch {
            statusLabel.stringValue = "Export failed: \(error.localizedDescription)"
            RunLog.write("live-test-guide.export.failed", error.localizedDescription)
        }
    }

    @objc private func closeWindow() {
        window?.close()
    }
}
