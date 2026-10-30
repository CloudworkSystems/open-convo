import Foundation

/// Reads the calendars on this Mac, Google ones included when the Google
/// account is added under System Settings, Internet Accounts
/// (docs/plans/calendar-through-the-mac.md, PR 1).
///
/// Read only, and nothing leaves the Mac. It asks for access only when
/// `requestAccess()` is called, checks access again on every read (so a
/// revocation in System Settings is noticed), and refreshes on the store's
/// own change notice, with no polling of its own. It logs nothing.
public final class CalendarReader {
    /// The longest range one read may cover.
    public static let maximumRangeDays = 400

    /// System Settings, Privacy & Security, Calendars: what the views open
    /// when access is refused or revoked.
    public static let privacySettingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars")!

    public let accessPath: CalendarAccessPath
    private let store: CalendarStore

    public init(store: CalendarStore, accessPath: CalendarAccessPath = .current) {
        self.store = store
        self.accessPath = accessPath
    }

    /// Read fresh from the store each time.
    public var accessState: CalendarAccessState {
        accessPath.accessState(rawStatus: store.authorizationRawStatus())
    }

    /// Asks the person once, by this Mac's request. When access was already
    /// decided, macOS wouldn't ask again, so this only reports the state.
    /// A failed request is reported as the state it left, never thrown.
    @discardableResult
    public func requestAccess() async -> CalendarAccessState {
        guard accessState == .notDetermined else { return accessState }
        _ = try? await store.requestAccess(path: accessPath)
        return accessState
    }

    /// Every event calendar on this Mac, by name, then id.
    public func calendars() throws -> [CalendarInfo] {
        try requireAccess()
        return sortedCalendars()
    }

    /// The meetings overlapping `start..<end` (at most 400 days), each shown
    /// once however many calendars hold a copy, in the order they happen.
    ///
    /// - Parameters:
    ///   - calendarIDs: the calendars to read, in the person's order, which
    ///     also decides which copy is shown when copies agree. Nil reads every
    ///     calendar in `calendars()` order. Unknown ids are skipped.
    ///   - displayTimeZone: the zone timed occurrences are shown in. All-day
    ///     occurrences are dates and don't depend on it.
    public func occurrences(from start: Date, to end: Date, calendarIDs: [String]? = nil,
                            displayTimeZone: TimeZone = .current) throws -> [OccurrenceGroup] {
        try requireAccess()
        guard end > start else { throw CalendarReaderError.invalidRange }
        let limit = CalendarDate.gregorian(displayTimeZone)
            .date(byAdding: .day, value: CalendarReader.maximumRangeDays, to: start) ?? start
        guard end <= limit else { throw CalendarReaderError.rangeTooLong }

        let known = sortedCalendars().map(\.id)
        var order: [String] = []
        for id in calendarIDs ?? known where known.contains(id) && !order.contains(id) {
            order.append(id)
        }
        guard !order.isEmpty else { return [] }
        let index = Dictionary(uniqueKeysWithValues: order.enumerated().map { ($0.element, $0.offset) })

        let mapper = OccurrenceMapper(displayTimeZone: displayTimeZone, floatingTimeZone: store.floatingTimeZone)
        var seen = Set<String>()
        var mapped: [MappedOccurrence] = []
        for raw in store.occurrences(from: start, to: end, calendarIDs: order) {
            guard let calendarIndex = index[raw.calendarID] else { continue }
            let occurrence = mapper.map(raw, calendarIndex: calendarIndex)
            guard seen.insert(occurrence.occurrence.key).inserted else { continue }
            mapped.append(occurrence)
        }
        return OccurrenceGrouping.group(mapped)
    }

    /// Calls `handler` on the main queue when the calendars change (a sync
    /// brought in an edit made in Google Calendar on the web, for example) or
    /// access changes. Read again then; check `accessState` first.
    public func observeChanges(_ handler: @escaping () -> Void) -> CalendarChangeToken {
        store.observeChanges(handler)
    }

    private func requireAccess() throws {
        let state = accessState
        guard state == .granted else { throw CalendarReaderError.noAccess(state) }
    }

    private func sortedCalendars() -> [CalendarInfo] {
        store.calendars().sorted { a, b in
            let byName = a.name.localizedStandardCompare(b.name)
            if byName != .orderedSame { return byName == .orderedAscending }
            return compareCodeUnits(a.id, b.id) < 0
        }
    }
}

public enum CalendarReaderError: Error, Equatable {
    /// Reading isn't allowed: the state says why (refused, restricted, write
    /// only, or not asked yet). The views say so and offer System Settings.
    case noAccess(CalendarAccessState)
    /// The end is not after the start.
    case invalidRange
    /// The range is longer than `CalendarReader.maximumRangeDays`.
    case rangeTooLong
}
