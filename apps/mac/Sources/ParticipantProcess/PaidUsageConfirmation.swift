import DeskHost
import Foundation

// Section 17's confirmation owner (plan F4; Codex F0 answers 9, 12 and 13,
// and the promptness duty of Codex's S8 R1 re-review). INACTIVE: nothing in
// the app constructs `PaidUsageConfirmationOwner`; only the test target and
// the test-only availability probe do (F7 composes activation). It is the
// only way the participant can become available: it answers "available"
// only when section 5's local checks (F3) pass, a confirmation made in this
// launch is active, and the checks' snapshot matches the one confirmed.
//
// The confirmation lives in this object's memory only. Nothing here writes a
// file, a default, the Keychain or a log, and nothing here reads one: no
// environment, argument, default, file or page message can make or restore
// a confirmation. It becomes active only inside the successful completion
// of this owner's own `OwnerAuthentication` request, taken with a fresh
// snapshot before and after the request; no other code can construct one.

/// The confirmation (section 17's ledger), in memory only, for this launch.
/// Constructed only by `PaidUsageConfirmationOwner.confirm()`, in this file.
struct PaidUsageConfirmation {
    let confirmedAtMillis: Int64
    let cliVersion: String
    let cliFileIdentity: ClaudeCLIFileIdentity
    let loginKind: ClaudeLoginKind
    /// The opaque account and organization comparator (F3): no account field.
    let accountIdentity: ClaudeAccountComparator
    /// Runs claimed (section 7's commit to spawn), 0-5.
    var runsStarted: Int

    fileprivate init(confirmedAtMillis: Int64, snapshot: ClaudeLocalSnapshot) {
        self.confirmedAtMillis = confirmedAtMillis
        cliVersion = snapshot.cliVersion
        cliFileIdentity = snapshot.fileIdentity
        loginKind = snapshot.loginKind
        accountIdentity = snapshot.account
        runsStarted = 0
    }

    /// Why this check ends the confirmation (section 17: a CLI version, file
    /// identity, login or account change), or nil when it does not. A check
    /// that shows the pinned file gone or another version is `cli-changed`;
    /// signed out, or no longer a claude.ai plan, is `login-changed`. A
    /// `provider-override` or `check-failed` shows no change of what was
    /// confirmed: it wins as the reason while it lasts, and any later pass
    /// must still match this snapshot exactly.
    func end(for result: ClaudeLocalCheckResult) -> ParticipantConfirmationEnd? {
        Self.change(from: (cliVersion, cliFileIdentity, loginKind, accountIdentity), to: result)
    }

    /// What `result` shows changed from these facts: `cli-changed`,
    /// `login-changed`, or nil (the same facts, or a `provider-override` or
    /// `check-failed`, which shows no change). The same rule ends an active
    /// confirmation and abandons a pending attempt (Codex F34-R4).
    static func change(from facts: (cliVersion: String, fileIdentity: ClaudeCLIFileIdentity, loginKind: ClaudeLoginKind,
                                    account: ClaudeAccountComparator),
                       to result: ClaudeLocalCheckResult) -> ParticipantConfirmationEnd? {
        switch result {
        case .passed(let snapshot):
            if snapshot.cliVersion != facts.cliVersion || snapshot.fileIdentity != facts.fileIdentity { return .cliChanged }
            if snapshot.loginKind != facts.loginKind || snapshot.account != facts.account { return .loginChanged }
            return nil
        case .failed(.cliMissing), .failed(.cliVersionMismatch):
            return .cliChanged
        case .failed(.signedOut), .failed(.notSubscription):
            return .loginChanged
        case .failed(.providerOverride), .failed(.checkFailed):
            return nil
        }
    }

    /// `change(from:to:)` from a snapshot's facts.
    static func change(from snapshot: ClaudeLocalSnapshot, to result: ClaudeLocalCheckResult) -> ParticipantConfirmationEnd? {
        change(from: (snapshot.cliVersion, snapshot.fileIdentity, snapshot.loginKind, snapshot.account), to: result)
    }

