import Darwin

/// What the engine asks of the operating system. The Darwin driver implements
/// it with `killpg`, `proc_listpids`, `waitpid` and the control socket; tests
/// implement it with a recording fake, so every timing rule below is checked
/// without a process.
public protocol SupervisorSystem: AnyObject {
    /// Sends `signal` to the CLI's process group (the leader's pid), and to
    /// the leader itself if it has left that group: until it is reaped the
    /// leader is the supervisor's own child, so its pid cannot be reused.
    func signalGroup(_ signal: Int32)
    /// How many processes other than the leader are in the CLI's group, or
    /// nil when the probe failed. Nil is never read as empty.
    func otherMemberCount() -> Int?
    /// Reaps the exited leader. Called once, only after a probe found the
    /// group empty; afterwards the group id may be reused, so nothing is ever
    /// signalled again.
    func reapLeader()
    /// Writes one control message; false when the write failed (the app is gone).
    func report(_ message: SupervisorMessage) -> Bool
}

/// The bounds from contract section 11, in milliseconds.
public struct SupervisorTiming: Equatable, Sendable {
    /// SIGTERM, then wait up to this long for the group to empty.
    public var stopTermWait: UInt64 = 10_000
    /// After the one SIGKILL, probe this long before reporting `uncleared`.
    public var killProbe: UInt64 = 2_000
    /// While members remain after that, re-probe (and SIGKILL) this often.
    public var unclearedReprobe: UInt64 = 5_000
    /// After the app dies: SIGKILL at this point...
    public var appGoneKill: UInt64 = 3_000
    /// ...and probe until this point, then exit.
    public var appGoneExit: UInt64 = 6_000
    /// How often a waiting phase probes the group.
    public var probeInterval: UInt64 = 50
    /// Longest sleep while nothing is pending, so `getppid()` is rechecked.
    public var idleWake: UInt64 = 1_000

    public init() {}

    public static let contract = SupervisorTiming()
}

/// The supervisor's state machine for one CLI process group.
///
/// - The leader's exit is read without reaping it, so its pid, which is the
///   group id, stays reserved; the leader is reaped only after a probe finds
///   the group empty (ignoring the zombie leader), and after that the group
///   is never signalled.
/// - Stop: SIGTERM the group, wait up to 10 s, one SIGKILL, probe 2 s; then
///   `uncleared`, re-probing every 5 s and sending SIGKILL while members
///   remain. A `stop` in that state is the cleanup retry: one more SIGKILL and
///   a 2 s probe.
/// - After any exit of the leader the group is probed and what remains is
///   stopped.
/// - Until its exit is seen, the leader counts as present wherever its group
///   is (it may have moved itself into another group of the session), so the
///   group is never cleared and the leader never reaped while it runs. A
///   probe that fails counts as members remaining.
/// - App gone: SIGTERM, SIGKILL at 3 s, probe until 6 s, exit; a Stop in
///   progress is cut to the same bound. Before the CLI is spawned, nothing is
///   spawned.
public final class SupervisorEngine {
    public enum Phase: Equatable, Sendable {
        case awaitingSpawn
        case running
        case stopping
        case uncleared
        case retrying
        case appGone
        case finished
    }

    public private(set) var phase: Phase = .awaitingSpawn
    public private(set) var leaderExited = false
    public private(set) var leaderReaped = false
    public private(set) var appIsGone = false
    /// Whether control writes still go out; the first failed write ends them.
    public private(set) var reporting = true
    /// True when the supervisor ended with the group confirmed empty.
    public private(set) var groupCleared = false
    /// The supervisor's own exit code once `phase` is `.finished`: 0 cleared,
    /// 1 left with members, 2 spawn failed, 3 app gone before any spawn.
    public private(set) var exitCode: Int32 = 0

    private let system: SupervisorSystem
    private let timing: SupervisorTiming
    private var lastNow: UInt64 = 0
    private var stopBeforeSpawn = false
    private var writeFailed = false

    // The current stop sequence.
    private var killAt: UInt64 = 0
    private var killSent = false
    private var probeUntil: UInt64 = 0
    private var reprobeAt: UInt64 = 0

    // After the app is gone.
    private var appGoneKillAt: UInt64 = 0
    private var appGoneKillSent = false
    private var appGoneExitAt: UInt64 = 0

    public init(system: SupervisorSystem, timing: SupervisorTiming = .contract) {
        self.system = system
        self.timing = timing
    }

    // MARK: Inputs

    /// The CLI could not be spawned. There is no group; report and finish.
    public func spawnFailed(now: UInt64) {
        lastNow = now
        guard phase == .awaitingSpawn else { return }
        report(.spawnFailed)
        finish(exitCode: 2)
    }

    /// The CLI is running as the leader of its own group.
    public func spawned(now: UInt64) {
        lastNow = now
        guard phase == .awaitingSpawn else { return }
        phase = .running
        report(.spawned)
        if stopBeforeSpawn { stopRequested(now: now) }
        settle()
    }

