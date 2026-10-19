import Darwin
import DeskHost
import Foundation
@testable import LocalModelRoute
import Testing

// Step 3, PR 5: the kill-mid-reply proof, with invented text only.
//
// `LocalConversationProofHost` plays True Convo Test with the Desk open: the
// app's own lane (the real coordinator and `OllamaClient`), the real host
// and router, and the real encrypted store, with a small page stand-in that
// saves each streamed event the way the Desk does. Ollama is `VectorOllama`,
// a fake on a random loopback port inside this test process, so it outlives
// every app it serves and logs every request.
//
// Each round prepares a turn that has an earlier turn as context, starts
// it, and SIGKILLs the app (no handler runs, as with a crash or a force
// quit) at one exact point, chosen only after an explicit handshake, never
// on timing: the fake has the chat request and has not answered it, or the
// app printed that its save of the reply so far returned (after one, three
// or six pieces; after six, a seventh is in flight at the kill). A fresh app then opens the same folder,
// and the proof checks:
// - the run reads as cut off (`unknown`, `exit-unrecorded`), with exactly
//   the text saved so far kept, nothing doubled;
// - until the owner closes it, the Desk's own rules hold: Retry is not
//   offered and Send waits (busy). The restored page's recovery (status,
//   then events, which answer `lost` `restarted` with no ending) leads to
//   "Close as unknown"; once that closure is saved the run reads as cut off,
//   its text unchanged, and Send is free;
// - nothing was sent again on its own: Ollama saw one `/api/chat` for it;
// - the run's leftover `open-convo-run-…:pin` alias is swept at launch;
// - Retry (allowed now, by the Desk's `canRetryLocalRun`), then Send: a new
//   prepared run from the same message, new ids, sends exactly one new chat
//   with the same context and message, completes, and leaves the closed old
//   run exactly as it was.
// The page side of the same path (the real Desk restoring a crashed run,
// offering Close as unknown, then Retry) is in the Desk's
// `tests/foundation/local-conversation.test.mjs`.
// A graceful quit mid-reply is checked the same way: it records `stopped`,
// not cut off, deletes the alias itself, and there is still one chat.

/// The proof's app as a child process, driven over stdin and stdout.
final class ProofApp: @unchecked Sendable {
    static var path: String { Products.path("LocalConversationProofHost") }

    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errors = Pipe()
    private let lock = NSLock()
    private var buffer = Data()
    private var errorText = Data()
    private var taken: Set<Int> = []

