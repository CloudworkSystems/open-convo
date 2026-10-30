import CryptoKit
import Darwin
import Foundation

// Section 5's real local checks of the pinned Claude Code (plan F3; Codex F0
// answers 9, 10 and 11). INACTIVE: nothing outside the test target and the
// test-only availability probe constructs `ClaudeLocalChecks`, and nothing in
// Sources calls `ClaudeCheckRoots.forCurrentUser` (a unit test does, to
// compare it with the user database; it reads no file), so the app reads no
// Claude file and runs no Claude program. These checks never answer "available" on their
// own: a pass is still `overflow-unverified`, which only section 17's
// confirmation owner (F4) may lift. They make no model request, billing read
// or provider probe, never execute a configured key or policy helper, and
// never read the CLI's own Keychain item. They run `auth status` only with
// its network blocked by macOS (`ClaudeAuthStatusGate`, the owner's D1
// decision), so server-managed settings cannot arrive during it and arm a
// helper (Codex F34-D1).

/// Where the checks look. Every path root is injected: tests give invented
/// trees; production would give `forCurrentUser`, which nothing calls yet.
public struct ClaudeCheckRoots: Sendable, Equatable {
    /// The user's home from the user database (`getpwuid_r`), never `$HOME`
    /// (Codex F0 answer 9). The pinned binary, `~/.claude.json` and the
    /// config folder `~/.claude` are under it.
    public let home: String
    /// The login name from the user database: the per-user managed
    /// preferences folder is named after it.
    public let userName: String
    /// The uid every folder on the pinned binary's path, and the binary
    /// itself, must belong to.
    public let owner: uid_t
    /// `/Library/Application Support/ClaudeCode` in production.
    public let managedSettingsFolder: String
    /// `/Library/Managed Preferences` in production.
    public let managedPreferencesFolder: String
    /// An app-owned folder, this user's and writable by no one else, under
    /// which each probe gets a fresh, empty 0700 working folder. A git root
    /// above it, other than the home, fails the checks (`local-settings`).
    public let probeParent: URL
    /// The outermost folder the walk from `probeParent` up checks for a git
    /// root: `/` in production; tests give their temporary folder, so they
    /// touch nothing outside it. `probeParent` must be inside it.
    public let gitSearchTop: String

    public init(home: String, userName: String, owner: uid_t, managedSettingsFolder: String,
                managedPreferencesFolder: String, probeParent: URL, gitSearchTop: String) {
        self.home = home
        self.userName = userName
        self.owner = owner
        self.managedSettingsFolder = managedSettingsFolder
        self.managedPreferencesFolder = managedPreferencesFolder
        self.probeParent = probeParent
        self.gitSearchTop = gitSearchTop
    }

    public static let systemManagedSettingsFolder = "/Library/Application Support/ClaudeCode"
    public static let systemManagedPreferencesFolder = "/Library/Managed Preferences"

    /// The folders between the home and the pinned version file, in order.
    static let pinnedBinaryFolders = [".local", "share", "claude", "versions"]

    /// The real roots for this user: home and name from the user database,
    /// this process's uid, the system's managed folders, the git walk up to
    /// `/`. Never called in Sources in this slice (F7 composes activation);
    /// nil if the user database has no usable entry.
    public static func forCurrentUser(probeParent: URL) -> ClaudeCheckRoots? {
        var entry = passwd()
        var result: UnsafeMutablePointer<passwd>?
        var buffer = [CChar](repeating: 0, count: 16_384)
        guard getpwuid_r(getuid(), &entry, &buffer, buffer.count, &result) == 0, result != nil,
              let directory = entry.pw_dir, let name = entry.pw_name else { return nil }
        let home = String(cString: directory)
        let userName = String(cString: name)
        guard home.hasPrefix("/"), home.count > 1, !userName.isEmpty, !userName.contains("/") else { return nil }
        return ClaudeCheckRoots(home: home, userName: userName, owner: getuid(),
                                managedSettingsFolder: systemManagedSettingsFolder,
                                managedPreferencesFolder: systemManagedPreferencesFolder, probeParent: probeParent,
                                gitSearchTop: "/")
    }

    /// The exact pinned version file (answer 9): never the launcher link.
    var binaryPath: String {
        ([home] + Self.pinnedBinaryFolders + [ParticipantCommandLine.pinnedCLIVersion]).joined(separator: "/")
    }

    /// The CLI's config folder. `CLAUDE_CONFIG_DIR` never reaches the CLI
    /// (section 11's environment rule drops it), so this is the one it uses.
    var configFolder: String { home + "/.claude" }

