import Darwin
import Foundation
import Security
import Testing

/// The packaged test copy that `TRUECONVO_PACKAGED_APP` names: a built
/// `dist/True Convo Test.app` from `scripts/package_app.sh --test-identity`.
/// Only its helper program is ever run, the way the app would run it; the app
/// itself is never opened, launched or installed.
enum PackagedApp {
    static let variable = "TRUECONVO_PACKAGED_APP"
    static let bundleName = "True Convo Test.app"
    static let bundleIdentifier = "com.trueconvo.voice-cursor.test"
    static let helperIdentifier = "com.trueconvo.voice-cursor.test.participant-supervisor"
    /// Contents/MacOS, sorted: the allow-list package_app.sh enforces.
    static let programs = ["ParticipantSupervisor", "True Convo Test"]

    /// The variable's value, when it is set and not empty.
    static var named: String? {
        guard let value = ProcessInfo.processInfo.environment[variable], !value.isEmpty else { return nil }
        return value
    }

    struct Problem: Error, CustomStringConvertible {
        let description: String
    }

    /// The app's folder, once the variable names an existing True Convo Test.app
    /// by an absolute path. A wrong value fails the tier (it is never skipped),
    /// so a mistaken path cannot pass as packaged evidence.
    static func app() throws -> URL {
        guard let named else { throw Problem(description: "\(variable) is not set") }
        guard named.hasPrefix("/") else { throw Problem(description: "\(variable) must be an absolute path, not \(named)") }
        let url = URL(fileURLWithPath: named, isDirectory: true).standardizedFileURL
        guard url.lastPathComponent == bundleName else {
            throw Problem(description: "\(variable) must name a \(bundleName), not \(url.lastPathComponent)")
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw Problem(description: "no built app at \(url.path)")
        }
        return url
    }

    static var helper: URL {
        get throws { try app().appendingPathComponent("Contents/MacOS/ParticipantSupervisor") }
    }

    /// What `inspect()` found: the copy's TCSourceCommit, whether this
    /// checkout has local changes, and every check that failed.
    struct Inspection {
        var commit: String?
        var checkoutClean: Bool?
        var problems: [String] = []
    }

    /// Every check the packaged evidence relies on, collected so `bundle()`
    /// can report them all and every run depends on them: the bundle id;
    /// TCSourceCommit equal to this checkout's HEAD (a copy packaged from an
    /// older commit fails, so it cannot pass as evidence for this one);
    /// exactly the two programs; the helper a plain executable file, not a
    /// link; both signatures valid (the app's with its nested code); both
    /// identifiers.
    static func inspect() -> Inspection {
        var found = Inspection()
        let app: URL
        do { app = try self.app() } catch {
            found.problems.append("\(error)")
            return found
        }
        let helper = app.appendingPathComponent("Contents/MacOS/ParticipantSupervisor")
        let plist = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")) as? [String: Any]
        let identifier = plist?["CFBundleIdentifier"] as? String
        if identifier != bundleIdentifier {
            found.problems.append("CFBundleIdentifier is \(identifier ?? "missing"), not \(bundleIdentifier)")
        }
        found.commit = plist?["TCSourceCommit"] as? String
        do {
            let checkout = try Checkout.read()
            found.checkoutClean = checkout.clean
            if found.commit != checkout.head {
                found.problems.append("TCSourceCommit is \(found.commit ?? "missing"), not this checkout's HEAD \(checkout.head); package this commit with --test-identity first")
            }
        } catch {
            found.problems.append("\(error)")
        }
        let listed = (try? FileManager.default.contentsOfDirectory(atPath: app.appendingPathComponent("Contents/MacOS").path)) ?? []
        if listed.sorted() != programs {
            found.problems.append("Contents/MacOS holds \(listed.sorted()), not exactly \(programs)")
        }
        var information = stat()
        if lstat(helper.path, &information) != 0 || information.st_mode & S_IFMT != S_IFREG || access(helper.path, X_OK) != 0 {
            found.problems.append("Contents/MacOS/ParticipantSupervisor is not a plain executable file")
            return found
        }
        let checks: [(String, () throws -> Bool)] = [
            ("the helper's signature (strict)", { try validity(helper, nested: false) == errSecSuccess }),
            ("the app's signature, nested code included (strict)", { try validity(app, nested: true) == errSecSuccess }),
            ("the helper's identifier is \(helperIdentifier)", { try signingIdentifier(helper) == helperIdentifier }),
            ("the app's identifier is \(bundleIdentifier)", { try signingIdentifier(app) == bundleIdentifier }),
        ]
        for (name, check) in checks {
            do {
                if try !check() { found.problems.append("failed: \(name)") }
            } catch {
                found.problems.append("failed: \(name): \(error)")
            }
        }
        return found
    }

