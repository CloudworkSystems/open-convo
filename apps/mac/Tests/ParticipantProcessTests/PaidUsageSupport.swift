import Darwin
import Foundation
@testable import ParticipantCoordinator
@testable import ParticipantProcess

// Fakes for section 17's owner (plan F4), test target only: scripted local
// checks (F3's protocol) with invented snapshots, and an `OwnerAuthentication`
// that never calls LocalAuthentication. Invented data only.

/// Invented passing snapshots. Comparators made with the same invented key
/// match exactly when the invented account and organization do.
enum InventedSnapshot {
    static let key = [UInt8](repeating: 7, count: 32)

    static func identity(inode: UInt64 = 4_242, size: Int64 = 1_000, changed: Int = 1_700_000_000) -> ClaudeCLIFileIdentity {
        var info = stat()
        info.st_dev = 1
        info.st_ino = inode
        info.st_size = off_t(size)
        info.st_mtimespec = timespec(tv_sec: 1_700_000_000, tv_nsec: 0)
        info.st_ctimespec = timespec(tv_sec: changed, tv_nsec: 0)
        return ClaudeCLIFileIdentity(info)
    }

    static func make(inode: UInt64 = 4_242, changed: Int = 1_700_000_000, version: String = "2.1.283",
                     plan: ClaudeSubscriptionPlan = .max, account: String = "invented-person@invented.invalid",
                     organization: String? = "invented-organization") -> ClaudeLocalSnapshot {
        ClaudeLocalSnapshot(cliVersion: version, fileIdentity: identity(inode: inode, changed: changed),
                            loginKind: .subscription(plan),
                            account: ClaudeAccountComparator(email: account, organization: organization, key: key))
    }

    static let passing = ClaudeLocalCheckResult.passed(make())
}

/// Section 5's local checks as a fake: one result for `evaluate`, and for
/// `evaluateFresh` the queued results in order, then that same result. A
/// fresh check can be held at a gate.
final class ScriptedLocalChecks: ClaudeLocalChecking, @unchecked Sendable {
    private let lock = NSLock()
    private var current: ClaudeLocalCheckResult
    private var queued: [ClaudeLocalCheckResult] = []
    private var evaluateCount = 0
    private var freshCount = 0
    private var gate: AsyncGate?

    init(_ result: ClaudeLocalCheckResult = InventedSnapshot.passing) {
        current = result
    }

    func set(_ result: ClaudeLocalCheckResult) {
        lock.lock(); defer { lock.unlock() }
        current = result
        queued = []
    }

    /// The next fresh checks answer these, in order.
    func queue(_ results: ClaudeLocalCheckResult...) {
        lock.lock(); defer { lock.unlock() }
        queued += results
    }

    /// The next fresh checks wait at a gate until it opens.
    func holdFresh() -> AsyncGate {
        lock.lock(); defer { lock.unlock() }
        let gate = AsyncGate()
        self.gate = gate
        return gate
    }

    func evaluate() async -> ClaudeLocalCheckResult {
        reused()
    }

    private func reused() -> ClaudeLocalCheckResult {
        lock.lock(); defer { lock.unlock() }
        evaluateCount += 1
        return current
    }

    func evaluateFresh() async -> ClaudeLocalCheckResult {
        if let gate = takeGate() { await gate.pass() }
        return nextFresh()
    }

    private func takeGate() -> AsyncGate? {
        lock.lock(); defer { lock.unlock() }
        return gate
    }

    func releaseHold() {
        lock.lock()
        let gate = self.gate
        self.gate = nil
        lock.unlock()
        gate?.open()
    }

    private func nextFresh() -> ClaudeLocalCheckResult {
        lock.lock(); defer { lock.unlock() }
        freshCount += 1
        return queued.isEmpty ? current : queued.removeFirst()
    }

    var counts: (evaluate: Int, fresh: Int) {
        lock.lock(); defer { lock.unlock() }
        return (evaluateCount, freshCount)
    }
}

/// `OwnerAuthentication` for tests: never LocalAuthentication. Answers each
/// request as told (on another thread, or at once), or holds it until the
/// test answers it (a request that may never complete), counting requests
/// and cancels.
final class FakeOwnerAuthentication: OwnerAuthentication, @unchecked Sendable {
    enum Mode {
        /// Answered on another thread, soon.
        case answer(OwnerAuthenticationOutcome)
        /// Answered before `requestOwnerAuthentication` returns.
        case immediately(OwnerAuthenticationOutcome)
        /// Held until `complete(_:)`, which may never come.
        case hold
    }

