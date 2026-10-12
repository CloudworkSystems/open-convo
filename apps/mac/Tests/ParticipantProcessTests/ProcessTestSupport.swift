import Darwin
import DeskHost
import Foundation
@testable import ParticipantProcess
import ParticipantSupervisorCore
import Testing

/// Locates the build's products: the test bundle sits beside the executables.
final class ProductsMarker {}

enum Products {
    static let directory = Bundle(for: ProductsMarker.self).bundleURL.deletingLastPathComponent()

    static func path(_ name: String) -> String {
        directory.appendingPathComponent(name).path
    }

    static var supervisor: String { path("ParticipantSupervisor") }
    static var pausingSupervisor: String { path("ParticipantPausingSupervisor") }
    static var fakeCLI: String { path("ParticipantFakeCLI") }
    static var testHost: String { path("ParticipantTestHost") }
    static var availabilityProbe: String { path("ParticipantAvailabilityProbe") }

    static func require() throws {
        for name in [supervisor, pausingSupervisor, fakeCLI, testHost, availabilityProbe] {
            guard FileManager.default.isExecutableFile(atPath: name) else {
                throw ProcessTestError.missingProduct(name)
            }
        }
    }
}

enum ProcessTestError: Error, CustomStringConvertible {
    case missingProduct(String)
    case timeout(String)

    var description: String {
        switch self {
        case .missingProduct(let path): return "missing build product \(path); run swift build first"
        case .timeout(let what): return "timed out waiting for \(what)"
        }
    }
}

/// Invented stream-json lines. Field names were checked against the strings
/// of the installed CLI 2.1.283 binary file (its SDK message schemas), never
/// against a run: `system`/`init` with `model`, `tools`, `mcp_servers`,
/// `slash_commands`, `skills`, `plugins`, `apiKeySource`; `rate_limit_event`
/// with `rate_limit_info.overageStatus`, `isUsingOverage`, `overageInUse`;
/// `stream_event` with `event.type` `message_start`, `content_block_start`
/// (`index`, `content_block.type`), `content_block_delta` (`delta.type`
/// `text_delta`/`thinking_delta`, `delta.text`); `result` with `subtype`
/// and `is_error`.
enum Invented {
    static let model = "invented-pinned-model"
    static let expectation = ParticipantInitExpectation(
        model: model, slashCommands: ["invented-command"], skills: [],
        plugins: .array([]), apiKeySource: "none")

    static func json(_ object: [String: Any]) -> String {
        let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self)
    }

    static func initLine(model: String = model, tools: [String] = [], mcpServers: [[String: Any]] = [],
                         slashCommands: [String] = ["invented-command"], skills: [String] = [],
                         plugins: [[String: Any]] = [], apiKeySource: String = "none") -> String {
        json(["type": "system", "subtype": "init", "model": model, "tools": tools, "mcp_servers": mcpServers,
              "slash_commands": slashCommands, "skills": skills, "plugins": plugins, "apiKeySource": apiKeySource,
              "cwd": "/invented", "session_id": "invented-session", "uuid": "00000000-0000-4000-8000-000000000001",
              "claude_code_version": "invented", "permissionMode": "default", "output_style": "default"])
    }

    static func rateLimit(overageStatus: Any? = "rejected", isUsingOverage: Any? = false, overageInUse: Any? = nil) -> String {
        var info: [String: Any] = ["status": "allowed", "resetsAt": 1_900_000_000, "rateLimitType": "five_hour"]
        if let overageStatus { info["overageStatus"] = overageStatus }
        if let isUsingOverage { info["isUsingOverage"] = isUsingOverage }
        if let overageInUse { info["overageInUse"] = overageInUse }
        return json(["type": "rate_limit_event", "rate_limit_info": info, "uuid": "00000000-0000-4000-8000-000000000002",
                     "session_id": "invented-session"])
    }

    static func streamEvent(_ event: [String: Any], parent: String? = nil) -> String {
        json(["type": "stream_event", "event": event, "parent_tool_use_id": parent.map { $0 as Any } ?? NSNull(),
              "uuid": "00000000-0000-4000-8000-000000000003", "session_id": "invented-session"])
    }

    static let messageStart = streamEvent(["type": "message_start", "message": ["id": "msg_invented", "content": []]])

    static func blockStart(_ index: Int, type: String = "text") -> String {
        let block: [String: Any] = type == "text" ? ["type": "text", "text": ""] : ["type": type]
        return streamEvent(["type": "content_block_start", "index": index, "content_block": block])
    }

    static func textDelta(_ text: String, index: Int = 0) -> String {
        streamEvent(["type": "content_block_delta", "index": index, "delta": ["type": "text_delta", "text": text]])
    }

    static func thinkingDelta(_ text: String, index: Int) -> String {
        streamEvent(["type": "content_block_delta", "index": index, "delta": ["type": "thinking_delta", "thinking": text]])
    }

    static func result(subtype: String = "success", isError: Bool = false) -> String {
        json(["type": "result", "subtype": subtype, "is_error": isError, "result": "invented",
              "duration_ms": 1, "duration_api_ms": 1, "num_turns": 1, "session_id": "invented-session",
              "uuid": "00000000-0000-4000-8000-000000000004"])
    }

    /// A complete passing stream for `texts`.
    static func passingStream(_ texts: [String]) -> [String] {
        [initLine(), rateLimit(), messageStart, blockStart(0)] + texts.map { textDelta($0) } + [result()]
    }
}

