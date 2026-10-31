import Darwin
import Foundation

// One run of section 5's local checks, blocking, on its own thread
// (`ClaudeLocalChecks` calls it). See `ClaudeLocalChecks` for the order.

/// The pinned version file as one inspection found it.
enum ClaudeBinaryState: Equatable, Sendable {
    /// A folder on the way, or the file, does not exist: `cli-missing`.
    case missing
    /// It exists but is refused (a link, another owner's, writable by
    /// others, not an executable regular file, unreadable): `check-failed`.
    case refused(ClaudeCheckDetail)
    case present(ClaudeCLIFileIdentity)
}

/// What one run decided, with the binary state it started from.
struct ClaudeCheckOutcome: Sendable {
    let result: ClaudeLocalCheckResult
    /// Nil when no run finished (abandoned at its deadline, or not started
    /// while an earlier one is stalled): such an outcome is never reused.
    let binary: ClaudeBinaryState?
    let step: ClaudeCheckStep
    let source: ClaudeCheckSource?
    let detail: ClaudeCheckDetail?

    func logEntry(reused: Bool) -> ClaudeCheckLogEntry {
        var failure: ClaudeLocalFailure?
        if case .failed(let reason) = result { failure = reason }
        return ClaudeCheckLogEntry(reused: reused, failure: failure, step: step, source: source, detail: detail)
    }

    /// `check-failed` where `point` says the check was, without a run's
    /// result: `total-timeout` for one abandoned at its deadline, `stalled`
    /// for one not started.
    static func unfinished(at point: ClaudeCheckProgress.Point, _ detail: ClaudeCheckDetail) -> ClaudeCheckOutcome {
        ClaudeCheckOutcome(result: .failed(.checkFailed), binary: nil, step: point.step, source: point.source, detail: detail)
    }
}

/// Where one check is (its step and source), for `ClaudeLocalChecks` to
/// report when it abandons the check at its deadline (Codex F3-3).
final class ClaudeCheckProgress: @unchecked Sendable {
    struct Point: Equatable, Sendable {
        let step: ClaudeCheckStep
        let source: ClaudeCheckSource?
    }

    private let lock = NSLock()
    private var current: Point
    private var abandoned = false

    init(_ step: ClaudeCheckStep = .binary, _ source: ClaudeCheckSource? = nil) {
        current = Point(step: step, source: source)
    }

    func at(_ step: ClaudeCheckStep, _ source: ClaudeCheckSource? = nil) {
        lock.lock(); defer { lock.unlock() }
        current = Point(step: step, source: source)
    }

    var point: Point {
        lock.lock(); defer { lock.unlock() }
        return current
    }

    /// The watchdog gave up on this check at its deadline (its caller has
    /// its answer): whatever the thread reaches next must start nothing.
    func abandon() {
        lock.lock(); defer { lock.unlock() }
        abandoned = true
    }

    var isAbandoned: Bool {
        lock.lock(); defer { lock.unlock() }
        return abandoned
    }
}

struct ClaudeCheckRun: Sendable {
    let roots: ClaudeCheckRoots
    let limits: ClaudeCheckLimits
    /// Nil: this process's own environment, read at each check.
    let environment: [String: String]?
    let accountKey: [UInt8]
    let observer: ClaudeCheckObserver?
    /// How step 4 runs `auth status` (Codex F34-D1).
    let authStatus: ClaudeAuthStatusGate

    var binary: ClaudePinnedBinary {
        ClaudePinnedBinary(home: roots.home, owner: roots.owner, observer: observer)
    }

    func binaryState() -> ClaudeBinaryState {
        binary.inspect()
    }

    static func nowMillis() -> UInt64 {
        clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000
    }

