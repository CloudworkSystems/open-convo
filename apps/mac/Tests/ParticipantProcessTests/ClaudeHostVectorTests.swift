import Foundation
import Testing
@testable import DeskHost
@testable import ParticipantCoordinator
@testable import ParticipantProcess

// The seeded host cases of `native-participant-claude-v1.json` (contract
// section 21.6; the Claude Code adapter's PR 3e): each case is replayed
// through section 19's harness (`VectorReplay` over the real `HostRouter`,
// `DeskHostProtocol`, `ParticipantCoordinator` and `ProofStore`, with the
// fake CLI scripted in virtual time), under the off-Mac pin its root seeds,
// with one earlier turn as context. Nothing is spawned and all text is
// invented.
//
// What a Claude host case may say, beyond section 19:
// - `stdin`: for a start the case accepted and launched, the exact bytes the
//   launcher was handed (section 21.3's layout, the earlier turn then the
//   new message). A case without it launches nothing.
// Availability is section 19's fake (approval and paid-usage confirmation
// are section 17's owner, run in `ClaudeApprovalTests`).

/// The Claude file's cases and records in section 19's shape, so the shared
/// harness replays them.
struct ClaudeHostVectors {
    static let resourceName = "native-participant-claude-v1"
    static let caseKeys = VectorReplay.caseKeys.union(["stdin"])

    let vectors: ParticipantVectors
    /// Every case of the Claude file, numbered from 1 as the file lists it.
    let cases: [ParticipantVectors.Case]
    /// Each seeded case's `stdin`, by case number; nil when it states none.
    let stdin: [Int: String]
    let pin: ParticipantPin

    var hostCases: [ParticipantVectors.Case] { cases.filter { !$0.seed.isEmpty } }

    static func load() throws -> ClaudeHostVectors {
        guard let url = Bundle.module.url(forResource: resourceName, withExtension: "json"),
              let shared = Bundle.module.url(forResource: ParticipantVectors.resourceName, withExtension: "json") else {
            throw VectorHarnessError.fixture("the bundled vectors are missing")
        }
        guard var claude = try JSONValue.decode(Data(contentsOf: url)).objectValue, case .array(let values)? = claude["cases"],
              let records = claude["records"], let pin = claude["context"]?.objectValue?["claudeParticipant"].flatMap(ParticipantPin.init(json:)),
              var root = try JSONValue.decode(Data(contentsOf: shared)).objectValue else {
            throw VectorHarnessError.fixture("the Claude vectors have no cases, records or pin")
        }
        var stdin: [Int: String] = [:]
        let stripped = try values.enumerated().map { offset, value -> JSONValue in
            guard var fields = value.objectValue else { throw VectorHarnessError.fixture("Claude case #\(offset + 1) is not an object") }
            guard fields["seed"] != nil else { return value }
            if let extra = Set(fields.keys).subtracting(caseKeys).sorted().first {
                throw VectorHarnessError.unsupported("Claude #\(offset + 1) case key \(extra)")
            }
            if let text = fields.removeValue(forKey: "stdin") {
                guard let string = text.stringValue else { throw VectorHarnessError.fixture("Claude #\(offset + 1) stdin") }
                stdin[offset + 1] = string
            }
            return .object(fields)
        }
        claude["cases"] = .array(stripped)
        // Section 19's root supplies `context` (connection, generation,
        // workspace handle, launch id, CLI version) and nothing else this
        // file relies on: its `records` and `cases` are replaced by the
        // Claude file's.
        root["records"] = records
        root["cases"] = claude["cases"]
        let vectors = try ParticipantVectors(data: JSONValue.object(root).canonicalData())
        return ClaudeHostVectors(vectors: vectors, cases: vectors.cases, stdin: stdin, pin: pin)
    }

