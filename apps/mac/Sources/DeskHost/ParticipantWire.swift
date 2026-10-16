import Foundation

// Wire vocabulary for one subscription participant
// (`docs/desk-native-participant-contract.md`). It lives here, not in
// ParticipantProcess, because that module depends on this one and the
// commit checks in `DeskHostProtocol` need the same rules.
//
// Nothing here is switched on. A host lists and decodes the participant
// operations only when it is given a `ParticipantHostConfiguration`, and
// nothing outside the tests builds one: the bundled page codec would refuse
// the longer capabilities list.

/// Native's participant identity, fixed per app build and pinned CLI version
/// (section 5). Each string is nonblank and at most 256 UTF-8 bytes, the same
/// rule the page applies before it shows or saves a participant.
public struct ParticipantPin: Equatable, Sendable {
    /// The exact keys of a participant object, on the wire and in a run.
    public static let keys: Set<String> = ["id", "label", "model", "executionHost"]
    public static let maxFieldBytes = 256

    public let id: String
    public let label: String
    public let model: String
    public let executionHost: String

    public init?(id: String, label: String, model: String, executionHost: String) {
        guard [id, label, model, executionHost].allSatisfy(Self.isValidField) else { return nil }
        self.id = id
        self.label = label
        self.model = model
        self.executionHost = executionHost
    }

    /// Exactly `{id, label, model, executionHost}`, each a valid string; nil
    /// for anything else. A caller that owes a precise refusal (extra keys
    /// are `unknown-field`, wrong types `malformed-envelope`) checks `keys`
    /// first.
    public init?(json: JSONValue) {
        guard let fields = json.objectValue, Set(fields.keys) == Self.keys,
              let id = fields["id"]?.stringValue, let label = fields["label"]?.stringValue,
              let model = fields["model"]?.stringValue, let executionHost = fields["executionHost"]?.stringValue else { return nil }
        self.init(id: id, label: label, model: model, executionHost: executionHost)
    }

    public var jsonValue: JSONValue {
        .object([
            "id": .string(id),
            "label": .string(label),
            "model": .string(model),
            "executionHost": .string(executionHost)
        ])
    }

    /// Exact equality, byte for byte, as the page's `===` compares and as
    /// the contract's pin checks require (sections 6, 7 and 15). Swift's own
    /// `String ==` is canonical equivalence: it calls "K" and the Kelvin sign
    /// U+212A equal, so it is never used for a pin.
    public static func == (lhs: ParticipantPin, rhs: ParticipantPin) -> Bool {
        sameBytes(lhs.id, rhs.id) && sameBytes(lhs.label, rhs.label) && sameBytes(lhs.model, rhs.model)
            && sameBytes(lhs.executionHost, rhs.executionHost)
    }

    /// The comparison for any wire string checked against the pin, such as
    /// a request's `participantId` against `id`: the same UTF-8 bytes, not
    /// merely canonically equivalent text.
    public static func sameBytes(_ lhs: String, _ rhs: String) -> Bool {
        lhs.utf8.elementsEqual(rhs.utf8)
    }

    /// Nonblank as the page's `String.prototype.trim` sees it, and at most
    /// `maxFieldBytes` UTF-8 bytes. A Swift string holds no unpaired
    /// surrogate, so its UTF-8 count is the byte count the page measures.
    public static func isValidField(_ value: String) -> Bool {
        value.utf8.count <= maxFieldBytes && !value.unicodeScalars.allSatisfy(isJavaScriptTrimmed)
    }

    /// The scalars `trim` removes: ECMAScript WhiteSpace and LineTerminator.
    /// Swift's `whitespacesAndNewlines` differs (it lacks U+FEFF and adds
    /// U+0085), so the list is spelled out to agree with the page exactly.
    private static func isJavaScriptTrimmed(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }
}

/// What a participant host is given. Its presence is the gate: a host built
/// with one lists the twelve operations and decodes `participant.*`; a host
/// without one is a v1 host, byte for byte. Nothing in the app constructs
/// it until the page codec that understands the longer list is bundled.
///
/// It also carries the host's one request-identity space (`identities`,
/// section 3; Codex Q20, Q22). The workspace lane and the participant lane
/// must be handed the same configuration value: a copy shares the index by
/// reference, while a second configuration built separately has its own
/// index and would be a second, independently accepting authority.
public struct ParticipantHostConfiguration: Equatable, Sendable {
    public let pin: ParticipantPin
    /// The first-trial input bound (section 17) in UTF-8 bytes, or nil for
    /// none. Never above the input total.
    public let inputBound: Int?
    /// The request-identity space both lanes claim through. Shared runtime
    /// state, held by reference.
    public let identities: RequestIdentityIndex
    /// The local route (contract section 20), or nil for a host without one,
    /// which is revision 3 exactly. Held by reference: a preparing commit
    /// and availability each read its catalog afresh.
    public let localRoute: (any LocalCatalogReading)?

