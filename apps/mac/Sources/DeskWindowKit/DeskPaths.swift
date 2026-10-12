import Darwin
import Foundation

/// Where the invented Desk keeps its files.
///
/// One base folder, `~/Library/Application Support/com.trueconvo.voice-cursor/desk-invented-proof/`,
/// mode 0700, holding a plain `INVENTED-DATA-ONLY.txt` marker, and inside it
/// one store folder per app run, `run-<yyyyMMdd-HHmmss>-<8 hex>/`, mode
/// 0700, created on the run's first unlock. The made-up key for a run
/// folder lives only in that run's memory, so a folder from an earlier run
/// can never be opened again; it is left exactly as it was.
///
/// The Application Support folder is resolved once per use (so system
/// aliases above it, such as `/var` for `/private/var`, are fine). Below it,
/// `com.trueconvo.voice-cursor`, `desk-invented-proof` and each run folder
/// are opened one at a time, each relative to the one before, never
/// following a link. Each must be a plain folder owned by this user that no
/// group or other user can write to; anything else is refused before it is
/// read, created in or changed. Every create, permission change, marker
/// write and listing goes through those open folders, so a name swapped
/// after the check is never followed. Nothing here ever deletes anything.
public struct DeskPaths: Equatable, Sendable {
    public enum Failure: Error, Equatable, Sendable {
        /// A symbolic link where an app-owned folder belongs.
        case symlinkedFolder(String)
        /// Something other than a plain folder where one belongs.
        case notAFolder(String)
        /// An app-owned folder that belongs to another user.
        case notYours(String)
        /// An app-owned folder that a group or other users can write to.
        case openToOthers(String)
        /// An app-owned folder that is there but could not be opened (errno).
        case cannotOpen(String, Int32)
        /// The marker is a link or not a plain file.
        case unsafeMarker
        /// A folder or the marker could not be made (errno).
        case cannotCreate(String, Int32)
    }

    public static let appFolderName = "com.trueconvo.voice-cursor"
    public static let baseFolderName = "desk-invented-proof"
    public static let markerFileName = "INVENTED-DATA-ONLY.txt"
    public static let markerText = """
    Invented data only.

    True Convo's Desk window keeps made-up proof data here, one folder per app
    run. Each folder's made-up key lived only in that run's memory, so a folder
    from an earlier run cannot be opened again. Nothing here is real or
    private, and nothing here is deleted automatically.

    """
    public static let runFolderPrefix = "run-"

    /// The user's Application Support folder (or an invented one in tests).
    public let applicationSupport: URL
    /// `applicationSupport/com.trueconvo.voice-cursor/desk-invented-proof`, as given.
    public let base: URL

    public init(applicationSupport: URL) {
        self.applicationSupport = applicationSupport
        base = applicationSupport
            .appendingPathComponent(Self.appFolderName, isDirectory: true)
            .appendingPathComponent(Self.baseFolderName, isDirectory: true)
    }

    /// The app's own base folder for the invented Desk.
    public static func standard(fileManager: FileManager = .default) -> DeskPaths? {
        guard let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        return DeskPaths(applicationSupport: support)
    }

    enum Node: Equatable {
        case absent, directory, regular, symlink, other
    }

    static func inspect(_ path: String) -> Node {
        var info = Darwin.stat()
        guard lstat(path, &info) == 0 else { return errno == ENOENT ? .absent : .other }
        switch info.st_mode & S_IFMT {
        case S_IFDIR: return .directory
        case S_IFREG: return .regular
        case S_IFLNK: return .symlink
        default: return .other
        }
    }

    /// Names of the run folders already in the base. Reads only; creates
    /// nothing, and a base that is missing or unsafe has none.
    public func existingRunFolderNames() -> [String] {
        guard let base = try? openBase(creating: false) else { return [] }
        return Self.entryNames(in: base).filter { $0.hasPrefix(Self.runFolderPrefix) }.sorted()
    }

    /// Makes sure the base exists as a plain 0700 folder holding the marker,
    /// and returns its checked path.
    @discardableResult
    public func prepareBase() throws -> URL {
        let base = try openBaseForWriting()
        try Self.makePrivate(base)
        return base.url
    }

