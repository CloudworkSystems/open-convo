import Foundation
import Testing
@testable import DeskHost
@testable import ParticipantCoordinator
@testable import ParticipantProcess

// Lock, unlock, document generations, window close and quit (plan S10;
// contract sections 7, 8, 9, 10 and 14; Codex Q21 and Q31-Q34, and the
// lifecycle obligations of Codex's S7, S8 and S9 reviews). The app's order
// is kept throughout: the lane's `lockNow()` before the host's `lock()`,
// the lane's `beginShutdown(quitting:)` before the host's
// `revokeForShutdown()`, and
// the host's `closeStore()` after the lane's `finishShutdown`. Runs are
// scripted on the virtual clock or driven by hand, never the real CLI;
// every wait is bounded. Invented data only.

/// What a close did, in order, from every thread.
final class OrderLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []

    func append(_ item: String) {
        lock.lock(); defer { lock.unlock() }
        items.append(item)
    }

    func reset() {
        lock.lock(); defer { lock.unlock() }
        items = []
    }

    var entries: [String] {
        lock.lock(); defer { lock.unlock() }
        return items
    }
}

/// Records each push in the log as `push <type> <state or event type>`.
final class OrderedSink: HostEventSink, @unchecked Sendable {
    let log: OrderLog

    init(log: OrderLog) {
        self.log = log
    }

    func push(_ event: HostEvent) {
        switch event {
        case .hostConnection(_, _, let state, _): log.append("push host.connection \(state.rawValue)")
        case .participantEvent(_, _, let detail): log.append("push participant.event \(detail.objectValue?["type"]?.stringValue ?? "?")")
        default: log.append("push \(event.type)")
        }
    }
}

/// Runs each piece of store work on its own thread, logging `write` as it
/// is handed over.
struct OrderedExecutor: MutationExecutor {
    let log: OrderLog

    func run<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        log.append("write")
        return try await withCheckedThrowingContinuation { continuation in
            Thread { continuation.resume(with: Result { try work() }) }.start()
        }
    }
}

/// A run driven by hand whose `stop` is logged (and reaches a supervisor).
final class OrderedRun: ParticipantRunning, @unchecked Sendable {
    let updates: AsyncStream<ParticipantRunUpdate>
    private let continuation: AsyncStream<ParticipantRunUpdate>.Continuation
    private let log: OrderLog

    init(log: OrderLog) {
        self.log = log
        var continuation: AsyncStream<ParticipantRunUpdate>.Continuation!
        updates = AsyncStream(bufferingPolicy: .unbounded) { continuation = $0 }
        self.continuation = continuation
    }

    func send(_ update: ParticipantRunUpdate) { continuation.yield(update) }
    func finish() { continuation.finish() }

    @discardableResult
    func stop() -> Bool {
        log.append("stop")
        return true
    }

    var snapshot: ParticipantRunSnapshot {
        ParticipantRunSnapshot(lastSequence: 0, terminal: nil, groupCleared: nil, cleanup: .owned)
    }
}

final class OrderedLauncher: ParticipantLaunching, @unchecked Sendable {
    let cliVersion = "invented-cli-version"
    let log: OrderLog
    private let lock = NSLock()
    private var launched: [OrderedRun] = []

    init(log: OrderLog) {
        self.log = log
    }

    func launch(_ request: ParticipantLaunchRequest) throws -> any ParticipantRunning {
        let run = OrderedRun(log: log)
        lock.lock(); launched.append(run); lock.unlock()
        return run
    }

    var runs: [OrderedRun] {
        lock.lock(); defer { lock.unlock() }
        return launched
    }
}

@Suite("Participant coordinator: lifecycle")
struct ParticipantCoordinatorLifecycleTests {
    typealias Start = ParticipantCoordinatorStartTests
    typealias Stop = ParticipantCoordinatorStopTests

    /// Lock, as the app does it: the lane's step, then the host's.
    static func lock(_ world: VectorWorld) async {
        world.coordinator.lockNow()
        await world.host.lock()
    }

    /// A verified unlock, its epoch read just before the host's unlock (S11
    /// reading 4): the host's store opens, then the lane writes what it
    /// held.
    static func unlock(_ world: VectorWorld) async {
        let epoch = world.coordinator.lockEpoch
        await world.host.unlock()
        await world.coordinator.unlock(ifNoLockSince: epoch)
    }

    /// The first half of a window close or quit, as the app does it.
    static func beginClose(_ world: VectorWorld, quitting: Bool) async {
        world.coordinator.beginShutdown(quitting: quitting)
        await world.host.revokeForShutdown()
    }

