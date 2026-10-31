import DeskHost
import DeskWindowKit
import Foundation
import ParticipantProcess

/// Section 21.4's approval as the Desk window's control sees it (the Claude
/// Code adapter's PR 4a): the open Desk's protected store behind plain
/// values. INACTIVE: nothing in the app constructs it before PR 4b. Only the
/// window's statement sheet reaches `approve()` and `withdraw()`; nothing on
/// the page's wire does.
@MainActor
public final class HostApprovalDeskControls: DeskHostApprovalControlling {
    private let store: () -> ProofStore?
    private let now: () -> Date
    public var onChange: (@MainActor () -> Void)?

    /// `store` answers the open Desk's store, or nil while it has none (the
    /// session's `store`, opened on unlock).
    public init(store: @escaping () -> ProofStore?, now: @escaping () -> Date = Date.init) {
        self.store = store
        self.now = now
    }

    public var state: DeskHostApprovalState {
        guard let store = store() else { return .unreadable }
        do {
            return Self.state(try store.hostApproval(HostApproval.anthropic))
        } catch {
            return .unreadable
        }
    }

    public func approve() -> DeskHostApprovalResult {
        change(.approved) { try $0.approveHost(HostApproval.anthropic, at: now()) }
    }

    public func withdraw() -> DeskHostApprovalResult {
        change(.withdrawn) { try $0.revokeHost(HostApproval.anthropic) }
    }

    private func change(_ done: DeskHostApprovalResult, _ write: (ProofStore) throws -> Void) -> DeskHostApprovalResult {
        guard let store = store() else { return .failed }
        let result: DeskHostApprovalResult
        do {
            try write(store)
            result = done
        } catch {
            result = Self.result(error)
        }
        if result != .failed { onChange?() }
        return result
    }

    // MARK: Mapping

    /// A saved approval with an unparsable time reads as unreadable, never
    /// approved (the store's decoder already refuses one).
    nonisolated static func state(_ approval: HostApproval?) -> DeskHostApprovalState {
        guard let approval else { return .notApproved }
        guard let millis = ParticipantTimestamp.parse(approval.approvedAt) else { return .unreadable }
        return .approved(at: Date(timeIntervalSince1970: Double(millis) / 1000))
    }

    /// `replacedUnsynced` is visible and in effect but not yet known durable;
    /// every other error changed nothing.
    nonisolated static func result(_ error: Error) -> DeskHostApprovalResult {
        if case ProofStoreError.replacedUnsynced? = error as? ProofStoreError { return .unsynced }
        return .failed
    }
}
