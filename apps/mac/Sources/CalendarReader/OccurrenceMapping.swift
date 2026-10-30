import Foundation

/// A store occurrence turned into what the views need, plus the two facts
/// only the grouping uses (the invitation identifier and the organizer mark),
/// which never leave the module.
struct MappedOccurrence {
    let occurrence: CalendarOccurrence
    let externalID: String?
    let organizerIsCurrentUser: Bool
    /// The calendar's place in the person's list (0 is first).
    let calendarIndex: Int
}

/// Maps store occurrences: timed ones to UTC and local times, all-day ones to
/// dates with an exclusive end and no clock times.
struct OccurrenceMapper {
    /// The zone timed occurrences are shown in.
    let displayTimeZone: TimeZone
    /// The zone the store read all-day dates in.
    let floatingTimeZone: TimeZone
    private let formatter: ISO8601DateFormatter

    init(displayTimeZone: TimeZone, floatingTimeZone: TimeZone) {
        self.displayTimeZone = displayTimeZone
        self.floatingTimeZone = floatingTimeZone
        formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = displayTimeZone
    }

    func map(_ raw: StoreOccurrence, calendarIndex: Int) -> MappedOccurrence {
        let end = max(raw.end, raw.start)
        let time: OccurrenceTime
        if raw.isAllDay {
            // The store gives an all-day event as midnight to the last
            // second (or midnight) of its last day, in its floating zone.
            // Read the dates in that same zone, so the result never depends
            // on the zone the views are in.
            let start = CalendarDate(raw.start, in: floatingTimeZone)
            let lastInstant = end > raw.start ? end.addingTimeInterval(-1) : raw.start
            let endExclusive = max(CalendarDate(lastInstant, in: floatingTimeZone), start).adding(days: 1)
            time = .allDay(start: start, endExclusive: endExclusive)
        } else {
            time = .timed(start: instant(raw.start), end: instant(end))
        }
        let occurrence = CalendarOccurrence(
            key: OccurrenceMapper.key(calendarID: raw.calendarID, eventID: raw.eventID, originalStart: raw.originalStart),
            title: raw.title,
            location: raw.location,
            calendarID: raw.calendarID,
            status: raw.status,
            originalStart: raw.originalStart,
            time: time
        )
        let externalID = raw.externalID.flatMap { $0.isEmpty ? nil : $0 }
        return MappedOccurrence(occurrence: occurrence, externalID: externalID,
                                organizerIsCurrentUser: raw.organizerIsCurrentUser, calendarIndex: calendarIndex)
    }

    /// Ids only, never content: the calendar, the event and, for a repeating
    /// occurrence, its original start in milliseconds.
    static func key(calendarID: String, eventID: String, originalStart: Date?) -> String {
        guard let originalStart else { return "\(calendarID)|\(eventID)" }
        return "\(calendarID)|\(eventID)|\(milliseconds(originalStart))"
    }

    static func milliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    private func instant(_ date: Date) -> TimedInstant {
        TimedInstant(utc: date, local: formatter.string(from: date), utcOffsetSeconds: displayTimeZone.secondsFromGMT(for: date))
    }
}
