import Darwin
import DeskHost
import Foundation
@testable import ParticipantProcess
import ParticipantSupervisorCore
import Testing

// The production launcher (plan S5), and the live tier of Codex Q14: the
// real supervisor and the fake CLI behind `ProcessParticipantLauncher`,
// compared with the virtual tier on the same script. The live tier may
// normalize only timestamps and text chunk boundaries; it still compares
// the ordered text bytes, event kinds and reasons, contiguous sequences, one
// last terminal, cleanup and groupCleared, stop ordering and process
// lifetime. Invented data only; never the real CLI.

/// What a live run and a virtual run of the same script must share.
struct RunShape: Equatable, CustomStringConvertible {
    /// Every update in order: each event's type (consecutive text events
    /// counted once) with its reason, the terminal with its groupCleared,
    /// and the cleanup updates where they fall. `overflowObserved` is not
    /// here: where it falls among the others depends on how reads and
    /// control messages interleave, so only its count is compared.
    var updates: [String]
    /// Every text byte, in order.
    var text: [UInt8]
    /// Each distinct `runId sessionId` the events carry, in order.
    var identities: [String]
    var groupCleared: Bool?
    /// How many `overflowObserved` updates (section 17): 0 or 1.
    var overflowObserved = 0

    init(_ updates: [ParticipantRunUpdate]) {
        var shape: [String] = []
        var text: [UInt8] = []
        var identities: [String] = []
        for update in updates {
            switch update {
            case .event(let event), .terminal(let event, _):
                let pair = "\(event.runId) \(event.sessionId)"
                if !identities.contains(pair) { identities.append(pair) }
                var entry = event.reason.map { "\(event.type.rawValue):\($0)" } ?? event.type.rawValue
                if case .terminal(_, let cleared) = update {
                    entry += " groupCleared=\(cleared.map(String.init) ?? "null")"
                }
                if event.type == .text {
                    text += Array((event.text ?? "").utf8)
                    if shape.last == entry { continue }
                }
                shape.append(entry)
            case .groupCleared: shape.append("groupCleared")
            case .cleanupRetryUncleared: shape.append("cleanupRetryUncleared")
            case .cleanupReleased: shape.append("cleanupReleased")
            case .overflowObserved: overflowObserved += 1
            }
        }
        self.updates = shape
        self.text = text
        self.identities = identities
        groupCleared = updates.terminalUpdate?.groupCleared
    }

    var description: String {
        "\(updates) text=\(String(decoding: text, as: UTF8.self)) ids=\(identities) overflowObserved=\(overflowObserved)"
    }
}

extension FakeCLIFolder.Scenario {
    /// The fake CLI writes exactly the lines a scripted run reads, with the
    /// script's gaps as sleeps. A script without an exit hangs, as the
    /// virtual CLI does, until it is signalled.
    static func script(_ steps: [ScriptStep]) -> Self {
        var scenario = Self()
        var elapsed: UInt64 = 0
        var deltaWritten = false
        var exits = false
        for step in steps {
            if step.atMs > elapsed {
                scenario.steps.append(["sleepMs": Int(step.atMs - elapsed)])
                elapsed = step.atMs
            }
            if case .exit(let code) = step.kind {
                scenario.steps.append(["exit": Int(code)])
                exits = true
                break
            }
            if case .stderr(let text) = step.kind { scenario.steps.append(["err": text]) }
            for line in step.lines(firstDelta: step.isTextDelta && !deltaWritten) {
                scenario.steps.append(["out": line])
            }
            if step.isTextDelta { deltaWritten = true }
        }
        if !exits { scenario.steps.append(["hang": true]) }
        return scenario
    }
}

enum LauncherFixture {
    static let identity = ParticipantRunIdentity(runId: "71abcdef-0000-4000-8abc-0000000000b1",
                                                 sessionId: "52abcdef-0000-4000-8abc-0000000000b1",
                                                 createdAtMillis: 1_700_000_000_000)
    /// Two chunks with a combining accent across their boundary, and an emoji.
    static let chunks = ["Invented question about caf", "e\u{301} and \u{1F600}"]

