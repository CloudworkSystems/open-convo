import AppKit
import DeskHost
import DeskWindowKit
import Foundation
import ParticipantDeskControls
import ParticipantProcess
import TrueConvoIdentity

/// The Claude Code adapter's PR 4b: the Claude entry turned on, in True
/// Convo Test only, as the fake-CLI kill proof composed it
/// (`ClaudeConversationProofHost`).
///
/// In plain words: section 5's real local checks (with `auth status`'s
/// network blocked, the owner's D1 choice), section 17's real owner over
/// macOS's own owner check, section 21.4's approval read from the Desk's
/// open store, and the production launcher with the bundled supervisor.
/// Nothing is sent until the owner has approved Anthropic in the Desk
/// window and confirmed there that paid usage is off; each confirmation
/// allows five runs, and every lock, sleep, logout and quit ends it. The
/// real app gets none of this (`make` answers nil), so its Desk has no
/// participants at all. Made once per launch, at launch, so the end
/// observers run whether or not a Desk window exists (section 17).
@MainActor
public final class ClaudeConversation {
    /// Section 17's owner: the coordinator's availability and its run
    /// claims, and the window's paid-usage controls.
    nonisolated let owner: PaidUsageConfirmationOwner
    /// Section 21.4's approval, read from the store the Desk has open now.
    nonisolated let approvals: CurrentStoreApproval
    /// The production launcher over the pinned CLI file and the bundled
    /// supervisor (tests may give another).
    nonisolated let launcher: any ParticipantLaunching
    let signals: PaidUsageEndSignals
    /// The window's section 17 controls.
    public let paidUsage: any DeskPaidUsageControlling

    /// The values Claude Code's first stream line must carry besides the
    /// model and the empty tool lists (section 11's init rule), as recorded
    /// on the owner's Mac on 2026-11-01 with the pinned CLI, the app's
    /// flags and the network blocked (section 16's recording). The one
    /// plugin is the CLI's built-in `agents-md`, shown on 2026-11-02 to load
    /// no AGENTS.md under those flags (contract section 16); any other
    /// value at start still stops the run.
    nonisolated static let recordedInit = ParticipantInitExpectation(
        model: LocalConversationLane.claudePin.model, slashCommands: [], skills: [],
        plugins: .array([.object(["name": .string("agents-md"), "path": .string("builtin"),
                                  "source": .string("agents-md@builtin")])]),
        apiKeySource: "none")

    init(owner: PaidUsageConfirmationOwner, approvals: CurrentStoreApproval, launcher: any ParticipantLaunching,
         signals: PaidUsageEndSignals) {
        self.owner = owner
        self.approvals = approvals
        self.launcher = launcher
        self.signals = signals
        paidUsage = PaidUsageDeskControls(owner: owner)
    }

    /// True Convo Test's Claude entry, with its end observers started; nil
    /// for every other identity, the real app included. Nil too without
    /// recorded init values, so nothing is offered that could not run
    /// (Codex P1 on #228); the app passes `recordedInit`. And nil if this user's
    /// folders cannot be read or the private participants folder cannot be
    /// made, under the Desk's own invented-data folder (`paths`). The
    /// supervisor is the one bundled beside `executable`.
    public static func make(for identity: AppIdentity, paths: DeskPaths, executable: URL?,
                            log: @escaping @Sendable (_ event: String, _ detail: String) -> Void) -> ClaudeConversation? {
        make(for: identity, paths: paths, executable: executable, log: log, expectedInit: recordedInit)
    }

    /// The same, with the init values given (tests give invented ones).
    static func make(for identity: AppIdentity, paths: DeskPaths, executable: URL?,
                     log: @escaping @Sendable (_ event: String, _ detail: String) -> Void,
                     expectedInit: ParticipantInitExpectation?) -> ClaudeConversation? {
        guard LocalConversationLane.turnsOn(for: identity) else { return nil }
        guard let expectedInit else {
            log("claude.wiring.off", "reason=init-unrecorded")
            return nil
        }
        guard let executable else {
            log("claude.wiring.off", "reason=no-executable")
            return nil
        }
        let parent: ParticipantsParent
        do {
            parent = try ParticipantsFolder.prepare(in: try paths.prepareBase())
        } catch {
            log("claude.wiring.off", "reason=participants-folder")
            return nil
        }
        // Each probe and each run gets its own new, empty 0700 folder
        // under this one private parent, inside Application Support, where
        // no git root sits above it (section 5 step 3).
        guard let roots = ClaudeCheckRoots.forCurrentUser(probeParent: parent.url) else {
            log("claude.wiring.off", "reason=user-database")
            return nil
        }
        let approvals = CurrentStoreApproval()
        let owner = PaidUsageConfirmationOwner(checks: ClaudeLocalChecks(roots: roots), approvals: approvals)
        let launcher = ProcessParticipantLauncher(supervisorPath: ParticipantSupervisorLocation.besides(executable: executable),
                                                  cliPath: roots.binaryPath, workingParent: parent, expectedInit: expectedInit)
        let signals = PaidUsageEndSignals(owner: owner, workspaceCenter: NSWorkspace.shared.notificationCenter)
        signals.start()
        log("claude.wiring.on", "")
        return ClaudeConversation(owner: owner, approvals: approvals, launcher: launcher, signals: signals)
    }

    /// Points the owner's approval reader at `session`'s store, now and as
    /// it changes. Called once, when the app makes its Desk session, before
    /// any store opens.
    public func follow(_ session: DeskSession) {
        let approvals = self.approvals
        approvals.use(session.store)
        session.onStoreChange = { approvals.use($0) }
    }

    /// The window's section 21.4 control, over `session`'s open store.
    public func hostApproval(for session: DeskSession) -> any DeskHostApprovalControlling {
        HostApprovalDeskControls(store: { [weak session] in session?.store })
    }

    /// Tests only: stops the end observers.
    func stopObserving() {
        signals.stop()
    }

    /// The app's quit: any confirmation under way is abandoned (section 17;
    /// the window's own close does this too when it is open). The
    /// confirmation itself lives in memory and goes with the process.
    public func appWillQuit() {
        owner.abandonPendingConfirmation()
    }
}
