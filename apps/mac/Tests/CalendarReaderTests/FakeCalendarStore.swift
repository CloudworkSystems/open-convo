import CalendarReader
import Foundation

/// A calendar store with invented calendars only. It plays Apple's framework:
/// raw authorization statuses, the person's answer to the request, and the
/// change notice.
final class FakeCalendarStore: CalendarStore {
    /// 0 not determined, 1 restricted, 2 denied, 3 granted, 4 write only.
    var rawStatus = 0
    /// The status the person's answer leaves (3 allows, 2 refuses, 4 allows
    /// adding events only).
    var answer = 3
    var requestFails = false
    private(set) var requestedPaths: [CalendarAccessPath] = []
    private(set) var queries: [(start: Date, end: Date, calendarIDs: [String])] = []

    var calendarList: [CalendarInfo]
    var events: [StoreOccurrence]
    var floatingTimeZone: TimeZone

    private var handlers: [Int: () -> Void] = [:]
    private var nextHandler = 0
    var observerCount: Int { handlers.count }

    init(calendars: [CalendarInfo] = [], events: [StoreOccurrence] = [], floatingTimeZone: TimeZone = Zones.newYork) {
        calendarList = calendars
        self.events = events
        self.floatingTimeZone = floatingTimeZone
    }

    func authorizationRawStatus() -> Int { rawStatus }

    func requestAccess(path: CalendarAccessPath) async throws -> Bool {
        requestedPaths.append(path)
        if requestFails { throw FakeError.requestFailed }
        rawStatus = answer
        return answer == 3
    }

    func calendars() -> [CalendarInfo] { calendarList }

    func occurrences(from start: Date, to end: Date, calendarIDs: [String]) -> [StoreOccurrence] {
        queries.append((start, end, calendarIDs))
        return events.filter { calendarIDs.contains($0.calendarID) && $0.start < end && max($0.end, $0.start) >= start }
    }

    func observeChanges(_ handler: @escaping () -> Void) -> CalendarChangeToken {
        let id = nextHandler
        nextHandler += 1
        handlers[id] = handler
        return CalendarChangeToken { [weak self] in self?.handlers[id] = nil }
    }

    /// What a sync, an edit elsewhere, or a revocation in System Settings does.
    func simulateChange() {
        for handler in handlers.values { handler() }
    }

    enum FakeError: Error { case requestFailed }
}

enum Zones {
    static let newYork = TimeZone(identifier: "America/New_York")!
    static let tokyo = TimeZone(identifier: "Asia/Tokyo")!
    static let utc = TimeZone(identifier: "UTC")!
}

/// An instant from an ISO 8601 string with its offset.
func at(_ text: String) -> Date {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    guard let date = formatter.date(from: text) else { fatalError("bad test date \(text)") }
    return date
}

func calendar(_ id: String, _ name: String, account: CalendarAccountKind = .iCloud) -> CalendarInfo {
    CalendarInfo(id: id, name: name, colorHex: "#3366CC", account: account)
}

/// An invented occurrence; times are New York unless the text says otherwise.
func event(_ eventID: String, in calendarID: String, _ title: String = "Dentist",
           start: String = "2026-11-12T10:00:00-05:00", end: String = "2026-11-12T11:00:00-05:00",
           externalID: String? = nil, location: String? = nil, status: OccurrenceStatus = .confirmed,
           allDay: Bool = false, originalStart: String? = nil, organizer: Bool = false) -> StoreOccurrence {
    StoreOccurrence(eventID: eventID, externalID: externalID, calendarID: calendarID, title: title, location: location,
                    status: status, start: at(start), end: at(end), isAllDay: allDay,
                    originalStart: originalStart.map(at), organizerIsCurrentUser: organizer)
}

/// A reader with access already granted, over the given calendars and events.
func grantedReader(_ calendars: [CalendarInfo], _ events: [StoreOccurrence],
                   floatingTimeZone: TimeZone = Zones.newYork) -> (CalendarReader, FakeCalendarStore) {
    let store = FakeCalendarStore(calendars: calendars, events: events, floatingTimeZone: floatingTimeZone)
    store.rawStatus = 3
    return (CalendarReader(store: store, accessPath: .fullAccess), store)
}

let november = (start: at("2026-11-01T00:00:00-04:00"), end: at("2026-12-01T00:00:00-05:00"))

/// Calendars A, B and C, in that order (named so they sort that way).
let abc = [calendar("A", "A calendar"), calendar("B", "B calendar", account: .google), calendar("C", "C calendar", account: .exchange)]
