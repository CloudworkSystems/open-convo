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
    @Test("The owner's Stop listens about half a second longer")
    func ownerStopGetsTail() {
        let seconds = StopTailPolicy.tailSeconds(source: .owner, livePastesFinishedSegments: false)
        #expect(seconds == StopTailPolicy.ownerStopTailSeconds)
        #expect(seconds >= 0.4 && seconds <= 0.6)
    }

    @Test("Safety stops, auto-stops and engine errors still stop at once")
    func automaticStopHasNoTail() {
        #expect(StopTailPolicy.tailSeconds(source: .automatic, livePastesFinishedSegments: false) == 0)
        #expect(StopTailPolicy.tailSeconds(source: .automatic, livePastesFinishedSegments: true) == 0)
    }

    @Test("The old live-paste mode keeps stopping at once")
    func livePasteModeHasNoTail() {
        #expect(StopTailPolicy.tailSeconds(source: .owner, livePastesFinishedSegments: true) == 0)
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
