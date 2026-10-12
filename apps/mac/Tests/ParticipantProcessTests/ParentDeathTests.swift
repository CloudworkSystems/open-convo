import Darwin
import Foundation
@testable import ParticipantProcess
import ParticipantSupervisorCore
import Testing

/// One parent-death run: a test host plays the app, the real supervisor (or
/// its test build, or the helper inside a packaged copy; the test checks the
/// process the host started is that program) runs the fake CLI, the test
/// SIGKILLs the host (never its close handler) and then requires, from the
/// kill, that `proc_listpids(PROC_PGRP_ONLY)` finds no member of the CLI's group within
/// 10 s (6 s when the lifeline is leaked, so its EOF cannot report the death)
/// and that the supervisor is gone within 6 s (contract section 11), each
/// with 0.25 s of polling margin where the bound is 6 s.
struct ParentDeathRun {
    let folder: FakeCLIFolder
    let host: HostProcess
    let supervisor: pid_t
    private var extraPids: [pid_t] = []

    /// The contract's fake: ignores SIGTERM and forks a child in its group
    /// that ignores it too.
    static var stubbornScenario: FakeCLIFolder.Scenario {
        var scenario = FakeCLIFolder.Scenario.lines([Invented.initLine(), Invented.rateLimit()], then: ["hang": true])
        scenario.sigterm = "ignore"
        scenario.child = "ignore-term"
        return scenario
    }

    init(_ scenario: FakeCLIFolder.Scenario = stubbornScenario, supervisorPath: String = Products.supervisor,
         pauseMillis: Int? = nil) async throws {
        folder = try FakeCLIFolder(scenario)
        if let pauseMillis {
            try "\(pauseMillis)".write(to: folder.temporary.appendingPathComponent("participant-test-supervisor-pause-ms"),
                                       atomically: true, encoding: .utf8)
        }
        host = try HostProcess(supervisor: supervisorPath, folder: folder)
        guard let pid = pid_t(try await host.waitFor("supervisor ")) else { throw ProcessTestError.timeout("supervisor pid") }
        supervisor = pid
        // The host has just spawned it and is still alive, so it is running.
        Processes.expectProgram(pid, is: supervisorPath)
    }

    /// Waits until the CLI and its child are running in their group.
    func running() async throws -> (cli: pid_t, child: pid_t) {
        try await host.waitFor("control spawned")
        let cli = try await folder.waitForPid("cli.pid")
        let child = try await folder.waitForPid("child.pid")
        #expect(Set(Processes.members(cli)) == [cli, child])
        return (cli, child)
    }

    mutating func remember(_ pid: pid_t) { extraPids.append(pid) }

    /// The contract's bounds, in seconds from the app's death.
    static let groupBound: Double = 10
    static let noteExitBound: Double = 6.25
    static let supervisorBound: Double = 6.25

    /// From `start`: seconds until the group is empty and until the supervisor
    /// is gone, polled together from the same instant and each required
    /// within its bound.
    func measure(group: pid_t?, from start: ContinuousClock.Instant, within groupLimit: Double = ParentDeathRun.groupBound,
                 supervisorWithin supervisorLimit: Double = ParentDeathRun.supervisorBound)
        async -> (groupEmpty: Double?, supervisorGone: Double?) {
        var groupEmpty: Double?
        var gone: Double?
        let limit = max(groupLimit, supervisorLimit)
        _ = await Processes.waitUntil(seconds: limit) {
            if let group, groupEmpty == nil, Processes.members(group).isEmpty { groupEmpty = Processes.elapsed(since: start) }
            if gone == nil, !Processes.isRunning(supervisor) { gone = Processes.elapsed(since: start) }
            return (group == nil || groupEmpty != nil) && gone != nil || Processes.elapsed(since: start) > limit
        }
        if let group {
            #expect(groupEmpty.map { $0 <= groupLimit } == true,
                    "group \(group) empty at \(groupEmpty.map { String(format: "%.2fs", $0) } ?? "never: \(Processes.members(group))"), bound \(groupLimit)s")
        }
        #expect(gone.map { $0 <= supervisorLimit } == true,
                "supervisor \(supervisor) gone at \(gone.map { String(format: "%.2fs", $0) } ?? "never"), bound \(supervisorLimit)s")
        return (groupEmpty, gone)
    }

    func cause() -> String? {
        try? String(contentsOf: folder.temporary.appendingPathComponent("pausing-supervisor-\(supervisor).txt"),
                    encoding: .utf8)
    }

    func clean() {
        host.kill9()
        folder.clean(also: [supervisor] + extraPids)
    }
}

