import Darwin
import Foundation
@testable import ParticipantProcess
import Testing

// Section 5's real local checks (plan F3; Codex F0 answers 9, 10 and 11),
// with the fake CLI copied into invented trees (ClaudeLocalChecksSupport).
// Every check here starts processes, so these run one at a time in the
// serialized process suite. Never the real CLI, the real home or managed
// folders, the Keychain or the network; each test asserts that every path
// the checks touched (as requested) is inside its temporary folder, and the
// two that run the test-only probe have it count the paths it touched
// outside its working folder (none).

extension ProcessSuites {
    @Suite("Claude local checks with the fake CLI (section 5)")
    struct LocalChecks {
        // MARK: Passing

        @Test("All checks pass: an in-memory snapshot, still overflow-unverified; exact probe argv, environment, folder, descriptors, closed stdin and own group; nothing outside the tree touched")
        func passes() async throws {
            let tree = try InventedClaudeTree()
            defer { tree.clean() }
            let checks = tree.checks()
            let result = await checks.evaluateFresh()
            let snapshot = try #require(result.snapshot, "\(result)")
            #expect(snapshot.cliVersion == ParticipantCommandLine.pinnedCLIVersion)
            var info = stat()
            #expect(lstat(tree.binaryPath, &info) == 0)
            #expect(snapshot.fileIdentity == ClaudeCLIFileIdentity(info), "device, inode, size, mtime and ctime of the version file")
            #expect(snapshot.loginKind == .subscription(.max))
            #expect(result.availability == .unavailable(.overflowUnverified), "never available on its own")
            #expect(await checks.check() == .unavailable(.overflowUnverified))
            #expect(await checks.recheck() == .unavailable(.overflowUnverified))
            #expect(await checks.evaluateFresh().snapshot?.account == snapshot.account, "the same account, the same checks object")
            let other = await tree.checks().evaluateFresh()
            #expect(other.snapshot != nil && other.snapshot?.account != snapshot.account, "never equal across checks objects")
            #expect(String(describing: snapshot.account) == "account-comparator")
            #expect(String(reflecting: snapshot.account) == "account-comparator")
            #expect(Mirror(reflecting: snapshot.account).children.isEmpty, "the comparator shows nothing")

            let version = try #require(tree.record("version.json"))
            let auth = try #require(tree.record("auth-status.json"))
            #expect(version["argv"] as? [String] == ["--version"])
            #expect(auth["argv"] as? [String] == ["auth", "status", "--json"])
            let expected = ["HOME=\(tree.home.path)", "USER=invented-user", "TMPDIR=\(tree.temporary.path)/",
                            "LANG=en_US.UTF-8"] + Invented.fixedEnvironment
            for (name, record) in [("version", version), ("auth status", auth)] {
                let environment = record["env"] as? [String] ?? []
                #expect(Set(environment) == Set(expected) && environment.count == expected.count,
                        "\(name): section 11's environment exactly, dropped names absent: \(environment)")
                #expect(record["fds"] as? [Int] == [0, 1, 2], "\(name): stdin, stdout and stderr only")
                #expect(record["stdinState"] as? String == "eof", "\(name): stdin is closed")
                #expect(record["pid"] as? Int != nil && record["pid"] as? Int == record["pgid"] as? Int, "\(name): its own group")
                let folder = record["cwd"] as? String ?? ""
                #expect(folder.hasPrefix(tree.work.path + "/participant-"), "\(name): a fresh folder under the probe parent")
            }
            #expect(try FileManager.default.contentsOfDirectory(atPath: tree.work.path).isEmpty, "every probe folder removed")
            #expect(tree.log.entries.first?.line == "check=fresh result=passed step=finished")
            #expect(Set(tree.accesses.executed) == [tree.binaryPath], "only the pinned file is ever executed")
            let read = Set(tree.accesses.read)
            for source in ClaudeCheckSource.settingsSources where source != .managedDropIn && source != .localSettings {
                #expect(read.contains(tree.path(source)), "\(source.rawValue) inspected")
            }
            #expect(tree.accesses.accesses.contains(.list(tree.path(.managedDropIn))))
            #expect(tree.accesses.accesses.contains(.inspect(tree.work.path + "/.git"))
                    && tree.accesses.accesses.contains(.inspect(tree.root.path + "/.git")),
                    "the git walk, from the probe parent up to the tree's top only")
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        // MARK: The pinned binary (answer 9)

