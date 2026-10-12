import Darwin
import ParticipantSupervisorCore
import Testing

/// A simulated process group: the leader and some other members, each dying
/// (or not) on a given signal. The leader becomes a zombie when it dies and
/// is gone only once reaped. A leader may have moved itself into another
/// group (`leaderInGroup` false): the group's probe no longer lists it, but
/// the driver still signals it directly. A probe may fail (`probeFails`).
final class SimulatedGroup: SupervisorSystem {
    enum Leader { case alive, zombie, reaped }

    var now: UInt64 = 0
    var leader = Leader.alive
    var leaderInGroup = true
    var others = 0
    var leaderDiesOn: Set<Int32> = [SIGTERM, SIGKILL]
    var othersDieOn: Set<Int32> = [SIGTERM, SIGKILL]
    var reportsFail = false
    var probeFails = false
    private(set) var signals: [(at: UInt64, signal: Int32)] = []
    private(set) var reports: [SupervisorMessage] = []
    private(set) var signalledAfterReap = false
    private(set) var reapedWhileAlive = false
    var pendingLeaderExit: Int32?

    func signalGroup(_ signal: Int32) {
        if leader == .reaped { signalledAfterReap = true }
        signals.append((now, signal))
        if leader == .alive, leaderDiesOn.contains(signal) {
            leader = .zombie
            pendingLeaderExit = signal   // a wait status for "killed by signal"
        }
        if othersDieOn.contains(signal) { others = 0 }
    }

    func otherMemberCount() -> Int? {
        probeFails ? nil : others
    }

    /// Everything still alive, wherever its group is.
    var anyoneAlive: Bool { leader == .alive || others > 0 }

    func reapLeader() {
        if leader == .alive { reapedWhileAlive = true }
        leader = .reaped
    }

    func report(_ message: SupervisorMessage) -> Bool {
        reports.append(message)
        return !reportsFail
    }

    var signalNames: [String] {
        signals.map { "\($0.signal == SIGTERM ? "TERM" : $0.signal == SIGKILL ? "KILL" : "\($0.signal)")@\($0.at)" }
    }
}

/// Drives the engine the way the driver does: deliver the leader's exit
/// (kqueue), then tick, every 50 ms of simulated time.
struct EngineSimulation {
    let group = SimulatedGroup()
    let engine: SupervisorEngine

    init() {
        engine = SupervisorEngine(system: group)
    }

    func spawn() {
        engine.spawned(now: group.now)
    }

    func run(until end: UInt64) {
        while group.now < end, engine.phase != .finished {
            group.now += 50
            deliverExit()
            engine.tick(now: group.now)
        }
    }

    func deliverExit() {
        if let status = group.pendingLeaderExit {
            group.pendingLeaderExit = nil
            engine.leaderDidExit(status: status, now: group.now)
        }
    }

    /// The leader exits on its own with `status`.
    func leaderExits(_ status: Int32) {
        group.leader = .zombie
        engine.leaderDidExit(status: status, now: group.now)
    }
}

@Suite("Supervisor engine: stop sequence, parent death, reaping")
struct SupervisorEngineTests {
    @Test("An exit with an empty group reports exit then cleared, reaps, never signals")
    func exitWithEmptyGroup() {
        let sim = EngineSimulation()
        sim.spawn()
        sim.group.now = 400
        sim.leaderExits(0)
        #expect(sim.group.reports == [.spawned, .exit(status: 0), .cleared])
        #expect(sim.group.signals.isEmpty)
        #expect(sim.group.leader == .reaped)
        #expect(sim.engine.phase == .finished)
        #expect(sim.engine.exitCode == 0)
    }

    @Test("After any exit, what remains is stopped: SIGTERM at once, cleared when empty")
    func exitLeavesMembers() {
        let sim = EngineSimulation()
        sim.group.others = 1
        sim.spawn()
        sim.group.now = 1_000
        sim.leaderExits(0)
        #expect(sim.group.signalNames == ["TERM@1000"])
        sim.run(until: 2_000)
        #expect(sim.group.reports == [.spawned, .exit(status: 0), .cleared])
        #expect(sim.engine.phase == .finished)
    }

