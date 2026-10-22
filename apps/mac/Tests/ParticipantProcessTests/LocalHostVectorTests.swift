import Foundation
import Testing
@testable import DeskHost
@testable import LocalModelRoute
@testable import ParticipantCoordinator
@testable import ParticipantProcess

// The seeded host cases of `native-participant-local-v1.json` (contract
// section 20.5; step 3 PR 4c): each case is replayed through the real
// `HostRouter`, `DeskHostProtocol`, `ParticipantCoordinator` and
// `ProofStore` (the section 19 harness, `VectorWorld`), with the host's
// local route the real `OllamaClient` talking HTTP to `VectorOllama`, a fake
// Ollama on a random loopback port. Nothing reaches the network or a real
// Ollama, and all text is invented.
//
// What a host case may say, beyond section 19:
// - `seed.localRoute` (`{state, reason, models}`): the fake's catalog and
//   whether it answers. Required at the root; a later case may change it.
// - `seed.script`: fake-server steps. `retag` and `alias-swap` arm the
//   fake's next `/api/copy`; `http-200`, `chunk` (`text`, optional
//   `repeat`), `done`, `http-error` (`status`), `redirect` and `drop`
//   answer the chat request of the run the case starts, in order, after its
//   reply.
// - `ollama`: every request the fake received during the case, in order,
//   as `{method, path, body}`. The root's list begins with the launch's own
//   alias sweep, which the harness waits for before the first request.
// - actions `lock`, `unlock`, `begin-generation` and `issue-connection`,
//   as section 19's.
// Virtual time stands still while a chat streams, so accepted text is one
// event, flushed by the run's end (or by Stop). Every `/api/chat` must find
// its run's start record already durable (section 20.4: receipt before
// request), or the case fails.

/// The real `LocalChatRun`, its updates relayed and counted, so the harness
/// knows when the coordinator has consumed them all. Its stops are counted
/// too: the real run carries a stop out later, on its own queue, so a stop
/// asked for (by a lock, say) has not ended the run when `stop()` returns.
/// And the reply body bytes it has taken in (`LocalChatRun`'s test seam), so
/// the harness knows when it has read everything the fake sent.
final class VectorLocalRun: ParticipantRunning, @unchecked Sendable {
    let runId: String
    let updates: AsyncStream<ParticipantRunUpdate>
    private let inner: any ParticipantRunning
    private let lock = NSLock()
    private var count = 0
    private var ended = false
    private var stops = 0
    private var body = 0

    init(_ inner: any ParticipantRunning, runId: String) {
        self.inner = inner
        self.runId = runId
        var continuation: AsyncStream<ParticipantRunUpdate>.Continuation!
        updates = AsyncStream(bufferingPolicy: .unbounded) { continuation = $0 }
        let relay = continuation!
        Task { [inner] in
            for await update in inner.updates {
                self.note()
                relay.yield(update)
            }
            self.end()
            relay.finish()
        }
    }

    var yielded: Int { lock.lock(); defer { lock.unlock() }; return count }
    var finished: Bool { lock.lock(); defer { lock.unlock() }; return ended }
    /// Whether anything asked this run to stop.
    var stopAsked: Bool { lock.lock(); defer { lock.unlock() }; return stops > 0 }
    /// Reply body bytes the run has taken in so far.
    var bodyBytes: Int { lock.lock(); defer { lock.unlock() }; return body }
    var snapshot: ParticipantRunSnapshot { inner.snapshot }

    @discardableResult
    func stop() -> Bool {
        lock.lock(); stops += 1; lock.unlock()
        return inner.stop()
    }

    private func note() { lock.lock(); count += 1; lock.unlock() }
    func noteBody(_ total: Int) { lock.lock(); body = total; lock.unlock() }
    private func end() { lock.lock(); ended = true; lock.unlock() }
}

/// The real client on the fake's port; every chat run it starts is kept.
final class VectorLocalRoute: LocalRouteLaunching, @unchecked Sendable {
    let client: OllamaClient
    private let lock = NSLock()
    private var launched: [VectorLocalRun] = []

