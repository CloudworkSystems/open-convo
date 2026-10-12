import Foundation

/// Owns only files explicitly registered for captures created by this process.
/// Writers must register their output before creating it, and stop before cleanup.
/// No directory listing or retained-recording sweep is part of this registry.
public final class OwnedRecordingFiles: @unchecked Sendable {
    private typealias RecordingPath = [String]

    private struct CaptureGroup {
        let retain: Bool
        var files: [RecordingPath: URL]
        var acceptsOutputs = true
    }

    private let lock = NSLock()
    private let fileManager: FileManager
    private var groups: [RecordingPath: CaptureGroup] = [:]
    private var closed = false

    public init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    private func recordingPath(_ url: URL) -> RecordingPath? {
        guard url.isFileURL else { return nil }
        // Resolve the parent (/var is /private/var on macOS), but never the
        // final component. An owned file replaced by a symlink is still only
        // that link; resolving it could claim or remove an unowned target.
        return url.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
            .standardizedFileURL.pathComponents + [url.lastPathComponent]
    }

    private func owner(of path: RecordingPath) -> RecordingPath? {
        groups.first(where: { $0.value.files[path] != nil })?.key
    }

    /// New ownership requires an absent path, including no dangling symlink.
    /// Historical files must never become eligible for current-capture cleanup.
    private func pathIsMissing(_ url: URL) -> Bool {
        do {
            _ = try fileManager.attributesOfItem(atPath: url.path)
            return false
        } catch {
            return isMissingFileError(error)
        }
    }

    private func isMissingFileError(_ error: Error) -> Bool {
        let error = error as NSError
        return (error.domain == NSCocoaErrorDomain &&
            (error.code == NSFileNoSuchFileError || error.code == NSFileReadNoSuchFileError)) ||
            (error.domain == NSPOSIXErrorDomain && error.code == 2)
    }

    /// Returns false for an existing unowned path, once shutdown starts, if
    /// another capture owns this URL, or if its start policy would change.
    /// Snapshot retention and call before creating the capture's writer.
    @discardableResult
    public func registerCapture(_ url: URL, retain: Bool) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !closed, !url.hasDirectoryPath, let capture = recordingPath(url) else { return false }
        if let group = groups[capture] { return group.acceptsOutputs && group.retain == retain }
        guard owner(of: capture) == nil, pathIsMissing(url) else { return false }
        groups[capture] = CaptureGroup(retain: retain, files: [capture: url.standardizedFileURL])
        return true
    }

    /// The capture key is always the original input, including after conversion.
    @discardableResult
    public func registerOutput(_ url: URL, forCapture captureURL: URL) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !closed, !url.hasDirectoryPath, let capture = recordingPath(captureURL), let output = recordingPath(url),
              var group = groups[capture], group.acceptsOutputs else { return false }
        if let existingOwner = owner(of: output) {
            return existingOwner == capture
        }
        guard pathIsMissing(url) else { return false }
        group.files[output] = url.standardizedFileURL
        groups[capture] = group
        return true
    }

    public func isOwned(_ url: URL) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let recording = recordingPath(url) else { return false }
        return owner(of: recording) != nil
    }

    /// The record-start choice never changes when later preferences change.
    public func retainsCapture(_ captureURL: URL) -> Bool? {
        lock.lock()
        defer { lock.unlock() }
        guard let capture = recordingPath(captureURL) else { return nil }
        return groups[capture]?.retain
    }

    /// Applies only this capture's immutable record-start retention choice.
    /// Returns failed deletions; successful/missing files are no longer owned.
    /// A finished group cannot accept new outputs, but failed cleanup is retryable.
    @discardableResult
    public func finishCapture(_ captureURL: URL) -> [URL] {
        lock.lock()
        defer { lock.unlock() }
        guard let capture = recordingPath(captureURL), var group = groups[capture] else { return [] }
        if group.retain {
            groups.removeValue(forKey: capture)
            return []
        }
        group.acceptsOutputs = false
        group.files = removeOwnedFiles(group.files)
        if group.files.isEmpty {
            groups.removeValue(forKey: capture)
        } else {
            groups[capture] = group
        }
        return sorted(group.files.values)
    }

    /// Permanently closes registration, then applies each capture's record-start
    /// choice independently. Failed discards remain retryable on repeated calls.
    @discardableResult
    public func shutdown() -> [URL] {
        lock.lock()
        defer { lock.unlock() }
        closed = true
        var failures: Set<URL> = []
        for capture in Array(groups.keys) {
            guard var group = groups[capture] else { continue }
            if group.retain {
                groups.removeValue(forKey: capture)
                continue
            }
            group.acceptsOutputs = false
            group.files = removeOwnedFiles(group.files)
            failures.formUnion(group.files.values)
            if group.files.isEmpty {
                groups.removeValue(forKey: capture)
            } else {
                groups[capture] = group
            }
        }
        return sorted(failures)
    }

    private func sorted<S: Sequence>(_ urls: S) -> [URL] where S.Element == URL {
        urls.sorted { $0.absoluteString < $1.absoluteString }
    }

    /// Called with the lock held so registration and cleanup cannot race.
    private func removeOwnedFiles(_ urls: [RecordingPath: URL]) -> [RecordingPath: URL] {
        var failures: [RecordingPath: URL] = [:]
        for (path, url) in urls {
            do {
                // A parent redirected after registration is no longer the
                // registered location. Refuse cleanup rather than follow it.
                guard recordingPath(url) == path else {
                    failures[path] = url
                    continue
                }
                let attributes = try fileManager.attributesOfItem(atPath: url.path)
                let type = attributes[.type] as? FileAttributeType
                guard type == .typeRegular || type == .typeSymbolicLink else {
                    failures[path] = url
                    continue
                }
                try fileManager.removeItem(at: url)
            } catch {
                if !isMissingFileError(error) { failures[path] = url }
            }
        }
        return failures
    }
}
