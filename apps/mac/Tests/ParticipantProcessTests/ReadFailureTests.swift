import Darwin
import Foundation
@testable import ParticipantProcess
import ParticipantSupervisorCore
import Testing

// Codex's S5-fix recheck, R1-f: a failed read of an output pipe is not EOF
// (contract sections 10 and 17). A failed stdout read never makes a buffered
// partial line complete and observes overflow conservatively; a failed read
// of either pipe never proves the writers gone, so it never releases a lost
// supervisor's cleanup. Invented data only. The live cases start only the
// real supervisor and the fake CLI, never the real CLI, and inject the fault
// through the spawner's own `read` seam, so it goes through the reader
// thread and the process events exactly as a real failed read would.

/// The spawner's pipe-read seam, driven by a test. Per pipe: pass real
/// reads through, delivering at most `interruptAt` bytes while EINTRs remain
/// and at most `failAt` bytes in all; once `interruptAt` bytes are delivered,
/// return EINTR `interruptions` times; once `failAt` are, wait while held,
/// then fail with `error`.
final class PipeReadFaults: @unchecked Sendable {
    struct Plan {
        var failAt: Int?
        var error: Int32 = EIO
        var held = false
        var interruptAt = 0
        var interruptions = 0
    }

    private let lock = NSLock()
    private var plans: [ParticipantOutputPipe: Plan]
    private var delivered: [ParticipantOutputPipe: Int] = [:]
    private var waiting: Set<ParticipantOutputPipe> = []
    private var failed: [ParticipantOutputPipe: Int] = [:]
    private var interrupted: [ParticipantOutputPipe: [Int]] = [:]

    init(_ plans: [ParticipantOutputPipe: Plan]) {
        self.plans = plans
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    /// A spawner whose readers read through this seam.
    var spawner: ParticipantProcessSpawner {
        var spawner = ParticipantProcessSpawner()
        spawner.pipeRead = ParticipantPipeRead { [self] pipe, descriptor, buffer in
            read(pipe, descriptor, buffer)
        }
        return spawner
    }

    func release(_ pipe: ParticipantOutputPipe) { locked { plans[pipe]?.held = false } }
    func releaseAll() { locked { for pipe in plans.keys { plans[pipe]?.held = false } } }
    func isWaiting(_ pipe: ParticipantOutputPipe) -> Bool { locked { waiting.contains(pipe) } }
    func failures(_ pipe: ParticipantOutputPipe) -> Int { locked { failed[pipe, default: 0] } }
    /// The bytes delivered on `pipe` when each EINTR was returned.
    func interruptions(_ pipe: ParticipantOutputPipe) -> [Int] { locked { interrupted[pipe, default: []] } }

    private func read(_ pipe: ParticipantOutputPipe, _ descriptor: Int32,
                      _ buffer: UnsafeMutableRawBufferPointer) -> (count: Int, error: Int32) {
        lock.lock()
        let plan = plans[pipe] ?? Plan()
        let done = delivered[pipe, default: 0]
        if plan.interruptions > 0, done >= plan.interruptAt {
            plans[pipe]?.interruptions -= 1
            interrupted[pipe, default: []].append(done)
            lock.unlock()
            return (-1, EINTR)
        }
        if let failAt = plan.failAt, done >= failAt {
            waiting.insert(pipe)
            lock.unlock()
            // Bounded, so a failed test never leaves a reader waiting.
            let deadline = ContinuousClock.now + .seconds(20)
            while locked({ plans[pipe]?.held == true }), ContinuousClock.now < deadline { usleep(5_000) }
            locked {
                waiting.remove(pipe)
                failed[pipe, default: 0] += 1
            }
            return (-1, plan.error)
        }
        var room = plan.failAt.map { min(buffer.count, $0 - done) } ?? buffer.count
        if plan.interruptions > 0 { room = min(room, plan.interruptAt - done) }   // stop exactly there
        lock.unlock()
        let count = Darwin.read(descriptor, buffer.baseAddress, room)
        let error = count < 0 ? errno : 0
        if count > 0 { locked { delivered[pipe, default: 0] += count } }
        return (count, error)
    }
}

extension ReaderHarness {
    mutating func stdoutReadFailed() { outputs += reader.stdoutReadFailed(now: now) }
    mutating func stderrReadFailed() { outputs += reader.stderrReadFailed(now: now) }
}

enum ReadFailureFixture {
    static let runId = "51000000-0000-4000-8000-0000000000aa"
    static let opening = [Invented.initLine(), Invented.rateLimit(), Invented.messageStart, Invented.blockStart(0)]
    /// The first half of a signal's line: read as complete, it is not JSON.
    static let halfSignal = Data(OverflowFixture.signal.utf8.prefix(OverflowFixture.signal.utf8.count / 2))

