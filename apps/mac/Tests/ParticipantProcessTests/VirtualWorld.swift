import Darwin
import DeskHost
import Foundation
@testable import ParticipantProcess
import ParticipantSupervisorCore

// The virtual-clock test world (plan S5; Codex Q14 and Q15). Test target
// only. It drives the real `StreamJSONReader` (through `ParticipantRunCore`)
// and the real `SupervisorEngine` with invented stream-json lines and a
// simulated process group, on a clock that moves only when the world says
// so. Nothing here re-implements either one: the world only decides when
// each is called and what the simulated group does with a signal.
//
// Time: one world clock in milliseconds since the world began. Monotonic is
// that count; wall is the seed clock plus it, plus a skew a test may set to
// move the wall clock alone (for the `at` clamping rule). Each run's reader
// deadline and supervisor wake are scheduled wake-ups the world fires, not a
// timer the clock value alone could move.

/// Monotonic = elapsed world time; wall = `wallAtStart` + elapsed + skew.
final class VirtualClock: ParticipantClock, @unchecked Sendable {
    let wallAtStart: Int64
    private let lock = NSLock()
    private var elapsedMillis: UInt64 = 0
    private var skewMillis: Int64 = 0

    init(wallAtStart: Int64) {
        self.wallAtStart = wallAtStart
    }

    func monotonicMillis() -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        return elapsedMillis
    }

    func wallMillis() -> Int64 {
        lock.lock(); defer { lock.unlock() }
        return wallAtStart + Int64(elapsedMillis) + skewMillis
    }

    /// Moves time forward only.
    func set(elapsed: UInt64) {
        lock.lock(); defer { lock.unlock() }
        precondition(elapsed >= elapsedMillis, "the virtual clock never goes back")
        elapsedMillis = elapsed
    }

    /// Moves the wall clock alone, by `delta` (negative goes back).
    func skewWall(by delta: Int64) {
        lock.lock(); defer { lock.unlock() }
        skewMillis += delta
    }
}

/// The fake CLI's steps (contract section 19's script kinds, plus `line` and
/// `stderr` for tests that need a raw line), at `atMs` after the script
/// starts.
struct ScriptStep: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case initClean
        case initWithTools
        case rateLimitOK
        case rateLimitOverageAllowed
        case textDelta(String)
        case resultSuccess
        /// The CLI exits on its own with this code (wait status code << 8).
        case exit(Int32)
        /// Any invented line, written as is.
        case line(String)
        /// Invented bytes written to stderr, as is (never a vector kind).
        case stderr(String)
    }

    var atMs: UInt64
    var kind: Kind

    init(atMs: UInt64, _ kind: Kind) {
        self.atMs = atMs
        self.kind = kind
    }

    /// A vector `script` entry; throws on any kind the world does not know,
    /// so a case is never run with a step silently dropped.
    init(vector: JSONValue) throws {
        guard let fields = vector.objectValue, let at = fields["atMs"]?.safeIntegerValue, at >= 0,
              let kind = fields["kind"]?.stringValue else {
            throw VirtualWorldError.unsupported("script step \(vector)")
        }
        let known: Set<String>
        switch kind {
        case "init-clean": self.kind = .initClean; known = ["atMs", "kind"]
        case "init-with-tools": self.kind = .initWithTools; known = ["atMs", "kind"]
        case "rate-limit-ok": self.kind = .rateLimitOK; known = ["atMs", "kind"]
        case "rate-limit-overage-allowed": self.kind = .rateLimitOverageAllowed; known = ["atMs", "kind"]
        case "result-success": self.kind = .resultSuccess; known = ["atMs", "kind"]
        case "text-delta":
            guard let text = fields["text"]?.stringValue else { throw VirtualWorldError.unsupported("text-delta without text") }
            self.kind = .textDelta(text); known = ["atMs", "kind", "text"]
        case "exit":
            guard let code = fields["code"]?.safeIntegerValue, (0...255).contains(code) else {
                throw VirtualWorldError.unsupported("exit without a code")
            }
            self.kind = .exit(Int32(code)); known = ["atMs", "kind", "code"]
        default:
            throw VirtualWorldError.unsupported("script kind \(kind)")
        }
        guard Set(fields.keys) == known else { throw VirtualWorldError.unsupported("script step keys \(fields.keys.sorted())") }
        atMs = UInt64(at)
    }

    /// The stream-json lines this step writes (the `Invented` builders). A
    /// run's first text delta is preceded by `message_start` and a text
    /// block start at index 0. `exit` and `stderr` write nothing to stdout.
    func lines(firstDelta: Bool) -> [String] {
        switch kind {
        case .initClean: return [Invented.initLine()]
        case .initWithTools: return [Invented.initLine(tools: ["Bash"])]
        case .rateLimitOK: return [Invented.rateLimit()]
        case .rateLimitOverageAllowed: return [Invented.rateLimit(overageStatus: "allowed", isUsingOverage: true)]
        case .textDelta(let text):
            return (firstDelta ? [Invented.messageStart, Invented.blockStart(0)] : []) + [Invented.textDelta(text)]
        case .resultSuccess: return [Invented.result()]
        case .exit, .stderr: return []
        case .line(let line): return [line]
        }
    }

    var isTextDelta: Bool {
        if case .textDelta = kind { return true }
        return false
    }
}