    static func request(chunks: [String] = chunks, inputBytes: Int? = nil) -> ParticipantLaunchRequest {
        ParticipantLaunchRequest(identity: identity, model: Invented.model, inputChunks: chunks,
                                 inputBytes: inputBytes ?? Data(chunks.joined().utf8).count, preparedBytes: 2_048)
    }

    static var pair: String { "\(identity.runId) \(identity.sessionId)" }

    /// The internal initializer: the fake folder's dirty environment in
    /// place of this process's own (the allow-list still applies).
    static func launcher(_ folder: FakeCLIFolder, parent: ParticipantsParent, cliPath: String? = nil,
                         supervisorPath: String = Products.supervisor, log: ParticipantLogSink) -> ProcessParticipantLauncher {
        ProcessParticipantLauncher(supervisorPath: supervisorPath, cliPath: cliPath ?? folder.cliPath, workingParent: parent,
                                   expectedInit: Invented.expectation, log: log, environment: folder.environment)
    }

    /// The same request and script on the virtual clock, settled.
    static func virtualShape(_ script: [ScriptStep], mode: SimulatedProcessMode = .exitsOnSigterm,
                             stopAt: UInt64? = nil) throws -> (RunShape, [ParticipantRunUpdate]) {
        let world = VirtualWorld(wallAtStart: identity.createdAtMillis)
        let request = request()
        let run = world.launch(identity: identity,
                               configuration: StreamJSONReader.Configuration(expectedInit: Invented.expectation,
                                                                             inputBytes: request.inputBytes,
                                                                             preparedBytes: request.preparedBytes),
                               mode: mode, script: script, untilTerminal: stopAt == nil)
        if let stopAt {
            try world.advance(to: stopAt)
            run.stop()
        }
        try world.settle()
        return (RunShape(run.recordedUpdates), run.recordedUpdates)
    }

    static func children(of parent: ParticipantsParent) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: parent.url.path)) ?? []).sorted()
    }
}

