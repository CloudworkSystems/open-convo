import Darwin
import DeskHost
import Foundation
@testable import ParticipantProcess
import ParticipantSupervisorCore
import Testing

// Codex's S5 review, fixes R1 and N1. R1: a paid-overflow signal that
// arrives after another end was decided still ends a confirmation (contract
// section 17), through one `overflowObserved` update apart from the terminal.
// N1: a working folder the filesystem will not remove is reported, not
// assumed gone. Invented data only; the one live case starts the real
// supervisor and the fake CLI, never the real CLI, and the spawn-failure
// case runs /bin/chmod on its own invented folders only.

extension ReaderHarness {
    var observed: Int { outputs.filter { $0 == .overflowObserved }.count }
    mutating func limitReached() { outputs += reader.stdoutLimitReached(now: now) }
    mutating func finishing() { outputs += reader.updatesFinishing() }
}

enum OverflowFixture {
    /// A rate-limit message that fails the overflow rule.
    static let signal = Invented.rateLimit(overageStatus: "allowed", isUsingOverage: true)
    /// Vector #48's delta: with 41 bytes of room, é (2 bytes) after 40 cannot fit.
    static let oversized = "Four. Invented reply with an accent: caf\u{E9}, and more"
    static let fitting = "Four. Invented reply with an accent: caf"
    static let room = 41

    /// Init, a passing rate limit and a text block, at +100: ready for `oversized`.
    static func opened() -> ReaderHarness {
        var run = ReaderHarness(inputBytes: 262_144 - room)
        run.spawned()
        run.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0)])
        run.now = 100
        return run
    }

    static func line(_ text: String) -> Data { Data((text + "\n").utf8) }
}

@Suite("Overflow observed apart from the terminal (contract section 17; S5 fix R1)")
struct OverflowObservationTests {
    // MARK: Reader

    @Test("An overflow line after the oversized delta, in its chunk, a later chunk or split across both: the fitting text, reply-too-long once, the same outputs otherwise, and overflowObserved exactly once",
          arguments: ["same chunk", "later chunk", "split line"])
    func afterOversizedDelta(_ delivery: String) {
        var baseline = OverflowFixture.opened()
        baseline.feed([Invented.textDelta(OverflowFixture.oversized)])
        baseline.now = 200
        baseline.ends(SIGTERM)

        var run = OverflowFixture.opened()
        let delta = OverflowFixture.line(Invented.textDelta(OverflowFixture.oversized))
        let signal = OverflowFixture.line(OverflowFixture.signal)
        switch delivery {
        case "same chunk":
            run.feedBytes(delta + signal)
        case "later chunk":
            run.feedBytes(delta)
            #expect(run.observed == 0 && run.texts == [OverflowFixture.fitting], "decided at the delta")
            run.now = 150
            run.feedBytes(signal)
        default:
            let cut = signal.count / 2
            run.feedBytes(delta + signal.prefix(cut))
            #expect(run.observed == 0, "half a line is not read")
            run.now = 150
            run.feedBytes(signal.dropFirst(cut))
        }
        #expect(run.observed == 1)
        run.feed([OverflowFixture.signal, Invented.textDelta(" more"), Invented.result()])
        run.now = 200
        run.ends(SIGTERM)

        #expect(run.observed == 1, "once")
        #expect(run.texts == [OverflowFixture.fitting])
        #expect(run.terminal == .terminal(.failed(.replyTooLong), groupCleared: true) && run.terminals.count == 1)
        #expect(run.outputs.filter { $0 != .overflowObserved } == baseline.outputs, "text, order and terminal unchanged")
        #expect(baseline.observed == 0)
    }

