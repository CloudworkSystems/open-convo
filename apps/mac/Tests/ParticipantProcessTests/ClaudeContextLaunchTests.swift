import Darwin
import DeskHost
import Foundation
@testable import ParticipantProcess
import ParticipantSupervisorCore
import Testing

// The Claude Code adapter's PR 3c, at the launcher (contract sections 21.3
// and 21.4): an off-Mac run's earlier turns reach the CLI in the one fixed
// stdin layout, byte for byte, through the real supervisor and the fake
// CLI; `reply-too-long` counts them; and the no-tools rule still stops a run
// whose CLI reports a tool before any text is kept. Invented text only;
// never the real CLI.

enum ContextFixture {
    static let turns = [LocalTurn(role: "user", text: "Invented question for an invented bakery: one first step?"),
                        LocalTurn(role: "assistant", text: "Invented reply: list the three busiest hours.")]

    static func request(context: [LocalTurn] = turns, contextBytes: Int? = nil,
                        chunks: [String] = LauncherFixture.chunks) -> ParticipantLaunchRequest {
        ParticipantLaunchRequest(identity: LauncherFixture.identity, model: Invented.model, context: context,
                                 contextBytes: contextBytes ?? context.reduce(0) { $0 + $1.text.utf8.count },
                                 inputChunks: chunks, inputBytes: Data(chunks.joined().utf8).count, preparedBytes: 2_048)
    }

    /// Section 21.3's layout, written out by hand for `request`.
    static func expectedStdin(_ turns: [LocalTurn], message: String) -> String {
        var text = "The earlier turns of this conversation follow, oldest first, then the new message. Each part starts "
            + "with a line in square brackets naming it and the exact length of its text in UTF-8 bytes. Reply only to "
            + "the new message.\n\n"
        for turn in turns { text += "[earlier \(turn.role) turn, \(turn.text.utf8.count) bytes]\n\(turn.text)\n\n" }
        return text + "[new message, \(message.utf8.count) bytes]\n" + message
    }
}

@Suite("Off-Mac stdin layout and launch checks (contract section 21.3)")
struct ClaudeStdinLayoutTests {
    @Test("No earlier turns: stdin is exactly the joined chunks, as revision 3; with turns, the one fixed layout")
    func layout() {
        let plain = ContextFixture.request(context: [])
        #expect(plain.stdin == plain.message)
        #expect(plain.stdin == Data(LauncherFixture.chunks.joined().utf8))

        let request = ContextFixture.request()
        let message = LauncherFixture.chunks.joined()
        #expect(String(decoding: request.stdin, as: UTF8.self) == ContextFixture.expectedStdin(ContextFixture.turns, message: message))
        #expect(request.stdin.starts(with: Data((ParticipantLaunchRequest.stdinPreamble + "\n\n").utf8)))
        #expect(request.stdin.suffix(request.message.count) == request.message, "nothing after the message")
        // The combining accent across the chunk boundary and the emoji are
        // counted as UTF-8 bytes, not characters.
        #expect(request.stdin.range(of: Data("[new message, \(request.inputBytes) bytes]\n".utf8)) != nil)
        #expect(message.count < request.inputBytes)
    }

    @Test("A launch whose turns are not contextBytes, or whose turn is neither the user's nor the assistant's, is refused before any folder is made")
    func refusedContext() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("participants-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let parent = try ParticipantsFolder.prepare(in: root)
        let launcher = ProcessParticipantLauncher(supervisorPath: "/invented/ParticipantSupervisor", cliPath: "/invented/claude",
                                                  workingParent: parent, expectedInit: Invented.expectation)
        #expect(throws: ParticipantLaunchError.contextMismatch) { try launcher.launch(ContextFixture.request(contextBytes: 1)) }
        #expect(throws: ParticipantLaunchError.contextMismatch) {
            try launcher.launch(ContextFixture.request(context: [LocalTurn(role: "system", text: "Invented.")]))
        }
        var wrong = ContextFixture.request()
        wrong.inputBytes += 1
        #expect(throws: ParticipantLaunchError.inputBytesMismatch(expected: wrong.inputBytes, actual: wrong.message.count)) {
            try launcher.launch(wrong)
        }
        #expect(LauncherFixture.children(of: parent).isEmpty, "refused before any folder is made")
    }
}

