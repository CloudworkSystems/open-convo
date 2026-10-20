import Foundation

/// How long the microphone keeps listening after the owner presses Stop.
///
/// People press Stop while the last word is still leaving their mouth, and
/// the newest slice of sound is still on its way from the microphone when
/// the key goes down. Stopping the microphone at that instant cut off the
/// last word. A short tail of extra listening, then a proper finish of the
/// speech engine, keeps it. Pure rules, so tests can prove them.
public enum StopTailPolicy {
    /// Extra listening after the owner's Stop (the dictation key, letting go
    /// of a hold-to-record key, or hiding the pill).
    public static let ownerStopTailSeconds: TimeInterval = 0.5

    /// Longest wait for Apple's older on-device engine to hand back its
    /// final words once the audio has ended. It usually answers well within
    /// this; if not, the words heard so far are used, as before.
    public static let finalResultWaitSeconds: TimeInterval = 1.0

    public enum StopSource: Equatable {
        /// The owner asked to stop: a tail is worth it.
        case owner
        /// True Convo stopped by itself: a safety stop after a click or key
        /// elsewhere, an auto-stop after a pause, or an engine error. These
        /// keep stopping at once, exactly as before.
        case automatic
    }

    /// Seconds of extra listening for this stop; 0 means stop at once.
    ///
    /// The old "live paste finished segments" mode pastes the words heard so
    /// far at the moment of Stop. A tail there would hear the same words
    /// again, so that mode keeps stopping at once.
    public static func tailSeconds(source: StopSource, livePastesFinishedSegments: Bool) -> TimeInterval {
        guard source == .owner, !livePastesFinishedSegments else { return 0 }
        return ownerStopTailSeconds
    }
}

/// Runs `work` after `delay` seconds and returns a function that cancels it.
/// The app passes the main queue; tests pass a fake clock.
public typealias StopTailScheduler = (_ delay: TimeInterval, _ work: @escaping () -> Void) -> (() -> Void)

/// One stop, then exactly one end of capture: after the tail, or at once
/// when there is no tail. A second stop during the tail changes nothing.
/// Discarding (quitting) drops the end so it never runs.
///
/// Use from one thread only (the app uses the main thread).
public final class StopTailSequencer {
    public enum Phase: Equatable {
        case idle
        case tail
        case ended
    }

    public enum StopDecision: Equatable {
        /// No tail: capture ended before `stop` returned.
        case endedNow
        /// Capture ends after this many seconds.
        case tail(seconds: TimeInterval)
        /// A stop already ran for this recording; nothing changed.
        case ignoredAlreadyStopping
    }

    public private(set) var phase: Phase = .idle
    private let schedule: StopTailScheduler
    private var cancelTimer: (() -> Void)?
    private var onEnd: (() -> Void)?

    public init(schedule: @escaping StopTailScheduler) {
        self.schedule = schedule
    }

    /// True while the tail is running: the owner has stopped, but the
    /// microphone is still listening for the last word.
    public var isInTail: Bool { phase == .tail }

    /// Call when a new recording starts.
    public func reset() {
        cancelTimer?()
        cancelTimer = nil
        onEnd = nil
        phase = .idle
    }

    @discardableResult
    public func stop(tailSeconds: TimeInterval, onEnd: @escaping () -> Void) -> StopDecision {
        guard phase == .idle else { return .ignoredAlreadyStopping }
        guard tailSeconds > 0 else {
            phase = .ended
            onEnd()
            return .endedNow
        }
        phase = .tail
        self.onEnd = onEnd
        cancelTimer = schedule(tailSeconds) { [weak self] in
            self?.finishTail()
        }
        return .tail(seconds: tailSeconds)
    }

    /// Drops a running tail: its end never runs. Returns whether one was
    /// running.
    @discardableResult
    public func discard() -> Bool {
        guard phase == .tail else { return false }
        cancelTimer?()
        cancelTimer = nil
        onEnd = nil
        phase = .ended
        return true
    }

    private func finishTail() {
        guard phase == .tail else { return }
        phase = .ended
        cancelTimer = nil
        let end = onEnd
        onEnd = nil
        end?()
    }
}

/// Waits for the speech engine's final words or a timeout, whichever comes
/// first, and reports exactly once. Use from one thread only.
public final class FinalResultWait {
    public enum Outcome: String, Equatable {
        case finalResult = "final-result"
        case timedOut = "timed-out"
        case cancelled
    }

