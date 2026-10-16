import Foundation
import Testing
@testable import DeskHost
@testable import LocalModelRoute
@testable import ParticipantCoordinator
@testable import ParticipantProcess

// Step 3 PR 3c: the local start through the real coordinator and the real
// store (contract section 20.4), with Ollama played by `ScriptedLocalRoute`:
// a fake at the route seam that records every call in order, keeps the set
// of aliases it holds, and hands out runs driven by the real `LocalChatCore`.
// The real `OllamaClient` side of the seam is tested against a fake server in
// LocalModelRouteTests, and once against the owner's Ollama by the opt-in
// smoke test below. Invented text only.

/// One local run whose HTTP side a test plays: the real `LocalChatCore`,
/// fed by the test instead of a socket.
final class ScriptedLocalRun: ParticipantRunning, @unchecked Sendable {
    let updates: AsyncStream<ParticipantRunUpdate>
    let launch: LocalRunLaunch
    private let continuation: AsyncStream<ParticipantRunUpdate>.Continuation
    private let lock = NSLock()
    private let clock: any ParticipantClock
    private var core: LocalChatCore
    private var cancelled = false
    private var finished = false

    init(launch: LocalRunLaunch, clock: any ParticipantClock) {
        self.launch = launch
        self.clock = clock
        core = LocalChatCore(identity: launch.identity, contextBytes: launch.contextBytes, inputBytes: launch.inputBytes,
                             preparedBytes: launch.preparedBytes)
        core.requestSent(monotonic: clock.monotonicMillis())
        var continuation: AsyncStream<ParticipantRunUpdate>.Continuation!
        updates = AsyncStream(bufferingPolicy: .unbounded) { continuation = $0 }
        self.continuation = continuation
    }

    var snapshot: ParticipantRunSnapshot {
        lock.lock(); defer { lock.unlock() }
        return core.snapshot
    }

    var requestCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelled
    }

    @discardableResult
    func stop() -> Bool {
        drive { $0.stopRequested(monotonic: clock.monotonicMillis(), wall: clock.wallMillis()) }
        return true
    }

    func respond(_ status: Int = 200) {
        drive { $0.response(status: status, monotonic: clock.monotonicMillis(), wall: clock.wallMillis()) }
    }

    func send(_ text: String) {
        let line = (try! JSONSerialization.data(withJSONObject: ["message": ["role": "assistant", "content": text], "done": false]))
        drive { $0.bytes([UInt8](line) + [0x0A], monotonic: clock.monotonicMillis(), wall: clock.wallMillis()) }
    }

    func done() {
        let line = (try! JSONSerialization.data(withJSONObject: ["message": ["role": "assistant", "content": ""], "done": true]))
        drive { $0.bytes([UInt8](line) + [0x0A], monotonic: clock.monotonicMillis(), wall: clock.wallMillis()) }
    }

    /// The connection dropped mid-reply.
    func drop() {
        drive { $0.finished(.failed, monotonic: clock.monotonicMillis(), wall: clock.wallMillis()) }
    }

    private func drive(_ step: (inout LocalChatCore) -> [LocalChatCore.Effect]) {
        lock.lock(); defer { lock.unlock() }
        guard !finished else { return }
        for effect in step(&core) {
            switch effect {
            case .update(let update): continuation.yield(update)
            case .cancelRequest: cancelled = true
            }
        }
        if core.isFinished {
            finished = true
            continuation.finish()
        }
    }
}

