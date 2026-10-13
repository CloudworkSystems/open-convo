import Foundation
import Testing
@testable import DeskHost
@testable import ParticipantCoordinator
@testable import ParticipantProcess

// Stop, cleanup-pending and supervisor loss for runs this launch spawned
// (plan S9; contract sections 7 step 12, 8, 10 and 11; Codex Q31): Stop
// signals first and answers from memory, concurrent Stops share one
// terminal or one retry, a lost supervisor is never signalled, and a run's
// terminal and cleanup evidence are written in the background, bounded and
// idempotent, with every new start busy until they are durable. Runs are
// scripted on the virtual clock (the real reader and supervisor engine),
// never the real CLI; every wait is bounded. Invented data only.

@Suite("Participant coordinator: Stop, cleanup and persistence")
struct ParticipantCoordinatorStopTests {
    typealias Start = ParticipantCoordinatorStartTests

    /// A run that keeps running: started, then its text at +350 ms.
    static let open = [ScriptStep(atMs: 0, .initClean), ScriptStep(atMs: 50, .rateLimitOK), ScriptStep(atMs: 100, .textDelta("Four. "))]

    /// Starts run 1 of `world` with `script` and `mode`, lets 500 ms pass and
    /// drains; nothing pushed so far is kept.
    static func started(_ world: VectorWorld, mode: SimulatedProcessMode, script: [ScriptStep] = open) async throws
        -> ScriptedParticipantRun {
        world.launcher.prepare(script: script, mode: mode)
        let reply = try await Self.ask(world, .participantStart, Start.start(1), id: Start.id(1))
        #expect(reply.outcome == .ok, "\(reply.jsonValue)")
        let run = try #require(world.launcher.runs.last)
        try world.virtual.advance(to: world.virtual.now + 500)
        #expect(await world.drain())
        _ = world.sink.take()
        return run
    }

    /// Sends `operation` for run `run` and waits for its answer, settling
    /// virtual time while it waits on the run's process.
    static func settled(_ world: VectorWorld, _ operation: HostOperation, run: Int = 1) async throws -> HostResponse {
        try #require(try await world.answer(Start.sending(world, operation, Start.read(run)), settling: true))
    }

    /// Sends `operation` and waits for its answer, bounded: a request that
    /// should answer at once fails the test instead of hanging it.
    static func ask(_ world: VectorWorld, _ operation: HostOperation, _ payload: [String: JSONValue],
                    id: String = UUID().uuidString.lowercased()) async throws -> HostResponse {
        try await Start.answer(Start.sending(world, operation, payload, id: id))
    }

    static func busy(_ world: VectorWorld) async throws -> Bool {
        try await Self.ask(world, .participantStart, Start.start(2)).reason == .participantBusy
    }

    /// Waits until no coordinator write is in flight.
    static func writesReturned(_ world: VectorWorld) async -> Bool {
        await waitUntil { !(await world.coordinator.isWriting) }
    }

    // MARK: Stop of a running run (section 10)

