import Foundation

/// Pure correction rules. It has no persistence, speech, target-delivery, or
/// diagnostic behavior.
public enum CorrectionPolicy {
    /// Changes one unambiguous occurrence in the current app-owned draft.
    /// A caller must already have shown the exact pair to the person.
    public static func applyFixOnce(
        to draft: String,
        phrasePair: CorrectionPhrasePair
    ) throws -> String {
        guard let firstRange = draft.range(of: phrasePair.sourcePhrase) else {
            throw CorrectionPolicyError.sourcePhraseNotFoundInDraft
        }

        guard !hasOverlappingOrLaterOccurrence(
            of: phrasePair.sourcePhrase,
            in: draft,
            afterFirstRange: firstRange
        ) else {
            throw CorrectionPolicyError.sourcePhraseIsAmbiguousInDraft
        }

        var updatedDraft = draft
        updatedDraft.replaceSubrange(firstRange, with: phrasePair.replacementPhrase)
        return updatedDraft
    }

    /// Applies saved lessons to finished dictation, the way a person expects:
    /// whole words only, any capitalization, every occurrence, and every
    /// eligible lesson at once. A match whose text already reads the way the
    /// lesson wants is not a change: it is skipped and not counted. It still
    /// refuses to guess: if two different lessons would change overlapping
    /// text, nothing changes and the caller gets `.requiresReview`. A lesson
    /// for the specific app wins over an any-app lesson with the same source
    /// phrase.
    public static func automaticDecision(
        for draft: String,
        in scope: CorrectionScope,
        lessons: [CorrectionLesson]
    ) -> CorrectionApplicationDecision {
        let eligible = preferAppSpecificLessons(lessons.filter { $0.scope.covers(scope) })
        var changes: [(range: Range<String.Index>, replacement: String, lessonID: UUID)] = []
        for lesson in eligible {
            for range in wholeWordRanges(of: lesson.phrasePair.sourcePhrase, in: draft) {
                let replacement = adaptedReplacement(
                    lesson.phrasePair.replacementPhrase,
                    matchedText: draft[range]
                )
                guard replacement != String(draft[range]) else { continue }
                changes.append((range: range, replacement: replacement, lessonID: lesson.id))
            }
        }
        guard !changes.isEmpty else {
            return .unchanged
        }

        changes.sort { $0.range.lowerBound < $1.range.lowerBound }
        for (previous, next) in zip(changes, changes.dropFirst())
        where next.range.lowerBound < previous.range.upperBound {
            return .requiresReview
        }

        var updatedDraft = draft
        for change in changes.reversed() {
            updatedDraft.replaceSubrange(change.range, with: change.replacement)
        }
        var appliedIDs: [UUID] = []
        for change in changes where !appliedIDs.contains(change.lessonID) {
            appliedIDs.append(change.lessonID)
        }
        return .apply(lessonIDs: appliedIDs, updatedDraft: updatedDraft)
    }

    /// Non-overlapping, case-insensitive occurrences that start and end on word
    /// boundaries, so a "cat" lesson never touches "category" and a "can"
    /// lesson never touches "can't", while a "conroe" lesson still fixes
    /// "Conroe's" and "'conroe'". A word edge is only required where the
    /// phrase itself starts or ends with a letter or digit, so a lesson saved
    /// as "hello," still matches inside "hello,world".
    static func wholeWordRanges(of phrase: String, in text: String) -> [Range<String.Index>] {
        guard let phraseFirst = phrase.first, let phraseLast = phrase.last else { return [] }
        let needsEdgeBefore = isWordCharacter(phraseFirst)
        let needsEdgeAfter = isWordCharacter(phraseLast)

        var ranges: [Range<String.Index>] = []
        var searchStart = text.startIndex
        while searchStart < text.endIndex,
              let range = text.range(
                  of: phrase,
                  options: [.caseInsensitive],
                  range: searchStart..<text.endIndex
              ) {
            if !needsEdgeBefore || isWordBoundary(before: range.lowerBound, in: text),
               !needsEdgeAfter || isWordBoundary(after: range.upperBound, in: text) {
                ranges.append(range)
                searchStart = range.upperBound
            } else {
                searchStart = text.index(after: range.lowerBound)
            }
        }
        return ranges
    }

    /// A match starting right after an apostrophe is mid-word only when a
    /// letter or digit comes before that apostrophe ("Brien" in "O'Brien").
    /// An apostrophe at the start or after a space is an opening quote, so
    /// "conroe" in "'conroe'" is a whole word.
    private static func isWordBoundary(before index: String.Index, in text: String) -> Bool {
        guard index > text.startIndex else { return true }
        let previousIndex = text.index(before: index)
        let previous = text[previousIndex]
        if isWordCharacter(previous) { return false }
        if isApostrophe(previous),
           previousIndex > text.startIndex,
           isWordCharacter(text[text.index(before: previousIndex)]) {
            return false
        }
        return true
    }