/// The variants that run the shipping supervisor, shared by `ParentDeath`
/// (this build's product) and `PackagedSupervisorTests` (the helper inside a
/// packaged True Convo Test.app). Each takes the supervisor to run.
extension ParentDeathRun {
    static func killWhileRunning(_ supervisor: SupervisorUnderTest) async throws {
        let run = try await ParentDeathRun(supervisorPath: supervisor.path)
        defer { run.clean() }
        let (cli, _) = try await run.running()
        let start = ContinuousClock.now
        run.host.kill9()
        let result = await run.measure(group: cli, from: start)
        #expect((result.groupEmpty ?? 99) >= 2.9, "no SIGKILL before 3 s")
        measured("\(supervisor.label)parent-death running", [("group-empty", result.groupEmpty), ("supervisor-gone", result.supervisorGone)])
    }

    static func killWhileStarting(_ supervisor: SupervisorUnderTest) async throws {
        let run = try await ParentDeathRun(supervisorPath: supervisor.path)
        defer { run.clean() }
        let start = ContinuousClock.now
        run.host.kill9()
        // The kill races the supervisor's start: either it finds the app gone
        // and spawns nothing, or the CLI is already up and must be cleaned.
        // Each run takes one branch and records which (cli-spawned=yes/no);
        // one run is never evidence that both branches occurred.
        var cli: pid_t?
        var groupEmpty: Double?
        var supervisorGone: Double?
        _ = await Processes.waitUntil(seconds: 10) {
            if cli == nil { cli = run.folder.pid("cli.pid") }
            if groupEmpty == nil, let cli, Processes.members(cli).isEmpty { groupEmpty = Processes.elapsed(since: start) }
            if supervisorGone == nil, !Processes.isRunning(run.supervisor) { supervisorGone = Processes.elapsed(since: start) }
            return supervisorGone != nil && (cli == nil || groupEmpty != nil)
        }
        #expect(supervisorGone.map { $0 <= ParentDeathRun.supervisorBound } == true,
                "supervisor gone at \(supervisorGone.map { String(format: "%.2fs", $0) } ?? "never")")
        if cli != nil {
            #expect(groupEmpty.map { $0 <= ParentDeathRun.groupBound } == true,
                    "group empty at \(groupEmpty.map { String(format: "%.2fs", $0) } ?? "never")")
        }
        try await Task.sleep(nanoseconds: 500_000_000)
        if cli == nil { cli = run.folder.pid("cli.pid") }
        if let cli {
            #expect(Processes.members(cli).isEmpty)
            if groupEmpty == nil, Processes.members(cli).isEmpty { groupEmpty = Processes.elapsed(since: start) }
            if let child = run.folder.pid("child.pid") { #expect(!Processes.isRunning(child)) }
        }
        let branch = cli == nil ? "no" : "yes"
        print("[measure] \(supervisor.label)parent-death starting: cli-spawned=\(branch)")
        measured("\(supervisor.label)parent-death starting cli-spawned=\(branch)",
                 [("group-empty", groupEmpty), ("supervisor-gone", supervisorGone)])
    }

    static func killDuringStopWait(_ supervisor: SupervisorUnderTest) async throws {
        let run = try await ParentDeathRun(supervisorPath: supervisor.path)
        defer { run.clean() }
        let (cli, _) = try await run.running()
        run.host.send("stop")
        try await run.host.waitFor("stop-sent")
        try await Task.sleep(nanoseconds: 1_000_000_000)
        #expect(Processes.members(cli).count == 2, "SIGTERM is ignored")
        let start = ContinuousClock.now
        run.host.kill9()
        let result = await run.measure(group: cli, from: start)
        #expect((result.groupEmpty ?? 99) < 5, "SIGKILL at 3 s after the app died, not 10 s after the stop")
        measured("\(supervisor.label)parent-death stop-wait", [("group-empty", result.groupEmpty), ("supervisor-gone", result.supervisorGone)])
    }

    static func lifelineClosed(_ supervisor: SupervisorUnderTest) async throws {
        let run = try await ParentDeathRun(supervisorPath: supervisor.path)
        defer { run.clean() }
        let (cli, _) = try await run.running()
        let start = ContinuousClock.now
        run.host.send("close-lifeline")
        try await run.host.waitFor("lifeline-closed")
        let result = await run.measure(group: cli, from: start)
        #expect(Processes.isRunning(run.host.pid), "the host never exited")
        try await run.host.waitFor("control cleared", seconds: 2)
        measured("\(supervisor.label)parent-death lifeline-closed", [("group-empty", result.groupEmpty), ("supervisor-gone", result.supervisorGone)])
    }

    static func leaderExitsChildIgnores(_ supervisor: SupervisorUnderTest) async throws {
        var scenario = ParentDeathRun.stubbornScenario
        scenario.sigterm = "exit"
        let run = try await ParentDeathRun(scenario, supervisorPath: supervisor.path)
        defer { run.clean() }
        let (cli, child) = try await run.running()
        let start = ContinuousClock.now
        run.host.kill9()
        try await Task.sleep(nanoseconds: 1_500_000_000)
        #expect(!Processes.isRunning(cli), "the leader exited on SIGTERM")
        #expect(Set(Processes.members(cli)) == [cli, child], "its zombie still holds the group id")
        #expect(Processes.isRunning(child))
        let result = await run.measure(group: cli, from: start)
        #expect((result.groupEmpty ?? 99) >= 2.9)
        measured("\(supervisor.label)parent-death leader-exits", [("group-empty", result.groupEmpty), ("supervisor-gone", result.supervisorGone)])
    }

    /// Bounded cleanup with the lifeline leaked: the group is empty and the
    /// supervisor gone within 6.25 s while the sleeper still holds the
    /// lifeline. Only the lifeline leaks, so control EOF, `NOTE_EXIT` or the
    /// driver's periodic `getppid()` check may each start the cleanup; this
    /// body does not say which. `ParentDeath.leakedLifelineCause` (test build
    /// only) leaks control too and records that `NOTE_EXIT` reported it
    /// (Codex F2-M2).
    static func leakedLifeline(_ supervisor: SupervisorUnderTest) async throws {
        var run = try await ParentDeathRun(supervisorPath: supervisor.path)
        defer { run.clean() }
        let (cli, _) = try await run.running()
        run.host.send("leak-lifeline")
        guard let sleeper = pid_t(try await run.host.waitFor("sleeper ")), sleeper > 0 else {
            Issue.record("no sleeper")
            return
        }
        run.remember(sleeper)
        let start = ContinuousClock.now
        run.host.kill9()
        let result = await run.measure(group: cli, from: start, within: ParentDeathRun.noteExitBound)
        #expect(Processes.isRunning(sleeper), "the lifeline stayed open")
        measured("\(supervisor.label)parent-death leaked-lifeline", [("group-empty", result.groupEmpty), ("supervisor-gone", result.supervisorGone)])
    }

    static func leaderLeftGroup(_ supervisor: SupervisorUnderTest) async throws {
        var scenario = ParentDeathRun.stubbornScenario
        scenario.leaveGroup = true
        let run = try await ParentDeathRun(scenario, supervisorPath: supervisor.path)
        defer { run.clean() }
        try await run.host.waitFor("control spawned")
        let cli = try await run.folder.waitForPid("cli.pid")
        let child = try await run.folder.waitForPid("child.pid")
        _ = await Processes.waitUntil(seconds: 5) { run.folder.record("moved.json") != nil }
        #expect(run.folder.record("moved.json")?["result"] as? Int == 0, "setpgid into the supervisor's group is allowed")
        #expect(Processes.groupOf(cli) == run.supervisor, "the leader left its own group")
        #expect(Processes.members(cli) == [child], "only its child is left in the CLI's group")
        let start = ContinuousClock.now
        run.host.kill9()
        let result = await run.measure(group: cli, from: start)
        #expect(!Processes.isRunning(cli), "the leader outside its group was stopped, not left behind")
        #expect((result.groupEmpty ?? 99) >= 2.9, "the child ignores SIGTERM: no SIGKILL before 3 s")
        measured("\(supervisor.label)parent-death leader-left-group", [("group-empty", result.groupEmpty),
                                                                       ("supervisor-gone", result.supervisorGone)])
    }
}