    @Test("Stop: SIGTERM, wait 10 s, one SIGKILL, then cleared")
    func stopSequenceTiming() {
        let sim = EngineSimulation()
        sim.group.leaderDiesOn = [SIGKILL]
        sim.spawn()
        sim.group.now = 1_000
        sim.engine.stopRequested(now: 1_000)
        sim.run(until: 10_950)
        #expect(sim.group.signalNames == ["TERM@1000"])
        sim.run(until: 12_000)
        #expect(sim.group.signalNames == ["TERM@1000", "KILL@11000"])
        #expect(sim.group.reports == [.spawned, .exit(status: SIGKILL), .cleared])
        #expect(sim.engine.groupCleared)
        #expect(!sim.group.signalledAfterReap)
    }

    @Test("Survivors: uncleared after the 2 s probe, SIGKILL every 5 s, cleared when empty")
    func survivorsGiveUncleared() {
        let sim = EngineSimulation()
        sim.group.others = 1
        sim.group.othersDieOn = []
        sim.spawn()
        sim.engine.stopRequested(now: 0)
        sim.run(until: 11_950)
        #expect(sim.group.reports == [.spawned, .exit(status: SIGTERM)])
        sim.run(until: 12_000)
        #expect(sim.group.reports == [.spawned, .exit(status: SIGTERM), .uncleared])
        #expect(sim.engine.phase == .uncleared)
        #expect(sim.group.leader == .zombie, "the zombie leader keeps the group id reserved")
        sim.run(until: 22_000)
        #expect(sim.group.signalNames == ["TERM@0", "KILL@10000", "KILL@17000", "KILL@22000"])
        sim.group.others = 0
        sim.run(until: 30_000)
        #expect(sim.group.reports == [.spawned, .exit(status: SIGTERM), .uncleared, .cleared])
        #expect(sim.group.now == 27_000)
        #expect(sim.group.leader == .reaped)
    }

    @Test("A stop while uncleared is the cleanup retry: one SIGKILL and a 2 s probe")
    func retryWhileUncleared() {
        let sim = EngineSimulation()
        sim.group.others = 1
        sim.group.othersDieOn = []
        sim.spawn()
        sim.engine.stopRequested(now: 0)
        sim.run(until: 13_000)
        sim.engine.stopRequested(now: 13_000)
        #expect(sim.group.signalNames.last == "KILL@13000")
        #expect(sim.engine.phase == .retrying)
        sim.run(until: 15_000)
        #expect(sim.group.reports == [.spawned, .exit(status: SIGTERM), .uncleared, .uncleared])
        sim.group.others = 0
        sim.group.now = 16_000
        sim.engine.stopRequested(now: 16_000)
        #expect(sim.group.reports.last == .cleared)
        #expect(sim.engine.phase == .finished)
    }

    @Test("App gone: SIGTERM at once, SIGKILL at 3 s, cleared, exit")
    func appGoneWhileRunning() {
        let sim = EngineSimulation()
        sim.group.leaderDiesOn = [SIGKILL]
        sim.group.others = 1
        sim.group.othersDieOn = [SIGKILL]
        sim.spawn()
        sim.group.now = 5_000
        sim.engine.appGone(now: 5_000)
        sim.run(until: 7_950)
        #expect(sim.group.signalNames == ["TERM@5000"])
        sim.run(until: 11_000)
        #expect(sim.group.signalNames == ["TERM@5000", "KILL@8000"])
        #expect(sim.engine.phase == .finished)
        #expect(sim.group.now <= 8_050)
        #expect(sim.group.reports.last == .cleared)
    }

    @Test("App gone during a Stop's wait cuts the wait to the 3 s bound")
    func appGoneCutsStopWait() {
        let sim = EngineSimulation()
        sim.group.leaderDiesOn = [SIGKILL]
        sim.spawn()
        sim.engine.stopRequested(now: 0)
        sim.run(until: 1_000)
        sim.engine.appGone(now: 1_000)
        sim.run(until: 12_000)
        #expect(sim.group.signalNames == ["TERM@0", "KILL@4000"])
        #expect(sim.engine.phase == .finished)
        #expect(sim.group.now <= 4_050)
    }

    @Test("App gone with members that survive SIGKILL: exit at 6 s without reaping")
    func appGoneWithSurvivors() {
        let sim = EngineSimulation()
        sim.group.others = 1
        sim.group.othersDieOn = []
        sim.spawn()
        sim.engine.appGone(now: 0)
        sim.run(until: 20_000)
        #expect(sim.engine.phase == .finished)
        #expect(sim.engine.exitCode == 1)
        #expect(sim.group.now == 6_000, "lives at most 6 s after the app is gone")
        #expect(sim.group.leader == .zombie, "never reaped while members remain")
        #expect(sim.group.signalNames == ["TERM@0", "KILL@3000", "KILL@6000"])
    }

