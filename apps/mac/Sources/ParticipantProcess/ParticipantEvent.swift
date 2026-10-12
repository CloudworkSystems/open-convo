import Foundation

/// Event types (contract section 8).
public enum ParticipantEventType: String, Sendable, CaseIterable {
    case started
    case text
    case completed
    case stopped
    case failed
}

/// Why a run stopped. `local-stop` once the group is confirmed gone,
/// whoever asked; `stop-incomplete` when it is not.
public enum ParticipantStopReason: String, Sendable, CaseIterable {
    case localStop = "local-stop"
    case stopIncomplete = "stop-incomplete"
}

/// Why native ended a run.
public enum ParticipantFailureReason: String, Sendable, CaseIterable {
    case replyTooLong = "reply-too-long"
    case paidOverflow = "paid-overflow"
    case timeout
    case processError = "process-error"
}

/// A run's one terminal event.
public enum ParticipantTerminal: Equatable, Sendable {
    case completed
    case stopped(ParticipantStopReason)
    case failed(ParticipantFailureReason)

    public var type: ParticipantEventType {
        switch self {
        case .completed: return .completed
        case .stopped: return .stopped
        case .failed: return .failed
        }
    }

    /// The `reason` field: present exactly on `stopped` and `failed`.
    public var reason: String? {
        switch self {
        case .completed: return nil
        case .stopped(let reason): return reason.rawValue
        case .failed(let reason): return reason.rawValue
        }
    }
}

/// One participant event, exactly `{runId, sessionId, sequence, at, type}`
/// plus `text` on text events and `reason` on `stopped` and `failed`.
public struct ParticipantEvent: Equatable, Sendable {
    public let runId: String
    public let sessionId: String
    public let sequence: Int
    public let at: String
    public let type: ParticipantEventType
    public let text: String?
    public let reason: String?

    public init(runId: String, sessionId: String, sequence: Int, at: String,
                type: ParticipantEventType, text: String? = nil, reason: String? = nil) {
        self.runId = runId
        self.sessionId = sessionId
        self.sequence = sequence
        self.at = at
        self.type = type
        self.text = text
        self.reason = reason
    }
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` in UTC, from milliseconds since 1970.
public enum ParticipantTimestamp {
    public static func format(millis: Int64) -> String {
        var seconds = time_t(millis / 1000)
        let fraction = Int(millis % 1000)
        var parts = tm()
        gmtime_r(&seconds, &parts)
        return String(format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                      Int(parts.tm_year) + 1900, Int(parts.tm_mon) + 1, Int(parts.tm_mday),
                      Int(parts.tm_hour), Int(parts.tm_min), Int(parts.tm_sec), fraction)
    }

    /// Milliseconds since 1970 for a `YYYY-MM-DDTHH:MM:SS.mmmZ` string, or nil.
    public static func parse(_ text: String) -> Int64? {
        let bytes = Array(text.utf8)
        guard bytes.count == 24, bytes[4] == 0x2D, bytes[7] == 0x2D, bytes[10] == 0x54,
              bytes[13] == 0x3A, bytes[16] == 0x3A, bytes[19] == 0x2E, bytes[23] == 0x5A else { return nil }
        func number(_ range: Range<Int>) -> Int? {
            var value = 0
            for index in range {
                let byte = bytes[index]
                guard byte >= 0x30, byte <= 0x39 else { return nil }
                value = value * 10 + Int(byte - 0x30)
            }
            return value
        }
        guard let year = number(0..<4), let month = number(5..<7), let day = number(8..<10),
              let hour = number(11..<13), let minute = number(14..<16), let second = number(17..<19),
              let millis = number(20..<23) else { return nil }
        var parts = tm()
        parts.tm_year = Int32(year - 1900)
        parts.tm_mon = Int32(month - 1)
        parts.tm_mday = Int32(day)
        parts.tm_hour = Int32(hour)
        parts.tm_min = Int32(minute)
        parts.tm_sec = Int32(second)
        let seconds = timegm(&parts)
        // Refuse dates `timegm` normalised (February 30 and the like).
        guard format(millis: Int64(seconds) * 1000 + Int64(millis)) == text else { return nil }
        return Int64(seconds) * 1000 + Int64(millis)
    }
}
