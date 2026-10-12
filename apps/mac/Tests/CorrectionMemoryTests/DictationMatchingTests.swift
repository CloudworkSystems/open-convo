import Foundation
@testable import CorrectionMemory
import Testing

/// How saved lessons behave on finished dictation (build plan step 7).
@Suite("Dictation matching")
struct DictationMatchingTests {
    private let notes = "com.apple.Notes"
    private let mail = "com.apple.mail"

    private func scope(_ app: String, _ locale: String = "en-US") throws -> CorrectionScope {
        try CorrectionScope(externalTargetApplicationIdentifier: app, localeIdentifier: locale)
    }

    private func lesson(_ source: String, _ replacement: String, _ scope: CorrectionScope) throws -> CorrectionLesson {
        try CorrectionLesson(
            phrasePair: CorrectionPhrasePair(sourcePhrase: source, replacementPhrase: replacement),
            scope: scope
        )
    }

    @Test("A lesson never changes part of a longer word")
    func wholeWordsOnly() throws {
        let catToDog = try lesson("cat", "dog", scope(notes))
        #expect(
            try CorrectionPolicy.automaticDecision(for: "a category of cats", in: scope(notes), lessons: [catToDog])
                == .unchanged
        )
        #expect(
            try CorrectionPolicy.automaticDecision(for: "the cat sat", in: scope(notes), lessons: [catToDog])
                == .apply(lessonIDs: [catToDog.id], updatedDraft: "the dog sat")
        )
    }

    @Test("Matching ignores capitals and keeps a sentence-start capital")
    func caseInsensitiveWithCapitalKept() throws {
        let conroe = try lesson("conroe", "Convo", scope(notes))
        #expect(
            try CorrectionPolicy.automaticDecision(for: "Conroe is great", in: scope(notes), lessons: [conroe])
                == .apply(lessonIDs: [conroe.id], updatedDraft: "Convo is great")
        )
        let marlo = try lesson("marlo", "marlowe", scope(notes))
        #expect(
            try CorrectionPolicy.automaticDecision(for: "Marlo called marlo", in: scope(notes), lessons: [marlo])
                == .apply(lessonIDs: [marlo.id], updatedDraft: "Marlowe called marlowe")
        )
    }

    @Test("An any-app lesson applies in every app, and only in its language")
    func anyAppScope() throws {
        let everywhere = try lesson("conroe", "Convo", CorrectionScope.anyApplication(localeIdentifier: "en-US"))
        for app in [notes, mail] {
            #expect(
                try CorrectionPolicy.automaticDecision(for: "open conroe", in: scope(app), lessons: [everywhere])
                    == .apply(lessonIDs: [everywhere.id], updatedDraft: "open Convo")
            )
        }
        #expect(
            try CorrectionPolicy.automaticDecision(for: "open conroe", in: scope(notes, "fr-FR"), lessons: [everywhere])
                == .unchanged
        )
    }

    @Test("en_US and en-US count as the same language")
    func localeSpellingsMatch() throws {
        let everywhere = try lesson("conroe", "Convo", CorrectionScope.anyApplication(localeIdentifier: "en-US"))
        #expect(
            try CorrectionPolicy.automaticDecision(for: "conroe", in: scope(notes, "en_US"), lessons: [everywhere])
                == .apply(lessonIDs: [everywhere.id], updatedDraft: "Convo")
        )
    }

    @Test("An app-specific lesson wins over an any-app lesson for the same phrase")
    func appSpecificWins() throws {
        let everywhere = try lesson("conroe", "Convo", CorrectionScope.anyApplication(localeIdentifier: "en-US"))
        let inMail = try lesson("conroe", "Conroe, Texas", scope(mail))
        #expect(
            try CorrectionPolicy.automaticDecision(for: "from conroe", in: scope(mail), lessons: [everywhere, inMail])
                == .apply(lessonIDs: [inMail.id], updatedDraft: "from Conroe, Texas")
        )
        #expect(
            try CorrectionPolicy.automaticDecision(for: "from conroe", in: scope(notes), lessons: [everywhere, inMail])
                == .apply(lessonIDs: [everywhere.id], updatedDraft: "from Convo")
        )
    }

    @Test("Independent lessons all apply in one dictation")
    func independentLessonsAllApply() throws {
        let first = try lesson("conroe", "Convo", scope(notes))
        let second = try lesson("marlo", "Marlowe", scope(notes))
        #expect(
            try CorrectionPolicy.automaticDecision(
                for: "tell marlo about conroe",
                in: scope(notes),
                lessons: [first, second]
            ) == .apply(lessonIDs: [second.id, first.id], updatedDraft: "tell Marlowe about Convo")
        )
    }

    @Test("Two lessons that would change overlapping text are flagged, not guessed")
    func collidingLessonsRequireReview() throws {
        let first = try lesson("new york", "NYC", scope(notes))
        let second = try lesson("york city", "York-City", scope(notes))
        #expect(
            try CorrectionPolicy.automaticDecision(for: "in new york city", in: scope(notes), lessons: [first, second])
                == .requiresReview
        )
    }

    @Test("Saved any-app lessons reapply after the store is reopened, counting each use")
    func storeReappliesAfterReopen() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CorrectionMemoryDictationTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let store = try CorrectionLessonStore(directory: directory)
        let everywhere = try CorrectionScope.anyApplication(localeIdentifier: "en-US")
        let first = try store.remember(CorrectionPhrasePair(sourcePhrase: "conroe", replacementPhrase: "Convo"), in: everywhere)
        let second = try store.remember(CorrectionPhrasePair(sourcePhrase: "marlo", replacementPhrase: "Marlowe"), in: everywhere)

        let reopened = try CorrectionLessonStore(directory: directory)
        let outcome = try reopened.applySavedCorrection(to: "marlo and conroe", in: scope(mail))
        #expect(outcome.updatedDraft == "Marlowe and Convo")
        #expect(Set(outcome.appliedLessons.map(\.id)) == [first.id, second.id])

        let reopenedAgain = try CorrectionLessonStore(directory: directory)
        #expect(reopenedAgain.lesson(withID: first.id)?.useCount == 1)
        #expect(reopenedAgain.lesson(withID: second.id)?.useCount == 1)
    }
}