    @Test("After a Stop, and after a timeout decided with half the signal's line buffered: observed once, terminal unchanged")
    func afterOtherDecisions() {
        var stopped = ReaderHarness()
        stopped.spawned()
        stopped.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0),
                      Invented.textDelta("accepted")])
        stopped.stop()
        let decided = stopped.outputs
        stopped.feed([Invented.textDelta(" later"), Invented.rateLimit(), OverflowFixture.signal, OverflowFixture.signal])
        #expect(stopped.outputs == decided + [.overflowObserved], "only the observation; the later text is dropped")
        stopped.ends(SIGTERM)
        #expect(stopped.texts == ["accepted"])
        #expect(stopped.terminal == .terminal(.stopped(.localStop), groupCleared: true) && stopped.terminals.count == 1)
        #expect(stopped.observed == 1)

        var timedOut = ReaderHarness()
        timedOut.spawned()
        timedOut.feed([Invented.initLine()])
        let signal = OverflowFixture.line(OverflowFixture.signal)
        timedOut.feedBytes(signal.prefix(10))
        timedOut.advance(120_000)
        #expect(timedOut.sentStop && timedOut.observed == 0, "quiet timeout decided; the partial line is kept")
        timedOut.feedBytes(signal.dropFirst(10))
        #expect(timedOut.observed == 1)
        timedOut.ends(SIGTERM)
        #expect(timedOut.terminal == .terminal(.failed(.timeout), groupCleared: true) && timedOut.terminals.count == 1)
    }

    @Test("A paid-overflow end is itself the observation, once: each failing rate limit, a result before any; one before init observes and stays process-error",
          arguments: StreamJSONReaderTests.failingRateLimits)
    func paidOverflowEnds(_ line: String) {
        var run = ReaderHarness()
        run.spawned()
        run.feed([Invented.initLine(), Invented.messageStart, Invented.blockStart(0), Invented.textDelta("held"), line,
                  OverflowFixture.signal])
        #expect(run.observed == 1)
        run.ends(SIGTERM)
        #expect(run.observed == 1)
        #expect(run.terminal == .terminal(.failed(.paidOverflow), groupCleared: true))
        #expect(run.texts.isEmpty)
    }

    @Test("Result before any rate limit, and a signal before init: observed once; a passing rate limit before init is not a signal")
    func otherOverflowPaths() {
        var resultFirst = ReaderHarness()
        resultFirst.spawned()
        resultFirst.feed([Invented.initLine(), Invented.result()])
        resultFirst.ends(0)
        #expect(resultFirst.observed == 1 && resultFirst.terminal == .terminal(.failed(.paidOverflow), groupCleared: true))

        var early = ReaderHarness()
        early.spawned()
        early.feed([OverflowFixture.signal, Invented.initLine()])
        early.ends(SIGTERM)
        #expect(early.observed == 1)
        #expect(early.terminal == .terminal(.failed(.processError), groupCleared: true), "the init rule's reason stays")

        var passing = ReaderHarness()
        passing.spawned()
        passing.feed([Invented.rateLimit(), Invented.initLine()])
        passing.ends(SIGTERM)
        #expect(passing.observed == 0)
        #expect(passing.terminal == .terminal(.failed(.processError), groupCleared: true))
    }

    @Test("After process-error from an unreadable line or an init that breaks the rule, and after an end the exit decided before stdout's EOF: a later signal is observed once, terminal and text unchanged")
    func afterLineAndExitDecisions() {
        for (label, opening) in [("unreadable line", [Invented.initLine(), Invented.rateLimit(), "not json"]),
                                 ("init mismatch", [Invented.initLine(tools: ["Bash"])])] {
            var run = ReaderHarness()
            run.spawned()
            run.feed(opening)
            #expect(run.sentStop && run.observed == 0, "\(label): decided, nothing observed yet")
            let decided = run.outputs
            run.feed([Invented.textDelta("later"), OverflowFixture.signal, OverflowFixture.signal])
            #expect(run.outputs == decided + [.overflowObserved], "\(label): only the observation")
            run.ends(SIGTERM)
            #expect(run.observed == 1 && run.texts.isEmpty, "\(label)")
            #expect(run.terminal == .terminal(.failed(.processError), groupCleared: true) && run.terminals.count == 1,
                    "\(label)")
        }

        // The exit and `cleared` overtake stdout: when the 1 s grace ends, the
        // exit decides process-error (no result), the terminal and the
        // release go out, and stdout is still open when the signal comes.
        var exited = ReaderHarness()
        exited.spawned()
        exited.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0),
                     Invented.textDelta("kept")])
        exited.exit(1 << 8)
        exited.cleared()
        exited.advance(1_000)
        #expect(exited.terminal == .terminal(.failed(.processError), groupCleared: true) && exited.released)
        #expect(exited.observed == 0)
        let decided = exited.outputs
        exited.feed([OverflowFixture.signal])
        #expect(exited.outputs == decided + [.overflowObserved])
        exited.stdoutEOF()
        exited.stderrEOF()
        #expect(exited.texts == ["kept"] && exited.terminals.count == 1 && exited.observed == 1)
    }

    @Test("When reading must stop before stdout's EOF, overflow is observed conservatively: a line over 1 MiB, the 32 MiB total, the spawner's limit, the updates finishing without EOF")
    func conservative() {
        func stopped(limits: StreamJSONReaderLimits = .contract) -> ReaderHarness {
            var run = ReaderHarness(limits: limits)
            run.spawned()
            run.feed([Invented.initLine(), Invented.rateLimit()])
            run.stop()
            return run
        }
        // After another decision: each bound ends reading, so it observes.
        var long = stopped()
        long.feedBytes(Data(repeating: 0x20, count: 1_048_576))
        #expect(long.observed == 0, "exactly 1 MiB is still a line")
        long.feedBytes(Data([0x20]))
        #expect(long.observed == 1)

        var limits = StreamJSONReaderLimits.contract
        limits.maxStdoutBytes = 2_048
        var total = stopped(limits: limits)
        #expect(total.reader.stdoutBytes < 2_048)
        total.feedBytes(Data(repeating: 0x20, count: 2_048 - total.reader.stdoutBytes))
        #expect(total.observed == 0, "exactly the bound is still read")
        total.feedBytes(Data([0x20]))
        #expect(total.observed == 1)

        var spawner = stopped()
        spawner.limitReached()
        #expect(spawner.observed == 1)

        var unfinished = stopped()
        unfinished.finishing()
        #expect(unfinished.observed == 1, "stdout's EOF never came")

        for var run in [long, total, spawner, unfinished] {
            run.feed([OverflowFixture.signal])
            run.limitReached()
            run.finishing()
            run.ends(SIGTERM)
            #expect(run.observed == 1, "once; nothing more is read")
            #expect(run.terminal == .terminal(.stopped(.localStop), groupCleared: true) && run.terminals.count == 1)
        }

        // Before any decision, the same bounds decide process-error and observe.
        var undecidedLine = ReaderHarness()
        undecidedLine.spawned()
        undecidedLine.feed([Invented.initLine()])
        undecidedLine.feedBytes(Data(repeating: 0x20, count: 1_048_577))
        var undecidedLimit = ReaderHarness()
        undecidedLimit.spawned()
        undecidedLimit.limitReached()
        for var run in [undecidedLine, undecidedLimit] {
            #expect(run.observed == 1 && run.sentStop)
            run.ends(SIGTERM)
            #expect(run.terminal == .terminal(.failed(.processError), groupCleared: true))
        }
    }

    @Test("No observation for a normal run, or a decided run whose stdout reaches EOF without a signal (later lines, readable or not, and a last line without its newline)")
    func noObservation() {
        var normal = ReaderHarness()
        normal.spawned()
        normal.feed(Invented.passingStream(["Hello", " invented"]))
        normal.ends(0)
        normal.finishing()
        #expect(normal.observed == 0 && normal.terminal == .terminal(.completed, groupCleared: true))

        var long = OverflowFixture.opened()
        long.feed([Invented.textDelta(OverflowFixture.oversized)] + StreamJSONReaderTests.passingRateLimits + [
            Invented.rateLimit(overageStatus: nil), Invented.textDelta(" more"), Invented.result(), "not json",
            "{\"type\":\"rate_limit_event\"}", "{\"type\":\"rate_limit_event\",\"rate_limit_info\":5}",
            Invented.json(["type": "stream_event", "event": ["type": "message_start"]])
        ])
        long.feedBytes(Data(Invented.rateLimit().utf8))
        long.ends(SIGTERM)
        long.finishing()
        #expect(long.observed == 0)
        #expect(long.texts == [OverflowFixture.fitting] && long.terminal == .terminal(.failed(.replyTooLong), groupCleared: true))

        var lastLine = ReaderHarness()
        lastLine.spawned()
        lastLine.feed([Invented.initLine(), Invented.rateLimit()])
        lastLine.stop()
        lastLine.feedBytes(Data(OverflowFixture.signal.utf8))
        #expect(lastLine.observed == 0, "not yet a complete line")
        lastLine.stdoutEOF()
        #expect(lastLine.observed == 1, "complete at EOF: a signal")
    }

    // MARK: Run core

    @Test("The run core carries it as an update, not an event: sequences and the terminal unchanged; owed at the end only when stdout's EOF never came")
    func runCore() {
        var run = CoreHarness(inputBytes: 262_144 - OverflowFixture.room)
        run.control(.spawned)
        run.feed([Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0),
                  Invented.textDelta(OverflowFixture.oversized), OverflowFixture.signal])
        run.ends(SIGTERM)
        #expect(run.updates.filter { $0 == .overflowObserved }.count == 1)
        #expect(run.events.map(\.sequence) == [1, 2, 3] && run.events.map(\.type) == [.started, .text, .failed])
        #expect(run.terminals.map(\.event.reason) == ["reply-too-long"])
        let text = run.effects.firstIndex { if case .update(.event(let event)) = $0 { return event.type == .text } else { return false } }
        let observed = run.effects.firstIndex(of: .update(.overflowObserved))
        #expect(text != nil && observed != nil && text! < observed!, "the decision first, then the later signal")
        let entry = ParticipantLogEntry(runId: CoreHarness.runId, kind: .overflowObserved)
        #expect(entry.line == "run=\(CoreHarness.runId) kind=overflow-observed", "ids and a fixed kind only")
        #expect(run.logs.filter { $0.kind == .overflowObserved } == [entry], "logged once")
        #expect(observed.map { run.effects[$0 + 1] } == .log(entry), "the update, then its log entry")
        #expect(run.logs.contains { $0.kind == .event && $0.reason == .failure(.replyTooLong) }, "the terminal keeps its own entry")
        #expect(run.core.updatesFinishing(wall: run.wall).isEmpty, "stdout's EOF was read")

        var cut = CoreHarness()
        cut.control(.spawned)
        cut.feed([Invented.initLine(), Invented.rateLimit()])
        cut.stop()
        cut.control(.exit(status: SIGTERM))
        cut.control(.cleared)
        #expect(cut.terminals.map(\.event.reason) == ["local-stop"])
        #expect(cut.core.updatesFinishing(wall: cut.wall)
                == [.update(.overflowObserved), .log(ParticipantLogEntry(runId: CoreHarness.runId, kind: .overflowObserved))],
                "no stdout EOF: conservative, and logged")
        #expect(cut.core.updatesFinishing(wall: cut.wall).isEmpty, "once")
    }

    // MARK: Scripted runs (virtual clock)

    static func world(_ script: [ScriptStep], inputBytes: Int = 58, limits: StreamJSONReaderLimits = .contract,
                      processLimits: ParticipantProcessLimits = ParticipantProcessLimits(),
                      before: ((VirtualWorld, ScriptedParticipantRun) throws -> Void)? = nil)
        async throws -> (ScriptedParticipantRun, UpdateCollector) {
        let world = try VirtualWorld(clock: ScriptedRunTimingTests.clock)
        let run = world.launch(identity: ScriptedRunTimingTests.identity(),
                               configuration: ScriptedRunTimingTests.configuration(inputBytes: inputBytes, limits: limits),
                               script: script, processLimits: processLimits)
        let collector = UpdateCollector(run)
        try before?(world, run)
        try world.settle()
        try await collector.wait(seconds: 5, for: "stream end") { $0.isFinished }
        return (run, collector)
    }

    @Test("Scripted run, same chunk: reply-too-long at +100 as vector #48, unchanged events, and overflowObserved once, delivered before the updates finish")
    func scriptedSameChunk() async throws {
        let head = [Invented.messageStart, Invented.blockStart(0), Invented.textDelta(OverflowFixture.oversized)]
        let inputBytes = 262_144 - OverflowFixture.room
        let opening = ScriptedRunTimingTests.opening
        let (baseline, _) = try await Self.world(opening + [ScriptStep(atMs: 100, .line(head.joined(separator: "\n")))],
                                                 inputBytes: inputBytes)
        let (run, collector) = try await Self.world(
            opening + [ScriptStep(atMs: 100, .line((head + [OverflowFixture.signal]).joined(separator: "\n")))],
            inputBytes: inputBytes)
        #expect(run.events == baseline.events, "every event, byte for byte")
        #expect(run.events.map(\.type) == [.started, .text, .failed] && run.events[1].text == OverflowFixture.fitting)
        #expect(run.events.last?.reason == "reply-too-long" && run.events.last?.at == "2026-10-09T00:01:01.100Z")
        #expect(run.recordedUpdates.filter { $0 != .overflowObserved } == baseline.recordedUpdates)
        #expect(run.recordedUpdates.filter { $0 == .overflowObserved }.count == 1)
        #expect(!baseline.recordedUpdates.contains(.overflowObserved))
        #expect(collector.updates == run.recordedUpdates, "the consumer had it before the stream finished")
        checkRunInvariants(collector.updates, "same chunk")
    }

    @Test("Scripted run, later chunk: the supervisor is lost (failed process-error), then the CLI writes a signal; observed once after the terminal, before the updates finish")
    func scriptedLaterChunk() async throws {
        let script = ScriptedRunTimingTests.opening + [ScriptStep(atMs: 100, .textDelta("kept")),
                                                       ScriptStep(atMs: 500, .rateLimitOverageAllowed)]
        let (run, collector) = try await Self.world(script) { world, run in
            try world.at(ms: 400) { world.supervisorDies(run) }
            try world.at(ms: 600) { world.pipesClose(run) }
        }
        #expect(run.events.map(\.type) == [.started, .text, .failed] && run.events.last?.reason == "process-error")
        #expect(run.events.last?.at == "2026-10-09T00:01:01.400Z" && run.terminalUpdate?.groupCleared == false)
        let updates = collector.updates
        let terminal = updates.firstIndex { if case .terminal = $0 { return true } else { return false } }
        let observed = updates.firstIndex(of: .overflowObserved)
        #expect(terminal != nil && observed != nil && terminal! < observed!, "after another decision")
        #expect(updates.filter { $0 == .overflowObserved }.count == 1)
        #expect(updates.last == .cleanupReleased && updates == run.recordedUpdates)
        checkRunInvariants(updates, "later chunk")
    }

    @Test("Scripted run, stdout bounds: the reader's total and the spawner's limit each observe once, terminal process-error unchanged")
    func scriptedBounds() async throws {
        let padding = ScriptStep(atMs: 200, .line(String(repeating: "x", count: 100)))
        var limits = StreamJSONReaderLimits.contract
        limits.maxStdoutBytes = ScriptedRunTimingTests.keptOpeningBytes + 50
        var processLimits = ParticipantProcessLimits()
        processLimits.stdoutBytes = ScriptedRunTimingTests.keptOpeningBytes + 50
        let (reader, _) = try await Self.world(ScriptedRunTimingTests.keptOpening + [padding], limits: limits)
        let (spawner, _) = try await Self.world(ScriptedRunTimingTests.keptOpening + [padding], processLimits: processLimits)
        for (label, run) in [("reader", reader), ("spawner", spawner)] {
            #expect(run.events.map(\.type) == [.started, .text, .failed] && run.events.last?.reason == "process-error", "\(label)")
            #expect(run.recordedUpdates.filter { $0 == .overflowObserved }.count == 1, "\(label)")
            checkRunInvariants(run.recordedUpdates, label)
        }
    }

    @Test("Scripted runs without a signal observe nothing (vectors #27 and #48 as scripted); vector #46's paid-overflow observes once")
    func scriptedVectors() throws {
        let vectors = try ParticipantVectors.load()
        for (number, name, expected) in [(27, "participant.start accepted", 0),
                                         (48, "participant.start reply too long ends after the longest fitting prefix", 0),
                                         (46, "participant.start paid overflow in the stream", 1)] {
            let setup = try VectorRunSetup(number, name, in: vectors)
            let world = try VirtualWorld(clock: setup.clock)
            let run = world.launch(identity: setup.identity, configuration: setup.configuration, script: try setup.script)
            try world.settle()
            #expect(run.recordedUpdates.filter { $0 == .overflowObserved }.count == expected, "#\(number)")
            expectEvents(run.events, equal: setup.pushedEvents, "#\(number)")
        }
    }
}

