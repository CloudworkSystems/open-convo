import Darwin
import Foundation
import ParticipantSupervisorCore

// One availability probe (`--version` or `auth status --json`) of the pinned
// file (contract section 5; Codex F0 answer 10). It is spawned directly
// (step 4 in production through `ClaudeNetworkBlock`'s tool, which then runs
// the pinned file in the same process), never through the supervisor (it carries no conversation text): section
// 11's environment rule, a fresh empty app-owned 0700 working folder, stdin
// a pipe already closed (EOF), stdout capped, stderr drained and dropped,
// its own process group. Once the leader exits the group is killed (the
// unreaped leader keeps its id reserved), so nothing it left in its group
// outlives the probe; at the deadline the group is killed too.

struct ClaudeProbeResult: Equatable, Sendable {
    enum Ending: Equatable, Sendable {
        /// The leader's wait status.
        case exited(Int32)
        case timedOut
        case outputTooLarge
        /// A stdout read failed before EOF (not EOF: the output is unknown).
        case readFailed
        case spawnFailed
        case folderFailed
    }

    let ending: Ending
    let stdout: Data
}

/// The owner's D1 decision (October 29, 2026, option 1): `auth status` runs
/// under macOS's sandbox with every network operation denied, so a
/// server-managed settings fetch it starts cannot reach Anthropic (Codex
/// F34-D1). Everything else is allowed, so the CLI still reads its own
/// login. The block applies to the probe and to anything it starts, and is
/// applied by the system's `sandbox-exec`, which Apple marks deprecated: it
/// is retested on each macOS version (the tests here run on the Mac CI
/// runner). Only that tool is used: a root-owned regular file that only
/// root can change, on the system volume. Anything else and the probe never
/// runs (`network-block`).
package struct ClaudeNetworkBlock: Sendable, Equatable {
    /// The profile: allow everything, then deny every network operation
    /// (outbound, inbound and bind, IP and local sockets alike).
    static let profile = "(version 1)(allow default)(deny network*)"

    let toolPath: String

    package static let system = ClaudeNetworkBlock(toolPath: "/usr/bin/sandbox-exec")

    /// Tests only: a tool at another path, to show what is refused.
    init(toolPath: String) {
        self.toolPath = toolPath
    }

    /// Nil when the tool may be used: not a link, a regular file owned by
    /// root, executable, with no group or other write and no setuid or
    /// setgid bit, in a root-owned folder (not a link) no one else can write.
    func refusal(observer: ClaudeCheckObserver?) -> ClaudeCheckDetail? {
        guard toolPath.hasPrefix("/"), !toolPath.utf8.contains(0) else { return .networkBlock }
        observer?(.inspect(toolPath))
        // The pinned file's own rules (`ClaudePinnedBinary`), with root as
        // the owner.
        let folder = (toolPath as NSString).deletingLastPathComponent
        var info = stat()
        guard lstat(folder, &info) == 0, ClaudePinnedBinary.folderRefusal(info, owner: 0) == nil,
              lstat(toolPath, &info) == 0, ClaudePinnedBinary.fileRefusal(info, owner: 0) == nil else { return .networkBlock }
        return nil
    }

    /// The argument list that runs `binary` with `arguments` under the block.
    func arguments(running binary: String, _ arguments: [String]) -> [String] {
        [toolPath, "-p", Self.profile, binary] + arguments
    }
}

struct ClaudeProbeRunner: Sendable {
    let binaryPath: String
    /// Nil: the pinned file is spawned directly. Otherwise the network
    /// block's tool is spawned, and it runs the pinned file (step 4 only).
    var networkBlock: ClaudeNetworkBlock? = nil
    let workParent: URL
    /// `NAME=value` entries, as `ParticipantEnvironment.build` made them.
    let environment: [String]
    let outputBytes: Int
    let observer: ClaudeCheckObserver?
    /// How stderr is read to drain it: `read(2)`. Tests only give a reader
    /// that never runs dry, to show each drain turn is bounded (Codex F34-R2).
    var readStderr: @Sendable (Int32, UnsafeMutableRawPointer, Int) -> Int = { Darwin.read($0, $1, $2) }
    /// How each of the three pipes is made: `DescriptorPipe.make`. Tests only
    /// give pipes whose other halves they keep, to see from those that a
    /// probe ending before its spawn closes all six descriptors (Codex F34-R1).
    var makePipe: @Sendable () throws -> DescriptorPipe = { try DescriptorPipe.make() }

