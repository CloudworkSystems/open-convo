import Darwin
import Foundation
import Testing
@testable import DeskHost
@testable import ParticipantCoordinator
@testable import ParticipantProcess

// Section 5's local checks without processes (plan F3): the two probes'
// readers, the settings scan, the pinned file's refusal rules, the result
// types, the start's recheck, and the inactive gates. Invented values only.

@Suite("Claude local checks: readers, scans, rules and gates (section 5)")
struct ClaudeLocalChecksUnitTests {
    // MARK: Result types

    @Test("The six local reasons map to section 5's, in its order; overflow-unverified is never one; no result is ever available")
    func reasons() {
        #expect(ClaudeLocalFailure.allCases.map(\.reason) == ParticipantUnavailableReason.allCases.filter { $0 != .overflowUnverified })
        #expect(ClaudeLocalFailure.allCases.map(\.rawValue) == ClaudeLocalFailure.allCases.map(\.reason.rawValue))
        for failure in ClaudeLocalFailure.allCases {
            #expect(ClaudeLocalCheckResult.failed(failure).availability == .unavailable(failure.reason))
        }
        var info = stat()
        info.st_ino = 7
        let snapshot = ClaudeLocalSnapshot(cliVersion: "2.1.283", fileIdentity: ClaudeCLIFileIdentity(info),
                                           loginKind: .subscription(.pro),
                                           account: ClaudeAccountComparator(email: "invented@example.invalid", organization: nil,
                                                                            key: Array(repeating: 1, count: 32)))
        #expect(ClaudeLocalCheckResult.passed(snapshot).availability == .unavailable(.overflowUnverified))
        #expect(!ClaudeLocalCheckResult.passed(snapshot).availability.available)
    }