extension ProcessSuites {
    @Suite("Overflow observed through the real spawner and supervisor (live tier; S5 fix R1)")
    struct OverflowLive {
        @Test("A signal in the same write as text that cannot fit: reply-too-long, one terminal, overflowObserved once before the updates finish")
        func signalAfterReplyTooLong() async throws {
            var limits = StreamJSONReaderLimits.contract
            limits.maxInputPlusOutputBytes = LiveRun.input.utf8.count + OverflowFixture.room
            var scenario = FakeCLIFolder.Scenario()
            // One write under PIPE_BUF: the signal is in the pipe before any stop.
            let tail = Invented.textDelta(OverflowFixture.oversized) + "\n" + OverflowFixture.signal
            #expect(tail.utf8.count + 1 <= 512)
            scenario.steps = [["out": Invented.initLine()], ["out": Invented.rateLimit()], ["out": Invented.messageStart],
                              ["out": Invented.blockStart(0)], ["out": tail], ["hang": true]]
            let live = try LiveRun(scenario, limits: limits)
            let cli = try await live.folder.waitForPid("cli.pid")
            try await live.collector.wait(seconds: 10, for: "stream end") { $0.isFinished }
            #expect(live.collector.events.map(\.type) == [.started, .text, .failed])
            #expect(live.collector.events.filter { $0.type == .text }.map { $0.text ?? "" } == [OverflowFixture.fitting])
            #expect(live.collector.terminal?.reason == "reply-too-long")
            #expect(live.collector.updates.filter { $0 == .overflowObserved }.count == 1)
            checkRunInvariants(live.collector.updates, "live signal after reply-too-long")
            await live.finish(group: cli)
        }
    }
}

