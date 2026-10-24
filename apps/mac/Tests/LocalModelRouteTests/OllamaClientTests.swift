import XCTest
import DeskHost
import ParticipantProcess
@testable import LocalModelRoute

/// The real URLSession paths against a fake Ollama on a random loopback port.
final class OllamaClientTests: XCTestCase {
    private let runId = "71abcdef-0000-4000-8abc-000000000001"
    private var alias: String { OllamaAlias.name(forRunId: runId)! }
    private let small = LocalModelEntry(name: "invented-small:7b", digest: Invented.digestA, isLocal: true)

    private func client(_ fake: FakeOllama) -> OllamaClient { OllamaClient(endpoint: OllamaEndpoint(port: fake.port)) }

    func testProductionReachesOnlyTheFixedLoopbackBase() {
        XCTAssertEqual(OllamaEndpoint.fixed.base.absoluteString, "http://127.0.0.1:11434")
        XCTAssertEqual(OllamaClient().endpoint, .fixed)
        let configuration = OllamaEndpoint.configuration(requestTimeout: 5)
        XCTAssertEqual(configuration.connectionProxyDictionary?.count, 0)
        XCTAssertNil(configuration.urlCache)
        XCTAssertNil(configuration.httpCookieStorage)
    }

    func testCatalogReadsTags() async throws {
        let fake = try FakeOllama { request in
            XCTAssertEqual(request.method, "GET")
            return .json(status: 200, Invented.tags([Invented.model("invented-small:7b", digest: Invented.digestA)]))
        }
        let catalog = await client(fake).catalog()
        XCTAssertEqual(catalog, .ready([small]))
        XCTAssertEqual(fake.requests.map(\.path), ["/api/tags"])
    }

    func testARedirectedCatalogIsUnreadableAndItsTargetIsNeverContacted() async throws {
        let target = try FakeOllama { _ in .json(status: 200, Invented.tags([])) }
        let fake = try FakeOllama { _ in .redirect(location: "http://127.0.0.1:\(target.port)/api/tags") }
        let catalog = await client(fake).catalog()
        XCTAssertEqual(catalog, .unavailable(.catalogUnreadable))
        XCTAssertTrue(target.requests.isEmpty)
    }

    func testNothingListeningIsOllamaNotRunning() async throws {
        let port = try ClosedPort.make()
        let catalog = await OllamaClient(endpoint: OllamaEndpoint(port: port)).catalog()
        XCTAssertEqual(catalog, .unavailable(.ollamaNotRunning))
    }

    func testBindCopiesThenChecksTheAliasDigest() async throws {
        let fake = try FakeOllama { [alias] request in
            switch request.path {
            case "/api/copy": return .json(status: 200, [:] as [String: Any])
            case "/api/tags": return .json(status: 200, Invented.tags([
                Invented.model("invented-small:7b", digest: Invented.digestA),
                Invented.model(alias, digest: Invented.digestA)]))
            default: return .json(status: 404, [:] as [String: Any])
            }
        }
        let result = await client(fake).bind(entry: small, runId: runId)
        XCTAssertEqual(result, .bound(alias: alias))
        XCTAssertEqual(fake.requests.map(\.path), ["/api/copy", "/api/tags"])
        XCTAssertEqual(fake.requests[0].json as? [String: String], ["source": "invented-small:7b", "destination": alias])
    }

    /// The retag case: the tag moved to another digest, or to a cloud model,
    /// between the catalog read and the copy. Nothing is sent; the alias goes.
    func testARetaggedModelIsChangedAndItsAliasDeleted() async throws {
        for retag in [Invented.model("x", digest: Invented.digestB), Invented.model("x", digest: Invented.digestA, remote: true)] {
            let fake = try FakeOllama { [alias] request in
                switch request.path {
                case "/api/tags":
                    var row = retag
                    row["name"] = alias
                    return .json(status: 200, Invented.tags([row]))
                default: return .json(status: 200, [:] as [String: Any])
                }
            }
            let result = await client(fake).bind(entry: small, runId: runId)
            XCTAssertEqual(result, .changed)
            XCTAssertEqual(fake.requests.map(\.path), ["/api/copy", "/api/tags", "/api/delete"])
            XCTAssertEqual(fake.requests[2].method, "DELETE")
            XCTAssertEqual(fake.requests[2].json as? [String: String], ["model": alias])
            XCTAssertFalse(fake.requests.contains { $0.path == "/api/chat" })
        }
    }

    func testBindNeverCopiesACloudEntryOrABadRunId() async throws {
        let fake = try FakeOllama()
        let cloud = LocalModelEntry(name: "invented:cloud", digest: Invented.digestA, isLocal: false)
        let cloudResult = await client(fake).bind(entry: cloud, runId: runId)
        XCTAssertEqual(cloudResult, .changed)
        let badResult = await client(fake).bind(entry: small, runId: "not-a-run-id")
        XCTAssertEqual(badResult, .changed)
        XCTAssertTrue(fake.requests.isEmpty)
    }

