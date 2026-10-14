import Foundation

/// Reads and writes the dictation archive's word-bearing files.
///
/// New words are only ever written sealed (`ArchiveSeal`); there is no
/// plaintext write here at all, so a missing key can never fall back to
/// plaintext. Reads accept both: a file or history line written before this
/// step is plaintext and is returned as it is, untouched; a sealed one is
/// opened, or reported as `locked` (no key) or `unreadable` (damaged, moved,
/// or sealed under another key). Each sealed file is bound to its path
/// inside the archive folder, so the same words cannot be swapped between
/// files unnoticed.
public struct ArchiveFiles: Sendable {
    public let root: URL

    public init(root: URL) {
        self.root = root.standardizedFileURL
    }

    public enum Read: Equatable, Sendable {
        case missing
        /// Written before this step; returned exactly as stored.
        case plaintext(Data)
        case opened(Data)
        /// Sealed, and the archive's key is not available.
        case locked
        /// Sealed, and it does not open: damaged, moved, or another key's.
        case unreadable

        /// The words, if they can be read at all.
        public var data: Data? {
            switch self {
            case .plaintext(let data), .opened(let data): return data
            case .missing, .locked, .unreadable: return nil
            }
        }

        public var isSealed: Bool {
            switch self {
            case .opened, .locked, .unreadable: return true
            case .missing, .plaintext: return false
            }
        }
    }

    /// What a file is bound to: its path inside the archive folder, or, for
    /// a file kept elsewhere, its full path.
    public func purpose(of url: URL) -> String {
        let rootComponents = root.pathComponents
        let components = url.standardizedFileURL.pathComponents
        if components.count > rootComponents.count, Array(components.prefix(rootComponents.count)) == rootComponents {
            return components.dropFirst(rootComponents.count).joined(separator: "/")
        }
        return "external:" + url.standardizedFileURL.path
    }

    /// Replaces `url` with `plaintext` sealed to its place (owner-only, in
    /// one step, flushed).
    public func writeSealed(_ plaintext: Data, to url: URL, seal: ArchiveSeal) throws {
        let sealed = try seal.sealFile(plaintext, purpose: purpose(of: url))
        try DurableFile.replace(url, with: sealed)
    }

    /// Appends one sealed line holding `plaintext` to `url`.
    public func appendSealedLine(_ plaintext: Data, to url: URL, seal: ArchiveSeal) throws {
        let line = try seal.sealLine(plaintext, purpose: purpose(of: url))
        try DurableFile.appendLine(Data(line.utf8), to: url)
    }

    public func read(_ url: URL, seal: ArchiveSeal?) -> Read {
        guard let stored = try? Data(contentsOf: url) else {
            return FileManager.default.fileExists(atPath: url.path) ? .unreadable : .missing
        }
        guard ArchiveSeal.looksSealedFile(stored) else { return .plaintext(stored) }
        // A damaged header is damage, not plaintext from before (Codex P2).
        guard ArchiveSeal.isSealedFile(stored) else { return .unreadable }
        guard let seal else { return .locked }
        guard let opened = try? seal.openFile(stored, purpose: purpose(of: url)) else { return .unreadable }
        return .opened(opened)
    }

    /// One line of an append-only file such as `history.jsonl`, without its
    /// newline.
    public func readLine<S: StringProtocol>(_ line: S, in url: URL, seal: ArchiveSeal?) -> Read {
        guard ArchiveSeal.looksSealedLine(line) else { return .plaintext(Data(line.utf8)) }
        guard ArchiveSeal.isSealedLine(line) else { return .unreadable }
        guard let seal else { return .locked }
        guard let opened = try? seal.openLine(line, purpose: purpose(of: url)) else { return .unreadable }
        return .opened(opened)
    }
}
