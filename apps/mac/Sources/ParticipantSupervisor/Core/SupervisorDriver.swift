import Darwin

/// The supervisor's five descriptors, exactly as the app passes them
/// (contract section 11). The first three are the CLI's own stdio and go to
/// the CLI unchanged.
public enum SupervisorDescriptor {
    public static let cliStdin: Int32 = 0
    public static let cliStdout: Int32 = 1
    public static let cliStderr: Int32 = 2
    public static let lifeline: Int32 = 3
    public static let control: Int32 = 4
    public static let count = 5
}

/// How the supervisor learned the app is gone.
public enum AppGoneCause: String, Sendable {
    case lifelineClosed = "lifeline-closed"
    case controlWriteFailed = "control-write-failed"
    case appExitNote = "app-exit-note"
    case appWatchFailed = "app-watch-failed"
    case parentChanged = "parent-changed"
}

/// Test-build seams. The shipping supervisor passes none.
public struct SupervisorHooks {
    /// Runs after the lifeline and control are watched and before the app's
    /// pid is (the test build pauses here while the app is killed).
    public var beforeAppWatch: (() -> Void)?
    /// Called once with the first way the app was found gone.
    public var appGoneObserved: ((AppGoneCause) -> Void)?

    public init(beforeAppWatch: (() -> Void)? = nil, appGoneObserved: ((AppGoneCause) -> Void)? = nil) {
        self.beforeAppWatch = beforeAppWatch
        self.appGoneObserved = appGoneObserved
    }
}

/// Exit codes for a supervisor that never reached its engine.
public enum SupervisorStartFailure: Int32 {
    case usage = 64
    case descriptors = 65
    case kqueue = 66
}

/// The supervisor process: `ParticipantSupervisor <app-pid> <cli-path> <cli-arguments...>`,
/// started by the app in its own process group with `POSIX_SPAWN_CLOEXEC_DEFAULT`
/// and exactly the five descriptors above, in the run's working folder.
/// Returns the process exit code. It spawns the CLI only with the pinned
/// command line (`CLICommandLineRule`) and only from an empty folder owned by
/// this user with mode 0700 (`WorkingFolderRule`); otherwise it reports
/// `spawn-failed`.
///
/// It never reads the CLI's output and never writes text: the CLI's pipes pass
/// through it only as descriptors handed to `posix_spawn`, after which its
/// copies are replaced with `/dev/null`. It is not a launchd job or login item;
/// it exits once its group is cleared and reported, and at most about 6 s
/// after the app is gone.
public func supervisorMain(arguments: [String], hooks: SupervisorHooks = SupervisorHooks()) -> Int32 {
    // A write to a closed socket must fail, not kill the supervisor.
    signal(SIGPIPE, SIG_IGN)

    guard arguments.count >= 3,
          let appPid = pid_t(arguments[1]), appPid > 1,
          arguments[2].hasPrefix("/") else {
        return SupervisorStartFailure.usage.rawValue
    }
    for descriptor in 0..<Int32(SupervisorDescriptor.count) where fcntl(descriptor, F_GETFD) == -1 {
        return SupervisorStartFailure.descriptors.rawValue
    }
    var on: Int32 = 1
    _ = setsockopt(SupervisorDescriptor.control, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    setNonBlocking(SupervisorDescriptor.control)
    setNonBlocking(SupervisorDescriptor.lifeline)

    let queue = kqueue()
    guard queue >= 0 else { return SupervisorStartFailure.kqueue.rawValue }
    _ = fcntl(queue, F_SETFD, FD_CLOEXEC)

    let driver = DarwinSupervisor(queue: queue, appPid: appPid, hooks: hooks)
    return driver.run(cliPath: arguments[2], cliArguments: Array(arguments.dropFirst(3)))
}

/// Milliseconds on a clock that keeps counting through sleep.
@inline(__always)
func monotonicMillis() -> UInt64 {
    clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000
}

private func setNonBlocking(_ descriptor: Int32) {
    let flags = fcntl(descriptor, F_GETFL)
    if flags >= 0 { _ = fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) }
}

