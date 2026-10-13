import Foundation
import Testing
@testable import DeskHost
@testable import ParticipantCoordinator
@testable import ParticipantProcess

// Codex's S8 review: R1 (section 17's five seconds and any confirmation
// revocation they require are part of the start admission barrier) and
// contract answer 1 (a request id released by an authoritative re-read that
// proved absence may start again, every check rerun, at most once). The
// held wake-up and the held owner below make both R1 races deterministic on
// the virtual clock. Invented data only; no real provider, CLI or sleep.
// Every hold here lets itself go after `vectorWaitSeconds` and is counted,
// so a hold nobody releases fails the test instead of hanging it. A
// coordinator call that never returned would still hang it: nothing bounds
// an awaited call (`waitUntil`).

/// Section 17's owner as a fake confirmation (Codex S8 R1): active until it
/// ends, as its own availability report shows (Q13 then lowers the answer to
/// `overflow-unverified`). The next end can be held after the call arrives
/// and before the confirmation changes.
final class HeldConfirmation: ParticipantConfirmationOwning, AvailabilityReporting, @unchecked Sendable {
    private let lock = NSLock()
    private let active: ParticipantConfirmationDisplay
    private var holdsNext = false
    private var isEnded = false
    private var callCount = 0
    private var endCount = 0
    private var timeouts = 0
    private let heldSignal = DispatchSemaphore(value: 0)
    private let releaseSignal = DispatchSemaphore(value: 0)

    init(active: ParticipantConfirmationDisplay) {
        self.active = active
    }

    /// The next `endForPaidOverflow` waits, the confirmation unchanged,
    /// until `release()` (or `vectorWaitSeconds`, counted as a timeout).
    func holdNextEnd() {
        lock.lock(); defer { lock.unlock() }
        holdsNext = true
    }

    /// Waits, off the shared pool, until a held end has arrived.
    func waitUntilHeld() async -> Bool {
        await waitOffPool(heldSignal, seconds: vectorWaitSeconds)
    }

    func release() {
        releaseSignal.signal()
    }

    func endForPaidOverflow() {
        lock.lock()
        callCount += 1
        let holds = holdsNext
        holdsNext = false
        lock.unlock()
        if holds {
            heldSignal.signal()
            let released = releaseSignal.wait(timeout: .now() + vectorWaitSeconds) == .success
            if !released {
                lock.lock(); timeouts += 1; lock.unlock()
            }
        }
        lock.lock()
        isEnded = true
        endCount += 1
        lock.unlock()
    }

    func report() async -> ParticipantAvailabilityReport {
        ParticipantAvailabilityReport(availability: .available, confirmation: ended ? .ended(.paidOverflow) : active)
    }

    func recheck() async -> ParticipantAvailabilityReport {
        await report()
    }

    /// Granted while it has not ended, as the real owner's claim is.
    func claimRun() -> Bool {
        !ended
    }

    /// Whether a call changed the confirmation.
    var ended: Bool {
        lock.lock(); defer { lock.unlock() }
        return isEnded
    }

    /// Calls that arrived, held or not.
    var calls: Int {
        lock.lock(); defer { lock.unlock() }
        return callCount
    }

    /// Calls that changed the confirmation (returned).
    var ends: Int {
        lock.lock(); defer { lock.unlock() }
        return endCount
    }

    var holdTimeouts: Int {
        lock.lock(); defer { lock.unlock() }
        return timeouts
    }
}

/// Wake-ups that never run by themselves (Codex S8 R1): an action runs only
/// when the test delivers it, however far virtual time has passed its time,
/// as when a dispatch thread is late, or has taken the action and not run
/// it yet. `deliverAll` runs every action once, on the calling thread,
/// cancelled ones included: once taken, an action is not stopped by
/// `cancel` (`ParticipantWakeup.cancel`), so this is the harshest delivery
/// the watch can meet.
final class HeldWakeups: ParticipantWakeups, @unchecked Sendable {
    final class Entry: ParticipantWakeup, @unchecked Sendable {
        let at: UInt64
        private let action: @Sendable () -> Void
        private let lock = NSLock()
        private var cancelled = false
        private var ran = false

