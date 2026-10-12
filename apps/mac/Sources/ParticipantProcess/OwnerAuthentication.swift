import Foundation
import LocalAuthentication

// Section 17's device-owner authentication (plan F4; Codex F0 answer 13).
// INACTIVE: nothing in the app constructs `LocalAuthenticationOwnerCheck` or
// asks it anything; only section 17's owner (`PaidUsageConfirmationOwner`)
// would, and nothing in the app constructs that either (F7 composes
// activation). Tests never run a real LocalAuthentication evaluation: they
// give the owner a fake from the test target, and a source scan holds that
// this file's class is the one `OwnerAuthentication` conformer in Sources.
// All of it is internal (Codex F34-6): the owner's one public initializer
// uses this conformer, so no other module can give it another.
//
// What the owner sees is macOS's own LocalAuthentication request, not an app
// window: it accepts the Mac login password, or an Apple Watch approval
// where macOS and the Mac's policy support it. True Convo has no password
// field and never sees, keeps or logs what was entered; it learns only
// whether the request succeeded.

/// How one LocalAuthentication request ended.
enum OwnerAuthenticationOutcome: Equatable, Sendable {
    /// macOS confirmed the device owner.
    case authenticated
    /// Cancelled, failed, or ended by the app.
    case notAuthenticated
    /// This Mac cannot run the request now (for example, no login password is
    /// set). Nothing is confirmed, and there is no way around it.
    case unavailable
}

/// One request under way, which its owner may abandon.
protocol OwnerAuthenticationRequest: Sendable {
    /// Asks macOS to end the request. It never waits; a result that still
    /// arrives afterwards is the owner's to discard.
    func cancel()
}

/// Section 17's device-owner authentication: one system LocalAuthentication
/// request per call, with a fixed reason. Exactly one conformer exists in
/// Sources (`LocalAuthenticationOwnerCheck`); the fake lives in the test
/// target only.
protocol OwnerAuthentication: Sendable {
    /// Starts one request. `completion` is called once, on any thread
    /// (synchronously, before this returns, when the request cannot start).
    func requestOwnerAuthentication(_ completion: @escaping @Sendable (OwnerAuthenticationOutcome) -> Void)
        -> any OwnerAuthenticationRequest
}

/// The one conformer: LocalAuthentication's `.deviceOwnerAuthentication`
/// policy with a fixed reason, a fresh `LAContext` per request. Nothing about
/// the answer is logged or kept.
final class LocalAuthenticationOwnerCheck: OwnerAuthentication {
    /// Shown by macOS in its own request ("True Convo Test is trying to …").
    static let reason = "confirm that you checked paid usage is off in claude.ai Settings > Usage"

    init() {}

    func requestOwnerAuthentication(_ completion: @escaping @Sendable (OwnerAuthenticationOutcome) -> Void)
        -> any OwnerAuthenticationRequest {
        let request = LocalAuthenticationRequest()
        var error: NSError?
        guard request.context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            completion(.unavailable)
            return request
        }
        request.context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: Self.reason) { success, _ in
            completion(success ? .authenticated : .notAuthenticated)
        }
        return request
    }
}

/// One `LAContext`, ended by `invalidate()`.
private final class LocalAuthenticationRequest: OwnerAuthenticationRequest, @unchecked Sendable {
    let context = LAContext()

    func cancel() {
        context.invalidate()
    }
}
