import Foundation
import Testing
@testable import DeskHost
@testable import LocalModelRoute
@testable import ParticipantCoordinator
import ParticipantProcess

/// The Swift side of `native-participant-local-v1.json` (contract section
/// 20.5): the page codec runs the same file, so both sides agree on every
/// availability reply with a local route, every reply the page refuses, and
/// every prepared run's form, and the local start runs through the
/// coordinator with a route that can start runs (step 3 PR 3c).
private struct LocalVectors {
    static let resourceName = "native-participant-local-v1"
    let data: Data
    let root: [String: JSONValue]

    static func load() throws -> LocalVectors {
        guard let url = Bundle.module.url(forResource: resourceName, withExtension: "json") else {
            throw CocoaError(.fileNoSuchFile)
        }
        let data = try Data(contentsOf: url)
        guard let root = try JSONValue.decode(data).objectValue else { throw CocoaError(.fileReadCorruptFile) }
        return LocalVectors(data: data, root: root)
    }

    var cases: [[String: JSONValue]] { root["cases"]?.listItems?.compactMap(\.objectValue) ?? [] }
    var invalidReplies: [[String: JSONValue]] { root["invalidReplies"]?.listItems?.compactMap(\.objectValue) ?? [] }
    func runs(_ kind: String) -> [[String: JSONValue]] {
        root["runs"]?.objectValue?[kind]?.listItems?.compactMap(\.objectValue) ?? []
    }
    var localParticipant: ParticipantPin? { root["context"]?.objectValue?["localParticipant"].flatMap(ParticipantPin.init(json:)) }
    var claudePin: ParticipantPin? { root["context"]?.objectValue?["participant"].flatMap(ParticipantPin.init(json:)) }
}

/// A reply's result fields: everything but the envelope and the outcome.
private func result(_ reply: [String: JSONValue]) -> [String: JSONValue] {
    reply.filter { !["v", "requestId", "connectionId", "generation", "operation", "outcome"].contains($0.key) }
}

/// The `/api/tags` body a fake Ollama would send for a ready reply's local
/// entries, in reverse order, plus two rows native leaves out: an
/// embedding-only model and one of native's own per-run aliases.
private func tagsBody(for entries: ArraySlice<JSONValue>) throws -> Data {
    var rows: [[String: Any]] = []
    for entry in entries.reversed() {
        let fields = try #require(entry.objectValue)
        let model = try #require(fields["model"]?.stringValue)
        let name = try #require(fields["label"]?.stringValue)
        let digest = String(model.dropFirst(name.utf8.count + 1))
        var row: [String: Any] = ["name": name, "model": name, "digest": digest, "capabilities": ["completion"]]
        if fields["available"] == .bool(false), !name.hasSuffix(":cloud") { row["remote_host"] = "https://invented.example:443" }
        if name.hasSuffix(":cloud") { row["remote_host"] = "https://invented.example:443"; row["remote_model"] = name }
        rows.append(row)
    }
    rows.append(["name": "invented-embedding:1b", "digest": String(repeating: "e5", count: 32), "capabilities": ["embedding"]])
    rows.append(["name": "open-convo-run-71abcdef00004000" + "8abc000000000999:pin", "digest": String(repeating: "c3", count: 32),
                 "capabilities": ["completion"]])
    return try JSONSerialization.data(withJSONObject: ["models": rows])
}

/// The catalog a reply describes, as faithfully as its fields allow: what
/// native would have to have read to send it.
private func describedCatalog(_ reply: [String: JSONValue]) -> LocalCatalogAnswer {
    let route = reply["routes"]?.listItems?.first?.objectValue
    if route?["state"] == .string("unavailable") {
        return .unavailable(reason: route?["reason"]?.stringValue ?? "")
    }
    let entries = (reply["participants"]?.listItems ?? []).dropFirst().compactMap { value -> LocalCatalogEntry? in
        guard var fields = value.objectValue else { return nil }
        let available = fields.removeValue(forKey: "available") == .bool(true)
        fields.removeValue(forKey: "reason")
        fields.removeValue(forKey: "confirmation")
        return ParticipantPin(json: .object(fields)).map { LocalCatalogEntry(participant: $0, available: available) }
    }
    return .ready(entries)
}

@Suite("Shared local-route vectors (contract section 20)")
struct LocalVectorTests {
    @Test("The native copy is byte-identical to the authoritative apps/desk vectors")
    func fixtureCopyIsExact() throws {
        let bundled = try LocalVectors.load().data
        let authoritative = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("desk/tests/fixtures/native-participant-local-v1.json")
        let original = try Data(contentsOf: authoritative)
        #expect(original.count > 100_000, "the scan read the real file")
        #expect(bundled == original, "copy apps/desk/tests/fixtures/native-participant-local-v1.json over the test fixture; never edit the copy")
    }