    @Test("App gone before the CLI is spawned: nothing is spawned or signalled")
    func appGoneBeforeSpawn() {
        let sim = EngineSimulation()
        sim.engine.appGone(now: 0)
        #expect(sim.engine.phase == .finished)
        #expect(sim.engine.exitCode == 3)
        sim.spawn()
        sim.engine.stopRequested(now: 0)
        #expect(sim.group.reports.isEmpty)
        #expect(sim.group.signals.isEmpty)
    }

    @Test("A stop that arrives before the spawn runs right after it")
    func stopBeforeSpawn() {
        let sim = EngineSimulation()
        sim.engine.stopRequested(now: 0)
        #expect(sim.group.signals.isEmpty)
        sim.spawn()
        #expect(sim.group.signalNames == ["TERM@0"])
        sim.run(until: 1_000)
        #expect(sim.group.reports == [.spawned, .exit(status: SIGTERM), .cleared])
    }

    @Test("Once the leader is reaped, nothing ever signals the group again")
    func neverSignalsAfterReap() {
        let sim = EngineSimulation()
        sim.spawn()
        sim.leaderExits(0)
        #expect(sim.group.leader == .reaped)
        sim.engine.stopRequested(now: 100)
        sim.engine.appGone(now: 200)
        sim.engine.tick(now: 60_000)
        #expect(sim.group.signals.isEmpty)
        #expect(!sim.group.signalledAfterReap)
        #expect(!sim.group.reapedWhileAlive)
    }

    @Test("A failed control write means the app is gone: reporting stops, cleanup runs")
    func failedWriteStartsCleanup() {
        let sim = EngineSimulation()
        sim.group.reportsFail = true
        sim.group.leaderDiesOn = [SIGKILL]
        sim.spawn()
        #expect(!sim.engine.reporting)
        #expect(sim.engine.appIsGone)
        #expect(sim.group.signalNames == ["TERM@0"])
        sim.run(until: 7_000)
        #expect(sim.group.signalNames == ["TERM@0", "KILL@3000"])
        #expect(sim.group.reports == [.spawned], "nothing more is written after the failed write")
        #expect(sim.engine.phase == .finished)
    }

    @Test("A leader that moved itself into another group is never reported cleared or reaped while it runs")
    func leaderLeftGroupOnStop() {
        let sim = EngineSimulation()
        sim.group.leaderInGroup = false
        sim.spawn()
        sim.group.now = 1_000
        sim.engine.stopRequested(now: 1_000)
        #expect(sim.group.signalNames == ["TERM@1000"], "the driver signals the leader itself too")
        sim.run(until: 2_000)
        #expect(sim.group.reports == [.spawned, .exit(status: SIGTERM), .cleared], "cleared only after its exit")
        #expect(!sim.group.reapedWhileAlive)

        // One that ignores SIGTERM: still a member until the SIGKILL at 10 s ends it.
        let stubborn = EngineSimulation()
        stubborn.group.leaderInGroup = false
        stubborn.group.leaderDiesOn = [SIGKILL]
        stubborn.spawn()
        stubborn.engine.stopRequested(now: 0)
        stubborn.run(until: 9_950)
        #expect(stubborn.group.reports == [.spawned], "an empty group probe does not clear a live leader")
        #expect(stubborn.group.leader == .alive)
        stubborn.run(until: 11_000)
        #expect(stubborn.group.signalNames == ["TERM@0", "KILL@10000"])
        #expect(stubborn.group.reports == [.spawned, .exit(status: SIGKILL), .cleared])
        #expect(!stubborn.group.reapedWhileAlive)
        #expect(!stubborn.group.anyoneAlive)
    }

    @Test("App gone with a leader outside its group: SIGTERM, SIGKILL at 3 s, cleared only once it exited")
    func leaderLeftGroupAppGone() {
        let sim = EngineSimulation()
        sim.group.leaderInGroup = false
        sim.group.leaderDiesOn = [SIGKILL]
        sim.spawn()
        sim.engine.appGone(now: 0)
        #expect(sim.engine.phase == .appGone, "not finished at once on an empty group probe")
        sim.run(until: 7_000)
        #expect(sim.group.signalNames == ["TERM@0", "KILL@3000"])
        #expect(sim.group.reports == [.spawned, .exit(status: SIGKILL), .cleared])
        #expect(!sim.group.reapedWhileAlive)
        #expect(sim.engine.phase == .finished)
    }

