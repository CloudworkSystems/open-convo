import Foundation
import Testing
@testable import DeskHost
@testable import ParticipantCoordinator
@testable import ParticipantProcess

// `participant.start` (plan S8; contract sections 3, 7-10, 12 and 17): the
// steps' refusals in order, the identity space, Stop during `starting`,
// the undetermined start record and its re-read (Codex Q27-Q29), the
// retained events a start replaces (Q30), spawn failures, reads while a
// start's write holds the store, and the busy guard with section 17's
// five-second rule (Codex S5 rulings). Invented data only; runs are
// scripted on the virtual clock or driven by hand, never the real CLI.

/// A run driven by hand: the test yields its updates and ends them.
final class ManualRun: ParticipantRunning, @unchecked Sendable {
    let updates: AsyncStream<ParticipantRunUpdate>
    let request: ParticipantLaunchRequest
    private let continuation: AsyncStream<ParticipantRunUpdate>.Continuation
    private let lock = NSLock()
    private var stops = 0

    init(request: ParticipantLaunchRequest) {
        self.request = request
        var continuation: AsyncStream<ParticipantRunUpdate>.Continuation!
        updates = AsyncStream(bufferingPolicy: .unbounded) { continuation = $0 }
        self.continuation = continuation
    }

    func send(_ update: ParticipantRunUpdate) { continuation.yield(update) }
    func finish() { continuation.finish() }

    @discardableResult
    func stop() -> Bool {
        lock.lock(); defer { lock.unlock() }
        stops += 1
        return false
    }

    var stopCalls: Int {
        lock.lock(); defer { lock.unlock() }
        return stops
    }

    var snapshot: ParticipantRunSnapshot {
        ParticipantRunSnapshot(lastSequence: 0, terminal: nil, groupCleared: nil, cleanup: .owned)
    }
}

final class ManualLauncher: ParticipantLaunching, @unchecked Sendable {
    let cliVersion = "invented-cli-version"
    private let lock = NSLock()
    private var launched: [ManualRun] = []

    func launch(_ request: ParticipantLaunchRequest) throws -> any ParticipantRunning {
        let run = ManualRun(request: request)
        lock.lock(); launched.append(run); lock.unlock()
        return run
    }

    var runs: [ManualRun] {
        lock.lock(); defer { lock.unlock() }
        return launched
    }
}

@Suite("Participant coordinator: start")
struct ParticipantCoordinatorStartTests {
    static let handle = "invented-workspace-handle"
    static let question = "Invented question: \"two plus two?\"\nReply in one line. \u{1F600}"
    static let clock = "2026-10-09T00:01:01.000Z"
    /// Vector #27's script: completed at +310.
    static let script = [ScriptStep(atMs: 0, .initClean), ScriptStep(atMs: 50, .rateLimitOK), ScriptStep(atMs: 100, .textDelta("Four. ")),
                         ScriptStep(atMs: 200, .textDelta("Invented reply.")), ScriptStep(atMs: 300, .resultSuccess),
                         ScriptStep(atMs: 310, .exit(0))]

    static func runId(_ n: Int) -> String { "71abcdef-0000-4000-8abc-00000000000\(n)" }
    static func sessionId(_ n: Int) -> String { "52abcdef-0000-4000-8abc-00000000000\(n)" }
    static func id(_ n: Int) -> String { String(format: "62abcdef-0000-4000-8abc-0000005%05d", n) }

    /// Vector #59's one prepared, never-dispatched run, availability
    /// available unless `extra` says otherwise.
    static func oneRun(extra: [String: JSONValue] = [:], clock: String = clock,
                       beforeHost: ((ProofStore) throws -> Void)? = nil) async throws -> VectorWorld {
        let vectors = try ParticipantVectors.load()
        let source = try vectors.named("participant.status not dispatched after restart")
        var seed: [String: JSONValue] = ["record": source.seed["record"] ?? .null, "runs": source.seed["runs"] ?? .array([]),
                                         "availability": .object(["result": .string("available")])]
        for (key, value) in extra { seed[key] = value }
        return try await VectorWorld(seed: seed, number: source.number, operation: "participant.start", vectors: vectors, clock: clock,
                                     beforeHost: beforeHost)
    }

    /// Vector #34's two runs, both prepared and never dispatched.
    static func twoRuns(earlierLaunchStartedRunOne: Bool = false) async throws -> VectorWorld {
        let vectors = try ParticipantVectors.load()
        let source = try vectors.named("participant.start not started: busy")
        guard case .array(let seeded)? = source.seed["runs"] else { throw VectorHarnessError.fixture("#34 runs") }
        var runs: [JSONValue] = []
        for (index, value) in seeded.enumerated() {
            var entry = try #require(value.objectValue)
            entry["start"] = .null
            if index == 0, earlierLaunchStartedRunOne {
                let earlier = try vectors.named("restart: start of a run an earlier launch dispatched is duplicate-run")
                guard case .array(let earlierRuns)? = earlier.seed["runs"] else { throw VectorHarnessError.fixture("#96 runs") }
                entry["start"] = earlierRuns.first?.objectValue?["start"] ?? .null
            }
            runs.append(.object(entry))
        }
        let seed: [String: JSONValue] = ["record": source.seed["record"] ?? .null, "runs": .array(runs),
                                         "availability": .object(["result": .string("available")])]
        return try await VectorWorld(seed: seed, number: source.number, operation: "participant.start", vectors: vectors, clock: clock)
    }

    /// The start payload of run 1 (#27's) or run 2 (#74's).
    static func start(_ run: Int = 1, chunks: [String]? = nil) -> [String: JSONValue] {
        [
            "workspaceHandle": .string(handle), "runId": .string(runId(run)), "sessionId": .string(sessionId(run)),
            "userMessageId": .string("72abcdef-0000-4000-8abc-00000000000\(run)"),
            "assistantMessageId": .string("73abcdef-0000-4000-8abc-00000000000\(run)"),
            "participant": .object(["id": .string("claude-code"), "label": .string("Claude Code"), "model": .string("invented-pinned-model"),
                                    "executionHost": .string("this-mac")]),
            "inputChunks": .array((chunks ?? [run == 1 ? question : "Invented busy question."]).map(JSONValue.string))
        ]
    }

    static func read(_ run: Int = 1) -> [String: JSONValue] {
        ["workspaceHandle": .string(handle), "runId": .string(runId(run)), "sessionId": .string(sessionId(run))]
    }

    static func events(_ run: Int = 1, after: Double = 0) -> [String: JSONValue] {
        var payload = read(run)
        payload["afterSequence"] = .number(after)
        payload["maxEvents"] = .number(64)
        return payload
    }

    static func send(_ world: VectorWorld, _ operation: HostOperation, _ payload: [String: JSONValue],
                     id: String = UUID().uuidString.lowercased()) async -> HostResponse {
        await world.send(ParticipantCoordinatorReadTests.request(operation, payload, world: world, id: id))
    }

    /// The request in flight, as a task.
    static func sending(_ world: VectorWorld, _ operation: HostOperation, _ payload: [String: JSONValue],
                        id: String = UUID().uuidString.lowercased()) -> Task<HostResponse, Never> {
        let request = ParticipantCoordinatorReadTests.request(operation, payload, world: world, id: id)
        return Task { await world.send(request) }
    }

    static func answer(_ task: Task<HostResponse, Never>) async throws -> HostResponse {
        try #require(await value(of: task), "answered within \(vectorWaitSeconds) s")
    }

    static func entry(_ world: VectorWorld, run: Int = 1) throws -> [String: JSONValue] {
        try #require(try world.runsOnDisk()?.compactMap(\.objectValue).first { $0["runId"] == .string(runId(run)) })
    }

    /// Asserts the request id is no identity: a probe claim succeeds (and is
    /// given back).
    static func leavesNoIdentity(_ world: VectorWorld, _ id: String) throws -> Bool {
        let requestId = try #require(UUID(uuidString: id))
        let identities = world.hostConfiguration.identities
        guard identities.claimStarting(requestId, payloadHash: "invented-probe") == .claimed else { return false }
        identities.releaseStarting(requestId)
        return true
    }

    // MARK: Steps in order

