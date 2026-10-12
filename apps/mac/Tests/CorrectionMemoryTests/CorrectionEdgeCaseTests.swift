import Foundation
@testable import CorrectionMemory
import Testing

/// Word edges, punctuation edges, capital keeping, and no-op matches, from the
/// independent review of the correction engine. Made-up phrases only.
@Suite("Correction edge cases")
struct CorrectionEdgeCaseTests {
    private let notes = "com.apple.Notes"

    private func scope(_ app: String = "com.apple.Notes") throws -> CorrectionScope {
        try CorrectionScope(externalTargetApplicationIdentifier: app, localeIdentifier: "en-US")
    }

    private func lesson(_ source: String, _ replacement: String) throws -> CorrectionLesson {
        try CorrectionLesson(
            phrasePair: CorrectionPhrasePair(sourcePhrase: source, replacementPhrase: replacement),
            scope: scope()
        )
    }

    private func decide(_ draft: String, _ lessons: [CorrectionLesson]) throws -> CorrectionApplicationDecision {
        try CorrectionPolicy.automaticDecision(for: draft, in: scope(), lessons: lessons)
    }

    // MARK: 1. An apostrophe followed by a letter is part of the word

    @Test("A lesson never splits a word at an apostrophe after the match")
    func apostropheAfterMatchIsPartOfTheWord() throws {
        let canToMay = try lesson("can", "may")
        #expect(try decide("I can't go", [canToMay]) == .unchanged)
        #expect(try decide("I can\u{2019}t go", [canToMay]) == .unchanged)
        #expect(try decide("Can't stop", [canToMay]) == .unchanged)
        #expect(try decide("I can go", [canToMay]) == .apply(lessonIDs: [canToMay.id], updatedDraft: "I may go"))

        let donToDawn = try lesson("don", "Dawn")
        #expect(try decide("we don't know", [donToDawn]) == .unchanged)
    }

