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
    /// both output pipes at EOF). Nothing of the run blocks a start.
    case released
}

public enum ParticipantRunUpdate: Equatable, Sendable {
    case event(ParticipantEvent)
    /// A terminal recorded `groupCleared: false`; the group has since cleared.
    case groupCleared
    case cleanupReleased
}

/// What a status read sees, from memory only.
public struct ParticipantRunSnapshot: Equatable, Sendable {
    public var lastSequence: Int
    public var terminal: ParticipantEvent?
    public var groupCleared: Bool?
    public var cleanup: ParticipantCleanupState
}

/// One run: a spawned supervisor and CLI, read through `StreamJSONReader`,
/// numbered into participant events. Every input is handled on one serial
/// queue; `stop()` writes `stop` to the supervisor before it touches anything
/// else.
///
/// A run keeps itself alive until its process has ended (every pipe and the
/// control socket closed and the supervisor reaped), so the rules only it
/// enforces (the timeouts, paid overflow, reply-too-long) still stop the CLI
/// if its owner lets go of it early.
public final class ParticipantRun: @unchecked Sendable {
    public let updates: AsyncStream<ParticipantRunUpdate>

    private let identity: ParticipantRunIdentity
    private let process: SpawnedParticipant
    private let clock: ParticipantClock
    private let log: ParticipantLogSink
    private let queue = DispatchQueue(label: "participant-run")
    private let continuation: AsyncStream<ParticipantRunUpdate>.Continuation
    private var reader: StreamJSONReader
    private var timer: DispatchSourceTimer?
    private var sequence = 0
    private var lastAtMillis: Int64
    private var terminalEvent: ParticipantEvent?
    private var groupCleared: Bool?
    private var released = false

