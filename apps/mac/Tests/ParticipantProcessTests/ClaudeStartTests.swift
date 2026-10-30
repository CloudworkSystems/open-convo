import Foundation
import Testing
@testable import DeskHost
@testable import ParticipantCoordinator
@testable import ParticipantProcess

// The Claude Code adapter's PR 3c through the real coordinator and the real
// store (contract sections 21.2-21.4): a host that pins the off-Mac entry
// prepares Claude runs that name earlier turns, a local model's and
// Claude's, resolves and hashes them again at start, and hands the launcher
// exactly those turns. The launcher is the scripted one; the production
// launcher's side is ClaudeContextLaunchTests. Invented text only.

final class ClaudeStartWorld {
    static let pin = ParticipantPin(id: "claude-code", label: "Claude", model: Invented.model, executionHost: "anthropic")!
    static let sessionId = "52abcdef-0000-4000-8abc-000000000a01"
    static let localRunId = "71abcdef-0000-4000-8abc-000000000a01"
    static let claudeRunId = "71abcdef-0000-4000-8abc-000000000a02"
    static let runId = "71abcdef-0000-4000-8abc-000000000a03"
    static let localInput = "Invented question for an invented bakery: one first step?"
    static let localOutput = "Invented reply: list the three busiest hours."
    static let claudeInput = "Invented follow-up: and the second step?"
    static let claudeOutput = "Invented reply: staff those hours first."
    static let input = ["Invented last question: ", "and the third?"]
    static let createdAt = "2026-10-29T04:00:00.000Z"

    let world: VectorWorld
    let generation: Int
    private(set) var revision = 0

    init(availability: JSONValue = .object(["result": .string("available")]), inputBound: Int? = nil) async throws {
        let vectors = try ParticipantVectors.load()
        let ready = LocalCatalogAnswer.ready([LocalCatalogEntry(participant: LocalStartWorld.localPin, available: true)])
        var seed: [String: JSONValue] = ["pin": Self.pin.jsonValue, "availability": availability]
        if let inputBound { seed["inputBound"] = .number(Double(inputBound)) }
        world = try await VectorWorld(seed: seed, number: 0, operation: "participant.start", vectors: vectors,
                                      localRoute: ScriptedLocalRoute([ready]))
        let script = try VectorRunSetup(27, "participant.start accepted", in: vectors).script
        world.launcher.prepare(script: script)
        generation = world.connections.validConnections().generation
    }

    func clean() { world.clean() }

    static func run(_ runId: String, participant: ParticipantPin, input: [String], output: [String] = [], phase: String,
                    context: [String]?) -> JSONValue {
        let suffix = runId.suffix(12)
        var run: [String: JSONValue] = [
            "version": .number(1), "runId": .string(runId), "sessionId": .string(sessionId),
            "userMessageId": .string("72abcdef-0000-4000-8abc-" + suffix),
            "assistantMessageId": .string("73abcdef-0000-4000-8abc-" + suffix), "participant": participant.jsonValue,
            "inputChunks": .array(input.map(JSONValue.string)), "outputChunks": .array(output.map(JSONValue.string)),
            "lastSequence": .number(output.isEmpty ? 0 : 3), "phase": .string(phase), "createdAt": .string(createdAt),
            "updatedAt": .string(output.isEmpty ? createdAt : "2026-10-29T04:00:05.000Z")]
        if let context { run["contextRunIds"] = .array(context.map(JSONValue.string)) }
        return .object(run)
    }

    static func local(_ phase: String) -> JSONValue {
        run(localRunId, participant: LocalStartWorld.localPin, input: [localInput], output: phase == "completed" ? [localOutput] : [],
            phase: phase, context: [])
    }

    static func claude(_ phase: String, output: String = claudeOutput) -> JSONValue {
        run(claudeRunId, participant: pin, input: [claudeInput], output: phase == "completed" ? [output] : [], phase: phase,
            context: [localRunId])
    }

    static func prepared(context: [String] = [localRunId, claudeRunId]) -> JSONValue {
        run(runId, participant: pin, input: input, phase: "prepared", context: context)
    }

    /// The page's commits: a local turn, then a Claude turn that names it,
    /// each prepared and completed, then the new Claude turn naming both.
    func prepare(context: [String] = [localRunId, claudeRunId]) async throws {
        try await commit([Self.local("prepared")], claim: Self.localRunId)
        try await commit([Self.local("completed")], claim: nil)
        try await commit([Self.local("completed"), Self.claude("prepared")], claim: Self.claudeRunId)
        try await commit([Self.local("completed"), Self.claude("completed")], claim: nil)
        try await commit([Self.local("completed"), Self.claude("completed"), Self.prepared(context: context)], claim: Self.runId)
    }

