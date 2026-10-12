import Darwin

/// The CLI's command line (contract section 11), shared by the app, which
/// builds it, and the supervisor, which spawns nothing else: exactly these
/// arguments after the binary path, then the build's pinned model. `--bare`
/// and `--fallback-model` never appear.
public enum CLICommandLineRule {
    /// Every argument before the model value, in order.
    public static let fixedArguments = [
        "-p",
        "--safe-mode",
        "--restricted",
        "--disable-slash-commands",
        "--tools", "",
        "--no-session-persistence",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model"
    ]

    /// Section 5: every pin string is nonblank and at most 256 UTF-8 bytes.
    public static let maxModelBytes = 256

    /// The full argument list for `model`, valid or not; `isPinned` and the
    /// spawner refuse an invalid model.
    public static func arguments(model: String) -> [String] {
        fixedArguments + [model]
    }

    /// A model value the CLI can only read as a model: nonblank, at most
    /// 256 UTF-8 bytes, not starting with `-` (so it can never read as a
    /// flag), and without control characters.
    public static func isValidModel(_ model: String) -> Bool {
        guard !model.isEmpty, model.utf8.count <= maxModelBytes, !model.hasPrefix("-") else { return false }
        guard model.unicodeScalars.contains(where: { $0 != " " && $0 != "\t" }) else { return false }
        return !model.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7F || (0x80...0x9F).contains($0.value) }
    }

    /// True for exactly the pinned list with a valid model.
    public static func isPinned(_ arguments: [String]) -> Bool {
        arguments.count == fixedArguments.count + 1
            && Array(arguments.prefix(fixedArguments.count)) == fixedArguments
            && isValidModel(arguments[fixedArguments.count])
    }
}

/// The CLI's working folder (contract section 11): an empty folder owned by
/// this user with mode 0700. Checked on an open descriptor, so a path that
/// is renamed or replaced after a check cannot point the CLI elsewhere.
public enum WorkingFolderRule {
    /// True when `descriptor` is a directory owned by this user, with mode
    /// exactly 0700 and no entry but `.` and `..`. Anything unreadable is false.
    public static func isPrivateEmptyDirectory(_ descriptor: Int32) -> Bool {
        var info = stat()
        guard fstat(descriptor, &info) == 0,
              (info.st_mode & S_IFMT) == S_IFDIR,
              info.st_uid == getuid(),
              (info.st_mode & 0o7777) == 0o700 else { return false }
        // A copy for reading, so the caller's descriptor stays open.
        let copy = fcntl(descriptor, F_DUPFD_CLOEXEC, 0)
        guard copy >= 0 else { return false }
        guard let directory = fdopendir(copy) else {
            _ = close(copy)
            return false
        }
        defer { closedir(directory) }
        rewinddir(directory)
        while true {
            errno = 0
            guard let entry = readdir(directory) else { return errno == 0 }
            let length = Int(entry.pointee.d_namlen)
            let name = withUnsafeBytes(of: entry.pointee.d_name) { Array($0.prefix(length)) }
            if name != [0x2E], name != [0x2E, 0x2E] { return false }
        }
    }

    /// The same check on this process's current directory.
    public static func currentDirectoryIsPrivateEmpty() -> Bool {
        let descriptor = open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard descriptor >= 0 else { return false }
        defer { _ = close(descriptor) }
        return isPrivateEmptyDirectory(descriptor)
    }
}
