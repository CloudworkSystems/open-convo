import DeskHost
import DeskHostWebKit
import Foundation
@testable import ParticipantAppWiring
@testable import ParticipantCoordinator
@testable import ParticipantProcess
import Testing
import TrueConvoIdentity

// Step 3 PR 4b: the app's one participant lane. On in True Convo Test only;
// the Claude Code entry is listed first (section 20.2) and never available.
// Ollama is played by `ScriptedLocalRoute` (LocalStartTests.swift); nothing
// here reaches the real Ollama. Invented data only.

@Suite("The app's local lane (step 3 PR 4b)")
struct LocalConversationLaneTests {
    @Test("On only for True Convo Test: the real app, and any other identity, gets no lane")
    func testCopyOnly() {
        #expect(LocalConversationLane.factory(for: .release) == nil, "the real app has no lane")
        #expect(LocalConversationLane.factory(for: .test) != nil, "True Convo Test has one (not built here: that would reach Ollama)")
        #expect(!LocalConversationLane.turnsOn(for: .release))
        #expect(LocalConversationLane.turnsOn(for: .test))
        // Unit tests and `swift run` have no bundle id, so they are the real app.
        #expect(AppIdentity.current.kind == .release)
        #expect(LocalConversationLane.factory(for: .current) == nil)
    }

    @Test("Built with shipping availability, no confirmation owner, no first-trial bound, the given route and a launcher that refuses")
    func configuration() throws {
        let route = ScriptedLocalRoute([.unavailable(reason: "ollama-not-running")])
        let coordinator = LocalConversationLane.makeCoordinator(route: route, launchId: UUID().uuidString.lowercased())
        let configuration = coordinator.configuration
        #expect(configuration.confirmation == nil, "no section 17 owner: nothing can confirm paid usage")
        #expect(configuration.availability is CheckedAvailability)
        #expect(configuration.hostConfiguration.inputBound == nil)
        #expect(configuration.hostConfiguration.localRoute === route)
        #expect(configuration.hostConfiguration.pin == LocalConversationLane.claudePin)
        #expect(configuration.hostConfiguration.pin.id == "claude-code")
        #expect(configuration.launcher is ClaudeNotConnected)
        #expect(configuration.launcher.cliVersion == ParticipantCommandLine.pinnedCLIVersion)
        let request = ParticipantLaunchRequest(
            identity: ParticipantRunIdentity(runId: "71abcdef-0000-4000-8abc-000000000a01", sessionId: "52abcdef-0000-4000-8abc-000000000a01",
                                         createdAtMillis: 0),
            model: "not-connected", inputChunks: ["Invented."], inputBytes: 9, preparedBytes: 9)
        #expect(throws: ClaudeNotConnected.Refused.self) { _ = try configuration.launcher.launch(request) }
    }

    @Test("Availability lists the Claude entry first, never available, then the local models and the route")
    func availability() async throws {
        let local = ParticipantPin(id: "ollama-local", label: "invented-local:8b", model: "invented-local:8b@" + String(repeating: "e5", count: 32),
                                   executionHost: "this-mac")!
        let route = ScriptedLocalRoute([.ready([LocalCatalogEntry(participant: local, available: true)])])
        let coordinator = LocalConversationLane.makeCoordinator(route: route, launchId: UUID().uuidString.lowercased())
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("LocalLane-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = try ProofStore(directory: folder.appendingPathComponent("proof", isDirectory: true), keys: InventedInMemoryKeyProvider())
        defer { store.close() }
        let connections = ConnectionRegistry()
        let sink = WebKitHostEventSink()
        let host = coordinator.makeHost(store: store, connections: connections, drafts: DraftBindingRegistry(),
                                        info: HostInfo(appVersion: "0.0.0-test", hostBuild: "local-lane"), events: sink)
        try await coordinator.attach(host: host, store: store, connections: connections, sink: sink)
        defer { Task { await coordinator.detach() } }
        let connection = await host.issueConnection()
        let reply = await coordinator.handle(HostRequest(requestId: UUID(), connectionId: connection.id, generation: connection.generation,
                                                         operation: .participantAvailability, payload: [:]))
        #expect(reply.outcome == .ok, "\(reply.jsonValue)")
        guard case .array(let participants)? = reply.fields["participants"] else { Issue.record("\(reply.jsonValue)"); return }
        #expect(participants.count == 2)
        let claude = participants.first?.objectValue
        #expect(claude?["id"] == .string("claude-code"))
        #expect(claude?["available"] == .bool(false))
        #expect(claude?["reason"] == .string("overflow-unverified"))
        #expect(claude?["confirmation"] == nil, "no confirmation key: section 17 is not built into this lane")
        #expect(participants.last?.objectValue?["model"] == .string(local.model))
        #expect(participants.last?.objectValue?["available"] == .bool(true))
        guard case .array(let routes)? = reply.fields["routes"] else { Issue.record("\(reply.jsonValue)"); return }
        #expect(routes.first?.objectValue?["state"] == .string("ready"))
        #expect(route.runs.isEmpty, "availability sends no chat")
    }
}
