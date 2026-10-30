import Foundation

/// The same meeting in two calendars shows once. The matching rules are the
/// merge engine's ("The Same Event In Two Calendars" in
/// docs/plans/calendar-merge-engine.md, packages/calendar-merge), carried
/// over unchanged; only the choice of the shown copy differs, because
/// EventKit has no `SEQUENCE` (calendar-through-the-mac.md, "Which copy wins").
enum OccurrenceGrouping {
    static func group(_ occurrences: [MappedOccurrence]) -> [OccurrenceGroup] {
        let units = identifierUnits(occurrences)
        let groups = matchTitleAndTime(units)
        return groups.map(makeGroup).sorted(by: showsBefore)
    }

    // MARK: - The same invitation identifier

    /// Copies with the same invitation identifier and the same occurrence
    /// (the same original start, or none for both) are one meeting. Anything
    /// without an identifier is a unit of its own.
    private static func identifierUnits(_ occurrences: [MappedOccurrence]) -> [Unit] {
        var byIdentifier: [String: [MappedOccurrence]] = [:]
        var order: [String] = []
        var units: [Unit] = []
        for occurrence in occurrences {
            guard let externalID = occurrence.externalID else {
                units.append(Unit(members: [occurrence]))
                continue
            }
            let occurrenceKey = occurrence.occurrence.originalStart.map { String(OccurrenceMapper.milliseconds($0)) } ?? "-"
            let key = "\(externalID)\u{1F}\(occurrenceKey)"
            if byIdentifier[key] == nil { order.append(key) }
            byIdentifier[key, default: []].append(occurrence)
        }
        for key in order {
            units.append(contentsOf: oneCopyPerCalendar(byIdentifier[key] ?? []).map(Unit.init(members:)))
        }
        return units
    }

    /// Two copies from the same calendar never merge, even with the same
    /// identifier (a calendar can hold an imported duplicate). In list order,
    /// each copy joins the first unit so far with no copy from its calendar.
    private static func oneCopyPerCalendar(_ copies: [MappedOccurrence]) -> [[MappedOccurrence]] {
        var split: [[MappedOccurrence]] = []
        for copy in copies.sorted(by: listOrder) {
            if let index = split.firstIndex(where: { !$0.contains { $0.calendarIndex == copy.calendarIndex } }) {
                split[index].append(copy)
            } else {
                split.append([copy])
            }
        }
        return split
    }

    // MARK: - Different identifiers, the same title and time

    /// Units with the same match key (normalized title, start, end and
    /// status) are grouped one to one, in a fixed order: by the earliest
    /// calendar in the person's list, then the identifier by code units, then
    /// the key. Each joins the first group so far that shares none of its
    /// calendars and holds no unit with its identifier; otherwise it starts a
    /// new group. A unit whose copies differ has no single title or time, so
    /// it is never matched further.
    private static func matchTitleAndTime(_ units: [Unit]) -> [[Unit]] {
        var buckets: [String: [Unit]] = [:]
        var bucketOrder: [String] = []
        var result: [[Unit]] = []
        for unit in units {
            guard let matchKey = unit.matchKey else {
                result.append([unit])
                continue
            }
            if buckets[matchKey] == nil { bucketOrder.append(matchKey) }
            buckets[matchKey, default: []].append(unit)
        }
        for matchKey in bucketOrder {
            let bucket = (buckets[matchKey] ?? []).sorted { a, b in
                if a.minCalendarIndex != b.minCalendarIndex { return a.minCalendarIndex < b.minCalendarIndex }
                let byIdentifier = compareCodeUnits(a.externalID ?? "", b.externalID ?? "")
                if byIdentifier != 0 { return byIdentifier < 0 }
                return compareCodeUnits(a.key, b.key) < 0
            }
            var groups: [TitleTimeGroup] = []
            for unit in bucket {
                let index = groups.firstIndex { group in
                    group.calendars.isDisjoint(with: unit.calendarIndexes)
                        && !(unit.externalID.map { group.identifiers.contains($0) } ?? false)
                }
                if let index {
                    groups[index].add(unit)
                } else {
                    var group = TitleTimeGroup()
                    group.add(unit)
                    groups.append(group)
                }
            }
            result.append(contentsOf: groups.map { $0.units })
        }
        return result
    }

    // MARK: - The shown copy

    private static func makeGroup(_ units: [Unit]) -> OccurrenceGroup {
        let members = units.flatMap(\.members).sorted(by: listOrder)
        let matchedBy: OccurrenceGroup.MatchedBy?
        if units.count > 1 {
            matchedBy = .titleAndTime
        } else if members.count > 1 {
            matchedBy = .identifier
        } else {
            matchedBy = nil
        }
        var calendarIDs: [String] = []
        for member in members where !calendarIDs.contains(member.occurrence.calendarID) {
            calendarIDs.append(member.occurrence.calendarID)
        }
        let key = members.map(\.occurrence.key).sorted { compareCodeUnits($0, $1) < 0 }.joined(separator: " + ")
        return OccurrenceGroup(key: key, calendarIDs: calendarIDs, matchedBy: matchedBy, shown: shown(members))
    }