    /// Bytes of `lines`, each with its newline.
    static func bytes(_ lines: [String]) -> Int { lines.reduce(0) { $0 + $1.utf8.count + 1 } }

    static func observed(_ updates: [ParticipantRunUpdate]) -> Int { updates.filter { $0 == .overflowObserved }.count }

    static func entries(_ log: RecordingLog, _ kind: ParticipantLogKind) -> [ParticipantLogEntry] {
        log.entries.filter { $0.kind == kind }
    }

    static func failure(_ kind: ParticipantLogKind, _ failure: ParticipantReadFailure) -> ParticipantLogEntry {
        ParticipantLogEntry(runId: runId, kind: kind, reason: .readFailure(failure))
    }

    static func expectTextless(_ log: RecordingLog, sourceLocation: SourceLocation = #_sourceLocation) {
        for line in log.entries.map(\.line) {
            #expect(!line.contains("nvented") && !line.contains("/"), "no text or path in the log: \(line)",
                    sourceLocation: sourceLocation)
        }
    }
}

// MARK: Reader and run core

@Suite("A failed pipe read is not EOF: reader and run core (S5 fix recheck R1-f)")
struct ReadFailureTests {
    @Test("Each errno has one fixed class, and the log entry holds a fixed kind and that class only")
    func errnoClasses() {
        #expect(ParticipantReadFailure(errno: EBADF) == .badDescriptor)
        #expect(ParticipantReadFailure(errno: EIO) == .io)
        #expect(ParticipantReadFailure(errno: EAGAIN) == .wouldBlock)
        #expect(ParticipantReadFailure(errno: EINVAL) == .invalid)
        #expect(ParticipantReadFailure(errno: ENXIO) == .other && ParticipantReadFailure(errno: 0) == .other)
        #expect(ParticipantReadFailure.allCases.map(\.rawValue)
                == ["bad-descriptor", "io-error", "would-block", "invalid", "other"])
        #expect(ReadFailureFixture.failure(.stdoutReadFailed, .io).line
                == "run=\(ReadFailureFixture.runId) kind=stdout-read-failed reason=io-error")
        #expect(ReadFailureFixture.failure(.stderrReadFailed, .badDescriptor).line
                == "run=\(ReadFailureFixture.runId) kind=stderr-read-failed reason=bad-descriptor")
    }

    @Test("Reader, after a decision: a failed read never reads the buffered partial line, observes once and changes nothing else; a real EOF reads it as the last line (control)")
    func readerAfterDecision() {
        func stopped() -> ReaderHarness {
            var run = ReaderHarness()
            run.spawned()
            run.feed(ReadFailureFixture.opening + [Invented.textDelta("accepted")])
            run.stop()
            return run
        }
        // Half a signal: EOF reads it as a line (not JSON, so nothing).
        var eof = stopped()
        eof.feedBytes(ReadFailureFixture.halfSignal)
        eof.stdoutEOF()
        eof.ends(SIGTERM)
        eof.finishing()
        #expect(eof.observed == 0, "fully read to EOF: no observation")

        var failed = stopped()
        failed.feedBytes(ReadFailureFixture.halfSignal)
        let decided = failed.outputs
        failed.stdoutReadFailed()
        #expect(failed.outputs == decided + [.overflowObserved], "only the observation")
        failed.feedBytes(Data("\n".utf8))
        failed.stdoutEOF()
        failed.stdoutReadFailed()
        failed.ends(SIGTERM)
        failed.finishing()
        #expect(failed.observed == 1, "once; nothing is read after the failure")
        #expect(failed.texts == ["accepted"] && failed.texts == eof.texts)
        #expect(failed.terminal == .terminal(.stopped(.localStop), groupCleared: true) && failed.terminals.count == 1)
        #expect(failed.outputs.filter { $0 != .overflowObserved } == eof.outputs, "terminal, text and order unchanged")

        // A complete signal waiting only for its newline: EOF reads it as
        // the last line; a failed read observes without reading it.
        var signalEOF = stopped()
        signalEOF.feedBytes(Data(OverflowFixture.signal.utf8))
        signalEOF.stdoutEOF()
        #expect(signalEOF.observed == 1, "complete at EOF, as before")
    }

    @Test("Reader, before any decision: the exit decides by the existing rules with the partial line unread (a read result completes, a cut one is process-error), without waiting out the grace; a real EOF reads the last line (control)")
    func readerBeforeDecision() {
        func opened(_ lines: [String]) -> ReaderHarness {
            var run = ReaderHarness()
            run.spawned()
            run.feed(ReadFailureFixture.opening + [Invented.textDelta("reply")] + lines)
            return run
        }
        // A success result already read, then garbage cut mid-line.
        var resultRead = opened([Invented.result()])
        resultRead.feedBytes(Data("{\"type\":\"inv".utf8))
        resultRead.stdoutReadFailed()
        #expect(resultRead.observed == 1 && resultRead.terminal == nil, "no decision from the failure itself")
        resultRead.exit(0)
        resultRead.cleared()
        #expect(resultRead.terminal == .terminal(.completed, groupCleared: true), "exit 0 after a read success result")
        #expect(resultRead.texts == ["reply"])

        // The result itself cut mid-line: never read, so the exit fails it.
        let result = Data(Invented.result().utf8)
        var cut = opened([])
        cut.feedBytes(result.prefix(result.count / 2))
        cut.exit(0)
        cut.cleared()
        #expect(cut.terminal == nil, "waiting for stdout within the grace")
        cut.stdoutReadFailed()
        #expect(cut.terminal == .terminal(.failed(.processError), groupCleared: true), "decided at the failure, not the grace")
        #expect(cut.texts == ["reply"] && cut.observed == 1)

        // Control: the same result as a last line without its newline, at EOF.
        var eof = opened([])
        eof.feedBytes(result)
        eof.exit(0)
        eof.cleared()
        eof.stdoutEOF()
        #expect(eof.terminal == .terminal(.completed, groupCleared: true) && eof.observed == 0)
    }

    @Test("Reader, supervisor lost: a failed read of either pipe never releases cleanup; after an uncleared terminal the loss answers cleanupRetryUncleared; both pipes at EOF release (control)")
    func readerLostSupervisor() {
        func lost(stdout: (inout ReaderHarness) -> Void, stderr: (inout ReaderHarness) -> Void) -> ReaderHarness {
            var run = ReaderHarness()
            run.spawned()
            run.feed(ReadFailureFixture.opening + [Invented.textDelta("before")])
            run.controlClosed()
            stdout(&run)
            stderr(&run)
            return run
        }
        let stdoutFailed = lost(stdout: { $0.stdoutReadFailed() }, stderr: { $0.stderrEOF() })
        let stderrFailed = lost(stdout: { $0.stdoutEOF() }, stderr: { $0.stderrReadFailed() })
        let bothFailed = lost(stdout: { $0.stdoutReadFailed() }, stderr: { $0.stderrReadFailed() })
        let control = lost(stdout: { $0.stdoutEOF() }, stderr: { $0.stderrEOF() })
        for (label, run) in [("stdout", stdoutFailed), ("stderr", stderrFailed), ("both", bothFailed)] {
            #expect(!run.released && run.reader.supervisorLost, "\(label): not EOF, so not released")
            #expect(run.terminal == .terminal(.failed(.processError), groupCleared: false), "\(label)")
        }
        #expect(stdoutFailed.observed == 1 && stderrFailed.observed == 0, "stdout read to EOF: nothing observed")
        #expect(control.released && control.observed == 0)

        // A clean EOF arriving after a failure (the spawner never sends one)
        // still proves nothing.
        var late = stdoutFailed
        late.stdoutEOF()
        late.stderrEOF()
        #expect(!late.released)

        // An uncleared terminal, then the loss after a failed read.
        var uncleared = ReaderHarness()
        uncleared.spawned()
        uncleared.feed(ReadFailureFixture.opening)
        uncleared.stop()
        uncleared.exit(SIGKILL)
        uncleared.uncleared()
        #expect(uncleared.terminal == .terminal(.stopped(.stopIncomplete), groupCleared: false))
        uncleared.stdoutReadFailed()
        uncleared.stderrEOF()
        uncleared.controlClosed()
        #expect(!uncleared.released && uncleared.outputs.last == .cleanupRetryUncleared)
    }

    @Test("Run core: a failed read is logged as a fixed kind and errno class (no byte count, no text), then the observation; stderr's changes nothing else; nothing is owed at the end")
    func runCore() {
        var run = CoreHarness()
        run.control(.spawned)
        run.feed(ReadFailureFixture.opening + [Invented.textDelta("accepted")])
        run.stop()
        run.send(.stdout(ReadFailureFixture.halfSignal))
        var mark = run.effects.count
        run.send(.stdoutReadFailed(totalBytes: 4_096, failure: .io))
        #expect(Array(run.effects[mark...]) == [
            .log(ParticipantLogEntry(runId: CoreHarness.runId, kind: .stdoutReadFailed, reason: .readFailure(.io))),
            .update(.overflowObserved),
            .log(ParticipantLogEntry(runId: CoreHarness.runId, kind: .overflowObserved))
        ])
        mark = run.effects.count
        run.send(.stderrReadFailed(totalBytes: 12, failure: .badDescriptor))
        #expect(Array(run.effects[mark...]) == [
            .log(ParticipantLogEntry(runId: CoreHarness.runId, kind: .stderrReadFailed, reason: .readFailure(.badDescriptor)))
        ])
        run.control(.exit(status: SIGTERM))
        run.control(.cleared)
        #expect(run.terminals.map(\.event.reason) == ["local-stop"] && run.events.map(\.sequence) == [1, 2, 3])
        #expect(run.core.updatesFinishing(wall: run.wall).isEmpty, "already observed, once")
        #expect(run.core.snapshot.cleanup == .released, "the group cleared: released by the group, not the pipes")
    }
}