/// A folder holding the fake CLI (as a symlink named `claude`), its scenario
/// and its records, plus a parent for working folders and a TMPDIR.
struct FakeCLIFolder {
    let root: URL
    let cliPath: String
    let records: URL
    let workParent: URL
    let temporary: URL

    struct Scenario {
        var sigterm = "exit"
        var child: String?
        /// The fake moves itself into its parent's (the supervisor's) group.
        var leaveGroup = false
        var readStdin = true
        var steps: [[String: Any]] = []

        static func lines(_ lines: [String], then end: [String: Any] = ["exit": 0], delayMs: Int = 0) -> Scenario {
            var scenario = Scenario()
            for line in lines {
                scenario.steps.append(["out": line])
                if delayMs > 0 { scenario.steps.append(["sleepMs": delayMs]) }
            }
            scenario.steps.append(end)
            return scenario
        }
    }

    init(_ scenario: Scenario) throws {
        try Products.require()
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("participant-\(UUID().uuidString.prefix(8))", isDirectory: true)
        let fake = root.appendingPathComponent("fake", isDirectory: true)
        workParent = root.appendingPathComponent("work", isDirectory: true)
        temporary = root.appendingPathComponent("tmp", isDirectory: true)
        records = fake.appendingPathComponent("records", isDirectory: true)
        let files = FileManager.default
        for folder in [fake, workParent, temporary] {
            try files.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        cliPath = fake.appendingPathComponent("claude").path
        try files.createSymbolicLink(atPath: cliPath, withDestinationPath: Products.fakeCLI)
        let object: [String: Any] = ["sigterm": scenario.sigterm, "child": scenario.child.map { $0 as Any } ?? NSNull(),
                                     "leaveGroup": scenario.leaveGroup, "readStdin": scenario.readStdin,
                                     "steps": scenario.steps]
        try JSONSerialization.data(withJSONObject: object).write(to: fake.appendingPathComponent("scenario.json"))
    }

    var environment: [String: String] {
        ["HOME": root.appendingPathComponent("home").path, "USER": "invented-user",
         "TMPDIR": temporary.path + "/", "LANG": "en_US.UTF-8",
         // Never passed on: the allow-list drops them.
         "ANTHROPIC_API_KEY": "invented-not-a-key", "ANTHROPIC_BASE_URL": "http://invented.invalid",
         "CLAUDE_CODE_USE_BEDROCK": "1", "INVENTED_APP_VARIABLE": "invented"]
    }

    func pid(_ name: String) -> pid_t? {
        guard let text = try? String(contentsOf: records.appendingPathComponent(name), encoding: .utf8) else { return nil }
        return pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    func waitForPid(_ name: String, seconds: Double = 5) async throws -> pid_t {
        let found = await Processes.waitUntil(seconds: seconds) { pid(name) != nil }
        guard found != nil, let value = pid(name) else { throw ProcessTestError.timeout(name) }
        return value
    }

    func cliRecord() -> [String: Any]? {
        record("cli.json")
    }

    func record(_ name: String) -> [String: Any]? {
        guard let data = try? Data(contentsOf: records.appendingPathComponent(name)) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    func waitForCLIRecord(seconds: Double = 5) async throws -> [String: Any] {
        _ = await Processes.waitUntil(seconds: seconds) { cliRecord() != nil }
        guard let record = cliRecord() else { throw ProcessTestError.timeout("cli.json") }
        return record
    }

    /// Kills whatever the fake left behind, then removes the folder.
    func clean(also pids: [pid_t] = []) {
        for pid in pids + [self.pid("cli.pid"), self.pid("child.pid")].compactMap({ $0 }) {
            Processes.killIfRunning(pid)
        }
        try? FileManager.default.removeItem(at: root)
    }
}

enum Processes {
    /// Group members as `proc_listpids(PROC_PGRP_ONLY)` lists them, zombies
    /// included. A failed probe is recorded and never reads as empty.
    static func members(_ group: pid_t) -> [pid_t] {
        guard let members = ProcessGroupProbe.members(of: group) else {
            Issue.record("the group probe failed for \(group)")
            return [-1]
        }
        return members
    }

    /// True while `pid` exists and is not a zombie.
    static func isRunning(_ pid: pid_t) -> Bool {
        guard pid > 0 else { return false }
        var info = proc_bsdinfo()
        let size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
        guard size == Int32(MemoryLayout<proc_bsdinfo>.size) else { return false }
        return info.pbi_status != UInt32(SZOMB)
    }

    static func groupOf(_ pid: pid_t) -> pid_t? {
        var info = proc_bsdinfo()
        let size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
        guard size == Int32(MemoryLayout<proc_bsdinfo>.size) else { return nil }
        return pid_t(info.pbi_pgid)
    }

    /// The environment another process (same user) was started with, read
    /// from `KERN_PROCARGS2`: what `posix_spawn` passed, before the process
    /// itself added anything. Nil when the probe fails.
    static func initialEnvironment(of pid: pid_t) -> [String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        let argc = buffer.withUnsafeBytes { Int($0.load(as: Int32.self)) }
        var index = MemoryLayout<Int32>.size
        // The executable path, then NUL padding up to argv[0], which is never empty.
        while index < size, buffer[index] != 0 { index += 1 }
        while index < size, buffer[index] == 0 { index += 1 }
        func nextString() -> String? {
            guard index < size else { return nil }
            let start = index
            while index < size, buffer[index] != 0 { index += 1 }
            guard index < size else { return nil }
            defer { index += 1 }
            return String(decoding: buffer[start..<index], as: UTF8.self)
        }
        // Exactly argc arguments, empty ones included (the pinned command line
        // has `--tools ""`); then environment entries up to the first empty one.
        for _ in 0..<argc { guard nextString() != nil else { return nil } }
        var environment: [String] = []
        while let entry = nextString(), !entry.isEmpty { environment.append(entry) }
        return environment
    }

    /// Open descriptors of another process (same user): number and type.
    static func descriptors(of pid: pid_t) -> [(fd: Int32, type: UInt32)] {
        let bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
        guard bytes > 0 else { return [] }
        let count = Int(bytes) / MemoryLayout<proc_fdinfo>.size
        var infos = [proc_fdinfo](repeating: proc_fdinfo(), count: count + 8)
        let filled = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, &infos, Int32(infos.count * MemoryLayout<proc_fdinfo>.size))
        guard filled > 0 else { return [] }
        return infos.prefix(Int(filled) / MemoryLayout<proc_fdinfo>.size).map { ($0.proc_fd, $0.proc_fdtype) }
    }

    /// Polls `condition` every 20 ms; the elapsed seconds once it holds, or nil.
    static func waitUntil(seconds: Double, _ condition: () -> Bool) async -> Double? {
        let start = ContinuousClock.now
        while true {
            if condition() { return elapsed(since: start) }
            if elapsed(since: start) > seconds { return nil }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    static func elapsed(since start: ContinuousClock.Instant) -> Double {
        let elapsed = ContinuousClock.now - start
        return Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
    }

    static func killIfRunning(_ pid: pid_t) {
        guard pid > 1, isRunning(pid) else { return }
        _ = kill(pid, SIGKILL)
    }

    /// A finished child of this process that stays a zombie member of
    /// `group`: SIGKILL cannot remove it, so it simulates a member that
    /// survives SIGKILL until this process reaps it.
    static func spawnZombieMember(of group: pid_t) -> pid_t? {
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawnattr_setpgroup(&attributes, group)
        let words: [String] = ["/usr/bin/true"]
        let argv: [UnsafeMutablePointer<CChar>?] = words.map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) } }
        var pid: pid_t = 0
        guard posix_spawn(&pid, "/usr/bin/true", nil, &attributes, argv, environ) == 0 else { return nil }
        return pid
    }

    static func reap(_ pid: pid_t) {
        var status: Int32 = 0
        while waitpid(pid, &status, 0) == -1, errno == EINTR {}
    }
}

/// Collects a run's updates as they arrive.
final class UpdateCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [ParticipantRunUpdate] = []
    private var finished = false