    /// Replays one host case; the launcher must have been handed exactly the
    /// case's `stdin`, or nothing when it states none.
    func run(_ target: ParticipantVectors.Case) async throws {
        let expected = stdin[target.number]
        try await VectorReplay.run(target, in: vectors) { world in
            let requests = world.launcher.requests
            guard let expected else {
                guard requests.isEmpty else { throw VectorHarnessError.mismatch("Claude #\(target.number) launched with no stdin stated") }
                return
            }
            guard requests.count == 1, let request = requests.first else {
                throw VectorHarnessError.mismatch("Claude #\(target.number) launched \(requests.count) times")
            }
            guard request.identity.runId == target.request.objectValue?["payload"]?.objectValue?["runId"]?.stringValue,
                  request.model == pin.model else {
                throw VectorHarnessError.mismatch("Claude #\(target.number) launched \(request.identity.runId) on \(request.model)")
            }
            if let difference = VectorReplay.difference(.string(String(decoding: request.stdin, as: UTF8.self)), .string(expected)) {
                throw VectorHarnessError.mismatch("Claude #\(target.number) stdin: \(difference)")
            }
        }
    }
}

@Suite("Claude vectors' seeded host cases (contract section 21.6; adapter PR 3e)")
struct ClaudeHostVectorTests {
    /// The named host cases (the plan's "Fake-CLI host cases"), by number.
    static let enabled: [(number: Int, name: String)] = [
        (9, "Claude host: a preparing commit binds the earlier turn by its hash"),
        (10, "Claude host: a start sends the earlier turn and the new message; text before the rate limit is held, then released"),
        (11, "Claude host: text held until a rate limit that shows paid overflow ends the run paid-overflow, nothing kept"),
        (12, "Claude host: tools in init fail the run process-error at sequence 1, before any text"),
        (13, "Claude host: a start under a provider override is participant-unavailable, nothing spawned or sent"),
        (14, "Claude host: availability under a provider override names the off-Mac entry unavailable"),
        (15, "Claude host: a reply past the shared bound, the earlier turn counted, ends reply-too-long after the longest fitting prefix"),
        (16, "Claude host: Stop before the first piece: stopped at sequence 2, no text"),
        (17, "Claude host: Stop after the first piece keeps it: stopped at sequence 3"),
        (18, "Claude host: lock stops the run and pushes nothing after"),
        (19, "Claude host: supervisor lost mid-run: failed process-error, cleanup pending")
    ]

    @Test("Every seeded host case replays through section 19's harness under the off-Mac pin: eleven cases, all executed and passing")
    func everyHostCaseReplays() async throws {
        let claude = try ClaudeHostVectors.load()
        #expect(claude.hostCases.map(\.number) == Self.enabled.map(\.number))
        for (number, name) in Self.enabled {
            #expect(claude.cases[number - 1].name == name, "#\(number) is still the case this slice enabled")
        }
        var passed: [Int] = []
        for vector in claude.hostCases {
            do {
                try await claude.run(vector)
                passed.append(vector.number)
            } catch {
                Issue.record("Claude #\(vector.number) \(vector.name): \(error)")
            }
        }
        print("[claude host vectors] \(claude.hostCases.count) host cases: \(passed.count) passed")
        #expect(passed == Self.enabled.map(\.number), "every host case passes")
    }

    @Test("Each root seeds the off-Mac pin and Claude's input bound, and every run it saves carries its context; the starts that launch name their stdin")
    func rootsAndContext() throws {
        let claude = try ClaudeHostVectors.load()
        for vector in claude.hostCases {
            let root = try claude.vectors.chain(to: vector)[0]
            #expect(root.seed["pin"].flatMap(ParticipantPin.init(json:)) == claude.pin, "#\(vector.number)")
            #expect(root.seed["inputBound"] == .number(Double(ParticipantLimits.firstTrialInputBound)),
                    "#\(vector.number): Claude's first-trial input bound, as the coordinator requires")
            for run in vector.afterRuns ?? [] {
                let entry = try #require(run.objectValue)
                #expect(entry["participant"].flatMap(ParticipantPin.init(json:)) == claude.pin, "#\(vector.number)")
                #expect(entry["contextRunIds"] == .array([.string("71abcdef-0000-4000-8abc-000000001201")]), "#\(vector.number)")
                #expect(entry["contextBytes"] == .number(75), "#\(vector.number): the earlier turn's bytes")
            }
        }
        let launched = claude.hostCases.filter { claude.stdin[$0.number] != nil }.map(\.number)
        #expect(launched == [10, 11, 12, 15], "\(launched)")
        for number in launched {
            let stdin = try #require(claude.stdin[number])
            #expect(stdin.hasPrefix(ParticipantLaunchRequest.stdinPreamble + "\n\n[earlier user turn, 56 bytes]\n"), "#\(number)")
        }
    }
}
