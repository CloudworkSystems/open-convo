import Darwin
import Foundation
import ParticipantSupervisorCore

/// One run's process, before it starts. The command line is not free-form:
/// the spawner builds the pinned one (`ParticipantCommandLine`) around
/// `model`, and the folder is one `ParticipantWorkingFolder.create` made.
public struct ParticipantProcessLaunch: Sendable {
    /// The bundled supervisor (`ParticipantSupervisorLocation`).
    public var supervisorPath: String
    /// The CLI binary. Always injected; nothing here resolves it.
    public var cliPath: String
    /// The build's pinned model, the only variable part of the command line.
    public var model: String
    /// `NAME=value` entries (`ParticipantEnvironment.build`).
    public var environment: [String]
    /// The run's empty 0700 folder.
    public var workingFolder: ParticipantWorkingFolder
    /// Written to the CLI's stdin, which is then closed.
    public var input: Data

    public init(supervisorPath: String, cliPath: String, model: String,
                environment: [String], workingFolder: ParticipantWorkingFolder, input: Data) {
        self.supervisorPath = supervisorPath
        self.cliPath = cliPath
        self.model = model
        self.environment = environment
        self.workingFolder = workingFolder
        self.input = input
    }

    /// Exactly what the supervisor is asked to run after the binary path.
    public var arguments: [String] { ParticipantCommandLine.arguments(model: model) }
}

/// How much output is kept in memory. Bytes past a bound are read and
/// dropped, so a runaway CLI can neither grow memory nor block on a full pipe.
public struct ParticipantProcessLimits: Equatable, Sendable {
    public var stdoutBytes = 32 * 1_048_576
    public var stderrBytes = 65_536
    public var readChunk = 65_536

    public init() {}
}

/// What the spawned process reports, in arrival order per source. Sources
/// are independent: a control message can overtake stdout bytes written
/// earlier, which is why the reader waits for stdout EOF before trusting an
/// exit.
public enum ParticipantProcessEvent: Equatable, Sendable {
    case control(SupervisorMessage)
    /// The control socket reached EOF: the supervisor exited or was lost.
    case controlClosed
    case stdout(Data)
    /// Bytes past `ParticipantProcessLimits.stdoutBytes` are being dropped.
    case stdoutLimitReached
    case stdoutClosed(totalBytes: Int)
    /// At most `ParticipantProcessLimits.stderrBytes` in total.
    case stderr(Data)
    case stderrClosed(totalBytes: Int)
    case stdinClosed(writtenBytes: Int, complete: Bool)
    /// The supervisor's own wait status, after the app reaped it.
    case supervisorExited(status: Int32)
}

public enum ParticipantSpawnError: Error, Equatable {
    case invalidLaunch
    /// The working folder is no longer an empty folder of this user's with
    /// mode 0700 at its path (renamed, replaced, linked or written to).
    case workingFolderNotPrivate
    case descriptors(Int32)
    case spawn(Int32)
}

/// Starts a run's supervisor, which starts the CLI (contract section 11).
///
/// The app makes the CLI's three pipes, a lifeline pipe and a control
/// socketpair, and spawns the supervisor in its own process group with
/// `POSIX_SPAWN_CLOEXEC_DEFAULT` and exactly five descriptors: the CLI's
/// stdin read end, stdout and stderr write ends, the lifeline's read end and
/// the control socket. It keeps the lifeline's write end, close-on-exec, so
/// it closes when the app process ends, and closes its copies of the CLI's
/// pipe ends once the supervisor is spawned, so EOF on its read ends means no
/// process holds a write end.
public struct ParticipantProcessSpawner: Sendable {
    public var limits: ParticipantProcessLimits

    public init(limits: ParticipantProcessLimits = ParticipantProcessLimits()) {
        self.limits = limits
    }

