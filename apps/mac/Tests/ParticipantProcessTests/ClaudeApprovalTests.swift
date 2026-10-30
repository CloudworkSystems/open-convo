import Foundation
import Testing
@testable import DeskHost
@testable import ParticipantCoordinator
@testable import ParticipantDeskControls
@testable import ParticipantProcess

// The Claude Code adapter's PR 3d (contract section 21.4): the owner's
// approval of Anthropic, read by section 17's owner just before
// `overflow-unverified`, and the Claude vectors' eight page-level cases run
// through the real coordinator over that owner. The local checks, the
// approval and the owner's authentication are fakes; nothing is spawned but
// the scripted launcher. Invented data only.

/// The vectors' off-Mac pin on a coordinator whose availability and
/// confirmation are the real section 17 owner, with the first-trial bound,
/// over a real store, and optionally a ready local route.
final class ClaudeApprovalWorld {
    /// The vectors' `confirmedAt`, 2026-10-29T03:30:00.000Z.
    static let confirmedAt: Int64 = 1_793_244_600_000

    let vectors: [String: JSONValue]
    let world: VectorWorld
    let checks = ScriptedLocalChecks()
    let approval: InventedApproval
    let owner: PaidUsageConfirmationOwner
    let host: DeskHostProtocol
    let coordinator: ParticipantCoordinator
    let generation: Int
    let pin: ParticipantPin