        init(at: UInt64, action: @escaping @Sendable () -> Void) {
            self.at = at
            self.action = action
        }

        func cancel() {
            lock.lock(); defer { lock.unlock() }
            cancelled = true
        }

        var isCancelled: Bool {
            lock.lock(); defer { lock.unlock() }
            return cancelled
        }

        func runOnce() {
            lock.lock()
            let first = !ran
            ran = true
            lock.unlock()
            if first { action() }
        }
    }

    private let lock = NSLock()
    private var entries: [Entry] = []

    func wake(atMonotonicMillis at: UInt64, _ action: @escaping @Sendable () -> Void) -> any ParticipantWakeup {
        let entry = Entry(at: at, action: action)
        lock.lock(); entries.append(entry); lock.unlock()
        return entry
    }

    /// The monotonic times asked for, in order.
    var times: [UInt64] {
        lock.lock(); defer { lock.unlock() }
        return entries.map(\.at)
    }

    var cancelled: Int {
        lock.lock(); defer { lock.unlock() }
        return entries.filter(\.isCancelled).count
    }

    func deliverAll() {
        lock.lock()
        let all = entries
        lock.unlock()
        for entry in all { entry.runOnce() }
    }
}

/// Advances `world` on a thread of its own, as a dispatch wake-up runs on
/// its queue: a wake-up's action that blocks (a held owner) blocks only that
/// thread. The task's value is true once the advance returned without error.
func advanceOnItsOwnThread(_ world: VirtualWorld, to target: UInt64) -> Task<Bool, Never> {
    Task {
        await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            Thread { continuation.resume(returning: (try? world.advance(to: target)) != nil) }.start()
        }
    }
}

@Suite("Participant coordinator: confirmation expiry before start admission (Codex S8 R1)")
struct ConfirmationExpiryTests {
    typealias Start = ParticipantCoordinatorStartTests
    typealias Manual = ParticipantCoordinatorStartTests.Manual

    /// Vector #34's two runs, both prepared and never dispatched, with
    /// availability from `confirmation`, and a hand-driven coordinator whose
    /// owner it is.
    static func world(wakeups: (any ParticipantWakeups)? = nil) async throws -> (VectorWorld, HeldConfirmation, Manual) {
        let world = try await Start.twoRuns()
        let active = try #require(ParticipantConfirmationDisplay.active(confirmedAt: Start.clock, runsLeft: 5))
        let confirmation = HeldConfirmation(active: active)
        world.availability.set(confirmation)
        let manual = try await Manual(world, confirmation: confirmation, wakeups: wakeups)
        return (world, confirmation, manual)
    }

    /// Run 1 started under the active confirmation, with its terminal
    /// (group cleared) and `cleanup-released` applied; the stream left open.
    static func released(_ manual: Manual) async throws -> ManualRun {
        let started = try await manual.send(.participantStart, Start.start(1))
        #expect(started.outcome == .ok, "\(started.jsonValue)")
        let run = try #require(manual.launcher.runs.first)
        run.send(.event(manual.event(1, .started)))
        run.send(.terminal(manual.event(2, .completed), groupCleared: true))
        run.send(.cleanupReleased)
        #expect(await manual.applied(3))
        return run
    }

