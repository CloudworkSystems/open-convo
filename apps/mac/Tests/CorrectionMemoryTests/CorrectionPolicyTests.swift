import Foundation
import Testing
@testable import CorrectionMemory

@Suite("Correction policy")
struct CorrectionPolicyTests {
    @Test("Fix once changes only the transient draft and never writes a lesson")
    func fixOnceChangesOnlyTheTransientDraftAndNeverWritesALesson() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CorrectionLessonStore(directory: directory)
        let phrasePair = try CorrectionPhrasePair(
            sourcePhrase: "Conroe Cursor",
            replacementPhrase: "ConvoCursor"
        )
        var draft = TransientDraft(text: "Open Conroe Cursor now")

        try draft.applyFixOnce(phrasePair)

        #expect(draft.text == "Open ConvoCursor now")
        #expect(store.lessons.isEmpty)
        #expect((try CorrectionLessonStore(directory: directory)).lessons.isEmpty)
    }

    @Test("An exact, unambiguous saved phrase can improve an ordinary draft")
    func exactUnambiguousSavedPhraseImprovesAnOrdinaryDraft() throws {
        let scope = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.Notes",
            localeIdentifier: "en-US"
        )
        let lesson = try CorrectionLesson(
            phrasePair: CorrectionPhrasePair(
                sourcePhrase: "Conroe Cursor",
                replacementPhrase: "ConvoCursor"
            ),
            scope: scope
        )

        #expect(
            CorrectionPolicy.automaticDecision(
                for: "Open Conroe Cursor now",
                in: scope,
                lessons: [lesson]
            ) == .apply(lessonIDs: [lesson.id], updatedDraft: "Open ConvoCursor now")
        )
    }

    @Test("Every whole-word occurrence of a saved phrase is fixed")
    func everyWholeWordOccurrenceIsFixed() throws {
        let scope = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.Notes",
            localeIdentifier: "en-US"
        )
        let lesson = try CorrectionLesson(
            phrasePair: CorrectionPhrasePair(
                sourcePhrase: "Conroe Cursor",
                replacementPhrase: "ConvoCursor"
            ),
            scope: scope
        )

        #expect(
            CorrectionPolicy.automaticDecision(
                for: "Conroe Cursor, then Conroe Cursor",
                in: scope,
                lessons: [lesson]
            ) == .apply(lessonIDs: [lesson.id], updatedDraft: "ConvoCursor, then ConvoCursor")
        )
    }

    @Test("Fix once refuses ambiguity, and saved lessons never change part of a word")
    func fixOnceRefusesAmbiguityAndSavedLessonsSkipPartWords() throws {
        let scope = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.Notes",
            localeIdentifier: "en-US"
        )
        let phrasePair = try CorrectionPhrasePair(sourcePhrase: "aaa", replacementPhrase: "b")
        let lesson = try CorrectionLesson(phrasePair: phrasePair, scope: scope)

        #expect(throws: CorrectionPolicyError.sourcePhraseIsAmbiguousInDraft) {
            try CorrectionPolicy.applyFixOnce(to: "aaaa", phrasePair: phrasePair)
        }
        #expect(
            CorrectionPolicy.automaticDecision(
                for: "aaaa",
                in: scope,
                lessons: [lesson]
            ) == .unchanged
        )
    }

    @Test("Phrase pairs and scopes reject empty, unchanged, and internal targets")
    func phrasePairAndScopeRejectEmptyUnchangedAndInternalTargets() {
        #expect(throws: CorrectionPhrasePairError.emptySourcePhrase) {
            try CorrectionPhrasePair(sourcePhrase: "", replacementPhrase: "ConvoCursor")
        }
        #expect(throws: CorrectionPhrasePairError.emptyReplacementPhrase) {
            try CorrectionPhrasePair(sourcePhrase: "Conroe Cursor", replacementPhrase: "")
        }
        #expect(throws: CorrectionPhrasePairError.unchangedPhrasePair) {
            try CorrectionPhrasePair(sourcePhrase: "ConvoCursor", replacementPhrase: "ConvoCursor")
        }
        #expect(throws: CorrectionScopeError.emptyTargetApplicationIdentifier) {
            try CorrectionScope(
                externalTargetApplicationIdentifier: "",
                localeIdentifier: "en-US"
            )
        }
        #expect(throws: CorrectionScopeError.ownApplicationIsNotAnExternalTarget) {
            try CorrectionScope(
                externalTargetApplicationIdentifier: "com.trueconvo.mac",
                localeIdentifier: "en-US"
            )
        }
    }

    @Test("Scope mismatch and conflicting matches never apply automatically")
    func scopeMismatchAndConflictingMatchesNeverApplyAutomatically() throws {
        let notes = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.Notes",
            localeIdentifier: "en-US"
        )
        let mail = try CorrectionScope(
            externalTargetApplicationIdentifier: "com.apple.mail",
            localeIdentifier: "en-US"
        )
        let first = try CorrectionLesson(
            phrasePair: CorrectionPhrasePair(sourcePhrase: "Conroe Cursor", replacementPhrase: "ConvoCursor"),
            scope: notes
        )
        let conflicting = try CorrectionLesson(
            phrasePair: CorrectionPhrasePair(sourcePhrase: "Conroe Cursor", replacementPhrase: "Convo Cursor"),
            scope: notes
        )

        #expect(
            CorrectionPolicy.automaticDecision(
                for: "Conroe Cursor",
                in: mail,
                lessons: [first]
            ) == .unchanged
        )
        #expect(
            CorrectionPolicy.automaticDecision(
                for: "Conroe Cursor",
                in: notes,
                lessons: [first, conflicting]
            ) == .requiresReview
        )
    }

    @Test("Target refusal preserves a draft while only terminal events clear it")
    func targetRefusalPreservesDraftWhileOnlyTerminalEventsClearIt() throws {
        let phrasePair = try CorrectionPhrasePair(
            sourcePhrase: "Conroe Cursor",
            replacementPhrase: "ConvoCursor"
        )
        var refusedDraft = TransientDraft(text: "Conroe Cursor")
        try refusedDraft.applyFixOnce(phrasePair)

        #expect(refusedDraft.handle(.targetRefused) == .retainedForReview)
        #expect(refusedDraft.text == "ConvoCursor")

        for event in [
            TransientDraftEvent.cancelled,
            .successfullyDelivered,
            .terminalSpeechError,
            .backgrounded,
            .terminated
        ] {
            var draft = TransientDraft(text: "synthetic-private-draft-canary")
            #expect(draft.handle(event) == .cleared)
            #expect(draft.text == nil)
        }
    }

    private func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CorrectionMemoryPolicyTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
