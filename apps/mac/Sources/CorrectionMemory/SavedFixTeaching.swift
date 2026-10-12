import Foundation

/// What happened when a person taught a fix by typing it.
public enum TeachOutcome: Equatable, Sendable {
    /// A new lesson was saved.
    case saved
    /// The same wrong phrase now gets a different replacement. Its use count
    /// starts again at zero.
    case updated
    /// The same wrong phrase already had exactly this replacement. Nothing was
    /// written and the use count is kept.
    case alreadySaved
}

/// Counts from moving an old word list into saved lessons.
public struct LegacyImportReport: Equatable, Sendable {
    /// Rules in the old list.
    public var rules: Int
    /// Rules saved as new lessons by this run.
    public var saved: Int
    /// Rules whose wrong phrase (any capitals) already has a lesson. That
    /// lesson is kept as it is, so a fix taught later is never overwritten.
    public var alreadySaved: Int
    /// Rules that can never be saved: an empty phrase, or a replacement that
    /// is the same as the wrong phrase. They count as handled.
    public var invalid: Int
    /// Rules that could not be saved this time, for example because the file
    /// could not be written. They should be tried again later.
    public var failed: Int

    public init(rules: Int = 0, saved: Int = 0, alreadySaved: Int = 0, invalid: Int = 0, failed: Int = 0) {
        self.rules = rules
        self.saved = saved
        self.alreadySaved = alreadySaved
        self.invalid = invalid
        self.failed = failed
    }

    /// True when every valid old rule is now in the store.
    public var isComplete: Bool {
        failed == 0
    }
}

extension CorrectionLessonStore {
    /// Teaches "wrong -> right" in `scope`. Saved fixes match wrong phrases
    /// ignoring capitals, so a wrong phrase that differs from a saved one only
    /// in capitals is the same lesson.
    @discardableResult
    public func teach(wrong: String, right: String, in scope: CorrectionScope) throws -> TeachOutcome {
        let pair = try CorrectionPhrasePair(sourcePhrase: wrong, replacementPhrase: right)
        if let existing = existingLesson(forWrongPhrase: wrong, in: scope) {
            // Only the replacement's exact spelling matters; the wrong phrase
            // is matched ignoring capitals, so it stays as first taught.
            if existing.phrasePair.replacementPhrase == right {
                return .alreadySaved
            }
            try edit(lessonID: existing.id, phrasePair: pair, scope: scope)
            return .updated
        }
        try remember(pair, in: scope)
        return .saved
    }

    /// Moves an old word list (wrong -> right) into saved lessons, in a fixed
    /// order. A rule whose wrong phrase already has a lesson is left alone.
    /// Never throws: every rule is counted in the report, and failed rules
    /// can be retried by calling this again.
    public func importLegacyRules(_ rules: [String: String], in scope: CorrectionScope) -> LegacyImportReport {
        var report = LegacyImportReport(rules: rules.count)
        for (wrong, right) in rules.sorted(by: { $0.key < $1.key }) {
            let pair: CorrectionPhrasePair
            do {
                pair = try CorrectionPhrasePair(sourcePhrase: wrong, replacementPhrase: right)
            } catch {
                report.invalid += 1
                continue
            }
            if existingLesson(forWrongPhrase: wrong, in: scope) != nil {
                report.alreadySaved += 1
                continue
            }
            do {
                try remember(pair, in: scope)
                report.saved += 1
            } catch {
                report.failed += 1
            }
        }
        return report
    }

    /// What saved lessons would make of `draft` in `scope`, without counting a
    /// use or writing anything. If two lessons would change overlapping text,
    /// the draft comes back unchanged.
    public func preview(_ draft: String, in scope: CorrectionScope) -> String {
        if case let .apply(_, updatedDraft) = CorrectionPolicy.automaticDecision(
            for: draft,
            in: scope,
            lessons: lessons
        ) {
            return updatedDraft
        }
        return draft
    }

    private func existingLesson(forWrongPhrase wrong: String, in scope: CorrectionScope) -> CorrectionLesson? {
        let key = wrong.lowercased()
        return lessons.first { $0.scope == scope && $0.phrasePair.sourcePhrase.lowercased() == key }
    }
}
