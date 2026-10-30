import CalendarReader
import Foundation
import Testing

/// What each occurrence carries, all-day dates, the range and the calendar
/// choice (calendar-through-the-mac.md, "Reading the calendars").
@Suite("Reading occurrences")
struct OccurrenceReadingTests {
    private func only(_ groups: [OccurrenceGroup]) throws -> CalendarOccurrence {
        try #require(groups.count == 1)
        guard case .one(let occurrence) = groups[0].shown else {
            Issue.record("expected one shown copy")
            throw CancellationError()
        }
        return occurrence
    }

    @Test("A timed occurrence has its start and end in UTC and local time, with the offset")
    func timed() throws {
        let (reader, _) = grantedReader(abc, [event("e1", in: "A", "Piano", location: "Music room")])
        let occurrence = try only(reader.occurrences(from: november.start, to: november.end, displayTimeZone: Zones.newYork))
        #expect(occurrence.title == "Piano")
        #expect(occurrence.location == "Music room")
        #expect(occurrence.calendarID == "A")
        #expect(occurrence.status == .confirmed)
        #expect(occurrence.originalStart == nil)
        let start = TimedInstant(utc: at("2026-11-12T15:00:00Z"), local: "2026-11-12T10:00:00-05:00", utcOffsetSeconds: -18_000)
        let end = TimedInstant(utc: at("2026-11-12T16:00:00Z"), local: "2026-11-12T11:00:00-05:00", utcOffsetSeconds: -18_000)
        #expect(occurrence.time == .timed(start: start, end: end))
        let tokyo = try only(reader.occurrences(from: november.start, to: november.end, displayTimeZone: Zones.tokyo))
        guard case .timed(let tokyoStart, _) = tokyo.time else { Issue.record("timed"); return }
        #expect(tokyoStart.utc == start.utc)
        #expect(tokyoStart.local == "2026-11-13T00:00:00+09:00")
        #expect(tokyoStart.utcOffsetSeconds == 32_400)
    }

    @Test("An all-day event read in two time zones is the same day, with an exclusive end and no clock times")
    func allDayTwoZones() throws {
        // The store gives an all-day event as midnight to 23:59:59 in the
        // zone it reads floating dates in, as Apple's framework does.
        let newYork = event("d1", in: "A", "School holiday", start: "2026-11-12T00:00:00-05:00", end: "2026-11-12T23:59:59-05:00", allDay: true)
        let tokyo = event("d1", in: "A", "School holiday", start: "2026-11-12T00:00:00+09:00", end: "2026-11-12T23:59:59+09:00", allDay: true)
        let expected = OccurrenceTime.allDay(start: CalendarDate(year: 2026, month: 11, day: 12),
                                             endExclusive: CalendarDate(year: 2026, month: 11, day: 13))
        let (inNewYork, _) = grantedReader(abc, [newYork], floatingTimeZone: Zones.newYork)
        let (inTokyo, _) = grantedReader(abc, [tokyo], floatingTimeZone: Zones.tokyo)
        for zone in [Zones.newYork, Zones.tokyo, Zones.utc] {
            #expect(try only(inNewYork.occurrences(from: november.start, to: november.end, displayTimeZone: zone)).time == expected)
            #expect(try only(inTokyo.occurrences(from: november.start, to: november.end, displayTimeZone: zone)).time == expected)
        }
        #expect(CalendarDate(year: 2026, month: 11, day: 12).description == "2026-11-12")
    }

    @Test("A two-day all-day event ends the day after its last day, whether the store ends it at 23:59:59 or at midnight")
    func twoDayAllDay() throws {
        let lastSecond = event("d2", in: "A", "Camp", start: "2026-11-12T00:00:00-05:00", end: "2026-11-13T23:59:59-05:00", allDay: true)
        let midnight = event("d3", in: "B", "Trip", start: "2026-11-12T00:00:00-05:00", end: "2026-11-14T00:00:00-05:00", allDay: true)
        let (reader, _) = grantedReader(abc, [lastSecond, midnight])
        let expected = OccurrenceTime.allDay(start: CalendarDate(year: 2026, month: 11, day: 12),
                                             endExclusive: CalendarDate(year: 2026, month: 11, day: 14))
        let groups = try reader.occurrences(from: november.start, to: november.end)
        #expect(groups.count == 2)
        #expect(groups.allSatisfy { $0.first.time == expected })
        // Across a month and a year end.
        #expect(CalendarDate(year: 2026, month: 12, day: 31).adding(days: 1) == CalendarDate(year: 2027, month: 1, day: 1))
    }