    /// Status, events, Stop and availability answer at once (bounded),
    /// from memory: run 1 exited with its terminal.
    static func answersMeanwhile(_ manual: Manual, sourceLocation: SourceLocation = #_sourceLocation) async throws {
        let status = try await manual.ask(.participantStatus, Start.read(1))
        #expect(status.fields["state"] == .string("exited") && status.fields["groupCleared"] == .bool(true), "\(status.jsonValue)",
                sourceLocation: sourceLocation)
        let events = try await manual.ask(.participantEvents, Start.events(1))
        #expect(events.outcome == .ok && events.fields["lastSequence"] == .number(2), "\(events.jsonValue)", sourceLocation: sourceLocation)
        let stop = try await manual.ask(.participantStop, Start.read(1))
        #expect(stop.fields["state"] == .string("exited"), "\(stop.jsonValue)", sourceLocation: sourceLocation)
        let availability = try await manual.ask(.participantAvailability, [:])
        #expect(availability.outcome == .ok, sourceLocation: sourceLocation)
    }

    /// The one entry of an availability answer.
    static func entry(_ reply: HostResponse) -> [String: JSONValue]? {
        guard case .array(let entries)? = reply.fields["participants"] else { return nil }
        return entries.first?.objectValue
    }

    @Test("R1 (1): the due wake-up held, updates that finish after +5,000 ms still end the confirmation: the end seen late claims the one revocation, every start is participant-busy while the owner's call is outstanding (status, events, Stop and availability answer meanwhile), then participant-unavailable; nothing launches under the old active confirmation, and the late callback revokes nothing more")
    func lateWakeupFinishAfterDeadline() async throws {
        let wakeups = HeldWakeups()
        let (world, confirmation, manual) = try await Self.world(wakeups: wakeups)
        defer { world.clean() }
        let run = try await Self.released(manual)
        let released = world.virtual.now
        #expect(wakeups.times == [released + UpdatesWatch.graceMillis], "the wake-up was asked for at +5,000 ms")

        // The due callback is held: time passes it and nothing runs.
        try world.virtual.advance(to: released + 5_001)
        #expect(confirmation.calls == 0)
        #expect(try await manual.busy(), "updates unfinished")
        confirmation.holdNextEnd()
        run.finish()
        #expect(await confirmation.waitUntilHeld(), "the end, seen at +5,001, claimed the revocation and called the owner")
        #expect(await manual.finished(revocations: false), "every update applied, the end seen, the terminal durable")
        #expect(await manual.coordinator.consumption(of: Start.runId(1))?.finished == true)
        #expect(await manual.coordinator.persistence(of: Start.runId(1))?.isResolved == true)
        #expect(await manual.coordinator.isRevoking, "outstanding: the owner's call has not returned")
        #expect(await manual.coordinator.confirmationEvidence(of: Start.runId(1))?.ended == true)
        #expect(confirmation.ends == 0, "the confirmation has not changed yet")

        // Without R1 both busy flags were clear here, and the start launched
        // under the still-active confirmation.
        let busy = try await manual.send(.participantStart, Start.start(2))
        #expect(busy.reason == .participantBusy, "\(busy.jsonValue)")
        try await Self.answersMeanwhile(manual)
        #expect(manual.launcher.runs.count == 1)

        confirmation.release()
        #expect(await waitUntil { !(await manual.coordinator.isRevoking) }, "the owner's call returned")
        #expect(confirmation.calls == 1 && confirmation.ends == 1, "exactly one actual revocation")
        let unavailable = try await manual.send(.participantStart, Start.start(2))
        #expect(unavailable.reason == .participantUnavailable, "\(unavailable.jsonValue)")
        let availability = try await manual.send(.participantAvailability, [:])
        #expect(Self.entry(availability)?["reason"] == .string("overflow-unverified"))
        #expect(Self.entry(availability)?["confirmation"] == ParticipantConfirmationDisplay.ended(.paidOverflow).jsonValue)
        #expect(manual.launcher.runs.count == 1, "never launched under the old active confirmation")

        // The late callback, already taken when the end cancelled it, runs now.
        #expect(wakeups.cancelled == 1)
        wakeups.deliverAll()
        #expect(confirmation.calls == 1 && confirmation.ends == 1, "no second revocation")
        #expect(!(await manual.coordinator.isRevoking))
        #expect(confirmation.holdTimeouts == 0)
    }

    @Test("R1 (1), the boundary: the wake-up held, updates whose end is seen at exactly +5,000 ms missed the five seconds, as a wake-up running then would have (at or after the deadline): one revocation, the next start participant-unavailable, nothing launched, and the late callback revokes nothing more")
    func lateEndAtTheDeadline() async throws {
        let wakeups = HeldWakeups()
        let (world, confirmation, manual) = try await Self.world(wakeups: wakeups)
        defer { world.clean() }
        let run = try await Self.released(manual)
        let released = world.virtual.now
        try world.virtual.advance(to: released + UpdatesWatch.graceMillis)
        #expect(confirmation.calls == 0, "the due callback is held")
        run.finish()
        #expect(await manual.finished(), "the end seen at +5,000 and the revocation it claimed returned")
        #expect(await manual.coordinator.confirmationEvidence(of: Start.runId(1))?.ended == true)
        #expect(confirmation.calls == 1 && confirmation.ends == 1)
        let unavailable = try await manual.send(.participantStart, Start.start(2))
        #expect(unavailable.reason == .participantUnavailable, "\(unavailable.jsonValue)")
        #expect(manual.launcher.runs.count == 1)
        wakeups.deliverAll()
        #expect(confirmation.calls == 1 && confirmation.ends == 1, "no second revocation")
    }

    @Test("R1 (2): the wake-up claims expiry on time and the owner's call is held before the confirmation changes; with the updates then finished, no start dispatches through that interval (participant-busy), a late overflow observation is applied at once and calls nothing more, status, events, Stop and availability answer; released, the next start is participant-unavailable")
    func heldOwnerAfterTimerClaim() async throws {
        let (world, confirmation, manual) = try await Self.world()
        defer { world.clean() }
        let run = try await Self.released(manual)
        let released = world.virtual.now
        #expect(world.virtual.obligation() != nil, "the wake-up is armed on the timeline")

        confirmation.holdNextEnd()
        let advancing = advanceOnItsOwnThread(world.virtual, to: released + 5_000)
        #expect(await confirmation.waitUntilHeld(), "the wake-up claimed expiry and called the owner, which holds")
        #expect(confirmation.ends == 0, "the confirmation has not changed yet")
        #expect(await manual.coordinator.isRevoking)

        run.send(.overflowObserved)
        #expect(await manual.applied(4), "applied at once: the observation never waits for the held call")
        run.finish()
        #expect(await manual.finished(revocations: false), "every update applied, the end seen, the terminal durable")
        #expect(await manual.coordinator.persistence(of: Start.runId(1))?.isResolved == true)
        #expect(await manual.coordinator.isRevoking, "still outstanding")
        // Without R1 admission saw both flags clear here.
        for _ in 0..<3 {
            let busy = try await manual.send(.participantStart, Start.start(2))
            #expect(busy.reason == .participantBusy, "\(busy.jsonValue)")
        }
        try await Self.answersMeanwhile(manual)
        #expect(manual.launcher.runs.count == 1, "nothing dispatched through the interval")
        #expect(confirmation.calls == 1, "the observation found the revocation claimed")

        confirmation.release()
        #expect(await value(of: advancing) == true, "the wake-up's thread returns once the owner's call does")
        #expect(!(await manual.coordinator.isRevoking))
        #expect(confirmation.ends == 1)
        let unavailable = try await manual.send(.participantStart, Start.start(2))
        #expect(unavailable.reason == .participantUnavailable, "\(unavailable.jsonValue)")
        let availability = try await manual.send(.participantAvailability, [:])
        #expect(Self.entry(availability)?["available"] == .bool(false))
        #expect(Self.entry(availability)?["confirmation"] == ParticipantConfirmationDisplay.ended(.paidOverflow).jsonValue)
        #expect(manual.launcher.runs.count == 1)
        try world.virtual.advance(to: world.virtual.now + 10_000)
        #expect(confirmation.calls == 1 && confirmation.ends == 1, "once per run")
        #expect(confirmation.holdTimeouts == 0)
    }

    @Test("R1 (3), control: updates that finish at +4,999 ms meet the rule; the cancelled wake-up, delivered later anyway, ends nothing, nothing is outstanding, and the next start is admitted under the still-active confirmation")
    func finishBeforeDeadlineEndsNothing() async throws {
        let wakeups = HeldWakeups()
        let (world, confirmation, manual) = try await Self.world(wakeups: wakeups)
        defer { world.clean() }
        let run = try await Self.released(manual)
        let released = world.virtual.now
        try world.virtual.advance(to: released + 4_999)
        run.finish()
        #expect(await manual.finished())
        #expect(wakeups.cancelled == 1, "the end cancelled the wake-up")
        try world.virtual.advance(to: released + 6_000)
        wakeups.deliverAll()
        #expect(confirmation.calls == 0 && confirmation.ends == 0)
        #expect(await manual.coordinator.confirmationEvidence(of: Start.runId(1))?.ended == false)
        #expect(!(await manual.coordinator.isRevoking))
        let admitted = try await manual.send(.participantStart, Start.start(2))
        #expect(admitted.outcome == .ok, "\(admitted.jsonValue)")
        #expect(manual.launcher.runs.count == 2)
        manual.launcher.runs.last?.finish()
    }
}