    /// The file or folder a settings source is read from.
    func path(_ source: ClaudeCheckSource) -> String? {
        switch source {
        case .managedFile: return managedSettingsFolder + "/managed-settings.json"
        case .managedDropIn: return managedSettingsFolder + "/managed-settings.d"
        case .userPreferences: return managedPreferencesFolder + "/" + userName + "/com.anthropic.claudecode.plist"
        case .devicePreferences: return managedPreferencesFolder + "/com.anthropic.claudecode.plist"
        case .remoteSettings: return configFolder + "/remote-settings.json"
        case .policyLimits: return configFolder + "/policy-limits.json"
        case .globalConfig: return home + "/.claude.json"
        case .legacyGlobalConfig: return configFolder + "/.config.json"
        case .userSettings: return configFolder + "/settings.json"
        case .environment, .authStatus, .localSettings: return nil
        }
    }
}

/// Whether and how section 5's step 4 runs `auth status` (Codex F34-D1).
/// Read only (bytes, never run), Claude Code 2.1.283's `auth status` starts
/// a server-managed settings fetch for an eligible account (a Team or
/// Enterprise plan, an unknown plan, a profile login or a stored key),
/// applies a new payload in memory for that non-interactive run without
/// writing it to `remote-settings.json`, and can then run a policy helper the
/// payload names, before any inspection can see it. Nothing in that build
/// skips the fetch for an eligible account, and which accounts are eligible
/// depends on the login's plan, which only `auth status` (or the CLI's
/// Keychain item, never read) tells. So no check before it can rule that
/// out.
///
/// The owner's D1 decision (October 29, 2026, option 1): the probe runs with
/// every network operation denied by macOS (`ClaudeNetworkBlock`), so the
/// fetch cannot reach Anthropic and no new payload arrives, and only Pro and
/// Max plans pass (a Team or Enterprise login is `not-subscription`). A
/// cached payload is already on disk, where step 3 reads it first.
package enum ClaudeAuthStatusGate: Sendable, Equatable {
    /// Production: `auth status` runs under `ClaudeNetworkBlock`. If the
    /// block cannot be applied (its tool missing or not the system's), step
    /// 4 is `check-failed` and `auth status` never runs.
    case runWithNetworkBlocked(ClaudeNetworkBlock)
    /// The test target and the test-only probe only, over invented trees
    /// and the fake CLI: step 4 runs `auth status` with nothing around it.
    case runForTests

    /// What production uses.
    package static let production = ClaudeAuthStatusGate.runWithNetworkBlocked(.system)
}

/// Section 5's bounds. `contract` is the only production value.
public struct ClaudeCheckLimits: Sendable, Equatable {
    /// Each probe process (`--version`, `auth status`).
    public var perProcessMillis: UInt64 = 5_000
    /// One whole check, file reads included: a check still blocked at this
    /// bound is abandoned and answers `check-failed` (Codex F3-3).
    public var totalMillis: UInt64 = 12_000
    /// How long a result may be reused (never by a start: section 7 step 13).
    public var reuseMillis: UInt64 = 30_000
    /// A probe's stdout; more is `check-failed`.
    public var outputBytes = 65_536
    /// Each settings file, drop-in or managed preferences file.
    public var settingsBytes = 1_048_576
    /// `~/.claude.json` (it also holds the CLI's own per-project records).
    public var globalConfigBytes = 33_554_432

    public init() {}

    public static let contract = ClaudeCheckLimits()
}

/// Why the local checks fail: section 5's reasons in its order, except
/// `host-not-approved` and `overflow-unverified`, which only section 17's
/// owner decides (F4; contract section 21.4).
public enum ClaudeLocalFailure: String, Sendable, CaseIterable {
    case cliMissing = "cli-missing"
    case cliVersionMismatch = "cli-version-mismatch"
    case providerOverride = "provider-override"
    case signedOut = "signed-out"
    case notSubscription = "not-subscription"
    case checkFailed = "check-failed"

    public var reason: ParticipantUnavailableReason {
        switch self {
        case .cliMissing: return .cliMissing
        case .cliVersionMismatch: return .cliVersionMismatch
        case .providerOverride: return .providerOverride
        case .signedOut: return .signedOut
        case .notSubscription: return .notSubscription
        case .checkFailed: return .checkFailed
        }
    }
}

