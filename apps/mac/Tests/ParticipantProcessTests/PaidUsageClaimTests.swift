import Foundation
import Testing
@testable import DeskHost
@testable import ParticipantCoordinator
@testable import ParticipantProcess

// Section 7's run claim with section 17's real owner (plan F4; Codex F0
// answer 12): where the coordinator claims, what never claims, a claim
// refused after the durable start record, the fifth run, and the owner's
// ends through the coordinator (S5 R1, S8 R1). The owner's local checks and
// authentication are fakes; runs are driven by hand, scripted on the
// virtual clock, or the fake CLI under the real supervisor. Invented data
// only; never the real CLI, a provider, the Keychain or a real
// LocalAuthentication request.

@Suite("Section 17 owner through the coordinator: the run claim")
struct PaidUsageClaimTests {
    typealias Start = ParticipantCoordinatorStartTests

    /// A coordinator over `world` whose availability and confirmation are
    /// `proxy` (so the owner and its counts), its runs driven by hand.
    static func manual(_ world: VectorWorld, _ proxy: CountingOwnerProxy) async throws -> Start.Manual {
        world.availability.set(proxy)
        return try await Start.Manual(world, confirmation: proxy)
    }

    static func confirmedProxy(checks: ScriptedLocalChecks = ScriptedLocalChecks()) async -> CountingOwnerProxy {
        CountingOwnerProxy(await inventedOwner(checks: checks, confirmed: true))
    }

    @Test("The claim comes once, after the durable start record and before the launch, and counts the launched run; with no active confirmation the start is participant-unavailable and claims nothing")
    func placement() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let unconfirmed = CountingOwnerProxy(await inventedOwner())
        let refusing = try await Self.manual(world, unconfirmed)
        #expect(try await refusing.send(.participantStart, Start.start(1)).reason == .participantUnavailable)
        #expect(unconfirmed.claims == 0 && refusing.launcher.runs.isEmpty)

