import Darwin
import Foundation
@testable import ParticipantProcess
import ParticipantSupervisorCore
import Testing

/// Starts the real supervisor directly, the way any process could, without
/// the spawner's checks: the five descriptors, `cliArguments` after the fake
/// CLI's path, and `directory` as its working folder. Waits for it to exit
/// and returns its exit code and control lines. The lifeline stays open
/// throughout, so the supervisor never takes the test for gone.
func runSupervisorDirectly(folder: FakeCLIFolder, cliArguments: [String], directory: String) throws
    -> (exitCode: Int32?, control: [String]) {
    let stdin = try DescriptorPipe.make()
    let stdout = try DescriptorPipe.make()
    let stderr = try DescriptorPipe.make()
    let lifeline = try DescriptorPipe.make()
    var pair: [Int32] = [-1, -1]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else { throw ProcessTestError.timeout("socketpair") }
    let controlApp = try DescriptorPipe.lift(pair[0])
    let controlSupervisor = try DescriptorPipe.lift(pair[1])

    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP))
    posix_spawnattr_setpgroup(&attributes, 0)
    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_addchdir_np(&actions, directory)
    for (source, target) in [(stdin.read, 0), (stdout.write, 1), (stderr.write, 2), (lifeline.read, 3),
                             (controlSupervisor, 4)] {
        posix_spawn_file_actions_adddup2(&actions, source, Int32(target))
    }
    let words = [Products.supervisor, String(getpid()), folder.cliPath] + cliArguments
    let argv: [UnsafeMutablePointer<CChar>?] = words.map { strdup($0) } + [nil]
    let envp: [UnsafeMutablePointer<CChar>?] = ParticipantEnvironment.build(from: folder.environment).map { strdup($0) } + [nil]
    defer {
        argv.forEach { free($0) }
        envp.forEach { free($0) }
    }
    var pid: pid_t = 0
    let result = posix_spawn(&pid, Products.supervisor, &actions, &attributes, argv, envp)
    for descriptor in [stdin.read, stdout.write, stderr.write, lifeline.read, controlSupervisor, stdin.write] {
        _ = close(descriptor)
    }
    defer {
        for descriptor in [stdout.read, stderr.read, lifeline.write, controlApp] { _ = close(descriptor) }
    }
    guard result == 0 else { throw ProcessTestError.missingProduct(Products.supervisor) }

    // The control socket reaches EOF when the supervisor exits.
    var bytes: [UInt8] = []
    var buffer = [UInt8](repeating: 0, count: 256)
    while true {
        let count = read(controlApp, &buffer, buffer.count)
        if count > 0 { bytes += buffer[0..<count]; continue }
        if count < 0, errno == EINTR { continue }
        break
    }
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1, errno == EINTR {}
    let exited = (status & 0x7F) == 0
    let lines = String(decoding: bytes, as: UTF8.self).split(separator: "\n").map(String.init)
    return (exited ? (status >> 8) & 0xFF : nil, lines)
}

extension ProcessSuites {
    @Suite("Launch boundary: only the pinned command line, only from a private empty folder")
    struct LaunchBoundary {
        static let pinned = ParticipantCommandLine.arguments(model: Invented.model)

        static let offContract: [[String]] = [
            ["--bare"] + pinned,
            pinned + ["--fallback-model", "invented-other"],
            pinned.filter { $0 != "--safe-mode" },
            Array(pinned.dropLast()) + ["--bare"],
            Array(pinned.dropLast()) + [""],
            Array(pinned.dropLast(2)),
            []
        ]

        @Test("The supervisor itself refuses any other command line: spawn-failed, nothing spawned", arguments: offContract)
        func supervisorRefusesArguments(_ arguments: [String]) throws {
            let folder = try FakeCLIFolder(.lines(Invented.passingStream(["never"])))
            defer { folder.clean() }
            let work = try ParticipantWorkingFolder.create(under: folder.workParent)
            let result = try runSupervisorDirectly(folder: folder, cliArguments: arguments, directory: work.path)
            #expect(result.control == ["spawn-failed"])
            #expect(result.exitCode == 2)
            #expect(folder.pid("cli.pid") == nil, "the fake CLI never ran")
        }

