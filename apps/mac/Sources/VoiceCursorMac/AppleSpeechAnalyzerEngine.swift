import AVFoundation
import CoreMedia
import Foundation
import Speech
import VoiceCursorCore

/// A live speech engine the dictation controller can hold on any macOS
/// version. Stored properties can't be limited to macOS 26, so the controller
/// keeps Apple's new engine through this protocol.
protocol LiveSpeechEngine: AnyObject {
    /// The model name written to the dictation history and timing report.
    var modelName: String { get }
    /// Called on the audio thread with each microphone buffer.
    func append(_ buffer: AVAudioPCMBuffer)
    /// Called on the audio thread at the start and end of each tap callback,
    /// so the finish can wait for a callback still running when the tap goes.
    func tapCallbackBegan()
    func tapCallbackEnded()
    /// Ends the audio, waits for the final text, and returns it. Call only
    /// after the microphone tap is removed, so no buffer can still arrive.
    func finishAndWait(timeout: TimeInterval) async -> LiveSpeechFinish
    /// Stops at once and throws the words away (start failures and aborts).
    func cancel()
}

/// What a live engine hands back when a dictation ends.
struct LiveSpeechFinish {
    /// The text, or nil if there is none. When `complete` is false this may
    /// be missing words.
    var text: String?
    /// A plain reason to show when the engine failed, wasn't ready, or didn't
    /// finish, so the pill doesn't blame the microphone. Always set when
    /// `complete` is false; nil when it finished normally.
    var problem: String?
    /// True only when the engine finished normally and handed over all its
    /// words. Text that isn't complete must never be sent automatically.
    var complete: Bool
}

/// "Apple On-Device (New)": Apple's SpeechAnalyzer with SpeechTranscriber
/// (DictationTranscriber when SpeechTranscriber can't serve the language).
///
/// Each dictation gets a new analyzer; finishing an analyzer ends its session
/// for good. Apple's model stays loaded between dictations through
/// `modelRetention: .processLifetime`, so later dictations start quickly.
///
/// Audio stays on this Mac and no recording is kept. The only network use is
/// macOS downloading Apple's speech model once, through AssetInventory.
@available(macOS 26, *)
final class AppleSpeechAnalyzerEngine: LiveSpeechEngine, @unchecked Sendable {
    enum EngineError: LocalizedError {
        case unsupportedLanguage(String)
        case modelNotReady

        var errorDescription: String? {
            switch self {
            case .unsupportedLanguage(let language):
                return "doesn't support \(language) on this Mac"
            case .modelNotReady:
                return "Apple's speech model isn't ready yet; try again in a moment"
            }
        }
    }

    static let label = "Apple On-Device (New)"
    /// One place to change for a speed/accuracy comparison. `.fastResults` is
    /// left out on purpose: Apple says it is faster but less accurate.
    private static let reportingOptions: Set<SpeechTranscriber.ReportingOption> = [.volatileResults]
    private static let analyzerOptions = SpeechAnalyzer.Options(
        priority: .userInitiated,
        modelRetention: .processLifetime
    )
    /// While Apple's model is still getting ready, audio waits in a queue. Past
    /// this much audio, newer buffers are dropped (and logged).
    private static let maxQueuedSeconds = 60.0
    /// Shown when a dictation starts while Apple's model has to download.
    private static let downloadingReason = "Apple's speech model is downloading (one time only); try again in a minute"
    /// Shown when the model was still loading after the dictation key was released.
    private static let stillLoadingReason = "Apple's speech model was still loading, so this dictation couldn't be transcribed; try again in a moment"
    /// Shown when the text may be missing its last words.
    private static let finalizeFailedReason = "Apple's speech engine couldn't finish the last words, so the end may be missing"
    private static let finalizeTimedOutReason = "Apple's speech engine took too long to finish, so the end may be missing"
    private static let lastWordsLateReason = "Apple's speech engine didn't hand over its last words in time, so the end may be missing"
    private static let stoppedEarlyReason = "Apple's speech engine was stopped before it finished"
    private static let failedGenericReason = "Apple's speech engine hit an error (details are in the run log)"
    private static let droppedAudioReason = "Apple's speech engine took too long to get ready, so some of your words were dropped"
    private static let conversionFailedReason = "Some of your audio couldn't be passed to Apple's speech engine, so words may be missing"
    private static let lateAudioReason = "The last moment of your audio arrived after the dictation ended, so the end may be missing"

