import Foundation
import Testing
@testable import CorrectionMemory

@Suite("Correction lesson store")
struct CorrectionLessonStoreTests {
    @Test("Remember persists an exact scoped lesson and a duplicate is idempotent")
    func rememberPersistsAnExactScopedLessonAndDuplicateIsIdempotent() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let phrasePair = try CorrectionPhrasePair(
            sourcePhrase: "Conroe Cursor",
            replacementPhrase: "ConvoCursor"
        )
        let scope = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.Notes",
            localeIdentifier: "en-US"
        )

        let store = try CorrectionLessonStore(directory: directory)
        let saved = try store.remember(phrasePair, in: scope)
        let repeatedSave = try store.remember(phrasePair, in: scope)

        #expect(repeatedSave == saved)
        #expect(store.lessons == [saved])

        let restartedStore = try CorrectionLessonStore(directory: directory)
        #expect(restartedStore.lessons == [saved])
    }

    @Test("A conflicting replacement for the same source and scope is refused")
    func conflictingReplacementForTheSameSourceAndScopeIsRefused() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CorrectionLessonStore(directory: directory)
        let scope = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.Notes",
            localeIdentifier: "en-US"
        )
        _ = try store.remember(
            CorrectionPhrasePair(sourcePhrase: "Wojciechowsky", replacementPhrase: "Wojciechowski"),
            in: scope
        )

        let conflict = try CorrectionPhrasePair(
            sourcePhrase: "Wojciechowsky",
            replacementPhrase: "Wojciechowski-Smith"
        )

        #expect(throws: CorrectionLessonStoreError.conflictingReplacement) {
            try store.remember(conflict, in: scope)
        }
        #expect(store.lessons.count == 1)
    }

    @Test("A matching lesson increments only that lesson and persists across restart")
    func matchingLessonIncrementsOnlyThatLessonAndPersistsAcrossRestart() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CorrectionLessonStore(directory: directory)
        let notes = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.Notes",
            localeIdentifier: "en-US"
        )
        let mail = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.mail",
            localeIdentifier: "en-US"
        )
        let notesLesson = try store.remember(
            CorrectionPhrasePair(sourcePhrase: "Conroe Cursor", replacementPhrase: "ConvoCursor"),
            in: notes
        )
        let mailLesson = try store.remember(
            CorrectionPhrasePair(sourcePhrase: "Conroe Cursor", replacementPhrase: "Convo Cursor"),
            in: mail
        )

        let outcome = try store.applySavedCorrection(to: "Conroe Cursor", in: notes)

        #expect(outcome.updatedDraft == "ConvoCursor")
        #expect(outcome.appliedLesson?.id == notesLesson.id)
        #expect(store.lesson(withID: notesLesson.id)?.useCount == 1)
        #expect(store.lesson(withID: mailLesson.id)?.useCount == 0)

        let restartedStore = try CorrectionLessonStore(directory: directory)
        #expect(restartedStore.lesson(withID: notesLesson.id)?.useCount == 1)
        #expect(restartedStore.lesson(withID: mailLesson.id)?.useCount == 0)
    }

    @Test("Edit, undo, forget, and reset are explicit durable transitions")
    func editUndoForgetAndResetAreExplicitDurableTransitions() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CorrectionLessonStore(directory: directory)
        let notes = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.Notes",
            localeIdentifier: "en-US"
        )
        let initial = try store.remember(
            CorrectionPhrasePair(sourcePhrase: "Conroe Cursor", replacementPhrase: "ConvoCursor"),
            in: notes
        )
        _ = try store.applySavedCorrection(to: "Conroe Cursor", in: notes)

        let edited = try store.edit(
            lessonID: initial.id,
            phrasePair: CorrectionPhrasePair(sourcePhrase: "Conroe Cursor", replacementPhrase: "Convo Cursor"),
            scope: notes
        )
        #expect(edited.useCount == 0)
        #expect(edited.phrasePair.replacementPhrase == "Convo Cursor")

        try store.undoRememberedLesson(lessonID: edited.id)
        #expect(store.lessons.isEmpty)
        #expect((try CorrectionLessonStore(directory: directory)).lessons.isEmpty)

        let first = try store.remember(
            CorrectionPhrasePair(sourcePhrase: "TCA", replacementPhrase: "True Convo"),
            in: notes
        )
        let second = try store.remember(
            CorrectionPhrasePair(sourcePhrase: "Nexus", replacementPhrase: "Cloudwork Nexus"),
            in: notes
        )
        #expect(first.id != second.id)
        try store.forget(lessonID: first.id)
        #expect(store.lessons.map(\.id) == [second.id])
        try store.reset()
        #expect((try CorrectionLessonStore(directory: directory)).lessons.isEmpty)
    }

    private func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CorrectionMemoryStoreTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
