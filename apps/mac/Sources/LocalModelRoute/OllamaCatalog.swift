import Foundation

// Contract section 20.1-20.2: which of Ollama's models the local route lists,
// and how. Pure: it reads one `/api/tags` body and touches nothing else.

/// One listed chat model. `model` is the name, `@` and the 64-hex digest.
public struct LocalModelEntry: Equatable, Sendable {
    public let name: String
    public let digest: String
    /// False for a `:cloud` or remote model: listed, never available.
    public let isLocal: Bool

    public var id: String { LocalRoute.participantId }
    public var label: String { name }
    public var model: String { "\(name)@\(digest)" }
    public var executionHost: String { LocalRoute.executionHost }
}

/// Route-level reasons (section 20.2).
public enum LocalRouteReason: String, Sendable, CaseIterable {
    case ollamaNotRunning = "ollama-not-running"
    case catalogUnreadable = "catalog-unreadable"
    case catalogTooLarge = "catalog-too-large"
    case hostNotLoopback = "host-not-loopback"
}

public enum LocalCatalog: Equatable, Sendable {
    case ready([LocalModelEntry])
    case unavailable(LocalRouteReason)
}

public enum LocalRoute {
    public static let participantId = "ollama-local"
    public static let executionHost = "this-mac"
    /// More listed models than this makes the route `catalog-too-large`
    /// rather than leaving any out (Codex round 4 on #38): a saved choice is
    /// never hidden behind a cut-off list.
    public static let maxEntries = 256
    public static let maxFieldBytes = 256
}

public enum OllamaCatalog {
    /// Reads `/api/tags`. Anything that isn't a valid model list is
    /// `catalog-unreadable`; a list with more chat models than
    /// `LocalRoute.maxEntries` is `catalog-too-large`.
    public static func parse(_ body: Data) -> LocalCatalog {
        guard let root = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let models = root["models"] as? [Any] else { return .unavailable(.catalogUnreadable) }
        var entries: [LocalModelEntry] = []
        var names = Set<String>()
        for item in models {
            guard let model = item as? [String: Any], let name = model["name"] as? String,
                  !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return .unavailable(.catalogUnreadable)
            }
            guard names.insert(name).inserted else { return .unavailable(.catalogUnreadable) }
            // Native's own per-run aliases are never entries (20.1, exact format only).
            if OllamaAlias.isAlias(name) { continue }
            guard let capabilities = model["capabilities"] as? [Any],
                  capabilities.contains(where: { ($0 as? String) == "completion" }) else { continue }
            guard let digest = model["digest"] as? String, isDigest(digest) else { continue }
            let entry = LocalModelEntry(name: name, digest: digest,
                                        isLocal: model["remote_host"] == nil && model["remote_model"] == nil
                                            && !name.hasSuffix(":cloud"))
            // A name too long for the four 256-byte fields has no usable identity.
            guard entry.model.utf8.count <= LocalRoute.maxFieldBytes else { continue }
            entries.append(entry)
        }
        guard entries.count <= LocalRoute.maxEntries else { return .unavailable(.catalogTooLarge) }
        return .ready(entries.sorted { codePointBefore($0.name, $1.name) })
    }

    static func isDigest(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }

    /// Code-point order (section 20.2), not UTF-16 or locale order.
    static func codePointBefore(_ a: String, _ b: String) -> Bool {
        a.unicodeScalars.lexicographicallyPrecedes(b.unicodeScalars) { $0.value < $1.value }
    }
}

/// Native's private per-run alias (section 20.4): exactly
/// `open-convo-run-<lowercase v4 run id without dashes>:pin`.
public enum OllamaAlias {
    private static let pattern = try! NSRegularExpression(
        pattern: "\\Aopen-convo-run-[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}:pin\\z")
    private static let runIdPattern = try! NSRegularExpression(
        pattern: "\\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\z")

    /// The alias for a run, or nil when `runId` isn't a lowercase v4 id.
    public static func name(forRunId runId: String) -> String? {
        guard matches(runIdPattern, runId) else { return nil }
        return "open-convo-run-\(runId.replacingOccurrences(of: "-", with: "")):pin"
    }

    /// True only for the exact generated format; an owner's own tag that
    /// merely starts `open-convo-run-` is never native's.
    public static func isAlias(_ name: String) -> Bool { matches(pattern, name) }

    private static func matches(_ regex: NSRegularExpression, _ value: String) -> Bool {
        regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }
}
