import DeskHost
import DeskHostWebKit
import DeskWindowKit
import Foundation
@testable import ParticipantAppWiring
@testable import ParticipantCoordinator
@testable import ParticipantProcess
import Testing
import TrueConvoIdentity

// The Claude Code adapter's PR 4b: True Convo Test's Claude entry. The
// owner here runs over scripted local checks and a fake owner check
// (PaidUsageSupport.swift), Ollama is `ScriptedLocalRoute`, and nothing
// reaches the real Claude Code, LocalAuthentication or Ollama. Invented
// data in throwaway folders only.

@Suite("True Convo Test's Claude entry (the Claude Code adapter's PR 4b)")
struct ClaudeConversationWiringTests {
    static func folder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ClaudeWiring-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    /// The entry over fakes, with observers on private centers.
    @MainActor
    static func entry(approvals: CurrentStoreApproval = CurrentStoreApproval(), checks: ScriptedLocalChecks = ScriptedLocalChecks(),
                      launcher: any ParticipantLaunching = ClaudeNotConnected()) -> ClaudeConversation {
        let owner = PaidUsageConfirmationOwner(checks: checks, approval: approvals,
                                               authentication: FakeOwnerAuthentication(.immediately(.authenticated)))
        return ClaudeConversation(owner: owner, approvals: approvals, launcher: launcher,
                                  signals: PaidUsageEndSignals(owner: owner, distributedCenter: NotificationCenter(),
                                                               workspaceCenter: NotificationCenter()))
    }

    /// Invented init values, as section 16's run would record them.
    static let invented = ParticipantInitExpectation(model: LocalConversationLane.claudePin.model, slashCommands: ["invented-command"],
                                                     skills: [], plugins: .array([]), apiKeySource: "none")
    static let executable = URL(fileURLWithPath: "/invented/True Convo Test.app/Contents/MacOS/True Convo Test")

