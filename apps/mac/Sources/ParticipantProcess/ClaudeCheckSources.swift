import Darwin
import Foundation
import ParticipantSupervisorCore

// Section 5's provider-override inspection (Codex F0 answer 11), made before
// `auth status` runs and again after it. Every source that could change the
// provider, key or base URL for `auth status` or for the run is read, in
// memory, for a few keys only; nothing read is kept, logged or executed.
// A configured helper (key, refresh, proxy, headers or policy) is never run:
// it is itself an unsupported override. Paths come from `ClaudeCheckRoots`.
//
// Which sources, and why (the F1 reading, Q4):
// - Managed: `managed-settings.json`, `managed-settings.d/*.json`, the
//   per-user and device MDM preferences, and server-managed
//   `remote-settings.json` in the config folder. They apply under
//   `--restricted` and `--safe-mode`. `policy-limits.json` there too,
//   conservatively. The SDK parent tier applies only if passed, and nothing
//   passes it (no `--managed-settings`, no SDK options), so it has no file.
// - `~/.claude.json`: its `env` and `primaryApiKey` apply apart from the
//   settings files (and `~/.claude/.config.json`, an older name for it, if
//   present, conservatively).
// - `~/.claude/settings.json`: the run ignores it under `--restricted`, but
//   `auth status` runs without that flag, so its helpers and its `env`
//   apply to that probe.
// - Project and local settings, for `auth status` (the F3 review's byte
//   reading of 2.1.283, Codex F3-5; never run): project settings come from
//   its working folder, which is new and empty, so there are none. Local
//   settings come from `<root>/.claude/settings.local.json`, `<root>` the
//   canonical git root of that folder when it is not the folder itself or
//   the user's home and it, its `.git` and its `.claude` are the user's;
//   otherwise from the working folder. These checks do not resolve that
//   root: any `.git` above the probe's folder, short of the home, is
//   unresolved (`local-settings`).
// - The app's environment never reaches the CLI beyond section 11's
//   allow-list; `ClaudeCheckEnvironment` checks what does.

enum ClaudeSourceVerdict: Equatable, Sendable {
    case clear
    case override(ClaudeCheckSource, ClaudeCheckDetail)
    case unresolved(ClaudeCheckSource, ClaudeCheckDetail)
}

/// What one source, or one part of it, showed.
enum ClaudeSourceFinding: Equatable, Sendable {
    /// `provider-override`: `.override` or `.helper`.
    case override(ClaudeCheckDetail)
    /// `check-failed`: unreadable, of an unknown shape, or a setting these
    /// checks cannot resolve.
    case unresolved(ClaudeCheckDetail)
}

struct ClaudeSourceInspector: Sendable {
    let roots: ClaudeCheckRoots
    let limits: ClaudeCheckLimits
    let observer: ClaudeCheckObserver?
    /// Where the check is, for one abandoned at its deadline.
    var progress: ClaudeCheckProgress?

    /// Every source, in `ClaudeCheckSource.settingsSources` order. An
    /// override in any wins over an unresolved one anywhere; the first
    /// unresolved one is reported otherwise.
    func inspect() -> ClaudeSourceVerdict {
        var firstUnresolved: (ClaudeCheckSource, ClaudeCheckDetail)?
        for source in ClaudeCheckSource.settingsSources {
            progress?.at(.sources, source)
            switch inspect(source) {
            case nil:
                continue
            case .override(let detail)?:
                return .override(source, detail)
            case .unresolved(let detail)?:
                if firstUnresolved == nil { firstUnresolved = (source, detail) }
            }
        }
        if let firstUnresolved { return .unresolved(firstUnresolved.0, firstUnresolved.1) }
        return .clear
    }

    func inspect(_ source: ClaudeCheckSource) -> ClaudeSourceFinding? {
        if source == .localSettings { return localSettingsRoot() }
        guard let path = roots.path(source) else { return nil }
        switch source {
        case .managedFile, .remoteSettings, .policyLimits:
            return json(path, cap: limits.settingsBytes) { ClaudeSettingsScan.settings($0) }
        case .managedDropIn:
            return dropIns(path)
        case .userPreferences, .devicePreferences:
            if source == .userPreferences, roots.userName.isEmpty || roots.userName.contains("/") || roots.userName.hasPrefix(".") {
                return .unresolved(.unsupported)
            }
            return propertyList(path)
        case .globalConfig, .legacyGlobalConfig:
            return json(path, cap: limits.globalConfigBytes) { ClaudeSettingsScan.globalConfig($0) }
        case .userSettings:
            return json(path, cap: limits.settingsBytes) { ClaudeSettingsScan.userSettings($0) }
        case .environment, .authStatus, .localSettings:
            return nil
        }
    }

