/// Availability (contract section 5).

/// Why the participant is unavailable; the first failing check.
public enum ParticipantUnavailableReason: String, Sendable, CaseIterable {
    case cliMissing = "cli-missing"
    case cliVersionMismatch = "cli-version-mismatch"
    case providerOverride = "provider-override"
    case signedOut = "signed-out"
    case notSubscription = "not-subscription"
    /// Contract section 21.4: every local check passed, but the owner has
    /// not approved sending to Anthropic. Display only.
    case hostNotApproved = "host-not-approved"
    case overflowUnverified = "overflow-unverified"
    case checkFailed = "check-failed"
}

/// One availability answer: `reason` is nil exactly when available.
public struct ParticipantAvailability: Equatable, Sendable {
    public let available: Bool
    public let reason: ParticipantUnavailableReason?

    private init(available: Bool, reason: ParticipantUnavailableReason?) {
        self.available = available
        self.reason = reason
    }

    public static func unavailable(_ reason: ParticipantUnavailableReason) -> ParticipantAvailability {
        ParticipantAvailability(available: false, reason: reason)
    }

    /// Not public: no module outside this one can answer "available". The
    /// test target reaches it with `@testable import` for its fake. In this
    /// module only section 17's owner uses it (`PaidUsageConfirmationOwner`,
    /// plan F4, inactive), when the local checks pass and match an active
    /// confirmation; a source scan holds that it is the one use.
    static let available = ParticipantAvailability(available: true, reason: nil)
}

/// Where availability comes from. It is injected; the implementations
/// outside the test target are `ShippingAvailability` and section 5's local
/// checks (F3, which never answer available on their own), and only this
/// module (and, through `@testable import`, the test target) can make an
/// answer that says available.
public protocol AvailabilityChecking: Sendable {
    /// May reuse a recent answer (section 5: up to 30 s).
    func check() async -> ParticipantAvailability
    /// A start's recheck (section 7 step 13): never a reused answer. Every
    /// checker implements it, with no default, so a wrapper can never
    /// quietly answer a start with a reused check (Codex F3-9).
    func recheck() async -> ParticipantAvailability
}

/// The shipping answer until an approved way to confirm paid overflow is off
/// exists (contract sections 5 and 17): always `overflow-unverified`. It reads
/// no environment, defaults, argument, file or page value, resolves no binary
/// and runs nothing, so none of those can change it.
public struct ShippingAvailability: AvailabilityChecking {
    public init() {}

    public func check() async -> ParticipantAvailability {
        .unavailable(.overflowUnverified)
    }

    public func recheck() async -> ParticipantAvailability {
        .unavailable(.overflowUnverified)
    }
}