    public init(pin: ParticipantPin, inputBound: Int? = nil, identities: RequestIdentityIndex = RequestIdentityIndex(),
                localRoute: (any LocalCatalogReading)? = nil) {
        precondition(inputBound.map { (1...ParticipantLimits.inputTotalBytes).contains($0) } ?? true,
                     "an input bound is positive and within the input total")
        self.pin = pin
        self.inputBound = inputBound
        self.identities = identities
        self.localRoute = localRoute
    }

    /// Equal when they configure the same wire: the pin (byte for byte),
    /// the input bound and the same local route (`===`, or none on both).
    /// `identities` is runtime state, not a setting, and is not compared;
    /// whether two hosts share one identity space is
    /// `lhs.identities === rhs.identities`.
    public static func == (lhs: ParticipantHostConfiguration, rhs: ParticipantHostConfiguration) -> Bool {
        lhs.pin == rhs.pin && lhs.inputBound == rhs.inputBound && lhs.localRoute === rhs.localRoute
    }
}

// MARK: The local route's catalog (contract section 20.2)

/// Where a participant host reads the local route's catalog. LocalModelRoute's
/// `OllamaClient` is the real one; this module cannot import it, so the seam
/// lives here. Every call is a fresh read: nothing here caches an answer.
public protocol LocalCatalogReading: AnyObject, Sendable {
    func localCatalog() async -> LocalCatalogAnswer
}

/// One chat model as availability lists it: exactly `{id, label, model,
/// executionHost}` (`ollama-local`, the name, name@digest, `this-mac`), and
/// whether it runs on this Mac.
public struct LocalCatalogEntry: Equatable, Sendable {
    public let participant: ParticipantPin
    /// False for a cloud or remote model: listed, never available
    /// (`model-not-local`).
    public let available: Bool

    public init(participant: ParticipantPin, available: Bool) {
        self.participant = participant
        self.available = available
    }
}

/// The local route as one catalog read found it (section 20.2).
public enum LocalCatalogAnswer: Equatable, Sendable {
    /// Entries in availability's order (sorted by name, at most 256).
    case ready([LocalCatalogEntry])
    /// `ollama-not-running`, `catalog-unreadable`, `catalog-too-large` or
    /// `host-not-loopback`. An unavailable route lists no entries.
    case unavailable(reason: String)

    public static let routeReasons: Set<String> = [
        "ollama-not-running", "catalog-unreadable", "catalog-too-large", "host-not-loopback"
    ]

    /// The ready route's available entry equal to `participant` (all four
    /// fields, byte for byte), if any: section 6 step 5 for a local run.
    public func availableEntry(_ participant: ParticipantPin) -> LocalCatalogEntry? {
        guard case .ready(let entries) = self else { return nil }
        return entries.first { $0.available && $0.participant == participant }
    }

    /// This answer held to section 20.2 whatever produced it, as the page
    /// codec holds a reply: a ready list has at most 256 entries, each
    /// `ollama-local` on `this-mac`, its label the name before `@` and a
    /// 64-hex digest after it, sorted by name in code-point order with no
    /// name twice; anything else is `catalog-unreadable` (more than 256 is
    /// `catalog-too-large`). A name ending `:cloud` is never available. An
    /// unknown route reason is `catalog-unreadable`.
    public var checked: LocalCatalogAnswer {
        switch self {
        case .unavailable(let reason):
            return Self.routeReasons.contains(reason) ? self : .unavailable(reason: "catalog-unreadable")
        case .ready(let entries):
            guard entries.count <= 256 else { return .unavailable(reason: "catalog-too-large") }
            var previous: String?
            var kept: [LocalCatalogEntry] = []
            for entry in entries {
                let pin = entry.participant
                guard ParticipantPin.sameBytes(pin.id, LocalRouteWire.participantId),
                      ParticipantPin.sameBytes(pin.executionHost, LocalRouteWire.executionHost),
                      Self.isModel(pin.model, named: pin.label) else { return .unavailable(reason: "catalog-unreadable") }
                if let previous {
                    guard previous.unicodeScalars.lexicographicallyPrecedes(pin.label.unicodeScalars, by: { $0.value < $1.value }) else {
                        return .unavailable(reason: "catalog-unreadable")
                    }
                }
                previous = pin.label
                kept.append(LocalCatalogEntry(participant: pin, available: entry.available && !pin.label.hasSuffix(":cloud")))
            }
            return .ready(kept)
        }
    }