// MARK: N1

@Suite("Working folder removal: a refusal is reported, never assumed away (S5 fix N1)")
struct WorkingFolderRemovalTests {
    /// A private temporary parent, and a working folder in it holding an
    /// invented leftover in a subfolder this user may not write, so the
    /// leftover cannot be unlinked. `unlock` makes it removable again.
    struct Refusing {
        let parent: URL
        let folder: ParticipantWorkingFolder
        let locked: String

        init() throws {
            parent = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
                .appendingPathComponent("wf-n1-\(UUID().uuidString.prefix(8))", isDirectory: true)
            try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            folder = try ParticipantWorkingFolder.create(under: parent)
            locked = (folder.path as NSString).appendingPathComponent("invented-locked")
            #expect(mkdir(locked, 0o700) == 0)
            try Data("invented leftover".utf8).write(to: URL(fileURLWithPath: (locked as NSString).appendingPathComponent("file")))
            #expect(chmod(locked, 0o500) == 0)
        }

        func unlock() { _ = chmod(locked, 0o700) }

        func clean() {
            unlock()
            try? FileManager.default.removeItem(at: parent)
        }
    }

    @Test("remove() is true once the folder is gone, also when already gone, and false when the filesystem refuses; the folder then stays")
    func removeReportsRefusal() throws {
        let refusing = try Refusing()
        defer { refusing.clean() }
        #expect(!refusing.folder.remove(), "a file in a folder this user cannot write cannot be unlinked")
        #expect(FileManager.default.fileExists(atPath: refusing.folder.path))
        refusing.unlock()
        #expect(refusing.folder.remove())
        #expect(!FileManager.default.fileExists(atPath: refusing.folder.path))
        #expect(refusing.folder.remove(), "already gone counts as gone")
    }