    /// `finishShutdown`, bounded in wall time.
    static func finish(_ world: VectorWorld, quitting: Bool) async throws -> ParticipantShutdownReport {
        try #require(await value(of: Task { await world.coordinator.finishShutdown(quitting: quitting) }),
                     "returned within \(vectorWaitSeconds) s")
    }

    /// Each pushed detail as `<type> <state>` or `<type> <event type>`.
    static func kinds(_ pushed: [JSONValue]) -> [String] {
        pushed.map { detail in
            let fields = detail.objectValue ?? [:]
            let type = fields["type"]?.stringValue ?? "?"
            if let state = fields["state"]?.stringValue { return "\(type) \(state)" }
            return "\(type) \(fields["event"]?.objectValue?["type"]?.stringValue ?? "?")"
        }
    }

    /// The window reopened over the same folder: a new store, and a new host
    /// with the same configuration, attached to the same coordinator, with a
    /// fresh document's connection (Codex Q21). The world's store must be
    /// closed first. The caller closes the returned store.
    static func reopen(_ world: VectorWorld) async throws -> (store: ProofStore, host: DeskHostProtocol) {
        let store = try ProofStore(directory: world.storeDirectory, keys: world.keys, seed: WorkspaceSeed(record: ["revision": .number(0)]))
        let host = DeskHostProtocol(store: store, connections: world.connections, drafts: DraftBindingRegistry(), info: VectorWorld.info,
                                    events: world.sink, participants: world.hostConfiguration)
        try await world.coordinator.attach(host: host, store: store, connections: world.connections, sink: world.sink)
        await world.reload(on: host)
        return (store, host)
    }

    /// The next launch over the same folder (the world's store closed and its
    /// coordinator detached): a new store, host, identity space and
    /// coordinator with another launch id; run 1 as it reads it.
    static func nextLaunch(_ world: VectorWorld) async throws -> (status: HostResponse, stop: HostResponse, events: HostResponse) {
        let reopened = try ProofStore(directory: world.storeDirectory, keys: world.keys, seed: WorkspaceSeed(record: ["revision": .number(0)]))
        defer { reopened.close() }
        let configuration = ParticipantHostConfiguration(pin: world.hostConfiguration.pin)
        let host = DeskHostProtocol(store: reopened, connections: world.connections, drafts: DraftBindingRegistry(), info: VectorWorld.info,
                                    events: world.sink, participants: configuration)
        let next = ParticipantCoordinator(configuration: ParticipantCoordinator.Configuration(
            hostConfiguration: configuration, availability: world.availability, launchId: "75abcdef-0000-4000-8abc-000000000003",
            clock: world.virtual.clock, executor: world.executor, launcher: ManualLauncher(), log: world.log,
            wakeups: VirtualWakeups(world: world.virtual), confirmation: nil))
        try await next.attach(host: host, store: reopened, connections: world.connections, sink: world.sink)
        defer { Task { await next.detach() } }
        let connection = world.connections.adopt(id: "51000000-0000-4000-8000-0000000000f1")
        func direct(_ operation: HostOperation, _ payload: [String: JSONValue]) async throws -> HostResponse {
            var fields = try #require(ParticipantCoordinatorReadTests.request(operation, payload, world: world).objectValue)
            fields["connectionId"] = .string(connection.id)
            fields["generation"] = .number(Double(connection.generation))
            let request = try HostRequest(validating: .object(fields), acceptsParticipant: true)
            return try await Start.answer(Task { await next.handle(request) })
        }
        return (try await direct(.participantStatus, Start.read()), try await direct(.participantStop, Start.read()),
                try await direct(.participantEvents, Start.events()))
    }

    static func exitUnrecorded(_ next: (status: HostResponse, stop: HostResponse, events: HostResponse)) -> Bool {
        next.status.fields["state"] == .string("unknown") && next.status.fields["unknownReason"] == .string("exit-unrecorded")
            && next.status.fields["terminal"] == .null && next.stop.fields["state"] == .string("not-owned")
            && next.events.fields["lost"]?.objectValue?["reason"] == .string("restarted") && next.events.fields["terminal"] == .null
    }

    // MARK: Lock and unlock

    @Test("lockNow is synchronous, with no actor hop: before it returns every live run is sent stop, the lock flag and a new epoch are set and pushes are off; a repeat moves the epoch only; the follow-up marks the run stopping and drops its retained text (lost locked), keeping text-free numbers; the stop-incomplete terminal 12 s later is held, never pushed or written")
    func lockNowIsSynchronous() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let run = try await Stop.started(world, mode: .survivesSigkill)
        #expect(await world.coordinator.retainedEvents.map(\.sequence) == [1, 2], "started and its text")
        let lockedAt = world.virtual.now
        let epoch = world.coordinator.lockEpoch
        let writes = world.executor.runs
        world.coordinator.lockNow()
        // Nothing has been awaited since lockNow returned.
        #expect(run.stopCalls.count == 1 && run.stopCalls.first?.sent == true)
        #expect(run.system.signalNames == ["TERM@\(lockedAt)"])
        #expect(world.coordinator.lockEpoch == epoch + 1)
        #expect(world.coordinator.gate.state.locked && !world.coordinator.pushGate.isOpen)
        world.coordinator.lockNow()
        #expect(run.stopCalls.count == 1 && world.coordinator.lockEpoch == epoch + 2, "idempotent, but for the epoch")
        await world.host.lock()

        #expect(await waitUntil { await world.coordinator.stopRequested(of: Start.runId(1)) == true }, "the follow-up marks it stopping")
        #expect(await world.coordinator.retainedEvents.isEmpty)
        #expect(await world.coordinator.retainedLoss == RetainedRun.Loss(reason: .locked, throughSequence: 2))
        try world.virtual.advance(to: lockedAt + 12_000)
        #expect(await world.drain())
        #expect(run.terminalUpdate?.event.reason == "stop-incomplete" && run.terminalUpdate?.groupCleared == false)
        #expect(run.system.signalNames == ["TERM@\(lockedAt)", "KILL@\(lockedAt + 10_000)"])
        #expect(Self.kinds(world.sink.take()) == ["host.connection locked"], "locked, then nothing")
        #expect(try Start.entry(world)["terminal"] == .null, "held, not written")
        #expect(world.executor.runs == writes, "no write is attempted while locked")
        #expect(await world.coordinator.retainedEvents.map(\.sequence) == [3], "only the terminal, text-free")
        let owed = await world.coordinator.obligations()
        #expect(owed.cleanupPending == 1 && owed.writesPending == 1 && owed.live == 0 && owed.starting == 0, "\(owed)")
    }

    @Test("Vector #93's flow with text still in the reader: no participant push follows locked, neither the accepted text the stop sequence emits nor the terminal; nothing is written while locked; the unlock writes the held terminal once to the same folder and never pushes it; nothing restarts; the new document reads exited with the text lost locked; then starts are admitted")
    func heldTerminalWrittenAtUnlock() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let run = try await Stop.started(world, mode: .exitsOnSigterm)
        // A delta the reader still holds (its 250 ms are not up) when the lock comes.
        world.virtual.play([ScriptStep(atMs: 0, .textDelta(" Invented more."))], on: run, untilTerminal: false)
        try world.virtual.advance(to: world.virtual.now)
        let writes = world.executor.runs
        await Self.lock(world)
        try await world.settle()
        let made = run.events.map { "\($0.sequence) \($0.type.rawValue)" }
        #expect(made == ["1 started", "2 text", "3 text", "4 stopped"], "the accepted text, then the terminal: \(made)")
        #expect(run.terminalUpdate?.event.reason == "local-stop" && run.terminalUpdate?.groupCleared == true)
        #expect(Self.kinds(world.sink.take()) == ["host.connection locked"])
        #expect(world.executor.runs == writes)
        #expect(try Start.entry(world)["terminal"] == .null)
        #expect(await world.coordinator.retainedLoss == RetainedRun.Loss(reason: .locked, throughSequence: 3))
        #expect(await world.coordinator.retainedEvents.map(\.sequence) == [4])

        await Self.unlock(world)
        #expect(await Stop.writesReturned(world))
        let entry = try Start.entry(world)
        let terminal = try #require(entry["terminal"]?.objectValue)
        #expect(terminal["sequence"] == .number(4) && terminal["reason"] == .string("local-stop") && entry["groupCleared"] == .bool(true))
        #expect(world.executor.runs == writes + 1, "written once")
        #expect(world.sink.take().isEmpty, "written, never pushed")
        #expect(await world.coordinator.hasUnresolvedWrites == false)

        await world.reload()
        #expect(Self.kinds(world.sink.take()) == ["host.connection ready"])
        let status = try await Stop.ask(world, .participantStatus, Start.read())
        #expect(status.fields["state"] == .string("exited") && status.fields["lastSequence"] == .number(4), "\(status.jsonValue)")
        let events = try await Stop.ask(world, .participantEvents, Start.events(after: 0))
        #expect(events.fields["lost"] == .object(["fromSequence": .number(1), "throughSequence": .number(3), "reason": .string("locked")]),
                "\(events.jsonValue)")
        #expect(events.fields["terminal"] == status.fields["terminal"] && events.fields["events"] == .array([]))
        #expect(world.launcher.requests.count == 1, "nothing restarts")
        try await world.settle()
        #expect(world.sink.take().isEmpty)
        world.launcher.prepare(script: Start.script)
        #expect(try await Stop.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
    }

    @Test("Section 7 under lock: the coordinator's own flag decides step 1 even before the host locks (store-locked, claiming, writing and launching nothing); a start at its availability recheck when the lock comes spawns nothing and writes nothing, not even a terminal, and the run stays not-dispatched; one whose start record was being written spawns nothing and keeps stopped local-stop at sequence 1 for the unlock, which writes it and never pushes it",
          arguments: ["flag before the host locks", "availability recheck", "start record write"])
    func lockDuringStarting(_ moment: String) async throws {
        let world = try await Start.oneRun()
        defer { world.clean() }
        let faults = try #require(world.faults)
        let writes = world.executor.runs
        let folder = try world.folderSnapshot()
        switch moment {
        case "flag before the host locks":
            world.coordinator.lockNow()
            let refused = try await Stop.ask(world, .participantStart, Start.start(), id: Start.id(1))
            #expect(refused.reason == .storeLocked, "\(refused.jsonValue)")
            #expect(world.launcher.requests.isEmpty && world.executor.runs == writes)
            #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil)
            #expect(try Start.leavesNoIdentity(world, Start.id(1)))
            await world.host.lock()
        case "availability recheck":
            let gate = world.availability.hold()
            let start = Start.sending(world, .participantStart, Start.start(), id: Start.id(1))
            #expect(await waitUntil { gate.arrived > 0 })
            await Self.lock(world)
            gate.open()
            #expect(try await Start.answer(start).reason == .storeLocked)
            #expect(world.launcher.requests.isEmpty && world.executor.runs == writes)
            #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil, "nothing written: nobody asked to stop it")
            #expect(try Start.leavesNoIdentity(world, Start.id(1)))
            #expect(await world.coordinator.phase(of: Start.runId(1)) == nil)
            await Self.unlock(world)
            await world.reload()
            #expect(try await Stop.ask(world, .participantStatus, Start.read()).fields["state"] == .string("not-dispatched"))
        default:
            faults.arm(.nextWrite)
            let start = Start.sending(world, .participantStart, Start.start(), id: Start.id(1))
            #expect(await faults.waitUntilHeld(), "the start record's write holds the store")
            world.coordinator.lockNow()
            faults.release()
            let reply = try await Start.answer(start)
            #expect(reply.outcome == .ok, "its record is durable: ok, with nothing spawned: \(reply.jsonValue)")
            await world.host.lock()
            #expect(world.launcher.requests.isEmpty)
            let entry = try Start.entry(world)
            #expect(entry["start"]?.objectValue?["requestId"] == .string(Start.id(1)) && entry["terminal"] == .null, "held for the unlock")
            let owed = try #require(await world.coordinator.owedWrites()[Start.runId(1)])
            #expect(owed.count == 1 && owed.first?.neverSpawned == true && owed.first?.groupCleared == nil)
            #expect(owed.first?.terminal.type == "stopped" && owed.first?.terminal.reason == "local-stop" && owed.first?.terminal.sequence == 1)
            await Self.unlock(world)
            #expect(await Stop.writesReturned(world))
            let written = try Start.entry(world)
            #expect(written["terminal"]?.objectValue?["reason"] == .string("local-stop") && written["groupCleared"] == .null)
            await world.reload()
            let status = try await Stop.ask(world, .participantStatus, Start.read())
            #expect(status.fields["state"] == .string("exited") && status.fields["terminal"]?.objectValue?["sequence"] == .number(1))
            #expect(Self.kinds(world.sink.take()) == ["host.connection locked", "host.connection ready"], "held, then never pushed")
        }
        #expect(faults.holdTimeouts == 0)
    }

    @Test("Lock and unlock epochs race: an unlock verified before a newer lock never applies (still locked, nothing written); the unlock for the newer epoch applies and writes; an unlock with nothing locked does nothing")
    func unlockEpochRace() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        _ = try await Stop.started(world, mode: .exitsOnSigterm)
        await Self.lock(world)
        try await world.settle()
        let writes = world.executor.runs
        let stale = world.coordinator.lockEpoch
        // Another lock (inactivity, say) lands while that unlock is verified.
        world.coordinator.lockNow()
        await world.host.unlock()
        await world.coordinator.unlock(ifNoLockSince: stale)
        #expect(world.coordinator.gate.state.locked, "the newer lock wins")
        #expect(!world.coordinator.pushGate.isOpen)
        #expect(await Stop.writesReturned(world))
        #expect(world.executor.runs == writes)
        #expect(try Start.entry(world)["terminal"] == .null)

        await world.coordinator.unlock(ifNoLockSince: world.coordinator.lockEpoch)
        #expect(!world.coordinator.gate.state.locked && world.coordinator.pushGate.isOpen)
        #expect(await Stop.writesReturned(world))
        #expect(try Start.entry(world)["terminal"]?.objectValue?["reason"] == .string("local-stop"))
        let epoch = world.coordinator.lockEpoch
        await world.coordinator.unlock(ifNoLockSince: epoch)
        #expect(!world.coordinator.gate.state.locked && world.coordinator.lockEpoch == epoch, "nothing locked: nothing changes")
    }

    @Test("Codex S8 R1 and the S9 fix kept: a lock and a close never lose the confirmation revocation section 17 requires: updates unfinished five seconds after cleanup-released end the confirmation exactly at +5,000 ms, once, with a lock in between, and starts stay busy after the unlock until the updates finish; the close then ends nothing more")
    func revocationSurvivesLockAndClose() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let manual = try await Start.Manual(world)
        #expect(try await manual.send(.participantStart, Start.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        run.send(.event(manual.event(1, .started)))
        run.send(.terminal(manual.event(2, .completed), groupCleared: true))
        run.send(.cleanupReleased)
        #expect(await manual.applied(3))
        let released = world.virtual.now
        manual.coordinator.lockNow()
        await world.host.lock()
        try world.virtual.advance(to: released + 4_999)
        #expect(manual.owner.paidOverflowEnds == 0)
        try world.virtual.advance(to: released + 5_000)
        #expect(manual.owner.paidOverflowEnds == 1, "the lock did not lose it")
        let epoch = manual.coordinator.lockEpoch
        await world.host.unlock()
        await manual.coordinator.unlock(ifNoLockSince: epoch)
        await world.reload()
        #expect(try await manual.busy(), "busy until the updates finish")
        manual.coordinator.beginShutdown(quitting: true)
        await world.host.revokeForShutdown()
        try world.virtual.advance(to: world.virtual.now + 10_000)
        #expect(manual.owner.paidOverflowEnds == 1, "once")
        run.finish()
        let report = try #require(await value(of: Task { await manual.coordinator.finishShutdown(quitting: true) }))
        #expect(!report.reachedBound && report.remaining.isEmpty, "\(report)")
        #expect(manual.owner.paidOverflowEnds == 1)
    }

    // MARK: Window close and quit

    @Test("Window close in the app's order, recorded: the lane's beginShutdown stops the run and suspends pushes before the host's revoked, so no participant push follows it; finishShutdown waits for the terminal and writes it while the store is open; only then does the store close")
    func closeOrder() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let log = OrderLog()
        let sink = OrderedSink(log: log)
        let host = DeskHostProtocol(store: world.store, connections: world.connections, drafts: DraftBindingRegistry(), info: VectorWorld.info,
                                    events: sink, participants: world.hostConfiguration)
        let launcher = OrderedLauncher(log: log)
        let coordinator = ParticipantCoordinator(configuration: ParticipantCoordinator.Configuration(
            hostConfiguration: world.hostConfiguration, availability: world.availability,
            launchId: try ParticipantVectors.load().context.launchId, clock: world.virtual.clock, executor: OrderedExecutor(log: log),
            launcher: launcher, log: world.log, wakeups: VirtualWakeups(world: world.virtual), confirmation: nil))
        await world.coordinator.detach()
        try await coordinator.attach(host: host, store: world.store, connections: world.connections, sink: sink)
        let start = try HostRequest(validating: ParticipantCoordinatorReadTests.request(.participantStart, Start.start(1), world: world),
                                    acceptsParticipant: true)
        #expect(try await Start.answer(Task { await coordinator.handle(start) }).outcome == .ok)
        let run = try #require(launcher.runs.first)
        let event = { (sequence: Int, type: ParticipantEventType, reason: String?) in
            ParticipantEvent(runId: Start.runId(1), sessionId: Start.sessionId(1), sequence: sequence, at: Start.clock, type: type, reason: reason)
        }
        run.send(.event(event(1, .started, nil)))
        #expect(await waitUntil { await coordinator.consumption(of: Start.runId(1))?.applied == 1 })
        #expect(log.entries.last == "push participant.event started")
        log.reset()

        coordinator.beginShutdown(quitting: false)
        await host.revokeForShutdown()
        let finishing = Task { await coordinator.finishShutdown(quitting: false) }
        #expect(await waitUntil { await coordinator.isFinishingShutdown })
        #expect(await value(of: finishing, within: 0.3) == nil, "it waits for the stopped run's terminal")
        run.send(.terminal(event(2, .stopped, "local-stop"), groupCleared: true))
        run.send(.cleanupReleased)
        run.finish()
        let report = try #require(await value(of: finishing))
        // A window close waits for the terminal and its write, not for the
        // cleanup release or the updates' end, which may still be on their way.
        #expect(!report.reachedBound && report.remaining.live == 0 && report.remaining.writesPending == 0, "\(report)")
        #expect(!world.store.publishedRuns.closed, "open until the terminal is written")
        await host.closeStore()
        log.append("store closed")
        #expect(log.entries == ["stop", "push host.connection revoked", "write", "store closed"], "\(log.entries)")
        let entry = try Start.entry(world)
        #expect(entry["terminal"]?.objectValue?["reason"] == .string("local-stop") && entry["groupCleared"] == .bool(true))
        await coordinator.detach()
    }

    @Test("Codex S7: shutdown of new requests and pushes is distinct from draining earlier work: after beginShutdown a start is store-locked, while a never-dispatched Stop's write already on the executor is let finish, finishShutdown waits for it, and that earlier Stop gets its write's answer; its terminal is never pushed after revoked")
    func closeDrainsEarlierWork() async throws {
        let world = try await Start.oneRun()
        defer { world.clean() }
        world.executor.holdNext()
        let stop = Start.sending(world, .participantStop, Start.read())
        #expect(await waitOffPool(world.executor.held, seconds: vectorWaitSeconds), "the cancellation's write waits on the executor")
        world.coordinator.beginShutdown(quitting: false)
        let refused = try await Stop.ask(world, .participantStart, Start.start(), id: Start.id(2))
        #expect(refused.reason == .storeLocked, "no new start once close begins: \(refused.jsonValue)")
        #expect(try Start.leavesNoIdentity(world, Start.id(2)))
        await world.host.revokeForShutdown()
        let finishing = Task { await world.coordinator.finishShutdown(quitting: false) }
        #expect(await waitUntil { await world.coordinator.isFinishingShutdown })
        #expect(await value(of: finishing, within: 0.3) == nil, "it waits for the write in flight")
        world.executor.releaseHeld()
        let stopped = try await Start.answer(stop)
        #expect(stopped.fields["state"] == .string("exited") && stopped.fields["terminal"]?.objectValue?["reason"] == .string("local-stop"),
                "the earlier Stop gets its write's answer: \(stopped.jsonValue)")
        let report = try #require(await value(of: finishing))
        #expect(!report.reachedBound && report.remaining.isEmpty, "\(report)")
        #expect(Self.kinds(world.sink.take()) == ["host.connection revoked"], "nothing after revoked")
        #expect(world.launcher.requests.isEmpty && world.executor.holdTimeouts == 0)
    }

    @Test("Codex Q33: quit's one overall bound is 17 s from beginShutdown on the virtual clock, for every obligation together: a run whose group survives SIGKILL ends stop-incomplete at +12 s and stays cleanup-pending while its terminal's write is held in the store; finishShutdown(quitting:) still waits at +16,999 ms and returns at exactly +17,000 ms with what is unfinished; calling again returns at once (never extended)")
    func quitBoundIsSeventeenSeconds() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        let run = try await Stop.started(world, mode: .survivesSigkill)
        let began = world.virtual.now
        await Self.beginClose(world, quitting: true)
        faults.arm(.nextWrite)
        let quitting = Task { await world.coordinator.finishShutdown(quitting: true) }
        #expect(await waitUntil { await world.coordinator.isFinishingShutdown })
        #expect(await world.coordinator.obligations().live == 1)
        try world.virtual.advance(to: began + 12_000)
        #expect(run.terminalUpdate?.event.reason == "stop-incomplete")
        #expect(await faults.waitUntilHeld(), "the terminal's write is held in the store")
        try world.virtual.advance(to: began + 16_999)
        #expect(await value(of: quitting, within: 0.3) == nil, "still waiting at +16,999 ms")
        try world.virtual.advance(to: began + 17_000)
        let report = try #require(await value(of: quitting))
        #expect(report.reachedBound)
        #expect(report.remaining.cleanupPending == 1 && report.remaining.writesPending == 1 && report.remaining.live == 0
                && report.remaining.starting == 0, "\(report.remaining)")
        let again = try await Self.finish(world, quitting: true)
        #expect(again.reachedBound && world.virtual.now == began + 17_000, "the same bound, already passed: at once")
        // The app quits at the bound; the held write is let go only so the
        // folder can be removed.
        faults.release()
        #expect(await Stop.writesReturned(world))
        #expect(faults.holdTimeouts == 0)
    }

    @Test("Codex Q33, a timeout race: the terminal's write is still on the executor when the bound passes; finishShutdown still waits at +16,999 ms, returns at the bound, the store closes, and the late write finds it closed: nothing is recorded or invented, and the next launch reads the run exit-unrecorded (Stop not-owned, events lost restarted)")
    func quitBoundWithLateWrite() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let run = try await Stop.started(world, mode: .exitsOnSigterm)
        let began = world.virtual.now
        world.executor.holdNext()
        await Self.beginClose(world, quitting: true)
        let quitting = Task { await world.coordinator.finishShutdown(quitting: true) }
        try world.virtual.advance(to: began)
        #expect(await waitOffPool(world.executor.held, seconds: vectorWaitSeconds), "the terminal's write waits on the executor")
        #expect(run.terminalUpdate?.event.reason == "local-stop")
        try world.virtual.advance(to: began + 16_999)
        #expect(await value(of: quitting, within: 0.3) == nil, "still waiting at +16,999 ms: no 5 s of its own for the write")
        try world.virtual.advance(to: began + 17_000)
        let report = try #require(await value(of: quitting))
        #expect(report.reachedBound && report.remaining.writesPending == 1, "\(report)")
        await world.host.closeStore()
        world.executor.releaseHeld()
        #expect(await Stop.writesReturned(world))
        #expect(try Start.entry(world)["terminal"] == .null, "the late write found the store closed")
        #expect(await world.coordinator.hasUnresolvedWrites, "still owed in memory, never invented")
        #expect(world.executor.holdTimeouts == 0)
        await world.coordinator.detach()
        #expect(Self.exitUnrecorded(try await Self.nextLaunch(world)))
    }

    @Test("Codex Q32: a quit while locked writes nothing: the held terminal stays in memory, the shutdown returns once the runs ended (there is nothing it may write), and the next launch reads the run exit-unrecorded")
    func lockedQuitWritesNothing() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        _ = try await Stop.started(world, mode: .exitsOnSigterm)
        await Self.lock(world)
        try await world.settle()
        let writes = world.executor.runs
        await Self.beginClose(world, quitting: true)
        let report = try await Self.finish(world, quitting: true)
        #expect(!report.reachedBound && report.remaining.writesPending == 1 && report.remaining.cleanupPending == 0, "\(report)")
        #expect(world.executor.runs == writes, "nothing written")
        #expect(try Start.entry(world)["terminal"] == .null)
        await world.host.closeStore()
        await world.coordinator.detach()
        #expect(Self.exitUnrecorded(try await Self.nextLaunch(world)))
    }

    @Test("Codex Q33 with no Desk window: after a window close (which does not wait for cleanup) a cleanup-pending run is still an obligation, so a quit takes the participant bound; it writes nothing with no stack, waits for the group under the same one 17 s bound and returns there, or earlier once the group clears, leaving the owed true unwritten",
          arguments: [false, true])
    func quitWithNoStack(_ groupClears: Bool) async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let run = try await Stop.started(world, mode: .survivesSigkill)
        let stop = try await Stop.settled(world, .participantStop)
        #expect(stop.fields["state"] == .string("cleanup-pending"))
        try await world.settle()
        #expect(try Start.entry(world)["groupCleared"] == .bool(false))
        await Self.beginClose(world, quitting: false)
        let closed = try await Self.finish(world, quitting: false)
        #expect(!closed.reachedBound && closed.remaining.cleanupPending == 1 && closed.remaining.writesPending == 0, "\(closed)")
        await world.host.closeStore()
        await world.coordinator.detach()

        let owed = await world.coordinator.obligations()
        #expect(!owed.isEmpty && owed.cleanupPending == 1, "the participant bound, not the plain one, even with no window: \(owed)")
        let writes = world.executor.runs
        let began = world.virtual.now
        world.coordinator.beginShutdown(quitting: true)
        let quitting = Task { await world.coordinator.finishShutdown(quitting: true) }
        #expect(await waitUntil { await world.coordinator.isFinishingShutdown })
        if groupClears {
            try world.virtual.advance(to: began + 3_000)
            run.groupClears()
            try world.virtual.advance(to: began + 16_000)
            let report = try #require(await value(of: quitting))
            #expect(!report.reachedBound && report.remaining.cleanupPending == 0 && report.remaining.writesPending == 1, "\(report)")
            #expect(world.virtual.now == began + 16_000)
        } else {
            try world.virtual.advance(to: began + 16_999)
            #expect(await value(of: quitting, within: 0.3) == nil)
            try world.virtual.advance(to: began + 17_000)
            let report = try #require(await value(of: quitting))
            #expect(report.reachedBound && report.remaining.cleanupPending == 1, "\(report)")
        }
        #expect(world.executor.runs == writes, "no stack: nothing written")
        #expect(try Start.entry(world)["groupCleared"] == .bool(false), "nothing invented")
    }

    @Test("Obligations count every kind, with or without a stack, and are empty only when nothing is owed: a start at its recheck, a live run, a cleanup-pending group, a write held; with nothing owed a quit takes the plain path and finishShutdown returns at once, leaving no wake-up")
    func obligationsOfEveryKind() async throws {
        let empty = try await Start.twoRuns()
        defer { empty.clean() }
        #expect(await empty.coordinator.obligations().isEmpty)
        await Self.beginClose(empty, quitting: true)
        let none = try await Self.finish(empty, quitting: true)
        #expect(none == ParticipantShutdownReport(reachedBound: false, remaining: ParticipantObligations()))
        #expect(empty.virtual.obligation() == nil, "the bound's wake-up was cancelled")

        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        let gate = world.availability.hold()
        world.launcher.prepare(script: Stop.open, mode: .survivesSigkill)
        let start = Start.sending(world, .participantStart, Start.start(1))
        #expect(await waitUntil { gate.arrived > 0 })
        #expect(await world.coordinator.obligations().starting == 1)
        gate.open()
        #expect(try await Start.answer(start).outcome == .ok)
        try world.virtual.advance(to: world.virtual.now + 500)
        #expect(await world.drain())
        #expect(await world.coordinator.obligations().live == 1)
        faults.arm(.nextWrite)
        let stop = Start.sending(world, .participantStop, Start.read())
        #expect(await waitUntil { await world.coordinator.processWaiters == 1 })
        try world.virtual.advance(to: world.virtual.now + 12_000)
        #expect(try await Start.answer(stop).fields["state"] == .string("cleanup-pending"))
        #expect(await faults.waitUntilHeld())
        let held = await world.coordinator.obligations()
        #expect(held.live == 0 && held.cleanupPending == 1 && held.writesPending == 1, "\(held)")
        faults.release()
        #expect(await Stop.writesReturned(world))
        await world.coordinator.detach()
        let detached = await world.coordinator.obligations()
        #expect(detached.cleanupPending == 1 && detached.writesPending == 0 && !detached.isEmpty, "no stack: \(detached)")
        #expect(faults.holdTimeouts == 0)
    }

    // MARK: Close, reopen and the folder's owed writes

    @Test("Codex Q21: a window close drops the retained text before the stack goes (lost closed, only the terminal kept); reopened over the same folder, events read lost closed; after the next run starts, the earlier run's events read lost replaced")
    func lostClosedThenReplaced() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        _ = try await Stop.started(world, mode: .exitsOnSigterm)
        #expect(await world.coordinator.retainedEvents.map(\.sequence) == [1, 2])
        await Self.beginClose(world, quitting: false)
        let report = try await Self.finish(world, quitting: false)
        #expect(!report.reachedBound && report.remaining.live == 0 && report.remaining.writesPending == 0, "\(report)")
        #expect(await world.coordinator.retainedEvents.map(\.sequence) == [3], "only the terminal, before the detach")
        #expect(await world.coordinator.retainedLoss == RetainedRun.Loss(reason: .closed, throughSequence: 2))
        #expect(Self.kinds(world.sink.take()) == ["host.connection revoked"])
        #expect(try Start.entry(world)["terminal"]?.objectValue?["reason"] == .string("local-stop"), "written before the store closed")
        await world.host.closeStore()
        await world.coordinator.detach()

        let reopened = try await Self.reopen(world)
        defer { reopened.store.close() }
        let closed = try await Stop.ask(world, .participantEvents, Start.events(after: 0))
        #expect(closed.fields["lost"] == .object(["fromSequence": .number(1), "throughSequence": .number(2), "reason": .string("closed")]),
                "\(closed.jsonValue)")
        #expect(closed.fields["terminal"]?.objectValue?["sequence"] == .number(3))
        world.launcher.prepare(script: Start.script)
        #expect(try await Stop.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
        let replaced = try await Stop.ask(world, .participantEvents, Start.events(after: 0))
        #expect(replaced.fields["lost"]?.objectValue?["reason"] == .string("replaced"), "\(replaced.jsonValue)")
        #expect(replaced.fields["terminal"] == closed.fields["terminal"])
    }

    @Test("Codex Q21: close and reopen keep a cleanup-pending run's group owned: the close does not wait for it, the reopened stack over the same folder answers participant-busy and cleanup-pending, and once the group clears its true is written through the new stack; then a start is admitted")
    func reopenKeepsCleanupPendingBusy() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let run = try await Stop.started(world, mode: .survivesSigkill)
        #expect(try await Stop.settled(world, .participantStop).fields["state"] == .string("cleanup-pending"))
        try await world.settle()
        await Self.beginClose(world, quitting: false)
        let closed = try await Self.finish(world, quitting: false)
        #expect(!closed.reachedBound && closed.remaining.cleanupPending == 1, "\(closed)")
        await world.host.closeStore()
        await world.coordinator.detach()

        let reopened = try await Self.reopen(world)
        defer { reopened.store.close() }
        #expect(try await Stop.busy(world), "the group is still owned")
        let status = try await Stop.ask(world, .participantStatus, Start.read())
        #expect(status.fields["state"] == .string("cleanup-pending") && status.fields["groupCleared"] == .bool(false), "\(status.jsonValue)")
        run.groupClears()
        try await world.settle()
        #expect(await Stop.writesReturned(world))
        #expect(try Start.entry(world)["groupCleared"] == .bool(true), "written through the reopened stack")
        world.launcher.prepare(script: Start.script)
        #expect(try await Stop.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
    }

    @Test("Codex S9 ruling c: an owed terminal write is flushed by the re-attach to the same folder or by the unlock, before the stack's next request and with no busy start or Stop to trigger it; one bounded pass each: a flush that fails again stays owed, with no retry until the next trigger",
          arguments: ["re-attach", "unlock"])
    func flushOnReattachAndUnlock(_ trigger: String) async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.prepare(script: Start.script)
        #expect(try await Stop.ask(world, .participantStart, Start.start(1)).outcome == .ok)
        faults.fail(before: .rename)
        try await world.settle()
        #expect(try Start.entry(world)["terminal"] == .null)
        #expect(await world.coordinator.hasUnresolvedWrites)
        _ = world.sink.take()
        func pull() async {
            if trigger == "re-attach" {
                await world.coordinator.detach()
                try? await world.coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
            } else {
                await Self.lock(world)
                await Self.unlock(world)
                await world.reload()
            }
        }
        let first = try #require(await world.coordinator.persistence(of: Start.runId(1))?.attempts)
        faults.fail(before: .rename)
        await pull()
        #expect(await Stop.writesReturned(world))
        #expect(await world.coordinator.persistence(of: Start.runId(1))?.attempts == first + 1, "one pass")
        #expect(try Start.entry(world)["terminal"] == .null, "failed again")
        #expect(await world.coordinator.hasUnresolvedWrites, "still owed")
        try await world.settle()
        #expect(await world.coordinator.persistence(of: Start.runId(1))?.attempts == first + 1, "no retry loop and no timer")

        await pull()
        #expect(await Stop.writesReturned(world))
        #expect(await world.coordinator.persistence(of: Start.runId(1))?.attempts == first + 2)
        #expect(try Start.entry(world)["terminal"]?.objectValue?["type"] == .string("completed"))
        #expect(await world.coordinator.hasUnresolvedWrites == false)
        let pushed = Self.kinds(world.sink.take()).filter { $0.hasPrefix("participant.event") }
        #expect(pushed.isEmpty, "its terminal was pushed once, when it came; the flush pushes nothing")
        world.launcher.prepare(script: Start.script)
        #expect(try await Stop.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
    }

    @Test("Codex S9 ruling c, the commit boundary (plan S11): called directly, the pass returns only after its one attempt, and a failure stays owed with no retry; locked, or with no stack, it attempts nothing; a workspace commit through the router waits for the pass, held on the coordinator's executor, and reaches the store only after the owed terminal is durable")
    func commitWaitsForOwedWrites() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.prepare(script: Start.script)
        #expect(try await Stop.ask(world, .participantStart, Start.start(1)).outcome == .ok)
        faults.fail(before: .rename)
        try await world.settle()
        #expect(try Start.entry(world)["terminal"] == .null)
        let first = try #require(await world.coordinator.persistence(of: Start.runId(1))?.attempts)
        func attempts() async -> Int? { await world.coordinator.persistence(of: Start.runId(1))?.attempts }

        // Directly: one attempt, returned before the call did; it fails, so
        // the write stays owed, and nothing retries it.
        faults.fail(before: .rename)
        await world.coordinator.reconcileBeforeStoreWork()
        #expect(await attempts() == first + 1, "attempted before it returned")
        #expect(await world.coordinator.isWriting == false)
        #expect(await world.coordinator.hasUnresolvedWrites, "failed again: still owed")
        try await world.settle()
        #expect(await attempts() == first + 1, "no retry loop and no timer")

        // Locked (the lane's flag alone): nothing is attempted (Codex Q32).
        world.coordinator.lockNow()
        var executorRuns = world.executor.runs
        await world.coordinator.reconcileBeforeStoreWork()
        #expect(world.executor.runs == executorRuns)
        #expect(await attempts() == first + 1)
        faults.fail(before: .rename)
        await world.coordinator.unlock(ifNoLockSince: world.coordinator.lockEpoch)
        #expect(await Stop.writesReturned(world))
        #expect(await attempts() == first + 2, "the unlock's own pass, failing again")

        // No stack: nothing is attempted.
        await world.coordinator.detach()
        executorRuns = world.executor.runs
        await world.coordinator.reconcileBeforeStoreWork()
        #expect(world.executor.runs == executorRuns)
        #expect(await attempts() == first + 2)
        faults.fail(before: .rename)
        try await world.coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        #expect(await Stop.writesReturned(world))
        #expect(await attempts() == first + 3, "the re-attach's own pass, failing again")
        #expect(await world.coordinator.hasUnresolvedWrites)

        // Through the router: the commit waits while the owed write is held
        // on the coordinator's executor, and reaches the store after it.
        let before = try world.store.read()
        var record = before.record
        record["revision"] = .number(Double(before.revision + 1))
        world.executor.holdNext()
        let commit = Start.sending(world, .workspaceCommitProof, ["workspaceHandle": .string(Start.handle),
                                                                  "expectedRevision": .number(Double(before.revision)),
                                                                  "record": .object(record)])
        #expect(await waitOffPool(world.executor.held, seconds: vectorWaitSeconds), "the owed write waits on the executor")
        #expect(await value(of: commit, within: 0.3) == nil, "the commit waits for it")
        #expect(try world.store.read().revision == before.revision, "and has not reached the store")
        world.executor.releaseHeld()
        let committed = try await Start.answer(commit)
        #expect(committed.outcome == .ok && committed.fields["revision"] == .number(Double(before.revision + 1)), "\(committed.jsonValue)")
        #expect(await attempts() == first + 4)
        #expect(try Start.entry(world)["terminal"]?.objectValue?["type"] == .string("completed"), "durable before the commit")
        #expect(await world.coordinator.hasUnresolvedWrites == false)
        #expect(world.executor.holdTimeouts == 0)

        // Nothing owed: a commit asks for a pass that writes nothing.
        executorRuns = world.executor.runs
        let after = try world.store.read()
        var next = after.record
        next["revision"] = .number(Double(after.revision + 1))
        let plain = try await Stop.ask(world, .workspaceCommitProof, ["workspaceHandle": .string(Start.handle),
                                                                      "expectedRevision": .number(Double(after.revision)),
                                                                      "record": .object(next)])
        #expect(plain.outcome == .ok)
        #expect(world.executor.runs == executorRuns, "no participant write")
    }

    @Test("Codex S9 rulings a and c: a conflicted run is never flushed: an unlock and a re-attach attempt nothing for it, log nothing more and change no file; every start stays busy until quit")
    func conflictNeverFlushed() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.prepare(script: Start.script)
        #expect(try await Stop.ask(world, .participantStart, Start.start(1)).outcome == .ok)
        faults.fail(before: .rename)
        try await world.settle()
        let other: JSONValue = .object(["type": .string("failed"), "sequence": .number(2), "at": .string("2026-10-09T00:01:01.200Z"),
                                        "reason": .string("process-error")])
        _ = try Stop.substitute(world, terminal: other, groupCleared: .bool(false))
        #expect(try await Stop.busy(world))
        #expect(await Stop.writesReturned(world))
        let conflicted = try #require(await world.coordinator.persistence(of: Start.runId(1)))
        #expect(conflicted.conflict)
        let folder = try world.folderSnapshot()
        await Self.lock(world)
        await Self.unlock(world)
        await world.coordinator.detach()
        try await world.coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        await world.reload()
        #expect(await Stop.writesReturned(world))
        #expect(await world.coordinator.persistence(of: Start.runId(1))?.attempts == conflicted.attempts, "never attempted again")
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil)
        #expect(world.log.entries.filter { $0.kind == .writeConflict }.count == 1, "logged once")
        #expect(try await Stop.busy(world), "busy until the app quits")
    }

    // MARK: Detach, re-reads and attach epochs (Codex S8)

    @Test("Codex S8: a detach during the start record's write: whatever the write did, the start and a Stop waiting on it answer unknown-connection, nothing is spawned and no store work starts through the stack let go; a durable record keeps its stopped local-stop at sequence 1 in memory, written by the re-attach to the same folder and never pushed; an undetermined one stays uncertain and the re-attached stack re-reads it",
          arguments: ["durable", "undetermined"])
    func detachDuringStartRecordWrite(_ outcome: String) async throws {
        let world = try await Start.oneRun()
        defer { world.clean() }
        let faults = try #require(world.faults)
        faults.arm(.nextWrite)
        if outcome == "undetermined" { faults.undeterminedFlushes = true }
        let start = Start.sending(world, .participantStart, Start.start(), id: Start.id(1))
        #expect(await faults.waitUntilHeld())
        let stop = Start.sending(world, .participantStop, Start.read())
        #expect(await waitUntil { await world.coordinator.stopWaiters(for: Start.runId(1)) == 1 })
        let writes = world.executor.runs
        await world.coordinator.detach()
        faults.release()
        #expect(try await Start.answer(start).reason == .unknownConnection)
        #expect(try await Start.answer(stop).reason == .unknownConnection)
        #expect(world.launcher.requests.isEmpty, "nothing spawned for a stack let go")
        #expect(world.executor.runs == writes, "no store work started through it")
        #expect(world.sink.take().isEmpty)
        #expect(try Start.entry(world)["start"]?.objectValue?["requestId"] == .string(Start.id(1)))
        #expect(try Start.entry(world)["terminal"] == .null)
        if outcome == "durable" {
            let owed = try #require(await world.coordinator.owedWrites()[Start.runId(1)])
            #expect(owed.count == 1 && owed.first?.neverSpawned == true && owed.first?.terminal.reason == "local-stop"
                    && owed.first?.terminal.sequence == 1)
            #expect(await world.coordinator.obligations().writesPending == 1)
            try await world.coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
            #expect(await Stop.writesReturned(world))
            let entry = try Start.entry(world)
            #expect(entry["terminal"]?.objectValue?["reason"] == .string("local-stop") && entry["groupCleared"] == .null)
            #expect(world.sink.take().isEmpty, "decided with no stack: never pushed")
            let status = try await Stop.ask(world, .participantStatus, Start.read())
            #expect(status.fields["state"] == .string("exited") && status.fields["terminal"]?.objectValue?["sequence"] == .number(1))
        } else {
            #expect(await world.coordinator.phase(of: Start.runId(1)) == "uncertain")
            try await world.coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
            faults.undeterminedFlushes = false
            let status = try await Stop.ask(world, .participantStatus, Start.read())
            #expect(status.fields["state"] == .string("exited") && status.fields["terminal"]?.objectValue?["reason"] == .string("process-error"),
                    "re-read on the re-attached stack: the record is there, nothing ran: \(status.jsonValue)")
            #expect(Self.kinds(world.sink.take()) == ["participant.event failed"], "pushed once, to the attached stack")
        }
        #expect(faults.holdTimeouts == 0)
    }

    @Test("Codex S8: an authoritative re-read is keyed to the stack that asked: held on the executor when that stack is let go and the same store attached again, it decides nothing and its status answers unknown-connection; a status on the new attach never joins it, waits for it, then re-reads itself and settles the run")
    func rereadKeyedToItsStack() async throws {
        let world = try await Start.oneRun()
        defer { world.clean() }
        let faults = try #require(world.faults)
        faults.undeterminedFlushes = true
        #expect(try await Stop.ask(world, .participantStart, Start.start(), id: Start.id(1)).outcome == .unknown)
        #expect(await world.coordinator.phase(of: Start.runId(1)) == "uncertain")
        faults.undeterminedFlushes = false
        let before = world.executor.runs
        world.executor.holdNext()
        let first = Start.sending(world, .participantStatus, Start.read())
        #expect(await waitOffPool(world.executor.held, seconds: vectorWaitSeconds), "its re-read waits on the executor, before the store")
        await world.coordinator.detach()
        try await world.coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        let second = Start.sending(world, .participantStatus, Start.read())
        #expect(await value(of: second, within: 0.3) == nil, "never joins the re-read of the attach let go")
        world.executor.releaseHeld()
        #expect(try await Start.answer(first).reason == .unknownConnection)
        let settled = try await Start.answer(second)
        #expect(settled.fields["state"] == .string("exited") && settled.fields["terminal"]?.objectValue?["reason"] == .string("process-error"),
                "\(settled.jsonValue)")
        #expect(try Start.entry(world)["terminal"]?.objectValue?["sequence"] == .number(1))
        #expect(world.executor.runs == before + 4,
                "the held re-read (which decided nothing), the attach's refresh, the new attach's own re-read, and one terminal write")
        #expect(await world.coordinator.isWriting == false)
        #expect(world.executor.holdTimeouts == 0)
    }

    @Test("Codex S8: same-store re-attach epochs: a Stop waiting for a running run's terminal on one attach answers unknown-connection once the stack is let go, even though the same store was attached again; a Stop on the new attach joins the same terminal, with no second signal, and answers it")
    func sameStoreReattachEpoch() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let run = try await Stop.started(world, mode: .survivesSigkill)
        let first = Start.sending(world, .participantStop, Start.read())
        #expect(await waitUntil { await world.coordinator.processWaiters == 1 })
        await world.coordinator.detach()
        try await world.coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        let second = Start.sending(world, .participantStop, Start.read())
        #expect(await waitUntil { await world.coordinator.processWaiters == 2 })
        try world.virtual.advance(to: world.virtual.now + 12_000)
        #expect(try await Start.answer(first).reason == .unknownConnection, "admitted on the attach let go")
        let answered = try await Start.answer(second)
        #expect(answered.fields["state"] == .string("cleanup-pending")
                && answered.fields["terminal"]?.objectValue?["reason"] == .string("stop-incomplete"), "\(answered.jsonValue)")
        #expect(run.stopCalls.count == 1, "one signal for both")
        try await world.settle()
    }

    // MARK: The S10 review's fixes

    /// A text event of run 1, as a hand-driven run sends it.
    static func textEvent(_ sequence: Int, _ text: String) -> ParticipantEvent {
        ParticipantEvent(runId: Start.runId(1), sessionId: Start.sessionId(1), sequence: sequence, at: Start.clock, type: .text, text: text)
    }

    @Test("S10 review R1: an update applied after lockNow's step on the app's thread and before its follow-up reaches the actor keeps the lock's stopping mark: status reads stopping, the event's text is not kept, and a later Stop joins that stop and signals nothing more")
    func updateBeforeLockFollowUp() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let manual = try await Start.Manual(world)
        #expect(try await manual.send(.participantStart, Start.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        run.send(.event(manual.event(1, .started)))
        #expect(await manual.applied(1))
        // lockNow's step on the app's thread alone, as it stands before its
        // follow-up reaches the actor: the run's next update gets there first.
        for handle in manual.coordinator.gate.lockNow() { handle.stop() }
        #expect(run.stopCalls == 1)
        run.send(.event(Self.textEvent(2, "Invented text the lock drops.")))
        #expect(await manual.applied(2))
        #expect(await manual.coordinator.stopRequested(of: Start.runId(1)) == true, "the lock's mark survives the update")
        #expect(await manual.coordinator.retainedEvents.isEmpty)
        #expect(await manual.coordinator.retainedLoss == RetainedRun.Loss(reason: .locked, throughSequence: 2))
        #expect(try await manual.state() == .string("stopping"))
        let stop = Task { try? await manual.send(.participantStop, Start.read(1)) }
        #expect(await waitUntil { await manual.coordinator.processWaiters == 1 }, "it waits for the lock's stop")
        #expect(run.stopCalls == 1, "it joins the lock's stop: no second signal")
        run.send(.terminal(manual.event(3, .stopped, reason: "local-stop"), groupCleared: true))
        run.send(.cleanupReleased)
        run.finish()
        let answered = try #require(await value(of: stop) ?? nil)
        #expect(answered.fields["state"] == .string("exited") && answered.fields["terminal"]?.objectValue?["sequence"] == .number(3),
                "\(answered.jsonValue)")
        #expect(run.stopCalls == 1)
        #expect(await manual.finished())
    }

    @Test("S10 review: a request answered right after lockNow's or beginShutdown's step on the app's thread, before its follow-up reaches the actor, gives none of the dropped text: events read lost locked or closed",
          arguments: [false, true])
    func textGoneBeforeFollowUp(_ closing: Bool) async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let manual = try await Start.Manual(world)
        #expect(try await manual.send(.participantStart, Start.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        let secret = "Invented text that must not outlive the lock."
        run.send(.event(manual.event(1, .started)))
        run.send(.event(Self.textEvent(2, secret)))
        #expect(await manual.applied(2))
        #expect(await manual.coordinator.retainedEvents.map(\.sequence) == [1, 2])
        // The gate's step alone: the follow-up that would drop the text on
        // the actor is never scheduled, so the request is the first to look.
        let stopped = closing
            ? manual.coordinator.gate.beginShutdown(at: world.virtual.now, quitting: false)
            : manual.coordinator.gate.lockNow()
        #expect(stopped.count == 1)
        let events = try await manual.send(.participantEvents, Start.events(after: 0))
        #expect(events.outcome == .ok && events.fields["events"] == .array([]), "\(events.jsonValue)")
        #expect(events.fields["lost"] == .object(["fromSequence": .number(1), "throughSequence": .null,
                                                  "reason": .string(closing ? "closed" : "locked")]), "\(events.jsonValue)")
        let bytes = String(decoding: events.jsonValue.canonicalData(), as: UTF8.self)
        #expect(!bytes.contains("Invented text"), "no dropped text in the reply")
        #expect(await manual.coordinator.retainedEvents.isEmpty)
        run.finish()
    }

    @Test("Codex Q33 from its start: the quit's 17 s run from beginShutdown(quitting: true), not from finishShutdown: with 5 s between the two calls, finishShutdown still waits at +16,999 ms and returns at exactly +17,000 ms, not +22,000")
    func quitBoundFromItsBegin() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let run = try await Stop.started(world, mode: .survivesSigkill)
        let began = world.virtual.now
        await Self.beginClose(world, quitting: true)
        try world.virtual.advance(to: began + 5_000)
        let quitting = Task { await world.coordinator.finishShutdown(quitting: true) }
        #expect(await waitUntil { await world.coordinator.isFinishingShutdown })
        try world.virtual.advance(to: began + 16_999)
        #expect(run.terminalUpdate?.event.reason == "stop-incomplete")
        #expect(await value(of: quitting, within: 0.3) == nil, "still waiting at +16,999 ms")
        try world.virtual.advance(to: began + 17_000)
        let report = try #require(await value(of: quitting))
        #expect(report.reachedBound && report.remaining.cleanupPending == 1, "\(report)")
        #expect(world.virtual.now == began + 17_000)
    }

    @Test("Codex Q33, a quit during a window close: the quit's beginShutdown lands while the close runs and shares its bound; the close settles (it does not wait for cleanup), closes the store and detaches first; the quit's finishShutdown, entered 6 s after the close began, with no window, still returns at the close's start + 17 s (16 s after the quit began), never a fresh 17 s from the detach or its own call; no stack attaches once the quit began")
    func quitDuringCloseSharesItsBound() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        _ = try await Stop.started(world, mode: .survivesSigkill)
        #expect(try await Stop.settled(world, .participantStop).fields["state"] == .string("cleanup-pending"))
        try await world.settle()
        let began = world.virtual.now
        await Self.beginClose(world, quitting: false)
        let closing = Task { await world.coordinator.finishShutdown(quitting: false) }
        try world.virtual.advance(to: began + 1_000)
        // The quit begins while the close runs, before its stack is let go.
        world.coordinator.beginShutdown(quitting: true)
        let closed = try #require(await value(of: closing))
        #expect(!closed.reachedBound && closed.remaining.cleanupPending == 1, "\(closed)")
        await world.host.closeStore()
        await world.coordinator.detach()
        try world.virtual.advance(to: began + 6_000)
        let quitting = Task { await world.coordinator.finishShutdown(quitting: true) }
        #expect(await waitUntil { await world.coordinator.isFinishingShutdown })
        try world.virtual.advance(to: began + 16_999)
        #expect(await value(of: quitting, within: 0.3) == nil, "still waiting at +16,999 ms")
        try world.virtual.advance(to: began + 17_000)
        let report = try #require(await value(of: quitting))
        #expect(report.reachedBound && report.remaining.cleanupPending == 1, "\(report)")
        #expect(world.virtual.now == began + 17_000, "the close's bound, shared")

        // A quit is final: the folder reopened is refused.
        let store = try ProofStore(directory: world.storeDirectory, keys: world.keys, seed: WorkspaceSeed(record: ["revision": .number(0)]))
        defer { store.close() }
        let host = DeskHostProtocol(store: store, connections: world.connections, drafts: DraftBindingRegistry(), info: VectorWorld.info,
                                    events: world.sink, participants: world.hostConfiguration)
        await #expect(throws: ParticipantCoordinator.AttachError.shuttingDown) {
            try await world.coordinator.attach(host: host, store: store, connections: world.connections, sink: world.sink)
        }
    }

    @Test("S10 review R2: a window close or quit that begins while an attach refreshes its store makes that attach attach nothing (shuttingDown): closed stays set, pushes stay off and the bound keeps its start; after the close's detach a new attach works, after a quit none does",
          arguments: [false, true])
    func attachRefusedDuringShutdown(_ quitting: Bool) async throws {
        let world = try await Start.oneRun()
        defer { world.clean() }
        await world.coordinator.detach()
        world.executor.holdNext()
        let attaching = Task {
            try await world.coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        }
        #expect(await waitOffPool(world.executor.held, seconds: vectorWaitSeconds), "the attach is refreshing the store")
        let began = world.virtual.now
        world.coordinator.beginShutdown(quitting: quitting)
        try world.virtual.advance(to: began + 2_000)
        world.executor.releaseHeld()
        await #expect(throws: ParticipantCoordinator.AttachError.shuttingDown) { try await attaching.value }
        let lifecycle = world.coordinator.gate.state
        #expect(lifecycle.closing && !world.coordinator.pushGate.isOpen)
        #expect(lifecycle.boundStart(quitting: quitting) == began, "the bound keeps its start")
        let status = try await Start.answer(Start.sending(world, .participantStatus, Start.read()))
        #expect(status.reason == .unknownConnection, "nothing attached: \(status.jsonValue)")
        let report = try await Self.finish(world, quitting: quitting)
        #expect(!report.reachedBound && report.remaining.isEmpty, "\(report)")
        await world.coordinator.detach()
        if quitting {
            await #expect(throws: ParticipantCoordinator.AttachError.shuttingDown) {
                try await world.coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
            }
        } else {
            try await world.coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
            #expect(!world.coordinator.gate.state.closing && world.coordinator.pushGate.isOpen)
            let reopened = try await Stop.ask(world, .participantStatus, Start.read())
            #expect(reopened.fields["state"] == .string("not-dispatched"), "\(reopened.jsonValue)")
        }
        #expect(world.executor.holdTimeouts == 0)
    }

    @Test("Codex Q33, one cap and not one per phase: a run stopped 1 s before the quit survives SIGKILL (stop-incomplete 11 s into the quit, written with false); its group clears, the supervisor's 5 s re-probe sees it 16 s into the quit, and the true upgrade's write is held in the store; finishShutdown(quitting: true) still waits at +16,999 ms and returns at exactly +17,000 ms with that write unfinished, where a 12 s stop plus a 5 s write would run to +21 s")
    func quitBoundIsOneCap() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        let run = try await Stop.started(world, mode: .survivesSigkill)
        let stoppedAt = world.virtual.now
        let stop = Start.sending(world, .participantStop, Start.read())
        #expect(await waitUntil { await world.coordinator.processWaiters == 1 })
        try world.virtual.advance(to: stoppedAt + 1_000)
        let began = world.virtual.now
        await Self.beginClose(world, quitting: true)
        let quitting = Task { await world.coordinator.finishShutdown(quitting: true) }
        #expect(await waitUntil { await world.coordinator.isFinishingShutdown })
        try world.virtual.advance(to: began + 11_000)
        #expect(run.terminalUpdate?.event.reason == "stop-incomplete")
        #expect(try await Start.answer(stop).fields["state"] == .string("cleanup-pending"))
        #expect(await Stop.writesReturned(world))
        #expect(try Start.entry(world)["groupCleared"] == .bool(false), "the terminal is written")
        faults.arm(.nextWrite)
        run.groupClears()
        try world.virtual.advance(to: began + 16_000)
        #expect(await faults.waitUntilHeld(), "the re-probe saw the group gone: the upgrade's write is held in the store")
        try world.virtual.advance(to: began + 16_999)
        #expect(await value(of: quitting, within: 0.3) == nil, "still waiting at +16,999 ms")
        try world.virtual.advance(to: began + 17_000)
        let report = try #require(await value(of: quitting))
        #expect(report.reachedBound && report.remaining.writesPending == 1, "\(report)")
        #expect(world.virtual.now == began + 17_000)
        faults.release()
        #expect(await Stop.writesReturned(world))
        #expect(faults.holdTimeouts == 0)
    }

    @Test("S10 review R7: a never-spawned terminal (a spawn that threw) whose write is still on the executor when a window close's bound passes is drained on the closed store, stays owed, and is queued once more through the stack reopened over the same folder meanwhile, whose own flush skipped it: it becomes durable there with no busy start or Stop; the start admitted on the stack let go answers unknown-connection")
    func drainedNeverSpawnedWriteRequeued() async throws {
        struct InventedLaunchFailure: Error {}
        let world = try await Start.oneRun()
        defer { world.clean() }
        world.launcher.failLaunches(with: InventedLaunchFailure())
        // The start record's write passes; the spawn failure's terminal waits.
        world.executor.holdNext(skipping: 1)
        let start = Start.sending(world, .participantStart, Start.start(), id: Start.id(1))
        #expect(await waitOffPool(world.executor.held, seconds: vectorWaitSeconds), "the terminal's write waits on the executor")
        let began = world.virtual.now
        await Self.beginClose(world, quitting: false)
        let closing = Task { await world.coordinator.finishShutdown(quitting: false) }
        #expect(await waitUntil { await world.coordinator.isFinishingShutdown })
        try world.virtual.advance(to: began + 17_000)
        let closed = try #require(await value(of: closing))
        #expect(closed.reachedBound && closed.remaining.writesPending == 1, "\(closed)")
        await world.host.closeStore()
        await world.coordinator.detach()
        let reopened = try await Self.reopen(world)
        defer { reopened.store.close() }
        #expect(await world.coordinator.owedWrites().isEmpty, "the attach's flush skipped it: its write is in flight")
        world.executor.releaseHeld()
        #expect(try await Start.answer(start).reason == .unknownConnection, "admitted on the stack let go")
        #expect(await Stop.writesReturned(world))
        let entry = try Start.entry(world)
        #expect(entry["terminal"]?.objectValue?["reason"] == .string("process-error") && entry["groupCleared"] == .null,
                "written through the reopened stack: \(entry)")
        #expect(await world.coordinator.hasUnresolvedWrites == false)
        #expect(world.executor.holdTimeouts == 0)
    }

    @Test("S10 review R8: a start whose Stop came before step 14, its stack let go while the never-dispatched cancellation's write is on the executor, answers unknown-connection, not that write's run-not-prepared; the write itself, already handed over, still completes")
    func cancelledStartAfterDetach() async throws {
        let world = try await Start.oneRun()
        defer { world.clean() }
        let gate = world.availability.hold()
        let start = Start.sending(world, .participantStart, Start.start(), id: Start.id(1))
        #expect(await waitUntil { gate.arrived > 0 })
        let stop = Start.sending(world, .participantStop, Start.read())
        #expect(await waitUntil { await world.coordinator.stopWaiters(for: Start.runId(1)) == 1 })
        world.executor.holdNext()
        gate.open()
        #expect(await waitOffPool(world.executor.held, seconds: vectorWaitSeconds), "the cancellation's write waits on the executor")
        await world.coordinator.detach()
        world.executor.releaseHeld()
        let started = try await Start.answer(start)
        #expect(started.reason == .unknownConnection, "\(started.jsonValue)")
        let stopped = try await Start.answer(stop)
        #expect(stopped.reason == .unknownConnection || stopped.fields["terminal"]?.objectValue?["reason"] == .string("local-stop"),
                "the Stop answers by the write it joined, or unknown-connection if it had not: \(stopped.jsonValue)")
        #expect(await Stop.writesReturned(world))
        #expect(try Start.entry(world)["terminal"]?.objectValue?["reason"] == .string("local-stop"), "drained, not recalled")
        #expect(world.launcher.requests.isEmpty && world.executor.holdTimeouts == 0)
    }

    @Test("Section 8 after an unlock: a run the lock stopped whose terminal comes after the unlock (its group survives SIGTERM: KILL at +10 s, stop-incomplete at +12 s) pushes that terminal only to the connection issued after the unlock, never to the one the lock revoked, and the unlock lets it be written")
    func unlockBeforeLockStoppedTerminal() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let run = try await Stop.started(world, mode: .survivesSigkill)
        let lockedAt = world.virtual.now
        await Self.lock(world)
        try world.virtual.advance(to: lockedAt + 2_000)
        #expect(run.terminalUpdate == nil)
        await Self.unlock(world)
        await world.reload()
        #expect(Self.kinds(world.sink.take()) == ["host.connection locked", "host.connection ready"])
        try world.virtual.advance(to: lockedAt + 12_000)
        #expect(await world.drain())
        #expect(run.terminalUpdate?.event.reason == "stop-incomplete")
        let pushed = world.sink.take()
        #expect(Self.kinds(pushed) == ["participant.event stopped"], "\(pushed)")
        #expect(pushed.allSatisfy { $0.objectValue?["connectionId"] == .string("51000000-0000-4000-8000-0000000000d1") },
                "only to the connection issued after the unlock")
        #expect(await Stop.writesReturned(world))
        #expect(try Start.entry(world)["terminal"]?.objectValue?["reason"] == .string("stop-incomplete"))
    }
}
