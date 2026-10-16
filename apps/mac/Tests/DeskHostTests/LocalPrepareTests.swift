import CryptoKit
import Foundation
import Testing
@testable import DeskHost

/// Invented values in the shape of `native-participant-local-v1.json`: one
/// session, completed runs 1 and 2, and run 3 prepared for a local model
/// with runs 1 and 2 as its earlier turns. No real model names, digests or
/// text.
private enum Local {
    static let claudePin = ParticipantPin(id: "claude-code", label: "Claude Code", model: "invented-pinned-model",
                                          executionHost: "this-mac")!
    static let digest = String(repeating: "c3", count: 32)
    static let pin = ParticipantPin(id: "ollama-local", label: "invented-local-small:7b",
                                    model: "invented-local-small:7b@\(digest)", executionHost: "this-mac")!
    static let cloudPin = ParticipantPin(id: "ollama-local", label: "invented-cloud:cloud",
                                         model: "invented-cloud:cloud@\(String(repeating: "a1", count: 32))", executionHost: "this-mac")!
    static let catalog = LocalCatalogAnswer.ready([LocalCatalogEntry(participant: cloudPin, available: false),
                                                   LocalCatalogEntry(participant: pin, available: true)])
    static let createdAt = "2026-10-15T07:00:00.000Z"
    static let session = "52abcdef-0000-4000-8abc-000000000901"

    static func id(_ prefix: String, _ n: Int) -> String { "\(prefix)-0000-4000-8abc-" + String(format: "%012d", 900 + n) }
    static func runId(_ n: Int) -> String { id("71abcdef", n) }

    /// A completed earlier turn, as the page keeps it.
    static func completed(_ n: Int, input: [String] = ["Invented question."], output: [String] = ["Invented answer."],
                          _ edit: (inout [String: JSONValue]) -> Void = { _ in }) -> JSONValue {
        var run: [String: JSONValue] = [
            "version": .number(1), "runId": .string(runId(n)), "sessionId": .string(session),
            "userMessageId": .string(id("72abcdef", n)), "assistantMessageId": .string(id("73abcdef", n)),
            "participant": pin.jsonValue, "inputChunks": .array(input.map(JSONValue.string)),
            "outputChunks": .array(output.map(JSONValue.string)), "lastSequence": .number(4), "phase": .string("completed"),
            "createdAt": .string(createdAt), "updatedAt": .string("2026-10-15T07:00:05.000Z")
        ]
        edit(&run)
        return .object(run)
    }

    /// Run `n` in the prepared form, local unless `participant` says otherwise.
    static func prepared(_ n: Int = 3, participant: ParticipantPin = pin, context: [String]? = [runId(1), runId(2)],
                         chunks: [String] = ["Invented follow-up question."],
                         _ edit: (inout [String: JSONValue]) -> Void = { _ in }) -> JSONValue {
        var run: [String: JSONValue] = [
            "version": .number(1), "runId": .string(runId(n)), "sessionId": .string(session),
            "userMessageId": .string(id("72abcdef", n)), "assistantMessageId": .string(id("73abcdef", n)),
            "participant": participant.jsonValue, "inputChunks": .array(chunks.map(JSONValue.string)),
            "outputChunks": .array([]), "lastSequence": .number(0), "phase": .string("prepared"),
            "createdAt": .string(createdAt), "updatedAt": .string(createdAt)
        ]
        if let context { run["contextRunIds"] = .array(context.map(JSONValue.string)) }
        edit(&run)
        return .object(run)
    }

    static let first = completed(1, input: ["Invented ", "question one?"], output: ["Invented answer ", "one."])
    static let second = completed(2, input: ["Invented question two?"], output: ["Invented \"answer\" two."])

    static func record(revision: Int = 5, runs: [JSONValue] = [first, second, prepared()]) -> [String: JSONValue] {
        ["schemaVersion": .number(2), "revision": .number(Double(revision)), "label": .string("invented local record"),
         "conversationRuns": .array(runs)]
    }

