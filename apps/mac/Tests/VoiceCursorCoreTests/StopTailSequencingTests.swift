import Foundation
import Testing
@testable import VoiceCursorCore

/// A pretend clock: scheduled work runs only when the test moves time on.
private final class FakeClock {
    private struct Item {
        let id: Int
        let due: TimeInterval
        let work: () -> Void
    }

    private(set) var now: TimeInterval = 0
    private var items: [Item] = []
    private var nextId = 0

    var pendingCount: Int { items.count }

    var scheduler: StopTailScheduler {
        { [unowned self] delay, work in
            let id = self.nextId
            self.nextId += 1
            self.items.append(Item(id: id, due: self.now + delay, work: work))
            return { [weak self] in self?.items.removeAll { $0.id == id } }
        }
    }

    func advance(by seconds: TimeInterval) {
        now += seconds
        while let index = items.indices
            .filter({ items[$0].due <= now })
            .min(by: { items[$0].due < items[$1].due }) {
            let item = items.remove(at: index)
            item.work()
        }
    }
}

@Suite("Stop tail policy")
struct StopTailPolicyTests {
    private func tail(
        _ timing: StopTailPolicy.InsertionTiming,
        _ action: StopTailPolicy.CompletionAction,
        preview: Bool = false,
        livePaste: Bool = false,
        source: StopTailPolicy.StopSource = .owner
    ) -> TimeInterval {
        StopTailPolicy.tailSeconds(
            source: source,
            insertionTiming: timing,
            completionAction: action,
            livePreviewActive: preview,
            livePastesFinishedSegments: livePaste
        )
    }

    @Test("Final Paste Only: the owner's Stop listens about half a second longer, for every action",
          arguments: StopTailPolicy.CompletionAction.allCases)
    func finalPasteOnlyGetsTail(action: StopTailPolicy.CompletionAction) {
        let seconds = tail(.finalPasteOnly, action)
        #expect(seconds == StopTailPolicy.ownerStopTailSeconds)
        #expect(seconds >= 0.4 && seconds <= 0.6)
    }

    @Test("Live Typewriter with Paste or Paste and Submit stops at once: live words are committed (and Return sent) at Stop",
          arguments: [StopTailPolicy.CompletionAction.autoPaste, .autoSubmit])
    func liveTypingStopsAtOnce(action: StopTailPolicy.CompletionAction) {
        #expect(tail(.liveTypewriter, action) == 0)
    }

    @Test("Live Typewriter with Copy or Archive types nothing live, so it keeps the tail",
          arguments: [StopTailPolicy.CompletionAction.clipboard, .archiveOnly])
    func liveTypewriterWithoutTypingGetsTail(action: StopTailPolicy.CompletionAction) {
        #expect(tail(.liveTypewriter, action) == StopTailPolicy.ownerStopTailSeconds)
    }

    @Test("Any running live preview stops at once, whatever the settings say",
          arguments: StopTailPolicy.InsertionTiming.allCases, StopTailPolicy.CompletionAction.allCases)
    func runningPreviewStopsAtOnce(timing: StopTailPolicy.InsertionTiming, action: StopTailPolicy.CompletionAction) {
        #expect(tail(timing, action, preview: true) == 0)
    }

    @Test("The old live-paste mode stops at once",
          arguments: StopTailPolicy.InsertionTiming.allCases, StopTailPolicy.CompletionAction.allCases)
    func livePasteModeHasNoTail(timing: StopTailPolicy.InsertionTiming, action: StopTailPolicy.CompletionAction) {
        #expect(tail(timing, action, livePaste: true) == 0)
    }

    @Test("Safety stops, auto-stops and engine errors still stop at once",
          arguments: StopTailPolicy.InsertionTiming.allCases, StopTailPolicy.CompletionAction.allCases)
    func automaticStopHasNoTail(timing: StopTailPolicy.InsertionTiming, action: StopTailPolicy.CompletionAction) {
        #expect(tail(timing, action, source: .automatic) == 0)
    }

    @Test("A tail never runs while live text is in the app or a live-mode Return is pending")
    func neverWithLiveTextOrPendingSubmit() {
        for timing in StopTailPolicy.InsertionTiming.allCases {
            for action in StopTailPolicy.CompletionAction.allCases {
                for preview in [false, true] {
                    for livePaste in [false, true] {
                        let liveText = preview || livePaste || (timing == .liveTypewriter && (action == .autoPaste || action == .autoSubmit))
                        let seconds = tail(timing, action, preview: preview, livePaste: livePaste)
                        #expect((seconds > 0) == !liveText, "\(timing) \(action) preview=\(preview) livePaste=\(livePaste)")
                    }
                }
            }
        }
    }
}

