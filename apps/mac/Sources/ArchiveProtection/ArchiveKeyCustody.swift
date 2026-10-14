import DeskHost
import Foundation

/// Step 2, PR 4: the dictation archive's own key, under the same custody as
/// the Desk store's (`KeyProvider`; in the app, `KeychainKeyProvider` with
/// its own service, `<app's Keychain service>.archive-key`).
///
/// The archive folder holds one plaintext marker, `protected-archive.json`,
/// with only the format version and the archive's id, which names the key.
/// The custody rules are the Desk store's:
/// - a key is made only when the folder has no marker yet: the key first,
///   then the marker, published without replacing anything (RENAME_EXCL)
///   and flushed, so a marker never names a key that was never made;
/// - a marker whose key is gone reads as `keyMissing`: nothing new is made
///   over it, so words sealed under the old key are never stranded by a
///   quiet replacement, and nothing falls back to plaintext;
/// - a marker that is not a plain, well-formed file is reported and never
///   repaired or replaced;
/// - key material never appears in a response, a log, a file or an error.
public enum ArchiveKeyCustody {
    public static let markerName = "protected-archive.json"
    static let formatVersion = 1
    static let markerSizeLimit = 4096

    public enum Status: Sendable {
        /// New words can be sealed and sealed words opened.
        case ready(ArchiveSeal)
        /// The marker names a key this Mac's Keychain no longer holds.
        case keyMissing(archiveId: UUID)
        /// Something else stands in the way; nothing was changed.
        case unavailable(Problem)

        public var seal: ArchiveSeal? {
            if case .ready(let seal) = self { return seal }
            return nil
        }
    }

    public enum Problem: String, Error, Equatable, Sendable {
        /// The archive folder is not a plain folder, or could not be made.
        case folderUnusable = "folder-unusable"
        /// The marker is not a plain file, or does not parse.
        case markerUnreadable = "marker-unreadable"
        /// The key store refused (for example a locked Keychain).
        case keyUnavailable = "key-unavailable"
        /// The new marker could not be written.
        case markerWriteFailed = "marker-write-failed"
    }

    /// Opens the archive's key, making key and marker on first use.
    public static func open(root: URL, keys: any KeyProvider) -> Status {
        do {
            try prepareFolder(root)
        } catch {
            return .unavailable(.folderUnusable)
        }
        let marker = root.appendingPathComponent(markerName, isDirectory: false)
        switch readMarker(marker) {
        case .present(let archiveId):
            return status(for: archiveId, keys: keys)
        case .unreadable:
            return .unavailable(.markerUnreadable)
        case .absent:
            break
        }

        let archiveId = UUID()
        let key: StoreKey
        do {
            key = try keys.createKey(for: archiveId)
        } catch {
            return .unavailable(.keyUnavailable)
        }
        switch publishMarker(archiveId: archiveId, at: marker) {
        case .published:
            do {
                return .ready(try ArchiveSeal(material: key.material, archiveId: archiveId))
            } catch {
                return .unavailable(.keyUnavailable)
            }
        case .alreadyThere:
            // Another copy of the app made the archive first: its marker
            // wins, and the key made here is never used.
            switch readMarker(marker) {
            case .present(let winner): return status(for: winner, keys: keys)
            case .unreadable, .absent: return .unavailable(.markerUnreadable)
            }
        case .failed:
            return .unavailable(.markerWriteFailed)
        }
    }

    private static func status(for archiveId: UUID, keys: any KeyProvider) -> Status {
        let key: StoreKey?
        do {
            key = try keys.existingKey(for: archiveId)
        } catch {
            return .unavailable(.keyUnavailable)
        }
        guard let key else { return .keyMissing(archiveId: archiveId) }
        do {
            return .ready(try ArchiveSeal(material: key.material, archiveId: archiveId))
        } catch {
            return .unavailable(.keyUnavailable)
        }
    }

    // MARK: Folder

    private static func prepareFolder(_ root: URL) throws {
        var info = stat()
        if lstat(root.path, &info) == 0 {
            guard (info.st_mode & S_IFMT) == S_IFDIR else { throw Problem.folderUnusable }
            return
        }
        guard errno == ENOENT else { throw Problem.folderUnusable }
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: 0o700)]
        )
    }

    // MARK: Marker

    enum MarkerRead: Equatable {
        case absent
        case present(UUID)
        case unreadable
    }

    private struct Marker: Codable {
        let format: Int
        let archiveId: String
    }

    static func readMarker(_ url: URL) -> MarkerRead {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else {
            return errno == ENOENT ? .absent : .unreadable
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_size <= markerSizeLimit else { return .unreadable }
        guard let data = try? handle.readToEnd(),
              let marker = try? JSONDecoder().decode(Marker.self, from: data),
              marker.format == formatVersion,
              let archiveId = UUID(uuidString: marker.archiveId) else { return .unreadable }
        return .present(archiveId)
    }

    enum Publish: Equatable {
        case published
        case alreadyThere
        case failed
    }

    static func publishMarker(archiveId: UUID, at marker: URL) -> Publish {
        let folder = marker.deletingLastPathComponent()
        let temporary = folder.appendingPathComponent(".\(markerName).\(UUID().uuidString).tmp", isDirectory: false)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let body = try? encoder.encode(Marker(format: formatVersion, archiveId: archiveId.uuidString.lowercased())),
              (try? DurableFile.writeNew(body + Data("\n".utf8), to: temporary)) != nil else {
            unlink(temporary.path)
            return .failed
        }
        guard renamex_np(temporary.path, marker.path, UInt32(RENAME_EXCL)) == 0 else {
            let code = errno
            unlink(temporary.path)
            return code == EEXIST ? .alreadyThere : .failed
        }
        return (try? DurableFile.flushFolder(folder)) != nil ? .published : .failed
    }
}