    func commit(_ runs: [JSONValue], claim: String?) async throws {
        let reply = await tryCommit(runs, claim: claim)
        guard reply.outcome == .ok else { throw LocalStartTestError.commit("\(reply)") }
    }

    func tryCommit(_ runs: [JSONValue], claim: String?) async -> HostResponse {
        var payload: [String: JSONValue] = [
            "workspaceHandle": .string(world.store.workspaceHandle), "expectedRevision": .number(Double(revision)),
            "record": .object(["schemaVersion": .number(2), "revision": .number(Double(revision + 1)),
                               "conversationRuns": .array(runs)])]
        if let claim, let run = runs.first(where: { $0.objectValue?["runId"] == .string(claim) })?.objectValue {
            var fields: [String: JSONValue] = ["participantId": run["participant"]?.objectValue?["id"] ?? .null,
                                               "createdAt": .string(Self.createdAt)]
            for key in ["runId", "sessionId", "userMessageId", "assistantMessageId"] { fields[key] = run[key] }
            payload["participantRun"] = .object(fields)
        }
        let reply = await world.host.handle(HostRequest(requestId: UUID(), connectionId: world.connectionId, generation: generation,
                                                        operation: .workspaceCommitProof, payload: payload))
        if reply.outcome == .ok { revision += 1 }
        return reply
    }

    func start() async -> HostResponse {
        let payload: [String: JSONValue] = [
            "workspaceHandle": .string(world.store.workspaceHandle), "runId": .string(Self.runId), "sessionId": .string(Self.sessionId),
            "userMessageId": .string("72abcdef-0000-4000-8abc-000000000a03"),
            "assistantMessageId": .string("73abcdef-0000-4000-8abc-000000000a03"),
            "participant": Self.pin.jsonValue, "inputChunks": .array(Self.input.map(JSONValue.string))]
        return await world.coordinator.handle(HostRequest(requestId: UUID(), connectionId: world.connectionId, generation: generation,
                                                          operation: .participantStart, payload: payload))
    }

    var entry: ParticipantRunEntry? { world.store.publishedRuns.entry(for: Self.runId) }

    static var turns: [LocalTurn] {
        [LocalTurn(role: "user", text: localInput), LocalTurn(role: "assistant", text: localOutput),
         LocalTurn(role: "user", text: claudeInput), LocalTurn(role: "assistant", text: claudeOutput)]
    }
}

