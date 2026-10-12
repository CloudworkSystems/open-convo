import Foundation
import Testing
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif
@testable import VoiceCursorCore

@Suite("Temporary recording cleanup")
struct TemporaryAudioStoreTests {
    @Test("Launch sweep deletes only invented recognized temporary audio and preserves retained/unknown files")
    func sweepKeepsRetainedArchiveUntouched() throws {
        let files = FileManager.default
        let root = files.temporaryDirectory.appendingPathComponent("TemporaryAudioStoreTests-\(UUID().uuidString)")
        defer { try? files.removeItem(at: root) }
        let store = TemporaryAudioStore(directory: root.appendingPathComponent("temporary-recordings"))
        let first = try store.recordingURL(sessionID: "voice-cursor-1")
        let second = try store.recordingURL(sessionID: "voice-cursor-2")
        let invented = Data("invented fixture bytes, not audio".utf8)
        try invented.write(to: first); try invented.write(to: second)
        let retainedDirectory = root.appendingPathComponent("recordings")
        try files.createDirectory(at: retainedDirectory, withIntermediateDirectories: true)
        let retained = retainedDirectory.appendingPathComponent("voice-cursor-1.wav")
        try invented.write(to: retained)
        let unknown = store.directory.appendingPathComponent("unrecognized.wav")
        try invented.write(to: unknown)
        let link = store.directory.appendingPathComponent("voice-cursor-3.wav")
        try files.createSymbolicLink(at: link, withDestinationURL: retained)
        func physicalFileIdentity(_ url: URL) throws -> String {
            // The parent still exists after sweep; the recording leaf does not.
            guard let parent = url.deletingLastPathComponent().path.withCString({ realpath($0, nil) }) else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
            defer { free(parent) }
            return String(cString: parent) + "/" + url.lastPathComponent
        }
        let expectedFiles = Set(try [first, second].map(physicalFileIdentity))
        let removed = try store.sweep()
        // Resolving a deleted leaf can leave /var and /private/var unequal.
        let removedFiles = Set(try removed.map(physicalFileIdentity))
        #expect(removedFiles == expectedFiles)
        #expect(!files.fileExists(atPath: first.path))
        #expect(!files.fileExists(atPath: second.path))
        #expect(try Data(contentsOf: retained) == invented)
        #expect(try Data(contentsOf: unknown) == invented)
        #expect(try link.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true)
        #expect(try store.sweep().isEmpty)
    }

    @Test("Explicit temporary cleanup is idempotent and refuses a retained path")
    func removeDoesNotCrossTheBoundary() throws {
        let files = FileManager.default
        let root = files.temporaryDirectory.appendingPathComponent("TemporaryAudioStoreTests-\(UUID().uuidString)")
        defer { try? files.removeItem(at: root) }
        let store = TemporaryAudioStore(directory: root.appendingPathComponent("temporary-recordings"))
        let url = try store.recordingURL(sessionID: "voice-cursor-4")
        try Data("invented".utf8).write(to: url)
        #expect(try store.remove(url))
        #expect(try !store.remove(url))
        let outside = root.appendingPathComponent("voice-cursor-4.wav")
        try Data("retained invented fixture".utf8).write(to: outside)
        #expect(throws: TemporaryAudioError.unsafeRecording) { try store.remove(outside) }
        #expect(files.fileExists(atPath: outside.path))
        #expect(throws: TemporaryAudioError.invalidRecordingName) { try store.recordingURL(sessionID: "../recordings/voice-cursor-4") }
    }

    @Test("A symlinked temporary directory cannot expose retained audio to launch cleanup")
    func directorySymlinkFailsClosed() throws {
        let files = FileManager.default
        let root = files.temporaryDirectory.appendingPathComponent("TemporaryAudioStoreTests-\(UUID().uuidString)")
        defer { try? files.removeItem(at: root) }
        let retained = root.appendingPathComponent("recordings")
        try files.createDirectory(at: retained, withIntermediateDirectories: true)
        let recording = retained.appendingPathComponent("voice-cursor-5.wav")
        try Data("retained invented fixture".utf8).write(to: recording)
        let temporary = root.appendingPathComponent("temporary-recordings")
        try files.createSymbolicLink(at: temporary, withDestinationURL: retained)
        let store = TemporaryAudioStore(directory: temporary)
        #expect(throws: TemporaryAudioError.unsafeDirectory) { try store.sweep() }
        #expect(files.fileExists(atPath: recording.path))
    }

    @Test("A store created before its folder exists accepts directory slashes and resolved parent aliases")
    func directoryIdentitySurvivesCreationAndAliases() throws {
        let files = FileManager.default
        let root = files.temporaryDirectory.appendingPathComponent("TemporaryAudioStoreTests-\(UUID().uuidString)")
        defer { try? files.removeItem(at: root) }
        let parent = root.appendingPathComponent("real-parent", isDirectory: true)
        try files.createDirectory(at: parent, withIntermediateDirectories: true)
        let alias = root.appendingPathComponent("alias-parent", isDirectory: true)
        try files.createSymbolicLink(at: alias, withDestinationURL: parent)
        // Deliberately construct the store before this final directory exists,
        // without a directory hint, just as the failing Mac suites do.
        let store = TemporaryAudioStore(directory: alias.appendingPathComponent("temporary-recordings", isDirectory: false))
        let first = try store.recordingURL(sessionID: "voice-cursor-6")
        try Data("invented".utf8).write(to: first)
        let physicalDirectory = parent.appendingPathComponent("temporary-recordings", isDirectory: true)
        #expect(try store.remove(physicalDirectory.appendingPathComponent(first.lastPathComponent)))
        let second = try store.recordingURL(sessionID: "voice-cursor-7")
        try Data("invented".utf8).write(to: second)
        let slashDirectory = URL(fileURLWithPath: store.directory.path + "/", isDirectory: true)
        #expect(try store.remove(slashDirectory.appendingPathComponent(second.lastPathComponent)))
        #expect(try store.sweep().isEmpty)
    }

