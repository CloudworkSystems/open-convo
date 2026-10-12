import Foundation
@testable import CorrectionMemory
import Testing

/// Teaching a fix by typing it, moving the old word list in, and previewing
/// saved fixes without writing anything. Made-up phrases only.
@Suite("Saved fix teaching")
struct SavedFixTeachingTests {
    private func everyApp(_ locale: String = "en-US") throws -> CorrectionScope {
        try CorrectionScope.anyApplication(localeIdentifier: locale)
    }

    private func app(_ identifier: String, _ locale: String = "en-US") throws -> CorrectionScope {
        try CorrectionScope(externalTargetApplicationIdentifier: identifier, localeIdentifier: locale)
    }

    private func makeDirectory() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("SavedFixTeachingTests-\(UUID().uuidString)", isDirectory: true)
    }

    // MARK: Teaching (B4)

    @Test("Re-teaching a word that differs only in capitals is already saved and keeps its use count")
    func reteachingWithDifferentCapitalsIsAlreadySaved() throws {
        let directory = makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CorrectionLessonStore(directory: directory)

        #expect(try store.teach(wrong: "blue wren", right: "Bluewren", in: everyApp()) == .saved)
        _ = try store.applySavedCorrection(to: "the blue wren sang", in: app("com.apple.Notes"))
        #expect(store.lessons.first?.useCount == 1)
        let fileBefore = try Data(contentsOf: store.storageURL)

        #expect(try store.teach(wrong: "Blue Wren", right: "Bluewren", in: everyApp()) == .alreadySaved)
        #expect(try store.teach(wrong: "BLUE WREN", right: "Bluewren", in: everyApp()) == .alreadySaved)
        #expect(try store.teach(wrong: "blue wren", right: "Bluewren", in: everyApp()) == .alreadySaved)

        #expect(store.lessons.count == 1)
        #expect(store.lessons.first?.useCount == 1)
        #expect(store.lessons.first?.phrasePair.sourcePhrase == "blue wren")
        #expect(try Data(contentsOf: store.storageURL) == fileBefore)
        #expect(try CorrectionLessonStore(directory: directory).lessons.first?.useCount == 1)
    }

    @Test("Re-teaching a word with a different replacement updates it and restarts its use count")
    func reteachingWithANewReplacementUpdates() throws {
        let directory = makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CorrectionLessonStore(directory: directory)

        #expect(try store.teach(wrong: "blue wren", right: "Bluewren", in: everyApp()) == .saved)
        _ = try store.applySavedCorrection(to: "a blue wren", in: app("com.apple.Notes"))
        #expect(try store.teach(wrong: "Blue Wren", right: "BlueWren", in: everyApp()) == .updated)

        #expect(store.lessons.count == 1)
        #expect(store.lessons.first?.phrasePair.replacementPhrase == "BlueWren")
        #expect(store.lessons.first?.useCount == 0)
    }

    // MARK: Moving the old word list in (B2)

    @Test("Legacy import saves valid rules, counts invalid ones as handled, and keeps a newer lesson")
    func legacyImportCountsEveryRule() throws {
        let directory = makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CorrectionLessonStore(directory: directory)
        #expect(try store.teach(wrong: "sky blu", right: "Skyblue", in: everyApp()) == .saved)

        let rules = [
            "Sky Blu": "Sky Blue",   // same word as a newer lesson: the newer one is kept
            "mint leef": "mint leaf",
            "   ": "anything",        // empty wrong phrase: can never be saved
            "same word": "same word", // no change: can never be saved
            "tall trea": " ",         // empty replacement: can never be saved
        ]
        let first = store.importLegacyRules(rules, in: try everyApp())
        #expect(first == LegacyImportReport(rules: 5, saved: 1, alreadySaved: 1, invalid: 3, failed: 0))
        #expect(first.isComplete)

        let byWrong = Dictionary(uniqueKeysWithValues: store.lessons.map {
            ($0.phrasePair.sourcePhrase, $0.phrasePair.replacementPhrase)
        })
        #expect(byWrong == ["sky blu": "Skyblue", "mint leef": "mint leaf"])

        let again = store.importLegacyRules(rules, in: try everyApp())
        #expect(again == LegacyImportReport(rules: 5, saved: 0, alreadySaved: 2, invalid: 3, failed: 0))
        #expect(store.lessons.count == 2)
    }

    @Test("A rule that fails to save is reported, and a later import saves it")
    func legacyImportReportsFailuresSoTheyAreRetried() throws {
        let directory = makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileManager = OwnerOnlyWriteLimitFileManager(allowedOwnerOnlyWrites: 1)
        let store = try CorrectionLessonStore(directory: directory, fileManager: fileManager)
        let rules = ["mint leef": "mint leaf", "red focks": "red fox"]

        let first = store.importLegacyRules(rules, in: try everyApp())
        #expect(first == LegacyImportReport(rules: 2, saved: 1, alreadySaved: 0, invalid: 0, failed: 1))
        #expect(!first.isComplete)
        #expect(store.lessons.map(\.phrasePair.sourcePhrase) == ["mint leef"])

        fileManager.allowedOwnerOnlyWrites = .max
        let retry = store.importLegacyRules(rules, in: try everyApp())
        #expect(retry == LegacyImportReport(rules: 2, saved: 1, alreadySaved: 1, invalid: 0, failed: 0))
        #expect(retry.isComplete)
        #expect(
            try CorrectionLessonStore(directory: directory).lessons.map(\.phrasePair.sourcePhrase).sorted()
                == ["mint leef", "red focks"]
        )
    }

    // MARK: Previewing without writing (B1, B5)

    @Test("A preview applies saved fixes without counting a use or writing the file")
    func previewNeverWrites() throws {
        let directory = makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CorrectionLessonStore(directory: directory)
        #expect(try store.teach(wrong: "blue wren", right: "Bluewren", in: everyApp()) == .saved)
        let fileBefore = try Data(contentsOf: store.storageURL)

        #expect(try store.preview("a Blue wren here", in: app("com.apple.TextEdit")) == "a Bluewren here")
        #expect(try store.preview("nothing to fix", in: app("com.apple.TextEdit")) == "nothing to fix")

        #expect(store.lessons.first?.useCount == 0)
        #expect(try Data(contentsOf: store.storageURL) == fileBefore)
    }

    @Test("A preview uses the language it is given, not any other")
    func previewFollowsTheGivenLanguage() throws {
        let directory = makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CorrectionLessonStore(directory: directory)
        #expect(try store.teach(wrong: "blue wren", right: "Bluewren", in: everyApp("en-US")) == .saved)

        #expect(try store.preview("a blue wren", in: app("com.apple.TextEdit", "fr-FR")) == "a blue wren")
        #expect(try store.preview("a blue wren", in: app("com.apple.TextEdit", "en_US")) == "a Bluewren")
    }

    @Test("A preview leaves text alone when two fixes would collide")
    func previewRefusesToGuess() throws {
        let directory = makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CorrectionLessonStore(directory: directory)
        #expect(try store.teach(wrong: "new york", right: "New York", in: everyApp()) == .saved)
        #expect(try store.teach(wrong: "york city", right: "York-City", in: everyApp()) == .saved)

        #expect(try store.preview("in new york city", in: app("com.apple.Notes")) == "in new york city")
    }
}

private struct SimulatedWriteFailure: Error {}

/// Lets the first `allowedOwnerOnlyWrites` lesson-file writes through, then
/// fails the owner-only permission step of every later write, which makes the
/// store's save throw without changing the file on disk.
private final class OwnerOnlyWriteLimitFileManager: FileManager {
    var allowedOwnerOnlyWrites: Int

    init(allowedOwnerOnlyWrites: Int) {
        self.allowedOwnerOnlyWrites = allowedOwnerOnlyWrites
        super.init()
    }

    override func setAttributes(_ attributes: [FileAttributeKey: Any], ofItemAtPath path: String) throws {
        if (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, path.hasSuffix(".tmp") {
            guard allowedOwnerOnlyWrites > 0 else { throw SimulatedWriteFailure() }
            allowedOwnerOnlyWrites -= 1
        }
        try super.setAttributes(attributes, ofItemAtPath: path)
    }
}