    /// The app sent `stop`.
    public func stopRequested(now: UInt64) {
        lastNow = now
        switch phase {
        case .awaitingSpawn:
            stopBeforeSpawn = true
        case .running:
            beginStopSequence(now: now)
        case .uncleared:
            // Cleanup retry: one more SIGKILL to the still-reserved group.
            signal(SIGKILL)
            probeUntil = now + timing.killProbe
            phase = .retrying
            probe()
        case .stopping, .retrying, .appGone, .finished:
            break
        }
        settle()
    }

    /// kqueue reported the leader's exit (`NOTE_EXIT | NOTE_EXITSTATUS`), or
    /// `waitid(WNOWAIT)` saw it. The leader stays unreaped.
    public func leaderDidExit(status: Int32, now: UInt64) {
        lastNow = now
        guard !leaderExited, phase != .awaitingSpawn, phase != .finished else { return }
        leaderExited = true
        report(.exit(status: status))
        if phase == .running {
            // After any exit, probe and stop what remains (a failed probe
            // may hide members, so it stops too).
            if system.otherMemberCount() == 0 {
                finishCleared()
            } else {
                beginStopSequence(now: now)
            }
        } else {
            probe()
        }
        settle()
    }

    /// Lifeline EOF, `NOTE_EXIT` on the app, `getppid()` no longer the app,
    /// or a failed control write.
    public func appGone(now: UInt64) {
        lastNow = now
        guard !appIsGone, phase != .finished else { return }
        appIsGone = true
        if phase == .awaitingSpawn {
            // Nothing was spawned and nothing will be.
            finish(exitCode: 3)
            return
        }
        if phase == .running {
            signal(SIGTERM)
        }
        // Whatever was in progress is cut to the parent-death bound.
        appGoneKillAt = now + timing.appGoneKill
        appGoneExitAt = now + timing.appGoneExit
        phase = .appGone
        probe()
        settle()
    }

    /// Advances timers; the driver calls it after every wake.
    public func tick(now: UInt64) {
        lastNow = now
        switch phase {
        case .awaitingSpawn, .running, .finished:
            break
        case .stopping:
            if probe() { break }
            if !killSent {
                if now >= killAt {
                    signal(SIGKILL)
                    killSent = true
                    probeUntil = now + timing.killProbe
                }
            } else if now >= probeUntil {
                enterUncleared(now: now)
            }
        case .retrying:
            if probe() { break }
            if now >= probeUntil { enterUncleared(now: now) }
        case .uncleared:
            if now >= reprobeAt {
                if probe() { break }
                signal(SIGKILL)
                reprobeAt = now + timing.unclearedReprobe
            }
        case .appGone:
            if probe() { break }
            if !appGoneKillSent, now >= appGoneKillAt {
                signal(SIGKILL)
                appGoneKillSent = true
            }
            if now >= appGoneExitAt {
                // Leaving with members: one last SIGKILL while the leader still
                // holds the group id, then exit without reaping it (launchd
                // reaps it once this process is gone).
                signal(SIGKILL)
                report(.uncleared)
                finish(exitCode: 1)
            }
        }
        settle()
    }

    /// When the driver must wake next, or nil when only an event can matter.
    public func nextWake(now: UInt64) -> UInt64? {
        switch phase {
        case .awaitingSpawn, .finished:
            return nil
        case .running:
            return now + timing.idleWake
        case .stopping, .retrying, .appGone:
            return now + timing.probeInterval
        case .uncleared:
            return min(reprobeAt, now + timing.idleWake)
        }
    }

    // MARK: Steps

    private func beginStopSequence(now: UInt64) {
        signal(SIGTERM)
        killAt = now + timing.stopTermWait
        killSent = false
        phase = .stopping
        probe()
    }

    private func enterUncleared(now: UInt64) {
        report(.uncleared)
        phase = .uncleared
        reprobeAt = now + timing.unclearedReprobe
    }

    /// Probes the group; when it is empty, reaps the leader, reports
    /// `cleared` and finishes. Returns true when it finished.
    @discardableResult
    private func probe() -> Bool {
        guard phase != .finished, phase != .awaitingSpawn else { return false }
        // A leader whose exit is not seen yet is alive, a member wherever its
        // group is; a failed probe is not an empty group.
        guard leaderExited, system.otherMemberCount() == 0 else { return false }
        finishCleared()
        return true
    }

    private func finishCleared() {
        // The leader has exited and nothing else is in its group: it is a
        // zombie, so reap it, then never signal again.
        system.reapLeader()
        leaderReaped = true
        groupCleared = true
        report(.cleared)
        finish(exitCode: 0)
    }

    private func finish(exitCode code: Int32) {
        exitCode = code
        phase = .finished
    }

    private func signal(_ value: Int32) {
        // Never signal a group whose leader was reaped: its id may be reused.
        guard !leaderReaped, phase != .awaitingSpawn else { return }
        system.signalGroup(value)
    }

    private func report(_ message: SupervisorMessage) {
        guard reporting else { return }
        if !system.report(message) {
            // A failed write means the app is gone: stop reporting, finish cleanup.
            reporting = false
            writeFailed = true
        }
    }

    /// Applies a failed write's consequence once the current step is done.
    private func settle() {
        if writeFailed, !appIsGone, phase != .finished {
            writeFailed = false
            appGone(now: lastNow)
        }
    }
}
