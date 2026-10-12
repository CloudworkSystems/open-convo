/// The CLI's environment rule (contract section 11), shared by the app,
/// which builds the supervisor's environment with it, and the supervisor,
/// which applies it again to its own environment before spawning the CLI:
/// the Swift runtime's CoreFoundation adds `__CF_USER_TEXT_ENCODING` to a
/// process's environment at load, so passing `environ` on unfiltered would
/// hand the CLI a variable the app never chose.
///
/// The section 5 availability checks (`--version`, `auth status`) are not
/// built yet (F3). When they are, they take their environment from this same
/// rule, fixed values included (Codex F0 answer 10).
public enum CLIEnvironmentRule {
    public static let path = "/usr/bin:/bin:/usr/sbin:/sbin"
    /// Passed through from the app's environment when present and nonempty.
    public static let passedNames = ["HOME", "USER", "TMPDIR", "LANG", "LC_ALL"]
    /// Always set, to exactly these values, whatever the incoming entries
    /// hold: an inherited value for one of these names, different or the
    /// same, is dropped and this one used. After `PATH`, Codex F0 answer 10's
    /// four switches: no nonessential traffic (telemetry, update checks), no
    /// auto-update, no `@` file attachments, no claude.ai MCP connectors.
    /// They do not make the CLI network-silent: a login refresh and the model
    /// request still reach Anthropic.
    public static let fixed: [(name: String, value: String)] = [
        ("PATH", path),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
        ("DISABLE_AUTOUPDATER", "1"),
        ("CLAUDE_CODE_DISABLE_ATTACHMENTS", "1"),
        ("ENABLE_CLAUDEAI_MCP_SERVERS", "false")
    ]

    /// `NAME=value` entries in a fixed order: each passed name's first
    /// nonempty value without a NUL byte, then every fixed entry.
    public static func apply(to entries: [String]) -> [String] {
        var values: [String: String] = [:]
        for entry in entries {
            guard let equals = entry.firstIndex(of: "=") else { continue }
            let name = String(entry[..<equals])
            let value = String(entry[entry.index(after: equals)...])
            if values[name] == nil { values[name] = value }
        }
        var result: [String] = []
        for name in passedNames {
            guard let value = values[name], !value.isEmpty, !value.utf8.contains(0) else { continue }
            result.append("\(name)=\(value)")
        }
        result += fixed.map { "\($0.name)=\($0.value)" }
        return result
    }
}