    private var cancelTimer: (() -> Void)?
    private var onDone: ((Outcome) -> Void)?

    public init(
        timeoutSeconds: TimeInterval,
        schedule: StopTailScheduler,
        onDone: @escaping (Outcome) -> Void
    ) {
        self.onDone = onDone
        cancelTimer = schedule(timeoutSeconds) { [weak self] in
            self?.finish(.timedOut)
        }
    }

    public var isDone: Bool { onDone == nil }

    /// The engine answered (final words or an error).
    public func signal() { finish(.finalResult) }

    /// Quitting: report `cancelled` now.
    public func cancel() { finish(.cancelled) }

    private func finish(_ outcome: Outcome) {
        guard let done = onDone else { return }
        onDone = nil
        cancelTimer?()
        cancelTimer = nil
        done(outcome)
    }
}

/// A value that is set once and handed to whoever asks, now or later.
/// The finish of a dictation starts at Stop but must not read the words
/// until the tail is over; this is where it waits. `nil` means the capture
/// was discarded. Use from one thread only.
public final class OneShotResult<Value> {
    private var resolved = false
    private var value: Value?
    private var waiters: [(Value?) -> Void] = []

    public init() {}

    public var isResolved: Bool { resolved }

    /// Sets the value. Later calls change nothing and return false.
    @discardableResult
    public func resolve(_ value: Value?) -> Bool {
        guard !resolved else { return false }
        resolved = true
        self.value = value
        let pending = waiters
        waiters = []
        pending.forEach { $0(value) }
        return true
    }

    /// Calls `handler` once with the value: now if it is set, else when it is.
    public func whenResolved(_ handler: @escaping (Value?) -> Void) {
        if resolved {
            handler(value)
        } else {
            waiters.append(handler)
        }
    }
}

/// What a dictation captured, read when capture really ended (after the
/// tail and Apple's last words), not at the moment of Stop. Words or loud
/// sound that arrive during the tail count as evidence of speech, so the
/// silent-recording guard never throws away the very words the tail kept.
public struct CaptureEndEvidence: Equatable {
    /// The words heard up to the end of capture.
    public var words: String
    /// When the live listener first heard words, if it did.
    public var firstPartialAt: Date?
    public var firstFinalAt: Date?
    public var totalSlices: Int
    public var slicesAtOrAboveNearSilent: Int
    public var slicesAtOrAboveStrictSilent: Int
    public var liveListenerHadError: Bool
    /// From the start of the dictation to the end of capture, tail included.
    public var capturedSeconds: Double

    public init(
        words: String,
        firstPartialAt: Date?,
        firstFinalAt: Date?,
        totalSlices: Int,
        slicesAtOrAboveNearSilent: Int,
        slicesAtOrAboveStrictSilent: Int,
        liveListenerHadError: Bool,
        capturedSeconds: Double
    ) {
        self.words = words
        self.firstPartialAt = firstPartialAt
        self.firstFinalAt = firstFinalAt
        self.totalSlices = totalSlices
        self.slicesAtOrAboveNearSilent = slicesAtOrAboveNearSilent
        self.slicesAtOrAboveStrictSilent = slicesAtOrAboveStrictSilent
        self.liveListenerHadError = liveListenerHadError
        self.capturedSeconds = capturedSeconds
    }

    /// The silent-recording guard's verdict on this capture.
    /// - Parameters:
    ///   - appleLiveCapture: Apple's live listener ran for this dictation.
    ///   - speechEngineHeardWords: Apple On-Device (New) returned words at
    ///     its finish.
    public func treatAsNoSpeech(appleLiveCapture: Bool, speechEngineHeardWords: Bool) -> Bool {
        SilentRecordingPolicy.treatAsNoSpeech(
            liveListenerRanWithoutError: appleLiveCapture && !liveListenerHadError,
            liveListenerHeardWords: firstPartialAt != nil || speechEngineHeardWords,
            recordingSeconds: capturedSeconds,
            slicesAtOrAboveNearSilent: slicesAtOrAboveNearSilent,
            slicesAtOrAboveStrictSilent: slicesAtOrAboveStrictSilent,
            totalSlices: totalSlices
        )
    }
}
