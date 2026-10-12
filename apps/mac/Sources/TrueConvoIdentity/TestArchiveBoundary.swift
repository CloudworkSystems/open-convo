import Darwin
import Foundation

/// True Convo Test's archive folder must be its own before anything uses it.
///
/// The test copy keeps its recordings, transcripts, history, saved fixes and
/// run log in `~/.tca-dictate-test`. If that folder, or anything in it, were
/// a link to the real app's `~/.tca-dictate` (or anywhere else), the test
/// copy's launch sweep of temporary recordings, its run log and every other
/// archive write would land in someone else's files. So, at launch and
/// before any of that, the test copy checks the folder:
///
/// - It may be absent: the app then makes a new, plain folder.
/// - Otherwise it must be a plain folder at `~/.tca-dictate-test` itself,
///   compared after macOS's own links above it are resolved (such as `/var`
///   for `/private/var`, or a home folder reached through a system link).
/// - Everything inside it, at any depth, must be a plain folder or a plain
///   file: no symbolic link (even a broken one), no Finder alias, no file
///   that also appears somewhere else (a hard link), and nothing else (such
///   as a named pipe). Anything that cannot be read to check is refused too.
/// - It and everything in it must be on the home folder's own disk: a disk,
///   disk image or network share mounted at the folder or inside it leads
///   somewhere else even though it looks like a plain folder.
///
/// The check only looks: it never follows a link, opens a file's contents,
/// creates, changes or deletes anything. The real app (and `swift run`, and
/// unit tests) is never checked: `check` answers `.notChecked` for it at
/// once, so its behaviour is exactly what it was before.
public enum TestArchiveBoundary {
    /// What was wrong with the first item found.
    public enum Problem: String, Equatable, Sendable, CaseIterable {
        /// A symbolic link, even one that points nowhere.
        case symbolicLink
        /// A Finder alias file.
        case finderAlias
        /// A plain file that also appears somewhere else (a hard link).
        case sharedFile
        /// Not a plain folder (for the archive folder) or not a plain file
        /// or folder (inside it).
        case notPlain
        /// The archive folder resolves somewhere other than
        /// `~/.tca-dictate-test` itself, or it (or something in it) is on
        /// another disk: something is mounted there.
        case outsideFolder
        /// It could not be read to check.
        case cannotCheck
    }

    public struct Refusal: Equatable, Sendable {
        public let problem: Problem
        /// The item, relative to the home folder, such as
        /// `.tca-dictate-test/temporary-recordings`.
        public let relativePath: String

        public init(problem: Problem, relativePath: String) {
            self.problem = problem
            self.relativePath = relativePath
        }

        /// The item as a person reads it, such as
        /// `~/.tca-dictate-test/temporary-recordings`.
        public var displayPath: String { "~/" + relativePath }
    }

    public enum Verdict: Equatable, Sendable {
        /// The real app: nothing was checked, exactly as before.
        case notChecked
        /// True Convo Test, and the folder is its own (or not there yet).
        case ownFolder
        /// True Convo Test, and the folder must not be used.
        case refused(Refusal)
    }

    /// Checks `identity`'s archive folder inside `home`. Only True Convo
    /// Test's is checked; every other identity gets `.notChecked` without a
    /// single file-system call.
    public static func check(identity: AppIdentity, home: URL) -> Verdict {
        check(identity: identity, home: home, lstatAt: { path, info in lstat(path, &info) })
    }