    /// Main queue. The whole rough transcript so far, and whether the newest
    /// piece is final.
    var onTranscript: (String, Bool) -> Void = { _, _ in }
    /// Main queue. A full status line, such as model download progress.
    var onStatus: (String) -> Void = { _ in }
    /// Main queue. A plain reason, without the engine name in front.
    var onError: (String) -> Void = { _ in }

    private let language: String
    private let sessionId: String
    private let inputFormat: AVAudioFormat
    private let createdAt = Date()
    private let lock = NSLock()

    // Everything below is guarded by `lock`.
    private var currentModelName = "SpeechAnalyzer/SpeechTranscriber"
    private var pending: [AVAudioPCMBuffer] = []
    private var pendingFrames: AVAudioFramePosition = 0
    private var droppedFrames: AVAudioFramePosition = 0
    private var converter: AVAudioConverter?
    private var analyzerFormat: AVAudioFormat?
    private var continuation: AsyncStream<AnalyzerInput>.Continuation?
    private var analyzer: SpeechAnalyzer?
    private var setupTask: Task<Void, Error>?
    private var resultsTask: Task<Void, Never>?
    /// Final and rough pieces, by stretch of audio (rules in VoiceCursorCore).
    private var transcript = LiveTranscriptAccumulator()
    /// The finish has begun: the microphone tap is gone, so any buffer that
    /// still arrives is dropped (and logged) rather than sent on.
    private var inputEnded = false
    private var lateBuffers = 0
    /// Microphone callbacks currently running (see tapCallbackBegan), so the
    /// finish can wait for one already in progress before ending input.
    private var tapCallbacksInFlight = 0
    /// Buffers (or the final flush) that could not be converted and sent on.
    private var conversionFailures = 0
    private var cancelled = false
    /// Apple's engine stopped with an error mid-dictation: no more words can
    /// arrive, so audio is no longer taken.
    private var failed = false
    /// The plain reason for a failure or a not-ready model, for the finish result.
    private var problem: String?

    var modelName: String {
        lock.withLock { currentModelName }
    }

    /// `inputFormat` is the mono microphone format the controller's tap sends.
    init(language: String, sessionId: String, inputFormat: AVAudioFormat) {
        self.language = language
        self.sessionId = sessionId
        self.inputFormat = inputFormat
    }

