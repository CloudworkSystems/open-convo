import Foundation

/// Decides when a finished recording was silence. Whisper invents text from
/// silence (for example "Thank you for watching these videos"), so a silent
/// recording must never be pasted or copied.
///
/// Evidence, 2026-09-27: Patrick's real dictations peaked around -38 to -42 dBFS
/// per second; the silent one never rose above -45 dBFS even in a single sample,
/// and Apple's live listener heard no words during it.
///
/// The rule counts how many short slices (one audio buffer each, about 20 ms)
/// reached speech loudness, instead of trusting the single loudest moment: a
/// cough or bump is a few slices, real speech is dozens.
public enum SilentRecordingPolicy {
    /// A slice at or above this level counts as speech-loud when Apple's live
    /// listener is trustworthy.
    public static let nearSilentThresholdDBFS: Double = -45

    /// A slice at or above this quieter level counts when Apple's listener
    /// can't be trusted, so quiet but real speech is never thrown away.
    public static let strictSilentThresholdDBFS: Double = -50

    /// Fewer speech-loud slices than this (about 0.2 seconds) counts as silence.
    public static let minimumSpeechSlices = 10

    /// Apple's listener can take up to about 4 seconds to report its first
    /// words, so "it heard nothing" only means something after this long.
    public static let minimumSecondsForListenerVerdict: Double = 5

    /// True when the finished recording should be treated as "no speech".
    /// - Parameters:
    ///   - liveListenerRanWithoutError: Apple's live recognizer ran for this
    ///     dictation and reported no real error (its own cancel on stop and
    ///     "no speech" don't count as errors).
    ///   - liveListenerHeardWords: it produced at least one partial result.
    ///   - recordingSeconds: length of the recording.
    ///   - slicesAtOrAboveNearSilent: slices at or above -45 dBFS.
    ///   - slicesAtOrAboveStrictSilent: slices at or above -50 dBFS.
    ///   - totalSlices: all slices recorded; 0 means loudness is unknown.
    public static func treatAsNoSpeech(
        liveListenerRanWithoutError: Bool,
        liveListenerHeardWords: Bool,
        recordingSeconds: Double,
        slicesAtOrAboveNearSilent: Int,
        slicesAtOrAboveStrictSilent: Int,
        totalSlices: Int
    ) -> Bool {
        guard totalSlices > 0 else { return false }
        // Once Apple's listener has heard words, the transcript is always kept,
        // even if the listener reported an error later in the dictation.
        if liveListenerHeardWords {
            return false
        }
        let listenerVerdictCounts = liveListenerRanWithoutError
            && recordingSeconds >= minimumSecondsForListenerVerdict
        if listenerVerdictCounts {
            return slicesAtOrAboveNearSilent < minimumSpeechSlices
        }
        return slicesAtOrAboveStrictSilent < minimumSpeechSlices
    }

    /// Converts the app's 0...1 meter level (dBFS -60...0 mapped linearly) back
    /// to dBFS.
    public static func dbfs(fromNormalizedLevel level: Double) -> Double {
        level <= 0 ? -60 : min(level, 1) * 60 - 60
    }
}
