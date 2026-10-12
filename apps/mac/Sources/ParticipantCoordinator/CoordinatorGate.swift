import DeskHost
import Foundation
import ParticipantProcess

// The coordinator's lifecycle (`docs/desk-native-participant-contract.md`
// sections 7, 8, 9 and 14; plan S10; Codex Q21 and Q31-Q33): its own lock
// and closed flags, the lock epoch, the registry of live runs' handles, and
// the signal a shutdown waits on. Lock and the start of a window close or
// quit happen on the app's thread and must take effect before the call
// returns, without waiting for the actor (whose work may be waiting on the
// store), so this state lives behind its own lock instead.

/// What lock, unlock, window close and quit set, readable from any thread.
/// One lock covers it all, and the push gate's suspension is changed under
/// it too, so the flags and the pushes can never disagree (lock order:
/// this gate, then `ParticipantPushGate`, then the connection registry,
/// then the sink). So lock and the start of a close or quit wait, on the
/// app's thread, for a push already under way to return from the sink: a
/// sink's `push` must return promptly and never wait on the main thread
/// (`HostEventSink`). Handles are stopped outside the lock.
final class CoordinatorGate: @unchecked Sendable {
    struct State: Equatable {
        /// Lock began and no unlock answered it: starts are `store-locked`
        /// (section 7 step 1), nothing is pushed, text is not kept, and no
        /// participant write is attempted (Codex Q32).
        var locked = false
        /// A window close or quit began, until the next attach: starts are
        /// `store-locked`, nothing is pushed, text is not kept. It outlives
        /// the detach that ends a close, so nothing is kept or pushed with no
        /// window either.
        var closing = false
        /// Moves on every `lockNow()`, so an unlock verified before a later
        /// lock never applies.
        var lockEpoch = 0
        /// Moves on every `lockNow()` and every `beginShutdown`, repeats
        /// included (`ParticipantLane.lifecycleEpoch`): the WebKit
        /// transport drops an answer to a request admitted at another value.
        var lifecycleEpoch = 0
        /// Moves on every lock, window close or quit, and detach. A start
        /// admitted at one value that finds another spawns nothing (section
        /// 7: lock, close or quit during `starting` stops it).
        var serial = 0
        /// Moves each time lock or close drops the retained text, with the
        /// reason the drop gives (section 9: `locked`, `closed`).
        var textDrops = 0
        var dropReason = ParticipantLostReason.locked
        /// Moves each time lock or close stops every run: the coordinator
        /// then marks them stopping (section 10's status).
        var stopRounds = 0
        /// Monotonic milliseconds when the current window close or quit
        /// began: a close's one overall bound runs from here (Codex Q33).
        /// Cleared by the detach that ends a close, so a quit after it, with
        /// no window, begins its own bound. While it is set no stack is
        /// attached: an attach still refreshing its store when a close or
        /// quit begins attaches nothing.
        var shutdownBegan: UInt64?
        /// Monotonic milliseconds when the quit's bound began: its own
        /// `beginShutdown(quitting: true)`, or the window close under way
        /// then, whose bound it shares. Never cleared: a quit is final for
        /// the launch, so no detach restarts its bound and no stack is
        /// attached after it (Codex Q33: one 17 s maximum in all).
        var quitBegan: UInt64?

        /// Event text is kept only while neither lock nor close is under way.
        var keepsText: Bool { !locked && !closing }

        /// A close or quit under way, or a quit begun: no stack attaches.
        var refusesAttach: Bool { shutdownBegan != nil || quitBegan != nil }

        /// Where the bound of `finishShutdown(quitting:)` runs from: the
        /// quit's start for a quit; for a window close, its own start, or
        /// the quit's if that is earlier.
        func boundStart(quitting: Bool) -> UInt64? {
            if quitting { return quitBegan }
            return [shutdownBegan, quitBegan].compactMap { $0 }.min()
        }
    }

    private let lock = NSLock()
    private var current = State()
    /// Every spawned run whose process may still need a `stop`: from its
    /// spawn until its updates end.
    private var handles: [String: any ParticipantRunning] = [:]
    private let pushes: ParticipantPushGate

    init(pushes: ParticipantPushGate) {
        self.pushes = pushes
    }