        let proxy = await Self.confirmedProxy()
        let manual = try await Self.manual(world, proxy)
        let seen = ResultBox<(durable: Bool, launched: Int)>()
        let store = world.store
        let launcher = manual.launcher
        proxy.onClaim = {
            let durable = store.publishedRuns.runs.first { $0.runId == Start.runId(1) }?.start != nil
            seen.set((durable, launcher.runs.count))
        }
        #expect(try await manual.send(.participantStart, Start.start(1)).outcome == .ok)
        let atClaim = try #require(seen.value)
        #expect(atClaim.durable, "the start record was durable at the claim")
        #expect(atClaim.launched == 0, "nothing was launched before the claim")
        #expect(proxy.claims == 1 && manual.launcher.runs.count == 1)
        #expect(displayState(proxy.owner.display) == "active 4")
    }

    @Test("Refusals before the write, a definite or undetermined start record, the re-read that settles it and an exact replay never claim; a launch that throws after a claim still counts")
    func whatNeverClaims() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        let proxy = await Self.confirmedProxy()
        let manual = try await Self.manual(world, proxy)

        // Pre-write refusals at steps 2-11 and a definite step-14 failure.
        var bad = Start.start(1)
        bad["extra"] = .number(1)
        #expect(try await manual.send(.participantStart, bad).reason == .unknownField)
        #expect(try await manual.send(.participantStart, Start.start(1, chunks: ["Invented other text."])).reason == .runMismatch)
        faults.fail(before: .rename)
        #expect(try await manual.send(.participantStart, Start.start(1)).reason == .storeCorrupt)
        #expect(proxy.claims == 0)

        // An undetermined record, then the status re-read that finds it.
        faults.undeterminedFlushes = true
        let id = Start.id(1)
        var request = try #require(ParticipantCoordinatorReadTests.request(.participantStart, Start.start(1), world: world, id: id).objectValue)
        let first = await manual.coordinator.handle(try HostRequest(validating: .object(request), acceptsParticipant: true))
        #expect(first.outcome == .unknown)
        faults.undeterminedFlushes = false
        let status = try await manual.send(.participantStatus, Start.read(1))
        #expect(status.fields["terminal"]?.objectValue?["reason"] == .string("process-error"), "\(status.jsonValue)")
        let replay = await manual.coordinator.handle(try HostRequest(validating: .object(request), acceptsParticipant: true))
        #expect(replay.outcome == .ok, "the found record replays")
        #expect(proxy.claims == 0 && manual.launcher.runs.isEmpty)

        // A launch that throws after the claim: counted, never refunded.
        struct InventedLaunchFailure: Error {}
        let throwing = ThrowingLauncher(InventedLaunchFailure())
        let coordinator = ParticipantCoordinator(configuration: ParticipantCoordinator.Configuration(
            hostConfiguration: world.hostConfiguration, availability: world.availability,
            launchId: try ParticipantVectors.load().context.launchId, clock: world.virtual.clock, executor: world.executor,
            launcher: throwing, log: world.log, wakeups: VirtualWakeups(world: world.virtual), confirmation: proxy))
        await manual.coordinator.detach()
        try await coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        request = try #require(ParticipantCoordinatorReadTests.request(.participantStart, Start.start(2), world: world, id: Start.id(2)).objectValue)
        let thrown = await coordinator.handle(try HostRequest(validating: .object(request), acceptsParticipant: true))
        #expect(thrown.outcome == .ok)
        #expect(proxy.claims == 1 && throwing.attempts == 1)
        #expect(displayState(proxy.owner.display) == "active 4", "the failed spawn counted")
        let entry = try Start.entry(world, run: 2)
        #expect(entry["terminal"]?.objectValue?["reason"] == .string("process-error") && entry["groupCleared"] == .null)
        let again = await coordinator.handle(try HostRequest(validating: .object(request), acceptsParticipant: true))
        #expect(again.outcome == .ok && proxy.claims == 1 && throwing.attempts == 1, "an exact replay: no claim, no launch, no retry")
    }

    @Test("A claim refused after the durable start record (the confirmation ended during the write): nothing spawned, failed process-error at sequence 1 with groupCleared null; starts busy until that terminal is durable, then participant-unavailable; the start replays ok and never claims again")
    func lateClaimFailure() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let proxy = await Self.confirmedProxy()
        let manual = try await Self.manual(world, proxy)
        let executor = world.executor
        _ = world.sink.take()

        executor.holdNext()
        let id = Start.id(1)
        let request = try #require(ParticipantCoordinatorReadTests.request(.participantStart, Start.start(1), world: world, id: id).objectValue)
        let coordinator = manual.coordinator
        let start = Task { await coordinator.handle(try! HostRequest(validating: .object(request), acceptsParticipant: true)) }
        #expect(await waitOffPool(executor.held, seconds: vectorWaitSeconds), "the start record's write is held")
        // Logout or power-off begins (it does not lock the Desk): the
        // confirmation ends while the record is written.
        proxy.owner.end(.logout)
        executor.holdNext()
        executor.releaseHeld()
        #expect(await waitOffPool(executor.held, seconds: vectorWaitSeconds), "the never-spawned terminal's write is held")
        #expect(proxy.claims == 1, "claimed once, refused")
        #expect(try Start.entry(world)["start"] != .null, "the start record is durable")
        #expect(try await manual.send(.participantStart, Start.start(2)).reason == .participantBusy, "a terminal still owed")
        #expect(world.sink.take().isEmpty, "nothing pushed before the terminal is durable")
        executor.releaseHeld()
        let reply = try #require(await value(of: start))
        #expect(reply.outcome == .ok && reply.fields["runId"] == .string(Start.runId(1)), "\(reply.jsonValue)")
        #expect(manual.launcher.runs.isEmpty, "nothing spawned")
        let pushed = world.sink.take().compactMap { $0.objectValue?["event"]?.objectValue }
        #expect(pushed.count == 1 && pushed.first?["type"] == .string("failed") && pushed.first?["reason"] == .string("process-error"))
        #expect(pushed.first?["sequence"] == .number(1))
        let entry = try Start.entry(world)
        #expect(entry["terminal"]?.objectValue?["sequence"] == .number(1) && entry["groupCleared"] == .null)
        #expect(entry["start"]?.objectValue?["requestId"] == .string(id), "the start identity is kept, never released")
        let status = try await manual.send(.participantStatus, Start.read(1))
        #expect(status.fields["state"] == .string("exited"), "\(status.jsonValue)")

        let replay = await coordinator.handle(try HostRequest(validating: .object(request), acceptsParticipant: true))
        #expect(replay.outcome == .ok, "the recorded start replays")
        #expect(proxy.claims == 1 && manual.launcher.runs.isEmpty && world.sink.take().isEmpty)
        #expect(proxy.owner.display == .ended(.logout), "the honest ended display stays")
        #expect(try await manual.send(.participantStart, Start.start(2)).reason == .participantUnavailable)
        #expect(proxy.claims == 1)
        #expect(executor.holdTimeouts == 0)
    }

    @Test("A lock overtaking the start during its record's write prevents the launch before any claim")
    func lockOvertakesClaim() async throws {
        let world = try await Start.oneRun()
        defer { world.clean() }
        let proxy = await Self.confirmedProxy()
        let manual = try await Self.manual(world, proxy)
        let executor = world.executor
        executor.holdNext()
        let coordinator = manual.coordinator
        let request = try #require(ParticipantCoordinatorReadTests.request(.participantStart, Start.start(1), world: world).objectValue)
        let start = Task { await coordinator.handle(try! HostRequest(validating: .object(request), acceptsParticipant: true)) }
        #expect(await waitOffPool(executor.held, seconds: vectorWaitSeconds))
        coordinator.lockNow()
        executor.releaseHeld()
        #expect(try #require(await value(of: start)).outcome == .ok)
        #expect(proxy.claims == 0 && manual.launcher.runs.isEmpty, "the lifecycle check came first: no claim, no launch")
        #expect(displayState(proxy.owner.display) == "active 5")
    }

    @Test("A start in progress (its recheck or its record's write, where the claim follows) keeps every other start participant-busy")
    func claimInProgressBusy() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let proxy = await Self.confirmedProxy()
        let manual = try await Self.manual(world, proxy)
        let coordinator = manual.coordinator
        let gate = world.availability.hold()
        let request = try #require(ParticipantCoordinatorReadTests.request(.participantStart, Start.start(1), world: world).objectValue)
        let first = Task { await coordinator.handle(try! HostRequest(validating: .object(request), acceptsParticipant: true)) }
        #expect(await waitUntil { gate.arrived > 0 })
        #expect(try await manual.send(.participantStart, Start.start(2)).reason == .participantBusy, "during the recheck")
        world.executor.holdNext()
        world.availability.releaseHold()
        #expect(await waitOffPool(world.executor.held, seconds: vectorWaitSeconds))
        #expect(try await manual.send(.participantStart, Start.start(2)).reason == .participantBusy, "during the record's write")
        world.executor.releaseHeld()
        #expect(try #require(await value(of: first)).outcome == .ok)
        #expect(proxy.claims == 1 && manual.launcher.runs.count == 1)
    }

    @Test("Paid overflow observed ends the confirmation through exactly one owner call per run, and nothing reuses it (S5 R1): the next start is participant-unavailable")
    func overflowEnds() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let proxy = await Self.confirmedProxy()
        let manual = try await Self.manual(world, proxy)
        #expect(try await manual.send(.participantStart, Start.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        run.send(.event(manual.event(1, .started)))
        run.send(.overflowObserved)
        run.send(.terminal(manual.event(2, .failed, reason: "paid-overflow"), groupCleared: true))
        run.send(.cleanupReleased)
        run.send(.overflowObserved)
        #expect(await manual.applied(5))
        #expect(proxy.ends == 1 && proxy.owner.display == .ended(.paidOverflow))
        try world.virtual.advance(to: world.virtual.now + 6_000)
        run.finish()
        #expect(await manual.finished())
        #expect(proxy.ends == 1, "one call for the run")
        #expect(try await manual.send(.participantStart, Start.start(2)).reason == .participantUnavailable, "never reused")
        #expect(proxy.claims == 1)
    }

    @Test("Updates unfinished five seconds after cleanup-released: the owner ends the confirmation paid-overflow, once, off the coordinator; starts stay busy until the updates finish, then are participant-unavailable")
    func lateEnd() async throws {
        let world = try await Start.twoRuns()
        defer { world.clean() }
        let proxy = await Self.confirmedProxy()
        let manual = try await Self.manual(world, proxy)
        #expect(try await manual.send(.participantStart, Start.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        run.send(.event(manual.event(1, .started)))
        run.send(.terminal(manual.event(2, .completed), groupCleared: true))
        run.send(.cleanupReleased)
        #expect(await manual.applied(3))
        #expect(proxy.owner.display.isActive)
        try world.virtual.advance(to: world.virtual.now + 5_000)
        #expect(await waitUntil { proxy.ends == 1 }, "the five-second rule ended it")
        #expect(proxy.owner.display == .ended(.paidOverflow))
        #expect(try await manual.busy(), "the updates have not finished")
        run.finish()
        #expect(await manual.finished())
        #expect(proxy.ends == 1)
        #expect(try await manual.send(.participantStart, Start.start(2)).reason == .participantUnavailable)
    }

    @Test("The public owner initializer makes the owner both the coordinator's availability and its confirmation, with section 17's 4,096-byte input bound")
    func publicWiring() async throws {
        let owner = await inventedOwner()
        let bounded = ParticipantHostConfiguration(pin: CoordinatorDesk.pin, inputBound: ParticipantLimits.firstTrialInputBound)
        let configuration = ParticipantCoordinator.Configuration(
            hostConfiguration: bounded, confirmationOwner: owner,
            launchId: UUID().uuidString.lowercased(), clock: InventedWallClock(), executor: BackgroundMutationExecutor(),
            launcher: ManualLauncher(), log: RecordingLog())
        #expect((configuration.availability as? PaidUsageConfirmationOwner) === owner)
        #expect((configuration.confirmation as? PaidUsageConfirmationOwner) === owner)
        #expect(configuration.hostConfiguration.inputBound == 4_096, "section 17's first-trial bound (Codex F34-3)")
        #expect(configuration.hostConfiguration.identities === bounded.identities, "the host's identity space, shared")
        // Any other bound stops the initializer (a precondition, not
        // reachable in a test process): the source holds it.
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/ParticipantCoordinator/ParticipantCoordinator.swift"),
            encoding: .utf8)
        let ownerInit = try #require(source.range(of: "confirmationOwner owner: PaidUsageConfirmationOwner,").map {
            String(source[$0.upperBound...].prefix(600))
        })
        #expect(ownerInit.contains("precondition(hostConfiguration.inputBound == ParticipantLimits.firstTrialInputBound,"))
        let plain = ParticipantCoordinator.Configuration(
            hostConfiguration: ParticipantHostConfiguration(pin: CoordinatorDesk.pin), availability: owner,
            launchId: UUID().uuidString.lowercased(), clock: InventedWallClock(), executor: BackgroundMutationExecutor(),
            launcher: ManualLauncher(), log: RecordingLog())
        #expect(plain.confirmation == nil, "the first public initializer still has no owner")
    }
}

