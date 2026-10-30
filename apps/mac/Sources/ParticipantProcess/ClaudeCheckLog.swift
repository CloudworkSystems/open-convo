import Foundation
import os
import TrueConvoIdentity

// What the local checks log (plan F3): fixed codes only. No path, account
// field, version text, probe output, settings value or environment value can
// be written: every field is one of the enums below.

/// Which check decided.
public enum ClaudeCheckStep: String, Sendable, CaseIterable {
    case binary
    case version
    case environment
    case sources
    case authStatus = "auth-status"
    case finished
}

/// Where a provider override, or an unreadable or unresolved input, was
/// found. Settings sources are inspected in this order.
public enum ClaudeCheckSource: String, Sendable, CaseIterable {
    /// `managed-settings.json` in the managed settings folder.
    case managedFile = "managed-file"
    /// Every `.json` file (not a dot-file) in `managed-settings.d`.
    case managedDropIn = "managed-drop-in"
    /// The per-user MDM preferences file.
    case userPreferences = "mdm-user"
    /// The device MDM preferences file.
    case devicePreferences = "mdm-device"
    /// Server-managed settings cached in the config folder.
    case remoteSettings = "remote-settings"
    /// Server policy limits cached in the config folder (read
    /// conservatively; the reading does not say they can carry an override).
    case policyLimits = "policy-limits"
    /// `~/.claude.json`: its `env` and `primaryApiKey`.
    case globalConfig = "global-config"
    /// `~/.claude/.config.json`, an older global config name, if present
    /// (read conservatively; not confirmed by the reading).
    case legacyGlobalConfig = "legacy-global-config"
    /// `~/.claude/settings.json`: `auth status` runs without `--restricted`,
    /// so a helper configured there could run; the run itself ignores it.
    case userSettings = "user-settings"
    /// Where `auth status` would find local settings: a git root above the
    /// probe's working folder other than the home (Codex F3-5).
    case localSettings = "local-settings"
    /// The probes' environment, as section 11's rule builds it.
    case environment
    /// What `auth status` reported.
    case authStatus = "auth-status"

    /// The settings sources, in inspection order.
    static let settingsSources: [ClaudeCheckSource] = [
        .managedFile, .managedDropIn, .userPreferences, .devicePreferences, .remoteSettings, .policyLimits,
        .globalConfig, .legacyGlobalConfig, .userSettings, .localSettings
    ]
}

/// Why a step failed, as a fixed code.
public enum ClaudeCheckDetail: String, Sendable, CaseIterable {
    case missing
    case linked
    case notRegular = "not-regular"
    case notOwned = "not-owned"
    case writable
    case notExecutable = "not-executable"
    case specialMode = "special-mode"
    case inaccessible
    case changed
    case timeout
    case totalTimeout = "total-timeout"
    case outputTooLarge = "output-too-large"
    case emptyOutput = "empty-output"
    case unparseable
    case exitStatus = "exit-status"
    case spawnFailed = "spawn-failed"
    case readFailed = "read-failed"
    case folderFailed = "folder-failed"
    case mismatch
    case override
    case helper
    case unreadable
    case tooLarge = "too-large"
    /// A source would undo section 11's environment: a fixed value changed;
    /// in a source the run reads, any name section 11 does not allow; in
    /// user settings, the config folder, `HOME`, `USER`, retries, a proxy,
    /// TLS trust, a client certificate or telemetry export.
    case restriction
    /// A managed configuration these checks do not support (a hook, a value
    /// of an unexpected type).
    case unsupported
    case homeMismatch = "home-mismatch"
    case userMismatch = "user-mismatch"
    case signedOut = "signed-out"
    case noSubscription = "no-subscription"
    case unknownPlan = "unknown-plan"
    case noAccount = "no-account"
    /// `auth status` reported on another config folder than the one
    /// inspected.
    case configMismatch = "config-mismatch"
    /// A git root above the probe's working folder, other than the home:
    /// `auth status` could read local settings there.
    case gitRoot = "git-root"
    /// An earlier check's file or process work outlived its 12 s bound and
    /// has not returned: nothing new is started.
    case stalled
    /// Step 4 was not run: its network block (the owner's D1 decision)
    /// could not be applied, because the system tool that applies it is
    /// missing or is not a root-owned file only root can change. Without
    /// the block, `auth status` could fetch server-managed settings and run
    /// a helper they carry before any inspection sees it (Codex F34-D1).
    case networkBlock = "network-block"
    /// The login is a claude.ai plan other than Pro or Max (the owner's D1
    /// decision): a Team or Enterprise plan can have server-managed
    /// settings, so it is refused as `not-subscription`.
    case planNotAccepted = "plan-not-accepted"
}

/// One check's log line: whether the result was reused, its result, and
/// where it was decided.
public struct ClaudeCheckLogEntry: Equatable, Sendable {
    public let reused: Bool
    /// Nil when the checks passed.
    public let failure: ClaudeLocalFailure?
    public let step: ClaudeCheckStep
    public let source: ClaudeCheckSource?
    public let detail: ClaudeCheckDetail?

    public var line: String {
        var fields = ["check=\(reused ? "reused" : "fresh")", "result=\(failure?.rawValue ?? "passed")",
                      "step=\(step.rawValue)"]
        if let source { fields.append("source=\(source.rawValue)") }
        if let detail { fields.append("detail=\(detail.rawValue)") }
        return fields.joined(separator: " ")
    }
}

public protocol ClaudeCheckLogSink: Sendable {
    func record(_ entry: ClaudeCheckLogEntry)
}

/// The app's log for the checks: unified logging, one line per check.
public struct SystemClaudeCheckLog: ClaudeCheckLogSink {
    private static let logger = Logger(subsystem: AppIdentity.current.logSubsystem, category: "participant-checks")

    public init() {}

    public func record(_ entry: ClaudeCheckLogEntry) {
        // Every field is a fixed code.
        Self.logger.log("\(entry.line, privacy: .public)")
    }
}
