import Foundation

// What the calendar reader hands to the rest of True Convo
// (docs/plans/calendar-through-the-mac.md, PR 1). Only what the views need:
// no notes, attendees, links or alarms are ever read into these types.
//
// Calendar content (titles, places, calendar names) is the person's own, so
// every type that holds some prints counts and ids only: an accidental log
// line or test message never shows it.

/// Whether True Convo may read the calendars on this Mac.
public enum CalendarAccessState: String, Equatable, Sendable {
    /// Never asked yet.
    case notDetermined
    /// Reading is allowed.
    case granted
    /// Refused when asked, or revoked later in System Settings.
    case refused
    /// Blocked on this Mac (a device profile or Screen Time).
    case restricted
    /// macOS 14 and later: only adding events is allowed, which can't read.
    case writeOnly
}

/// Which of Apple's two access requests this Mac takes. The app supports
/// macOS 13, so both are compiled in and chosen at run time.
public enum CalendarAccessPath: String, Equatable, Sendable {
    /// macOS 14 and later: full access, which reading needs.
    case fullAccess
    /// macOS 13: the older calendar access request.
    case legacy

    public static func forSystem(majorVersion: Int) -> CalendarAccessPath {
        majorVersion >= 14 ? .fullAccess : .legacy
    }

    /// The path for the Mac this runs on.
    public static var current: CalendarAccessPath {
        forSystem(majorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion)
    }

    /// The Info.plist key whose text macOS shows when it asks.
    public var usageDescriptionKey: String {
        switch self {
        case .fullAccess: return "NSCalendarsFullAccessUsageDescription"
        case .legacy: return "NSCalendarsUsageDescription"
        }
    }

    /// Reads Apple's authorization status by its raw value, so the same
    /// mapping covers both systems: 0 not determined, 1 restricted, 2 denied,
    /// 3 authorized (macOS 13) or full access (macOS 14), 4 write only
    /// (macOS 14). Anything unknown reads as refused, never as granted.
    public func accessState(rawStatus: Int) -> CalendarAccessState {
        switch rawStatus {
        case 0: return .notDetermined
        case 1: return .restricted
        case 2: return .refused
        case 3: return .granted
        case 4: return self == .fullAccess ? .writeOnly : .refused
        default: return .refused
        }
    }
}

/// The kind of account a calendar belongs to.
public enum CalendarAccountKind: String, Equatable, Sendable {
    case iCloud
    case google
    case exchange
    case onMyMac
    case subscribed
    case birthdays
    case other

    /// Classifies by Apple's source type raw value (0 local, 1 Exchange,
    /// 2 CalDAV, 3 MobileMe, 4 subscribed, 5 birthdays) and, for CalDAV, the
    /// account's title. The title is only looked at here, never kept.
    public static func classify(sourceType: Int, sourceTitle: String) -> CalendarAccountKind {
        switch sourceType {
        case 0: return .onMyMac
        case 1: return .exchange
        case 3: return .iCloud
        case 4: return .subscribed
        case 5: return .birthdays
        case 2:
            let title = sourceTitle.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if title == "icloud" { return .iCloud }
            if title.contains("google") || title.hasSuffix("@gmail.com") || title.hasSuffix("@googlemail.com") {
                return .google
            }
            return .other
        default: return .other
        }
    }
}

/// One calendar the Mac knows.
public struct CalendarInfo: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let id: String
    public let name: String
    /// `#RRGGBB`, in sRGB.
    public let colorHex: String
    public let account: CalendarAccountKind

    public init(id: String, name: String, colorHex: String, account: CalendarAccountKind) {
        self.id = id
        self.name = name
        self.colorHex = colorHex
        self.account = account
    }

    /// `#RRGGBB` from sRGB channels between 0 and 1 (clamped).
    public static func hex(red: Double, green: Double, blue: Double) -> String {
        func channel(_ value: Double) -> Int { Int((min(max(value, 0), 1) * 255).rounded()) }
        return String(format: "#%02lX%02lX%02lX", channel(red), channel(green), channel(blue))
    }

    public var description: String { "CalendarInfo(id: \(id), account: \(account.rawValue))" }
    public var debugDescription: String { description }
}

/// A day on the calendar, with no clock time and no time zone, so an all-day
/// event never shifts a day when the time zone changes.
public struct CalendarDate: Hashable, Comparable, Sendable, CustomStringConvertible {
    public let year: Int
    public let month: Int
    public let day: Int