// MARK: Live tier

extension ProcessSuites {
    @Suite("A failed pipe read is not EOF, through the real spawner and supervisor (live tier; S5 fix recheck R1-f)")
    struct ReadFailureLive {
        typealias Fixture = ReadFailureFixture

        @Test("After reply-too-long, a failed stdout read with half a line buffered: that line is never read as complete; overflowObserved exactly once before the updates finish; terminal, text and sequence unchanged; logged as a fixed kind and errno class")
        func afterReplyTooLong() async throws {
            var limits = StreamJSONReaderLimits.contract
            limits.maxInputPlusOutputBytes = LiveRun.input.utf8.count + OverflowFixture.room
            let delta = Invented.textDelta(OverflowFixture.oversized)
            let trailing = Invented.result()
            let faults = PipeReadFaults([
                .stdout: .init(failAt: Fixture.bytes(Fixture.opening + [delta]) + trailing.utf8.count / 2, error: EIO)
            ])
            defer { faults.releaseAll() }
            let live = try LiveRun(.lines(Fixture.opening + [delta, trailing], then: ["hang": true]),
                                   limits: limits, spawner: faults.spawner)
            let cli = try await live.folder.waitForPid("cli.pid")
            try await live.collector.wait(seconds: 10, for: "stream end") { $0.isFinished }

            let updates = live.collector.updates
            #expect(live.collector.events.map(\.type) == [.started, .text, .failed])
            #expect(live.collector.events.map(\.sequence) == [1, 2, 3])
            #expect(live.collector.events.filter { $0.type == .text }.map { $0.text ?? "" } == [OverflowFixture.fitting])
            #expect(live.collector.terminal?.reason == "reply-too-long")
            #expect(live.collector.terminalUpdate?.groupCleared == true && live.collector.released,
                    "the group cleared, so cleanup is released by the group")
            #expect(Fixture.observed(updates) == 1, "the half line is not read; the observation is conservative")
            let text = updates.firstIndex { if case .event(let event) = $0 { return event.type == .text } else { return false } }
            let observed = updates.firstIndex(of: .overflowObserved)
            #expect(text != nil && observed != nil && text! < observed!, "the decision first, then the failed read")
            #expect(faults.failures(.stdout) == 1)
            #expect(Fixture.entries(live.log, .stdoutReadFailed) == [Fixture.failure(.stdoutReadFailed, .io)])
            #expect(Fixture.entries(live.log, .stdoutClosed).isEmpty, "never reported as EOF")
            #expect(Fixture.entries(live.log, .stderrClosed).count == 1)
            Fixture.expectTextless(live.log)
            checkRunInvariants(updates, "live failed read after reply-too-long")
            await live.finish(group: cli)
        }

