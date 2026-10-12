import Darwin
import Foundation
@testable import ParticipantProcess
import ParticipantSupervisorCore
import Testing

/// Every test that starts processes runs one at a time, so timings are not
/// skewed by each other. Each starts only the real supervisor (or its test
/// build), the fake CLI, the test host and `/bin/sleep` or `/usr/bin/true`;
/// never the real CLI.
@Suite("Participant processes", .serialized)
struct ProcessSuites {}

func realPath(_ path: String) -> String {
    guard let resolved = realpath(path, nil) else { return path }
    defer { free(resolved) }
    return String(cString: resolved)
}

func measured(_ label: String, _ values: [(String, Double?)]) {
    let parts = values.map { "\($0.0)=\($0.1.map { String(format: "%.2fs", $0) } ?? "none")" }
    print("[measure] \(label): \(parts.joined(separator: " "))")
}

extension ProcessSuites {
    @Suite("Spawner and supervisor with the fake CLI")
    struct Live {
        @Test("Completion: started, text, completed; exact argv, environment, folder, stdin, descriptors; textless log")
        func completion() async throws {
            let live = try LiveRun(.lines(Invented.passingStream(["Invented ", "reply ", "text"])))
            let group = try await live.folder.waitForPid("cli.pid")
            let elapsed = try await live.collector.wait(seconds: 10, for: "release") { $0.released }
            let events = live.collector.events
            #expect(events.map(\.type) == [.started, .text, .completed])
            #expect(events.map(\.sequence) == [1, 2, 3])
            #expect(events.first { $0.type == .text }?.text == "Invented reply text")
            #expect(events.allSatisfy { $0.runId == "51000000-0000-4000-8000-0000000000aa" && $0.sessionId == "invented-session-id" })
            #expect(events.allSatisfy { ($0.reason == nil) == ($0.type != .stopped && $0.type != .failed) })
            #expect(events.allSatisfy { ParticipantTimestamp.parse($0.at).map { $0 >= 1_700_000_000_000 } == true })
            let snapshot = live.run.snapshot
            #expect(snapshot.groupCleared == true)
            #expect(snapshot.cleanup == .released)
            #expect(snapshot.lastSequence == 3)

            let record = try await live.folder.waitForCLIRecord()
            #expect(record["argv"] as? [String] == ParticipantCommandLine.arguments(model: Invented.model))
            let environment = live.folder.environment
            #expect(record["env"] as? [String] == [
                "HOME=\(environment["HOME"]!)", "USER=invented-user", "TMPDIR=\(environment["TMPDIR"]!)",
                "LANG=en_US.UTF-8", "PATH=/usr/bin:/bin:/usr/sbin:/sbin"
            ])
            #expect(record["cwd"] as? String == realPath(live.workingFolder.path))
            #expect(record["stdin"] as? String == LiveRun.input)
            #expect(record["fds"] as? [Int] == [0, 1, 2], "the CLI inherits only stdin, stdout and stderr")
            #expect(record["pgid"] as? Int == record["pid"] as? Int, "the CLI leads its own group")
            #expect(try FileManager.default.contentsOfDirectory(atPath: live.workingFolder.path).isEmpty)

