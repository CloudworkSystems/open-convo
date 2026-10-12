import Foundation
@testable import DeskHost
@testable import ParticipantCoordinator
@testable import ParticipantProcess

// The fakes the vector harness and the start tests drive (contract section
// 19's `faults`, plan S8): store writes held or failed inside the store's
// lock, a gated availability recheck, the five-second rule's wake-ups on
// the virtual clock, and a recording confirmation owner. Holds and gates let
// themselves go after `vectorWaitSeconds` (a real bound: the case then
// fails). `waitUntil` only polls against that deadline (see there). Nothing
// in this package bounds an awaited call that never returns: no suite sets a
// time limit, and Swift Testing's `.timeLimit` could not interrupt a call
// that ignores cancellation anyway. Such a hang lasts until the test command
// is killed from outside (its own timeout, if the caller set one).

/// The holds' and gates' bound, and `waitUntil`'s polling deadline.
let vectorWaitSeconds: Double = 10

/// Store faults (section 19), armed and disarmed as a case's `faults` say,
/// plus the generic holds the start tests use. Every hold blocks the write
/// inside `ProofStore`'s lock until released, or for at most
/// `vectorWaitSeconds`.
final class VectorFaults: AtomicWriteFaults, @unchecked Sendable {
    enum Hold: Equatable {
        /// `hold-commit-write`: the commit's result write, its second
        /// replacement after its dispatch receipt, before its rename.
        case commitResult
        /// `hold-start-record-write`: the next write, before it begins.
        case nextWrite
    }

    private let lock = NSLock()
    private var hold: Hold?
    private var renamesSinceArmed = 0
    private var undetermined = false
    private var failStage: AtomicWriteStage?
    private var failSkips = 0
    private var holding = false
    private var timeouts = 0
    private var releaseSent = false
    private let reachedSignal = DispatchSemaphore(value: 0)
    private let releaseSignal = DispatchSemaphore(value: 0)

    /// `start-record-undetermined`: while set, every replacement's folder
    /// flush fails after its rename (so it is visible but not durable), and
    /// so does every later flush retry. The store stays unsynced.
    var undeterminedFlushes: Bool {
        get { lock.lock(); defer { lock.unlock() }; return undetermined }
        set { lock.lock(); defer { lock.unlock() }; undetermined = newValue }
    }

    /// Arms one hold; the write it matches waits inside the store's lock.
    func arm(_ hold: Hold) {
        lock.lock(); defer { lock.unlock() }
        self.hold = hold
        renamesSinceArmed = 0
    }

    /// The next write to reach `stage` fails before it with `EIO` (nil:
    /// none); `skipping` lets that many writes pass `stage` first.
    func fail(before stage: AtomicWriteStage?, skipping: Int = 0) {
        lock.lock(); defer { lock.unlock() }
        failStage = stage
        failSkips = skipping
    }

    /// Holds that ended because nothing released them within
    /// `vectorWaitSeconds` (a harness mistake: the case must fail).
    var holdTimeouts: Int {
        lock.lock(); defer { lock.unlock() }
        return timeouts
    }

    /// Releases a held write (or the next one to reach its hold).
    func release() {
        lock.lock()
        let signal = holding && !releaseSent
        if signal { releaseSent = true }
        hold = nil
        lock.unlock()
        if signal { releaseSignal.signal() }
    }

    /// Disarms everything and lets a held write go.
    func disarm() {
        lock.lock()
        undetermined = false
        failStage = nil
        lock.unlock()
        release()
    }

    var isHolding: Bool {
        lock.lock(); defer { lock.unlock() }
        return holding
    }

    /// Waits, off the shared pool, until a write is held.
    func waitUntilHeld() async -> Bool {
        await waitOffPool(reachedSignal, seconds: vectorWaitSeconds)
    }

    func fault(before stage: AtomicWriteStage, target: URL) -> Int32? {
        lock.lock()
        var holds = false
        switch (hold, stage) {
        case (.nextWrite?, .target):
            holds = true
        case (.commitResult?, .rename):
            renamesSinceArmed += 1
            holds = renamesSinceArmed == 2
        default:
            break
        }
        if holds {
            hold = nil
            holding = true
            releaseSent = false
        }
        var fails = false
        if failStage == stage {
            if failSkips > 0 {
                failSkips -= 1
            } else {
                fails = true
                failStage = nil
            }
        }
        let flushFails = stage == .directoryFlush && undetermined
        lock.unlock()
        if holds {
            reachedSignal.signal()
            let released = releaseSignal.wait(timeout: .now() + vectorWaitSeconds) == .success
            lock.lock()
            holding = false
            if !released { timeouts += 1 }
            lock.unlock()
        }
        return fails || flushFails ? EIO : nil
    }

    func flushRetryFault(target: URL) -> Int32? {
        undeterminedFlushes ? EIO : nil
    }
}

/// An async gate: `pass()` waits until `open()`, for at most
/// `vectorWaitSeconds` (then it opens itself, so nothing hangs, and counts
/// that as a timeout the case must fail on).
final class AsyncGate: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var arrivals = 0
    private var timeouts = 0

    func pass() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            arrivals += 1
            if isOpen {
                lock.unlock()
                continuation.resume()
                return
            }
            waiting.append(continuation)
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + vectorWaitSeconds) { [weak self] in self?.open(timedOut: true) }
        }
    }

    func open() {
        open(timedOut: false)
    }

    private func open(timedOut: Bool) {
        lock.lock()
        if timedOut, !isOpen { timeouts += 1 }
        isOpen = true
        let resumed = waiting
        waiting = []
        lock.unlock()
        for continuation in resumed { continuation.resume() }
    }

    /// Callers that reached the gate so far.
    var arrived: Int {
        lock.lock(); defer { lock.unlock() }
        return arrivals
    }

    /// Times the gate opened itself because nothing opened it.
    var timedOut: Int {
        lock.lock(); defer { lock.unlock() }
        return timeouts
    }
}