    static func claim(_ n: Int = 3, participantId: String = "ollama-local") -> JSONValue {
        .object(["runId": .string(runId(n)), "sessionId": .string(session), "userMessageId": .string(id("72abcdef", n)),
                 "assistantMessageId": .string(id("73abcdef", n)), "participantId": .string(participantId),
                 "createdAt": .string(createdAt)])
    }

    static func prepare(_ claim: JSONValue = claim(), record: [String: JSONValue] = record(),
                        local: ParticipantLocalPrepare? = ParticipantLocalPrepare(catalog: catalog),
                        inputBound: Int? = nil) -> ParticipantCheck<ParticipantPreparedRun> {
        ParticipantPrepare.prepare(claim: claim, record: record, pin: claudePin, inputBound: inputBound, local: local)
    }

    static func reason(_ check: ParticipantCheck<ParticipantPreparedRun>) -> HostRefusal? {
        if case .refused(let reason) = check { return reason }
        return nil
    }

    static func run(_ check: ParticipantCheck<ParticipantPreparedRun>) -> ParticipantPreparedRun? {
        if case .passed(let run) = check { return run }
        return nil
    }

    /// The contract's hash, computed here from the literal canonical JSON
    /// (sorted keys, no spaces, `"` escaped), not through native's encoder.
    static let expectedHash: String = {
        let json = #"[{"role":"user","text":"Invented question one?"},{"role":"assistant","text":"Invented answer one."},"#
            + #"{"role":"user","text":"Invented question two?"},{"role":"assistant","text":"Invented \"answer\" two."}]"#
        return SHA256.hash(data: Data(json.utf8)).map { String(format: "%02x", $0) }.joined()
    }()
    /// The four turns' text bytes.
    static let expectedBytes = "Invented question one?".utf8.count + "Invented answer one.".utf8.count
        + "Invented question two?".utf8.count + "Invented \"answer\" two.".utf8.count
}

/// A local route whose answer a test sets; counts every read.
final class FakeLocalCatalog: LocalCatalogReading, @unchecked Sendable {
    private let lock = NSLock()
    private var current: LocalCatalogAnswer
    private var count = 0
    private let onRead: @Sendable () -> Void

    init(_ answer: LocalCatalogAnswer, onRead: @escaping @Sendable () -> Void = {}) {
        current = answer
        self.onRead = onRead
    }

    var answer: LocalCatalogAnswer {
        get { lock.lock(); defer { lock.unlock() }; return current }
        set { lock.lock(); current = newValue; lock.unlock() }
    }

    var reads: Int { lock.lock(); defer { lock.unlock() }; return count }

    func localCatalog() async -> LocalCatalogAnswer {
        onRead()
        lock.lock(); defer { lock.unlock() }
        count += 1
        return current
    }
}

@Suite("Local runs at preparation (contract section 20.3)")
struct LocalPrepareTests {
    @Test("A local run prepares with its earlier turns bound by ids, bytes and SHA-256 of the canonical turns, never their text")
    func preparesWithContext() throws {
        let run = try #require(Local.run(Local.prepare()))
        #expect(run.participant == Local.pin)
        let context = try #require(run.context)
        #expect(context.runIds == [Local.runId(1), Local.runId(2)])
        #expect(context.bytes == Local.expectedBytes)
        #expect(context.hash == Local.expectedHash)
        #expect(run.inputBytes == "Invented follow-up question.".utf8.count)
        // The run's canonical JSON, contextRunIds included, is preparedBytes.
        #expect(run.preparedBytes == Local.prepared().canonicalData().count)

        // No earlier turns: an empty list, zero bytes, the hash of [].
        let alone = try #require(Local.run(Local.prepare(record: Local.record(runs: [Local.prepared(context: [])]))))
        #expect(alone.context?.runIds == [] && alone.context?.bytes == 0)
        #expect(alone.context?.hash == SHA256.hash(data: Data("[]".utf8)).map { String(format: "%02x", $0) }.joined())

        // A Claude Code run on the same host is unchanged: twelve keys, no context.
        let claude = Local.prepare(Local.claim(participantId: "claude-code"),
                                   record: Local.record(runs: [Local.prepared(participant: Local.claudePin, context: nil)]))
        #expect(Local.run(claude)?.context == nil)
    }