    @Test("Every case is counted: seven availability replies and the one local start run here")
    func everyCaseCounted() throws {
        let vectors = try LocalVectors.load()
        let operations = vectors.cases.map { $0["request"]?.objectValue?["operation"]?.stringValue ?? "" }
        #expect(operations.filter { $0 == "participant.availability" }.count == 7)
        #expect(operations.filter { $0 == "participant.start" }.count == 1)
        #expect(operations.count == 8)
        #expect(vectors.invalidReplies.count == 19)
        #expect(vectors.runs("valid").count == 3 && vectors.runs("invalid").count == 6)
    }

    @Test("Native's availability with a local route is each vector's reply exactly, through the real catalog parser")
    func availabilityReplies() throws {
        let vectors = try LocalVectors.load()
        for vector in vectors.cases where vector["request"]?.objectValue?["operation"] == .string("participant.availability") {
            let name = vector["name"]?.stringValue ?? "?"
            let reply = try #require(vector["reply"]?.objectValue)
            let participants = try #require(reply["participants"]?.listItems)
            let claude = try #require(participants.first?.objectValue)
            let route = try #require(reply["routes"]?.listItems?.first?.objectValue)
            let catalog: LocalCatalog
            switch route["reason"]?.stringValue {
            case nil:
                catalog = OllamaCatalog.parse(try tagsBody(for: participants.dropFirst()))
            case "catalog-too-large":
                let rows = (0...256).map { ["name": String(format: "invented-m%04d:1b", $0), "digest": String(repeating: "a1", count: 32),
                                            "capabilities": ["completion"]] as [String: Any] }
                catalog = OllamaCatalog.parse(try JSONSerialization.data(withJSONObject: ["models": rows]))
            case "catalog-unreadable":
                catalog = OllamaCatalog.parse(Data("invented: not a model list".utf8))
            case let reason?:
                catalog = .unavailable(try #require(LocalRouteReason(rawValue: reason)))
            }
            let answer = OllamaClient.answer(catalog).checked
            let native = answer.availabilityFields(claude: claude)
            #expect(JSONValue.object(native).canonicalData() == JSONValue.object(result(reply)).canonicalData(), "\(name)")
        }
    }

    @Test("Native never sends any reply the page refuses: from the catalog each one describes, native's reply differs")
    func invalidRepliesAreNeverNatives() throws {
        let vectors = try LocalVectors.load()
        for vector in vectors.invalidReplies {
            let name = vector["name"]?.stringValue ?? "?"
            let reply = try #require(vector["reply"]?.objectValue)
            let claude = try #require(reply["participants"]?.listItems?.first?.objectValue)
            let native = describedCatalog(reply).checked.availabilityFields(claude: claude)
            #expect(JSONValue.object(native).canonicalData() != JSONValue.object(result(reply)).canonicalData(), "\(name)")
        }
    }

    @Test("Prepared runs: each valid run prepares and each invalid one is refused, against a ready catalog with the vectors' local model")
    func preparedRuns() throws {
        let vectors = try LocalVectors.load()
        let local = try #require(vectors.localParticipant)
        let claudePin = try #require(vectors.claudePin)
        let catalog = ParticipantLocalPrepare(catalog: .ready([LocalCatalogEntry(participant: local, available: true)]))
        for (kind, passes) in [("valid", true), ("invalid", false)] {
            for vector in vectors.runs(kind) {
                let name = vector["name"]?.stringValue ?? "?"
                let run = try #require(vector["run"]?.objectValue)
                let runId = try #require(run["runId"]?.stringValue)
                // Each context id the run names, other than its own, is a
                // completed earlier turn of the same session in the record.
                var ids: [String] = []
                for value in run["contextRunIds"]?.listItems ?? [] {
                    if let id = value.stringValue, id != runId, !ids.contains(id) { ids.append(id) }
                }
                var earlier: [JSONValue] = []
                for (index, id) in ids.enumerated() {
                    var turn = run
                    turn.removeValue(forKey: "contextRunIds")
                    turn["runId"] = .string(id)
                    turn["userMessageId"] = .string(String(format: "72abcdef-0000-4000-8abc-%012d", 5_000 + index))
                    turn["assistantMessageId"] = .string(String(format: "73abcdef-0000-4000-8abc-%012d", 5_000 + index))
                    turn["phase"] = .string("completed")
                    turn["outputChunks"] = .array([.string("Invented earlier answer.")])
                    turn["lastSequence"] = .number(3)
                    earlier.append(.object(turn))
                }
                let record: [String: JSONValue] = ["schemaVersion": .number(2), "revision": .number(5),
                                                   "conversationRuns": .array(earlier + [.object(run)])]
                let participantId = run["participant"]?.objectValue?["id"] ?? .null
                let claim: JSONValue = .object(["runId": .string(runId), "sessionId": run["sessionId"] ?? .null,
                                                "userMessageId": run["userMessageId"] ?? .null,
                                                "assistantMessageId": run["assistantMessageId"] ?? .null,
                                                "participantId": participantId, "createdAt": run["createdAt"] ?? .null])
                let check = ParticipantPrepare.prepare(claim: claim, record: record, pin: claudePin, inputBound: nil, local: catalog)
                if passes {
                    guard case .passed(let prepared) = check else { Issue.record("\(name): \(check)"); continue }
                    #expect((prepared.context?.runIds ?? []) == ids, "\(name)")
                } else if case .passed = check {
                    Issue.record("\(name) prepared")
                }
            }
        }
    }
}

/// A local route whose answer a test sets; counts every read.
private final class CountingRoute: LocalCatalogReading, @unchecked Sendable {
    private let lock = NSLock()
    private var current: LocalCatalogAnswer
    private var count = 0