    /// Starts getting Apple's engine ready in the background. Audio passed to
    /// `append` before it is ready waits in a queue, so no first words are lost.
    func start() {
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.setUp()
            } catch {
                let reason = Self.plainReason(for: error)
                let wasCancelled = self.lock.withLock { () -> Bool in
                    if self.problem == nil { self.problem = reason }
                    return self.cancelled
                }
                RunLog.write(
                    "speech-analyzer.setup.failed",
                    "id=\(self.sessionId) cancelled=\(wasCancelled) error=\"\(error.localizedDescription)\""
                )
                if !wasCancelled {
                    DispatchQueue.main.async { self.onError(reason) }
                }
                throw error
            }
        }
        lock.withLock { setupTask = task }
    }

    private func setUp() async throws {
        let module = try await Self.makeModule(language: language)
        let name = Self.modelName(for: module)
        lock.withLock { currentModelName = name }
        try await Self.ensureModelInstalled(
            module,
            logId: sessionId,
            onDownloadStarting: { [weak self] in self?.reportModelDownloading() },
            onStatus: { [weak self] status in
                DispatchQueue.main.async { self?.onStatus(status) }
            }
        )
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(
            compatibleWith: [module],
            considering: inputFormat
        ) else {
            throw EngineError.modelNotReady
        }
        let analyzer = SpeechAnalyzer(modules: [module], options: Self.analyzerOptions)
        try await analyzer.prepareToAnalyze(in: format)
        let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let resultsTask = Task { [weak self] in
            guard let self else { return }
            await self.readResults(module)
        }
        do {
            try await analyzer.start(inputSequence: stream)
        } catch {
            continuation.finish()
            resultsTask.cancel()
            throw error
        }

        let queuedCount: Int? = lock.withLock {
            guard !cancelled else { return nil }
            // The download finished in time, so it is no longer the reason.
            if problem == Self.downloadingReason { problem = nil }
            self.analyzer = analyzer
            self.analyzerFormat = format
            self.continuation = continuation
            self.resultsTask = resultsTask
            let queued = pending
            pending = []
            pendingFrames = 0
            for buffer in queued {
                convertAndYieldLocked(buffer)
            }
            return queued.count
        }
        guard let queuedCount else {
            // Cancelled while getting ready: end this analyzer's session now.
            continuation.finish()
            await analyzer.cancelAndFinishNow()
            return
        }
        RunLog.write(
            "speech-analyzer.ready",
            "id=\(sessionId) model=\(name) format=\(Int(format.sampleRate))Hz/\(format.channelCount)ch/\(Self.sampleTypeName(format)) queued=\(queuedCount) setupMs=\(milliseconds(between: createdAt, and: Date()))"
        )
    }

    // MARK: - Model

    /// SpeechTranscriber when this Mac and language support it, otherwise
    /// DictationTranscriber, otherwise a plain error.
    private static func makeModule(language: String) async throws -> any SpeechModule {
        let wanted = Locale(identifier: language)
        if SpeechTranscriber.isAvailable,
           let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted)
        {
            return SpeechTranscriber(
                locale: locale,
                transcriptionOptions: [],
                reportingOptions: reportingOptions,
                attributeOptions: []
            )
        }
        if let locale = await DictationTranscriber.supportedLocale(equivalentTo: wanted) {
            return DictationTranscriber(locale: locale, preset: .progressiveLongDictation)
        }
        throw EngineError.unsupportedLanguage(language)
    }

    private static func sampleTypeName(_ format: AVAudioFormat) -> String {
        switch format.commonFormat {
        case .pcmFormatInt16: return "int16"
        case .pcmFormatInt32: return "int32"
        case .pcmFormatFloat32: return "float32"
        case .pcmFormatFloat64: return "float64"
        default: return "other"
        }
    }

    private static func modelName(for module: any SpeechModule) -> String {
        module is DictationTranscriber
            ? "SpeechAnalyzer/DictationTranscriber"
            : "SpeechAnalyzer/SpeechTranscriber"
    }

    /// Asks macOS to download Apple's model if it isn't installed yet. Progress
    /// goes to the run log and the status line only. Returns false, without
    /// downloading, when a download is needed but `allowDownload` is false.
    @discardableResult
    private static func ensureModelInstalled(
        _ module: any SpeechModule,
        logId: String,
        allowDownload: Bool = true,
        onDownloadStarting: (() -> Void)? = nil,
        onStatus: @escaping (String) -> Void
    ) async throws -> Bool {
        await reserveLanguages(of: module, logId: logId)
        let before = await AssetInventory.status(forModules: [module])
        RunLog.write("speech-analyzer.model.status", "id=\(logId) status=\(before)")
        guard let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) else {
            return true
        }
        guard allowDownload else {
            RunLog.write("speech-analyzer.model.download.skipped", "id=\(logId) reason=download-not-requested")
            return false
        }
        if before != .installed {
            // No model to use yet: this dictation can't produce words.
            onDownloadStarting?()
        }
        let progress = request.progress
        let startedAt = Date()
        RunLog.write("speech-analyzer.model.download.started", "id=\(logId)")
        let watcher = Task {
            while !Task.isCancelled {
                let percent = Int(progress.fractionCompleted * 100)
                RunLog.write("speech-analyzer.model.download", "id=\(logId) percent=\(percent)")
                onStatus("\(label): downloading Apple's speech model \(percent)%")
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
        do {
            try await request.downloadAndInstall()
        } catch {
            watcher.cancel()
            throw error
        }
        watcher.cancel()
        RunLog.write(
            "speech-analyzer.model.installed",
            "id=\(logId) ms=\(milliseconds(between: startedAt, and: Date()))"
        )
        onStatus("\(label): Apple's speech model is installed")
        return true
    }

    /// Asks macOS to set the model's language aside for this app. Apple says a
    /// language must be reserved before its model is used; when the model is
    /// already on the Mac, the installation request doesn't do it. Asking again
    /// is harmless (it answers false). A failure here is only logged: if it
    /// matters, the next step fails with Apple's reason.
    private static func reserveLanguages(of module: any SpeechModule, logId: String) async {
        guard let module = module as? any LocaleDependentSpeechModule else { return }
        for locale in module.selectedLocales {
            do {
                let newlyReserved = try await AssetInventory.reserve(locale: locale)
                RunLog.write("speech-analyzer.locale.reserved", "id=\(logId) locale=\(locale.identifier) new=\(newlyReserved)")
            } catch {
                RunLog.write(
                    "speech-analyzer.locale.reserve.failed",
                    "id=\(logId) locale=\(locale.identifier) error=\"\(error.localizedDescription)\""
                )
            }
        }
    }

    /// Apple's model has to download before this dictation can produce words,
    /// so the controller stops the dictation now rather than let the person
    /// talk to nothing. The download carries on for next time.
    private func reportModelDownloading() {
        let wasCancelled = lock.withLock { () -> Bool in
            if problem == nil { problem = Self.downloadingReason }
            return cancelled
        }
        RunLog.write("speech-analyzer.model.download.blocks-dictation", "id=\(sessionId) cancelled=\(wasCancelled)")
        guard !wasCancelled else { return }
        DispatchQueue.main.async { self.onError(Self.downloadingReason) }
    }

    /// Gets Apple's model loaded so the first dictation starts quickly. When
    /// the person picks this engine it also downloads the model if needed; at
    /// app launch (`onlyIfInstalled`) it never starts a download.
    /// `inputSampleRate` is the microphone's rate, so this prepares the same
    /// audio format a dictation asks for.
    static func prepareModel(
        language: String,
        inputSampleRate: Double?,
        onlyIfInstalled: Bool,
        onStatus: @escaping (String) -> Void
    ) async {
        let startedAt = Date()
        let send: (String) -> Void = { status in
            DispatchQueue.main.async { onStatus(status) }
        }
        do {
            let module = try await makeModule(language: language)
            let installed = try await ensureModelInstalled(
                module,
                logId: "prewarm",
                allowDownload: !onlyIfInstalled,
                onStatus: send
            )
            guard installed else {
                RunLog.write("speech-analyzer.prewarm.skipped", "reason=model-not-installed")
                return
            }
            // Same as a dictation: mono Float32 at the microphone's rate.
            let micFormat = inputSampleRate.flatMap {
                AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: $0, channels: 1, interleaved: false)
            }
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(
                compatibleWith: [module],
                considering: micFormat
            ) else {
                throw EngineError.modelNotReady
            }
            // A throwaway analyzer: preparing it loads the model, and
            // `.processLifetime` keeps it loaded for the next analyzer.
            let analyzer = SpeechAnalyzer(modules: [module], options: analyzerOptions)
            try await analyzer.prepareToAnalyze(in: format)
            RunLog.write(
                "speech-analyzer.prewarm.finished",
                "model=\(modelName(for: module)) ms=\(milliseconds(between: startedAt, and: Date()))"
            )
            send("\(label): ready")
        } catch {
            RunLog.write("speech-analyzer.prewarm.failed", "error=\"\(error.localizedDescription)\"")
            send("\(label): \(plainReason(for: error))")
        }
    }

    /// A short plain reason for an error from Apple's speech engine, shown
    /// after "Apple On-Device (New): ". The raw text goes to the run log only.
    static func plainReason(for error: Error) -> String {
        if let engineError = error as? EngineError {
            return engineError.errorDescription ?? "Apple's speech engine hit an error (details are in the run log)"
        }
        if error is CancellationError {
            return "Apple's speech engine was stopped before it finished"
        }
        if error is URLError || (error as NSError).domain == NSURLErrorDomain {
            return "Apple's speech model couldn't download; check the internet connection and try again"
        }
        if let speechError = error as? SFSpeechError {
            let code = speechError.code
            if code == .noModel {
                return "Apple's speech model isn't installed yet; pick this engine again in the menu to download it"
            }
            if code == .assetLocaleNotAllocated {
                return "macOS hasn't set Apple's speech model aside for this app; pick this engine again in the menu"
            }
            if code == .tooManyAssetLocalesAllocated {
                return "macOS won't set aside another speech language for this app"
            }
            if code == .cannotAllocateUnsupportedLocale {
                return "this language isn't supported on this Mac"
            }
            if code == .insufficientResources {
                return "the Mac is too busy for Apple's speech engine right now; try again in a moment"
            }
            if code == .unexpectedAudioFormat || code == .incompatibleAudioFormats || code == .audioDisordered {
                return "this microphone's audio didn't work with Apple's speech engine; try another microphone or the older Apple engine"
            }
            if code == .moduleOutputFailed {
                return "Apple's speech engine stopped unexpectedly; try again"
            }
        }
        return "Apple's speech engine hit an error (details are in the run log)"
    }

    // MARK: - Results

    private func readResults(_ module: any SpeechModule) async {
        do {
            if let transcriber = module as? SpeechTranscriber {
                for try await result in transcriber.results {
                    receive(result, text: String(result.text.characters))
                }
            } else if let transcriber = module as? DictationTranscriber {
                for try await result in transcriber.results {
                    receive(result, text: String(result.text.characters))
                }
            }
        } catch {
            if Task.isCancelled {
                // setUp cancelled this after the analyzer failed to start, and
                // reports that error itself.
                RunLog.write("speech-analyzer.results.stopped", "id=\(sessionId) reason=setup-failed")
                return
            }
            let reason = Self.plainReason(for: error)
            let (wasCancelled, continuation) = lock.withLock { () -> (Bool, AsyncStream<AnalyzerInput>.Continuation?) in
                if !cancelled {
                    // Nothing reads results any more, so stop taking audio.
                    failed = true
                    pending = []
                    pendingFrames = 0
                    if problem == nil { problem = reason }
                }
                return (cancelled, self.continuation)
            }
            continuation?.finish()
            RunLog.write(
                "speech-analyzer.results.failed",
                "id=\(sessionId) cancelled=\(wasCancelled) error=\"\(error.localizedDescription)\""
            )
            if !wasCancelled {
                DispatchQueue.main.async { self.onError(reason) }
            }
        }
    }

    /// Hands one result to the accumulator, which keeps each piece by its
    /// stretch of audio and uses Apple's finalization time to tell final
    /// pieces from rough ones (see LiveTranscriptAccumulator).
    private func receive(_ result: some SpeechModuleResult, text: String) {
        let range = result.range
        let start = range.isValid ? Self.seconds(range.start) : nil
        let end = range.isValid ? Self.seconds(range.end) : nil
        let finalizationTime = Self.seconds(result.resultsFinalizationTime)
        let update: (text: String, isFinal: Bool)? = lock.withLock {
            let isFinal = transcript.receive(
                text: text,
                start: start,
                end: end,
                isFinal: result.isFinal,
                finalizationTime: finalizationTime
            )
            return cancelled ? nil : (transcript.text, isFinal)
        }
        guard let update else { return }
        DispatchQueue.main.async { self.onTranscript(update.text, update.isFinal) }
    }

    private static func seconds(_ time: CMTime) -> Double? {
        time.isNumeric ? time.seconds : nil
    }

    // MARK: - Audio

    /// The controller's microphone tap calls these around each callback, so
    /// a callback still running when the tap is removed is waited for.
    func tapCallbackBegan() {
        lock.withLock { tapCallbacksInFlight += 1 }
    }

    func tapCallbackEnded() {
        lock.withLock { tapCallbacksInFlight = max(0, tapCallbacksInFlight - 1) }
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.withLock {
            guard !cancelled, !failed else { return }
            guard !inputEnded else {
                // Shouldn't happen: the controller removes the tap before
                // finishing. Logged so a lost buffer is never silent.
                if lateBuffers == 0 {
                    RunLog.write("speech-analyzer.audio.after-end", "id=\(sessionId)")
                }
                lateBuffers += 1
                return
            }
            guard continuation != nil else {
                // Not ready yet. The controller's tap hands over a fresh copy
                // of each buffer, so keeping it is safe.
                let limit = AVAudioFramePosition(Self.maxQueuedSeconds * buffer.format.sampleRate)
                if pendingFrames + AVAudioFramePosition(buffer.frameLength) > limit {
                    if droppedFrames == 0 {
                        RunLog.write("speech-analyzer.queue.full", "id=\(sessionId) seconds=\(Int(Self.maxQueuedSeconds))")
                    }
                    droppedFrames += AVAudioFramePosition(buffer.frameLength)
                    return
                }
                pending.append(buffer)
                pendingFrames += AVAudioFramePosition(buffer.frameLength)
                return
            }
            convertAndYieldLocked(buffer)
        }
    }

    /// Converts a buffer to the analyzer's format and sends it on. Pass nil at
    /// the end to flush what the converter still holds. Uses AVAudioConverter
    /// directly; Apple's ready-made converters need macOS 27.
    private func convertAndYieldLocked(_ buffer: AVAudioPCMBuffer?) {
        guard let analyzerFormat, let continuation else {
            // Audio with nowhere to go is lost, so the text can't be complete.
            if buffer != nil { noteConversionFailureLocked("no-destination") }
            return
        }
        if let buffer, buffer.format == analyzerFormat {
            continuation.yield(AnalyzerInput(buffer: buffer))
            return
        }
        if let buffer, converter == nil || converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: analyzerFormat)
            if converter == nil {
                RunLog.write("speech-analyzer.convert.unavailable", "id=\(sessionId)")
            }
        }
        guard let converter else {
            if buffer != nil { noteConversionFailureLocked("no-converter") }
            return
        }

        let inputFrames = Double(buffer?.frameLength ?? 0)
        let ratio = analyzerFormat.sampleRate / converter.inputFormat.sampleRate
        let capacity = AVAudioFrameCount((inputFrames * ratio).rounded(.up)) + 1024
        var supplied = false
        while true {
            guard let output = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else {
                noteConversionFailureLocked("no-output-buffer")
                return
            }
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, inputStatus in
                guard let buffer else {
                    inputStatus.pointee = .endOfStream
                    return nil
                }
                if supplied {
                    inputStatus.pointee = .noDataNow
                    return nil
                }
                supplied = true
                inputStatus.pointee = .haveData
                return buffer
            }
            if output.frameLength > 0 {
                continuation.yield(AnalyzerInput(buffer: output))
            }
            if status == .error {
                RunLog.write(
                    "speech-analyzer.convert.failed",
                    "id=\(sessionId) error=\"\(error?.localizedDescription ?? "unknown")\""
                )
                noteConversionFailureLocked("convert-error")
                return
            }
            // .haveData means the output filled up and more is waiting.
            guard status == .haveData else { return }
        }
    }

    /// Counts audio that could not be converted and sent on. Logged once per
    /// dictation, with a fixed reason only (never any dictated text).
    private func noteConversionFailureLocked(_ kind: String) {
        if conversionFailures == 0 {
            RunLog.write("speech-analyzer.convert.lost", "id=\(sessionId) kind=\(kind)")
        }
        conversionFailures += 1
    }

    // MARK: - Finish and cancel

    func finishAndWait(timeout: TimeInterval) async -> LiveSpeechFinish {
        let deadline = Date().addingTimeInterval(timeout)
        // The controller removed the microphone tap before calling this, but
        // Apple doesn't promise a callback already running has returned. Wait
        // briefly for it so its audio is sent before input ends. Anything that
        // still arrives later is counted and makes the text incomplete.
        let callbackWaitDeadline = Date().addingTimeInterval(0.25)
        while lock.withLock({ tapCallbacksInFlight }) > 0, Date() < callbackWaitDeadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        let setupTask = lock.withLock { () -> Task<Void, Error>? in
            inputEnded = true
            return self.setupTask
        }
        if let setupTask {
            let setup = await Self.race(timeout: timeout, onTimeout: SetupOutcome.stillPreparing) {
                (try? await setupTask.value) != nil ? SetupOutcome.ready : SetupOutcome.failed
            }
            switch setup {
            case .ready:
                break
            case .failed:
                // The raw error is in the run log (speech-analyzer.setup.failed).
                RunLog.write("speech-analyzer.finish.setup-failed", "id=\(sessionId)")
                let problem = lock.withLock { self.problem }
                return LiveSpeechFinish(
                    text: nil,
                    problem: problem ?? "Apple's speech engine couldn't start (details are in the run log)",
                    complete: false
                )
            case .stillPreparing:
                // Leave the setup running so the model download can finish
                // for next time; this dictation's audio is dropped.
                RunLog.write("speech-analyzer.finish.not-ready", "id=\(sessionId) timeoutMs=\(Int(timeout * 1000))")
                let problem = lock.withLock { self.problem }
                cancel()
                return LiveSpeechFinish(text: nil, problem: problem ?? Self.stillLoadingReason, complete: false)
            }
        }

        // End the analyzer's input: flush what the converter still holds,
        // then close the stream.
        let (analyzer, continuation, resultsTask, dropped, failedBeforeFinish): (SpeechAnalyzer?, AsyncStream<AnalyzerInput>.Continuation?, Task<Void, Never>?, AVAudioFramePosition, Bool) = lock.withLock {
            if !failed {
                convertAndYieldLocked(nil)
            }
            return (self.analyzer, self.continuation, self.resultsTask, self.droppedFrames, self.failed)
        }
        continuation?.finish()
        guard let analyzer else {
            // Only when this engine was cancelled while getting ready.
            RunLog.write("speech-analyzer.finished", "id=\(sessionId) complete=false reason=cancelled")
            return LiveSpeechFinish(text: nil, problem: Self.stoppedEarlyReason, complete: false)
        }

        if failedBeforeFinish {
            // Apple's engine already stopped with an error, so finalizing can't
            // add anything: keep the words it heard and skip the wait.
            Task { await analyzer.cancelAndFinishNow() }
            let (text, problem, finalPieces, roughPieces) = lock.withLock {
                (transcript.text, self.problem, transcript.finalPieceCount, transcript.roughPieceCount)
            }
            RunLog.write(
                "speech-analyzer.finished",
                "id=\(sessionId) finalized=false failed=true complete=false finalPieces=\(finalPieces) roughPieces=\(roughPieces) chars=\(text.count) droppedFrames=\(dropped)"
            )
            return LiveSpeechFinish(text: text.isEmpty ? nil : text, problem: problem ?? Self.failedGenericReason, complete: false)
        }

        let finalizeStartedAt = Date()
        let finalizeTimeout = max(2.0, deadline.timeIntervalSinceNow)
        let sessionId = sessionId
        let finalize = await Self.race(timeout: finalizeTimeout, onTimeout: FinalizeOutcome.timedOut) {
            do {
                try await analyzer.finalizeAndFinishThroughEndOfInput()
                return FinalizeOutcome.finished
            } catch {
                RunLog.write("speech-analyzer.finalize.failed", "id=\(sessionId) error=\"\(error.localizedDescription)\"")
                return FinalizeOutcome.failed
            }
        }
        let finalizeMs = milliseconds(between: finalizeStartedAt, and: Date())

        // The analyzer is finished, so its results end once the last ones
        // are read. Wait for that, so late final words aren't left behind.
        var drained = false
        switch finalize {
        case .finished:
            if let resultsTask {
                drained = await Self.race(timeout: max(2.0, deadline.timeIntervalSinceNow), onTimeout: false) {
                    await resultsTask.value
                    return true
                }
            }
        case .failed, .timedOut:
            // The analyzer may already be stuck, so don't wait on it forever.
            _ = await Self.race(timeout: 1.0, onTimeout: false) {
                await analyzer.cancelAndFinishNow()
                return true
            }
            // Keep whatever words arrived before the stop.
            if let resultsTask {
                _ = await Self.race(timeout: 1.0, onTimeout: false) {
                    await resultsTask.value
                    return true
                }
            }
        }

        let (text, readerFailed, readerProblem, finalPieces, roughPieces, promoted, late, conversions) = lock.withLock { () -> (String, Bool, String?, Int, Int, Int, Int, Int) in
            (
                transcript.text,
                failed,
                problem,
                transcript.finalPieceCount,
                transcript.roughPieceCount,
                transcript.roughPiecesFinalizedWithoutResend,
                lateBuffers,
                conversionFailures
            )
        }
        // Any lost audio or unfinished step makes the text incomplete, so it is
        // shown as partial and never sent automatically (rules in VoiceCursorCore).
        let completeness = LiveFinishCompleteness(
            finalize: finalize.coreValue,
            drained: drained,
            readerFailed: readerFailed,
            droppedFrames: Int64(dropped),
            conversionFailures: conversions,
            lateBuffers: late
        )
        let reason: String?
        switch completeness.issue {
        case nil: reason = nil
        case .finalizeFailed: reason = Self.finalizeFailedReason
        case .finalizeTimedOut: reason = Self.finalizeTimedOutReason
        case .lastWordsLate: reason = Self.lastWordsLateReason
        case .engineError: reason = readerProblem ?? Self.failedGenericReason
        case .audioDroppedWhileStarting: reason = Self.droppedAudioReason
        case .audioConversionFailed: reason = Self.conversionFailedReason
        case .audioAfterStop: reason = Self.lateAudioReason
        }
        let complete = completeness.isComplete
        RunLog.write(
            "speech-analyzer.finished",
            "id=\(sessionId) finalized=\(finalize.logValue) drained=\(drained) complete=\(complete) finalizeMs=\(finalizeMs) finalPieces=\(finalPieces) roughPieces=\(roughPieces) roughKeptAsFinal=\(promoted) chars=\(text.count) droppedFrames=\(dropped) lateBuffers=\(late) conversionFailures=\(conversions)"
        )
        return LiveSpeechFinish(text: text.isEmpty ? nil : text, problem: reason, complete: complete)
    }

    func cancel() {
        let (analyzer, continuation): (SpeechAnalyzer?, AsyncStream<AnalyzerInput>.Continuation?) = lock.withLock {
            cancelled = true
            pending = []
            pendingFrames = 0
            return (self.analyzer, self.continuation)
        }
        continuation?.finish()
        // The setup task is not cancelled, so a model download in progress can
        // finish for next time; it ends its own analyzer once it sees `cancelled`.
        if let analyzer {
            Task { await analyzer.cancelAndFinishNow() }
        }
    }

    private enum SetupOutcome: Sendable {
        case ready
        case failed
        case stillPreparing
    }

    private enum FinalizeOutcome: Sendable {
        case finished
        case failed
        case timedOut

        var logValue: String {
            switch self {
            case .finished: return "true"
            case .failed: return "failed"
            case .timedOut: return "timed-out"
            }
        }

        var coreValue: LiveFinishOutcome {
            switch self {
            case .finished: return .finished
            case .failed: return .failed
            case .timedOut: return .timedOut
            }
        }
    }

    /// Runs `work` and returns its answer, or `onTimeout` if `timeout` passes
    /// first. Unlike a task group, it never waits for the slower side to finish.
    private static func race<Value: Sendable>(
        timeout: TimeInterval,
        onTimeout: Value,
        _ work: @escaping @Sendable () async -> Value
    ) async -> Value {
        let gate = ResumeGate()
        return await withCheckedContinuation { (continuation: CheckedContinuation<Value, Never>) in
            let timer = Task {
                do {
                    try await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
                } catch {
                    return
                }
                if gate.claim() { continuation.resume(returning: onTimeout) }
            }
            Task {
                let value = await work()
                if gate.claim() { continuation.resume(returning: value) }
                timer.cancel()
            }
        }
    }
}

/// Lets exactly one of two racing tasks resume a continuation.
private final class ResumeGate: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if claimed { return false }
        claimed = true
        return true
    }
}