        @Test("After a Stop, a failed stdout read held until the terminal is out, with half a line buffered: overflowObserved once, after the terminal and before the updates finish; local-stop, text and sequence unchanged")
        func afterStop() async throws {
            let partial = Invented.textDelta("partial")
            let trailing = Invented.textDelta(" more")
            let faults = PipeReadFaults([
                .stdout: .init(failAt: Fixture.bytes(Fixture.opening + [partial]) + trailing.utf8.count / 2,
                               error: EBADF, held: true)
            ])
            defer { faults.releaseAll() }
            let live = try LiveRun(.lines(Fixture.opening + [partial, trailing], then: ["hang": true]),
                                   spawner: faults.spawner)
            let cli = try await live.folder.waitForPid("cli.pid")
            try await live.collector.wait(seconds: 10, for: "text") { $0.events.contains { $0.type == .text } }
            let held = await Processes.waitUntil(seconds: 5) { faults.isWaiting(.stdout) }
            #expect(held != nil, "the half line is delivered, then the read is held")

            live.run.stop()
            try await live.collector.wait(seconds: 5, for: "release") { $0.released }
            #expect(live.collector.terminal?.reason == "local-stop" && live.collector.terminalUpdate?.groupCleared == true)
            #expect(Fixture.observed(live.collector.updates) == 0, "nothing more has been read")
            #expect(!live.collector.isFinished, "stdout's reading has not ended")

            faults.release(.stdout)
            try await live.collector.wait(seconds: 5, for: "stream end") { $0.isFinished }
            let updates = live.collector.updates
            #expect(Fixture.observed(updates) == 1)
            let terminal = updates.firstIndex { if case .terminal = $0 { return true } else { return false } }
            let observed = updates.firstIndex(of: .overflowObserved)
            #expect(terminal != nil && observed != nil && terminal! < observed!, "after the terminal, before the end")
            #expect(live.collector.events.map(\.type) == [.started, .text, .stopped])
            #expect(live.collector.events.map(\.sequence) == [1, 2, 3])
            #expect(live.collector.events.filter { $0.type == .text }.map { $0.text ?? "" } == ["partial"])
            #expect(Fixture.entries(live.log, .stdoutReadFailed) == [Fixture.failure(.stdoutReadFailed, .badDescriptor)])
            #expect(Fixture.entries(live.log, .stdoutClosed).isEmpty)
            Fixture.expectTextless(live.log)
            checkRunInvariants(updates, "live failed read after a Stop")
            await live.finish(group: cli)
        }

