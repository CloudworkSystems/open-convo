import Foundation

/// Decides whether a live speech engine's finished text is complete, or
/// whether some of the dictation may be missing. Incomplete text is shown as
/// partial and never auto-submitted. Pure, so every path can be tested.
public enum LiveFinishIssue: Equatable, Sendable {
    case finalizeFailed
    case finalizeTimedOut
    case lastWordsLate
    case engineError
    case audioDroppedWhileStarting
    case audioConversionFailed
    case audioAfterStop
}

public enum LiveFinishOutcome: Equatable, Sendable {
    case finished
    case failed
    case timedOut
}

public struct LiveFinishCompleteness: Equatable, Sendable {
    public var finalize: LiveFinishOutcome
    /// The results stream ended on its own after a successful finalize.
    public var drained: Bool
    /// The engine's results reader stopped with an error.
    public var readerFailed: Bool
    /// Audio frames dropped because too much piled up before the engine was ready.
    public var droppedFrames: Int64
    /// Buffers that could not be converted to the engine's format (or flushed).
    public var conversionFailures: Int
    /// Microphone buffers that arrived after input had ended.
    public var lateBuffers: Int

    public init(
        finalize: LiveFinishOutcome,
        drained: Bool,
        readerFailed: Bool,
        droppedFrames: Int64,
        conversionFailures: Int,
        lateBuffers: Int
    ) {
        self.finalize = finalize
        self.drained = drained
        self.readerFailed = readerFailed
        self.droppedFrames = droppedFrames
        self.conversionFailures = conversionFailures
        self.lateBuffers = lateBuffers
    }

    /// nil means the text is complete. Otherwise the most important reason
    /// some words may be missing.
    public var issue: LiveFinishIssue? {
        switch finalize {
        case .failed: return .finalizeFailed
        case .timedOut: return .finalizeTimedOut
        case .finished: break
        }
        if !drained { return .lastWordsLate }
        if readerFailed { return .engineError }
        if droppedFrames > 0 { return .audioDroppedWhileStarting }
        if conversionFailures > 0 { return .audioConversionFailed }
        if lateBuffers > 0 { return .audioAfterStop }
        return nil
    }

    public var isComplete: Bool { issue == nil }
}