extension ProcessSuites {
    @Suite("Production launcher with the real supervisor and the fake CLI (live tier)")
    struct Launcher {
        @Test("A passing stream completes as the virtual run does; cwd was a fresh child of participants, stdin the plain joined chunks, and the folder is gone at the end")
        func passingStream() async throws {
            let vectors = try ParticipantVectors.load()
            let script = try VectorRunSetup(27, "participant.start accepted", in: vectors).script
            let folder = try FakeCLIFolder(.script(script))
            defer { folder.clean() }
            let parent = try ParticipantsFolder.prepare(in: folder.workParent)
            let log = RecordingLog()
            let request = LauncherFixture.request()
            let run = try LauncherFixture.launcher(folder, parent: parent, log: log).launch(request)
            let collector = UpdateCollector(run)
            let cli = try await folder.waitForPid("cli.pid")
            try await collector.wait(seconds: 10, for: "stream end") { $0.isFinished }

            let (virtual, _) = try LauncherFixture.virtualShape(script)
            #expect(RunShape(collector.updates) == virtual, "live \(RunShape(collector.updates)) virtual \(virtual)")
            #expect(virtual.updates == ["started", "text", "completed groupCleared=true", "cleanupReleased"])
            #expect(virtual.identities == [LauncherFixture.pair])
            checkRunInvariants(collector.updates, "live completion")
            #expect(run.snapshot.cleanup == .released && run.snapshot.groupCleared == true)

            let record = try await folder.waitForCLIRecord()
            let cwd = try #require(record["cwd"] as? String)
            #expect((cwd as NSString).deletingLastPathComponent == realPath(parent.url.path), "a child of participants")
            #expect((cwd as NSString).lastPathComponent.hasPrefix("participant-"))
            #expect(cwd != realPath(folder.workParent.path), "never the run folder itself")
            #expect(Array((record["stdin"] as? String ?? "").utf8) == Array(request.stdin), "stdin bytes exactly")
            #expect(request.stdin.count == request.inputBytes)
            let environment = folder.environment
            #expect(record["env"] as? [String] == [
                "HOME=\(environment["HOME"]!)", "USER=invented-user", "TMPDIR=\(environment["TMPDIR"]!)",
                "LANG=en_US.UTF-8"
            ] + Invented.fixedEnvironment, "only the allow-list and the fixed values, through the production launcher")
            #expect(!FileManager.default.fileExists(atPath: cwd), "the working folder is removed once the updates finish")
            #expect(LauncherFixture.children(of: parent).isEmpty, "only the run's own child was removed")
            #expect(FileManager.default.fileExists(atPath: parent.url.path), "the participants parent stays")
            #expect(Processes.members(cli).isEmpty, "the group is gone")
            #expect(!run.stop(), "the supervisor is gone (the stream ends only once it is reaped)")
        }

        @Test("A missing CLI: spawn-failed, then failed process-error at sequence 1 with groupCleared null, as the virtual run; the folder is removed")
        func missingCLI() async throws {
            let folder = try FakeCLIFolder(.script([]))
            defer { folder.clean() }
            let parent = try ParticipantsFolder.prepare(in: folder.workParent)
            let log = RecordingLog()
            let missing = folder.root.appendingPathComponent("missing-claude").path
            let run = try LauncherFixture.launcher(folder, parent: parent, cliPath: missing, log: log)
                .launch(LauncherFixture.request())
            let collector = UpdateCollector(run)
            try await collector.wait(seconds: 10, for: "stream end") { $0.isFinished }

            let (virtual, _) = try LauncherFixture.virtualShape([], mode: .spawnFails)
            #expect(RunShape(collector.updates) == virtual, "live \(RunShape(collector.updates)) virtual \(virtual)")
            #expect(virtual.updates == ["failed:process-error groupCleared=null", "cleanupReleased"])
            #expect(virtual.identities == [LauncherFixture.pair])
            #expect(collector.events.map(\.sequence) == [1])
            checkRunInvariants(collector.updates, "live missing CLI")
            #expect(folder.pid("cli.pid") == nil, "no CLI ever ran")
            #expect(log.entries.contains { $0.kind == .cliSpawnFailed })
            #expect(LauncherFixture.children(of: parent).isEmpty, "the folder is removed")
        }

        @Test("A spawner refusal (invalidLaunch) or a stdin that is not inputBytes leaves no working folder behind")
        func refusedLaunches() throws {
            let folder = try FakeCLIFolder(.script([]))
            defer { folder.clean() }
            let parent = try ParticipantsFolder.prepare(in: folder.workParent)
            let relative = LauncherFixture.launcher(folder, parent: parent, supervisorPath: "relative/ParticipantSupervisor",
                                                    log: RecordingLog())
            #expect(throws: ParticipantSpawnError.invalidLaunch) { try relative.launch(LauncherFixture.request()) }
            #expect(LauncherFixture.children(of: parent).isEmpty, "removed when the spawn throws")

            let launcher = LauncherFixture.launcher(folder, parent: parent, log: RecordingLog())
            let wrong = LauncherFixture.request(inputBytes: 1)
            #expect(throws: ParticipantLaunchError.inputBytesMismatch(expected: 1, actual: wrong.message.count)) {
                try launcher.launch(wrong)
            }
            #expect(LauncherFixture.children(of: parent).isEmpty, "refused before any folder is made")
        }

        @Test("Stop on a hanging CLI through the launcher: written first, stopped local-stop, groupCleared true, the same shape as the virtual run")
        func stop() async throws {
            let script = [ScriptStep(atMs: 0, .initClean), ScriptStep(atMs: 0, .rateLimitOK),
                          ScriptStep(atMs: 0, .textDelta("partial "))]
            let folder = try FakeCLIFolder(.script(script))
            defer { folder.clean() }
            let parent = try ParticipantsFolder.prepare(in: folder.workParent)
            let run = try LauncherFixture.launcher(folder, parent: parent, log: RecordingLog()).launch(LauncherFixture.request())
            let collector = UpdateCollector(run)
            let cli = try await folder.waitForPid("cli.pid")
            try await collector.wait(seconds: 10, for: "text") { $0.events.contains { $0.type == .text } }
            #expect(collector.terminal == nil)
            #expect(run.stop(), "stop reached the supervisor")
            try await collector.wait(seconds: 10, for: "stream end") { $0.isFinished }

            let (virtual, _) = try LauncherFixture.virtualShape(script, stopAt: 1_000)
            #expect(RunShape(collector.updates) == virtual, "live \(RunShape(collector.updates)) virtual \(virtual)")
            #expect(virtual.updates == ["started", "text", "stopped:local-stop groupCleared=true", "cleanupReleased"])
            checkRunInvariants(collector.updates, "live stop")
            #expect(Processes.members(cli).isEmpty)
            #expect(LauncherFixture.children(of: parent).isEmpty)
        }

        @Test("An init that breaks the rule (#45) ends alike live and virtual: failed process-error at sequence 1, groupCleared true")
        func initMismatch() async throws {
            let vectors = try ParticipantVectors.load()
            let script = try VectorRunSetup(45, "participant.start init mismatch fails at sequence 1", in: vectors).script
            let folder = try FakeCLIFolder(.script(script))
            defer { folder.clean() }
            let parent = try ParticipantsFolder.prepare(in: folder.workParent)
            let run = try LauncherFixture.launcher(folder, parent: parent, log: RecordingLog()).launch(LauncherFixture.request())
            let collector = UpdateCollector(run)
            let cli = try await folder.waitForPid("cli.pid")
            try await collector.wait(seconds: 10, for: "stream end") { $0.isFinished }
            let (virtual, _) = try LauncherFixture.virtualShape(script)
            #expect(RunShape(collector.updates) == virtual, "live \(RunShape(collector.updates)) virtual \(virtual)")
            #expect(virtual.updates == ["failed:process-error groupCleared=true", "cleanupReleased"])
            #expect(collector.events.map(\.sequence) == [1])
            checkRunInvariants(collector.updates, "live init mismatch")
            #expect(Processes.members(cli).isEmpty, "the group is gone")
            #expect(LauncherFixture.children(of: parent).isEmpty)
        }
    }
}

