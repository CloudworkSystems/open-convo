#if canImport(EventKit)
import CoreGraphics
import EventKit
import Foundation

/// The real calendar store: Apple's calendar framework, read only. This is
/// the only file in the module that names EventKit. Making one asks nothing;
/// macOS asks the person only when `requestAccess(path:)` runs.
public final class EventKitCalendarStore: CalendarStore {
    private let store = EKEventStore()

    public init() {}

    public var floatingTimeZone: TimeZone { TimeZone.current }

    public func authorizationRawStatus() -> Int {
        EKEventStore.authorizationStatus(for: .event).rawValue
    }

    public func requestAccess(path: CalendarAccessPath) async throws -> Bool {
        let granted: Bool
        switch path {
        case .fullAccess:
            if #available(macOS 14.0, *) {
                granted = try await store.requestFullAccessToEvents()
            } else {
                granted = try await store.requestAccess(to: .event)
            }
        case .legacy:
            granted = try await store.requestAccess(to: .event)
        }
        // A store made before access was granted can list nothing until
        // its accounts are read again.
        if granted { store.refreshSourcesIfNecessary() }
        return granted
    }

    public func calendars() -> [CalendarInfo] {
        store.calendars(for: .event).map { calendar in
            CalendarInfo(
                id: calendar.calendarIdentifier,
                name: calendar.title,
                colorHex: EventKitCalendarStore.hex(calendar.cgColor),
                account: CalendarAccountKind.classify(sourceType: calendar.source?.sourceType.rawValue ?? -1,
                                                      sourceTitle: calendar.source?.title ?? "")
            )
        }
    }

    public func occurrences(from start: Date, to end: Date, calendarIDs: [String]) -> [StoreOccurrence] {
        let wanted = Set(calendarIDs)
        let calendars = store.calendars(for: .event).filter { wanted.contains($0.calendarIdentifier) }
        guard !calendars.isEmpty else { return [] }
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
        return store.events(matching: predicate).compactMap { event -> StoreOccurrence? in
            guard let calendarID = event.calendar?.calendarIdentifier, let eventStart = event.startDate else { return nil }
            let repeats = event.hasRecurrenceRules || event.isDetached
            let originalStart: Date? = repeats ? event.occurrenceDate : nil
            return StoreOccurrence(
                eventID: event.eventIdentifier ?? event.calendarItemIdentifier,
                externalID: event.calendarItemExternalIdentifier,
                calendarID: calendarID,
                title: event.title ?? "",
                location: event.location,
                status: EventKitCalendarStore.status(event.status),
                start: eventStart,
                end: event.endDate ?? eventStart,
                isAllDay: event.isAllDay,
                originalStart: originalStart,
                organizerIsCurrentUser: event.organizer?.isCurrentUser ?? false
            )
        }
    }

    public func observeChanges(_ handler: @escaping () -> Void) -> CalendarChangeToken {
        let center = NotificationCenter.default
        let observer = center.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { _ in handler() }
        return CalendarChangeToken { center.removeObserver(observer) }
    }

    /// EventKit's "none" means no status was set, which iCalendar (and the
    /// merge engine) reads as confirmed.
    static func status(_ status: EKEventStatus) -> OccurrenceStatus {
        switch status {
        case .canceled: return .cancelled
        case .tentative: return .tentative
        case .none, .confirmed: return .confirmed
        @unknown default: return .confirmed
        }
    }

    static func hex(_ color: CGColor?) -> String {
        guard let color, let sRGB = CGColorSpace(name: CGColorSpace.sRGB),
              let converted = color.converted(to: sRGB, intent: .defaultIntent, options: nil),
              let parts = converted.components, parts.count >= 3 else {
            return "#808080"
        }
        return CalendarInfo.hex(red: Double(parts[0]), green: Double(parts[1]), blue: Double(parts[2]))
    }
}
#endif
