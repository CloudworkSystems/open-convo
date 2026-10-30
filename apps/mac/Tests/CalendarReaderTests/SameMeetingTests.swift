import CalendarReader
import Foundation
import Testing

/// The same meeting in two calendars shows once: the merge engine's rules
/// ("The Same Event In Two Calendars", packages/calendar-merge, test 9),
/// repeated against the fake store, and the plan's rule for which copy wins.
@Suite("The same meeting in two calendars")
struct SameMeetingTests {
    /// Each group as its event ids, sorted, joined with "|"; the list sorted.
    private func groupsOf(_ groups: [OccurrenceGroup]) -> [String] {
        groups.map { group in
            Set(group.key.components(separatedBy: " + ").map { $0.components(separatedBy: "|")[1] })
                .sorted().joined(separator: "|")
        }.sorted()
    }

    private func read(_ events: [StoreOccurrence], calendars: [CalendarInfo] = abc,
                      order: [String]? = nil) throws -> [OccurrenceGroup] {
        let (reader, _) = grantedReader(calendars, events)
        return try reader.occurrences(from: november.start, to: november.end, calendarIDs: order, displayTimeZone: Zones.newYork)
    }

    // MARK: - Matching

    @Test("The same invitation identifier in two calendars shows once, listing both calendars")
    func sameIdentifier() throws {
        let groups = try read([
            event("trip-b", in: "B", "Field trip", externalID: "shared@test.example"),
            event("trip-a", in: "A", "Field trip", externalID: "shared@test.example"),
        ])
        #expect(groups.count == 1)
        #expect(groups[0].matchedBy == .identifier)
        #expect(groups[0].calendarIDs == ["A", "B"])
        #expect(groups[0].shown == .one(groups[0].first))
        #expect(groups[0].first.calendarID == "A")
        #expect(groups[0].key == "A|trip-a + B|trip-b")
    }

    @Test("A repeating meeting in two calendars with one occurrence moved: each occurrence shows once, matched by its original start")
    func repeatingWithOneMoved() throws {
        func series(_ id: String, in calendarID: String, movedStart: String) -> [StoreOccurrence] {
            [
                event(id, in: calendarID, "Weekly sync", start: "2026-11-12T10:00:00-05:00", end: "2026-11-12T11:00:00-05:00",
                      externalID: "weekly@test.example", originalStart: "2026-11-12T10:00:00-05:00"),
                event(id, in: calendarID, "Weekly sync", start: movedStart, end: at(movedStart).addingTimeInterval(3600).iso,
                      externalID: "weekly@test.example", originalStart: "2026-11-19T10:00:00-05:00"),
                event(id, in: calendarID, "Weekly sync", start: "2026-11-26T10:00:00-05:00", end: "2026-11-26T11:00:00-05:00",
                      externalID: "weekly@test.example", originalStart: "2026-11-26T10:00:00-05:00"),
            ]
        }
        // Moved in both calendars.
        let both = try read(series("s-a", in: "A", movedStart: "2026-11-19T14:00:00-05:00")
                            + series("s-b", in: "B", movedStart: "2026-11-19T14:00:00-05:00"))
        #expect(both.count == 3)
        #expect(both.allSatisfy { $0.calendarIDs == ["A", "B"] && $0.matchedBy == .identifier && !$0.copiesDiffer })
        guard case .timed(let moved, _) = both[1].first.time else { Issue.record("timed"); return }
        #expect(moved.local == "2026-11-19T14:00:00-05:00")
        #expect(both[1].first.originalStart == at("2026-11-19T10:00:00-05:00"))
        // Moved in one calendar only (the other hasn't synced yet): still one
        // meeting for that occurrence, marked as differing, with both versions.
        let one = try read(series("s-a", in: "A", movedStart: "2026-11-19T14:00:00-05:00")
                           + series("s-b", in: "B", movedStart: "2026-11-19T10:00:00-05:00"))
        #expect(one.count == 3)
        let differing = one.filter(\.copiesDiffer)
        #expect(differing.count == 1)
        guard case .differing(let versions) = differing.first?.shown else { Issue.record("differing"); return }
        #expect(versions.map(\.calendarID) == ["A", "B"])
        #expect(versions.allSatisfy { $0.originalStart == at("2026-11-19T10:00:00-05:00") })
    }

