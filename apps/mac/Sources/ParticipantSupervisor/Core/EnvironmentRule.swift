/// The CLI's environment rule (contract section 11), shared by the app,
/// which builds the supervisor's environment with it, and the supervisor,
/// which applies it again to its own environment before spawning the CLI:
/// the Swift runtime's CoreFoundation adds `__CF_USER_TEXT_ENCODING` to a
/// process's environment at load, so passing `environ` on unfiltered would
/// hand the CLI a variable the app never chose.
public enum CLIEnvironmentRule {
    public static let path = "/usr/bin:/bin:/usr/sbin:/sbin"
    /// Passed through from the app's environment when present and nonempty.
    public static let passedNames = ["HOME", "USER", "TMPDIR", "LANG", "LC_ALL"]

    /// `NAME=value` entries in a fixed order: each passed name's first
    /// nonempty value without a NUL byte, then the fixed `PATH`.
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
        result.append("PATH=\(path)")
        return result
    }
}