@Suite("Stop tail sequencer")
struct StopTailSequencerTests {
    @Test("A tail ends capture once, only after the tail is over")
    func tailEndsOnceAfterDelay() {
        let clock = FakeClock()
        let sequencer = StopTailSequencer(schedule: clock.scheduler)
        var ends = 0

        let decision = sequencer.stop(tailSeconds: 0.5) { ends += 1 }

        #expect(decision == .tail(seconds: 0.5))
        #expect(sequencer.isInTail)
        clock.advance(by: 0.49)
        #expect(ends == 0)
        #expect(sequencer.isInTail)
        clock.advance(by: 0.01)
        #expect(ends == 1)
        #expect(sequencer.phase == .ended)
        clock.advance(by: 5)
        #expect(ends == 1)
    }

    @Test("No tail ends capture before stop returns")
    func zeroTailEndsNow() {
        let clock = FakeClock()
        let sequencer = StopTailSequencer(schedule: clock.scheduler)
        var ends = 0

        let decision = sequencer.stop(tailSeconds: 0) { ends += 1 }

        #expect(decision == .endedNow)
        #expect(ends == 1)
        #expect(!sequencer.isInTail)
        #expect(clock.pendingCount == 0)
    }

    @Test("A second Stop during the tail changes nothing")
    func secondStopIgnored() {
        let clock = FakeClock()
        let sequencer = StopTailSequencer(schedule: clock.scheduler)
        var firstEnds = 0
        var secondEnds = 0

        sequencer.stop(tailSeconds: 0.5) { firstEnds += 1 }
        clock.advance(by: 0.2)
        let second = sequencer.stop(tailSeconds: 0.5) { secondEnds += 1 }
        let secondImmediate = sequencer.stop(tailSeconds: 0) { secondEnds += 1 }

        #expect(second == .ignoredAlreadyStopping)
        #expect(secondImmediate == .ignoredAlreadyStopping)
        #expect(secondEnds == 0)
        clock.advance(by: 0.3)
        #expect(firstEnds == 1)
        #expect(secondEnds == 0)
    }

    @Test("A Stop after the end is ignored too")
    func stopAfterEndIgnored() {
        let clock = FakeClock()
        let sequencer = StopTailSequencer(schedule: clock.scheduler)
        var ends = 0
        sequencer.stop(tailSeconds: 0.5) { ends += 1 }
        clock.advance(by: 1)

        #expect(sequencer.stop(tailSeconds: 0.5) { ends += 1 } == .ignoredAlreadyStopping)
        clock.advance(by: 1)
        #expect(ends == 1)
    }

    @Test("Discarding during the tail drops the end at once")
    func discardDropsEnd() {
        let clock = FakeClock()
        let sequencer = StopTailSequencer(schedule: clock.scheduler)
        var ends = 0
        sequencer.stop(tailSeconds: 0.5) { ends += 1 }
        clock.advance(by: 0.1)

        #expect(sequencer.discard())
        #expect(!sequencer.isInTail)
        #expect(clock.pendingCount == 0)
        clock.advance(by: 1)
        #expect(ends == 0)
        #expect(!sequencer.discard())
    }

    @Test("Discarding with no tail running does nothing")
    func discardWithoutTail() {
        let clock = FakeClock()
        let sequencer = StopTailSequencer(schedule: clock.scheduler)
        #expect(!sequencer.discard())
        #expect(sequencer.phase == .idle)
    }

    @Test("A new recording starts clean, and an old tail can't end it")
    func resetForNewRecording() {
        let clock = FakeClock()
        let sequencer = StopTailSequencer(schedule: clock.scheduler)
        var oldEnds = 0
        var newEnds = 0
        sequencer.stop(tailSeconds: 0.5) { oldEnds += 1 }

        sequencer.reset()
        #expect(sequencer.phase == .idle)
        clock.advance(by: 1)
        #expect(oldEnds == 0)

        sequencer.stop(tailSeconds: 0.5) { newEnds += 1 }
        clock.advance(by: 0.5)
        #expect(newEnds == 1)
        #expect(oldEnds == 0)
    }
}

@Suite("Final result wait")
struct FinalResultWaitTests {
    @Test("The engine's answer before the timeout is reported once")
    func signalBeforeTimeout() {
        let clock = FakeClock()
        var outcomes: [FinalResultWait.Outcome] = []
        let wait = FinalResultWait(timeoutSeconds: 1.0, schedule: clock.scheduler) { outcomes.append($0) }

        clock.advance(by: 0.3)
        wait.signal()
        wait.signal()
        clock.advance(by: 2)

        #expect(outcomes == [.finalResult])
        #expect(wait.isDone)
        #expect(clock.pendingCount == 0)
    }