    /// Availability's fields with a local route (section 20.2): `claude`
    /// (the Claude Code entry, as section 5 builds it) first, then one
    /// entry per listed model, `reason` null exactly when available and
    /// `model-not-local` otherwise, and the one `routes` item. An
    /// unavailable route lists no local entry. Call it on a `checked`
    /// answer.
    public func availabilityFields(claude: [String: JSONValue]) -> [String: JSONValue] {
        var listed: [JSONValue] = [.object(claude)]
        let route: JSONValue
        switch self {
        case .ready(let entries):
            for entry in entries {
                var fields = entry.participant.jsonValue.objectValue ?? [:]
                fields["available"] = .bool(entry.available)
                fields["reason"] = entry.available ? .null : .string(LocalRouteWire.modelNotLocal)
                listed.append(.object(fields))
            }
            route = .object(["route": .string(LocalRouteWire.participantId), "state": .string("ready"), "reason": .null])
        case .unavailable(let reason):
            route = .object(["route": .string(LocalRouteWire.participantId), "state": .string("unavailable"),
                             "reason": .string(reason)])
        }
        return ["participants": .array(listed), "routes": .array([route])]
    }

    /// `model` is exactly `name`, `@` and 64 lowercase hex digits.
    static func isModel(_ model: String, named name: String) -> Bool {
        let bytes = Array(model.utf8)
        let nameBytes = Array(name.utf8)
        guard bytes.count == nameBytes.count + 65, bytes.starts(with: nameBytes), bytes[nameBytes.count] == 0x40 else { return false }
        return bytes[(nameBytes.count + 1)...].allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }
}

/// Section 20's fixed names.
public enum LocalRouteWire {
    /// The local route's participant id and route name.
    public static let participantId = "ollama-local"
    public static let executionHost = "this-mac"
    /// The reason on a listed model that does not run on this Mac.
    public static let modelNotLocal = "model-not-local"
    /// At most this many earlier runs as context (section 20.3).
    public static let maxContextRuns = 256
}

/// Participant id rules (section 3). `runId`, `userMessageId` and
/// `assistantMessageId` are native-style ids; `sessionId` is a DeskState
/// record id. A nil answer is `invalid-identity` to the caller.
public enum ParticipantIds {
    /// A canonical lowercase UUIDv4 string, returned as written. Missing,
    /// non-string, uppercase or another version is nil.
    public static func runLike(_ value: JSONValue?) -> String? {
        guard let string = value?.stringValue, UUID.canonicalV4(string) != nil else { return nil }
        return string
    }

    /// An RFC 4122 version 1-5 id in either case, returned exactly as
    /// written: the host never rewrites a record id, and compares it exactly.
    public static func session(_ value: JSONValue?) -> String? {
        value?.recordIdValue
    }

    /// The ids a request names must differ even ignoring case, so a
    /// lowercase run id cannot alias an uppercase session id.
    public static func distinctIgnoringCase(_ ids: [String]) -> Bool {
        Set(ids.map { $0.lowercased() }).count == ids.count
    }
}

/// Participant limits (sections 6, 9 and 15), in UTF-8 or canonical JSON
/// bytes. Refusal thresholds, never silent truncation.
public enum ParticipantLimits {
    /// One input chunk, and one event's text.
    public static let chunkBytes = 16_384
    /// All input chunks together; also input plus output.
    public static let inputTotalBytes = 262_144
    /// A prepared or open run's canonical JSON: 768 KiB less a 1 KiB
    /// terminal reserve.
    public static let preparedRunBytes = 785_408
    /// Most events one `participant.events` reply returns.
    public static let maxEvents = 64
    /// A `participant.events` reply's canonical JSON.
    public static let eventsReplyBytes = 1_048_576
    /// The first-trial input bound a section 17 host passes as
    /// `ParticipantHostConfiguration.inputBound`. Tests use it; a host
    /// without that confirmation built passes none.
    public static let firstTrialInputBound = 4_096
    /// Section 14's quit bound for participant work (Codex Q33): one
    /// overall maximum, from the start of a window close or quit, for every
    /// participant obligation together (starting, live, stopping,
    /// cleanup-pending, terminal or cleanup writes pending), with or
    /// without a Desk window. It replaces "12 s plus one 5 s write"; there
    /// is no separate bound per run or per phase to add to it.
    public static let shutdownMillis: UInt64 = 17_000
}