    @Test("Different identifiers with the same title and time show once; two copies in one calendar, or different times, don't")
    func titleAndTime() throws {
        let groups = try read([
            event("a-cafe", in: "A", "Café with Juniper", start: "2026-11-12T15:00:00-05:00", end: "2026-11-12T16:00:00-05:00", externalID: "a-cafe@test.example"),
            event("a-twice-1", in: "A", "Standup", start: "2026-11-13T09:00:00-05:00", end: "2026-11-13T09:15:00-05:00", externalID: "a-twice-1@test.example"),
            event("a-twice-2", in: "A", "Standup", start: "2026-11-13T09:00:00-05:00", end: "2026-11-13T09:15:00-05:00", externalID: "a-twice-2@test.example"),
            event("a-later", in: "A", "Piano", start: "2026-11-14T10:00:00-05:00", end: "2026-11-14T11:00:00-05:00", externalID: "a-later@test.example"),
            event("b-cafe", in: "B", "  CAFE WITH JUNIPER  ", start: "2026-11-12T15:00:00-05:00", end: "2026-11-12T16:00:00-05:00", externalID: "b-cafe@test.example"),
            event("b-later", in: "B", "Piano", start: "2026-11-14T11:00:00-05:00", end: "2026-11-14T12:00:00-05:00", externalID: "b-later@test.example"),
        ])
        let cafe = groups.filter { $0.first.title.lowercased().contains("caf") }
        #expect(cafe.count == 1)
        #expect(cafe.first?.matchedBy == .titleAndTime)
        #expect(cafe.first?.calendarIDs == ["A", "B"])
        // The titles agree once case, accents and spaces are set aside.
        #expect(cafe.first?.shown == .one(cafe[0].first))
        #expect(cafe.first?.first.title == "Café with Juniper")
        #expect(groups.filter { $0.first.title == "Standup" }.count == 2)
        #expect(groups.filter { $0.first.title == "Piano" }.count == 2)
    }

    @Test("Copies without any identifier match by title and time too")
    func noIdentifiers() throws {
        let groups = try read([event("a1", in: "A", "Yoga"), event("b1", in: "B", "yoga ")])
        #expect(groupsOf(groups) == ["a1|b1"])
        #expect(groups[0].matchedBy == .titleAndTime)
    }

    @Test("A cancelled copy and a live copy at the same time are not merged")
    func cancelledAndLive() throws {
        let groups = try read([
            event("c1", in: "A", "Recital", externalID: "c1@test.example", status: .cancelled),
            event("c2", in: "B", "Recital", externalID: "c2@test.example"),
        ])
        #expect(groupsOf(groups) == ["c1", "c2"])
        #expect(groups.allSatisfy { $0.matchedBy == nil })
    }

    @Test("All-day copies match on the same dates")
    func allDayMatch() throws {
        let groups = try read([
            event("h1", in: "A", "Holiday", start: "2026-11-26T00:00:00-05:00", end: "2026-11-26T23:59:59-05:00", allDay: true),
            event("h2", in: "B", "Holiday", start: "2026-11-26T00:00:00-05:00", end: "2026-11-27T00:00:00-05:00", allDay: true),
            event("h3", in: "C", "Holiday", start: "2026-11-26T00:00:00-05:00", end: "2026-11-27T23:59:59-05:00", allDay: true),
        ])
        #expect(groupsOf(groups) == ["h1|h2", "h3"])
    }