    /// The facts a confirmation keeps, as two snapshots compare them.
    static func sameFacts(_ one: ClaudeLocalSnapshot, _ other: ClaudeLocalSnapshot) -> Bool {
        one.cliVersion == other.cliVersion && one.fileIdentity == other.fileIdentity && one.loginKind == other.loginKind
            && one.account == other.account
    }
}

/// How one confirmation attempt ended (`PaidUsageConfirmationOwner.confirm`).
public enum PaidUsageConfirmOutcome: Equatable, Sendable {
    /// Active now, with five runs.
    case confirmed
    /// A confirmation is active already: nothing was asked.
    case alreadyActive
    /// Another attempt is under way: nothing was asked.
    case inProgress
    /// The local checks failed, before or after the request: nothing confirmed.
    case checksFailed(ClaudeLocalFailure)
    /// The request was cancelled or failed.
    case notAuthenticated
    /// This Mac could not run the request.
    case authenticationUnavailable
    /// While the attempt was pending, a lock, sleep, logout, power-off or
    /// paid-overflow end, a window close or quit, or a change of the pinned
    /// file, its version, the login or the account (seen by its own second
    /// check, or by any availability check while it was pending, even if
    /// the facts then came back): any result was discarded and nothing was
    /// confirmed.
    case interrupted
}

/// Section 17's owner: the one confirmation of this launch, the availability
/// report built on it, the run claim and every end.
///
/// - `report()` and `recheck()` (section 5): the local checks' answer (F3;
///   `recheck` never reuses one) with the confirmation's display. Available
///   only when the checks pass, Anthropic is approved (contract section
///   21.4: `host-not-approved` otherwise, `check-failed` when the approval
///   cannot be read), the confirmation is active and the check's snapshot
///   matches it; any check that shows a changed file, version,
///   login or account ends it first (`cli-changed`, `login-changed`). An
///   earlier failing check wins as the reason; the confirmation is reported
///   as it is.
/// - `claimRun()` (section 7, Codex F0 answer 12): counts one run of an
///   active confirmation; the fifth ends it with `run-limit`.
/// - `endForPaidOverflow()`, `end(_:)` and `abandonPendingConfirmation()`:
///   the ends. Each, and the claim, takes one lock and returns at once: no
///   wait on the main thread, no user interaction, no I/O (Codex S8 R1).
///   An ended confirmation is never revived: a new one needs the request
///   again. It keeps its first reason, except that `paid-overflow` replaces
///   any other, so the display says paid usage may have been used.
/// - `beginConfirmation()` then `confirm(_:)` (or `confirm()`): the native
///   flow's one way to a confirmation.
public final class PaidUsageConfirmationOwner: AvailabilityReporting, @unchecked Sendable {
    /// Runs per confirmation (section 17): a trial limit, not a spending cap.
    public static let runLimit = 5

    private enum State {
        case unconfirmed
        case active(PaidUsageConfirmation)
        case ended(ParticipantConfirmationEnd)
    }

    fileprivate enum Answer {
        case outcome(OwnerAuthenticationOutcome)
        case abandoned
    }

    /// One confirmation attempt under way: the wait for its request's
    /// answer, and the request, which an end abandons.
    fileprivate final class Attempt {
        var waiter: CheckedContinuation<Answer, Never>?
        var request: (any OwnerAuthenticationRequest)?
        /// Its answer was given: an outcome, or abandoned. A later answer is
        /// discarded.
        var settled = false
        /// From its first check's start: what availability checks saw while
        /// its first snapshot was not known yet (distinct results only).
        var watching = false
        var seen: [ClaudeLocalCheckResult] = []
        /// Its first check's snapshot: every check seen from then on is
        /// compared with it at once (Codex F34-R4).
        var first: ClaudeLocalSnapshot?
    }