    /// One whole check, blocking, ending by `deadline` (monotonic
    /// milliseconds) for every probe; `ClaudeLocalChecks` bounds the file
    /// work by the same deadline and abandons a check that passes it.
    func perform(deadline: UInt64, progress: ClaudeCheckProgress) -> ClaudeCheckOutcome {
        let pinned = binary
        progress.at(.binary)
        let state = pinned.inspect()
        func end(_ failure: ClaudeLocalFailure, _ step: ClaudeCheckStep, _ source: ClaudeCheckSource?,
                 _ detail: ClaudeCheckDetail?) -> ClaudeCheckOutcome {
            ClaudeCheckOutcome(result: .failed(failure), binary: state, step: step, source: source, detail: detail)
        }

        // 1. The pinned binary.
        let identity: ClaudeCLIFileIdentity
        switch state {
        case .missing: return end(.cliMissing, .binary, nil, .missing)
        case .refused(let detail): return end(.checkFailed, .binary, nil, detail)
        case .present(let found): identity = found
        }
        let probeEnvironment = ParticipantEnvironment.build(from: environment ?? ProcessInfo.processInfo.environment)
        let runner = ClaudeProbeRunner(binaryPath: pinned.path, workParent: roots.probeParent, environment: probeEnvironment,
                                       outputBytes: limits.outputBytes, observer: observer)
        func probe(_ arguments: [String], through runner: ClaudeProbeRunner) -> (ClaudeProbeResult, timeout: ClaudeCheckDetail) {
            let now = Self.nowMillis()
            let own = now + limits.perProcessMillis
            guard now < deadline, !progress.isAbandoned else {
                return (ClaudeProbeResult(ending: .timedOut, stdout: Data()), .totalTimeout)
            }
            let until = Swift.min(own, deadline)
            let result = runner.run(arguments, until: until, abandoned: { progress.isAbandoned })
            return (result, until == deadline && own > deadline ? .totalTimeout : .timeout)
        }

        // 2. `--version`, which the CLI answers before any settings, auth or
        // network work.
        progress.at(.version)
        let (versionProbe, versionTimeout) = probe(["--version"], through: runner)
        switch ClaudeCheckAnswers.version(versionProbe, timeout: versionTimeout) {
        case .unreadable(let detail):
            return end(.checkFailed, .version, nil, detail)
        case .version(let version):
            guard version == ParticipantCommandLine.pinnedCLIVersion else {
                return end(.cliVersionMismatch, .version, nil, .mismatch)
            }
        }
        progress.at(.binary)
        guard pinned.inspect() == state else { return end(.checkFailed, .binary, nil, .changed) }

        // 3. Provider overrides, before anything that could invoke one.
        progress.at(.environment, .environment)
        if let detail = ClaudeCheckEnvironment.applicability(probeEnvironment, roots: roots) {
            return end(.checkFailed, .environment, .environment, detail)
        }
        let inspector = ClaudeSourceInspector(roots: roots, limits: limits, observer: observer, progress: progress)
        switch inspector.inspect() {
        case .override(let source, let detail): return end(.providerOverride, .sources, source, detail)
        case .unresolved(let source, let detail): return end(.checkFailed, .sources, source, detail)
        case .clear: break
        }

        // 4. `auth status`, which 2.1.283 lets fetch server-managed settings
        // (and arm a helper they carry) before any inspection can see them:
        // in production only with its network blocked (the owner's D1
        // decision, Codex F34-D1).
        progress.at(.authStatus, .authStatus)
        var authRunner = runner
        if case .runWithNetworkBlocked(let block) = authStatus {
            if let detail = block.refusal(observer: observer) { return end(.checkFailed, .authStatus, .authStatus, detail) }
            authRunner.networkBlock = block
        }
        let (authProbe, authTimeout) = probe(["auth", "status", "--json"], through: authRunner)
        let answer = ClaudeCheckAnswers.authStatus(authProbe, timeout: authTimeout, configFolder: roots.configFolder)
        // Past the deadline nothing more is done: the check is over.
        if case .failure(let failure, let detail) = answer, Self.nowMillis() >= deadline {
            return end(failure, .authStatus, .authStatus, detail)
        }
        // What `auth status` itself may have cached counts too, however it
        // ended: an override found now wins over its answer (section 5's
        // order, Codex F3-6); an unresolved source after its failure.
        let after = inspector.inspect()
        if case .override(let source, let detail) = after { return end(.providerOverride, .sources, source, detail) }
        let login: (plan: ClaudeSubscriptionPlan, email: String, organization: String?)
        switch answer {
        case .failure(let failure, let detail):
            return end(failure, .authStatus, .authStatus, detail)
        case .subscription(let plan, let email, let organization):
            login = (plan, email, organization)
        }
        // Only Pro, Max and Ultra (the owner's D1 decision, with Ultra the
        // October 30 rename of Max 20x): a Team or Enterprise
        // plan can carry server-managed settings.
        guard ClaudeSubscriptionPlan.accepted.contains(login.plan) else {
            return end(.notSubscription, .authStatus, .authStatus, .planNotAccepted)
        }
        if case .unresolved(let source, let detail) = after { return end(.checkFailed, .sources, source, detail) }
        progress.at(.binary)
        guard pinned.inspect() == state else { return end(.checkFailed, .binary, nil, .changed) }
        progress.at(.finished)
        guard Self.nowMillis() < deadline else { return end(.checkFailed, .finished, nil, .totalTimeout) }

        let snapshot = ClaudeLocalSnapshot(
            cliVersion: ParticipantCommandLine.pinnedCLIVersion, fileIdentity: identity, loginKind: .subscription(login.plan),
            account: ClaudeAccountComparator(email: login.email, organization: login.organization, key: accountKey))
        return ClaudeCheckOutcome(result: .passed(snapshot), binary: state, step: .finished, source: nil, detail: nil)
    }
}