    /// `auth status` would read local settings from a git root above its
    /// working folder (see the top of this file). From the probe parent up
    /// to `gitSearchTop` (`/` in production), the first folder holding a
    /// `.git` entry decides: the home (which the CLI never takes as that
    /// root) is clear, any other is unresolved (`git-root`); none is clear.
    /// Only `lstat` is used: nothing is read, and a link is not followed.
    private func localSettingsRoot() -> ClaudeSourceFinding? {
        let top = Self.trimmed(roots.gitSearchTop)
        let home = Self.trimmed(roots.home)
        var folder = Self.trimmed(roots.probeParent.path)
        guard folder.hasPrefix("/"), top.hasPrefix("/"), top == "/" || folder == top || folder.hasPrefix(top + "/") else {
            return .unresolved(.unsupported)
        }
        while true {
            let marker = (folder == "/" ? "" : folder) + "/.git"
            observer?(.inspect(marker))
            var info = stat()
            if lstat(marker, &info) == 0 { return folder == home ? nil : .unresolved(.gitRoot) }
            guard errno == ENOENT else { return .unresolved(.unreadable) }
            if folder == top || folder == "/" { return nil }
            folder = (folder as NSString).deletingLastPathComponent
        }
    }

    static func trimmed(_ path: String) -> String {
        var path = path
        while path.count > 1, path.hasSuffix("/") { path.removeLast() }
        return path
    }

    // MARK: Reading

    private enum Read {
        case absent
        case unresolved(ClaudeCheckDetail)
        case data(Data)
    }

    /// Reads a regular file (following a link, as the CLI does) of at most
    /// `cap` bytes. Absent only when it does not exist; a FIFO or device
    /// never blocks (`O_NONBLOCK`) and is refused.
    private func read(_ path: String, cap: Int, relativeTo folder: Int32? = nil, name: String? = nil) -> Read {
        observer?(.read(path))
        let flags = O_RDONLY | O_CLOEXEC | O_NONBLOCK
        let descriptor = folder.map { openat($0, name ?? "", flags) } ?? open(path, flags)
        guard descriptor >= 0 else { return errno == ENOENT ? .absent : .unresolved(.unreadable) }
        defer { _ = close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0 else { return .unresolved(.unreadable) }
        guard info.st_mode & S_IFMT == S_IFREG else { return .unresolved(.notRegular) }
        guard info.st_size <= cap else { return .unresolved(.tooLarge) }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count > 0 {
                data.append(contentsOf: buffer[0..<count])
                if data.count > cap { return .unresolved(.tooLarge) }
                continue
            }
            if count == 0 { return .data(data) }
            if errno == EINTR { continue }
            return .unresolved(.unreadable)
        }
    }

    private func json(_ path: String, cap: Int, scan: (Any) -> ClaudeSourceFinding?) -> ClaudeSourceFinding? {
        switch read(path, cap: cap) {
        case .absent: return nil
        case .unresolved(let detail): return .unresolved(detail)
        case .data(let data): return Self.parseJSON(data).map(scan) ?? .unresolved(.unparseable)
        }
    }

    private func propertyList(_ path: String) -> ClaudeSourceFinding? {
        switch read(path, cap: limits.settingsBytes) {
        case .absent: return nil
        case .unresolved(let detail): return .unresolved(detail)
        case .data(let data):
            guard let object = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
                  object is [String: Any] else { return .unresolved(.unparseable) }
            return ClaudeSettingsScan.settings(object)
        }
    }

    /// `managed-settings.d`: every `.json` entry that is not a dot-file,
    /// read through links as the CLI does. A missing folder holds none.
    private func dropIns(_ path: String) -> ClaudeSourceFinding? {
        observer?(.list(path))
        let folder = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard folder >= 0 else { return errno == ENOENT ? nil : .unresolved(.unreadable) }
        defer { _ = close(folder) }
        guard let names = Self.entryNames(folder) else { return .unresolved(.unreadable) }
        var unresolved: ClaudeSourceFinding?
        for name in names.sorted() where name.hasSuffix(".json") && !name.hasPrefix(".") {
            let finding: ClaudeSourceFinding?
            switch read(path + "/" + name, cap: limits.settingsBytes, relativeTo: folder, name: name) {
            case .absent: finding = .unresolved(.unreadable)   // listed, then gone: unresolved
            case .unresolved(let detail): finding = .unresolved(detail)
            case .data(let data):
                finding = Self.parseJSON(data).map { ClaudeSettingsScan.settings($0) } ?? .unresolved(.unparseable)
            }
            if case .override? = finding { return finding }
            if unresolved == nil { unresolved = finding }
        }
        return unresolved
    }

