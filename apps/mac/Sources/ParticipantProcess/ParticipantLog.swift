import Foundation
import os

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
    case stderrClosed = "stderr-closed"
    case event
    case groupCleared = "group-cleared"
    case groupUncleared = "group-uncleared"
    case cleanupReleased = "cleanup-released"
}

/// A fixed reason a log entry may carry. Only these enums' raw values ever
/// reach a log.
public enum ParticipantLogReason: Equatable, Sendable {
    case stop(ParticipantStopReason)
    case failure(ParticipantFailureReason)
    case stderr(StderrReason)

    public var rawValue: String {
        switch self {
        case .stop(let reason): return reason.rawValue
        case .failure(let reason): return reason.rawValue
        case .stderr(let reason): return reason.rawValue
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
    private static let logger = Logger(subsystem: "com.trueconvo.voice-cursor", category: "participant")

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
