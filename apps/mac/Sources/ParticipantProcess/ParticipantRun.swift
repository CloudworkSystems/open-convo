import Darwin
import Foundation
import ParticipantSupervisorCore

/// Clocks the run reads: monotonic for timers, wall for event `at`.
public protocol ParticipantClock: Sendable {
    func monotonicMillis() -> UInt64
    func wallMillis() -> Int64
}

public struct SystemParticipantClock: ParticipantClock {
    public init() {}

    public func monotonicMillis() -> UInt64 {
        clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000
    }

    public func wallMillis() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}

/// The ids an event carries, and the run's `createdAt`.
public struct ParticipantRunIdentity: Equatable, Sendable {
    public var runId: String
    public var sessionId: String
    /// `createdAt` in milliseconds since 1970; no event is earlier.
    public var createdAtMillis: Int64

    public init(runId: String, sessionId: String, createdAtMillis: Int64) {
        self.runId = runId
        self.sessionId = sessionId
        self.createdAtMillis = createdAtMillis
    }
}

/// Whether this launch still owns the run's process group.
public enum ParticipantCleanupState: Equatable, Sendable {
    /// No terminal yet, or a terminal with the group not confirmed gone.
    case owned
    /// The group is confirmed gone, or ownership is lost (supervisor gone and
    /// both output pipes at EOF; a failed read is not EOF, so after one this
    /// never comes from the pipes). Nothing of the run blocks a start.
    case released
}

public enum ParticipantRunUpdate: Equatable, Sendable {
    /// `started` or `text`.
    case event(ParticipantEvent)
    /// The run's one terminal event (`completed`, `stopped` or `failed`)
    /// with the `groupCleared` recorded with it, in one update: true once
    /// the group is confirmed gone, false when it is not (uncleared, or the
    /// supervisor lost; never later true then), null when nothing ran.
    case terminal(ParticipantEvent, groupCleared: Bool?)
    /// A terminal recorded `groupCleared: false`; the group has since cleared.
    case groupCleared
    /// After an uncleared terminal, a cleanup retry (a `stop()`) cannot clear
    /// the group now: the retry ended with members left, or the supervisor
    /// was lost while an output pipe was not at EOF (a loss that finds both
    /// pipes at EOF gives `cleanupReleased` instead). Nothing changes and
    /// nothing new is recorded; a Stop waiting on the retry can answer.
    case cleanupRetryUncleared
    case cleanupReleased
    /// Paid overflow may have been in use (section 17): the owner of a
    /// confirmation that paid usage is off ends it. A paid-overflow end; an
    /// overflow signal before init (the end stays `process-error`) or read
    /// after another end (which keeps its terminal); or stdout that could
    /// not be read to its EOF (a bound, or a failed read). Not an event: no
    /// sequence, never on the wire, no change to any terminal; logged as
    /// `overflow-observed`. At most once per run, before or after the
    /// terminal, and always before the updates finish.
    case overflowObserved
}

/// What a status read sees, from memory only.
public struct ParticipantRunSnapshot: Equatable, Sendable {
    public var lastSequence: Int
    public var terminal: ParticipantEvent?
    public var groupCleared: Bool?
    public var cleanup: ParticipantCleanupState

    /// Public so another run kind behind the same seam (the local route,
    /// contract section 20.4) can report its own state.
    public init(lastSequence: Int, terminal: ParticipantEvent?, groupCleared: Bool?, cleanup: ParticipantCleanupState) {
        self.lastSequence = lastSequence
        self.terminal = terminal
        self.groupCleared = groupCleared
        self.cleanup = cleanup
    }
}

/// One run: a spawned supervisor and CLI, read through `StreamJSONReader`,
/// numbered into participant events by `ParticipantRunCore`. Every input is
/// handled on one serial queue; `stop()` writes `stop` to the supervisor
/// before it touches anything else.
///
/// A run keeps itself alive until its process events have ended (each output
/// pipe at EOF or its read failed, the control socket closed and the
/// supervisor reaped), so the rules only it enforces (the timeouts, paid
/// overflow, reply-too-long) still stop the CLI if its owner lets go of it
/// early. A failed read is not EOF and does not prove the CLI exited: the
/// updates can then finish with cleanup still pending.
public final class ParticipantRun: @unchecked Sendable {
    public let updates: AsyncStream<ParticipantRunUpdate>