    init(_ answer: LocalCatalogAnswer) { current = answer }

    var answer: LocalCatalogAnswer {
        get { lock.lock(); defer { lock.unlock() }; return current }
        set { lock.lock(); current = newValue; lock.unlock() }
    }

    var reads: Int { lock.lock(); defer { lock.unlock() }; return count }

    func localCatalog() async -> LocalCatalogAnswer {
        lock.lock(); defer { lock.unlock() }
        count += 1
        return current
    }
}

@Suite("Availability with a local route, through the coordinator (contract section 20.2)")
struct LocalAvailabilityTests {
    @Test("Each availability request reads the route afresh; the Claude Code entry stays first and unchanged; an unavailable route lists no local entry")
    func throughTheCoordinator() async throws {
        let vectors = try ParticipantVectors.load()
        let local = try LocalVectors.load()
        let localPin = try #require(local.localParticipant)
        let world = try await VectorWorld(seed: [:], number: 0, operation: "participant.availability", vectors: vectors)
        defer { world.clean() }
        let route = CountingRoute(.ready([LocalCatalogEntry(participant: localPin, available: true)]))
        let configuration = ParticipantHostConfiguration(pin: world.hostConfiguration.pin, identities: world.hostConfiguration.identities,
                                                         localRoute: route)
        let host = DeskHostProtocol(store: world.store, connections: world.connections, drafts: DraftBindingRegistry(),
                                    info: VectorWorld.info, events: world.sink, participants: configuration)
        let report = ParticipantAvailabilityReport(availability: .unavailable(.overflowUnverified), confirmation: nil)
        let coordinator = ParticipantCoordinator(configuration: .init(
            hostConfiguration: configuration, availability: SeededAvailability(seeded: report), launchId: vectors.context.launchId,
            clock: world.virtual.clock, executor: world.executor, launcher: world.launcher, log: world.log))
        try await coordinator.attach(host: host, store: world.store, connections: world.connections, sink: world.sink)
        let generation = world.connections.validConnections().generation
        func ask() async -> HostResponse {
            await coordinator.handle(HostRequest(requestId: UUID(), connectionId: world.connectionId, generation: generation,
                                                 operation: .participantAvailability, payload: [:]))
        }
        let first = await ask()
        #expect(first.outcome == .ok)
        let listed = first.fields["participants"]?.listItems ?? []
        #expect(listed.count == 2)
        #expect(listed.first?.objectValue?["id"] == .string("claude-code"))
        #expect(listed.first?.objectValue?["reason"] == .string("overflow-unverified"))
        #expect(listed.last == .object(["id": .string("ollama-local"), "label": .string(localPin.label), "model": .string(localPin.model),
                                        "executionHost": .string("this-mac"), "available": .bool(true), "reason": .null]))
        #expect(first.fields["routes"] == .array([.object(["route": .string("ollama-local"), "state": .string("ready"), "reason": .null])]))
        route.answer = .unavailable(reason: "ollama-not-running")
        let second = await ask()
        #expect(route.reads == 2, "no reused answer")
        #expect(second.fields["participants"]?.listItems?.count == 1)
        #expect(second.fields["routes"]?.listItems?.first?.objectValue?["reason"] == .string("ollama-not-running"))

        // The vectors' local start, on a run this host prepared, with a route
        // that only lists models: refused `participant-changed`, with
        // nothing written or launched (a route that can start runs is
        // `localStartVector` below).
        route.answer = .ready([LocalCatalogEntry(participant: localPin, available: true)])
        let start = try #require(local.cases.first { $0["request"]?.objectValue?["operation"] == .string("participant.start") })
        var payload = try #require(start["request"]?.objectValue?["payload"]?.objectValue)
        payload["workspaceHandle"] = .string(world.store.workspaceHandle)
        var run: [String: JSONValue] = ["version": .number(1), "outputChunks": .array([]), "lastSequence": .number(0),
                                        "phase": .string("prepared"), "createdAt": .string("2026-10-15T07:00:00.000Z"),
                                        "updatedAt": .string("2026-10-15T07:00:00.000Z"), "contextRunIds": .array([])]
        for key in ["runId", "sessionId", "userMessageId", "assistantMessageId", "participant", "inputChunks"] { run[key] = payload[key] }
        var claim: [String: JSONValue] = ["participantId": .string("ollama-local"), "createdAt": .string("2026-10-15T07:00:00.000Z")]
        for key in ["runId", "sessionId", "userMessageId", "assistantMessageId"] { claim[key] = payload[key] }
        let commit = await host.handle(HostRequest(
            requestId: UUID(), connectionId: world.connectionId, generation: generation, operation: .workspaceCommitProof,
            payload: ["workspaceHandle": .string(world.store.workspaceHandle), "expectedRevision": .number(0),
                      "record": .object(["schemaVersion": .number(2), "revision": .number(1), "conversationRuns": .array([.object(run)])]),
                      "participantRun": .object(claim)]))
        #expect(commit.outcome == .ok, "\(commit)")
        let runId = try #require(payload["runId"]?.stringValue)
        #expect(world.store.publishedRuns.entry(for: runId)?.context?.runIds == [])
        let refused = await coordinator.handle(HostRequest(requestId: UUID(), connectionId: world.connectionId, generation: generation,
                                                           operation: .participantStart, payload: payload))
        #expect(refused.reason == .participantChanged)
        #expect(world.launcher.runs.isEmpty)
        #expect(world.store.publishedRuns.entry(for: runId)?.start == nil)
    }
}