    var state: State {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    var isLocked: Bool { state.locked }

    /// Lock: the flag, a new epoch, pushes suspended (an in-flight push
    /// finishes first), and every live handle returned for its `stop`. A
    /// repeat while locked moves the epochs only.
    func lockNow() -> [any ParticipantRunning] {
        lock.lock()
        defer { lock.unlock() }
        current.lockEpoch += 1
        current.lifecycleEpoch += 1
        guard !current.locked else { return [] }
        current.locked = true
        current.serial += 1
        current.textDrops += 1
        current.dropReason = .locked
        current.stopRounds += 1
        pushes.suspend()
        return Array(handles.values)
    }

    /// A window close or quit begins at monotonic `now`: the flag, the
    /// bound's start, pushes suspended, and every live handle returned for
    /// its `stop` (a cleanup-pending run's is one more cleanup retry). A
    /// repeat while that bound runs changes nothing, except that the first
    /// `quitting` call records the quit's start: the close's under way, or
    /// `now`, and that every call moves the lifecycle epoch.
    func beginShutdown(at now: UInt64, quitting: Bool) -> [any ParticipantRunning] {
        lock.lock()
        defer { lock.unlock() }
        current.lifecycleEpoch += 1
        if quitting, current.quitBegan == nil { current.quitBegan = current.shutdownBegan ?? now }
        guard current.shutdownBegan == nil else { return [] }
        current.closing = true
        current.shutdownBegan = now
        current.serial += 1
        current.textDrops += 1
        current.dropReason = .closed
        current.stopRounds += 1
        pushes.suspend()
        return Array(handles.values)
    }

    /// Clears the lock flag if no lock came since `epoch`; pushes resume
    /// unless a close or quit is under way. Returns whether it unlocked.
    func unlock(ifNoLockSince epoch: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard current.locked, current.lockEpoch == epoch else { return false }
        current.locked = false
        if !current.closing { pushes.resume() }
        return true
    }

    /// A close or quit under way refuses an attach (`attach`).
    var refusesAttach: Bool { state.refusesAttach }

    /// A Desk stack is attached, unless a window close or quit is under way
    /// (one that began while this attach refreshed its store included) or
    /// a quit began this launch: then nothing changes and it returns false.
    /// Otherwise a close that let the previous stack go is over, and pushes
    /// reach this stack unless the coordinator is locked.
    func attach(sink: HostEventSink, connections: ConnectionRegistry) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !current.refusesAttach else { return false }
        current.closing = false
        pushes.attach(sink: sink, connections: connections, suspended: current.locked)
        return true
    }

    /// The stack is let go: nothing is pushed to it from here, a start
    /// still in progress spawns nothing, and a close's bound ends with it
    /// (a quit's never does).
    func detach() {
        lock.lock()
        defer { lock.unlock() }
        current.serial += 1
        current.shutdownBegan = nil
        pushes.detach()
    }

    /// Registers a spawned run's handle. True when a lock, close, quit or
    /// detach came after its start was admitted at `serial` (or one is under
    /// way): its sweep may have missed this handle, so the caller stops it
    /// now. Either the sweep sees the handle or this sees the sweep.
    func register(runId: String, handle: any ParticipantRunning, admittedAt serial: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        handles[runId] = handle
        return current.serial != serial || current.locked || current.closing
    }

    /// The run's updates ended: its process needs no `stop` any more.
    func unregister(runId: String) {
        lock.lock()
        defer { lock.unlock() }
        handles[runId] = nil
    }
}

/// Wakes a shutdown waiting for the coordinator's runs and writes: every
/// change it may be waiting for, and its deadline's wake-up, signal it.
/// `wait(after:)` returns at once when a signal came after the ticket was
/// read, so a signal from another thread between a check and the wait is
/// never lost.
final class ProgressSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []

    var ticket: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func signal() {
        lock.lock()
        count += 1
        let resumed = waiting
        waiting = []
        lock.unlock()
        for continuation in resumed { continuation.resume() }
    }

    func wait(after ticket: Int) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock()
            if count != ticket {
                lock.unlock()
                continuation.resume()
                return
            }
            waiting.append(continuation)
            lock.unlock()
        }
    }
}
