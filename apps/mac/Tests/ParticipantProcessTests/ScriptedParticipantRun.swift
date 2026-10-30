import Darwin
import Foundation
@testable import ParticipantProcess
import ParticipantSupervisorCore

/// One run on the virtual clock behind the launch seam (plan S5): the real
/// `ParticipantRunCore` (and so the real `StreamJSONReader`) fed by script
/// steps, and the real `SupervisorEngine` acting on a
/// `SimulatedSupervisorSystem`. Engine reports become `.control` events,
/// script steps become `.stdout` lines (or `.stderr` bytes), kept and cut as
/// the spawner's readers keep and cut them (`ParticipantProcessLimits`:
/// bytes past the bound are dropped, and stdout's first overrun reports
/// `.stdoutLimitReached`), and the core's effects are carried out as
/// `ParticipantRun` carries them out: yields in order, native's own `stop`
/// written to the supervisor, log entries recorded. Everything is
/// synchronous under one lock; the `VirtualWorld` decides when time moves.
final class ScriptedParticipantRun: ParticipantRunning, @unchecked Sendable {
    let updates: AsyncStream<ParticipantRunUpdate>
    let identity: ParticipantRunIdentity
    let system: SimulatedSupervisorSystem
    /// World time of the launch.
    let launchedAt: UInt64

    private enum Source: Hashable { case stdout, stderr, stdin, control, supervisor }

    private let lock = NSRecursiveLock()
    private let continuation: AsyncStream<ParticipantRunUpdate>.Continuation
    private let clock: VirtualClock
    private let log: ParticipantLogSink
    private let inputBytes: Int
    private let processLimits: ParticipantProcessLimits
    private var core: ParticipantRunCore
    private let engine: SupervisorEngine
    private var wakeAt: UInt64?
    private var queue: [ScriptedWork] = []
    private var draining = false
    private var recorded: [ParticipantRunUpdate] = []
    private var closed: Set<Source> = []
    private var stdoutTotal = 0
    private var stdoutKept = 0
    private var stdoutLimitReported = false
    private var stderrTotal = 0
    private var stderrKept = 0
    private var eofHeld = false
    private var eofParked = false
    private var deltaWritten = false
    private var probesBeforeClear: Int?
    private var stops: [(at: UInt64, sent: Bool)] = []
    private var untilTerminalFlag = false
    private var streamFinished = false

    init(identity: ParticipantRunIdentity, configuration: StreamJSONReader.Configuration, mode: SimulatedProcessMode,
         processLimits: ParticipantProcessLimits = ParticipantProcessLimits(),
         supervisorTiming: SupervisorTiming = .contract, clock: VirtualClock, log: ParticipantLogSink) {
        self.identity = identity
        self.clock = clock
        self.log = log
        self.inputBytes = configuration.inputBytes
        self.processLimits = processLimits
        launchedAt = clock.monotonicMillis()
        core = ParticipantRunCore(identity: identity, configuration: configuration)
        let system = SimulatedSupervisorSystem(mode: mode, now: { clock.monotonicMillis() })
        self.system = system
        engine = SupervisorEngine(system: system, timing: supervisorTiming)
        var continuation: AsyncStream<ParticipantRunUpdate>.Continuation!
        updates = AsyncStream(bufferingPolicy: .unbounded) { continuation = $0 }
        self.continuation = continuation
        log.record(ParticipantLogEntry(runId: identity.runId, kind: .supervisorSpawned))
    }

    /// The supervisor starts and spawns the CLI (or fails to); stdin is
    /// written and closed.
    func start() {
        lock.lock(); defer { lock.unlock() }
        let now = clock.monotonicMillis()
        if system.mode == .spawnFails {
            engine.spawnFailed(now: now)
            afterEngine(now: now)
            queue.append(.core(.stdinClosed(writtenBytes: 0, complete: false)))
        } else {
            engine.spawned(now: now)
            afterEngine(now: now)
            queue.append(.core(.stdinClosed(writtenBytes: inputBytes, complete: true)))
        }
        drain()
    }