    /// What an end took from the attempt it abandoned, to finish outside
    /// the lock.
    private struct Abandoned {
        var waiter: CheckedContinuation<Answer, Never>?
        var request: (any OwnerAuthenticationRequest)?
        var changed: Bool
    }

    /// Where an abandoned request is cancelled: off the caller, so an end
    /// returns at once.
    private static let cancelQueue = DispatchQueue(label: "paid-usage-confirmation-cancel")

    private let lock = NSLock()
    private let checks: any ClaudeLocalChecking
    private let approval: any HostApprovalReading
    private let authentication: any OwnerAuthentication
    private let clock: any ParticipantClock
    private var state = State.unconfirmed
    private var attempt: Attempt?
    private var changeHandler: (@Sendable () -> Void)?

    /// Starts `unconfirmed`, as every launch does. Nothing is read. The one
    /// public way to make the owner: over section 5's real local checks and
    /// the one `OwnerAuthentication` conformer, so no module can give it
    /// other checks or another authenticator (Codex F34-6).
    ///
    /// Section 21.4's approval is read from `store`, the Desk's protected
    /// store; with no store (`nil`) nothing is approved. It takes the store
    /// itself, never a reader, so no module can hand the owner a reader that
    /// always approves (independent review of PR 3d).
    public convenience init(checks: ClaudeLocalChecks, store: ProofStore?) {
        let approval: any HostApprovalReading = store ?? NoHostApproval()
        self.init(checks: checks, approval: approval, authentication: LocalAuthenticationOwnerCheck())
    }

    /// Tests only (through `@testable`): fakes for the checks, the approval,
    /// the authenticator and the clock.
    init(checks: any ClaudeLocalChecking, approval: any HostApprovalReading, authentication: any OwnerAuthentication,
         clock: any ParticipantClock = SystemParticipantClock()) {
        self.checks = checks
        self.approval = approval
        self.authentication = authentication
        self.clock = clock
    }

    // MARK: What it shows

    /// Called, outside the lock and on whatever thread made the change, after
    /// the confirmation or an attempt changes. It must return at once (the
    /// native controls only queue a redraw).
    public func setChangeHandler(_ handler: (@Sendable () -> Void)?) {
        lock.lock(); defer { lock.unlock() }
        changeHandler = handler
    }

    /// Section 5's display-only `confirmation`, as of now.
    public var display: ParticipantConfirmationDisplay {
        lock.lock(); defer { lock.unlock() }
        return displayLocked()
    }

    /// An attempt is under way (between `confirm()` and its outcome).
    public var isConfirming: Bool {
        lock.lock(); defer { lock.unlock() }
        return attempt != nil
    }

    // MARK: AvailabilityReporting (section 5)

    /// May reuse a recent local check (section 5: up to 30 s, while the
    /// pinned file is unchanged).
    public func report() async -> ParticipantAvailabilityReport {
        assess(await checks.evaluate())
    }

    /// A start's recheck (section 7 step 13): a fresh local check, never a
    /// reused one.
    public func recheck() async -> ParticipantAvailabilityReport {
        assess(await checks.evaluateFresh())
    }

    /// The native "Check Claude": section 5's local checks only, fresh, with
    /// the same ends any check applies. It needs no Desk, store or Keychain.
    public func checkClaude() async -> ParticipantAvailabilityReport {
        assess(await checks.evaluateFresh())
    }