    init(port: UInt16) { client = OllamaClient(endpoint: OllamaEndpoint(port: port)) }

    var runs: [VectorLocalRun] { lock.lock(); defer { lock.unlock() }; return launched }

    func localCatalog() async -> LocalCatalogAnswer { await client.localCatalog() }
    func bindAlias(_ participant: ParticipantPin, runId: String) async -> LocalAliasBinding {
        await client.bindAlias(participant, runId: runId)
    }
    func deleteAlias(runId: String) async { await client.deleteAlias(runId: runId) }
    func sweepAliases(keepingRunIds: Set<String>) async { await client.sweepAliases(keepingRunIds: keepingRunIds) }

    func launchLocal(_ request: LocalRunLaunch, clock: any ParticipantClock) -> any ParticipantRunning {
        let inner = client.launchLocal(request, clock: clock)
        let run = VectorLocalRun(inner, runId: request.identity.runId)
        // Before any reply: the fake answers only when the harness plays it.
        (inner as? LocalChatRun)?.setBodyTakenIn { [weak run] total in run?.noteBody(total) }
        lock.lock(); launched.append(run); lock.unlock()
        return run
    }
}

/// The local file's host cases (those with a `seed`), in section 19's form.
struct LocalHostVectors {
    static let caseKeys: Set<String> = ["name", "seed", "request", "reply", "pushed", "afterRuns", "inFlight", "actions", "ollama"]

    /// The section 19 vectors with the local file's `records`: the context
    /// (connection, generation, handle, pin, launch) is the same in both.
    let base: ParticipantVectors
    /// Every case of the local file, numbered from 1 as the file lists them.
    let cases: [ParticipantVectors.Case]
    let ollama: [Int: [JSONValue]]

    var hostCases: [ParticipantVectors.Case] { cases.filter { !$0.seed.isEmpty } }

    static func load() throws -> LocalHostVectors {
        guard let url = Bundle.module.url(forResource: "native-participant-local-v1", withExtension: "json") else {
            throw VectorHarnessError.fixture("the bundled local vectors are missing")
        }
        guard let root = try JSONValue.decode(Data(contentsOf: url)).objectValue, case .array(let values)? = root["cases"],
              let records = root["records"]?.objectValue else {
            throw VectorHarnessError.fixture("the local vectors have no cases or records")
        }
        var base = try ParticipantVectors.load()
        base.records = try records.mapValues { value in
            guard let record = value.objectValue else { throw VectorHarnessError.fixture("a local record is not an object") }
            return record
        }
        var ollama: [Int: [JSONValue]] = [:]
        let cases = try values.enumerated().map { offset, value -> ParticipantVectors.Case in
            let number = offset + 1
            guard let fields = value.objectValue, let name = fields["name"]?.stringValue, let request = fields["request"],
                  let reply = fields["reply"] else { throw VectorHarnessError.fixture("local case #\(number) lacks name, request or reply") }
            func list(_ key: String) throws -> [JSONValue]? {
                guard let present = fields[key] else { return nil }
                guard case .array(let items) = present else { throw VectorHarnessError.fixture("local #\(number) \(key) is not a list") }
                return items
            }
            let seed = fields["seed"]?.objectValue ?? [:]
            if !seed.isEmpty {
                if let extra = Set(fields.keys).subtracting(caseKeys).sorted().first {
                    throw VectorHarnessError.unsupported("local #\(number) case key \(extra)")
                }
                guard let calls = try list("ollama") else { throw VectorHarnessError.fixture("local #\(number) states no ollama calls") }
                ollama[number] = calls
            }
            var inFlight: ParticipantVectors.Case.InFlight?
            if let value = fields["inFlight"] {
                guard let held = value.objectValue, let heldRequest = held["request"], let heldReply = held["reply"] else {
                    throw VectorHarnessError.fixture("local #\(number) inFlight")
                }
                inFlight = .init(request: heldRequest, reply: heldReply)
            }
            let actions = try (list("actions") ?? []).map { value in
                guard let action = value.stringValue else { throw VectorHarnessError.fixture("local #\(number) action") }
                return action
            }
            return ParticipantVectors.Case(number: number, name: name, seed: seed, request: request, reply: reply,
                                           pushed: try list("pushed"), afterRuns: try list("afterRuns"), keys: Set(fields.keys),
                                           inFlight: inFlight, actions: actions)
        }
        return LocalHostVectors(base: base, cases: cases, ollama: ollama)
    }

