import Darwin
import Foundation
@testable import ParticipantProcess
@testable import ParticipantSupervisorCore
import Testing

/// The availability fake. It exists only in the test target: outside
/// `ParticipantProcess`, only `@testable import` reaches `.available`.
struct InventedAvailability: AvailabilityChecking {
    func check() async -> ParticipantAvailability { .available }
}

@Suite("Pinned command line, environment, folder, availability, log")
struct ParticipantLaunchTests {
    @Test("The pinned argv, exactly, with the build's model")
    func pinnedArguments() {
        let arguments = ParticipantCommandLine.arguments(model: "invented-pinned-model")
        #expect(arguments == ["-p", "--safe-mode", "--restricted", "--disable-slash-commands", "--tools", "",
                              "--no-session-persistence", "--output-format", "stream-json", "--verbose",
                              "--include-partial-messages", "--model", "invented-pinned-model"])
        #expect(!arguments.contains("--bare"))
        #expect(!arguments.contains("--fallback-model"))
        #expect(ParticipantCommandLine.pinnedCLIVersion == "2.1.283")
        #expect(CLICommandLineRule.isPinned(arguments))
    }

    @Test("Only the pinned list with a valid model counts as pinned")
    func pinnedRule() {
        let pinned = ParticipantCommandLine.arguments(model: "invented-pinned-model")
        #expect(!CLICommandLineRule.isPinned(["--bare"] + pinned))
        #expect(!CLICommandLineRule.isPinned(pinned + ["--fallback-model", "invented"]))
        #expect(!CLICommandLineRule.isPinned(pinned.filter { $0 != "--restricted" }))
        #expect(!CLICommandLineRule.isPinned(Array(pinned.dropLast())))
        #expect(!CLICommandLineRule.isPinned([]))
        for model in ["", " ", "-p", "--bare", "a\tb", "a\u{85}b", String(repeating: "m", count: 257)] {
            #expect(!CLICommandLineRule.isValidModel(model), "\(model.debugDescription)")
            #expect(!CLICommandLineRule.isPinned(Array(pinned.dropLast()) + [model]))
        }
        for model in ["invented-pinned-model", "invented model 1.5", String(repeating: "m", count: 256), "é-model"] {
            #expect(CLICommandLineRule.isValidModel(model), "\(model.debugDescription)")
        }
    }

    @Test("Only HOME, USER, TMPDIR, LANG and LC_ALL pass; PATH is fixed")
    func environmentAllowList() {
        let source = [
            "HOME": "/invented/home", "USER": "invented", "TMPDIR": "/invented/tmp/", "LANG": "en_US.UTF-8",
            "LC_ALL": "en_US.UTF-8", "PATH": "/invented/bin:/usr/local/bin",
            "ANTHROPIC_API_KEY": "invented-not-a-key", "ANTHROPIC_AUTH_TOKEN": "invented",
            "ANTHROPIC_BASE_URL": "http://invented.invalid", "CLAUDE_CODE_USE_BEDROCK": "1",
            "CLAUDE_CODE_USE_VERTEX": "1", "HTTPS_PROXY": "http://invented.invalid", "SHELL": "/bin/zsh",
            "__CF_USER_TEXT_ENCODING": "0x0:0x0:0x0", "DYLD_INSERT_LIBRARIES": "/invented.dylib"
        ]
        #expect(ParticipantEnvironment.build(from: source) == [
            "HOME=/invented/home", "USER=invented", "TMPDIR=/invented/tmp/", "LANG=en_US.UTF-8",
            "LC_ALL=en_US.UTF-8", "PATH=/usr/bin:/bin:/usr/sbin:/sbin"
        ])
        #expect(ParticipantEnvironment.build(from: ["HOME": "", "USER": "a\u{0}b"]) == ["PATH=/usr/bin:/bin:/usr/sbin:/sbin"])
    }

    @Test("The supervisor's second pass keeps the first value and drops what the runtime added")
    func supervisorEnvironmentRule() {
        let entries = ["__CF_USER_TEXT_ENCODING=0x1F7:0x0:0x0", "HOME=/invented/home", "HOME=/invented/second",
                       "PATH=/invented", "USER=invented", "NOEQUALS", "LANG="]
        #expect(CLIEnvironmentRule.apply(to: entries) == ["HOME=/invented/home", "USER=invented",
                                                          "PATH=/usr/bin:/bin:/usr/sbin:/sbin"])
    }

    @Test("The working folder is new, empty, this user's and mode 0700")
    func workingFolder() throws {
        let parent = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("wf-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let folder = try ParticipantWorkingFolder.create(under: parent)
        var info = stat()
        #expect(lstat(folder.path, &info) == 0)
        #expect(info.st_mode & 0o7777 == 0o700)
        #expect(info.st_uid == getuid())
        #expect(try FileManager.default.contentsOfDirectory(atPath: folder.path).isEmpty)
        let second = try ParticipantWorkingFolder.create(under: parent)
        #expect(second.path != folder.path)
        folder.remove()
        #expect(!FileManager.default.fileExists(atPath: folder.path))
        #expect(throws: ParticipantWorkingFolderError.parentMissing) {
            try ParticipantWorkingFolder.create(under: parent.appendingPathComponent("missing"))
        }
    }

    @Test("The working folder's parent must be this user's and closed to others' writes")
    func workingFolderParent() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("wf-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }
        for mode: mode_t in [0o777, 0o775, 0o757, 0o1777] {
            let parent = base.appendingPathComponent("mode-\(String(mode, radix: 8))")
            #expect(mkdir(parent.path, 0o700) == 0 && chmod(parent.path, mode) == 0)
            #expect(throws: ParticipantWorkingFolderError.parentNotPrivate, "mode \(String(mode, radix: 8))") {
                try ParticipantWorkingFolder.create(under: parent)
            }
            #expect(try FileManager.default.contentsOfDirectory(atPath: parent.path).isEmpty, "nothing was made")
        }
        // A folder of another user's (root's home), which this user cannot write either.
        var info = stat()
        if lstat("/private/var/root", &info) == 0, info.st_uid != getuid() {
            #expect(throws: ParticipantWorkingFolderError.parentNotPrivate) {
                try ParticipantWorkingFolder.create(under: URL(fileURLWithPath: "/private/var/root"))
            }
        }
        // A link to a folder is not the folder.
        let real = base.appendingPathComponent("real")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: false)
        let link = base.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        #expect(throws: ParticipantWorkingFolderError.parentMissing) { try ParticipantWorkingFolder.create(under: link) }
        let made = try ParticipantWorkingFolder.create(under: real)
        #expect(made.path.hasPrefix(real.path + "/participant-"))
    }

    @Test("A failed group probe is unknown, never an empty group")
    func groupProbeFailure() throws {
        // proc_listpids answers 0 both for an empty group and for an error,
        // telling them apart only by errno: a buffer under one pid makes it fail.
        #expect(ProcessGroupProbe.members(of: getpgrp(), bufferBytes: 2) == nil)
        #expect(ProcessGroupProbe.members(of: getpgrp())?.contains(getpid()) == true)
        // A group no process leads any more: truly empty.
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawnattr_setpgroup(&attributes, 0)
        let argv: [UnsafeMutablePointer<CChar>?] = [strdup("/usr/bin/true"), nil]
        defer { argv.forEach { free($0) } }
        var pid: pid_t = 0
        #expect(posix_spawn(&pid, "/usr/bin/true", nil, &attributes, argv, environ) == 0)
        var status: Int32 = 0
        while waitpid(pid, &status, 0) == -1, errno == EINTR {}
        #expect(ProcessGroupProbe.members(of: pid) == [])
    }

    @Test("Shipping availability is overflow-unverified whatever the environment or defaults say")
    func shippingAvailability() async {
        let names = ["TRUECONVO_PARTICIPANT_AVAILABLE", "PARTICIPANT_OVERFLOW_CONFIRMED", "CLAUDE_CODE_OVERFLOW_OFF"]
        for name in names { setenv(name, "1", 1) }
        defer { for name in names { unsetenv(name) } }
        // Invented defaults in the registration domain: this process's memory
        // only, never written to disk. (The argument domain is checked in a
        // separate process below, from its launch arguments.)
        UserDefaults.standard.register(defaults: ["TrueConvoParticipantAvailable": true,
                                                  "ParticipantOverflowConfirmed": true,
                                                  "participant.available": "YES"])
        #expect(UserDefaults.standard.bool(forKey: "TrueConvoParticipantAvailable"), "the invented defaults are visible")
        let answer = await ShippingAvailability().check()
        #expect(answer == .unavailable(.overflowUnverified))
        #expect(!answer.available)
        #expect(ParticipantUnavailableReason.allCases.map(\.rawValue) == [
            "cli-missing", "cli-version-mismatch", "provider-override", "signed-out", "not-subscription",
            "overflow-unverified", "check-failed"
        ])
        // The test target's own fake is the only way to an available answer.
        let fake = await InventedAvailability().check()
        #expect(fake.available && fake.reason == nil)
    }

    @Test("A separate process with invented environment, arguments, defaults and flag files still answers overflow-unverified")
    func availabilityProbeProcess() throws {
        try Products.require()
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("avail-\(UUID().uuidString.prefix(8))")
        let home = root.appendingPathComponent("home")
        let temporary = root.appendingPathComponent("tmp")
        for folder in [home, temporary] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
        defer { try? FileManager.default.removeItem(at: root) }
        for folder in [root, home, temporary] {
            for name in ["participant-available", ".trueconvo-participant-available", "overflow-off", "participant.json"] {
                try "{\"available\":true,\"overflow\":\"off\"}".write(to: folder.appendingPathComponent(name),
                                                                       atomically: false, encoding: .utf8)
            }
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: Products.availabilityProbe)
        process.arguments = ["--participant-available", "--overflow-confirmed", "-TrueConvoParticipantAvailable", "YES",
                             "-ParticipantOverflowConfirmed", "1", "--available=true"]
        process.environment = ["HOME": home.path, "TMPDIR": temporary.path + "/", "LANG": "en_US.UTF-8",
                               "PATH": "/usr/bin:/bin", "TRUECONVO_PARTICIPANT_AVAILABLE": "1",
                               "PARTICIPANT_OVERFLOW_CONFIRMED": "1", "CLAUDE_CODE_OVERFLOW_OFF": "1"]
        process.currentDirectoryURL = root
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)
        #expect(String(decoding: data, as: UTF8.self) == "available=false reason=overflow-unverified\n")
    }

    @Test("The availability source has no build-configuration branch, reads no input, and nothing public says available")
    func availabilitySource() throws {
        // A Release build compiles this same file; with no #if in it, Debug and
        // Release get the same constant answer the tests above check.
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/ParticipantProcess/ParticipantAvailability.swift")
        let code = try String(contentsOf: file, encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.hasPrefix("//") }
        #expect(!code.isEmpty)
        #expect(!code.contains { $0.hasPrefix("#if") || $0.hasPrefix("#elseif") }, "no build-configuration branch")
        for input in ["import Foundation", "ProcessInfo", "UserDefaults", "CommandLine", "getenv", "environ",
                      "FileManager", "fopen", "open(", "Bundle", "NSUserDefaults", "@_spi"] {
            #expect(!code.contains { $0.contains(input) }, "reads no input: \(input)")
        }
        let availableTrue = code.filter { $0.contains("available: true") }
        #expect(availableTrue.count == 1, "one place makes an available answer")
        #expect(availableTrue.allSatisfy { !$0.contains("public") && !$0.contains("open ") })
        #expect(code.contains("private init(available: Bool, reason: ParticipantUnavailableReason?) {"))
    }

    @Test("Timestamps are UTC with milliseconds and round-trip")
    func timestamps() {
        #expect(ParticipantTimestamp.format(millis: 1_700_000_000_123) == "2023-11-14T22:13:20.123Z")
        #expect(ParticipantTimestamp.format(millis: 0) == "1970-01-01T00:00:00.000Z")
        #expect(ParticipantTimestamp.parse("2023-11-14T22:13:20.123Z") == 1_700_000_000_123)
        #expect(ParticipantTimestamp.parse("2023-02-30T00:00:00.000Z") == nil)
        #expect(ParticipantTimestamp.parse("2023-11-14 22:13:20.123Z") == nil)
    }

    @Test("A log line holds only ids, types, counts, codes and fixed reasons")
    func logLine() {
        let entry = ParticipantLogEntry(runId: "51000000-0000-4000-8000-0000000000aa", kind: .event, eventType: .text,
                                        sequence: 2, byteCount: 11)
        #expect(entry.line == "run=51000000-0000-4000-8000-0000000000aa kind=event event=text sequence=2 bytes=11")
        let exit = ParticipantLogEntry(runId: "r", kind: .cliExited, exitCode: 1, signal: nil,
                                       reason: .failure(.processError))
        #expect(exit.line == "run=r kind=cli-exited exit=1 reason=process-error")
        #expect(ParticipantWaitStatus.decode(256).exitCode == 1)
        #expect(ParticipantWaitStatus.decode(256).signal == nil)
        #expect(ParticipantWaitStatus.decode(9).exitCode == nil)
        #expect(ParticipantWaitStatus.decode(9).signal == 9)
        #expect(ParticipantWaitStatus.decode(0).exitCode == 0)
    }
}