/// Ollama at the route seam. Every call is recorded in order; `aliases` is
/// the set of run aliases Ollama would hold. Hooks run inside a call, so a
/// test can lock, stop or retag at an exact point.
final class ScriptedLocalRoute: LocalRouteLaunching, @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [LocalCatalogAnswer]
    private var recorded: [String] = []
    private var held: Set<String>
    private var launched: [ScriptedLocalRun] = []
    var bindResult: LocalAliasBinding?
    var onBind: (@Sendable () async -> Void)?
    var onLaunch: (@Sendable (LocalRunLaunch) -> Void)?

    /// Each catalog read takes the next answer; the last one repeats.
    init(_ answers: [LocalCatalogAnswer], leftoverAliases: Set<String> = []) {
        self.answers = answers
        held = leftoverAliases
    }

    /// The answers from now on (a preparing commit reads the catalog too).
    func answer(_ next: [LocalCatalogAnswer]) { lock.lock(); answers = next; lock.unlock() }

    var calls: [String] { lock.lock(); defer { lock.unlock() }; return recorded }
    var aliases: Set<String> { lock.lock(); defer { lock.unlock() }; return held }
    var runs: [ScriptedLocalRun] { lock.lock(); defer { lock.unlock() }; return launched }

    private func note(_ call: String) { lock.lock(); recorded.append(call); lock.unlock() }

    func localCatalog() async -> LocalCatalogAnswer {
        lock.lock(); defer { lock.unlock() }
        recorded.append("tags")
        return answers.count > 1 ? answers.removeFirst() : answers[0]
    }

    func bindAlias(_ participant: ParticipantPin, runId: String) async -> LocalAliasBinding {
        note("bind")
        let result = bindResult ?? .bound(alias: OllamaAlias.name(forRunId: runId) ?? "")
        // A copy that ran leaves the alias, whatever the check after it saw.
        lock.lock(); held.insert(runId); lock.unlock()
        if let onBind { await onBind() }
        return result
    }

    func deleteAlias(runId: String) async {
        lock.lock(); recorded.append("delete"); held.remove(runId); lock.unlock()
    }

    func sweepAliases(keepingRunIds: Set<String>) async {
        lock.lock(); recorded.append("sweep"); held = held.intersection(keepingRunIds); lock.unlock()
    }

    func launchLocal(_ request: LocalRunLaunch, clock: any ParticipantClock) -> any ParticipantRunning {
        note("chat")
        onLaunch?(request)
        let run = ScriptedLocalRun(launch: request, clock: clock)
        lock.lock(); launched.append(run); lock.unlock()
        return run
    }
}

/// A store with an earlier completed local turn and a prepared local run
/// that names it as context, and a coordinator whose host has `route`.
final class LocalStartWorld {
    static let localPin = ParticipantPin(id: "ollama-local", label: "invented-local-small:7b",
                                         model: "invented-local-small:7b@" + String(repeating: "c3", count: 32),
                                         executionHost: "this-mac")!
    static let sessionId = "52abcdef-0000-4000-8abc-000000000901"
    static let earlierRunId = "71abcdef-0000-4000-8abc-000000000801"
    static let runId = "71abcdef-0000-4000-8abc-000000000901"
    static let earlierInput = "My invented bakery is called Maple Crumb."
    static let earlierOutput = "Noted: Maple Crumb."
    static let input = ["What is my invented bakery ", "called?"]
    static let createdAt = "2026-10-15T07:00:00.000Z"

    let world: VectorWorld
    let route: ScriptedLocalRoute
    let host: DeskHostProtocol
    let coordinator: ParticipantCoordinator
    let generation: Int
    private(set) var revision = 0

    init(route: ScriptedLocalRoute) async throws {
        let vectors = try ParticipantVectors.load()
        world = try await VectorWorld(seed: [:], number: 0, operation: "participant.start", vectors: vectors)
        self.route = route
        let configuration = ParticipantHostConfiguration(pin: world.hostConfiguration.pin, identities: world.hostConfiguration.identities,
                                                         localRoute: route)
        host = DeskHostProtocol(store: world.store, connections: world.connections, drafts: DraftBindingRegistry(),
                                info: VectorWorld.info, events: world.sink, participants: configuration)
        let report = ParticipantAvailabilityReport(availability: .unavailable(.overflowUnverified), confirmation: nil)
        coordinator = ParticipantCoordinator(configuration: .init(
            hostConfiguration: configuration, availability: SeededAvailability(seeded: report), launchId: vectors.context.launchId,
            clock: world.virtual.clock, executor: world.executor, launcher: world.launcher, log: world.log))
        try await coordinator.attach(host: host, store: world.store, connections: world.connections, sink: world.sink)
        generation = world.connections.validConnections().generation
    }

    func clean() { world.clean() }

    static func run(_ runId: String, user: String, assistant: String, input: [String], phase: String,
                    context: [String]?) -> JSONValue {
        var run: [String: JSONValue] = [
            "version": .number(1), "runId": .string(runId), "sessionId": .string(sessionId),
            "userMessageId": .string(user), "assistantMessageId": .string(assistant), "participant": localPin.jsonValue,
            "inputChunks": .array(input.map(JSONValue.string)), "outputChunks": .array([]), "lastSequence": .number(0),
            "phase": .string(phase), "createdAt": .string(createdAt), "updatedAt": .string(createdAt)]
        if let context { run["contextRunIds"] = .array(context.map(JSONValue.string)) }
        return .object(run)
    }