    @Test("Collisions: Dentist twice in A and once in B, then a third copy in C; shuffling never changes the groups")
    func dentist() throws {
        let a1 = event("a1", in: "A", externalID: "a1"), a2 = event("a2", in: "A", externalID: "a2")
        let b1 = event("b1", in: "B", externalID: "b1"), c1 = event("c1", in: "C", externalID: "c1")
        #expect(groupsOf(try read([a1, a2, b1], order: ["A", "B"])) == ["a1|b1", "a2"])
        #expect(groupsOf(try read([a1, a2, b1, c1])) == ["a1|b1|c1", "a2"])
        #expect(groupsOf(try read([c1, b1, a2, a1])) == ["a1|b1|c1", "a2"])
        #expect(groupsOf(try read([a2, c1, a1, b1])) == ["a1|b1|c1", "a2"])
        for group in try read([a1, a2, b1, c1]) {
            #expect(Set(group.calendarIDs).count == group.calendarIDs.count)
        }
    }

    @Test("A copy joins a group only if none of its calendars are already there")
    func disjointCalendars() throws {
        // x is in A and B (one identifier); y only in B; z only in C.
        let groups = try read([
            event("x", in: "A", externalID: "x"), event("x", in: "B", externalID: "x"),
            event("y", in: "B", externalID: "y"), event("z", in: "C", externalID: "z"),
        ])
        #expect(groupsOf(groups) == ["x|z", "y"])
        let xz = try #require(groups.first { $0.key.contains("|z") })
        #expect(xz.calendarIDs == ["A", "B", "C"])
        #expect(xz.matchedBy == .titleAndTime)
    }

    @Test("Ordering is by the earliest calendar in the list, then the identifier")
    func orderingByCalendarThenIdentifier() throws {
        // c is in A and B, b only in B, a only in C: so c and a pair, b is alone.
        let events = [
            event("c", in: "A", externalID: "c"), event("b", in: "B", externalID: "b"),
            event("c", in: "B", externalID: "c"), event("a", in: "C", externalID: "a"),
        ]
        #expect(groupsOf(try read(events)) == ["a|c", "b"])
        #expect(groupsOf(try read(events.reversed())) == ["a|c", "b"])
    }

    @Test("A meeting whose copies differ is never matched further by title and time")
    func differingIsNotMatchedFurther() throws {
        let groups = try read([
            event("u-a", in: "A", "Review", externalID: "u", location: "Room 1"),
            event("u-b", in: "B", "Review", externalID: "u", location: "Room 2"),
            event("plain", in: "C", "Review", location: "Room 1"),
        ])
        #expect(groupsOf(groups) == ["plain", "u-a|u-b"])
    }

    // MARK: - Which copy wins

    @Test("The organizer's own copy wins over an attendee copy, even when the attendee copy was touched later (no last-modified is ever read)")
    func organizerWins() throws {
        let groups = try read([
            event("att", in: "A", "Board review", externalID: "board@test.example", location: "Room 1"),
            event("org", in: "B", "Board review", externalID: "board@test.example", location: "Room 2", organizer: true),
        ])
        #expect(groups.count == 1)
        #expect(groups[0].first.calendarID == "B")
        #expect(groups[0].first.location == "Room 2")
        #expect(!groups[0].copiesDiffer)
        #expect(groups[0].calendarIDs == ["A", "B"])
    }

    @Test("Copies that agree show the copy from the earliest calendar in the person's list")
    func agreeingByListOrder() throws {
        let events = [
            event("p-a", in: "A", "Parents' evening", externalID: "pe@test.example", location: "Hall"),
            event("p-b", in: "B", "Parents' evening", externalID: "pe@test.example", location: "Hall"),
        ]
        let byDefault = try read(events)
        #expect(byDefault[0].shown == .one(byDefault[0].first))
        #expect(byDefault[0].first.calendarID == "A")
        let swapped = try read(events, order: ["B", "A"])
        #expect(swapped[0].first.calendarID == "B")
        #expect(swapped[0].calendarIDs == ["B", "A"])
    }