    func testSweepDeletesOnlyExactFormatAliasesWithoutALiveRun() async throws {
        let live = "71abcdef-0000-4000-8abc-000000000002"
        let stale = OllamaAlias.name(forRunId: runId)!
        let kept = OllamaAlias.name(forRunId: live)!
        let fake = try FakeOllama { request in
            request.path == "/api/tags"
                ? .json(status: 200, Invented.tags([Invented.model(stale, digest: Invented.digestA),
                                                     Invented.model(kept, digest: Invented.digestA),
                                                     Invented.model("open-convo-run-backup:latest", digest: Invented.digestA),
                                                     Invented.model("invented-small:7b", digest: Invented.digestA)]))
                : .json(status: 200, [:] as [String: Any])
        }
        await client(fake).sweepAliases(keeping: [live])
        let deletes = fake.requests.filter { $0.path == "/api/delete" }
        XCTAssertEqual(deletes.compactMap { $0.json?["model"] as? String }, [stale])
    }

    // MARK: Chat runs

    private func request(alias: String, context: [LocalChatTurn] = []) -> LocalChatRequest {
        LocalChatRequest(identity: ParticipantRunIdentity(runId: runId, sessionId: "52abcdef-0000-4000-8abc-000000000001",
                                                          createdAtMillis: 1_760_500_000_000),
                         alias: alias, context: context, inputChunks: ["Invented ", "question?"],
                         contextBytes: context.reduce(0) { $0 + $1.text.utf8.count }, inputBytes: 18, preparedBytes: 600)
    }

    private func collect(_ run: LocalChatRun) async -> [ParticipantRunUpdate] {
        var all: [ParticipantRunUpdate] = []
        for await update in run.updates { all.append(update) }
        return all
    }

    func testAChatStreamsFromTheAliasWithContextAndThinkingOff() async throws {
        let fake = try FakeOllama { _ in .stream(status: 200, pieces: [
            (0, Invented.chunk("Invented ")), (10, Invented.chunk("answer.")), (10, Invented.done)]) }
        let context = [LocalChatTurn(role: .user, text: "Earlier invented question."),
                       LocalChatTurn(role: .assistant, text: "Earlier invented answer.")]
        let run = LocalChatRun.start(request(alias: alias, context: context), endpoint: OllamaEndpoint(port: fake.port),
                                     clock: SystemParticipantClock(), limits: .contract)
        let updates = await collect(run)
        let types = updates.compactMap { update -> String? in
            switch update {
            case .event(let event): return event.type.rawValue
            case .terminal(let event, let cleared): return "\(event.type.rawValue) cleared=\(String(describing: cleared))"
            default: return nil
            }
        }
        XCTAssertEqual(types.first, "started")
        XCTAssertEqual(types.last, "completed cleared=Optional(true)")
        let text = updates.compactMap { if case .event(let e) = $0 { return e.text }; return nil }.joined()
        XCTAssertEqual(text, "Invented answer.")
        let body = try XCTUnwrap(fake.requests.first?.json)
        XCTAssertEqual(fake.requests.first?.path, "/api/chat")
        XCTAssertEqual(body["model"] as? String, alias)
        XCTAssertEqual(body["stream"] as? Bool, true)
        XCTAssertEqual(body["think"] as? Bool, false)
        let messages = try XCTUnwrap(body["messages"] as? [[String: String]])
        XCTAssertEqual(messages, [["role": "user", "content": "Earlier invented question."],
                                  ["role": "assistant", "content": "Earlier invented answer."],
                                  ["role": "user", "content": "Invented question?"]])
        XCTAssertEqual(run.snapshot.cleanup, .released)
    }

    /// Codex round 1 on #42: a peer that sends `done` and then holds the
    /// connection open must not hold the run open.
    func testDoneEndsTheRunEvenIfThePeerKeepsTheConnectionOpen() async throws {
        let fake = try FakeOllama { _ in .stream(status: 200, pieces: [(0, Invented.chunk("ok")), (0, Invented.done),
                                                                     (30_000, Data())]) }
        let run = LocalChatRun.start(request(alias: alias), endpoint: OllamaEndpoint(port: fake.port),
                                     clock: SystemParticipantClock(), limits: .contract)
        let started = Date()
        _ = await collect(run)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertEqual(run.snapshot.terminal?.type, .completed)
    }

    func testARedirectedChatFailsAndItsTargetIsNeverContacted() async throws {
        let target = try FakeOllama { _ in .stream(status: 200, pieces: [(0, Invented.done)]) }
        let fake = try FakeOllama { _ in .redirect(location: "http://127.0.0.1:\(target.port)/api/chat") }
        let run = LocalChatRun.start(request(alias: alias), endpoint: OllamaEndpoint(port: fake.port),
                                     clock: SystemParticipantClock(), limits: .contract)
        _ = await collect(run)
        XCTAssertEqual(run.snapshot.terminal?.reason, "process-error")
        XCTAssertTrue(target.requests.isEmpty)
    }

