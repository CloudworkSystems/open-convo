import Foundation

/// A phrase pair that a person has explicitly approved for one narrow lesson.
/// The strings are kept exactly as entered; validation only rejects unusable input.
public struct CorrectionPhrasePair: Codable, Equatable, Hashable, Sendable {
    public let sourcePhrase: String
    public let replacementPhrase: String

    public init(sourcePhrase: String, replacementPhrase: String) throws {
        guard !sourcePhrase.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CorrectionPhrasePairError.emptySourcePhrase
        }
        guard !replacementPhrase.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CorrectionPhrasePairError.emptyReplacementPhrase
        }
        guard sourcePhrase != replacementPhrase else {
            throw CorrectionPhrasePairError.unchangedPhrasePair
        }

        self.sourcePhrase = sourcePhrase
        self.replacementPhrase = replacementPhrase
    }

    private enum CodingKeys: String, CodingKey {
        case sourcePhrase
        case replacementPhrase
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            sourcePhrase: container.decode(String.self, forKey: .sourcePhrase),
            replacementPhrase: container.decode(String.self, forKey: .replacementPhrase)
        )
    }
}

public enum CorrectionPhrasePairError: Error, Equatable, Sendable {
    case emptySourcePhrase
    case emptyReplacementPhrase
    case unchangedPhrasePair
}

/// The declared context where a lesson may be reused. It deliberately names an
/// external app, never True Convo itself.
public struct CorrectionScope: Codable, Equatable, Hashable, Sendable {
    /// True Convo's own bundle identifiers. A lesson never targets the app that
    /// is doing the dictating. Covers the current id, the planned id, and the
    /// running bundle's id, all compared lowercased.
    public static let ownApplicationIdentifiers: Set<String> = {
        var identifiers: Set<String> = ["com.trueconvo.voice-cursor", "com.trueconvo.mac"]
        if let running = Bundle.main.bundleIdentifier?.lowercased() {
            identifiers.insert(running)
        }
        return identifiers
    }()

    /// Target identifier meaning "every app": the lesson follows the person
    /// wherever they dictate. Chosen by the owner on 2026-09-27.
    public static let anyApplicationIdentifier = "*"

    public let externalTargetApplicationIdentifier: String
    public let localeIdentifier: String

    /// A scope that applies in every app for one language.
    public static func anyApplication(localeIdentifier: String) throws -> CorrectionScope {
        try CorrectionScope(
            externalTargetApplicationIdentifier: anyApplicationIdentifier,
            localeIdentifier: localeIdentifier
        )
    }

    public var appliesToAnyApplication: Bool {
        externalTargetApplicationIdentifier == Self.anyApplicationIdentifier
    }

    /// Whether a lesson saved with this scope may apply where `target` describes
    /// the app being dictated into. App ids compare case-insensitively, and
    /// "en_US" and "en-US" count as the same language.
    public func covers(_ target: CorrectionScope) -> Bool {
        guard Self.normalizedLocale(localeIdentifier) == Self.normalizedLocale(target.localeIdentifier) else {
            return false
        }
        return appliesToAnyApplication
            || externalTargetApplicationIdentifier.lowercased()
                == target.externalTargetApplicationIdentifier.lowercased()
    }

    static func normalizedLocale(_ identifier: String) -> String {
        identifier.replacingOccurrences(of: "_", with: "-").lowercased()
    }

    public init(externalTargetApplicationIdentifier: String, localeIdentifier: String) throws {
        let targetIdentifier = externalTargetApplicationIdentifier.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        let locale = localeIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !targetIdentifier.isEmpty else {
            throw CorrectionScopeError.emptyTargetApplicationIdentifier
        }
        guard targetIdentifier == externalTargetApplicationIdentifier,
              !targetIdentifier.contains(where: \.isWhitespace) else {
            throw CorrectionScopeError.invalidTargetApplicationIdentifier
        }
        guard !Self.ownApplicationIdentifiers.contains(targetIdentifier.lowercased()) else {
            throw CorrectionScopeError.ownApplicationIsNotAnExternalTarget
        }
        guard !locale.isEmpty else {
            throw CorrectionScopeError.emptyLocaleIdentifier
        }
        guard locale == localeIdentifier else {
            throw CorrectionScopeError.invalidLocaleIdentifier
        }

        self.externalTargetApplicationIdentifier = externalTargetApplicationIdentifier
        self.localeIdentifier = localeIdentifier
    }

    private enum CodingKeys: String, CodingKey {
        case externalTargetApplicationIdentifier
        case localeIdentifier
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            externalTargetApplicationIdentifier: container.decode(
                String.self,
                forKey: .externalTargetApplicationIdentifier
            ),
            localeIdentifier: container.decode(String.self, forKey: .localeIdentifier)
        )
    }
}

public enum CorrectionScopeError: Error, Equatable, Sendable {
    case emptyTargetApplicationIdentifier
    case invalidTargetApplicationIdentifier
    case ownApplicationIsNotAnExternalTarget
    case emptyLocaleIdentifier
    case invalidLocaleIdentifier
}

/// The only durable correction state: an approved phrase pair, narrow scope,
/// creation time, and count of successful exact reuses.
public struct CorrectionLesson: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public private(set) var phrasePair: CorrectionPhrasePair
    public private(set) var scope: CorrectionScope
    public let createdAt: Date
    public private(set) var useCount: Int

    public init(
        id: UUID = UUID(),
        phrasePair: CorrectionPhrasePair,
        scope: CorrectionScope,
        createdAt: Date = Date(),
        useCount: Int = 0
    ) throws {
        guard useCount >= 0 else {
            throw CorrectionLessonError.negativeUseCount
        }

        self.id = id
        self.phrasePair = phrasePair
        self.scope = scope
        self.createdAt = createdAt
        self.useCount = useCount
    }

    mutating func recordSuccessfulUse() throws {
        guard useCount < Int.max else {
            throw CorrectionLessonError.useCountOverflow
        }
        useCount += 1
    }

    mutating func edit(phrasePair: CorrectionPhrasePair, scope: CorrectionScope) {
        self.phrasePair = phrasePair
        self.scope = scope
        useCount = 0
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case phrasePair
        case scope
        case createdAt
        case useCount
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            id: container.decode(UUID.self, forKey: .id),
            phrasePair: container.decode(CorrectionPhrasePair.self, forKey: .phrasePair),
            scope: container.decode(CorrectionScope.self, forKey: .scope),
            createdAt: container.decode(Date.self, forKey: .createdAt),
            useCount: container.decode(Int.self, forKey: .useCount)
        )
    }
}

public enum CorrectionLessonError: Error, Equatable, Sendable {
    case negativeUseCount
    case useCountOverflow
}
