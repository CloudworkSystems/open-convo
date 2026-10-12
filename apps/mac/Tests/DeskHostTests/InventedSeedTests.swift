import Foundation
import Testing
@testable import DeskHost

/// The host-provisioned first-run seed must open in the pinned renderer. The
/// renderer's `validateState` (apps/desk/src/domain/validation.ts) requires at
/// least one folder ("goal") with a matching goal draft; empty sessions and a
/// null selection are fine. This suite checks the actual generated seed for
/// that shape, checks the `workspace.read` reply the host serves for it, and
/// writes both to a bundle so the pinned TypeScript validator and codec can
/// be run on the real bytes:
///
/// - `DESKHOST_SEED_BUNDLE_OUT=<file>` writes the bundle there (else a temp file).
/// - `DESKHOST_SEED_PROBE_COMMAND="<node> --import <tsx loader> <probe.mts>"`
///   additionally runs that command with the bundle path appended and
///   requires exit status 0 (the probe prints its own JSON report).
@Suite("Invented first-run seed")
struct InventedSeedTests {
    static let iso8601Millis = try! NSRegularExpression(pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$")

    @Test("The default seed carries one invented folder with its goal draft and the renderer's required top-level fields")
    func defaultSeedShape() throws {
        let seed = WorkspaceSeed.inventedRevisionZero(at: Date(timeIntervalSince1970: 1_791_000_000))
        let record = seed.record
        #expect(Set(record.keys) == ["schemaVersion", "revision", "updatedAt", "goals", "sessions", "messages", "drafts", "goalDrafts",
                                     "workItems", "notes", "activity", "selection", "preferences", "capabilities"])
        #expect(record["schemaVersion"] == .number(1))
        #expect(record["revision"] == .number(0))
        let stamp = try #require(record["updatedAt"]?.stringValue)
        #expect(Self.iso8601Millis.firstMatch(in: stamp, range: NSRange(stamp.startIndex..., in: stamp)) != nil, "renderer timestamps are toISOString() form")
        #expect(stamp == "2026-10-03T04:00:00.000Z")

        let goals = try #require(record["goals"]?.arrayValue)
        #expect(goals.count == 1, "the renderer needs at least one folder")
        let goal = try #require(goals.first?.objectValue)
        #expect(Set(goal.keys) == ["id", "title", "nextStep", "createdAt", "updatedAt"])
        let goalId = try #require(goal["id"]?.stringValue)
        #expect(UUID.isRecordId(goalId))
        let title = goal["title"]?.stringValue ?? ""
        #expect(!title.trimmingCharacters(in: CharacterSet.whitespaces).isEmpty)
        #expect(goal["nextStep"]?.stringValue != nil)
        #expect(goal["createdAt"] == .string(stamp))
        #expect(goal["updatedAt"] == .string(stamp))
        let goalDrafts = try #require(record["goalDrafts"]?.objectValue)
        #expect(Set(goalDrafts.keys) == [goalId], "goal drafts match their goals one to one")
        #expect(goalDrafts[goalId] == .object(["nextStep": .null, "workTitle": .string("")]))

        #expect(record["sessions"] == .array([]))
        #expect(record["drafts"] == .object([:]), "drafts match sessions one to one")
        #expect(record["messages"] == .array([]))
        #expect(record["workItems"] == .array([]))
        #expect(record["notes"] == .array([]))
        #expect(record["activity"] == .array([]))
        #expect(record["selection"] == .object(["goalId": .null, "sessionId": .null, "route": .string("sessions")]))
        #expect(record["preferences"] == .object(["theme": .string("system")]))
        #expect(record["capabilities"] == .object(["mode": .string("synthetic"), "provider": .string("demo-only"), "native": .string("unavailable")]))
        // Every seed invents its own folder identity.
        #expect(WorkspaceSeed.inventedRevisionZero().record["goals"]?.arrayValue?.first?.objectValue?["id"] != goal["id"])
    }

    @Test("The host serves the actual default seed through workspace.read in the agreed reply shape, and the pinned validator and codec accept it when the probe is configured")
    func defaultSeedThroughWorkspaceRead() async throws {
        let harness = try HostHarness()
        defer { harness.clean() }
        let seed = try harness.store.read()
        #expect(seed.revision == 0)
        let request = harness.readRequest()
        let response = await harness.host.handle(request)
        #expect(response.outcome == .ok)
        #expect(Set(response.fields.keys) == ["record", "revision"])
        #expect(response.revision == 0)
        #expect(response.record == seed.record)
        #expect(response.record?["revision"]?.safeIntegerValue == response.revision, "record.revision equals revision")
        #expect(response.record?["goals"]?.arrayValue?.isEmpty == false, "the served seed has a folder")

        let bundle: JSONValue = .object([
            "context": .object(["connectionId": .string(harness.connection.id), "documentGeneration": .number(Double(harness.connection.generation))]),
            "readRequest": .object(["requestId": .string(request.requestIdString), "operation": .string(request.operation.rawValue), "payload": .object(request.payload)]),
            "readReply": response.jsonValue,
            "seed": .object(seed.record)
        ])
        let environment = ProcessInfo.processInfo.environment
        let output = environment["DESKHOST_SEED_BUNDLE_OUT"].map { URL(fileURLWithPath: $0) }
            ?? harness.fixture.directory.appendingPathComponent("seed-bundle.json")
        try bundle.canonicalData().write(to: output)
        #expect(FileManager.default.fileExists(atPath: output.path))

        guard let command = environment["DESKHOST_SEED_PROBE_COMMAND"], !command.isEmpty else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "\(command) '\(output.path)'"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        let report = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        #expect(process.terminationStatus == 0, "pinned validator/codec probe: \(report)")
    }
}
