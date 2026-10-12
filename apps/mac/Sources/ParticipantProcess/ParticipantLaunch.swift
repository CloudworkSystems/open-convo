import Darwin
import Foundation
import ParticipantSupervisorCore

/// The pinned command line (contract section 11). The binary path is always
/// injected; nothing in this module resolves or runs the real CLI. The rule
/// itself lives in `CLICommandLineRule`, which the supervisor checks again.
public enum ParticipantCommandLine {
    /// The CLI version whose `--help` lists every flag below.
    public static let pinnedCLIVersion = "2.1.283"

    /// Exactly the arguments after the binary path. `--bare` and
    /// `--fallback-model` never appear; the model is the build's pin.
    public static func arguments(model: String) -> [String] {
        CLICommandLineRule.arguments(model: model)
    }
}

/// The CLI's environment: only `HOME`, `USER`, `TMPDIR`, `LANG`, `LC_ALL` from
/// the app's own, then fixed values the app's own never change: `PATH` and
/// the four switches of Codex F0 answer 10 (`CLIEnvironmentRule.fixed`).
/// Everything else (API keys, base URLs, provider switches, proxies, the
/// app's own variables, its own values for the fixed names) is dropped. The
/// supervisor applies the same rule again before it spawns the CLI.
public enum ParticipantEnvironment {
    public static let path = CLIEnvironmentRule.path
    public static let passedNames = CLIEnvironmentRule.passedNames

    /// `NAME=value` entries in a fixed order. A missing or empty variable is
    /// left out, as is a value holding a NUL byte (it could not be passed).
    public static func build(from source: [String: String]) -> [String] {
        CLIEnvironmentRule.apply(to: passedNames.compactMap { name in source[name].map { "\(name)=\($0)" } })
    }
}

public enum ParticipantWorkingFolderError: Error, Equatable {
    case parentMissing
    /// The parent is not this user's, or others may write to it (and so
    /// could rename the run's folder and put another in its place).
    case parentNotPrivate
    case createFailed(Int32)
    case notPrivate
}

/// A new, empty folder for one run, owned by this user with mode 0700, under
/// a parent this user owns that no one else may write to. The CLI starts
/// there and finds nothing. Only `create(under:)` makes one; the spawner
/// checks it again, on an open descriptor, right before the spawn.
public struct ParticipantWorkingFolder: Sendable, Equatable {
    public let path: String

    private init(path: String) {
        self.path = path
    }

    public static func create(under parent: URL) throws -> ParticipantWorkingFolder {
        var parentInfo = stat()
        guard lstat(parent.path, &parentInfo) == 0, (parentInfo.st_mode & S_IFMT) == S_IFDIR else {
            throw ParticipantWorkingFolderError.parentMissing
        }
        guard parentInfo.st_uid == getuid(), (parentInfo.st_mode & 0o022) == 0 else {
            throw ParticipantWorkingFolderError.parentNotPrivate
        }
        let path = parent.appendingPathComponent("participant-\(UUID().uuidString.lowercased())", isDirectory: true).path
        guard mkdir(path, 0o700) == 0 else { throw ParticipantWorkingFolderError.createFailed(errno) }
        // The umask can only narrow the mode; set it exactly, then check what exists.
        _ = chmod(path, 0o700)
        let descriptor = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        let isPrivate = descriptor >= 0 && WorkingFolderRule.isPrivateEmptyDirectory(descriptor)
        if descriptor >= 0 { _ = close(descriptor) }
        guard isPrivate else {
            _ = rmdir(path)
            throw ParticipantWorkingFolderError.notPrivate
        }
        return ParticipantWorkingFolder(path: path)
    }

    /// Removes the folder and anything the run left in it. True when the
    /// folder is gone afterwards (removed now, or already absent); false when
    /// the filesystem refused, and the folder, with whatever the run left in
    /// it, may still be there. Deleting files is separate from process
    /// cleanup: a false here says nothing about the run's process group.
    @discardableResult
    public func remove() -> Bool {
        do {
            try FileManager.default.removeItem(atPath: path)
            return true
        } catch {
            var info = stat()
            return lstat(path, &info) != 0 && errno == ENOENT
        }
    }
}

/// Where the supervisor lives: bundled and signed with the app, next to its
/// executable. The path is passed to the spawner; nothing searches for it.
public enum ParticipantSupervisorLocation {
    public static let executableName = "ParticipantSupervisor"

    public static func besides(executable: URL) -> String {
        executable.deletingLastPathComponent().appendingPathComponent(executableName).path
    }
}