    /// The helper inside the packaged app, as the supervisor the shared
    /// parent-death and supervisor-loss bodies run, once every check in
    /// `inspect()` has passed. It prints the copy's TCSourceCommit next to
    /// that run's timings, so the evidence names the build it tested.
    static func supervisor() throws -> SupervisorUnderTest {
        let found = inspect()
        guard found.problems.isEmpty, let commit = found.commit else {
            throw Problem(description: "the packaged app failed its checks: \(found.problems.joined(separator: "; "))")
        }
        report(commit, clean: found.checkoutClean)
        return SupervisorUnderTest(path: try helper.path, label: "packaged ")
    }

    static func report(_ commit: String, clean: Bool?) {
        let checkout = clean.map { $0 ? "clean" : "with local changes" } ?? "unknown"
        print("[measure] packaged source-commit=\(commit) (this checkout's HEAD; checkout \(checkout))")
    }

    /// Local signature checks only (Security's static code API reads the files;
    /// an ad hoc signature has no certificate to evaluate).
    static func staticCode(_ url: URL) throws -> SecStaticCode {
        var code: SecStaticCode?
        let status = SecStaticCodeCreateWithPath(url as CFURL, SecCSFlags(), &code)
        guard status == errSecSuccess, let code else {
            throw Problem(description: "SecStaticCodeCreateWithPath \(url.lastPathComponent): \(status)")
        }
        return code
    }

    static func signingIdentifier(_ url: URL) throws -> String? {
        var information: CFDictionary?
        let status = SecCodeCopySigningInformation(try staticCode(url), SecCSFlags(rawValue: kSecCSSigningInformation),
                                                   &information)
        guard status == errSecSuccess else {
            throw Problem(description: "SecCodeCopySigningInformation \(url.lastPathComponent): \(status)")
        }
        return (information as? [String: Any])?[kSecCodeInfoIdentifier as String] as? String
    }

    /// `codesign --verify --strict`, plus nested code for the app.
    static func validity(_ url: URL, nested: Bool) throws -> OSStatus {
        var flags = SecCSFlags(rawValue: kSecCSStrictValidate)
        if nested { flags.formUnion(SecCSFlags(rawValue: kSecCSCheckNestedCode | kSecCSCheckAllArchitectures)) }
        return SecStaticCodeCheckValidity(try staticCode(url), flags, nil)
    }

    /// The checkout these tests were built from, read with git: its HEAD and
    /// whether it has local changes. Each git call is bounded (10 s, then it
    /// is killed and the tier fails) and takes no optional locks.
    enum Checkout {
        static func read() throws -> (head: String, clean: Bool) {
            let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path
            let head = try git(["-C", folder, "rev-parse", "--verify", "HEAD"]).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !head.isEmpty else { throw Problem(description: "git rev-parse HEAD printed nothing") }
            let changes = try git(["-C", folder, "status", "--porcelain", "--untracked-files=all"])
            return (head, changes.isEmpty)
        }

        static func git(_ arguments: [String], seconds: Int = 10) throws -> String {
            // Output goes to a private temporary file, never a pipe that could fill.
            let output = FileManager.default.temporaryDirectory
                .appendingPathComponent("packaged-tier-git-\(UUID().uuidString).txt")
            guard FileManager.default.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                throw Problem(description: "could not create \(output.path)")
            }
            defer { try? FileManager.default.removeItem(at: output) }
            let handle = try FileHandle(forWritingTo: output)
            defer { try? handle.close() }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            process.arguments = ["--no-optional-locks"] + arguments
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = handle
            process.standardError = FileHandle.nullDevice
            let done = DispatchSemaphore(value: 0)
            process.terminationHandler = { _ in done.signal() }
            try process.run()
            if done.wait(timeout: .now() + .seconds(seconds)) == .timedOut {
                _ = kill(process.processIdentifier, SIGKILL)
                _ = done.wait(timeout: .now() + .seconds(2))
                throw Problem(description: "git \(arguments.joined(separator: " ")) took more than \(seconds) s; stopped")
            }
            guard process.terminationStatus == 0 else {
                throw Problem(description: "git \(arguments.joined(separator: " ")) exited \(process.terminationStatus)")
            }
            return try String(contentsOf: output, encoding: .utf8)
        }
    }
}