    @Test("Without a local route a run with contextRunIds is not in the prepared form; on any host a Claude Code run with one is not either")
    func formDependsOnTheRoute() {
        #expect(Local.reason(Local.prepare(local: nil)) == .runNotPrepared, "a host without a local route is revision 3 exactly")
        #expect(Local.reason(Local.prepare(Local.claim(participantId: "claude-code"),
                                           record: Local.record(runs: [Local.prepared(participant: Local.claudePin, context: [])])))
                == .runNotPrepared)
        #expect(Local.reason(Local.prepare(record: Local.record(runs: [Local.first, Local.second, Local.prepared(context: nil)])))
                == .runNotPrepared, "a local run without contextRunIds")
    }

    @Test("Step 3 refuses a context list that is not at most 256 distinct canonical lowercase UUIDv4 strings")
    func contextListForm() {
        let upper = Local.runId(1).uppercased()
        let cases: [(String, JSONValue)] = [
            ("not a list", .string(Local.runId(1))),
            ("listed twice", .array([.string(Local.runId(1)), .string(Local.runId(1))])),
            ("uppercase", .array([.string(upper)])),
            ("not v4", .array([.string("71abcdef-0000-1000-8abc-000000000901")])),
            ("not a string", .array([.number(1)])),
            ("257 ids", .array((0..<257).map { .string("71abcdef-0000-4000-8abc-\(String(format: "%012d", $0))") }))
        ]
        for (label, value) in cases {
            let run = Local.prepared { $0["contextRunIds"] = value }
            #expect(Local.reason(Local.prepare(record: Local.record(runs: [Local.first, Local.second, run]))) == .runNotPrepared, "\(label)")
        }
        let most = (0..<256).map { "71abcdef-0000-4000-8abc-\(String(format: "%012d", $0))" }
        let run = Local.prepared { $0["contextRunIds"] = .array(most.map(JSONValue.string)) }
        #expect(Local.reason(Local.prepare(record: Local.record(runs: [Local.first, Local.second, run]))) == .runMismatch,
                "256 well-formed ids pass step 3, then fail to resolve")
    }

    @Test("Step 5 for a local run: the claim names ollama-local and the run's participant is an available entry of the ready catalog, byte for byte")
    func stepFive() {
        let ready = ParticipantLocalPrepare(catalog: Local.catalog)
        #expect(Local.run(Local.prepare(local: ready)) != nil)
        #expect(Local.reason(Local.prepare(Local.claim(participantId: "claude-code"))) == .runMismatch, "the claim's id")
        #expect(Local.reason(Local.prepare(local: ParticipantLocalPrepare(catalog: nil))) == .runMismatch, "no catalog read")
        #expect(Local.reason(Local.prepare(local: ParticipantLocalPrepare(catalog: .unavailable(reason: "ollama-not-running"))))
                == .runMismatch, "the route is down")
        #expect(Local.reason(Local.prepare(local: ParticipantLocalPrepare(catalog: .ready([]))))
                == .runMismatch, "the model is missing")
        let moved = ParticipantPin(id: "ollama-local", label: Local.pin.label,
                                   model: "invented-local-small:7b@\(String(repeating: "d4", count: 32))", executionHost: "this-mac")!
        #expect(Local.reason(Local.prepare(local: ParticipantLocalPrepare(catalog: .ready([LocalCatalogEntry(participant: moved, available: true)]))))
                == .runMismatch, "the name now has another digest")
        let cloud = Local.prepared(participant: Local.cloudPin)
        #expect(Local.reason(Local.prepare(record: Local.record(runs: [Local.first, Local.second, cloud]))) == .runMismatch,
                "a listed model that is not local is never available")
    }

    @Test("Context resolution: each id is one completed run of the same session, before this run and in turn order, else run-mismatch")
    func resolution() {
        let other = Local.completed(1) { $0["sessionId"] = .string("52abcdef-0000-4000-8abc-000000000999") }
        let open = Local.completed(1) { $0["phase"] = .string("streaming") }
        let badChunks = Local.completed(1) { $0["outputChunks"] = .array([.number(1)]) }
        let cases: [(String, [JSONValue])] = [
            ("an unknown id", [Local.first, Local.second, Local.prepared(context: [Local.runId(7)])]),
            ("another session", [other, Local.prepared(context: [Local.runId(1)])]),
            ("not completed", [open, Local.prepared(context: [Local.runId(1)])]),
            ("non-string output", [badChunks, Local.prepared(context: [Local.runId(1)])]),
            ("after this run", [Local.prepared(context: [Local.runId(1)]), Local.first]),
            ("out of turn order", [Local.first, Local.second, Local.prepared(context: [Local.runId(2), Local.runId(1)])]),
            ("this run itself", [Local.first, Local.prepared(context: [Local.runId(3)])]),
            ("listed twice in the record", [Local.first, Local.first, Local.prepared(context: [Local.runId(1)])])
        ]
        for (label, runs) in cases {
            #expect(Local.reason(Local.prepare(record: Local.record(runs: runs))) == .runMismatch, "\(label)")
        }
    }

    @Test("One input limit: resolved context bytes plus input bytes at most 262,144, else text-too-large; section 17's trial bound is Claude Code's only")
    func oneInputLimit() throws {
        // 16,384-byte chunks: earlier run 1 holds 245,760 bytes of turns.
        let big = String(repeating: "a", count: 16_384)
        let earlier = Local.completed(1, input: Array(repeating: big, count: 8), output: Array(repeating: big, count: 7))
        let exact = Local.prepared(context: [Local.runId(1)], chunks: [String(repeating: "b", count: 16_384)])
        let run = try #require(Local.run(Local.prepare(record: Local.record(runs: [earlier, exact]))))
        #expect(run.context?.bytes == 15 * 16_384 && run.inputBytes == 16_384, "exactly 262,144 together")
        let over = Local.prepared(context: [Local.runId(1)], chunks: [String(repeating: "b", count: 16_384), "b"])
        #expect(Local.reason(Local.prepare(record: Local.record(runs: [earlier, over]))) == .textTooLarge)
        // A host with the first-trial bound still prepares a longer local input.
        let long = Local.prepared(context: [], chunks: [String(repeating: "c", count: 5_000)])
        #expect(Local.run(Local.prepare(record: Local.record(runs: [long]), inputBound: ParticipantLimits.firstTrialInputBound)) != nil)
    }

    // MARK: Through the host

    @Test("A participant host reads the catalog afresh once per commit whose claim names the local route, never for any other, and stores the context keys")
    func throughTheHost() async throws {
        let catalog = FakeLocalCatalog(Local.catalog)
        // The committed record already holds a completed earlier turn.
        let earlier = Local.completed(1, input: ["Invented question one?"], output: ["Invented answer one."])
        let harness = try LocalHost(route: catalog, seed: Local.record(revision: 4, runs: [earlier]))
        defer { harness.clean() }
        // A Claude Code commit on this host: no read.
        let claudeRun = Local.prepared(9, participant: Local.claudePin, context: nil)
        let claude = await harness.commit(expected: 4, record: Local.record(revision: 5, runs: [earlier, claudeRun]),
                                          claim: Local.claim(9, participantId: "claude-code"))
        #expect(claude.outcome == .ok, "\(claude)")
        #expect(catalog.reads == 0)

        // A local commit: one read, then the entry with its three context keys.
        let local = await harness.commit(expected: 5, record: Local.record(revision: 6, runs: [earlier, claudeRun,
                                                                                                 Local.prepared(2, context: [Local.runId(1)])]),
                                         claim: Local.claim(2))
        #expect(local.outcome == .ok, "\(local)")
        #expect(catalog.reads == 1)
        let entry = try #require(harness.store.publishedRuns.entry(for: Local.runId(2)))
        #expect(entry.context?.runIds == [Local.runId(1)])
        let disk = try #require(try JSONValue.decode(harness.store.plainStateForTesting()).objectValue)
        let stored = try #require(disk["runs"]?.arrayValue?.first { $0.objectValue?["runId"] == .string(Local.runId(2)) }?.objectValue)
        #expect(stored.count == 17)
        #expect(stored["contextBytes"] == .number(Double("Invented question one?Invented answer one.".utf8.count)))
        let runsText = String(decoding: (disk["runs"] ?? .null).canonicalData(), as: UTF8.self)
        #expect(!runsText.contains("Invented answer one"), "the runs list holds no context text")

        // The model moved since the page listed it: run-mismatch, nothing written.
        catalog.answer = .ready([])
        let stale = await harness.commit(expected: 6, record: Local.record(revision: 7, runs: [earlier, claudeRun,
                                                                                                 Local.prepared(2, context: [Local.runId(1)]),
                                                                                                 Local.prepared(3, context: [Local.runId(1)])]),
                                         claim: Local.claim(3))
        #expect(stale.reason == .runMismatch)
        #expect(catalog.reads == 2)
        #expect(harness.store.publishedRuns.entry(for: Local.runId(3)) == nil)
    }

    @Test("A connection revoked while the catalog is read is refused before any check, holding nothing")
    func preflightAfterTheRead() async throws {
        let connections = ConnectionRegistry()
        let catalog = FakeLocalCatalog(Local.catalog) { connections.invalidateAll() }
        let harness = try LocalHost(route: catalog, connections: connections)
        defer { harness.clean() }
        let reply = await harness.commit(expected: 4, record: Local.record(revision: 5, runs: [Local.prepared(1, context: [])]),
                                         claim: Local.claim(1))
        #expect(reply.reason == .unknownConnection)
        #expect(await harness.host.outstandingMutation == nil)
        #expect(harness.store.publishedRuns.runs.isEmpty)
    }

    @Test("Two hosts' configurations are equal only with the same local route, or none")
    func configurationEquality() {
        let route = FakeLocalCatalog(Local.catalog)
        let identities = RequestIdentityIndex()
        let one = ParticipantHostConfiguration(pin: Local.claudePin, identities: identities, localRoute: route)
        #expect(one == ParticipantHostConfiguration(pin: Local.claudePin, identities: identities, localRoute: route))
        #expect(one != ParticipantHostConfiguration(pin: Local.claudePin, identities: identities, localRoute: FakeLocalCatalog(Local.catalog)))
        #expect(one != ParticipantHostConfiguration(pin: Local.claudePin, identities: identities))
    }

    // MARK: Stored entries (section 20.5)

    @Test("A runs entry has all three context keys or none, exactly when its participant is ollama-local; each in its form")
    func entryInvariants() throws {
        let check = try #require(Local.run(Local.prepare()))
        let entry = try #require(ParticipantRunEntry(prepared: check, prepareRequestId: UUID(), preparedRevision: 5))
        let json = try #require(entry.jsonValue.objectValue)
        #expect(json.count == 17)
        #expect(ParticipantRunEntry(json: .object(json)) == entry, "round-trips")
        func edited(_ edit: (inout [String: JSONValue]) -> Void) -> ParticipantRunEntry? {
            var fields = json
            edit(&fields)
            return ParticipantRunEntry(json: .object(fields))
        }
        #expect(edited { $0.removeValue(forKey: "contextHash") } == nil, "two of three")
        var none = json
        for key in ParticipantRunContext.keys { none.removeValue(forKey: key) }
        #expect(ParticipantRunEntry(json: .object(none)) == nil, "a local entry without its context")
        #expect(edited { $0["participant"] = Local.claudePin.jsonValue } == nil, "context on a Claude Code entry")
        #expect(edited { $0["contextHash"] = .string(String(repeating: "A", count: 64)) } == nil, "uppercase hash")
        #expect(edited { $0["contextBytes"] = .number(-1) } == nil)
        #expect(edited { $0["contextBytes"] = .number(Double(262_144)) } == nil, "with the input past 262,144")
        #expect(edited { $0["contextRunIds"] = .array([.string(Local.runId(3))]) } == nil, "the run itself")
        #expect(edited { $0["contextRunIds"] = .array([.string(Local.runId(1)), .string(Local.runId(1))]) } == nil, "twice")
        #expect(edited { $0["contextRunIds"] = .string(Local.runId(1)) } == nil, "not a list")
    }

    @Test("LocalCatalogAnswer.checked holds any reader to section 20.2: entry form, code-point order, no name twice, at most 256, cloud names never available")
    func checkedAnswer() {
        let good = Local.catalog
        #expect(good.checked == good)
        func entry(_ name: String, digest: String = Local.digest, id: String = "ollama-local", host: String = "this-mac",
                   available: Bool = true) -> LocalCatalogEntry {
            LocalCatalogEntry(participant: ParticipantPin(id: id, label: name, model: "\(name)@\(digest)", executionHost: host)!,
                              available: available)
        }
        let unreadable = LocalCatalogAnswer.unavailable(reason: "catalog-unreadable")
        #expect(LocalCatalogAnswer.ready([entry("b:1b"), entry("a:1b")]).checked == unreadable, "out of order")
        #expect(LocalCatalogAnswer.ready([entry("a:1b"), entry("a:1b")]).checked == unreadable, "a name twice")
        #expect(LocalCatalogAnswer.ready([entry("a:1b", digest: "abc")]).checked == unreadable, "short digest")
        #expect(LocalCatalogAnswer.ready([entry("a:1b", digest: String(repeating: "C3", count: 32))]).checked == unreadable)
        #expect(LocalCatalogAnswer.ready([entry("a:1b", id: "claude-code")]).checked == unreadable)
        #expect(LocalCatalogAnswer.ready([entry("a:1b", host: "elsewhere")]).checked == unreadable)
        #expect(LocalCatalogAnswer.ready([entry("a:cloud")]).checked == .ready([entry("a:cloud", available: false)]))
        let many = (0..<257).map { entry(String(format: "m%04d:1b", $0)) }
        #expect(LocalCatalogAnswer.ready(many).checked == .unavailable(reason: "catalog-too-large"))
        #expect(LocalCatalogAnswer.ready(Array(many.prefix(256))).checked == .ready(Array(many.prefix(256))))
        #expect(LocalCatalogAnswer.unavailable(reason: "invented-reason").checked == unreadable)
        #expect(LocalCatalogAnswer.unavailable(reason: "host-not-loopback").checked == .unavailable(reason: "host-not-loopback"))
    }
}

