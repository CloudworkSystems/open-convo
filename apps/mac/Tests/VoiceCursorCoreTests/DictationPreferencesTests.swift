import Foundation
import Testing
@testable import VoiceCursorCore

@Suite("Production dictation preferences")
struct DictationPreferencesTests {
    @Test("Production getter and Hermes preset keep an unset recording choice off")
    func freshProductionPreferencesStayOff() {
        let name = "DictationPreferencesTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = DictationPreferences(defaults: defaults)
        #expect(!preferences.retainAudioForHarvest)
        preferences.applyHermesRecommendedSettings()
        #expect(!preferences.retainAudioForHarvest)
        #expect(defaults.object(forKey: "retainAudioForHarvest") == nil)
        #expect(preferences.savedRetentionNotice == nil)
        #expect(defaults.string(forKey: "provider") == "local-whisper")
        #expect(defaults.string(forKey: "localWhisperModel") == "small")
        #expect(defaults.string(forKey: "archiveAudioFormat") == "flac")
        #expect(defaults.string(forKey: "completionAction") == "auto-paste")
        #expect(defaults.string(forKey: "hotKeyMode") == "press-to-toggle")
        #expect(defaults.string(forKey: "pillBehavior") == "one-shot")
        #expect(defaults.string(forKey: "insertionMode") == "final-paste-only")
        #expect(defaults.string(forKey: "finalRewriteMode") == "keep-live-text")
        #expect(defaults.string(forKey: "wakeSensitivity") == "quiet")
        for key in ["autoStop", "livePasteAppleFinals", "liveInsertApplePartials", "captureSelectionCorrections", "spokenPunctuationCommands"] {
            #expect(defaults.object(forKey: key) != nil)
            #expect(!defaults.bool(forKey: key))
        }
    }

    @Test("Production preset preserves both explicit audio choices and unrelated preferences", arguments: [true, false])
    func presetPreservesExistingChoice(enabled: Bool) {
        let name = "DictationPreferencesTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set(enabled, forKey: "retainAudioForHarvest")
        defaults.set("invented-unrelated-value", forKey: "unrelated-setting")
        let preferences = DictationPreferences(defaults: defaults)
        #expect(preferences.retainAudioForHarvest == enabled)
        preferences.applyHermesRecommendedSettings()
        let reopened = DictationPreferences(defaults: UserDefaults(suiteName: name)!)
        #expect(reopened.retainAudioForHarvest == enabled)
        #expect(defaults.bool(forKey: "retainAudioForHarvest") == enabled)
        #expect(defaults.string(forKey: "unrelated-setting") == "invented-unrelated-value")
        #expect((reopened.savedRetentionNotice != nil) == enabled)
    }

    @Test("Production setter is the explicit choice and stored-on disclosure changes no preference")
    func explicitChoiceAndNotice() {
        let name = "DictationPreferencesTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = DictationPreferences(defaults: defaults)
        preferences.retainAudioForHarvest = true
        let before = defaults.bool(forKey: "retainAudioForHarvest")
        #expect(preferences.savedRetentionNotice?.contains("Earlier versions may have enabled it") == true)
        #expect(defaults.bool(forKey: "retainAudioForHarvest") == before)
        #expect(defaults.object(forKey: "retainAudioForHarvest") != nil)
        preferences.retainAudioForHarvest = false
        #expect(!preferences.retainAudioForHarvest)
        #expect(preferences.savedRetentionNotice == nil)
    }