    @Test("Copies that disagree and none is the organizer's: shown once, marked, with every version in list order (three calendars too)")
    func disagreeingNoOrganizer() throws {
        let two = try read([
            event("m-b", in: "B", "Planning", externalID: "plan@test.example", location: "Room 2"),
            event("m-a", in: "A", "Planning", externalID: "plan@test.example", location: "Room 1"),
        ])
        #expect(two.count == 1)
        guard case .differing(let versions) = two[0].shown else { Issue.record("differing"); return }
        #expect(versions.map(\.calendarID) == ["A", "B"])
        #expect(versions.map(\.location) == ["Room 1", "Room 2"])

        let three = try read([
            event("m-a", in: "A", "Planning", externalID: "plan@test.example", location: "Room 1"),
            event("m-b", in: "B", "Planning", externalID: "plan@test.example", location: "Room 1"),
            event("m-c", in: "C", "Planning moved", start: "2026-11-12T10:30:00-05:00", end: "2026-11-12T11:30:00-05:00",
                  externalID: "plan@test.example", location: "Room 1"),
        ], order: ["C", "A", "B"])
        #expect(three.count == 1)
        guard case .differing(let all) = three[0].shown else { Issue.record("differing"); return }
        #expect(all.map(\.calendarID) == ["C", "A", "B"])
        #expect(three[0].calendarIDs == ["C", "A", "B"])
    }

    @Test("Two organizer copies: no copy is treated as right; if they disagree every version shows, if they agree the earliest calendar's shows")
    func twoOrganizers() throws {
        let disagreeing = try read([
            event("o-a", in: "A", "Family dinner", externalID: "dinner@test.example", location: "Home", organizer: true),
            event("o-b", in: "B", "Family dinner", externalID: "dinner@test.example", location: "Grandma's", organizer: true),
            event("o-c", in: "C", "Family dinner", externalID: "dinner@test.example", location: "Park"),
        ])
        guard case .differing(let versions) = disagreeing[0].shown else { Issue.record("differing"); return }
        #expect(versions.map(\.calendarID) == ["A", "B", "C"])

        let agreeing = try read([
            event("o-b", in: "B", "Family dinner", externalID: "dinner@test.example", location: "Home", organizer: true),
            event("o-a", in: "A", "Family dinner", externalID: "dinner@test.example", location: "Home", organizer: true),
        ])
        #expect(!agreeing[0].copiesDiffer)
        #expect(agreeing[0].first.calendarID == "A")
    }

    @Test("A status difference is a disagreement: a cancellation in one calendar is never quietly hidden")
    func statusDisagreement() throws {
        let groups = try read([
            event("l-a", in: "A", "Lunch", externalID: "lunch@test.example"),
            event("l-b", in: "B", "Lunch", externalID: "lunch@test.example", status: .cancelled),
        ])
        guard case .differing(let versions) = groups[0].shown else { Issue.record("differing"); return }
        #expect(versions.map(\.status) == [.confirmed, .cancelled])
    }

    @Test("The order the store returns events in never changes the result")
    func determinism() throws {
        let events = [
            event("r1", in: "A", "Run", start: "2026-11-12T07:00:00-05:00", end: "2026-11-12T08:00:00-05:00", externalID: "x1", location: "Park"),
            event("r2", in: "A", "Run", start: "2026-11-12T07:00:00-05:00", end: "2026-11-12T08:00:00-05:00", externalID: "x2", location: "Track"),
            event("s1", in: "A", "Swim", start: "2026-11-12T18:00:00-05:00", end: "2026-11-12T19:00:00-05:00", externalID: "x3"),
            event("r3", in: "B", "run", start: "2026-11-12T07:00:00-05:00", end: "2026-11-12T08:00:00-05:00", externalID: "y1", location: "Gym"),
            event("s2", in: "B", "Swim", start: "2026-11-12T18:00:00-05:00", end: "2026-11-12T19:00:00-05:00", externalID: "y2"),
            event("s3", in: "C", "Swim", start: "2026-11-12T18:00:00-05:00", end: "2026-11-12T19:00:00-05:00", externalID: "x3"),
        ]
        let base = try read(events)
        #expect(try read(events.reversed()) == base)
        #expect(try read(Array(events[3...] + events[..<3])) == base)
    }
}

private extension Date {
    var iso: String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = Zones.newYork
        return formatter.string(from: self)
    }
}
