import Foundation
import Testing
@testable import DeskHost

/// The participant wire vocabulary (docs/desk-native-participant-contract.md
/// sections 3-5, 8 and 15), on invented values only.
@Suite("Participant wire vocabulary")
struct ParticipantWireTests {
    /// The pin from the shared vectors' context.
    static let pinFields = ["id": "claude-code", "label": "Claude Code", "model": "invented-pinned-model", "executionHost": "this-mac"]

    static func pinJSON(_ overrides: [String: JSONValue] = [:], dropping: String? = nil) -> JSONValue {
        var fields = pinFields.mapValues { JSONValue.string($0) }
        for (key, value) in overrides { fields[key] = value }
        if let dropping { fields.removeValue(forKey: dropping) }
        return .object(fields)
    }

    @Test("A pin string is nonblank as the page trims it and at most 256 UTF-8 bytes, counted in bytes, not characters")
    func pinFieldBounds() throws {
        let twoByte = String(repeating: "é", count: 128)
        #expect(twoByte.utf8.count == 256)
        #expect(ParticipantPin.isValidField(twoByte), "256 bytes passes")
        let overByOne = "a" + twoByte
        #expect(overByOne.utf8.count == 257 && overByOne.count == 129)
        #expect(!ParticipantPin.isValidField(overByOne), "257 bytes fails though it is only 129 characters")
        let threeByte = String(repeating: "€", count: 85) + "ab"
        #expect(threeByte.utf8.count == 257)
        #expect(!ParticipantPin.isValidField(threeByte))
        let threeByteExact = String(repeating: "€", count: 85) + "a"
        #expect(threeByteExact.utf8.count == 256)
        #expect(ParticipantPin.isValidField(threeByteExact), "three-byte characters totalling exactly 256 bytes pass")
        // Four-byte characters are surrogate pairs to the page: 64 of them
        // are 128 UTF-16 units but 256 UTF-8 bytes, the widest gap between
        // the page's `.length` and the byte count both sides enforce.
        let fourByte = String(repeating: "\u{1F600}", count: 64)
        #expect(fourByte.utf8.count == 256 && fourByte.utf16.count == 128)
        #expect(ParticipantPin.isValidField(fourByte))
        #expect(!ParticipantPin.isValidField(fourByte + "a"), "257 bytes in 129 UTF-16 units")
        #expect(ParticipantPin.isValidField(String(repeating: "x", count: 256)))
        #expect(!ParticipantPin.isValidField(String(repeating: "x", count: 257)))

        for blank in ["", " ", "\t\n\r", "\u{00A0}", "\u{3000}", "\u{FEFF}", "\u{2028} \u{2029}"] {
            #expect(!ParticipantPin.isValidField(blank), "blank: \(blank.unicodeScalars.map { String($0.value, radix: 16) })")
        }
        // JavaScript's trim keeps NEL (U+0085) and, since Unicode 6.3, the
        // Mongolian vowel separator (U+180E), so the page counts them as text.
        #expect(ParticipantPin.isValidField("\u{0085}"))
        #expect(ParticipantPin.isValidField("\u{180E}"))
        #expect(ParticipantPin.isValidField(" x "))

        #expect(ParticipantPin(id: "claude-code", label: " ", model: "m", executionHost: "this-mac") == nil)
        #expect(ParticipantPin(id: "claude-code", label: "Claude Code", model: overByOne, executionHost: "this-mac") == nil)
        let pin = try #require(ParticipantPin(id: "claude-code", label: "Claude Code", model: twoByte, executionHost: "this-mac"))
        #expect(pin.model == twoByte)
    }

    @Test("A pin reads from exactly its four string keys and writes them back unchanged")
    func pinJSONShape() throws {
        let pin = try #require(ParticipantPin(json: Self.pinJSON()))
        #expect(pin.id == "claude-code")
        #expect(pin.label == "Claude Code")
        #expect(pin.model == "invented-pinned-model")
        #expect(pin.executionHost == "this-mac")
        #expect(pin.jsonValue == Self.pinJSON())
        #expect(ParticipantPin(json: pin.jsonValue) == pin)
        #expect(Set(pin.jsonValue.objectValue.map { Array($0.keys) } ?? []) == ParticipantPin.keys)

        #expect(ParticipantPin(json: Self.pinJSON(["extra": .string("x")])) == nil, "an extra key")
        #expect(ParticipantPin(json: Self.pinJSON(dropping: "executionHost")) == nil, "a missing key")
        #expect(ParticipantPin(json: Self.pinJSON(["model": .number(1)])) == nil, "a non-string")
        #expect(ParticipantPin(json: Self.pinJSON(["label": .string("")])) == nil, "a blank string")
        #expect(ParticipantPin(json: .array([])) == nil)
        #expect(ParticipantPin(json: .string("claude-code")) == nil)
    }