/// The availability fake a world reports through: the seeded report
/// (section 19's `availability`, or the shipping one when absent), which a
/// later case may change, and `hold-availability-recheck`'s gate.
final class VectorAvailability: AvailabilityReporting, @unchecked Sendable {
    private let lock = NSLock()
    private var current: any AvailabilityReporting
    private var gate: AsyncGate?
    /// Gates already released, kept for `gateTimeouts`.
    private var gates: [AsyncGate] = []

    init(_ reporter: any AvailabilityReporting) {
        current = reporter
    }

    func set(_ reporter: any AvailabilityReporting) {
        lock.lock(); defer { lock.unlock() }
        current = reporter
    }

    /// The next reports wait at a gate until it opens.
    func hold() -> AsyncGate {
        lock.lock(); defer { lock.unlock() }
        let gate = AsyncGate()
        self.gate = gate
        return gate
    }

    func releaseHold() {
        lock.lock()
        let gate = self.gate
        self.gate = nil
        if let gate { gates.append(gate) }
        lock.unlock()
        gate?.open()
    }

    /// Times any gate this fake made opened itself (a harness mistake).
    var gateTimeouts: Int {
        lock.lock(); defer { lock.unlock() }
        return (gates + [gate].compactMap { $0 }).reduce(0) { $0 + $1.timedOut }
    }

    func report() async -> ParticipantAvailabilityReport {
        let (gate, reporter) = state()
        if let gate { await gate.pass() }
        return await reporter.report()
    }

    /// A start's recheck (section 7 step 13) waits at the same gate, then
    /// asks the seeded reporter's own recheck.
    func recheck() async -> ParticipantAvailabilityReport {
        let (gate, reporter) = state()
        if let gate { await gate.pass() }
        return await reporter.recheck()
    }

    private func state() -> (AsyncGate?, any AvailabilityReporting) {
        lock.lock(); defer { lock.unlock() }
        return (gate, current)
    }
}

/// The coordinator's wake-ups as timeline entries of a `VirtualWorld`, so
/// they fire as virtual time passes them; a cancelled one leaves the
/// timeline (and no longer obliges settling). One the world has already
/// taken to run is not stopped by `cancel`, as `ParticipantWakeup` states.
final class VirtualWakeups: ParticipantWakeups, @unchecked Sendable {
    let world: VirtualWorld

    init(world: VirtualWorld) {
        self.world = world
    }

    /// Never dropped: a time that passed while the request crossed threads
    /// fires at the world's next step.
    func wake(atMonotonicMillis at: UInt64, _ action: @escaping @Sendable () -> Void) -> any ParticipantWakeup {
        VirtualWakeup(world: world, id: world.atOrNext(ms: at) { action() })
    }
}

struct VirtualWakeup: ParticipantWakeup, @unchecked Sendable {
    let world: VirtualWorld
    let id: Int

    func cancel() {
        world.cancel(id)
    }
}

/// Section 17's confirmation owner as a test fake: counts the ends, and
/// grants every run claim (the vectors' seeded availability decides; the
/// claim is the real owner's, `PaidUsageClaimTests`), counting them too: the
/// harness checks one claim per launch attempt over every vector.
final class RecordingConfirmationOwner: ParticipantConfirmationOwning, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var claimCount = 0

    func endForPaidOverflow() {
        lock.lock(); defer { lock.unlock() }
        count += 1
    }

    func claimRun() -> Bool {
        lock.lock(); defer { lock.unlock() }
        claimCount += 1
        return true
    }

    var paidOverflowEnds: Int {
        lock.lock(); defer { lock.unlock() }
        return count
    }

    var claims: Int {
        lock.lock(); defer { lock.unlock() }
        return claimCount
    }
}

/// Waits for `semaphore` on a dedicated thread, off the shared pool.
func waitOffPool(_ semaphore: DispatchSemaphore, seconds: Double) async -> Bool {
    await withCheckedContinuation { continuation in
        Thread { continuation.resume(returning: semaphore.wait(timeout: .now() + seconds) == .success) }.start()
    }
}

/// Polls `condition` until it holds or `seconds` have passed: a polling
/// deadline, checked between polls, not a timeout around the condition.
/// A condition that awaits (an actor call, say) and never returns is not
/// interrupted, and nothing else here bounds it: the wait, and the test run,
/// then hang until killed from outside (Codex S8 follow-up). `value(of:)`'s
/// condition awaits nothing, so its own wait is bounded.
func waitUntil(seconds: Double = vectorWaitSeconds, _ condition: () async -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(nanoseconds: 200_000)
    }
    return await condition()
}

/// A task's value, or nil if it has none by `seconds`. This wait is bounded:
/// its polling condition awaits nothing. The task is left to finish on its
/// own (or, if it awaits a call that never returns, never).
func value<T: Sendable>(of task: Task<T, Never>, within seconds: Double = vectorWaitSeconds) async -> T? {
    let box = ResultBox<T>()
    let watcher = Task { box.set(await task.value) }
    _ = await waitUntil(seconds: seconds) { box.value != nil }
    watcher.cancel()
    return box.value
}

final class ResultBox<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: T?

    func set(_ value: T) {
        lock.lock(); defer { lock.unlock() }
        stored = value
    }

    var value: T? {
        lock.lock(); defer { lock.unlock() }
        return stored
    }
}
