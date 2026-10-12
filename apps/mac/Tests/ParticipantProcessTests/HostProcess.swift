import Darwin
import Foundation
import Testing

/// The test host (`ParticipantTestHost`) as a child of this test process,
/// with its stdin and stdout on pipes, so a test can drive it and SIGKILL it.
final class HostProcess {
    let pid: pid_t
    private let input: Int32
    private let output: Int32
    private var pending: [UInt8] = []
    private(set) var lines: [String] = []
    private var reaped = false

    /// The host makes the run's working folder under `folder.workParent`.
    init(supervisor: String, folder: FakeCLIFolder) throws {
        var toHost: [Int32] = [-1, -1]
        var fromHost: [Int32] = [-1, -1]
        guard pipe(&toHost) == 0, pipe(&fromHost) == 0 else { throw ProcessTestError.timeout("pipes") }
        for descriptor in toHost + fromHost { _ = fcntl(descriptor, F_SETFD, FD_CLOEXEC) }
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT))
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_adddup2(&actions, toHost[0], 0)
        posix_spawn_file_actions_adddup2(&actions, fromHost[1], 1)
        posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)
        let words: [String] = [Products.testHost, "--supervisor", supervisor, "--cli", folder.cliPath,
                               "--workparent", folder.workParent.path, "--model", Invented.model,
                               "--input", "invented host input"]
        let argv: [UnsafeMutablePointer<CChar>?] = words.map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = folder.environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
        }
        var child: pid_t = 0
        let result = posix_spawn(&child, Products.testHost, &actions, &attributes, argv, envp)
        _ = close(toHost[0])
        _ = close(fromHost[1])
        guard result == 0 else {
            _ = close(toHost[1])
            _ = close(fromHost[0])
            throw ProcessTestError.missingProduct(Products.testHost)
        }
        pid = child
        input = toHost[1]
        output = fromHost[0]
        _ = fcntl(output, F_SETFL, fcntl(output, F_GETFL) | O_NONBLOCK)
        _ = fcntl(input, F_SETNOSIGPIPE, 1)
    }

    deinit {
        kill9()
        _ = close(input)
        _ = close(output)
    }

    func send(_ command: String) {
        let bytes = Array((command + "\n").utf8)
        _ = bytes.withUnsafeBytes { write(input, $0.baseAddress!, bytes.count) }
    }

    /// Reads what the host printed so far into `lines`.
    private func drain() {
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = read(output, &buffer, buffer.count)
            guard count > 0 else { break }
            pending += buffer[0..<count]
        }
        while let newline = pending.firstIndex(of: 0x0A) {
            lines.append(String(decoding: pending[..<newline], as: UTF8.self))
            pending.removeSubrange(...newline)
        }
    }

    /// Waits for a line starting with `prefix` and returns the rest of it.
    @discardableResult
    func waitFor(_ prefix: String, seconds: Double = 10) async throws -> String {
        var found: String?
        _ = await Processes.waitUntil(seconds: seconds) {
            drain()
            found = lines.first { $0.hasPrefix(prefix) }
            return found != nil
        }
        guard let found else { throw ProcessTestError.timeout("host line \(prefix) after \(lines)") }
        return String(found.dropFirst(prefix.count))
    }

    func hasLine(_ line: String) -> Bool {
        drain()
        return lines.contains(line)
    }

    /// SIGKILL, the way `kill -9` or a crash ends the app: no handler runs.
    func kill9() {
        guard !reaped else { return }
        _ = kill(pid, SIGKILL)
        Processes.reap(pid)
        reaped = true
    }
}