extension ProcessSuites {
    @Suite("Off-Mac runs through the production launcher, the real supervisor and the fake CLI (contract section 21)")
    struct ClaudeContextLaunch {
        @Test("The earlier turns reach the CLI in the fixed layout, byte for byte, with the pinned command line and allow-listed environment; the run completes")
        func layoutReachesCLI() async throws {
            let vectors = try ParticipantVectors.load()
            let script = try VectorRunSetup(27, "participant.start accepted", in: vectors).script
            let folder = try FakeCLIFolder(.script(script))
            defer { folder.clean() }
            let parent = try ParticipantsFolder.prepare(in: folder.workParent)
            let request = ContextFixture.request()
            let run = try LauncherFixture.launcher(folder, parent: parent, log: RecordingLog()).launch(request)
            let collector = UpdateCollector(run)
            try await collector.wait(seconds: 10, for: "stream end") { $0.isFinished }
            #expect(collector.terminal?.type == .completed, "\(RunShape(collector.updates))")

            let record = try await folder.waitForCLIRecord()
            let stdin = record["stdin"] as? String ?? ""
            #expect(Array(stdin.utf8) == Array(request.stdin), "stdin bytes exactly")
            #expect(stdin == ContextFixture.expectedStdin(ContextFixture.turns, message: LauncherFixture.chunks.joined()))
            #expect(record["argv"] as? [String] == ParticipantCommandLine.arguments(model: Invented.model),
                    "the pinned command line, no-tools flags included")
            #expect(LauncherFixture.children(of: parent).isEmpty)
        }

        @Test("reply-too-long counts the context: a reply that fits beside the new message alone is cut beside the earlier turns")
        func replyTooLongCountsContext() async throws {
            let script = [ScriptStep(atMs: 0, .initClean), ScriptStep(atMs: 0, .rateLimitOK),
                          ScriptStep(atMs: 0, .textDelta("Four. Invented reply past the room left.")),
                          ScriptStep(atMs: 0, .resultSuccess), ScriptStep(atMs: 0, .exit(0))]
            let message = Data(LauncherFixture.chunks.joined().utf8).count
            // Leaves 11 bytes for the reply.
            let half = (ParticipantLimits.inputTotalBytes - message - 11) / 2
            let large = [LocalTurn(role: "user", text: String(repeating: "a", count: half)),
                         LocalTurn(role: "assistant", text: String(repeating: "b", count: ParticipantLimits.inputTotalBytes - message - 11 - half))]
            for (context, expected) in [([LocalTurn](), "completed"), (large, "failed")] {
                let folder = try FakeCLIFolder(.script(script))
                defer { folder.clean() }
                let parent = try ParticipantsFolder.prepare(in: folder.workParent)
                let request = ContextFixture.request(context: context)
                let run = try LauncherFixture.launcher(folder, parent: parent, log: RecordingLog()).launch(request)
                let collector = UpdateCollector(run)
                try await collector.wait(seconds: 20, for: "stream end") { $0.isFinished }
                #expect(collector.terminal?.type.rawValue == expected, "\(context.count) turns: \(RunShape(collector.updates))")
                if !context.isEmpty {
                    #expect(collector.terminal?.reason == "reply-too-long")
                    let text = collector.events.compactMap(\.text).joined()
                    #expect(text.utf8.count <= 11, "only the prefix that fits: \(text)")
                    let record = try await folder.waitForCLIRecord()
                    #expect((record["stdin"] as? String)?.utf8.count == request.stdin.count, "the whole layout went in")
                }
            }
        }

        @Test("Tools refused: a CLI that reports a tool at start is stopped before any text is kept, with context as without")
        func toolsRefused() async throws {
            let script = [ScriptStep(atMs: 0, .initWithTools), ScriptStep(atMs: 0, .rateLimitOK),
                          ScriptStep(atMs: 0, .textDelta("Invented text that must never be kept."))]
            for context in [[LocalTurn](), ContextFixture.turns] {
                let folder = try FakeCLIFolder(.script(script))
                defer { folder.clean() }
                let parent = try ParticipantsFolder.prepare(in: folder.workParent)
                let run = try LauncherFixture.launcher(folder, parent: parent, log: RecordingLog())
                    .launch(ContextFixture.request(context: context))
                let collector = UpdateCollector(run)
                let cli = try await folder.waitForPid("cli.pid")
                try await collector.wait(seconds: 10, for: "stream end") { $0.isFinished }
                #expect(collector.terminal?.type == .failed && collector.terminal?.reason == "process-error")
                #expect(collector.events.map(\.sequence) == [1], "nothing before the terminal")
                #expect(!collector.events.contains { $0.type == .text })
                let record = try await folder.waitForCLIRecord()
                #expect(record["argv"] as? [String] == ParticipantCommandLine.arguments(model: Invented.model))
                #expect(Processes.members(cli).isEmpty, "the group is gone")
            }
        }
    }
}
