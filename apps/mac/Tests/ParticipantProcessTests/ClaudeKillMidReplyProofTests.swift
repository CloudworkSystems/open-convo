import Darwin
import DeskHost
import Foundation
@testable import ParticipantProcess
import Testing

// The Claude Code adapter's PR 4-proof: the fake-CLI kill proof
// (docs/plans/claude-code-adapter.md, "Proofs"), built like step 3's
// `LocalKillMidReplyProofTests`, with invented text only.
//
// `ClaudeConversationProofHost` plays True Convo Test with the Desk open and
// the Claude Code entry wired as PR 4b will wire it: the app's Claude pin,
// the real coordinator over section 17's real owner, the real host and the
// real encrypted store (which holds section 21.4's approval), and the
// production launcher with the real supervisor. The CLI is
// `ParticipantFakeCLI`, never the real one: it streams the scripted events
// below, each only once the test creates its `go-N` file (a handshake,
// never timing), and logs each spawn. The app's own lane still refuses
// every Claude launch until PR 4b (`LocalConversationLaneTests`).
//
// Each round approves Anthropic, confirms paid usage, prepares a turn with
// an earlier turn as context, starts it, and SIGKILLs the app (no handler
// runs, as with a crash or a force quit) at one exact point: the fake has
// read its input and printed nothing, or the app printed that its save of
// the reply so far returned (after one, three or six pieces; after six, a
// seventh is in flight at the kill). Then:
// - within 10 seconds no fake CLI or supervisor of the run is left;
// - a fresh app over the same folder reads the run as cut off (`unknown`,
//   `exit-unrecorded`), with exactly the text saved so far kept, nothing
//   doubled, and the fake was spawned once;
// - the approval is still saved, but the confirmation is not: it ended
//   with the app, so the entry reads `overflow-unverified`;
// - until the owner closes it, the Desk's rules hold: Retry is not offered
//   and Send waits. The restored page's recovery (status, then events, which
//   answer `lost` `restarted` with no ending) leads to "Close as unknown";
//   once that closure is saved the run reads as cut off, its text
//   unchanged, and Send is free;
// - after a new confirmation, Retry then Send makes exactly one new run,
//   new ids, one new spawn, with the same input on its stdin, which
//   completes and leaves the closed old run exactly as it was.
// A graceful quit mid-reply is checked the same way: it records `stopped`,
// leaves no process, and the fake was spawned once.

/// One round's folders and fake CLI.
final class ClaudeProofWorld {
    static var path: String { Products.path("ClaudeConversationProofHost") }
    static let pieces = (1...7).map { "Invented piece \($0) of the reply. " }
    static let earlierInput = "My invented bakery is called Maple Crumb."
    static let message = "What is my invented bakery called?"
    static let retryReply = "Your invented bakery is Maple Crumb."

    let fake: FakeCLIFolder
    var fakeFolder: URL { URL(fileURLWithPath: fake.cliPath).deletingLastPathComponent() }
    var store: URL { fake.root.appendingPathComponent("store", isDirectory: true) }
    var keys: URL { fake.root.appendingPathComponent("keys", isDirectory: true) }
    var runFolder: URL { fake.root.appendingPathComponent("run", isDirectory: true) }