    /// Endings after an apostrophe that leave the word itself alone: the
    /// possessive 's and the short contractions 'll, 'd, 're, 've and 'm.
    private static let wordKeepingEndings: Set<String> = ["s", "ll", "d", "re", "ve", "m"]

    /// A match ending right before an apostrophe is still a whole word when no
    /// letter follows the apostrophe ("students'") or when the letters after
    /// it are a possessive or short contraction ("Conroe's", "Conroe'll").
    /// Any other letters change the word, so "can" in "can't" is mid-word.
    private static func isWordBoundary(after index: String.Index, in text: String) -> Bool {
        guard index < text.endIndex else { return true }
        let next = text[index]
        if isWordCharacter(next) { return false }
        guard isApostrophe(next) else { return true }
        let endingStart = text.index(after: index)
        var endingEnd = endingStart
        while endingEnd < text.endIndex, text[endingEnd].isLetter {
            endingEnd = text.index(after: endingEnd)
        }
        let ending = text[endingStart..<endingEnd].lowercased()
        return ending.isEmpty || wordKeepingEndings.contains(ending)
    }

    private static func isWordCharacter(_ character: Character) -> Bool {
        character.isLetter || character.isNumber
    }

    /// The straight apostrophe and the curly one (U+2019) that macOS and
    /// speech engines often type instead.
    private static func isApostrophe(_ character: Character) -> Bool {
        character == "'" || character == "\u{2019}"
    }

    /// Keeps a capital at the start of a sentence: "Conroe" fixed by a lesson
    /// saved as "convo" becomes "Convo". It compares first letters, skipping
    /// leading punctuation, so "'Til" fixed by "until" becomes "Until".
    /// Never lowercases a replacement.
    private static func adaptedReplacement(_ replacement: String, matchedText: Substring) -> String {
        guard let matchedFirstLetter = matchedText.first(where: \.isLetter),
              matchedFirstLetter.isUppercase,
              let letterIndex = replacement.firstIndex(where: \.isLetter),
              replacement[letterIndex].isLowercase
        else {
            return replacement
        }
        var adapted = replacement
        adapted.replaceSubrange(letterIndex...letterIndex, with: replacement[letterIndex].uppercased())
        return adapted
    }

    /// When the same source phrase has both an app-specific lesson and an
    /// any-app lesson, only the app-specific one competes.
    private static func preferAppSpecificLessons(_ lessons: [CorrectionLesson]) -> [CorrectionLesson] {
        let appSpecificSources = Set(
            lessons.filter { !$0.scope.appliesToAnyApplication }
                .map { $0.phrasePair.sourcePhrase.lowercased() }
        )
        return lessons.filter {
            !$0.scope.appliesToAnyApplication
                || !appSpecificSources.contains($0.phrasePair.sourcePhrase.lowercased())
        }
    }

    /// Searching from one character after the first match's lower bound makes
    /// overlapping copies ambiguous too: `aaa` occurs twice in `aaaa`.
    private static func hasOverlappingOrLaterOccurrence(
        of phrase: String,
        in draft: String,
        afterFirstRange firstRange: Range<String.Index>
    ) -> Bool {
        let nextSearchStart = draft.index(after: firstRange.lowerBound)
        return draft.range(of: phrase, range: nextSearchStart..<draft.endIndex) != nil
    }
}

public enum CorrectionApplicationDecision: Equatable, Sendable {
    case unchanged
    case apply(lessonIDs: [UUID], updatedDraft: String)
    case requiresReview
}

public enum CorrectionPolicyError: Error, Equatable, Sendable {
    case sourcePhraseNotFoundInDraft
    case sourcePhraseIsAmbiguousInDraft
    case draftIsNoLongerAvailable
}

/// A review-only draft. Its text exists only in memory and never references a
/// lesson store. Target refusal is intentionally nonterminal so the person can
/// keep reviewing or copy the draft themselves.
public struct TransientDraft: Equatable, Sendable {
    public private(set) var text: String?

    public init(text: String) {
        self.text = text
    }

    public mutating func applyFixOnce(_ phrasePair: CorrectionPhrasePair) throws {
        guard let text else {
            throw CorrectionPolicyError.draftIsNoLongerAvailable
        }
        self.text = try CorrectionPolicy.applyFixOnce(to: text, phrasePair: phrasePair)
    }

    @discardableResult
    public mutating func handle(_ event: TransientDraftEvent) -> TransientDraftDisposition {
        switch event {
        case .targetRefused:
            return .retainedForReview
        case .cancelled, .successfullyDelivered, .terminalSpeechError, .backgrounded, .terminated:
            text = nil
            return .cleared
        }
    }
}

public enum TransientDraftEvent: Equatable, Sendable {
    case targetRefused
    case cancelled
    case successfullyDelivered
    case terminalSpeechError
    case backgrounded
    case terminated
}

public enum TransientDraftDisposition: Equatable, Sendable {
    case retainedForReview
    case cleared
}