        @Test("cli-missing when the version file or any folder on its way is absent; nothing runs and no source is read")
        func missing() async throws {
            let tree = try InventedClaudeTree(scenario: nil)
            defer { tree.clean() }
            #expect(await tree.fresh() == .failed(.cliMissing), "no folder at all")
            try tree.install(scenario: ["authStatus": "subscription"])
            tree.remove(tree.binaryPath)
            #expect(await tree.fresh() == .failed(.cliMissing), "the folders but no file")
            #expect(tree.log.last?.line == "check=fresh result=cli-missing step=binary detail=missing")
            #expect(tree.accesses.executed.isEmpty && tree.accesses.read.isEmpty)
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("A linked, writable, non-executable, setuid, non-regular or foreign-owned pin, or a linked or writable folder on its way, is check-failed and never run")
        func refusedBinary() async throws {
            let tree = try InventedClaudeTree()
            defer { tree.clean() }
            let elsewhere = tree.root.appendingPathComponent("elsewhere", isDirectory: true)
            try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
            let copy = elsewhere.appendingPathComponent("copy").path
            try FileManager.default.copyItem(atPath: Products.fakeCLI, toPath: copy)
            let pinned = tree.binaryPath
            func refused(_ detail: ClaudeCheckDetail, _ label: String, roots: ClaudeCheckRoots? = nil,
                         sourceLocation: SourceLocation = #_sourceLocation) async {
                #expect(await tree.fresh(roots: roots) == .failed(.checkFailed), "\(label)", sourceLocation: sourceLocation)
                #expect(tree.log.last?.step == .binary && tree.log.last?.detail == detail,
                        "\(label): \(tree.log.last?.line ?? "")", sourceLocation: sourceLocation)
            }

            tree.remove(pinned)
            try FileManager.default.createSymbolicLink(atPath: pinned, withDestinationPath: copy)
            await refused(.linked, "the version file is a link")
            tree.remove(pinned)
            try FileManager.default.copyItem(atPath: copy, toPath: pinned)

            for (mode, detail, label) in [(mode_t(0o775), ClaudeCheckDetail.writable, "group-writable"),
                                          (0o757, .writable, "writable by others"), (0o644, .notExecutable, "not executable"),
                                          (0o4755, .specialMode, "setuid")] {
                tree.chmod(pinned, mode)
                await refused(detail, label)
            }
            tree.chmod(pinned, 0o755)
            #expect(await tree.fresh().snapshot != nil, "the control passes")

            let folder = tree.versions.deletingLastPathComponent().path
            tree.chmod(folder, 0o777)
            await refused(.writable, "a folder on the way writable by others")
            tree.chmod(folder, 0o755)
            tree.chmod(tree.home.path, 0o770)
            await refused(.writable, "a group-writable home")
            tree.chmod(tree.home.path, 0o700)

            // The versions folder as a link to a folder holding a copy.
            let real = tree.versions.path
            let moved = tree.root.appendingPathComponent("moved-versions").path
            try FileManager.default.moveItem(atPath: real, toPath: moved)
            try FileManager.default.createSymbolicLink(atPath: real, withDestinationPath: moved)
            await refused(.linked, "a folder on the way is a link")
            tree.remove(real)
            try FileManager.default.moveItem(atPath: moved, toPath: real)

            tree.remove(pinned)
            try FileManager.default.createDirectory(atPath: pinned, withIntermediateDirectories: false)
            await refused(.notRegular, "a folder at the version file's place")
            tree.remove(pinned)
            try FileManager.default.copyItem(atPath: copy, toPath: pinned)

            let foreign = ClaudeCheckRoots(home: tree.home.path, userName: InventedClaudeTree.userName, owner: getuid() &+ 1,
                                           managedSettingsFolder: tree.managed.path,
                                           managedPreferencesFolder: tree.preferences.path, probeParent: tree.work,
                                           gitSearchTop: tree.root.path)
            await refused(.notOwned, "another user's", roots: foreign)

            #expect(tree.probes("version") == 1, "only the control ran the pin: a link is never followed")
            // Paths are recorded as requested, so this holds by construction;
            // the probe count above is the real proof.
            #expect(!tree.accesses.accesses.contains { $0.path.hasPrefix(elsewhere.path) || $0.path.hasPrefix(moved) })
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("A pin whose identity changes during the check (here while it answers --version) is check-failed")
        func changesDuringCheck() async throws {
            let tree = try InventedClaudeTree(scenario: ["authStatus": "subscription", "versionTouchesSelf": true])
            defer { tree.clean() }
            #expect(await tree.fresh() == .failed(.checkFailed))
            #expect(tree.log.last?.line == "check=fresh result=check-failed step=binary detail=changed")
            #expect(tree.probes("auth-status") == 0)
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        // MARK: --version

        @Test("cli-version-mismatch for another version; garbled, empty, oversized or failing output is check-failed; auth status never runs and no source is read")
        func version() async throws {
            let tree = try InventedClaudeTree(scenario: ["authStatus": "subscription", "version": "2.1.284"])
            defer { tree.clean() }
            #expect(await tree.fresh() == .failed(.cliVersionMismatch))
            #expect(tree.log.last?.line == "check=fresh result=cli-version-mismatch step=version detail=mismatch")
            for (mode, detail) in [("garbled", ClaudeCheckDetail.unparseable), ("empty", .emptyOutput),
                                   ("oversized", .outputTooLarge), ("exit-2", .exitStatus)] {
                try tree.setScenario(["authStatus": "subscription", "versionMode": mode])
                #expect(await tree.fresh() == .failed(.checkFailed), "\(mode)")
                #expect(tree.log.last?.step == .version && tree.log.last?.detail == detail, "\(mode): \(tree.log.last?.line ?? "")")
            }
            #expect(tree.probes("version") == 5)
            #expect(tree.probes("auth-status") == 0)
            #expect(tree.accesses.read.isEmpty, "no source is read after a failed --version")
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("A --version past its per-process bound is check-failed at the bound, and its group is killed")
        func versionTimeout() async throws {
            let tree = try InventedClaudeTree(scenario: ["authStatus": "subscription", "versionMode": "slow", "versionSlowMs": 6_000,
                                                         "checkChild": true])
            defer { tree.clean() }
            var limits = ClaudeCheckLimits.contract
            limits.perProcessMillis = 1_000
            let start = ContinuousClock.now
            #expect(await tree.fresh(limits: limits) == .failed(.checkFailed))
            let elapsed = Processes.elapsed(since: start)
            #expect(tree.log.last?.line == "check=fresh result=check-failed step=version detail=timeout")
            #expect(elapsed >= 0.9 && elapsed < 3, "\(elapsed)")
            let leader = try #require(tree.record("version.json")?["pid"] as? Int)
            let child = try #require(tree.pid("child.pid"))
            #expect(!Processes.isRunning(pid_t(leader)) && !Processes.isRunning(child), "the probe's whole group is gone")
            #expect(try FileManager.default.contentsOfDirectory(atPath: tree.work.path).isEmpty)
            measured("local check version timeout", [("returned", elapsed)])
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("Section 5's bounds as built: 5 s per probe, 12 s per check, 30 s reuse; a slow --version at the contract bound is check-failed in about 5 s")
        func contractBounds() async throws {
            #expect(ClaudeCheckLimits.contract.perProcessMillis == 5_000)
            #expect(ClaudeCheckLimits.contract.totalMillis == 12_000)
            #expect(ClaudeCheckLimits.contract.reuseMillis == 30_000)
            let tree = try InventedClaudeTree(scenario: ["authStatus": "subscription", "versionMode": "slow", "versionSlowMs": 7_000])
            defer { tree.clean() }
            let start = ContinuousClock.now
            #expect(await tree.fresh() == .failed(.checkFailed))
            let elapsed = Processes.elapsed(since: start)
            #expect(tree.log.last?.detail == .timeout)
            #expect(elapsed >= 4.9 && elapsed < 6.5, "\(elapsed)")
            measured("local check contract bound", [("returned", elapsed)])
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        // MARK: auth status

        @Test("auth status: signed-out, not-subscription, provider-override (the stored Console key quirk included) and check-failed for every unknown shape")
        func authStatus() async throws {
            let tree = try InventedClaudeTree()
            defer { tree.clean() }
            let cases: [(String?, ClaudeLocalFailure, ClaudeCheckDetail)] = [
                ("signed-out", .signedOut, .signedOut),
                ("console", .providerOverride, .override),            // stored Console key: claude.ai with apiKeySource
                ("console-login", .notSubscription, .noSubscription),  // claude.ai, no key, no plan
                ("api-key-env", .providerOverride, .override),
                ("api-key-helper", .providerOverride, .override),
                ("oauth-token", .providerOverride, .override),
                ("bedrock", .providerOverride, .override),
                ("vertex", .providerOverride, .override),
                ("gateway", .providerOverride, .override),
                ("garbled", .checkFailed, .unparseable),
                ("empty", .checkFailed, .emptyOutput),
                ("oversized", .checkFailed, .outputTooLarge),
                ("unknown-plan", .checkFailed, .unknownPlan),
                ("unknown-method", .checkFailed, .unparseable),
                ("no-account", .checkFailed, .noAccount),
                ("logged-in-exit-1", .checkFailed, .exitStatus),
                ("logged-in-number", .checkFailed, .unparseable),
                (nil, .checkFailed, .exitStatus)                       // the fake exits 70
            ]
            for (variant, failure, detail) in cases {
                try tree.setScenario(variant.map { ["authStatus": $0] } ?? [:])
                #expect(await tree.fresh() == .failed(failure), "\(variant ?? "none")")
                #expect(tree.log.last?.step == .authStatus && tree.log.last?.source == .authStatus
                        && tree.log.last?.detail == detail, "\(variant ?? "none"): \(tree.log.last?.line ?? "")")
            }
            #expect(tree.probes("auth-status") == cases.count)
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("auth status past its per-process bound, or past the 12 s total (scaled down), is check-failed; its group is killed")
        func authTimeouts() async throws {
            let tree = try InventedClaudeTree(scenario: ["authStatus": "slow", "slowMs": 6_000, "checkChild": true])
            defer { tree.clean() }
            var limits = ClaudeCheckLimits.contract
            limits.perProcessMillis = 1_000
            var start = ContinuousClock.now
            #expect(await tree.fresh(limits: limits) == .failed(.checkFailed))
            var elapsed = Processes.elapsed(since: start)
            #expect(tree.log.last?.line == "check=fresh result=check-failed step=auth-status source=auth-status detail=timeout")
            #expect(elapsed >= 0.9 && elapsed < 3, "\(elapsed)")
            let leader = try #require(tree.record("auth-status.json")?["pid"] as? Int)
            #expect(!Processes.isRunning(pid_t(leader)))
            let child = try #require(tree.pid("child.pid"), "the child recorded itself before the bound")
            #expect(!Processes.isRunning(child), "the probe's whole group is gone")

            // The total: each probe within its own bound, together past it.
            try tree.setScenario(["authStatus": "slow", "slowMs": 1_500, "versionMode": "slow", "versionSlowMs": 1_500])
            limits.perProcessMillis = 2_000
            limits.totalMillis = 2_500
            start = ContinuousClock.now
            #expect(await tree.fresh(limits: limits) == .failed(.checkFailed))
            elapsed = Processes.elapsed(since: start)
            #expect(tree.log.last?.line == "check=fresh result=check-failed step=auth-status source=auth-status detail=total-timeout")
            #expect(elapsed >= 2.4 && elapsed < 4, "\(elapsed)")
            measured("local check auth timeouts", [("total", elapsed)])
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("A probe that leaves a child in its group: the check still ends, and the child is killed with the group")
        func groupCleared() async throws {
            let tree = try InventedClaudeTree(scenario: ["authStatus": "subscription", "checkChild": true])
            defer { tree.clean() }
            let start = ContinuousClock.now
            #expect(await tree.fresh().snapshot != nil)
            let elapsed = Processes.elapsed(since: start)
            let child = try #require(tree.pid("child.pid"))
            #expect(!Processes.isRunning(child), "the child that ignores SIGTERM and holds the pipes is gone")
            #expect(elapsed < 4, "\(elapsed)")
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("A probe whose group keeps stderr full: each drain turn is bounded, so the probe's own bound still ends it, and its whole group is dead by then, observed from outside (Codex F34-R2)")
        func stderrFlood() async throws {
            let tree = try InventedClaudeTree(scenario: ["authStatus": "subscription", "versionMode": "slow", "versionSlowMs": 6_000,
                                                         "checkStderrFlood": 4])
            defer { tree.clean() }
            var limits = ClaudeCheckLimits.contract
            limits.perProcessMillis = 1_000
            limits.totalMillis = 4_000
            let checks = tree.checks(limits: limits)
            let start = ContinuousClock.now
            #expect(await checks.evaluateFresh() == .failed(.checkFailed))
            let returned = Processes.elapsed(since: start)
            #expect(tree.log.last?.line == "check=fresh result=check-failed step=version detail=timeout",
                    "the probe's own 1 s bound ended it, not the check's 4 s watchdog: \(tree.log.last?.line ?? "")")
            #expect(returned >= 0.9 && returned < 2.5, "\(returned)")
            #expect(!checks.hasStalledWork, "its thread returned: nothing was abandoned")

            // From outside: the leader, every writer and anything else in its group.
            let leader = pid_t(try #require(tree.record("version.json")?["pid"] as? Int))
            let writers = tree.floodPids
            #expect(writers.count == 4, "the writers recorded themselves before the bound")
            let group = Set([leader] + writers + Processes.members(leader))
            let dead = await Processes.waitUntil(seconds: 0.5) { group.allSatisfy { !Processes.isRunning($0) } }
            let observed = Processes.elapsed(since: start)
            #expect(dead != nil, "the whole group is dead: \(group.filter { Processes.isRunning($0) })")
            #expect(observed < 3, "dead by the bound, well before the check's own 4 s: \(observed)")
            #expect(try FileManager.default.contentsOfDirectory(atPath: tree.work.path).isEmpty)
            measured("local check stderr flood", [("returned", returned), ("group dead", observed)])
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("A stderr that never runs dry (a reader that always has a full buffer): each drain turn is bounded, so the probe still returns at its deadline and kills its whole group, observed from outside (Codex F34-R2; an unbounded turn never returns here)")
        func endlessStderr() async throws {
            let tree = try InventedClaudeTree(scenario: ["authStatus": "subscription", "versionMode": "slow", "versionSlowMs": 6_000,
                                                         "checkStderrFlood": 1])
            defer { tree.clean() }
            final class Reads: @unchecked Sendable {
                private let lock = NSLock()
                private var count = 0
                func add() { lock.lock(); count += 1; lock.unlock() }
                var value: Int { lock.lock(); defer { lock.unlock() }; return count }
            }
            let reads = Reads()
            var runner = ClaudeProbeRunner(binaryPath: tree.binaryPath, workParent: tree.work,
                                           environment: ParticipantEnvironment.build(from: tree.environment), outputBytes: 65_536,
                                           observer: nil)
            runner.readStderr = { _, _, count in
                reads.add()
                return count
            }
            let result = ResultBox<ClaudeProbeResult>()
            let start = ContinuousClock.now
            let deadline = ClaudeCheckRun.nowMillis() + 1_000
            let thread = Thread { result.set(runner.run(["--version"], until: deadline)) }
            thread.start()
            let returned = await Processes.waitUntil(seconds: 6) { result.value != nil }
            #expect(returned != nil, "the probe returned")
            #expect(result.value?.ending == .timedOut)
            #expect(returned.map { $0 >= 0.9 && $0 < 2.5 } == true, "at its 1 s deadline: \(returned ?? -1)")
            #expect(reads.value > ClaudeProbeRunner.readsPerTurn, "stderr was read turn after turn")

            let leader = pid_t(try #require(tree.record("version.json")?["pid"] as? Int))
            let writers = tree.floodPids
            #expect(writers.count == 1)
            let group = Set([leader] + writers + Processes.members(leader))
            let dead = await Processes.waitUntil(seconds: 0.5) { group.allSatisfy { !Processes.isRunning($0) } }
            #expect(dead != nil, "the whole group is dead: \(group.filter { Processes.isRunning($0) })")
            #expect(Processes.elapsed(since: start) < 3, "by the bound")
            #expect(try FileManager.default.contentsOfDirectory(atPath: tree.work.path).isEmpty)
        }

        @Test("A check given up on in the instant between the probe's last look and its spawn: the probe starts, and the collector's first turn kills it at once, not at its deadline (the F34 re-review's R1 window)")
        func abandonedBetweenLookAndSpawn() async throws {
            let tree = try InventedClaudeTree(scenario: ["authStatus": "subscription", "versionMode": "slow", "versionSlowMs": 6_000])
            defer { tree.clean() }
            final class Looks: @unchecked Sendable {
                private let lock = NSLock()
                private var count = 0
                /// Live at the pre-spawn look; given up on at every look after it.
                func abandoned() -> Bool { lock.lock(); defer { lock.unlock() }; count += 1; return count > 1 }
                var value: Int { lock.lock(); defer { lock.unlock() }; return count }
            }
            let looks = Looks()
            let runner = ClaudeProbeRunner(binaryPath: tree.binaryPath, workParent: tree.work,
                                           environment: ParticipantEnvironment.build(from: tree.environment), outputBytes: 65_536,
                                           observer: { [accesses = tree.accesses] in accesses.record($0) })
            let result = ResultBox<ClaudeProbeResult>()
            let deadline = ClaudeCheckRun.nowMillis() + 5_000
            let thread = Thread { result.set(runner.run(["--version"], until: deadline, abandoned: { looks.abandoned() })) }
            thread.start()
            let returned = await Processes.waitUntil(seconds: 7) { result.value != nil }
            #expect(result.value?.ending == .timedOut)
            #expect(returned.map { $0 < 1.5 } == true, "on the collector's first turn, not at its 5 s deadline: \(returned ?? -1)")
            #expect(tree.accesses.executed.count == 1, "the window this covers: it was spawned")
            #expect(looks.value >= 2, "the pre-spawn look, then the collector's")
            // The leader was reaped before the runner returned; if it got far
            // enough to record itself, that pid is gone, and it records no more.
            if let leader = (tree.record("version.json")?["pid"] as? Int).map({ pid_t($0) }) {
                #expect(!Processes.isRunning(leader))
            }
            let probes = tree.probes("version")
            try await Task.sleep(for: .milliseconds(300))
            #expect(tree.probes("version") == probes && probes <= 1)
            #expect(try FileManager.default.contentsOfDirectory(atPath: tree.work.path).isEmpty)
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        // MARK: Provider overrides (answer 11)

        @Test("Each source with an override is provider-override before auth status runs: managed file, drop-in, both MDM files, remote settings, policy limits, ~/.claude.json env and primaryApiKey, the older global config, user settings")
        func overrideSources() async throws {
            let tree = try InventedClaudeTree(scenario: ["authStatus": "signed-out"])
            defer { tree.clean() }
            let helper = tree.root.appendingPathComponent("invented-helper").path
            let dropIn = tree.path(.managedDropIn) + "/20-invented.json"
            typealias Case = (label: String, path: String, write: () throws -> Void, source: ClaudeCheckSource, detail: ClaudeCheckDetail)
            let cases: [Case] = [
                ("managed apiKeyHelper", tree.path(.managedFile),
                 { try tree.writeJSON(["apiKeyHelper": helper], to: tree.path(.managedFile)) }, .managedFile, .helper),
                ("managed modelOverrides", tree.path(.managedFile),
                 { try tree.writeJSON(["modelOverrides": ["invented": "invented"]], to: tree.path(.managedFile)) }, .managedFile, .override),
                ("managed forceLoginGatewayUrl", tree.path(.managedFile),
                 { try tree.writeJSON(["forceLoginGatewayUrl": "https://invented.invalid"], to: tree.path(.managedFile)) },
                 .managedFile, .override),
                ("drop-in base URL", dropIn,
                 { try tree.writeJSON(["env": ["ANTHROPIC_BASE_URL": "https://invented.invalid"]], to: dropIn) }, .managedDropIn, .override),
                ("per-user MDM console login", tree.path(.userPreferences),
                 { try tree.writePropertyList(["forceLoginMethod": "console"], to: tree.path(.userPreferences)) },
                 .userPreferences, .override),
                ("device MDM provider switch", tree.path(.devicePreferences),
                 { try tree.writePropertyList(["env": ["CLAUDE_CODE_USE_BEDROCK": "1"]], to: tree.path(.devicePreferences)) },
                 .devicePreferences, .override),
                ("remote settings, wrapped helper", tree.path(.remoteSettings),
                 { try tree.writeJSON(["checksum": "invented", "settings": ["awsAuthRefresh": helper]], to: tree.path(.remoteSettings)) },
                 .remoteSettings, .helper),
                ("policy limits token", tree.path(.policyLimits),
                 { try tree.writeJSON(["restrictions": ["env": ["ANTHROPIC_AUTH_TOKEN": "invented"]]], to: tree.path(.policyLimits)) },
                 .policyLimits, .override),
                ("global config env key", tree.path(.globalConfig),
                 { try tree.writeJSON(["env": ["ANTHROPIC_API_KEY": "invented-not-a-key"]], to: tree.path(.globalConfig)) },
                 .globalConfig, .override),
                ("global config primaryApiKey", tree.path(.globalConfig),
                 { try tree.writeJSON(["primaryApiKey": "invented-not-a-key"], to: tree.path(.globalConfig)) }, .globalConfig, .override),
                ("older global config primaryApiKey", tree.path(.legacyGlobalConfig),
                 { try tree.writeJSON(["primaryApiKey": "invented-not-a-key"], to: tree.path(.legacyGlobalConfig)) },
                 .legacyGlobalConfig, .override),
                ("user settings helper", tree.path(.userSettings),
                 { try tree.writeJSON(["apiKeyHelper": helper], to: tree.path(.userSettings)) }, .userSettings, .helper),
                ("user settings provider env", tree.path(.userSettings),
                 { try tree.writeJSON(["env": ["CLAUDE_CODE_USE_VERTEX": "1"]], to: tree.path(.userSettings)) }, .userSettings, .override)
            ]
            for item in cases {
                try item.write()
                #expect(await tree.fresh() == .failed(.providerOverride), "\(item.label)")
                #expect(tree.log.last?.step == .sources && tree.log.last?.source == item.source && tree.log.last?.detail == item.detail,
                        "\(item.label): \(tree.log.last?.line ?? "")")
                tree.remove(item.path)
            }
            #expect(tree.probes("version") == cases.count)
            #expect(tree.probes("auth-status") == 0, "auth status never ran with an override present")
            #expect(await tree.fresh() == .failed(.signedOut), "the control: no override, auth status runs")
            #expect(tree.probes("auth-status") == 1)
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("Benign content in every source passes: no provider key, a claudeai login, fixed values unchanged, only traffic-off names where the run reads, other names in user settings, an MCP server's own env, dot-files and other files in the drop-in folder, a git root at the home")
        func benignSources() async throws {
            let tree = try InventedClaudeTree()
            defer { tree.clean() }
            let dropIns = tree.path(.managedDropIn)
            try tree.writeJSON(["permissions": ["deny": ["Invented(*)"]], "forceLoginMethod": "claudeai",
                                "env": ["DISABLE_AUTOUPDATER": "1", "DO_NOT_TRACK": "1"]], to: tree.path(.managedFile))
            try tree.writeJSON(["cleanupPeriodDays": 7], to: dropIns + "/10-invented.json")
            try tree.writeJSON(["apiKeyHelper": "/invented/never-read"], to: dropIns + "/.hidden.json")
            try tree.write("{\"apiKeyHelper\": \"/invented/never-read\"}", to: dropIns + "/notes.txt")
            try tree.writePropertyList(["forceLoginMethod": "claudeai", "apiKeyHelper": ""], to: tree.path(.userPreferences))
            try tree.writePropertyList(["permissions": ["allow": ["Invented"]]], to: tree.path(.devicePreferences))
            try tree.writeJSON(["settings": [String: Any]()], to: tree.path(.remoteSettings))
            try tree.writeJSON(["restrictions": ["invented_limit": true]], to: tree.path(.policyLimits))
            try tree.writeJSON(["numStartups": 3, "env": ["DISABLE_TELEMETRY": "1", "CLAUDE_CODE_DISABLE_ATTACHMENTS": "1"],
                                "mcpServers": ["invented": ["command": "/invented/server",
                                                            "env": ["ANTHROPIC_API_KEY": "invented-for-the-server"]]],
                                "projects": ["/invented/project": ["env": ["ANTHROPIC_BASE_URL": "https://invented.invalid"]]]],
                               to: tree.path(.globalConfig))
            try tree.writeJSON(["env": ["CLAUDE_CODE_DISABLE_ATTACHMENTS": "1", "INVENTED_FLAG": "1", "BASH_DEFAULT_TIMEOUT_MS": "1000"],
                                "hooks": ["Stop": [["command": "/invented/hook"]]]], to: tree.path(.userSettings))
            // A git root at the home: the CLI never takes it as the root.
            let probeParentInHome = tree.home.appendingPathComponent("Library/work", isDirectory: true)
            try FileManager.default.createDirectory(at: probeParentInHome, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            try FileManager.default.createDirectory(at: tree.home.appendingPathComponent(".git"), withIntermediateDirectories: true)
            let inHome = ClaudeCheckRoots(home: tree.home.path, userName: InventedClaudeTree.userName, owner: getuid(),
                                          managedSettingsFolder: tree.managed.path, managedPreferencesFolder: tree.preferences.path,
                                          probeParent: probeParentInHome, gitSearchTop: tree.root.path)
            let atHome = await tree.fresh(roots: inHome)
            #expect(atHome.snapshot != nil, "\(atHome) \(tree.log.last?.line ?? "")")
            let result = await tree.fresh()
            #expect(result.snapshot != nil, "\(result) \(tree.log.last?.line ?? "")")
            #expect(!tree.accesses.read.contains(dropIns + "/.hidden.json") && !tree.accesses.read.contains(dropIns + "/notes.txt"))
            #expect(tree.accesses.read.contains(dropIns + "/10-invented.json"))
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("A source that would undo section 11's environment (for the run, or for auth status from user settings: a fixed value, a redirect, a proxy, TLS trust, telemetry export), a managed hook, or a value of an unexpected type is check-failed; auth status never runs")
        func unsupportedSources() async throws {
            let tree = try InventedClaudeTree(scenario: ["authStatus": "signed-out"])
            defer { tree.clean() }
            let cases: [(String, String, Any, ClaudeCheckSource, ClaudeCheckDetail)] = [
                ("attachments back on", tree.path(.managedFile), ["env": ["CLAUDE_CODE_DISABLE_ATTACHMENTS": "0"]], .managedFile, .restriction),
                ("another PATH", tree.path(.managedFile), ["env": ["PATH": "/invented/bin:/usr/bin"]], .managedFile, .restriction),
                ("retries", tree.path(.remoteSettings), ["env": ["CLAUDE_CODE_MAX_RETRIES": "9"]], .remoteSettings, .restriction),
                ("config folder", tree.path(.globalConfig), ["env": ["CLAUDE_CONFIG_DIR": "/invented/config"]], .globalConfig, .restriction),
                ("managed proxy", tree.path(.managedFile), ["env": ["HTTPS_PROXY": "http://invented.invalid:1"]], .managedFile, .restriction),
                ("managed TLS trust", tree.path(.managedDropIn) + "/30-invented.json", ["env": ["NODE_EXTRA_CA_CERTS": "/invented/ca.pem"]],
                 .managedDropIn, .restriction),
                ("remote telemetry export", tree.path(.remoteSettings),
                 ["env": ["CLAUDE_CODE_ENABLE_TELEMETRY": "1", "OTEL_LOG_USER_PROMPTS": "1"]], .remoteSettings, .restriction),
                ("an unknown name where the run reads it", tree.path(.globalConfig), ["env": ["INVENTED_FLAG": "1"]], .globalConfig,
                 .restriction),
                ("user settings: attachments back on", tree.path(.userSettings), ["env": ["CLAUDE_CODE_DISABLE_ATTACHMENTS": "0"]],
                 .userSettings, .restriction),
                ("user settings: traffic back on", tree.path(.userSettings), ["env": ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": ""]],
                 .userSettings, .restriction),
                ("user settings: config folder", tree.path(.userSettings), ["env": ["CLAUDE_CONFIG_DIR": "/invented/config"]],
                 .userSettings, .restriction),
                ("user settings: another home", tree.path(.userSettings), ["env": ["HOME": "/invented/other-home"]], .userSettings,
                 .restriction),
                ("user settings: another user", tree.path(.userSettings), ["env": ["USER": "invented-other-user"]], .userSettings,
                 .restriction),
                ("user settings: proxy", tree.path(.userSettings), ["env": ["https_proxy": "http://invented.invalid:1"]], .userSettings,
                 .restriction),
                ("managed hook", tree.path(.managedFile), ["hooks": ["Stop": [["command": "/invented/hook"]]]], .managedFile, .unsupported),
                ("login method not a string", tree.path(.managedFile), ["forceLoginMethod": 5], .managedFile, .unsupported),
                ("env not an object", tree.path(.globalConfig), ["env": "invented"], .globalConfig, .unsupported)
            ]
            for (label, path, object, source, detail) in cases {
                try tree.writeJSON(object, to: path)
                #expect(await tree.fresh() == .failed(.checkFailed), "\(label)")
                #expect(tree.log.last?.source == source && tree.log.last?.detail == detail, "\(label): \(tree.log.last?.line ?? "")")
                tree.remove(path)
            }
            #expect(tree.probes("auth-status") == 0)
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("auth status reporting on another config folder than the one inspected is check-failed (a redirect the sources did not show)")
        func configFolderMismatch() async throws {
            let tree = try InventedClaudeTree(scenario: ["authStatus": "subscription", "configDirectory": "/invented/config"])
            defer { tree.clean() }
            #expect(await tree.fresh() == .failed(.checkFailed))
            #expect(tree.log.last?.line == "check=fresh result=check-failed step=auth-status source=auth-status detail=config-mismatch")
            try tree.setScenario(["authStatus": "subscription", "configDirectory": tree.roots.configFolder + "/"])
            #expect(await tree.fresh().snapshot != nil, "a trailing slash names the same folder")
            try tree.setScenario(["authStatus": "subscription"])
            #expect(await tree.fresh().snapshot != nil, "the tree's own config folder")
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("A git root above the probe's folder, other than the home, is check-failed before auth status runs (local settings could apply there); nothing past the tree's top is touched")
        func gitRootAboveProbe() async throws {
            let tree = try InventedClaudeTree(scenario: ["authStatus": "subscription"])
            defer { tree.clean() }
            for (label, marker, directory) in [("a checkout around the probe parent", tree.root.path + "/.git", true),
                                               ("a worktree's .git file at the probe parent", tree.work.path + "/.git", false)] {
                if directory {
                    try FileManager.default.createDirectory(atPath: marker, withIntermediateDirectories: true)
                } else {
                    try tree.write("gitdir: /invented/main/.git/worktrees/invented\n", to: marker)
                }
                #expect(await tree.fresh() == .failed(.checkFailed), "\(label)")
                #expect(tree.log.last?.line == "check=fresh result=check-failed step=sources source=local-settings detail=git-root",
                        "\(label): \(tree.log.last?.line ?? "")")
                tree.remove(marker)
            }
            #expect(tree.probes("auth-status") == 0, "auth status never ran beside an unresolved git root")
            #expect(await tree.fresh().snapshot != nil, "the control")
            let outside = ClaudeCheckRoots(home: tree.home.path, userName: InventedClaudeTree.userName, owner: getuid(),
                                           managedSettingsFolder: tree.managed.path, managedPreferencesFolder: tree.preferences.path,
                                           probeParent: tree.work, gitSearchTop: tree.home.path)
            #expect(await tree.fresh(roots: outside) == .failed(.checkFailed), "a probe parent outside the walk's top is unresolved")
            #expect(tree.log.last?.source == .localSettings && tree.log.last?.detail == .unsupported)
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("The 12 s total covers file reads: a read that blocks is check-failed at the bound; until its thread returns every check answers at once and nothing new runs; its late result is never reused")
        func blockedRead() async throws {
            let tree = try InventedClaudeTree()
            defer {
                tree.accesses.release()
                tree.clean()
            }
            var limits = ClaudeCheckLimits.contract
            limits.totalMillis = 1_000
            let clock = VirtualClock(wallAtStart: 0)
            let checks = tree.checks(limits: limits, clock: clock)
            #expect(await checks.evaluate().snapshot != nil, "a passing check, cached")

            // Its pin then sits on a volume that stalls: the reuse path's look
            // at the file blocks too.
            tree.accesses.hold(at: tree.home.path)
            var start = ContinuousClock.now
            #expect(await checks.evaluate() == .failed(.checkFailed), "nothing reused while the pin cannot be seen")
            var elapsed = Processes.elapsed(since: start)
            #expect(elapsed >= 0.9 && elapsed < 3, "\(elapsed)")
            #expect(tree.log.last?.line == "check=fresh result=check-failed step=binary detail=stalled")
            #expect(checks.hasStalledWork)
            tree.accesses.release()
            #expect(await waitUntil(seconds: 10) { !checks.hasStalledWork }, "the held thread returned")

            // A fresh check blocked reading a managed file.
            let versionsBefore = tree.probes("version")
            tree.accesses.hold(at: tree.path(.managedFile))
            start = ContinuousClock.now
            #expect(await checks.evaluateFresh() == .failed(.checkFailed))
            elapsed = Processes.elapsed(since: start)
            #expect(elapsed >= 0.9 && elapsed < 3, "\(elapsed)")
            #expect(tree.log.last?.line == "check=fresh result=check-failed step=sources source=managed-file detail=total-timeout")
            #expect(tree.accesses.isHolding && checks.hasStalledWork)

            // Still blocked: every call answers at once, and nothing runs.
            for call in ["evaluateFresh", "recheck", "evaluate"] {
                start = ContinuousClock.now
                switch call {
                case "evaluateFresh": #expect(await checks.evaluateFresh() == .failed(.checkFailed))
                case "recheck": #expect(await checks.recheck() == .unavailable(.checkFailed))
                default: #expect(await checks.evaluate() == .failed(.checkFailed))
                }
                #expect(Processes.elapsed(since: start) < 0.5, "\(call) answered at once")
                #expect(tree.log.last?.line == "check=fresh result=check-failed step=sources source=managed-file detail=stalled",
                        "\(call): \(tree.log.last?.line ?? "")")
            }
            #expect(tree.probes("version") == versionsBefore + 1, "only the blocked check ran a probe")

            // Released: its late result (a pass) is dropped, never reused.
            tree.accesses.release()
            #expect(await waitUntil(seconds: 10) { !checks.hasStalledWork })
            let probesBefore = tree.probes("auth-status")
            #expect(await checks.evaluate().snapshot != nil)
            #expect(tree.probes("auth-status") == probesBefore + 1, "checked again, not the late result")
            #expect(tree.log.last?.line == "check=fresh result=passed step=finished")
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("A probe's folder work that blocks past the check's bound starts nothing: check-failed at the bound; released, the thread spawns no probe and removes its folder (Codex F34-R1)")
        func noSpawnAfterDeadline() async throws {
            let tree = try InventedClaudeTree()
            defer {
                tree.accesses.release()
                tree.clean()
            }
            var limits = ClaudeCheckLimits.contract
            limits.perProcessMillis = 500
            limits.totalMillis = 800
            let checks = tree.checks(limits: limits)
            // The version probe's fresh folder (a random name under the probe
            // parent) sits on a volume that stalls: the look at it blocks.
            let folders = tree.work.path + "/participant-"
            tree.accesses.hold { access in
                if case .inspect(let path) = access { return path.hasPrefix(folders) }
                return false
            }
            let start = ContinuousClock.now
            #expect(await checks.evaluateFresh() == .failed(.checkFailed))
            let elapsed = Processes.elapsed(since: start)
            #expect(elapsed >= 0.7 && elapsed < 2.5, "\(elapsed)")
            #expect(tree.log.last?.line == "check=fresh result=check-failed step=version detail=total-timeout")
            #expect(tree.accesses.heldArrivals == 1 && checks.hasStalledWork, "the version probe's folder work is still held")
            let executed = tree.accesses.executed.count
            #expect(executed == 0)

            // Past the probe's own bound and the check's: the folder work returns.
            tree.accesses.release()
            #expect(await waitUntil(seconds: 10) { !checks.hasStalledWork }, "the held thread returned")
            #expect(tree.accesses.executed.count == executed, "nothing was spawned after its deadline")
            #expect(tree.probes("version") == 0 && tree.probes("auth-status") == 0, "the fake never ran")
            #expect(try FileManager.default.contentsOfDirectory(atPath: tree.work.path).isEmpty, "its folder was removed")
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("A probe whose preparation blocks past its deadline closes all six pipe descriptors, as seen from the other halves the test keeps, and spawns nothing (Codex F34-R1; the F34 re-review's M3)")
        func expiredPreparationClosesDescriptors() async throws {
            let tree = try InventedClaudeTree()
            defer {
                tree.accesses.release()
                tree.clean()
            }
            // Each pipe the runner gets is the read end of one real pipe and
            // the write end of another; the test keeps the other two ends, so
            // its own ends show whether the runner's are closed.
            final class Kept: @unchecked Sendable {
                private let lock = NSLock()
                private var items: [(write: Int32, read: Int32)] = []
                func add(write: Int32, read: Int32) { lock.lock(); items.append((write, read)); lock.unlock() }
                var all: [(write: Int32, read: Int32)] { lock.lock(); defer { lock.unlock() }; return items }
            }
            let kept = Kept()
            var runner = ClaudeProbeRunner(binaryPath: tree.binaryPath, workParent: tree.work,
                                           environment: ParticipantEnvironment.build(from: tree.environment), outputBytes: 65_536,
                                           observer: { [accesses = tree.accesses] in accesses.record($0) })
            runner.makePipe = {
                let first = try DescriptorPipe.make()
                let second = try DescriptorPipe.make()
                kept.add(write: first.write, read: second.read)
                return DescriptorPipe(read: first.read, write: second.write)
            }
            // The probe's fresh folder sits on a volume that stalls.
            let folders = tree.work.path + "/participant-"
            tree.accesses.hold { access in
                if case .inspect(let path) = access { return path.hasPrefix(folders) }
                return false
            }
            let result = ResultBox<ClaudeProbeResult>()
            let deadline = ClaudeCheckRun.nowMillis() + 200
            let thread = Thread { result.set(runner.run(["--version"], until: deadline)) }
            thread.start()
            #expect(await Processes.waitUntil(seconds: 5) { tree.accesses.heldArrivals == 1 } != nil)
            try await Task.sleep(for: .milliseconds(400))
            #expect(result.value == nil, "still held, past its deadline")
            tree.accesses.release()
            #expect(await Processes.waitUntil(seconds: 5) { result.value != nil } != nil)
            #expect(result.value?.ending == .timedOut)
            #expect(tree.accesses.executed.isEmpty, "nothing was spawned")

            let pairs = kept.all
            #expect(pairs.count == 3, "all three pipes were made before the last look")
            for pair in pairs {
                // The runner's read end is closed: a write to this pipe fails.
                _ = fcntl(pair.write, F_SETNOSIGPIPE, 1)
                var byte: UInt8 = 0
                let wrote = Darwin.write(pair.write, &byte, 1)
                let writeError = errno
                #expect(wrote == -1 && writeError == EPIPE, "the runner's read end is still open")
                // The runner's write end is closed: this pipe reads end of file.
                _ = fcntl(pair.read, F_SETFL, fcntl(pair.read, F_GETFL) | O_NONBLOCK)
                let got = Darwin.read(pair.read, &byte, 1)
                #expect(got == 0, "the runner's write end is still open")
                _ = close(pair.write)
                _ = close(pair.read)
            }
            #expect(try FileManager.default.contentsOfDirectory(atPath: tree.work.path).isEmpty, "its folder was removed")
            #expect(tree.probes("version") == 0, "the fake never ran")
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("An unreadable, oversized, unparseable or non-regular source is check-failed without hanging; auth status never runs")
        func unreadableSources() async throws {
            let tree = try InventedClaudeTree(scenario: ["authStatus": "signed-out"])
            defer { tree.clean() }
            var limits = ClaudeCheckLimits.contract
            limits.globalConfigBytes = 64
            func failed(_ source: ClaudeCheckSource, _ detail: ClaudeCheckDetail, _ label: String, limits: ClaudeCheckLimits = .contract,
                        sourceLocation: SourceLocation = #_sourceLocation) async {
                let start = ContinuousClock.now
                #expect(await tree.fresh(limits: limits) == .failed(.checkFailed), "\(label)", sourceLocation: sourceLocation)
                #expect(Processes.elapsed(since: start) < 4, "\(label): no hang", sourceLocation: sourceLocation)
                #expect(tree.log.last?.source == source && tree.log.last?.detail == detail,
                        "\(label): \(tree.log.last?.line ?? "")", sourceLocation: sourceLocation)
            }
            let managedFile = tree.path(.managedFile)
            try tree.writeJSON(["permissions": [String: Any]()], to: managedFile)
            tree.chmod(managedFile, 0o000)
            await failed(.managedFile, .unreadable, "a managed file with no read permission")
            tree.chmod(managedFile, 0o644)
            tree.chmod(tree.managed.path, 0o000)
            await failed(.managedFile, .unreadable, "a managed folder that cannot be searched")
            tree.chmod(tree.managed.path, 0o755)
            tree.remove(managedFile)
            try FileManager.default.createDirectory(atPath: managedFile, withIntermediateDirectories: true)
            await failed(.managedFile, .notRegular, "a folder in the managed file's place")
            tree.remove(managedFile)
            #expect(mkfifo(managedFile, 0o644) == 0)
            await failed(.managedFile, .notRegular, "a FIFO in the managed file's place")
            tree.remove(managedFile)

            let dropIns = tree.path(.managedDropIn)
            try FileManager.default.createDirectory(atPath: dropIns, withIntermediateDirectories: true)
            tree.chmod(dropIns, 0o000)
            await failed(.managedDropIn, .unreadable, "an unreadable drop-in folder")
            tree.chmod(dropIns, 0o755)
            tree.remove(dropIns)

            try tree.write("{\"env\": ", to: tree.path(.globalConfig))
            await failed(.globalConfig, .unparseable, "a truncated ~/.claude.json")
            try tree.write("[1, 2]", to: tree.path(.globalConfig))
            await failed(.globalConfig, .unparseable, "not an object")
            try tree.write("{\"numStartups\": 1, \"tipsHistory\": \"" + String(repeating: "x", count: 200) + "\"}", to: tree.path(.globalConfig))
            await failed(.globalConfig, .tooLarge, "past its bound", limits: limits)
            tree.remove(tree.path(.globalConfig))

            try tree.write("invented, not a property list", to: tree.path(.devicePreferences))
            await failed(.devicePreferences, .unparseable, "an unreadable MDM file")
            tree.remove(tree.path(.devicePreferences))

            #expect(tree.probes("auth-status") == 0)
            #expect(await tree.fresh() == .failed(.signedOut), "the control")
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("A configured helper is never executed, stat'ed or read: provider-override, no marker, auth status never runs; run directly, the same helper writes its marker")
        func helpersNeverRun() async throws {
            let tree = try InventedClaudeTree()
            defer { tree.clean() }
            let marker = tree.root.appendingPathComponent("helper-ran").path
            let helper = tree.root.appendingPathComponent("invented-helper").path
            try tree.write("#!/bin/sh\n: > '\(marker)'\necho invented-not-a-key\n", to: helper)
            tree.chmod(helper, 0o755)
            let cases: [(String, String, () throws -> Void)] = [
                ("managed apiKeyHelper", tree.path(.managedFile), { try tree.writeJSON(["apiKeyHelper": helper], to: tree.path(.managedFile)) }),
                ("managed policyHelper", tree.path(.managedFile), { try tree.writeJSON(["policyHelper": ["path": helper]], to: tree.path(.managedFile)) }),
                ("managed policyHelpers", tree.path(.managedFile), { try tree.writeJSON(["policyHelpers": [helper]], to: tree.path(.managedFile)) }),
                ("managed awsCredentialExport", tree.path(.managedFile),
                 { try tree.writeJSON(["awsCredentialExport": helper], to: tree.path(.managedFile)) }),
                ("MDM apiKeyHelper", tree.path(.devicePreferences),
                 { try tree.writePropertyList(["apiKeyHelper": helper], to: tree.path(.devicePreferences)) }),
                ("user settings apiKeyHelper", tree.path(.userSettings),
                 { try tree.writeJSON(["apiKeyHelper": helper], to: tree.path(.userSettings)) }),
                ("user settings proxyAuthHelper", tree.path(.userSettings),
                 { try tree.writeJSON(["proxyAuthHelper": helper], to: tree.path(.userSettings)) }),
                ("global config apiKeyHelper", tree.path(.globalConfig),
                 { try tree.writeJSON(["apiKeyHelper": helper], to: tree.path(.globalConfig)) })
            ]
            for (label, path, write) in cases {
                try write()
                #expect(await tree.fresh() == .failed(.providerOverride), "\(label)")
                #expect(tree.log.last?.detail == .helper, "\(label): \(tree.log.last?.line ?? "")")
                #expect(!FileManager.default.fileExists(atPath: marker), "\(label): the helper never ran")
                tree.remove(path)
            }
            #expect(tree.probes("auth-status") == 0, "no auth command that could invoke a helper ran")
            #expect(!tree.accesses.accesses.contains { $0.path == helper }, "never executed, stat'ed or read")
            #expect(tree.outside.isEmpty, "\(tree.outside)")

            // Not vacuous: the helper works when something does run it.
            var pid: pid_t = 0
            let argv: [UnsafeMutablePointer<CChar>?] = [strdup(helper), nil]
            defer { argv.forEach { free($0) } }
            #expect(posix_spawn(&pid, helper, nil, nil, argv, environ) == 0)
            var status: Int32 = 0
            while waitpid(pid, &status, 0) == -1, errno == EINTR {}
            #expect(FileManager.default.fileExists(atPath: marker), "run by the test itself, it writes the marker")
        }

        // MARK: The D1 gate (Codex F34-D1)

        @Test("Until the D1 decision production never runs auth status: with every earlier check passing, step 4 is check-failed (server-managed settings unguarded), no auth command runs and the owner asks nothing; earlier failures still win; the public initializer has this gate")
        func authStatusGate() async throws {
            let tree = try InventedClaudeTree()
            defer { tree.clean() }
            let refusing = tree.checks(authStatus: .refuseUntilDecided)
            #expect(await refusing.evaluateFresh() == .failed(.checkFailed))
            #expect(tree.log.last?.line == "check=fresh result=check-failed step=auth-status source=remote-settings detail=unguarded")
            #expect(await refusing.recheck() == .unavailable(.checkFailed))
            #expect(tree.probes("version") == 2 && tree.probes("auth-status") == 0, "--version ran; auth status never did")
            #expect(Set(tree.accesses.executed) == [tree.binaryPath])
            for source in ClaudeCheckSource.settingsSources where source != .managedDropIn && source != .localSettings {
                #expect(tree.accesses.read.contains(tree.path(source)), "\(source.rawValue) still inspected first")
            }

            // Earlier failures still win, in section 5's order.
            try tree.writeJSON(["apiKeyHelper": "/invented/never-run"], to: tree.path(.userSettings))
            #expect(await refusing.evaluateFresh() == .failed(.providerOverride))
            tree.remove(tree.path(.userSettings))
            try tree.setScenario(["authStatus": "subscription", "version": "2.1.284"])
            #expect(await refusing.evaluateFresh() == .failed(.cliVersionMismatch))
            try tree.setScenario(["authStatus": "subscription"])

            // Section 17's owner over it: nothing is asked, nothing confirmed.
            let authentication = FakeOwnerAuthentication()
            let owner = PaidUsageConfirmationOwner(checks: refusing, authentication: authentication, clock: InventedWallClock())
            #expect(await owner.confirm() == .checksFailed(.checkFailed))
            #expect(authentication.requests == 0)
            #expect(await owner.report().availability == .unavailable(.checkFailed))
            #expect(tree.probes("auth-status") == 0)

            // The public initializer (what F7 would compose) refuses; only the
            // tests' and the test-only probe's initializers can run it.
            #expect(ClaudeLocalChecks(roots: tree.roots, log: tree.log).authStatusGate == .refuseUntilDecided)
            #expect(tree.checks().authStatusGate == .runForTests)
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        // MARK: Order

        @Test("Section 5's order: an earlier failing check wins; an override wins over an unresolved source; nothing after a failure runs or is read")
        func precedence() async throws {
            let tree = try InventedClaudeTree(scenario: nil)
            defer { tree.clean() }
            try tree.writeJSON(["primaryApiKey": "invented-not-a-key"], to: tree.path(.globalConfig))
            #expect(await tree.fresh() == .failed(.cliMissing), "missing wins over an override")
            #expect(tree.accesses.read.isEmpty)

            try tree.install(scenario: ["authStatus": "signed-out", "version": "2.1.284"])
            #expect(await tree.fresh() == .failed(.cliVersionMismatch), "a version mismatch wins over an override")
            #expect(tree.accesses.read.isEmpty, "no source read after the version failed")

            try tree.setScenario(["authStatus": "signed-out"])
            #expect(await tree.fresh() == .failed(.providerOverride), "an override wins over signed-out")
            #expect(tree.probes("auth-status") == 0)

            try tree.writeJSON(["permissions": [String: Any]()], to: tree.path(.managedFile))
            tree.chmod(tree.path(.managedFile), 0o000)
            #expect(await tree.fresh() == .failed(.providerOverride), "an override (later in order) wins over an unreadable source")
            #expect(tree.log.last?.source == .globalConfig)

            tree.remove(tree.path(.globalConfig))
            #expect(await tree.fresh() == .failed(.checkFailed), "an unresolved source stops the checks before auth status")
            #expect(tree.log.last?.source == .managedFile && tree.log.last?.step == .sources)
            #expect(tree.probes("auth-status") == 0, "never run while an override cannot be ruled out")

            var other = tree.environment
            other["HOME"] = tree.root.appendingPathComponent("other-home").path
            try tree.writeJSON(["primaryApiKey": "invented-not-a-key"], to: tree.path(.globalConfig))
            let readsBefore = tree.accesses.read.count
            #expect(await tree.fresh(environment: other) == .failed(.checkFailed), "another HOME: whose files apply is unresolved")
            #expect(tree.log.last?.line == "check=fresh result=check-failed step=environment source=environment detail=home-mismatch")
            #expect(tree.accesses.read.count == readsBefore, "no source read for another home")
            #expect(tree.probes("auth-status") == 0)
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("The app's environment: HOME or USER other than the roots' is check-failed; dropped names never reach a probe; no HOME at all is fine")
        func environment() async throws {
            let tree = try InventedClaudeTree()
            defer { tree.clean() }
            var other = tree.environment
            other["USER"] = "invented-other-user"
            #expect(await tree.fresh(environment: other) == .failed(.checkFailed))
            #expect(tree.log.last?.detail == .userMismatch)
            var trailing = tree.environment
            trailing["HOME"] = tree.home.path + "/"
            #expect(await tree.fresh(environment: trailing).snapshot != nil, "a trailing slash names the same home")
            var none = tree.environment
            none["HOME"] = nil
            none["USER"] = nil
            #expect(await tree.fresh(environment: none).snapshot != nil, "absent: the CLI falls back to the user database")
            let environment = tree.record("auth-status.json")?["env"] as? [String] ?? []
            #expect(!environment.contains { $0.hasPrefix("HOME=") || $0.hasPrefix("USER=") })
            #expect(!environment.contains { $0.hasPrefix("ANTHROPIC_") || $0.hasPrefix("CLAUDE_CONFIG_DIR=") || $0.hasPrefix("TRUECONVO_") })
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        // MARK: Reuse (section 5) and identity (answer 9)

        @Test("Results are reused for 30 s while the pin is unchanged; recheck() and evaluateFresh() always check; a reused failure until a fresh check")
        func reuse() async throws {
            let tree = try InventedClaudeTree()
            defer { tree.clean() }
            let clock = VirtualClock(wallAtStart: 0)
            let checks = tree.checks(clock: clock)
            let first = await checks.evaluate()
            #expect(first.snapshot != nil)
            #expect(tree.probes("version") == 1 && tree.probes("auth-status") == 1)
            clock.set(elapsed: 10_000)
            #expect(await checks.evaluate() == first, "reused")
            #expect(await checks.check() == .unavailable(.overflowUnverified))
            #expect(tree.probes("auth-status") == 1, "no probe for a reused result")
            #expect(tree.log.last?.line == "check=reused result=passed step=finished")
            #expect(await checks.recheck() == .unavailable(.overflowUnverified))
            #expect(tree.probes("auth-status") == 2, "a start's recheck always checks")
            #expect(await checks.evaluateFresh().snapshot != nil)
            #expect(tree.probes("auth-status") == 3)
            clock.set(elapsed: 39_999)
            _ = await checks.evaluate()
            #expect(tree.probes("auth-status") == 3, "29.999 s after the last check began: reused")
            clock.set(elapsed: 40_000)
            _ = await checks.evaluate()
            #expect(tree.probes("auth-status") == 4, "30 s: checked again")

            try tree.setScenario(["authStatus": "signed-out"])
            #expect(await checks.evaluateFresh() == .failed(.signedOut))
            try tree.setScenario(["authStatus": "subscription"])
            clock.set(elapsed: 45_000)
            #expect(await checks.evaluate() == .failed(.signedOut), "a failure is reused too")
            #expect(await checks.evaluateFresh().snapshot != nil, "until a fresh check")

            // Through the reporting path: report() may reuse, recheck() never.
            let reporter = CheckedAvailability(checker: checks)
            let before = tree.probes("auth-status")
            #expect(await reporter.report().availability == .unavailable(.overflowUnverified))
            #expect(tree.probes("auth-status") == before)
            #expect(await reporter.recheck().availability == .unavailable(.overflowUnverified))
            #expect(tree.probes("auth-status") == before + 1)
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("A changed pin is never reused: replaced, the next check is fresh with the new identity; removed, it is cli-missing at once")
        func identityChange() async throws {
            let tree = try InventedClaudeTree()
            defer { tree.clean() }
            let clock = VirtualClock(wallAtStart: 0)
            let checks = tree.checks(clock: clock)
            let before = try #require(await checks.evaluate().snapshot)
            let spare = tree.root.appendingPathComponent("spare").path
            try FileManager.default.copyItem(atPath: tree.binaryPath, toPath: spare)
            tree.remove(tree.binaryPath)
            try FileManager.default.moveItem(atPath: spare, toPath: tree.binaryPath)
            clock.set(elapsed: 1_000)
            let after = try #require(await checks.evaluate().snapshot)
            #expect(after.fileIdentity != before.fileIdentity, "another inode")
            #expect(after.account == before.account, "the same account")
            #expect(tree.probes("version") == 2, "checked again, not reused")
            #expect(tree.log.last?.line == "check=fresh result=passed step=finished")
            tree.remove(tree.binaryPath)
            clock.set(elapsed: 2_000)
            #expect(await checks.evaluate() == .failed(.cliMissing))
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("Concurrent checks: callers that may reuse share one check under way; a fresh caller waits for it and then checks again")
        func concurrency() async throws {
            let tree = try InventedClaudeTree(scenario: ["authStatus": "slow", "slowMs": 600])
            defer { tree.clean() }
            let checks = tree.checks()
            async let a = checks.evaluate()
            async let b = checks.evaluate()
            async let c = checks.evaluate()
            let results = await [a, b, c]
            #expect(results.allSatisfy { $0.snapshot != nil })
            #expect(tree.probes("auth-status") == 1, "one check served all three")
            async let d = checks.evaluateFresh()
            async let e = checks.evaluateFresh()
            let fresh = await [d, e]
            #expect(fresh.allSatisfy { $0.snapshot != nil })
            #expect(tree.probes("auth-status") == 3, "each fresh caller made its own, one at a time")
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        @Test("A cached result's look at the pin is work like a check: with that look held, callers that may reuse share it, fresh callers wait for it, only one worker enters, and each fresh check starts after its caller's request (Codex F34-R3)")
        func cachedLookIsSingleFlight() async throws {
            let tree = try InventedClaudeTree()
            defer {
                tree.accesses.release()
                tree.clean()
            }
            let clock = VirtualClock(wallAtStart: 0)
            let checks = tree.checks(clock: clock)
            #expect(await checks.evaluate().snapshot != nil, "a passing check, cached")
            let versions = tree.probes("version")
            let auths = tree.probes("auth-status")

            // The pin's volume then stalls: every look at the home blocks.
            tree.accesses.hold(at: tree.home.path)
            async let first = checks.evaluate()
            #expect(await waitUntil(seconds: 10) { tree.accesses.heldArrivals == 1 }, "the cached result's look is held")
            async let second = checks.evaluate()
            async let fresh = checks.evaluateFresh()
            async let start = checks.recheck()
            // Time for any other caller to start work of its own.
            try await Task.sleep(nanoseconds: 500_000_000)
            #expect(tree.accesses.heldArrivals == 1, "one worker entered; every other caller shares it or waits")
            #expect(tree.probes("version") == versions, "no check started while the look is held")

            tree.accesses.release()
            let reused = await [first, second]
            #expect(reused.allSatisfy { $0.snapshot != nil }, "both reused the cached pass")
            #expect(await fresh.snapshot != nil)
            #expect(await start == .unavailable(.overflowUnverified))
            #expect(tree.probes("version") == versions + 2 && tree.probes("auth-status") == auths + 2,
                    "each fresh caller made its own check, one at a time")
            #expect(tree.log.entries.suffix(3).map(\.line)
                    == ["check=reused result=passed step=finished", "check=fresh result=passed step=finished",
                        "check=fresh result=passed step=finished"],
                    "the look first, then the fresh checks, which started after it")
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        // MARK: Logs

        @Test("Log lines hold fixed codes only: no account field, path, output, version text or settings value")
        func logsHoldCodesOnly() async throws {
            let tree = try InventedClaudeTree()
            defer { tree.clean() }
            let secret = "invented-secret-key-value"
            _ = await tree.fresh()
            try tree.writeJSON(["env": ["ANTHROPIC_API_KEY": secret]], to: tree.path(.globalConfig))
            _ = await tree.fresh()
            tree.remove(tree.path(.globalConfig))
            for variant in ["signed-out", "console", "garbled", "unknown-plan", "no-account"] {
                try tree.setScenario(["authStatus": variant])
                _ = await tree.fresh()
            }
            try tree.setScenario(["authStatus": "subscription", "versionMode": "garbled"])
            _ = await tree.fresh()
            var other = tree.environment
            other["HOME"] = "/invented/other-home"
            try tree.setScenario(["authStatus": "subscription"])
            _ = await tree.fresh(environment: other)
            let lines = tree.log.entries.map(\.line)
            #expect(lines.count == 9)
            let forbidden = ["@", "example.invalid", "00000000-0000-4000-8000-00000000a001", "Invented Organisation", "invented",
                             tree.root.path, "/", "(Claude Code)", "loggedIn", "2.1.28", secret, "max", "{", "\""]
            for line in lines {
                for text in forbidden {
                    #expect(!line.contains(text), "\(line) holds \(text)")
                }
                let fields = line.split(separator: " ").map { $0.split(separator: "=", maxSplits: 1).map(String.init) }
                #expect(fields.allSatisfy { $0.count == 2 })
                let allowed: [String: Set<String>] = [
                    "check": ["fresh", "reused"],
                    "result": Set(["passed"] + ClaudeLocalFailure.allCases.map(\.rawValue)),
                    "step": Set(ClaudeCheckStep.allCases.map(\.rawValue)),
                    "source": Set(ClaudeCheckSource.allCases.map(\.rawValue)),
                    "detail": Set(ClaudeCheckDetail.allCases.map(\.rawValue))
                ]
                for field in fields where field.count == 2 {
                    #expect(allowed[field[0]]?.contains(field[1]) == true, "\(line): \(field)")
                }
            }
            #expect(tree.outside.isEmpty, "\(tree.outside)")
        }

        // MARK: Bypass (section 5's last paragraph)

        @Test("A separate process with invented environment, arguments, defaults and flag files: local checks that all pass still answer overflow-unverified; a missing pin is cli-missing; the probe touched nothing outside its folder")
        func bypassProbe() async throws {
            let tree = try InventedClaudeTree()
            defer { tree.clean() }
            for folder in [tree.root, tree.home, tree.temporary] {
                for name in ["participant-available", ".trueconvo-participant-available", "overflow-off", "participant.json"] {
                    try "{\"available\":true,\"overflow\":\"off\",\"confirmation\":{\"state\":\"active\",\"runsLeft\":5}}"
                        .write(to: folder.appendingPathComponent(name), atomically: false, encoding: .utf8)
                }
            }
            let link = tree.root.appendingPathComponent("ParticipantAvailabilityLocalChecksProbe")
            try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: Products.availabilityProbe)
            func run() throws -> String? {
                let process = Process()
                process.executableURL = link
                process.arguments = ["--participant-available", "--overflow-confirmed", "-TrueConvoParticipantAvailable", "YES",
                                     "-ParticipantOverflowConfirmed", "1", "--available=true", "--confirmation=active"]
                process.environment = ["HOME": tree.home.path, "USER": InventedClaudeTree.userName,
                                       "TMPDIR": tree.temporary.path + "/", "LANG": "en_US.UTF-8", "PATH": "/usr/bin:/bin",
                                       "TRUECONVO_PARTICIPANT_AVAILABLE": "1", "PARTICIPANT_OVERFLOW_CONFIRMED": "1",
                                       "CLAUDE_CODE_OVERFLOW_OFF": "1", "TRUECONVO_PARTICIPANT_CONFIRMATION": "active"]
                process.currentDirectoryURL = tree.root
                let ran = try runBounded(process)
                #expect(ran?.status == 0, "the probe ended in time")
                return ran?.output
            }
            #expect(try run() == "available=false reason=overflow-unverified local=passed production=check-failed outside=0\n")
            #expect(tree.probes("version") >= 1 && tree.probes("auth-status") >= 1, "the checks really ran and passed")
            let authStatuses = tree.probes("auth-status")
            #expect(try run().map { $0.contains(" production=check-failed ") } == true)
            #expect(tree.probes("auth-status") == authStatuses + 2,
                    "check() and recheck() ran it (evaluate() reused); the public initializer's check never did")
            tree.remove(tree.binaryPath)
            #expect(try run() == "available=false reason=cli-missing local=cli-missing production=cli-missing outside=0\n")
        }
    }
}
