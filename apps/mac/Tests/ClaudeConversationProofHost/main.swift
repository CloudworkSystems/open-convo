import Darwin
import DeskHost
import Foundation

// The Claude Code adapter's PR 4-proof: the fake-CLI kill proof's app.
// Test-only, never bundled.
//
// It plays True Convo Test with its Desk open and the Claude Code entry
// wired as PR 4b will wire it: the app's own Claude pin
// (`LocalConversationLane.claudePin`), the real coordinator over section
// 17's real owner, the real `DeskHostProtocol` reached the way the app's
// message handler reaches it, the real encrypted `ProofStore` (section
// 21.4's approval lives there), and the production launcher
// (`ProcessParticipantLauncher`) with the real supervisor. Only the CLI is
// the test's fake (`ParticipantFakeCLI`, never the real one), and section 5's
// local checks and macOS's owner check are invented passes, since neither
// can run here. The app's own lane is untouched: True Convo Test still gets
// `ClaudeNotConnected` until PR 4b. A small stand-in for the page saves each
// pushed event into the conversation record the way the Desk does, and
// prints a line only after that save has returned, so the proof can SIGKILL
// it at an exact point. Invented text only.
//
//   ClaudeConversationProofHost <store-folder> <keys-folder> <supervisor> <cli> <run-folder>
//
// Prints `ready` once the Desk is open. Commands, one per line on stdin:
//   approve            approves Anthropic in the store (section 21.4):
//                      `approved <true|false>`
//   confirm            the owner's paid-usage confirmation (section 17):
//                      `confirm <outcome>`
//   revoke             withdraws the approval: `revoked <true|false>`
//   end                ends the confirmation as a screen lock does: `ended-confirmation`
//   availability       `availability <available|reason>` for the Claude entry
//   prepare            the earlier turn, then the new turn as a prepared
//                      Claude run naming it as context: `prepared <runId>`
//   draft              another prepared run of the same message, new ids,
//                      the completed turns as context: `prepared <runId>`
//   start <runId>      `start <outcome> <reason|->`
//   status <runId>     `status <reply JSON>`
//   record             `record <conversationRuns JSON>`
//   events <runId>     `events <reply JSON>`, from the saved lastSequence
//   busy               `busy <true|false>`: whether the Desk would hold Send
//   close <runId>      "Close as unknown", saved: `closed <true|false>`
//   retry <runId>      the owner's Retry then Send, under the Desk's rules:
//                      `retry refused <not-retryable|busy>`, or a new
//                      prepared run with new ids and the same message, then
//                      its start: `prepared <newRunId>`, `start <outcome> <reason|->`
//   quit               the app's quit, as the Desk session does it:
//                      `quit reachedBound=<bool>`, then exit 0
// And on its own, after each pushed event's save has returned:
//   `saved <runId> <sequence> <type> <chars>` (chars: the run's saved reply)
//   `ended <runId> <type> <reason|->` after a terminal event's save

#if DEBUG
// The internal initializers reached here (the owner over invented checks,
// the app's pin) are reachable only in a debug build with testing enabled,
// which is what `swift build` and `swift test` make. A release build of
// this helper only refuses to run.
@testable import ParticipantAppWiring
import ParticipantCoordinator
@testable import ParticipantProcess

let outputLock = NSLock()
func say(_ line: String) {
    outputLock.lock()
    defer { outputLock.unlock() }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("ClaudeConversationProofHost: " + message + "\n").utf8))
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

/// Section 5's local checks as an invented pass: the pinned version, a Max
/// plan login and an invented account. The real checks run the real CLI's
/// `--version` and `auth status`, which the proof never does.
struct InventedPassingChecks: ClaudeLocalChecking {
    static let result: ClaudeLocalCheckResult = {
        var info = stat()
        info.st_dev = 1
        info.st_ino = 4_242
        info.st_size = 1_000
        info.st_mtimespec = timespec(tv_sec: 1_700_000_000, tv_nsec: 0)
        info.st_ctimespec = timespec(tv_sec: 1_700_000_000, tv_nsec: 0)
        return .passed(ClaudeLocalSnapshot(
            cliVersion: ParticipantCommandLine.pinnedCLIVersion, fileIdentity: ClaudeCLIFileIdentity(info),
            loginKind: .subscription(.max),
            account: ClaudeAccountComparator(email: "invented-person@invented.invalid", organization: "invented-organization",
                                             key: [UInt8](repeating: 7, count: 32))))
    }()