/// A participant host with a local route, on a fresh store at revision 4.
private final class LocalHost {
    let fixture: DeskHostFixture
    let store: ProofStore
    let connections: ConnectionRegistry
    let host: DeskHostProtocol
    let connection: HostConnection

    init(route: FakeLocalCatalog, connections: ConnectionRegistry = ConnectionRegistry(),
         seed: [String: JSONValue] = ["schemaVersion": .number(1), "revision": .number(4)]) throws {
        fixture = try DeskHostFixture()
        store = try fixture.makeStore(seed: WorkspaceSeed(workspaceHandle: "invented-workspace-handle", record: seed))
        self.connections = connections
        host = DeskHostProtocol(store: store, connections: connections, drafts: DraftBindingRegistry(), info: HostHarness.info,
                                events: RecordingSink(), participants: ParticipantHostConfiguration(pin: Local.claudePin, localRoute: route))
        connection = connections.issue()
    }

    func clean() {
        store.close()
        fixture.clean()
    }

    func commit(expected: Int, record: [String: JSONValue], claim: JSONValue) async -> HostResponse {
        await host.handle(HostRequest(requestId: UUID(), connectionId: connection.id, generation: connection.generation,
                                      operation: .workspaceCommitProof,
                                      payload: ["workspaceHandle": .string("invented-workspace-handle"),
                                                "expectedRevision": .number(Double(expected)), "record": .object(record),
                                                "participantRun": claim]))
    }
}