/// What the simulated process group does with signals (section 19's
/// `process`), plus a supervisor that cannot spawn the CLI.
enum SimulatedProcessMode: Equatable, Sendable {
    /// The leader dies on SIGTERM or SIGKILL; no other members.
    case exitsOnSigterm
    /// The leader dies on SIGTERM or SIGKILL; one other member that no
    /// signal removes, holding the CLI's stdout and stderr open.
    case survivesSigkill
    /// The supervisor reports `spawn-failed`: there is no CLI and no group.
    case spawnFails

    init(vector: String?) throws {
        switch vector {
        case nil, "exits-on-sigterm": self = .exitsOnSigterm
        case "survives-sigkill": self = .survivesSigkill
        default: throw VirtualWorldError.unsupported("process \(vector ?? "nil")")
        }
    }
}

enum VirtualWorldError: Error, CustomStringConvertible {
    case unsupported(String)
    /// Settling went past its bound: a case that never settles fails here
    /// instead of hanging.
    case notSettled(String)
    case replayMismatch(String)

    var description: String {
        switch self {
        case .unsupported(let text): return "unsupported: \(text)"
        case .notSettled(let text): return "did not settle: \(text)"
        case .replayMismatch(let text): return "replay mismatch: \(text)"
        }
    }
}

/// Work one scripted run carries out in order, at the current millisecond.
enum ScriptedWork: Equatable {
    /// A process event for the run core, as the spawner would deliver it.
    case core(ParticipantProcessEvent)
    /// Every holder of the CLI's stdout and stderr write ends is gone: EOF
    /// on both (the run fills in its byte counts).
    case pipesClosed
    /// The supervisor read `stop` from the control socket.
    case engineStop
    /// The supervisor saw the leader's exit (kqueue `NOTE_EXIT`).
    case engineLeaderExit(Int32)
}

/// The operating system as the real `SupervisorEngine` sees it, for one run:
/// the CLI's group (leader and, in `survivesSigkill`, one member), its pipes,
/// and the supervisor's control socket. Whatever the engine causes (a
/// report, a leader killed by a signal, the pipes closing) is queued as
/// `ScriptedWork` for the run, never handed back into the engine from
/// inside its own call; a leader killed by a signal is seen at the same
/// millisecond, not on the next 50 ms tick.
final class SimulatedSupervisorSystem: SupervisorSystem {
    enum Leader: Equatable { case notSpawned, alive, zombie, reaped }

    let mode: SimulatedProcessMode
    private(set) var leader: Leader
    private(set) var survivorAlive: Bool
    private(set) var pipesOpen = true
    /// The supervisor process is running (its control socket open).
    private(set) var supervisorAlive = true
    private(set) var signals: [(at: UInt64, signal: Int32)] = []
    private(set) var reports: [(at: UInt64, message: SupervisorMessage)] = []
    /// Group probes the engine made (`otherMemberCount`).
    private(set) var probes = 0
    private(set) var signalledAfterReap = false
    private(set) var reapedWhileAlive = false
    var outbox: [ScriptedWork] = []
    private let now: () -> UInt64

