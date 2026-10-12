import DeskHost
import DeskHostWebKit
import Foundation

/// Where the built Desk comes from.
///
/// In the packaged app: `Contents/Resources/Desk/` (the files the scheme
/// handler serves) and `Contents/Resources/desk-manifest.json`, which lives
/// outside `Desk/` so it is never served itself. Packaging writes and
/// verifies that manifest (`DeskBundleManifest`).
///
/// Only a DEBUG build also accepts `TRUECONVO_DESK_BUNDLE`, a built
/// `apps/desk/native-dist` folder for development and tests; its manifest
/// is made by scanning the folder. A release build never reads that
/// variable. With no Desk at all there is no location, and the app's Desk
/// menu item is disabled.
public struct DeskBundleLocation: Equatable, Sendable {
    public enum Source: Equatable, Sendable {
        case packaged
        case developmentFolder
    }

    public static let environmentKey = "TRUECONVO_DESK_BUNDLE"
    public static let folderName = "Desk"
    public static let manifestName = "desk-manifest.json"

    public let directory: URL
    /// Nil for a development folder: its manifest comes from a scan.
    public let manifestURL: URL?
    public let source: Source

    public init(directory: URL, manifestURL: URL?, source: Source) {
        self.directory = directory.standardizedFileURL
        self.manifestURL = manifestURL?.standardizedFileURL
        self.source = source
    }

    /// The Desk inside an app's resources folder, if the app carries one.
    public static func packaged(resourcesURL: URL?) -> DeskBundleLocation? {
        guard let resourcesURL else { return nil }
        let directory = resourcesURL.appendingPathComponent(folderName, isDirectory: true)
        let manifest = resourcesURL.appendingPathComponent(manifestName, isDirectory: false)
        guard DeskPaths.inspect(directory.path) == .directory,
              DeskPaths.inspect(manifest.path) == .regular,
              DeskPaths.inspect(directory.appendingPathComponent(DeskAssetResponder.entryPath).path) == .regular else { return nil }
        return DeskBundleLocation(directory: directory, manifestURL: manifest, source: .packaged)
    }

    /// A built Desk folder used directly (development and tests).
    public static func developmentFolder(_ directory: URL) -> DeskBundleLocation? {
        guard DeskPaths.inspect(directory.standardizedFileURL.path) == .directory else { return nil }
        return DeskBundleLocation(directory: directory, manifestURL: nil, source: .developmentFolder)
    }

    /// The Desk this app should show: in a DEBUG build `TRUECONVO_DESK_BUNDLE`
    /// first, otherwise the packaged one.
    public static func current(bundle: Bundle = .main,
                               environment: [String: String] = ProcessInfo.processInfo.environment) -> DeskBundleLocation? {
        #if DEBUG
        if let path = environment[environmentKey], !path.isEmpty {
            return developmentFolder(URL(fileURLWithPath: path, isDirectory: true))
        }
        #endif
        return packaged(resourcesURL: bundle.resourceURL)
    }

    /// Whether this build honours `TRUECONVO_DESK_BUNDLE` at all.
    public static var acceptsDevelopmentFolder: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    public func makeResolver() throws -> AssetResolver {
        let manifest = try manifestURL.map { try BundleManifest.load(from: $0) } ?? DeskBundleScanner.manifest(forBundleAt: directory)
        return AssetResolver(manifest: manifest, bundleDirectory: directory)
    }
}