    @Test("The account comparator: equal for the same account and key, different for another account, organization or key; prints nothing")
    func comparator() {
        let key = Array(repeating: UInt8(3), count: 32)
        let a = ClaudeAccountComparator(email: "invented@example.invalid", organization: "invented-org", key: key)
        #expect(a == ClaudeAccountComparator(email: "invented@example.invalid", organization: "invented-org", key: key))
        #expect(a != ClaudeAccountComparator(email: "other@example.invalid", organization: "invented-org", key: key))
        #expect(a != ClaudeAccountComparator(email: "invented@example.invalid", organization: "other-org", key: key))
        #expect(a != ClaudeAccountComparator(email: "invented@example.invalid", organization: nil, key: key))
        #expect(a != ClaudeAccountComparator(email: "invented@example.invalid", organization: "invented-org",
                                             key: Array(repeating: 4, count: 32)))
        #expect(ClaudeAccountComparator(email: "a", organization: "b", key: key) != ClaudeAccountComparator(email: "a\u{0}\u{1}b", organization: nil, key: key),
                "the separator keeps the two fields apart")
        for text in [String(describing: a), String(reflecting: a), "\(a)"] {
            #expect(text == "account-comparator")
        }
        var dumped = ""
        dump(a, to: &dumped)
        #expect(!dumped.contains("invented") && !dumped.contains("digest"), "\(dumped)")
    }

    // MARK: Readers

    @Test("--version: exactly one `<x.y.z> (Claude Code)` line with exit 0; anything else is unreadable with a fixed detail")
    func versionReader() {
        func read(_ probe: ClaudeProbeResult) -> ClaudeVersionAnswer { ClaudeCheckAnswers.version(probe, timeout: .timeout) }
        #expect(read(.exited(0, "2.1.283 (Claude Code)\n")) == .version("2.1.283"))
        #expect(read(.exited(0, "2.1.283 (Claude Code)")) == .version("2.1.283"))
        #expect(read(.exited(0, "2.1.284 (Claude Code)\n")) == .version("2.1.284"))
        for text in ["2.1.283 (Claude Code)\nCommit: 0\n", "2.1.283\n", "v2.1.283 (Claude Code)\n", "2.1 (Claude Code)\n",
                     "2.1.283 (Claude Code)\r\n", "2.1.283  (Claude Code)\n", "2.1.283-beta (Claude Code)\n", " 2.1.283 (Claude Code)\n",
                     "2.1.283 (Claude Code)\n\n", "١.٢.٣ (Claude Code)\n"] {
            #expect(read(.exited(0, text)) == .unreadable(.unparseable), "\(text.debugDescription)")
        }
        #expect(read(ClaudeProbeResult(ending: .exited(0), stdout: Data([0xFF, 0xFE]))) == .unreadable(.unparseable))
        #expect(read(.exited(0, "")) == .unreadable(.emptyOutput))
        #expect(read(.exited(1, "2.1.283 (Claude Code)\n")) == .unreadable(.exitStatus))
        #expect(read(ClaudeProbeResult(ending: .exited(9), stdout: Data("2.1.283 (Claude Code)\n".utf8))) == .unreadable(.exitStatus),
                "killed by a signal")
        #expect(read(ClaudeProbeResult(ending: .timedOut, stdout: Data())) == .unreadable(.timeout))
        #expect(ClaudeCheckAnswers.version(ClaudeProbeResult(ending: .timedOut, stdout: Data()), timeout: .totalTimeout)
                == .unreadable(.totalTimeout))
        #expect(read(ClaudeProbeResult(ending: .outputTooLarge, stdout: Data())) == .unreadable(.outputTooLarge))
        #expect(read(ClaudeProbeResult(ending: .readFailed, stdout: Data())) == .unreadable(.readFailed))
        #expect(read(ClaudeProbeResult(ending: .spawnFailed, stdout: Data())) == .unreadable(.spawnFailed))
        #expect(read(ClaudeProbeResult(ending: .folderFailed, stdout: Data())) == .unreadable(.folderFailed))
    }

    @Test("auth status: provider evidence first (the stored Console key reads claude.ai), then signed-out, not-subscription; every unknown shape check-failed")
    func authReader() {
        let folder = "/invented/home/.claude"
        func read(_ fields: [String: Any], exit: Int32 = 0) -> ClaudeAuthAnswer {
            var fields = fields
            if fields["configDirectory"] == nil { fields["configDirectory"] = folder }
            let data = (try? JSONSerialization.data(withJSONObject: fields)) ?? Data()
            return ClaudeCheckAnswers.authStatus(ClaudeProbeResult(ending: .exited(exit << 8), stdout: data), timeout: .timeout,
                                                 configFolder: folder)
        }
        let plan: [String: Any] = ["loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
                                   "email": "invented@example.invalid", "orgId": "invented-org", "orgName": "Invented",
                                   "subscriptionType": "pro", "analyticsDisabled": true, "configDirectory": folder]
        func with(_ changes: [String: Any?]) -> [String: Any] {
            var fields = plan
            for (key, value) in changes { fields[key] = value }
            return fields
        }
        #expect(read(plan) == .subscription(.pro, email: "invented@example.invalid", organization: "invented-org"))
        #expect(read(with(["orgId": NSNull()])) == .subscription(.pro, email: "invented@example.invalid", organization: nil))
        #expect(read(with(["apiKeySource": NSNull()])) == .subscription(.pro, email: "invented@example.invalid", organization: "invented-org"),
                "a null key source is no key source")
        for (name, plan) in [("pro", ClaudeSubscriptionPlan.pro), ("max", .max), ("team", .team), ("enterprise", .enterprise)] {
            #expect(read(with(["subscriptionType": name])) == .subscription(plan, email: "invented@example.invalid", organization: "invented-org"))
        }
        let override = ClaudeAuthAnswer.failure(.providerOverride, .override)
        #expect(read(with(["apiKeySource": "/login managed key", "subscriptionType": NSNull()])) == override, "stored Console key")
        #expect(read(with(["apiKeySource": "/login managed key"])) == override, "even with a plan")
        #expect(read(with(["apiKeySource": "ANTHROPIC_API_KEY"])) == override)
        for method in ["api_key", "api_key_helper", "oauth_token", "third_party"] {
            #expect(read(with(["authMethod": method])) == override, "\(method)")
        }
        for provider in ["bedrock", "vertex", "foundry", "gateway", "invented-provider"] {
            #expect(read(with(["apiProvider": provider])) == override, "\(provider)")
        }
        #expect(read(["loggedIn": false, "authMethod": "none", "apiProvider": "bedrock"], exit: 1) == override,
                "an override wins over signed-out")
        #expect(read(["loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"], exit: 1) == .failure(.signedOut, .signedOut))
        #expect(read(with(["subscriptionType": nil])) == .failure(.notSubscription, .noSubscription))
        #expect(read(with(["subscriptionType": NSNull()])) == .failure(.notSubscription, .noSubscription))
        // The config folder it reported on (Codex F3-1): the inspected one,
        // a trailing slash aside; another is unknown, after provider evidence.
        #expect(read(with(["configDirectory": folder + "/"])) == .subscription(.pro, email: "invented@example.invalid", organization: "invented-org"))
        #expect(read(with(["configDirectory": "/invented/other-home/.claude"])) == .failure(.checkFailed, .configMismatch))
        #expect(read(["loggedIn": false, "authMethod": "none", "apiProvider": "firstParty", "configDirectory": "/invented/elsewhere"], exit: 1)
                == .failure(.checkFailed, .configMismatch), "logged out of another folder says nothing about this one")
        #expect(read(with(["configDirectory": "/invented/elsewhere", "apiKeySource": "ANTHROPIC_API_KEY"])) == override,
                "provider evidence wins")

        let unknown: [([String: Any], Int32, ClaudeCheckDetail, String)] = [
            (with(["subscriptionType": "invented-plan"]), 0, .unknownPlan, "unknown plan"),
            (with(["email": nil]), 0, .noAccount, "no email"),
            (with(["email": ""]), 0, .noAccount, "empty email"),
            (with(["authMethod": "none"]), 0, .unparseable, "logged in with no method"),
            (with(["authMethod": "invented_method"]), 0, .unparseable, "unknown method"),
            (with(["loggedIn": 1]), 0, .unparseable, "a number for loggedIn"),
            (with(["loggedIn": nil]), 0, .unparseable, "no loggedIn"),
            (with(["apiProvider": nil]), 0, .unparseable, "no provider"),
            (with(["apiKeySource": 5]), 0, .unparseable, "a key source of another type"),
            (with(["subscriptionType": ["max"]]), 0, .unparseable, "a plan of another type"),
            (with(["orgId": 7]), 0, .unparseable, "an organization of another type"),
            (with(["configDirectory": NSNull()]), 0, .unparseable, "no config folder"),
            (with(["configDirectory": 7]), 0, .unparseable, "a config folder of another type"),
            (plan, 1, .exitStatus, "logged in, exit 1"),
            (["loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"], 0, .exitStatus, "logged out, exit 0"),
            (plan, 2, .exitStatus, "exit 2")
        ]
        for (fields, exit, detail, label) in unknown {
            #expect(read(fields, exit: exit) == .failure(.checkFailed, detail), "\(label)")
        }
        func raw(_ text: String) -> ClaudeAuthAnswer {
            ClaudeCheckAnswers.authStatus(.exited(0, text), timeout: .timeout, configFolder: folder)
        }
        #expect(raw("") == .failure(.checkFailed, .emptyOutput))
        #expect(raw("[true]") == .failure(.checkFailed, .unparseable))
        #expect(raw("{\"loggedIn\": tru") == .failure(.checkFailed, .unparseable))
        #expect(raw("\u{1B}[32m{}\u{1B}[0m") == .failure(.checkFailed, .unparseable), "colored output is not JSON")
        #expect(ClaudeCheckAnswers.authStatus(ClaudeProbeResult(ending: .timedOut, stdout: Data()), timeout: .totalTimeout,
                                              configFolder: folder) == .failure(.checkFailed, .totalTimeout))
        #expect(ClaudeCheckAnswers.authStatus(ClaudeProbeResult(ending: .exited(9), stdout: Data("{}".utf8)), timeout: .timeout,
                                              configFolder: folder) == .failure(.checkFailed, .exitStatus), "killed by a signal")
    }

    // MARK: Settings scans

    @Test("The settings scan: helpers and routing keys are overrides when set; provider env names whatever their value; where the run reads, only fixed values and traffic-off names; in user settings, fixed values, redirects and routing unresolved")
    func settingsScan() {
        let helper: ClaudeSourceFinding = .override(.helper)
        let override: ClaudeSourceFinding = .override(.override)
        let restriction: ClaudeSourceFinding = .unresolved(.restriction)
        for key in ClaudeSettingsScan.helperKeys {
            #expect(ClaudeSettingsScan.settings([key: "/invented/helper"]) == helper, "\(key)")
            #expect(ClaudeSettingsScan.userSettings([key: "/invented/helper"]) == helper, "\(key)")
            #expect(ClaudeSettingsScan.globalConfig([key: "/invented/helper"]) == helper, "\(key)")
            for unset in [NSNull(), "", [Any](), [String: Any]()] as [Any] {
                #expect(ClaudeSettingsScan.settings([key: unset]) == nil, "\(key) unset")
            }
        }
        for key in ClaudeSettingsScan.routingKeys {
            #expect(ClaudeSettingsScan.settings([key: "invented"]) == override, "\(key)")
        }
        #expect(ClaudeSettingsScan.settings(["forceLoginMethod": "claudeai"]) == nil)
        #expect(ClaudeSettingsScan.settings(["forceLoginMethod": "console"]) == override)
        #expect(ClaudeSettingsScan.settings(["forceLoginMethod": "gateway"]) == override)
        #expect(ClaudeSettingsScan.settings(["forceLoginMethod": 1]) == .unresolved(.unsupported))
        for name in ClaudeSettingsScan.providerEnvironmentNames.sorted() + ["ANTHROPIC_MODEL", "CLAUDE_CODE_USE_INVENTED"] {
            for value in ["1", "0", ""] {
                #expect(ClaudeSettingsScan.settings(["env": [name: value]]) == override, "\(name)=\(value)")
                #expect(ClaudeSettingsScan.userSettings(["env": [name: value]]) == override, "\(name)=\(value)")
                #expect(ClaudeSettingsScan.globalConfig(["env": [name: value]]) == override, "\(name)=\(value)")
            }
        }
        // Where the run reads (managed, ~/.claude.json): an allow-list
        // (Codex F3-2). Traffic-off names pass; any other name is unresolved.
        for name in ClaudeSettingsScan.runAllowedEnvironmentNames {
            #expect(ClaudeSettingsScan.settings(["env": [name: "1"]]) == nil, "\(name) only turns traffic off")
            #expect(ClaudeSettingsScan.globalConfig(["env": [name: "0"]]) == nil, "\(name) only turns traffic off")
        }
        let routing = ["HTTPS_PROXY", "http_proxy", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED",
                       "SSL_CERT_FILE", "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY", "CLAUDE_CODE_ENABLE_TELEMETRY",
                       "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_LOG_USER_PROMPTS", "NODE_OPTIONS"]
        for name in ["OPENAI_API_KEY", "INVENTED_FLAG", "BASH_DEFAULT_TIMEOUT_MS"] + routing {
            #expect(ClaudeSettingsScan.settings(["env": [name: "1"]]) == restriction, "\(name) where the run reads it")
            #expect(ClaudeSettingsScan.globalConfig(["env": [name: "1"]]) == restriction, "\(name) in ~/.claude.json")
        }
        // User settings (auth status only, Codex F3-1): redirects and routing
        // are unresolved; names that never reach the run are ignored.
        for name in routing + Array(ClaudeSettingsScan.restrictedEnvironmentNames) {
            #expect(ClaudeSettingsScan.userSettings(["env": [name: "invented"]]) == restriction, "\(name) in user settings")
        }
        for name in ["OPENAI_API_KEY", "INVENTED_FLAG", "BASH_DEFAULT_TIMEOUT_MS", "DISABLE_TELEMETRY"] {
            #expect(ClaudeSettingsScan.userSettings(["env": [name: "1"]]) == nil, "\(name) never reaches the run")
        }
        for fixed in Invented.fixedEnvironment {
            let parts = fixed.split(separator: "=", maxSplits: 1).map(String.init)
            #expect(ClaudeSettingsScan.settings(["env": [parts[0]: parts[1]]]) == nil, "\(fixed) unchanged")
            #expect(ClaudeSettingsScan.userSettings(["env": [parts[0]: parts[1]]]) == nil, "\(fixed) unchanged")
            for changed in ["invented", ""] {
                #expect(ClaudeSettingsScan.settings(["env": [parts[0]: changed]]) == restriction, "\(parts[0]) changed")
                #expect(ClaudeSettingsScan.globalConfig(["env": [parts[0]: changed]]) == restriction, "\(parts[0]) changed")
                #expect(ClaudeSettingsScan.userSettings(["env": [parts[0]: changed]]) == restriction,
                        "\(parts[0]) changed for auth status (answer 10)")
            }
        }
        for name in ClaudeSettingsScan.restrictedEnvironmentNames {
            #expect(ClaudeSettingsScan.settings(["env": [name: "invented"]]) == restriction, "\(name)")
        }
        #expect(ClaudeSettingsScan.settings(["env": ["CLAUDE_CODE_MAX_RETRIES": "9", "ANTHROPIC_BASE_URL": "x"]]) == override,
                "an override wins over a restriction")
        #expect(ClaudeSettingsScan.settings(["env": "invented"]) == .unresolved(.unsupported))
        #expect(ClaudeSettingsScan.settings(["env": NSNull()]) == nil)
        #expect(ClaudeSettingsScan.settings(["hooks": ["Stop": [["command": "/invented"]]]]) == .unresolved(.unsupported))
        #expect(ClaudeSettingsScan.userSettings(["hooks": ["Stop": [["command": "/invented"]]]]) == nil)
        #expect(ClaudeSettingsScan.settings(["hooks": [String: Any]()]) == nil)
        // Managed sources are searched at any depth; the global config and
        // user settings at the top only.
        let nested: [String: Any] = ["wrapper": ["list": [["env": ["ANTHROPIC_API_KEY": "invented"]]]]]
        #expect(ClaudeSettingsScan.settings(nested) == override)
        #expect(ClaudeSettingsScan.globalConfig(["mcpServers": ["invented": ["env": ["ANTHROPIC_API_KEY": "invented"]]]]) == nil)
        #expect(ClaudeSettingsScan.userSettings(["invented": ["apiKeyHelper": "/invented"]]) == nil)
        #expect(ClaudeSettingsScan.settings(["invented": ["apiKeyHelper": "/invented"]]) == helper)
        #expect(ClaudeSettingsScan.globalConfig(["primaryApiKey": "invented"]) == override)
        #expect(ClaudeSettingsScan.globalConfig(["primaryApiKey": ""]) == nil)
        #expect(ClaudeSettingsScan.globalConfig(["primaryApiKey": NSNull()]) == nil)
        var deep: Any = ["apiKeyHelper": "/invented"]
        for _ in 0..<40 { deep = ["level": deep] }
        #expect(ClaudeSettingsScan.settings(deep) == .unresolved(.unsupported), "too deep to rule out")
        #expect(ClaudeSettingsScan.settings(["hooks": ["x": 1], "apiKeyHelper": "/invented"]) == helper,
                "an override wins over an unresolved key in the same source")
    }

    // MARK: The pinned file's rules (answer 9)

    @Test("Refusal rules for the folders and the version file, foreign owner included")
    func refusalRules() {
        let me = getuid()
        func info(_ type: mode_t, _ mode: mode_t, owner: uid_t = getuid()) -> stat {
            var value = stat()
            value.st_mode = type | mode
            value.st_uid = owner
            return value
        }
        #expect(ClaudePinnedBinary.fileRefusal(info(S_IFREG, 0o755), owner: me) == nil)
        #expect(ClaudePinnedBinary.fileRefusal(info(S_IFREG, 0o700), owner: me) == nil)
        #expect(ClaudePinnedBinary.fileRefusal(info(S_IFREG, 0o755, owner: me &+ 1), owner: me) == .notOwned)
        #expect(ClaudePinnedBinary.fileRefusal(info(S_IFREG, 0o755, owner: 0), owner: me) == .notOwned)
        #expect(ClaudePinnedBinary.fileRefusal(info(S_IFREG, 0o775), owner: me) == .writable)
        #expect(ClaudePinnedBinary.fileRefusal(info(S_IFREG, 0o757), owner: me) == .writable)
        #expect(ClaudePinnedBinary.fileRefusal(info(S_IFREG, 0o644), owner: me) == .notExecutable)
        #expect(ClaudePinnedBinary.fileRefusal(info(S_IFREG, 0o4755), owner: me) == .specialMode)
        #expect(ClaudePinnedBinary.fileRefusal(info(S_IFREG, 0o2755), owner: me) == .specialMode)
        #expect(ClaudePinnedBinary.fileRefusal(info(S_IFLNK, 0o755), owner: me) == .linked)
        #expect(ClaudePinnedBinary.fileRefusal(info(S_IFDIR, 0o755), owner: me) == .notRegular)
        #expect(ClaudePinnedBinary.fileRefusal(info(S_IFIFO, 0o755), owner: me) == .notRegular)
        #expect(ClaudePinnedBinary.folderRefusal(info(S_IFDIR, 0o755), owner: me) == nil)
        #expect(ClaudePinnedBinary.folderRefusal(info(S_IFDIR, 0o750), owner: me) == nil)
        #expect(ClaudePinnedBinary.folderRefusal(info(S_IFDIR, 0o755, owner: me &+ 1), owner: me) == .notOwned)
        #expect(ClaudePinnedBinary.folderRefusal(info(S_IFDIR, 0o775), owner: me) == .writable)
        #expect(ClaudePinnedBinary.folderRefusal(info(S_IFDIR, 0o777), owner: me) == .writable)
        #expect(ClaudePinnedBinary.folderRefusal(info(S_IFREG, 0o755), owner: me) == .notRegular)
    }

    @Test("Paths: the pin is the exact version file under the roots' home, four folders down; the sources sit where the reading says; the production roots come from the user database")
    func paths() throws {
        let roots = ClaudeCheckRoots(home: "/invented/home", userName: "invented-user", owner: 501, managedSettingsFolder: "/invented/managed",
                                     managedPreferencesFolder: "/invented/preferences",
                                     probeParent: URL(fileURLWithPath: "/invented/work"), gitSearchTop: "/invented")
        let components = roots.binaryPath.split(separator: "/").map(String.init)
        #expect(roots.binaryPath.hasPrefix("/invented/home/"))
        #expect(components.count == 2 + 4 + 1)
        #expect(components.last == ParticipantCommandLine.pinnedCLIVersion, "the version file itself, never a launcher link")
        #expect(components[2].hasPrefix(".") && components[5] == "versions")
        #expect(roots.path(.managedFile) == "/invented/managed/managed-settings.json")
        #expect(roots.path(.managedDropIn) == "/invented/managed/managed-settings.d")
        #expect(roots.path(.userPreferences) == "/invented/preferences/invented-user/com.anthropic.claudecode.plist")
        #expect(roots.path(.devicePreferences) == "/invented/preferences/com.anthropic.claudecode.plist")
        #expect(roots.path(.remoteSettings) == "/invented/home/.claude/remote-settings.json")
        #expect(roots.path(.policyLimits) == "/invented/home/.claude/policy-limits.json")
        #expect(roots.path(.globalConfig) == "/invented/home/.claude.json")
        #expect(roots.path(.legacyGlobalConfig) == "/invented/home/.claude/.config.json")
        #expect(roots.path(.userSettings) == "/invented/home/.claude/settings.json")
        #expect(roots.path(.environment) == nil && roots.path(.authStatus) == nil && roots.path(.localSettings) == nil)
        #expect(ClaudeCheckSource.settingsSources.count == 10 && ClaudeCheckSource.settingsSources.last == .localSettings)
        #expect(ClaudeCheckRoots.systemManagedSettingsFolder == "/Library/Application Support/ClaudeCode")
        #expect(ClaudeCheckRoots.systemManagedPreferencesFolder == "/Library/Managed Preferences")

        // Only builds paths: the user database, never $HOME, and no file read
        // (the one call of it anywhere; Sources never calls it).
        let production = try #require(ClaudeCheckRoots.forCurrentUser(probeParent: URL(fileURLWithPath: "/invented/work")))
        var entry = passwd()
        var result: UnsafeMutablePointer<passwd>?
        var buffer = [CChar](repeating: 0, count: 16_384)
        #expect(getpwuid_r(getuid(), &entry, &buffer, buffer.count, &result) == 0)
        #expect(production.home == String(cString: entry.pw_dir) && production.userName == String(cString: entry.pw_name))
        #expect(production.owner == getuid())
        #expect(production.managedSettingsFolder == ClaudeCheckRoots.systemManagedSettingsFolder)
        #expect(production.managedPreferencesFolder == ClaudeCheckRoots.systemManagedPreferencesFolder)
        #expect(production.gitSearchTop == "/", "the git walk goes all the way up in production")
    }

    // MARK: The start's recheck (section 7 step 13)

    @Test("Every start rechecks: participant.availability asks report(), a start's step 13 asks recheck(); CheckedAvailability passes each through")
    func startRechecks() async throws {
        let world = try await ParticipantCoordinatorStartTests.oneRun()
        defer { world.clean() }
        world.launcher.prepare(script: ParticipantCoordinatorStartTests.script)
        let reporter = CountingReporter()
        world.availability.set(reporter)
        let availability = await ParticipantCoordinatorStartTests.send(world, .participantAvailability, [:])
        #expect(availability.outcome == .ok)
        #expect(reporter.counts == (1, 0))
        #expect(await ParticipantCoordinatorStartTests.send(world, .participantStart, ParticipantCoordinatorStartTests.start()).outcome == .ok)
        #expect(reporter.counts == (1, 1), "the start's recheck, never a reused report")
        try await world.settle()

        let checker = CountingChecker()
        let checked = CheckedAvailability(checker: checker)
        #expect(await checked.report().availability == .unavailable(.signedOut))
        #expect(await checked.recheck().availability == .unavailable(.notSubscription))
        #expect(checker.counts == (1, 1))
        // Every checker and reporter implements it; none has a default (F3-9).
        #expect(await ShippingAvailability().recheck() == .unavailable(.overflowUnverified))
        let shipping = await CheckedAvailability(checker: ShippingAvailability()).recheck()
        #expect(shipping == ParticipantAvailabilityReport(availability: .unavailable(.overflowUnverified), confirmation: nil))
    }

    // MARK: Inactive gates

    @Test("Inactive: only the test-only probe constructs ClaudeLocalChecks or names the tests' auth status gate, nothing in Sources calls forCurrentUser, the checks run nothing but the pin and read no Keychain, and no recheck has a default")
    func inactiveGates() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources")
        let files = try #require(FileManager.default.subpaths(atPath: sources.path)).filter { $0.hasSuffix(".swift") }
        var lines: [(file: String, line: String)] = []
        for relative in files {
            let text = try String(contentsOf: sources.appendingPathComponent(relative), encoding: .utf8)
            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                let code = line.trimmingCharacters(in: .whitespaces)
                if !code.hasPrefix("//") { lines.append((relative, code)) }
            }
        }
        #expect(lines.count > 1_000, "the scan read the sources")
        let constructions = lines.filter { $0.line.contains("ClaudeLocalChecks(") || $0.line.contains("ClaudeLocalChecks.init") }
        // The test-only probe makes two: the tests' gate, and the public
        // initializer's (which runs auth status with its network blocked,
        // the owner's D1 decision).
        #expect(constructions.map(\.file) == Array(repeating: "ParticipantTestFakes/AvailabilityProbe/main.swift", count: 2),
                "\(constructions)")
        // Only the test-only probe names the tests' step 4 gate (Codex
        // F34-D1); the public initializer blocks the network, through the
        // system's tool only.
        let runsAuthStatus = lines.filter { $0.line.contains(".runForTests") || $0.line.contains("runForTests)") }
        #expect(runsAuthStatus.map(\.file) == ["ParticipantTestFakes/AvailabilityProbe/main.swift"], "\(runsAuthStatus)")
        #expect(lines.filter { $0.line.contains("authStatus: .production") }.map(\.file) == ["ParticipantProcess/ClaudeLocalChecks.swift"])
        let tools = lines.filter { $0.line.contains("ClaudeNetworkBlock(toolPath:") }
        #expect(tools.map(\.line) == ["package static let system = ClaudeNetworkBlock(toolPath: \"/usr/bin/sandbox-exec\")"], "\(tools)")
        let production = lines.filter { $0.line.contains("forCurrentUser(") }
        #expect(production.map(\.line) == ["public static func forCurrentUser(probeParent: URL) -> ClaudeCheckRoots? {"],
                "declared, never called: \(production)")

        let checkFiles = files.filter { $0.hasPrefix("ParticipantProcess/Claude") }
        #expect(Set(checkFiles) == ["ParticipantProcess/ClaudeLocalChecks.swift", "ParticipantProcess/ClaudeCheckRun.swift",
                                    "ParticipantProcess/ClaudeCheckProbe.swift", "ParticipantProcess/ClaudeCheckSources.swift",
                                    "ParticipantProcess/ClaudeCheckAnswers.swift", "ParticipantProcess/ClaudeCheckLog.swift"])
        let checkLines = lines.filter { checkFiles.contains($0.file) }
        let spawns = checkLines.filter { $0.line.contains("posix_spawn(") }
        #expect(spawns.map(\.line) == ["guard posix_spawn(&pid, executable, &actions, &attributes, argv, envp) == 0, pid > 0 else { return nil }"],
                "one spawn: of the pinned file, or of the network block's tool running it")
        #expect(checkLines.filter { $0.line.hasPrefix("let executable = ") }.map(\.line)
                    == ["let executable = networkBlock?.toolPath ?? binaryPath"])
        for forbidden in ["Process(", "NSTask", "system(", "popen(", "execv", "execl", "fork(", "import Security", "SecItem",
                          "SecKeychain", "LAContext", "LocalAuthentication", "URLSession", "getenv(", "@_spi", "#if"] {
            #expect(!checkLines.contains { $0.line.contains(forbidden) }, "\(forbidden)")
        }
        let environmentReads = checkLines.filter { $0.line.contains("ProcessInfo") }
        #expect(environmentReads.map(\.line)
                    == ["let probeEnvironment = ParticipantEnvironment.build(from: environment ?? ProcessInfo.processInfo.environment)"],
                "the app's environment only ever reaches the probes through section 11's rule")
        #expect(!checkLines.contains { $0.line.contains("\"HOME\"]") }, "the pin never comes from $HOME")
        // A start's recheck has no default anywhere (Codex F3-9): every
        // checker and reporter says what a start gets.
        #expect(!lines.contains { $0.line.hasPrefix("extension AvailabilityChecking") || $0.line.hasPrefix("extension AvailabilityReporting") },
                "no protocol extension can give a reused recheck")
    }
}