    @Test("A day's all-day events come before its timed ones; days in order")
    func order() throws {
        let (reader, _) = grantedReader(abc, [
            event("t2", in: "A", "Lunch", start: "2026-11-13T12:00:00-05:00", end: "2026-11-13T13:00:00-05:00"),
            event("t1", in: "A", "Run", start: "2026-11-12T07:00:00-05:00", end: "2026-11-12T08:00:00-05:00"),
            event("a1", in: "B", "Holiday", start: "2026-11-12T00:00:00-05:00", end: "2026-11-12T23:59:59-05:00", allDay: true),
        ])
        let titles = try reader.occurrences(from: november.start, to: november.end, displayTimeZone: Zones.newYork).map(\.first.title)
        #expect(titles == ["Holiday", "Run", "Lunch"])
    }

    @Test("A repeating occurrence carries its original start; a one-off has none; keys are stable and distinct")
    func originalStartAndKeys() throws {
        let events = [
            event("s1", in: "A", "Standup", start: "2026-11-12T09:00:00-05:00", end: "2026-11-12T09:15:00-05:00", originalStart: "2026-11-12T09:00:00-05:00"),
            event("s1", in: "A", "Standup", start: "2026-11-13T09:30:00-05:00", end: "2026-11-13T09:45:00-05:00", originalStart: "2026-11-13T09:00:00-05:00"),
            event("o1", in: "A", "Haircut", start: "2026-11-14T09:00:00-05:00", end: "2026-11-14T10:00:00-05:00"),
        ]
        let (reader, _) = grantedReader(abc, events)
        let first = try reader.occurrences(from: november.start, to: november.end).map(\.first)
        #expect(first.map(\.originalStart) == [at("2026-11-12T09:00:00-05:00"), at("2026-11-13T09:00:00-05:00"), nil])
        #expect(Set(first.map(\.key)).count == 3)
        let again = try reader.occurrences(from: november.start, to: november.end).map(\.first)
        #expect(again.map(\.key) == first.map(\.key))
        #expect(first.allSatisfy { !$0.key.contains("Standup") && !$0.key.contains("Haircut") }, "keys hold ids, never titles")
    }