    func chain(to target: ParticipantVectors.Case) throws -> [ParticipantVectors.Case] {
        var chain = [target]
        var seen: Set<String> = [target.name]
        while let parent = chain[0].afterCase {
            guard seen.insert(parent).inserted, let found = cases.first(where: { $0.name == parent }) else {
                throw VectorHarnessError.fixture("local #\(target.number) afterCase \(parent)")
            }
            chain.insert(found, at: 0)
        }
        return chain
    }
}

/// Replays one host case and checks everything it states.
enum LocalHostReplay {
    static let localSeedKeys: Set<String> = ["localRoute", "script"]
    static let chatSteps: Set<String> = ["http-200", "chunk", "done", "http-error", "redirect", "drop"]
    static let armedSteps: Set<String> = ["retag", "alias-swap"]
    static let actions: Set<String> = ["lock", "unlock", "begin-generation", "issue-connection"]

    static func run(_ target: ParticipantVectors.Case, in vectors: LocalHostVectors) async throws {
        let chain = try vectors.chain(to: target)
        guard let rootRoute = chain[0].seed["localRoute"] else {
            throw VectorHarnessError.fixture("local #\(chain[0].number) a root without localRoute")
        }
        for step in chain {
            if let action = step.actions.first(where: { !actions.contains($0) }) {
                throw VectorHarnessError.unsupported("local #\(step.number) action \(action)")
            }
        }
        let ollama = try VectorOllama()
        defer { ollama.shutDown() }
        try ollama.configure(rootRoute)
        let route = VectorLocalRoute(port: ollama.port)
        let root = chain[0]
        let firstClock = chain.lazy.compactMap { $0.seed["clock"]?.stringValue }.first
        let world = try await VectorWorld(seed: hostSeed(root.seed), number: root.number, operation: root.operation,
                                          vectors: vectors.base, clock: firstClock, localRoute: route)
        defer { world.clean() }
        world.localDrain = { await drained(route, world: world) }
        // Receipt before request (section 20.4): when a chat arrives, its
        // run's start record is already in the store's durable copy.
        let early = ResultBox<String>()
        let store = world.store
        ollama.onChat = { body in
            let alias = body.objectValue?["model"]?.stringValue
            let recorded = store.publishedRuns.runs.contains { entry in
                entry.start?.cliVersion == "ollama-local" && entry.terminal == nil && OllamaAlias.name(forRunId: entry.runId) == alias
            }
            if !recorded { early.set("a chat for \(alias ?? "?") arrived before its start record was durable") }
        }
        // The launch's own alias sweep finishes before the first request.
        if ollama.mode != .notRunning {
            guard await waitUntil({ !ollama.calls.isEmpty && !ollama.names.contains(where: OllamaAlias.isAlias) }) else {
                throw VectorHarnessError.mismatch("local #\(root.number) the launch sweep never ran")
            }
        }
        await quiet { ollama.calls.count }

        for (index, step) in chain.enumerated() {
            let label = index == chain.count - 1 ? "local #\(step.number)" : "local ancestor #\(step.number) \(step.name)"
            if index > 0 {
                ollama.clearCalls()
                if let changed = step.seed["localRoute"] { try ollama.configure(changed) }
                try world.prepare(seed: hostSeed(step.seed), number: step.number, isRoot: false)
            }
            var chat: [JSONValue] = []
            if case .array(let steps)? = step.seed["script"] {
                for value in steps {
                    let kind = value.objectValue?["kind"]?.stringValue ?? ""
                    if chatSteps.contains(kind) {
                        chat.append(value)
                    } else if armedSteps.contains(kind) {
                        try ollama.arm(value)
                    } else {
                        throw VectorHarnessError.unsupported("\(label) script step \(kind)")
                    }
                }
            } else if step.seed["script"] != nil {
                throw VectorHarnessError.fixture("\(label) script is not a list")
            }
            // Section 19's stack actions, as `VectorWorld` drives them.
            for action in step.actions {
                switch action {
                case "lock":
                    world.coordinator.lockNow()
                    await world.host.lock()
                case "unlock":
                    let epoch = world.coordinator.lockEpoch
                    await world.host.unlock()
                    await world.coordinator.unlock(ifNoLockSince: epoch)
                case "begin-generation":
                    await world.host.beginGeneration()
                default:
                    guard let id = step.request.objectValue?["connectionId"]?.stringValue else {
                        throw VectorHarnessError.unsupported("\(label) issue-connection with no request connection")
                    }
                    await world.host.issueConnection(adopting: id)
                }
                try await world.settle()
            }
            var driven = step
            driven.actions = []
            let outcome = try await world.drive(driven)
            if !chat.isEmpty {
                guard step.operation == HostOperation.participantStart.rawValue, outcome.reply.outcome == .ok else {
                    throw VectorHarnessError.unsupported("\(label) chat steps for a request that started nothing")
                }
                try await play(chat, ollama: ollama, route: route, world: world, label: label)
            }
            try await world.settle()
            let full = VectorWorld.Outcome(before: outcome.before, reply: outcome.reply, inFlightReply: outcome.inFlightReply,
                                           atReply: outcome.atReply, runsAtReply: outcome.runsAtReply,
                                           pushed: outcome.pushed + world.sink.take())
            try compare("\(label) reply", full.reply.jsonValue, step.reply)
            if let inFlight = step.inFlight {
                guard let reply = full.inFlightReply else { throw VectorHarnessError.mismatch("\(label) no in-flight reply") }
                try compare("\(label) in-flight reply", reply.jsonValue, inFlight.reply)
            }
            if let expected = step.pushed { try compare("\(label) pushed", .array(full.pushed), .array(expected)) }
            if let expected = step.afterRuns {
                guard let runs = try world.runsOnDisk() else { throw VectorHarnessError.mismatch("\(label) no readable state.json") }
                try compare("\(label) runs", .array(runs), .array(expected))
            }
            let expectedCalls = vectors.ollama[step.number] ?? []
            _ = await waitUntil { ollama.calls.count >= expectedCalls.count }
            await quiet { ollama.calls.count }
            try compare("\(label) ollama", .array(ollama.calls), .array(expectedCalls))
            if let problem = early.value { throw VectorHarnessError.mismatch("\(label) \(problem)") }
            if index == chain.count - 1 { try VectorReplay.checkTarget(target, full, world: world) }
        }
        // The folder reopens ready and publishes exactly the runs on disk.
        let runsAfter = try world.runsOnDisk()
        let reopened = try await world.reopen()
        guard reopened.status == .ready else { throw VectorHarnessError.mismatch("the store reopens \(reopened.status)") }
        try compare("reopened runs", .array(reopened.runs ?? []), .array(runsAfter ?? []))
    }