    private let identity: ParticipantRunIdentity
    private let process: SpawnedParticipant
    private let clock: ParticipantClock
    private let log: ParticipantLogSink
    private let queue = DispatchQueue(label: "participant-run")
    private let continuation: AsyncStream<ParticipantRunUpdate>.Continuation
    private var core: ParticipantRunCore
    private var timer: DispatchSourceTimer?

    public init(identity: ParticipantRunIdentity, process: SpawnedParticipant,
                configuration: StreamJSONReader.Configuration,
                clock: ParticipantClock = SystemParticipantClock(),
                log: ParticipantLogSink = SystemParticipantLog()) {
        self.identity = identity
        self.process = process
        self.clock = clock
        self.log = log
        self.core = ParticipantRunCore(identity: identity, configuration: configuration)
        var continuation: AsyncStream<ParticipantRunUpdate>.Continuation!
        self.updates = AsyncStream(bufferingPolicy: .unbounded) { continuation = $0 }
        self.continuation = continuation
        log.record(ParticipantLogEntry(runId: identity.runId, kind: .supervisorSpawned))

        // Strong on purpose: the run lives while its process events do (see
        // above), and is freed once they end.
        let events = process.events
        Task.detached { [self, queue] in
            for await event in events {
                queue.async { self.handle(event) }
            }
            queue.async { self.processEnded() }
        }
    }

    /// User Stop, lock, window close or quit; also the cleanup retry once a
    /// terminal exists. Writes `stop` first, from memory only, then lets the
    /// reader record the decision.
    ///
    /// Returns whether that write reached the supervisor's control socket:
    /// false once the socket is closed (the supervisor is gone, so nothing
    /// can be signalled and no retry is possible). True means only that the
    /// local write succeeded, never that the CLI, its group or the provider
    /// stopped; the updates say what happened.
    @discardableResult
    public func stop() -> Bool {
        let sent = process.sendStop()
        queue.async { [self] in
            perform(core.stopRequested(stopSent: sent, monotonic: clock.monotonicMillis(), wall: clock.wallMillis()))
            rearmTimer()
        }
        return sent
    }

    public var snapshot: ParticipantRunSnapshot {
        queue.sync { core.snapshot }
    }

    // MARK: Inputs

    private func handle(_ event: ParticipantProcessEvent) {
        perform(core.process(event, monotonic: clock.monotonicMillis(), wall: clock.wallMillis()))
        switch event {
        case .control, .controlClosed, .stdout, .stdoutLimitReached, .stdoutClosed, .stdoutReadFailed,
             .stderrClosed, .stderrReadFailed:
            rearmTimer()
        case .stderr, .stdinClosed, .supervisorExited:
            break   // the reader's deadlines cannot have moved
        }
    }

    private func processEnded() {
        timer?.cancel()
        timer = nil
        // Anything the core still owes (section 17's observation) goes out
        // before the updates finish.
        perform(core.updatesFinishing(wall: clock.wallMillis()))
        continuation.finish()
    }

    private func tick() {
        perform(core.tick(monotonic: clock.monotonicMillis(), wall: clock.wallMillis()))
        rearmTimer()
    }

    // MARK: Outputs

    /// Carries out the core's effects in order: yields, native's own `stop`
    /// writes and log entries.
    private func perform(_ effects: [ParticipantRunCore.Effect]) {
        for effect in effects {
            switch effect {
            case .update(let update):
                continuation.yield(update)
            case .sendStop:
                if process.sendStop() {
                    log.record(ParticipantLogEntry(runId: identity.runId, kind: .stopSent))
                }
            case .log(let entry):
                log.record(entry)
            }
        }
    }

    private func rearmTimer() {
        guard let deadline = core.nextDeadline() else {
            timer?.cancel()
            timer = nil
            return
        }
        let now = clock.monotonicMillis()
        let delay = deadline > now ? deadline - now : 0
        if timer == nil {
            let source = DispatchSource.makeTimerSource(queue: queue)
            source.setEventHandler { [weak self] in self?.tick() }
            source.resume()
            timer = source
        }
        timer?.schedule(deadline: .now() + .milliseconds(Int(min(delay, 3_600_000))), leeway: .milliseconds(5))
    }
}