    init(_ world: ProofWorld) throws {
        // A missing app fails the proof, never skips it: a skipped proof
        // must not read as a passed one.
        guard FileManager.default.isExecutableFile(atPath: Self.path) else { throw ProofAppError.missing(Self.path) }
        process.executableURL = URL(fileURLWithPath: Self.path)
        process.arguments = [world.store.path, world.keys.path, String(world.fake.port)]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        // At end of file a handler is called again and again with no data:
        // it lets go of itself then.
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { self?.append(data, error: false) }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { self?.append(data, error: true) }
        }
        try process.run()
    }

    deinit {
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        output.fileHandleForReading.readabilityHandler = nil
        errors.fileHandleForReading.readabilityHandler = nil
    }

    private func append(_ data: Data, error: Bool) {
        lock.lock(); defer { lock.unlock() }
        if error { errorText.append(data) } else { buffer.append(data) }
    }

    /// Every whole line printed so far.
    var lines: [String] {
        lock.lock(); defer { lock.unlock() }
        return String(decoding: buffer, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false).dropLast().map(String.init)
    }

    var detail: String {
        lock.lock(); let errors = String(decoding: errorText, as: UTF8.self); lock.unlock()
        return "lines=\(lines.suffix(12)) stderr=\(errors.suffix(400))"
    }

    func send(_ command: String) {
        try? input.fileHandleForWriting.write(contentsOf: Data((command + "\n").utf8))
    }

    /// Waits for the first line not yet taken that starts with `prefix`,
    /// takes it and returns the rest of it.
    @discardableResult
    func next(_ prefix: String, seconds: Double = 20) async throws -> String {
        let deadline = Date().addingTimeInterval(seconds)
        while true {
            if let found = take(prefix) { return found }
            guard process.isRunning, Date() < deadline else { throw ProofAppError.noLine(prefix, detail) }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    private func take(_ prefix: String) -> String? {
        let all = lines
        lock.lock(); defer { lock.unlock() }
        guard let found = all.indices.first(where: { !taken.contains($0) && all[$0].hasPrefix(prefix) }) else { return nil }
        taken.insert(found)
        return String(all[found].dropFirst(prefix.count))
    }

    /// The handshake: waits until the app says its save of `runId`'s
    /// `type` event returned, holding `chars` characters of reply.
    func saved(_ runId: String, _ type: String, chars: Int) async throws {
        let deadline = Date().addingTimeInterval(20)
        while true {
            let found = lines.contains { line in
                let words = line.split(separator: " ")
                return words.count == 5 && words[0] == "saved" && words[1] == runId && words[3] == type && words[4] == "\(chars)"
            }
            if found { return }
            guard process.isRunning, Date() < deadline else { throw ProofAppError.noLine("saved \(runId) \(type) \(chars)", detail) }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    /// A command whose answer is one JSON line.
    func json(_ command: String, _ prefix: String) async throws -> JSONValue {
        send(command)
        return try JSONValue.decode(Data(try await next(prefix + " ").utf8))
    }

    /// SIGKILL, the way a crash, a force quit or `kill -9` ends the app;
    /// returns once it is gone. (Polled: `waitUntilExit` relies on a run
    /// loop a test task does not have.)
    func kill9() async throws {
        kill(process.processIdentifier, SIGKILL)
        _ = try await waitForExit(seconds: 10)
    }

    var terminationReason: Process.TerminationReason { process.terminationReason }

    func waitForExit(seconds: Double = 25) async throws -> Int32 {
        let deadline = Date().addingTimeInterval(seconds)
        while process.isRunning {
            guard Date() < deadline else { throw ProofAppError.noExit(detail) }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        return process.terminationStatus
    }
}

enum ProofAppError: Error {
    case missing(String)
    case noLine(String, String)
    case noExit(String)
    case notMet(String)
}

/// One round's folders and fake Ollama.
final class ProofWorld {
    static let model = "invented-local-small:7b"
    static let digest = String(repeating: "c3", count: 32)
    static let earlierInput = "My invented bakery is called Maple Crumb."
    static let earlierOutput = "Noted: Maple Crumb."
    static let input = "What is my invented bakery called?"

    let base: URL
    let fake: VectorOllama
    var store: URL { base.appendingPathComponent("store", isDirectory: true) }
    var keys: URL { base.appendingPathComponent("keys", isDirectory: true) }

    init() throws {
        base = FileManager.default.temporaryDirectory.appendingPathComponent("kill-mid-reply-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: base.appendingPathComponent("keys", isDirectory: true),
                                                withIntermediateDirectories: true)
        fake = try VectorOllama()
        try fake.configure(.object(["state": .string("ready"), "reason": .null,
                                    "models": .array([.object(["name": .string(Self.model), "digest": .string(Self.digest)])])]))
    }

    func clean() {
        fake.shutDown()
        try? FileManager.default.removeItem(at: base)
    }

    /// Every `/api/chat` body Ollama received, in order.
    var chats: [[String: JSONValue]] {
        fake.calls.compactMap { call in
            guard let fields = call.objectValue, fields["path"] == .string("/api/chat") else { return nil }
            return fields["body"]?.objectValue ?? [:]
        }
    }

    var aliases: [String] { fake.names.filter(OllamaAlias.isAlias) }

    /// The messages every chat for this conversation must carry: the
    /// earlier turn as context, then the one new message.
    static var expectedMessages: JSONValue {
        .array([.object(["role": .string("user"), "content": .string(earlierInput)]),
                .object(["role": .string("assistant"), "content": .string(earlierOutput)]),
                .object(["role": .string("user"), "content": .string(input)])])
    }
}

/// Polls `condition` every 10 ms for up to `seconds`; a failure names `what`.
func proofUntil(_ what: String, seconds: Double = 20, _ condition: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(seconds)
    while !condition() {
        guard Date() < deadline else { throw ProofAppError.notMet(what) }
        try await Task.sleep(nanoseconds: 10_000_000)
    }
}

/// Where in the reply the app is killed.
enum KillMoment: String, CaseIterable, Sendable, CustomTestStringConvertible {
    /// The start record is written and the chat request is with Ollama,
    /// which has not answered yet.
    case beforeReplyStarted
    /// One piece of text saved.
    case early
    /// Three pieces saved.
    case middle
    /// Six pieces saved, and a seventh sent that may or may not be saved.
    case late

    var testDescription: String { rawValue }
}

@Suite("Step 3 PR 5: kill mid-reply and reopen, through the app's own lane and store (invented text only)", .serialized)
struct LocalKillMidReplyProofTests {
    /// Rounds per kill moment; `LOCAL_PROOF_ROUNDS` raises it.
    static let rounds = max(1, Int(ProcessInfo.processInfo.environment["LOCAL_PROOF_ROUNDS"] ?? "") ?? 2)
    static let pieces = (1...7).map { "Invented piece \($0) of the reply. " }

    /// Opens the app on a fresh folder, prepares the turn and starts it,
    /// returning once the fake holds its one chat request.
    private func startTurn(_ world: ProofWorld) async throws -> (ProofApp, String, VectorOllama.Chat) {
        let app = try ProofApp(world)
        try await app.next("ready")
        app.send("prepare")
        let runId = try await app.next("prepared ")
        app.send("start \(runId)")
        #expect(try await app.next("start ") == "ok -")
        try await proofUntil("the chat request to reach Ollama") { world.chats.count == 1 }
        let chat = try #require(world.fake.chats.first)
        return (app, runId, chat)
    }

    /// Plays the reply up to `count` pieces, each saved before the next.
    /// (`started` is not a handshake of its own: the URL loader reports the
    /// 200 only once the first bytes of the body arrive.)
    private func play(_ chat: VectorOllama.Chat, _ app: ProofApp, runId: String, pieces count: Int) async throws -> String {
        chat.head()
        var saved = ""
        for piece in Self.pieces.prefix(count) {
            chat.line(["message": ["role": "assistant", "content": piece], "done": false])
            saved += piece
            try await app.saved(runId, "text", chars: saved.count)
        }
        try await app.saved(runId, "started", chars: 0)
        return saved
    }

    private static func run(_ record: JSONValue, _ runId: String) -> [String: JSONValue]? {
        guard case .array(let runs) = record else { return nil }
        return runs.first { $0.objectValue?["runId"] == .string(runId) }?.objectValue
    }

    private static func text(_ run: [String: JSONValue]?) -> String {
        guard case .array(let chunks)? = run?["outputChunks"] else { return "<none>" }
        return chunks.compactMap(\.stringValue).joined()
    }

    @Test("A SIGKILL mid-reply: the next launch reads the run as cut off with its saved text, sends nothing again, sweeps the alias, and Retry sends exactly one new chat",
          arguments: KillMoment.allCases)
    func killMidReply(_ moment: KillMoment) async throws {
        for round in 1...Self.rounds {
            let world = try ProofWorld()
            defer { world.clean() }
            let (first, runId, chat) = try await startTurn(world)
            let alias = try #require(OllamaAlias.name(forRunId: runId))

            var acknowledged = ""
            var inFlight: String?
            switch moment {
            case .beforeReplyStarted: break
            case .early: acknowledged = try await play(chat, first, runId: runId, pieces: 1)
            case .middle: acknowledged = try await play(chat, first, runId: runId, pieces: 3)
            case .late:
                acknowledged = try await play(chat, first, runId: runId, pieces: 6)
                inFlight = Self.pieces[6]
                chat.line(["message": ["role": "assistant", "content": Self.pieces[6]], "done": false])
            }
            try await first.kill9()
            chat.close()
            #expect(first.terminationReason == .uncaughtSignal, "\(moment) round \(round): killed, not stopped by an error")
            // What the crash left: the alias, and one chat.
            #expect(world.aliases == [alias], "\(moment) round \(round)")
            #expect(world.chats.count == 1, "\(moment) round \(round)")

            // The next launch over the same folder.
            let second = try ProofApp(world)
            try await second.next("ready")
            try await proofUntil("the launch sweep to delete the leftover alias") { world.aliases.isEmpty }
            let status = try await second.json("status \(runId)", "status").objectValue ?? [:]
            #expect(status["outcome"] == .string("ok"), "\(moment) round \(round): \(status)")
            #expect(status["state"] == .string("unknown"), "\(moment) round \(round): \(status)")
            #expect(status["unknownReason"] == .string("exit-unrecorded"), "\(moment) round \(round): \(status)")

            let before = try await second.json("record", "record")
            guard case .array(let runsBefore) = before else { throw ProofAppError.notMet("a record") }
            #expect(runsBefore.count == 2, "\(moment) round \(round): the earlier turn and this one, nothing added")
            let cutOff = Self.run(before, runId)
            let kept = Self.text(cutOff)
            if let inFlight {
                #expect(kept == acknowledged || kept == acknowledged + inFlight, "\(moment) round \(round): kept \(kept.count) chars")
            } else {
                #expect(kept == acknowledged, "\(moment) round \(round): kept \(kept.count) chars")
            }
            #expect(cutOff?["phase"] == .string(moment == .beforeReplyStarted ? "prepared" : "running"), "\(moment) round \(round)")
            #expect(cutOff?["closure"] == nil, "\(moment) round \(round): no closure until the owner closes it")
            #expect(world.chats.count == 1, "\(moment) round \(round): nothing re-sent on reopen")

            // Before the recovery, the Desk's rules hold everything: Retry is
            // not offered (the run has not ended) and Send waits (busy).
            second.send("busy")
            #expect(try await second.next("busy ") == "true", "\(moment) round \(round): Send waits on the unfinished run")
            second.send("retry \(runId)")
            #expect(try await second.next("retry refused ") == "not-retryable", "\(moment) round \(round)")

            // The restored page's recovery, as the Desk runs it: status (above),
            // then events from the saved sequence. Native answers that the
            // rest was lost when the earlier launch ended, with no recorded
            // ending, which is what makes the Desk offer "Close as unknown".
            let lastSequence = cutOff?["lastSequence"]?.safeIntegerValue ?? -1
            let events = try await second.json("events \(runId)", "events").objectValue ?? [:]
            #expect(events["outcome"] == .string("ok"), "\(moment) round \(round): \(events)")
            #expect(events["events"] == .array([]), "\(moment) round \(round): \(events)")
            #expect(events["terminal"] == .null, "\(moment) round \(round): \(events)")
            #expect(events["lost"] == .object(["fromSequence": .number(Double(lastSequence + 1)), "throughSequence": .null,
                                               "reason": .string("restarted")]), "\(moment) round \(round): \(events)")

            // The owner's "Close as unknown", saved: the reply now reads as cut
            // off, with the saved text and sequence exactly as they were.
            second.send("close \(runId)")
            #expect(try await second.next("closed ") == "true", "\(moment) round \(round)")
            let closedRecord = try await second.json("record", "record")
            let closed = try #require(Self.run(closedRecord, runId), "\(moment) round \(round)")
            let closure = closed["closure"]?.objectValue
            #expect(closure?["kind"] == .string("unknown") && closure?["reason"] == .string("user-closed"),
                    "\(moment) round \(round): \(String(describing: closure))")
            var withoutClosure = closed
            withoutClosure["closure"] = nil
            #expect(withoutClosure == cutOff, "\(moment) round \(round): the closure adds itself and changes nothing else")
            #expect(Self.text(closed) == kept, "\(moment) round \(round): the saved text is kept")
            let closedStatus = try await second.json("status \(runId)", "status").objectValue ?? [:]
            #expect(closedStatus["state"] == .string("unknown") && closedStatus["unknownReason"] == .string("exit-unrecorded"),
                    "\(moment) round \(round): native still says it never recorded how it ended: \(closedStatus)")
            second.send("busy")
            #expect(try await second.next("busy ") == "false", "\(moment) round \(round): Send is no longer held")
            #expect(world.chats.count == 1, "\(moment) round \(round): the recovery sent nothing")

            // The owner's Retry, then Send: a new run, new ids, one new chat.
            second.send("retry \(runId)")
            let retryId = try await second.next("prepared ")
            #expect(try await second.next("start ") == "ok -", "\(moment) round \(round)")
            #expect(retryId != runId)
            try await proofUntil("the retry's chat to reach Ollama") { world.chats.count == 2 }
            let retryChat = try #require(world.fake.chats.last)
            retryChat.head()
            retryChat.line(["message": ["role": "assistant", "content": "Your invented bakery is Maple Crumb."], "done": false])
            retryChat.line(["message": ["role": "assistant", "content": ""], "done": true, "done_reason": "stop"])
            retryChat.end()
            retryChat.close()
            #expect(try await second.next("ended \(retryId) ") == "completed -", "\(moment) round \(round)")

            let chats = world.chats
            #expect(chats.count == 2, "\(moment) round \(round): the first send and the retry, nothing else")
            #expect(chats.first?["model"] == .string(alias))
            #expect(chats.last?["model"] == OllamaAlias.name(forRunId: retryId).map(JSONValue.string))
            for body in chats {
                #expect(body["messages"] == ProofWorld.expectedMessages, "\(moment) round \(round): the same context and message")
            }
            let after = try await second.json("record", "record")
            guard case .array(let runsAfter) = after else { throw ProofAppError.notMet("a record") }
            #expect(runsAfter.count == 3, "\(moment) round \(round)")
            #expect(Self.run(after, runId) == closed, "\(moment) round \(round): the old run stays exactly as it was")
            #expect(Self.text(Self.run(after, retryId)) == "Your invented bakery is Maple Crumb.")
            let ids = runsAfter.compactMap { $0.objectValue?["assistantMessageId"]?.stringValue }
            #expect(Set(ids).count == 3, "\(moment) round \(round): no reply recorded twice")
            let oldStatus = try await second.json("status \(runId)", "status").objectValue ?? [:]
            #expect(oldStatus["state"] == .string("unknown") && oldStatus["unknownReason"] == .string("exit-unrecorded"),
                    "\(moment) round \(round): \(oldStatus)")
            let newStatus = try await second.json("status \(retryId)", "status").objectValue ?? [:]
            #expect(newStatus["state"] == .string("exited"), "\(moment) round \(round): \(newStatus)")
            #expect(newStatus["terminal"]?.objectValue?["type"] == .string("completed"), "\(moment) round \(round): \(newStatus)")
            try await proofUntil("the retry's alias to be deleted after its terminal") { world.aliases.isEmpty }

            second.send("quit")
            #expect(try await second.next("quit ") == "reachedBound=false")
            #expect(try await second.waitForExit() == 0)
            #expect(world.chats.count == 2, "\(moment) round \(round): still two chats after the quit")
        }
    }

    @Test("A graceful quit mid-reply records stopped, not cut off: the alias goes with it, the saved text stays, and nothing is sent again")
    func quitMidReply() async throws {
        for round in 1...Self.rounds {
            let world = try ProofWorld()
            defer { world.clean() }
            let (first, runId, chat) = try await startTurn(world)
            let acknowledged = try await play(chat, first, runId: runId, pieces: 2)
            first.send("quit")
            #expect(try await first.next("quit ") == "reachedBound=false", "round \(round)")
            #expect(try await first.waitForExit() == 0, "round \(round)")
            chat.close()
            #expect(world.aliases.isEmpty, "round \(round): the quit deleted the alias itself")
            #expect(world.chats.count == 1, "round \(round)")

            let second = try ProofApp(world)
            try await second.next("ready")
            let status = try await second.json("status \(runId)", "status").objectValue ?? [:]
            #expect(status["state"] == .string("exited"), "round \(round): \(status)")
            #expect(status["unknownReason"] == .null, "round \(round): \(status)")
            let terminal = status["terminal"]?.objectValue
            #expect(terminal?["type"] == .string("stopped"), "round \(round): \(status)")
            #expect(terminal?["reason"] == .string("local-stop"), "round \(round): \(status)")
            #expect(status["groupCleared"] == .bool(true), "round \(round): \(status)")
            let record = try await second.json("record", "record")
            #expect(Self.text(Self.run(record, runId)) == acknowledged, "round \(round): the saved text stays")
            second.send("quit")
            #expect(try await second.next("quit ") == "reachedBound=false")
            #expect(try await second.waitForExit() == 0)
            #expect(world.chats.count == 1, "round \(round): nothing sent again")
            #expect(world.aliases.isEmpty)
        }
    }
}