    /// Creates this run's store folder: a new name every time, never an
    /// existing folder reused, nothing removed. The path returned has just
    /// been walked again, without following links, to this very folder.
    public func makeRunFolder(now: Date = Date()) throws -> URL {
        try makeRunFolder(now: now, afterCheck: {})
    }

    /// `afterCheck` runs once the base is open and checked, before anything
    /// is made or changed in it (a test seam for a swap at that moment).
    func makeRunFolder(now: Date, afterCheck: () throws -> Void) throws -> URL {
        let base = try openBaseForWriting()
        try afterCheck()
        try Self.makePrivate(base)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let stamp = formatter.string(from: now)
        for _ in 0..<8 {
            var generator = SystemRandomNumberGenerator()
            let suffix = String(format: "%08x", UInt32.random(in: .min ... .max, using: &generator))
            let name = "\(Self.runFolderPrefix)\(stamp)-\(suffix)"
            if mkdirat(base.descriptor, name, 0o700) == 0 {
                guard let run = try Self.openChild(name, in: base, label: "run", creating: false) else {
                    throw Failure.cannotCreate("run", ENOENT)
                }
                _ = fchmod(run.descriptor, 0o700)
                // Walk to it again by name: the path handed on must still
                // lead, through no link, to the folder just made.
                let again = try openRunFolder(named: name)
                guard again.identity == run.identity else { throw Failure.notAFolder("run") }
                return again.url
            }
            guard errno == EEXIST else { throw Failure.cannotCreate("run", errno) }
        }
        throw Failure.cannotCreate("run", EEXIST)
    }

    /// A run folder made earlier in this run is still a plain private
    /// folder directly inside the base, reached through no link.
    public func validateRunFolder(_ folder: URL) throws {
        let name = folder.lastPathComponent
        guard name.hasPrefix(Self.runFolderPrefix), !name.contains("/") else { throw Failure.notAFolder("run") }
        _ = try openRunFolder(named: name, expectedPath: folder.path)
    }

    // MARK: Walking without following links

    /// One open folder, reached from the resolved Application Support
    /// folder one name at a time. Closed when released.
    final class OpenFolder {
        let descriptor: Int32
        let path: String

        init(descriptor: Int32, path: String) {
            self.descriptor = descriptor
            self.path = path
        }

        deinit { close(descriptor) }

        var url: URL { URL(fileURLWithPath: path, isDirectory: true) }

        /// Device and inode of the open folder.
        var identity: [UInt64] {
            var info = Darwin.stat()
            guard fstat(descriptor, &info) == 0 else { return [] }
            return [UInt64(UInt32(bitPattern: info.st_dev)), UInt64(info.st_ino)]
        }
    }