    init(mode: SimulatedProcessMode, now: @escaping () -> UInt64) {
        self.mode = mode
        self.now = now
        leader = mode == .spawnFails ? .notSpawned : .alive
        survivorAlive = mode == .survivesSigkill
    }

    // MARK: SupervisorSystem

    func signalGroup(_ signal: Int32) {
        if leader == .reaped { signalledAfterReap = true }
        signals.append((now(), signal))
        // The survivor ignores every signal; the leader dies on TERM or KILL.
        if leader == .alive, signal == SIGTERM || signal == SIGKILL {
            leaderDies(status: signal)   // a wait status for "killed by signal"
        }
    }

    func otherMemberCount() -> Int? {
        probes += 1
        return survivorAlive ? 1 : 0
    }

    func reapLeader() {
        if leader == .alive { reapedWhileAlive = true }
        leader = .reaped
    }

    func report(_ message: SupervisorMessage) -> Bool {
        reports.append((now(), message))
        outbox.append(.core(.control(message)))
        return true
    }

    // MARK: What happens to the processes

    /// The leader exits with `status` (its own exit, or killed).
    func leaderDies(status: Int32) {
        guard leader == .alive else { return }
        leader = .zombie
        closePipesIfUnheld()
        if supervisorAlive { outbox.append(.engineLeaderExit(status)) }
    }

    /// `group-clears`: the surviving member exits.
    func survivorExits() {
        survivorAlive = false
        closePipesIfUnheld()
    }

    /// `pipes-close`: every holder of the CLI's stdout and stderr exits.
    func everyHolderExits() {
        survivorAlive = false
        leaderDies(status: SIGKILL)
        closePipesIfUnheld()
    }

    /// The supervisor finished (cleared, or spawn failed) and exits.
    func supervisorExits(status: Int32) {
        guard supervisorAlive else { return }
        supervisorAlive = false
        outbox.append(.core(.controlClosed))
        outbox.append(.core(.supervisorExited(status: status)))
        closePipesIfUnheld()
    }

    /// `supervisor-dies`: only the supervisor is killed; the CLI keeps its pipes.
    func supervisorKilled() {
        guard supervisorAlive else { return }
        supervisorAlive = false
        outbox.append(.core(.controlClosed))
        outbox.append(.core(.supervisorExited(status: SIGKILL)))
    }

    private func closePipesIfUnheld() {
        // Before a spawn the supervisor holds the write ends; it closes them
        // when it exits.
        let leaderHolds = leader == .alive || (leader == .notSpawned && supervisorAlive)
        guard pipesOpen, !leaderHolds, !survivorAlive else { return }
        pipesOpen = false
        outbox.append(.pipesClosed)
    }

    var signalNames: [String] {
        signals.map { "\($0.signal == SIGTERM ? "TERM" : $0.signal == SIGKILL ? "KILL" : "\($0.signal)")@\($0.at)" }
    }
}

/// An ordered timeline of script steps and actions over scripted runs, with
/// the settle rule of Codex Q15.
///
/// Settling advances, in time order, to the next timeline entry (script step
/// or action), run-core deadline or supervisor wake, firing everything due
/// at that millisecond and draining each run's queued work after every
/// input. Within one millisecond, timeline entries go first, then each run's
/// reader deadline, then its supervisor wake, repeated until nothing is due.
/// That order is a harness convention: Q15 does not set it, and the real
/// `ParticipantRun` gives no such guarantee (its timer and its stdout reads
/// race on one queue). No vector has an input and a timer at the same
/// millisecond; a test that does shows only what this harness does.
/// The work done at one millisecond (each timeline entry, each round of
/// timers) spends a budget, `sameTimeWorkBound`, that `settle`, `advance`
/// and the draining `settle` all go through: an entry that keeps adding
/// entries at `now` fails `notSettled` instead of hanging. Within one call
/// the budget holds across steps at the same millisecond (work a draining
/// coordinator adds at `now` between steps spends it too); it starts afresh
/// when time moves on or a new call begins.
/// It stops when nothing still obliges it to go on:
/// - no timeline entry is pending;
/// - no run started `untilTerminal` (a case script) lacks its terminal, so a
///   script with no exit step runs to its timeout (#47 ends 00:03:01.100),
///   and a terminal ends that obligation;
/// - no supervisor is in a stop sequence or cleanup retry;
/// - no `group-clears` action still awaits the next actual group probe.
/// A seeded running run without a script is not advanced (#55, #56); stable
/// `cleanup-pending`, or a lost supervisor with open pipes, is settled: its
/// background re-probes are not advanced and no exit or EOF is invented.
/// A bound on the number of advances fails a case that never settles.
final class VirtualWorld: @unchecked Sendable {
    let clock: VirtualClock
    /// The most timeline entries plus timer rounds one millisecond may run
    /// within one call; past it, the step throws `notSettled`.
    var sameTimeWorkBound = 10_000
    /// The millisecond the current call's budget is being spent on, and how
    /// much of it is spent.
    private var sameTimeAt: UInt64?
    private var sameTimeWork = 0
    private let lock = NSRecursiveLock()
    private var timeline: [(at: UInt64, order: Int, action: () -> Void)] = []
    private var order = 0
    private var scripted: [ScriptedParticipantRun] = []

