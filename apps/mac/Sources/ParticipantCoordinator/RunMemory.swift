import DeskHost
import Foundation
import ParticipantProcess

// What the coordinator remembers of the runs this launch starts
// (`docs/desk-native-participant-contract.md` sections 7, 10 and 17): a
// start in progress, a start record whose write is undetermined, a spawned
// run with its updates, its Stops and the persistence of its terminal and
// cleanup evidence, and a never-spawned run whose terminal is durable.
// Memory only and text-free; event text is kept apart, in `RetainedRun`.
//
// Every start of this launch has memory from its starting mark until it
// either refuses (nothing written), or its run is spawned and owned here,
// or a terminal for a run that never spawned is durable. In that last case
// the memory moves from here to the coordinator's pending cancellations
// when the terminal's write begins: once the run's start record is
// durable, that exact terminal stays pending through every failure,
// definite ones included, until a retry makes it durable; then it moves to
// the ended runs (`EndedRun`). If the store holds another terminal for the
// run, or no entry, it stays pending, conflicted, never retried, until the
// app quits (Codex S9 ruling a). So the read side's "earlier launch" answers
// (`exit-unrecorded`, `not-owned`) never stand in for a run this launch
// dispatched (Codex S7 reading (c), Q28), and every run whose events are
// retained has run memory beside them (plan S9: the three reads agree when
// the store cannot be read).

/// A run this launch is starting or has started.
struct OwnedRun {
    enum Phase {
        /// Section 7 steps 13-15: marked `starting`, its availability
        /// recheck or its start record's write in flight.
        case starting(StartingRun)
        /// The start record's write was undetermined. Nothing was spawned,
        /// and nothing ever is for this attempt; the next start, Stop or
        /// status of the run re-reads the folder first.
        case uncertain(UncertainStart)
        /// Spawned: this launch owns its process group and its updates.
        case live(LiveRun)
    }

    let runId: String
    let sessionId: String
    var phase: Phase

    /// Section 7 step 12: a start in progress, or a spawned run whose
    /// cleanup, updates or terminal and cleanup writes are not done (Codex
    /// Q31), or whose confirmation revocation is claimed and has not
    /// returned from the owner (Codex S8 R1). An undetermined start record
    /// spawned nothing and never will, so it blocks no other run (it still
    /// blocks its own: step 7, after its re-read).
    var blocksStarts: Bool {
        switch phase {
        case .starting: return true
        case .uncertain: return false
        case .live(let live): return live.blocksStarts
        }
    }
}

/// One start between its starting mark and its end.
struct StartingRun {
    let requestId: UUID
    /// A Stop arrived while starting. Lock, window close, quit and detach
    /// are seen through the gate's counter instead (`AdmittedStart.serial`).
    var stopRequested = false
    /// Where Stops wait for this start to end.
    let latch = StartLatch()
}

/// Where Stops wait for one start to end (section 7: Stop during
/// `starting` waits for the start). Resolved once, by the start, on every
/// path out of it; a Stop arriving later gets that answer at once.
final class StartLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var end: StartEnd?
    private var waiting: [CheckedContinuation<StartEnd, Never>] = []
    private var count = 0

    func wait() async -> StartEnd {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let end {
                lock.unlock()
                continuation.resume(returning: end)
                return
            }
            waiting.append(continuation)
            count += 1
            lock.unlock()
        }
    }

    /// The first call decides; later ones change nothing.
    func resolve(_ end: StartEnd) {
        lock.lock()
        guard self.end == nil else {
            lock.unlock()
            return
        }
        self.end = end
        let resumed = waiting
        waiting = []
        lock.unlock()
        for continuation in resumed { continuation.resume(returning: end) }
    }

    /// Stops that have waited here (a test probe).
    var waiters: Int {
        lock.lock(); defer { lock.unlock() }
        return count
    }
}

/// What a Stop that waited on a start does once the start has ended.
enum StartEnd: Sendable {
    /// The start answered for it: the run's start record is durable and the
    /// Stop came first, so the start recorded `stopped` `local-stop` at
    /// sequence 1 with nothing spawned (or that write's failure).
    case answered(CancellationResult)
    /// The run is no longer starting: read it again (not dispatched, a
    /// cancellation in flight, or an undetermined start record).
    case reevaluate
}

/// An undetermined start record of this launch.
struct UncertainStart {
    let requestId: UUID
    /// The run whose events were kept when the write was undetermined. A
    /// re-read that finds the record replaces them (Codex Q30) only while
    /// they are still the ones kept: a run started since is newer.
    let retainedBefore: String?
}

