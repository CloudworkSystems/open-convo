import Foundation

/// Step 2, PR 4c: kept recordings are sealed like the words.
///
/// A final retained recording is sealed as `<name>.sealed` (bound to its
/// place in the archive) and its plaintext removed. Tools that need the
/// sound get a short-lived owner-only copy in a private temporary folder
/// (0700, file 0600) that is removed as soon as they finish; a launch sweep
/// removes copies a crash left behind. Recordings from before this step are
/// plaintext audio and are used as they are; they are told apart by the
/// `.sealed` extension, never by guessing at their bytes.
public struct SealedRecordings: Sendable {
    public static let sealedExtension = "sealed"
    public static let openedCopyPrefix = "tc-opened-audio-"

    public enum Failure: Error, Equatable, Sendable {
        /// Sealed, and the key is missing or the file doesn't open.
        case notReadable
        /// The readable copy could not be made.
        case copyFailed
    }

    public enum SealOutcome: Equatable, Sendable {
        /// Sealed; the plaintext is gone.
        case sealed(URL)
        /// Sealed, but the plaintext could not be removed.
        case sealedPlaintextLeft(URL)
        /// Not sealed (no key, or the write failed); the plaintext was
        /// removed rather than kept readable.
        case notSealed
        /// Not sealed, and the plaintext could not be removed either.
        case notSealedPlaintextLeft
    }

    public let files: ArchiveFiles
    /// Where readable copies go: give each app copy its own folder, so one
    /// copy's launch sweep never removes another's copy in use.
    public let temporaryRoot: URL

    public init(files: ArchiveFiles, temporaryRoot: URL = FileManager.default.temporaryDirectory) {
        self.files = files
        self.temporaryRoot = temporaryRoot
    }

    public static func isSealed(_ url: URL) -> Bool { url.pathExtension == sealedExtension }

    /// Seals the recording at `url` and removes its plaintext. With no seal
    /// (missing key) the plaintext is removed too: never kept readable.
    public func seal(_ url: URL, seal: ArchiveSeal?) -> SealOutcome {
        let sealedURL = url.appendingPathExtension(Self.sealedExtension)
        guard let seal, let data = try? Data(contentsOf: url),
              (try? files.writeSealed(data, to: sealedURL, seal: seal)) != nil else {
            return Self.remove(url) ? .notSealed : .notSealedPlaintextLeft
        }
        return Self.remove(url) ? .sealed(sealedURL) : .sealedPlaintextLeft(sealedURL)
    }

    /// A recording's sound: a sealed one opened in memory, an older one read
    /// as it is. Nil when it can't be read.
    public func data(of url: URL, seal: ArchiveSeal?) -> Data? {
        guard Self.isSealed(url) else { return try? Data(contentsOf: url) }
        // The extension says it is sealed: only an envelope that opens counts
        // (Codex P2 on #34), never bytes read as plaintext.
        if case .opened(let data) = files.read(url, seal: seal) { return data }
        return nil
    }

    /// Runs `body` with a readable copy of the recording at `url`: an older
    /// recording as it is; a sealed one as an owner-only copy in a private
    /// temporary folder, removed as soon as `body` returns or throws.
    public func withReadableCopy<T>(of url: URL, seal: ArchiveSeal?, _ body: (URL) async throws -> T) async throws -> T {
        guard Self.isSealed(url) else { return try await body(url) }
        guard let data = data(of: url, seal: seal) else { throw Failure.notReadable }
        let folder = temporaryRoot.appendingPathComponent(Self.openedCopyPrefix + UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: temporaryRoot, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: NSNumber(value: 0o700)])
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: NSNumber(value: 0o700)])
        } catch {
            throw Failure.copyFailed
        }
        defer { try? FileManager.default.removeItem(at: folder) }
        let copy = folder.appendingPathComponent(url.deletingPathExtension().lastPathComponent)
        do {
            try DurableFile.writeNew(data, to: copy)
        } catch {
            throw Failure.copyFailed
        }
        return try await body(copy)
    }

    /// Removes readable copies left by a run that ended mid-use. Returns how
    /// many folders were removed.
    @discardableResult
    public func sweepOpenedCopies() -> Int {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: temporaryRoot.path)) ?? []
        var removed = 0
        for name in names where name.hasPrefix(Self.openedCopyPrefix) {
            if (try? FileManager.default.removeItem(at: temporaryRoot.appendingPathComponent(name))) != nil { removed += 1 }
        }
        return removed
    }

    // MARK: Unfinished recordings (Codex round 2 on #34)
    //
    // A kept recording is plaintext from the moment it is captured until it
    // is sealed. Before that, a marker `<recordings>/.pending/<name>` is
    // written; it is cleared once the recording is sealed. A run that ends
    // in between (quit, kill, crash) leaves the marker, and the next launch
    // seals that recording, or removes it when there is no key. Recordings
    // from before this step have no marker and are never touched.

    public static let pendingFolderName = ".pending"

    private func pendingMarker(for capture: URL) -> URL {
        capture.deletingLastPathComponent()
            .appendingPathComponent(Self.pendingFolderName, isDirectory: true)
            .appendingPathComponent(capture.lastPathComponent, isDirectory: false)
    }

    /// Notes that `capture` will be a kept recording. Call before anything
    /// is written there; a failure means it must not be kept.
    public func markPending(_ capture: URL) throws {
        let marker = pendingMarker(for: capture)
        let pending = marker.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: pending, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: NSNumber(value: 0o700)])
        // The `.pending` entry itself must be on disk in the recordings
        // folder before capture starts, or a power loss could keep the audio
        // and lose the marker (Codex round 3 on #34).
        try DurableFile.flushFolder(pending.deletingLastPathComponent())
        try DurableFile.replace(marker, with: Data())
    }

    /// The recording made from `capture` is sealed (or gone): its marker
    /// goes.
    public func clearPending(_ capture: URL) {
        let marker = pendingMarker(for: capture)
        if unlink(marker.path) == 0 { try? DurableFile.flushFolder(marker.deletingLastPathComponent()) }
    }

    /// Seals, or with no seal removes, every recording a run left unfinished
    /// in `folder`, including its converted form, then clears its marker.
    /// A marker is kept when its recording could be neither sealed nor
    /// removed, so the next launch tries again. Returns how many recordings
    /// were handled.
    @discardableResult
    public func reconcilePending(in folder: URL, seal: ArchiveSeal?) -> Int {
        let pending = folder.appendingPathComponent(Self.pendingFolderName, isDirectory: true)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: pending.path)) ?? []
        var handled = 0
        for name in names where !name.hasPrefix(".") {
            let capture = folder.appendingPathComponent(name, isDirectory: false)
            let stem = capture.deletingPathExtension()
            let candidates = Set([capture, stem.appendingPathExtension("wav"), stem.appendingPathExtension("flac")])
            var settled = true
            for candidate in candidates where FileManager.default.fileExists(atPath: candidate.path) {
                switch self.seal(candidate, seal: seal) {
                case .sealed, .notSealed: handled += 1
                case .sealedPlaintextLeft, .notSealedPlaintextLeft: settled = false
                }
            }
            if settled { clearPending(capture) }
        }
        return handled
    }

    /// Removes the plaintext and flushes its folder, so a power loss can't
    /// bring it back (Codex P1 on #34). False when either step fails.
    private static func remove(_ url: URL) -> Bool {
        guard unlink(url.path) == 0 || errno == ENOENT else { return false }
        return (try? DurableFile.flushFolder(url.deletingLastPathComponent())) != nil
    }
}
