import DeskHost
import Foundation

// Step 3, PR 5: the kill-mid-reply proof's app. Test-only, never bundled.
//
// It plays True Convo Test with its Desk open: the app's own lane
// (`LocalConversationLane.makeCoordinator`, the real coordinator with the
// real `OllamaClient`, held as `any DeskParticipantLane` as the Desk session
// holds it), the real `DeskHostProtocol` reached the way the app's message
// handler reaches it, and the real encrypted `ProofStore`, with Ollama
// played by the test's fake on another loopback port. A small stand-in for the page saves each pushed
// event into the conversation record the way the Desk does, and prints a
// line only after that save has returned, so the proof can SIGKILL it at an
// exact point. Invented text only.
//
//   LocalConversationProofHost <store-folder> <keys-folder> <ollama-port>
//
// Prints `ready` once the Desk is open. Commands, one per line on stdin:
//   prepare            the earlier turn, then the new turn as a prepared
//                      local run naming it as context: `prepared <runId>`
//   start <runId>      `start <outcome> <reason|->`
//   status <runId>     `status <reply JSON>`
//   record             `record <conversationRuns JSON>`
//   retry <runId>      the owner's Retry then Send: a new prepared run with
//                      new ids and the same message, then its start:
//                      `prepared <newRunId>`, `start <outcome> <reason|->`
//   quit               the app's quit, as the Desk session does it:
//                      `quit reachedBound=<bool>`, then exit 0
// And on its own, after each pushed event's save has returned:
//   `saved <runId> <sequence> <type> <chars>` (chars: the run's saved reply)
//   `ended <runId> <type> <reason|->` after a terminal event's save

#if DEBUG
// The internal initializers reached here (the fake's port; the app's own
// coordinator) are reachable only in a debug build with testing enabled,
// which is what `swift build` and `swift test` make. A release build of
// this helper only refuses to run.
@testable import LocalModelRoute
@testable import ParticipantAppWiring

let outputLock = NSLock()
func say(_ line: String) {
    outputLock.lock()
    defer { outputLock.unlock() }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("LocalConversationProofHost: " + message + "\n").utf8))
    exit(2)
}

/// Invented keys in files, one per id (0600), so the next launch opens the
/// same store, as the Keychain would let it. Test-only.
final class InventedFileKeys: KeyProvider, @unchecked Sendable {
    let folder: URL
    init(folder: URL) { self.folder = folder }

    private func url(_ id: UUID) -> URL { folder.appendingPathComponent(id.uuidString + ".key") }

    func existingKey(for storeId: UUID) throws -> StoreKey? {
        guard let data = try? Data(contentsOf: url(storeId)) else { return nil }
        return StoreKey(storeId: storeId, material: data, custody: "invented-file-test-only")
    }

    func createKey(for storeId: UUID) throws -> StoreKey {
        guard try existingKey(for: storeId) == nil else { throw KeyProviderError.keyExists }
        var generator = SystemRandomNumberGenerator()
        let material = Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let temporary = folder.appendingPathComponent(".\(UUID().uuidString).tmp")
        guard FileManager.default.createFile(atPath: temporary.path, contents: material,
                                             attributes: [.posixPermissions: NSNumber(value: 0o600)]),
              rename(temporary.path, url(storeId).path) == 0 else { throw KeyProviderError.unavailable }
        return StoreKey(storeId: storeId, material: material, custody: "invented-file-test-only")
    }
}

/// The stack's sink: every participant event goes to the page stand-in.
final class PageSink: HostEventSink, @unchecked Sendable {
    let events: AsyncStream<JSONValue>
    private let continuation: AsyncStream<JSONValue>.Continuation

    init() {
        var continuation: AsyncStream<JSONValue>.Continuation!
        events = AsyncStream(bufferingPolicy: .unbounded) { continuation = $0 }
        self.continuation = continuation
    }

    func push(_ event: HostEvent) {
        if case .participantEvent(_, _, let detail) = event { continuation.yield(detail) } // the event object itself
    }
}

