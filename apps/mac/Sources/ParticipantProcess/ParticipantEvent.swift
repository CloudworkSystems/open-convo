import DeskHost
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
        // Floor division, as `toISOString` writes it: a time before 1970 with
        // nonzero milliseconds is the second before it plus a positive
        // fraction (-1 is 23:59:59.999 on 1969-12-31), never a negative one.
        var whole = millis / 1000
        var fraction = Int(millis % 1000)
        if fraction < 0 {
            whole -= 1
            fraction += 1000
        }
        var days = whole / 86_400
        var secondOfDay = Int(whole % 86_400)
        if secondOfDay < 0 {
            days -= 1
            secondOfDay += 86_400
        }
        let date = civil(days: days)
        return String(format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                      date.year, date.month, date.day,
                      secondOfDay / 3_600, secondOfDay / 60 % 60, secondOfDay % 60, fraction)
    }

    /// Days since 1970-01-01 for a proleptic Gregorian date, as the page's
    /// `Date` counts them for every year, not only those `timegm` reads (it
    /// refuses years before 1900). Out-of-range fields roll over; the caller
    /// writes the result back and compares, which refuses them.
    private static func days(year: Int, month: Int, day: Int) -> Int64 {
        let y = Int64(month <= 2 ? year - 1 : year)
        let era = (y >= 0 ? y : y - 399) / 400
        let yearOfEra = y - era * 400
        let monthFromMarch = Int64((month + 9) % 12)
        let dayOfYear = (153 * monthFromMarch + 2) / 5 + Int64(day) - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }

    /// The proleptic Gregorian date `days` after 1970-01-01.
    private static func civil(days: Int64) -> (year: Int, month: Int, day: Int) {
        let z = days + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let dayOfEra = z - era * 146_097
        let yearOfEra = (dayOfEra - dayOfEra / 1_460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let monthFromMarch = (5 * dayOfYear + 2) / 153
        let day = dayOfYear - (153 * monthFromMarch + 2) / 5 + 1
        let month = monthFromMarch < 10 ? monthFromMarch + 3 : monthFromMarch - 9
        return (Int(yearOfEra + era * 400 + (month <= 2 ? 1 : 0)), Int(month), Int(day))
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
        let total = (days(year: year, month: month, day: day) * 86_400
                     + Int64(hour * 3_600 + minute * 60 + second)) * 1_000 + Int64(millis)
        // Writing the result back and comparing refuses every field that
        // rolled over: February 30, hour 24, second 60 and the like.
        guard format(millis: total) == text else { return nil }
        return total
    }
}

/// The `at` rule (section 8): the latest of native's clock, the previous
/// `at` and the run's `createdAt`, in milliseconds since 1970. One place for
/// the run core and for events the coordinator makes itself.
public enum ParticipantEventTime {
    public static func atMillis(wall: Int64, previous: Int64, createdAt: Int64) -> Int64 {
        max(wall, previous, createdAt)
    }
}

// MARK: Wire form (section 8)

public extension ParticipantTerminal {
    /// The terminal for a section 8 `type` and `reason` pair; nil for any
    /// other pair (`completed` carries no reason).
    init?(type: String, reason: String?) {
        switch (type, reason) {
        case ("completed", nil):
            self = .completed
        case ("stopped", let reason?):
            guard let value = ParticipantStopReason(rawValue: reason) else { return nil }
            self = .stopped(value)
        case ("failed", let reason?):
            guard let value = ParticipantFailureReason(rawValue: reason) else { return nil }
            self = .failed(value)
        default:
            return nil
        }
    }

    /// The terminal a recorded `{type, sequence, at, reason}` names.
    init?(_ record: ParticipantRunTerminal) {
        self.init(type: record.type, reason: record.reason)
    }