        @Test("Before any decision, a failed stdout read cuts the result line: the exit then decides by the existing rules with that line unread (failed process-error), overflowObserved once. Control: the same stream to a real EOF, its result line without a newline, still read as complete: completed, no observation")
        func beforeDecision() async throws {
            let delta = Invented.textDelta("Invented reply")
            let result = Invented.result()

            // Control, through the production read: the last line is read at EOF.
            var eofScenario = FakeCLIFolder.Scenario()
            let lines: [[String: Any]] = (Fixture.opening + [delta]).map { ["out": $0] }
            eofScenario.steps = lines + [["outRaw": result], ["exit": 0]]
            let eof = try LiveRun(eofScenario)
            let eofCLI = try await eof.folder.waitForPid("cli.pid")
            try await eof.collector.wait(seconds: 10, for: "stream end") { $0.isFinished }
            #expect(eof.collector.events.map(\.type) == [.started, .text, .completed])
            #expect(Fixture.observed(eof.collector.updates) == 0 && eof.collector.released)
            #expect(Fixture.entries(eof.log, .stdoutClosed).count == 1)
            #expect(Fixture.entries(eof.log, .stdoutReadFailed).isEmpty && Fixture.entries(eof.log, .stderrReadFailed).isEmpty)
            await eof.finish(group: eofCLI)

            let faults = PipeReadFaults([
                .stdout: .init(failAt: Fixture.bytes(Fixture.opening + [delta]) + result.utf8.count / 2)
            ])
            defer { faults.releaseAll() }
            let live = try LiveRun(.lines(Fixture.opening + [delta, result]), spawner: faults.spawner)
            let cli = try await live.folder.waitForPid("cli.pid")
            try await live.collector.wait(seconds: 10, for: "stream end") { $0.isFinished }
            #expect(live.collector.events.map(\.type) == [.started, .text, .failed])
            #expect(live.collector.events.map(\.sequence) == [1, 2, 3])
            #expect(live.collector.terminal?.reason == "process-error", "exit 0 without a read success result")
            #expect(live.collector.events.filter { $0.type == .text }.map { $0.text ?? "" } == ["Invented reply"])
            #expect(live.collector.terminalUpdate?.groupCleared == true && live.collector.released)
            #expect(Fixture.observed(live.collector.updates) == 1)
            #expect(Fixture.entries(live.log, .stdoutReadFailed) == [Fixture.failure(.stdoutReadFailed, .io)])
            Fixture.expectTextless(live.log)
            checkRunInvariants(live.collector.updates, "live failed read before a decision")
            await live.finish(group: cli)
        }