/// The invented conversation (the same ids and words as `LocalStartWorld`).
enum Invented {
    static let pin = ParticipantPin(id: "ollama-local", label: "invented-local-small:7b",
                                    model: "invented-local-small:7b@" + String(repeating: "c3", count: 32),
                                    executionHost: "this-mac")!
    static let sessionId = "52abcdef-0000-4000-8abc-000000000901"
    static let earlierRunId = "71abcdef-0000-4000-8abc-000000000801"
    static let runId = "71abcdef-0000-4000-8abc-000000000901"
    static let earlierInput = "My invented bakery is called Maple Crumb."
    static let earlierOutput = "Noted: Maple Crumb."
    static let input = ["What is my invented bakery ", "called?"]
    static let createdAt = "2026-10-15T07:00:00.000Z"
}

func now() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(identifier: "UTC")
    return formatter.string(from: Date())
}

func newId() -> String { UUID().uuidString.lowercased() }

enum PageError: Error { case save(String) }

/// What the Desk page does with the record and the wire, reduced to what
/// the proof needs: one save at a time, each after the last returned.
actor Page {
    let host: DeskHostProtocol
    let lane: any DeskParticipantLane
    let handle: String
    let connectionId: String
    let generation: Int
    private var revision: Int
    private var runs: [JSONValue]

    init(host: DeskHostProtocol, lane: any DeskParticipantLane, store: ProofStore, connection: HostConnection) throws {
        self.host = host
        self.lane = lane
        handle = store.workspaceHandle
        connectionId = connection.id
        generation = connection.generation
        let committed = try store.read()
        revision = committed.revision
        if case .array(let saved)? = committed.record["conversationRuns"] { runs = saved } else { runs = [] }
    }

    /// As the app's `HostMessageHandler` routes a request: `participant.*`
    /// to the lane; a commit first waits for the lane's pass of the writes
    /// it owes; then the host.
    func ask(_ operation: HostOperation, _ payload: [String: JSONValue]) async -> HostResponse {
        let request = HostRequest(requestId: UUID(), connectionId: connectionId, generation: generation,
                                  operation: operation, payload: payload)
        if request.operation.isParticipant { return await lane.handle(request) }
        if request.operation.waitsForOwedParticipantWrites { await lane.reconcileBeforeStoreWork(ahead: request, host: host) }
        return await host.handle(request)
    }

    private func run(_ runId: String) -> [String: JSONValue]? {
        runs.first { $0.objectValue?["runId"] == .string(runId) }?.objectValue
    }

    /// One `workspace.commitProof` of `next`, with the claim for `claim`.
    private func save(_ next: [JSONValue], claim: String? = nil) async throws {
        var payload: [String: JSONValue] = [
            "workspaceHandle": .string(handle), "expectedRevision": .number(Double(revision)),
            "record": .object(["schemaVersion": .number(2), "revision": .number(Double(revision + 1)),
                               "conversationRuns": .array(next)])]
        if let claim, let run = next.first(where: { $0.objectValue?["runId"] == .string(claim) })?.objectValue {
            var fields: [String: JSONValue] = ["participantId": .string("ollama-local")]
            for key in ["runId", "sessionId", "userMessageId", "assistantMessageId", "createdAt"] { fields[key] = run[key] }
            payload["participantRun"] = .object(fields)
        }
        let reply = await ask(.workspaceCommitProof, payload)
        guard reply.outcome == .ok else { throw PageError.save(String(decoding: reply.canonicalData(), as: UTF8.self)) }
        revision += 1
        runs = next
    }

    static func prepared(_ runId: String, user: String, assistant: String, input: [String], context: [String],
                         at: String) -> [String: JSONValue] {
        ["version": .number(1), "runId": .string(runId), "sessionId": .string(Invented.sessionId),
         "userMessageId": .string(user), "assistantMessageId": .string(assistant), "participant": Invented.pin.jsonValue,
         "inputChunks": .array(input.map(JSONValue.string)), "outputChunks": .array([]), "lastSequence": .number(0),
         "phase": .string("prepared"), "createdAt": .string(at), "updatedAt": .string(at),
         "contextRunIds": .array(context.map(JSONValue.string))]
    }

    /// The earlier turn (prepared, then completed with its reply), then the
    /// new turn prepared with the earlier one as context.
    func prepare() async throws -> String {
        var earlier = Self.prepared(Invented.earlierRunId, user: "72abcdef-0000-4000-8abc-000000000801",
                                    assistant: "73abcdef-0000-4000-8abc-000000000801", input: [Invented.earlierInput],
                                    context: [], at: Invented.createdAt)
        try await save([.object(earlier)], claim: Invented.earlierRunId)
        earlier["phase"] = .string("completed")
        earlier["outputChunks"] = .array([.string(Invented.earlierOutput)])
        earlier["lastSequence"] = .number(3)
        earlier["updatedAt"] = .string("2026-10-15T07:00:05.000Z")
        try await save([.object(earlier)])
        let next = Self.prepared(Invented.runId, user: "72abcdef-0000-4000-8abc-000000000901",
                                 assistant: "73abcdef-0000-4000-8abc-000000000901", input: Invented.input,
                                 context: [Invented.earlierRunId], at: Invented.createdAt)
        try await save([.object(earlier), .object(next)], claim: Invented.runId)
        return Invented.runId
    }

    /// Retry, then Send: the message back in the composer and sent again as
    /// a new run with new ids. Its context is the session's completed runs,
    /// so a cut-off reply is never sent as context. The old run is left
    /// exactly as it is.
    func retry(_ oldRunId: String) async throws -> String {
        guard let old = run(oldRunId), case .array(let input)? = old["inputChunks"] else { throw PageError.save("no run \(oldRunId)") }
        let context = runs.compactMap { value -> String? in
            guard let run = value.objectValue, run["phase"] == .string("completed") else { return nil }
            return run["runId"]?.stringValue
        }
        let runId = newId()
        let next = Self.prepared(runId, user: newId(), assistant: newId(), input: input.compactMap(\.stringValue),
                                 context: context, at: now())
        try await save(runs + [.object(next)], claim: runId)
        return runId
    }

    func start(_ runId: String) async -> HostResponse? {
        guard let run = run(runId) else { return nil }
        var payload: [String: JSONValue] = ["workspaceHandle": .string(handle)]
        for key in ["runId", "sessionId", "userMessageId", "assistantMessageId", "participant", "inputChunks"] {
            payload[key] = run[key]
        }
        return await ask(.participantStart, payload)
    }

    func status(_ runId: String) async -> HostResponse {
        await ask(.participantStatus, ["workspaceHandle": .string(handle), "runId": .string(runId),
                                       "sessionId": .string(Invented.sessionId)])
    }

    var record: JSONValue { .array(runs) }

    /// A pushed event saved into its run, as the Desk's run transcript does.
    func accept(_ event: [String: JSONValue]) async {
        guard let runId = event["runId"]?.stringValue, let type = event["type"]?.stringValue,
              let sequence = event["sequence"]?.safeIntegerValue,
              let index = runs.firstIndex(where: { $0.objectValue?["runId"] == .string(runId) }),
              var run = runs[index].objectValue, case .array(var output)? = run["outputChunks"] else { return }
        switch type {
        case "started":
            run["phase"] = .string("running")
        case "text":
            guard let text = event["text"]?.stringValue else { return }
            output.append(.string(text))
            run["phase"] = .string("running")
        case "completed", "stopped", "failed":
            run["phase"] = .string(type)
            if type != "completed", let reason = event["reason"] { run["reason"] = reason }
        default:
            return
        }
        run["outputChunks"] = .array(output)
        run["lastSequence"] = .number(Double(sequence))
        run["updatedAt"] = .string(now())
        var next = runs
        next[index] = .object(run)
        do {
            try await save(next)
        } catch {
            fail("saving event \(sequence) of \(runId): \(error)")
        }
        let chars = output.compactMap(\.stringValue).joined().count
        say("saved \(runId) \(sequence) \(type) \(chars)")
        if ["completed", "stopped", "failed"].contains(type) {
            say("ended \(runId) \(type) \(event["reason"]?.stringValue ?? "-")")
        }
    }
}