final class DarwinSupervisor: SupervisorSystem {
    private let queue: Int32
    private let appPid: pid_t
    private let hooks: SupervisorHooks
    private var cliPid: pid_t = 0
    private var splitter = ControlLineSplitter()
    private var lifelineOpen = true
    private var controlOpen = true
    private var appGoneSeen = false
    private lazy var engine = SupervisorEngine(system: self)

    init(queue: Int32, appPid: pid_t, hooks: SupervisorHooks) {
        self.queue = queue
        self.appPid = appPid
        self.hooks = hooks
    }

    func run(cliPath: String, cliArguments: [String]) -> Int32 {
        watchRead(SupervisorDescriptor.lifeline)
        watchRead(SupervisorDescriptor.control)
        hooks.beforeAppWatch?()

        // Watch the app's pid, then confirm it is still our parent: a pid that
        // died before the watch was registered may already belong to another
        // process, but our parent changes to launchd the moment the app dies.
        let watched = watchAppExit()
        if getppid() != appPid {
            noteAppGone(.parentChanged)
        } else if !watched {
            noteAppGone(.appWatchFailed)
        }
        // Anything already pending: lifeline EOF, NOTE_EXIT, an early stop.
        pump(timeoutMillis: 0)
        if !appGoneSeen, getppid() != appPid { noteAppGone(.parentChanged) }
        if appGoneSeen {
            return engine.exitCode   // 3: spawned nothing
        }

        // Only the pinned command line, from an empty private folder; anything
        // else spawns nothing, whoever started this supervisor.
        guard CLICommandLineRule.isPinned(cliArguments), WorkingFolderRule.currentDirectoryIsPrivateEmpty(),
              let pid = spawnCLI(path: cliPath, arguments: cliArguments) else {
            engine.spawnFailed(now: monotonicMillis())
            return engine.exitCode
        }
        cliPid = pid
        watchLeaderExit()
        // Reports `spawned`, then runs a `stop` that arrived before the spawn.
        engine.spawned(now: monotonicMillis())
        releaseCLIDescriptors()

        while engine.phase != .finished {
            let now = monotonicMillis()
            let wake = engine.nextWake(now: now) ?? (now + SupervisorTiming.contract.idleWake)
            pump(timeoutMillis: wake > now ? wake - now : 0)
            let after = monotonicMillis()
            if getppid() != appPid { noteAppGone(.parentChanged) }
            if !engine.leaderExited, let status = peekLeaderExit() {
                engine.leaderDidExit(status: status, now: after)
            }
            if !engine.reporting { noteAppGone(.controlWriteFailed) }
            engine.tick(now: after)
        }
        return engine.exitCode
    }

    // MARK: SupervisorSystem

    func signalGroup(_ signal: Int32) {
        guard cliPid > 0 else { return }
        _ = killpg(cliPid, signal)
        // A leader that moved itself into another group is out of killpg's
        // reach. The engine never signals after the reap, so the leader is
        // still this process's child and its pid cannot belong to another.
        if getpgid(cliPid) != cliPid { _ = kill(cliPid, signal) }
    }

    func otherMemberCount() -> Int? {
        guard cliPid > 0 else { return 0 }
        return ProcessGroupProbe.members(of: cliPid)?.filter { $0 != cliPid }.count
    }

    func reapLeader() {
        guard cliPid > 0 else { return }
        var status: Int32 = 0
        while waitpid(cliPid, &status, WNOHANG) == -1, errno == EINTR {}
    }