    public func spawn(_ launch: ParticipantProcessLaunch) throws -> SpawnedParticipant {
        let arguments = launch.arguments
        guard launch.supervisorPath.hasPrefix("/"), launch.cliPath.hasPrefix("/"),
              CLICommandLineRule.isPinned(arguments),
              !([launch.supervisorPath, launch.cliPath, launch.workingFolder.path] + arguments + launch.environment)
                .contains(where: { $0.utf8.contains(0) }) else {
            throw ParticipantSpawnError.invalidLaunch
        }

        // The folder is checked on the descriptor the supervisor will start
        // in, not by path, so nothing put at the path after the check counts.
        let folder = open(launch.workingFolder.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard folder >= 0 else { throw ParticipantSpawnError.workingFolderNotPrivate }
        defer { _ = close(folder) }
        guard WorkingFolderRule.isPrivateEmptyDirectory(folder) else {
            throw ParticipantSpawnError.workingFolderNotPrivate
        }

        var opened: [Int32] = []
        func closeAll() { opened.forEach { _ = close($0) } }
        let cliStdin: DescriptorPipe, cliStdout: DescriptorPipe, cliStderr: DescriptorPipe, lifeline: DescriptorPipe
        let control: (app: Int32, supervisor: Int32)
        do {
            cliStdin = try DescriptorPipe.make(); opened += [cliStdin.read, cliStdin.write]
            cliStdout = try DescriptorPipe.make(); opened += [cliStdout.read, cliStdout.write]
            cliStderr = try DescriptorPipe.make(); opened += [cliStderr.read, cliStderr.write]
            lifeline = try DescriptorPipe.make(); opened += [lifeline.read, lifeline.write]
            control = try makeControlPair(); opened += [control.app, control.supervisor]
        } catch {
            closeAll()
            throw error
        }

        var on: Int32 = 1
        _ = setsockopt(control.app, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        let flags = fcntl(control.app, F_GETFL)
        _ = fcntl(control.app, F_SETFL, flags | O_NONBLOCK)

        let childEnds: [(source: Int32, target: Int32)] = [
            (cliStdin.read, SupervisorDescriptor.cliStdin),
            (cliStdout.write, SupervisorDescriptor.cliStdout),
            (cliStderr.write, SupervisorDescriptor.cliStderr),
            (lifeline.read, SupervisorDescriptor.lifeline),
            (control.supervisor, SupervisorDescriptor.control)
        ]
        let supervisorArguments = [launch.supervisorPath, String(getpid()), launch.cliPath] + arguments
        let pid: pid_t
        do {
            // The allow-list applies here, at the supervisor's own spawn, and
            // not only when the supervisor later spawns the CLI: a loader or
            // runtime variable in `launch.environment` would otherwise reach
            // the supervisor process itself (Codex review of ec294dc, P2).
            pid = try spawnSupervisor(path: launch.supervisorPath, arguments: supervisorArguments,
                                      environment: CLIEnvironmentRule.apply(to: launch.environment),
                                      workingFolder: folder, descriptors: childEnds)
        } catch {
            closeAll()
            throw error
        }
        // The supervisor holds the child ends now; the app keeps only its own.
        for end in childEnds { _ = close(end.source) }

        return SpawnedParticipant(
            supervisorProcessID: pid,
            stdinWrite: cliStdin.write, stdoutRead: cliStdout.read, stderrRead: cliStderr.read,
            lifelineWrite: lifeline.write, control: control.app,
            input: launch.input, limits: limits)
    }

    private func spawnSupervisor(path: String, arguments: [String], environment: [String],
                                 workingFolder: Int32,
                                 descriptors: [(source: Int32, target: Int32)]) throws -> pid_t {
        var attributes: posix_spawnattr_t?
        guard posix_spawnattr_init(&attributes) == 0 else { throw ParticipantSpawnError.spawn(errno) }
        defer { posix_spawnattr_destroy(&attributes) }
        var actions: posix_spawn_file_actions_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw ParticipantSpawnError.spawn(errno) }
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
              posix_spawnattr_setsigmask(&attributes, &mask) == 0 else {
            throw ParticipantSpawnError.spawn(EINVAL)
        }
        // Into the checked folder first, before any dup2 below could reuse its
        // number. Every source is at 5 or above (`DescriptorPipe.make`), so no
        // dup2 overwrites a source a later one still needs.
        guard posix_spawn_file_actions_addfchdir_np(&actions, workingFolder) == 0 else {
            throw ParticipantSpawnError.spawn(EINVAL)
        }
        for end in descriptors {
            guard posix_spawn_file_actions_adddup2(&actions, end.source, end.target) == 0 else {
                throw ParticipantSpawnError.spawn(EINVAL)
            }
        }

        let argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = environment.map { strdup($0) } + [nil]
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
        }
        var pid: pid_t = 0
        let result = posix_spawn(&pid, path, &actions, &attributes, argv, envp)
        guard result == 0, pid > 0 else { throw ParticipantSpawnError.spawn(result) }
        return pid
    }

