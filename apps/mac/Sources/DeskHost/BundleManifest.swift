import Foundation

/// The list of bundled Desk files the custom-scheme handler may serve. Paths
/// are relative, use `/`, and name regular files; the manifest itself is
/// loaded from a URL the app chooses, never from a request.
public struct BundleManifest: Codable, Equatable, Sendable {
    public struct Asset: Codable, Equatable, Sendable {
        public let path: String
        public let mediaType: String

        public init(path: String, mediaType: String) {
            self.path = path
            self.mediaType = mediaType
        }
    }

    public let scheme: String
    public let host: String
    public let assets: [Asset]

    public init(scheme: String = DeskHost.assetScheme, host: String = "desk", assets: [Asset]) throws {
        self.scheme = scheme.lowercased()
        self.host = host.lowercased()
        self.assets = assets
        for asset in assets {
            guard Self.components(ofRelativePath: asset.path) != nil else { throw BundleManifestError.invalidAssetPath(asset.path) }
        }
    }

    public init(from decoder: Decoder) throws {
        struct Raw: Decodable { let scheme: String?; let host: String?; let assets: [Asset] }
        let raw = try Raw(from: decoder)
        try self.init(scheme: raw.scheme ?? DeskHost.assetScheme, host: raw.host ?? "desk", assets: raw.assets)
    }

    /// The manifest is parsed by the bounded `JSONValue.decode` first, so a
    /// file that is not UTF-8 or is nested past `JSONValue.maxNestingDepth`
    /// is refused, never walked, by either parser.
    public static func load(from url: URL) throws -> BundleManifest {
        let data = try Data(contentsOf: url)
        _ = try JSONValue.decode(data)
        return try JSONDecoder().decode(BundleManifest.self, from: data)
    }

    public func asset(at path: String) -> Asset? {
        assets.first { $0.path == path }
    }

    /// Splits a relative path into safe components, or nil when it is absolute,
    /// empty, or contains `.`/`..`/empty segments, backslashes or NUL bytes.
    static func components(ofRelativePath path: String) -> [String]? {
        guard !path.isEmpty, !path.hasPrefix("/") else { return nil }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        for part in parts {
            guard !part.isEmpty, part != ".", part != "..",
                  !part.contains("\\"), !part.contains("\0") else { return nil }
        }
        return parts
    }
}

public enum BundleManifestError: Error, Equatable, Sendable {
    case invalidAssetPath(String)
}

public enum AssetRefusal: String, Equatable, Sendable {
    case wrongScheme = "wrong-scheme"
    case wrongHost = "wrong-host"
    case absolutePath = "absolute-path"
    case traversal = "traversal"
    case unlisted = "unlisted"
    case symlink = "symlink"
    case notRegularFile = "not-regular-file"
    case missing = "missing"
}

public enum AssetResolution: Equatable, Sendable {
    case asset(url: URL, mediaType: String)
    case refused(AssetRefusal)
}

/// Maps `trueconvo-desk://desk/<path>` to one manifest-listed regular file
/// under the bundle folder. Everything else is refused: other schemes or
/// hosts, absolute paths, `..`, unlisted names, symlinks anywhere on the path.
/// Query and fragment are ignored. Nothing outside the bundle folder is ever
/// opened, and no request can name a filesystem path.
// FileManager is documented thread-safe; the struct holds no other mutable state.
public struct AssetResolver: @unchecked Sendable {
    public let manifest: BundleManifest
    public let bundleDirectory: URL
    private let files: FileManager

    public init(manifest: BundleManifest, bundleDirectory: URL, fileManager: FileManager = .default) {
        self.manifest = manifest
        self.bundleDirectory = bundleDirectory.standardizedFileURL
        self.files = fileManager
    }

    public func resolve(_ request: URL) -> AssetResolution {
        guard request.scheme?.lowercased() == manifest.scheme else { return .refused(.wrongScheme) }
        guard request.host?.lowercased() == manifest.host, request.user == nil, request.password == nil, request.port == nil else {
            return .refused(.wrongHost)
        }
        guard let components = URLComponents(url: request, resolvingAgainstBaseURL: false) else { return .refused(.traversal) }
        let encodedPath = components.percentEncodedPath
        guard encodedPath.hasPrefix("/") else { return .refused(.unlisted) }
        let encodedRelative = String(encodedPath.dropFirst())
        guard !encodedRelative.isEmpty else { return .refused(.unlisted) }
        guard !encodedRelative.hasPrefix("/") else { return .refused(.absolutePath) }
        var parts: [String] = []
        for encoded in encodedRelative.split(separator: "/", omittingEmptySubsequences: false) {
            guard let part = String(encoded).removingPercentEncoding else { return .refused(.traversal) }
            parts.append(part)
        }
        let relativePath = parts.joined(separator: "/")
        guard let safeParts = BundleManifest.components(ofRelativePath: relativePath), safeParts == parts else {
            return .refused(.traversal)
        }
        guard let asset = manifest.asset(at: relativePath) else { return .refused(.unlisted) }

        var file = bundleDirectory
        for part in safeParts { file.appendPathComponent(part) }
        guard let attributes = try? files.attributesOfItem(atPath: file.path) else { return .refused(.missing) }
        guard attributes[.type] as? FileAttributeType != .typeSymbolicLink else { return .refused(.symlink) }
        guard attributes[.type] as? FileAttributeType == .typeRegular else { return .refused(.notRegularFile) }
        // Any symlinked folder on the way changes the resolved parent.
        let expectedParent = bundleDirectory.resolvingSymlinksInPath().standardizedFileURL
            .appendingPathComponent(safeParts.dropLast().joined(separator: "/")).standardizedFileURL
        let actualParent = file.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL
        guard actualParent.pathComponents == expectedParent.pathComponents else { return .refused(.symlink) }
        return .asset(url: file, mediaType: asset.mediaType)
    }

    /// Resolves and reads in one step so the handler never opens a path it did
    /// not just check.
    public func read(_ request: URL) throws -> (data: Data, mediaType: String)? {
        guard case .asset(let url, let mediaType) = resolve(request) else { return nil }
        return (try Data(contentsOf: url), mediaType)
    }
}
