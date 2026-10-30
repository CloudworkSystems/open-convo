import Foundation
import Testing
@testable import DeskHost
@testable import DeskWindowKit
@testable import ParticipantCoordinator
@testable import ParticipantDeskControls
@testable import ParticipantProcess

// The Claude Code adapter's PR 4a, "Nothing leaves without consent" (the
// plan's Proofs): no spawn unless both gates are passed, a withdrawn
// approval or an ended paid-usage confirmation stops the next spawn, and the
// CLI never receives an API key or proxy setting. Through the real
// coordinator, section 17's real owner and a real store; the local checks,
// the owner's authentication and the launcher are fakes, so nothing real is
// ever run. Invented data only.

@Suite("Nothing leaves without consent (Claude Code adapter PR 4a)")
struct ClaudeConsentProofTests {
    static let accepted = "participant.start for the off-Mac Claude entry accepted"

    @Test("Approved by the owner and paid usage confirmed: only both together launch the CLI, once; any other pair is participant-unavailable with nothing launched or claimed")
    func bothGates() async throws {
        var launched: [String] = []
        for approved in [false, true] {
            for confirmed in [false, true] {
                let claude = try await ClaudeApprovalWorld(approved: true)
                defer { claude.clean() }
                let vector = try claude.named(Self.accepted)
                try await claude.prepareStartRun(vector)
                if confirmed { try await claude.confirm() }
                if !approved { claude.approval.set(false) }
                let reply = try await claude.send(vector)
                let name = "approved \(approved), confirmed \(confirmed)"
                if approved && confirmed {
                    #expect(reply.outcome == .ok, "\(name): \(reply)")
                    #expect(claude.world.launcher.requests.count == 1, "\(name)")
                    launched.append(name)
                } else {
                    #expect(reply.outcome == .refused && reply.reason == .participantUnavailable, "\(name): \(reply)")
                    #expect(claude.world.launcher.requests.isEmpty, "\(name): nothing sent")
                    if confirmed {
                        #expect(claude.owner.display.state == .active(confirmedAt: "2026-10-29T03:30:00.000Z", runsLeft: 5),
                                "\(name): nothing claimed")
                    }
                }
            }
        }
        #expect(launched == ["approved true, confirmed true"])
    }

    @Test("An ended paid-usage confirmation (a lock, sleep or login change) stops the next spawn, with the approval still saved")
    func endedConfirmation() async throws {
        for end in [ParticipantConfirmationEnd.lock, .sleep, .loginChanged] {
            let claude = try await ClaudeApprovalWorld(approved: true)
            defer { claude.clean() }
            let vector = try claude.named(Self.accepted)
            try await claude.prepareStartRun(vector)
            try await claude.confirm()
            claude.owner.end(end)
            #expect(!claude.owner.claimRun(), "\(end)")
            let reply = try await claude.send(vector)
            #expect(reply.outcome == .refused && reply.reason == .participantUnavailable, "\(end): \(reply)")
            #expect(claude.world.launcher.requests.isEmpty, "\(end): nothing sent")
            #expect(claude.owner.display.state == .ended(end), "\(end)")
        }
    }

    @Test("A withdrawn approval stops the next spawn after one already went, and approving again allows exactly one more")
    func withdrawnApproval() async throws {
        let claude = try await ClaudeApprovalWorld(approved: true)
        defer { claude.clean() }
        let vector = try claude.named(Self.accepted)
        try await claude.prepareStartRun(vector)
        try await claude.confirm()
        #expect(try await claude.send(vector).outcome == .ok)
        #expect(claude.world.launcher.requests.count == 1)
        claude.approval.set(false)
        #expect(!claude.owner.claimRun(), "the next claim is refused at once")
        claude.approval.set(nil)
        #expect(!claude.owner.claimRun(), "an unreadable store never claims")
        #expect(claude.world.launcher.requests.count == 1, "nothing more sent")
    }

    @Test("The window's control over the real store: Approve and Withdraw change the owner's next answer and claim; a locked or missing store reads unreadable and writes nothing")
    @MainActor
    func controlOverTheStore() async throws {
        let world = try await ClaudeApprovalWorld(approved: false)
        defer { world.clean() }
        let store = world.world.store
        var current: ProofStore? = store
        let approvedAt = Date(timeIntervalSince1970: 1_793_244_600)
        let controls = HostApprovalDeskControls(store: { current }, now: { approvedAt })
        var changes = 0
        controls.onChange = { changes += 1 }
        let owner = PaidUsageConfirmationOwner(checks: ScriptedLocalChecks(), approval: store,
                                               authentication: FakeOwnerAuthentication(), clock: InventedWallClock())
        #expect(controls.state == .notApproved)
        #expect(await owner.report().availability == .unavailable(.hostNotApproved))

        #expect(controls.approve() == .approved)
        #expect(controls.state == .approved(at: approvedAt))
        #expect(try store.hostApproval(HostApproval.anthropic)?.approvedAt == "2026-10-29T03:30:00.000Z")
        #expect(await owner.report().availability == .unavailable(.overflowUnverified), "approval alone launches nothing")
        #expect(!owner.claimRun(), "nor claims")
        #expect(await owner.confirm() == .confirmed)
        #expect(owner.claimRun())
        #expect(controls.approve() == .approved, "approving again keeps the saved one")
        #expect(controls.state == .approved(at: approvedAt))

        #expect(controls.withdraw() == .withdrawn)
        #expect(controls.state == .notApproved)
        #expect(!owner.claimRun(), "a withdrawal stops the next claim")
        #expect(changes == 3)

        store.lockStore()
        #expect(controls.state == .unreadable)
        #expect(controls.approve() == .failed)
        store.unlockStore()
        #expect(controls.state == .notApproved, "the locked write changed nothing")
        current = nil
        #expect(controls.state == .unreadable)
        #expect(controls.approve() == .failed)
        #expect(changes == 3, "a failed write reports no change")
        current = store
        #expect(controls.state == .notApproved)
    }

    @Test("The mappings: an unsynced write is reported as such, every other store error as nothing changed")
    func mappings() {
        #expect(HostApprovalDeskControls.result(ProofStoreError.replacedUnsynced(5)) == .unsynced)
        for error: Error in [ProofStoreError.writeFailed(5), ProofStoreError.locked, ProofStoreError.closed, ProofStoreError.invalidHost,
                             CocoaError(.fileWriteUnknown)] {
            #expect(HostApprovalDeskControls.result(error) == .failed, "\(error)")
        }
        #expect(HostApprovalDeskControls.state(nil) == .notApproved)
        let approval = HostApproval(host: HostApproval.anthropic, approvedAt: "2026-10-29T03:30:00.000Z")
        #expect(approval != nil)
        #expect(approval.map(HostApprovalDeskControls.state) == .approved(at: Date(timeIntervalSince1970: 1_793_244_600)))
    }

    @Test("The CLI's environment never carries an API key, token, base URL, other provider or proxy, whatever the app's own holds (as ParticipantLaunchTests' allow-list and LaunchBoundaryTests' spawned check)")
    func noKeyOrProxyReachesTheCLI() {
        let leaking = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK",
                       "CLAUDE_CODE_USE_VERTEX", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY",
                       "NO_PROXY", "NODE_EXTRA_CA_CERTS"]
        var source = Dictionary(uniqueKeysWithValues: leaking.map { ($0, "invented-not-a-secret") })
        source["HOME"] = "/invented/home"
        let built = ParticipantEnvironment.build(from: source)
        for name in leaking {
            #expect(!built.contains { $0.hasPrefix(name + "=") }, "\(name)")
        }
        #expect(!built.contains { $0.contains("invented-not-a-secret") })
        #expect(built.contains("HOME=/invented/home"))
    }
}