    func report(_ message: SupervisorMessage) -> Bool {
        guard controlOpen else { return false }
        let bytes = message.wireBytes
        var written = 0
        while written < bytes.count {
            let result = bytes.withUnsafeBytes { buffer in
                write(SupervisorDescriptor.control, buffer.baseAddress! + written, buffer.count - written)
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
    }

    // MARK: Events

    private func noteAppGone(_ cause: AppGoneCause) {
        if !appGoneSeen {
            appGoneSeen = true
            hooks.appGoneObserved?(cause)
        }
        // Before the spawn this finishes the engine, so nothing is spawned.
        engine.appGone(now: monotonicMillis())
    }

    /// Waits up to `timeoutMillis` for kqueue events and handles them all.
    private func pump(timeoutMillis: UInt64) {
        var timeout = timespec(tv_sec: Int(timeoutMillis / 1000), tv_nsec: Int((timeoutMillis % 1000) * 1_000_000))
        let empty = kevent()
        var events = Array(repeating: empty, count: 8)
        let count = kevent(queue, nil, 0, &events, Int32(events.count), &timeout)
        guard count > 0 else { return }
        for event in events.prefix(Int(count)) {
            handle(event)
        }
    }

    private func handle(_ event: kevent) {
        let filter = Int32(event.filter)
        if event.flags & UInt16(EV_ERROR) != 0 {
            if filter == EVFILT_PROC, pid_t(truncatingIfNeeded: event.ident) == appPid {
                noteAppGone(.appWatchFailed)
            }
            return
        }
        switch filter {
        case EVFILT_READ:
            let descriptor = Int32(truncatingIfNeeded: event.ident)
            if descriptor == SupervisorDescriptor.lifeline {
                drainLifeline()
            } else if descriptor == SupervisorDescriptor.control {
                readControl()
            }
        case EVFILT_PROC:
            let pid = pid_t(truncatingIfNeeded: event.ident)
            guard event.fflags & NOTE_EXIT != 0 else { return }
            if pid == appPid {
                noteAppGone(.appExitNote)
            } else if pid == cliPid, !engine.leaderExited {
                engine.leaderDidExit(status: Int32(truncatingIfNeeded: event.data), now: monotonicMillis())
            }
        default:
            break
        }
    }

    /// The app never writes to the lifeline; EOF means every write end is closed.
    private func drainLifeline() {
        guard lifelineOpen else { return }
        var buffer = [UInt8](repeating: 0, count: 64)
        while true {
            let count = read(SupervisorDescriptor.lifeline, &buffer, buffer.count)
            if count > 0 { continue }
            if count < 0, errno == EINTR { continue }
            if count < 0, errno == EAGAIN { return }
            lifelineOpen = false
            unwatchRead(SupervisorDescriptor.lifeline)
            noteAppGone(.lifelineClosed)
            return
        }
    }

    private func readControl() {
        guard controlOpen else { return }
        var buffer = [UInt8](repeating: 0, count: 64)
        while true {
            let count = read(SupervisorDescriptor.control, &buffer, buffer.count)
            if count > 0 {
                for line in splitter.append(buffer.prefix(count)) where SupervisorCommand(line: line) == .stop {
                    engine.stopRequested(now: monotonicMillis())
                }
                continue
            }
            if count < 0, errno == EINTR { continue }
            if count < 0, errno == EAGAIN { return }
            // EOF is not by itself the app's death (the lifeline and NOTE_EXIT
            // are); it ends reporting, and the next report's failure is
            // treated as the app gone.
            controlOpen = false
            unwatchRead(SupervisorDescriptor.control)
            return
        }
    }

    // MARK: Registration

    private func watchRead(_ descriptor: Int32) {
        var change = kevent(ident: UInt(descriptor), filter: Int16(EVFILT_READ), flags: UInt16(EV_ADD | EV_ENABLE),
                            fflags: 0, data: 0, udata: nil)
        _ = kevent(queue, &change, 1, nil, 0, nil)
    }

    private func unwatchRead(_ descriptor: Int32) {
        var change = kevent(ident: UInt(descriptor), filter: Int16(EVFILT_READ), flags: UInt16(EV_DELETE),
                            fflags: 0, data: 0, udata: nil)
        _ = kevent(queue, &change, 1, nil, 0, nil)
    }

    /// Registers `NOTE_EXIT` on the app; false when the kernel refused it
    /// (the pid is already gone).
    private func watchAppExit() -> Bool {
        registerProcess(appPid, notes: NOTE_EXIT)
    }

    /// Registers `NOTE_EXIT | NOTE_EXITSTATUS` on the leader. If it already
    /// exited, `peekLeaderExit` finds its status without reaping it.
    private func watchLeaderExit() {
        _ = registerProcess(cliPid, notes: NOTE_EXIT | UInt32(NOTE_EXITSTATUS))
    }

    private func registerProcess(_ pid: pid_t, notes: UInt32) -> Bool {
        var change = kevent(ident: UInt(pid), filter: Int16(EVFILT_PROC), flags: UInt16(EV_ADD | EV_RECEIPT),
                            fflags: notes, data: 0, udata: nil)
        var receipt = kevent()
        let count = kevent(queue, &change, 1, &receipt, 1, nil)
        guard count == 1 else { return count == 0 }
        // With EV_RECEIPT every registration answers with EV_ERROR; data 0 is success.
        return receipt.flags & UInt16(EV_ERROR) == 0 || receipt.data == 0
    }

    /// The leader's wait status if it has exited, read with `WNOWAIT` so it
    /// stays a zombie and keeps the group id reserved.
    private func peekLeaderExit() -> Int32? {
        guard cliPid > 0 else { return nil }
        var info = siginfo_t()
        let result = waitid(P_PID, id_t(cliPid), &info, WEXITED | WNOHANG | WNOWAIT)
        guard result == 0, info.si_pid == cliPid else { return nil }
        switch info.si_code {
        case CLD_EXITED: return (info.si_status & 0xFF) << 8
        case CLD_KILLED: return info.si_status & 0x7F
        case CLD_DUMPED: return (info.si_status & 0x7F) | 0x80
        default: return nil
        }
    }

    // MARK: Spawn

    /// Spawns the CLI as the leader of a new group with only stdin, stdout and
    /// stderr, the environment rule applied again, every catchable signal at
    /// its default and nothing masked.
    private func spawnCLI(path: String, arguments: [String]) -> pid_t? {
        var attributes: posix_spawnattr_t?
        guard posix_spawnattr_init(&attributes) == 0 else { return nil }
        defer { posix_spawnattr_destroy(&attributes) }
        var actions: posix_spawn_file_actions_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { return nil }
        defer { posix_spawn_file_actions_destroy(&actions) }

        let flags = POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK
        guard posix_spawnattr_setflags(&attributes, Int16(flags)) == 0,
              posix_spawnattr_setpgroup(&attributes, 0) == 0 else { return nil }
        var defaults = sigset_t()
        for signalNumber in 1..<Int32(NSIG) where signalNumber != SIGKILL && signalNumber != SIGSTOP {
            defaults |= sigset_t(1) << sigset_t(signalNumber - 1)
        }
        var mask = sigset_t()
        guard posix_spawnattr_setsigdefault(&attributes, &defaults) == 0,
              posix_spawnattr_setsigmask(&attributes, &mask) == 0 else { return nil }
        for descriptor in [SupervisorDescriptor.cliStdin, SupervisorDescriptor.cliStdout, SupervisorDescriptor.cliStderr] {
            guard posix_spawn_file_actions_addinherit_np(&actions, descriptor) == 0 else { return nil }
        }

        let argv: [UnsafeMutablePointer<CChar>?] = ([path] + arguments).map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = CLIEnvironmentRule.apply(to: currentEnvironment()).map { strdup($0) } + [nil]
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
        }
        var pid: pid_t = 0
        let result = posix_spawn(&pid, path, &actions, &attributes, argv, envp)
        return result == 0 && pid > 0 ? pid : nil
    }

    private func currentEnvironment() -> [String] {
        var entries: [String] = []
        var entry = environ
        while let pointer = entry.pointee {
            entries.append(String(cString: pointer))
            entry += 1
        }
        return entries
    }

    /// Closes the supervisor's copies of the CLI's pipe ends (replacing them
    /// with `/dev/null`), so EOF on the app's read ends means no process holds
    /// a write end.
    private func releaseCLIDescriptors() {
        let null = open("/dev/null", O_RDWR | O_CLOEXEC)
        for descriptor in [SupervisorDescriptor.cliStdin, SupervisorDescriptor.cliStdout, SupervisorDescriptor.cliStderr] {
            if null >= 0 {
                _ = dup2(null, descriptor)
            } else {
                _ = close(descriptor)
            }
        }
        if null > SupervisorDescriptor.cliStderr { _ = close(null) }
    }
}
