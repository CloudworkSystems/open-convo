import DeskHost
import Foundation

/// Builds the `BundleManifest` for a built Desk bundle folder at packaging
/// time: every regular file with a listable extension, by relative path. It
/// is loud about anything the resolver would later refuse (a symlink, a file
/// with an unknown extension) and about a missing entry document, so a
/// broken bundle fails when it is packaged rather than when it is opened.
public enum DeskBundleScanner {
    public enum ScanError: Error, Equatable, Sendable {
        case notADirectory
        case symlink(String)
        case unlistableExtension(String)
        case missingEntry
    }

    public static func manifest(forBundleAt directory: URL, scheme: String = DeskHost.assetScheme, host: String = "desk",
                                fileManager: FileManager = .default) throws -> BundleManifest {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw ScanError.notADirectory
        }
        let root = directory.standardizedFileURL
        let keys: [URLResourceKey] = [.isRegularFileKey, .isSymbolicLinkKey, .isDirectoryKey]
        guard let enumerator = fileManager.enumerator(at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else {
            throw ScanError.notADirectory
        }
        var assets: [BundleManifest.Asset] = []
        let prefix = root.path + "/"
        for case let fileURL as URL in enumerator {
            let fullPath = fileURL.standardizedFileURL.path
            guard fullPath.hasPrefix(prefix) else { throw ScanError.notADirectory }
            let relativePath = fullPath.dropFirst(prefix.count)
            let values = try fileURL.resourceValues(forKeys: Set(keys))
            if values.isSymbolicLink == true { throw ScanError.symlink(String(relativePath)) }
            guard values.isRegularFile == true else { continue }
            guard let mediaType = DeskAssetMediaType.mediaType(forExtension: fileURL.pathExtension) else {
                throw ScanError.unlistableExtension(String(relativePath))
            }
            assets.append(.init(path: String(relativePath), mediaType: mediaType))
        }
        assets.sort { $0.path < $1.path }
        guard assets.contains(where: { $0.path == DeskAssetResponder.entryPath }) else { throw ScanError.missingEntry }
        return try BundleManifest(scheme: scheme, host: host, assets: assets)
    }

    /// Writes the manifest as the JSON `BundleManifest.load(from:)` reads.
    public static func write(_ manifest: BundleManifest, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(manifest).write(to: url, options: .atomic)
    }
}