    /// Runs the pinned file with `arguments` until it ends or `deadline`
    /// (monotonic milliseconds) passes. Nothing is spawned once the deadline
    /// has passed or `abandoned` is true (the watchdog has given up on the
    /// check), however long the preparation took (Codex F34-R1). That last
    /// look and the spawn are not one step (holding them together would make
    /// the watchdog wait through `posix_spawn`, which can block): a check
    /// given up on in the instant between them still starts its probe, and
    /// the collector's first turn, which looks again, kills it and its group.
    func run(_ arguments: [String], until deadline: UInt64, abandoned: () -> Bool = { false }) -> ClaudeProbeResult {
        func ended(_ ending: ClaudeProbeResult.Ending) -> ClaudeProbeResult {
            ClaudeProbeResult(ending: ending, stdout: Data())
        }
        guard binaryPath.hasPrefix("/"),
              !([binaryPath, networkBlock?.toolPath ?? ""] + arguments + environment).contains(where: { $0.utf8.contains(0) }) else {
            return ended(.spawnFailed)
        }
        let folder: ParticipantWorkingFolder
        do {
            folder = try ParticipantWorkingFolder.create(under: workParent)
        } catch {
            return ended(.folderFailed)
        }
        // Removed once the probe has ended; a probe answers nothing from it.
        defer { _ = folder.remove() }
        observer?(.inspect(folder.path))
        let folderDescriptor = open(folder.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard folderDescriptor >= 0 else { return ended(.folderFailed) }
        defer { _ = close(folderDescriptor) }
        guard WorkingFolderRule.isPrivateEmptyDirectory(folderDescriptor) else { return ended(.folderFailed) }

        var opened: [Int32] = []
        func closeAll() { opened.forEach { _ = close($0) } }
        let input: DescriptorPipe, output: DescriptorPipe, errors: DescriptorPipe
        do {
            input = try makePipe(); opened += [input.read, input.write]
            output = try makePipe(); opened += [output.read, output.write]
            errors = try makePipe(); opened += [errors.read, errors.write]
        } catch {
            closeAll()
            return ended(.spawnFailed)
        }
        // The folder work above can block (a stalled volume) past the
        // deadline, after the caller already has its answer: then nothing
        // is started (Codex F34-R1). The descriptors are closed here, and the
        // folder removed by the `defer` above.
        guard ClaudeCheckRun.nowMillis() < deadline, !abandoned() else {
            closeAll()
            return ended(.timedOut)
        }
        let executable = networkBlock?.toolPath ?? binaryPath
        let argv = networkBlock?.arguments(running: binaryPath, arguments) ?? [binaryPath] + arguments
        if networkBlock != nil { observer?(.execute(executable)) }
        observer?(.execute(binaryPath))
        let pid = spawn(executable, arguments: argv, folder: folderDescriptor,
                        stdin: input.read, stdout: output.write, stderr: errors.write)
        // The child holds its ends now. Closing the write end of stdin here
        // is what gives it EOF at once.
        for descriptor in [input.read, input.write, output.write, errors.write] { _ = close(descriptor) }
        guard let pid else {
            _ = close(output.read)
            _ = close(errors.read)
            return ended(.spawnFailed)
        }
        return collect(pid: pid, stdout: output.read, stderr: errors.read, deadline: deadline, abandoned: abandoned)
    }

    private func spawn(_ executable: String, arguments: [String], folder: Int32, stdin: Int32, stdout: Int32,
                       stderr: Int32) -> pid_t? {
        var attributes: posix_spawnattr_t?
        guard posix_spawnattr_init(&attributes) == 0 else { return nil }
        defer { posix_spawnattr_destroy(&attributes) }
        var actions: posix_spawn_file_actions_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { return nil }
        defer { posix_spawn_file_actions_destroy(&actions) }

        let flags = POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK
        var defaults = sigset_t()
        for signalNumber in 1..<Int32(NSIG) where signalNumber != SIGKILL && signalNumber != SIGSTOP {
            defaults |= sigset_t(1) << sigset_t(signalNumber - 1)
        }
        var mask = sigset_t()
        guard posix_spawnattr_setflags(&attributes, Int16(flags)) == 0,
              posix_spawnattr_setpgroup(&attributes, 0) == 0,
              posix_spawnattr_setsigdefault(&attributes, &defaults) == 0,
              posix_spawnattr_setsigmask(&attributes, &mask) == 0,
              posix_spawn_file_actions_addfchdir_np(&actions, folder) == 0,
              posix_spawn_file_actions_adddup2(&actions, stdin, 0) == 0,
              posix_spawn_file_actions_adddup2(&actions, stdout, 1) == 0,
              posix_spawn_file_actions_adddup2(&actions, stderr, 2) == 0 else { return nil }

        let argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = environment.map { strdup($0) } + [nil]
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
        }
        var pid: pid_t = 0
        guard posix_spawn(&pid, executable, &actions, &attributes, argv, envp) == 0, pid > 0 else { return nil }
        return pid
    }