    init(_ run: ParticipantRun) {
        let updates = run.updates
        Task.detached { [self] in
            for await update in updates { append(update) }
            markFinished()
        }
    }

    private func markFinished() {
        lock.lock(); finished = true; lock.unlock()
    }

    private func append(_ update: ParticipantRunUpdate) {
        lock.lock(); items.append(update); lock.unlock()
    }

    var updates: [ParticipantRunUpdate] {
        lock.lock(); defer { lock.unlock() }
        return items
    }

    var isFinished: Bool {
        lock.lock(); defer { lock.unlock() }
        return finished
    }

    var events: [ParticipantEvent] {
        updates.compactMap { if case .event(let event) = $0 { return event } else { return nil } }
    }

    var terminal: ParticipantEvent? {
        events.first { [.completed, .stopped, .failed].contains($0.type) }
    }

    var released: Bool { updates.contains(.cleanupReleased) }

    @discardableResult
    func wait(seconds: Double, for what: String, _ condition: (UpdateCollector) -> Bool) async throws -> Double {
        guard let elapsed = await Processes.waitUntil(seconds: seconds, { condition(self) }) else {
            throw ProcessTestError.timeout(what)
        }
        return elapsed
    }
}

/// Records log entries for inspection.
final class RecordingLog: ParticipantLogSink, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [ParticipantLogEntry] = []

    func record(_ entry: ParticipantLogEntry) {
        lock.lock(); items.append(entry); lock.unlock()
    }

    var entries: [ParticipantLogEntry] {
        lock.lock(); defer { lock.unlock() }
        return items
    }
}