    // MARK: ParticipantRunning

    /// Writes `stop` (it reaches the supervisor while its control socket is
    /// open), then the core hears of it, then the supervisor acts. Here the
    /// core always hears before the exit the stop causes, by construction;
    /// the real `ParticipantRun` queues `stopRequested` after the write, so
    /// that order is shown only by the live tier's stop test.
    @discardableResult
    func stop() -> Bool {
        lock.lock(); defer { lock.unlock() }
        let sent = system.supervisorAlive
        let now = clock.monotonicMillis()
        stops.append((now, sent))
        perform(core.stopRequested(stopSent: sent, monotonic: now, wall: clock.wallMillis()))
        if sent { queue.append(.engineStop) }
        drain()
        return sent
    }

    var snapshot: ParticipantRunSnapshot {
        lock.lock(); defer { lock.unlock() }
        return core.snapshot
    }

    // MARK: What tests read

    /// Every update yielded so far, in order.
    var recordedUpdates: [ParticipantRunUpdate] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }

    var events: [ParticipantEvent] { recordedUpdates.events }

    var terminalUpdate: (event: ParticipantEvent, groupCleared: Bool?)? { recordedUpdates.terminalUpdate }

    var stopCalls: [(at: UInt64, sent: Bool)] {
        lock.lock(); defer { lock.unlock() }
        return stops
    }

    /// The updates stream finished: every source of the process ended.
    var isFinished: Bool {
        lock.lock(); defer { lock.unlock() }
        return closed.count == 5
    }

    var enginePhase: SupervisorEngine.Phase {
        lock.lock(); defer { lock.unlock() }
        return engine.phase
    }

    var untilTerminal: Bool {
        get { lock.lock(); defer { lock.unlock() }; return untilTerminalFlag }
        set { lock.lock(); untilTerminalFlag = newValue; lock.unlock() }
    }

    // MARK: Driven by the world

    /// One script step. A CLI that has exited (or never ran) writes nothing.
    func deliver(_ step: ScriptStep) {
        lock.lock(); defer { lock.unlock() }
        guard system.leader == .alive else { return }
        switch step.kind {
        case .exit(let code):
            system.leaderDies(status: code << 8)
        case .stderr(let text):
            writeStderr(Data(text.utf8))
        default:
            for line in step.lines(firstDelta: step.isTextDelta && !deltaWritten) {
                writeStdout(Data((line + "\n").utf8))
            }
            if step.isTextDelta { deltaWritten = true }
        }
        collect()
        drain()
    }

    func groupClears() {
        lock.lock(); defer { lock.unlock() }
        probesBeforeClear = system.probes
        system.survivorExits()
        collect()
        drain()
    }

    func supervisorDies() {
        lock.lock(); defer { lock.unlock() }
        system.supervisorKilled()
        wakeAt = nil
        collect()
        drain()
    }

    func pipesClose() {
        lock.lock(); defer { lock.unlock() }
        system.everyHolderExits()
        collect()
        drain()
    }

    /// From now, the pipes' EOF waits for `releasePipeEOF()`.
    func holdPipeEOF() {
        lock.lock(); defer { lock.unlock() }
        eofHeld = true
    }

    /// Delivers a held EOF, if the pipes have closed; later ones are not held.
    func releasePipeEOF() {
        lock.lock(); defer { lock.unlock() }
        eofHeld = false
        if eofParked {
            eofParked = false
            queue.append(.pipesClosed)
        }
        drain()
    }

    /// The earliest reader deadline or supervisor wake, if any.
    func nextDueTime() -> UInt64? {
        lock.lock(); defer { lock.unlock() }
        let wake = system.supervisorAlive && engine.phase != .finished ? wakeAt : nil
        return [core.nextDeadline(), wake].compactMap { $0 }.min()
    }

    /// Fires the reader's deadline, then the supervisor's wake, when due.
    func fireDue(now: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        var fired = false
        if let deadline = core.nextDeadline(), deadline <= now {
            perform(core.tick(monotonic: now, wall: clock.wallMillis()))
            drain()
            fired = true
        }
        if system.supervisorAlive, engine.phase != .finished, let wake = wakeAt, wake <= now {
            engine.tick(now: now)
            afterEngine(now: now)
            drain()
            fired = true
        }
        return fired
    }

    /// Why settling must go on for this run, or nil.
    func obligation() -> String? {
        lock.lock(); defer { lock.unlock() }
        if untilTerminalFlag, core.snapshot.terminal == nil { return "no terminal yet" }
        guard system.supervisorAlive else { return nil }
        switch engine.phase {
        case .stopping: return "a stop sequence"
        case .retrying: return "a cleanup retry"
        case .appGone: return "parent-death cleanup"
        case .awaitingSpawn, .running, .uncleared, .finished: break
        }
        if let before = probesBeforeClear {
            if engine.phase == .uncleared, system.probes == before { return "group-clears awaits the next probe" }
            probesBeforeClear = nil
        }
        return nil
    }

    // MARK: Carrying out work

    /// The supervisor's driver ticks after every input and wakes at
    /// `nextWake`; once the engine finishes, the supervisor exits.
    private func afterEngine(now: UInt64) {
        wakeAt = engine.nextWake(now: now)
        if engine.phase == .finished { system.supervisorExits(status: engine.exitCode << 8) }
        collect()
    }

    private func engineInput(_ body: (UInt64) -> Void) {
        guard system.supervisorAlive, engine.phase != .finished else { return }
        let now = clock.monotonicMillis()
        body(now)
        engine.tick(now: now)
        afterEngine(now: now)
    }

    private func collect() {
        queue += system.outbox
        system.outbox.removeAll()
    }

    /// As the spawner's stdout reader: keeps at most `stdoutBytes`, drops the
    /// rest, and reports the first overrun once.
    private func writeStdout(_ bytes: Data) {
        stdoutTotal += bytes.count
        let room = max(0, processLimits.stdoutBytes - stdoutKept)
        if room > 0 {
            let taken = min(room, bytes.count)
            stdoutKept += taken
            queue.append(.core(.stdout(bytes.prefix(taken))))
        }
        if bytes.count > room, !stdoutLimitReported {
            stdoutLimitReported = true
            queue.append(.core(.stdoutLimitReached))
        }
    }

    /// As the spawner's stderr reader: keeps at most `stderrBytes`, drops the rest.
    private func writeStderr(_ bytes: Data) {
        stderrTotal += bytes.count
        let room = max(0, processLimits.stderrBytes - stderrKept)
        if room > 0 {
            let taken = min(room, bytes.count)
            stderrKept += taken
            queue.append(.core(.stderr(bytes.prefix(taken))))
        }
    }

    private func drain() {
        guard !draining else { return }
        draining = true
        defer { draining = false }
        while !queue.isEmpty {
            let work = queue.removeFirst()
            let now = clock.monotonicMillis()
            switch work {
            case .core(let event):
                deliverToCore(event, now: now)
            case .pipesClosed where eofHeld:
                eofParked = true
            case .pipesClosed:
                deliverToCore(.stdoutClosed(totalBytes: stdoutTotal), now: now)
                deliverToCore(.stderrClosed(totalBytes: stderrTotal), now: now)
            case .engineStop:
                engineInput { engine.stopRequested(now: $0) }
            case .engineLeaderExit(let status):
                engineInput { engine.leaderDidExit(status: status, now: $0) }
            }
            collect()
        }
        if closed.count == 5, !streamFinished {
            // As `ParticipantRun.processEnded`: what the core still owes goes
            // out before the updates finish.
            streamFinished = true
            perform(core.updatesFinishing(wall: clock.wallMillis()))
            continuation.finish()
        }
    }

    private func deliverToCore(_ event: ParticipantProcessEvent, now: UInt64) {
        perform(core.process(event, monotonic: now, wall: clock.wallMillis()))
        switch event {
        case .stdoutClosed, .stdoutReadFailed: closed.insert(.stdout)
        case .stderrClosed, .stderrReadFailed: closed.insert(.stderr)
        case .stdinClosed: closed.insert(.stdin)
        case .controlClosed: closed.insert(.control)
        case .supervisorExited: closed.insert(.supervisor)
        case .control, .stdout, .stdoutLimitReached, .stderr: break
        }
    }

    /// As `ParticipantRun.perform`: yields, native's own `stop`, log entries.
    private func perform(_ effects: [ParticipantRunCore.Effect]) {
        for effect in effects {
            switch effect {
            case .update(let update):
                recorded.append(update)
                continuation.yield(update)
            case .sendStop:
                if system.supervisorAlive {
                    log.record(ParticipantLogEntry(runId: identity.runId, kind: .stopSent))
                    queue.append(.engineStop)
                }
            case .log(let entry):
                log.record(entry)
            }
        }
    }
}