    /// The organizer's own copy wins when exactly one copy is it. Otherwise
    /// no copy is treated as right: copies that agree on title, time,
    /// location and status show the earliest calendar's copy; copies that
    /// disagree show every version. Last-modified dates are never used.
    /// Titles and places are compared as the match compares titles (case,
    /// accents and spaces at the ends ignored), so "Café" and " CAFE " agree.
    static func shown(_ members: [MappedOccurrence]) -> OccurrenceGroup.Shown {
        let ordered = members.sorted(by: listOrder)
        let organizers = ordered.filter(\.organizerIsCurrentUser)
        if organizers.count == 1 { return .one(organizers[0].occurrence) }
        let first = ordered[0].occurrence
        let agree = ordered.dropFirst().allSatisfy { agrees($0.occurrence, first) }
        return agree ? .one(first) : .differing(ordered.map(\.occurrence))
    }

    private static func agrees(_ a: CalendarOccurrence, _ b: CalendarOccurrence) -> Bool {
        a.time == b.time && a.status == b.status
            && normalize(a.title) == normalize(b.title)
            && normalize(a.location ?? "") == normalize(b.location ?? "")
    }

    // MARK: - Helpers

    private struct TitleTimeGroup {
        var units: [Unit] = []
        var calendars = Set<Int>()
        var identifiers = Set<String>()

        mutating func add(_ unit: Unit) {
            units.append(unit)
            calendars.formUnion(unit.calendarIndexes)
            if let identifier = unit.externalID { identifiers.insert(identifier) }
        }
    }

    /// A unit: one occurrence, or every copy of one invitation's occurrence.
    private struct Unit {
        let members: [MappedOccurrence]
        let calendarIndexes: Set<Int>
        let minCalendarIndex: Int
        let externalID: String?
        let key: String
        let matchKey: String?

        init(members: [MappedOccurrence]) {
            let ordered = members.sorted(by: OccurrenceGrouping.listOrder)
            self.members = ordered
            calendarIndexes = Set(ordered.map(\.calendarIndex))
            minCalendarIndex = ordered.map(\.calendarIndex).min() ?? 0
            externalID = ordered.first?.externalID
            key = ordered.map(\.occurrence.key).sorted { compareCodeUnits($0, $1) < 0 }.joined(separator: " + ")
            switch OccurrenceGrouping.shown(ordered) {
            case .one(let occurrence): matchKey = OccurrenceGrouping.matchKey(occurrence)
            case .differing: matchKey = nil
            }
        }
    }

    static func matchKey(_ occurrence: CalendarOccurrence) -> String {
        let when: String
        switch occurrence.time {
        case .allDay(let start, let end):
            when = "D\(start)-\(end)"
        case .timed(let start, let end):
            when = "T\(OccurrenceMapper.milliseconds(start.utc))-\(OccurrenceMapper.milliseconds(end.utc))"
        }
        return "\(when)|\(normalize(occurrence.title))|\(occurrence.status.rawValue)"
    }

    /// The merge engine's title rule: lower case, accents removed, spaces
    /// and line breaks at the ends trimmed.
    static func normalize(_ text: String) -> String {
        let decomposed = text.lowercased().decomposedStringWithCanonicalMapping
        var scalars = String.UnicodeScalarView()
        for scalar in decomposed.unicodeScalars {
            switch scalar.properties.generalCategory {
            case .nonspacingMark, .spacingMark, .enclosingMark: continue
            default: scalars.append(scalar)
            }
        }
        return String(scalars).precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func listOrder(_ a: MappedOccurrence, _ b: MappedOccurrence) -> Bool {
        if a.calendarIndex != b.calendarIndex { return a.calendarIndex < b.calendarIndex }
        return compareCodeUnits(a.occurrence.key, b.occurrence.key) < 0
    }

    /// Day first, then all-day before timed, then start, then key.
    private static func showsBefore(_ a: OccurrenceGroup, _ b: OccurrenceGroup) -> Bool {
        let left = sortKey(a.first), right = sortKey(b.first)
        if left.day != right.day { return left.day < right.day }
        if left.timed != right.timed { return !left.timed }
        if left.start != right.start { return left.start < right.start }
        return compareCodeUnits(a.key, b.key) < 0
    }

    private static func sortKey(_ occurrence: CalendarOccurrence) -> (day: String, timed: Bool, start: Int64) {
        switch occurrence.time {
        case .allDay(let start, _):
            return (start.description, false, 0)
        case .timed(let start, _):
            return (String(start.local.prefix(10)), true, OccurrenceMapper.milliseconds(start.utc))
        }
    }
}

/// Compares by UTF-16 code units, like the merge engine's JavaScript.
func compareCodeUnits(_ a: String, _ b: String) -> Int {
    var left = a.utf16.makeIterator(), right = b.utf16.makeIterator()
    while true {
        switch (left.next(), right.next()) {
        case (nil, nil): return 0
        case (nil, _): return -1
        case (_, nil): return 1
        case let (x?, y?):
            if x != y { return x < y ? -1 : 1 }
        }
    }
}