    private func makeControlPair() throws -> (app: Int32, supervisor: Int32) {
        var pair: [Int32] = [-1, -1]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else { throw ParticipantSpawnError.descriptors(errno) }
        // `lift` closes its own descriptor when it fails.
        let app: Int32
        do {
            app = try DescriptorPipe.lift(pair[0])
        } catch {
            _ = close(pair[1])
            throw error
        }
        do {
            return (app, try DescriptorPipe.lift(pair[1]))
        } catch {
            _ = close(app)
            throw error
        }
    }
}

/// A pipe whose ends are close-on-exec and numbered 5 or above, clear of the
/// five targets the supervisor's descriptors are moved to.
struct DescriptorPipe {
    static let lowestDescriptor: Int32 = 5

    let read: Int32
    let write: Int32

    static func make() throws -> DescriptorPipe {
        var ends: [Int32] = [-1, -1]
        guard Darwin.pipe(&ends) == 0 else { throw ParticipantSpawnError.descriptors(errno) }
        let readEnd: Int32
        do {
            readEnd = try lift(ends[0])
        } catch {
            _ = close(ends[1])
            throw error
        }
        do {
            return DescriptorPipe(read: readEnd, write: try lift(ends[1]))
        } catch {
            _ = close(readEnd)
            throw error
        }
    }

    /// Marks `descriptor` close-on-exec, first moving it to 5 or above.
    static func lift(_ descriptor: Int32) throws -> Int32 {
        if descriptor >= lowestDescriptor {
            guard fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0 else {
                let error = errno
                _ = close(descriptor)
                throw ParticipantSpawnError.descriptors(error)
            }
            return descriptor
        }
        let moved = fcntl(descriptor, F_DUPFD_CLOEXEC, lowestDescriptor)
        let error = errno
        _ = close(descriptor)
        guard moved >= 0 else { throw ParticipantSpawnError.descriptors(error) }
        return moved
    }
}

/// A descriptor several threads may use and one closes, so a closed number
/// that the system hands out again is never written to.
final class GuardedDescriptor: @unchecked Sendable {
    private let lock = NSLock()
    private var descriptor: Int32

    init(_ descriptor: Int32) {
        self.descriptor = descriptor
    }

    /// Runs `body` with the open descriptor, or returns nil once closed.
    func with<T>(_ body: (Int32) -> T) -> T? {
        lock.lock()
        defer { lock.unlock() }
        guard descriptor >= 0 else { return nil }
        return body(descriptor)
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        guard descriptor >= 0 else { return }
        _ = Darwin.close(descriptor)
        descriptor = -1
    }
}

/// A running supervisor and the app's ends of its descriptors.
public final class SpawnedParticipant: @unchecked Sendable {
    /// Kept in memory only, for the app's own bookkeeping and tests.
    public let supervisorProcessID: pid_t
    /// Every report from the process. Finishes once stdout, stderr, stdin,
    /// control and the supervisor's exit have all ended.
    public let events: AsyncStream<ParticipantProcessEvent>