/// The pinned version file's identity (Codex F0 answer 9), kept in memory to
/// compare at confirmation and at every check and start. Metadata only: it
/// is not an immutable-execution guarantee.
public struct ClaudeCLIFileIdentity: Equatable, Sendable {
    public let device: UInt64
    public let inode: UInt64
    public let size: Int64
    public let modifiedSeconds: Int
    public let modifiedNanoseconds: Int
    public let changedSeconds: Int
    public let changedNanoseconds: Int

    init(_ info: Darwin.stat) {
        device = UInt64(UInt32(bitPattern: info.st_dev))
        inode = UInt64(info.st_ino)
        size = Int64(info.st_size)
        modifiedSeconds = info.st_mtimespec.tv_sec
        modifiedNanoseconds = info.st_mtimespec.tv_nsec
        changedSeconds = info.st_ctimespec.tv_sec
        changedNanoseconds = info.st_ctimespec.tv_nsec
    }
}

/// The claude.ai plan `auth status` reports.
public enum ClaudeSubscriptionPlan: String, Sendable, CaseIterable {
    case pro, max, team, enterprise

    /// The plans the checks pass (the owner's D1 decision): the others can
    /// carry server-managed settings.
    static let accepted: Set<ClaudeSubscriptionPlan> = [.pro, .max]
}

/// How the CLI is signed in, when the checks pass: always a claude.ai plan
/// login, no API key, first-party provider.
public enum ClaudeLoginKind: Equatable, Sendable {
    case subscription(ClaudeSubscriptionPlan)
}

/// An opaque stand-in for the signed-in account and organization: an HMAC of
/// both under a random key made when the checks are made, kept in memory
/// only. Two comparators are equal only when both came from the same
/// `ClaudeLocalChecks` and name the same account and organization. It holds
/// no account field and prints none.
public struct ClaudeAccountComparator: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible,
                                       CustomReflectable {
    private let digest: [UInt8]

    init(email: String, organization: String?, key: [UInt8]) {
        var message = Data(email.utf8)
        message.append(0)
        if let organization {
            message.append(1)
            message.append(Data(organization.utf8))
        } else {
            message.append(0)
        }
        digest = Array(HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key)))
    }

    public var description: String { "account-comparator" }
    public var debugDescription: String { "account-comparator" }
    public var customMirror: Mirror { Mirror(self, children: []) }
}

/// What a passing check found, in memory only.
public struct ClaudeLocalSnapshot: Equatable, Sendable {
    /// The version `--version` printed: the pinned one.
    public let cliVersion: String
    public let fileIdentity: ClaudeCLIFileIdentity
    public let loginKind: ClaudeLoginKind
    public let account: ClaudeAccountComparator
}

/// One run of the local checks: the first failing reason, or what a pass
/// found.
public enum ClaudeLocalCheckResult: Equatable, Sendable {
    case failed(ClaudeLocalFailure)
    case passed(ClaudeLocalSnapshot)

    /// As an availability answer: never available. A pass still needs
    /// section 17's active confirmation, so on its own it is
    /// `overflow-unverified`.
    public var availability: ParticipantAvailability {
        switch self {
        case .failed(let failure): return .unavailable(failure.reason)
        case .passed: return .unavailable(.overflowUnverified)
        }
    }

    public var snapshot: ClaudeLocalSnapshot? {
        if case .passed(let snapshot) = self { return snapshot }
        return nil
    }
}

/// Section 5's local checks, as section 17's owner (F4) consumes them.
public protocol ClaudeLocalChecking: Sendable {
    /// May reuse a result up to `reuseMillis` old while the pinned file's
    /// identity is unchanged (availability display).
    func evaluate() async -> ClaudeLocalCheckResult
    /// Never reuses: confirmation and every start (section 7 step 13).
    func evaluateFresh() async -> ClaudeLocalCheckResult
}

/// What the checks touch, for tests: every path stat'ed, opened, read,
/// listed or executed, before it is (the path as requested). Nil outside
/// tests. Package-visible only for the test-only probe, a separate process.
package enum ClaudeCheckAccess: Equatable, Sendable {
    case inspect(String)
    case read(String)
    case list(String)
    case execute(String)

    package var path: String {
        switch self {
        case .inspect(let path), .read(let path), .list(let path), .execute(let path): return path
        }
    }
}

package typealias ClaudeCheckObserver = @Sendable (ClaudeCheckAccess) -> Void