        @Test("Before any decision, with a success result already read, a failed stdout read cuts the next line: the exit 0 completes, so the terminal itself shows the cut line was never read (read as complete it is not JSON, which would be process-error); overflowObserved once")
        func resultThenCutLine() async throws {
            let delta = Invented.textDelta("Invented reply")
            let result = Invented.result()
            let after = Invented.textDelta("never read")
            let lines = Fixture.opening + [delta, result]
            let faults = PipeReadFaults([.stdout: .init(failAt: Fixture.bytes(lines) + after.utf8.count / 2)])
            defer { faults.releaseAll() }
            let live = try LiveRun(.lines(lines + [after]), spawner: faults.spawner)
            let cli = try await live.folder.waitForPid("cli.pid")
            try await live.collector.wait(seconds: 10, for: "stream end") { $0.isFinished }
            #expect(live.collector.events.map(\.type) == [.started, .text, .completed])
            #expect(live.collector.events.map(\.sequence) == [1, 2, 3])
            #expect(live.collector.terminal?.type == .completed && live.collector.terminal?.reason == nil,
                    "the cut line was not read, so it decided nothing")
            #expect(live.collector.events.filter { $0.type == .text }.map { $0.text ?? "" } == ["Invented reply"])
            #expect(live.collector.terminalUpdate?.groupCleared == true && live.collector.released)
            #expect(Fixture.observed(live.collector.updates) == 1)
            #expect(faults.failures(.stdout) == 1)
            #expect(Fixture.entries(live.log, .stdoutReadFailed) == [Fixture.failure(.stdoutReadFailed, .io)])
            #expect(Fixture.entries(live.log, .stdoutClosed).isEmpty, "never reported as EOF")
            Fixture.expectTextless(live.log)
            checkRunInvariants(live.collector.updates, "live failed read after a read result")
            await live.finish(group: cli)
        }

        @Test("Supervisor lost: a failed read of either pipe, before or after the loss, is not EOF: the run stays cleanup-pending (owned, never released) after its updates finish; a stdout failure observes overflow once, a stderr failure (stdout read to EOF) observes nothing",
              arguments: ["stdout after the loss", "stderr after the loss", "stdout before the loss", "stderr before the loss"])
        func supervisorLost(_ variant: String) async throws {
            let pipe: ParticipantOutputPipe = variant.hasPrefix("stdout") ? .stdout : .stderr
            let afterLoss = variant.hasSuffix("after the loss")
            let lines = Fixture.opening + [Invented.textDelta("before")]
            let faults = PipeReadFaults([
                pipe: .init(failAt: pipe == .stdout ? Fixture.bytes(lines) : 0, error: EIO, held: afterLoss)
            ])
            defer { faults.releaseAll() }
            let live = try LiveRun(.lines(lines, then: ["hang": true]), spawner: faults.spawner)
            let cli = try await live.folder.waitForPid("cli.pid")
            try await live.collector.wait(seconds: 10, for: "text") { $0.events.contains { $0.type == .text } }
            let ready = await Processes.waitUntil(seconds: 5) {
                afterLoss ? faults.isWaiting(pipe) : faults.failures(pipe) == 1
            }
            #expect(ready != nil, "\(variant): \(afterLoss ? "held before the loss" : "failed before the loss")")

            _ = kill(live.process.supervisorProcessID, SIGKILL)
            try await live.collector.wait(seconds: 5, for: "terminal") { $0.terminal != nil }
            #expect(live.collector.terminal?.reason == "process-error", "\(variant)")
            #expect(live.collector.terminalUpdate?.groupCleared == false, "\(variant)")
            if afterLoss { faults.release(pipe) }
            let kind: ParticipantLogKind = pipe == .stdout ? .stdoutReadFailed : .stderrReadFailed
            let reached = await Processes.waitUntil(seconds: 5) { !Fixture.entries(live.log, kind).isEmpty }
            #expect(reached != nil, "\(variant): the failure reached the run")

            // The test, not native, ends the fake by its recorded id: the
            // other pipe then reaches a real EOF and every source ends.
            _ = kill(cli, SIGKILL)
            try await live.collector.wait(seconds: 5, for: "stream end") { $0.isFinished }
            #expect(!live.collector.released, "\(variant): a failed read is not EOF, so cleanup is never released")
            #expect(live.run.snapshot.cleanup == .owned && live.run.snapshot.groupCleared == false,
                    "\(variant): cleanup-pending, a stable state")
            #expect(Fixture.observed(live.collector.updates) == (pipe == .stdout ? 1 : 0), "\(variant)")
            #expect(Fixture.entries(live.log, kind) == [Fixture.failure(kind, .io)], "\(variant)")
            let otherClosed: ParticipantLogKind = pipe == .stdout ? .stderrClosed : .stdoutClosed
            let ownClosed: ParticipantLogKind = pipe == .stdout ? .stdoutClosed : .stderrClosed
            #expect(Fixture.entries(live.log, otherClosed).count == 1 && Fixture.entries(live.log, ownClosed).isEmpty,
                    "\(variant)")
            #expect(Fixture.entries(live.log, .cleanupReleased).isEmpty, "\(variant)")
            Fixture.expectTextless(live.log)
            checkRunInvariants(live.collector.updates, variant)
            await live.finish(group: cli)
        }

        @Test("EINTR, before any byte and mid-stream, is retried on both pipes: the passing stream completes, the stdout and stderr ends are real EOFs, no observation, a normal release (control)")
        func interruptedReads() async throws {
            let faults = PipeReadFaults([
                .stdout: .init(interruptAt: Fixture.bytes([Invented.initLine()]), interruptions: 3),
                .stderr: .init(interruptions: 3)
            ])
            defer { faults.releaseAll() }
            let live = try LiveRun(.lines(Invented.passingStream(["Invented ", "reply"])), spawner: faults.spawner)
            let cli = try await live.folder.waitForPid("cli.pid")
            try await live.collector.wait(seconds: 10, for: "stream end") { $0.isFinished }
            #expect(live.collector.events.map(\.type) == [.started, .text, .completed])
            #expect(live.collector.events.filter { $0.type == .text }.map { $0.text ?? "" } == ["Invented reply"])
            #expect(Fixture.observed(live.collector.updates) == 0 && live.collector.released)
            let midStream = Fixture.bytes([Invented.initLine()])
            #expect(faults.interruptions(.stdout) == [midStream, midStream, midStream],
                    "each stdout EINTR came after exactly the init line, mid-stream")
            #expect(faults.interruptions(.stderr) == [0, 0, 0], "each stderr EINTR came before any byte")
            #expect(faults.failures(.stdout) == 0 && faults.failures(.stderr) == 0)
            #expect(Fixture.entries(live.log, .stdoutClosed).count == 1 && Fixture.entries(live.log, .stderrClosed).count == 1)
            #expect(Fixture.entries(live.log, .stdoutReadFailed).isEmpty && Fixture.entries(live.log, .stderrReadFailed).isEmpty)
            checkRunInvariants(live.collector.updates, "live EINTR retried")
            await live.finish(group: cli)
        }
    }
}