    public init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    /// The day `instant` falls on in `timeZone`.
    public init(_ instant: Date, in timeZone: TimeZone) {
        let parts = CalendarDate.gregorian(timeZone).dateComponents([.year, .month, .day], from: instant)
        self.init(year: parts.year ?? 0, month: parts.month ?? 0, day: parts.day ?? 0)
    }

    public func adding(days: Int) -> CalendarDate {
        let utc = TimeZone(identifier: "UTC") ?? TimeZone(secondsFromGMT: 0)!
        let calendar = CalendarDate.gregorian(utc)
        let noon = DateComponents(year: year, month: month, day: day, hour: 12)
        guard let date = calendar.date(from: noon), let moved = calendar.date(byAdding: .day, value: days, to: date) else {
            return self
        }
        return CalendarDate(moved, in: utc)
    }

    /// `YYYY-MM-DD`.
    public var description: String { String(format: "%04ld-%02ld-%02ld", year, month, day) }

    public static func < (lhs: CalendarDate, rhs: CalendarDate) -> Bool {
        (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
    }

    static func gregorian(_ timeZone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }
}

/// One edge of a timed occurrence: the instant, and how it reads locally.
public struct TimedInstant: Equatable, Sendable {
    public let utc: Date
    /// ISO 8601 with the offset, for example `2026-11-12T10:00:00-05:00`.
    public let local: String
    public let utcOffsetSeconds: Int

    public init(utc: Date, local: String, utcOffsetSeconds: Int) {
        self.utc = utc
        self.local = local
        self.utcOffsetSeconds = utcOffsetSeconds
    }
}

/// When an occurrence happens.
public enum OccurrenceTime: Equatable, Sendable {
    case timed(start: TimedInstant, end: TimedInstant)
    /// The end date is exclusive: a one-day event on November 12 ends on
    /// November 13.
    case allDay(start: CalendarDate, endExclusive: CalendarDate)
}

public enum OccurrenceStatus: String, Equatable, Sendable {
    case confirmed
    case tentative
    case cancelled
}

/// One occurrence of an event in one calendar.
public struct CalendarOccurrence: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    /// Stable across reads: the calendar, the event and, for a repeating
    /// event, the occurrence's original start.
    public let key: String
    public let title: String
    public let location: String?
    public let calendarID: String
    public let status: OccurrenceStatus
    /// The original start of a repeating occurrence (fixed when that one
    /// occurrence is moved); nil for a one-off event.
    public let originalStart: Date?
    public let time: OccurrenceTime

    public init(key: String, title: String, location: String?, calendarID: String, status: OccurrenceStatus,
                originalStart: Date?, time: OccurrenceTime) {
        self.key = key
        self.title = title
        self.location = location
        self.calendarID = calendarID
        self.status = status
        self.originalStart = originalStart
        self.time = time
    }

    public var description: String { "CalendarOccurrence(key: \(key), status: \(status.rawValue))" }
    public var debugDescription: String { description }
}

/// One meeting as the views show it: every copy of it, from every calendar.
public struct OccurrenceGroup: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public enum MatchedBy: String, Equatable, Sendable {
        /// The same invitation identifier and the same occurrence.
        case identifier
        /// Different identifiers, the same title and time.
        case titleAndTime
    }

    public enum Shown: Equatable, Sendable {
        /// One copy stands for the meeting.
        case one(CalendarOccurrence)
        /// The copies differ and none is known to be right: the views show
        /// the meeting once with a "the copies differ" mark and every
        /// version, in the person's calendar order.
        case differing([CalendarOccurrence])
    }

    /// The member keys, sorted, joined with " + ".
    public let key: String
    /// Every calendar a copy came from, in the person's calendar order.
    public let calendarIDs: [String]
    /// Nil for a meeting found in one calendar only.
    public let matchedBy: MatchedBy?
    public let shown: Shown

    public init(key: String, calendarIDs: [String], matchedBy: MatchedBy?, shown: Shown) {
        self.key = key
        self.calendarIDs = calendarIDs
        self.matchedBy = matchedBy
        self.shown = shown
    }

    public var copiesDiffer: Bool {
        if case .differing = shown { return true }
        return false
    }

    /// The copy shown, or the first version when the copies differ.
    public var first: CalendarOccurrence {
        switch shown {
        case .one(let occurrence): return occurrence
        case .differing(let versions): return versions[0]
        }
    }

    public var description: String {
        let versions: Int
        switch shown {
        case .one: versions = 1
        case .differing(let list): versions = list.count
        }
        return "OccurrenceGroup(key: \(key), calendars: \(calendarIDs.count), versions: \(versions))"
    }
    public var debugDescription: String { description }
}