/// Section 5's checks of the pinned Claude Code, in its order:
///
/// 1. The pinned binary: exactly `<home>/.local/share/claude/versions/2.1.283`
///    under the user database's home, every folder on the way this user's,
///    reached through no link and writable by no one else, the file a regular
///    executable of this user's with no group or other write. Missing:
///    `cli-missing`; anything else wrong: `check-failed`.
/// 2. `--version` must print `2.1.283 (Claude Code)`: another version is
///    `cli-version-mismatch`. It runs before any settings, auth or network
///    work, so it can invoke no helper.
/// 3. Provider overrides, before `auth status` runs: the probe environment's
///    `HOME` and `USER` must be the roots' (else whose files the CLI reads is
///    unresolved: `check-failed`), then every settings source
///    (`ClaudeCheckSource`). An override in any is `provider-override`; else
///    an unreadable or unresolved one is `check-failed`. No helper is ever
///    run: a configured one is `provider-override`.
/// 4. `auth status --json`: provider evidence (`apiKeySource`, another
///    `apiProvider`, an API key, key helper, OAuth token or third-party
///    method) is `provider-override`; logged out is `signed-out`; a
///    claude.ai login without a plan, or on a plan other than Pro or Max, is
///    `not-subscription`. The settings sources are read once more after it,
///    and the binary's identity is checked again after each probe: a change
///    is `check-failed`. Production runs it with every network operation
///    denied (`ClaudeAuthStatusGate`, the owner's D1 decision); when that
///    block cannot be applied, step 4 is `check-failed` (`network-block`)
///    and `auth status` never runs.
///
/// Each probe runs the pinned file directly under section 11's environment
/// rule (`ParticipantEnvironment.build`), in a fresh empty app-owned 0700
/// folder, with stdin at EOF, stdout capped, in its own process group, which
/// is killed once the probe ends or times out. 5 s per probe and 12 s for the
/// whole check, else `check-failed`; any output of an unknown shape is
/// `check-failed`. Only booleans, the plan and the opaque account comparator
/// are kept, in memory. Logs carry fixed codes only (`ClaudeCheckLogEntry`).
///
/// Results are reused for up to 30 s by `evaluate()` and `check()` while the
/// pinned file's identity is unchanged; `evaluateFresh()` and `recheck()`
/// (every start, section 7 step 13) never reuse. One piece of work runs at a
/// time, a check or a reused result's look at the pin (Codex F34-R3): a
/// caller that may reuse shares the one under way, and a fresh caller waits
/// for it and then starts its own check.
/// The 12 s bound covers the file work too (Codex F3-3): a check whose
/// thread is still blocked at it (a read on a stalled network or FUSE
/// volume, say) is abandoned and answers `check-failed`, and until that
/// thread returns every call answers `check-failed` (`stalled`) at once and
/// nothing new is started. A late result is dropped, never reused.
public actor ClaudeLocalChecks: ClaudeLocalChecking, AvailabilityChecking {
    private struct Cached {
        let outcome: ClaudeCheckOutcome
        let binary: ClaudeBinaryState
        let atMillis: UInt64
    }

    /// The one piece of work under way: a check, or a cached result's look
    /// at the pin before it is reused (Codex F34-R3). Its own task clears
    /// it, and stores what it found, before it ends, so a waiter that sees
    /// it end finds it cleared.
    private struct Work {
        let id: UInt64
        /// A check: its result, always. A look at the pin: the cached
        /// result if it may be reused, else nil (a check must follow).
        let task: Task<ClaudeLocalCheckResult?, Never>
    }

    private let worker: ClaudeCheckRun
    private let clock: any ParticipantClock
    private let log: any ClaudeCheckLogSink
    private let watchdog = ClaudeCheckWatchdog()
    private var cached: Cached?
    private var inFlight: Work?
    private var nextWork: UInt64 = 0

    /// The probes' environment is built, at each check, from this process's
    /// own environment under section 11's rule. Step 4 runs `auth status`
    /// with its network blocked (`ClaudeAuthStatusGate.production`).
    public init(roots: ClaudeCheckRoots, limits: ClaudeCheckLimits = .contract,
                clock: any ParticipantClock = SystemParticipantClock(),
                log: any ClaudeCheckLogSink = SystemClaudeCheckLog()) {
        self.init(roots: roots, limits: limits, clock: clock, log: log, environment: nil, observer: nil,
                  authStatus: .production)
    }

    /// The test-only availability probe's (a separate process, which cannot
    /// use `@testable`): its own environment, as in production, an observer
    /// of every path touched, which it reports, and the step 4 gate it names.
    package init(roots: ClaudeCheckRoots, log: any ClaudeCheckLogSink, observer: @escaping ClaudeCheckObserver,
                 authStatus: ClaudeAuthStatusGate) {
        self.init(roots: roots, limits: .contract, clock: SystemParticipantClock(), log: log, environment: nil, observer: observer,
                  authStatus: authStatus)
    }

    /// Tests only (through `@testable`): the variables the environment rule
    /// reads in place of this process's own, an observer of every path
    /// touched, and the step 4 gate. The rule applies either way.
    init(roots: ClaudeCheckRoots, limits: ClaudeCheckLimits = .contract, clock: any ParticipantClock = SystemParticipantClock(),
         log: any ClaudeCheckLogSink = SystemClaudeCheckLog(), environment: [String: String]?,
         observer: ClaudeCheckObserver?, authStatus: ClaudeAuthStatusGate) {
        // A fresh random key per checks object: comparators never match
        // across objects or launches.
        let key = SymmetricKey(size: .bits256).withUnsafeBytes { Array($0) }
        worker = ClaudeCheckRun(roots: roots, limits: limits, environment: environment, accountKey: key, observer: observer,
                                authStatus: authStatus)
        self.clock = clock
        self.log = log
    }

    /// Tests only: an abandoned check's thread has not returned yet.
    nonisolated var hasStalledWork: Bool {
        watchdog.stalled != nil
    }

    /// Tests only: whether step 4 runs `auth status`.
    nonisolated var authStatusGate: ClaudeAuthStatusGate {
        worker.authStatus
    }

    // MARK: AvailabilityChecking

    /// Never available: a pass is `overflow-unverified` (section 17's).
    public func check() async -> ParticipantAvailability {
        await evaluate().availability
    }

    /// A start's recheck (section 7 step 13): never a reused result.
    public func recheck() async -> ParticipantAvailability {
        await evaluateFresh().availability
    }

    // MARK: ClaudeLocalChecking

    public func evaluate() async -> ClaudeLocalCheckResult {
        var mayReuse = true
        while true {
            if let work = inFlight {
                // One piece of work at a time: share the one under way.
                if let result = await work.task.value { return result }
                // A look at the pin found nothing to reuse: a check follows.
                mayReuse = false
                continue
            }
            if mayReuse, watchdog.stalled == nil, let cached, isFresh(cached) {
                // Reuse only while the pinned file is as it was; any change
                // (missing, refused, another identity) means a new check. The
                // look at the file is work like a check, with the same bound.
                mayReuse = false
                lookAtPin(before: cached)
                continue
            }
            return await fresh()
        }
    }

    public func evaluateFresh() async -> ClaudeLocalCheckResult {
        // One piece of work at a time: wait for any under way (bounded, as
        // all is), then make a new check that starts after this call.
        while let work = inFlight { _ = await work.task.value }
        return await fresh()
    }

    // MARK: Internals

    private func isFresh(_ cached: Cached) -> Bool {
        let now = clock.monotonicMillis()
        return now >= cached.atMillis && now - cached.atMillis < worker.limits.reuseMillis
    }

    /// Starts the look at the pin before `cached` is reused, as the work
    /// under way (the caller then waits for it as any work).
    private func lookAtPin(before cached: Cached) {
        nextWork += 1
        let id = nextWork
        let worker = self.worker
        let watchdog = self.watchdog
        let deadline = ClaudeCheckRun.nowMillis() + worker.limits.totalMillis
        // Isolated to this actor: after the look, `reuse` runs here before
        // the task ends.
        let task = Task { () -> ClaudeLocalCheckResult? in
            let found = await watchdog.run(until: deadline, progress: ClaudeCheckProgress(), { worker.binaryState() })
            return self.reuse(id: id, cachedAt: cached.atMillis, found)
        }
        inFlight = Work(id: id, task: task)
    }

    /// The cached result, if the look at the pin found it as it was and the
    /// result is still fresh; else nil, and the cache is dropped.
    private func reuse(id: UInt64, cachedAt: UInt64, _ found: ClaudeCheckWatchdog.Bounded<ClaudeBinaryState>) -> ClaudeLocalCheckResult? {
        if inFlight?.id == id { inFlight = nil }
        switch found {
        case .finished(let binary):
            guard let current = cached, current.atMillis == cachedAt else { return nil }
            if isFresh(current), binary == current.binary {
                log.record(current.outcome.logEntry(reused: true))
                return current.outcome.result
            }
            // The pin changed (or the result aged): never reused again.
            cached = nil
            return nil
        case .abandoned:
            // Still blocked: nothing is reused, and the check that follows
            // answers at once while it is.
            cached = nil
            return nil
        }
    }

    private func fresh() async -> ClaudeLocalCheckResult {
        if let stalled = watchdog.stalled {
            // An abandoned check's thread is still blocked: nothing new is
            // started (one at a time), and the answer is at once.
            let outcome = ClaudeCheckOutcome.unfinished(at: stalled, .stalled)
            log.record(outcome.logEntry(reused: false))
            return outcome.result
        }
        nextWork += 1
        let id = nextWork
        let startedAt = clock.monotonicMillis()
        let worker = self.worker
        let watchdog = self.watchdog
        // One deadline for the probes (inside the run) and the whole run
        // (the watchdog).
        let deadline = ClaudeCheckRun.nowMillis() + worker.limits.totalMillis
        let progress = ClaudeCheckProgress()
        // Isolated to this actor: after the work, `finish` runs here before
        // the task ends.
        let task = Task { () -> ClaudeLocalCheckResult? in
            let outcome: ClaudeCheckOutcome
            switch await watchdog.run(until: deadline, progress: progress, { worker.perform(deadline: deadline, progress: progress) }) {
            case .finished(let done): outcome = done
            case .abandoned(let point): outcome = .unfinished(at: point, .totalTimeout)
            }
            self.finish(id: id, outcome: outcome, startedAt: startedAt)
            return outcome.result
        }
        inFlight = Work(id: id, task: task)
        // A check's task always answers.
        return await task.value ?? .failed(.checkFailed)
    }

    private func finish(id: UInt64, outcome: ClaudeCheckOutcome, startedAt: UInt64) {
        if inFlight?.id == id { inFlight = nil }
        if let binary = outcome.binary {
            if cached.map({ startedAt >= $0.atMillis }) ?? true {
                cached = Cached(outcome: outcome, binary: binary, atMillis: startedAt)
            }
        } else {
            // Abandoned: no earlier result is reused after it either.
            cached = nil
        }
        log.record(outcome.logEntry(reused: false))
    }
}

