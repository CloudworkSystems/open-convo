import Foundation
import LocalAuthentication

/// What owner verification answered.
public enum DeskUnlockVerdict: Equatable, Sendable {
    case verified
    /// Cancelled, failed or refused: the Desk stays locked.
    case refused
    /// This Mac cannot verify the owner right now: the Desk stays locked,
    /// with this plain message. There is no way around it.
    case unavailable(String)
}

/// Confirms the Mac's owner before the Desk unlocks.
@MainActor
public protocol DeskUnlockVerifier: AnyObject {
    func verify(reason: String) async -> DeskUnlockVerdict
}

/// The Mac's own owner check: password, Touch ID or Apple Watch, through
/// LocalAuthentication (`.deviceOwnerAuthentication`). Nothing about the
/// answer is logged or kept. If the check is unavailable the Desk stays
/// locked; there is no bypass.
@MainActor
public final class MacOwnerVerifier: DeskUnlockVerifier {
    public static let reason = "Unlock the invented Desk"
    public static let unavailableMessage = "This Mac can't confirm it's you right now, so the Desk stays locked."

    public init() {}

    public func verify(reason: String) async -> DeskUnlockVerdict {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return .unavailable(Self.unavailableMessage)
        }
        return await withCheckedContinuation { continuation in
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
                continuation.resume(returning: success ? .verified : .refused)
            }
        }
    }
}

/// For tests: answers from a list, in order (refused once it runs out),
/// and records each reason it was asked with.
@MainActor
public final class StubUnlockVerifier: DeskUnlockVerifier {
    public var verdicts: [DeskUnlockVerdict]
    public private(set) var reasons: [String] = []

    public init(_ verdicts: DeskUnlockVerdict...) {
        self.verdicts = verdicts
    }

    public var askedCount: Int { reasons.count }

    public func verify(reason: String) async -> DeskUnlockVerdict {
        reasons.append(reason)
        return verdicts.isEmpty ? .refused : verdicts.removeFirst()
    }
}