@Suite("Production launcher: configuration, the participants folder and the inactive gate")
struct ProcessLauncherGateTests {
    @Test("cliVersion is the build's pin, never a parameter (Codex Q16); the public initializer takes no environment")
    func cliVersion() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("participants-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let launcher = ProcessParticipantLauncher(supervisorPath: "/invented/ParticipantSupervisor", cliPath: "/invented/claude",
                                                  workingParent: try ParticipantsFolder.prepare(in: root),
                                                  expectedInit: Invented.expectation)
        #expect(launcher.cliVersion == ParticipantCommandLine.pinnedCLIVersion)
        #expect(launcher.environment == nil, "it reads this process's own environment")
    }

    @Test("ParticipantsFolder: a 0700 participants folder inside the run folder, reused when private, refused when a link, open to others or missing (Codex Q18)")
    func participantsFolder() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("participants-\(UUID().uuidString.prefix(8))", isDirectory: true)
        let files = FileManager.default
        try files.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? files.removeItem(at: root) }
        let run = root.appendingPathComponent("run-invented", isDirectory: true)
        try files.createDirectory(at: run, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try Data("invented store file".utf8).write(to: run.appendingPathComponent("state.json"))

        let prepared = try ParticipantsFolder.prepare(in: run)
        let parent = prepared.url
        #expect(parent.path == run.appendingPathComponent("participants").path && parent.path != run.path)
        let attributes = try files.attributesOfItem(atPath: parent.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        #expect(try ParticipantsFolder.prepare(in: run) == prepared, "an existing private one is reused")
        let child = try ParticipantWorkingFolder.create(under: parent)
        #expect((child.path as NSString).deletingLastPathComponent == parent.path)
        child.remove()
        #expect(try files.contentsOfDirectory(atPath: run.path).sorted() == ["participants", "state.json"], "nothing else touched")

        try files.setAttributes([.posixPermissions: 0o770], ofItemAtPath: parent.path)
        #expect(throws: ParticipantWorkingFolderError.notPrivate) { try ParticipantsFolder.prepare(in: run) }
        #expect((try files.attributesOfItem(atPath: parent.path)[.posixPermissions] as? NSNumber)?.intValue == 0o770,
                "refused, never repaired")

        let linked = root.appendingPathComponent("run-linked", isDirectory: true)
        try files.createDirectory(at: linked, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let elsewhere = root.appendingPathComponent("elsewhere", isDirectory: true)
        try files.createDirectory(at: elsewhere, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try files.createSymbolicLink(at: linked.appendingPathComponent("participants"), withDestinationURL: elsewhere)
        #expect(throws: ParticipantWorkingFolderError.notPrivate) { try ParticipantsFolder.prepare(in: linked) }

        let linkedRun = root.appendingPathComponent("run-is-a-link")
        try files.createSymbolicLink(at: linkedRun, withDestinationURL: run)
        #expect(throws: ParticipantWorkingFolderError.parentMissing) { try ParticipantsFolder.prepare(in: linkedRun) }

        let open = root.appendingPathComponent("run-open", isDirectory: true)
        try files.createDirectory(at: open, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o777])
        try files.setAttributes([.posixPermissions: 0o777], ofItemAtPath: open.path)
        #expect(throws: ParticipantWorkingFolderError.parentNotPrivate) { try ParticipantsFolder.prepare(in: open) }
        #expect(!files.fileExists(atPath: open.appendingPathComponent("participants").path), "nothing made in it")

        #expect(throws: ParticipantWorkingFolderError.parentMissing) {
            try ParticipantsFolder.prepare(in: root.appendingPathComponent("run-missing"))
        }
    }

    @Test("Inactive: nothing in Sources outside its own file names the production launcher or the participants folder, and nothing constructs either")
    func inactiveGate() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources")
        let files = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
        #expect(files.count > 20, "the scan read the sources")
        #expect(files.contains { $0.lastPathComponent == "ParticipantLaunching.swift" })
        var found: [String] = []
        for file in files {
            let own = file.lastPathComponent == "ParticipantLaunching.swift"
            let lines = try String(contentsOf: file, encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false)
            for line in lines where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
                // Any construction, in any file: a call, `.init`, or a typed `.init`.
                var needles = ["ProcessParticipantLauncher(", "ProcessParticipantLauncher.init", ": ProcessParticipantLauncher = .init",
                               "ParticipantsFolder.prepare("]
                // Outside the defining file, no mention at all.
                if !own {
                    needles += ["ProcessParticipantLauncher", "ParticipantsFolder", "ParticipantsParent", "LaunchedParticipantRun"]
                }
                for needle in needles where line.contains(needle) {
                    found.append("\(file.lastPathComponent): \(line.trimmingCharacters(in: .whitespaces))")
                }
            }
        }
        #expect(found.isEmpty, "\(found)")
    }

    @Test("Only the test fakes, the test target, the coordinator, section 17's window adapter, the local route and the app's lane wiring depend on ParticipantProcess; the app reaches the coordinator and the local route only through ParticipantAppWiring; the adapter stays test-only; the Desk window and the hosts depend on none of them")
    func packageDependencies() throws {
        let manifest = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Package.swift")
        let text = try String(contentsOf: manifest, encoding: .utf8)
        let target = try NSRegularExpression(pattern: #"\.(?:target|executableTarget|testTarget)\("#)
        let starts = target.matches(in: text, range: NSRange(text.startIndex..., in: text)).map(\.range.location)
        let ns = text as NSString
        var dependencies: [String: [String]] = [:]
        for (index, start) in starts.enumerated() {
            let end = index + 1 < starts.count ? starts[index + 1] : ns.length
            let segment = ns.substring(with: NSRange(location: start, length: end - start))
            guard let name = segment.firstMatch(of: #/name:\s*"([^"]+)"/#)?.1 else { continue }
            let list = segment.firstMatch(of: #/dependencies:\s*\[([^\]]*)\]/#).map { String($0.1) } ?? ""
            dependencies[String(name)] = list.matches(of: #/"([^"]+)"/#).map { String($0.1) }
        }
        for name in ["VoiceCursorMac", "DeskWindowKit", "DeskHost", "DeskHostWebKit", "DeskBundleManifest", "ParticipantProcess",
                     "ParticipantTestHost", "ParticipantAvailabilityProbe", "ParticipantProcessTests", "ParticipantCoordinator",
                     "ParticipantDeskControls", "ParticipantAppWiring"] {
            #expect(dependencies[name] != nil, "the scan found \(name)")
        }
        #expect(dependencies["VoiceCursorMac"]?.contains("DeskWindowKit") == true, "the scan reads dependency lists")
        #expect(dependencies["ParticipantCoordinator"] == ["DeskHost", "ParticipantProcess"], "the coordinator sits above both (Codex Q19)")
        let dependents = dependencies.filter { $0.value.contains("ParticipantProcess") }.keys.sorted()
        #expect(dependents == ["LocalModelRoute", "LocalModelRouteTests", "ParticipantAppWiring", "ParticipantAvailabilityProbe",
                               "ParticipantCoordinator", "ParticipantDeskControls", "ParticipantProcessTests", "ParticipantTestHost"],
                "\(dependents)")
        // The local route (contract section 20) sits on ParticipantProcess,
        // and on DeskHost for the catalog seam a participant host reads.
        // Besides test targets (its own, and this one for the shared local
        // vectors), only the app's lane wiring links it (step 3 PR 4b). The
        // coordinator does not.
        #expect(dependencies["LocalModelRoute"] == ["DeskHost", "ParticipantProcess"])
        let localDependents = dependencies.filter { $0.value.contains("LocalModelRoute") }.keys.sorted()
        // Step 3 PR 5: the kill-mid-reply proof's app (test-only, debug
        // builds only, never bundled) links it to reach the fake's port.
        #expect(localDependents == ["LocalConversationProofHost", "LocalModelRouteTests", "ParticipantAppWiring", "ParticipantProcessTests"],
                "\(localDependents)")
        // Step 3 PR 4b: the app's one lane. Exactly these modules, and only
        // the app (and this test target) link it. The Desk window kit and
        // the hosts still know no participant module.
        #expect(dependencies["ParticipantAppWiring"]
                    == ["DeskHost", "LocalModelRoute", "ParticipantCoordinator", "ParticipantProcess", "TrueConvoIdentity"])
        let wiringDependents = dependencies.filter { $0.value.contains("ParticipantAppWiring") }.keys.sorted()
        // Besides the app, only tests: this target and the kill-mid-reply
        // proof's app (step 3 PR 5), which runs the app's own lane.
        #expect(wiringDependents == ["LocalConversationProofHost", "ParticipantProcessTests", "VoiceCursorMac"], "\(wiringDependents)")
        let appParticipantModules = (dependencies["VoiceCursorMac"] ?? []).filter { $0.hasPrefix("Participant") || $0 == "LocalModelRoute" }
        #expect(appParticipantModules == ["ParticipantAppWiring"], "the app links the lane wiring and nothing else of the participant path")
        for name in ["DeskWindowKit", "DeskHost", "DeskHostWebKit", "DeskBundleManifest"] {
            #expect(!(dependencies[name] ?? []).contains { $0.hasPrefix("Participant") || $0 == "LocalModelRoute" }, "\(name)")
        }
        // Section 17's window adapter (plan F4) joins the owner to the Desk
        // window's plain controls; only the test target links it, so the app
        // links neither it nor ParticipantProcess until activation (F7).
        #expect(dependencies["ParticipantDeskControls"] == ["DeskWindowKit", "ParticipantProcess"])
        let adapterDependents = dependencies.filter { $0.value.contains("ParticipantDeskControls") }.keys.sorted()
        #expect(adapterDependents == ["ParticipantProcessTests"], "\(adapterDependents)")
        // Linking the coordinator is what could pull it into the app: only
        // the test target and the app's lane wiring may (Codex Q1, Q19; step
        // 3 PR 4b). Never the window or a host directly.
        let coordinatorDependents = dependencies.filter { $0.value.contains("ParticipantCoordinator") }.keys.sorted()
        #expect(coordinatorDependents == ["ParticipantAppWiring", "ParticipantProcessTests"], "\(coordinatorDependents)")
    }

    @Test("Nothing in Sources outside the coordinator's own folder imports, names or constructs ParticipantCoordinator but the app's lane wiring, which constructs it once; nothing constructs it in its own folder")
    func coordinatorInactiveGate() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources")
        let files = try #require(FileManager.default.subpaths(atPath: sources.path)).filter { $0.hasSuffix(".swift") }
        #expect(files.count > 20, "the scan sees the package's sources")
        #expect(files.contains("ParticipantCoordinator/ParticipantCoordinator.swift"))
        // Step 3 PR 4b: the app's lane wiring is the one file outside the
        // module that may import, name and construct it: these lines exactly.
        let wiring = "ParticipantAppWiring/LocalConversationLane.swift"
        let wiringLines: Set<String> = [
            "import ParticipantCoordinator",
            "static func makeCoordinator(route: any LocalRouteLaunching, launchId: String) -> ParticipantCoordinator {",
            "ParticipantCoordinator(configuration: ParticipantCoordinator.Configuration(",
        ]
        #expect(files.contains(wiring))
        var found: [String] = []
        var wiringFound: [String] = []
        for relative in files {
            let own = relative.hasPrefix("ParticipantCoordinator/")
            let lines = try String(contentsOf: sources.appendingPathComponent(relative), encoding: .utf8)
                .split(separator: "\n", omittingEmptySubsequences: false)
            for line in lines where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
                var needles = ["ParticipantCoordinator(", "ParticipantCoordinator.init", ": ParticipantCoordinator = .init"]
                // Inside its own module a construction can also be spelled
                // `Self(configuration:` or `.init(configuration:` (a static
                // `shared`, say); no other type there takes that label.
                if own { needles += ["Self(configuration:", ".init(configuration:"] }
                if !own { needles += ["ParticipantCoordinator", "import ParticipantCoordinator"] }
                let code = line.trimmingCharacters(in: .whitespaces)
                guard needles.contains(where: { line.contains($0) }) else { continue }
                if relative == wiring && wiringLines.contains(code) {
                    wiringFound.append(code)
                } else {
                    found.append("\(relative): \(code)")
                }
            }
        }
        #expect(found.isEmpty, "\(found)")
        #expect(wiringFound.sorted() == wiringLines.sorted(), "the wiring constructs it exactly once: \(wiringFound)")
    }

    @Test("The coordinator cannot make an answer available: its sources never write `available`, and its entry comes from the report")
    func coordinatorNeverFabricatesAvailable() throws {
        let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/ParticipantCoordinator")
        let files = try FileManager.default.contentsOfDirectory(atPath: folder.path).filter { $0.hasSuffix(".swift") }
        #expect(files.count >= 4)
        let code = try files.flatMap { file in
            try String(contentsOf: folder.appendingPathComponent(file), encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.hasPrefix("//") }
        }
        #expect(!code.contains { $0.contains("\"available\"") }, "no `available` key is written here")
        #expect(!code.contains { $0.contains("available: true") || $0.contains(".available") && !$0.contains("availability.available") })
        #expect(!code.contains { $0.contains("@testable") })
        #expect(code.contains { $0.contains("entry.merge(report.jsonFields)") }, "the entry's answer is the report's own fields")
    }
}
