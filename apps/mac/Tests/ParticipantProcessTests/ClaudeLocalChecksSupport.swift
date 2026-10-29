import Darwin
import Foundation
@testable import ParticipantProcess
import Testing

// Support for section 5's local checks tests (plan F3). Everything is
// invented and lives under one temporary folder: an invented home with the
// fake CLI copied to the pinned version file's place (the path comes from
// `ClaudeCheckRoots`, never spelled here), invented managed folders, an
// invented probe parent, the git walk stopping at the temporary folder. The
// checks record every path they touch (as requested), and a test asserts
// none is outside that folder.

/// Every path the checks touched, in order. A test may hold the checks'
/// threads at one path (or at every access a rule picks), as a blocking read
/// on a stalled volume would.
final class CheckAccessRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [ClaudeCheckAccess] = []
    private var rule: (@Sendable (ClaudeCheckAccess) -> Bool)?
    private var held = DispatchSemaphore(value: 0)
    private var arrivals = 0

    func record(_ access: ClaudeCheckAccess) {
        lock.lock()
        items.append(access)
        let hold = rule?(access) ?? false
        if hold { arrivals += 1 }
        let semaphore = held
        lock.unlock()
        // Bounded, so a broken test can never hang the run.
        if hold { _ = semaphore.wait(timeout: .now() + 60) }
    }

    /// Holds every checks thread, before it touches `path`, until `release`.
    func hold(at path: String) {
        hold { $0.path == path }
    }

    /// Holds every checks thread, before an access `rule` picks, until
    /// `release`.
    func hold(where rule: @escaping @Sendable (ClaudeCheckAccess) -> Bool) {
        lock.lock(); defer { lock.unlock() }
        self.rule = rule
        held = DispatchSemaphore(value: 0)
        arrivals = 0
    }

    /// Lets every held thread go on; nothing is held after it.
    func release() {
        lock.lock()
        rule = nil
        let semaphore = held
        let count = arrivals
        lock.unlock()
        for _ in 0..<Swift.max(count, 1) { semaphore.signal() }
    }

    /// A thread is (or was) held since the hold was set.
    var isHolding: Bool {
        heldArrivals > 0
    }

    /// How many threads reached the hold since it was set: each is (or
    /// was) a separate piece of the checks' work.
    var heldArrivals: Int {
        lock.lock(); defer { lock.unlock() }
        return arrivals
    }

    var accesses: [ClaudeCheckAccess] {
        lock.lock(); defer { lock.unlock() }
        return items
    }

    var executed: [String] {
        accesses.compactMap { if case .execute(let path) = $0 { return path } else { return nil } }
    }

    var read: [String] {
        accesses.compactMap { if case .read(let path) = $0 { return path } else { return nil } }
    }
}

final class RecordingCheckLog: ClaudeCheckLogSink, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [ClaudeCheckLogEntry] = []

    func record(_ entry: ClaudeCheckLogEntry) {
        lock.lock(); items.append(entry); lock.unlock()
    }

    var entries: [ClaudeCheckLogEntry] {
        lock.lock(); defer { lock.unlock() }
        return items
    }

    var last: ClaudeCheckLogEntry? { entries.last }
}

/// One invented tree: `home`, `managed`, `preferences`, `work` (the probe
/// parent, 0700) and `tmp` under a fresh temporary folder, its real path.
final class InventedClaudeTree {
    static let userName = "invented-user"

    let root: URL
    let home: URL
    let managed: URL
    let preferences: URL
    let work: URL
    let temporary: URL
    let accesses = CheckAccessRecorder()
    let log = RecordingCheckLog()
    /// Paths a test made unreadable, given back their mode before removal.
    private var locked: [(String, mode_t)] = []