    private let control: GuardedDescriptor
    private let lifeline: GuardedDescriptor
    private let continuation: AsyncStream<ParticipantProcessEvent>.Continuation
    private let remainingSources = SourceCounter(count: 5)

    init(supervisorProcessID: pid_t, stdinWrite: Int32, stdoutRead: Int32, stderrRead: Int32,
         lifelineWrite: Int32, control controlDescriptor: Int32, input: Data, limits: ParticipantProcessLimits) {
        self.supervisorProcessID = supervisorProcessID
        self.control = GuardedDescriptor(controlDescriptor)
        self.lifeline = GuardedDescriptor(lifelineWrite)
        var continuation: AsyncStream<ParticipantProcessEvent>.Continuation!
        self.events = AsyncStream(bufferingPolicy: .unbounded) { continuation = $0 }
        self.continuation = continuation

        let yield: @Sendable (ParticipantProcessEvent) -> Void = { [continuation] event in
            continuation!.yield(event)
        }
        let done: @Sendable () -> Void = { [remainingSources, continuation] in
            if remainingSources.finishOne() { continuation!.finish() }
        }

        Self.startReader(name: "participant-stdout", descriptor: stdoutRead, keep: limits.stdoutBytes,
                         chunk: limits.readChunk, yield: yield, done: done,
                         data: { .stdout($0) }, limit: .stdoutLimitReached, closed: { .stdoutClosed(totalBytes: $0) })
        Self.startReader(name: "participant-stderr", descriptor: stderrRead, keep: limits.stderrBytes,
                         chunk: limits.readChunk, yield: yield, done: done,
                         data: { .stderr($0) }, limit: nil, closed: { .stderrClosed(totalBytes: $0) })
        Self.startControlReader(control: control, yield: yield, done: done)
        Self.startStdinWriter(descriptor: stdinWrite, input: input, yield: yield, done: done)
        Self.startReaper(pid: supervisorProcessID, lifeline: lifeline, yield: yield, done: done)
    }

    /// Writes `stop` to the supervisor. Memory only: no store access, no
    /// waiting. False once the supervisor's socket is gone.
    @discardableResult
    public func sendStop() -> Bool {
        let bytes = SupervisorCommand.stop.wireBytes
        return control.with { descriptor -> Bool in
            var written = 0
            while written < bytes.count {
                let result = bytes.withUnsafeBytes { buffer in
                    write(descriptor, buffer.baseAddress! + written, buffer.count - written)
                }
                if result > 0 {
                    written += result
                } else if result < 0, errno == EINTR {
                    continue
                } else {
                    return false
                }
            }
            return true
        } ?? false
    }

    /// Test seam: closes the lifeline's write end while the app lives.
    @_spi(ParticipantTesting)
    public func closeLifelineForTesting() {
        lifeline.close()
    }

    /// Test seam: runs `body` with the lifeline's write end (to leak it to
    /// another process), or returns nil once it is closed.
    @_spi(ParticipantTesting)
    public func withLifelineDescriptorForTesting<T>(_ body: (Int32) -> T) -> T? {
        lifeline.with(body)
    }

    /// Test seam: runs `body` with the app's end of the control socket (to
    /// leak it with the lifeline, so only `NOTE_EXIT` can report the app's
    /// death), or returns nil once it is closed.
    @_spi(ParticipantTesting)
    public func withControlDescriptorForTesting<T>(_ body: (Int32) -> T) -> T? {
        control.with(body)
    }

    // MARK: Threads

