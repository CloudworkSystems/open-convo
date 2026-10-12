import Foundation

public enum TemporaryAudioError: Error, Equatable { case unsafeDirectory, invalidRecordingName, unsafeRecording }

/// Only newly marked temporary recordings; never scans the retained archive.
public final class TemporaryAudioStore {
    public let directory: URL
    private let files: FileManager
    private let requestedDirectory: URL
    private let trustedParent: [String]

    public init(directory: URL, files: FileManager = .default) {
        self.requestedDirectory = directory
        // Pin the parent before the final directory exists. Keep the leaf
        // unresolved so a symlink at temporary-recordings is still refused.
        let parent = Self.resolvedParent(directory.deletingLastPathComponent(), files: files)
        self.trustedParent = parent.pathComponents
        self.directory = parent.appendingPathComponent(directory.lastPathComponent, isDirectory: true)
        self.files = files
    }

    private static func resolvedParent(_ url: URL, files: FileManager) -> URL {
        guard url.isFileURL else { return url.standardizedFileURL }
        // Resolve the existing ancestor, then append the absent suffix. Do not
        // rely on Foundation resolving /var through a not-yet-created fixture
        // parent: the same identity must hold before and after mkdir.
        var ancestor = url.standardizedFileURL
        var missing: [String] = []
        while !files.fileExists(atPath: ancestor.path), ancestor.path != "/" {
            missing.append(ancestor.lastPathComponent)
            ancestor = ancestor.deletingLastPathComponent()
        }
        var resolved = ancestor.resolvingSymlinksInPath().standardizedFileURL
        for component in missing.reversed() {
            resolved.appendPathComponent(component, isDirectory: true)
        }
        return resolved
    }

    private func isRecordingName(_ name: String) -> Bool {
        name.range(of: "^voice-cursor-[0-9]+\\.wav$", options: .regularExpression) != nil
    }

    private func checkDirectory(create: Bool) throws -> Bool {
        guard directory.isFileURL, requestedDirectory.isFileURL,
              Self.resolvedParent(requestedDirectory.deletingLastPathComponent(), files: files).pathComponents == trustedParent,
              Self.resolvedParent(directory.deletingLastPathComponent(), files: files).pathComponents == trustedParent else {
            throw TemporaryAudioError.unsafeDirectory
        }
        if try attributes(at: directory) == nil {
            guard create else { return false }
            try files.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        // attributesOfItem inspects the leaf itself, including dangling links.
        let values = try attributes(at: directory)
        guard values?[.type] as? FileAttributeType == .typeDirectory else { throw TemporaryAudioError.unsafeDirectory }
        return true
    }

    private func attributes(at url: URL) throws -> [FileAttributeKey: Any]? {
        do { return try files.attributesOfItem(atPath: url.path) }
        catch {
            let failure = error as NSError
            if (failure.domain == NSCocoaErrorDomain &&
                (failure.code == NSFileNoSuchFileError || failure.code == NSFileReadNoSuchFileError)) ||
                (failure.domain == NSPOSIXErrorDomain && failure.code == 2) { return nil }
            throw error
        }
    }

    public func recordingURL(sessionID: String) throws -> URL {
        let name = "\(sessionID).wav"
        guard isRecordingName(name) else { throw TemporaryAudioError.invalidRecordingName }
        _ = try checkDirectory(create: true)
        return directory.appendingPathComponent(name)
    }

    @discardableResult public func remove(_ url: URL) throws -> Bool {
        guard url.isFileURL, isRecordingName(url.lastPathComponent) else { throw TemporaryAudioError.unsafeRecording }
        // Foundation can add a directory slash once a previously absent folder
        // exists. macOS also exposes /private/var through /var. Compare resolved
        // parent components, never resolve the recording itself: a final symlink
        // must remain visible to the refusal check below.
        let parent = url.deletingLastPathComponent().standardizedFileURL
        guard parent.resolvingSymlinksInPath().standardizedFileURL.pathComponents ==
                directory.resolvingSymlinksInPath().standardizedFileURL.pathComponents else {
            throw TemporaryAudioError.unsafeRecording
        }
        guard try checkDirectory(create: false) else { return false }
        // Use the pinned physical directory for deletion, never a caller's
        // parent alias that could subsequently point outside the trusted folder.
        let recording = directory.appendingPathComponent(url.lastPathComponent)
        guard let values = try attributes(at: recording) else { return false }
        guard values[.type] as? FileAttributeType == .typeRegular else { throw TemporaryAudioError.unsafeRecording }
        try files.removeItem(at: recording)
        return true
    }

    /// Launch recovery removes only recognized regular files from this folder.
    /// Unknown files, symlinks, subfolders and all retained recordings are kept.
    @discardableResult public func sweep() throws -> [URL] {
        guard try checkDirectory(create: false) else { return [] }
        let urls = try files.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil, options: [])
        var removed: [URL] = []
        for url in urls where isRecordingName(url.lastPathComponent) {
            let values = try attributes(at: url)
            guard values?[.type] as? FileAttributeType == .typeRegular else { continue }
            if try remove(url) { removed.append(url) }
        }
        return removed
    }
}