/// A launcher whose every launch throws, counting the attempts.
final class ThrowingLauncher: ParticipantLaunching, @unchecked Sendable {
    let cliVersion = "invented-cli-version"
    private let error: Error
    private let lock = NSLock()
    private var count = 0

    init(_ error: Error) {
        self.error = error
    }

    func launch(_ request: ParticipantLaunchRequest) throws -> any ParticipantRunning {
        lock.lock(); count += 1; lock.unlock()
        throw error
    }

    var attempts: Int {
        lock.lock(); defer { lock.unlock() }
        return count
    }
}

extension ProcessSuites {
    @Suite("Section 17 owner: five runs with the fake CLI under the real supervisor")
    struct PaidUsageFiveRuns {
        typealias Start = ParticipantCoordinatorStartTests

        /// Six prepared, never-dispatched runs of the same invented question
        /// (#34's first run, with distinct ids).
        static func sixRuns() async throws -> VectorWorld {
            let vectors = try ParticipantVectors.load()
            let source = try vectors.named("participant.start not started: busy")
            guard case .array(let seeded)? = source.seed["runs"], var template = seeded.first?.objectValue else {
                throw VectorHarnessError.fixture("#34 runs")
            }
            template["start"] = .null
            var runs: [JSONValue] = []
            for n in 1...6 {
                var entry = template
                entry["runId"] = .string(Start.runId(n))
                entry["sessionId"] = .string(Start.sessionId(n))
                entry["userMessageId"] = .string("72abcdef-0000-4000-8abc-00000000000\(n)")
                entry["assistantMessageId"] = .string("73abcdef-0000-4000-8abc-00000000000\(n)")
                entry["prepareRequestId"] = .string("62abcdef-0000-4000-8abc-0000000007\(n)0")
                runs.append(.object(entry))
            }
            // Section 17's host has the first-trial input bound (Codex F34-3).
            let seed: [String: JSONValue] = ["record": source.seed["record"] ?? .null, "runs": .array(runs),
                                             "availability": .object(["result": .string("available")]),
                                             "inputBound": .number(Double(ParticipantLimits.firstTrialInputBound))]
            return try await VectorWorld(seed: seed, number: source.number, operation: "participant.start", vectors: vectors,
                                         clock: Start.clock)
        }

