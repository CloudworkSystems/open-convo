import DeskWindowKit
import Foundation
import ParticipantProcess

/// Section 17's owner as the Desk window's controls see it (plan F4): plain
/// values in, plain values out, nothing decided here. INACTIVE: nothing in
/// the app constructs it (F7 composes activation, and the app does not link
/// this module yet). The window's state line updates through the owner's
/// change handler, which only queues a redraw on the main queue, so no owner
/// call (the coordinator's end or claim included) ever waits for the main
/// thread.
@MainActor
public final class PaidUsageDeskControls: DeskPaidUsageControlling {
    private let owner: PaidUsageConfirmationOwner
    public var onChange: (@MainActor () -> Void)?

    public init(owner: PaidUsageConfirmationOwner) {
        self.owner = owner
        owner.setChangeHandler { [weak self] in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.onChange?() } }
        }
    }

    public var state: DeskPaidUsageState {
        Self.state(owner.display)
    }

    public var isConfirming: Bool {
        owner.isConfirming
    }

    public func checkClaude() async -> DeskClaudeCheck {
        Self.check(await owner.checkClaude())
    }

    public func confirm() async -> DeskPaidUsageConfirmResult {
        // Begun here, on the main actor and before any suspension, so a Desk
        // lock or window close the window handles after its own open-Desk
        // check finds the attempt and abandons it (Codex F4-2).
        let attempt = owner.beginConfirmation()
        return Self.result(await owner.confirm(attempt))
    }

    public func abandonPendingConfirmation() {
        owner.abandonPendingConfirmation()
    }

    // MARK: Mapping

    nonisolated static func state(_ display: ParticipantConfirmationDisplay) -> DeskPaidUsageState {
        switch display.state {
        case .unconfirmed:
            return .unconfirmed
        case .active(let confirmedAt, let runsLeft):
            guard let millis = ParticipantTimestamp.parse(confirmedAt) else { return .unconfirmed }
            return .active(confirmedAt: Date(timeIntervalSince1970: Double(millis) / 1000), runsLeft: runsLeft)
        case .ended(let end):
            return .ended(Self.end(end))
        }
    }

    nonisolated static func end(_ end: ParticipantConfirmationEnd) -> DeskPaidUsageEnd {
        switch end {
        case .lock: return .lock
        case .sleep: return .sleep
        case .logout: return .logout
        case .cliChanged: return .cliChanged
        case .loginChanged: return .loginChanged
        case .runLimit: return .runLimit
        case .paidOverflow: return .paidOverflow
        }
    }

    /// A report's first failing local check, or `passed` when the local
    /// checks passed (`host-not-approved`, `overflow-unverified`, or
    /// available).
    nonisolated static func check(_ report: ParticipantAvailabilityReport) -> DeskClaudeCheck {
        switch report.availability.reason {
        case nil, .hostNotApproved?, .overflowUnverified?: return .passed
        case .cliMissing?: return .cliMissing
        case .cliVersionMismatch?: return .cliVersionMismatch
        case .providerOverride?: return .providerOverride
        case .signedOut?: return .signedOut
        case .notSubscription?: return .notSubscription
        case .checkFailed?: return .checkFailed
        }
    }

    nonisolated static func check(_ failure: ClaudeLocalFailure) -> DeskClaudeCheck {
        switch failure {
        case .cliMissing: return .cliMissing
        case .cliVersionMismatch: return .cliVersionMismatch
        case .providerOverride: return .providerOverride
        case .signedOut: return .signedOut
        case .notSubscription: return .notSubscription
        case .checkFailed: return .checkFailed
        }
    }

    nonisolated static func result(_ outcome: PaidUsageConfirmOutcome) -> DeskPaidUsageConfirmResult {
        switch outcome {
        case .confirmed: return .confirmed
        case .alreadyActive: return .alreadyActive
        case .inProgress: return .inProgress
        case .checksFailed(let failure): return .checksFailed(check(failure))
        case .notAuthenticated: return .notAuthenticated
        case .authenticationUnavailable: return .authenticationUnavailable
        case .interrupted: return .interrupted
        }
    }
}