    /// The Application Support folder, resolved once (aliases above it are
    /// the system's). Nil when it is missing and nothing may be created.
    func openSupport(creating: Bool) throws -> OpenFolder? {
        let given = applicationSupport.path
        var info = Darwin.stat()
        if stat(given, &info) != 0 {
            guard errno == ENOENT else { throw Failure.cannotOpen("support", errno) }
            guard creating else { return nil }
            do {
                try FileManager.default.createDirectory(at: applicationSupport, withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o700])
            } catch {
                throw Failure.cannotCreate("support", Int32((error as NSError).code))
            }
        }
        guard let resolved = realpath(given, nil) else { throw Failure.cannotOpen("support", errno) }
        let path = String(cString: resolved)
        free(resolved)
        let descriptor = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw Failure.cannotOpen("support", errno) }
        return OpenFolder(descriptor: descriptor, path: path)
    }

    /// `com.trueconvo.voice-cursor`, then `desk-invented-proof`, each opened
    /// relative to the one before and checked. Nil when one is missing and
    /// nothing may be created.
    func openBase(creating: Bool) throws -> OpenFolder? {
        guard let support = try openSupport(creating: creating),
              let app = try Self.openChild(Self.appFolderName, in: support, label: "app", creating: creating) else { return nil }
        return try Self.openChild(Self.baseFolderName, in: app, label: "base", creating: creating)
    }

    private func openBaseForWriting() throws -> OpenFolder {
        guard let base = try openBase(creating: true) else { throw Failure.cannotCreate("base", ENOENT) }
        return base
    }

    /// The named run folder inside the base, walked to afresh. When
    /// `expectedPath` is given it must name that same place.
    private func openRunFolder(named name: String, expectedPath: String? = nil) throws -> OpenFolder {
        guard let base = try openBase(creating: false) else { throw Failure.notAFolder("base") }
        if let expectedPath {
            let allowed = [base.path + "/" + name, self.base.path + "/" + name]
            guard allowed.contains(expectedPath) else { throw Failure.notAFolder("run") }
        }
        guard let run = try Self.openChild(name, in: base, label: "run", creating: false) else { throw Failure.notAFolder("run") }
        return run
    }

    /// Opens `name` inside `parent` as a folder without following a link,
    /// creating it (0700) first when asked and missing, then checks it.
    static func openChild(_ name: String, in parent: OpenFolder, label: String, creating: Bool) throws -> OpenFolder? {
        let flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
        var descriptor = openat(parent.descriptor, name, flags)
        if descriptor < 0, errno == ENOENT {
            guard creating else { return nil }
            if mkdirat(parent.descriptor, name, 0o700) != 0, errno != EEXIST { throw Failure.cannotCreate(label, errno) }
            descriptor = openat(parent.descriptor, name, flags)
        }
        guard descriptor >= 0 else {
            let code = errno
            throw refusal(opening: name, in: parent, label: label, code: code)
        }
        let folder = OpenFolder(descriptor: descriptor, path: parent.path + "/" + name)
        var info = Darwin.stat()
        guard fstat(descriptor, &info) == 0 else { throw Failure.cannotOpen(label, errno) }
        if let refusal = refusal(forFolder: info, label: label) { throw refusal }
        return folder
    }

    /// Why an open folder is refused, if it is: not a folder, another
    /// user's, or writable by a group or other users.
    static func refusal(forFolder info: Darwin.stat, label: String, owner: uid_t = geteuid()) -> Failure? {
        guard info.st_mode & S_IFMT == S_IFDIR else { return .notAFolder(label) }
        guard info.st_uid == owner else { return .notYours(label) }
        guard info.st_mode & (S_IWGRP | S_IWOTH) == 0 else { return .openToOthers(label) }
        return nil
    }

    /// Why `name` could not be opened as a folder.
    private static func refusal(opening name: String, in parent: OpenFolder, label: String, code: Int32) -> Failure {
        var info = Darwin.stat()
        guard fstatat(parent.descriptor, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { return .cannotOpen(label, code) }
        switch info.st_mode & S_IFMT {
        case S_IFLNK: return .symlinkedFolder(label)
        case S_IFDIR: return .cannotOpen(label, code)
        default: return .notAFolder(label)
        }
    }

    /// The base is ours: private to this user, holding the marker.
    private static func makePrivate(_ base: OpenFolder) throws {
        _ = fchmod(base.descriptor, 0o700)
        let descriptor = openat(base.descriptor, markerFileName, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else {
            // Already there (or another copy just wrote it): fine if it is a plain file.
            let code = errno
            var info = Darwin.stat()
            guard code == EEXIST, fstatat(base.descriptor, markerFileName, &info, AT_SYMLINK_NOFOLLOW) == 0,
                  info.st_mode & S_IFMT == S_IFREG else { throw Failure.unsafeMarker }
            return
        }
        defer { close(descriptor) }
        let bytes = Array(markerText.utf8)
        guard write(descriptor, bytes, bytes.count) == bytes.count else { throw Failure.cannotCreate("marker", errno) }
    }

    /// The names in an open folder, read through that folder itself.
    static func entryNames(in folder: OpenFolder) -> [String] {
        let descriptor = openat(folder.descriptor, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard descriptor >= 0 else { return [] }
        guard let stream = fdopendir(descriptor) else {
            close(descriptor)
            return []
        }
        defer { closedir(stream) }
        var names: [String] = []
        while let entry = readdir(stream) {
            let length = Int(entry.pointee.d_namlen)
            let bytes = withUnsafeBytes(of: entry.pointee.d_name) { Array($0.prefix(length)) }
            let name = String(decoding: bytes, as: UTF8.self)
            if name != ".", name != ".." { names.append(name) }
        }
        return names
    }
}