        static func start(_ n: Int) -> [String: JSONValue] {
            var payload = Start.start(n)
            payload["inputChunks"] = .array([.string(Start.question)])
            return payload
        }

        @Test("Five starts claim five runs (5, 4, 3, 2, 1 left); the fifth claim ends it run-limit while that fifth fake-CLI run goes on to its completed terminal; a sixth start is participant-unavailable")
        func fiveRuns() async throws {
            let world = try await Self.sixRuns()
            defer { world.clean() }
            let folder = try FakeCLIFolder(.script(Start.script))
            defer { folder.clean() }
            let parent = try ParticipantsFolder.prepare(in: folder.workParent)
            let owner = await inventedOwner(confirmed: true)
            let coordinator = ParticipantCoordinator(configuration: ParticipantCoordinator.Configuration(
                hostConfiguration: world.hostConfiguration, confirmationOwner: owner,
                launchId: try ParticipantVectors.load().context.launchId, clock: SystemParticipantClock(), executor: world.executor,
                launcher: LauncherFixture.launcher(folder, parent: parent, log: RecordingLog()), log: world.log))
            await world.coordinator.detach()
            try await coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
            func send(_ operation: HostOperation, _ payload: [String: JSONValue]) async throws -> HostResponse {
                let request = try #require(ParticipantCoordinatorReadTests.request(operation, payload, world: world).objectValue)
                return await coordinator.handle(try HostRequest(validating: .object(request), acceptsParticipant: true))
            }

            for n in 1...5 {
                let reply = try await send(.participantStart, Self.start(n))
                #expect(reply.outcome == .ok, "run \(n): \(reply.jsonValue)")
                if n < 5 {
                    #expect(displayState(owner.display) == "active \(5 - n)", "run \(n)")
                } else {
                    #expect(owner.display == .ended(.runLimit), "the fifth claim ended it")
                }
                // The run goes on to its own terminal; the next start waits
                // until its updates and writes are done.
                #expect(await waitUntil(seconds: 20) {
                    guard await coordinator.consumption(of: Start.runId(n))?.finished == true else { return false }
                    let writing = await coordinator.isWriting
                    let unresolved = await coordinator.hasUnresolvedWrites
                    return !writing && !unresolved
                }, "run \(n) finished")
                let entry = try Start.entry(world, run: n)
                #expect(entry["terminal"]?.objectValue?["type"] == .string("completed"), "run \(n): \(entry)")
            }
            #expect(owner.display == .ended(.runLimit))
            let sixth = try await send(.participantStart, Self.start(6))
            #expect(sixth.reason == .participantUnavailable, "\(sixth.jsonValue)")
            #expect(try Start.entry(world, run: 6)["start"] == .null, "nothing recorded for the sixth")
            #expect(LauncherFixture.children(of: parent).isEmpty)
        }
    }
}