    @Test("A failed probe is not an empty group: never cleared or reaped on it")
    func failedProbeIsNotEmpty() {
        // Stop: the leader and its child die on SIGTERM, but the probe cannot say so.
        let stop = EngineSimulation()
        stop.group.others = 1
        stop.group.probeFails = true
        stop.spawn()
        stop.engine.stopRequested(now: 0)
        stop.run(until: 12_000)
        #expect(stop.group.reports == [.spawned, .exit(status: SIGTERM), .uncleared])
        #expect(stop.group.leader == .zombie, "not reaped: the group id stays reserved")
        #expect(stop.group.signalNames == ["TERM@0", "KILL@10000"])
        stop.group.probeFails = false
        stop.run(until: 20_000)
        #expect(stop.group.reports.last == .cleared, "cleared at the next re-probe that works")
        #expect(stop.group.leader == .reaped)

        // The leader exits on its own: a failed probe stops what may remain.
        let exit = EngineSimulation()
        exit.group.probeFails = true
        exit.spawn()
        exit.leaderExits(0)
        #expect(exit.group.reports == [.spawned, .exit(status: 0)])
        #expect(exit.group.signalNames == ["TERM@0"])
        #expect(exit.engine.phase == .stopping)
        #expect(exit.group.leader == .zombie)

        // App gone: exit at 6 s without reaping, reporting uncleared.
        let gone = EngineSimulation()
        gone.group.probeFails = true
        gone.spawn()
        gone.engine.appGone(now: 0)
        gone.run(until: 20_000)
        #expect(gone.engine.exitCode == 1)
        #expect(gone.group.now == 6_000)
        #expect(gone.group.reports == [.spawned, .exit(status: SIGTERM), .uncleared])
        #expect(gone.group.leader == .zombie)
    }

    @Test("A spawn failure reports spawn-failed and finishes")
    func spawnFailed() {
        let sim = EngineSimulation()
        sim.engine.spawnFailed(now: 0)
        #expect(sim.group.reports == [.spawnFailed])
        #expect(sim.engine.exitCode == 2)
        #expect(sim.group.signals.isEmpty)
    }
}

@Suite("Supervisor control protocol")
struct ControlProtocolTests {
    @Test("Every message round-trips through its one line")
    func roundTrip() {
        let messages: [SupervisorMessage] = [.spawned, .spawnFailed, .exit(status: 0), .exit(status: 256),
                                             .exit(status: 9), .exit(status: -1), .cleared, .uncleared]
        for message in messages {
            #expect(SupervisorMessage(line: message.line) == message)
            #expect(message.wireBytes.last == 0x0A)
            #expect(message.wireBytes.allSatisfy { $0 < 0x80 })
        }
        #expect(SupervisorCommand(line: "stop") == .stop)
        #expect(SupervisorCommand.stop.wireBytes == Array("stop\n".utf8))
    }

    @Test("Anything but the fixed lines is refused", arguments: [
        "", "Spawned", "spawned ", "exit", "exit ", "exit 01", "exit +1", "exit -0", "exit 1 2",
        "exit 99999999999", "cleared!", "invented text", "stop"
    ])
    func refusesUnknown(_ line: String) {
        #expect(SupervisorMessage(line: line) == nil)
    }

    @Test("The splitter splits on newline only and drops an overlong line whole")
    func splitter() {
        var splitter = ControlLineSplitter()
        #expect(splitter.append(Array("spaw".utf8)).isEmpty)
        #expect(splitter.append(Array("ned\nexit 0\ncle".utf8)) == ["spawned", "exit 0"])
        let long = Array(String(repeating: "x", count: 100).utf8)
        #expect(splitter.append(Array("ared\n".utf8) + long + Array("\nuncleared\n".utf8)) == ["cleared", "uncleared"])
        #expect(splitter.append(Array("stop\u{2028}\n".utf8)) == [], "non-ASCII never matches a line")
        #expect(splitter.append(Array("stop\n".utf8)) == ["stop"])
    }
}