    /// Reads per descriptor in one turn of the loop below, at most: writers
    /// that keep a pipe full cannot hold the loop away from the deadline and
    /// the leader's exit (Codex F34-R2). 4 x 16 KiB per turn.
    static let readsPerTurn = 4

    /// Reads stdout (capped) and drains stderr until the leader has exited
    /// and both pipes are at EOF, or the deadline, or the check is given up
    /// on (looked at every turn, the first included). Each turn reads each
    /// descriptor a bounded number of times and checks the deadline before
    /// every read. The group is killed once the leader exits (its id stays
    /// reserved until the reap below) and at the deadline; the leader is
    /// always reaped.
    private func collect(pid: pid_t, stdout: Int32, stderr: Int32, deadline: UInt64,
                         abandoned: () -> Bool) -> ClaudeProbeResult {
        defer {
            _ = close(stdout)
            _ = close(stderr)
        }
        for descriptor in [stdout, stderr] {
            _ = fcntl(descriptor, F_SETFL, fcntl(descriptor, F_GETFL) | O_NONBLOCK)
        }
        func stop(_ ending: ClaudeProbeResult.Ending) -> ClaudeProbeResult {
            _ = killpg(pid, SIGKILL)
            Self.reap(pid)
            return ClaudeProbeResult(ending: ending, stdout: Data())
        }
        var output = Data()
        var stdoutOpen = true
        var stderrOpen = true
        var exited = false
        var buffer = [UInt8](repeating: 0, count: 16_384)
        while true {
            if !exited, Self.hasExited(pid) {
                exited = true
                // Anything the probe left in its group goes with it.
                _ = killpg(pid, SIGKILL)
            }
            if exited, !stdoutOpen, !stderrOpen { break }
            let now = ClaudeCheckRun.nowMillis()
            guard now < deadline, !abandoned() else { return stop(.timedOut) }
            let wait = Int32(Swift.min(deadline - now, 20))
            var watched: [pollfd] = []
            if stdoutOpen { watched.append(pollfd(fd: stdout, events: Int16(POLLIN), revents: 0)) }
            if stderrOpen { watched.append(pollfd(fd: stderr, events: Int16(POLLIN), revents: 0)) }
            if watched.isEmpty {
                usleep(useconds_t(wait) * 1_000)
                continue
            }
            let ready = poll(&watched, nfds_t(watched.count), wait)
            if ready <= 0 { continue }
            for entry in watched where entry.revents != 0 {
                let isStdout = entry.fd == stdout
                reading: for _ in 0..<Self.readsPerTurn {
                    guard ClaudeCheckRun.nowMillis() < deadline else { return stop(.timedOut) }
                    let count = isStdout ? read(entry.fd, &buffer, buffer.count)
                        : buffer.withUnsafeMutableBytes { readStderr(entry.fd, $0.baseAddress!, $0.count) }
                    if count > 0 {
                        guard isStdout else { continue }   // stderr is drained and dropped
                        output.append(contentsOf: buffer[0..<count])
                        if output.count > outputBytes { return stop(.outputTooLarge) }
                        continue
                    }
                    if count < 0, errno == EINTR { continue }
                    if count < 0, errno == EAGAIN { break reading }
                    if count < 0, isStdout { return stop(.readFailed) }
                    // EOF (or a failed stderr read, which only stops the draining).
                    if isStdout { stdoutOpen = false } else { stderrOpen = false }
                    break reading
                }
            }
        }
        let status = Self.reap(pid)
        return ClaudeProbeResult(ending: .exited(status), stdout: output)
    }

    /// True once the leader has exited, without reaping it.
    private static func hasExited(_ pid: pid_t) -> Bool {
        var info = siginfo_t()
        return waitid(P_PID, id_t(pid), &info, WEXITED | WNOHANG | WNOWAIT) == 0 && info.si_pid == pid
    }

    @discardableResult
    private static func reap(_ pid: pid_t) -> Int32 {
        var status: Int32 = 0
        while waitpid(pid, &status, 0) == -1, errno == EINTR {}
        return status
    }
}
