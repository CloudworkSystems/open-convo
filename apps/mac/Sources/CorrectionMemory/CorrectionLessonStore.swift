import Foundation

/// Explicit state transitions for the local lesson array. Calling `remember`
/// is the only U2 path that creates a lesson; Fix once stays entirely inside
/// `TransientDraft` and never receives this store.
public final class CorrectionLessonStore {
    public let storageURL: URL
    public private(set) var lessons: [CorrectionLesson]

    private let boundary: LocalDataBoundary

    public init(directory: URL, fileManager: FileManager = .default) throws {
        let boundary = LocalDataBoundary(directory: directory, fileManager: fileManager)
        self.boundary = boundary
        self.storageURL = boundary.lessonsFileURL
        self.lessons = try boundary.readLessons()
        try Self.validateStoredLessons(self.lessons)
    }

    public func lesson(withID id: UUID) -> CorrectionLesson? {
        lessons.first { $0.id == id }
    }

    /// Saves one direct, owner-approved lesson. Repeating the exact same save
    /// returns the original lesson; a different replacement for the same
    /// source and scope is refused rather than silently choosing one.
    @discardableResult
    public func remember(
        _ phrasePair: CorrectionPhrasePair,
        in scope: CorrectionScope,
        createdAt: Date = Date()
    ) throws -> CorrectionLesson {
        if let existing = lessons.first(where: {
            $0.phrasePair == phrasePair && $0.scope == scope
        }) {
            return existing
        }
        if lessons.contains(where: {
            $0.phrasePair.sourcePhrase == phrasePair.sourcePhrase && $0.scope == scope
        }) {
            throw CorrectionLessonStoreError.conflictingReplacement
        }

        let lesson = try CorrectionLesson(
            phrasePair: phrasePair,
            scope: scope,
            createdAt: createdAt
        )
        var updatedLessons = lessons
        updatedLessons.append(lesson)
        try persist(updatedLessons)
        return lesson
    }

    /// Changes a lesson only through an explicit edit. A semantic change resets
    /// its use count, and duplicate or conflicting rules are refused.
    @discardableResult
    public func edit(
        lessonID: UUID,
        phrasePair: CorrectionPhrasePair,
        scope: CorrectionScope
    ) throws -> CorrectionLesson {
        guard let index = lessons.firstIndex(where: { $0.id == lessonID }) else {
            throw CorrectionLessonStoreError.lessonNotFound
        }

        let existing = lessons[index]
        guard existing.phrasePair != phrasePair || existing.scope != scope else {
            return existing
        }

        for otherLesson in lessons where otherLesson.id != lessonID && otherLesson.scope == scope && otherLesson.phrasePair.sourcePhrase == phrasePair.sourcePhrase {
            if otherLesson.phrasePair == phrasePair {
                throw CorrectionLessonStoreError.duplicateLesson
            }
            throw CorrectionLessonStoreError.conflictingReplacement
        }

        var editedLesson = existing
        editedLesson.edit(phrasePair: phrasePair, scope: scope)
        var updatedLessons = lessons
        updatedLessons[index] = editedLesson
        try persist(updatedLessons)
        return editedLesson
    }

    /// Immediate Undo for a just-saved lesson. It is intentionally the same
    /// durable removal transition as Forget, with a more precise caller name.
    public func undoRememberedLesson(lessonID: UUID) throws {
        try forget(lessonID: lessonID)
    }

    public func forget(lessonID: UUID) throws {
        guard let index = lessons.firstIndex(where: { $0.id == lessonID }) else {
            throw CorrectionLessonStoreError.lessonNotFound
        }

        var updatedLessons = lessons
        updatedLessons.remove(at: index)
        try persist(updatedLessons)
    }

    public func reset() throws {
        try persist([])
    }

    /// Applies every eligible saved lesson to finished dictation. No match, a
    /// scope mismatch, or a collision leaves the draft unchanged and changes no
    /// use count. Each applied lesson's use count goes up once per dictation.
    public func applySavedCorrection(
        to draft: String,
        in scope: CorrectionScope
    ) throws -> CorrectionApplicationOutcome {
        switch CorrectionPolicy.automaticDecision(for: draft, in: scope, lessons: lessons) {
        case .unchanged:
            return .unchanged(draft: draft)
        case .requiresReview:
            return .requiresReview(draft: draft)
        case let .apply(lessonIDs, updatedDraft):
            var updatedLessons = lessons
            var applied: [CorrectionLesson] = []
            for lessonID in lessonIDs {
                guard let index = updatedLessons.firstIndex(where: { $0.id == lessonID }) else {
                    throw CorrectionLessonStoreError.lessonNotFound
                }
                try updatedLessons[index].recordSuccessfulUse()
                applied.append(updatedLessons[index])
            }
            try persist(updatedLessons)
            return .applied(draft: updatedDraft, lessons: applied)
        }
    }

    private func persist(_ proposedLessons: [CorrectionLesson]) throws {
        try Self.validateStoredLessons(proposedLessons)
        try boundary.replaceLessonsAtomically(proposedLessons)
        lessons = proposedLessons
    }

    private static func validateStoredLessons(_ lessons: [CorrectionLesson]) throws {
        var identifiers = Set<UUID>()
        var exactRules = Set<StoredRuleIdentity>()
        var sourcesInScope = Set<StoredSourceIdentity>()

        for lesson in lessons {
            guard identifiers.insert(lesson.id).inserted else {
                throw CorrectionLessonStoreError.duplicateLessonIdentifier
            }

            let exactRule = StoredRuleIdentity(phrasePair: lesson.phrasePair, scope: lesson.scope)
            guard exactRules.insert(exactRule).inserted else {
                throw CorrectionLessonStoreError.duplicateLesson
            }

            let sourceIdentity = StoredSourceIdentity(
                sourcePhrase: lesson.phrasePair.sourcePhrase,
                scope: lesson.scope
            )
            guard sourcesInScope.insert(sourceIdentity).inserted else {
                throw CorrectionLessonStoreError.conflictingReplacement
            }
        }
    }
}

public enum CorrectionLessonStoreError: Error, Equatable, Sendable {
    case conflictingReplacement
    case duplicateLesson
    case duplicateLessonIdentifier
    case lessonNotFound
}

public enum CorrectionApplicationOutcome: Equatable, Sendable {
    case unchanged(draft: String)
    case requiresReview(draft: String)
    case applied(draft: String, lessons: [CorrectionLesson])

    public var updatedDraft: String {
        switch self {
        case let .unchanged(draft), let .requiresReview(draft), let .applied(draft, _):
            return draft
        }
    }

    /// Every lesson applied to this draft, in the order they first appear.
    public var appliedLessons: [CorrectionLesson] {
        guard case let .applied(_, lessons) = self else {
            return []
        }
        return lessons
    }

    /// The first applied lesson, for callers that only show one.
    public var appliedLesson: CorrectionLesson? {
        appliedLessons.first
    }
}

private struct StoredRuleIdentity: Hashable {
    let phrasePair: CorrectionPhrasePair
    let scope: CorrectionScope
}

private struct StoredSourceIdentity: Hashable {
    let sourcePhrase: String
    let scope: CorrectionScope
}