    init(approved: Bool?, localRoute: Bool = false) async throws {
        let data = try Data(contentsOf: try #require(Bundle.module.url(forResource: "native-participant-claude-v1", withExtension: "json")))
        vectors = try #require(try JSONValue.decode(data).objectValue)
        let context = try #require(vectors["context"]?.objectValue)
        pin = try #require(context["claudeParticipant"].flatMap(ParticipantPin.init(json:)))
        let local = try #require(context["localParticipant"].flatMap(ParticipantPin.init(json:)))
        let shared = try ParticipantVectors.load()
        world = try await VectorWorld(seed: [:], number: 0, operation: "participant.availability", vectors: shared)
        let route = localRoute ? ScriptedLocalRoute([.ready([LocalCatalogEntry(participant: local, available: true)])]) : nil
        let configuration = ParticipantHostConfiguration(pin: pin, inputBound: ParticipantLimits.firstTrialInputBound,
                                                         identities: world.hostConfiguration.identities, localRoute: route)
        host = DeskHostProtocol(store: world.store, connections: world.connections, drafts: DraftBindingRegistry(),
                                info: VectorWorld.info, events: world.sink, participants: configuration)
        approval = InventedApproval(approved)
        owner = PaidUsageConfirmationOwner(checks: checks, approval: approval, authentication: FakeOwnerAuthentication(),
                                           clock: InventedWallClock(wall: Self.confirmedAt))
        coordinator = ParticipantCoordinator(configuration: .init(
            hostConfiguration: configuration, confirmationOwner: owner, launchId: shared.context.launchId,
            clock: world.virtual.clock, executor: world.executor, launcher: world.launcher, log: world.log))
        try await coordinator.attach(host: host, store: world.store, connections: world.connections, sink: world.sink)
        generation = world.connections.validConnections().generation
        world.launcher.prepare(script: try VectorRunSetup(27, "participant.start accepted", in: shared).script)
    }

    func clean() { world.clean() }

    /// The page-level cases: those with no `seed` (the seeded host cases
    /// run in `ClaudeHostVectorTests`).
    var cases: [[String: JSONValue]] {
        (vectors["cases"]?.arrayValue ?? []).compactMap(\.objectValue).filter { $0["seed"] == nil }
    }

    func named(_ name: String) throws -> [String: JSONValue] {
        try #require(cases.first { $0["name"] == .string(name) }, "a case named \(name)")
    }

    func confirm(runs: Int = 0) async throws {
        try #require(await owner.confirm() == .confirmed)
        for _ in 0..<runs { try #require(owner.claimRun()) }
    }

    /// The case's request from this world's connection, with this store's
    /// handle in place of the vectors' invented one.
    func send(_ vector: [String: JSONValue]) async throws -> HostResponse {
        let request = try #require(vector["request"]?.objectValue)
        let operation = try #require(request["operation"]?.stringValue.flatMap(HostOperation.init(rawValue:)))
        var payload = request["payload"]?.objectValue ?? [:]
        if payload["workspaceHandle"] != nil { payload["workspaceHandle"] = .string(world.store.workspaceHandle) }
        return await coordinator.handle(HostRequest(requestId: UUID(), connectionId: world.connectionId, generation: generation,
                                                    operation: operation, payload: payload))
    }

    /// The reply's fields after the envelope, as the vector states them.
    static func stated(_ vector: [String: JSONValue]) throws -> [String: JSONValue] {
        var reply = try #require(vector["reply"]?.objectValue)
        for key in ["v", "requestId", "connectionId", "generation", "operation", "outcome", "reason"] { reply[key] = nil }
        return reply
    }

    /// Prepares the start cases' run through the page's commit: no earlier
    /// turns, so its `contextRunIds` is empty.
    func prepareStartRun(_ vector: [String: JSONValue]) async throws {
        let payload = try #require(vector["request"]?.objectValue?["payload"]?.objectValue)
        let createdAt = "2026-10-29T04:00:00.000Z"
        var run: [String: JSONValue] = ["version": .number(1), "outputChunks": .array([]), "lastSequence": .number(0),
                                        "phase": .string("prepared"), "createdAt": .string(createdAt), "updatedAt": .string(createdAt),
                                        "contextRunIds": .array([])]
        for key in ["runId", "sessionId", "userMessageId", "assistantMessageId", "participant", "inputChunks"] { run[key] = payload[key] }
        var claim: [String: JSONValue] = ["participantId": .string("claude-code"), "createdAt": .string(createdAt)]
        for key in ["runId", "sessionId", "userMessageId", "assistantMessageId"] { claim[key] = payload[key] }
        let reply = await host.handle(HostRequest(
            requestId: UUID(), connectionId: world.connectionId, generation: generation, operation: .workspaceCommitProof,
            payload: ["workspaceHandle": .string(world.store.workspaceHandle), "expectedRevision": .number(0),
                      "record": .object(["schemaVersion": .number(2), "revision": .number(1), "conversationRuns": .array([.object(run)])]),
                      "participantRun": .object(claim)]))
        try #require(reply.outcome == .ok, "\(reply)")
    }
}

@Suite("Anthropic approval in section 17's owner (contract section 21.4; adapter PR 3d)")
struct ClaudeApprovalOwnerTests {
    @Test("Section 5's order: an earlier failing check wins and the approval is not read; with every check passed, not approved is host-not-approved, unreadable is check-failed, approved is overflow-unverified until confirmed")
    func order() async throws {
        let checks = ScriptedLocalChecks(.failed(.signedOut))
        let approval = InventedApproval(false)
        let owner = await inventedOwner(checks: checks, approval: approval)
        #expect(await owner.report().availability == .unavailable(.signedOut))
        #expect(await owner.recheck().availability == .unavailable(.signedOut))
        #expect(approval.reads == 0, "read only once every local check has passed")

        checks.set(InventedSnapshot.passing)
        #expect(await owner.report().availability == .unavailable(.hostNotApproved))
        #expect(await owner.recheck().availability == .unavailable(.hostNotApproved))
        #expect(await owner.report().confirmation == .unconfirmed)
        approval.set(nil)
        #expect(await owner.report().availability == .unavailable(.checkFailed), "an unreadable store is never approved")
        approval.set(true)
        #expect(await owner.report().availability == .unavailable(.overflowUnverified))
        #expect(await owner.confirm() == .confirmed)
        #expect(await owner.report().availability.available)
        #expect(await owner.recheck().availability.available)
    }

    @Test("A revoked approval stops the next answer and the next claim at once, keeps the active confirmation as it is, and counts nothing; approving again restores both")
    func revoke() async throws {
        let approval = InventedApproval(true)
        let owner = await inventedOwner(approval: approval, confirmed: true)
        #expect(owner.claimRun())
        let runsLeft = await owner.report().confirmation
        approval.set(false)
        #expect(!owner.claimRun(), "a revoke after the recheck still stops the spawn")
        approval.set(nil)
        #expect(!owner.claimRun(), "an unreadable store never claims")
        approval.set(false)
        let report = await owner.report()
        #expect(report.availability == .unavailable(.hostNotApproved))
        #expect(report.confirmation?.isActive == true, "the confirmation is not ended by the revoke")
        #expect(report.confirmation == runsLeft, "a refused claim counts nothing")
        #expect(await owner.recheck().availability == .unavailable(.hostNotApproved), "a start's recheck reads it afresh")
        approval.set(true)
        #expect(await owner.recheck().availability.available)
        #expect(owner.claimRun())
    }

    @Test("Over the real store: approving and revoking in the protected store change the owner's next answer")
    func overTheStore() async throws {
        let world = try await ClaudeApprovalWorld(approved: false)
        defer { world.clean() }
        let owner = PaidUsageConfirmationOwner(checks: ScriptedLocalChecks(), approval: world.world.store,
                                               authentication: FakeOwnerAuthentication(), clock: InventedWallClock())
        #expect(await owner.report().availability == .unavailable(.hostNotApproved))
        try world.world.store.approveHost(HostApproval.anthropic)
        #expect(await owner.report().availability == .unavailable(.overflowUnverified))
        #expect(await owner.confirm() == .confirmed)
        #expect(await owner.recheck().availability.available)
        try world.world.store.revokeHost(HostApproval.anthropic)
        #expect(await owner.recheck().availability == .unavailable(.hostNotApproved))
        world.world.store.lockStore()
        #expect(await owner.recheck().availability == .unavailable(.checkFailed))
        world.world.store.unlockStore()
    }

    @Test("The Desk's Check Claude reads host-not-approved as every local check passed")
    func checkClaudeDisplay() {
        let report = ParticipantAvailabilityReport(availability: .unavailable(.hostNotApproved), confirmation: .unconfirmed)
        #expect(PaidUsageDeskControls.check(report) == .passed)
    }
}

@Suite("Shared Claude Code adapter vectors: the page-level cases through the coordinator (contract section 21.6)")
struct ClaudeVectorPageCaseTests {
    @Test("Every availability case is the coordinator's reply exactly, over the real owner with the approval and confirmation the case names")
    func availabilityCases() async throws {
        typealias Setup = (approved: Bool?, failure: ClaudeLocalFailure?, confirm: Bool, runs: Int, revoke: Bool, local: Bool)
        let setups: [String: Setup] = [
            "off-Mac Claude entry not yet approved: host-not-approved": (false, nil, false, 0, false, false),
            "off-Mac Claude entry approved, paid usage not confirmed: overflow-unverified": (true, nil, false, 0, false, false),
            "off-Mac Claude entry approved and confirmed: available (test fake)": (true, nil, true, 0, false, false),
            "off-Mac Claude entry: an earlier check wins over the approval": (false, .signedOut, false, 0, false, false),
            "off-Mac Claude entry: approval revoked while a confirmation is active": (true, nil, true, 2, true, false),
            "off-Mac Claude entry beside a ready local route": (false, nil, false, 0, false, true),
        ]
        var ran = 0
        for (name, setup) in setups {
            let claude = try await ClaudeApprovalWorld(approved: setup.approved, localRoute: setup.local)
            defer { claude.clean() }
            let vector = try claude.named(name)
            if setup.confirm { try await claude.confirm(runs: setup.runs) }
            if setup.revoke { claude.approval.set(false) }
            if let failure = setup.failure { claude.checks.set(.failed(failure)) }
            let reply = try await claude.send(vector)
            #expect(reply.outcome == .ok, "\(name): \(reply)")
            let expected = try ClaudeApprovalWorld.stated(vector)
            #expect(reply.fields == expected, "\(name): \(reply.fields)")
            #expect(claude.world.launcher.requests.isEmpty, "\(name): availability never launches")
            ran += 1
        }
        #expect(ran == 6)
    }

    @Test("participant.start for the off-Mac entry: accepted when approved and confirmed, with one claim and one launch of exactly the message")
    func startAccepted() async throws {
        let claude = try await ClaudeApprovalWorld(approved: true)
        defer { claude.clean() }
        let vector = try claude.named("participant.start for the off-Mac Claude entry accepted")
        try await claude.prepareStartRun(vector)
        try await claude.confirm()
        let reply = try await claude.send(vector)
        #expect(reply.outcome == .ok, "\(reply)")
        #expect(reply.fields["runId"] == vector["reply"]?.objectValue?["runId"])
        let request = try #require(claude.world.launcher.requests.first)
        #expect(claude.world.launcher.requests.count == 1)
        #expect(request.context.isEmpty && request.contextBytes == 0)
        #expect(request.stdin == request.message, "no earlier turns: exactly the message")
        #expect(request.model == claude.pin.model)
        #expect(claude.owner.display.state == .active(confirmedAt: "2026-10-29T03:30:00.000Z", runsLeft: 4), "one run claimed")
    }

    @Test("participant.start before approval: participant-unavailable at the recheck, with nothing written, claimed or launched, even with paid usage confirmed")
    func startBeforeApproval() async throws {
        let claude = try await ClaudeApprovalWorld(approved: true)
        defer { claude.clean() }
        let vector = try claude.named("participant.start for the off-Mac Claude entry before approval: participant-unavailable, nothing sent")
        try await claude.prepareStartRun(vector)
        try await claude.confirm()
        claude.approval.set(false)
        let runId = try #require(vector["request"]?.objectValue?["payload"]?.objectValue?["runId"]?.stringValue)
        let before = claude.world.store.publishedRuns.entry(for: runId)
        let reply = try await claude.send(vector)
        #expect(reply.outcome == .refused && reply.reason == .participantUnavailable, "\(reply)")
        #expect(vector["reply"]?.objectValue?["reason"] == .string("participant-unavailable"))
        #expect(claude.world.launcher.requests.isEmpty, "nothing sent")
        #expect(claude.world.store.publishedRuns.entry(for: runId) == before, "nothing written")
        #expect(claude.owner.display.state == .active(confirmedAt: "2026-10-29T03:30:00.000Z", runsLeft: 5), "nothing claimed")
    }

    @Test("Every page-level case is run here: six availability replies and two starts")
    func everyCaseCounted() async throws {
        let claude = try await ClaudeApprovalWorld(approved: false)
        defer { claude.clean() }
        let operations = claude.cases.compactMap { $0["request"]?.objectValue?["operation"]?.stringValue }
        #expect(operations.filter { $0 == "participant.availability" }.count == 6)
        #expect(operations.filter { $0 == "participant.start" }.count == 2)
        #expect(claude.cases.count == 8)
    }
}

private extension JSONValue {
    var arrayValue: [JSONValue]? {
        if case .array(let values) = self { return values }
        return nil
    }
}