/// Starts one real run: real supervisor, fake CLI.
struct LiveRun {
    let folder: FakeCLIFolder
    let workingFolder: ParticipantWorkingFolder
    let process: SpawnedParticipant
    let run: ParticipantRun
    let collector: UpdateCollector
    let log: RecordingLog

    static let input = "invented question about invented things"

    /// `rawEnvironment`, when given, is handed to the spawner as the launch's
    /// environment exactly as written, without `ParticipantEnvironment.build`.
    init(_ scenario: FakeCLIFolder.Scenario, supervisorPath: String = Products.supervisor,
         missingCLI: Bool = false, limits: StreamJSONReaderLimits = .contract,
         rawEnvironment: ((FakeCLIFolder) -> [String])? = nil) throws {
        folder = try FakeCLIFolder(scenario)
        workingFolder = try ParticipantWorkingFolder.create(under: folder.workParent)
        var launch = Self.launch(folder: folder, workingFolder: workingFolder,
                                 supervisorPath: supervisorPath, missingCLI: missingCLI)
        if let rawEnvironment { launch.environment = rawEnvironment(folder) }
        process = try ParticipantProcessSpawner().spawn(launch)
        log = RecordingLog()
        run = Self.makeRun(process: process, limits: limits, log: log)
        collector = UpdateCollector(run)
    }

    static func launch(folder: FakeCLIFolder, workingFolder: ParticipantWorkingFolder,
                       supervisorPath: String = Products.supervisor, missingCLI: Bool = false,
                       model: String = Invented.model) -> ParticipantProcessLaunch {
        ParticipantProcessLaunch(
            supervisorPath: supervisorPath,
            cliPath: missingCLI ? folder.root.appendingPathComponent("missing-claude").path : folder.cliPath,
            model: model,
            environment: ParticipantEnvironment.build(from: folder.environment),
            workingFolder: workingFolder,
            input: Data(Self.input.utf8))
    }

    static func makeRun(process: SpawnedParticipant, limits: StreamJSONReaderLimits = .contract,
                        log: ParticipantLogSink) -> ParticipantRun {
        ParticipantRun(
            identity: ParticipantRunIdentity(runId: "51000000-0000-4000-8000-0000000000aa",
                                             sessionId: "invented-session-id", createdAtMillis: 1_700_000_000_000),
            process: process,
            configuration: StreamJSONReader.Configuration(expectedInit: Invented.expectation,
                                                          inputBytes: Self.input.utf8.count,
                                                          preparedBytes: 2_048, limits: limits),
            log: log)
    }

    /// Asserts the group and the supervisor are gone, then removes everything.
    func finish(group: pid_t?, seconds: Double = 10) async {
        if let group {
            let empty = await Processes.waitUntil(seconds: seconds) { Processes.members(group).isEmpty }
            #expect(empty != nil, "group \(group) still has \(Processes.members(group))")
        }
        let gone = await Processes.waitUntil(seconds: seconds) { !Processes.isRunning(process.supervisorProcessID) }
        #expect(gone != nil, "supervisor still running")
        folder.clean(also: [process.supervisorProcessID])
    }
}
