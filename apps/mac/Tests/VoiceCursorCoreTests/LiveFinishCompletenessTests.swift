import Testing
@testable import VoiceCursorCore

@Suite("Live finish completeness")
struct LiveFinishCompletenessTests {
    private func clean() -> LiveFinishCompleteness {
        LiveFinishCompleteness(
            finalize: .finished,
            drained: true,
            readerFailed: false,
            droppedFrames: 0,
            conversionFailures: 0,
            lateBuffers: 0
        )
    }

    @Test("A clean finish is complete")
    func cleanFinishIsComplete() {
        #expect(clean().isComplete)
        #expect(clean().issue == nil)
    }

    @Test("A failed or timed-out finalize is incomplete")
    func finalizeProblems() {
        var failed = clean()
        failed.finalize = .failed
        #expect(failed.issue == .finalizeFailed)
        var timedOut = clean()
        timedOut.finalize = .timedOut
        #expect(timedOut.issue == .finalizeTimedOut)
    }

    @Test("Results that never finished arriving are incomplete")
    func notDrained() {
        var value = clean()
        value.drained = false
        #expect(value.issue == .lastWordsLate)
    }

    @Test("A results reader error is incomplete")
    func readerError() {
        var value = clean()
        value.readerFailed = true
        #expect(value.issue == .engineError)
    }

    @Test("Audio dropped while the engine got ready is incomplete")
    func droppedWhileStarting() {
        var value = clean()
        value.droppedFrames = 1024
        #expect(value.issue == .audioDroppedWhileStarting)
    }

    @Test("A failed audio conversion is incomplete")
    func conversionFailure() {
        var value = clean()
        value.conversionFailures = 1
        #expect(value.issue == .audioConversionFailed)
    }

    @Test("A microphone buffer after input ended is incomplete")
    func lateBuffer() {
        var value = clean()
        value.lateBuffers = 1
        #expect(value.issue == .audioAfterStop)
        #expect(!value.isComplete)
    }

    @Test("The finalize problem is reported first when several happen")
    func priority() {
        var value = clean()
        value.finalize = .timedOut
        value.drained = false
        value.readerFailed = true
        value.droppedFrames = 10
        value.conversionFailures = 2
        value.lateBuffers = 3
        #expect(value.issue == .finalizeTimedOut)
        value.finalize = .finished
        #expect(value.issue == .lastWordsLate)
        value.drained = true
        #expect(value.issue == .engineError)
        value.readerFailed = false
        #expect(value.issue == .audioDroppedWhileStarting)
        value.droppedFrames = 0
        #expect(value.issue == .audioConversionFailed)
        value.conversionFailures = 0
        #expect(value.issue == .audioAfterStop)
    }
}