            try await live.collector.wait(seconds: 10, for: "stream end") { $0.isFinished }
            let lines = live.log.entries.map(\.line)
            #expect(lines.contains("run=51000000-0000-4000-8000-0000000000aa kind=event event=text sequence=2 bytes=19"))
            for line in lines {
                #expect(!line.contains("nvented"), "no text in the log: \(line)")
                #expect(!line.contains("/"), "no path in the log: \(line)")
            }
            #expect(!live.process.sendStop(), "the supervisor is gone; stop goes nowhere")
            measured("completion", [("released", elapsed)])
            await live.finish(group: group)
        }

        @Test("Stop: supervisor in its own group with five descriptors; stopped local-stop once the group is gone")
        func stop() async throws {
            let live = try LiveRun(.lines([Invented.initLine(), Invented.rateLimit(), Invented.messageStart,
                                          Invented.blockStart(0), Invented.textDelta("partial")], then: ["hang": true]))
            let cli = try await live.folder.waitForPid("cli.pid")
            try await live.collector.wait(seconds: 10, for: "text") { $0.events.contains { $0.type == .text } }

            let supervisor = live.process.supervisorProcessID
            #expect(Processes.groupOf(supervisor) == supervisor, "the supervisor leads its own group")
            #expect(Processes.groupOf(cli) == cli, "the CLI leads another group")
            #expect(Processes.groupOf(cli) != getpgrp())
            let descriptors = Processes.descriptors(of: supervisor).sorted { $0.fd < $1.fd }
            #expect(descriptors.prefix(5).map(\.fd) == [0, 1, 2, 3, 4])
            #expect(descriptors.prefix(5).map(\.type) == [UInt32(PROX_FDTYPE_VNODE), UInt32(PROX_FDTYPE_VNODE),
                                                          UInt32(PROX_FDTYPE_VNODE), UInt32(PROX_FDTYPE_PIPE),
                                                          UInt32(PROX_FDTYPE_SOCKET)],
                    "0-2 are /dev/null once the CLI holds its pipes; 3 is the lifeline, 4 the control socket")
            #expect(descriptors.dropFirst(5).map(\.type) == [UInt32(PROX_FDTYPE_KQUEUE)], "plus its own kqueue, nothing else")

            let start = ContinuousClock.now
            live.run.stop()
            let elapsed = try await live.collector.wait(seconds: 5, for: "release") { $0.released }
            let events = live.collector.events
            #expect(events.map(\.type) == [.started, .text, .stopped])
            #expect(events.last?.reason == "local-stop")
            #expect(live.run.snapshot.groupCleared == true)
            #expect(elapsed < 3)
            measured("stop", [("stopped", Processes.elapsed(since: start))])
            await live.finish(group: cli)
        }

        @Test("An unsanitized launch environment: the supervisor itself and the CLI both start with only the allow-list")
        func unsanitizedEnvironment() async throws {
            // Invented values only. None is a real key, library or folder.
            let live = try LiveRun(.lines([Invented.initLine(), Invented.rateLimit()], then: ["hang": true])) { folder in
                let allowed = folder.environment
                return [
                    "DYLD_FALLBACK_LIBRARY_PATH=/invented/lib", "DYLD_FRAMEWORK_PATH=/invented/frameworks",
                    "HOME=\(allowed["HOME"]!)", "HOME=/invented/second-home", "USER=invented-user",
                    "TMPDIR=\(allowed["TMPDIR"]!)", "LANG=en_US.UTF-8", "LC_ALL=",
                    "PATH=/invented/bin:/usr/bin", "ANTHROPIC_API_KEY=invented-not-a-key",
                    "ANTHROPIC_BASE_URL=http://invented.invalid", "CLAUDE_CODE_USE_BEDROCK=1",
                    "MallocStackLogging=1", "INVENTED_APP_VARIABLE=invented", "NOT-AN-ENTRY"
                ]
            }
            let cli = try await live.folder.waitForPid("cli.pid")
            try await live.collector.wait(seconds: 10, for: "started") { $0.events.contains { $0.type == .started } }

            let environment = live.folder.environment
            let expected = [
                "HOME=\(environment["HOME"]!)", "USER=invented-user", "TMPDIR=\(environment["TMPDIR"]!)",
                "LANG=en_US.UTF-8", "PATH=/usr/bin:/bin:/usr/sbin:/sbin"
            ]
            let supervisor = try #require(Processes.initialEnvironment(of: live.process.supervisorProcessID),
                                          "the supervisor's start environment could be read")
            #expect(supervisor == expected, "the supervisor process itself starts with only the allow-list")
            #expect(!supervisor.contains { $0.hasPrefix("DYLD_") || $0.hasPrefix("ANTHROPIC_") || $0.hasPrefix("Malloc") })
            let record = try await live.folder.waitForCLIRecord()
            #expect(record["env"] as? [String] == expected, "and so does the CLI")

            live.run.stop()
            try await live.collector.wait(seconds: 5, for: "release") { $0.released }
            #expect(live.collector.events.last?.reason == "local-stop")
            await live.finish(group: cli)
        }

        @Test("Stop with a SIGTERM-ignoring CLI and a forked child: one SIGKILL at 10 s, then local-stop")
        func stopIgnoringTerm() async throws {
            var scenario = FakeCLIFolder.Scenario.lines([Invented.initLine(), Invented.rateLimit()], then: ["hang": true])
            scenario.sigterm = "ignore"
            scenario.child = "ignore-term"
            let live = try LiveRun(scenario)
            let cli = try await live.folder.waitForPid("cli.pid")
            let child = try await live.folder.waitForPid("child.pid")
            try await live.collector.wait(seconds: 10, for: "started") { $0.events.contains { $0.type == .started } }
            #expect(Set(Processes.members(cli)) == [cli, child])

            let start = ContinuousClock.now
            live.run.stop()
            try await Task.sleep(nanoseconds: 9_000_000_000)
            #expect(Processes.isRunning(cli) && Processes.isRunning(child), "SIGTERM is ignored; no SIGKILL before 10 s")
            #expect(live.collector.terminal == nil)
            let elapsed = try await live.collector.wait(seconds: 6, for: "release") { $0.released }
            let total = Processes.elapsed(since: start)
            #expect(live.collector.terminal?.reason == "local-stop")
            #expect(live.run.snapshot.groupCleared == true)
            #expect(total >= 9.9 && total < 12.5)
            #expect(Processes.members(cli).isEmpty)
            #expect(!Processes.isRunning(child))
            measured("stop-ignoring-term", [("stopped", total), ("after-9s", elapsed)])
            await live.finish(group: cli)
        }

        @Test("stop-incomplete when a member survives SIGKILL; the retry clears it later")
        func stopIncomplete() async throws {
            let live = try LiveRun(.lines([Invented.initLine()], then: ["hang": true]))
            let cli = try await live.folder.waitForPid("cli.pid")
            try await live.collector.wait(seconds: 10, for: "started") { $0.events.contains { $0.type == .started } }
            // A finished child of this test that joins the CLI's group: a zombie
            // member no signal removes until this test reaps it.
            let zombie = try #require(Processes.spawnZombieMember(of: cli))
            defer { Processes.reap(zombie) }
            #expect(Processes.members(cli).contains(zombie))

            let start = ContinuousClock.now
            live.run.stop()
            try await live.collector.wait(seconds: 15, for: "terminal") { $0.terminal != nil }
            let stopIncompleteAt = Processes.elapsed(since: start)
            #expect(live.collector.terminal?.type == .stopped)
            #expect(live.collector.terminal?.reason == "stop-incomplete")
            #expect(live.run.snapshot.groupCleared == false)
            #expect(live.run.snapshot.cleanup == .owned)
            #expect(stopIncompleteAt >= 11.9 && stopIncompleteAt < 14)
            #expect(Processes.members(cli).contains(cli), "the zombie leader keeps the group id reserved")

            Processes.reap(zombie)
            let retry = ContinuousClock.now
            live.run.stop()
            try await live.collector.wait(seconds: 5, for: "release") { $0.released }
            #expect(live.collector.updates.contains(.groupCleared))
            #expect(live.run.snapshot.groupCleared == true)
            #expect(live.collector.events.filter { [.completed, .stopped, .failed].contains($0.type) }.count == 1)
            measured("stop-incomplete", [("uncleared", stopIncompleteAt), ("retry-cleared", Processes.elapsed(since: retry))])
            await live.finish(group: cli)
        }

        @Test("A CLI leader that moved itself into another group: Stop ends it before the group is reported cleared")
        func leaderLeftGroupStop() async throws {
            var scenario = FakeCLIFolder.Scenario.lines([Invented.initLine(), Invented.rateLimit()], then: ["hang": true])
            scenario.leaveGroup = true
            let live = try LiveRun(scenario)
            let cli = try await live.folder.waitForPid("cli.pid")
            try await live.collector.wait(seconds: 10, for: "started") { $0.events.contains { $0.type == .started } }
            #expect(live.folder.record("moved.json")?["result"] as? Int == 0, "setpgid into the supervisor's group is allowed")
            #expect(Processes.groupOf(cli) == live.process.supervisorProcessID, "the leader left its own group")
            #expect(Processes.members(cli).isEmpty, "nothing is left in the CLI's group")

            live.run.stop()
            try await live.collector.wait(seconds: 5, for: "release") { $0.released }
            #expect(!Processes.isRunning(cli), "cleared only once the leader itself is gone")
            #expect(live.collector.terminal?.reason == "local-stop")
            #expect(live.run.snapshot.groupCleared == true)
            await live.finish(group: cli)
        }

        @Test("A run its owner lets go of still applies the overflow rule: the CLI is stopped, then the run is freed")
        func droppedRunStillStops() async throws {
            var scenario = FakeCLIFolder.Scenario()
            scenario.steps = [["out": Invented.initLine()], ["sleepMs": 1_000],
                              ["out": Invented.rateLimit(overageStatus: "allowed", isUsingOverage: true)], ["hang": true]]
            let folder = try FakeCLIFolder(scenario)
            let workingFolder = try ParticipantWorkingFolder.create(under: folder.workParent)
            weak var weakRun: ParticipantRun?
            let collector: UpdateCollector
            let supervisor: pid_t
            do {
                let process = try ParticipantProcessSpawner().spawn(LiveRun.launch(folder: folder, workingFolder: workingFolder))
                supervisor = process.supervisorProcessID
                let run = LiveRun.makeRun(process: process, log: RecordingLog())
                weakRun = run
                collector = UpdateCollector(run)
            }
            defer { folder.clean(also: [supervisor]) }
            // Nothing in this test holds the run or its process any more.
            let cli = try await folder.waitForPid("cli.pid")
            let stopped = await Processes.waitUntil(seconds: 6) { !Processes.isRunning(cli) && !Processes.isRunning(supervisor) }
            #expect(stopped != nil, "the overflow message stopped the CLI though no one holds the run")
            #expect(collector.events.map(\.type) == [.started, .failed])
            #expect(collector.terminal?.reason == "paid-overflow")
            let freed = await Processes.waitUntil(seconds: 5) { weakRun == nil }
            #expect(freed != nil, "the run is freed once its process has ended")
            try await collector.wait(seconds: 5, for: "stream end") { $0.isFinished }
        }

        @Test("A CLI that cannot be spawned: failed process-error at sequence 1, groupCleared null")
        func spawnFailure() async throws {
            let live = try LiveRun(.lines([]), missingCLI: true)
            try await live.collector.wait(seconds: 5, for: "release") { $0.released }
            #expect(live.collector.events.map(\.type) == [.failed])
            #expect(live.collector.events.first?.sequence == 1)
            #expect(live.collector.events.first?.reason == "process-error")
            #expect(live.run.snapshot.groupCleared == nil)
            #expect(live.log.entries.contains { $0.kind == .cliSpawnFailed })
            await live.finish(group: nil)
        }

        @Test("Paid overflow from the process: nothing shown, run ended, group cleared")
        func paidOverflow() async throws {
            let live = try LiveRun(.lines([Invented.initLine(), Invented.messageStart, Invented.blockStart(0),
                                          Invented.textDelta("never shown"),
                                          Invented.rateLimit(overageStatus: "allowed", isUsingOverage: true)],
                                         then: ["hang": true]))
            let cli = try await live.folder.waitForPid("cli.pid")
            try await live.collector.wait(seconds: 5, for: "release") { $0.released }
            #expect(live.collector.events.map(\.type) == [.started, .failed])
            #expect(live.collector.terminal?.reason == "paid-overflow")
            #expect(live.run.snapshot.groupCleared == true)
            await live.finish(group: cli)
        }

        @Test("An init that breaks the rule ends the run: failed process-error at sequence 1")
        func initMismatch() async throws {
            let live = try LiveRun(.lines([Invented.initLine(tools: ["Bash"]), Invented.rateLimit()], then: ["hang": true]))
            let cli = try await live.folder.waitForPid("cli.pid")
            try await live.collector.wait(seconds: 5, for: "release") { $0.released }
            #expect(live.collector.events.map(\.type) == [.failed])
            #expect(live.collector.events.first?.sequence == 1)
            #expect(live.collector.events.first?.reason == "process-error")
            await live.finish(group: cli)
        }

        @Test("Supervisor loss: SIGKILL only the supervisor; failed process-error, owned until the pipes close")
        func supervisorLoss() async throws {
            var scenario = FakeCLIFolder.Scenario.lines([Invented.initLine(), Invented.rateLimit(), Invented.messageStart,
                                                         Invented.blockStart(0), Invented.textDelta("before")],
                                                        then: ["hang": true])
            scenario.child = "ignore-term"
            let live = try LiveRun(scenario)
            let cli = try await live.folder.waitForPid("cli.pid")
            let child = try await live.folder.waitForPid("child.pid")
            try await live.collector.wait(seconds: 10, for: "text") { $0.events.contains { $0.type == .text } }

            let supervisor = live.process.supervisorProcessID
            _ = kill(supervisor, SIGKILL)
            let lostAfter = try await live.collector.wait(seconds: 5, for: "terminal") { $0.terminal != nil }
            #expect(live.collector.terminal?.type == .failed)
            #expect(live.collector.terminal?.reason == "process-error")
            #expect(live.run.snapshot.groupCleared == false)
            try await Task.sleep(nanoseconds: 500_000_000)
            #expect(live.run.snapshot.cleanup == .owned, "the CLI still holds its pipes")
            #expect(Processes.isRunning(cli) && Processes.isRunning(child), "nothing signalled the group")
            #expect(live.log.entries.contains { $0.kind == .supervisorLost })

            // The test, not native, kills the fake by its own recorded ids.
            let killed = ContinuousClock.now
            _ = kill(cli, SIGKILL)
            _ = kill(child, SIGKILL)
            let released = try await live.collector.wait(seconds: 5, for: "release") { $0.released }
            #expect(live.run.snapshot.groupCleared == false, "never later set true")
            let empty = await Processes.waitUntil(seconds: 10) { Processes.members(cli).isEmpty }
            #expect(empty != nil)
            #expect(!Processes.isRunning(supervisor))
            measured("supervisor-loss", [("terminal", lostAfter), ("released-after-kill", released),
                                         ("group-empty", Processes.elapsed(since: killed))])
            await live.finish(group: cli)
        }
    }
}