    /// The record this terminal writes at `sequence` and `at`, `reason` null
    /// for `completed`; nil when the record's own rules refuse them (a
    /// `completed` before sequence 2, an invalid time).
    func record(sequence: Int, at: String) -> ParticipantRunTerminal? {
        ParticipantRunTerminal(type: type.rawValue, sequence: sequence, at: at, reason: reason)
    }
}

public extension ParticipantEvent {
    /// The event's terminal, when it is `completed`, `stopped` or `failed`
    /// with a section 8 reason.
    var terminal: ParticipantTerminal? {
        switch type {
        case .started, .text: return nil
        case .completed, .stopped, .failed: return ParticipantTerminal(type: type.rawValue, reason: reason)
        }
    }

    /// The runs-entry record a terminal event writes, or nil.
    var terminalRecord: ParticipantRunTerminal? {
        terminal?.record(sequence: sequence, at: at)
    }

    /// The terminal event a recorded terminal stands for, with the run's ids.
    init?(runId: String, sessionId: String, recorded: ParticipantRunTerminal) {
        guard let terminal = ParticipantTerminal(recorded) else { return nil }
        self.init(runId: runId, sessionId: sessionId, sequence: recorded.sequence, at: recorded.at,
                  type: terminal.type, reason: terminal.reason)
    }

    /// Exactly `{runId, sessionId, sequence, at, type}`, plus `text` on text
    /// events and `reason` on `stopped` and `failed`, and nothing else. The
    /// keys follow `type`: a value missing for its type is written as null,
    /// which `init?(jsonValue:)` and the page refuse, never left out.
    var jsonValue: JSONValue {
        var fields: [String: JSONValue] = [
            "runId": .string(runId),
            "sessionId": .string(sessionId),
            "sequence": .number(Double(sequence)),
            "at": .string(at),
            "type": .string(type.rawValue)
        ]
        if type == .text { fields["text"] = text.map(JSONValue.string) ?? .null }
        if type == .stopped || type == .failed { fields["reason"] = reason.map(JSONValue.string) ?? .null }
        return .object(fields)
    }

    /// Strict, as the page's event check reads one (section 8): exactly the
    /// keys for its type; `runId` a lowercase UUIDv4 and `sessionId` a record
    /// id, different ignoring case; `sequence` a safe integer, 1 for
    /// `started` and above 1 for `text` and `completed`; `at` a real
    /// `.mmmZ` time; `text` 1-16,384 UTF-8 bytes; `reason` one of its type's.
    /// Anything else is nil.
    init?(jsonValue: JSONValue) {
        guard let fields = jsonValue.objectValue, let typeName = fields["type"]?.stringValue,
              let type = ParticipantEventType(rawValue: typeName) else { return nil }
        var keys: Set<String> = ["runId", "sessionId", "sequence", "at", "type"]
        if type == .text { keys.insert("text") }
        if type == .stopped || type == .failed { keys.insert("reason") }
        guard Set(fields.keys) == keys,
              let runId = ParticipantIds.runLike(fields["runId"]), let sessionId = ParticipantIds.session(fields["sessionId"]),
              ParticipantIds.distinctIgnoringCase([runId, sessionId]),
              let sequence = fields["sequence"]?.safeIntegerValue, sequence >= 1,
              let at = fields["at"]?.stringValue, ParticipantTimestamp.parse(at) != nil else { return nil }
        var text: String?
        var reason: String?
        switch type {
        case .started:
            guard sequence == 1 else { return nil }
        case .text:
            guard sequence > 1, let value = fields["text"]?.stringValue, !value.isEmpty,
                  value.utf8.count <= ParticipantLimits.chunkBytes else { return nil }
            text = value
        case .completed:
            guard sequence > 1 else { return nil }
        case .stopped, .failed:
            guard let value = fields["reason"]?.stringValue, ParticipantTerminal(type: typeName, reason: value) != nil else {
                return nil
            }
            reason = value
        }
        self.init(runId: runId, sessionId: sessionId, sequence: sequence, at: at, type: type, text: text, reason: reason)
    }
}