    static var earlierPrepared: JSONValue {
        run(earlierRunId, user: "72abcdef-0000-4000-8abc-000000000801", assistant: "73abcdef-0000-4000-8abc-000000000801",
            input: [earlierInput], phase: "prepared", context: [])
    }

    static func earlierCompleted(output: String = earlierOutput) -> JSONValue {
        guard case .object(var run) = earlierPrepared else { return .null }
        run["phase"] = .string("completed")
        run["outputChunks"] = .array([.string(output)])
        run["lastSequence"] = .number(3)
        run["updatedAt"] = .string("2026-10-15T07:00:05.000Z")
        return .object(run)
    }

    static var prepared: JSONValue {
        run(runId, user: "72abcdef-0000-4000-8abc-000000000901", assistant: "73abcdef-0000-4000-8abc-000000000901",
            input: input, phase: "prepared", context: [earlierRunId])
    }

    /// The page's three commits: the earlier turn prepared, then completed,
    /// then the new turn prepared with the earlier one as context.
    func prepare() async throws {
        try await commit([Self.earlierPrepared], claim: Self.earlierRunId)
        try await commit([Self.earlierCompleted()], claim: nil)
        try await commit([Self.earlierCompleted(), Self.prepared], claim: Self.runId)
    }

    func commit(_ runs: [JSONValue], claim: String?) async throws {
        var payload: [String: JSONValue] = [
            "workspaceHandle": .string(world.store.workspaceHandle), "expectedRevision": .number(Double(revision)),
            "record": .object(["schemaVersion": .number(2), "revision": .number(Double(revision + 1)),
                               "conversationRuns": .array(runs)])]
        if let claim, let run = runs.first(where: { $0.objectValue?["runId"] == .string(claim) })?.objectValue {
            var fields: [String: JSONValue] = ["participantId": .string("ollama-local"), "createdAt": .string(Self.createdAt)]
            for key in ["runId", "sessionId", "userMessageId", "assistantMessageId"] { fields[key] = run[key] }
            payload["participantRun"] = .object(fields)
        }
        let reply = await host.handle(HostRequest(requestId: UUID(), connectionId: world.connectionId, generation: generation,
                                                  operation: .workspaceCommitProof, payload: payload))
        guard reply.outcome == .ok else { throw LocalStartTestError.commit("\(reply)") }
        revision += 1
    }

    var startPayload: [String: JSONValue] {
        ["workspaceHandle": .string(world.store.workspaceHandle), "runId": .string(Self.runId), "sessionId": .string(Self.sessionId),
         "userMessageId": .string("72abcdef-0000-4000-8abc-000000000901"),
         "assistantMessageId": .string("73abcdef-0000-4000-8abc-000000000901"),
         "participant": Self.localPin.jsonValue, "inputChunks": .array(Self.input.map(JSONValue.string))]
    }

    func ask(_ operation: HostOperation, _ payload: [String: JSONValue], requestId: UUID = UUID()) async -> HostResponse {
        await coordinator.handle(HostRequest(requestId: requestId, connectionId: world.connectionId, generation: generation,
                                             operation: operation, payload: payload))
    }

    func start(requestId: UUID = UUID()) async -> HostResponse { await ask(.participantStart, startPayload, requestId: requestId) }

    func stop() async -> HostResponse {
        await ask(.participantStop, ["workspaceHandle": .string(world.store.workspaceHandle), "runId": .string(Self.runId),
                                     "sessionId": .string(Self.sessionId)])
    }

    var entry: ParticipantRunEntry? { world.store.publishedRuns.entry(for: Self.runId) }
}

enum LocalStartTestError: Error { case commit(String) }