    @Test("Made for True Convo Test only, and only once section 16's init values are recorded: nil for the real app, before the recording and with no executable, and nothing is made in their folders")
    @MainActor
    func testCopyOnly() throws {
        let root = try Self.folder()
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = DeskPaths(applicationSupport: root, identity: .release)
        let testPaths = DeskPaths(applicationSupport: root, identity: .test)
        #expect(ClaudeConversation.make(for: .release, paths: paths, executable: Self.executable, log: { _, _ in },
                                        expectedInit: Self.invented) == nil)
        #expect(ClaudeConversation.make(for: .current, paths: paths, executable: Self.executable, log: { _, _ in },
                                        expectedInit: Self.invented) == nil, "unit tests have no bundle id, so they are the real app")
        #expect(ClaudeConversation.make(for: .test, paths: testPaths, executable: nil, log: { _, _ in },
                                        expectedInit: Self.invented) == nil)
        // Codex P1 on #228: nothing is offered that could not run.
        #expect(ClaudeConversation.recordedInit == nil, "not recorded until section 16's run")
        let logs = LockedLines()
        #expect(ClaudeConversation.make(for: .test, paths: testPaths, executable: Self.executable,
                                        log: { logs.append("\($0) \($1)") }) == nil, "the app's call, before the recording")
        #expect(logs.lines == ["claude.wiring.off reason=init-unrecorded"])
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty, "no folder made for any of them")
    }

    @Test("For True Convo Test: the private participants folder under the Desk's invented-data folder, the production launcher over the pinned file, the bundled supervisor and the recorded values, and the end observers running")
    @MainActor
    func madeForTheTestCopy() throws {
        let root = try Self.folder()
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = DeskPaths(applicationSupport: root, identity: .test)
        let logs = LockedLines()
        let entry = try #require(ClaudeConversation.make(for: .test, paths: paths, executable: Self.executable,
                                                         log: { logs.append("\($0) \($1)") }, expectedInit: Self.invented))
        defer { entry.stopObserving() }
        var info = stat()
        let participants = paths.base.appendingPathComponent(ParticipantsFolder.name)
        #expect(lstat(participants.path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFDIR)
        #expect(info.st_mode & 0o7777 == 0o700 && info.st_uid == getuid(), "this user's, and no one else's")
        let launcher = try #require(entry.launcher as? ProcessParticipantLauncher)
        #expect(launcher.supervisorPath == "/invented/True Convo Test.app/Contents/MacOS/ParticipantSupervisor")
        let roots = try #require(ClaudeCheckRoots.forCurrentUser(probeParent: participants))
        #expect(launcher.cliPath == roots.binaryPath, "the exact pinned file the local checks read, never the launcher link")
        #expect(launcher.cliPath.hasSuffix("/" + ParticipantCommandLine.pinnedCLIVersion))
        #expect(launcher.workingParent.url.standardizedFileURL.path == participants.standardizedFileURL.path)
        #expect(launcher.expectedInit == Self.invented)
        #expect(entry.signals.isRunning, "the end observers run from launch")
        #expect(logs.lines == ["claude.wiring.on "])
    }

    @Test("With the entry, the lane's Claude side is section 17's owner, with the first-trial bound and the entry's launcher; the local route is unchanged")
    @MainActor
    func configuration() {
        let route = ScriptedLocalRoute([.unavailable(reason: "ollama-not-running")])
        let entry = Self.entry()
        let configuration = LocalConversationLane.configuration(route: route, launchId: UUID().uuidString.lowercased(), claude: entry)
        #expect(configuration.confirmation as? PaidUsageConfirmationOwner === entry.owner, "the owner ends and claims runs")
        #expect(configuration.availability as? PaidUsageConfirmationOwner === entry.owner, "and is the availability, so the two agree")
        #expect(configuration.hostConfiguration.inputBound == ParticipantLimits.firstTrialInputBound)
        #expect(configuration.hostConfiguration.pin == LocalConversationLane.claudePin)
        #expect(configuration.hostConfiguration.localRoute === route)
        #expect(configuration.launcher is ClaudeNotConnected)
        let without = LocalConversationLane.configuration(route: route, launchId: UUID().uuidString.lowercased(), claude: nil)
        #expect(without.confirmation == nil && without.availability is CheckedAvailability && without.hostConfiguration.inputBound == nil,
                "without the entry, as before: never available")
    }

    @Test("The approval reader follows the open store: none open reads not approved, a closed one unreadable, and only the owner's saved approval approves")
    func approvalFollowsTheStore() throws {
        let root = try Self.folder()
        defer { try? FileManager.default.removeItem(at: root) }
        let approvals = CurrentStoreApproval()
        #expect(approvals.isApproved(host: HostApproval.anthropic) == false, "no store open")
        let store = try ProofStore(directory: root.appendingPathComponent("proof", isDirectory: true), keys: InventedInMemoryKeyProvider())
        approvals.use(store)
        #expect(approvals.isApproved(host: HostApproval.anthropic) == false)
        _ = try store.approveHost(HostApproval.anthropic)
        #expect(approvals.isApproved(host: HostApproval.anthropic) == true)
        try store.revokeHost(HostApproval.anthropic)
        #expect(approvals.isApproved(host: HostApproval.anthropic) == false, "a withdrawal counts at once")
        _ = try store.approveHost(HostApproval.anthropic)
        store.close()
        #expect(approvals.isApproved(host: HostApproval.anthropic) == nil, "a closed store cannot be read, so never approved")
        approvals.use(nil)
        #expect(approvals.isApproved(host: HostApproval.anthropic) == false, "gone with the stack")
    }

    @Test("Through the real coordinator: not approved, then approved but unconfirmed, then available; a withdrawal and a lock each close it again")
    @MainActor
    func bothGates() async throws {
        let root = try Self.folder()
        defer { try? FileManager.default.removeItem(at: root) }
        let approvals = CurrentStoreApproval()
        let entry = Self.entry(approvals: approvals)
        let route = ScriptedLocalRoute([.unavailable(reason: "ollama-not-running")])
        let coordinator = LocalConversationLane.makeCoordinator(route: route, launchId: UUID().uuidString.lowercased(), claude: entry)
        let store = try ProofStore(directory: root.appendingPathComponent("proof", isDirectory: true), keys: InventedInMemoryKeyProvider())
        defer { store.close() }
        approvals.use(store)
        let connections = ConnectionRegistry()
        let sink = WebKitHostEventSink()
        let host = coordinator.makeHost(store: store, connections: connections, drafts: DraftBindingRegistry(),
                                        info: HostInfo(appVersion: "0.0.0-test", hostBuild: "claude-wiring"), events: sink)
        let lane: any DeskParticipantLane = coordinator
        try await lane.attach(host: host, store: store, connections: connections, sink: sink)
        await lane.unlock(ifNoLockSince: lane.lockEpoch)
        let connection = await host.issueConnection()
        func claude() async -> [String: JSONValue]? {
            let reply = await coordinator.handle(HostRequest(requestId: UUID(), connectionId: connection.id, generation: connection.generation,
                                                             operation: .participantAvailability, payload: [:]))
            guard reply.outcome == .ok, case .array(let participants)? = reply.fields["participants"] else { return nil }
            return participants.first?.objectValue
        }
        let first = await claude()
        #expect(first?["id"] == .string("claude-code") && first?["executionHost"] == .string("anthropic"))
        #expect(first?["available"] == .bool(false))
        #expect(first?["reason"] == .string("host-not-approved"), "\(String(describing: first))")
        _ = try store.approveHost(HostApproval.anthropic)
        let approved = await claude()
        #expect(approved?["reason"] == .string("overflow-unverified"), "approved, not yet confirmed: \(String(describing: approved))")
        let confirmed = await entry.owner.confirm()
        #expect(confirmed == .confirmed)
        let open = await claude()
        #expect(open?["available"] == .bool(true), "\(String(describing: open))")
        try store.revokeHost(HostApproval.anthropic)
        let withdrawn = await claude()
        #expect(withdrawn?["reason"] == .string("host-not-approved"), "a withdrawal closes it at once")
        _ = try store.approveHost(HostApproval.anthropic)
        let again = await claude()
        #expect(again?["available"] == .bool(true))
        entry.owner.end(.lock)
        let locked = await claude()
        #expect(locked?["reason"] == .string("overflow-unverified"), "a lock ends the confirmation")
        #expect(route.runs.isEmpty, "nothing sent to Ollama")
        await lane.detach()
    }
}

/// Log lines, collected across threads.
final class LockedLines: @unchecked Sendable {
    private let lock = NSLock()
    private var collected: [String] = []
    func append(_ line: String) { lock.lock(); collected.append(line); lock.unlock() }
    var lines: [String] { lock.lock(); defer { lock.unlock() }; return collected }
}