    init() throws {
        fake = try FakeCLIFolder(FakeCLIFolder.Scenario())
        for folder in [keys, runFolder] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        }
        try script(Self.gatedSteps())
    }

    func clean() { fake.clean() }

    /// The app over this world's folders, in the fake's invented environment
    /// (which also carries an API key, a base URL and a provider switch the
    /// allow-list must drop).
    func app() throws -> ProofApp {
        try ProofApp(path: Self.path, arguments: [store.path, keys.path, Products.supervisor, fake.cliPath, runFolder.path],
                     environment: fake.environment)
    }

    /// The first run's stream: init, the rate-limit message that releases
    /// text (overage rejected), the message start, then each piece, and the
    /// result, each step only once its `go-N` exists.
    static func gatedSteps() -> [[String: Any]] {
        var steps: [[String: Any]] = [["waitFile": "go-0"]]
        for line in [Invented.initLine(model: "claude-sonnet-5-5"), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0)] {
            steps.append(["out": line])
        }
        for (index, piece) in pieces.enumerated() {
            steps.append(["waitFile": "go-\(index + 1)"])
            steps.append(["out": Invented.textDelta(piece)])
        }
        steps.append(["waitFile": "go-\(pieces.count + 1)"])
        steps.append(["out": Invented.result()])
        steps.append(["exit": 0])
        return steps
    }

    /// The retry's stream, ungated, with the pin's model in its init line
    /// (the reader ends a run whose init reports another).
    static func passingSteps() -> [[String: Any]] {
        [Invented.initLine(model: "claude-sonnet-5-5"), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0),
         Invented.textDelta(retryReply), Invented.result()].map { ["out": $0] } + [["exit": 0]]
    }

    /// Replaces the scenario the next spawn reads.
    func script(_ steps: [[String: Any]]) throws {
        let object: [String: Any] = ["sigterm": "exit", "child": NSNull(), "leaveGroup": false, "readStdin": true, "steps": steps]
        let data = try JSONSerialization.data(withJSONObject: object)
        let temporary = fakeFolder.appendingPathComponent("scenario.json.tmp")
        try data.write(to: temporary)
        guard rename(temporary.path, fakeFolder.appendingPathComponent("scenario.json").path) == 0 else {
            throw ProofAppError.notMet("the scenario")
        }
    }

    /// Lets the fake take its step `n`.
    func release(_ n: Int) {
        FileManager.default.createFile(atPath: fakeFolder.appendingPathComponent("go-\(n)").path, contents: Data())
    }

    /// Every spawn of the fake as a run (never a check), in order.
    var spawns: [String] {
        let text = (try? String(contentsOf: fake.records.appendingPathComponent("spawns.log"), encoding: .utf8)) ?? ""
        return text.split(separator: "\n").map(String.init)
    }

    /// The fake's and its supervisor's pids, from the latest spawn's record.
    func processes() async throws -> (cli: pid_t, supervisor: pid_t, stdin: String) {
        let record = try await fake.waitForCLIRecord(seconds: 20)
        guard let cli = record["pid"] as? Int, let supervisor = record["ppid"] as? Int, let stdin = record["stdin"] as? String else {
            throw ProofAppError.notMet("the fake's record: \(record)")
        }
        return (pid_t(cli), pid_t(supervisor), stdin)
    }

    /// Fails unless neither process is left within 10 seconds.
    static func gone(_ cli: pid_t, _ supervisor: pid_t, _ what: String) async throws {
        let done = await Processes.waitUntil(seconds: 10) { !Processes.isRunning(cli) && !Processes.isRunning(supervisor) }
        if done == nil {
            Processes.killIfRunning(cli)
            Processes.killIfRunning(supervisor)
            throw ProofAppError.notMet("\(what): no fake CLI or supervisor left within 10 seconds")
        }
    }
}

@Suite("Claude Code adapter PR 4-proof: kill mid-reply and reopen, through the real owner, coordinator, store, launcher and supervisor, with the fake CLI (invented text only)",
       .serialized)
struct ClaudeKillMidReplyProofTests {
    /// Rounds per kill moment; `CLAUDE_PROOF_ROUNDS` raises it.
    static let rounds = max(1, Int(ProcessInfo.processInfo.environment["CLAUDE_PROOF_ROUNDS"] ?? "") ?? 2)

    /// Opens the app on a fresh folder, approves Anthropic, confirms paid
    /// usage, prepares the turn and starts it, returning once the fake has
    /// read its input (and printed nothing).
    private func startTurn(_ world: ClaudeProofWorld) async throws -> (ProofApp, String) {
        let app = try world.app()
        try await app.next("ready")
        app.send("availability")
        #expect(try await app.next("availability ") == "host-not-approved", "a fresh store approves nothing")
        app.send("approve")
        #expect(try await app.next("approved ") == "true")
        app.send("confirm")
        #expect(try await app.next("confirm ") == "confirmed")
        app.send("availability")
        #expect(try await app.next("availability ") == "available")
        app.send("prepare")
        let runId = try await app.next("prepared ")
        app.send("start \(runId)")
        #expect(try await app.next("start ") == "ok -")
        _ = try await world.processes()
        return (app, runId)
    }