    public init(identity: ParticipantRunIdentity, process: SpawnedParticipant,
                configuration: StreamJSONReader.Configuration,
                clock: ParticipantClock = SystemParticipantClock(),
                log: ParticipantLogSink = SystemParticipantLog()) {
        self.identity = identity
        self.process = process
        self.clock = clock
        self.log = log
        self.reader = StreamJSONReader(configuration: configuration)
        self.lastAtMillis = identity.createdAtMillis
        var continuation: AsyncStream<ParticipantRunUpdate>.Continuation!
        self.updates = AsyncStream(bufferingPolicy: .unbounded) { continuation = $0 }
        self.continuation = continuation
        log.record(ParticipantLogEntry(runId: identity.runId, kind: .supervisorSpawned))

        // Strong on purpose: the run lives while its process does (see above),
        // and is freed once the events end.
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
    public func stop() {
        let sent = process.sendStop()
        queue.async { [self] in
            if sent { log.record(ParticipantLogEntry(runId: identity.runId, kind: .stopSent)) }
            apply(reader.stopRequested(now: clock.monotonicMillis()))
        }
    }

    public var snapshot: ParticipantRunSnapshot {
        queue.sync {
            ParticipantRunSnapshot(lastSequence: sequence, terminal: terminalEvent,
                                   groupCleared: groupCleared, cleanup: released ? .released : .owned)
        }
    }

    // MARK: Inputs

    private func handle(_ event: ParticipantProcessEvent) {
        let now = clock.monotonicMillis()
        switch event {
        case .control(let message):
            switch message {
            case .spawned:
                log.record(ParticipantLogEntry(runId: identity.runId, kind: .cliSpawned))
            case .spawnFailed:
                log.record(ParticipantLogEntry(runId: identity.runId, kind: .cliSpawnFailed))
            case .exit(let status):
                let decoded = ParticipantWaitStatus.decode(status)
                log.record(ParticipantLogEntry(runId: identity.runId, kind: .cliExited,
                                               exitCode: decoded.exitCode, signal: decoded.signal))
            case .cleared:
                log.record(ParticipantLogEntry(runId: identity.runId, kind: .groupCleared))
            case .uncleared:
                log.record(ParticipantLogEntry(runId: identity.runId, kind: .groupUncleared))
            }
            apply(reader.supervisor(message, now: now))
        case .controlClosed:
            let outputs = reader.controlClosed(now: now)
            if reader.supervisorLost {
                log.record(ParticipantLogEntry(runId: identity.runId, kind: .supervisorLost))
            }
            apply(outputs)
        case .stdout(let bytes):
            apply(reader.consumeStdout(bytes, now: now))
        case .stdoutLimitReached:
            apply(reader.stdoutLimitReached(now: now))
        case .stdoutClosed(let total):
            log.record(ParticipantLogEntry(runId: identity.runId, kind: .stdoutClosed, byteCount: total))
            apply(reader.stdoutClosed(now: now))
        case .stderr(let bytes):
            reader.consumeStderr(bytes)
        case .stderrClosed(let total):
            log.record(ParticipantLogEntry(runId: identity.runId, kind: .stderrClosed, byteCount: total,
                                           reason: .stderr(reader.stderrReason)))
            apply(reader.stderrClosed(now: now))
        case .stdinClosed(let written, _):
            log.record(ParticipantLogEntry(runId: identity.runId, kind: .stdinClosed, byteCount: written))
        case .supervisorExited(let status):
            let decoded = ParticipantWaitStatus.decode(status)
            log.record(ParticipantLogEntry(runId: identity.runId, kind: .supervisorExited,
                                           exitCode: decoded.exitCode, signal: decoded.signal))
        }
    }

    private func processEnded() {
        timer?.cancel()
        timer = nil
        continuation.finish()
    }

    private func tick() {
        apply(reader.tick(now: clock.monotonicMillis()))
    }

    // MARK: Outputs

    private func apply(_ outputs: [StreamJSONReader.Output]) {
        for output in outputs {
            switch output {
            case .started:
                emit(.started)
            case .text(let text):
                emit(.text, text: text)
            case .terminal(let terminal, let cleared):
                groupCleared = cleared
                terminalEvent = emit(terminal.type, reason: terminal.reason)
                if let reason = terminalReason(terminal) {
                    log.record(ParticipantLogEntry(runId: identity.runId, kind: .event, eventType: terminal.type,
                                                   sequence: sequence, reason: reason))
                }
            case .sendStop:
                if process.sendStop() {
                    log.record(ParticipantLogEntry(runId: identity.runId, kind: .stopSent))
                }
            case .groupClearedAfterTerminal:
                groupCleared = true
                continuation.yield(.groupCleared)
            case .cleanupReleased:
                released = true
                log.record(ParticipantLogEntry(runId: identity.runId, kind: .cleanupReleased))
                continuation.yield(.cleanupReleased)
            }
        }
        rearmTimer()
    }

    @discardableResult
    private func emit(_ type: ParticipantEventType, text: String? = nil, reason: String? = nil) -> ParticipantEvent {
        sequence += 1
        lastAtMillis = max(clock.wallMillis(), lastAtMillis, identity.createdAtMillis)
        let event = ParticipantEvent(runId: identity.runId, sessionId: identity.sessionId, sequence: sequence,
                                     at: ParticipantTimestamp.format(millis: lastAtMillis),
                                     type: type, text: text, reason: reason)
        if type != .stopped, type != .failed, type != .completed {
            log.record(ParticipantLogEntry(runId: identity.runId, kind: .event, eventType: type, sequence: sequence,
                                           byteCount: text.map { $0.utf8.count }))
        } else if type == .completed {
            log.record(ParticipantLogEntry(runId: identity.runId, kind: .event, eventType: type, sequence: sequence))
        }
        continuation.yield(.event(event))
        return event
    }

    private func terminalReason(_ terminal: ParticipantTerminal) -> ParticipantLogReason? {
        switch terminal {
        case .completed: return nil
        case .stopped(let reason): return .stop(reason)
        case .failed(let reason): return .failure(reason)
        }
    }

    private func rearmTimer() {
        guard let deadline = reader.nextDeadline() else {
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
