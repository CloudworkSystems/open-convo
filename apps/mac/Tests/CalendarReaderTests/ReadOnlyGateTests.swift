import Foundation
import Testing

/// The plan's builder rules, checked on the source: read only, nothing leaves
/// the Mac, nothing logged, Apple's frameworks only, the permission texts,
/// and wiring that asks nothing at launch (calendar-through-the-mac.md,
/// "Rules For The Builder").
@Suite("Calendar reader rules")
struct ReadOnlyGateTests {
    private static let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()

    private func moduleSources() throws -> [(name: String, text: String)] {
        let folder = Self.root.appendingPathComponent("Sources/CalendarReader")
        let names = try FileManager.default.contentsOfDirectory(atPath: folder.path).filter { $0.hasSuffix(".swift") }.sorted()
        return try names.map { ($0, try String(contentsOf: folder.appendingPathComponent($0), encoding: .utf8)) }
    }

    private func matches(_ pattern: String, in text: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
    }

    @Test("The store's requirements are read-only: no method creates, changes or deletes anything")
    func storeIsReadOnly() throws {
        let sources = try moduleSources()
        let source = try #require(sources.first { $0.name == "CalendarStore.swift" }).text
        let start = try #require(source.range(of: "public protocol CalendarStore: AnyObject {"))
        let body = String(source[start.upperBound...].prefix { $0 != "}" })
        let names = body.components(separatedBy: "\n").compactMap { line -> String? in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.hasPrefix("///"), let match = trimmed.firstMatch(of: #/^(?:func|var)\s+(\w+)/#) else { return nil }
            return String(match.1)
        }
        #expect(names == ["authorizationRawStatus", "requestAccess", "calendars", "occurrences", "floatingTimeZone", "observeChanges"])
    }

    @Test("No write call to Apple's calendar framework anywhere in the module")
    func noWriteCalls() throws {
        let sources = try moduleSources()
        #expect(sources.count >= 5)
        let forbidden = [#"\.save\("#, #"\.remove\("#, #"saveCalendar"#, #"removeCalendar"#, #"\.commit\("#, #"\.reset\("#,
                         #"WriteOnlyAccess"#, #"\bEKEvent\("#, #"\bEKCalendar\("#, #"EKReminder"#, #"\.reminder\b"#,
                         #"EKEventEditViewController"#, #"EKSource\("#]
        for (name, text) in sources {
            for pattern in forbidden {
                #expect(!matches(pattern, in: text), "\(name) matches \(pattern)")
            }
        }
    }

    @Test("Only the real store's file names EventKit; nothing logs, prints or reaches the network; Apple's frameworks only")
    func boundaries() throws {
        for (name, text) in try moduleSources() {
            #expect(matches(#"import EventKit"#, in: text) == (name == "EventKitCalendarStore.swift"), "\(name)")
            for pattern in [#"\bprint\("#, #"debugPrint\("#, #"NSLog"#, #"os_log"#, #"\bLogger\b"#, #"import os\b"#, #"standardError"#,
                            #"URLSession"#, #"https?://"#, #"\bNWConnection\b"#, #"@testable"#] {
                #expect(!matches(pattern, in: text), "\(name) matches \(pattern)")
            }
            let imports = text.components(separatedBy: "\n").filter { $0.hasPrefix("import ") }
            #expect(Set(imports).isSubset(of: ["import Foundation", "import EventKit", "import CoreGraphics"]), "\(name): \(imports)")
        }
    }

    @Test("Both permission texts are in the app's Info.plist, word for word as the plan says")
    func usageTexts() throws {
        let data = try Data(contentsOf: Self.root.appendingPathComponent("Packaging/Info.plist"))
        let plist = try #require(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        let text = "True Convo shows your calendars in its own views. It only reads them, on this Mac. Meeting places are shared only if you turn on travel time (sent to Apple) or open a place in Google Maps."
        #expect(plist["NSCalendarsFullAccessUsageDescription"] as? String == text)
        #expect(plist["NSCalendarsUsageDescription"] as? String == text)
        // Reading only: never the add-events-only (write only) permission.
        for key in ["NSCalendarsWriteOnlyAccessUsageDescription", "NSRemindersUsageDescription", "NSRemindersFullAccessUsageDescription"] {
            #expect(!plist.keys.contains(key), "\(key)")
        }
    }

    @Test("The module depends on nothing; the app links it and makes it lazily, so nothing asks for access at launch")
    func wiring() throws {
        let package = try String(contentsOf: Self.root.appendingPathComponent("Package.swift"), encoding: .utf8)
        #expect(package.contains(".target(name: \"CalendarReader\"),"))
        let appTarget = try #require(package.range(of: "name: \"VoiceCursorMac\",\n            dependencies: [").map {
            String(package[$0.upperBound...].prefix { $0 != "]" })
        })
        #expect(appTarget.contains("\"CalendarReader\""))
        let app = try String(contentsOf: Self.root.appendingPathComponent("Sources/VoiceCursorMac/main.swift"), encoding: .utf8)
        let uses = app.components(separatedBy: "\n").filter { $0.contains("CalendarReader") || $0.contains("calendarReader") || $0.contains("EventKit") }
        #expect(uses.map { $0.trimmingCharacters(in: .whitespaces) } == [
            "import CalendarReader",
            "private lazy var calendarReader = CalendarReader(store: EventKitCalendarStore())",
        ])
        #expect(!app.contains("calendarReader."), "nothing uses the reader yet, so nothing asks for access")
    }
}