    @Test("Native UI uses the tested production getter/preset and shutdown cleanup")
    func nativeWiringKeepsTheRegressionCovered() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Sources/VoiceCursorMac/main.swift"), encoding: .utf8)
        #expect(source.contains("static let dictationPreferences = DictationPreferences(defaults: defaults)"))
        #expect(!source.contains("static var retainAudioForHarvest:"), "A separate native getter bypasses the production preference tests.")
        let presetStart = try #require(source.range(of: "@objc private func useHermesRecommendedSettings()"))
        let presetTail = String(source[presetStart.lowerBound...])
        let presetEnd = try #require(presetTail.dropFirst().range(of: "@objc"))
        let preset = String(presetTail[..<presetEnd.lowerBound])
        #expect(preset.contains("Settings.dictationPreferences.applyHermesRecommendedSettings()"))
        #expect(!preset.contains("retainAudioForHarvest ="), "The native preset must not override the separate recording choice.")
        #expect(source.contains("Archive.sweepTemporaryAudio()"))
        #expect(source.contains("keepRecordingForFinalization: true"))
        #expect(source.contains("recordingsStateLabel.stringValue = Settings.dictationPreferences.savedRetentionNotice"))
        #expect(source.contains("Saved retention: On"))
        let quitStart = try #require(source.range(of: "@objc private func quit()"))
        let quitTail = String(source[quitStart.lowerBound...])
        let quitEnd = try #require(quitTail.range(of: "private func refreshMenuState"))
        let quit = String(quitTail[..<quitEnd.lowerBound])
        #expect(quit.contains("controller.shutdown()"))
        #expect(!quit.contains("controller.stop()"), "Quit must not start delayed transcription then terminate before cleanup.")
    }

    @Test("Native capture lifecycle registers outputs before writing and cleans up before accepting another capture")
    func nativeLifecycleWiring() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Sources/VoiceCursorMac/main.swift"), encoding: .utf8)
        let capture = try functionBody("private func startCapture(", in: source)
        let retention = try #require(capture.range(of: "let retainAudioAtStart = Settings.dictationPreferences.retainAudioForHarvest"))
        let path = try #require(capture.range(of: "Archive.captureRecordingURL(for: sessionId, retain: retainAudioAtStart)"))
        let registration = try #require(capture.range(of: "guard ownedRecordings.registerCapture(recordingURL, retain: retainAudioAtStart)"))
        let writer = try #require(capture.range(of: "AVAudioFile(forWriting: recordingURL"))
        #expect(retention.lowerBound < path.lowerBound && path.lowerBound < registration.lowerBound,
                "One record-start preference snapshot must choose the path and register its cleanup policy.")
        #expect(capture.components(separatedBy: "Settings.dictationPreferences.retainAudioForHarvest").count == 2)
        #expect(registration.lowerBound < writer.lowerBound, "Refusing existing files, including dangling symlinks, must precede opening the native writer.")
        #expect(capture.contains("recordingProcesses.performIfOpen"))

        let prepare = try functionBody("private func prepareOwnedRecordingForRetention(", in: source)
        let output = try #require(prepare.range(of: "ownedRecordings.registerOutput(output, forCapture: url)"))
        let promotion = try #require(prepare.range(of: "Archive.promoteTemporaryAudio(url)"))
        #expect(output.lowerBound < promotion.lowerBound)
        #expect(prepare.contains("if format == .flac"))
        #expect(!prepare.contains("Settings.archiveFormat"))
        let finalize = try functionBody("static func finalizeAudio(", in: source)
        #expect(finalize.contains("guard format == .flac"))
        #expect(!finalize.contains("Settings.archiveFormat"), "The conversion must use the same format as output registration.")
        #expect(finalize.contains("processes: processes"))

        let stop = try functionBody("func stop(source: StopTailPolicy.StopSource = .automatic) {\n        guard isRecording", in: source)
        #expect(stop.contains("let retainAudioForHarvest = url.flatMap { ownedRecordings.retainsCapture($0) } ?? false"))
        #expect(!stop.contains("Settings.dictationPreferences.retainAudioForHarvest"), "Finalization must use the original capture policy, including conversion and failures.")
        #expect(stop.components(separatedBy: "Settings.archiveFormat").count == 2)
        #expect(stop.contains("prepareOwnedRecordingForRetention(url, format: archiveFormat)"))
        #expect(stop.contains("Archive.finalizeAudio(retainedURL, format: archiveFormat, processes: self.recordingProcesses)"))
        #expect(stop.contains("processes: self.recordingProcesses"), "The current Local Whisper child must also be owned and reaped on quit.")
        let release = try #require(stop.range(of: "releasedRecording = true"))
        let ready = try #require(stop.range(of: "self.isProcessing = false"))
        #expect(release.lowerBound < ready.lowerBound)
        #expect(stop.contains("defer { if !releasedRecording, let url { self.finishOwnedRecording(url) } }"), "An old finalizer must not clean up again after exposing the controller for a new capture.")

        let shutdown = try functionBody("func shutdown()", in: source)
        let reap = try #require(shutdown.range(of: "recordingProcesses.cancelAndWait()"))
        let stopWriter = try #require(shutdown.range(of: "stopWithoutArchive()"))
        let cleanup = try #require(shutdown.range(of: "ownedRecordings.shutdown()"))
        #expect(reap.lowerBound < stopWriter.lowerBound && stopWriter.lowerBound < cleanup.lowerBound)
        #expect(!shutdown.contains("Settings.dictationPreferences.retainAudioForHarvest"))
        let finish = try functionBody("private func finishOwnedRecording(", in: source)
        #expect(finish.contains("ownedRecordings.finishCapture(url)"))
        #expect(!finish.contains("Settings.dictationPreferences.retainAudioForHarvest"), "Normal, cancelled and failed captures all finish under their record-start policy.")
        let processShutdown = try functionBody("func cancelAndWait()", in: source)
        #expect(processShutdown.contains("closed = true"))
        #expect(processShutdown.contains("process.terminate()"))
        #expect(processShutdown.contains("Darwin.kill(process.processIdentifier, SIGKILL)"))
        #expect(processShutdown.contains("process.waitUntilExit()"))
        let whisper = try functionBody("private static func transcribeWithLocalWhisper(", in: source)
        #expect(whisper.contains("processes: processes"))
    }

    @Test("Pending native permission grants and idle starts cannot reopen capture after shutdown")
    func nativePermissionWiring() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Sources/VoiceCursorMac/main.swift"), encoding: .utf8)
        for signature in ["private func startCapture(", "private func startIdleMonitorAuthorized()", "private func requestSpeechPermission(", "private func ensureMicrophonePermission("] {
            let body = try functionBody(signature, in: source)
            #expect(body.contains("guard !recordingProcesses.isClosed else { return }"))
        }
        for signature in ["private func requestSpeechPermission(", "private func ensureMicrophonePermission("] {
            let body = try functionBody(signature, in: source)
            #expect(body.contains("guard let self, !self.recordingProcesses.isClosed else { return }"), "Delayed permission callbacks must honor the permanent shutdown gate.")
        }
    }

    @Test("Only the owner's Stop gets the listening tail; safety stops and quitting end capture at once")
    func stopTailWiring() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Sources/VoiceCursorMac/main.swift"), encoding: .utf8)

        let stopDictation = try functionBody("private func stopDictation(hidePill: Bool = true, immediate: Bool = false)", in: source)
        #expect(stopDictation.contains("controller.stop(source: immediate ? .automatic : .owner)"))
        let safetyStop = try functionBody("private func stopDictationAfterExternalLivePreviewGuard(", in: source)
        #expect(safetyStop.contains("stopDictation(immediate: true)"), "A safety stop must not wait for a tail.")
        #expect(!source.contains("self.stop(source: .owner)"), "Auto-stops and engine errors stop at once.")

        let stop = try functionBody("func stop(source: StopTailPolicy.StopSource = .automatic) {\n        guard isRecording", in: source)
        // Live typing is frozen and the safety checks are read at the moment
        // of Stop, before the tail starts.
        let freeze = try #require(stop.range(of: "TextInjector.freezeLivePreviewPartials()"))
        let guardCheck = try #require(stop.range(of: "TextInjector.hasExternalFinalPasteGuard"))
        let tail = try #require(stop.range(of: "stopTail.stop(tailSeconds: tailSeconds)"))
        #expect(freeze.lowerBound < tail.lowerBound && guardCheck.lowerBound < tail.lowerBound)
        // The finish reads the words only after capture ended.
        let words = try #require(stop.range(of: "await self.evidenceAtEndOfCapture(captureEnd)"))
        let finalText = try #require(stop.range(of: "var finalText = fallbackTranscript"))
        #expect(words.lowerBound < finalText.lowerBound)
        // Codex P1 on #82: speech evidence is read when capture ends, never
        // at the moment of Stop, so the tail's words and sound count.
        let beforeTail = String(stop[..<tail.lowerBound])
        for early in ["sliceCountTotal", "sliceCountAtOrAboveNearSilent", "self.firstPartialAt", "liveListenerHadError"] {
            #expect(!beforeTail.contains(early), "\(early) must not be read before the tail")
        }
        let silentGuard = try #require(stop.range(of: "evidence.treatAsNoSpeech("))
        #expect(words.lowerBound < silentGuard.lowerBound)
        let end = try functionBody("private func completeCaptureEnd(", in: source)
        let micOff = try #require(end.range(of: "stopWithoutArchive("))
        let slices = try #require(end.range(of: "let totalSlices = sliceCountTotal"))
        #expect(micOff.lowerBound < slices.lowerBound, "No slice is counted after the evidence is read.")
        #expect(end.contains("firstPartialAt: firstPartialAt"))
        #expect(end.contains("liveListenerHadError: liveListenerHadError"))

        // Codex P2 on #82: while finishing, no engine puts live words or a
        // listening status on the pill (it keeps "Finishing…").
        let realtime = try functionBody("private func handleRealtimeTranscript(", in: source)
        let realtimeGate = try #require(realtime.range(of: "guard isRecording else { return }"))
        let realtimeWords = try #require(realtime.range(of: "onTranscript(normalized)"))
        let realtimeCollect = try #require(realtime.range(of: "latestTranscript = normalized"))
        #expect(realtimeCollect.lowerBound < realtimeGate.lowerBound && realtimeGate.lowerBound < realtimeWords.lowerBound)
        let analyzer = try functionBody("private func handleSpeechAnalyzerTranscript(", in: source)
        #expect(analyzer.contains("guard currentProvider == .appleSpeechAnalyzer, isRecording else { return }"))
        let apple = try functionBody("private func startRecognitionSession(", in: source)
        let appleGate = try #require(apple.range(of: "if self.isRecording {"))
        let appleWords = try #require(apple.range(of: "self.onTranscript(combinedText)"))
        #expect(appleGate.lowerBound < appleWords.lowerBound)
        let recognitionError = try functionBody("private func handleRecognitionError(", in: source)
        #expect(recognitionError.contains("if isRecording { onStatus(error.localizedDescription) }"))
        #expect(!source.contains("self.audioEngine.isRunning else { return }\n                        self.onStatus"))

        let shutdown = try functionBody("func shutdown()", in: source)
        let discard = try #require(shutdown.range(of: "stopTail.discard()"))
        let writerStop = try #require(shutdown.range(of: "stopWithoutArchive()"))
        #expect(discard.lowerBound < writerStop.lowerBound)
        #expect(shutdown.contains("captureEnd?.resolve(nil)"))

        let livePaste = try functionBody("private func livePasteFinalizedSegmentIfNeeded(", in: source)
        #expect(livePaste.contains("guard isRecording else { return }"), "Nothing is pasted live after Stop.")
    }

    private func functionBody(_ signature: String, in source: String) throws -> String {
        let declaration = try #require(source.range(of: signature))
        // Some signatures include the opening brace for disambiguation.
        let start = try #require(source[declaration.lowerBound...].firstIndex(of: "{"))
        var depth = 0
        for index in source[start...].indices {
            if source[index] == "{" { depth += 1 }
            if source[index] == "}" { depth -= 1 }
            if depth == 0 { return String(source[start...index]) }
        }
        throw NSError(domain: "DictationPreferencesTests", code: 1)
    }
}
