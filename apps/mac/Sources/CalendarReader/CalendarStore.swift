import Foundation

/// The reader's only way to the calendars: Apple's calendar framework in the
/// app (`EventKitCalendarStore`), a fake store in tests.
///
/// Read only. Nothing here creates, changes or deletes an event, calendar or
/// reminder, and a test checks that these stay the only requirements.
public protocol CalendarStore: AnyObject {
    /// Apple's authorization status for events, by raw value
    /// (`CalendarAccessPath.accessState(rawStatus:)` reads it).
    func authorizationRawStatus() -> Int
    /// Asks the person once, by the request for `path`. True when allowed.
    func requestAccess(path: CalendarAccessPath) async throws -> Bool
    /// Every event calendar the Mac knows, in any order.
    func calendars() -> [CalendarInfo]
    /// The occurrences in the given calendars that overlap `start..<end`,
    /// with repeating events already expanded and changed or cancelled
    /// occurrences already applied (Apple's framework does both).
    func occurrences(from start: Date, to end: Date, calendarIDs: [String]) -> [StoreOccurrence]
    /// The time zone the store reads all-day and floating dates in.
    var floatingTimeZone: TimeZone { get }
    /// Calls `handler` on the main queue whenever the store changes: a sync
    /// brought changes in, something was edited elsewhere, or access changed.
    /// Stops when the token is cancelled or released.
    func observeChanges(_ handler: @escaping () -> Void) -> CalendarChangeToken
}

/// One occurrence as the store gives it, before the reader maps it.
public struct StoreOccurrence: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    /// The store's own id for the event (shared by a series' occurrences).
    public var eventID: String
    /// The invitation identifier shared across calendars (EventKit's external
    /// identifier, standing in for the iCalendar `UID`), when there is one.
    public var externalID: String?
    public var calendarID: String
    public var title: String
    public var location: String?
    public var status: OccurrenceStatus
    public var start: Date
    public var end: Date
    public var isAllDay: Bool
    /// The original start of a repeating occurrence; nil for a one-off.
    public var originalStart: Date?
    /// True when the store marks the organizer as the person using this Mac.
    public var organizerIsCurrentUser: Bool

    public init(eventID: String, externalID: String?, calendarID: String, title: String, location: String?,
                status: OccurrenceStatus, start: Date, end: Date, isAllDay: Bool, originalStart: Date?,
                organizerIsCurrentUser: Bool) {
        self.eventID = eventID
        self.externalID = externalID
        self.calendarID = calendarID
        self.title = title
        self.location = location
        self.status = status
        self.start = start
        self.end = end
        self.isAllDay = isAllDay
        self.originalStart = originalStart
        self.organizerIsCurrentUser = organizerIsCurrentUser
    }

    public var description: String { "StoreOccurrence(calendar: \(calendarID), event: \(eventID))" }
    public var debugDescription: String { description }
}

/// Keeps a change observation alive. Cancel it, or let it go, to stop.
public final class CalendarChangeToken {
    private var onCancel: (() -> Void)?

    public init(onCancel: @escaping () -> Void) {
        self.onCancel = onCancel
    }

    public func cancel() {
        let stop = onCancel
        onCancel = nil
        stop?()
    }

    deinit {
        cancel()
    }
}