    @Test("A launched run whose folder cannot be removed passes every update on and logs working-folder-not-removed before its updates finish; a removable one logs nothing")
    func launchedRunReportsRefusal() async throws {
        func launched(_ folder: ParticipantWorkingFolder) async throws -> (ScriptedParticipantRun, UpdateCollector, RecordingLog) {
            let world = try VirtualWorld(clock: ScriptedRunTimingTests.clock)
            let inner = world.launch(identity: ScriptedRunTimingTests.identity(),
                                     configuration: ScriptedRunTimingTests.configuration(),
                                     script: ScriptedRunTimingTests.opening + [
                                        ScriptStep(atMs: 100, .textDelta("reply")), ScriptStep(atMs: 300, .resultSuccess),
                                        ScriptStep(atMs: 310, .exit(0))])
            let log = RecordingLog()
            let run = LaunchedParticipantRun(run: inner, runId: ScriptedRunTimingTests.runId, workingFolder: folder, log: log)
            let collector = UpdateCollector(run)
            try world.settle()
            try await collector.wait(seconds: 5, for: "stream end") { $0.isFinished }
            return (inner, collector, log)
        }

        let refusing = try Refusing()
        defer { refusing.clean() }
        let (inner, collector, log) = try await launched(refusing.folder)
        #expect(collector.updates == inner.recordedUpdates && collector.terminal?.type == .completed)
        #expect(log.entries.map(\.line) == ["run=\(ScriptedRunTimingTests.runId) kind=working-folder-not-removed"],
                "recorded before the end; no path")
        #expect(FileManager.default.fileExists(atPath: refusing.folder.path), "the folder stays, and is reported")