    private func assess(_ result: ClaudeLocalCheckResult) -> ParticipantAvailabilityReport {
        // Section 21.4: read before taking this owner's lock (the store has
        // its own), and only once every local check has passed, so an
        // earlier failing check wins.
        var approved: Bool?
        if case .passed = result { approved = approval.isApproved(host: HostApproval.anthropic) }
        lock.lock()
        var ended: Abandoned?
        if case .active(let confirmation) = state, let end = confirmation.end(for: result) {
            ended = endLocked(end)
        } else if let current = attempt, current.watching {
            // A pending attempt: a change seen now discards its answer, even
            // if the facts come back before it completes (Codex F34-R4). A
            // result `report()` reused counts too, even one from a check made
            // before the attempt began (a result does not say when its check
            // ran): that only refuses, and a retry is not hit again (this
            // attempt's fresh check has replaced the cached result).
            if let first = current.first {
                if PaidUsageConfirmation.change(from: first, to: result) != nil { ended = abandonLocked() }
            } else if !current.seen.contains(result) {
                current.seen.append(result)
            }
        }
        var availability = result.availability
        if case .passed = result {
            switch approved {
            case false?:
                // Just before `overflow-unverified` in section 5's order; an
                // active confirmation is still reported beside it.
                availability = .unavailable(.hostNotApproved)
            case nil:
                availability = .unavailable(.checkFailed)
            case true?:
                if case .active = state {
                    // The one available answer outside
                    // `ParticipantAvailability`: the checks pass, Anthropic
                    // is approved, and the checks match an active
                    // confirmation.
                    availability = ParticipantAvailability.available
                }
            }
        }
        let display = displayLocked()
        lock.unlock()
        if let ended { finish(ended) }
        return ParticipantAvailabilityReport(availability: availability, confirmation: display)
    }

    // MARK: The run claim (section 7; Codex F0 answer 12)

    /// One run of the active confirmation, claimed by the coordinator once,
    /// synchronously, immediately before it dispatches the run: true when
    /// counted. The fifth claim ends the confirmation (`run-limit`), and that
    /// fifth run may finish. With no active confirmation nothing is counted
    /// and the run must not be dispatched. A counted run is never refunded.
    public func claimRun() -> Bool {
        lock.lock()
        guard case .active(var confirmation) = state else {
            lock.unlock()
            return false
        }
        confirmation.runsStarted += 1
        state = confirmation.runsStarted >= Self.runLimit ? .ended(.runLimit) : .active(confirmation)
        let handler = changeHandler
        lock.unlock()
        handler?()
        return true
    }

    // MARK: Ends

    /// Paid overflow may have been in use (section 17's backstop): the
    /// confirmation ends with `paid-overflow`. The coordinator calls this on
    /// its own thread or a wake-up's; it returns at once.
    public func endForPaidOverflow() {
        end(.paidOverflow)
    }

    /// Ends an active confirmation with `reason` (an ended one keeps its
    /// first reason, unless this is `paid-overflow`, which replaces it; with
    /// none in this launch there is nothing to end), and abandons any attempt
    /// under way: its result, even a late success, is discarded. Returns at
    /// once.
    public func end(_ reason: ParticipantConfirmationEnd) {
        lock.lock()
        let ended = endLocked(reason)
        lock.unlock()
        finish(ended)
    }

    /// A window close, quit or Desk lock: abandons any attempt under way (its
    /// result is discarded) and ends nothing else. Returns at once.
    public func abandonPendingConfirmation() {
        lock.lock()
        let abandoned = abandonLocked()
        lock.unlock()
        finish(abandoned)
    }

    private func endLocked(_ reason: ParticipantConfirmationEnd) -> Abandoned {
        var abandoned = abandonLocked()
        switch state {
        case .active:
            state = .ended(reason)
            abandoned.changed = true
        case .ended(let earlier) where reason == .paidOverflow && earlier != .paidOverflow:
            // Paid usage may have been used (the fifth run, after its claim
            // ended it `run-limit`, say): that outranks how it ended, so the
            // display says so (Codex F4-1). Still never revived.
            state = .ended(.paidOverflow)
            abandoned.changed = true
        case .ended, .unconfirmed:
            break
        }
        return abandoned
    }

    private func abandonLocked() -> Abandoned {
        guard let current = attempt else { return Abandoned(waiter: nil, request: nil, changed: false) }
        attempt = nil
        current.settled = true
        let abandoned = Abandoned(waiter: current.waiter, request: current.request, changed: true)
        current.waiter = nil
        current.request = nil
        return abandoned
    }