    /// The check itself. `lstatAt` is always `lstat` in the app; tests pass
    /// one that reports another disk for a chosen item, because mounting a
    /// disk inside an invented folder is not something a unit test should do.
    static func check(identity: AppIdentity, home: URL, lstatAt: (String, inout stat) -> Int32) -> Verdict {
        guard identity.isTest else { return .notChecked }
        let name = identity.archiveFolderName
        let root = identity.archiveRoot(home: home)

        var info = stat()
        guard lstatAt(root.path, &info) == 0 else {
            return errno == ENOENT ? .ownFolder : refused(.cannotCheck, name)
        }
        switch info.st_mode & S_IFMT {
        case S_IFDIR:
            break
        case S_IFLNK:
            return refused(.symbolicLink, name)
        case S_IFREG:
            return refused(isFinderAlias(root.path) ? .finderAlias : .notPlain, name)
        default:
            return refused(.notPlain, name)
        }

        // A plain folder in a home folder that macOS itself may reach through
        // links: compare the resolved paths, never the names as given.
        guard let resolvedHome = realPath(home.path),
              let resolvedRoot = realPath(root.path),
              resolvedRoot == URL(fileURLWithPath: resolvedHome, isDirectory: true).appendingPathComponent(name).path
        else {
            return refused(.outsideFolder, name)
        }
        // Something mounted at the folder looks like a plain folder at the
        // same path; only its disk (device) differs from the home folder's.
        let disk = info.st_dev
        var homeInfo = stat()
        guard lstatAt(resolvedHome, &homeInfo) == 0 else { return refused(.cannotCheck, name) }
        guard homeInfo.st_dev == disk else { return refused(.outsideFolder, name) }

        // Everything inside, at any depth, without following anything.
        var folders: [(path: String, relative: String)] = [(root.path, name)]
        while let folder = folders.popLast() {
            let names: [String]
            do {
                names = try FileManager.default.contentsOfDirectory(atPath: folder.path)
            } catch {
                return refused(.cannotCheck, folder.relative)
            }
            for child in names.sorted() {
                let path = folder.path + "/" + child
                let relative = folder.relative + "/" + child
                var childInfo = stat()
                guard lstatAt(path, &childInfo) == 0 else {
                    // Gone since the listing: nothing there to follow.
                    if errno == ENOENT { continue }
                    return refused(.cannotCheck, relative)
                }
                // Something mounted inside the folder.
                guard childInfo.st_dev == disk else { return refused(.outsideFolder, relative) }
                switch childInfo.st_mode & S_IFMT {
                case S_IFDIR:
                    folders.append((path, relative))
                case S_IFREG:
                    if childInfo.st_nlink > 1 { return refused(.sharedFile, relative) }
                    if isFinderAlias(path) { return refused(.finderAlias, relative) }
                case S_IFLNK:
                    return refused(.symbolicLink, relative)
                default:
                    return refused(.notPlain, relative)
                }
            }
        }
        return .ownFolder
    }

    private static func refused(_ problem: Problem, _ relativePath: String) -> Verdict {
        .refused(Refusal(problem: problem, relativePath: relativePath))
    }

    /// Whether a plain file is a Finder alias. Unreadable counts as one, so
    /// the answer fails closed.
    private static func isFinderAlias(_ path: String) -> Bool {
        let values = try? URL(fileURLWithPath: path).resourceValues(forKeys: [.isAliasFileKey])
        return values?.isAliasFile ?? true
    }

    private static func realPath(_ path: String) -> String? {
        guard let resolved = Darwin.realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}

/// The words True Convo Test shows when it refuses its archive folder, then
/// quits. Plain text, kept here so tests can read it without showing a window.
public enum TestArchiveRefusalMessage {
    public static let title = "True Convo Test can't use its folder"
    public static let quitButton = "Quit True Convo Test"

    public static func message(for refusal: TestArchiveBoundary.Refusal) -> String {
        let folder = "~/" + AppIdentity.test.archiveFolderName
        return [
            "True Convo Test keeps its own files in \(folder), apart from your real True Convo. It checks that folder before using it, and found a problem:",
            "\(refusal.displayPath) \(words(for: refusal.problem)).",
            "Using a folder it cannot be sure of could read or change files that belong somewhere else, such as your real True Convo recordings. So True Convo Test changed nothing, and it will quit now. Your real True Convo was not touched.",
            "Ask for help before you move or delete anything in \(folder).",
        ].joined(separator: "\n\n")
    }

    static func words(for problem: TestArchiveBoundary.Problem) -> String {
        switch problem {
        case .symbolicLink: return "is a link to another place"
        case .finderAlias: return "is a Finder alias to another place"
        case .sharedFile: return "is a file that also appears in another place"
        case .notPlain: return "is not a plain file or folder"
        case .outsideFolder: return "leads to another place"
        case .cannotCheck: return "could not be checked"
        }
    }
}