@Suite("Participant coordinator: a request id after proven absence (Codex S8 answer 1)")
struct ReleasedStartIdTests {
    typealias Start = ParticipantCoordinatorStartTests

    /// Run 1 started under `Start.id(1)` with its start record's write
    /// undetermined (every folder flush failing); returns the runs the
    /// folder held before it.
    static func undetermined(_ world: VectorWorld) async throws -> [JSONValue] {
        let faults = try #require(world.faults)
        world.launcher.prepare(script: Start.script)
        let seeded = try #require(try world.runsOnDisk())
        faults.undeterminedFlushes = true
        let reply = await Start.send(world, .participantStart, Start.start(), id: Start.id(1))
        #expect(reply.outcome == .unknown, "\(reply.jsonValue)")
        return seeded
    }

    /// The start record's rename never reached the folder after all.
    static func loseTheRecord(_ world: VectorWorld, seeded: [JSONValue]) throws {
        try #require(world.faults).disarm()
        var state = try #require(try JSONValue.decode(world.store.plainStateForTesting()).objectValue)
        state["runs"] = .array(seeded)
        try JSONEncoder().encode(JSONValue.object(state)).writePlainState(to: world.store)
    }

    static func isStartId(_ world: VectorWorld, _ id: String) throws -> Bool {
        world.hostConfiguration.identities.isStartId(try #require(UUID(uuidString: id)))
    }

    @Test("Answer 1: once an authoritative re-read proves an undetermined start record absent, its request id is released, not tombstoned: the exact retry under the same id (which makes the re-read itself, or follows a status that made it) runs every check again and dispatches once; afterwards the durable record replays without a second launch")
    func sameIdAfterProvenAbsence() async throws {
        for statusFirst in [false, true] {
            let world = try await Start.oneRun()
            defer { world.clean() }
            let seeded = try await Self.undetermined(world)
            #expect(try Self.isStartId(world, Start.id(1)), "reserved while undetermined")
            try Self.loseTheRecord(world, seeded: seeded)
            if statusFirst {
                let status = await Start.send(world, .participantStatus, Start.read())
                #expect(status.fields["state"] == .string("not-dispatched"), "\(status.jsonValue)")
                #expect(try !Self.isStartId(world, Start.id(1)), "the proven absence released the id")
            }
            let accepted = await Start.send(world, .participantStart, Start.start(), id: Start.id(1))
            #expect(accepted.outcome == .ok && accepted.fields["runId"] == .string(Start.runId(1)), "\(statusFirst): \(accepted.jsonValue)")
            try await world.settle()
            #expect(world.launcher.requests.count == 1, "dispatched once")
            let start = try #require(try Start.entry(world)["start"]?.objectValue)
            #expect(start["requestId"] == .string(Start.id(1)))
            #expect(try Start.entry(world)["terminal"]?.objectValue?["type"] == .string("completed"))
            let replay = await Start.send(world, .participantStart, Start.start(), id: Start.id(1))
            #expect(replay.outcome == .ok, "\(replay.jsonValue)")
            #expect(world.launcher.requests.count == 1, "a durable exact replay never dispatches twice")
        }
    }

    @Test("Answer 1, controls: while the undetermined record is unresolved, retries under its id (one at a time and concurrently) are unknown, the id stays reserved and nothing launches; once a re-read finds the record, concurrent retries replay ok, the failed process-error terminal is recorded and pushed once, and nothing launches")
    func sameIdFoundOrUnresolvedNeverDispatches() async throws {
        let world = try await Start.oneRun()
        defer { world.clean() }
        _ = try await Self.undetermined(world)
        _ = world.sink.take()

        // Unresolved: every re-read's folder flush still fails.
        let again = await Start.send(world, .participantStart, Start.start(), id: Start.id(1))
        #expect(again.outcome == .unknown, "\(again.jsonValue)")
        let unresolved = (0..<3).map { _ in Start.sending(world, .participantStart, Start.start(), id: Start.id(1)) }
        for task in unresolved {
            let reply = try await Start.answer(task)
            #expect(reply.outcome == .unknown, "\(reply.jsonValue)")
        }
        #expect(try Self.isStartId(world, Start.id(1)), "still reserved")
        #expect(world.launcher.requests.isEmpty && world.sink.take().isEmpty)

        // Found: the record is there after all.
        try #require(world.faults).disarm()
        let found = (0..<3).map { _ in Start.sending(world, .participantStart, Start.start(), id: Start.id(1)) }
        for task in found {
            let reply = try await Start.answer(task)
            #expect(reply.outcome == .ok && reply.fields["runId"] == .string(Start.runId(1)), "\(reply.jsonValue)")
        }
        #expect(await waitUntil { !(await world.coordinator.isWriting) })
        #expect(world.launcher.requests.isEmpty, "a found record never dispatches")
        let entry = try Start.entry(world)
        #expect(entry["start"]?.objectValue?["requestId"] == .string(Start.id(1)))
        #expect(entry["terminal"]?.objectValue?["reason"] == .string("process-error"))
        #expect(world.sink.take().count == 1, "the one failed terminal, pushed once")
    }

    @Test("Answer 1: concurrent retries of a released id share one re-read and launch exactly once: one is admitted (held at its availability recheck), the others answer unknown, other bytes under the id are payload-mismatch, another id duplicate-run; then the durable record replays")
    func concurrentRetriesLaunchOnce() async throws {
        let world = try await Start.oneRun()
        defer { world.clean() }
        let seeded = try await Self.undetermined(world)
        try Self.loseTheRecord(world, seeded: seeded)
        let gate = world.availability.hold()

        let retries = (0..<3).map { _ in Start.sending(world, .participantStart, Start.start(), id: Start.id(1)) }
        let replies = retries.map { _ in ResultBox<HostResponse>() }
        let watchers = zip(retries, replies).map { task, box in Task { box.set(await task.value) } }
        defer { watchers.forEach { $0.cancel() } }
        #expect(await waitUntil { gate.arrived == 1 && replies.filter { $0.value != nil }.count == 2 },
                "one retry admitted and held at its recheck; the other two answered")
        let early = replies.compactMap(\.value)
        #expect(early.count == 2 && early.allSatisfy { $0.outcome == .unknown }, "\(early.map(\.jsonValue))")
        let other = await Start.send(world, .participantStart, Start.start(chunks: ["Invented other bytes."]), id: Start.id(1))
        #expect(other.reason == .payloadMismatch, "\(other.jsonValue)")
        let otherId = await Start.send(world, .participantStart, Start.start(), id: Start.id(2))
        #expect(otherId.reason == .duplicateRun, "\(otherId.jsonValue)")
        #expect(gate.arrived == 1 && world.launcher.requests.isEmpty)

        gate.open()
        #expect(await waitUntil { replies.allSatisfy { $0.value != nil } })
        let answered = replies.compactMap(\.value)
        #expect(answered.filter { $0.outcome == .ok }.count == 1 && answered.filter { $0.outcome == .unknown }.count == 2)
        try await world.settle()
        #expect(world.launcher.requests.count == 1, "exactly one launch")
        let replay = await Start.send(world, .participantStart, Start.start(), id: Start.id(1))
        #expect(replay.outcome == .ok)
        #expect(world.launcher.requests.count == 1)
        #expect(gate.timedOut == 0)
    }
}