    func evaluate() async -> ClaudeLocalCheckResult { Self.result }
    func evaluateFresh() async -> ClaudeLocalCheckResult { Self.result }
}

/// macOS's owner check as an invented yes, answered at once.
struct InventedOwnerYes: OwnerAuthentication {
    struct Request: OwnerAuthenticationRequest { func cancel() {} }

    func requestOwnerAuthentication(_ completion: @escaping @Sendable (OwnerAuthenticationOutcome) -> Void)
        -> any OwnerAuthenticationRequest {
        completion(.authenticated)
        return Request()
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

/// The invented conversation: the same words as the local proof's, on the
/// Claude pin.
enum Invented {
    static let pin = LocalConversationLane.claudePin
    static let sessionId = "52abcdef-0000-4000-8abc-000000000a01"
    static let earlierRunId = "71abcdef-0000-4000-8abc-000000000a01"
    static let runId = "71abcdef-0000-4000-8abc-000000000a02"
    static let earlierInput = "My invented bakery is called Maple Crumb."
    static let earlierOutput = "Noted: Maple Crumb."
    static let input = ["What is my invented bakery ", "called?"]
    static let createdAt = "2026-10-31T07:00:00.000Z"
    /// What the fake's init line reports (`ParticipantClaudeKillProofTests`
    /// writes it): the pin's model, no tools and the fake's one invented
    /// slash command.
    static let expectedInit = ParticipantInitExpectation(model: pin.model, slashCommands: ["invented-command"], skills: [],
                                                         plugins: .array([]), apiKeySource: "none")
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
            var fields: [String: JSONValue] = ["participantId": .string(Invented.pin.id)]
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
    /// new turn prepared with the earlier one as context, as the Desk's
    /// `selectClaudeContext` picks it (well inside section 21.2's bound).
    func prepare() async throws -> String {
        var earlier = Self.prepared(Invented.earlierRunId, user: "72abcdef-0000-4000-8abc-000000000a01",
                                    assistant: "73abcdef-0000-4000-8abc-000000000a01", input: [Invented.earlierInput],
                                    context: [], at: Invented.createdAt)
        try await save([.object(earlier)], claim: Invented.earlierRunId)
        earlier["phase"] = .string("completed")
        earlier["outputChunks"] = .array([.string(Invented.earlierOutput)])
        earlier["lastSequence"] = .number(3)
        earlier["updatedAt"] = .string("2026-10-31T07:00:05.000Z")
        try await save([.object(earlier)])
        let next = Self.prepared(Invented.runId, user: "72abcdef-0000-4000-8abc-000000000a02",
                                 assistant: "73abcdef-0000-4000-8abc-000000000a02", input: Invented.input,
                                 context: [Invented.earlierRunId], at: Invented.createdAt)
        try await save([.object(earlier), .object(next)], claim: Invented.runId)
        return Invented.runId
    }

    // The Desk's own rules, ported line for line so this stand-in cannot do
    // what the page would not.

    /// `isConversationRunClosed` (domain/conversation-runs.ts): a recorded
    /// ending, or a saved closure.
    static func isClosed(_ run: [String: JSONValue]) -> Bool {
        ["completed", "stopped", "failed"].contains(run["phase"]?.stringValue ?? "") || run["closure"] != nil
    }

    /// `canRetryClaudeRun` (domain/claude-participant.ts): an off-Mac Claude
    /// run whose reply ended without completing: closed by the owner,
    /// stopped or failed.
    static func canRetry(_ run: [String: JSONValue]) -> Bool {
        guard let participant = run["participant"]?.objectValue, participant["id"] == .string("claude-code"),
              participant["executionHost"] == .string("anthropic") else { return false }
        if let closure = run["closure"]?.objectValue {
            return !(closure["kind"] == .string("interrupted")
                     && closure["terminalEvent"]?.objectValue?["type"] == .string("completed"))
        }
        return ["stopped", "failed"].contains(run["phase"]?.stringValue ?? "")
    }

    /// `busy` (app/use-conversation-runs.tsx), its saved-record part: Send
    /// waits while any run of the session is not closed.
    func busy(_ sessionId: String) -> Bool {
        runs.contains { value in
            guard let run = value.objectValue, run["sessionId"] == .string(sessionId) else { return false }
            return !Self.isClosed(run)
        }
    }

    var sessionBusy: Bool { busy(Invented.sessionId) }

    /// The Claude entry's line in `participant.availability`.
    func claudeAvailability() async -> String {
        let reply = await ask(.participantAvailability, [:])
        guard case .array(let participants)? = reply.fields["participants"],
              let claude = participants.compactMap(\.objectValue).first(where: { $0["id"] == .string(Invented.pin.id) }) else {
            return "missing"
        }
        if claude["available"] == .bool(true) { return "available" }
        return claude["reason"]?.stringValue ?? "unknown"
    }

    /// What the restored page reads for an unfinished run, after `status`:
    /// `participant.events` from the saved `lastSequence`.
    func events(_ runId: String) async -> HostResponse {
        let after = run(runId)?["lastSequence"] ?? .number(0)
        return await ask(.participantEvents, ["workspaceHandle": .string(handle), "runId": .string(runId),
                                              "sessionId": .string(Invented.sessionId), "afterSequence": after,
                                              "maxEvents": .number(64)])
    }

    /// "Close as unknown" (`closeConversationRun` with `{kind: 'unknown',
    /// reason: 'user-closed', at}`), saved: the saved text and sequence stay,
    /// and nothing is claimed about how the reply ended.
    func closeAsUnknown(_ runId: String) async throws -> Bool {
        guard let index = runs.firstIndex(where: { $0.objectValue?["runId"] == .string(runId) }),
              var run = runs[index].objectValue, !Self.isClosed(run) else { return false }
        let at = max(now(), run["updatedAt"]?.stringValue ?? "")
        run["closure"] = .object(["kind": .string("unknown"), "reason": .string("user-closed"), "at": .string(at)])
        var next = runs
        next[index] = .object(run)
        try await save(next)
        return true
    }

    /// Retry, then Send, each under the Desk's rule: Retry only when
    /// `canRetryClaudeRun`, Send only when the session is not busy. The
    /// message goes again as a new run with new ids; its context is the
    /// session's completed runs, so a cut-off reply is never sent as
    /// context. The old run is left exactly as it is.
    func retry(_ oldRunId: String) async throws -> (runId: String?, refusal: String?) {
        guard let old = run(oldRunId), case .array(let input)? = old["inputChunks"] else { throw PageError.save("no run \(oldRunId)") }
        guard Self.canRetry(old) else { return (nil, "not-retryable") }
        guard !sessionBusy else { return (nil, "busy") }
        let context = runs.compactMap { value -> String? in
            guard let run = value.objectValue, run["phase"] == .string("completed") else { return nil }
            return run["runId"]?.stringValue
        }
        let runId = newId()
        let next = Self.prepared(runId, user: newId(), assistant: newId(), input: input.compactMap(\.stringValue),
                                 context: context, at: now())
        try await save(runs + [.object(next)], claim: runId)
        return (runId, nil)
    }

    /// Another prepared run of the same message with new ids, as Send
    /// makes one, its context the session's completed turns. Not started.
    /// It skips the Desk's busy rule on purpose: the closed-gate proof
    /// tries starts the page would not offer, to show the Mac app's own
    /// gates refuse them.
    func draft() async throws -> String {
        let context = runs.compactMap { value -> String? in
            guard let run = value.objectValue, run["phase"] == .string("completed") else { return nil }
            return run["runId"]?.stringValue
        }
        let runId = newId()
        try await save(runs + [.object(Self.prepared(runId, user: newId(), assistant: newId(), input: Invented.input,
                                                     context: context, at: now()))], claim: runId)
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
guard arguments.count == 6 else { fail("usage: <store-folder> <keys-folder> <supervisor> <cli> <run-folder>") }
let folder = URL(fileURLWithPath: arguments[1], isDirectory: true)
let keys = InventedFileKeys(folder: URL(fileURLWithPath: arguments[2], isDirectory: true))
let parent: ParticipantsParent
do { parent = try ParticipantsFolder.prepare(in: URL(fileURLWithPath: arguments[5], isDirectory: true)) } catch { fail("participants: \(error)") }

// The Desk opens, in the session's order (DeskSession.openStack): the
// store, the launch's one lane, its host, attach, unlock, the lane's one
// pass of owed writes, any dispatch recovery, then the page's document and
// connection. Section 17's owner reads section 21.4's approval from this
// store, as `PaidUsageConfirmationOwner(checks:store:)` does in the app.
let store: ProofStore
do { store = try ProofStore(directory: folder, keys: keys, seed: .inventedRevisionZero()) } catch { fail("open: \(error)") }
let owner = PaidUsageConfirmationOwner(checks: InventedPassingChecks(), approval: store, authentication: InventedOwnerYes())
let launcher = ProcessParticipantLauncher(supervisorPath: arguments[3], cliPath: arguments[4], workingParent: parent,
                                          expectedInit: Invented.expectedInit)
let coordinator = ParticipantCoordinator(configuration: ParticipantCoordinator.Configuration(
    hostConfiguration: ParticipantHostConfiguration(pin: Invented.pin, inputBound: ParticipantLimits.firstTrialInputBound),
    confirmationOwner: owner, launchId: newId(), clock: SystemParticipantClock(), executor: BackgroundMutationExecutor(),
    launcher: launcher, log: SystemParticipantLog()))
let lane: any DeskParticipantLane = coordinator
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
        case ("approve"?, 1):
            say("approved \((try? store.approveHost(HostApproval.anthropic)) != nil)")
        case ("revoke"?, 1):
            say("revoked \((try? store.revokeHost(HostApproval.anthropic)) != nil)")
        case ("end"?, 1):
            owner.end(.lock)
            say("ended-confirmation")
        case ("draft"?, 1):
            do { say("prepared \(try await page.draft())") } catch { fail("draft: \(error)") }
        case ("confirm"?, 1):
            say("confirm \(await owner.confirm())")
        case ("availability"?, 1):
            say("availability \(await page.claudeAvailability())")
        case ("prepare"?, 1):
            do { say("prepared \(try await page.prepare())") } catch { fail("prepare: \(error)") }
        case ("start"?, 2):
            say(startLine(await page.start(words[1])))
        case ("status"?, 2):
            say("status " + String(decoding: await page.status(words[1]).canonicalData(), as: UTF8.self))
        case ("record"?, 1):
            say("record " + String(decoding: await page.record.canonicalData(), as: UTF8.self))
        case ("events"?, 2):
            say("events " + String(decoding: await page.events(words[1]).canonicalData(), as: UTF8.self))
        case ("busy"?, 1):
            say("busy \(await page.sessionBusy)")
        case ("close"?, 2):
            do { say("closed \(try await page.closeAsUnknown(words[1]))") } catch { fail("close: \(error)") }
        case ("retry"?, 2):
            let result: (runId: String?, refusal: String?)
            do { result = try await page.retry(words[1]) } catch { fail("retry: \(error)") }
            guard let runId = result.runId else { say("retry refused \(result.refusal ?? "-")"); continue }
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
FileHandle.standardError.write(Data("ClaudeConversationProofHost: debug builds only\n".utf8))
exit(2)
#endif