/// What an authoritative re-read made of an undetermined start record.
enum UncertainResolution: Sendable {
    /// The record is there: nothing ran, and `failed` `process-error` at
    /// sequence 1 was written (this is that write's result; a failure
    /// leaves the terminal pending in the coordinator, never forgotten).
    case found(CancellationResult)
    /// The record is not there: the run is as the folder shows it.
    case absent
    /// The re-read failed: still undetermined.
    case unresolved
    /// Another request's re-read settled it first: read the run as usual.
    case settled
}

/// What one write of a terminal for a run that never spawned came to (a
/// never-dispatched cancellation, a Stop during the start record's write,
/// a spawn that threw, or an undetermined start record found later).
enum CancellationResult: Sendable {
    case recorded(ParticipantEvent)
    case refused(HostRefusal)
    case undetermined
}

/// A spawned run as this launch knows it.
struct LiveRun {
    let handle: any ParticipantRunning
    let watch: UpdatesWatch
    /// The highest sequence applied.
    var lastSequence = 0
    var terminal: ParticipantEvent?
    /// As recorded with the terminal, then true once the group cleared.
    var groupCleared: Bool?
    /// The run's process group is confirmed gone, or its ownership is lost
    /// (`cleanupReleased`).
    var cleanupReleased = false
    /// The coordinator consumed every update and saw the stream end. Not
    /// the same fact as `cleanupReleased` (R1-f): either can come first,
    /// and either can never come.
    var updatesFinished = false
    /// Updates applied so far (a test probe; order is the stream's).
    var applied = 0
    /// Paid overflow was observed for this run (section 17).
    var overflowObserved = false
    /// A Stop asked the run to stop: section 10's `stopping` until its
    /// terminal. Set by the first Stop, which signalled.
    var stopRequested = false
    /// Where Stops of the running or stopping run wait for its terminal;
    /// every Stop shares it, and with it the one terminal.
    var terminalLatch: WaitLatch?
    /// Where Stops wait on a cleanup retry in progress; cleared when the
    /// retry answers, so the next Stop retries again.
    var retryLatch: WaitLatch?
    /// The terminal and cleanup evidence as written to the store (Codex Q31).
    var persistence = RunPersistence()

    init(handle: any ParticipantRunning, watch: UpdatesWatch) {
        self.handle = handle
        self.watch = watch
    }

    /// Section 7 step 12 (Codex S5 rulings, Q31, S8 R1): a spawned run blocks
    /// every other start until its cleanup is released, its updates are all
    /// consumed, its terminal and cleanup evidence are durable, and any
    /// confirmation revocation claimed for it has returned from the owner.
    var blocksStarts: Bool {
        !(cleanupReleased && updatesFinished && persistence.isResolved) || watch.revocationOutstanding
    }

    /// Section 10's `cleanup-pending`, once a terminal is in: the group is
    /// not confirmed gone (`groupCleared` false) and cleanup is not
    /// released. A cleared group, or none spawned (`groupCleared` true or
    /// null, released right after), is `exited` at once, even before the
    /// release is applied; so is a released one (ownership lost, both
    /// pipes at EOF). Not the busy rule above. Process truth: a write still
    /// pending does not change it (Codex Q31).
    var isCleanupPending: Bool { groupCleared == false && !cleanupReleased }
}

/// A spawned run's terminal and cleanup evidence as the store holds them
/// (Codex Q31). The exact terminal (its sequence, `at` and reason) and the
/// `groupCleared` recorded with it are written first; the later
/// `groupCleared` true, owed only after an actual group probe found the
/// group gone (`.groupCleared`), is a separate write after it. Each write is
/// idempotent in the store, so a retry after an undetermined one is safe.
/// Nothing here is published as durable: only the store's own runs copy
/// is, after a durable write.
struct RunPersistence {
    /// The exact record the run's terminal event writes.
    var terminal: ParticipantRunTerminal?
    /// The `groupCleared` recorded with the terminal (true, false, or null
    /// when nothing ran).
    var recordedGroupCleared: Bool?
    /// The group cleared after a terminal that recorded false: `true` is owed.
    var clearedLater = false
    var terminalDurable = false
    var clearedDurable = false
    /// The last attempt was undetermined: the folder may show it, not durably.
    var uncertain = false
    /// The store holds another terminal or no such run (or a cleanup
    /// upgrade is owed with no terminal to name, which no reader order
    /// produces): nothing here ever replaces it, so the write is not
    /// retried, and it stays unresolved.
    var conflict = false
    /// Write attempts made (a test probe).
    var attempts = 0