func startLine(_ reply: HostResponse?) -> String {
    guard let reply else { return "start missing-run -" }
    return "start \(reply.outcome.rawValue) \(reply.fields["reason"]?.stringValue ?? "-")"
}

/// Commands from stdin, read on a thread of their own so no task blocks.
func commandLines() -> AsyncStream<String> {
    var continuation: AsyncStream<String>.Continuation!
    let stream = AsyncStream<String>(bufferingPolicy: .unbounded) { continuation = $0 }
    let lines = continuation!
    Thread {
        while let line = readLine() { lines.yield(line) }
        lines.finish()
    }.start()
    return stream
}

let arguments = CommandLine.arguments
guard arguments.count == 4, let port = UInt16(arguments[3]) else { fail("usage: <store-folder> <keys-folder> <ollama-port>") }
let folder = URL(fileURLWithPath: arguments[1], isDirectory: true)
let keys = InventedFileKeys(folder: URL(fileURLWithPath: arguments[2], isDirectory: true))

// The Desk opens, in the session's order (DeskSession.openStack): the
// launch's one lane (its launch sweep starts as it is made), its host over a
// new store on the folder, attach, unlock, the lane's one pass of owed
// writes, any dispatch recovery, then the page's document and connection.
// The lane is held as the Desk session holds it, through DeskHost's seam.
let lane: any DeskParticipantLane = LocalConversationLane.makeCoordinator(
    route: OllamaClient(endpoint: OllamaEndpoint(port: port)), launchId: newId())
