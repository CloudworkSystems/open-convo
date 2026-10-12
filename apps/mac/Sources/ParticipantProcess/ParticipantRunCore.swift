import Foundation
import ParticipantSupervisorCore

/// The pure part of one run (contract sections 8 and 10): the stream reader,
/// event numbering from 1, the `at` rule, the one terminal with the
/// `groupCleared` it records, and cleanup. It owns no queue, timer, clock or
/// process: every input carries the monotonic time (the reader's timers) and
/// the wall time (`at`) in milliseconds, and each answer is a list of
/// effects the caller carries out in order. `ParticipantRun` drives it from
/// a real process; a test or a vector harness drives it on an invented clock.
///
/// A Stop is written to the supervisor before the core hears of it (section
/// 11): the caller writes `stop` first, then calls `stopRequested`. A
/// `.sendStop` effect is only ever native's own decision to end the run.
public struct ParticipantRunCore {
    public enum Effect: Equatable, Sendable {
        /// Yield this to the run's one consumer.
        case update(ParticipantRunUpdate)
        /// Native decided to end the run: write `stop` to the supervisor, and
        /// log `stop-sent` if it went out.
        case sendStop
        /// Record this entry.
        case log(ParticipantLogEntry)
    }

    public let identity: ParticipantRunIdentity
    private var reader: StreamJSONReader
    private var sequence = 0
    private var lastAtMillis: Int64
    private var terminalEvent: ParticipantEvent?
    private var groupCleared: Bool?
    private var released = false

    public init(identity: ParticipantRunIdentity, configuration: StreamJSONReader.Configuration) {
        self.identity = identity
        self.reader = StreamJSONReader(configuration: configuration)
        self.lastAtMillis = identity.createdAtMillis
    }

    /// What a status read sees: what the effects returned so far report. It
    /// changes as soon as `process`, `stopRequested` or `tick` returns, before
    /// the caller has yielded, logged or stored anything; a caller whose
    /// ordering depends on it (signal before store, status after the push)
    /// carries out those effects before it lets anything read the snapshot.
    /// `ParticipantRun` does both on its one queue.
    public var snapshot: ParticipantRunSnapshot {
        ParticipantRunSnapshot(lastSequence: sequence, terminal: terminalEvent,
                               groupCleared: groupCleared, cleanup: released ? .released : .owned)
    }

    /// The earliest monotonic time `tick` has something to do, if any.
    public func nextDeadline() -> UInt64? {
        reader.nextDeadline()
    }

    // MARK: Inputs