    /// The names in an open folder, `.` and `..` left out; nil if it cannot
    /// be read to the end.
    private static func entryNames(_ folder: Int32) -> [String]? {
        let copy = fcntl(folder, F_DUPFD_CLOEXEC, 0)
        guard copy >= 0 else { return nil }
        guard let stream = fdopendir(copy) else {
            _ = close(copy)
            return nil
        }
        defer { closedir(stream) }
        var names: [String] = []
        while true {
            errno = 0
            guard let entry = readdir(stream) else { return errno == 0 ? names : nil }
            let length = Int(entry.pointee.d_namlen)
            let bytes = withUnsafeBytes(of: entry.pointee.d_name) { Array($0.prefix(length)) }
            guard let name = String(bytes: bytes, encoding: .utf8) else { return nil }
            if name != ".", name != ".." { names.append(name) }
        }
    }

    /// One JSON object, or nil.
    private static func parseJSON(_ data: Data) -> Any? {
        guard let object = try? JSONSerialization.jsonObject(with: data), object is [String: Any] else { return nil }
        return object
    }
}

/// The keys read in a settings object, and what they mean here. Values are
/// looked at only to tell set from unset, and for `forceLoginMethod` and the
/// `env` entries named below; nothing is kept.
enum ClaudeSettingsScan {
    /// Settings that make the CLI run a program: a key, refresh, proxy or
    /// headers helper, or a managed policy helper. Never run here; each is
    /// an unsupported override (`provider-override`).
    static let helperKeys: Set<String> = ["apiKeyHelper", "awsCredentialExport", "awsAuthRefresh", "gcpAuthRefresh",
                                          "proxyAuthHelper", "otelHeadersHelper", "policyHelper", "policyHelpers"]
    /// Settings that route the login or the model elsewhere.
    static let routingKeys: Set<String> = ["forceLoginGatewayUrl", "modelOverrides"]
    /// `env` names that set a provider, base URL, key, token or transport
    /// (the reading's list); also every `ANTHROPIC_` and `CLAUDE_CODE_USE_`
    /// name, conservatively.
    static let providerEnvironmentNames: Set<String> = [
        "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS",
        "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_GATEWAY",
        "ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_FOUNDRY_BASE_URL",
        "ANTHROPIC_AWS_BASE_URL", "ANTHROPIC_GOOGLE_CLOUD_BASE_URL", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
        "ANTHROPIC_AWS_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
        "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_HOST_CREDS_FILE",
        "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_UNIX_SOCKET", "CLAUDE_CODE_CLIENT_DATA_URL"
    ]
    /// `env` names that redirect whose files or account the CLI reads, or
    /// change its retries: the config folder, `HOME`, `USER`, retries and
    /// the retry watchdog.
    static let restrictedEnvironmentNames: Set<String> = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_MAX_RETRIES",
                                                          "CLAUDE_CODE_RETRY_WATCHDOG", "HOME", "USER"]
    /// `env` names that send the CLI's traffic, trust or telemetry elsewhere,
    /// all of which section 11 drops (Codex F3-2): proxies, TLS trust, client
    /// certificates, telemetry export (and every `OTEL_` name) and the
    /// runtime's own options.
    static let routingEnvironmentNames: Set<String> = [
        "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy",
        "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "SSL_CERT_DIR",
        "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY", "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
        "CLAUDE_CODE_ENABLE_TELEMETRY", "NODE_OPTIONS"
    ]
    /// `env` names a source the run reads may set besides section 11's fixed
    /// names with exactly their values: each only turns traffic off (the F1
    /// reading, Q6). Any other name there is unresolved (Codex F3-2):
    /// section 11's environment is an allow-list, and a source the run reads
    /// must not add to it.
    static let runAllowedEnvironmentNames: Set<String> = ["DISABLE_TELEMETRY", "DO_NOT_TRACK", "DISABLE_ERROR_REPORTING",
                                                          "DISABLE_GROWTHBOOK", "DISABLE_UPDATES"]

    /// Who a source applies to. `.managed` (managed, server-managed and
    /// policy sources) and `.globalConfig` also apply to the run, so an
    /// `env` name there that section 11 does not allow is unresolved, and a
    /// managed hook (a program the run would start) is unsupported.
    /// `.authStatusOnly` (user settings) applies only to `auth status`, whose
    /// environment section 11's restrictions cover too (Codex F0 answer 10):
    /// an `env` there that changes a fixed value, redirects or routes is
    /// unresolved (Codex F3-1).
    enum Scope {
        case managed
        case globalConfig
        case authStatusOnly
    }

    static func isProviderEnvironmentName(_ name: String) -> Bool {
        providerEnvironmentNames.contains(name) || name.hasPrefix("ANTHROPIC_") || name.hasPrefix("CLAUDE_CODE_USE_")
    }

    static func isRoutingEnvironmentName(_ name: String) -> Bool {
        routingEnvironmentNames.contains(name) || name.hasPrefix("OTEL_")
    }

    /// Set: present, not null, not an empty string, list or object.
    static func isConfigured(_ value: Any) -> Bool {
        switch value {
        case is NSNull: return false
        case let text as String: return !text.isEmpty
        case let list as [Any]: return !list.isEmpty
        case let object as [String: Any]: return !object.isEmpty
        default: return true
        }
    }

    /// A settings object from a managed, server-managed or policy source,
    /// searched at every depth (its wrapper, if any, is not known).
    static func settings(_ value: Any) -> ClaudeSourceFinding? {
        walk(value, scope: .managed, depth: 0, recursive: true)
    }

    /// `~/.claude/settings.json`: its top level only.
    static func userSettings(_ value: Any) -> ClaudeSourceFinding? {
        walk(value, scope: .authStatusOnly, depth: 0, recursive: false)
    }

    /// `~/.claude.json`: its top-level `env` and `primaryApiKey` (and,
    /// conservatively, any top-level helper key). Its nested objects are
    /// the CLI's own records (MCP servers carry their own `env`, which is
    /// not the CLI's), so they are not searched.
    static func globalConfig(_ value: Any) -> ClaudeSourceFinding? {
        guard let object = value as? [String: Any] else { return .unresolved(.unparseable) }
        if let key = object["primaryApiKey"], isConfigured(key) { return .override(.override) }
        return walk(object, scope: .globalConfig, depth: 0, recursive: false)
    }

    private static func walk(_ value: Any, scope: Scope, depth: Int, recursive: Bool) -> ClaudeSourceFinding? {
        guard depth <= 32 else { return .unresolved(.unsupported) }
        var unresolved: ClaudeSourceFinding?
        func note(_ finding: ClaudeSourceFinding?) -> ClaudeSourceFinding? {
            if case .override? = finding { return finding }
            if unresolved == nil, let finding { unresolved = finding }
            return nil
        }
        if let object = value as? [String: Any] {
            for key in object.keys.sorted() {
                guard let item = object[key] else { continue }
                if helperKeys.contains(key), isConfigured(item) { return .override(.helper) }
                if routingKeys.contains(key), isConfigured(item) { return .override(.override) }
                if key == "forceLoginMethod", let found = note(loginMethod(item)) { return found }
                if key == "env", let found = note(environment(item, scope: scope)) { return found }
                if key == "hooks", scope == .managed, isConfigured(item), let found = note(.unresolved(.unsupported)) {
                    return found
                }
                if recursive, let found = note(walk(item, scope: scope, depth: depth + 1, recursive: true)) { return found }
            }
        } else if let list = value as? [Any], recursive {
            for item in list {
                if let found = note(walk(item, scope: scope, depth: depth + 1, recursive: true)) { return found }
            }
        }
        return unresolved
    }

    /// `forceLoginMethod`: `claudeai` (or unset) keeps the claude.ai login;
    /// `console` or `gateway` (any other name) is an override.
    private static func loginMethod(_ value: Any) -> ClaudeSourceFinding? {
        switch value {
        case is NSNull: return nil
        case let name as String: return name.isEmpty || name == "claudeai" ? nil : .override(.override)
        default: return .unresolved(.unsupported)
        }
    }

    /// An `env` object: a provider name is an override, whatever its value,
    /// in any source. Otherwise unresolved: a fixed name with another value
    /// than section 11's, in any source; in a source the run reads, any name
    /// but the few that only turn traffic off; in user settings (`auth
    /// status` only), a name that redirects or routes. Other names in user
    /// settings never reach the run and are ignored.
    private static func environment(_ value: Any, scope: Scope) -> ClaudeSourceFinding? {
        if value is NSNull { return nil }
        guard let entries = value as? [String: Any] else { return .unresolved(.unsupported) }
        var restricted = false
        for name in entries.keys.sorted() {
            if isProviderEnvironmentName(name) { return .override(.override) }
            if let fixed = CLIEnvironmentRule.fixed.first(where: { $0.name == name }) {
                if entries[name] as? String != fixed.value { restricted = true }
                continue
            }
            switch scope {
            case .managed, .globalConfig:
                if !runAllowedEnvironmentNames.contains(name) { restricted = true }
            case .authStatusOnly:
                if restrictedEnvironmentNames.contains(name) || isRoutingEnvironmentName(name) { restricted = true }
            }
        }
        return restricted ? .unresolved(.restriction) : nil
    }
}
