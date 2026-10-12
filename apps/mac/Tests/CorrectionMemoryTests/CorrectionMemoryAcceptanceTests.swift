import Foundation
import Testing
@testable import CorrectionMemory

@Suite("Correction memory acceptance fixtures")
struct CorrectionMemoryAcceptanceTests {
    @Test("AE1, AE2, AE3, and AE5: Fix once is transient; Remember is scoped, helpful later, and removable")
    func correctionLoopAcceptance() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let store = try CorrectionLessonStore(directory: directory)
        let scope = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.TextEdit",
            localeIdentifier: "en_US"
        )
        let otherScope = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.Notes",
            localeIdentifier: "en_US"
        )
        let pair = try CorrectionPhrasePair(
            sourcePhrase: "Synthetic Misheard Name",
            replacementPhrase: "Synthetic Correct Name"
        )

        let fixedOnce = try CorrectionPolicy.applyFixOnce(
            to: "Call Synthetic Misheard Name",
            phrasePair: pair
        )
        #expect(fixedOnce == "Call Synthetic Correct Name")
        let emptyRestartedStore = try CorrectionLessonStore(directory: directory)
        #expect(emptyRestartedStore.lessons.isEmpty)

        let lesson = try store.remember(pair, in: scope)
        let restartedStore = try CorrectionLessonStore(directory: directory)
        let later = try restartedStore.applySavedCorrection(
            to: "Call Synthetic Misheard Name tomorrow",
            in: scope
        )
        #expect(later.updatedDraft == "Call Synthetic Correct Name tomorrow")
        #expect(later.appliedLesson?.id == lesson.id)
        #expect(restartedStore.lesson(withID: lesson.id)?.useCount == 1)

        let otherScopeOutcome = try restartedStore.applySavedCorrection(
            to: "Call Synthetic Misheard Name tomorrow",
            in: otherScope
        )
        #expect(otherScopeOutcome.updatedDraft == "Call Synthetic Misheard Name tomorrow")

        try restartedStore.forget(lessonID: lesson.id)
        let finalRestartedStore = try CorrectionLessonStore(directory: directory)
        #expect(finalRestartedStore.lessons.isEmpty)
    }

    @Test("AE7: terminal synthetic drafts do not create a transcript or derived file")
    func terminalDraftBoundaryAcceptance() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CorrectionLessonStore(directory: directory)
        let scope = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.TextEdit",
            localeIdentifier: "en_US"
        )
        _ = try store.remember(
            CorrectionPhrasePair(sourcePhrase: "approved source", replacementPhrase: "approved replacement"),
            in: scope
        )

        for event in [
            TransientDraftEvent.cancelled,
            .successfullyDelivered,
            .terminalSpeechError,
            .backgrounded,
            .terminated
        ] {
            var draft = TransientDraft(text: "synthetic-unapproved-draft-canary")
            #expect(draft.handle(event) == .cleared)
            #expect(draft.text == nil)
        }

        let savedText = try String(contentsOf: store.storageURL, encoding: .utf8)
        #expect(!savedText.contains("synthetic-unapproved-draft-canary"))
        #expect(!savedText.contains("transcript"))
        #expect(!savedText.contains("audio"))
    }

    private func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "true-convo-correction-acceptance-\(UUID().uuidString)",
            isDirectory: true
        )
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