        let removable = try ParticipantWorkingFolder.create(under: refusing.parent)
        let (_, cleanCollector, cleanLog) = try await launched(removable)
        #expect(cleanCollector.terminal?.type == .completed)
        #expect(cleanLog.entries.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: removable.path))
    }

    /// Runs /bin/chmod on an invented folder (here, to add or clear an ACL).
    static func setACL(_ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/chmod")
        process.arguments = arguments
        try process.run()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0, "chmod \(arguments)")
    }

    @Test("The launcher's spawn-failure path: a spawner refusal whose new working folder cannot be removed logs working-folder-not-removed, then throws the spawner's error")
    func spawnFailureReportsRefusal() throws {
        let files = FileManager.default
        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("wf-n1-spawn-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try files.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer {
            try? Self.setACL(["-R", "-N", root.path])
            try? files.removeItem(at: root)
        }
        let runFolder = root.appendingPathComponent("run-invented", isDirectory: true)
        try files.createDirectory(at: runFolder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let parent = try ParticipantsFolder.prepare(in: runFolder)
        // Each folder made in the parent from now on inherits "deny delete".
        // No seam: the launcher makes the folder and the real spawner refuses
        // the relative supervisor path before anything is spawned.
        try Self.setACL(["+a", "everyone deny delete,directory_inherit,only_inherit", parent.url.path])
        let log = RecordingLog()
        let launcher = ProcessParticipantLauncher(supervisorPath: "relative/ParticipantSupervisor",
                                                  cliPath: "/invented/claude", workingParent: parent,
                                                  expectedInit: Invented.expectation, log: log, environment: [:])
        #expect(throws: ParticipantSpawnError.invalidLaunch) { try launcher.launch(LauncherFixture.request()) }
        #expect(log.entries.map(\.line) == ["run=\(LauncherFixture.identity.runId) kind=working-folder-not-removed"],
                "logged once, before the throw; no path")
        let left = LauncherFixture.children(of: parent)
        #expect(left.count == 1 && left.first?.hasPrefix("participant-") == true, "the folder is still there, and reported")
    }
}