let store: ProofStore
do { store = try ProofStore(directory: folder, keys: keys, seed: .inventedRevisionZero()) } catch { fail("open: \(error)") }
let sink = PageSink()
let connections = ConnectionRegistry()
let host = lane.makeHost(store: store, connections: connections, drafts: DraftBindingRegistry(),
                                info: HostInfo(appVersion: "invented-proof-version", hostBuild: "invented-proof-build"),
                                events: sink)
let commands = commandLines()

Task {
    do {
        try await lane.attach(host: host, store: store, connections: connections, sink: sink)
    } catch {
        fail("attach: \(error)")
    }
    await lane.unlock(ifNoLockSince: lane.lockEpoch)
    await lane.reconcileBeforeStoreWork()
    if await host.outstandingMutation != nil {
        do { _ = try await host.recoverUnresolvedDispatch() } catch { fail("recover: \(error)") }
    }
    await host.beginGeneration()
    let connection = await host.issueConnection()
    let page: Page
    do {
        page = try Page(host: host, lane: lane, store: store, connection: connection)
    } catch {
        fail("read: \(error)")
    }
    Task {
        for await event in sink.events {
            if let fields = event.objectValue { await page.accept(fields) }
        }
    }
    say("ready")
    for await line in commands {
        let words = line.split(separator: " ").map(String.init)
        switch (words.first, words.count) {
        case ("prepare"?, 1):
            do { say("prepared \(try await page.prepare())") } catch { fail("prepare: \(error)") }
        case ("start"?, 2):
            say(startLine(await page.start(words[1])))
        case ("status"?, 2):
            say("status " + String(decoding: await page.status(words[1]).canonicalData(), as: UTF8.self))
        case ("record"?, 1):
            say("record " + String(decoding: await page.record.canonicalData(), as: UTF8.self))
        case ("retry"?, 2):
            let runId: String
            do { runId = try await page.retry(words[1]) } catch { fail("retry: \(error)") }
            say("prepared \(runId)")
            say(startLine(await page.start(runId)))
        case ("quit"?, 1):
            // As the Desk session quits with the Desk open (contract section
            // 14, S10 reading 1 and S11 readings 5 and 6).
            lane.beginShutdown(quitting: true)
            await host.revokeForShutdown()
            let report = await lane.finishShutdown(quitting: true)
            await host.closeStore()
            await lane.detach()
            say("quit reachedBound=\(report.reachedBound)")
            exit(0)
        default:
            fail("unknown command \(line)")
        }
    }
    exit(0)
}
RunLoop.main.run()
#else
FileHandle.standardError.write(Data("LocalConversationProofHost: debug builds only\n".utf8))
exit(2)
#endif