/// The test launcher: starts `ScriptedParticipantRun`s in a `VirtualWorld`,
/// records every launch request (so a test can show it was never called),
/// and throws on demand.
final class ScriptedLauncher: ParticipantLaunching, @unchecked Sendable {
    let world: VirtualWorld
    let cliVersion: String
    let expectedInit: ParticipantInitExpectation
    let limits: StreamJSONReaderLimits
    private let lock = NSLock()
    private var nextScript: [ScriptStep]
    private var nextMode: SimulatedProcessMode
    private var nextFailure: Error?
    private var launchRequests: [ParticipantLaunchRequest] = []
    private var launched: [ScriptedParticipantRun] = []

    init(world: VirtualWorld, cliVersion: String = "invented-cli-version",
         expectedInit: ParticipantInitExpectation = Invented.expectation, limits: StreamJSONReaderLimits = .contract,
         script: [ScriptStep] = [], mode: SimulatedProcessMode = .exitsOnSigterm) {
        self.world = world
        self.cliVersion = cliVersion
        self.expectedInit = expectedInit
        self.limits = limits
        self.nextScript = script
        self.nextMode = mode
    }

    /// The script and process mode the next launch plays.
    func prepare(script: [ScriptStep], mode: SimulatedProcessMode = .exitsOnSigterm) {
        lock.lock(); defer { lock.unlock() }
        nextScript = script
        nextMode = mode
    }