/// Polls until `condition` holds, for at most five seconds.
@discardableResult
func eventually(_ condition: () async -> Bool) async -> Bool {
    for _ in 0..<500 {
        if await condition() { return true }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return await condition()
}

private let ready = LocalCatalogAnswer.ready([LocalCatalogEntry(participant: LocalStartWorld.localPin, available: true)])
private let movedPin = ParticipantPin(id: "ollama-local", label: "invented-local-small:7b",
                                      model: "invented-local-small:7b@" + String(repeating: "d4", count: 32), executionHost: "this-mac")!

@Suite("Local start, alias lifecycle, lock and quit (contract section 20.4; step 3 PR 3c)")
struct LocalStartTests {
    @Test("A local start re-resolves its context, binds the alias, writes the receipt, and only then sends the chat with exactly the hashed turns")
    func startsAndStreams() async throws {
        let stale = "71abcdef-0000-4000-8abc-000000000777"
        let route = ScriptedLocalRoute([ready], leftoverAliases: [stale])
        let local = try await LocalStartWorld(route: route)
        defer { local.clean() }
        try await local.prepare()
        let store = local.world.store
        let receiptBeforeChat = LockedFlag()
        route.onLaunch = { _ in
            let start = store.publishedRuns.entry(for: LocalStartWorld.runId)?.start
            receiptBeforeChat.set(start?.cliVersion == "ollama-local")
        }
        _ = local.world.sink.take()
        let before = route.calls.count
        let reply = await local.start()
        #expect(reply.outcome == .ok, "\(reply)")
        #expect(reply.fields["runId"] == .string(LocalStartWorld.runId))
        // Step 10's catalog, step 13's, the sweep before the start, the
        // bind, then the chat: nothing else, in this order. The launch's
        // own sweep came before.
        #expect(Array(route.calls.dropFirst(before)) == ["tags", "tags", "sweep", "bind", "chat"], "\(route.calls)")
        #expect(route.calls.filter { $0 == "sweep" }.count == 2)
        #expect(receiptBeforeChat.value, "the start record was durable before /api/chat")
        #expect(!route.aliases.contains(stale), "the launch sweep removed a leftover alias")
        let run = try #require(route.runs.first)
        #expect(run.launch.context == [LocalTurn(role: "user", text: LocalStartWorld.earlierInput),
                                       LocalTurn(role: "assistant", text: LocalStartWorld.earlierOutput)])
        #expect(run.launch.inputChunks == LocalStartWorld.input)
        #expect(run.launch.alias == OllamaAlias.name(forRunId: LocalStartWorld.runId))
        #expect(run.launch.contextBytes == local.entry?.context?.bytes)

        run.respond()
        run.send("Your invented bakery is Maple Crumb.")
        run.done()
        #expect(await eventually { local.entry?.terminal?.type == "completed" })
        #expect(local.entry?.groupCleared == true)
        #expect(await eventually { route.aliases.isEmpty }, "the alias is deleted after the terminal is written")
        #expect(route.calls.last == "delete")
        let pushed = local.world.sink.take().compactMap { $0.objectValue?["event"]?.objectValue?["type"]?.stringValue }
        #expect(pushed == ["started", "text", "completed"], "\(pushed)")
        let status = await local.ask(.participantStatus, ["workspaceHandle": .string(store.workspaceHandle),
                                                          "runId": .string(LocalStartWorld.runId),
                                                          "sessionId": .string(LocalStartWorld.sessionId)])
        #expect(status.fields["state"] == .string("exited"), "\(status)")
        // Not busy afterwards: the run released its cleanup with the terminal.
        #expect(await eventually { await local.coordinator.obligations() == ParticipantObligations() })
    }

    @Test("A changed earlier turn is run-mismatch at start: nothing bound, nothing recorded, nothing sent")
    func contextChanged() async throws {
        let route = ScriptedLocalRoute([ready])
        let local = try await LocalStartWorld(route: route)
        defer { local.clean() }
        try await local.prepare()
        try await local.commit([LocalStartWorld.earlierCompleted(output: "An edited invented answer."), LocalStartWorld.prepared],
                               claim: nil)
        let reply = await local.start()
        #expect(reply.reason == .runMismatch, "\(reply)")
        #expect(!route.calls.contains("bind") && !route.calls.contains("chat"), "\(route.calls)")
        #expect(local.entry?.start == nil)
    }

    @Test("Step 10: a model whose digest moved before the start is participant-changed, with no bind and no second read")
    func changedBeforeAdmission() async throws {
        let route = ScriptedLocalRoute([ready])
        let local = try await LocalStartWorld(route: route)
        defer { local.clean() }
        try await local.prepare()
        route.answer([.ready([LocalCatalogEntry(participant: movedPin, available: true)])])
        let before = route.calls.count
        let reply = await local.start()
        #expect(reply.reason == .participantChanged, "\(reply)")
        #expect(Array(route.calls.dropFirst(before)) == ["tags"])
        #expect(local.entry?.start == nil)
    }

    @Test("Step 13: a retag between the reads is participant-changed; a route that went down, or a model that became remote, is participant-unavailable; an unavailable route at step 10 is not a change")
    func recheck() async throws {
        let remote = LocalCatalogAnswer.ready([LocalCatalogEntry(participant: LocalStartWorld.localPin, available: false)])
        let down = LocalCatalogAnswer.unavailable(reason: "ollama-not-running")
        let cases: [([LocalCatalogAnswer], HostRefusal)] = [
            ([ready, .ready([LocalCatalogEntry(participant: movedPin, available: true)])], .participantChanged),
            ([ready, down], .participantUnavailable),
            ([ready, remote], .participantUnavailable),
            ([down], .participantUnavailable),
        ]
        for (answers, expected) in cases {
            let route = ScriptedLocalRoute([ready])
            let local = try await LocalStartWorld(route: route)
            defer { local.clean() }
            try await local.prepare()
            route.answer(answers)
            let reply = await local.start()
            #expect(reply.reason == expected, "\(answers): \(reply)")
            #expect(!route.calls.contains("bind") && !route.calls.contains("chat"))
            #expect(local.entry?.start == nil)
        }
    }

    @Test("A bind that finds the alias moved or the route gone refuses, deletes the alias and sends nothing")
    func bindRefused() async throws {
        for (binding, expected) in [(LocalAliasBinding.changed, HostRefusal.participantChanged),
                                    (.unavailable, .participantUnavailable)] {
            let route = ScriptedLocalRoute([ready])
            route.bindResult = binding
            let local = try await LocalStartWorld(route: route)
            defer { local.clean() }
            try await local.prepare()
            let reply = await local.start()
            #expect(reply.reason == expected)
            #expect(await eventually { route.aliases.isEmpty })
            #expect(!route.calls.contains("chat"))
            #expect(local.entry?.start == nil)
        }
    }

    @Test("A lock during the bind: nothing is written, the alias is deleted and nothing is sent")
    func lockDuringBind() async throws {
        let route = ScriptedLocalRoute([ready])
        let local = try await LocalStartWorld(route: route)
        defer { local.clean() }
        try await local.prepare()
        let coordinator = local.coordinator
        route.onBind = { coordinator.lockNow() }
        let reply = await local.start()
        #expect(reply.reason == .storeLocked, "\(reply)")
        #expect(await eventually { route.aliases.isEmpty })
        #expect(!route.calls.contains("chat"))
        #expect(local.entry?.start == nil && local.entry?.terminal == nil, "still not dispatched")
    }

    @Test("An undetermined start record sends nothing and deletes the alias")
    func undeterminedRecord() async throws {
        let route = ScriptedLocalRoute([ready])
        let local = try await LocalStartWorld(route: route)
        defer { local.clean() }
        try await local.prepare()
        local.world.faults?.undeterminedFlushes = true
        let reply = await local.start()
        #expect(reply.outcome == .unknown, "\(reply)")
        #expect(await eventually { route.aliases.isEmpty })
        #expect(!route.calls.contains("chat"))
    }

    @Test("Stop cancels the request: stopped local-stop with groupCleared true, then the alias goes")
    func stopWhileRunning() async throws {
        let route = ScriptedLocalRoute([ready])
        let local = try await LocalStartWorld(route: route)
        defer { local.clean() }
        try await local.prepare()
        #expect(await local.start().outcome == .ok)
        let run = try #require(route.runs.first)
        run.respond()
        run.send("Invented partial ")
        let reply = await local.stop()
        #expect(reply.fields["state"] == .string("exited"), "\(reply)")
        #expect(reply.fields["groupCleared"] == .bool(true))
        #expect(run.requestCancelled)
        #expect(await eventually { local.entry?.terminal?.reason == "local-stop" })
        #expect(await eventually { route.aliases.isEmpty })
    }

    @Test("A dropped connection ends the run failed process-error and the alias goes")
    func dropped() async throws {
        let route = ScriptedLocalRoute([ready])
        let local = try await LocalStartWorld(route: route)
        defer { local.clean() }
        try await local.prepare()
        #expect(await local.start().outcome == .ok)
        let run = try #require(route.runs.first)
        run.respond()
        run.send("cut ")
        run.drop()
        #expect(await eventually { local.entry?.terminal?.reason == "process-error" })
        #expect(await eventually { route.aliases.isEmpty })
    }

    @Test("Lock while running: the request is cancelled, nothing is pushed, the alias goes at once and the terminal is written at unlock")
    func lockWhileRunning() async throws {
        let route = ScriptedLocalRoute([ready])
        let local = try await LocalStartWorld(route: route)
        defer { local.clean() }
        try await local.prepare()
        #expect(await local.start().outcome == .ok)
        let run = try #require(route.runs.first)
        run.respond()
        _ = await eventually { local.world.sink.take().isEmpty == false }
        local.coordinator.lockNow()
        let epoch = local.coordinator.lockEpoch
        #expect(run.requestCancelled)
        #expect(await eventually { route.aliases.isEmpty }, "lock leaves no alias behind")
        #expect(local.entry?.terminal == nil, "held while locked")
        #expect(local.world.sink.take().isEmpty, "nothing reaches a locked document")
        await local.coordinator.unlock(ifNoLockSince: epoch)
        #expect(await eventually { local.entry?.terminal?.reason == "local-stop" })
    }

    @Test("Quit while running: stopped, written, and no alias left, inside the bound")
    func quitWhileRunning() async throws {
        let route = ScriptedLocalRoute([ready])
        let local = try await LocalStartWorld(route: route)
        defer { local.clean() }
        try await local.prepare()
        #expect(await local.start().outcome == .ok)
        let run = try #require(route.runs.first)
        run.respond()
        run.send("Invented text ")
        local.coordinator.beginShutdown(quitting: true)
        let report = await local.coordinator.finishShutdown(quitting: true)
        #expect(!report.reachedBound)
        #expect(route.aliases.isEmpty, "quit waits for the alias deletion")
        #expect(local.entry?.terminal?.reason == "local-stop")
        #expect(local.entry?.groupCleared == true)
    }

    @Test("A crash mid-reply: the next launch reads the run as exit-unrecorded and never requests it again")
    func crashMidReply() async throws {
        let route = ScriptedLocalRoute([ready])
        let local = try await LocalStartWorld(route: route)
        defer { local.clean() }
        try await local.prepare()
        let requestId = UUID()
        #expect(await local.start(requestId: requestId).outcome == .ok)
        let run = try #require(route.runs.first)
        run.respond()
        run.send("Invented text cut off ")
        // The app dies here: no terminal is written. A new launch over the
        // same folder has its own coordinator and launch id.
        await local.coordinator.detach()
        let next = ParticipantCoordinator(configuration: .init(
            hostConfiguration: local.coordinator.configuration.hostConfiguration,
            availability: SeededAvailability(seeded: ParticipantAvailabilityReport(availability: .unavailable(.overflowUnverified),
                                                                                   confirmation: nil)),
            launchId: "75abcdef-0000-4000-8abc-000000000003", clock: local.world.virtual.clock, executor: local.world.executor,
            launcher: local.world.launcher, log: local.world.log))
        try await next.attach(host: local.host, store: local.world.store, connections: local.world.connections, sink: local.world.sink)
        let status = await next.handle(HostRequest(
            requestId: UUID(), connectionId: local.world.connectionId, generation: local.generation, operation: .participantStatus,
            payload: ["workspaceHandle": .string(local.world.store.workspaceHandle), "runId": .string(LocalStartWorld.runId),
                      "sessionId": .string(LocalStartWorld.sessionId)]))
        #expect(status.fields["state"] == .string("unknown"), "\(status)")
        #expect(status.fields["unknownReason"] == .string("exit-unrecorded"), "\(status)")
        // The same start again replays its recorded `ok`; a new request id is
        // a duplicate. Neither sends anything.
        let replay = await next.handle(HostRequest(requestId: requestId, connectionId: local.world.connectionId,
                                                   generation: local.generation, operation: .participantStart,
                                                   payload: local.startPayload))
        #expect(replay.outcome == .ok)
        let again = await next.handle(HostRequest(requestId: UUID(), connectionId: local.world.connectionId,
                                                  generation: local.generation, operation: .participantStart,
                                                  payload: local.startPayload))
        #expect(again.reason == .duplicateRun, "\(again)")
        #expect(route.calls.filter { $0 == "chat" }.count == 1)
    }

    @Test("A Claude Code start on a host with a local route never reads the local catalog")
    func claudeStartReadsNoCatalog() async throws {
        let route = ScriptedLocalRoute([ready])
        let local = try await LocalStartWorld(route: route)
        defer { local.clean() }
        var payload = local.startPayload
        payload["participant"] = local.world.hostConfiguration.pin.jsonValue
        let before = route.calls.count
        let reply = await local.ask(.participantStart, payload)
        #expect(reply.outcome == .refused)
        #expect(route.calls.count == before)
    }
}