    @Test("Two Stops at once share one signal and one terminal: exits-on-sigterm ends stopped local-stop with groupCleared true at once (exited); survives-sigkill ends stop-incomplete with false 12 s later, after TERM and one KILL at +10 s (cleanup-pending); stopping meanwhile; pushed once and recorded once")
    func concurrentStopsShareOneTerminal() async throws {
        for (mode, state, reason, cleared, delay) in [(SimulatedProcessMode.exitsOnSigterm, "exited", "local-stop", true, UInt64(0)),
                                                      (.survivesSigkill, "cleanup-pending", "stop-incomplete", false, 12_000)] {
            let world = try await Start.twoRuns()
            defer { world.clean() }
            let run = try await Self.started(world, mode: mode)
            let stoppedAt = world.virtual.now
            let first = Start.sending(world, .participantStop, Start.read())
            #expect(await waitUntil { await world.coordinator.processWaiters >= 1 || run.terminalUpdate != nil })
            if mode == .survivesSigkill {
                let status = try await Self.ask(world, .participantStatus, Start.read())
                #expect(status.fields["state"] == .string("stopping") && status.fields["terminal"] == .null, "\(status.jsonValue)")
            }
            let second = Start.sending(world, .participantStop, Start.read())
            if mode == .survivesSigkill {
                // It joins the first before any time passes. (Under
                // exits-on-sigterm the run may already have ended when it
                // arrives: then it reads the ended run, which signals
                // nothing and gives the same fields.)
                #expect(await waitUntil { await world.coordinator.processWaiters == 2 })
            }
            let one = try #require(try await world.answer(first, settling: true))
            let two = try #require(try await world.answer(second, settling: true))
            #expect(one.fields["state"] == .string(state) && one.fields["groupCleared"] == .bool(cleared), "\(one.jsonValue)")
            #expect(one.fields == two.fields, "one terminal: \(two.jsonValue)")
            let terminal = try #require(one.fields["terminal"]?.objectValue)
            #expect(terminal["reason"] == .string(reason) && terminal["sequence"] == .number(3))
            #expect(terminal["at"] == .string(ParticipantTimestamp.format(millis: world.virtual.clock.wallAtStart + Int64(stoppedAt + delay))),
                    "section 11's bound: \(terminal)")
            #expect(run.stopCalls.count == 1, "the second Stop joined the first")
            #expect(run.system.signalNames == (mode == .exitsOnSigterm ? ["TERM@\(stoppedAt)"] : ["TERM@\(stoppedAt)", "KILL@\(stoppedAt + 10_000)"]))
            #expect(one.fields["providerCancelConfirmed"] == .bool(false))
            try await world.settle()
            let pushed = world.sink.take()
            #expect(pushed.count == 1 && pushed.first?.objectValue?["event"]?.objectValue?["reason"] == .string(reason), "\(pushed)")
            let entry = try Start.entry(world)
            #expect(entry["terminal"]?.objectValue?["reason"] == .string(reason) && entry["groupCleared"] == .bool(cleared))
            #expect(await world.coordinator.hasUnresolvedWrites == false)
        }
    }

    @Test("A Stop arriving during stopping joins the first: no second signal, the same terminal; a Stop after the run ended on its own is exited and signals nothing")
    func stopDuringStoppingJoins() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let run = try await Self.started(world, mode: .survivesSigkill)
        let first = Start.sending(world, .participantStop, Start.read())
        #expect(await waitUntil { await world.coordinator.processWaiters == 1 })
        try world.virtual.advance(to: world.virtual.now + 5_000)
        #expect(await world.coordinator.processWaiters == 1, "still inside the 10 s wait")
        let late = Start.sending(world, .participantStop, Start.read())
        #expect(await waitUntil { await world.coordinator.processWaiters == 2 })
        let one = try #require(try await world.answer(first, settling: true))
        let two = try #require(try await world.answer(late, settling: true))
        #expect(one.fields == two.fields && one.fields["state"] == .string("cleanup-pending"), "\(two.jsonValue)")
        #expect(run.stopCalls.count == 1)

        // A run that completed on its own: nothing to signal.
        let fresh = try await Start.twoRuns()
        defer { fresh.clean() }
        fresh.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(fresh, .participantStart, Start.start(1)).outcome == .ok)
        try await fresh.settle()
        let done = try #require(fresh.launcher.runs.first)
        let stop = try await Self.ask(fresh, .participantStop, Start.read())
        #expect(stop.fields["state"] == .string("exited") && stop.fields["terminal"]?.objectValue?["type"] == .string("completed"))
        #expect(done.stopCalls.isEmpty && done.system.signals.isEmpty)
    }

    // MARK: Cleanup-pending (section 10)

    @Test("Cleanup-pending: a retry Stop sends one more SIGKILL and probes 2 s; members left is cleanup-pending with no new event; concurrent retries share one; once the group clears, the retry is exited with groupCleared true, written after the terminal; then starts are admitted")
    func retryEndsUnclearedThenCleared() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let run = try await Self.started(world, mode: .survivesSigkill)
        let stop = try await Self.settled(world, .participantStop)
        #expect(stop.fields["state"] == .string("cleanup-pending"))
        try await world.settle()
        _ = world.sink.take()
        #expect(try await Self.busy(world), "cleanup-pending blocks every start")

        let retryAt = world.virtual.now
        let first = Start.sending(world, .participantStop, Start.read())
        #expect(await waitUntil { await world.coordinator.processWaiters == 1 })
        let second = Start.sending(world, .participantStop, Start.read())
        #expect(await waitUntil { await world.coordinator.processWaiters == 2 })
        let one = try #require(try await world.answer(first, settling: true))
        let two = try #require(try await world.answer(second, settling: true))
        #expect(one.fields == stop.fields && two.fields == stop.fields, "unchanged: \(one.jsonValue)")
        #expect(run.stopCalls.count == 2, "one retry for both")
        #expect(run.system.signalNames.last == "KILL@\(retryAt)", "\(run.system.signalNames)")
        try await world.settle()
        #expect(world.sink.take().isEmpty, "no new event")
        #expect(try Start.entry(world)["groupCleared"] == .bool(false))

        run.groupClears()
        let cleared = try await Self.settled(world, .participantStop)
        #expect(cleared.fields["state"] == .string("exited") && cleared.fields["groupCleared"] == .bool(true), "\(cleared.jsonValue)")
        #expect(cleared.fields["terminal"] == stop.fields["terminal"], "the terminal is never rewritten")
        try await world.settle()
        #expect(world.sink.take().isEmpty)
        let entry = try Start.entry(world)
        #expect(entry["groupCleared"] == .bool(true) && entry["terminal"]?.objectValue?["reason"] == .string("stop-incomplete"))
        let status = try await Self.ask(world, .participantStatus, Start.read())
        #expect(status.fields["state"] == .string("exited") && status.fields["groupCleared"] == .bool(true))
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
        #expect(!run.system.signalledAfterReap, "never signalled after the reap")
    }

    // MARK: Supervisor loss (section 10)

    @Test("Supervisor lost while a Stop is in progress: stopped stop-incomplete with groupCleared false, cleanup-pending; a later Stop signals nothing; once both pipes reach EOF it is exited, still false, never set true")
    func supervisorLostDuringStop() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let run = try await Self.started(world, mode: .survivesSigkill)
        let stop = Start.sending(world, .participantStop, Start.read())
        #expect(await waitUntil { await world.coordinator.processWaiters == 1 })
        try world.virtual.advance(to: world.virtual.now + 1_000)
        run.supervisorDies()
        let reply = try #require(try await world.answer(stop, settling: true))
        #expect(reply.fields["state"] == .string("cleanup-pending") && reply.fields["groupCleared"] == .bool(false), "\(reply.jsonValue)")
        #expect(reply.fields["terminal"]?.objectValue?["reason"] == .string("stop-incomplete"))
        try await world.settle()
        let signals = run.system.signals.count
        let again = try await Self.ask(world, .participantStop, Start.read())
        #expect(again.fields == reply.fields, "\(again.jsonValue)")
        #expect(run.system.signals.count == signals && run.stopCalls.last?.sent == false, "nothing signalled without a supervisor")
        #expect(try await Self.busy(world))

        run.pipesClose()
        #expect(await world.drain())
        let status = try await Self.ask(world, .participantStatus, Start.read())
        #expect(status.fields["state"] == .string("exited") && status.fields["groupCleared"] == .bool(false), "\(status.jsonValue)")
        #expect(try Start.entry(world)["groupCleared"] == .bool(false), "never set true")
        #expect(try await Self.ask(world, .participantStop, Start.read()).fields["state"] == .string("exited"))
    }

    @Test("A supervisor-lost run fails process-error with groupCleared false and blocks every start until both pipes reach EOF; then a start is admitted")
    func supervisorLostBlocksUntilEOF() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let run = try await Self.started(world, mode: .exitsOnSigterm)
        run.supervisorDies()
        try await world.settle()
        let status = try await Self.ask(world, .participantStatus, Start.read())
        #expect(status.fields["state"] == .string("cleanup-pending") && status.fields["groupCleared"] == .bool(false), "\(status.jsonValue)")
        #expect(status.fields["terminal"]?.objectValue?["reason"] == .string("process-error"))
        #expect(try await Self.busy(world))
        try world.virtual.advance(to: world.virtual.now + 60_000)
        #expect(try await Self.busy(world), "until EOF, however long")
        run.pipesClose()
        #expect(await world.drain())
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
        #expect(try Start.entry(world, run: 1)["groupCleared"] == .bool(false))
    }

    @Test("An earlier launch's run with an uncleared group never blocks a start; its Stop is exited with the stored false and signals nothing")
    func earlierLaunchGroupNeverBlocks() async throws {
        let vectors = try ParticipantVectors.load()
        let source = try vectors.named("participant.start after restart is not blocked by an earlier launch group")
        let seed: [String: JSONValue] = ["record": source.seed["record"] ?? .null, "runs": source.seed["runs"] ?? .null,
                                         "availability": .object(["result": .string("available")])]
        let world = try await VectorWorld(seed: seed, number: source.number, operation: "participant.start", vectors: vectors,
                                          clock: "2026-10-09T00:01:30.000Z")
        defer { world.clean() }
        let stop = try await Self.ask(world, .participantStop, Start.read(1))
        #expect(stop.fields["state"] == .string("exited") && stop.fields["groupCleared"] == .bool(false), "\(stop.jsonValue)")
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
        #expect(world.launcher.requests.map(\.identity.runId) == [Start.runId(2)])
    }

    // MARK: The store's lock (contract 16.5, at test level; Codex Q31)

    @Test("Contract 16.5 at test level: while another write already holds ProofStore's lock (a never-dispatched run's cancellation, held inside it), a Stop of a running run signals TERM once and answers exited, and a cleanup-pending run's retry Stop signals one SIGKILL and answers exited with groupCleared true; status, events and a start answer too, all before that write is released; then every write lands")
    func stopSignalsWhileAnotherWriteHoldsTheLock() async throws {
        for mode in [SimulatedProcessMode.exitsOnSigterm, .survivesSigkill] {
            let world = try await Start.twoRuns()
            defer { world.clean() }
            let faults = try #require(world.faults)
            let run = try await Self.started(world, mode: mode)
            if mode == .survivesSigkill {
                // Cleanup-pending, its terminal durable; then the group
                // clears, so the retry below finds it gone.
                #expect(try await Self.settled(world, .participantStop).fields["state"] == .string("cleanup-pending"))
                try await world.settle()
                run.groupClears()
                #expect(await world.drain())
                let pending = try await Self.ask(world, .participantStatus, Start.read())
                #expect(pending.fields["state"] == .string("cleanup-pending"), "only a probe proves the group gone: \(pending.jsonValue)")
            }
            let signals = run.system.signals.count
            let calls = run.stopCalls.count
            // Run 2 was never dispatched: its Stop's cancellation write
            // holds the store's lock, and that Stop waits for it.
            faults.arm(.nextWrite)
            let cancel = Start.sending(world, .participantStop, Start.read(2))
            #expect(await faults.waitUntilHeld(), "an unrelated write holds ProofStore's lock")

            let at = world.virtual.now
            let stop = try await Self.ask(world, .participantStop, Start.read())
            #expect(faults.isHolding, "\(mode): answered while the other write still held the lock")
            #expect(run.stopCalls.count == calls + 1 && run.stopCalls.last?.sent == true, "signalled, once")
            #expect(Array(run.system.signalNames.dropFirst(signals)) == [mode == .exitsOnSigterm ? "TERM@\(at)" : "KILL@\(at)"],
                    "\(run.system.signalNames)")
            #expect(stop.fields["state"] == .string("exited") && stop.fields["groupCleared"] == .bool(true), "\(stop.jsonValue)")
            let status = try await Self.ask(world, .participantStatus, Start.read())
            #expect(status.fields["state"] == .string("exited") && status.fields["terminal"] == stop.fields["terminal"])
            let events = try await Self.ask(world, .participantEvents, Start.events(after: 2))
            #expect(events.fields["events"] == .array([try #require(stop.fields["terminal"])]), "\(events.jsonValue)")
            // Run 2's cancellation is in flight: its start is `unknown`, at once.
            #expect(try await Self.ask(world, .participantStart, Start.start(2)).outcome == .unknown)
            #expect(faults.isHolding, "every answer came while the other write held the lock")

            faults.release()
            let cancelled = try await Start.answer(cancel)
            #expect(cancelled.fields["state"] == .string("exited")
                    && cancelled.fields["terminal"]?.objectValue?["reason"] == .string("local-stop"), "\(cancelled.jsonValue)")
            #expect(await Self.writesReturned(world))
            let entry = try Start.entry(world)
            #expect(entry["groupCleared"] == .bool(true), "\(entry)")
            #expect(entry["terminal"]?.objectValue?["reason"] == .string(mode == .exitsOnSigterm ? "local-stop" : "stop-incomplete"))
            #expect(await world.coordinator.hasUnresolvedWrites == false)
            #expect(faults.holdTimeouts == 0)
            #expect(!run.system.signalledAfterReap)
        }
    }

    @Test("Stop never waits for its own terminal write: that write is held inside ProofStore's lock until after the reply is taken; exited from memory, status and events agree; a start is busy (and answers) until the write returns, then admitted")
    func stopNeverWaitsForItsOwnWrite() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        _ = try await Self.started(world, mode: .exitsOnSigterm)
        faults.arm(.nextWrite)
        let stop = try await Self.ask(world, .participantStop, Start.read())
        #expect(await faults.waitUntilHeld(), "the terminal's own write is held inside the store's lock, released only after the reply was taken")
        #expect(stop.fields["state"] == .string("exited") && stop.fields["groupCleared"] == .bool(true), "\(stop.jsonValue)")
        let status = try await Self.ask(world, .participantStatus, Start.read())
        #expect(status.fields["state"] == .string("exited") && status.fields["terminal"] == stop.fields["terminal"])
        let events = try await Self.ask(world, .participantEvents, Start.events(after: 2))
        #expect(events.fields["events"] == .array([try #require(stop.fields["terminal"])]), "\(events.jsonValue)")
        #expect(try Start.entry(world)["terminal"] == .null, "not on disk yet")
        #expect(try await Self.busy(world), "Codex Q31: busy while the terminal write is unresolved")
        #expect(faults.isHolding)
        faults.release()
        #expect(await Self.writesReturned(world))
        #expect(try Start.entry(world)["terminal"]?.objectValue?["reason"] == .string("local-stop"))
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
        #expect(faults.holdTimeouts == 0)
    }

    // MARK: Pending terminal and cleanup writes (Codex Q31)

    @Test("Codex Q31, failed terminal write (definite): status and events answer the exact terminal from memory while the folder shows none; every start is busy; the busy start queues a retry that writes the same at, sequence and reason later; then a start is admitted")
    func failedTerminalWrite() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(1)).outcome == .ok)
        faults.fail(before: .rename)
        try await world.settle()
        let persistence = try #require(await world.coordinator.persistence(of: Start.runId(1)))
        #expect(!persistence.terminalDurable && !persistence.uncertain && persistence.attempts == 1 && !persistence.conflict)
        #expect(try Start.entry(world)["terminal"] == .null, "nothing applied")
        let status = try await Self.ask(world, .participantStatus, Start.read())
        #expect(status.fields["state"] == .string("exited") && status.fields["lastSequence"] == .number(3), "\(status.jsonValue)")
        let terminal = try #require(status.fields["terminal"]?.objectValue)
        #expect(terminal["type"] == .string("completed"))
        let events = try await Self.ask(world, .participantEvents, Start.events(after: 2))
        #expect(events.fields["events"] == .array([.object(terminal)]))

        // Later, on another clock reading: the retry writes the exact terminal.
        try world.virtual.advance(to: world.virtual.now + 30_000)
        #expect(try await Self.busy(world), "busy while the terminal write is unresolved")
        #expect(await Self.writesReturned(world))
        let entry = try Start.entry(world)
        #expect(entry["terminal"] == .object(["type": .string("completed"), "sequence": .number(3), "at": terminal["at"] ?? .null,
                                              "reason": .null]), "the exact terminal: \(entry)")
        #expect(entry["groupCleared"] == .bool(true))
        #expect(await world.coordinator.persistence(of: Start.runId(1))?.attempts == 2)
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
    }

    @Test("Codex Q31, a Stop retries an owed write: after a failed terminal write, a Stop of the ended run signals nothing, answers exited with the terminal from memory, and queues the retry, which writes that exact terminal; then a start is admitted")
    func stopRetriesFailedTerminalWrite() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(1)).outcome == .ok)
        let run = try #require(world.launcher.runs.first)
        faults.fail(before: .rename)
        try await world.settle()
        #expect(await world.coordinator.persistence(of: Start.runId(1))?.attempts == 1)
        #expect(try Start.entry(world)["terminal"] == .null)

        try world.virtual.advance(to: world.virtual.now + 30_000)
        let stop = try await Self.ask(world, .participantStop, Start.read())
        #expect(stop.fields["state"] == .string("exited") && stop.fields["groupCleared"] == .bool(true), "\(stop.jsonValue)")
        let terminal = try #require(stop.fields["terminal"]?.objectValue)
        #expect(terminal["type"] == .string("completed") && terminal["sequence"] == .number(3))
        #expect(run.stopCalls.isEmpty && run.system.signals.isEmpty, "an ended run is never signalled")
        #expect(await Self.writesReturned(world))
        let persistence = try #require(await world.coordinator.persistence(of: Start.runId(1)))
        #expect(persistence.terminalDurable && persistence.attempts == 2, "the Stop's retry")
        let entry = try Start.entry(world)
        #expect(entry["terminal"] == .object(["type": .string("completed"), "sequence": .number(3), "at": terminal["at"] ?? .null,
                                              "reason": .null]), "the exact terminal, its first at: \(entry)")
        #expect(entry["groupCleared"] == .bool(true))
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
    }

    @Test("Codex Q31, a restart recovers only durable evidence: after a failed terminal write, the next launch reads the run as exit-unrecorded (Stop not-owned, events lost restarted); nothing rebuilds the terminal")
    func restartReadsOnlyDurableEvidence() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(1)).outcome == .ok)
        faults.fail(before: .rename)
        try await world.settle()
        #expect(try Start.entry(world)["terminal"] == .null)

        // The next launch: a new store over the same folder, a new host and
        // identity space, a new coordinator with another launch id.
        await world.coordinator.detach()
        world.store.close()
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
        func direct(_ operation: HostOperation, _ payload: [String: JSONValue]) async throws -> HostResponse {
            let request = try HostRequest(validating: ParticipantCoordinatorReadTests.request(operation, payload, world: world),
                                          acceptsParticipant: true)
            return try await Start.answer(Task { await next.handle(request) })
        }
        let status = try await direct(.participantStatus, Start.read())
        #expect(status.fields["state"] == .string("unknown") && status.fields["unknownReason"] == .string("exit-unrecorded"), "\(status.jsonValue)")
        #expect(status.fields["lastSequence"] == .null && status.fields["terminal"] == .null)
        #expect(try await direct(.participantStop, Start.read()).fields["state"] == .string("not-owned"))
        let events = try await direct(.participantEvents, Start.events())
        #expect(events.fields["lost"]?.objectValue?["reason"] == .string("restarted") && events.fields["terminal"] == .null)
        await next.detach()
    }

    @Test("Codex Q31, uncertain terminal write (its folder flush fails): visible but never published; status answers from memory; every start is busy, and a retry while the flush still fails stays uncertain; once a flush succeeds the retry makes it durable; then a start is admitted")
    func uncertainTerminalWrite() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(1)).outcome == .ok)
        faults.undeterminedFlushes = true
        try await world.settle()
        #expect(await world.coordinator.persistence(of: Start.runId(1))?.uncertain == true)
        #expect(try Start.entry(world)["terminal"]?.objectValue?["type"] == .string("completed"), "the folder shows it")
        #expect(world.store.publishedRuns.entry(for: Start.runId(1))?.terminal == nil, "never published as durable")
        #expect(try await Self.ask(world, .participantStatus, Start.read()).fields["state"] == .string("exited"))
        #expect(try await Self.busy(world))
        #expect(await Self.writesReturned(world))
        #expect(await world.coordinator.persistence(of: Start.runId(1))?.uncertain == true, "still undetermined")
        #expect(await world.coordinator.hasUnresolvedWrites)
        faults.undeterminedFlushes = false
        #expect(try await Self.busy(world), "resolved before any replacement")
        #expect(await Self.writesReturned(world))
        #expect(await world.coordinator.hasUnresolvedWrites == false)
        #expect(world.store.publishedRuns.entry(for: Start.runId(1))?.terminal?.type == "completed")
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
    }

    @Test("Codex Q31, re-read: an uncertain terminal write that another path's folder flush made durable is resolved from the store's durable copy, with no second write")
    func rereadResolvesUncertainWrite() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(1)).outcome == .ok)
        faults.undeterminedFlushes = true
        try await world.settle()
        faults.undeterminedFlushes = false
        _ = try world.store.refreshPublishedRuns()
        let writes = world.executor.runs
        #expect(await world.coordinator.hasUnresolvedWrites, "memory has not looked yet")
        await world.coordinator.reconcileNow()
        #expect(await world.coordinator.hasUnresolvedWrites == false)
        #expect(world.executor.runs == writes, "resolved from the durable copy, not written again")
        #expect(await world.coordinator.persistence(of: Start.runId(1))?.attempts == 1)
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
    }

    @Test("Codex Q31, failed cleanup upgrade: a retry Stop that finds the group gone answers exited with groupCleared true without waiting for the upgrade's write (held in the store until after the reply is taken); that write fails definitely, the folder keeps false; starts are busy until the queued retry writes true")
    func failedCleanupUpgrade() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        let run = try await Self.started(world, mode: .survivesSigkill)
        #expect(try await Self.settled(world, .participantStop).fields["state"] == .string("cleanup-pending"))
        try await world.settle()
        #expect(try Start.entry(world)["groupCleared"] == .bool(false))

        faults.arm(.nextWrite)
        run.groupClears()
        let stop = try await Self.ask(world, .participantStop, Start.read())
        #expect(stop.fields["state"] == .string("exited") && stop.fields["groupCleared"] == .bool(true), "\(stop.jsonValue)")
        #expect(await faults.waitUntilHeld(), "the upgrade's write is held in the store, released only after the reply was taken")
        faults.fail(before: .rename)
        faults.release()
        #expect(await Self.writesReturned(world))
        #expect(try Start.entry(world)["groupCleared"] == .bool(false), "the definite failure applied nothing")
        let persistence = try #require(await world.coordinator.persistence(of: Start.runId(1)))
        #expect(persistence.terminalDurable && persistence.clearedLater && !persistence.clearedDurable)
        let status = try await Self.ask(world, .participantStatus, Start.read())
        #expect(status.fields["state"] == .string("exited") && status.fields["groupCleared"] == .bool(true), "process truth: \(status.jsonValue)")
        #expect(try await Self.busy(world))
        #expect(await Self.writesReturned(world))
        #expect(try Start.entry(world)["groupCleared"] == .bool(true))
        try await world.settle()
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
        #expect(faults.holdTimeouts == 0)
    }

    @Test("Codex Q31, uncertain cleanup upgrade (its folder flush fails): the retry Stop answers exited with groupCleared true; the folder shows true while the durable copy keeps false; starts are busy, and a retry while the flush still fails stays uncertain; once a flush succeeds, a Stop of the run (signalling nothing) queues the retry that makes it durable; then a start is admitted")
    func uncertainCleanupUpgrade() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        let run = try await Self.started(world, mode: .survivesSigkill)
        #expect(try await Self.settled(world, .participantStop).fields["state"] == .string("cleanup-pending"))
        try await world.settle()
        #expect(try Start.entry(world)["groupCleared"] == .bool(false))

        faults.undeterminedFlushes = true
        run.groupClears()
        let stop = try await Self.ask(world, .participantStop, Start.read())
        #expect(stop.fields["state"] == .string("exited") && stop.fields["groupCleared"] == .bool(true), "\(stop.jsonValue)")
        #expect(await Self.writesReturned(world))
        let uncertain = try #require(await world.coordinator.persistence(of: Start.runId(1)))
        #expect(uncertain.terminalDurable && uncertain.clearedLater && !uncertain.clearedDurable && uncertain.uncertain && !uncertain.conflict)
        #expect(try Start.entry(world)["groupCleared"] == .bool(true), "the folder shows it")
        #expect(world.store.publishedRuns.entry(for: Start.runId(1))?.groupCleared == false, "never published as durable")
        let status = try await Self.ask(world, .participantStatus, Start.read())
        #expect(status.fields["state"] == .string("exited") && status.fields["groupCleared"] == .bool(true), "process truth: \(status.jsonValue)")
        #expect(try await Self.busy(world))
        #expect(await Self.writesReturned(world))
        #expect(await world.coordinator.persistence(of: Start.runId(1))?.uncertain == true, "still undetermined")
        #expect(await world.coordinator.hasUnresolvedWrites)

        faults.undeterminedFlushes = false
        let calls = run.stopCalls.count
        let signals = run.system.signals.count
        let again = try await Self.ask(world, .participantStop, Start.read())
        #expect(again.fields == stop.fields, "\(again.jsonValue)")
        #expect(run.stopCalls.count == calls && run.system.signals.count == signals, "a cleared group is never signalled")
        #expect(await Self.writesReturned(world))
        let durable = try #require(await world.coordinator.persistence(of: Start.runId(1)))
        #expect(durable.clearedDurable && !durable.uncertain)
        #expect(world.store.publishedRuns.entry(for: Start.runId(1))?.groupCleared == true)
        #expect(await world.coordinator.hasUnresolvedWrites == false)
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
        #expect(!run.system.signalledAfterReap)
    }

    @Test("Codex Q31: a pending terminal never replaces another terminal: when the folder holds a different one, the write is refused as a conflict, not retried, the folder keeps its terminal, and starts stay busy; status and events still give the run's own terminal from memory; one text-free write-conflict log entry")
    func pendingTerminalNeverReplacesAnother() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(1)).outcome == .ok)
        faults.fail(before: .rename)
        try await world.settle()
        // Another terminal for the run reaches the folder.
        let other: JSONValue = .object(["type": .string("failed"), "sequence": .number(2), "at": .string("2026-10-09T00:01:01.200Z"),
                                        "reason": .string("process-error")])
        var state = try #require(try JSONValue.decode(world.store.plainStateForTesting()).objectValue)
        guard case .array(var runs)? = state["runs"], var entry = runs.first?.objectValue else {
            Issue.record("no runs")
            return
        }
        entry["terminal"] = other
        entry["groupCleared"] = .bool(false)
        runs[0] = .object(entry)
        state["runs"] = .array(runs)
        try JSONEncoder().encode(JSONValue.object(state)).writePlainState(to: world.store)
        _ = try world.store.rereadRuns()
        #expect(try await Self.busy(world))
        #expect(await Self.writesReturned(world))
        let persistence = try #require(await world.coordinator.persistence(of: Start.runId(1)))
        #expect(persistence.conflict && !persistence.terminalDurable && !persistence.owesWrite)
        #expect(try Start.entry(world)["terminal"] == other, "never replaced")
        let attempts = persistence.attempts
        #expect(try await Self.busy(world), "still unresolved")
        await world.coordinator.reconcileNow()
        #expect(await world.coordinator.persistence(of: Start.runId(1))?.attempts == attempts, "never retried")
        // Process truth stays the run's own terminal (Codex Q31).
        let status = try await Self.ask(world, .participantStatus, Start.read())
        let own = try #require(status.fields["terminal"]?.objectValue)
        #expect(status.fields["state"] == .string("exited") && own["type"] == .string("completed") && own["sequence"] == .number(3),
                "\(status.jsonValue)")
        let events = try await Self.ask(world, .participantEvents, Start.events(after: 2))
        #expect(events.fields["events"] == .array([.object(own)]), "\(events.jsonValue)")
        #expect(world.log.entries.filter { $0.kind == .writeConflict }.map(\.line)
                == ["run=\(Start.runId(1)) kind=write-conflict event=completed sequence=3"], "logged once, text-free")
    }

    /// Puts `terminal` with `groupCleared` into run `run`'s entry in
    /// `state.json`, the rest of the folder kept, and has the store re-read
    /// it authoritatively: another valid terminal reaching the run's folder
    /// entry (the invented-folder fault of
    /// `pendingTerminalNeverReplacesAnother`). Returns the entry as written.
    static func substitute(_ world: VectorWorld, terminal: JSONValue, groupCleared: JSONValue, run: Int = 1) throws
        -> [String: JSONValue] {
        var state = try #require(try JSONValue.decode(world.store.plainStateForTesting()).objectValue)
        guard case .array(var runs)? = state["runs"],
              let index = runs.firstIndex(where: { $0.objectValue?["runId"] == .string(Start.runId(run)) }),
              var entry = runs[index].objectValue else {
            Issue.record("no entry for run \(run)")
            return [:]
        }
        entry["terminal"] = terminal
        entry["groupCleared"] = groupCleared
        runs[index] = .object(entry)
        state["runs"] = .array(runs)
        try JSONEncoder().encode(JSONValue.object(state)).writePlainState(to: world.store)
        _ = try world.store.rereadRuns()
        #expect((world.store.publishedRuns.entry(for: Start.runId(run))?.terminal?.jsonValue ?? .null) == terminal, "re-read as written")
        return try Start.entry(world, run: run)
    }

    /// Takes run `run`'s entry out of `state.json`, with the prepare
    /// identity naming it and that identity's ledger entry and receipt (so
    /// the folder still loads), and has the store re-read it
    /// authoritatively: the run's entry gone from the folder (the same
    /// invented-folder fault).
    static func remove(_ world: VectorWorld, run: Int = 1) throws {
        var state = try #require(try JSONValue.decode(world.store.plainStateForTesting()).objectValue)
        let runId = JSONValue.string(Start.runId(run))
        guard case .array(let runs)? = state["runs"], case .array(let identities)? = state["identities"] else {
            Issue.record("no runs or identities")
            return
        }
        let named = Set(identities.filter { $0.objectValue?["runId"] == runId }.compactMap { $0.objectValue?["requestId"]?.stringValue })
        #expect(!named.isEmpty, "the run's prepare identity")
        func unnamed(_ value: JSONValue) -> Bool { !named.contains(value.objectValue?["requestId"]?.stringValue ?? "") }
        state["runs"] = .array(runs.filter { $0.objectValue?["runId"] != runId })
        state["identities"] = .array(identities.filter(unnamed))
        for key in ["ledger", "receipts"] {
            if case .array(let list)? = state[key] { state[key] = .array(list.filter(unnamed)) }
        }
        try JSONEncoder().encode(JSONValue.object(state)).writePlainState(to: world.store)
        _ = try world.store.rereadRuns()
        #expect(world.store.publishedRuns.entry(for: Start.runId(run)) == nil, "re-read with no entry")
    }

    @Test("Codex S9-R1: a pending cleanup upgrade never marks another terminal: terminal A is durable with groupCleared false and its upgrade's write failed (still owed); a different valid terminal B with false reaches the folder and is re-read; the busy start's retry names A, the store refuses it inside its lock, and the whole folder, B's entry included, stays byte-identical; one text-free write-conflict log entry, never retried by a busy start, a Stop or a reconcile; starts stay busy; status, events and Stop give the run's own terminal and cleared group from memory")
    func pendingCleanupUpgradeNeverMarksAnother() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        let run = try await Self.started(world, mode: .survivesSigkill)
        let pending = try await Self.settled(world, .participantStop)
        #expect(pending.fields["state"] == .string("cleanup-pending"), "\(pending.jsonValue)")
        try await world.settle()
        let own = try #require(pending.fields["terminal"])
        #expect(try Start.entry(world)["groupCleared"] == .bool(false))

        // The group clears; the upgrade's write fails definitely, so it is owed.
        faults.fail(before: .rename)
        run.groupClears()
        let cleared = try await Self.ask(world, .participantStop, Start.read())
        #expect(cleared.fields["state"] == .string("exited") && cleared.fields["groupCleared"] == .bool(true), "\(cleared.jsonValue)")
        #expect(await Self.writesReturned(world))
        let owed = try #require(await world.coordinator.persistence(of: Start.runId(1)))
        #expect(owed.terminalDurable && owed.clearedLater && !owed.clearedDurable && !owed.conflict && owed.owesWrite)
        #expect(try Start.entry(world)["groupCleared"] == .bool(false), "the definite failure applied nothing")

        // Terminal B, with false cleanup evidence, reaches the folder.
        let other: JSONValue = .object(["type": .string("failed"), "sequence": .number(2), "at": .string("2026-10-09T00:01:01.200Z"),
                                        "reason": .string("process-error")])
        let substituted = try Self.substitute(world, terminal: other, groupCleared: .bool(false))
        let folder = try world.folderSnapshot()

        // A busy start queues the owed retry: refused inside the store's lock.
        #expect(try await Self.busy(world))
        #expect(await Self.writesReturned(world))
        #expect(try Start.entry(world) == substituted, "B's whole entry unchanged, its groupCleared still false")
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil, "nothing in the folder changed")
        let conflict = try #require(await world.coordinator.persistence(of: Start.runId(1)))
        #expect(conflict.conflict && conflict.terminalDurable && conflict.clearedLater && !conflict.clearedDurable && !conflict.owesWrite)
        let attempts = conflict.attempts
        let conflictLog = ["run=\(Start.runId(1)) kind=write-conflict"]
        #expect(world.log.entries.filter { $0.kind == .writeConflict }.map(\.line) == conflictLog, "logged once, text-free")

        // Never retried; every start stays busy (Codex S9 ruling a: until quit).
        #expect(try await Self.busy(world), "still unresolved")
        await world.coordinator.reconcileNow()
        let calls = run.stopCalls.count
        let signals = run.system.signals.count
        let stop = try await Self.ask(world, .participantStop, Start.read())
        #expect(stop.fields["state"] == .string("exited") && stop.fields["groupCleared"] == .bool(true) && stop.fields["terminal"] == own,
                "process truth from memory: \(stop.jsonValue)")
        #expect(run.stopCalls.count == calls && run.system.signals.count == signals, "a cleared group is never signalled")
        #expect(await Self.writesReturned(world))
        #expect(try await Self.busy(world))
        #expect(await Self.writesReturned(world))
        #expect(await world.coordinator.persistence(of: Start.runId(1))?.attempts == attempts, "never retried")
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil)
        #expect(world.log.entries.filter { $0.kind == .writeConflict }.map(\.line) == conflictLog, "still once")
        #expect(await world.coordinator.hasUnresolvedWrites)

        // Status and events agree with Stop, from memory.
        let status = try await Self.ask(world, .participantStatus, Start.read())
        #expect(status.fields["state"] == .string("exited") && status.fields["groupCleared"] == .bool(true)
                && status.fields["terminal"] == own, "\(status.jsonValue)")
        let events = try await Self.ask(world, .participantEvents, Start.events())
        guard case .array(let list)? = events.fields["events"] else {
            Issue.record("events: \(events.jsonValue)")
            return
        }
        #expect(list.last == own, "the run's own terminal: \(events.jsonValue)")
        #expect(!run.system.signalledAfterReap)
    }

    @Test("Codex S9-R1, the interval after the snapshot: the cleanup upgrade's pass inspects its snapshot (terminal A, false) and is held on the executor before the store; a different valid terminal B with false is then re-read; released, the store compares A inside its lock and refuses, B's entry and the whole folder unchanged; one text-free write-conflict log entry, never retried; with cleanup released and the updates finished, starts stay busy; status, events and Stop give the run's own terminal from memory")
    func cleanupUpgradeComparesInsideTheLock() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let executor = GatedExecutor()
        let manual = try await Start.Manual(world, executor: executor)
        #expect(try await manual.send(.participantStart, Start.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        let own = manual.event(2, .failed, reason: "process-error")
        run.send(.event(manual.event(1, .started)))
        run.send(.terminal(own, groupCleared: false))
        #expect(await manual.applied(2))
        #expect(await waitUntil { !(await manual.coordinator.isWriting) })
        #expect(await manual.coordinator.persistence(of: Start.runId(1))?.terminalDurable == true)
        #expect(try Start.entry(world)["groupCleared"] == .bool(false))

        // The upgrade's pass takes its snapshot (A, false: nothing to adopt)
        // and is held on the executor, before the store's lock.
        executor.arm()
        run.send(.groupCleared)
        #expect(await manual.applied(3))
        #expect(await waitOffPool(executor.entered, seconds: 10), "the upgrade waits on the executor, after its snapshot")
        // Only now does terminal B reach the folder.
        let other: JSONValue = .object(["type": .string("stopped"), "sequence": .number(2), "at": .string("2026-10-09T00:01:01.900Z"),
                                        "reason": .string("stop-incomplete")])
        let substituted = try Self.substitute(world, terminal: other, groupCleared: .bool(false))
        let folder = try world.folderSnapshot()
        executor.release.signal()
        #expect(await waitUntil { !(await manual.coordinator.isWriting) })

        #expect(try Start.entry(world) == substituted, "B's whole entry unchanged, its groupCleared still false")
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil, "nothing in the folder changed")
        let conflict = try #require(await manual.coordinator.persistence(of: Start.runId(1)))
        #expect(conflict.conflict && conflict.terminalDurable && conflict.clearedLater && !conflict.clearedDurable && !conflict.owesWrite)
        #expect(conflict.attempts == 2, "the terminal's write, then the held upgrade")
        let conflictLog = ["run=\(Start.runId(1)) kind=write-conflict"]
        #expect(world.log.entries.filter { $0.kind == .writeConflict }.map(\.line) == conflictLog, "logged once, text-free")

        // Cleanup released and the updates finished: only the conflict
        // keeps starts busy (Codex S9 ruling a: until quit), never retried.
        run.send(.cleanupReleased)
        run.finish()
        #expect(await manual.finished())
        #expect(try await manual.busy())
        await manual.coordinator.reconcileNow()
        let stop = try await manual.ask(.participantStop, Start.read())
        #expect(stop.fields["state"] == .string("exited") && stop.fields["groupCleared"] == .bool(true)
                && stop.fields["terminal"] == own.jsonValue, "process truth from memory: \(stop.jsonValue)")
        #expect(run.stopCalls == 0, "nothing signalled")
        #expect(try await manual.busy())
        #expect(await waitUntil { !(await manual.coordinator.isWriting) })
        #expect(await manual.coordinator.persistence(of: Start.runId(1))?.attempts == 2, "never retried")
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil)
        #expect(world.log.entries.filter { $0.kind == .writeConflict }.map(\.line) == conflictLog, "still once")
        let status = try await manual.send(.participantStatus, Start.read())
        #expect(status.fields["state"] == .string("exited") && status.fields["groupCleared"] == .bool(true)
                && status.fields["terminal"] == own.jsonValue, "\(status.jsonValue)")
        let events = try await manual.send(.participantEvents, Start.events())
        #expect(events.fields["events"] == .array([manual.event(1, .started).jsonValue, own.jsonValue]), "\(events.jsonValue)")
    }

    @Test("Codex S9-R1 controls at the coordinator: after terminal A (false) is durable, the folder's entry for the run changes, then the group clears and the upgrade names A: an entry with no terminal gets A with groupCleared true in one write (the run's own facts, no other terminal replaced) and starts are admitted once cleanup is released; A with groupCleared null, or no entry at all, is refused unchanged, never recreated or retried, logged once, and starts stay busy", arguments: ["no terminal", "groupCleared null", "no entry"])
    func cleanupUpgradeMeetsAChangedEntry(_ change: String) async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let manual = try await Start.Manual(world)
        #expect(try await manual.send(.participantStart, Start.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        let own = manual.event(2, .failed, reason: "process-error")
        run.send(.event(manual.event(1, .started)))
        run.send(.terminal(own, groupCleared: false))
        #expect(await manual.applied(2))
        #expect(await waitUntil { !(await manual.coordinator.isWriting) })
        #expect(await manual.coordinator.persistence(of: Start.runId(1))?.terminalDurable == true)
        let durable = try Start.entry(world)
        let recorded = try #require(durable["terminal"])
        #expect(durable["groupCleared"] == .bool(false))

        switch change {
        case "no terminal": _ = try Self.substitute(world, terminal: .null, groupCleared: .null)
        case "groupCleared null": _ = try Self.substitute(world, terminal: recorded, groupCleared: .null)
        default: try Self.remove(world)
        }
        let folder = try world.folderSnapshot()
        let writes = world.executor.runs
        run.send(.groupCleared)
        #expect(await manual.applied(3))
        #expect(await waitUntil { !(await manual.coordinator.isWriting) })
        #expect(world.executor.runs == writes + 1, "one attempt: the upgrade naming A")
        let persistence = try #require(await manual.coordinator.persistence(of: Start.runId(1)))
        #expect(persistence.attempts == 2, "the terminal's write, then the upgrade")
        run.send(.cleanupReleased)
        run.finish()
        #expect(await manual.finished())
        let conflicts = world.log.entries.filter { $0.kind == .writeConflict }.map(\.line)

        if change == "no terminal" {
            var restored = durable
            restored["groupCleared"] = .bool(true)
            #expect(try Start.entry(world) == restored, "A with true, in one write")
            #expect(persistence.clearedDurable && !persistence.conflict && !persistence.owesWrite)
            #expect(conflicts.isEmpty)
            #expect(try await manual.send(.participantStart, Start.start(2)).outcome == .ok, "resolved: admitted")
            return
        }
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil, "refused unchanged: nothing recreated or marked")
        #expect(persistence.conflict && !persistence.clearedDurable && !persistence.owesWrite)
        #expect(conflicts == ["run=\(Start.runId(1)) kind=write-conflict"], "logged once, text-free")
        #expect(try await manual.busy(), "fails closed: busy until quit")
        await manual.coordinator.reconcileNow()
        #expect(try await manual.busy())
        #expect(await waitUntil { !(await manual.coordinator.isWriting) })
        #expect(await manual.coordinator.persistence(of: Start.runId(1))?.attempts == 2, "never retried")
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil)
        #expect(world.log.entries.filter { $0.kind == .writeConflict }.map(\.line) == conflicts, "still once")
        let stop = try await manual.ask(.participantStop, Start.read())
        #expect(stop.fields["state"] == .string("exited") && stop.fields["groupCleared"] == .bool(true)
                && stop.fields["terminal"] == own.jsonValue, "process truth from memory: \(stop.jsonValue)")
    }

    @Test("A cleanup upgrade owed with no terminal to name (a cleared group reported before any terminal, which no reader order produces) fails closed: never attempted, nothing written, one text-free write-conflict log entry; the terminal that follows is not written either, starts stay busy, and status gives it from memory")
    func cleanupUpgradeWithNoTerminalFailsClosed() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let manual = try await Start.Manual(world)
        #expect(try await manual.send(.participantStart, Start.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        run.send(.event(manual.event(1, .started)))
        #expect(await manual.applied(1))
        #expect(await waitUntil { !(await manual.coordinator.isWriting) })
        let folder = try world.folderSnapshot()
        let writes = world.executor.runs

        run.send(.groupCleared)
        #expect(await manual.applied(2))
        #expect(await waitUntil { !(await manual.coordinator.isWriting) })
        let conflictLog = ["run=\(Start.runId(1)) kind=write-conflict"]
        #expect(world.log.entries.filter { $0.kind == .writeConflict }.map(\.line) == conflictLog, "logged once, text-free")
        let persistence = try #require(await manual.coordinator.persistence(of: Start.runId(1)))
        #expect(persistence.conflict && persistence.attempts == 0 && !persistence.owesWrite && !persistence.isResolved)

        let own = manual.event(2, .completed)
        run.send(.terminal(own, groupCleared: true))
        run.send(.cleanupReleased)
        run.finish()
        #expect(await manual.finished())
        #expect(world.executor.runs == writes, "nothing attempted")
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil, "nothing written")
        #expect(try await manual.busy(), "fails closed: busy until quit")
        #expect(await waitUntil { !(await manual.coordinator.isWriting) })
        #expect(world.executor.runs == writes)
        #expect(world.log.entries.filter { $0.kind == .writeConflict }.map(\.line) == conflictLog, "still once")
        let status = try await manual.send(.participantStatus, Start.read())
        #expect(status.fields["state"] == .string("exited") && status.fields["terminal"] == own.jsonValue, "\(status.jsonValue)")
    }

    @Test("A persistence pass writes only through a stack still attached: detached while the terminal's write is in flight, the pass lets that write finish but never starts the cleanup upgrade on the stack let go; attached again, a busy start's retry writes it")
    func passNeverWritesThroughADetachedStack() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        let manual = try await Start.Manual(world)
        #expect(try await manual.send(.participantStart, Start.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        faults.arm(.nextWrite)
        run.send(.event(manual.event(1, .started)))
        run.send(.terminal(manual.event(2, .failed, reason: "process-error"), groupCleared: false))
        #expect(await faults.waitUntilHeld(), "the terminal's write holds the store")
        run.send(.groupCleared)
        #expect(await manual.applied(3), "the upgrade is owed behind the terminal's write")
        await manual.coordinator.detach()
        faults.release()
        #expect(await waitUntil { !(await manual.coordinator.isWriting) })
        let entry = try Start.entry(world)
        #expect(entry["terminal"]?.objectValue?["reason"] == .string("process-error") && entry["groupCleared"] == .bool(false),
                "nothing new on the stack let go: \(entry)")
        let owed = try #require(await manual.coordinator.persistence(of: Start.runId(1)))
        #expect(owed.terminalDurable && owed.clearedLater && !owed.clearedDurable)

        try await manual.coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        #expect(try await manual.busy())
        #expect(await waitUntil { !(await manual.coordinator.isWriting) })
        #expect(try Start.entry(world)["groupCleared"] == .bool(true))
        #expect(await manual.coordinator.persistence(of: Start.runId(1))?.clearedDurable == true)
        #expect(faults.holdTimeouts == 0)
    }

    @Test("Codex Q31, busy admission covers a never-spawned run's pending terminal (S8's spawn failure whose write failed): another run's start is busy and queues the retry; once durable it is pushed once and the start is admitted")
    func neverSpawnedPendingTerminalBlocks() async throws {
        struct InventedLaunchFailure: Error {}
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.failLaunches(with: InventedLaunchFailure())
        faults.fail(before: .rename, skipping: 1)
        #expect(try await Self.ask(world, .participantStart, Start.start(1), id: Start.id(1)).outcome == .ok)
        #expect(await world.coordinator.hasUnresolvedWrites)
        world.launcher.failLaunches(with: nil)
        #expect(try await Self.busy(world))
        #expect(await Self.writesReturned(world))
        #expect(await world.coordinator.hasUnresolvedWrites == false)
        let pushed = world.sink.take()
        #expect(pushed.count == 1 && pushed.first?.objectValue?["event"]?.objectValue?["reason"] == .string("process-error"), "\(pushed)")
        #expect(try Start.entry(world)["terminal"]?.objectValue?["sequence"] == .number(1))
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
    }

    // MARK: A busy refusal's one write exception (Codex S9 ruling b)

    /// Run 1's launch throws after its start record is durable, and its
    /// never-spawned terminal's write fails definitely: that terminal is
    /// owed (pending in memory, not on disk, nothing pushed).
    static func olderOwedTerminal(_ world: VectorWorld) async throws -> [String: [ParticipantCoordinator.OwedWrite]] {
        struct InventedLaunchFailure: Error {}
        let faults = try #require(world.faults)
        world.launcher.failLaunches(with: InventedLaunchFailure())
        faults.fail(before: .rename, skipping: 1)
        #expect(try await Self.ask(world, .participantStart, Start.start(1), id: Start.id(1)).outcome == .ok)
        #expect(await Self.writesReturned(world))
        world.launcher.failLaunches(with: nil)
        #expect(try Start.entry(world)["terminal"] == .null, "not on disk")
        #expect(world.sink.take().isEmpty, "nothing pushed before it is durable")
        let owed = await world.coordinator.owedWrites()
        #expect(owed.keys.sorted() == [Start.runId(1)] && owed[Start.runId(1)]?.count == 1
                && owed[Start.runId(1)]?.first?.neverSpawned == true && owed[Start.runId(1)]?.first?.groupCleared == nil, "\(owed)")
        return owed
    }

    /// `folder` with run `run`'s entry in `state.json` holding `terminal`
    /// and `groupCleared` (the file re-encoded), every other file as it
    /// was: an invented folder for the harness exception's checks.
    static func withRun(_ folder: [String: Data], run: Int = 1, terminal: JSONValue, groupCleared: JSONValue) throws -> [String: Data] {
        let bytes = try #require(folder["/state.json"])
        var state = try #require(try JSONValue.decode(bytes).objectValue)
        guard case .array(var runs)? = state["runs"] else { throw VectorHarnessError.mismatch("no runs") }
        let index = try #require(runs.firstIndex { $0.objectValue?["runId"] == .string(Start.runId(run)) })
        var entry = try #require(runs[index].objectValue)
        entry["terminal"] = terminal
        entry["groupCleared"] = groupCleared
        runs[index] = .object(entry)
        state["runs"] = .array(runs)
        var changed = folder
        changed["/state.json"] = try JSONEncoder().encode(JSONValue.object(state))
        return changed
    }

    /// `state.json` beyond its runs list (records, ledger, receipts and
    /// identities), and every other file in the folder.
    static func beyondRuns(_ folder: [String: Data]) throws -> (state: JSONValue, others: [String: Data]) {
        let bytes = try #require(folder["/state.json"])
        var state = try #require(try JSONValue.decode(bytes).objectValue)
        state["runs"] = nil
        var others = folder
        others["/state.json"] = nil
        return (.object(state), others)
    }

    @Test("Codex S9 ruling b: a start that reaches section 7 step 12 and is refused participant-busy may make an older run's pre-existing owed write durable, and that never-spawned terminal is pushed once; the refused start launches nothing and leaves its own entry, identity, receipts, workspace record and every other file unchanged; the harness's exception accepts exactly that change and refuses more")
    func busyRefusalMakesOlderOwedWriteDurable() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let owed = try await Self.olderOwedTerminal(world)
        let owedTerminal = try #require(owed[Start.runId(1)]?.first?.terminal)
        let folder = try world.folderSnapshot()
        let refusedEntry = try Start.entry(world, run: 2)
        let launches = world.launcher.requests.count
        let writes = world.executor.runs

        let id = Start.id(7)
        let busy = try await Self.ask(world, .participantStart, Start.start(2), id: id)
        #expect(busy.outcome == .refused && busy.reason == .participantBusy, "\(busy.jsonValue)")
        #expect(await Self.writesReturned(world))
        let after = try world.folderSnapshot()
        let pushed = world.sink.take()

        // The older run's exact owed terminal is durable, and pushed once.
        let entry = try Start.entry(world)
        #expect(entry["terminal"] == owedTerminal.jsonValue && entry["groupCleared"] == .null, "\(entry)")
        #expect(await world.coordinator.hasUnresolvedWrites == false)
        #expect(pushed.count == 1, "\(pushed)")
        let event = try #require(pushed.first?.objectValue?["event"]?.objectValue)
        #expect(event["runId"] == .string(Start.runId(1)) && event["reason"] == .string("process-error") && event["sequence"] == .number(1))
        #expect(world.executor.runs == writes + 1, "one write: the older run's owed one")

        // The refused start: nothing of its own.
        #expect(try Start.entry(world, run: 2) == refusedEntry, "its own entry unchanged")
        #expect(try Start.leavesNoIdentity(world, id), "no identity")
        #expect(world.launcher.requests.count == launches, "nothing launched")
        let (stateBefore, othersBefore) = try Self.beyondRuns(folder)
        let (stateAfter, othersAfter) = try Self.beyondRuns(after)
        #expect(VectorReplay.difference(stateAfter, stateBefore) == nil, "records, receipts and identities unchanged")
        #expect(VectorReplay.folderChange(othersBefore, othersAfter) == nil, "every other file unchanged")

        // The harness's exception accepts exactly this, and nothing more.
        #expect(VectorReplay.busyReconciliation(refusedRunId: Start.runId(2), before: folder, after: after, owed: owed, pushed: pushed) == nil)
        #expect(VectorReplay.busyReconciliation(refusedRunId: Start.runId(2), before: folder, after: after, owed: [:], pushed: []) != nil,
                "a write nothing owed")
        #expect(VectorReplay.busyReconciliation(refusedRunId: Start.runId(2), before: folder, after: after, owed: owed,
                                                pushed: pushed + pushed) != nil, "a second push to one connection")
        let changedOwn = try Self.withRun(after, run: 2, terminal: owedTerminal.jsonValue, groupCleared: .null)
        #expect(VectorReplay.busyReconciliation(refusedRunId: Start.runId(2), before: folder, after: changedOwn, owed: owed, pushed: pushed) != nil,
                "the refused run's own entry")
        // Another terminal replaced by the owed one.
        let other: JSONValue = .object(["type": .string("stopped"), "sequence": .number(1), "at": .string("2026-10-09T00:01:01.900Z"),
                                        "reason": .string("local-stop")])
        let otherBefore = try Self.withRun(folder, terminal: other, groupCleared: .null)
        #expect(VectorReplay.busyReconciliation(refusedRunId: Start.runId(2), before: otherBefore, after: after, owed: owed, pushed: []) != nil,
                "another terminal replaced")
        // A spawned run's owed upgrade moves false to true for its exact
        // terminal, and never true back to false.
        let uncleared = try Self.withRun(folder, terminal: owedTerminal.jsonValue, groupCleared: .bool(false))
        let cleared = try Self.withRun(folder, terminal: owedTerminal.jsonValue, groupCleared: .bool(true))
        let upgrade = [Start.runId(1): [ParticipantCoordinator.OwedWrite(terminal: owedTerminal, groupCleared: true, neverSpawned: false)]]
        let downgrade = [Start.runId(1): [ParticipantCoordinator.OwedWrite(terminal: owedTerminal, groupCleared: false, neverSpawned: false)]]
        #expect(VectorReplay.busyReconciliation(refusedRunId: Start.runId(2), before: uncleared, after: cleared, owed: upgrade, pushed: []) == nil,
                "the owed upgrade")
        #expect(VectorReplay.busyReconciliation(refusedRunId: Start.runId(2), before: cleared, after: uncleared, owed: downgrade, pushed: []) != nil,
                "true back to false")
        // Codex S9-N1: an unchanged folder whose entry holds the owed
        // never-spawned terminal with non-null cleanup does not hold it as
        // the store does, so its push is refused.
        for cleanup in [JSONValue.bool(false), .bool(true)] {
            let held = try Self.withRun(folder, terminal: owedTerminal.jsonValue, groupCleared: cleanup)
            #expect(VectorReplay.busyReconciliation(refusedRunId: Start.runId(2), before: held, after: held, owed: owed, pushed: pushed) != nil,
                    "a push for the owed terminal with groupCleared \(cleanup)")
        }
        // Nothing owed made durable: state.json keeps its exact bytes, so
        // the same values in other bytes are refused.
        #expect(VectorReplay.busyReconciliation(refusedRunId: Start.runId(2), before: folder, after: folder, owed: owed, pushed: []) == nil)
        let bytes = try #require(folder["/state.json"])
        let pretty = JSONEncoder()
        pretty.outputFormatting = [.prettyPrinted]
        let prettyBytes = try pretty.encode(try JSONValue.decode(bytes))
        var rewritten = folder
        rewritten["/state.json"] = prettyBytes
        #expect(prettyBytes != bytes, "other bytes")
        #expect(VectorReplay.difference(try JSONValue.decode(prettyBytes), try JSONValue.decode(bytes)) == nil, "the same values")
        #expect(VectorReplay.busyReconciliation(refusedRunId: Start.runId(2), before: folder, after: rewritten, owed: owed, pushed: []) != nil,
                "state.json rewritten with nothing owed made durable")

        // Once: nothing is owed now, so the next start is admitted and pushes no second copy.
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(2)).outcome == .ok)
        try await world.settle()
        #expect(world.sink.take().allSatisfy { $0.objectValue?["event"]?.objectValue?["runId"] != .string(Start.runId(1)) }, "pushed once")
    }

    @Test("Codex S9 ruling b, control: a start refused before section 7 step 12 (step 2's unknown field, step 6's unknown run, step 7's duplicate run, step 9's run mismatch) while an older run's write is owed queues nothing: no executor use, no write, no push, no identity, no launch, and the write stays owed until a step-12 refusal queues it")
    func earlierRefusalQueuesNothing() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let owed = try await Self.olderOwedTerminal(world)
        let folder = try world.folderSnapshot()
        let launches = world.launcher.requests.count
        let writes = world.executor.runs
        var unknownRun = Start.start(2)
        unknownRun["runId"] = .string(Start.runId(9))
        var extra = Start.start(2)
        extra["extra"] = .number(1)
        var mismatch = Start.start(2)
        mismatch["sessionId"] = .string(Start.sessionId(9))
        let refusals: [(payload: [String: JSONValue], reason: HostRefusal, label: String)] = [
            (extra, .unknownField, "step 2"), (unknownRun, .unknownRun, "step 6"), (Start.start(1), .duplicateRun, "step 7, the owed run itself"),
            (mismatch, .runMismatch, "step 9")
        ]
        for (index, refusal) in refusals.enumerated() {
            let id = Start.id(20 + index)
            let reply = try await Self.ask(world, .participantStart, refusal.payload, id: id)
            #expect(reply.outcome == .refused && reply.reason == refusal.reason, "\(refusal.label): \(reply.jsonValue)")
            #expect(try Start.leavesNoIdentity(world, id), "\(refusal.label) left no identity")
        }
        #expect(!(await world.coordinator.isWriting), "nothing queued")
        #expect(world.executor.runs == writes, "no refusal used the executor")
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil, "no refusal wrote")
        #expect(world.sink.take().isEmpty, "no refusal pushed")
        #expect(world.launcher.requests.count == launches, "no refusal launched")
        #expect(await world.coordinator.owedWrites() == owed, "still owed, as it was")

        // A step-12 refusal queues it.
        #expect(try await Self.busy(world))
        #expect(await Self.writesReturned(world))
        #expect(await world.coordinator.hasUnresolvedWrites == false)
        #expect(world.sink.take().count == 1)
    }

    // MARK: A pending never-spawned terminal meets another (Codex S9 ruling a)

    /// Another valid terminal for run 1 with nothing spawned: `stopped`
    /// `local-stop` at sequence 1, at another time than any this launch
    /// writes (an invented folder's).
    static let otherUnspawned: JSONValue = .object(["type": .string("stopped"), "sequence": .number(1),
                                                    "at": .string("2026-10-09T00:01:01.900Z"), "reason": .string("local-stop")])

    /// After run 1's pending never-spawned terminal failed closed: the one
    /// text-free `conflictLog` line, the whole folder as `folder` (nothing
    /// replaced or recreated), `writes` executor uses and nothing pushed;
    /// then busy starts, Stops and a reconcile never retry it, every start
    /// stays busy, and status, events and Stop answer the run's own pending
    /// terminal from memory (`start-uncertain` at 0, nothing emitted, Stop
    /// `unknown`), never the folder's.
    static func failsClosed(_ world: VectorWorld, folder: [String: Data], writes: Int, conflictLog: [String],
                            sourceLocation: SourceLocation = #_sourceLocation) async throws {
        func conflicts() -> [String] { world.log.entries.filter { $0.kind == .writeConflict }.map(\.line) }
        #expect(conflicts() == conflictLog, "logged once, text-free", sourceLocation: sourceLocation)
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil, "nothing written, replaced or recreated",
                sourceLocation: sourceLocation)
        #expect(world.executor.runs == writes, sourceLocation: sourceLocation)
        #expect(world.sink.take().isEmpty, "nothing pushed", sourceLocation: sourceLocation)
        #expect(await world.coordinator.owedWrites().isEmpty, "a conflict owes nothing it would write", sourceLocation: sourceLocation)
        #expect(await world.coordinator.hasUnresolvedWrites, "still unresolved", sourceLocation: sourceLocation)

        // Never retried; every start stays busy (until the app quits).
        for _ in 0..<2 {
            #expect(try await Self.busy(world), "busy", sourceLocation: sourceLocation)
            #expect(await Self.writesReturned(world), sourceLocation: sourceLocation)
            let stop = try await Self.ask(world, .participantStop, Start.read())
            #expect(stop.outcome == .unknown && stop.fields.isEmpty, "from memory, never the folder's terminal: \(stop.jsonValue)",
                    sourceLocation: sourceLocation)
        }
        let reconciled = Task { () -> Bool in
            await world.coordinator.reconcileNow()
            return true
        }
        #expect(await value(of: reconciled) == true, "reconciled within \(vectorWaitSeconds) s", sourceLocation: sourceLocation)
        #expect(world.executor.runs == writes, "never retried", sourceLocation: sourceLocation)

        // Status and events agree with Stop, from memory.
        let status = try await Self.ask(world, .participantStatus, Start.read())
        #expect(status.outcome == .ok && status.fields["state"] == .string("unknown")
                && status.fields["unknownReason"] == .string("start-uncertain") && status.fields["lastSequence"] == .number(0)
                && status.fields["terminal"] == .null && status.fields["groupCleared"] == .null, "\(status.jsonValue)",
                sourceLocation: sourceLocation)
        let events = try await Self.ask(world, .participantEvents, Start.events())
        #expect(events.outcome == .ok && events.fields["events"] == .array([]) && events.fields["lastSequence"] == .number(0)
                && events.fields["terminal"] == .null && events.fields["lost"] == .null, "\(events.jsonValue)", sourceLocation: sourceLocation)
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil, sourceLocation: sourceLocation)
        #expect(world.sink.take().isEmpty, sourceLocation: sourceLocation)
        #expect(conflicts() == conflictLog, "still once", sourceLocation: sourceLocation)
        #expect(await world.coordinator.hasUnresolvedWrites, sourceLocation: sourceLocation)
    }

    @Test("Codex S9 ruling a, never spawned, a write: run 1's launch threw after its start record was durable and its failed process-error write failed, so that exact terminal is pending; another valid terminal then reaches the run's folder entry and is re-read. The busy start's retry meets it inside the store's lock: refused, that entry and the whole folder unchanged, one text-free write-conflict log entry; never retried by busy starts, Stops or a reconcile; every start stays busy; status, events and Stop answer the run's own pending terminal from memory, never the other")
    func neverSpawnedTerminalMeetsAnother() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let owed = try await Self.olderOwedTerminal(world)
        let own = try #require(owed[Start.runId(1)]?.first?.terminal)
        let substituted = try Self.substitute(world, terminal: Self.otherUnspawned, groupCleared: .null)
        let folder = try world.folderSnapshot()
        let writes = world.executor.runs
        #expect(world.log.entries.allSatisfy { $0.kind != .writeConflict }, "nothing has met it yet")

        // A busy start queues the owed retry; the store refuses it inside its lock.
        #expect(try await Self.busy(world))
        #expect(await Self.writesReturned(world))
        #expect(world.executor.runs == writes + 1, "one attempt: the retry")
        #expect(try Start.entry(world) == substituted, "the other terminal's whole entry unchanged")
        try await Self.failsClosed(world, folder: folder, writes: writes + 1,
                                   conflictLog: ["run=\(Start.runId(1)) kind=write-conflict event=\(own.type) sequence=\(own.sequence)"])
    }

    @Test("Codex S9 ruling a, never spawned, a read: with run 1's never-spawned terminal pending, another valid terminal reaches its folder entry and is re-read; the first status, events or Stop that reads it fails the run closed with no write (never dropping the pending terminal or pushing either one): one text-free write-conflict log entry, the whole folder unchanged; that read and every later one answer the run's own pending terminal from memory; never retried; every start stays busy", arguments: [HostOperation.participantStatus, .participantEvents, .participantStop])
    func neverSpawnedReadFindsAnother(_ reader: HostOperation) async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let owed = try await Self.olderOwedTerminal(world)
        let own = try #require(owed[Start.runId(1)]?.first?.terminal)
        _ = try Self.substitute(world, terminal: Self.otherUnspawned, groupCleared: .null)
        let folder = try world.folderSnapshot()
        let writes = world.executor.runs

        let first = try await Self.ask(world, reader, reader == .participantEvents ? Start.events() : Start.read())
        switch reader {
        case .participantStatus:
            #expect(first.fields["unknownReason"] == .string("start-uncertain") && first.fields["terminal"] == .null, "\(first.jsonValue)")
        case .participantEvents:
            #expect(first.outcome == .ok && first.fields["events"] == .array([]) && first.fields["terminal"] == .null, "\(first.jsonValue)")
        default:
            #expect(first.outcome == .unknown && first.fields.isEmpty, "\(first.jsonValue)")
        }
        #expect(world.executor.runs == writes, "the read wrote nothing")
        try await Self.failsClosed(world, folder: folder, writes: writes,
                                   conflictLog: ["run=\(Start.runId(1)) kind=write-conflict event=\(own.type) sequence=\(own.sequence)"])
    }

    @Test("Codex S9 ruling a, never spawned, no entry: with run 1's never-spawned terminal pending, its entry leaves the folder and is re-read; status and events answer that pending terminal from memory (never unknown-run) and log nothing; the retry a busy start or a Stop then makes meets no entry inside the store's lock: nothing recreated, the whole folder unchanged, one text-free write-conflict log entry; never retried again; every start stays busy", arguments: ["busy start", "Stop"])
    func neverSpawnedTerminalMeetsNoEntry(_ trigger: String) async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let owed = try await Self.olderOwedTerminal(world)
        let own = try #require(owed[Start.runId(1)]?.first?.terminal)
        try Self.remove(world)
        let folder = try world.folderSnapshot()
        let writes = world.executor.runs

        // Before any retry: from memory, not unknown-run.
        let status = try await Self.ask(world, .participantStatus, Start.read())
        #expect(status.outcome == .ok && status.fields["unknownReason"] == .string("start-uncertain"), "\(status.jsonValue)")
        let events = try await Self.ask(world, .participantEvents, Start.events())
        #expect(events.outcome == .ok && events.fields["events"] == .array([]), "\(events.jsonValue)")
        #expect(world.log.entries.allSatisfy { $0.kind != .writeConflict } && world.executor.runs == writes, "a read neither writes nor logs")

        if trigger == "busy start" {
            #expect(try await Self.busy(world))
        } else {
            let stop = try await Self.ask(world, .participantStop, Start.read())
            #expect(stop.outcome == .unknown && stop.fields.isEmpty, "\(stop.jsonValue)")
        }
        #expect(await Self.writesReturned(world))
        #expect(world.executor.runs == writes + 1, "one attempt: the retry")
        try await Self.failsClosed(world, folder: folder, writes: writes + 1,
                                   conflictLog: ["run=\(Start.runId(1)) kind=write-conflict event=\(own.type) sequence=\(own.sequence)"])
    }

    @Test("Codex S9 ruling a, never dispatched (the one change to Codex Q28/Q29's cancellation): a never-dispatched Stop's undetermined write leaves its stopped local-stop pending; another valid stopped local-stop for the run then reaches the folder and is re-read. Whether a busy start's retry or a status read meets it first, the pending cancellation fails closed instead of being retried for ever (a write) or dropped with no log (a read): one text-free write-conflict log entry, the whole folder unchanged, never retried, every start busy, the run's own pending terminal answered from memory", arguments: ["busy start", "status"])
    func neverDispatchedPendingMeetsAnother(_ trigger: String) async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        faults.undeterminedFlushes = true
        let first = try await Self.ask(world, .participantStop, Start.read())
        #expect(first.outcome == .unknown, "\(first.jsonValue)")
        faults.undeterminedFlushes = false
        #expect(try Start.entry(world)["terminal"]?.objectValue?["type"] == .string("stopped"), "visible, not durable")
        #expect(await world.coordinator.owedWrites()[Start.runId(1)]?.first?.neverSpawned == true, "pending")
        let substituted = try Self.substitute(world, terminal: Self.otherUnspawned, groupCleared: .null)
        let folder = try world.folderSnapshot()
        let writes = world.executor.runs

        if trigger == "busy start" {
            #expect(try await Self.busy(world))
            #expect(await Self.writesReturned(world))
            #expect(world.executor.runs == writes + 1, "one attempt: the retry")
        } else {
            let status = try await Self.ask(world, .participantStatus, Start.read())
            #expect(status.fields["unknownReason"] == .string("start-uncertain"), "never the other terminal: \(status.jsonValue)")
            #expect(world.executor.runs == writes, "the read wrote nothing")
        }
        #expect(try Start.entry(world) == substituted)
        try await Self.failsClosed(world, folder: folder, writes: world.executor.runs,
                                   conflictLog: ["run=\(Start.runId(1)) kind=write-conflict event=stopped sequence=1"])
        #expect(try await Self.ask(world, .participantStart, Start.start(1)).reason == .runNotPrepared, "its own start: the folder's terminal")
    }

    @Test("Codex Q28/Q29 unchanged: a never-dispatched Stop's first attempt, with nothing pending, whose write meets another terminal (re-read while the write is held on the executor) answers unknown and keeps nothing: no write-conflict log entry, nothing owed or unresolved, the folder's terminal answered by status")
    func neverDispatchedFirstAttemptMeetsAnother() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let executor = GatedExecutor()
        let manual = try await Start.Manual(world, executor: executor)
        executor.arm()
        let stop = Task { try? await manual.send(.participantStop, Start.read()) }
        #expect(await waitOffPool(executor.entered, seconds: 10), "the cancellation's write waits on the executor")
        let substituted = try Self.substitute(world, terminal: Self.otherUnspawned, groupCleared: .null)
        executor.release.signal()
        let reply = try #require(await value(of: stop) ?? nil, "answered within \(vectorWaitSeconds) s")
        #expect(reply.outcome == .unknown && reply.fields.isEmpty, "\(reply.jsonValue)")
        #expect(await waitUntil { !(await manual.coordinator.isWriting) })
        #expect(try Start.entry(world) == substituted, "never replaced")
        #expect(world.log.entries.allSatisfy { $0.kind != .writeConflict }, "nothing was pending, so nothing fails closed")
        #expect(await manual.coordinator.hasUnresolvedWrites == false)
        #expect(await manual.coordinator.owedWrites().isEmpty)
        let status = try await manual.ask(.participantStatus, Start.read())
        let terminal = try #require(status.fields["terminal"]?.objectValue)
        #expect(status.fields["state"] == .string("exited") && terminal["at"] == Self.otherUnspawned.objectValue?["at"]
                && terminal["type"] == .string("stopped"), "\(status.jsonValue)")
        #expect(world.sink.take().isEmpty)
    }

    @Test("Codex S9 ruling a, never spawned, before its first write returns: run 1's start record is durable and its never-spawned failed process-error write (a launch that threw, or a re-read that found the record) is held on the executor before the store; another valid terminal then reaches the run's folder entry, or the entry leaves the folder, and is re-read. Meanwhile status and events answer that terminal from memory (start-uncertain at 0, nothing emitted), never the other terminal or unknown-run; a Stop joins the held write instead of answering from the folder; a start is busy and queues nothing; nothing is logged yet. Released, the write meets it inside the store's lock and fails closed: the Stop answers unknown, nothing is written, recreated or pushed, one text-free write-conflict log entry, never retried, every start busy, and the same answers from memory follow, so no read changes its answer", arguments: ["launch threw", "re-read found the record"], ["another terminal", "no entry"])
    func neverSpawnedFirstWriteHeld(_ path: String, _ fault: String) async throws {
        struct InventedLaunchFailure: Error {}
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        let trigger: Task<HostResponse, Never>
        if path == "launch threw" {
            world.launcher.failLaunches(with: InventedLaunchFailure())
            // The start record passes; the terminal's write waits.
            world.executor.holdNext(skipping: 1)
            trigger = Start.sending(world, .participantStart, Start.start(1), id: Start.id(1))
        } else {
            faults.undeterminedFlushes = true
            let start = try await Self.ask(world, .participantStart, Start.start(1), id: Start.id(1))
            #expect(start.outcome == .unknown, "\(start.jsonValue)")
            faults.undeterminedFlushes = false
            // A status re-reads, which finds the record; the terminal's write waits.
            world.executor.holdNext(skipping: 1)
            trigger = Start.sending(world, .participantStatus, Start.read())
        }
        #expect(await waitOffPool(world.executor.held, seconds: vectorWaitSeconds), "the terminal's write waits on the executor")
        world.launcher.failLaunches(with: nil)
        let before = try Start.entry(world)
        #expect(before["start"] != .null && before["terminal"] == .null, "the start record is durable, no terminal: \(before)")
        #expect(world.launcher.requests.count == (path == "launch threw" ? 1 : 0))
        if fault == "another terminal" {
            _ = try Self.substitute(world, terminal: Self.otherUnspawned, groupCleared: .null)
        } else {
            try Self.remove(world)
        }
        let folder = try world.folderSnapshot()
        let writes = world.executor.runs

        // Before the write returns: from memory, never the folder's.
        let status = try await Self.ask(world, .participantStatus, Start.read())
        #expect(status.outcome == .ok && status.fields["state"] == .string("unknown")
                && status.fields["unknownReason"] == .string("start-uncertain") && status.fields["lastSequence"] == .number(0)
                && status.fields["terminal"] == .null && status.fields["groupCleared"] == .null, "\(status.jsonValue)")
        let events = try await Self.ask(world, .participantEvents, Start.events())
        #expect(events.outcome == .ok && events.fields["events"] == .array([]) && events.fields["lastSequence"] == .number(0)
                && events.fields["terminal"] == .null, "\(events.jsonValue)")
        let stop = Start.sending(world, .participantStop, Start.read())
        #expect(await value(of: stop, within: 1) == nil, "the Stop joins the held write; it never answers from the folder")
        #expect(try await Self.busy(world))
        #expect(world.executor.runs == writes, "nothing queued or written meanwhile")
        #expect(world.log.entries.allSatisfy { $0.kind != .writeConflict }, "nothing has met it yet")
        #expect(world.sink.take().isEmpty)

        world.executor.releaseHeld()
        let triggered = try await Start.answer(trigger)
        if path == "launch threw" {
            #expect(triggered.outcome == .ok, "\(triggered.jsonValue)")
        } else {
            #expect(triggered.fields["unknownReason"] == .string("start-uncertain"), "\(triggered.jsonValue)")
        }
        let stopped = try await Start.answer(stop)
        #expect(stopped.outcome == .unknown && stopped.fields.isEmpty, "the joined write's answer: \(stopped.jsonValue)")
        #expect(await Self.writesReturned(world))
        #expect(world.executor.holdTimeouts == 0)
        if fault == "another terminal" {
            #expect(try Start.entry(world)["terminal"] == Self.otherUnspawned, "never replaced")
        }
        try await Self.failsClosed(world, folder: folder, writes: writes,
                                   conflictLog: ["run=\(Start.runId(1)) kind=write-conflict event=failed sequence=1"])
    }

    @Test("Codex S9 ruling a, never spawned, its own terminal with another groupCleared: with run 1's never-spawned failed process-error pending, that exact terminal reaches its folder entry with groupCleared false (an invented folder) and is re-read. The store refuses the write's null there as a conflict, so a read does too: whether a busy start's retry or a status read meets it first, the run fails closed the same way, never settled as durable or pushed: one text-free write-conflict log entry, the whole folder unchanged, never retried, every start busy, the run's own pending terminal answered from memory", arguments: ["busy start", "status"])
    func neverSpawnedOwnTerminalWithGroupCleared(_ trigger: String) async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let owed = try await Self.olderOwedTerminal(world)
        let own = try #require(owed[Start.runId(1)]?.first?.terminal)
        let substituted = try Self.substitute(world, terminal: own.jsonValue, groupCleared: .bool(false))
        let folder = try world.folderSnapshot()
        let writes = world.executor.runs

        if trigger == "busy start" {
            #expect(try await Self.busy(world))
            #expect(await Self.writesReturned(world))
            #expect(world.executor.runs == writes + 1, "one attempt: the retry")
        } else {
            let status = try await Self.ask(world, .participantStatus, Start.read())
            #expect(status.fields["unknownReason"] == .string("start-uncertain"), "never settled from the folder: \(status.jsonValue)")
            #expect(world.executor.runs == writes, "the read wrote nothing")
        }
        #expect(try Start.entry(world) == substituted)
        try await Self.failsClosed(world, folder: folder, writes: world.executor.runs,
                                   conflictLog: ["run=\(Start.runId(1)) kind=write-conflict event=\(own.type) sequence=\(own.sequence)"])
    }

    @Test("Codex S9 ruling a, never dispatched, no entry (named for Codex's re-review: a change to Codex Q28/Q29 beside the silent drop): a never-dispatched Stop's undetermined write leaves its stopped local-stop pending; the run's entry then leaves the folder and is re-read. Status and events answer that pending terminal from memory (before: unknown-run) and log nothing; the retry a busy start or a Stop then makes (before: every busy start retried it, logging nothing, and a Stop refused unknown-run with no retry) meets no entry inside the store's lock: nothing recreated, the whole folder unchanged, one text-free write-conflict log entry; never retried again; every start stays busy", arguments: ["busy start", "Stop"])
    func neverDispatchedPendingMeetsNoEntry(_ trigger: String) async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        faults.undeterminedFlushes = true
        let first = try await Self.ask(world, .participantStop, Start.read())
        #expect(first.outcome == .unknown, "\(first.jsonValue)")
        faults.undeterminedFlushes = false
        #expect(await world.coordinator.owedWrites()[Start.runId(1)]?.first?.neverSpawned == true, "pending")
        try Self.remove(world)
        let folder = try world.folderSnapshot()
        let writes = world.executor.runs

        // Before any retry: from memory, not unknown-run.
        let status = try await Self.ask(world, .participantStatus, Start.read())
        #expect(status.outcome == .ok && status.fields["unknownReason"] == .string("start-uncertain"), "\(status.jsonValue)")
        let events = try await Self.ask(world, .participantEvents, Start.events())
        #expect(events.outcome == .ok && events.fields["events"] == .array([]), "\(events.jsonValue)")
        #expect(world.log.entries.allSatisfy { $0.kind != .writeConflict } && world.executor.runs == writes, "a read neither writes nor logs")

        if trigger == "busy start" {
            #expect(try await Self.busy(world))
        } else {
            let stop = try await Self.ask(world, .participantStop, Start.read())
            #expect(stop.outcome == .unknown && stop.fields.isEmpty, "\(stop.jsonValue)")
        }
        #expect(await Self.writesReturned(world))
        #expect(world.executor.runs == writes + 1, "one attempt: the retry")
        try await Self.failsClosed(world, folder: folder, writes: writes + 1,
                                   conflictLog: ["run=\(Start.runId(1)) kind=write-conflict event=stopped sequence=1"])
    }

    // MARK: Unreadable store (S7 obligation)

    @Test("S7 obligation: with the store unreadable, status, Stop and events agree from run memory: a spawned run's terminal, a never-spawned run's durable terminal; a run with no run memory, retained events alone included, is store-unreadable for status and unknown for Stop and events")
    func unreadableStoreAgreesFromMemory() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        world.launcher.prepare(script: Start.script)
        #expect(try await Self.ask(world, .participantStart, Start.start(1)).outcome == .ok)
        try await world.settle()
        let cancelled = try await Self.ask(world, .participantStop, Start.read(2))
        #expect(cancelled.fields["state"] == .string("exited"), "\(cancelled.jsonValue)")
        #expect(await Self.writesReturned(world))
        let ended = try await Self.ask(world, .participantStatus, Start.read(1))

        try Data("{invented damaged state".utf8).writePlainState(to: world.store)
        _ = try? world.store.rereadRuns()
        #expect(world.store.publishedRuns.status == .corrupt)

        // The spawned run.
        let status = try await Self.ask(world, .participantStatus, Start.read(1))
        #expect(status.fields == ended.fields, "\(status.jsonValue)")
        let stop = try await Self.ask(world, .participantStop, Start.read(1))
        #expect(stop.fields["state"] == .string("exited") && stop.fields["terminal"] == status.fields["terminal"])
        let events = try await Self.ask(world, .participantEvents, Start.events(1))
        guard case .array(let list)? = events.fields["events"] else {
            Issue.record("events: \(events.jsonValue)")
            return
        }
        #expect(list.count == 3 && list.last == status.fields["terminal"] && events.fields["lastSequence"] == .number(3))

        // The never-spawned run whose terminal is durable.
        let otherStatus = try await Self.ask(world, .participantStatus, Start.read(2))
        #expect(otherStatus.fields["state"] == .string("exited") && otherStatus.fields["lastSequence"] == .number(1)
                && otherStatus.fields["groupCleared"] == .null && otherStatus.fields["terminal"] == cancelled.fields["terminal"],
                "\(otherStatus.jsonValue)")
        let otherStop = try await Self.ask(world, .participantStop, Start.read(2))
        #expect(otherStop.fields == cancelled.fields, "\(otherStop.jsonValue)")
        let otherEvents = try await Self.ask(world, .participantEvents, Start.events(2))
        #expect(otherEvents.fields["events"] == .array([try #require(cancelled.fields["terminal"])]), "\(otherEvents.jsonValue)")

        // No run memory at all.
        let unknownRun = "71abcdef-0000-4000-8abc-000000000009"
        let payload: [String: JSONValue] = ["workspaceHandle": .string(Start.handle), "runId": .string(unknownRun),
                                            "sessionId": .string("52abcdef-0000-4000-8abc-000000000009")]
        let none = try await Self.ask(world, .participantStatus, payload)
        #expect(none.fields["state"] == .string("unknown") && none.fields["unknownReason"] == .string("store-unreadable"))
        #expect(try await Self.ask(world, .participantStop, payload).outcome == .unknown)
        var eventsPayload = payload
        eventsPayload["afterSequence"] = .number(0)
        eventsPayload["maxEvents"] = .number(64)
        #expect(try await Self.ask(world, .participantEvents, eventsPayload).outcome == .unknown)

        // Retained events alone, with no run memory beside them (the case S7
        // flagged): they never answer, so the three still agree.
        let started = ParticipantEvent(runId: unknownRun, sessionId: "52abcdef-0000-4000-8abc-000000000009", sequence: 1,
                                       at: "2026-10-09T00:01:01.000Z", type: .started)
        try await world.coordinator.seedRetained(runId: unknownRun, sessionId: "52abcdef-0000-4000-8abc-000000000009",
                                                 events: [started], lastSequence: 1, lost: nil)
        #expect(await world.coordinator.retainedRun?.runId == unknownRun)
        let retainedStatus = try await Self.ask(world, .participantStatus, payload)
        #expect(retainedStatus.fields["state"] == .string("unknown") && retainedStatus.fields["unknownReason"] == .string("store-unreadable"),
                "\(retainedStatus.jsonValue)")
        #expect(try await Self.ask(world, .participantStop, payload).outcome == .unknown)
        #expect(try await Self.ask(world, .participantEvents, eventsPayload).outcome == .unknown)
    }
}