    func testADroppedConnectionFails() async throws {
        let fake = try FakeOllama { _ in .stream(status: 200, pieces: [(0, Invented.chunk("cut "))]) }
        let run = LocalChatRun.start(request(alias: alias), endpoint: OllamaEndpoint(port: fake.port),
                                     clock: SystemParticipantClock(), limits: .contract)
        let updates = await collect(run)
        XCTAssertEqual(run.snapshot.terminal?.reason, "process-error")
        XCTAssertTrue(updates.contains { if case .event(let e) = $0 { return e.text == "cut " }; return false },
                      "accepted text arrives before the failure")
    }

    func testStopCancelsTheRequestAndEndsLocalStop() async throws {
        let fake = try FakeOllama { _ in .stream(status: 200, pieces: [(0, Invented.chunk("slow ")), (5_000, Invented.done)]) }
        let run = LocalChatRun.start(request(alias: alias), endpoint: OllamaEndpoint(port: fake.port),
                                     clock: SystemParticipantClock(), limits: .contract)
        var seenText = false
        var updates: [ParticipantRunUpdate] = []
        for await update in run.updates {
            updates.append(update)
            if case .event(let event) = update, event.type == .started { continue }
            if !seenText { seenText = true; run.stop() }
        }
        XCTAssertEqual(run.snapshot.terminal?.reason, "local-stop")
        XCTAssertEqual(run.snapshot.groupCleared, true)
        let terminal = updates.last(where: { if case .terminal = $0 { return true }; return false })
        if case .terminal(let event, _)? = terminal { XCTAssertEqual(event.type, .stopped) } else { XCTFail() }
        XCTAssertEqual(updates.last, .cleanupReleased, "no process group: cleanup is released with the terminal")
    }

    // MARK: The coordinator's seam (step 3 PR 3c)

    private var pin: ParticipantPin {
        ParticipantPin(id: "ollama-local", label: "invented-small:7b", model: "invented-small:7b@" + Invented.digestA,
                       executionHost: "this-mac")!
    }

    func testTheSeamReadsOnlyALocalEntrysExactForm() {
        XCTAssertEqual(OllamaClient.entry(pin), small)
        for bad in [ParticipantPin(id: "claude-code", label: "invented-small:7b", model: "invented-small:7b@" + Invented.digestA,
                                   executionHost: "this-mac"),
                    ParticipantPin(id: "ollama-local", label: "invented-small:7b", model: "invented-other:7b@" + Invented.digestA,
                                   executionHost: "this-mac"),
                    ParticipantPin(id: "ollama-local", label: "invented-small:7b", model: "invented-small:7b@ABC",
                                   executionHost: "this-mac"),
                    ParticipantPin(id: "ollama-local", label: "invented-small:7b", model: "invented-small:7b@" + Invented.digestA,
                                   executionHost: "elsewhere")] {
            XCTAssertNil(OllamaClient.entry(bad!))
        }
    }

    func testTheSeamBindsDeletesAndLaunchesThroughTheSameRequests() async throws {
        let fake = try FakeOllama { [alias] request in
            switch request.path {
            case "/api/tags": return .json(status: 200, Invented.tags([Invented.model("invented-small:7b", digest: Invented.digestA),
                                                                        Invented.model(alias, digest: Invented.digestA)]))
            case "/api/chat": return .stream(status: 200, pieces: [(0, Invented.chunk("Invented.")), (0, Invented.done)])
            default: return .json(status: 200, [:] as [String: Any])
            }
        }
        let client = client(fake)
        let bound = await client.bindAlias(pin, runId: runId)
        XCTAssertEqual(bound, .bound(alias: alias))
        let launch = LocalRunLaunch(identity: ParticipantRunIdentity(runId: runId, sessionId: "52abcdef-0000-4000-8abc-000000000001",
                                                                     createdAtMillis: 1_760_500_000_000),
                                    alias: alias, context: [LocalTurn(role: "user", text: "Earlier invented question."),
                                                            LocalTurn(role: "assistant", text: "Earlier invented answer.")],
                                    inputChunks: ["Invented question?"], contextBytes: 50, inputBytes: 18, preparedBytes: 600)
        let run = client.launchLocal(launch, clock: SystemParticipantClock())
        for await _ in run.updates {}
        XCTAssertEqual(run.snapshot.terminal?.type, .completed)
        await client.deleteAlias(runId: runId)
        await client.deleteAlias(runId: "not-a-run-id")
        XCTAssertEqual(fake.requests.map(\.path), ["/api/copy", "/api/tags", "/api/chat", "/api/delete"])
        let messages = try XCTUnwrap(fake.requests[2].json?["messages"] as? [[String: String]])
        XCTAssertEqual(messages.map { $0["role"] ?? "" }, ["user", "assistant", "user"])
        XCTAssertEqual(fake.requests[3].json as? [String: String], ["model": alias])
    }
}
