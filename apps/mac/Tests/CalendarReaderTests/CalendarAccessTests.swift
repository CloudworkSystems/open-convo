import CalendarReader
import Foundation
import Testing

/// Asking for access on macOS 13 and on macOS 14 and later, through one
/// interface: granted, refused, and revoked later (calendar-through-the-mac.md, PR 1).
@Suite("Calendar access")
struct CalendarAccessTests {
    @Test("macOS 13 takes the older request and its text; macOS 14 and later take full access and theirs")
    func pathPerSystem() {
        #expect(CalendarAccessPath.forSystem(majorVersion: 13) == .legacy)
        for major in [14, 15, 26] {
            #expect(CalendarAccessPath.forSystem(majorVersion: major) == .fullAccess)
        }
        #expect(CalendarAccessPath.legacy.usageDescriptionKey == "NSCalendarsUsageDescription")
        #expect(CalendarAccessPath.fullAccess.usageDescriptionKey == "NSCalendarsFullAccessUsageDescription")
    }

    @Test("Apple's statuses read the same on both paths, except write only, which can't read; unknown never reads as granted")
    func statusMapping() {
        for path in [CalendarAccessPath.legacy, .fullAccess] {
            #expect(path.accessState(rawStatus: 0) == .notDetermined)
            #expect(path.accessState(rawStatus: 1) == .restricted)
            #expect(path.accessState(rawStatus: 2) == .refused)
            #expect(path.accessState(rawStatus: 3) == .granted)
            #expect(path.accessState(rawStatus: 99) == .refused)
            #expect(path.accessState(rawStatus: -1) == .refused)
        }
        #expect(CalendarAccessPath.fullAccess.accessState(rawStatus: 4) == .writeOnly)
        #expect(CalendarAccessPath.legacy.accessState(rawStatus: 4) == .refused)
    }

    @Test("Granted on each path: the request for that system is used once, and reading works", arguments: [CalendarAccessPath.legacy, .fullAccess])
    func granted(path: CalendarAccessPath) async throws {
        let store = FakeCalendarStore(calendars: abc, events: [event("e1", in: "A")])
        let reader = CalendarReader(store: store, accessPath: path)
        #expect(reader.accessState == .notDetermined)
        #expect(store.queries.isEmpty)
        let state = await reader.requestAccess()
        #expect(state == .granted)
        #expect(store.requestedPaths == [path])
        #expect(try reader.calendars().map(\.id) == ["A", "B", "C"])
        #expect(try reader.occurrences(from: november.start, to: november.end).count == 1)
        // Already decided: asking again doesn't prompt.
        let answer1 = await reader.requestAccess()
        #expect(answer1 == .granted)
        #expect(store.requestedPaths == [path])
    }

    @Test("Refused on each path: reading says so, and nothing is read from the store", arguments: [CalendarAccessPath.legacy, .fullAccess])
    func refused(path: CalendarAccessPath) async throws {
        let store = FakeCalendarStore(calendars: abc, events: [event("e1", in: "A")])
        store.answer = 2
        let reader = CalendarReader(store: store, accessPath: path)
        let answer2 = await reader.requestAccess()
        #expect(answer2 == .refused)
        #expect(throws: CalendarReaderError.noAccess(.refused)) { try reader.calendars() }
        #expect(throws: CalendarReaderError.noAccess(.refused)) { try reader.occurrences(from: november.start, to: november.end) }
        #expect(store.queries.isEmpty)
        // macOS won't ask twice, so neither does the reader.
        let answer3 = await reader.requestAccess()
        #expect(answer3 == .refused)
        #expect(store.requestedPaths == [path])
    }

    @Test("macOS 14: allowing only new events (write only) can't read, and says so")
    func writeOnly() async {
        let store = FakeCalendarStore(calendars: abc)
        store.answer = 4
        let reader = CalendarReader(store: store, accessPath: .fullAccess)
        let answer4 = await reader.requestAccess()
        #expect(answer4 == .writeOnly)
        #expect(throws: CalendarReaderError.noAccess(.writeOnly)) { try reader.calendars() }
    }

    @Test("Restricted or not asked yet: reading says which, and never prompts by itself")
    func restrictedAndNotAsked() {
        let store = FakeCalendarStore(calendars: abc)
        let reader = CalendarReader(store: store, accessPath: .fullAccess)
        #expect(throws: CalendarReaderError.noAccess(.notDetermined)) { try reader.calendars() }
        store.rawStatus = 1
        #expect(throws: CalendarReaderError.noAccess(.restricted)) { try reader.calendars() }
        #expect(store.requestedPaths.isEmpty)
    }

    @Test("A failed request is reported as the state it left, not thrown")
    func failedRequest() async {
        let store = FakeCalendarStore(calendars: abc)
        store.requestFails = true
        let reader = CalendarReader(store: store, accessPath: .legacy)
        let answer5 = await reader.requestAccess()
        #expect(answer5 == .notDetermined)
        #expect(store.requestedPaths == [.legacy])
    }

    @Test("Revoked later in System Settings, on each path: the change notice comes, reading stops and says so", arguments: [CalendarAccessPath.legacy, .fullAccess])
    func revokedLater(path: CalendarAccessPath) async throws {
        let store = FakeCalendarStore(calendars: abc, events: [event("e1", in: "A")])
        let reader = CalendarReader(store: store, accessPath: path)
        let answer6 = await reader.requestAccess()
        #expect(answer6 == .granted)
        var notices = 0
        let token = reader.observeChanges { notices += 1 }
        #expect(try reader.occurrences(from: november.start, to: november.end).count == 1)
        store.rawStatus = 2
        store.simulateChange()
        #expect(notices == 1)
        #expect(reader.accessState == .refused)
        #expect(throws: CalendarReaderError.noAccess(.refused)) { try reader.occurrences(from: november.start, to: november.end) }
        #expect(throws: CalendarReaderError.noAccess(.refused)) { try reader.calendars() }
        #expect(store.queries.count == 1)
        token.cancel()
    }

    @Test("The change notice refreshes: an edit synced in shows on the next read; a cancelled or released token stops the notices")
    func changeNotice() throws {
        let (reader, store) = grantedReader(abc, [event("e1", in: "A", "Piano")])
        var notices = 0
        var token: CalendarChangeToken? = reader.observeChanges { notices += 1 }
        #expect(try reader.occurrences(from: november.start, to: november.end).map(\.first.title) == ["Piano"])
        store.events = [event("e1", in: "A", "Piano lesson")]
        store.simulateChange()
        #expect(notices == 1)
        #expect(try reader.occurrences(from: november.start, to: november.end).map(\.first.title) == ["Piano lesson"])
        token?.cancel()
        store.simulateChange()
        #expect(notices == 1)
        #expect(store.observerCount == 0)
        token = reader.observeChanges { notices += 1 }
        #expect(store.observerCount == 1)
        token = nil
        #expect(store.observerCount == 0)
        store.simulateChange()
        #expect(notices == 1)
    }

    @Test("The settings button opens Privacy & Security, Calendars")
    func settingsLink() {
        #expect(CalendarReader.privacySettingsURL.absoluteString == "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars")
    }
}