    @Test("Each step's refusal in order, an earlier step winning over a later one; a refusal launches nothing, leaves no identity, writes nothing, pushes nothing and uses no executor")
    func stepRefusalsInOrder() async throws {
        let world = try await Self.oneRun()
        defer { world.clean() }
        let folder = try world.folderSnapshot()
        var counter = 0
        func refused(_ payload: [String: JSONValue], _ expected: HostRefusal, _ label: String,
                     sourceLocation: SourceLocation = #_sourceLocation) async throws {
            counter += 1
            let id = Self.id(counter)
            let reply = await Self.send(world, .participantStart, payload, id: id)
            #expect(reply.outcome == .refused && reply.reason == expected, "\(label): \(reply.jsonValue)", sourceLocation: sourceLocation)
            #expect(try Self.leavesNoIdentity(world, id), "\(label) left no identity", sourceLocation: sourceLocation)
        }
        func with(_ changes: [String: JSONValue?], _ base: [String: JSONValue] = Self.start()) -> [String: JSONValue] {
            var payload = base
            for (key, value) in changes { payload[key] = value }
            return payload
        }
        var participant = try #require(Self.start()["participant"]?.objectValue)

        // 2. Shape: unknown keys, then the five ids in order, then the
        // other shapes, then distinct ids.
        try await refused(with(["extra": .number(1)]), .unknownField, "unknown key")
        try await refused(with(["extra": .number(1), "runId": .string("not-a-run")]), .unknownField, "unknown key before a bad id")
        try await refused(with(["workspaceHandle": nil]), .invalidIdentity, "missing handle")
        try await refused(with(["runId": .string(Self.runId(1).uppercased())]), .invalidIdentity, "upper-case run id")
        try await refused(with(["sessionId": .number(5)]), .invalidIdentity, "session id not a string")
        try await refused(with(["userMessageId": nil]), .invalidIdentity, "missing user message id")
        try await refused(with(["assistantMessageId": .string("invented")]), .invalidIdentity, "bad assistant message id")
        try await refused(with(["assistantMessageId": .string("invented"), "participant": .string("x")]), .invalidIdentity,
                          "an id before the participant")
        try await refused(with(["participant": .string("claude-code")]), .malformedEnvelope, "participant not an object")
        participant["extra"] = .string("x")
        try await refused(with(["participant": .object(participant)]), .malformedEnvelope, "participant with a fifth key")
        participant["extra"] = nil
        participant["label"] = .number(1)
        try await refused(with(["participant": .object(participant)]), .malformedEnvelope, "participant label not a string")
        try await refused(with(["inputChunks": .string(Self.question)]), .malformedEnvelope, "inputChunks not a list")
        try await refused(with(["inputChunks": .array([.string("x"), .number(1)])]), .malformedEnvelope, "a chunk not a string")
        try await refused(with(["participant": nil]), .malformedEnvelope, "missing participant")
        try await refused(with(["userMessageId": .string(Self.runId(1))]), .invalidIdentity, "ids not distinct")
        try await refused(with(["userMessageId": .string(Self.runId(1)), "inputChunks": .null]), .malformedEnvelope,
                          "distinctness last, after every shape")
        // 3. The handle, after the shape.
        try await refused(with(["workspaceHandle": .string("invented-other-handle")]), .unknownHandle, "another handle")
        try await refused(with(["workspaceHandle": .string("invented-other-handle"), "inputChunks": .null]), .malformedEnvelope,
                          "shape before the handle")
        // 4. A v1 identity (the run's own preparing commit).
        counter += 1
        let prepareId = "62abcdef-0000-4000-8abc-000000000001"
        let mismatch = await Self.send(world, .participantStart, Self.start(), id: prepareId)
        #expect(mismatch.outcome == .refused && mismatch.reason == .payloadMismatch)
        // 6. No entry.
        var other = Self.start()
        other["runId"] = .string(Self.runId(9))
        try await refused(other, .unknownRun, "no entry")
        // 9. The prepared run: each id, each participant field, the input
        // hash (the same text cut at another boundary included: Codex Q17).
        try await refused(with(["sessionId": .string(Self.sessionId(9))]), .runMismatch, "another session")
        try await refused(with(["userMessageId": .string("72abcdef-0000-4000-8abc-000000000009")]), .runMismatch, "another user message")
        try await refused(with(["assistantMessageId": .string("73abcdef-0000-4000-8abc-000000000009")]), .runMismatch,
                          "another assistant message")
        for key in ["id", "label", "model", "executionHost"] {
            var changed = try #require(Self.start()["participant"]?.objectValue)
            changed[key] = .string("invented-other-\(key)")
            try await refused(with(["participant": .object(changed)]), .runMismatch, "another participant \(key)")
        }
        let split = Self.question.index(Self.question.startIndex, offsetBy: 19)
        try await refused(Self.start(chunks: [String(Self.question[..<split]), String(Self.question[split...])]), .runMismatch,
                          "the same text in two chunks")
        try await refused(Self.start(chunks: []), .runMismatch, "no chunks")

        #expect(world.launcher.requests.isEmpty, "no refusal launched")
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil, "no refusal wrote")
        #expect(world.sink.take().isEmpty && world.executor.runs == 0)

        // 1. The lock flag, before everything.
        world.store.lockStore()
        try await refused(with(["extra": .number(1)]), .storeLocked, "locked, before the shape")
        world.store.unlockStore()