    @Test("Explicit cleanup refuses live and dangling symlink leaves and nested files")
    func recordingSymlinksAndNestedFilesFailClosed() throws {
        let files = FileManager.default
        let root = files.temporaryDirectory.appendingPathComponent("TemporaryAudioStoreTests-\(UUID().uuidString)")
        defer { try? files.removeItem(at: root) }
        let store = TemporaryAudioStore(directory: root.appendingPathComponent("temporary-recordings"))
        _ = try store.recordingURL(sessionID: "voice-cursor-8")
        let retained = root.appendingPathComponent("retained.wav")
        let bytes = Data("retained invented fixture".utf8)
        try bytes.write(to: retained)
        let link = store.directory.appendingPathComponent("voice-cursor-8.wav")
        let dangling = store.directory.appendingPathComponent("voice-cursor-9.wav")
        try files.createSymbolicLink(at: link, withDestinationURL: retained)
        try files.createSymbolicLink(at: dangling, withDestinationURL: root.appendingPathComponent("absent.wav"))
        let nested = store.directory.appendingPathComponent("nested", isDirectory: true)
        try files.createDirectory(at: nested, withIntermediateDirectories: true)
        let child = nested.appendingPathComponent("voice-cursor-10.wav")
        try bytes.write(to: child)
        for unsafe in [link, dangling, child] {
            #expect(throws: TemporaryAudioError.unsafeRecording) { try store.remove(unsafe) }
        }
        #expect(try store.sweep().isEmpty)
        #expect(try Data(contentsOf: retained) == bytes)
        #expect(try Data(contentsOf: child) == bytes)
        #expect(try files.destinationOfSymbolicLink(atPath: link.path) == retained.path)
        #expect(try files.destinationOfSymbolicLink(atPath: dangling.path) == root.appendingPathComponent("absent.wav").path)
    }

    @Test("Redirecting a parent alias cannot reassign the trusted temporary directory")
    func redirectedParentCannotExposeAnotherFolder() throws {
        let files = FileManager.default
        let root = files.temporaryDirectory.appendingPathComponent("TemporaryAudioStoreTests-\(UUID().uuidString)")
        defer { try? files.removeItem(at: root) }
        let original = root.appendingPathComponent("original-parent", isDirectory: true)
        let other = root.appendingPathComponent("other-parent", isDirectory: true)
        try files.createDirectory(at: original, withIntermediateDirectories: true)
        try files.createDirectory(at: other.appendingPathComponent("temporary-recordings"), withIntermediateDirectories: true)
        let alias = root.appendingPathComponent("parent-alias", isDirectory: true)
        try files.createSymbolicLink(at: alias, withDestinationURL: original)
        let store = TemporaryAudioStore(directory: alias.appendingPathComponent("temporary-recordings"))
        let recording = try store.recordingURL(sessionID: "voice-cursor-11")
        let outside = other.appendingPathComponent("temporary-recordings/voice-cursor-11.wav")
        let bytes = Data("invented preserved fixture".utf8)
        try bytes.write(to: recording); try bytes.write(to: outside)
        try files.removeItem(at: alias)
        try files.createSymbolicLink(at: alias, withDestinationURL: other)
        #expect(throws: TemporaryAudioError.unsafeDirectory) { try store.sweep() }
        #expect(throws: TemporaryAudioError.unsafeDirectory) { try store.recordingURL(sessionID: "voice-cursor-12") }
        #expect(throws: TemporaryAudioError.unsafeDirectory) { try store.remove(recording) }
        #expect(throws: TemporaryAudioError.unsafeRecording) { try store.remove(outside) }
        #expect(try Data(contentsOf: recording) == bytes)
        #expect(try Data(contentsOf: outside) == bytes)
    }

    @Test("An aliased existing ancestor keeps one identity when multiple missing parents are created")
    func missingParentsKeepTheirResolvedAncestor() throws {
        let files = FileManager.default
        let root = files.temporaryDirectory.appendingPathComponent("TemporaryAudioStoreTests-\(UUID().uuidString)")
        defer { try? files.removeItem(at: root) }
        let real = root.appendingPathComponent("real-parent", isDirectory: true)
        try files.createDirectory(at: real, withIntermediateDirectories: true)
        let alias = root.appendingPathComponent("alias-parent", isDirectory: true)
        try files.createSymbolicLink(at: alias, withDestinationURL: real)
        let missing = "missing-one/missing-two/temporary-recordings"
        let store = TemporaryAudioStore(directory: alias.appendingPathComponent(missing))
        let recording = try store.recordingURL(sessionID: "voice-cursor-13")
        try Data("invented".utf8).write(to: recording)
        let physical = real.appendingPathComponent(missing).appendingPathComponent(recording.lastPathComponent)
        #expect(try store.remove(physical))
        #expect(try store.sweep().isEmpty)
    }
}