    private func finish(_ abandoned: Abandoned) {
        abandoned.waiter?.resume(returning: .abandoned)
        if let request = abandoned.request {
            Self.cancelQueue.async { request.cancel() }
        }
        if abandoned.changed { notifyChange() }
    }

    private func notifyChange() {
        lock.lock()
        let handler = changeHandler
        lock.unlock()
        handler?()
    }

    // MARK: Confirming (section 17)

    /// The native flow, after the owner has read the statement sheet: a fresh
    /// local check, then one LocalAuthentication request, then a fresh check
    /// again. Only a successful request whose attempt was not abandoned
    /// meanwhile, with both checks passing and naming the same pinned file,
    /// version, login and account, makes the confirmation: active, five
    /// runs. Refused while one is active or an attempt is under way.
    public func confirm() async -> PaidUsageConfirmOutcome {
        await confirm(beginConfirmation())
    }

    /// The attempt's start, synchronous: from its return, an end, a Desk
    /// lock, a window close or a quit abandons it (Codex F4-2: the window
    /// begins it on the main actor right after its own open-Desk check, with
    /// no suspension between). It must be followed by `confirm(_:)`, which
    /// runs it; until then the owner counts it as under way.
    public func beginConfirmation() -> PaidUsageConfirmationAttempt {
        PaidUsageConfirmationAttempt(beginning: begin())
    }

    /// Runs an attempt `beginConfirmation()` began (see `confirm()`). An
    /// attempt abandoned meanwhile is `interrupted` and asks nothing.
    public func confirm(_ attempt: PaidUsageConfirmationAttempt) async -> PaidUsageConfirmOutcome {
        let current: Attempt
        switch attempt.beginning {
        case .refused(let outcome): return outcome
        case .began(let begun): current = begun
        }
        // Abandoned between its start and now: nothing is checked or asked.
        guard watch(current) else { return .interrupted }

        // Nothing is asked while a local check fails.
        let before = await checks.evaluateFresh()
        guard case .passed(let first) = before else { return conclude(current, before.failureOutcome) }
        // A change any check saw since this check began discards the attempt.
        guard settle(current, first: first) else { return .interrupted }

        switch await authenticate(current) {
        case .abandoned: return conclude(current, .interrupted)
        case .outcome(.notAuthenticated): return conclude(current, .notAuthenticated)
        case .outcome(.unavailable): return conclude(current, .authenticationUnavailable)
        case .outcome(.authenticated): break
        }

        // A fresh snapshot for the confirmation itself.
        return complete(current, first: first, after: await checks.evaluateFresh())
    }

    fileprivate enum Beginning {
        case refused(PaidUsageConfirmOutcome)
        case began(Attempt)
    }