extension ProcessSuites {
    @Suite("Parent death: SIGKILL of the app")
    struct ParentDeath {
        @Test("Killed while running: SIGTERM ignored, SIGKILL at 3 s, group empty, supervisor gone")
        func killWhileRunning() async throws {
            try await ParentDeathRun.killWhileRunning(.built)
        }

        @Test("Killed while starting: right after the supervisor is spawned; records which branch this run took (CLI spawned or not)")
        func killWhileStarting() async throws {
            try await ParentDeathRun.killWhileStarting(.built)
        }

        @Test("Killed during a Stop's wait: the 10 s wait is cut to the 3 s bound")
        func killDuringStopWait() async throws {
            try await ParentDeathRun.killDuringStopWait(.built)
        }

        @Test("The host closes the lifeline without exiting: cleanup runs and is still reported")
        func lifelineClosed() async throws {
            try await ParentDeathRun.lifelineClosed(.built)
        }

        @Test("The leader exits on SIGTERM while its child ignores it: the zombie leader keeps the group reserved")
        func leaderExitsChildIgnores() async throws {
            try await ParentDeathRun.leaderExitsChildIgnores(.built)
        }

        @Test("The lifeline leaked to a sleeper: bounded cleanup within 6 s, the sleeper still running")
        func leakedLifeline() async throws {
            try await ParentDeathRun.leakedLifeline(.built)
        }

