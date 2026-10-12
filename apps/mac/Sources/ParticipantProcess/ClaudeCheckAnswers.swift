import Darwin
import Foundation

// What the two probes printed, as section 5 reads it (shapes predicted by
// the F1 reading, Q3; never confirmed by a run). Only the fields named here
// are read; everything else, and the output itself, is dropped. An output
// of any other shape is `check-failed`.

enum ClaudeVersionAnswer: Equatable, Sendable {
    case version(String)
    case unreadable(ClaudeCheckDetail)
}

enum ClaudeAuthAnswer: Equatable, Sendable {
    case failure(ClaudeLocalFailure, ClaudeCheckDetail)
    /// A claude.ai plan login: the plan, and the account and organization
    /// the opaque comparator is made from (then dropped).
    case subscription(ClaudeSubscriptionPlan, email: String, organization: String?)
}

enum ClaudeCheckAnswers {
    /// The `authMethod` values the reading lists.
    static let knownAuthMethods: Set<String> = ["none", "third_party", "claude.ai", "api_key_helper", "oauth_token", "api_key"]
    /// Methods that are themselves a key, helper, token or other provider.
    static let overrideAuthMethods: Set<String> = ["third_party", "api_key_helper", "oauth_token", "api_key"]

    /// The probe's own failures, as fixed details.
    private static func probeFailure(_ ending: ClaudeProbeResult.Ending, timeout: ClaudeCheckDetail) -> ClaudeCheckDetail? {
        switch ending {
        case .timedOut: return timeout
        case .outputTooLarge: return .outputTooLarge
        case .readFailed: return .readFailed
        case .spawnFailed: return .spawnFailed
        case .folderFailed: return .folderFailed
        case .exited: return nil
        }
    }

    /// The exit code of a normal exit, nil after a signal.
    static func exitCode(_ status: Int32) -> Int32? {
        let decoded = ParticipantWaitStatus.decode(status)
        return decoded.signal == nil ? decoded.exitCode : nil
    }

    /// `--version`: exit 0 and exactly one line, `<version> (Claude Code)`,
    /// the version three dot-separated numbers.
    static func version(_ probe: ClaudeProbeResult, timeout: ClaudeCheckDetail) -> ClaudeVersionAnswer {
        if let failure = probeFailure(probe.ending, timeout: timeout) { return .unreadable(failure) }
        guard case .exited(let status) = probe.ending, exitCode(status) == 0 else { return .unreadable(.exitStatus) }
        guard !probe.stdout.isEmpty else { return .unreadable(.emptyOutput) }
        guard let text = String(data: probe.stdout, encoding: .utf8) else { return .unreadable(.unparseable) }
        var line = Substring(text)
        if line.hasSuffix("\n") { line = line.dropLast() }
        let suffix = " (Claude Code)"
        guard !line.contains("\n"), !line.contains("\r"), line.hasSuffix(suffix) else { return .unreadable(.unparseable) }
        let version = String(line.dropLast(suffix.count))
        let parts = version.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts.allSatisfy({ !$0.isEmpty && $0.count <= 9 && $0.allSatisfy { $0.isASCII && $0.isNumber } }) else {
            return .unreadable(.unparseable)
        }
        return .version(version)
    }

    /// `auth status --json`, in order: the probe ended with exit 0 or 1;
    /// one JSON object whose read fields have their types (`configDirectory`
    /// always present, the reading says); `loggedIn` agrees with the exit
    /// code; provider evidence is `provider-override` (the stored Console
    /// key quirk: a claude.ai method with any `apiKeySource` is one); a
    /// `configDirectory` other than `configFolder` is unknown (it reported
    /// on a config folder the checks did not inspect, Codex F3-1); logged
    /// out is `signed-out`; a logged-in method other than claude.ai is
    /// unknown; no plan is `not-subscription`; an unknown plan or a missing
    /// account is unknown.
    static func authStatus(_ probe: ClaudeProbeResult, timeout: ClaudeCheckDetail, configFolder: String) -> ClaudeAuthAnswer {
        func unknown(_ detail: ClaudeCheckDetail) -> ClaudeAuthAnswer { .failure(.checkFailed, detail) }
        if let failure = probeFailure(probe.ending, timeout: timeout) { return unknown(failure) }
        guard case .exited(let status) = probe.ending, let code = exitCode(status), code == 0 || code == 1 else {
            return unknown(.exitStatus)
        }
        guard !probe.stdout.isEmpty else { return unknown(.emptyOutput) }
        guard let object = (try? JSONSerialization.jsonObject(with: probe.stdout)) as? [String: Any],
              let loggedIn = boolean(object["loggedIn"]),
              let authMethod = object["authMethod"] as? String, knownAuthMethods.contains(authMethod),
              let apiProvider = object["apiProvider"] as? String,
              let apiKeySource = optionalString(object["apiKeySource"]),
              let subscriptionType = optionalString(object["subscriptionType"]),
              let email = optionalString(object["email"]),
              let organization = optionalString(object["orgId"]),
              let configDirectory = object["configDirectory"] as? String else {
            return unknown(.unparseable)
        }
        guard loggedIn == (code == 0) else { return unknown(.exitStatus) }
        if apiProvider != "firstParty" || apiKeySource.value != nil || overrideAuthMethods.contains(authMethod) {
            return .failure(.providerOverride, .override)
        }
        guard ClaudeSourceInspector.trimmed(configDirectory) == ClaudeSourceInspector.trimmed(configFolder) else {
            return unknown(.configMismatch)
        }
        guard loggedIn else { return .failure(.signedOut, .signedOut) }
        guard authMethod == "claude.ai" else { return unknown(.unparseable) }
        guard let planName = subscriptionType.value else { return .failure(.notSubscription, .noSubscription) }
        guard let plan = ClaudeSubscriptionPlan(rawValue: planName) else { return unknown(.unknownPlan) }
        guard let address = email.value, !address.isEmpty else { return unknown(.noAccount) }
        return .subscription(plan, email: address, organization: organization.value.flatMap { $0.isEmpty ? nil : $0 })
    }

    /// A JSON `true` or `false`; never a number.
    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    /// A string field that may be absent or null: `.value` nil then. Nil
    /// (the whole answer unknown) when present with another type.
    private struct OptionalField {
        let value: String?
    }

    private static func optionalString(_ value: Any?) -> OptionalField? {
        switch value {
        case nil, is NSNull: return OptionalField(value: nil)
        case let text as String: return OptionalField(value: text)
        default: return nil
        }
    }
}