    /// A write is owed and may be attempted.
    var owesWrite: Bool {
        !conflict && ((terminal != nil && !terminalDurable) || (clearedLater && !clearedDurable))
    }

    /// Everything memory holds is durable.
    var isResolved: Bool {
        (terminal == nil || terminalDurable) && (!clearedLater || clearedDurable)
    }

    /// What a durable entry of the run proves: this exact terminal is
    /// durable when the entry holds it, and the cleanup upgrade when the
    /// entry also holds `groupCleared` true. Another terminal proves
    /// nothing here (the write finds it).
    mutating func adopt(_ entry: ParticipantRunEntry?) {
        guard let entry, let terminal, entry.terminal == terminal else { return }
        terminalDurable = true
        if entry.groupCleared == true { clearedDurable = true }
    }
}

/// A never-spawned run of this launch whose terminal is durable: the text-free
/// memory beside its retained events, so status, Stop and events agree from
/// memory when the store cannot be read (plan S9).
struct EndedRun {
    let sessionId: String
    let terminal: ParticipantEvent
    let groupCleared: Bool?
}

/// Where requests wait for one fact about a live run (its terminal, or a
/// cleanup retry's answer). Resolved once; a later `wait` returns at once.
final class WaitLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var resolved = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            if resolved {
                lock.unlock()
                continuation.resume()
                return
            }
            waiting.append(continuation)
            lock.unlock()
        }
    }

    func resolve() {
        lock.lock()
        guard !resolved else {
            lock.unlock()
            return
        }
        resolved = true
        let resumed = waiting
        waiting = []
        lock.unlock()
        for continuation in resumed { continuation.resume() }
    }

    /// Requests waiting here now (a test probe).
    var waiters: Int {
        lock.lock(); defer { lock.unlock() }
        return resolved ? 0 : waiting.count
    }
}

// MARK: Section 17's five-second rule

/// Section 17's owner of the confirmation that paid usage is off, as the
/// coordinator sees it. Its one Sources conformer is
/// `PaidUsageConfirmationOwner` (plan F4, below), which nothing in the app
/// constructs yet (F7 composes activation); tests also give fakes. Without
/// one there is no confirmation, so there is nothing to end or claim, and
/// availability stays `overflow-unverified` in shipping. These are the
/// coordinator's two calls (Codex S5 rulings; F0 answer 12).
protocol ParticipantConfirmationOwning: Sendable {
    /// Paid overflow may have been in use: end the confirmation with
    /// `endedBy` `paid-overflow`. An ended confirmation is never revived;
    /// a repeat is harmless. The confirmation must read ended before this
    /// returns (starts are busy until then: Codex S8 R1).
    ///
    /// It must return promptly: no wait on the main thread, no user
    /// interaction, no slow or blocking I/O. An overflow observation calls
    /// it on the coordinator, in the run's order (`UpdatesWatch`), and
    /// every request, status, events and Stop included, waits until it
    /// returns. The wake-up and a late end call it off the coordinator.
    func endForPaidOverflow()

    /// Section 7's run claim (Codex F0 answer 12): called once per start, on
    /// the coordinator, synchronously, after the durable step-14 start
    /// record and the lifecycle checks after it, immediately before the
    /// dispatch, with no await between a successful claim and the launch.
    /// True counts the run against the active confirmation (the fifth ends
    /// it with `run-limit`; that fifth run may finish). False (none active)
    /// means nothing may be dispatched: the start takes the never-spawned
    /// failure path (`failed` `process-error` at sequence 1). A spawn that
    /// fails after a true claim still counts; nothing is refunded or
    /// retried. Same promptness duty as `endForPaidOverflow`.
    func claimRun() -> Bool
}

/// The section 17 owner, as the coordinator calls it.
extension PaidUsageConfirmationOwner: ParticipantConfirmationOwning {}

/// Wakes the coordinator at a monotonic time of its configured clock (the
/// five-second rule below). Tests drive a virtual one; nothing in Sources
/// constructs the coordinator, so `DispatchParticipantWakeups` is used only
/// by its own test until the app builds one.
public protocol ParticipantWakeups: Sendable {
    /// Calls `action` once, on some other thread, at or after the clock's
    /// monotonic time `at` (milliseconds), unless cancelled first. It may
    /// run any time later (scheduling, sleep), so its running is never
    /// proof that a deadline was met or missed on time (Codex S8 R1).
    func wake(atMonotonicMillis at: UInt64, _ action: @escaping @Sendable () -> Void) -> any ParticipantWakeup
}

