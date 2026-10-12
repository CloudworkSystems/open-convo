import Foundation
import Testing
@testable import CorrectionMemory

@Suite("Local data boundary")
struct LocalDataBoundaryTests {
    @Test("Lesson store uses owner-only directory and file permissions")
    func lessonStoreUsesOwnerOnlyDirectoryAndFilePermissions() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CorrectionLessonStore(directory: directory)
        let scope = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.Notes",
            localeIdentifier: "en-US"
        )
        _ = try store.remember(
            CorrectionPhrasePair(sourcePhrase: "Conroe Cursor", replacementPhrase: "ConvoCursor"),
            in: scope
        )

        let directoryPermissions = try permissionBits(at: directory)
        let filePermissions = try permissionBits(at: store.storageURL)

        #expect(directoryPermissions == 0o700)
        #expect(filePermissions == 0o600)
    }

    @Test("A transient draft canary is absent from the app-owned container")
    func transientDraftCanaryIsAbsentFromTheAppOwnedContainer() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CorrectionLessonStore(directory: directory)
        let scope = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.Notes",
            localeIdentifier: "en-US"
        )
        _ = try store.remember(
            CorrectionPhrasePair(sourcePhrase: "Conroe Cursor", replacementPhrase: "ConvoCursor"),
            in: scope
        )

        var draft = TransientDraft(text: "synthetic-private-draft-canary")
        #expect(draft.handle(.targetRefused) == .retainedForReview)
        #expect(draft.handle(.cancelled) == .cleared)

        let persistedText = try persistedTextInContainer(at: directory)
        #expect(!persistedText.contains("synthetic-private-draft-canary"))
        #expect(!persistedText.contains("audio"))
        #expect(!persistedText.contains("transcript"))
        #expect(!persistedText.contains("diagnostic"))
    }

    @Test("Reset removes saved lesson content without adding derived storage")
    func resetRemovesSavedLessonContentWithoutAddingDerivedStorage() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CorrectionLessonStore(directory: directory)
        let scope = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.Notes",
            localeIdentifier: "en-US"
        )
        _ = try store.remember(
            CorrectionPhrasePair(sourcePhrase: "private source", replacementPhrase: "private replacement"),
            in: scope
        )

        try store.reset()

        #expect((try CorrectionLessonStore(directory: directory)).lessons.isEmpty)
        let persistedText = try persistedTextInContainer(at: directory)
        #expect(!persistedText.contains("private source"))
        #expect(!persistedText.contains("private replacement"))
    }

    @Test("A failed permission step leaves the old lessons on disk and no temporary copy")
    func failedPermissionStepLeavesOldLessonsUntouched() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let scope = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.Notes",
            localeIdentifier: "en-US"
        )
        let kept = try CorrectionLesson(
            phrasePair: CorrectionPhrasePair(sourcePhrase: "old phrase", replacementPhrase: "kept phrase"),
            scope: scope
        )
        let added = try CorrectionLesson(
            phrasePair: CorrectionPhrasePair(sourcePhrase: "new phrase", replacementPhrase: "added phrase"),
            scope: scope
        )
        try LocalDataBoundary(directory: directory).replaceLessonsAtomically([kept])

        let failing = LocalDataBoundary(directory: directory, fileManager: OwnerOnlyFileModeFailingFileManager())
        #expect(throws: SimulatedPermissionFailure.self) {
            try failing.replaceLessonsAtomically([kept, added])
        }

        #expect(try LocalDataBoundary(directory: directory).readLessons().map(\.id) == [kept.id])
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        #expect(names == [LocalDataBoundary.lessonsFileName])
        #expect(try permissionBits(at: directory.appendingPathComponent(LocalDataBoundary.lessonsFileName)) == 0o600)
        #expect(try permissionBits(at: directory) == 0o700)
    }

    private func permissionBits(at url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard let permissions = attributes[.posixPermissions] as? NSNumber else {
            throw LocalDataBoundaryTestError.missingPermissions
        }
        return permissions.intValue & 0o777
    }

    private func persistedTextInContainer(at directory: URL) throws -> String {
        let urls = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
        return try urls.reduce(into: "") { text, url in
            text += try String(contentsOf: url, encoding: .utf8)
        }
    }

    private func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CorrectionMemoryBoundaryTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}

private enum LocalDataBoundaryTestError: Error {
    case missingPermissions
}

private struct SimulatedPermissionFailure: Error {}

/// Lets the folder be made owner-only (0700) but fails every attempt to make
/// a file owner-only (0600), to prove a failed permission step never leaves
/// new lessons on disk.
private final class OwnerOnlyFileModeFailingFileManager: FileManager {
    override func setAttributes(_ attributes: [FileAttributeKey: Any], ofItemAtPath path: String) throws {
        if (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600 {
            throw SimulatedPermissionFailure()
        }
        try super.setAttributes(attributes, ofItemAtPath: path)
    }
}