        // 5. Unreadable (missing) runs list.
        try FileManager.default.removeItem(at: world.store.stateURL)
        _ = try? world.store.rereadRuns()
        try await refused(Self.start(), .storeMissing, "store missing")
        #expect(world.launcher.requests.isEmpty)
    }

    @Test("Step 5 corrupt, steps 9-11 in order over an earlier pin (Codex Q25: participant-changed is its own permanent refusal), and step 11's bound")
    func laterStepsInOrder() async throws {
        let vectors = try ParticipantVectors.load()
        let corrupt = try await VectorWorld(seed: ["store": .string("corrupt")], number: 54, operation: "participant.start", vectors: vectors)
        defer { corrupt.clean() }
        let reply = await Self.send(corrupt, .participantStart, Self.start())
        #expect(reply.outcome == .refused && reply.reason == .storeCorrupt, "\(reply.jsonValue)")

        let changed = try vectors.named("restart after a pin change: a never-dispatched run is refused participant-changed")
        for (bound, label) in [(nil as Int?, "pin only"), (16, "pin and the bound")] {
            var seed = changed.seed
            if let bound { seed["inputBound"] = .number(Double(bound)) }
            let world = try await VectorWorld(seed: seed, number: changed.number, operation: "participant.start", vectors: vectors)
            defer { world.clean() }
            // The page's current pin is not what the run was prepared with.
            var current = Self.start()
            current["participant"] = world.hostConfiguration.pin.jsonValue
            let mismatch = await Self.send(world, .participantStart, current)
            #expect(mismatch.reason == .runMismatch, "\(label): step 9 compares the prepared participant")
            // The run's own participant: step 10, before step 11's bound.
            let refusal = await Self.send(world, .participantStart, Self.start())
            #expect(refusal.reason == .participantChanged, "\(label): \(refusal.jsonValue)")
            #expect(world.launcher.requests.isEmpty)
        }

        let bounded = try vectors.named("participant.start trial bound: a run prepared above 4,096 bytes is text-too-large, nothing spawned")
        let world = try await VectorWorld(root: bounded, vectors: vectors)
        defer { world.clean() }
        let tooLarge = await world.send(bounded.request)
        #expect(tooLarge.reason == .textTooLarge)
        #expect(world.launcher.requests.isEmpty)
    }

    @Test("Codex Q13 at start: an available answer with a present confirmation that is not active is overflow-unverified, so the start is participant-unavailable and launches nothing; with an active one it starts")
    func confirmationGatesStart() async throws {
        let world = try await Self.oneRun()
        defer { world.clean() }
        world.launcher.prepare(script: Self.script)
        for display in [ParticipantConfirmationDisplay.unconfirmed, .ended(.runLimit), .ended(.paidOverflow)] {
            world.availability.set(SeededAvailability(seeded: ParticipantAvailabilityReport(availability: .available, confirmation: display)))
            let refused = await Self.send(world, .participantStart, Self.start())
            #expect(refused.reason == .participantUnavailable, "\(display.jsonValue)")
        }
        #expect(world.launcher.requests.isEmpty && world.executor.runs == 0)
        let active = try #require(ParticipantConfirmationDisplay.active(confirmedAt: Self.clock, runsLeft: 5))
        world.availability.set(SeededAvailability(seeded: ParticipantAvailabilityReport(availability: .available, confirmation: active)))
        #expect(await Self.send(world, .participantStart, Self.start()).outcome == .ok)
        try await world.settle()
    }

    // MARK: Identity (section 3)

    @Test("While starting: the same bytes again are unknown, other bytes under that id payload-mismatch, another id duplicate-run; a commit, bind or reconcile under the starting id is refused or unknown; one launch only")
    func identityWhileStarting() async throws {
        let vectors = try ParticipantVectors.load()
        let world = try await Self.oneRun()
        defer { world.clean() }
        world.launcher.prepare(script: Self.script)
        let gate = world.availability.hold()
        let first = Self.sending(world, .participantStart, Self.start(), id: Self.id(1))
        #expect(await waitUntil { gate.arrived > 0 }, "the start is in its availability recheck")
        #expect(await world.coordinator.phase(of: Self.runId(1)) == "starting")

        let status = await Self.send(world, .participantStatus, Self.read())
        #expect(status.fields["state"] == .string("starting") && status.fields["lastSequence"] == .number(0))
        let events = await Self.send(world, .participantEvents, Self.events())
        #expect(events.outcome == .ok && events.fields["events"] == .array([]) && events.fields["lastSequence"] == .number(0))
        let again = await Self.send(world, .participantStart, Self.start(), id: Self.id(1))
        #expect(again.outcome == .unknown, "the same bytes while starting: \(again.jsonValue)")
        let changed = await Self.send(world, .participantStart, Self.start(chunks: ["Invented changed question."]), id: Self.id(1))
        #expect(changed.reason == .payloadMismatch)
        let second = await Self.send(world, .participantStart, Self.start(), id: Self.id(2))
        #expect(second.reason == .duplicateRun)
        #expect(try Self.leavesNoIdentity(world, Self.id(2)))

        var commit = try #require(try vectors.named("workspace.commitProof under a start request id").request.objectValue)
        commit["requestId"] = .string(Self.id(1))
        #expect(await world.send(.object(commit)).reason == .payloadMismatch, "a commit under a starting start's id")
        let bind = await Self.send(world, .dictationBindDraft, [
            "workspaceHandle": .string(Self.handle), "sessionId": .string(Self.sessionId(9)), "expectedRevision": .number(0),
            "expectedText": .string("Invented draft."), "selection": .object(["start": .number(0), "end": .number(0)])
        ], id: Self.id(1))
        #expect(bind.reason == .payloadMismatch, "a bind under a starting start's id: \(bind.jsonValue)")
        var reconcile = try #require(try vectors.named("workspace.reconcile for a start request id").request.objectValue)
        var target = try #require(reconcile["payload"]?.objectValue)
        target["targetRequestId"] = .string(Self.id(1))
        reconcile["payload"] = .object(target)
        #expect(await world.send(.object(reconcile)).outcome == .unknown, "reconcile of a starting id")

        gate.open()
        let accepted = try await Self.answer(first)
        #expect(accepted.outcome == .ok && accepted.fields["runId"] == .string(Self.runId(1)))
        try await world.settle()
        #expect(world.launcher.requests.count == 1)
        #expect(try Self.entry(world)["terminal"]?.objectValue?["type"] == .string("completed"))
        let replay = await Self.send(world, .participantStart, Self.start(), id: Self.id(1))
        #expect(replay.outcome == .ok && replay.fields["runId"] == .string(Self.runId(1)), "a durable record replays")
        #expect(world.launcher.requests.count == 1, "a replay launches nothing")
    }

    @Test("Codex S6 obligation: a start id only the store's published copy still reserves (the index never saw it) is unknown, claims nothing and launches nothing; once the authoritative re-read frees it, the same request starts")
    func publishedReservationOverlay() async throws {
        let reserved = Self.id(7)
        let world = try await Self.oneRun { store in
            let record = try #require(ParticipantRunStart(requestId: reserved, payloadHash: String(repeating: "a", count: 64),
                                                          at: Self.clock, launchId: "75abcdef-0000-4000-8abc-000000000001",
                                                          cliVersion: "invented-cli-version"))
            try store.recordStart(runId: Self.runId(1), record)
            // The folder loses the start; a non-authoritative reload makes
            // memory match it before the host (and the index) exist.
            var state = try #require(try JSONValue.decode(store.plainStateForTesting()).objectValue)
            var runs = try #require({ () -> [JSONValue]? in if case .array(let list)? = state["runs"] { return list }; return nil }())
            var entry = try #require(runs[0].objectValue)
            entry["start"] = .null
            runs[0] = .object(entry)
            state["runs"] = .array(runs)
            try JSONEncoder().encode(JSONValue.object(state)).writePlainState(to: store)
            _ = try store.withdrawUnresolvedDispatch(UUID())
        }
        defer { world.clean() }
        world.launcher.prepare(script: Self.script)
        let requestId = try #require(UUID(uuidString: reserved))
        #expect(world.store.publishedRuns.reservedStartRequestIds.contains(reserved), "the published copy reserves it")
        #expect(!world.hostConfiguration.identities.isStartId(requestId), "the index never saw it")
        let folder = try world.folderSnapshot()

        let reply = await Self.send(world, .participantStart, Self.start(), id: reserved)
        #expect(reply.outcome == .unknown, "\(reply.jsonValue)")
        let other = await Self.send(world, .participantStart, Self.start(chunks: ["Invented other bytes."]), id: reserved)
        #expect(other.outcome == .unknown, "its bytes are not known, so no mismatch either")
        #expect(!world.hostConfiguration.identities.isStartId(requestId), "nothing claimed")
        #expect(world.launcher.requests.isEmpty && world.executor.runs == 0)
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil)

        _ = try world.store.rereadRuns()
        #expect(!world.store.publishedRuns.reservedStartRequestIds.contains(reserved), "the authoritative re-read freed it")
        let accepted = await Self.send(world, .participantStart, Self.start(), id: reserved)
        #expect(accepted.outcome == .ok, "\(accepted.jsonValue)")
        try await world.settle()
        #expect(world.launcher.requests.count == 1)
    }

    @Test("The start record: payloadHash a526c373… for the vector request (operation plus canonical payload), this launch's id, the launcher's cliVersion, and the clock's time")
    func startRecord() async throws {
        let vectors = try ParticipantVectors.load()
        let accepted = try vectors.named("participant.start accepted")
        let request = try HostRequest(validating: accepted.request, acceptsParticipant: true)
        #expect(request.payloadHash == "a526c37374ffc71176f10125308cdc53ea97ed6939290d5e4fa443a11ca0ad0c")
        let world = try await Self.oneRun()
        defer { world.clean() }
        world.launcher.prepare(script: Self.script)
        #expect(await world.send(accepted.request).outcome == .ok)
        let start = try #require(try Self.entry(world)["start"]?.objectValue)
        #expect(start["payloadHash"] == .string(request.payloadHash))
        #expect(start["requestId"] == accepted.request.objectValue?["requestId"])
        #expect(start["launchId"] == .string(vectors.context.launchId) && start["cliVersion"] == .string(world.launcher.cliVersion))
        #expect(start["at"] == .string(Self.clock))
        let launch = try #require(world.launcher.requests.first)
        #expect(launch.model == world.hostConfiguration.pin.model && launch.inputChunks == [Self.question])
        #expect(launch.stdin == Data(Self.question.utf8) && launch.inputBytes == 58)
        try await world.settle()
    }

    // MARK: Stop during starting (section 7)

    @Test("Two Stops during the availability recheck share one terminal: the start writes nothing and is run-not-prepared, both Stops reply exited with the same stopped local-stop at sequence 1, pushed once; nothing launched")
    func stopsDuringRecheck() async throws {
        let world = try await Self.oneRun()
        defer { world.clean() }
        let gate = world.availability.hold()
        let start = Self.sending(world, .participantStart, Self.start())
        #expect(await waitUntil { gate.arrived > 0 })
        let stops = [Self.sending(world, .participantStop, Self.read()), Self.sending(world, .participantStop, Self.read())]
        #expect(await waitUntil { await world.coordinator.stopWaiters(for: Self.runId(1)) == 2 }, "both Stops wait on the start")
        gate.open()
        let refused = try await Self.answer(start)
        #expect(refused.reason == .runNotPrepared, "\(refused.jsonValue)")
        let first = try await Self.answer(stops[0])
        let second = try await Self.answer(stops[1])
        #expect(first.fields["state"] == .string("exited") && first.fields["terminal"] == second.fields["terminal"])
        #expect(first.fields["terminal"]?.objectValue?["type"] == .string("stopped") && first.fields["groupCleared"] == .null)
        #expect(world.sink.take().count == 1, "pushed once")
        let entry = try Self.entry(world)
        #expect(entry["start"] == .null && entry["terminal"]?.objectValue?["sequence"] == .number(1))
        #expect(world.launcher.requests.isEmpty)
    }

    @Test("Two Stops during the start record's write: the start replies ok, spawns nothing and records stopped local-stop at sequence 1 beside its start; both Stops reply exited with that terminal")
    func stopsDuringWrite() async throws {
        let world = try await Self.oneRun()
        defer { world.clean() }
        let faults = try #require(world.faults)
        faults.arm(.nextWrite)
        let start = Self.sending(world, .participantStart, Self.start(), id: Self.id(1))
        #expect(await faults.waitUntilHeld())
        let stops = [Self.sending(world, .participantStop, Self.read()), Self.sending(world, .participantStop, Self.read())]
        #expect(await waitUntil { await world.coordinator.stopWaiters(for: Self.runId(1)) == 2 })
        faults.release()
        #expect(try await Self.answer(start).outcome == .ok)
        let first = try await Self.answer(stops[0])
        let second = try await Self.answer(stops[1])
        #expect(first.fields["state"] == .string("exited") && first.fields["terminal"] == second.fields["terminal"])
        #expect(world.sink.take().count == 1)
        let entry = try Self.entry(world)
        #expect(entry["start"]?.objectValue?["requestId"] == .string(Self.id(1)))
        #expect(entry["terminal"]?.objectValue?["reason"] == .string("local-stop") && entry["groupCleared"] == .null)
        #expect(world.launcher.requests.isEmpty)
        let status = await Self.send(world, .participantStatus, Self.read())
        #expect(status.fields["state"] == .string("exited") && status.fields["lastSequence"] == .number(1))
        #expect(await Self.send(world, .participantStart, Self.start()).reason == .duplicateRun)
    }

    @Test("Codex Q29: the start record's write fails definitely while a Stop waits: the start is store-corrupt and the Stop records the never-dispatched stopped local-stop at sequence 1 (start null)")
    func definiteFailureWithStopWaiting() async throws {
        let world = try await Self.oneRun()
        defer { world.clean() }
        let faults = try #require(world.faults)
        faults.arm(.nextWrite)
        faults.fail(before: .rename)
        let start = Self.sending(world, .participantStart, Self.start(), id: Self.id(1))
        #expect(await faults.waitUntilHeld())
        let stop = Self.sending(world, .participantStop, Self.read())
        #expect(await waitUntil { await world.coordinator.stopWaiters(for: Self.runId(1)) == 1 })
        faults.release()
        let refused = try await Self.answer(start)
        #expect(refused.reason == .storeCorrupt, "\(refused.jsonValue)")
        let stopped = try await Self.answer(stop)
        #expect(stopped.fields["state"] == .string("exited") && stopped.fields["terminal"]?.objectValue?["sequence"] == .number(1))
        let entry = try Self.entry(world)
        #expect(entry["start"] == .null && entry["terminal"]?.objectValue?["type"] == .string("stopped"))
        #expect(try Self.leavesNoIdentity(world, Self.id(1)), "nothing was applied, so the claim went")
        #expect(world.launcher.requests.isEmpty)
    }

    @Test("A start while a never-dispatched Stop's cancellation is still being written, or undetermined, is unknown and launches nothing: whether the run was stopped is not known yet")
    func startWhileCancellationUnsettled() async throws {
        let world = try await Self.oneRun()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.prepare(script: Self.script)
        faults.arm(.nextWrite)
        let stop = Self.sending(world, .participantStop, Self.read())
        #expect(await faults.waitUntilHeld(), "the cancellation's write is in flight")
        let during = await Self.send(world, .participantStart, Self.start(), id: Self.id(1))
        #expect(during.outcome == .unknown, "while it is written: \(during.jsonValue)")
        #expect(try Self.leavesNoIdentity(world, Self.id(1)))
        faults.undeterminedFlushes = true
        faults.release()
        #expect(try await Self.answer(stop).outcome == .unknown, "the cancellation is undetermined")
        let pending = await Self.send(world, .participantStart, Self.start(), id: Self.id(2))
        #expect(pending.outcome == .unknown, "while it is pending: \(pending.jsonValue)")
        #expect(world.launcher.requests.isEmpty)
        faults.undeterminedFlushes = false
        let settled = await Self.send(world, .participantStop, Self.read())
        #expect(settled.fields["state"] == .string("exited"), "the retried terminal is durable")
        #expect(await Self.send(world, .participantStart, Self.start(), id: Self.id(3)).reason == .runNotPrepared)
        #expect(world.launcher.requests.isEmpty)
    }

    // MARK: The undetermined start record (section 7; Codex Q27, Q28)

    @Test("An undetermined start record: unknown, nothing spawned, its id still reserved; status re-reads (failing: start-uncertain at 0), events answer nothing, a new start of the run and a Stop are unknown; once a re-read finds the record, failed process-error at sequence 1 is recorded and pushed once")
    func undeterminedStartFound() async throws {
        let world = try await Self.oneRun()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.prepare(script: Self.script)
        faults.undeterminedFlushes = true
        let reply = await Self.send(world, .participantStart, Self.start(), id: Self.id(1))
        #expect(reply.outcome == .unknown)
        #expect(world.launcher.requests.isEmpty && world.sink.take().isEmpty)
        #expect(await world.coordinator.phase(of: Self.runId(1)) == "uncertain")
        #expect(world.hostConfiguration.identities.isStartId(try #require(UUID(uuidString: Self.id(1)))))

        let writes = world.executor.runs
        let events = await Self.send(world, .participantEvents, Self.events())
        #expect(events.outcome == .ok && events.fields["lastSequence"] == .number(0) && events.fields["events"] == .array([]))
        #expect(world.executor.runs == writes, "events never re-read")
        let status = await Self.send(world, .participantStatus, Self.read())
        #expect(status.fields["state"] == .string("unknown") && status.fields["unknownReason"] == .string("start-uncertain"))
        #expect(status.fields["lastSequence"] == .number(0))
        #expect(world.executor.runs == writes + 1, "status re-read, on the executor")
        #expect(await Self.send(world, .participantStart, Self.start(), id: Self.id(2)).outcome == .unknown, "a new start while unresolved")
        #expect(await Self.send(world, .participantStop, Self.read()).outcome == .unknown, "a Stop while unresolved (Codex Q28)")
        #expect(world.launcher.requests.isEmpty, "never spawned while undetermined")

        faults.undeterminedFlushes = false
        let found = await Self.send(world, .participantStatus, Self.read())
        #expect(found.fields["state"] == .string("exited") && found.fields["lastSequence"] == .number(1), "\(found.jsonValue)")
        #expect(found.fields["terminal"]?.objectValue?["reason"] == .string("process-error") && found.fields["groupCleared"] == .null)
        #expect(world.sink.take().count == 1, "pushed once")
        #expect(await Self.send(world, .participantStart, Self.start(), id: Self.id(3)).reason == .duplicateRun)
        let replay = await Self.send(world, .participantStart, Self.start(), id: Self.id(1))
        #expect(replay.outcome == .ok, "the recorded start's own bytes replay; its one event says it failed")
        #expect(world.launcher.requests.isEmpty && world.sink.take().isEmpty)
    }

    @Test("Codex Q27: when the re-read finds no record, the attempt's id is released and an explicit start with a new request id runs in the same launch; the old id is no start's any more")
    func undeterminedStartAbsent() async throws {
        let world = try await Self.oneRun()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.prepare(script: Self.script)
        let seeded = try #require(try world.runsOnDisk())
        faults.undeterminedFlushes = true
        #expect(await Self.send(world, .participantStart, Self.start(), id: Self.id(1)).outcome == .unknown)
        // The rename never reached the folder after all.
        faults.disarm()
        var state = try #require(try JSONValue.decode(world.store.plainStateForTesting()).objectValue)
        state["runs"] = .array(seeded)
        try JSONEncoder().encode(JSONValue.object(state)).writePlainState(to: world.store)

        let status = await Self.send(world, .participantStatus, Self.read())
        #expect(status.fields["state"] == .string("not-dispatched"))
        #expect(!world.hostConfiguration.identities.isStartId(try #require(UUID(uuidString: Self.id(1)))))
        let accepted = await Self.send(world, .participantStart, Self.start(), id: Self.id(2))
        #expect(accepted.outcome == .ok, "\(accepted.jsonValue)")
        try await world.settle()
        #expect(world.launcher.requests.count == 1)
        #expect(try Self.entry(world)["start"]?.objectValue?["requestId"] == .string(Self.id(2)))
    }

    @Test("Codex Q28: a Stop of an undetermined start re-reads first: the record found gives exited with failed process-error; none found gives the never-dispatched stopped local-stop")
    func stopDuringUndeterminedStart() async throws {
        for found in [true, false] {
            let world = try await Self.oneRun()
            defer { world.clean() }
            let faults = try #require(world.faults)
            let seeded = try #require(try world.runsOnDisk())
            faults.undeterminedFlushes = true
            #expect(await Self.send(world, .participantStart, Self.start(), id: Self.id(1)).outcome == .unknown)
            faults.disarm()
            if !found {
                var state = try #require(try JSONValue.decode(world.store.plainStateForTesting()).objectValue)
                state["runs"] = .array(seeded)
                try JSONEncoder().encode(JSONValue.object(state)).writePlainState(to: world.store)
            }
            let stop = await Self.send(world, .participantStop, Self.read())
            #expect(stop.fields["state"] == .string("exited"), "\(found): \(stop.jsonValue)")
            let terminal = try #require(stop.fields["terminal"]?.objectValue)
            #expect(terminal["sequence"] == .number(1))
            #expect(terminal["reason"] == .string(found ? "process-error" : "local-stop"))
            let entry = try Self.entry(world)
            #expect((entry["start"] == .null) == !found)
            #expect(world.sink.take().count == 1 && world.launcher.requests.isEmpty)
        }
    }

    // MARK: Retained events (Codex Q30)

    @Test("Codex Q30: the previous run's events stay through an availability refusal, a definite write failure and an undetermined write; a re-read that finds the record replaces them then; the earlier run's terminal stays replayable, lost replaced only before it")
    func retainedReplacement() async throws {
        let world = try await Self.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.prepare(script: Self.script)
        #expect(await Self.send(world, .participantStart, Self.start(1)).outcome == .ok)
        try await world.settle()
        _ = world.sink.take()
        func kept() async -> String? { await world.coordinator.retainedRun?.runId }
        let first = await world.coordinator.retainedRun
        #expect(first?.runId == Self.runId(1) && first?.events == 3)

        world.availability.set(SeededAvailability(seeded: ParticipantAvailabilityReport(availability: .unavailable(.overflowUnverified),
                                                                                         confirmation: nil)))
        #expect(await Self.send(world, .participantStart, Self.start(2)).reason == .participantUnavailable)
        #expect(await kept() == Self.runId(1), "an availability refusal keeps them")
        world.availability.set(SeededAvailability(seeded: ParticipantAvailabilityReport(availability: .available, confirmation: nil)))
        faults.fail(before: .rename)
        #expect(await Self.send(world, .participantStart, Self.start(2)).reason == .storeCorrupt)
        #expect(await kept() == Self.runId(1), "a definite failure keeps them")
        faults.undeterminedFlushes = true
        #expect(await Self.send(world, .participantStart, Self.start(2), id: Self.id(4)).outcome == .unknown)
        #expect(await kept() == Self.runId(1), "an undetermined write keeps them")
        let whole = await Self.send(world, .participantEvents, Self.events(1))
        #expect((whole.fields["events"].map { if case .array(let list) = $0 { return list.count } else { return 0 } }) == 3)

        faults.undeterminedFlushes = false
        let status = await Self.send(world, .participantStatus, Self.read(2))
        #expect(status.fields["terminal"]?.objectValue?["reason"] == .string("process-error"))
        #expect(await kept() == Self.runId(2), "the re-read found the record: replaced now")
        let earlier = await Self.send(world, .participantEvents, Self.events(1))
        let lost = try #require(earlier.fields["lost"]?.objectValue)
        #expect(lost["reason"] == .string("replaced") && lost["fromSequence"] == .number(1) && lost["throughSequence"] == .number(2))
        #expect(earlier.fields["terminal"]?.objectValue?["type"] == .string("completed"), "the recorded terminal is never gone")
        #expect(world.launcher.requests.count == 1)
    }

    @Test("Codex Q30, late: an undetermined start record found only after another run started keeps that newer run's events; the found run's failed terminal is still recorded, pushed and replayable")
    func lateReReadKeepsNewerRun() async throws {
        let world = try await Self.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.prepare(script: Self.script)
        faults.undeterminedFlushes = true
        #expect(await Self.send(world, .participantStart, Self.start(1), id: Self.id(1)).outcome == .unknown)
        faults.undeterminedFlushes = false
        // An undetermined start record blocks no other run; this start's
        // own folder flush makes the first record durable too.
        #expect(await Self.send(world, .participantStart, Self.start(2), id: Self.id(2)).outcome == .ok)
        try await world.settle()
        _ = world.sink.take()
        #expect(await world.coordinator.retainedRun?.runId == Self.runId(2))

        let status = await Self.send(world, .participantStatus, Self.read(1))
        #expect(status.fields["terminal"]?.objectValue?["reason"] == .string("process-error"), "\(status.jsonValue)")
        #expect(world.sink.take().count == 1)
        let kept = await world.coordinator.retainedRun
        #expect(kept?.runId == Self.runId(2) && kept?.events == 3, "the newer run's events stay")
        let newer = await Self.send(world, .participantEvents, Self.events(2))
        #expect((newer.fields["events"].map { if case .array(let list) = $0 { return list.count } else { return 0 } }) == 3)
        let found = await Self.send(world, .participantEvents, Self.events(1))
        #expect((found.fields["events"].map { if case .array(let list) = $0 { return list.count } else { return 0 } }) == 1)
        #expect(found.fields["lost"] == .null)
        #expect(world.launcher.requests.count == 1)
    }

    // MARK: Spawn failures (sections 7 and 8)

    @Test("A launch that throws: ok, failed process-error at sequence 1 with groupCleared null, pushed once; status exited; nothing blocks the next start")
    func spawnThrows() async throws {
        struct InventedLaunchFailure: Error {}
        let world = try await Self.twoRuns()
        defer { world.clean() }
        world.launcher.failLaunches(with: InventedLaunchFailure())
        let reply = await Self.send(world, .participantStart, Self.start(1))
        #expect(reply.outcome == .ok && reply.fields["runId"] == .string(Self.runId(1)))
        let pushed = world.sink.take()
        #expect(pushed.count == 1 && pushed.first?.objectValue?["event"]?.objectValue?["reason"] == .string("process-error"))
        let entry = try Self.entry(world)
        #expect(entry["terminal"]?.objectValue?["sequence"] == .number(1) && entry["groupCleared"] == .null && entry["start"] != .null)
        let status = await Self.send(world, .participantStatus, Self.read(1))
        #expect(status.fields["state"] == .string("exited"))
        world.launcher.failLaunches(with: nil)
        world.launcher.prepare(script: Self.script)
        #expect(await Self.send(world, .participantStart, Self.start(2)).outcome == .ok, "not busy")
        try await world.settle()
    }

    @Test("A supervisor that cannot spawn the CLI: ok, then failed process-error at sequence 1, recorded with the cleanup evidence the run reports")
    func spawnFailed() async throws {
        let world = try await Self.oneRun()
        defer { world.clean() }
        world.launcher.prepare(script: [], mode: .spawnFails)
        #expect(await Self.send(world, .participantStart, Self.start()).outcome == .ok)
        try await world.settle()
        let pushed = world.sink.take().compactMap { $0.objectValue?["event"]?.objectValue }
        #expect(pushed.count == 1 && pushed.first?["sequence"] == .number(1) && pushed.first?["reason"] == .string("process-error"))
        let run = try #require(world.launcher.runs.first)
        let entry = try Self.entry(world)
        #expect(entry["terminal"]?.objectValue?["reason"] == .string("process-error"))
        #expect(entry["groupCleared"] == (run.terminalUpdate?.groupCleared.map(JSONValue.bool) ?? .null))
        let status = await Self.send(world, .participantStatus, Self.read())
        #expect(status.fields["state"] == .string("exited"), "\(status.jsonValue)")
    }

    // MARK: Reads while a start holds the store

    @Test("Status, events, Stop and availability answer while the start record's write holds ProofStore's lock: starting, nothing emitted, the Stop waits on the start (not the lock), the other run not-dispatched; no read used the executor")
    func readsDuringHeldWrite() async throws {
        let world = try await Self.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        faults.arm(.nextWrite)
        let start = Self.sending(world, .participantStart, Self.start(1))
        #expect(await faults.waitUntilHeld())
        let writes = world.executor.runs
        let status = await Self.send(world, .participantStatus, Self.read(1))
        let events = await Self.send(world, .participantEvents, Self.events(1))
        let other = await Self.send(world, .participantStatus, Self.read(2))
        let otherEvents = await Self.send(world, .participantEvents, Self.events(2))
        let availability = await Self.send(world, .participantAvailability, [:])
        let stop = Self.sending(world, .participantStop, Self.read(1))
        #expect(await waitUntil { await world.coordinator.stopWaiters(for: Self.runId(1)) == 1 })
        #expect(faults.isHolding, "every answer came while the write held the store's lock")
        #expect(status.fields["state"] == .string("starting"))
        #expect(events.outcome == .ok && events.fields["lastSequence"] == .number(0))
        #expect(other.fields["state"] == .string("not-dispatched") && otherEvents.outcome == .ok)
        #expect(availability.outcome == .ok)
        #expect(world.executor.runs == writes, "no read wrote")
        faults.release()
        #expect(try await Self.answer(start).outcome == .ok)
        #expect(try await Self.answer(stop).fields["state"] == .string("exited"))
        #expect(world.launcher.requests.isEmpty)
    }

    // MARK: The busy guard and section 17 (Codex S5 rulings)

    /// A coordinator over `world`'s stack whose runs are driven by hand, on
    /// the world's virtual clock. Its confirmation owner is `owner`, its
    /// wake-ups the world's timeline and its store work the world's
    /// executor, unless a test passes others (Codex S8 R1's held owner and
    /// held wake-ups; Codex S9-R1's executor held before the store).
    struct Manual {
        let world: VectorWorld
        let launcher = ManualLauncher()
        let owner = RecordingConfirmationOwner()
        let coordinator: ParticipantCoordinator

        init(_ world: VectorWorld, confirmation: (any ParticipantConfirmationOwning)? = nil,
             wakeups: (any ParticipantWakeups)? = nil, executor: (any MutationExecutor)? = nil) async throws {
            self.world = world
            coordinator = ParticipantCoordinator(configuration: ParticipantCoordinator.Configuration(
                hostConfiguration: world.hostConfiguration, availability: world.availability,
                launchId: try ParticipantVectors.load().context.launchId, clock: world.virtual.clock,
                executor: executor ?? world.executor,
                launcher: launcher, log: world.log, wakeups: wakeups ?? VirtualWakeups(world: world.virtual),
                confirmation: confirmation ?? owner))
            await world.coordinator.detach()
            try await coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        }

        func send(_ operation: HostOperation, _ payload: [String: JSONValue], connection: String? = nil) async throws -> HostResponse {
            var request = try #require(ParticipantCoordinatorReadTests.request(operation, payload, world: world).objectValue)
            if let connection { request["connectionId"] = .string(connection) }
            return await coordinator.handle(try HostRequest(validating: .object(request), acceptsParticipant: true))
        }

        /// `send`, bounded: a request that should answer at once (a Stop
        /// that must not wait on the run) fails the test instead of hanging
        /// it.
        func ask(_ operation: HostOperation, _ payload: [String: JSONValue]) async throws -> HostResponse {
            let task = Task { try? await send(operation, payload) }
            return try #require(await value(of: task) ?? nil, "answered within \(vectorWaitSeconds) s")
        }

        func applied(_ count: Int, run: Int = 1) async -> Bool {
            await waitUntil { await coordinator.consumption(of: runId(run))?.applied == count }
        }

        /// The run's updates finished and every write they queued returned
        /// (Codex Q31: updates are applied to memory at once and their
        /// writes run behind them), and, unless `revocations` is false, every
        /// claimed confirmation revocation returned from the owner (Codex S8
        /// R1: a late end makes its call after the end is published; the
        /// tests that hold the owner pass false).
        func finished(run: Int = 1, revocations: Bool = true) async -> Bool {
            await waitUntil {
                guard await coordinator.consumption(of: runId(run))?.finished == true else { return false }
                guard !(await coordinator.isWriting) else { return false }
                guard revocations else { return true }
                return !(await coordinator.isRevoking)
            }
        }

        func event(_ sequence: Int, _ type: ParticipantEventType, reason: String? = nil, run: Int = 1) -> ParticipantEvent {
            ParticipantEvent(runId: runId(run), sessionId: sessionId(run), sequence: sequence, at: clock, type: type, reason: reason)
        }

        func state(run: Int = 1) async throws -> JSONValue? {
            try await send(.participantStatus, read(run)).fields["state"]
        }

        func busy() async throws -> Bool {
            let reply = try await send(.participantStart, start(2))
            return reply.reason == .participantBusy
        }
    }

    @Test("Step 12: busy while running, after the terminal until cleanup is released, and after that until the updates finish (delayed EOF); then admitted, with no confirmation ended; status follows running, then exited as soon as the terminal says the group cleared (never cleanup-pending with groupCleared true)")
    func busyUntilUpdatesFinish() async throws {
        let world = try await Self.twoRuns()
        defer { world.clean() }
        let manual = try await Manual(world)
        #expect(try await manual.send(.participantStart, Self.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        #expect(try await manual.state() == .string("running"))
        #expect(try await manual.busy(), "running")
        run.send(.event(manual.event(1, .started)))
        run.send(.terminal(manual.event(2, .completed), groupCleared: true))
        #expect(await manual.applied(2))
        let ended = try await manual.send(.participantStatus, Self.read(1))
        #expect(ended.fields["state"] == .string("exited") && ended.fields["groupCleared"] == .bool(true), "\(ended.jsonValue)")
        #expect(ended.fields["lastSequence"] == .number(2))
        #expect(try await manual.busy(), "a terminal, cleanup not released")
        run.send(.cleanupReleased)
        #expect(await manual.applied(3))
        #expect(try await manual.state() == .string("exited"))
        #expect(try await manual.busy(), "cleanup released, updates not finished")
        try world.virtual.advance(to: world.virtual.now + 2_000)
        #expect(try await manual.busy(), "still unfinished two seconds on")
        run.finish()
        #expect(await manual.finished())
        #expect(try await manual.send(.participantStart, Self.start(2)).outcome == .ok, "admitted once both are done")
        #expect(manual.owner.paidOverflowEnds == 0, "finished within five seconds: nothing ended")
        #expect(world.virtual.obligation() == nil, "the five-second wake-up was cancelled")
    }

    @Test("A late overflow observation after the terminal and after cleanup-released ends the confirmation once, in its order; starts stay busy until the updates finish, and the five-second rule adds no second end")
    func lateOverflowSignal() async throws {
        let world = try await Self.twoRuns()
        defer { world.clean() }
        let manual = try await Manual(world)
        #expect(try await manual.send(.participantStart, Self.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        run.send(.event(manual.event(1, .started)))
        run.send(.terminal(manual.event(2, .failed, reason: "timeout"), groupCleared: true))
        run.send(.cleanupReleased)
        #expect(await manual.applied(3))
        #expect(manual.owner.paidOverflowEnds == 0)
        run.send(.overflowObserved)
        #expect(await manual.applied(4))
        #expect(manual.owner.paidOverflowEnds == 1, "the late signal ended it")
        #expect(try await manual.busy())
        try world.virtual.advance(to: world.virtual.now + 6_000)
        #expect(manual.owner.paidOverflowEnds == 1, "once")
        run.finish()
        #expect(await manual.finished())
        #expect(try await manual.send(.participantStart, Self.start(2)).outcome == .ok)
    }

    @Test("Updates unfinished five monotonic seconds after cleanup-released: the confirmation ends exactly at +5,000 ms, once; starts stay busy until the updates finish; a reconnect, a new generation and a detach and attach change none of it")
    func openPipesPastFiveSeconds() async throws {
        let world = try await Self.twoRuns()
        defer { world.clean() }
        let manual = try await Manual(world)
        #expect(try await manual.send(.participantStart, Self.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        run.send(.event(manual.event(1, .started)))
        run.send(.terminal(manual.event(2, .completed), groupCleared: true))
        run.send(.cleanupReleased)
        #expect(await manual.applied(3))
        let released = world.virtual.now
        try world.virtual.advance(to: released + 4_999)
        #expect(manual.owner.paidOverflowEnds == 0)
        try world.virtual.advance(to: released + 5_000)
        #expect(manual.owner.paidOverflowEnds == 1, "monotonic +5,000 ms")
        #expect(await manual.coordinator.confirmationEvidence(of: Self.runId(1))?.ended == true)
        #expect(try await manual.busy(), "busy until the updates finish or the app quits")

        await world.host.beginGeneration()
        let fresh = await world.host.issueConnection()
        let reconnected = try await manual.send(.participantStart, Self.start(2), connection: fresh.id)
        #expect(reconnected.reason == .participantBusy, "\(reconnected.jsonValue)")
        await manual.coordinator.detach()
        try await manual.coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        let reattached = try await manual.send(.participantStart, Self.start(2), connection: fresh.id)
        #expect(reattached.reason == .participantBusy)
        try world.virtual.advance(to: world.virtual.now + 10_000)
        #expect(manual.owner.paidOverflowEnds == 1, "never again")
        run.finish()
        #expect(await manual.finished())
        #expect(try await manual.send(.participantStart, Self.start(2), connection: fresh.id).outcome == .ok)
        #expect(manual.owner.paidOverflowEnds == 1)
    }

    @Test("R1-f: updates that finish without cleanup-released (a lost supervisor, a failed read) leave the run cleanup-pending and every start busy; a Stop sends nothing (no supervisor), waits for nothing and answers cleanup-pending with groupCleared false at once; with no release there is no five-second end")
    func finishWithoutRelease() async throws {
        let world = try await Self.twoRuns()
        defer { world.clean() }
        let manual = try await Manual(world)
        #expect(try await manual.send(.participantStart, Self.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        run.send(.event(manual.event(1, .started)))
        run.send(.terminal(manual.event(2, .failed, reason: "process-error"), groupCleared: false))
        run.finish()
        #expect(await manual.finished())
        #expect(try await manual.state() == .string("cleanup-pending"))
        #expect(try await manual.busy())
        // Updates finished is not cleanup released: a Stop answers from
        // memory at once ("stop() false": nothing was sent).
        let stop = try await manual.ask(.participantStop, Self.read(1))
        #expect(stop.fields["state"] == .string("cleanup-pending") && stop.fields["groupCleared"] == .bool(false), "\(stop.jsonValue)")
        #expect(stop.fields["terminal"]?.objectValue?["reason"] == .string("process-error"))
        #expect(await manual.coordinator.processWaiters == 0, "nothing waits on the run")
        #expect(run.stopCalls == 1)
        #expect(try await manual.busy(), "still cleanup-pending")
        try world.virtual.advance(to: world.virtual.now + 10_000)
        #expect(try await manual.busy(), "until the app quits")
        #expect(manual.owner.paidOverflowEnds == 0)
    }

    @Test("Basic ownership (S9): Stop of a running run this launch spawned signals once, first, and waits for its terminal; status reads stopping meanwhile; a second Stop joins without signalling; both answer the one terminal; once ended and released a Stop is exited and signals nothing")
    func liveStopSignalsOnce() async throws {
        let world = try await Self.twoRuns()
        defer { world.clean() }
        let manual = try await Manual(world)
        #expect(try await manual.send(.participantStart, Self.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        run.send(.event(manual.event(1, .started)))
        #expect(await manual.applied(1))
        let first = Task { try? await manual.send(.participantStop, Self.read(1)) }
        #expect(await waitUntil { await manual.coordinator.processWaiters == 1 })
        #expect(run.stopCalls == 1, "signalled before anything else")
        let status = try await manual.send(.participantStatus, Self.read(1))
        #expect(status.fields["state"] == .string("stopping") && status.fields["lastSequence"] == .number(1), "\(status.jsonValue)")
        let second = Task { try? await manual.send(.participantStop, Self.read(1)) }
        #expect(await waitUntil { await manual.coordinator.processWaiters == 2 })
        #expect(run.stopCalls == 1, "the second Stop joins the first")
        run.send(.terminal(manual.event(2, .stopped, reason: "local-stop"), groupCleared: true))
        let one = try #require(await value(of: first) ?? nil, "answered within \(vectorWaitSeconds) s")
        let two = try #require(await value(of: second) ?? nil, "answered within \(vectorWaitSeconds) s")
        #expect(one.fields["state"] == .string("exited") && one.fields["groupCleared"] == .bool(true), "\(one.jsonValue)")
        #expect(one.fields["terminal"]?.objectValue?["reason"] == .string("local-stop"))
        #expect(one.fields == two.fields, "one terminal")
        run.send(.cleanupReleased)
        run.finish()
        #expect(await manual.finished())
        let stop = try await manual.ask(.participantStop, Self.read(1))
        #expect(stop.fields["state"] == .string("exited") && stop.fields["terminal"] == one.fields["terminal"])
        #expect(run.stopCalls == 1, "an ended run is never signalled")
    }

    @Test("Scripted end to end: a run whose stdout EOF never comes ends the confirmation five seconds after its cleanup is released, through the real reader and supervisor engine; the next start is busy until the EOF arrives")
    func scriptedHeldEOF() async throws {
        let world = try await Self.twoRuns()
        defer { world.clean() }
        world.launcher.prepare(script: Self.script)
        #expect(await Self.send(world, .participantStart, Self.start(1)).outcome == .ok)
        let run = try #require(world.launcher.runs.first)
        run.holdPipeEOF()
        try await world.settle()
        #expect(run.terminalUpdate?.event.type == .completed && !run.isFinished)
        #expect(world.confirmation.paidOverflowEnds == 1, "five seconds after cleanup-released")
        // The group cleared at +310; with stdout's EOF held, the reader
        // decides the terminal after its 1 s exit-decision grace, and the
        // run's cleanup is released with it (+1,310). The wake-up is five
        // seconds after that (+6,310), and settling ends there.
        #expect(run.system.reports.first { $0.message == .cleared }?.at == 310)
        #expect(world.virtual.wallNow == "2026-10-09T00:01:07.310Z", "settled at the wake-up: \(world.virtual.wallNow)")
        #expect(await Self.send(world, .participantStart, Self.start(2)).reason == .participantBusy)
        run.releasePipeEOF()
        #expect(await world.drain())
        world.launcher.prepare(script: Self.script)
        #expect(await Self.send(world, .participantStart, Self.start(2)).outcome == .ok)
        try await world.settle()
        #expect(world.confirmation.paidOverflowEnds == 1)
    }

    @Test("An earlier launch's dispatched run with no recorded exit never blocks a start")
    func earlierLaunchNeverBlocks() async throws {
        let world = try await Self.twoRuns(earlierLaunchStartedRunOne: true)
        defer { world.clean() }
        world.launcher.prepare(script: Self.script)
        #expect(await Self.send(world, .participantStatus, Self.read(1)).fields["unknownReason"] == .string("exit-unrecorded"))
        #expect(await Self.send(world, .participantStart, Self.start(2)).outcome == .ok)
        try await world.settle()
        #expect(await Self.send(world, .participantStart, Self.start(1)).reason == .duplicateRun)
    }

    // MARK: A never-spawned run's terminal that fails definitely (S8-2)

    /// After a definite failure of the `failed`/`stopped` terminal of a run
    /// whose start record is durable: no memory is lost. Nothing pushed;
    /// status `unknown` `start-uncertain` at 0 and events nothing at 0
    /// (they agree); a new start `duplicate-run`; the next Stop retries the
    /// same terminal and replies with it, pushed once; then `exited` at 1.
    static func keepsTheFailedTerminal(_ world: VectorWorld, reason: String, startId: String,
                                       sourceLocation: SourceLocation = #_sourceLocation) async throws {
        let entry = try Self.entry(world)
        #expect(entry["start"]?.objectValue?["requestId"] == .string(startId) && entry["terminal"] == .null,
                "the start is durable, the terminal is not", sourceLocation: sourceLocation)
        #expect(world.sink.take().isEmpty, "nothing pushed before the terminal is durable", sourceLocation: sourceLocation)
        #expect(await world.coordinator.phase(of: Self.runId(1)) == nil, sourceLocation: sourceLocation)
        let status = await Self.send(world, .participantStatus, Self.read())
        #expect(status.fields["state"] == .string("unknown") && status.fields["unknownReason"] == .string("start-uncertain"),
                "never an earlier launch's exit-unrecorded: \(status.jsonValue)", sourceLocation: sourceLocation)
        #expect(status.fields["lastSequence"] == .number(0) && status.fields["terminal"] == .null, sourceLocation: sourceLocation)
        let events = await Self.send(world, .participantEvents, Self.events())
        #expect(events.outcome == .ok && events.fields["events"] == .array([]) && events.fields["lastSequence"] == .number(0),
                "events agree with status: \(events.jsonValue)", sourceLocation: sourceLocation)
        #expect(await Self.send(world, .participantStart, Self.start(), id: Self.id(8)).reason == .duplicateRun,
                sourceLocation: sourceLocation)
        let replay = await Self.send(world, .participantStart, Self.start(), id: startId)
        #expect(replay.outcome == .ok, "the durable start record replays: \(replay.jsonValue)", sourceLocation: sourceLocation)

        let retried = await Self.send(world, .participantStop, Self.read())
        #expect(retried.fields["state"] == .string("exited") && retried.fields["groupCleared"] == .null,
                "a Stop retries the same terminal: \(retried.jsonValue)", sourceLocation: sourceLocation)
        let terminal = try #require(retried.fields["terminal"]?.objectValue, sourceLocation: sourceLocation)
        #expect(terminal["sequence"] == .number(1) && terminal["reason"] == .string(reason), sourceLocation: sourceLocation)
        #expect(world.sink.take().count == 1, "pushed once", sourceLocation: sourceLocation)
        #expect(try Self.entry(world)["terminal"]?.objectValue?["reason"] == .string(reason), sourceLocation: sourceLocation)
        let exited = await Self.send(world, .participantStatus, Self.read())
        #expect(exited.fields["state"] == .string("exited") && exited.fields["lastSequence"] == .number(1), sourceLocation: sourceLocation)
        let again = await Self.send(world, .participantStop, Self.read())
        #expect(again.fields["terminal"] == retried.fields["terminal"] && world.sink.take().isEmpty, "the one terminal",
                sourceLocation: sourceLocation)
    }

    @Test("A Stop at or after step 14 whose stopped local-stop write fails definitely: the start is ok, the waiting Stop store-corrupt; the run keeps that terminal (start-uncertain, never not-owned or exit-unrecorded) until a later Stop makes it durable")
    func stopAfterStep14WriteFails() async throws {
        let world = try await Self.oneRun()
        defer { world.clean() }
        let faults = try #require(world.faults)
        faults.arm(.nextWrite)
        faults.fail(before: .rename, skipping: 1)
        let start = Self.sending(world, .participantStart, Self.start(), id: Self.id(1))
        #expect(await faults.waitUntilHeld())
        let stop = Self.sending(world, .participantStop, Self.read())
        #expect(await waitUntil { await world.coordinator.stopWaiters(for: Self.runId(1)) == 1 })
        faults.release()
        #expect(try await Self.answer(start).outcome == .ok)
        let refused = try await Self.answer(stop)
        #expect(refused.reason == .storeCorrupt, "Codex Q28: a definite failure is store-corrupt: \(refused.jsonValue)")
        try await Self.keepsTheFailedTerminal(world, reason: "local-stop", startId: Self.id(1))
        #expect(world.launcher.requests.isEmpty)
    }

    @Test("A launch that throws and whose failed process-error write fails definitely: the start is still ok; the run keeps that terminal until a Stop makes it durable; nothing blocks the next run")
    func spawnThrowsWriteFails() async throws {
        struct InventedLaunchFailure: Error {}
        let world = try await Self.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        world.launcher.failLaunches(with: InventedLaunchFailure())
        faults.fail(before: .rename, skipping: 1)
        let reply = await Self.send(world, .participantStart, Self.start(1), id: Self.id(1))
        #expect(reply.outcome == .ok && reply.fields["runId"] == .string(Self.runId(1)), "\(reply.jsonValue)")
        try await Self.keepsTheFailedTerminal(world, reason: "process-error", startId: Self.id(1))
        world.launcher.failLaunches(with: nil)
        world.launcher.prepare(script: Self.script)
        #expect(await Self.send(world, .participantStart, Self.start(2)).outcome == .ok, "not busy")
        try await world.settle()
    }

    @Test("Codex Q28: a re-read that finds an undetermined start record, whose failed process-error write then fails definitely: the Stop that made the re-read answers store-corrupt (a status that made it answers start-uncertain); the run keeps that terminal until a later Stop makes it durable")
    func rereadFoundWriteFails() async throws {
        for trigger in [HostOperation.participantStop, .participantStatus] {
            let world = try await Self.oneRun()
            defer { world.clean() }
            let faults = try #require(world.faults)
            faults.undeterminedFlushes = true
            #expect(await Self.send(world, .participantStart, Self.start(), id: Self.id(1)).outcome == .unknown)
            faults.disarm()
            faults.fail(before: .rename)
            let reply = await Self.send(world, trigger, Self.read())
            if trigger == .participantStop {
                #expect(reply.reason == .storeCorrupt, "never not-owned: \(reply.jsonValue)")
            } else {
                #expect(reply.fields["unknownReason"] == .string("start-uncertain"), "\(reply.jsonValue)")
            }
            #expect(await world.coordinator.isWriting == false)
            try await Self.keepsTheFailedTerminal(world, reason: "process-error", startId: Self.id(1))
            #expect(world.launcher.requests.isEmpty)
        }
    }

    // MARK: Section 17 timing and wiring (S8-3, S8-7)

    @Test("Codex Q31 with section 17: with the terminal's store write held, every update is still applied at once and status and Stop answer exited with groupCleared true (never cleanup-pending); with the stream left open, the confirmation ends at +5,000 ms after cleanup-released arrived, the write still held")
    func fiveSecondsWhileTerminalWriteHeld() async throws {
        let world = try await Self.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        let manual = try await Manual(world)
        #expect(try await manual.send(.participantStart, Self.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        faults.arm(.nextWrite)
        run.send(.event(manual.event(1, .started)))
        run.send(.terminal(manual.event(2, .completed), groupCleared: true))
        run.send(.cleanupReleased)
        #expect(await faults.waitUntilHeld(), "the terminal's write holds the store")
        #expect(await waitUntil { world.virtual.obligation() != nil }, "the wake-up is armed on arrival")
        let released = world.virtual.now
        // Codex Q31: every update is applied to memory at once; only the
        // terminal's write waits, behind them.
        #expect(await waitUntil { await manual.coordinator.consumption(of: Self.runId(1))?.applied == 3 })
        #expect(await manual.coordinator.persistence(of: Self.runId(1))?.terminalDurable == false, "the terminal's write is still held")

        let status = try await manual.send(.participantStatus, Self.read(1))
        #expect(status.fields["state"] == .string("exited") && status.fields["groupCleared"] == .bool(true), "\(status.jsonValue)")
        #expect(status.fields["lastSequence"] == .number(2) && status.fields["terminal"]?.objectValue?["sequence"] == .number(2))
        let stop = try await manual.ask(.participantStop, Self.read(1))
        #expect(stop.fields["state"] == .string("exited") && stop.fields["groupCleared"] == .bool(true), "\(stop.jsonValue)")
        #expect(try await manual.busy())

        try world.virtual.advance(to: released + 4_999)
        #expect(manual.owner.paidOverflowEnds == 0)
        try world.virtual.advance(to: released + 5_000)
        #expect(manual.owner.paidOverflowEnds == 1, "five seconds after cleanup-released arrived, the stream still open")
        #expect(faults.isHolding)
        run.finish()
        faults.release()
        #expect(await manual.finished())
        #expect(await manual.coordinator.consumption(of: Self.runId(1))?.applied == 3)
        #expect(try await manual.send(.participantStart, Self.start(2)).outcome == .ok)
        #expect(manual.owner.paidOverflowEnds == 1, "once")
        #expect(faults.holdTimeouts == 0)
    }

    @Test("S9's change to S8's as-built rule (Codex Q31): a held store write alone no longer ends the confirmation: the stream finishes within five seconds of cleanup-released while the terminal's write is held, so nothing ends at +5,000 ms or later; starts stay busy until the write returns, then are admitted")
    func heldWriteAloneNeverEndsTheConfirmation() async throws {
        let world = try await Self.twoRuns()
        defer { world.clean() }
        let faults = try #require(world.faults)
        let manual = try await Manual(world)
        #expect(try await manual.send(.participantStart, Self.start(1)).outcome == .ok)
        let run = try #require(manual.launcher.runs.first)
        faults.arm(.nextWrite)
        run.send(.event(manual.event(1, .started)))
        run.send(.terminal(manual.event(2, .completed), groupCleared: true))
        run.send(.cleanupReleased)
        run.finish()
        #expect(await faults.waitUntilHeld(), "the terminal's write holds the store")
        let released = world.virtual.now
        #expect(await waitUntil { await manual.coordinator.consumption(of: Self.runId(1))?.finished == true },
                "every update applied and the end seen, the write still held")
        #expect(await manual.coordinator.persistence(of: Self.runId(1))?.terminalDurable == false)
        #expect(world.virtual.obligation() == nil, "the stream's end cancelled the wake-up")
        try world.virtual.advance(to: released + 10_000)
        #expect(manual.owner.paidOverflowEnds == 0, "S8 ended it here, conservatively; S9 does not")
        #expect(await manual.coordinator.confirmationEvidence(of: Self.runId(1))?.ended == false)
        #expect(try await manual.busy(), "the write is unresolved")
        #expect(faults.isHolding)
        faults.release()
        #expect(await manual.finished())
        #expect(try await manual.send(.participantStart, Self.start(2)).outcome == .ok)
        #expect(manual.owner.paidOverflowEnds == 0)
        #expect(faults.holdTimeouts == 0)
    }

    @Test("A coordinator with no section 17 owner never pairs an available answer with a confirmation: availability is overflow-unverified with the display kept, and a start is participant-unavailable, launching and writing nothing")
    func confirmationWithoutOwner() async throws {
        let world = try await Self.oneRun()
        defer { world.clean() }
        let launcher = ManualLauncher()
        let coordinator = ParticipantCoordinator(configuration: ParticipantCoordinator.Configuration(
            hostConfiguration: world.hostConfiguration, availability: world.availability,
            launchId: try ParticipantVectors.load().context.launchId, clock: world.virtual.clock, executor: world.executor,
            launcher: launcher, log: world.log))
        await world.coordinator.detach()
        try await coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        func send(_ operation: HostOperation, _ payload: [String: JSONValue]) async throws -> HostResponse {
            let request = ParticipantCoordinatorReadTests.request(operation, payload, world: world)
            return await coordinator.handle(try HostRequest(validating: request, acceptsParticipant: true))
        }
        let active = try #require(ParticipantConfirmationDisplay.active(confirmedAt: Self.clock, runsLeft: 5))
        world.availability.set(SeededAvailability(seeded: ParticipantAvailabilityReport(availability: .available, confirmation: active)))
        let folder = try world.folderSnapshot()
        let writes = world.executor.runs

        let availability = try await send(.participantAvailability, [:])
        guard case .array(let entries)? = availability.fields["participants"] else {
            Issue.record("no participants: \(availability.jsonValue)")
            return
        }
        let entry = try #require(entries.first?.objectValue)
        #expect(entry["available"] == .bool(false) && entry["reason"] == .string("overflow-unverified"), "\(entry)")
        #expect(entry["confirmation"] == active.jsonValue, "the display is kept")
        let start = try await send(.participantStart, Self.start())
        #expect(start.reason == .participantUnavailable, "\(start.jsonValue)")
        #expect(launcher.runs.isEmpty && world.executor.runs == writes)
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil)

        // Without a confirmation the report passes as it is.
        world.availability.set(SeededAvailability(seeded: ParticipantAvailabilityReport(availability: .available, confirmation: nil)))
        #expect(try await send(.participantStart, Self.start()).outcome == .ok)
        #expect(launcher.runs.count == 1)
        launcher.runs.first?.finish()
    }

    @Test("A detach during the availability recheck with a Stop waiting writes nothing to the stack let go: the start and the Stop answer unknown-connection; attached again, the run is still not dispatched")
    func detachDuringRecheckWithStopWaiting() async throws {
        let world = try await Self.oneRun()
        defer { world.clean() }
        let gate = world.availability.hold()
        let start = Self.sending(world, .participantStart, Self.start(), id: Self.id(1))
        #expect(await waitUntil { gate.arrived > 0 })
        let stop = Self.sending(world, .participantStop, Self.read())
        #expect(await waitUntil { await world.coordinator.stopWaiters(for: Self.runId(1)) == 1 })
        let folder = try world.folderSnapshot()
        await world.coordinator.detach()
        gate.open()
        #expect(try await Self.answer(start).reason == .unknownConnection)
        #expect(try await Self.answer(stop).reason == .unknownConnection)
        #expect(VectorReplay.folderChange(folder, try world.folderSnapshot()) == nil, "nothing written to the stack let go")
        #expect(world.sink.take().isEmpty && world.launcher.requests.isEmpty)
        #expect(try Self.leavesNoIdentity(world, Self.id(1)))
        try await world.coordinator.attach(host: world.host, store: world.store, connections: world.connections, sink: world.sink)
        #expect(await Self.send(world, .participantStatus, Self.read()).fields["state"] == .string("not-dispatched"))
    }

    @Test("DispatchParticipantWakeups fires once at or after its monotonic time and never once cancelled")
    func dispatchWakeups() async throws {
        let clock = SystemParticipantClock()
        let wakeups = DispatchParticipantWakeups(clock: clock)
        let fired = ResultBox<UInt64>()
        let start = clock.monotonicMillis()
        _ = wakeups.wake(atMonotonicMillis: start + 30) { fired.set(clock.monotonicMillis()) }
        let cancelled = ResultBox<Bool>()
        let never = wakeups.wake(atMonotonicMillis: start + 30) { cancelled.set(true) }
        never.cancel()
        #expect(await waitUntil(seconds: 5) { fired.value != nil })
        #expect((fired.value ?? 0) >= start + 30)
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(cancelled.value == nil)
    }
}