    @Test("Pin equality is byte for byte, as the page's === compares, not Swift's canonical equivalence")
    func pinEqualityIsExact() throws {
        func pin(id: String = "claude-code", label: String = "Caf\u{E9}", model: String = "invented-model",
                 executionHost: String = "this-mac") throws -> ParticipantPin {
            try #require(ParticipantPin(id: id, label: label, model: model, executionHost: executionHost))
        }
        let base = try pin()
        let same = try pin()
        #expect(base == same)
        // Each pair below is one string to Swift's `==` and two to the page.
        let pairs: [(String, String)] = [("Caf\u{E9}", "Cafe\u{301}"), ("K", "\u{212A}"), (";", "\u{37E}"), ("`", "\u{1FEF}")]
        for (written, equivalent) in pairs {
            #expect(written == equivalent, "Swift's String == calls these equal")
            #expect(!ParticipantPin.sameBytes(written, equivalent))
            #expect(ParticipantPin.sameBytes(written, written))
            let original = try pin(id: written, label: written, model: written, executionHost: written)
            let changed = [
                ("id", try pin(id: equivalent, label: written, model: written, executionHost: written)),
                ("label", try pin(id: written, label: equivalent, model: written, executionHost: written)),
                ("model", try pin(id: written, label: written, model: equivalent, executionHost: written)),
                ("executionHost", try pin(id: written, label: written, model: written, executionHost: equivalent))
            ]
            for (field, other) in changed {
                #expect(original != other, "\(field)")
            }
        }
        let decomposed = try pin(label: "Cafe\u{301}")
        #expect(ParticipantHostConfiguration(pin: base) != ParticipantHostConfiguration(pin: decomposed),
                "a configuration compares its pin the same way")
        #expect(ParticipantHostConfiguration(pin: base) == ParticipantHostConfiguration(pin: same))
    }

    @Test("Run-like ids are canonical lowercase v4 as written; a session id is any v1-5 record id with its case kept")
    func idRules() {
        let runId = "71abcdef-0000-4000-8abc-000000000001"
        #expect(ParticipantIds.runLike(.string(runId)) == runId)
        #expect(ParticipantIds.runLike(.string(runId.uppercased())) == nil, "an uppercase v4 is not a run id")
        #expect(ParticipantIds.runLike(.string("6ba7b810-9dad-11d1-80b4-00c04fd430c8")) == nil, "version 1 is not a run id")
        #expect(ParticipantIds.runLike(.string("71abcdef-0000-4000-cabc-000000000001")) == nil, "the variant must be RFC 4122")
        #expect(ParticipantIds.runLike(.string("")) == nil)
        #expect(ParticipantIds.runLike(.number(1)) == nil)
        #expect(ParticipantIds.runLike(nil) == nil, "a missing key")

        let upperV1 = "A1000000-0000-1000-8000-000000000001"
        #expect(ParticipantIds.session(.string(upperV1)) == upperV1, "case is kept, never rewritten")
        #expect(ParticipantIds.session(.string("52abcdef-0000-4000-8abc-000000000001")) == "52abcdef-0000-4000-8abc-000000000001")
        #expect(ParticipantIds.session(.string("52ABCDEF-0000-5000-8ABC-000000000001")) == "52ABCDEF-0000-5000-8ABC-000000000001")
        #expect(ParticipantIds.session(.string("A1000000-0000-6000-8000-000000000001")) == nil, "version 6 is outside 1-5")
        #expect(ParticipantIds.session(.string("00000000-0000-0000-0000-000000000000")) == nil)
        #expect(ParticipantIds.session(.null) == nil)
        #expect(ParticipantIds.session(nil) == nil)
    }

    @Test("The ids a request names must differ ignoring case")
    func distinctIds() {
        let run = "71abcdef-0000-4000-8abc-000000000001"
        let user = "73abcdef-0000-4000-8abc-000000000001"
        let assistant = "74abcdef-0000-4000-8abc-000000000001"
        let session = "52ABCDEF-0000-4000-8ABC-000000000001"
        #expect(ParticipantIds.distinctIgnoringCase([run, session, user, assistant]))
        #expect(!ParticipantIds.distinctIgnoringCase([run, run.uppercased(), user, assistant]), "a session id that is the run id in capitals")
        #expect(!ParticipantIds.distinctIgnoringCase([run, session, user, user]))
        #expect(!ParticipantIds.distinctIgnoringCase([session.lowercased(), session]))
        #expect(ParticipantIds.distinctIgnoringCase([run, session]))
        #expect(ParticipantIds.distinctIgnoringCase([]))
    }

    @Test("Timestamps are exactly YYYY-MM-DDTHH:MM:SS.mmmZ on a real calendar date")
    func timestamps() {
        #expect(WireTimestamp.isValid("2026-10-09T00:00:00.000Z"))
        #expect(WireTimestamp.isValid("2024-02-29T23:59:59.999Z"), "a leap day")
        #expect(WireTimestamp.isValid("1970-01-01T00:00:00.000Z"))
        #expect(!WireTimestamp.isValid("2023-02-30T00:00:00.000Z"), "February 30 is refused, not rolled into March")
        #expect(!WireTimestamp.isValid("2023-02-29T00:00:00.000Z"))
        #expect(!WireTimestamp.isValid("2026-13-01T00:00:00.000Z"))
        #expect(!WireTimestamp.isValid("2026-10-09T24:00:00.000Z"))
        #expect(!WireTimestamp.isValid("2026-10-09T00:60:00.000Z"))
        #expect(!WireTimestamp.isValid("2026-10-00T00:00:00.000Z"), "day 00")
        #expect(!WireTimestamp.isValid("2026-00-09T00:00:00.000Z"), "month 00")
        #expect(!WireTimestamp.isValid("2016-12-31T23:59:60.000Z"), "a leap second, which toISOString never writes")
        #expect(WireTimestamp.isValid("1969-12-31T23:59:59.000Z"), "before 1970 on a whole second")
        // Before 1970 with nonzero milliseconds, as the page reads it (the
        // formatter both copies share floors, as toISOString writes it).
        #expect(WireTimestamp.isValid("1969-12-31T23:59:59.999Z"))
        #expect(WireTimestamp.isValid("1969-07-20T20:17:40.123Z"))
        #expect(!WireTimestamp.isValid("1969-02-29T00:00:00.001Z"), "still a real calendar date before 1970")
        #expect(WireTimestamp.isValid("1899-12-31T23:59:59.999Z"), "and before 1900, as the page's Date reads it")
        #expect(WireTimestamp.isValid("1600-02-29T12:00:00.001Z"))
        #expect(!WireTimestamp.isValid("1900-02-29T00:00:00.000Z"), "1900 was not a leap year")

        let short = "2026-10-09T00:00:00.00Z"
        #expect(short.utf8.count == 23)
        #expect(!WireTimestamp.isValid(short), "two millisecond digits")
        let noZone = "2026-10-09T00:00:00.000"
        #expect(noZone.utf8.count == 23)
        #expect(!WireTimestamp.isValid(noZone))
        #expect(!WireTimestamp.isValid("2026-10-09T00:00:00Z"))
        #expect(!WireTimestamp.isValid("2026-10-09T00:00:00.0000Z"))
        #expect(!WireTimestamp.isValid("2026-10-09 00:00:00.000Z"))
        #expect(!WireTimestamp.isValid("2026-10-09t00:00:00.000z"))
        #expect(!WireTimestamp.isValid("2026-10-09T00:00:00.000+00:00"))
        #expect(!WireTimestamp.isValid("+026-10-09T00:00:00.000Z"))
        #expect(!WireTimestamp.isValid(""))
    }

    @Test("Limits are the contract's numbers")
    func limits() throws {
        #expect(ParticipantLimits.chunkBytes == 16_384)
        #expect(ParticipantLimits.inputTotalBytes == 262_144)
        #expect(ParticipantLimits.preparedRunBytes == 785_408)
        #expect(ParticipantLimits.preparedRunBytes == 768 * 1_024 - 1_024, "768 KiB less a 1 KiB terminal reserve")
        #expect(ParticipantLimits.maxEvents == 64)
        #expect(ParticipantLimits.eventsReplyBytes == 1_048_576)
        #expect(ParticipantLimits.firstTrialInputBound == 4_096)

        let pin = try #require(ParticipantPin(json: Self.pinJSON()))
        #expect(ParticipantHostConfiguration(pin: pin).inputBound == nil, "no bound unless one is given")
        #expect(ParticipantHostConfiguration(pin: pin, inputBound: ParticipantLimits.firstTrialInputBound).inputBound == 4_096)
    }

    @Test("A participant.event push carries exactly type, connectionId, generation and the nested event")
    func participantEventDetail() {
        let event = JSONValue.object([
            "runId": .string("71abcdef-0000-4000-8abc-000000000001"),
            "sessionId": .string("52abcdef-0000-4000-8abc-000000000001"),
            "sequence": .number(2),
            "at": .string("2026-10-09T00:00:01.000Z"),
            "type": .string("text"),
            "text": .string("Invented reply.")
        ])
        let pushed = HostEvent.participantEvent(connectionId: "51000000-0000-4000-8000-000000000001", generation: 2, event: event)
        #expect(pushed.type == "participant.event")
        #expect(pushed.connectionId == "51000000-0000-4000-8000-000000000001")
        #expect(pushed.generation == 2)
        let detail = pushed.jsonDetail.objectValue
        #expect(Set(detail.map { Array($0.keys) } ?? []) == ["type", "connectionId", "generation", "event"])
        #expect(detail?["type"] == .string("participant.event"))
        #expect(detail?["connectionId"] == .string("51000000-0000-4000-8000-000000000001"))
        #expect(detail?["generation"] == .number(2))
        #expect(detail?["event"] == event, "the event is nested whole, its own type untouched")
        #expect(String(decoding: pushed.jsonDetail.canonicalData(), as: UTF8.self).hasPrefix(
            "{\"connectionId\":\"51000000-0000-4000-8000-000000000001\",\"event\":{\"at\":\"2026-10-09T00:00:01.000Z\","))
    }

    /// A tripwire until the page codec for the longer list is bundled: no
    /// app code builds a participant configuration, and the one hand-off to
    /// a host is the coordinator's `makeHost`, passing its own (Codex's S10
    /// carried requirement 1; nothing in the app constructs a coordinator,
    /// which ProcessLauncherTests' gates hold). Switching the lane on is a
    /// reviewed change that edits this test.
    @Test("Nothing in Sources builds a ParticipantHostConfiguration, and only the coordinator's makeHost passes one to a host")
    func nothingSwitchesTheLaneOn() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources")
        let files = try #require(FileManager.default.subpaths(atPath: sources.path)).filter { $0.hasSuffix(".swift") }
        #expect(files.count > 20, "the scan sees the package's sources")
        #expect(files.contains("DeskHost/ParticipantWire.swift") && files.contains("DeskHostWebKit/HostMessageHandler.swift"))
        var lines: [(file: String, line: String)] = []
        for relative in files {
            let text = try String(contentsOf: sources.appendingPathComponent(relative), encoding: .utf8)
            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                let code = line.trimmingCharacters(in: .whitespaces)
                if !code.hasPrefix("//") { lines.append((relative, code)) }
            }
        }
        for construction in ["ParticipantHostConfiguration(", "ParticipantHostConfiguration.init", "Self(pin:"] {
            #expect(lines.filter { $0.line.contains(construction) }.map(\.file) == [], "\(construction)")
        }
        #expect(lines.filter { $0.line.contains("init(pin:") }.map(\.file) == ["DeskHost/ParticipantWire.swift"],
                "the one declaration, and no `.init(pin:` call")
        // Declarations name the type; a hand-off passes a value.
        let declarations = lines.filter { $0.line.contains("participants: ParticipantHostConfiguration?") }
        #expect(declarations.map(\.file) == ["DeskHost/DeskHostProtocol.swift", "DeskHost/DeskHostProtocol.swift"],
                "the host's stored gate and its init parameter")
        #expect(declarations.filter { $0.line.contains("participants: ParticipantHostConfiguration? = nil") }.count == 1,
                "the parameter defaults to off")
        let handOffs = lines.filter { $0.line.contains("participants:") && !$0.line.contains("participants: ParticipantHostConfiguration?") }
        #expect(handOffs.map(\.file) == ["ParticipantCoordinator/ParticipantCoordinator.swift"],
                "one call passes a configuration to a host: the coordinator's makeHost")
        #expect(handOffs.map(\.line) == ["participants: configuration.hostConfiguration)"], "its own configuration, not a new one")
    }
}