        @Test("The supervisor itself refuses a folder that is not private and empty: spawn-failed, nothing spawned")
        func supervisorRefusesFolder() throws {
            let folder = try FakeCLIFolder(.lines(Invented.passingStream(["never"])))
            defer { folder.clean() }
            // Open to others.
            let open = folder.root.appendingPathComponent("open").path
            #expect(mkdir(open, 0o700) == 0 && chmod(open, 0o755) == 0)
            // Private, but not empty.
            let filled = try ParticipantWorkingFolder.create(under: folder.workParent)
            try "invented".write(toFile: filled.path + "/CLAUDE.md", atomically: false, encoding: .utf8)
            for directory in [open, filled.path] {
                let result = try runSupervisorDirectly(folder: folder, cliArguments: Self.pinned, directory: directory)
                #expect(result.control == ["spawn-failed"], "\(directory)")
                #expect(result.exitCode == 2)
            }
            #expect(folder.pid("cli.pid") == nil, "the fake CLI never ran")
        }

        @Test("The pinned command line from a private empty folder runs (the control for the refusals above)")
        func supervisorRunsPinned() async throws {
            let folder = try FakeCLIFolder(.lines(Invented.passingStream(["invented"])))
            defer { folder.clean() }
            let work = try ParticipantWorkingFolder.create(under: folder.workParent)
            let result = try runSupervisorDirectly(folder: folder, cliArguments: Self.pinned, directory: work.path)
            #expect(result.control == ["spawned", "exit 0", "cleared"])
            #expect(result.exitCode == 0)
            let record = try await folder.waitForCLIRecord()
            #expect(record["argv"] as? [String] == Self.pinned)
            #expect(record["cwd"] as? String == realPath(work.path))
        }

        @Test("A working folder renamed and replaced after it was made is refused at the spawn; nothing starts")
        func swappedFolderRefused() throws {
            let folder = try FakeCLIFolder(.lines(Invented.passingStream(["never"])))
            defer { folder.clean() }
            let files = FileManager.default
            let decoy = folder.root.appendingPathComponent("decoy").path
            try files.createDirectory(atPath: decoy, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            try "invented decoy instructions".write(toFile: decoy + "/CLAUDE.md", atomically: false, encoding: .utf8)

            // Moved away, with a link to the decoy in its place.
            let linked = try ParticipantWorkingFolder.create(under: folder.workParent)
            try files.moveItem(atPath: linked.path, toPath: linked.path + "-moved")
            try files.createSymbolicLink(atPath: linked.path, withDestinationPath: decoy)
            // Something written into it.
            let filled = try ParticipantWorkingFolder.create(under: folder.workParent)
            try "invented".write(toFile: filled.path + "/CLAUDE.md", atomically: false, encoding: .utf8)
            // Replaced with an empty folder others may read.
            let reopened = try ParticipantWorkingFolder.create(under: folder.workParent)
            #expect(rmdir(reopened.path) == 0 && mkdir(reopened.path, 0o700) == 0 && chmod(reopened.path, 0o755) == 0)
            // Gone.
            let removed = try ParticipantWorkingFolder.create(under: folder.workParent)
            removed.remove()

            for working in [linked, filled, reopened, removed] {
                #expect(throws: ParticipantSpawnError.workingFolderNotPrivate, "\(working.path)") {
                    _ = try ParticipantProcessSpawner().spawn(LiveRun.launch(folder: folder, workingFolder: working))
                }
            }
            #expect(folder.pid("cli.pid") == nil, "nothing was spawned")
        }

        @Test("An invalid model is refused before anything is opened or spawned", arguments: [
            "", " ", "-x", "--bare", "invented\nmodel", "invented\u{7F}", String(repeating: "m", count: 257)
        ])
        func invalidModelRefused(_ model: String) throws {
            let folder = try FakeCLIFolder(.lines(Invented.passingStream(["never"])))
            defer { folder.clean() }
            let work = try ParticipantWorkingFolder.create(under: folder.workParent)
            #expect(throws: ParticipantSpawnError.invalidLaunch) {
                _ = try ParticipantProcessSpawner().spawn(LiveRun.launch(folder: folder, workingFolder: work, model: model))
            }
            #expect(folder.pid("cli.pid") == nil)
        }
    }
}