@Suite("Off-Mac Claude runs with context through the coordinator (contract section 21; adapter PR 3c)")
struct ClaudeStartTests {
    @Test("A Claude start re-resolves a local turn and a Claude turn, and launches exactly those turns, oldest first, under the pinned model")
    func startsWithContext() async throws {
        let claude = try await ClaudeStartWorld()
        defer { claude.clean() }
        try await claude.prepare()
        let entry = try #require(claude.entry)
        #expect(entry.context?.runIds == [ClaudeStartWorld.localRunId, ClaudeStartWorld.claudeRunId])
        #expect(entry.context?.bytes == ClaudeStartWorld.turns.reduce(0) { $0 + $1.text.utf8.count })

        let reply = await claude.start()
        #expect(reply.outcome == .ok, "\(reply)")
        let request = try #require(claude.world.launcher.requests.first)
        #expect(claude.world.launcher.requests.count == 1)
        #expect(request.context == ClaudeStartWorld.turns)
        #expect(request.contextBytes == entry.context?.bytes)
        #expect(request.model == ClaudeStartWorld.pin.model)
        #expect(request.inputChunks == ClaudeStartWorld.input && request.inputBytes == entry.inputBytes)
        #expect(String(decoding: request.stdin, as: UTF8.self)
                == ContextFixture.expectedStdin(ClaudeStartWorld.turns, message: ClaudeStartWorld.input.joined()))
        #expect(claude.world.confirmation.claims == 1, "section 17's run claim, once")
        #expect(claude.entry?.start != nil, "the start record was written before the launch")
    }

    @Test("An off-Mac run naming no earlier turns sends exactly the new message, as revision 3")
    func noContext() async throws {
        let claude = try await ClaudeStartWorld()
        defer { claude.clean() }
        try await claude.prepare(context: [])
        let reply = await claude.start()
        #expect(reply.outcome == .ok, "\(reply)")
        let request = try #require(claude.world.launcher.requests.first)
        #expect(request.context.isEmpty && request.contextBytes == 0)
        #expect(request.stdin == Data(ClaudeStartWorld.input.joined().utf8))
    }

    @Test("A changed earlier turn is run-mismatch at start: nothing recorded, nothing launched, no run claimed")
    func contextChanged() async throws {
        let claude = try await ClaudeStartWorld()
        defer { claude.clean() }
        try await claude.prepare()
        try await claude.commit([ClaudeStartWorld.local("completed"),
                                 ClaudeStartWorld.claude("completed", output: "An edited invented answer."),
                                 ClaudeStartWorld.prepared()], claim: nil)
        let reply = await claude.start()
        #expect(reply.reason == .runMismatch, "\(reply)")
        #expect(claude.world.launcher.requests.isEmpty)
        #expect(claude.world.confirmation.claims == 0)
        #expect(claude.entry?.start == nil)
    }

    @Test("Unavailable at step 13: participant-unavailable after the context check, nothing launched")
    func unavailable() async throws {
        let claude = try await ClaudeStartWorld(availability: .object(["result": .string("unavailable"),
                                                                       "reason": .string("overflow-unverified")]))
        defer { claude.clean() }
        try await claude.prepare()
        let reply = await claude.start()
        #expect(reply.reason == .participantUnavailable, "\(reply)")
        #expect(claude.world.launcher.requests.isEmpty)
        #expect(claude.entry?.start == nil)
    }

    @Test("The first-trial bound counts the earlier turns with the new message: one byte over is text-too-large at preparation, though the message alone fits")
    func firstTrialBound() async throws {
        let counted = ClaudeStartWorld.turns.reduce(0) { $0 + $1.text.utf8.count } + ClaudeStartWorld.input.joined().utf8.count
        for (bound, fits) in [(counted, true), (counted - 1, false)] {
            let claude = try await ClaudeStartWorld(inputBound: bound)
            defer { claude.clean() }
            if fits {
                try await claude.prepare()
                #expect(claude.entry != nil)
                #expect(await claude.start().outcome == .ok)
            } else {
                try await claude.commit([ClaudeStartWorld.local("prepared")], claim: ClaudeStartWorld.localRunId)
                try await claude.commit([ClaudeStartWorld.local("completed")], claim: nil)
                try await claude.commit([ClaudeStartWorld.local("completed"), ClaudeStartWorld.claude("prepared")],
                                        claim: ClaudeStartWorld.claudeRunId)
                try await claude.commit([ClaudeStartWorld.local("completed"), ClaudeStartWorld.claude("completed")], claim: nil)
                let reply = await claude.tryCommit([ClaudeStartWorld.local("completed"), ClaudeStartWorld.claude("completed"),
                                                    ClaudeStartWorld.prepared()], claim: ClaudeStartWorld.runId)
                #expect(reply.reason == .textTooLarge, "\(reply)")
                #expect(claude.entry == nil)
                // The same message with no earlier turns fits.
                let alone = await claude.tryCommit([ClaudeStartWorld.local("completed"), ClaudeStartWorld.claude("completed"),
                                                    ClaudeStartWorld.prepared(context: [])], claim: ClaudeStartWorld.runId)
                #expect(alone.outcome == .ok, "\(alone)")
            }
        }
    }

    @Test("The prepared form on an off-Mac host: an off-Mac run without contextRunIds, or a revision-3 run with it, is run-not-prepared")
    func preparedForm() async throws {
        let claude = try await ClaudeStartWorld()
        defer { claude.clean() }
        try await claude.commit([ClaudeStartWorld.local("prepared")], claim: ClaudeStartWorld.localRunId)
        try await claude.commit([ClaudeStartWorld.local("completed")], claim: nil)
        let revision3 = ParticipantPin(id: "claude-code", label: "Claude Code", model: Invented.model, executionHost: "this-mac")!
        let shapes = [
            ClaudeStartWorld.run(ClaudeStartWorld.runId, participant: ClaudeStartWorld.pin, input: ClaudeStartWorld.input,
                                 phase: "prepared", context: nil),
            ClaudeStartWorld.run(ClaudeStartWorld.runId, participant: revision3, input: ClaudeStartWorld.input,
                                 phase: "prepared", context: [ClaudeStartWorld.localRunId]),
        ]
        for shape in shapes {
            let reply = await claude.tryCommit([ClaudeStartWorld.local("completed"), shape], claim: ClaudeStartWorld.runId)
            #expect(reply.reason == .runNotPrepared, "\(reply)")
        }
        #expect(claude.entry == nil)
    }
}