    /// The seed `VectorWorld` reads: everything but the local route's keys.
    static func hostSeed(_ seed: [String: JSONValue]) -> [String: JSONValue] {
        seed.filter { !localSeedKeys.contains($0.key) }
    }

    /// Answers the newest run's chat request step by step, each step's
    /// effect taken in before the next.
    static func play(_ steps: [JSONValue], ollama: VectorOllama, route: VectorLocalRoute, world: VectorWorld,
                     label: String) async throws {
        guard let run = route.runs.last else { throw VectorHarnessError.unsupported("\(label) no local run to answer") }
        let index = route.runs.count - 1
        guard await waitUntil({ ollama.chats.count > index }) else {
            throw VectorHarnessError.mismatch("\(label) the chat request never reached the fake Ollama")
        }
        let chat = ollama.chats[index]
        // Reply body bytes sent so far: a chunk is taken in once the run has
        // read them all, or has ended (a run past a bound stops reading).
        var sent = 0
        for step in steps {
            guard let fields = step.objectValue, let kind = fields["kind"]?.stringValue else { throw VectorHarnessError.fixture("\(label) step") }
            let ended: Bool
            switch kind {
            case "http-200":
                // URLSession hands the status over only with the body's
                // first bytes, so `started` comes with the next step.
                chat.head()
                ended = true
            case "chunk":
                guard Set(fields.keys).isSubset(of: ["kind", "text", "repeat"]), let text = fields["text"]?.stringValue else {
                    throw VectorHarnessError.fixture("\(label) chunk is {kind, text, repeat?}")
                }
                let count = fields["repeat"]?.safeIntegerValue ?? 1
                sent += chat.line(["message": ["role": "assistant", "content": String(repeating: text, count: count)], "done": false])
                let target = sent
                ended = await waitUntil { run.bodyBytes >= target || run.finished }
            case "done":
                sent += chat.line(["message": ["role": "assistant", "content": ""], "done": true, "done_reason": "stop"])
                chat.end()
                chat.close()
                ended = await waitUntil { run.finished }
            case "http-error":
                guard let status = fields["status"]?.safeIntegerValue else { throw VectorHarnessError.fixture("\(label) http-error status") }
                chat.answer(VectorOllama.answer(status, Data(#"{"error":"invented failure"}"#.utf8)))
                ended = await waitUntil { run.finished }
            case "redirect":
                chat.answer(VectorOllama.head(307, length: 0, extra: "Location: http://127.0.0.1:9/invented-elsewhere\r\n"))
                ended = await waitUntil { run.finished }
            case "drop":
                chat.close()
                ended = await waitUntil { run.finished }
            default:
                throw VectorHarnessError.unsupported("\(label) chat step \(kind)")
            }
            guard ended else { throw VectorHarnessError.mismatch("\(label) the run never took in \(kind)") }
            try await world.settle()
        }
    }

    /// Every local run's updates applied (and their end seen once it ended).
    /// A run that has its terminal, or was asked to stop, counts only once
    /// its updates have ended: a stop is carried out on the run's own queue
    /// after `stop()` returns, so without this a lock's stop could still be
    /// on its way when the harness unlocks, and its text and `stopped` would
    /// then go to the connection issued after the unlock (the contract's
    /// S10 reading allows that; the vectors state the stop finished while
    /// locked).
    static func drained(_ route: VectorLocalRoute, world: VectorWorld) async -> Bool {
        for run in route.runs {
            guard let consumed = await world.coordinator.consumption(of: run.runId) else { continue }
            if consumed.applied < run.yielded || (run.finished && !consumed.finished) { return false }
            if run.snapshot.terminal != nil || run.stopAsked, !run.finished { return false }
        }
        return true
    }

    /// Waits until `count` has not moved for 100 ms (at most five seconds).
    static func quiet(_ count: () -> Int) async {
        for _ in 0..<50 {
            let before = count()
            try? await Task.sleep(nanoseconds: 100_000_000)
            if count() == before { return }
        }
    }

    static func compare(_ label: String, _ actual: JSONValue, _ expected: JSONValue) throws {
        guard actual.canonicalData() != expected.canonicalData() else { return }
        throw VectorHarnessError.mismatch("\(label):\n  expected \(String(decoding: expected.canonicalData(), as: UTF8.self))\n"
                                          + "  actual   \(String(decoding: actual.canonicalData(), as: UTF8.self))")
    }
}

@Suite("Shared local vectors: seeded host cases against a fake Ollama (contract section 20.5; step 3 PR 4c)", .serialized)
struct LocalHostVectorTests {
    @Test("Every seeded host case replays through the real coordinator, store and Ollama client, exactly as stated")
    func everyHostCase() async throws {
        let vectors = try LocalHostVectors.load()
        let cases = vectors.hostCases
        #expect(cases.count == 26, "the file's seeded host cases")
        for target in cases {
            do {
                try await LocalHostReplay.run(target, in: vectors)
            } catch {
                Issue.record("local #\(target.number) \(target.name): \(error)")
            }
        }

    }
}
