import Foundation
import os
import TrueConvoIdentity

/// What a participant log entry is about.
public enum ParticipantLogKind: String, Sendable, CaseIterable {
    case supervisorSpawned = "supervisor-spawned"
    case supervisorExited = "supervisor-exited"
    case supervisorLost = "supervisor-lost"
    case cliSpawned = "cli-spawned"
    case cliSpawnFailed = "cli-spawn-failed"
    case cliExited = "cli-exited"
    case stopSent = "stop-sent"
    case stdinClosed = "stdin-closed"
    case stdoutClosed = "stdout-closed"
    /// Reading stdout failed before EOF; the reason is the errno's fixed class.
    case stdoutReadFailed = "stdout-read-failed"
    case stderrClosed = "stderr-closed"
    /// Reading stderr failed before EOF; the reason is the errno's fixed class.
    case stderrReadFailed = "stderr-read-failed"
    case event
    case groupCleared = "group-cleared"
    case groupUncleared = "group-uncleared"
    case cleanupReleased = "cleanup-released"
    /// Paid overflow may have been in use (section 17's observation): no
    /// event, and the terminal keeps its own reason.
    case overflowObserved = "overflow-observed"
    /// The launcher could not remove a run's working folder; it may remain.
    case workingFolderNotRemoved = "working-folder-not-removed"
    /// A spawned run's terminal or cleanup write found another terminal, or
    /// no entry, in the store: never replaced or retried, so every start
    /// stays busy until the app quits (Codex Q31). Logged once per run.
    case writeConflict = "write-conflict"
}

/// A fixed reason a log entry may carry. Only these enums' raw values ever
/// reach a log.
public enum ParticipantLogReason: Equatable, Sendable {
    case stop(ParticipantStopReason)
    case failure(ParticipantFailureReason)
    case stderr(StderrReason)
    case readFailure(ParticipantReadFailure)

    public var rawValue: String {
        switch self {
        case .stop(let reason): return reason.rawValue
        case .failure(let reason): return reason.rawValue
        case .stderr(let reason): return reason.rawValue
        case .readFailure(let failure): return failure.rawValue
        }
    }
}

/// One log entry. By construction it holds only ids, event types, byte
/// counts, exit codes and fixed reasons: no prompt, reply or stderr text, no
/// account field, process id or path.
public struct ParticipantLogEntry: Equatable, Sendable {
    public let runId: String
    public let kind: ParticipantLogKind
    public let eventType: ParticipantEventType?
    public let sequence: Int?
    public let byteCount: Int?
    public let exitCode: Int32?
    public let signal: Int32?
    public let reason: ParticipantLogReason?

    public init(runId: String, kind: ParticipantLogKind, eventType: ParticipantEventType? = nil,
                sequence: Int? = nil, byteCount: Int? = nil, exitCode: Int32? = nil,
                signal: Int32? = nil, reason: ParticipantLogReason? = nil) {
        self.runId = runId
        self.kind = kind
        self.eventType = eventType
        self.sequence = sequence
        self.byteCount = byteCount
        self.exitCode = exitCode
        self.signal = signal
        self.reason = reason
    }

    /// The entry as one line of `key=value` fields.
    public var line: String {
        var fields = ["run=\(runId)", "kind=\(kind.rawValue)"]
        if let eventType { fields.append("event=\(eventType.rawValue)") }
        if let sequence { fields.append("sequence=\(sequence)") }
        if let byteCount { fields.append("bytes=\(byteCount)") }
        if let exitCode { fields.append("exit=\(exitCode)") }
        if let signal { fields.append("signal=\(signal)") }
        if let reason { fields.append("reason=\(reason.rawValue)") }
        return fields.joined(separator: " ")
    }
}

public protocol ParticipantLogSink: Sendable {
    func record(_ entry: ParticipantLogEntry)
}

/// The app's log: unified logging, one line per entry.
public struct SystemParticipantLog: ParticipantLogSink {
    /// `com.trueconvo.voice-cursor`, or the test copy's own subsystem.
    private static let logger = Logger(subsystem: AppIdentity.current.logSubsystem, category: "participant")

    public init() {}

    public func record(_ entry: ParticipantLogEntry) {
        // Every field is an id, a count, a code or a fixed reason.
        Self.logger.log("\(entry.line, privacy: .public)")
    }
}

/// How a wait status reads in a log entry.
public enum ParticipantWaitStatus {
    /// `(exitCode, signal)`: one of them is set for an ended process.
    public static func decode(_ status: Int32) -> (exitCode: Int32?, signal: Int32?) {
        let low = status & 0x7F
        if low == 0 { return ((status >> 8) & 0xFF, nil) }
        if low != 0x7F { return (nil, low) }
        return (nil, nil)
    }
}