public protocol ParticipantWakeup: Sendable {
    /// Stops an action that has not been taken to run yet. Cancelling is not
    /// a barrier: an action already taken (running, or taken and about to
    /// run on another thread) still runs, and may start after this
    /// returns. Every action therefore checks its own state when it runs
    /// (Codex S8 follow-up).
    func cancel()
}

/// `ParticipantWakeups` on a dispatch queue, checked against `clock`.
/// Dispatch time stops while the Mac sleeps and `CLOCK_MONOTONIC` does not,
/// so a timer set for the whole delay would fire late by however much of it
/// the Mac slept. The queue looks at the clock again at least once a second
/// instead: after a sleep the action runs within about a second of waking,
/// and it never runs before the clock reaches `at`.
public struct DispatchParticipantWakeups: ParticipantWakeups {
    /// The longest the queue waits before looking at the clock again.
    static let recheckMillis: UInt64 = 1_000

    private let clock: any ParticipantClock
    private let queue: DispatchQueue

    public init(clock: any ParticipantClock, queue: DispatchQueue = DispatchQueue(label: "participant-wakeups")) {
        self.clock = clock
        self.queue = queue
    }

    public func wake(atMonotonicMillis at: UInt64, _ action: @escaping @Sendable () -> Void) -> any ParticipantWakeup {
        let wakeup = DispatchWakeup(action: action)
        queue.async { arm(wakeup, at: at) }
        return wakeup
    }

    private func arm(_ wakeup: DispatchWakeup, at: UInt64) {
        guard !wakeup.isCancelled else { return }
        let now = clock.monotonicMillis()
        guard now < at else {
            wakeup.fire()
            return
        }
        let delay = Int(min(at - now, Self.recheckMillis))
        queue.asyncAfter(deadline: .now() + .milliseconds(delay)) { arm(wakeup, at: at) }
    }
}

/// One dispatch wake-up. `fire` takes the action under the lock and runs it
/// after unlocking, so a `cancel` that returns between the two does not
/// stop it: the weaker guarantee `ParticipantWakeup.cancel` states.
final class DispatchWakeup: ParticipantWakeup, @unchecked Sendable {
    private let lock = NSLock()
    private var action: (@Sendable () -> Void)?

    init(action: @escaping @Sendable () -> Void) {
        self.action = action
    }

    /// Cancelled, or already taken by `fire`.
    var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return action == nil
    }

    func fire() {
        lock.lock()
        let pending = action
        action = nil
        lock.unlock()
        pending?()
    }

    func cancel() {
        lock.lock(); defer { lock.unlock() }
        action = nil
    }
}

/// One spawned run's updates as section 17's five-second rule watches them
/// (Codex S5 rulings, S8 R1): once its cleanup is released at monotonic T,
/// its updates have until T + 5,000 ms to finish. If they have not (something
/// outside the group holds stdout open), the confirmation ends as for paid
/// overflow, once; the run keeps blocking starts until they finish or the
/// app quits. The rule adds no time to anything: it never extends a quit
/// bound or revives a confirmation.
///
/// The deadline is remembered, not left to the wake-up (Codex S8 R1). The
/// wake-up may run late or, once taken, after it was cancelled
/// (`ParticipantWakeup`), so it is only one of the two ways the rule can
/// fail. The other is the coordinator seeing the updates end: it reads the
/// monotonic clock then, and an end seen at or after the deadline missed
/// the five seconds even when the wake-up has not run. An end seen before
/// the deadline meets the rule; a wake-up that runs after it finds the
/// watch finished and does nothing.
///
/// Each run ends the confirmation at most once. Whoever first decides it
/// must end (an overflow observation, the wake-up, or the late end) claims
/// the run's one revocation under the lock; every later decision finds it
/// claimed. A claimed revocation is outstanding until the owner's call
/// returns, and an outstanding one keeps every start `participant-busy`
/// (`LiveRun.blocksStarts`): no start passes admission while the
/// confirmation may still read active. The wake-up makes its call on its own
/// thread and the late end on `revocationQueue`, off the coordinator, so
/// status, events and Stop keep answering while either is outstanding. An
/// overflow observation's call is made in the run's order on the
/// coordinator, as before S8 R1, so the coordinator waits for that one
/// (`ParticipantConfirmationOwning.endForPaidOverflow` must return
/// promptly).
///
/// The coordinator's relay marks cleanup released as it arrives; the
/// coordinator marks an observed overflow and the updates finished, in the
/// run's order; the wake-up may run on another thread. One lock covers all
/// of it.
final class UpdatesWatch: @unchecked Sendable {
    static let graceMillis: UInt64 = 5_000