@Suite("The shared local start vector, through the coordinator (step 3 PR 3c)")
struct LocalStartVectorTests {
    @Test("The vectors' local start answers the vector's reply exactly, records its receipt before the chat, and leaves no alias")
    func localStartVector() async throws {
        let vectors = try LocalVectors.load()
        let localPin = try #require(vectors.localParticipant)
        let vector = try #require(vectors.cases.first { $0["request"]?.objectValue?["operation"] == .string("participant.start") })
        let request = try #require(vector["request"]?.objectValue)
        let expected = try #require(vector["reply"]?.objectValue)
        let route = ScriptedLocalRoute([.ready([LocalCatalogEntry(participant: localPin, available: true)])])
        let local = try await LocalStartWorld(route: route)
        defer { local.clean() }
        var payload = try #require(request["payload"]?.objectValue)
        payload["workspaceHandle"] = .string(local.world.store.workspaceHandle)
        var run: [String: JSONValue] = ["version": .number(1), "outputChunks": .array([]), "lastSequence": .number(0),
                                        "phase": .string("prepared"), "createdAt": .string(LocalStartWorld.createdAt),
                                        "updatedAt": .string(LocalStartWorld.createdAt), "contextRunIds": .array([])]
        for key in ["runId", "sessionId", "userMessageId", "assistantMessageId", "participant", "inputChunks"] { run[key] = payload[key] }
        let runId = try #require(payload["runId"]?.stringValue)
        try await local.commit([.object(run)], claim: runId)
        let requestId = try #require(request["requestId"]?.stringValue.flatMap(UUID.init(uuidString:)))
        let reply = await local.ask(.participantStart, payload, requestId: requestId)
        #expect(reply.outcome == .ok, "\(reply)")
        #expect(JSONValue.object(reply.fields).canonicalData() == JSONValue.object(result(expected)).canonicalData())
        #expect(route.calls.suffix(2) == ["bind", "chat"], "\(route.calls)")
        #expect(local.world.store.publishedRuns.entry(for: runId)?.start?.cliVersion == "ollama-local")
        let started = try #require(route.runs.first)
        #expect(started.launch.context.isEmpty)
        started.respond()
        started.done()
        #expect(await eventually { local.world.store.publishedRuns.entry(for: runId)?.terminal?.type == "completed" })
        #expect(await eventually { route.aliases.isEmpty })
    }
}

private extension JSONValue {
    var listItems: [JSONValue]? {
        if case .array(let items) = self { return items }
        return nil
    }
}