/// The pinned version file, reached from the home one folder at a time
/// without following a link, with the existing safe-path rules (DeskPaths,
/// `ParticipantsFolder`): each folder this user's and not writable by group
/// or others. Nothing is opened for reading; the file is only stat'ed.
struct ClaudePinnedBinary: Sendable {
    let home: String
    let owner: uid_t
    let observer: ClaudeCheckObserver?

    var path: String {
        ([home] + ClaudeCheckRoots.pinnedBinaryFolders + [ParticipantCommandLine.pinnedCLIVersion]).joined(separator: "/")
    }

    func inspect() -> ClaudeBinaryState {
        observer?(.inspect(home))
        var current = open(home, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard current >= 0 else { return Self.openFailure(errno, at: home, parent: nil) }
        var info = stat()
        guard fstat(current, &info) == 0 else {
            _ = close(current)
            return .refused(.inaccessible)
        }
        if let refusal = Self.folderRefusal(info, owner: owner) {
            _ = close(current)
            return .refused(refusal)
        }
        var walked = home
        for name in ClaudeCheckRoots.pinnedBinaryFolders {
            walked += "/" + name
            observer?(.inspect(walked))
            let next = openat(current, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            if next < 0 {
                let code = errno
                let state = Self.openFailure(code, at: name, parent: current)
                _ = close(current)
                return state
            }
            _ = close(current)
            current = next
            guard fstat(current, &info) == 0 else {
                _ = close(current)
                return .refused(.inaccessible)
            }
            if let refusal = Self.folderRefusal(info, owner: owner) {
                _ = close(current)
                return .refused(refusal)
            }
        }
        defer { _ = close(current) }
        let file = ParticipantCommandLine.pinnedCLIVersion
        observer?(.inspect(walked + "/" + file))
        guard fstatat(current, file, &info, AT_SYMLINK_NOFOLLOW) == 0 else {
            return errno == ENOENT ? .missing : .refused(.inaccessible)
        }
        if let refusal = Self.fileRefusal(info, owner: owner) { return .refused(refusal) }
        return .present(ClaudeCLIFileIdentity(info))
    }

    /// Why a folder on the way is refused, if it is.
    static func folderRefusal(_ info: stat, owner: uid_t) -> ClaudeCheckDetail? {
        guard info.st_mode & S_IFMT == S_IFDIR else { return .notRegular }
        guard info.st_uid == owner else { return .notOwned }
        guard info.st_mode & (S_IWGRP | S_IWOTH) == 0 else { return .writable }
        return nil
    }

    /// Why the version file is refused, if it is.
    static func fileRefusal(_ info: stat, owner: uid_t) -> ClaudeCheckDetail? {
        switch info.st_mode & S_IFMT {
        case S_IFREG: break
        case S_IFLNK: return .linked
        default: return .notRegular
        }
        guard info.st_uid == owner else { return .notOwned }
        guard info.st_mode & (S_IWGRP | S_IWOTH) == 0 else { return .writable }
        guard info.st_mode & (S_ISUID | S_ISGID) == 0 else { return .specialMode }
        guard info.st_mode & S_IXUSR != 0 else { return .notExecutable }
        return nil
    }

    /// A folder that would not open: missing is `cli-missing`; a link, a
    /// non-folder or anything unreadable is refused.
    private static func openFailure(_ code: Int32, at name: String, parent: Int32?) -> ClaudeBinaryState {
        if code == ENOENT { return .missing }
        var info = stat()
        let found = parent.map { fstatat($0, name, &info, AT_SYMLINK_NOFOLLOW) == 0 }
            ?? (lstat(name, &info) == 0)
        guard found else { return .refused(.inaccessible) }
        switch info.st_mode & S_IFMT {
        case S_IFLNK: return .refused(.linked)
        case S_IFDIR: return .refused(.inaccessible)
        default: return .refused(.notRegular)
        }
    }
}

/// The probe environment's `HOME` and `USER` must name the roots' home and
/// user: otherwise the CLI would read another home's files than the ones
/// inspected, and which sources apply is unresolved.
enum ClaudeCheckEnvironment {
    static func applicability(_ entries: [String], roots: ClaudeCheckRoots) -> ClaudeCheckDetail? {
        for entry in entries {
            guard let equals = entry.firstIndex(of: "=") else { continue }
            let name = entry[..<equals]
            let value = String(entry[entry.index(after: equals)...])
            if name == "HOME", ClaudeSourceInspector.trimmed(value) != ClaudeSourceInspector.trimmed(roots.home) {
                return .homeMismatch
            }
            if name == "USER", value != roots.userName { return .userMismatch }
        }
        return nil
    }
}
