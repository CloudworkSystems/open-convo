import AppKit
@testable import DeskHost
@testable import DeskHostWebKit
@testable import DeskWindowKit
import Foundation
@testable import ParticipantCoordinator
@testable import ParticipantProcess
import XCTest

/// The real coordinator as the app would wire it (plan S11's follow-through,
/// Codex's S10 carried requirements 1, 4 and 5), with the invented one-page
/// Desk or none: it builds the host it attaches, it is the Desk session's
/// one lane across stacks, a lock seen anywhere from an unlock's owner check
/// through the host's and the lane's unlock keeps it locked, a push
/// already under way when its lock or close step runs on the main thread
/// returns without that thread, its lifecycle epoch moves on every lock and
/// shutdown begin (the WebKit transport's stale-answer check), and a quit
/// with nothing owed takes the plain bound. Runs are scripted on the
/// virtual clock or none; nothing runs the real CLI. Inactive in the app:
/// nothing there constructs a coordinator. Every session, host and
/// termination step is bounded (`bounded`).
final class CoordinatorAppWiringTests: CoordinatorDeskTestCase {
    typealias Start = ParticipantCoordinatorStartTests

    private func operations(_ reply: HostResponse) -> [String] {
        guard case .array(let list)? = reply.fields["capabilities"]?.objectValue?["operations"] else { return [] }
        return list.compactMap(\.stringValue)
    }

