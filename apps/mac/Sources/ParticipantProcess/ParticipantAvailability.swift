/// Availability (contract section 5).

/// Why the participant is unavailable; the first failing check.
public enum ParticipantUnavailableReason: String, Sendable, CaseIterable {
    case cliMissing = "cli-missing"
    case cliVersionMismatch = "cli-version-mismatch"
    case providerOverride = "provider-override"
    case signedOut = "signed-out"
    case notSubscription = "not-subscription"
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
    /// test target reaches it with `@testable import` for its fake; nothing
    /// in this module uses it until an approved overflow check exists
    /// (contract section 17).
    static let available = ParticipantAvailability(available: true, reason: nil)
}

/// Where availability comes from. It is injected; the only implementation
/// outside the test target is `ShippingAvailability`, and only this module
/// (and, through `@testable import`, the test target) can make an answer
/// that says available.
public protocol AvailabilityChecking: Sendable {
    func check() async -> ParticipantAvailability
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
}
