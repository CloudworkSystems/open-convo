import DeskHost

// The availability report (contract section 5): an availability answer plus
// the display-only `confirmation` a host with section 17 built adds. Nothing
// here can say "available": only this module can make that answer (the
// definition in `ParticipantAvailability.swift`, used by section 17's owner
// in `PaidUsageConfirmation.swift` alone), and a report only ever keeps it or
// lowers it. Nothing here reads any input either; a source scan test holds
// both.

/// Why a section 17 confirmation ended (section 5's `endedBy`).
public enum ParticipantConfirmationEnd: String, Sendable, CaseIterable {
    /// Screen lock or session resign.
    case lock
    /// Sleep, or the screens sleeping.
    case sleep
    /// Logout or power-off.
    case logout
    /// The pinned CLI's version or file identity changed.
    case cliChanged = "cli-changed"
    /// The login or account changed.
    case loginChanged = "login-changed"
    /// The fifth run started.
    case runLimit = "run-limit"
    case paidOverflow = "paid-overflow"
}

/// The optional, display-only `confirmation` object (section 5). Native
/// sources it; it is never an input, never part of the pin, the saved choice
/// or any identity, and carries no account identifier. Every value is valid:
/// `active` is made only through `active(confirmedAt:runsLeft:)`, which
/// refuses a time that is not `.mmmZ` or a count outside 1-5.
public struct ParticipantConfirmationDisplay: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        /// No confirmation in this launch.
        case unconfirmed
        case active(confirmedAt: String, runsLeft: Int)
        case ended(ParticipantConfirmationEnd)
    }

    public let state: State

    private init(state: State) {
        self.state = state
    }

    public static let unconfirmed = ParticipantConfirmationDisplay(state: .unconfirmed)

    /// Nil unless `confirmedAt` is a real `YYYY-MM-DDTHH:MM:SS.mmmZ` time and
    /// `runsLeft` is 1-5.
    public static func active(confirmedAt: String, runsLeft: Int) -> ParticipantConfirmationDisplay? {
        guard ParticipantTimestamp.parse(confirmedAt) != nil, (1...5).contains(runsLeft) else { return nil }
        return ParticipantConfirmationDisplay(state: .active(confirmedAt: confirmedAt, runsLeft: runsLeft))
    }

    public static func ended(_ endedBy: ParticipantConfirmationEnd) -> ParticipantConfirmationDisplay {
        ParticipantConfirmationDisplay(state: .ended(endedBy))
    }

    public var isActive: Bool {
        if case .active = state { return true }
        return false
    }

    /// Exactly `{state}`, `{state, confirmedAt, runsLeft}` or `{state, endedBy}`.
    public var jsonValue: JSONValue {
        switch state {
        case .unconfirmed:
            return .object(["state": .string("unconfirmed")])
        case .active(let confirmedAt, let runsLeft):
            return .object(["state": .string("active"), "confirmedAt": .string(confirmedAt),
                            "runsLeft": .number(Double(runsLeft))])
        case .ended(let endedBy):
            return .object(["state": .string("ended"), "endedBy": .string(endedBy.rawValue)])
        }
    }

    /// Strict, as the page reads it: exactly the keys for its state, and the
    /// same rules as above. Anything else is nil.
    ///
    /// Not public: native sources the confirmation and never reads one in
    /// (section 5), so no other module can turn a page message or a file into
    /// a display. The test target reaches it with `@testable import`.
    init?(jsonValue: JSONValue) {
        guard let fields = jsonValue.objectValue, let state = fields["state"]?.stringValue else { return nil }
        switch state {
        case "unconfirmed":
            guard Set(fields.keys) == ["state"] else { return nil }
            self = .unconfirmed
        case "active":
            guard Set(fields.keys) == ["state", "confirmedAt", "runsLeft"],
                  let confirmedAt = fields["confirmedAt"]?.stringValue, let runsLeft = fields["runsLeft"]?.safeIntegerValue,
                  let value = Self.active(confirmedAt: confirmedAt, runsLeft: runsLeft) else { return nil }
            self = value
        case "ended":
            guard Set(fields.keys) == ["state", "endedBy"], let name = fields["endedBy"]?.stringValue,
                  let endedBy = ParticipantConfirmationEnd(rawValue: name) else { return nil }
            self = .ended(endedBy)
        default:
            return nil
        }
    }
}

/// One availability answer with its optional confirmation (section 5). A
/// present confirmation that is not `active` never goes with "available":
/// such an answer is lowered to `overflow-unverified`. A present `active`
/// never raises an unavailable answer, and an earlier failing reason (such as
/// `provider-override`) is kept; the confirmation is still reported as it is.
///
/// `confirmation` nil means the key is omitted: a host without section 17
/// built, the older reporting path and the frozen vectors that predate it.
/// A host that builds section 17 must source the state itself and always
/// report it; omitting it is not a way to an available answer, which only
/// this module's own check can give.
public struct ParticipantAvailabilityReport: Equatable, Sendable {
    public let availability: ParticipantAvailability
    public let confirmation: ParticipantConfirmationDisplay?

    public init(availability: ParticipantAvailability, confirmation: ParticipantConfirmationDisplay?) {
        if availability.available, let confirmation, !confirmation.isActive {
            self.availability = .unavailable(.overflowUnverified)
        } else {
            self.availability = availability
        }
        self.confirmation = confirmation
    }

    /// The entry's fields after the pin: `available`, `reason` (null exactly
    /// when available) and, only when present, `confirmation`.
    public var jsonFields: [String: JSONValue] {
        var fields: [String: JSONValue] = [
            "available": .bool(availability.available),
            "reason": availability.reason.map { .string($0.rawValue) } ?? .null
        ]
        if let confirmation { fields["confirmation"] = confirmation.jsonValue }
        return fields
    }
}

/// Where a participant availability report comes from. It is injected, like
/// `AvailabilityChecking`.
public protocol AvailabilityReporting: Sendable {
    /// The answer for `participant.availability`; may reuse a recent check.
    func report() async -> ParticipantAvailabilityReport
    /// The answer for a start's recheck (section 7 step 13): never a reused
    /// check. Every reporter implements it, with no default, so a wrapper can
    /// never quietly answer a start with a reused check (Codex F3-9).
    func recheck() async -> ParticipantAvailabilityReport
}

/// A report from an availability check alone, for a host without section 17
/// built: the check's answer, and no confirmation (the key is omitted).
/// Over `ShippingAvailability` it is always `overflow-unverified`. A source
/// scan test holds that `Sources` builds it over `ShippingAvailability` only
/// and that nothing in this module uses the internal `.available`, so a
/// section 17 builder must change that test, and meet the rule above, before
/// an omitted confirmation can go with an available answer.
public struct CheckedAvailability: AvailabilityReporting {
    private let checker: any AvailabilityChecking

    public init(checker: any AvailabilityChecking) {
        self.checker = checker
    }

    public func report() async -> ParticipantAvailabilityReport {
        ParticipantAvailabilityReport(availability: await checker.check(), confirmation: nil)
    }

    public func recheck() async -> ParticipantAvailabilityReport {
        ParticipantAvailabilityReport(availability: await checker.recheck(), confirmation: nil)
    }
}