    /// Whether the attempt is still the current one; if so, availability
    /// checks are watched for it from now on.
    private func watch(_ current: Attempt) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard attempt === current else { return false }
        current.watching = true
        return true
    }

    /// Records the attempt's first snapshot. False (and the attempt
    /// abandoned) when it is no longer current, or when a check seen since
    /// its first check began showed a change from that snapshot.
    private func settle(_ current: Attempt, first: ClaudeLocalSnapshot) -> Bool {
        lock.lock()
        guard attempt === current else {
            lock.unlock()
            return false
        }
        let changed = current.seen.contains { PaidUsageConfirmation.change(from: first, to: $0) != nil }
        current.seen = []
        current.first = first
        let abandoned = changed ? abandonLocked() : nil
        lock.unlock()
        if let abandoned { finish(abandoned) }
        return !changed
    }

    /// The attempt's start: refused while one is active or another attempt
    /// is under way.
    private func begin() -> Beginning {
        lock.lock()
        if attempt != nil {
            lock.unlock()
            return .refused(.inProgress)
        }
        if case .active = state {
            lock.unlock()
            return .refused(.alreadyActive)
        }
        let current = Attempt()
        attempt = current
        lock.unlock()
        notifyChange()
        return .began(current)
    }

    /// After a successful request: the confirmation, made here and nowhere
    /// else, only if the attempt was not abandoned meanwhile and the fresh
    /// check passes naming the same pinned file, version, login and account
    /// as the check before the request.
    private func complete(_ current: Attempt, first: ClaudeLocalSnapshot, after: ClaudeLocalCheckResult) -> PaidUsageConfirmOutcome {
        lock.lock()
        guard attempt === current else {
            lock.unlock()
            return .interrupted
        }
        attempt = nil
        guard case .passed(let second) = after else {
            lock.unlock()
            notifyChange()
            return after.failureOutcome
        }
        guard PaidUsageConfirmation.sameFacts(first, second) else {
            // The pinned file, version, login or account changed while the
            // request was pending: the result is discarded.
            lock.unlock()
            notifyChange()
            return .interrupted
        }
        state = .active(PaidUsageConfirmation(confirmedAtMillis: clock.wallMillis(), snapshot: second))
        lock.unlock()
        notifyChange()
        return .confirmed
    }

    /// Ends an attempt that is still the current one with `outcome`; one
    /// abandoned meanwhile is `interrupted`.
    private func conclude(_ current: Attempt, _ outcome: PaidUsageConfirmOutcome) -> PaidUsageConfirmOutcome {
        lock.lock()
        guard attempt === current else {
            lock.unlock()
            return .interrupted
        }
        attempt = nil
        lock.unlock()
        notifyChange()
        return outcome
    }

    /// The attempt's one LocalAuthentication request: its outcome, or
    /// `abandoned` if an end came first (a later answer is then discarded).
    private func authenticate(_ current: Attempt) async -> Answer {
        await withCheckedContinuation { (continuation: CheckedContinuation<Answer, Never>) in
            ask(current, continuation)
        }
    }

    private func ask(_ current: Attempt, _ continuation: CheckedContinuation<Answer, Never>) {
        lock.lock()
        guard attempt === current, !current.settled else {
            lock.unlock()
            continuation.resume(returning: .abandoned)
            return
        }
        current.waiter = continuation
        lock.unlock()
        let request = authentication.requestOwnerAuthentication { outcome in self.answered(current, outcome) }
        lock.lock()
        let settled = current.settled
        if !settled { current.request = request }
        lock.unlock()
        // Abandoned while the request was being made (or answered at once):
        // it is ended now, which is harmless if it already was.
        if settled { Self.cancelQueue.async { request.cancel() } }
    }

    private func answered(_ current: Attempt, _ outcome: OwnerAuthenticationOutcome) {
        lock.lock()
        guard !current.settled else {
            lock.unlock()
            return
        }
        current.settled = true
        let waiter = current.waiter
        current.waiter = nil
        current.request = nil
        lock.unlock()
        waiter?.resume(returning: .outcome(outcome))
    }

    // MARK: Display

    private func displayLocked() -> ParticipantConfirmationDisplay {
        switch state {
        case .unconfirmed:
            return .unconfirmed
        case .active(let confirmation):
            // Never fails for a real clock; if it did, the display is not
            // active, which lowers any available answer (section 5).
            return .active(confirmedAt: ParticipantTimestamp.format(millis: confirmation.confirmedAtMillis),
                           runsLeft: Self.runLimit - confirmation.runsStarted) ?? .unconfirmed
        case .ended(let reason):
            return .ended(reason)
        }
    }
}

/// One confirmation attempt `beginConfirmation()` began, for `confirm(_:)`:
/// opaque, and meaningful only to the owner that made it.
public struct PaidUsageConfirmationAttempt: @unchecked Sendable {
    fileprivate let beginning: PaidUsageConfirmationOwner.Beginning
}

private extension ClaudeLocalCheckResult {
    var failureOutcome: PaidUsageConfirmOutcome {
        switch self {
        case .failed(let failure): return .checksFailed(failure)
        case .passed: return .interrupted
        }
    }
}