final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    var value: Bool { lock.lock(); defer { lock.unlock() }; return flag }
    func set(_ value: Bool) { lock.lock(); flag = value; lock.unlock() }
}

/// Opt-in: the whole local start against the Ollama on this Mac, with
/// invented text. Runs only with `OPEN_CONVO_OLLAMA_SMOKE=<model name>` set
/// (for example `llama3.2:3b`) and Ollama answering on 127.0.0.1:11434;
/// skipped otherwise. Prints only counts and yes/no answers, never the
/// reply's text.
@Suite("Local start against this Mac's Ollama (opt-in smoke)")
struct LocalStartSmokeTests {
    @Test("Real Ollama: the reply uses the context, the receipt comes first, and no run alias is left")
    func realOllama() async throws {
        guard let name = ProcessInfo.processInfo.environment["OPEN_CONVO_OLLAMA_SMOKE"], !name.isEmpty else { return }
        let client = OllamaClient()
        guard case .ready(let entries) = await client.localCatalog().checked,
              let entry = entries.first(where: { $0.participant.label == name && $0.available }) else {
            Issue.record("Ollama is not running or does not list \(name) as a local model")
            return
        }
        let local = try await LocalStartWorld(route: ScriptedLocalRoute([ready]))
        defer { local.clean() }
        let recorder = SmokeRoute(client: client, store: local.world.store)
        // The same world, but a host and coordinator over the real client.
        let configuration = ParticipantHostConfiguration(pin: local.world.hostConfiguration.pin,
                                                         identities: local.world.hostConfiguration.identities, localRoute: recorder)
        let host = DeskHostProtocol(store: local.world.store, connections: local.world.connections, drafts: DraftBindingRegistry(),
                                    info: VectorWorld.info, events: local.world.sink, participants: configuration)
        let report = ParticipantAvailabilityReport(availability: .unavailable(.overflowUnverified), confirmation: nil)
        let coordinator = ParticipantCoordinator(configuration: .init(
            hostConfiguration: configuration, availability: SeededAvailability(seeded: report),
            launchId: "75abcdef-0000-4000-8abc-000000000002", clock: SystemParticipantClock(), executor: local.world.executor,
            launcher: local.world.launcher, log: local.world.log))
        await local.coordinator.detach()
        try await coordinator.attach(host: host, store: local.world.store, connections: local.world.connections, sink: local.world.sink)

        func run(_ id: String, input: [String], output: [String], phase: String, context: [String]?) -> JSONValue {
            var run: [String: JSONValue] = [
                "version": .number(1), "runId": .string(id), "sessionId": .string(LocalStartWorld.sessionId),
                "userMessageId": .string("72" + id.dropFirst(2)), "assistantMessageId": .string("73" + id.dropFirst(2)),
                "participant": entry.participant.jsonValue, "inputChunks": .array(input.map(JSONValue.string)),
                "outputChunks": .array(output.map(JSONValue.string)), "lastSequence": .number(phase == "completed" ? 3 : 0),
                "phase": .string(phase), "createdAt": .string(LocalStartWorld.createdAt),
                "updatedAt": .string(phase == "completed" ? "2026-10-15T07:00:05.000Z" : LocalStartWorld.createdAt)]
            if let context { run["contextRunIds"] = .array(context.map(JSONValue.string)) }
            return .object(run)
        }
        let earlier = LocalStartWorld.earlierRunId
        let current = LocalStartWorld.runId
        let input = ["Reply with only the name of my bakery."]
        var revision = 0
        func commit(_ runs: [JSONValue], claim: String?) async -> Bool {
            var payload: [String: JSONValue] = [
                "workspaceHandle": .string(local.world.store.workspaceHandle), "expectedRevision": .number(Double(revision)),
                "record": .object(["schemaVersion": .number(2), "revision": .number(Double(revision + 1)), "conversationRuns": .array(runs)])]
            if let claim {
                payload["participantRun"] = .object([
                    "runId": .string(claim), "sessionId": .string(LocalStartWorld.sessionId),
                    "userMessageId": .string("72" + claim.dropFirst(2)), "assistantMessageId": .string("73" + claim.dropFirst(2)),
                    "participantId": .string("ollama-local"), "createdAt": .string(LocalStartWorld.createdAt)])
            }
            let reply = await host.handle(HostRequest(requestId: UUID(), connectionId: local.world.connectionId,
                                                      generation: local.generation, operation: .workspaceCommitProof, payload: payload))
            revision += 1
            return reply.outcome == .ok
        }
        let done = run(earlier, input: ["My bakery is called Maple Crumb."], output: ["Got it."], phase: "completed", context: nil)
        guard case .object(var donePrepared) = done else { return }
        donePrepared["phase"] = .string("prepared"); donePrepared["outputChunks"] = .array([]); donePrepared["lastSequence"] = .number(0)
        donePrepared["updatedAt"] = .string(LocalStartWorld.createdAt); donePrepared["contextRunIds"] = .array([])
        guard case .object(var completed) = done else { return }
        completed["contextRunIds"] = .array([])
        #expect(await commit([.object(donePrepared)], claim: earlier))
        #expect(await commit([.object(completed)], claim: nil))
        #expect(await commit([.object(completed), run(current, input: input, output: [], phase: "prepared", context: [earlier])],
                             claim: current))
        _ = local.world.sink.take()
        let start = await coordinator.handle(HostRequest(
            requestId: UUID(), connectionId: local.world.connectionId, generation: local.generation, operation: .participantStart,
            payload: ["workspaceHandle": .string(local.world.store.workspaceHandle), "runId": .string(current),
                      "sessionId": .string(LocalStartWorld.sessionId), "userMessageId": .string("72" + current.dropFirst(2)),
                      "assistantMessageId": .string("73" + current.dropFirst(2)), "participant": entry.participant.jsonValue,
                      "inputChunks": .array(input.map(JSONValue.string))]))
        #expect(start.outcome == .ok, "\(start)")
        var ended = false
        for _ in 0..<1_200 where !ended {
            ended = local.world.store.publishedRuns.entry(for: current)?.terminal != nil
            if !ended { try await Task.sleep(nanoseconds: 100_000_000) }
        }
        let events = local.world.sink.take().compactMap { $0.objectValue?["event"]?.objectValue }
        let reply = events.compactMap { $0["text"]?.stringValue }.joined()
        let terminal = local.world.store.publishedRuns.entry(for: current)?.terminal
        _ = await eventually { await recorder.aliasCount() == 0 }
        let leftover = await recorder.aliasCount()
        print("SMOKE model=\(name) terminal=\(terminal?.type ?? "none") textEvents=\(events.count - 2) replyBytes=\(reply.utf8.count) "
              + "usesContext=\(reply.lowercased().contains("maple crumb")) receiptBeforeChat=\(recorder.receiptBeforeChat) "
              + "leftoverRunAliases=\(leftover)")
        #expect(terminal?.type == "completed")
        #expect(reply.lowercased().contains("maple crumb"))
        #expect(recorder.receiptBeforeChat)
        #expect(leftover == 0)
    }
}