    /// Where a revocation claimed by the late end runs: off the coordinator,
    /// and off the shared concurrency pool, since the owner's call is
    /// synchronous and may take time. Concurrent, so one run's slow call
    /// never queues another run's (each run makes at most one).
    static let revocationQueue = DispatchQueue(label: "participant-confirmation-revocation", attributes: .concurrent)

    /// The run's one confirmation revocation.
    private enum Revocation {
        case none
        /// Claimed; the owner's call has not returned. Starts are busy.
        case outstanding
        /// The owner's call returned (or there is no owner to call).
        case done
    }

    private let lock = NSLock()
    private let owner: (any ParticipantConfirmationOwning)?
    private let clock: any ParticipantClock
    /// T + 5,000, once cleanup is released.
    private var deadline: UInt64?
    private var finished = false
    private var wakeup: (any ParticipantWakeup)?
    private var revocation = Revocation.none

    init(owner: (any ParticipantConfirmationOwning)?, clock: any ParticipantClock) {
        self.owner = owner
        self.clock = clock
    }

    /// Cleanup was released at monotonic `now`: from here the updates have
    /// `graceMillis` to finish. The deadline is kept before the wake-up is
    /// asked for.
    func cleanupReleased(at now: UInt64, wakeups: any ParticipantWakeups) {
        lock.lock()
        guard !finished, deadline == nil, revocation == .none else {
            lock.unlock()
            return
        }
        let due = now + Self.graceMillis
        deadline = due
        lock.unlock()
        let scheduled = wakeups.wake(atMonotonicMillis: due) { [weak self] in self?.gracePassed() }
        lock.lock()
        if finished || revocation != .none {
            lock.unlock()
            scheduled.cancel()
            return
        }
        wakeup = scheduled
        lock.unlock()
    }

    /// Every update was consumed and the stream ended, as of the clock's
    /// monotonic time read here, under the lock. Before the deadline (or
    /// with cleanup never released) the rule is met. At or after it the
    /// five seconds were missed, whether or not the wake-up has run: the
    /// revocation is claimed here unless something claimed it already, and
    /// made on `revocationQueue`. The caller publishes the updates finished
    /// only after this returns, so a start never sees them finished before
    /// a missed deadline's revocation is outstanding.
    func finish() {
        lock.lock()
        finished = true
        let scheduled = wakeup
        wakeup = nil
        var claimed = false
        if let deadline, clock.monotonicMillis() >= deadline { claimed = claimLocked() }
        lock.unlock()
        scheduled?.cancel()
        if claimed { Self.revocationQueue.async { self.revoke() } }
    }

    /// The run's own stream observed overflow (section 17): the
    /// confirmation ends now, unless the grace already ended it; the grace
    /// then has nothing left to end. Once per run either way: an ended
    /// confirmation is never revived, so once is all it needs. The owner is
    /// called here, in the run's order (unchanged by S8 R1).
    func overflowObserved() {
        lock.lock()
        let claimed = claimLocked()
        let scheduled = wakeup
        wakeup = nil
        lock.unlock()
        scheduled?.cancel()
        if claimed { revoke() }
    }

    /// The wake-up ran: at or after the deadline, possibly late, possibly
    /// after `finish` cancelled it. Updates already finished decided the
    /// rule themselves (and claimed the revocation if they missed it).
    private func gracePassed() {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        let claimed = claimLocked()
        wakeup = nil
        lock.unlock()
        if claimed { revoke() }
    }

    /// Takes the run's one revocation, with the lock held: true when the
    /// caller must make the owner's call. With no owner there is nothing to
    /// call or wait for.
    private func claimLocked() -> Bool {
        guard revocation == .none else { return false }
        guard owner != nil else {
            revocation = .done
            return false
        }
        revocation = .outstanding
        return true
    }

    /// The owner's call for a claimed revocation, outside the lock; starts
    /// stay busy until it returns.
    private func revoke() {
        owner?.endForPaidOverflow()
        lock.lock()
        revocation = .done
        lock.unlock()
    }

    /// Whether the confirmation was ended for this run, by the rule or by
    /// an observation: the decision, whose owner call may still be
    /// outstanding (a test probe).
    var endedConfirmation: Bool {
        lock.lock(); defer { lock.unlock() }
        return revocation != .none
    }

    /// A revocation is claimed and its owner call has not returned:
    /// section 7 step 12 answers `participant-busy` (Codex S8 R1).
    var revocationOutstanding: Bool {
        lock.lock(); defer { lock.unlock() }
        return revocation == .outstanding
    }
}