    init(wallAtStart: Int64) {
        clock = VirtualClock(wallAtStart: wallAtStart)
    }

    /// A world whose wall clock starts at `clock` (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
    convenience init(clock: String) throws {
        guard let millis = ParticipantTimestamp.parse(clock) else { throw VirtualWorldError.unsupported("clock \(clock)") }
        self.init(wallAtStart: millis)
    }

    /// World time now, in milliseconds since the world began.
    var now: UInt64 { clock.monotonicMillis() }

    var wallNow: String { ParticipantTimestamp.format(millis: clock.wallMillis()) }

    var runs: [ScriptedParticipantRun] {
        lock.lock(); defer { lock.unlock() }
        return scripted
    }

    /// The world time at which the wall clock (without skew) reads `wall`.
    func time(ofWall wall: String) throws -> UInt64 {
        guard let millis = ParticipantTimestamp.parse(wall), millis >= clock.wallAtStart else {
            throw VirtualWorldError.unsupported("wall time \(wall) before the world began")
        }
        return UInt64(millis - clock.wallAtStart)
    }

    // MARK: Timeline

    /// Runs `action` at world time `ms`, after anything already scheduled
    /// for that millisecond. A time that has passed is refused, so a mistyped
    /// time cannot run a case later than it says. Returns the entry's id,
    /// for `cancel(_:)`.
    @discardableResult
    func at(ms: UInt64, _ action: @escaping () -> Void) throws -> Int {
        guard ms >= now else { throw VirtualWorldError.unsupported("at \(ms), before now (\(now))") }
        return schedule(ms, action)
    }

    /// Runs `action` at world time `ms`, or at the next step if that time
    /// has passed: for wake-ups other threads ask for while time moves, which
    /// must never be dropped. Returns the entry's id, for `cancel(_:)`.
    func atOrNext(ms: UInt64, _ action: @escaping () -> Void) -> Int {
        schedule(ms, action)
    }

    /// Removes a timeline entry that has not run yet; one that ran, or an
    /// unknown id, changes nothing. A cancelled entry no longer obliges
    /// settling to go on.
    func cancel(_ id: Int) {
        lock.lock(); defer { lock.unlock() }
        timeline.removeAll { $0.order == id }
    }

    @discardableResult
    private func schedule(_ ms: UInt64, _ action: @escaping () -> Void) -> Int {
        lock.lock(); defer { lock.unlock() }
        order += 1
        timeline.append((ms, order, action))
        timeline.sort { ($0.at, $0.order) < ($1.at, $1.order) }
        return order
    }