    /// Makes every launch throw `error` (nil: launch normally).
    func failLaunches(with error: Error?) {
        lock.lock(); defer { lock.unlock() }
        nextFailure = error
    }

    var requests: [ParticipantLaunchRequest] {
        lock.lock(); defer { lock.unlock() }
        return launchRequests
    }

    var runs: [ScriptedParticipantRun] {
        lock.lock(); defer { lock.unlock() }
        return launched
    }

    func launch(_ request: ParticipantLaunchRequest) throws -> any ParticipantRunning {
        lock.lock()
        launchRequests.append(request)
        let failure = nextFailure
        let script = nextScript
        let mode = nextMode
        lock.unlock()
        if let failure { throw failure }
        // The same stdin rules as the production launcher (Codex Q17,
        // section 21.3).
        let message = request.message
        guard message.count == request.inputBytes else {
            throw ParticipantLaunchError.inputBytesMismatch(expected: request.inputBytes, actual: message.count)
        }
        guard request.context.allSatisfy({ $0.role == "user" || $0.role == "assistant" }),
              request.context.reduce(0, { $0 + $1.text.utf8.count }) == request.contextBytes else {
            throw ParticipantLaunchError.contextMismatch
        }
        let run = world.launch(
            identity: request.identity,
            configuration: StreamJSONReader.Configuration(expectedInit: expectedInit,
                                                          inputBytes: request.contextBytes + request.inputBytes,
                                                          preparedBytes: request.preparedBytes, limits: limits),
            mode: mode, script: script, untilTerminal: true)
        lock.lock(); launched.append(run); lock.unlock()
        return run
    }
}