    @Test("A lesson never splits a word at an apostrophe before the match")
    func apostropheBeforeMatchIsPartOfTheWord() throws {
        let brienToBryan = try lesson("brien", "Bryan")
        #expect(try decide("call O'Brien today", [brienToBryan]) == .unchanged)
        #expect(try decide("call O\u{2019}Brien today", [brienToBryan]) == .unchanged)
        #expect(
            try decide("call brien today", [brienToBryan])
                == .apply(lessonIDs: [brienToBryan.id], updatedDraft: "call Bryan today")
        )
    }

    @Test("An apostrophe not followed by a letter is still a word edge")
    func trailingApostropheIsStillAnEdge() throws {
        let studentsToPupils = try lesson("students", "pupils")
        #expect(
            try decide("the students' work", [studentsToPupils])
                == .apply(lessonIDs: [studentsToPupils.id], updatedDraft: "the pupils' work")
        )
    }

    @Test("A saved fix still reaches a possessive or short contraction of the word")
    func possessiveAndShortContractionStillMatch() throws {
        let conroeToConvo = try lesson("conroe", "Convo")
        #expect(
            try decide("The Conroe's menu opened", [conroeToConvo])
                == .apply(lessonIDs: [conroeToConvo.id], updatedDraft: "The Convo's menu opened")
        )
        #expect(
            try decide("The Conroe\u{2019}s menu opened", [conroeToConvo])
                == .apply(lessonIDs: [conroeToConvo.id], updatedDraft: "The Convo\u{2019}s menu opened")
        )
        #expect(
            try decide("Conroe'll be fine", [conroeToConvo])
                == .apply(lessonIDs: [conroeToConvo.id], updatedDraft: "Convo'll be fine")
        )
        #expect(
            try decide("Conroe'd know, conroe're sure, conroe've seen", [conroeToConvo])
                == .apply(
                    lessonIDs: [conroeToConvo.id],
                    updatedDraft: "Convo'd know, Convo're sure, Convo've seen"
                )
        )

        let brianToBryan = try lesson("brian", "bryan")
        #expect(
            try decide("Brian's car is here", [brianToBryan])
                == .apply(lessonIDs: [brianToBryan.id], updatedDraft: "Bryan's car is here")
        )
    }

    @Test("An opening quote before the word is a word edge")
    func openingQuoteIsAnEdge() throws {
        let conroeToConvo = try lesson("conroe", "Convo")
        #expect(
            try decide("he said 'conroe' twice", [conroeToConvo])
                == .apply(lessonIDs: [conroeToConvo.id], updatedDraft: "he said 'Convo' twice")
        )
        #expect(
            try decide("'conroe' is the name", [conroeToConvo])
                == .apply(lessonIDs: [conroeToConvo.id], updatedDraft: "'Convo' is the name")
        )
        #expect(
            try decide("he said \u{2019}conroe\u{2019} twice", [conroeToConvo])
                == .apply(lessonIDs: [conroeToConvo.id], updatedDraft: "he said \u{2019}Convo\u{2019} twice")
        )
    }

    @Test("Other letters after an apostrophe still make it one word")
    func otherApostropheEndingsStayMidWord() throws {
        let rockToRocky = try lesson("rock", "rocky")
        #expect(try decide("play rock'n'roll now", [rockToRocky]) == .unchanged)
        let conroeToConvo = try lesson("conroe", "Convo")
        #expect(try decide("the Conroe'sque look", [conroeToConvo]) == .unchanged)
    }

    @Test("A lesson that contains the apostrophe itself still applies")
    func lessonWithApostropheApplies() throws {
        let cantToCannot = try lesson("can't", "cannot")
        #expect(
            try decide("I can't go", [cantToCannot])
                == .apply(lessonIDs: [cantToCannot.id], updatedDraft: "I cannot go")
        )
    }

    // MARK: 2. Word edges are only required where the phrase edge is a letter or digit

    @Test("A phrase ending in punctuation matches right before a letter")
    func trailingPunctuationNeedsNoEdgeAfter() throws {
        let helloComma = try lesson("hello,", "hi,")
        #expect(
            try decide("hello,world", [helloComma])
                == .apply(lessonIDs: [helloComma.id], updatedDraft: "hi,world")
        )
        // The letter side still needs a real word edge.
        #expect(try decide("othello,world", [helloComma]) == .unchanged)
    }

    @Test("A phrase starting with punctuation matches right after a letter")
    func leadingPunctuationNeedsNoEdgeBefore() throws {
        let dotNet = try lesson(".net", ".NET")
        #expect(
            try decide("asp.net rocks", [dotNet])
                == .apply(lessonIDs: [dotNet.id], updatedDraft: "asp.NET rocks")
        )
        // The letter side still needs a real word edge.
        #expect(try decide("asp.network", [dotNet]) == .unchanged)
    }

    // MARK: 3. Capital keeping looks at the first letter, past punctuation

    @Test("A capital on the first letter is kept even after leading punctuation")
    func capitalKeptPastLeadingPunctuation() throws {
        let tilToUntil = try lesson("'til", "until")
        #expect(
            try decide("'Til then", [tilToUntil])
                == .apply(lessonIDs: [tilToUntil.id], updatedDraft: "Until then")
        )

        let bracketed = try lesson("conroe", "(convo)")
        #expect(
            try decide("Conroe rocks", [bracketed])
                == .apply(lessonIDs: [bracketed.id], updatedDraft: "(Convo) rocks")
        )
    }

    // MARK: 4. A match that would not change anything is not a change

    @Test("Text that already reads the way the lesson wants is left alone")
    func identicalReplacementIsNotAChange() throws {
        let capitalConvo = try lesson("convo", "Convo")
        #expect(try decide("Convo is here", [capitalConvo]) == .unchanged)
        #expect(
            try decide("Convo and convo", [capitalConvo])
                == .apply(lessonIDs: [capitalConvo.id], updatedDraft: "Convo and Convo")
        )
    }

    @Test("A match that changes nothing does not block another lesson's change")
    func noOpMatchIsNotACollision() throws {
        let capitalNewYork = try lesson("new york", "New York")
        let yorkCity = try lesson("york city", "York-City")
        #expect(
            try decide("in New York city", [capitalNewYork, yorkCity])
                == .apply(lessonIDs: [yorkCity.id], updatedDraft: "in New York-City")
        )
        // When both would really change the text, it is still flagged.
        #expect(try decide("in new york city", [capitalNewYork, yorkCity]) == .requiresReview)
    }

    @Test("A no-op match is not counted as a use and writes nothing")
    func noOpMatchIsNotCounted() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CorrectionMemoryEdgeTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let store = try CorrectionLessonStore(directory: directory)
        let saved = try store.remember(
            CorrectionPhrasePair(sourcePhrase: "convo", replacementPhrase: "Convo"),
            in: scope()
        )

        let outcome = try store.applySavedCorrection(to: "Convo is here", in: scope())
        #expect(outcome == .unchanged(draft: "Convo is here"))
        #expect(store.lesson(withID: saved.id)?.useCount == 0)
        #expect(try CorrectionLessonStore(directory: directory).lesson(withID: saved.id)?.useCount == 0)
    }
}