extension ProcessSuites {
    /// F2's packaged tier (contract section 11). The shipping parent-death
    /// variants run with the ParticipantSupervisor inside a packaged, ad hoc
    /// signed True Convo Test.app, driven by this build's test host and fake
    /// CLI, never the real CLI: within 10 s of the host's death (or of the
    /// lifeline closing) no member of the fake's group remains, and within
    /// 6.25 s no supervisor. Supervisor loss runs the same helper from this
    /// test process itself, with no test host, and kills only the helper.
    /// Before each run, every check in `PackagedApp.inspect()` must pass,
    /// including TCSourceCommit equal to this checkout's HEAD, and the run
    /// checks that the process it started is that helper. Runs only when
    /// TRUECONVO_PACKAGED_APP is set (unset, the tier is skipped and supplies
    /// no packaged evidence):
    ///
    ///     TRUECONVO_PACKAGED_APP="$PWD/dist/True Convo Test.app" swift test -j 2 --filter PackagedSupervisorTests
    ///
    /// Question 21, as Codex's F2 review ruled it (split evidence, accepted
    /// for section 16.4's packaged-helper mechanism with FakeCLI and the test
    /// host): these runs prove bounded cleanup outcomes with the shipping
    /// helper. Two checks stay test-build-only, in `ParentDeath`, run by
    /// ParticipantPausingSupervisor (the same supervisor core and driver plus
    /// test-only hooks): `pausedBeforeWatch` (a death before `NOTE_EXIT` is
    /// registered: the `getppid()` check sees `parentChanged`, and no CLI is
    /// spawned) and `leakedLifelineCause` (which trigger caused the cleanup:
    /// `appExitNote`). Never add pause or cause hooks, or the pausing
    /// executable, to the shipped helper to fold those two in. Killed while
    /// starting records which branch each run took (`cli-spawned=yes/no`);
    /// one run shows one branch, never both. The two layers count only from
    /// the same exact candidate (this tier against a copy packaged from that
    /// commit, `ParentDeath` from the same commit), and each receipt keeps the
    /// commit and the reported checkout state: a checkout with local changes
    /// is reported, not refused, so a matching TCSourceCommit alone is not
    /// proof.
    @Suite("Packaged supervisor: the helper inside True Convo Test.app",
           .enabled(if: PackagedApp.named != nil, "set TRUECONVO_PACKAGED_APP to a built dist/True Convo Test.app"))
    struct PackagedSupervisorTests {
        @Test("The bundle is the packaged test copy of this checkout's HEAD: its bundle id, TCSourceCommit, exactly two programs, valid signatures, the helper's own identifier")
        func bundle() throws {
            let found = PackagedApp.inspect()
            #expect(found.problems == [])
            #expect(found.commit != nil)
            if let commit = found.commit { PackagedApp.report(commit, clean: found.checkoutClean) }
        }

        @Test("Killed while running: SIGTERM ignored, SIGKILL at 3 s, group empty, supervisor gone")
        func killWhileRunning() async throws {
            try await ParentDeathRun.killWhileRunning(PackagedApp.supervisor())
        }

        @Test("Killed while starting: right after the supervisor is spawned; records which branch this run took (CLI spawned or not)")
        func killWhileStarting() async throws {
            try await ParentDeathRun.killWhileStarting(PackagedApp.supervisor())
        }

        @Test("Killed during a Stop's wait: the 10 s wait is cut to the 3 s bound")
        func killDuringStopWait() async throws {
            try await ParentDeathRun.killDuringStopWait(PackagedApp.supervisor())
        }

        @Test("The host closes the lifeline without exiting: cleanup runs and is still reported")
        func lifelineClosed() async throws {
            try await ParentDeathRun.lifelineClosed(PackagedApp.supervisor())
        }

        @Test("The leader exits on SIGTERM while its child ignores it: the zombie leader keeps the group reserved")
        func leaderExitsChildIgnores() async throws {
            try await ParentDeathRun.leaderExitsChildIgnores(PackagedApp.supervisor())
        }

        @Test("The lifeline leaked to a sleeper: bounded cleanup within 6 s, the sleeper still running")
        func leakedLifeline() async throws {
            try await ParentDeathRun.leakedLifeline(PackagedApp.supervisor())
        }

        @Test("A leader that moved into the supervisor's group and ignores SIGTERM: the SIGKILL at 3 s still reaches it")
        func leaderLeftGroup() async throws {
            try await ParentDeathRun.leaderLeftGroup(PackagedApp.supervisor())
        }

        @Test("Supervisor loss: SIGKILL only the supervisor; failed process-error, owned until the pipes close")
        func supervisorLoss() async throws {
            try await LiveRun.supervisorLoss(PackagedApp.supervisor())
        }
    }
}