    @Test("Only what the views need is carried: no notes, attendees, links or alarms")
    func onlyWhatViewsNeed() throws {
        let (reader, _) = grantedReader(abc, [event("e1", in: "A")])
        let occurrence = try only(reader.occurrences(from: november.start, to: november.end))
        let fields = Mirror(reflecting: occurrence).children.compactMap(\.label)
        #expect(fields == ["key", "title", "location", "calendarID", "status", "originalStart", "time"])
        let storeFields = Mirror(reflecting: event("e1", in: "A")).children.compactMap(\.label)
        #expect(storeFields == ["eventID", "externalID", "calendarID", "title", "location", "status", "start", "end",
                                "isAllDay", "originalStart", "organizerIsCurrentUser"])
    }

    @Test("Printing a calendar, an occurrence or a group shows ids and counts, never titles, places or names")
    func printsNoContent() throws {
        let (reader, _) = grantedReader(abc, [event("e1", in: "A", "Secret surprise party", location: "Invented Street 9")])
        let groups = try reader.occurrences(from: november.start, to: november.end)
        let printed = try [String(describing: groups), String(reflecting: groups), String(describing: groups[0].first),
                       String(describing: reader.calendars()), String(describing: event("e1", in: "A", "Secret surprise party"))]
        for text in printed {
            #expect(!text.contains("Secret") && !text.contains("Invented Street") && !text.contains("A calendar"))
        }
    }

    @Test("A range of up to 400 days reads; a longer or empty one is refused")
    func range() throws {
        let (reader, store) = grantedReader(abc, [])
        let start = at("2026-11-01T00:00:00-04:00")
        var days400 = DateComponents()
        days400.day = 400
        var newYorkCalendar = Calendar(identifier: .gregorian)
        newYorkCalendar.timeZone = Zones.newYork
        let limit = try #require(newYorkCalendar.date(byAdding: days400, to: start))
        #expect(try reader.occurrences(from: start, to: limit, displayTimeZone: Zones.newYork).isEmpty)
        #expect(store.queries.count == 1)
        #expect(throws: CalendarReaderError.rangeTooLong) {
            try reader.occurrences(from: start, to: limit.addingTimeInterval(1), displayTimeZone: Zones.newYork)
        }
        #expect(throws: CalendarReaderError.invalidRange) { try reader.occurrences(from: start, to: start) }
        #expect(store.queries.count == 1)
        #expect(CalendarReader.maximumRangeDays == 400)
    }

    @Test("Only the chosen calendars are read, in the chosen order; unknown or repeated ids are skipped; none chosen reads nothing")
    func calendarChoice() throws {
        let (reader, store) = grantedReader(abc, [event("e1", in: "A", "Run"), event("e2", in: "C", "Swim", start: "2026-11-13T10:00:00-05:00", end: "2026-11-13T11:00:00-05:00")])
        let groups = try reader.occurrences(from: november.start, to: november.end, calendarIDs: ["C", "missing", "C"])
        #expect(groups.map(\.first.title) == ["Swim"])
        #expect(store.queries.last?.calendarIDs == ["C"])
        #expect(try reader.occurrences(from: november.start, to: november.end, calendarIDs: []).isEmpty)
        #expect(try reader.occurrences(from: november.start, to: november.end, calendarIDs: ["missing"]).isEmpty)
        #expect(store.queries.count == 1)
        _ = try reader.occurrences(from: november.start, to: november.end)
        #expect(store.queries.last?.calendarIDs == ["A", "B", "C"])
    }

    @Test("Calendars are listed by name with their color and account kind")
    func calendarList() throws {
        let (reader, _) = grantedReader([calendar("z", "Work", account: .google), calendar("y", "family", account: .iCloud),
                                         calendar("x", "Birthdays", account: .birthdays)], [])
        #expect(try reader.calendars().map(\.id) == ["x", "y", "z"])
        #expect(try reader.calendars().map(\.account) == [.birthdays, .iCloud, .google])
        #expect(CalendarInfo.hex(red: 1, green: 0.5, blue: 0) == "#FF8000")
        #expect(CalendarInfo.hex(red: -1, green: 2, blue: 0.2) == "#00FF33")
    }

    @Test("Account kinds: iCloud, Google, Exchange, On My Mac, subscribed, birthdays")
    func accountKinds() {
        #expect(CalendarAccountKind.classify(sourceType: 0, sourceTitle: "On My Mac") == .onMyMac)
        #expect(CalendarAccountKind.classify(sourceType: 1, sourceTitle: "Work") == .exchange)
        #expect(CalendarAccountKind.classify(sourceType: 2, sourceTitle: "iCloud") == .iCloud)
        #expect(CalendarAccountKind.classify(sourceType: 3, sourceTitle: "") == .iCloud)
        #expect(CalendarAccountKind.classify(sourceType: 2, sourceTitle: "Google") == .google)
        #expect(CalendarAccountKind.classify(sourceType: 2, sourceTitle: "someone@gmail.com") == .google)
        #expect(CalendarAccountKind.classify(sourceType: 2, sourceTitle: "Fastmail") == .other)
        #expect(CalendarAccountKind.classify(sourceType: 4, sourceTitle: "Holidays") == .subscribed)
        #expect(CalendarAccountKind.classify(sourceType: 5, sourceTitle: "Other") == .birthdays)
        #expect(CalendarAccountKind.classify(sourceType: 42, sourceTitle: "") == .other)
    }
}