/// The wire's one timestamp form, `YYYY-MM-DDTHH:MM:SS.mmmZ` in UTC, as the
/// page's `toISOString` writes it. The same strict check as
/// `ParticipantTimestamp.parse` in ParticipantProcess, which this module
/// cannot import, so a time native accepts here that module can read:
/// exactly 24 bytes, digits where digits go, and a real calendar date
/// (February 30 is refused, not rolled into March). Every year 0000-9999 is
/// read as the page's `Date` reads it, before 1970 with nonzero milliseconds
/// included: the shared code is a proleptic Gregorian calculation that
/// floors, not `timegm` (which refuses years before 1900). A change to
/// either copy is made in both together; a test in ParticipantProcessTests
/// holds the two, and the page's answers, to the same results.
public enum WireTimestamp {
    public static func isValid(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard bytes.count == 24, bytes[4] == 0x2D, bytes[7] == 0x2D, bytes[10] == 0x54,
              bytes[13] == 0x3A, bytes[16] == 0x3A, bytes[19] == 0x2E, bytes[23] == 0x5A else { return false }
        func number(_ range: Range<Int>) -> Int? {
            var value = 0
            for index in range {
                let byte = bytes[index]
                guard byte >= 0x30, byte <= 0x39 else { return nil }
                value = value * 10 + Int(byte - 0x30)
            }
            return value
        }
        guard let year = number(0..<4), let month = number(5..<7), let day = number(8..<10),
              let hour = number(11..<13), let minute = number(14..<16), let second = number(17..<19),
              let millis = number(20..<23) else { return false }
        let total = (days(year: year, month: month, day: day) * 86_400
                     + Int64(hour * 3_600 + minute * 60 + second)) * 1_000 + Int64(millis)
        // Writing the result back and comparing refuses every field that
        // rolled over: February 30, hour 24, second 60 and the like.
        guard format(millis: total) == text else { return false }
        return true
    }

    /// `ParticipantTimestamp.format`, byte for byte.
    private static func format(millis: Int64) -> String {
        // Floor division, as `toISOString` writes it: a time before 1970 with
        // nonzero milliseconds is the second before it plus a positive
        // fraction (-1 is 23:59:59.999 on 1969-12-31), never a negative one.
        var whole = millis / 1000
        var fraction = Int(millis % 1000)
        if fraction < 0 {
            whole -= 1
            fraction += 1000
        }
        var days = whole / 86_400
        var secondOfDay = Int(whole % 86_400)
        if secondOfDay < 0 {
            days -= 1
            secondOfDay += 86_400
        }
        let date = civil(days: days)
        return String(format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                      date.year, date.month, date.day,
                      secondOfDay / 3_600, secondOfDay / 60 % 60, secondOfDay % 60, fraction)
    }

    /// Days since 1970-01-01 for a proleptic Gregorian date, as the page's
    /// `Date` counts them for every year, not only those `timegm` reads (it
    /// refuses years before 1900). Out-of-range fields roll over; the caller
    /// writes the result back and compares, which refuses them.
    private static func days(year: Int, month: Int, day: Int) -> Int64 {
        let y = Int64(month <= 2 ? year - 1 : year)
        let era = (y >= 0 ? y : y - 399) / 400
        let yearOfEra = y - era * 400
        let monthFromMarch = Int64((month + 9) % 12)
        let dayOfYear = (153 * monthFromMarch + 2) / 5 + Int64(day) - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }

    /// The proleptic Gregorian date `days` after 1970-01-01.
    private static func civil(days: Int64) -> (year: Int, month: Int, day: Int) {
        let z = days + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let dayOfEra = z - era * 146_097
        let yearOfEra = (dayOfEra - dayOfEra / 1_460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let monthFromMarch = (5 * dayOfYear + 2) / 153
        let day = dayOfYear - (153 * monthFromMarch + 2) / 5 + 1
        let month = monthFromMarch < 10 ? monthFromMarch + 3 : monthFromMarch - 9
        return (Int(yearOfEra + era * 400 + (month <= 2 ? 1 : 0)), Int(month), Int(day))
    }
}