    /// One process event, as the spawner delivers it.
    public mutating func process(_ event: ParticipantProcessEvent, monotonic now: UInt64, wall: Int64) -> [Effect] {
        var effects: [Effect] = []
        switch event {
        case .control(let message):
            switch message {
            case .spawned:
                effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .cliSpawned)))
            case .spawnFailed:
                effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .cliSpawnFailed)))
            case .exit(let status):
                let decoded = ParticipantWaitStatus.decode(status)
                effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .cliExited,
                                                        exitCode: decoded.exitCode, signal: decoded.signal)))
            case .cleared:
                effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .groupCleared)))
            case .uncleared:
                effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .groupUncleared)))
            }
            apply(reader.supervisor(message, now: now), wall: wall, into: &effects)
        case .controlClosed:
            let outputs = reader.controlClosed(now: now)
            if reader.supervisorLost {
                effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .supervisorLost)))
            }
            apply(outputs, wall: wall, into: &effects)
        case .stdout(let bytes):
            apply(reader.consumeStdout(bytes, now: now), wall: wall, into: &effects)
        case .stdoutLimitReached:
            apply(reader.stdoutLimitReached(now: now), wall: wall, into: &effects)
        case .stdoutClosed(let total):
            effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .stdoutClosed, byteCount: total)))
            apply(reader.stdoutClosed(now: now), wall: wall, into: &effects)
        case .stdoutReadFailed(_, let failure):
            // A fixed kind and the errno's class only: not EOF (section 17).
            effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .stdoutReadFailed,
                                                    reason: .readFailure(failure))))
            apply(reader.stdoutReadFailed(now: now), wall: wall, into: &effects)
        case .stderr(let bytes):
            reader.consumeStderr(bytes)
        case .stderrClosed(let total):
            effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .stderrClosed, byteCount: total,
                                                    reason: .stderr(reader.stderrReason))))
            apply(reader.stderrClosed(now: now), wall: wall, into: &effects)
        case .stderrReadFailed(_, let failure):
            effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .stderrReadFailed,
                                                    reason: .readFailure(failure))))
            apply(reader.stderrReadFailed(now: now), wall: wall, into: &effects)
        case .stdinClosed(let written, _):
            effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .stdinClosed, byteCount: written)))
        case .supervisorExited(let status):
            let decoded = ParticipantWaitStatus.decode(status)
            effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .supervisorExited,
                                                    exitCode: decoded.exitCode, signal: decoded.signal)))
        }
        return effects
    }

    /// User Stop, lock, window close or quit; also the cleanup retry once a
    /// terminal exists. The caller has already written `stop`; `stopSent`
    /// says whether that write reached the supervisor.
    public mutating func stopRequested(stopSent: Bool, monotonic now: UInt64, wall: Int64) -> [Effect] {
        var effects: [Effect] = []
        if stopSent { effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .stopSent))) }
        apply(reader.stopRequested(now: now), wall: wall, into: &effects)
        return effects
    }

    /// The reader's timers: coalescing, the three timeouts and the exit grace.
    public mutating func tick(monotonic now: UInt64, wall: Int64) -> [Effect] {
        var effects: [Effect] = []
        apply(reader.tick(now: now), wall: wall, into: &effects)
        return effects
    }

    /// The process's events have ended and the caller is about to finish the
    /// run's updates: carry these out first. Only `overflowObserved` and its
    /// log entry, when stdout's EOF was never read and nothing observed yet
    /// (section 17); nothing else changes.
    public mutating func updatesFinishing(wall: Int64) -> [Effect] {
        var effects: [Effect] = []
        apply(reader.updatesFinishing(), wall: wall, into: &effects)
        return effects
    }

    // MARK: Outputs

    private mutating func apply(_ outputs: [StreamJSONReader.Output], wall: Int64, into effects: inout [Effect]) {
        for output in outputs {
            switch output {
            case .started:
                let event = emit(.started, wall: wall, into: &effects)
                effects.append(.update(.event(event)))
            case .text(let text):
                let event = emit(.text, text: text, wall: wall, into: &effects)
                effects.append(.update(.event(event)))
            case .terminal(let terminal, let cleared):
                // The terminal and the `groupCleared` it records are one
                // update, so a consumer never sees one without the other.
                groupCleared = cleared
                let event = emit(terminal.type, reason: terminal.reason, wall: wall, into: &effects)
                terminalEvent = event
                effects.append(.update(.terminal(event, groupCleared: cleared)))
                if let reason = terminalReason(terminal) {
                    effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .event, eventType: terminal.type,
                                                            sequence: sequence, reason: reason)))
                }
            case .sendStop:
                effects.append(.sendStop)
            case .groupClearedAfterTerminal:
                groupCleared = true
                effects.append(.update(.groupCleared))
            case .cleanupRetryUncleared:
                effects.append(.update(.cleanupRetryUncleared))
            case .cleanupReleased:
                released = true
                effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .cleanupReleased)))
                effects.append(.update(.cleanupReleased))
            case .overflowObserved:
                // Not an event: no sequence, no `at`, never on the wire. The
                // update goes first, then a text-free log entry.
                effects.append(.update(.overflowObserved))
                effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .overflowObserved)))
            }
        }
    }

    /// Numbers the next event and sets its `at`; logs it unless it is a
    /// `stopped` or `failed` terminal, which is logged with its reason after
    /// it is yielded.
    private mutating func emit(_ type: ParticipantEventType, text: String? = nil, reason: String? = nil, wall: Int64,
                               into effects: inout [Effect]) -> ParticipantEvent {
        sequence += 1
        lastAtMillis = ParticipantEventTime.atMillis(wall: wall, previous: lastAtMillis, createdAt: identity.createdAtMillis)
        let event = ParticipantEvent(runId: identity.runId, sessionId: identity.sessionId, sequence: sequence,
                                     at: ParticipantTimestamp.format(millis: lastAtMillis),
                                     type: type, text: text, reason: reason)
        if type != .stopped, type != .failed, type != .completed {
            effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .event, eventType: type, sequence: sequence,
                                                    byteCount: text.map { $0.utf8.count })))
        } else if type == .completed {
            effects.append(.log(ParticipantLogEntry(runId: identity.runId, kind: .event, eventType: type, sequence: sequence)))
        }
        return event
    }

    private func terminalReason(_ terminal: ParticipantTerminal) -> ParticipantLogReason? {
        switch terminal {
        case .completed: return nil
        case .stopped(let reason): return .stop(reason)
        case .failed(let reason): return .failure(reason)
        }
    }
}