/// Bounds the checks' blocking work (Codex F3-3). Each piece runs on a thread
/// of its own (off the shared pool) and is answered by whichever comes
/// first: its end, or its deadline. Work still running at its deadline is
/// abandoned, not stopped (a thread blocked in a read cannot be), and stays
/// recorded, with where it was, until its thread returns; its late result is
/// dropped.
final class ClaudeCheckWatchdog: @unchecked Sendable {
    enum Bounded<T: Sendable>: Sendable {
        case finished(T)
        case abandoned(ClaudeCheckProgress.Point)
    }

    private final class Race<T: Sendable>: @unchecked Sendable {
        var waiter: CheckedContinuation<Bounded<T>, Never>?
        init(_ waiter: CheckedContinuation<Bounded<T>, Never>) { self.waiter = waiter }
    }

    private let lock = NSLock()
    private var abandoned: [UInt64: ClaudeCheckProgress.Point] = [:]
    private var next: UInt64 = 0

    /// Where the oldest abandoned work was at its deadline, while its thread
    /// has not returned; nil when none is out.
    var stalled: ClaudeCheckProgress.Point? {
        lock.lock(); defer { lock.unlock() }
        return abandoned.min { $0.key < $1.key }?.value
    }

    /// Runs `work`, answering by `deadline` (monotonic milliseconds).
    func run<T: Sendable>(until deadline: UInt64, progress: ClaudeCheckProgress,
                          _ work: @escaping @Sendable () -> T) async -> Bounded<T> {
        await withCheckedContinuation { (continuation: CheckedContinuation<Bounded<T>, Never>) in
            let race = Race(continuation)
            lock.lock()
            next += 1
            let id = next
            lock.unlock()
            let thread = Thread { [self] in
                let value = work()
                lock.lock()
                abandoned[id] = nil
                let waiter = race.waiter
                race.waiter = nil
                lock.unlock()
                waiter?.resume(returning: .finished(value))
            }
            thread.name = "claude-local-checks"
            thread.start()
            let now = ClaudeCheckRun.nowMillis()
            let wait = deadline > now ? deadline - now : 0
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(Int(wait))) { [self] in
                lock.lock()
                let waiter = race.waiter
                race.waiter = nil
                let point = progress.point
                if waiter != nil {
                    abandoned[id] = point
                    // Its thread must start nothing more (Codex F34-R1).
                    progress.abandon()
                }
                lock.unlock()
                waiter?.resume(returning: .abandoned(point))
            }
        }
    }
}