        @Test("Lifeline and control both leaked, test build recording why: NOTE_EXIT reports the death (test build only)")
        func leakedLifelineCause() async throws {
            var run = try await ParentDeathRun(supervisorPath: Products.pausingSupervisor, pauseMillis: 0)
            defer { run.clean() }
            let (cli, _) = try await run.running()
            run.host.send("leak-lifeline-and-control")
            guard let sleeper = pid_t(try await run.host.waitFor("sleeper ")), sleeper > 0 else {
                Issue.record("no sleeper")
                return
            }
            run.remember(sleeper)
            let start = ContinuousClock.now
            run.host.kill9()
            let result = await run.measure(group: cli, from: start, within: ParentDeathRun.noteExitBound)
            let cause = run.cause()
            #expect(cause == AppGoneCause.appExitNote.rawValue, "observed \(cause ?? "nothing")")
            print("[measure] parent-death leaked-lifeline cause=\(cause ?? "none")")
            measured("parent-death leaked-lifeline test-build", [("group-empty", result.groupEmpty),
                                                                  ("supervisor-gone", result.supervisorGone)])
        }

        @Test("A leader that moved into the supervisor's group and ignores SIGTERM: the SIGKILL at 3 s still reaches it")
        func leaderLeftGroup() async throws {
            try await ParentDeathRun.leaderLeftGroup(.built)
        }

        @Test("A supervisor that pauses before watching the app: the getppid() check catches the death (test build only)")
        func pausedBeforeWatch() async throws {
            var run = try await ParentDeathRun(supervisorPath: Products.pausingSupervisor)
            defer { run.clean() }
            // Inside the 1.5 s pause: leak the lifeline, then kill the host.
            run.host.send("leak-lifeline")
            guard let sleeper = pid_t(try await run.host.waitFor("sleeper ")), sleeper > 0 else {
                Issue.record("no sleeper")
                return
            }
            run.remember(sleeper)
            let start = ContinuousClock.now
            run.host.kill9()
            let result = await run.measure(group: nil, from: start)
            #expect(run.cause() == AppGoneCause.parentChanged.rawValue, "observed \(run.cause() ?? "nothing")")
            try await Task.sleep(nanoseconds: 500_000_000)
            #expect(run.folder.pid("cli.pid") == nil, "the app was gone before the spawn, so nothing was spawned")
            #expect(Processes.isRunning(sleeper))
            measured("parent-death paused-before-watch", [("supervisor-gone", result.supervisorGone)])
        }
    }
}