/// The real client, noting whether the start record was durable when the
/// chat went out, and counting run aliases from a fresh `/api/tags`.
private final class SmokeRoute: LocalRouteLaunching, @unchecked Sendable {
    let client: OllamaClient
    let store: ProofStore
    private let lock = NSLock()
    private var receiptAtChat = false

    init(client: OllamaClient, store: ProofStore) {
        self.client = client
        self.store = store
    }

    var receiptBeforeChat: Bool { lock.lock(); defer { lock.unlock() }; return receiptAtChat }

    func localCatalog() async -> LocalCatalogAnswer { await client.localCatalog() }
    func bindAlias(_ participant: ParticipantPin, runId: String) async -> LocalAliasBinding {
        await client.bindAlias(participant, runId: runId)
    }
    func deleteAlias(runId: String) async { await client.deleteAlias(runId: runId) }
    func sweepAliases(keepingRunIds: Set<String>) async { await client.sweepAliases(keepingRunIds: keepingRunIds) }
    func launchLocal(_ request: LocalRunLaunch, clock: any ParticipantClock) -> any ParticipantRunning {
        // The start record must already be in the store's durable copy.
        let recorded = store.publishedRuns.entry(for: request.identity.runId)?.start?.cliVersion == "ollama-local"
        lock.lock(); receiptAtChat = recorded; lock.unlock()
        return client.launchLocal(request, clock: clock)
    }

    func aliasCount() async -> Int {
        guard case .ok(let data) = await client.send(method: "GET", path: "api/tags", body: nil),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = root["models"] as? [[String: Any]] else { return -1 }
        return models.compactMap { $0["name"] as? String }.filter(OllamaAlias.isAlias).count
    }
}