    final class Request: OwnerAuthenticationRequest, @unchecked Sendable {
        private let owner: FakeOwnerAuthentication
        init(_ owner: FakeOwnerAuthentication) { self.owner = owner }
        func cancel() { owner.cancelled() }
    }

    private let lock = NSLock()
    private var mode: Mode
    private var held: [@Sendable (OwnerAuthenticationOutcome) -> Void] = []
    private var requestCount = 0
    private var cancelCount = 0

    init(_ mode: Mode = .answer(.authenticated)) {
        self.mode = mode
    }

    func set(_ mode: Mode) {
        lock.lock(); defer { lock.unlock() }
        self.mode = mode
    }

    func requestOwnerAuthentication(_ completion: @escaping @Sendable (OwnerAuthenticationOutcome) -> Void)
        -> any OwnerAuthenticationRequest {
        lock.lock()
        requestCount += 1
        let mode = self.mode
        if case .hold = mode { held.append(completion) }
        lock.unlock()
        switch mode {
        case .answer(let outcome): DispatchQueue.global().async { completion(outcome) }
        case .immediately(let outcome): completion(outcome)
        case .hold: break
        }
        return Request(self)
    }

    /// Answers every held request now, as a late result would arrive.
    func complete(_ outcome: OwnerAuthenticationOutcome) {
        lock.lock()
        let pending = held
        held = []
        lock.unlock()
        for completion in pending { completion(outcome) }
    }

    fileprivate func cancelled() {
        lock.lock(); defer { lock.unlock() }
        cancelCount += 1
    }

    var requests: Int {
        lock.lock(); defer { lock.unlock() }
        return requestCount
    }

    var cancels: Int {
        lock.lock(); defer { lock.unlock() }
        return cancelCount
    }

    var holding: Int {
        lock.lock(); defer { lock.unlock() }
        return held.count
    }
}

/// A fixed wall clock for confirmation times.
struct InventedWallClock: ParticipantClock {
    var wall: Int64 = 1_791_000_000_123

    func monotonicMillis() -> UInt64 { 1_000 }
    func wallMillis() -> Int64 { wall }
}

/// The owner with fakes, active when `confirmed`.
func inventedOwner(checks: ScriptedLocalChecks = ScriptedLocalChecks(), authentication: FakeOwnerAuthentication = FakeOwnerAuthentication(),
                   confirmed: Bool = false) async -> PaidUsageConfirmationOwner {
    let owner = PaidUsageConfirmationOwner(checks: checks, authentication: authentication, clock: InventedWallClock())
    if confirmed {
        let outcome = await owner.confirm()
        precondition(outcome == .confirmed, "the invented confirmation: \(outcome)")
    }
    return owner
}

/// The section 17 owner seen by the coordinator through a counting proxy:
/// every call is forwarded, and the ends and claims counted.
final class CountingOwnerProxy: ParticipantConfirmationOwning, AvailabilityReporting, @unchecked Sendable {
    let owner: PaidUsageConfirmationOwner
    private let lock = NSLock()
    private var endCount = 0
    private var claimCount = 0
    /// Called inside each claim, before it is forwarded (a placement probe).
    var onClaim: (@Sendable () -> Void)?

    init(_ owner: PaidUsageConfirmationOwner) {
        self.owner = owner
    }

    func endForPaidOverflow() {
        lock.lock(); endCount += 1; lock.unlock()
        owner.endForPaidOverflow()
    }

    func claimRun() -> Bool {
        lock.lock(); claimCount += 1; lock.unlock()
        onClaim?()
        return owner.claimRun()
    }

    func report() async -> ParticipantAvailabilityReport { await owner.report() }
    func recheck() async -> ParticipantAvailabilityReport { await owner.recheck() }

    var ends: Int {
        lock.lock(); defer { lock.unlock() }
        return endCount
    }

    var claims: Int {
        lock.lock(); defer { lock.unlock() }
        return claimCount
    }
}

/// Section 5's display as `{state}` keys and values, for comparisons.
func displayState(_ display: ParticipantConfirmationDisplay) -> String {
    switch display.state {
    case .unconfirmed: return "unconfirmed"
    case .active(_, let runsLeft): return "active \(runsLeft)"
    case .ended(let end): return "ended \(end.rawValue)"
    }
}