    private static func startReader(name: String, descriptor: Int32, keep: Int, chunk: Int,
                                    yield: @escaping @Sendable (ParticipantProcessEvent) -> Void,
                                    done: @escaping @Sendable () -> Void,
                                    data: @escaping @Sendable (Data) -> ParticipantProcessEvent,
                                    limit: ParticipantProcessEvent?,
                                    closed: @escaping @Sendable (Int) -> ParticipantProcessEvent) {
        let thread = Thread {
            var buffer = [UInt8](repeating: 0, count: chunk)
            var total = 0
            var kept = 0
            var limitReported = false
            while true {
                let count = read(descriptor, &buffer, buffer.count)
                if count > 0 {
                    total += count
                    let room = max(0, keep - kept)
                    if room > 0 {
                        let taken = min(room, count)
                        kept += taken
                        yield(data(Data(buffer[0..<taken])))
                    }
                    if count > room, !limitReported, let limit {
                        limitReported = true
                        yield(limit)
                    }
                    continue
                }
                if count < 0, errno == EINTR { continue }
                break
            }
            _ = close(descriptor)
            yield(closed(total))
            done()
        }
        thread.name = name
        thread.start()
    }

    private static func startControlReader(control: GuardedDescriptor,
                                           yield: @escaping @Sendable (ParticipantProcessEvent) -> Void,
                                           done: @escaping @Sendable () -> Void) {
        guard let descriptor = control.with({ $0 }) else {
            yield(.controlClosed)
            done()
            return
        }
        let thread = Thread {
            var splitter = ControlLineSplitter()
            var buffer = [UInt8](repeating: 0, count: 256)
            reading: while true {
                var poller = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
                let ready = poll(&poller, 1, -1)
                if ready < 0 {
                    if errno == EINTR { continue }
                    break
                }
                while true {
                    let count = read(descriptor, &buffer, buffer.count)
                    if count > 0 {
                        for line in splitter.append(buffer.prefix(count)) {
                            if let message = SupervisorMessage(line: line) { yield(.control(message)) }
                        }
                        continue
                    }
                    if count < 0, errno == EINTR { continue }
                    if count < 0, errno == EAGAIN { continue reading }
                    break reading
                }
            }
            control.close()
            yield(.controlClosed)
            done()
        }
        thread.name = "participant-control"
        thread.start()
    }

    private static func startStdinWriter(descriptor: Int32, input: Data,
                                         yield: @escaping @Sendable (ParticipantProcessEvent) -> Void,
                                         done: @escaping @Sendable () -> Void) {
        DispatchQueue.global(qos: .utility).async {
            // A CLI that exits early must give EPIPE here, not kill the app.
            _ = fcntl(descriptor, F_SETNOSIGPIPE, 1)
            let bytes = [UInt8](input)
            var written = 0
            while written < bytes.count {
                let result = bytes.withUnsafeBytes { buffer in
                    write(descriptor, buffer.baseAddress! + written, buffer.count - written)
                }
                if result > 0 {
                    written += result
                } else if result < 0, errno == EINTR {
                    continue
                } else {
                    break
                }
            }
            _ = close(descriptor)
            yield(.stdinClosed(writtenBytes: written, complete: written == bytes.count))
            done()
        }
    }

    private static func startReaper(pid: pid_t, lifeline: GuardedDescriptor,
                                    yield: @escaping @Sendable (ParticipantProcessEvent) -> Void,
                                    done: @escaping @Sendable () -> Void) {
        let thread = Thread {
            var status: Int32 = 0
            var result: pid_t
            repeat {
                result = waitpid(pid, &status, 0)
            } while result == -1 && errno == EINTR
            // The supervisor is gone, so nothing reads the lifeline any more.
            lifeline.close()
            yield(.supervisorExited(status: result == pid ? status : -1))
            done()
        }
        thread.name = "participant-reaper"
        thread.start()
    }
}

/// Counts down the sources still open.
final class SourceCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var remaining: Int

    init(count: Int) {
        remaining = count
    }

    /// True for the call that closes the last source.
    func finishOne() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        remaining -= 1
        return remaining == 0
    }
}