    /// Starts a scripted run now. Its script plays from now; `untilTerminal`
    /// obliges settling to reach its terminal. `supervisorTiming` other than
    /// the contract's is for tests of the harness itself.
    @discardableResult
    func launch(identity: ParticipantRunIdentity, configuration: StreamJSONReader.Configuration,
                mode: SimulatedProcessMode = .exitsOnSigterm, script: [ScriptStep] = [], untilTerminal: Bool = true,
                processLimits: ParticipantProcessLimits = ParticipantProcessLimits(),
                supervisorTiming: SupervisorTiming = .contract,
                log: ParticipantLogSink = RecordingLog()) -> ScriptedParticipantRun {
        lock.lock(); defer { lock.unlock() }
        let run = ScriptedParticipantRun(identity: identity, configuration: configuration, mode: mode,
                                         processLimits: processLimits, supervisorTiming: supervisorTiming,
                                         clock: clock, log: log)
        scripted.append(run)
        run.start()
        play(script, on: run, untilTerminal: untilTerminal)
        return run
    }

    /// Plays `script` on `run` from now (section 19's `run-script`).
    func play(_ script: [ScriptStep], on run: ScriptedParticipantRun, untilTerminal: Bool) {
        lock.lock(); defer { lock.unlock() }
        if untilTerminal { run.untilTerminal = true }
        let start = now
        for step in script {
            schedule(start + step.atMs) { run.deliver(step) }
        }
    }

    // MARK: Actions (section 19)

    /// `group-clears`: the surviving members exit; settling then advances
    /// through the next actual probe.
    func groupClears(_ run: ScriptedParticipantRun) { run.groupClears() }

    /// `supervisor-dies`: only the supervisor is killed; the CLI keeps its pipes.
    func supervisorDies(_ run: ScriptedParticipantRun) { run.supervisorDies() }

    /// `pipes-close`: every holder of the CLI's stdout and stderr exits.
    func pipesClose(_ run: ScriptedParticipantRun) { run.pipesClose() }

    /// Not a section 19 action: the pipes' EOF reaches the run only at `ms`,
    /// however early the pipes close, as when the supervisor's reports
    /// overtake stdout bytes still in the pipe (the reader's exit-decision
    /// grace).
    func delayPipeEOF(_ run: ScriptedParticipantRun, until ms: UInt64) throws {
        run.holdPipeEOF()
        try at(ms: ms) { run.releasePipeEOF() }
    }

    // MARK: Advancing

    /// Fires everything due up to and including `target`, in order, then
    /// sets the clock to `target`. Nothing here asks whether anything is
    /// obliged: time simply passes for every run. A target that has passed
    /// is refused.
    func advance(to target: UInt64, maxAdvances: Int = 1_000_000) throws {
        guard target >= now else { throw VirtualWorldError.unsupported("advance to \(target), before now (\(now))") }
        sameTimeAt = nil
        var advances = 0
        while let next = nextTime(), next <= target {
            advances += 1
            guard advances <= maxAdvances else { throw VirtualWorldError.notSettled("advance to \(target) at \(now)") }
            try step(to: next)
        }
        clock.set(elapsed: target)
    }

    func advance(toWall wall: String) throws {
        try advance(to: try time(ofWall: wall))
    }

    /// The settle rule above. `maxAdvances` is the test-level bound.
    func settle(maxAdvances: Int = 100_000) throws {
        sameTimeAt = nil
        var advances = 0
        while let reason = obligation() {
            guard let next = nextTime() else { throw VirtualWorldError.notSettled("\(reason) with nothing scheduled") }
            advances += 1
            guard advances <= maxAdvances else {
                throw VirtualWorldError.notSettled("\(reason) after \(maxAdvances) advances, at \(wallNow)")
            }
            try step(to: next)
        }
    }

    /// The same, letting `drain` (a later slice's coordinator) finish its
    /// queued work between advances; a `drain` that throws stops settling
    /// at once.
    func settle(maxAdvances: Int = 100_000, draining drain: () async throws -> Void) async throws {
        sameTimeAt = nil
        var advances = 0
        try await drain()
        while let reason = obligation() {
            guard let next = nextTime() else { throw VirtualWorldError.notSettled("\(reason) with nothing scheduled") }
            advances += 1
            guard advances <= maxAdvances else {
                throw VirtualWorldError.notSettled("\(reason) after \(maxAdvances) advances, at \(wallNow)")
            }
            try step(to: next)
            try await drain()
        }
    }

    /// Why settling must go on, or nil when it is settled.
    func obligation() -> String? {
        lock.lock(); defer { lock.unlock() }
        if let first = timeline.first { return "a timeline entry at \(first.at)" }
        for run in scripted {
            if let reason = run.obligation() { return "\(run.identity.runId): \(reason)" }
        }
        return nil
    }