    /// A session over the invented Desk whose one lane is `coordinator`,
    /// opened (owner verified) with its page holding its connection.
    private func openSession(_ folder: InventedDeskFolder, coordinator: ParticipantCoordinator, lines: DeskLines = DeskLines(),
                             made: @escaping @MainActor () -> Void = {}) async throws -> DeskSession {
        let session = DeskSession(paths: folder.paths, bundle: try folder.fixtureBundle(), info: CoordinatorDesk.info, log: lines.log,
                                  makeParticipantLane: { made(); return coordinator })
        try await bounded("the first unlock") { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        XCTAssertEqual(session.state, .open)
        _ = try await pageConnection(session)
        return session
    }

    /// The invented page's connection, once it committed holding it.
    private func pageConnection(_ session: DeskSession) async throws -> HostConnection {
        try await eventually("the invented page to commit holding the current connection") {
            guard let host = session.host else { return false }
            return !host.webView.isLoading && host.currentConnection != nil && host.documentConnection == host.currentConnection
        }
        return try XCTUnwrap(session.host?.currentConnection)
    }

    // MARK: Requirement 1: the coordinator builds the host it attaches

    func testTheCoordinatorBuildsTheParticipantHostItAttaches() async throws {
        let folder = try InventedDeskFolder()
        defer { folder.clean() }
        let coordinator = CoordinatorDesk.coordinator(world: CoordinatorDesk.world(), launcher: ManualLauncher())
        let store = try ProofStore(directory: folder.root.appendingPathComponent("proof", isDirectory: true), keys: InventedInMemoryKeyProvider())
        defer { store.close() }
        let connections = ConnectionRegistry()
        let sink = WebKitHostEventSink()
        let host = coordinator.makeHost(store: store, connections: connections, drafts: DraftBindingRegistry(), info: CoordinatorDesk.info,
                                        events: sink)
        XCTAssertTrue(host.acceptsParticipant)
        XCTAssertTrue(host.isParticipantHost(store: store, connections: connections, configuration: coordinator.configuration.hostConfiguration),
                      "built with the coordinator's own configuration: its pin, input bound and identity space")
        XCTAssertFalse(host.isParticipantHost(store: store, connections: connections,
                                              configuration: ParticipantHostConfiguration(pin: CoordinatorDesk.pin)),
                       "a configuration built separately has its own identity space")
        let connection = await host.issueConnection()
        let capabilities = await host.handle(CoordinatorDesk.request(.capabilities, [:], on: connection))
        XCTAssertEqual(operations(capabilities), HostOperation.participantAdvertised.map(\.rawValue))
        XCTAssertEqual(operations(capabilities).count, 12)

        try await coordinator.attach(host: host, store: store, connections: connections, sink: sink)
        let availability = await coordinator.handle(CoordinatorDesk.request(.participantAvailability, [:], on: connection))
        XCTAssertEqual(availability.outcome, .ok, "\(availability.jsonValue)")
        guard case .array(let participants)? = availability.fields["participants"] else { return XCTFail("\(availability.jsonValue)") }
        XCTAssertEqual(participants.first?.objectValue?["model"], .string(CoordinatorDesk.pin.model))
        XCTAssertEqual(participants.first?.objectValue?["available"], .bool(true))

        // A host it did not build over that configuration is refused.
        await coordinator.detach()
        let separate = DeskHostProtocol(store: store, connections: connections, drafts: DraftBindingRegistry(), info: CoordinatorDesk.info,
                                        events: sink, participants: ParticipantHostConfiguration(pin: CoordinatorDesk.pin))
        do {
            try await coordinator.attach(host: separate, store: store, connections: connections, sink: sink)
            XCTFail("attached a host with another identity space")
        } catch {
            XCTAssertEqual(error as? ParticipantCoordinator.AttachError, .differentHost)
        }
        try await coordinator.attach(host: host, store: store, connections: connections, sink: sink)
        await coordinator.detach()
    }

    func testTheDeskSessionCarriesTheRealCoordinatorAcrossItsStacks() async throws {
        let folder = try InventedDeskFolder()
        defer { folder.clean() }
        let coordinator = CoordinatorDesk.coordinator(world: CoordinatorDesk.world(), launcher: ManualLauncher())
        var made = 0
        let session = try await openSession(folder, coordinator: coordinator, made: { made += 1 })
        XCTAssertTrue((session.participantLane as? ParticipantCoordinator) === coordinator)
        let host = try XCTUnwrap(session.host)
        XCTAssertTrue((host.participantLane as? ParticipantCoordinator) === coordinator, "the stack's host carries the same lane")
        let first = try await pageConnection(session)
        let capabilities = await host.hostProtocol.handle(CoordinatorDesk.request(.capabilities, [:], on: first))
        XCTAssertEqual(operations(capabilities), HostOperation.participantAdvertised.map(\.rawValue), "a participant host, built by the coordinator")
        let attached = await coordinator.handle(CoordinatorDesk.request(.participantAvailability, [:], on: first))
        XCTAssertEqual(attached.outcome, .ok, "attached to the session's stack")

        try await bounded("the close") { await session.close() }
        XCTAssertEqual(session.state, .closed)
        let afterClose = await coordinator.handle(CoordinatorDesk.request(.participantAvailability, [:], on: first))
        XCTAssertEqual(afterClose.reason, .unknownConnection, "let go with its stack")

        try await bounded("the reopen") { await session.unlock(verifier: StubUnlockVerifier()) }
        XCTAssertEqual(session.state, .open, "reopened without asking")
        let second = try await pageConnection(session)
        let reattached = await coordinator.handle(CoordinatorDesk.request(.participantAvailability, [:], on: second))
        XCTAssertEqual(reattached.outcome, .ok, "the same coordinator, attached to the new stack")
        XCTAssertEqual(made, 1, "one lane for the run")
        try await bounded("the close") { await session.close() }
    }

    // MARK: Requirement 4: the unlock epoch across the whole unlock

    /// A lock the session never sees (the lane's own `lockNow()`) while the
    /// owner is asked: the session's unlock goes ahead, but the lane's
    /// unlock carries the epoch read when the check began, so the real
    /// coordinator stays locked. (On e4a748b a kept stack read the epoch at
    /// the host's unlock, after that lock, and unlocked the lane.)
    func testALockDuringTheOwnerCheckKeepsTheRealLaneLocked() async throws {
        let folder = try InventedDeskFolder()
        defer { folder.clean() }
        let coordinator = CoordinatorDesk.coordinator(world: CoordinatorDesk.world(), launcher: ManualLauncher())
        let session = try await openSession(folder, coordinator: coordinator)
        try await bounded("the lock") { await session.lock(reason: .menu) }
        XCTAssertTrue(coordinator.gate.isLocked)
        let check = HeldOwnerCheck()
        let unlocked = StepOutcome<Bool>()
        Task {
            await session.unlock(verifier: check)
            unlocked.value = true
        }
        try await eventually("the owner check") { check.isWaiting }
        coordinator.lockNow()
        check.answer(.verified)
        try await eventually("the unlock to end") { unlocked.value == true }
        XCTAssertEqual(session.state, .open, "the session saw no lock request")
        XCTAssertFalse(try XCTUnwrap(session.host).isLocked)
        XCTAssertTrue(coordinator.gate.isLocked, "the lock seen during the owner check refused the lane's unlock")

        // The next verified unlock, with no lock since its check began, does.
        try await bounded("the lock") { await session.lock(reason: .menu) }
        try await bounded("the unlock") { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        XCTAssertEqual(session.state, .open)
        XCTAssertFalse(coordinator.gate.isLocked)
        try await bounded("the close") { await session.close() }
    }

    /// A lock that reaches the lane while the host's own unlock step runs
    /// (after it reopened the store, before the lane's unlock) keeps the
    /// real coordinator locked too.
    func testALockDuringTheHostsUnlockStepKeepsTheRealLaneLocked() async throws {
        let folder = try InventedDeskFolder()
        defer { folder.clean() }
        let coordinator = CoordinatorDesk.coordinator(world: CoordinatorDesk.world(), launcher: ManualLauncher())
        let session = try await openSession(folder, coordinator: coordinator)
        try await bounded("the lock") { await session.lock(reason: .menu) }
        let host = try XCTUnwrap(session.host)
        host.lifecycleCheckpoint = { point in if point == .unlockStepReopened { coordinator.lockNow() } }
        try await bounded("the unlock") { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        host.lifecycleCheckpoint = nil
        XCTAssertEqual(session.state, .open)
        XCTAssertFalse(host.isLocked, "the host's own step was not overtaken")
        XCTAssertTrue(coordinator.gate.isLocked, "the lane's unlock was")
        try await bounded("the close") { await session.close() }
    }

    /// The case the app itself can hit (review minor F2): the session's own
    /// menu lock arrives while the host's unlock step runs, after it
    /// reopened the store and before the lane's unlock. The lane's unlock is
    /// refused by the epoch read as the owner check began, the session
    /// reports the unlock superseded and stays locked, and its deferred host
    /// lock locks the host again; the real coordinator stays locked. The
    /// next verified unlock opens all three.
    func testASessionLockDuringTheHostsUnlockStepKeepsHostAndRealLaneLocked() async throws {
        let folder = try InventedDeskFolder()
        defer { folder.clean() }
        let coordinator = CoordinatorDesk.coordinator(world: CoordinatorDesk.world(), launcher: ManualLauncher())
        let lines = DeskLines()
        let session = try await openSession(folder, coordinator: coordinator, lines: lines)
        try await bounded("the lock") { await session.lock(reason: .menu) }
        let host = try XCTUnwrap(session.host)
        let epochAtLock = coordinator.lockEpoch
        host.lifecycleCheckpoint = { [unowned session] point in
            if point == .unlockStepReopened { session.lockNow(reason: .menu) }
        }
        try await bounded("the unlock") { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        host.lifecycleCheckpoint = nil
        XCTAssertEqual(coordinator.lockEpoch, epochAtLock + 1, "the session's lock reached the lane once")
        XCTAssertEqual(session.state, .locked, "the lock won")
        XCTAssertTrue(lines.all.contains { $0.hasPrefix("desk.unlock.superseded") }, "\(lines.all)")
        try await eventually("the deferred host lock to lock the host again") { host.isLocked }
        try await bounded("the lane's queued unlock to end") { await host.laneUnlock?.value }
        XCTAssertTrue(coordinator.gate.isLocked, "the lane's unlock was refused")

        try await bounded("the next unlock") { await session.unlock(verifier: StubUnlockVerifier(.verified)) }
        XCTAssertEqual(session.state, .open)
        XCTAssertFalse(host.isLocked)
        XCTAssertFalse(coordinator.gate.isLocked)
        try await bounded("the close") { await session.close() }
    }

    /// A menu lock leaves the host's own step to a task, which here runs
    /// while the next unlock's owner check is up. That step does not lock
    /// the lane a second time, so the unlock, overtaken by no lock request,
    /// unlocks the real coordinator. (On e4a748b the step moved the lane's
    /// epoch again.)
    func testADeferredHostLockStepNeitherLocksTheRealLaneAgainNorKeepsItLocked() async throws {
        let folder = try InventedDeskFolder()
        defer { folder.clean() }
        let coordinator = CoordinatorDesk.coordinator(world: CoordinatorDesk.world(), launcher: ManualLauncher())
        let session = try await openSession(folder, coordinator: coordinator)
        let host = try XCTUnwrap(session.host)
        let before = coordinator.lockEpoch
        session.lockNow(reason: .menu)
        XCTAssertEqual(coordinator.lockEpoch, before + 1, "the session's lock, at once")
        let check = HeldOwnerCheck()
        let unlocked = StepOutcome<Bool>()
        Task {
            await session.unlock(verifier: check)
            unlocked.value = true
        }
        try await eventually("the owner check, and the host's deferred lock step") { check.isWaiting && host.isLocked }
        XCTAssertEqual(coordinator.lockEpoch, before + 1, "the host's step did not lock the lane again")
        check.answer(.verified)
        try await eventually("the unlock to end") { unlocked.value == true }
        XCTAssertEqual(session.state, .open)
        XCTAssertFalse(coordinator.gate.isLocked)
        try await bounded("the close") { await session.close() }
    }

    // MARK: Requirement 5: a push under way during lock and close

    /// A participant push from the real coordinator is held inside the
    /// WebKit sink's observer, on the pushing thread with the push gate
    /// held, when the host's lock (then, in a second world, its close) runs
    /// the lane's step on the main thread. The step waits for that push and
    /// nothing else: the push returns without the main thread and without
    /// calling back into the coordinator, then the step goes on. (This host
    /// loads no document, so nothing here could be delivered either way;
    /// dropping a push queued once the lock or close began is
    /// `ParticipantLaneWiringTests`' check, with a live page.)
    func testAPushUnderWayWhenTheRealLaneLocksOrClosesReturnsWithoutTheMainThread() async throws {
        for step in ["lock", "close"] {
            let folder = try InventedDeskFolder()
            defer { folder.clean() }
            let world = try await Start.oneRun()
            defer { world.clean() }
            // The stack the app would build: the coordinator's own host over
            // the same folder, its WebKit sink holding the next push.
            await world.coordinator.detach()
            world.store.close()
            let store = try ProofStore(directory: world.storeDirectory, keys: world.keys, seed: WorkspaceSeed(record: ["revision": .number(0)]))
            defer { store.close() }
            let hold = PushHold()
            let sink = WebKitHostEventSink { event in
                if case .participantEvent = event { hold.pushing() }
            }
            let hostProtocol = world.coordinator.makeHost(store: store, connections: world.connections, drafts: DraftBindingRegistry(),
                                                          info: VectorWorld.info, events: sink)
            try await world.coordinator.attach(host: hostProtocol, store: store, connections: world.connections, sink: sink)
            let host = DeskWebViewHost(hostProtocol: hostProtocol, resolver: try folder.fixtureResolver(), eventSink: sink,
                                       participantLane: world.coordinator)
            world.launcher.prepare(script: [ScriptStep(atMs: 0, .initClean), ScriptStep(atMs: 0, .rateLimitOK)])
            let pump = RealTimePump(world: world.virtual, rate: 4)
            pump.start()
            defer { pump.stop() }

            let started = await world.send(ParticipantCoordinatorReadTests.request(.participantStart, Start.start(), world: world))
            XCTAssertEqual(started.outcome, .ok, "\(step): \(started.jsonValue)")
            let run = try XCTUnwrap(world.launcher.runs.first)
            try await eventually("\(step): the run's started event") { run.events.contains { $0.type == .started } }
            hold.arm()
            run.deliver(ScriptStep(atMs: 0, .textDelta("Invented words held in the sink.")))
            try await eventually("\(step): the text push to be under way") { hold.entered }

            hold.release(after: 0.3)
            if step == "lock" {
                try await bounded("lock: the host's lock") { await host.lock() }
            } else {
                try await bounded("close: the host's close") { await host.close() }
            }
            hold.note("main went on")
            XCTAssertEqual(hold.journal, ["push held main=false", "push returned released=true", "main went on"],
                           "\(step): the lane's step waited for the push under way, which returned without the main thread")
            XCTAssertTrue(step == "lock" ? world.coordinator.gate.isLocked : world.coordinator.gate.state.closing)
            XCTAssertFalse(run.stopCalls.isEmpty, "\(step): the run was sent stop")
            if step == "lock" { try await bounded("lock: the host's close") { await host.close() } }
            XCTAssertEqual(pump.failures, [])
        }
    }
    // MARK: The stale-answer epoch (review F1) and the quit's plain bound

    /// The epoch the WebKit transport compares (`lifecycleEpoch`) moves on
    /// every lock and every shutdown begin, repeats included, inside the
    /// call; the unlock epoch moves on locks only.
    func testTheRealCoordinatorsLifecycleEpochMovesOnEveryLockAndShutdownBegin() {
        let coordinator = CoordinatorDesk.coordinator(world: CoordinatorDesk.world(), launcher: ManualLauncher())
        let lifecycle = coordinator.lifecycleEpoch
        let lock = coordinator.lockEpoch
        coordinator.lockNow()
        XCTAssertEqual(coordinator.lifecycleEpoch, lifecycle + 1)
        coordinator.lockNow()
        XCTAssertEqual(coordinator.lifecycleEpoch, lifecycle + 2, "a repeat while locked too")
        coordinator.beginShutdown(quitting: false)
        XCTAssertEqual(coordinator.lifecycleEpoch, lifecycle + 3)
        coordinator.beginShutdown(quitting: true)
        XCTAssertEqual(coordinator.lifecycleEpoch, lifecycle + 4, "a quit during the close too")
        XCTAssertEqual(coordinator.lockEpoch, lock + 2, "the unlock epoch moves on locks only")
    }

    /// A quit through the real `DeskTermination` with the real coordinator
    /// and nothing owed (review minor F1): the lane says so, the plain
    /// three-second limit is chosen, and the app gets its one yes well
    /// inside it, with the Desk closed and no limit reached.
    func testAQuitWithNothingOwedTakesThePlainBoundWithTheRealCoordinator() async throws {
        let folder = try InventedDeskFolder()
        defer { folder.clean() }
        let coordinator = CoordinatorDesk.coordinator(world: CoordinatorDesk.world(), launcher: ManualLauncher())
        let lines = DeskLines()
        let session = try await openSession(folder, coordinator: coordinator, lines: lines)
        let owedBefore = await coordinator.obligations()
        XCTAssertTrue(owedBefore.isEmpty, "no run, nothing owed")
        var replies: [Bool] = []
        let began = Date()
        let answer = DeskTermination.reply(for: session, pageAlreadyAsked: true, replyToApplication: { replies.append($0) })
        XCTAssertEqual(answer, .terminateLater, "a session with a lane always answers later")
        try await eventually("the app's one yes", timeout: DeskTermination.closeTimeout + 2) { !replies.isEmpty }
        let took = Date().timeIntervalSince(began)
        XCTAssertEqual(replies, [true])
        XCTAssertLessThan(took, DeskTermination.closeTimeout, "within the plain bound")
        try await eventually("the chosen limit's log line") { lines.all.contains { $0.hasPrefix("desk.terminate.participants") } }
        XCTAssertTrue(lines.all.contains("desk.terminate.participants owed=false limit=3s"), "\(lines.all)")
        XCTAssertFalse(lines.all.contains { $0.hasPrefix("desk.terminate.cap-reached") }, "\(lines.all)")
        XCTAssertEqual(session.state, .closed)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(replies, [true], "one answer only")
    }
}