    /// Plays the reply up to `count` pieces, each saved before the next.
    private func play(_ world: ClaudeProofWorld, _ app: ProofApp, runId: String, pieces count: Int) async throws -> String {
        world.release(0)
        var saved = ""
        for (index, piece) in ClaudeProofWorld.pieces.prefix(count).enumerated() {
            world.release(index + 1)
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

    @Test("A SIGKILL mid-reply: nothing is left running, the next launch reads the run as cut off with its saved text and one spawn, needs a new confirmation, and Retry makes exactly one new run",
          arguments: KillMoment.allCases)
    func killMidReply(_ moment: KillMoment) async throws {
        for round in 1...Self.rounds {
            let label = "\(moment) round \(round)"
            let world = try ClaudeProofWorld()
            defer { world.clean() }
            let (first, runId) = try await startTurn(world)
            let spawned = try await world.processes()
            #expect(spawned.stdin.contains(ClaudeProofWorld.earlierInput) && spawned.stdin.contains(ClaudeProofWorld.message),
                    "\(label): the earlier turn and the message went on stdin")

            var acknowledged = ""
            var inFlight: String?
            switch moment {
            case .beforeReplyStarted: break
            case .early: acknowledged = try await play(world, first, runId: runId, pieces: 1)
            case .middle: acknowledged = try await play(world, first, runId: runId, pieces: 3)
            case .late:
                acknowledged = try await play(world, first, runId: runId, pieces: 6)
                inFlight = ClaudeProofWorld.pieces[6]
                world.release(7)
            }
            try await first.kill9()
            #expect(first.terminationReason == .uncaughtSignal, "\(label): killed, not stopped by an error")
            try await ClaudeProofWorld.gone(spawned.cli, spawned.supervisor, label)
            #expect(world.spawns.count == 1, "\(label): one spawn for the run")

            // The next launch over the same folder.
            let second = try world.app()
            try await second.next("ready")
            second.send("availability")
            #expect(try await second.next("availability ") == "overflow-unverified",
                    "\(label): the approval is saved; the confirmation ended with the app")
            let status = try await second.json("status \(runId)", "status").objectValue ?? [:]
            #expect(status["outcome"] == .string("ok"), "\(label): \(status)")
            #expect(status["state"] == .string("unknown"), "\(label): \(status)")
            #expect(status["unknownReason"] == .string("exit-unrecorded"), "\(label): \(status)")

            let before = try await second.json("record", "record")
            guard case .array(let runsBefore) = before else { throw ProofAppError.notMet("a record") }
            #expect(runsBefore.count == 2, "\(label): the earlier turn and this one, nothing added")
            let cutOff = Self.run(before, runId)
            let kept = Self.text(cutOff)
            if let inFlight {
                #expect(kept == acknowledged || kept == acknowledged + inFlight, "\(label): kept \(kept.count) chars")
            } else {
                #expect(kept == acknowledged, "\(label): kept \(kept.count) chars")
            }
            #expect(cutOff?["phase"] == .string(moment == .beforeReplyStarted ? "prepared" : "running"), "\(label)")
            #expect(cutOff?["closure"] == nil, "\(label): no closure until the owner closes it")
            #expect(world.spawns.count == 1, "\(label): nothing spawned again on reopen")

            // Before the recovery, the Desk's rules hold everything.
            second.send("busy")
            #expect(try await second.next("busy ") == "true", "\(label): Send waits on the unfinished run")
            second.send("retry \(runId)")
            #expect(try await second.next("retry refused ") == "not-retryable", "\(label)")

            // The restored page's recovery: status (above), then events from
            // the saved sequence, which say the rest was lost when the
            // earlier launch ended, with no recorded ending.
            let lastSequence = cutOff?["lastSequence"]?.safeIntegerValue ?? -1
            let events = try await second.json("events \(runId)", "events").objectValue ?? [:]
            #expect(events["outcome"] == .string("ok"), "\(label): \(events)")
            #expect(events["events"] == .array([]), "\(label): \(events)")
            #expect(events["terminal"] == .null, "\(label): \(events)")
            #expect(events["lost"] == .object(["fromSequence": .number(Double(lastSequence + 1)), "throughSequence": .null,
                                               "reason": .string("restarted")]), "\(label): \(events)")

            // The owner's "Close as unknown", saved.
            second.send("close \(runId)")
            #expect(try await second.next("closed ") == "true", "\(label)")
            let closedRecord = try await second.json("record", "record")
            let closed = try #require(Self.run(closedRecord, runId), "\(label)")
            let closure = closed["closure"]?.objectValue
            #expect(closure?["kind"] == .string("unknown") && closure?["reason"] == .string("user-closed"),
                    "\(label): \(String(describing: closure))")
            var withoutClosure = closed
            withoutClosure["closure"] = nil
            #expect(withoutClosure == cutOff, "\(label): the closure adds itself and changes nothing else")
            #expect(Self.text(closed) == kept, "\(label): the saved text is kept")
            second.send("busy")
            #expect(try await second.next("busy ") == "false", "\(label): Send is no longer held")
            #expect(world.spawns.count == 1, "\(label): the recovery spawned nothing")

            // A new confirmation, then the owner's Retry and Send: a new run,
            // new ids, one new spawn with the same input.
            try world.script(ClaudeProofWorld.passingSteps())
            second.send("confirm")
            #expect(try await second.next("confirm ") == "confirmed", "\(label)")
            second.send("retry \(runId)")
            let retryId = try await second.next("prepared ")
            #expect(try await second.next("start ") == "ok -", "\(label)")
            #expect(retryId != runId)
            #expect(try await second.next("ended \(retryId) ") == "completed -", "\(label)")
            #expect(world.spawns.count == 2, "\(label): the first send and the retry, nothing else")
            let retried = try await world.processes()
            #expect(retried.cli != spawned.cli, "\(label): the retry's own spawn")
            #expect(retried.stdin == spawned.stdin, "\(label): the same earlier turn and message")
            try await ClaudeProofWorld.gone(retried.cli, retried.supervisor, "\(label), the retry")

            let after = try await second.json("record", "record")
            guard case .array(let runsAfter) = after else { throw ProofAppError.notMet("a record") }
            #expect(runsAfter.count == 3, "\(label)")
            #expect(Self.run(after, runId) == closed, "\(label): the old run stays exactly as it was")
            #expect(Self.text(Self.run(after, retryId)) == ClaudeProofWorld.retryReply)
            let ids = runsAfter.compactMap { $0.objectValue?["assistantMessageId"]?.stringValue }
            #expect(Set(ids).count == 3, "\(label): no reply recorded twice")
            let oldStatus = try await second.json("status \(runId)", "status").objectValue ?? [:]
            #expect(oldStatus["state"] == .string("unknown") && oldStatus["unknownReason"] == .string("exit-unrecorded"),
                    "\(label): \(oldStatus)")
            let newStatus = try await second.json("status \(retryId)", "status").objectValue ?? [:]
            #expect(newStatus["state"] == .string("exited"), "\(label): \(newStatus)")
            #expect(newStatus["terminal"]?.objectValue?["type"] == .string("completed"), "\(label): \(newStatus)")

            second.send("quit")
            #expect(try await second.next("quit ") == "reachedBound=false")
            #expect(try await second.waitForExit() == 0)
            #expect(world.spawns.count == 2, "\(label): still two spawns after the quit")
        }
    }

    @Test("A graceful quit mid-reply records stopped, not cut off: nothing is left running, the saved text stays, and the fake was spawned once")
    func quitMidReply() async throws {
        for round in 1...Self.rounds {
            let world = try ClaudeProofWorld()
            defer { world.clean() }
            let (first, runId) = try await startTurn(world)
            let spawned = try await world.processes()
            let acknowledged = try await play(world, first, runId: runId, pieces: 2)
            first.send("quit")
            #expect(try await first.next("quit ") == "reachedBound=false", "round \(round)")
            #expect(try await first.waitForExit() == 0, "round \(round)")
            try await ClaudeProofWorld.gone(spawned.cli, spawned.supervisor, "round \(round)")
            #expect(world.spawns.count == 1, "round \(round)")

            let second = try world.app()
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
            #expect(world.spawns.count == 1, "round \(round): nothing spawned again")
        }
    }
}