    private func nextTime() -> UInt64? {
        lock.lock(); defer { lock.unlock() }
        let candidates = [timeline.first?.at] + scripted.map { $0.nextDueTime() }
        return candidates.compactMap { $0 }.min()
    }

    /// One millisecond: its timeline entries in order (an entry may add
    /// more at `now`, which run after those already there), then each run's
    /// reader deadline and supervisor wake, until nothing is due. Each entry
    /// and each round of timers spends one unit of `sameTimeWorkBound`,
    /// shared with this call's earlier steps at the same millisecond.
    private func step(to time: UInt64) throws {
        if time > now { clock.set(elapsed: time) }
        if sameTimeAt != time {
            sameTimeAt = time
            sameTimeWork = 0
        }
        func spend(_ what: String) throws {
            sameTimeWork += 1
            guard sameTimeWork <= sameTimeWorkBound else {
                throw VirtualWorldError.notSettled("\(what) keep coming at \(time): \(sameTimeWorkBound) units of work")
            }
        }
        while hasDue(time) {
            try spend("timeline entries")
            popDue(time)?()
        }
        while runs.reduce(false, { $1.fireDue(now: time) || $0 }) {
            try spend("timers")
        }
    }

    private func hasDue(_ time: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return timeline.first.map { $0.at <= time } ?? false
    }

    private func popDue(_ time: UInt64) -> (() -> Void)? {
        lock.lock(); defer { lock.unlock() }
        guard let first = timeline.first, first.at <= time else { return nil }
        timeline.removeFirst()
        return first.action
    }
}

extension VirtualWorld {
    /// Replays a seeded running run (plan S9's rule): `init-clean`,
    /// `rate-limit-ok` and, for each retained text event, its delta 250 ms
    /// before its `at`, all from the first retained event's `at`; then
    /// advances to the last retained `at` and requires the replayed events
    /// to equal `retained`, byte for byte. Not `untilTerminal`: a seeded
    /// running run stays running until something acts on it.
    func replayRunning(identity: ParticipantRunIdentity, configuration: StreamJSONReader.Configuration,
                       mode: SimulatedProcessMode, retained: [ParticipantEvent],
                       log: ParticipantLogSink = RecordingLog()) throws -> ScriptedParticipantRun {
        guard let first = retained.first, first.type == .started,
              retained.allSatisfy({ $0.type == .started || $0.type == .text }) else {
            throw VirtualWorldError.unsupported("a running seed is started then text")
        }
        let start = try time(ofWall: first.at)
        try advance(to: start)
        var script = [ScriptStep(atMs: 0, .initClean), ScriptStep(atMs: 0, .rateLimitOK)]
        for event in retained where event.type == .text {
            let at = try time(ofWall: event.at)
            guard at >= start + 250, let text = event.text else { throw VirtualWorldError.unsupported("text before started + 250 ms") }
            script.append(ScriptStep(atMs: at - 250 - start, .textDelta(text)))
        }
        let run = launch(identity: identity, configuration: configuration, mode: mode, script: script,
                         untilTerminal: false, log: log)
        try advance(to: try time(ofWall: retained.last!.at))
        let replayed = run.events
        guard replayed.count == retained.count else {
            throw VirtualWorldError.replayMismatch("\(replayed.count) events, \(retained.count) retained")
        }
        for (made, kept) in zip(replayed, retained) {
            if let difference = VectorReplay.difference(made.jsonValue, kept.jsonValue) {
                throw VirtualWorldError.replayMismatch("sequence \(kept.sequence): \(difference)")
            }
        }
        return run
    }
}

extension Array where Element == ParticipantRunUpdate {
    /// Every event in order, the terminal included.
    var events: [ParticipantEvent] {
        compactMap { update in
            switch update {
            case .event(let event), .terminal(let event, _): return event
            default: return nil
            }
        }
    }

    var terminalUpdate: (event: ParticipantEvent, groupCleared: Bool?)? {
        for update in self {
            if case .terminal(let event, let cleared) = update { return (event, cleared) }
        }
        return nil
    }
}