    @Test("No answer in time reports a timeout once; a late answer is ignored")
    func timeoutThenLateSignal() {
        let clock = FakeClock()
        var outcomes: [FinalResultWait.Outcome] = []
        let wait = FinalResultWait(timeoutSeconds: 1.0, schedule: clock.scheduler) { outcomes.append($0) }

        clock.advance(by: 0.99)
        #expect(outcomes.isEmpty)
        clock.advance(by: 0.01)
        wait.signal()

        #expect(outcomes == [.timedOut])
    }

    @Test("Cancelling reports at once and stops the timer")
    func cancelReportsOnce() {
        let clock = FakeClock()
        var outcomes: [FinalResultWait.Outcome] = []
        let wait = FinalResultWait(timeoutSeconds: 1.0, schedule: clock.scheduler) { outcomes.append($0) }

        wait.cancel()
        clock.advance(by: 2)
        wait.signal()

        #expect(outcomes == [.cancelled])
    }
}

@Suite("One-shot result")
struct OneShotResultTests {
    @Test("A waiter that comes first gets the value when it is set")
    func waiterBeforeValue() {
        let result = OneShotResult<String>()
        var received: [String?] = []
        result.whenResolved { received.append($0) }
        #expect(received.isEmpty)

        #expect(result.resolve("invented words for a test"))
        #expect(received == ["invented words for a test"])
    }

    @Test("A waiter that comes later gets the value at once")
    func waiterAfterValue() {
        let result = OneShotResult<String>()
        result.resolve("sample phrase")
        var received: [String?] = []
        result.whenResolved { received.append($0) }
        #expect(received == ["sample phrase"])
    }

    @Test("Only the first value counts; a discard is nil")
    func firstValueWins() {
        let result = OneShotResult<String>()
        var received: [String?] = []
        result.whenResolved { received.append($0) }

        #expect(result.resolve(nil))
        #expect(!result.resolve("too late"))
        result.whenResolved { received.append($0) }

        #expect(received == [nil, nil])
        #expect(result.isResolved)
    }
}

@Suite("Speech evidence at the end of capture")
struct CaptureEndEvidenceTests {
    private let start = Date(timeIntervalSince1970: 1_000)

    @Test("A one-word dictation whose only speech arrives during the tail is not treated as no speech")
    func oneWordInTailIsKept() {
        // At the moment of Stop: nothing heard yet, only quiet slices.
        let atStop = CaptureEndEvidence(
            words: "",
            firstPartialAt: nil,
            firstFinalAt: nil,
            totalSlices: 40,
            slicesAtOrAboveNearSilent: 2,
            slicesAtOrAboveStrictSilent: 3,
            liveListenerHadError: false,
            capturedSeconds: 0.8
        )
        #expect(atStop.treatAsNoSpeech(appleLiveCapture: true, speechEngineHeardWords: false),
                "the old snapshot at Stop would have dropped the word")

        // At the end of capture: the word and its loud slices came in the tail.
        let atEnd = CaptureEndEvidence(
            words: "invented",
            firstPartialAt: start.addingTimeInterval(1.0),
            firstFinalAt: nil,
            totalSlices: 65,
            slicesAtOrAboveNearSilent: 14,
            slicesAtOrAboveStrictSilent: 16,
            liveListenerHadError: false,
            capturedSeconds: 1.3
        )
        #expect(!atEnd.treatAsNoSpeech(appleLiveCapture: true, speechEngineHeardWords: false))
    }

    @Test("Loud tail slices alone keep the words when the listener can't be trusted")
    func loudTailSlicesCount() {
        let atEnd = CaptureEndEvidence(
            words: "sample",
            firstPartialAt: nil,
            firstFinalAt: nil,
            totalSlices: 60,
            slicesAtOrAboveNearSilent: 11,
            slicesAtOrAboveStrictSilent: 12,
            liveListenerHadError: true,
            capturedSeconds: 1.2
        )
        #expect(!atEnd.treatAsNoSpeech(appleLiveCapture: true, speechEngineHeardWords: false))
    }

    @Test("Real silence is still treated as no speech")
    func silenceStillDropped() {
        let silent = CaptureEndEvidence(
            words: "invented filler text",
            firstPartialAt: nil,
            firstFinalAt: nil,
            totalSlices: 300,
            slicesAtOrAboveNearSilent: 1,
            slicesAtOrAboveStrictSilent: 2,
            liveListenerHadError: false,
            capturedSeconds: 6.5
        )
        #expect(silent.treatAsNoSpeech(appleLiveCapture: true, speechEngineHeardWords: false))
        #expect(!silent.treatAsNoSpeech(appleLiveCapture: false, speechEngineHeardWords: true))
    }
}