    /// With `scenario`, the fake CLI is installed at the pinned version
    /// file's place with that scenario beside it.
    init(scenario: [String: Any]? = ["authStatus": "subscription"]) throws {
        try Products.require()
        root = URL(fileURLWithPath: realPath(NSTemporaryDirectory()), isDirectory: true)
            .appendingPathComponent("claude-checks-\(UUID().uuidString.prefix(8))", isDirectory: true)
        home = root.appendingPathComponent("home", isDirectory: true)
        managed = root.appendingPathComponent("managed", isDirectory: true)
        preferences = root.appendingPathComponent("preferences", isDirectory: true)
        work = root.appendingPathComponent("work", isDirectory: true)
        temporary = root.appendingPathComponent("tmp", isDirectory: true)
        for folder in [home, work, temporary] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        }
        if let scenario { try install(scenario: scenario) }
    }

    var roots: ClaudeCheckRoots {
        ClaudeCheckRoots(home: home.path, userName: Self.userName, owner: getuid(), managedSettingsFolder: managed.path,
                         managedPreferencesFolder: preferences.path, probeParent: work, gitSearchTop: root.path)
    }

    var binaryPath: String { roots.binaryPath }
    var versions: URL { URL(fileURLWithPath: binaryPath).deletingLastPathComponent() }
    var records: URL { versions.appendingPathComponent("records") }

    /// The fake CLI, copied (a regular file of this user's, mode 0755).
    func install(scenario: [String: Any]) throws {
        try FileManager.default.createDirectory(at: versions, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o755])
        try FileManager.default.copyItem(atPath: Products.fakeCLI, toPath: binaryPath)
        try setScenario(scenario)
    }

    /// The fake's `auth status` reports this tree's config folder unless the
    /// scenario names another.
    func setScenario(_ scenario: [String: Any]) throws {
        var scenario = scenario
        if scenario["configDirectory"] == nil { scenario["configDirectory"] = roots.configFolder }
        try JSONSerialization.data(withJSONObject: scenario).write(to: versions.appendingPathComponent("scenario.json"))
    }

    func path(_ source: ClaudeCheckSource) -> String {
        roots.path(source) ?? "/nonexistent"
    }

    func write(_ text: String, to path: String) throws {
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o755])
        try Data(text.utf8).write(to: url)
    }

    func writeJSON(_ object: Any, to path: String) throws {
        try write(String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self), to: path)
    }

    func writePropertyList(_ object: [String: Any], to path: String) throws {
        let data = try PropertyListSerialization.data(fromPropertyList: object, format: .binary, options: 0)
        try FileManager.default.createDirectory(at: URL(fileURLWithPath: path).deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try data.write(to: URL(fileURLWithPath: path))
    }

    func remove(_ path: String) {
        try? FileManager.default.removeItem(atPath: path)
    }

    /// Sets `mode` on `path`, given back at `clean`.
    func chmod(_ path: String, _ mode: mode_t) {
        var info = stat()
        if lstat(path, &info) == 0 { locked.append((path, info.st_mode & 0o7777)) }
        _ = Darwin.chmod(path, mode)
    }

    /// The app's own environment as the tests invent it: the four passed
    /// names, and names the allow-list must drop.
    var environment: [String: String] {
        ["HOME": home.path, "USER": Self.userName, "TMPDIR": temporary.path + "/", "LANG": "en_US.UTF-8",
         "ANTHROPIC_API_KEY": "invented-not-a-key", "ANTHROPIC_BASE_URL": "http://invented.invalid",
         "CLAUDE_CODE_USE_BEDROCK": "1", "CLAUDE_CONFIG_DIR": "/invented/config", "TRUECONVO_PARTICIPANT_AVAILABLE": "1"]
    }

    /// The checks over this tree. They run `auth status` (the fake's) with
    /// nothing around it, where production blocks its network, unless
    /// `authStatus` says otherwise.
    func checks(limits: ClaudeCheckLimits = .contract, clock: any ParticipantClock = SystemParticipantClock(),
                environment: [String: String]? = nil, roots: ClaudeCheckRoots? = nil,
                authStatus: ClaudeAuthStatusGate = .runForTests) -> ClaudeLocalChecks {
        ClaudeLocalChecks(roots: roots ?? self.roots, limits: limits, clock: clock, log: log,
                          environment: environment ?? self.environment, observer: { [accesses] in accesses.record($0) },
                          authStatus: authStatus)
    }

    func fresh(limits: ClaudeCheckLimits = .contract, environment: [String: String]? = nil,
               roots: ClaudeCheckRoots? = nil) async -> ClaudeLocalCheckResult {
        await checks(limits: limits, environment: environment, roots: roots).evaluateFresh()
    }

    /// How many probes of `name` ("version" or "auth-status") the fake ran.
    func probes(_ name: String) -> Int {
        guard let text = try? String(contentsOf: records.appendingPathComponent("checks.log"), encoding: .utf8) else { return 0 }
        return text.split(separator: "\n").filter { $0 == "\(name).json" }.count
    }

    func record(_ name: String) -> [String: Any]? {
        guard let data = try? Data(contentsOf: records.appendingPathComponent(name)) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    func pid(_ name: String) -> pid_t? {
        guard let text = try? String(contentsOf: records.appendingPathComponent(name), encoding: .utf8) else { return nil }
        return pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// The fake's stderr writers (`checkStderrFlood`), as they recorded
    /// themselves.
    var floodPids: [pid_t] {
        guard let text = try? String(contentsOf: records.appendingPathComponent("flood.pids"), encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { pid_t($0) }
    }

    /// Paths the checks touched outside this tree (none, always).
    var outside: [String] {
        accesses.accesses.map(\.path).filter { !$0.hasPrefix(root.path + "/") }
    }

    func clean() {
        for (path, mode) in locked.reversed() { _ = Darwin.chmod(path, mode) }
        if let child = pid("child.pid") { Processes.killIfRunning(child) }
        for writer in floodPids { Processes.killIfRunning(writer) }
        try? FileManager.default.removeItem(at: root)
    }
}

/// Runs a test-only probe process to its end, at most `seconds`: its exit
/// status and stdout, or nil (it was killed) if it did not end in time.
func runBounded(_ process: Process, seconds: Double = 60) throws -> (status: Int32, output: String)? {
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    let ended = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in ended.signal() }
    try process.run()
    let box = ResultBox<Data>()
    let reader = Thread { box.set(output.fileHandleForReading.readDataToEndOfFile()) }
    reader.start()
    guard ended.wait(timeout: .now() + seconds) == .success else {
        kill(process.processIdentifier, SIGKILL)
        return nil
    }
    let deadline = Date().addingTimeInterval(10)
    while box.value == nil, Date() < deadline { usleep(10_000) }
    return (process.terminationStatus, String(decoding: box.value ?? Data(), as: UTF8.self))
}

/// An available report, counting `report()` and `recheck()` calls.
final class CountingReporter: AvailabilityReporting, @unchecked Sendable {
    private let lock = NSLock()
    private var reportCalls = 0
    private var recheckCalls = 0
    private let answer = ParticipantAvailabilityReport(availability: .available, confirmation: nil)

    func report() async -> ParticipantAvailabilityReport {
        count(recheck: false)
        return answer
    }

    func recheck() async -> ParticipantAvailabilityReport {
        count(recheck: true)
        return answer
    }

    private func count(recheck: Bool) {
        lock.lock(); defer { lock.unlock() }
        if recheck { recheckCalls += 1 } else { reportCalls += 1 }
    }

    var counts: (reports: Int, rechecks: Int) {
        lock.lock(); defer { lock.unlock() }
        return (reportCalls, recheckCalls)
    }
}

/// A checker counting `check()` and `recheck()` calls.
final class CountingChecker: AvailabilityChecking, @unchecked Sendable {
    private let lock = NSLock()
    private var checkCalls = 0
    private var recheckCalls = 0

    func check() async -> ParticipantAvailability {
        count(recheck: false)
        return .unavailable(.signedOut)
    }

    func recheck() async -> ParticipantAvailability {
        count(recheck: true)
        return .unavailable(.notSubscription)
    }

    private func count(recheck: Bool) {
        lock.lock(); defer { lock.unlock() }
        if recheck { recheckCalls += 1 } else { checkCalls += 1 }
    }

    var counts: (checks: Int, rechecks: Int) {
        lock.lock(); defer { lock.unlock() }
        return (checkCalls, recheckCalls)
    }
}

extension ClaudeProbeResult {
    static func exited(_ code: Int32, _ text: String) -> ClaudeProbeResult {
        ClaudeProbeResult(ending: .exited(code << 8), stdout: Data(text.utf8))
    }
}

/// A listening socket the test itself opens, for the fake's `auth status`
/// to try (`networkPort`, `networkSocket`): TCP on 127.0.0.1 with a port the
/// system picks, or a local socket under `/tmp` (a socket path is at most
/// 104 bytes, too short for the temporary folder). Nothing is ever accepted.
final class InventedListener {
    let socket: Int32
    let port: Int
    let path: String

    private init(socket: Int32, port: Int, path: String) {
        self.socket = socket
        self.port = port
        self.path = path
    }

    struct Failed: Error {
        let step: String
        let code: Int32
    }

    static func tcp() throws -> InventedListener {
        let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socket >= 0 else { throw Failed(step: "socket", code: errno) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(socket, $0, length) == 0 && getsockname(socket, $0, &length) == 0 }
        }
        guard bound, listen(socket, 4) == 0 else { let code = errno; Darwin.close(socket); throw Failed(step: "bind", code: code) }
        return InventedListener(socket: socket, port: Int(UInt16(bigEndian: address.sin_port)), path: "")
    }

    static func local() throws -> InventedListener {
        let path = "/tmp/oc-\(UUID().uuidString.prefix(8)).sock"
        let socket = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard socket >= 0 else { throw Failed(step: "socket", code: errno) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        _ = withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            path.utf8CString.withUnsafeBytes { buffer.copyMemory(from: UnsafeRawBufferPointer(rebasing: $0.prefix(buffer.count - 1))) }
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(socket, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0 }
        }
        guard bound, listen(socket, 4) == 0 else { let code = errno; Darwin.close(socket); throw Failed(step: "bind", code: code) }
        return InventedListener(socket: socket, port: 0, path: path)
    }

    /// Whether a connection is waiting, without accepting it.
    var hasConnection: Bool {
        var waiting = pollfd(fd: socket, events: Int16(POLLIN), revents: 0)
        return poll(&waiting, 1, 0) == 1 && waiting.revents & Int16(POLLIN) != 0
    }

    func close() {
        Darwin.close(socket)
        if !path.isEmpty { unlink(path) }
    }
}

extension ClaudeLocalCheckResult {
    /// Whatever the snapshot, whether the checks passed.
    var didPass: Bool {
        if case .passed = self { return true }
        return false
    }
}
