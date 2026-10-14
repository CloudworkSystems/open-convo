import CorrectionMemory
import DeskHost
import Foundation
import XCTest
@testable import ArchiveProtection

/// Invented words and invented keys only; nothing here touches the Keychain.
final class ArchiveSealTests: XCTestCase {
    private let id = UUID()
    private func key(_ byte: UInt8 = 7) -> Data { Data(repeating: byte, count: 32) }

    func testFileRoundTripsAndHidesTheWords() throws {
        let seal = try ArchiveSeal(material: key(), archiveId: id)
        let words = Data("invented dictation about a blue kettle".utf8)
        let stored = try seal.sealFile(words, purpose: "transcripts/a.md")
        XCTAssertTrue(ArchiveSeal.isSealedFile(stored))
        XCTAssertNil(String(decoding: stored, as: UTF8.self).range(of: "kettle"))
        XCTAssertEqual(try seal.openFile(stored, purpose: "transcripts/a.md"), words)
    }

    func testEveryWriteUsesAFreshNonce() throws {
        let seal = try ArchiveSeal(material: key(), archiveId: id)
        let words = Data("same words".utf8)
        XCTAssertNotEqual(try seal.sealFile(words, purpose: "p"), try seal.sealFile(words, purpose: "p"))
    }

    func testRefusesAnotherPlaceAnotherArchiveAnotherKey() throws {
        let seal = try ArchiveSeal(material: key(), archiveId: id)
        let stored = try seal.sealFile(Data("w".utf8), purpose: "transcripts/a.md")
        XCTAssertThrowsError(try seal.openFile(stored, purpose: "transcripts/b.md"))
        XCTAssertThrowsError(try ArchiveSeal(material: key(), archiveId: UUID()).openFile(stored, purpose: "transcripts/a.md"))
        XCTAssertThrowsError(try ArchiveSeal(material: key(8), archiveId: id).openFile(stored, purpose: "transcripts/a.md"))
    }

    func testRefusesDamage() throws {
        let seal = try ArchiveSeal(material: key(), archiveId: id)
        let stored = try seal.sealFile(Data("invented words".utf8), purpose: "p")
        var flipped = stored
        let index = flipped.count - 6
        flipped[index] = flipped[index] == UInt8(ascii: "A") ? UInt8(ascii: "B") : UInt8(ascii: "A")
        XCTAssertThrowsError(try seal.openFile(flipped, purpose: "p"))
        XCTAssertThrowsError(try seal.openFile(stored.dropLast(5), purpose: "p"))
        XCTAssertThrowsError(try seal.openFile(stored + Data("more\n".utf8), purpose: "p"))
        XCTAssertThrowsError(try seal.openFile(Data(ArchiveSeal.fileHeader.utf8), purpose: "p"))
        XCTAssertThrowsError(try seal.openFile(Data("plain words\n".utf8), purpose: "p"))
    }

    func testLinesRoundTripAndRefuseAnotherFile() throws {
        let seal = try ArchiveSeal(material: key(), archiveId: id)
        let line = try seal.sealLine(Data("{\"text\":\"invented\"}".utf8), purpose: "history.jsonl")
        XCTAssertTrue(ArchiveSeal.isSealedLine(line))
        XCTAssertFalse(line.contains("\n"))
        XCTAssertFalse(line.contains("invented"))
        XCTAssertEqual(try seal.openLine(line, purpose: "history.jsonl"), Data("{\"text\":\"invented\"}".utf8))
        XCTAssertThrowsError(try seal.openLine(line, purpose: "other.jsonl"))
        XCTAssertFalse(ArchiveSeal.isSealedLine("{\"text\":\"old plaintext\"}"))
    }

    func testOnlyA32ByteKey() {
        for length in [0, 16, 24, 31, 33, 64] {
            XCTAssertThrowsError(try ArchiveSeal(material: Data(count: length), archiveId: id)) { error in
                XCTAssertEqual(error as? ArchiveSeal.Failure, .wrongKeyLength)
            }
        }
    }
}

final class ArchiveKeyCustodyTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("archive-custody-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent(".tca-dictate-invented", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root.deletingLastPathComponent())
    }

    private var marker: URL { root.appendingPathComponent(ArchiveKeyCustody.markerName) }

    func testFirstOpenMakesKeyAndMarkerThenReopensTheSameKey() throws {
        let keys = InventedInMemoryKeyProvider()
        guard case .ready(let first) = ArchiveKeyCustody.open(root: root, keys: keys) else { return XCTFail("not ready") }
        XCTAssertEqual(keys.heldKeyCount, 1)
        XCTAssertEqual(ArchiveKeyCustody.readMarker(marker), .present(first.archiveId))
        let permissions = try FileManager.default.attributesOfItem(atPath: root.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o700)
        let markerPermissions = try FileManager.default.attributesOfItem(atPath: marker.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(markerPermissions?.intValue, 0o600)

        let sealed = try first.sealFile(Data("invented".utf8), purpose: "p")
        guard case .ready(let again) = ArchiveKeyCustody.open(root: root, keys: keys) else { return XCTFail("not ready") }
        XCTAssertEqual(again.archiveId, first.archiveId)
        XCTAssertEqual(try again.openFile(sealed, purpose: "p"), Data("invented".utf8))
        XCTAssertEqual(keys.heldKeyCount, 1)
    }

    func testMissingKeyIsReportedAndNothingIsMadeOverIt() throws {
        let keys = InventedInMemoryKeyProvider()
        guard case .ready(let first) = ArchiveKeyCustody.open(root: root, keys: keys) else { return XCTFail("not ready") }
        let markerBytes = try Data(contentsOf: marker)
        keys.forgetKey(for: first.archiveId)

        guard case .keyMissing(let archiveId) = ArchiveKeyCustody.open(root: root, keys: keys) else { return XCTFail("not missing") }
        XCTAssertEqual(archiveId, first.archiveId)
        XCTAssertEqual(keys.heldKeyCount, 0)
        XCTAssertEqual(try Data(contentsOf: marker), markerBytes)
    }

    func testRestoredKeyOpensAgain() throws {
        let keys = InventedInMemoryKeyProvider()
        guard case .ready(let first) = ArchiveKeyCustody.open(root: root, keys: keys),
              let material = try keys.existingKey(for: first.archiveId)?.material else { return XCTFail("not ready") }
        keys.forgetKey(for: first.archiveId)
        _ = try keys.importKey(material, for: first.archiveId)
        XCTAssertEqual(ArchiveKeyCustody.open(root: root, keys: keys).seal?.archiveId, first.archiveId)
    }

    func testUnreadableMarkersAreNeverReplaced() throws {
        let cases: [(String, (URL) throws -> Void)] = [
            ("garbage", { try Data("not json".utf8).write(to: $0) }),
            ("wrong format", { try Data("{\"archiveId\":\"\(UUID().uuidString)\",\"format\":2}".utf8).write(to: $0) }),
            ("bad id", { try Data("{\"archiveId\":\"nope\",\"format\":1}".utf8).write(to: $0) }),
            ("folder", { try FileManager.default.createDirectory(at: $0, withIntermediateDirectories: false) }),
            ("link", { try FileManager.default.createSymbolicLink(atPath: $0.path, withDestinationPath: "/dev/null") }),
            ("huge", { try Data(repeating: 32, count: 5000).write(to: $0) }),
        ]
        for (name, make) in cases {
            try? FileManager.default.removeItem(at: root)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try make(marker)
            let keys = InventedInMemoryKeyProvider()
            guard case .unavailable(let problem) = ArchiveKeyCustody.open(root: root, keys: keys) else {
                XCTFail("\(name): opened"); continue
            }
            XCTAssertEqual(problem, .markerUnreadable, name)
            XCTAssertEqual(keys.heldKeyCount, 0, name)
        }
    }

    func testKeyStoreRefusalMakesNoMarker() throws {
        guard case .unavailable(let problem) = ArchiveKeyCustody.open(root: root, keys: RefusingKeys()) else { return XCTFail("opened") }
        XCTAssertEqual(problem, .keyUnavailable)
        XCTAssertEqual(ArchiveKeyCustody.readMarker(marker), .absent)
    }

    func testAFileWhereTheFolderGoesIsRefused() throws {
        try FileManager.default.createDirectory(at: root.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: root)
        guard case .unavailable(let problem) = ArchiveKeyCustody.open(root: root, keys: InventedInMemoryKeyProvider()) else { return XCTFail("opened") }
        XCTAssertEqual(problem, .folderUnusable)
    }

    func testPublishNeverReplacesAMarker() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let winner = UUID()
        XCTAssertEqual(ArchiveKeyCustody.publishMarker(archiveId: winner, at: marker), .published)
        XCTAssertEqual(ArchiveKeyCustody.publishMarker(archiveId: UUID(), at: marker), .alreadyThere)
        XCTAssertEqual(ArchiveKeyCustody.readMarker(marker), .present(winner))
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: root.path).filter { $0.hasSuffix(".tmp") }
        XCTAssertEqual(leftovers, [])
    }
}

final class ArchiveFilesTests: XCTestCase {
    private var root: URL!
    private var seal: ArchiveSeal!
    private var files: ArchiveFiles!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("archive-files-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("transcripts"), withIntermediateDirectories: true)
        seal = try ArchiveSeal(material: Data(repeating: 3, count: 32), archiveId: UUID())
        files = ArchiveFiles(root: root)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testPurposeIsThePathInsideTheArchive() {
        XCTAssertEqual(files.purpose(of: root.appendingPathComponent("transcripts/a.md")), "transcripts/a.md")
        XCTAssertEqual(files.purpose(of: root.appendingPathComponent("history.jsonl")), "history.jsonl")
        XCTAssertEqual(files.purpose(of: URL(fileURLWithPath: "/elsewhere/a.md")), "external:/elsewhere/a.md")
    }

    func testSealedWriteReadsBackAndIsOwnerOnly() throws {
        let url = root.appendingPathComponent("transcripts/a.md")
        try files.writeSealed(Data("invented transcript".utf8), to: url, seal: seal)
        let stored = try Data(contentsOf: url)
        XCTAssertTrue(ArchiveSeal.isSealedFile(stored))
        XCTAssertNil(String(decoding: stored, as: UTF8.self).range(of: "invented"))
        XCTAssertEqual(files.read(url, seal: seal), .opened(Data("invented transcript".utf8)))
        XCTAssertEqual(files.read(url, seal: nil), .locked)
        let permissions = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("transcripts").path)
        XCTAssertEqual(leftovers, ["a.md"])
    }

    func testOldPlaintextIsReadAsItIsAndLeftUntouched() throws {
        let url = root.appendingPathComponent("transcripts/old.md")
        try Data("old invented words".utf8).write(to: url)
        let before = try FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date
        XCTAssertEqual(files.read(url, seal: seal), .plaintext(Data("old invented words".utf8)))
        XCTAssertEqual(files.read(url, seal: nil), .plaintext(Data("old invented words".utf8)))
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date, before)
        XCTAssertEqual(files.read(root.appendingPathComponent("transcripts/none.md"), seal: seal), .missing)
    }

    func testAMovedSealedFileDoesNotOpen() throws {
        let a = root.appendingPathComponent("transcripts/a.md")
        let b = root.appendingPathComponent("transcripts/b.md")
        try files.writeSealed(Data("invented".utf8), to: a, seal: seal)
        try FileManager.default.copyItem(at: a, to: b)
        XCTAssertEqual(files.read(b, seal: seal), .unreadable)
    }

    func testHistoryLinesMixOldAndSealed() throws {
        let url = root.appendingPathComponent("history.jsonl")
        try Data("{\"old\":1}\n".utf8).write(to: url)
        try files.appendSealedLine(Data("{\"new\":2}".utf8), to: url, seal: seal)
        let lines = String(decoding: try Data(contentsOf: url), as: UTF8.self).split(separator: "\n")
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(lines[0], "{\"old\":1}")
        XCTAssertEqual(files.readLine(lines[0], in: url, seal: seal), .plaintext(Data("{\"old\":1}".utf8)))
        XCTAssertEqual(files.readLine(lines[1], in: url, seal: seal), .opened(Data("{\"new\":2}".utf8)))
        XCTAssertEqual(files.readLine(lines[1], in: url, seal: nil), .locked)
        XCTAssertEqual(files.readLine(lines[1], in: root.appendingPathComponent("other.jsonl"), seal: seal), .unreadable)
    }

    func testATornLastLineGetsItsOwnLine() throws {
        let url = root.appendingPathComponent("history.jsonl")
        try Data("{\"torn\":".utf8).write(to: url)
        try files.appendSealedLine(Data("{\"new\":2}".utf8), to: url, seal: seal)
        let lines = String(decoding: try Data(contentsOf: url), as: UTF8.self).split(separator: "\n")
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(files.readLine(lines[1], in: url, seal: seal), .opened(Data("{\"new\":2}".utf8)))
    }

    func testANewHistoryFileIsOwnerOnly() throws {
        let url = root.appendingPathComponent("history.jsonl")
        try files.appendSealedLine(Data("{}".utf8), to: url, seal: seal)
        let permissions = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
    }
}

final class SealedLessonsFileTests: XCTestCase {
    private var directory: URL!
    private var files: ArchiveFiles!
    private var seal: ArchiveSeal!

    override func setUpWithError() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("archive-lessons-\(UUID().uuidString)", isDirectory: true)
        directory = root.appendingPathComponent("corrections", isDirectory: true)
        files = ArchiveFiles(root: root)
        seal = try ArchiveSeal(material: Data(repeating: 9, count: 32), archiveId: UUID())
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory.deletingLastPathComponent())
    }

    private var lessonsURL: URL { directory.appendingPathComponent(LocalDataBoundary.lessonsFileName) }

    private func protection(_ seal: ArchiveSeal) -> SealedLessonsFile {
        SealedLessonsFile(seal: seal, files: files, lessonsFile: lessonsURL)
    }

    func testSavedFixesAreSealedAndReopen() throws {
        let store = try CorrectionLessonStore(directory: directory, protection: protection(seal))
        try store.remember(try CorrectionPhrasePair(sourcePhrase: "teh kettel", replacementPhrase: "the kettle"), in: try CorrectionScope.anyApplication(localeIdentifier: "en-US"))
        let stored = try Data(contentsOf: lessonsURL)
        XCTAssertTrue(ArchiveSeal.isSealedFile(stored))
        XCTAssertNil(String(decoding: stored, as: UTF8.self).range(of: "kettle"))

        let reopened = try CorrectionLessonStore(directory: directory, protection: protection(seal))
        XCTAssertEqual(reopened.lessons.map(\.phrasePair.replacementPhrase), ["the kettle"])
    }

    func testOldPlainFixesAreReadThenSealedOnTheNextSave() throws {
        let plain = try CorrectionLessonStore(directory: directory)
        try plain.remember(try CorrectionPhrasePair(sourcePhrase: "invented one", replacementPhrase: "Invented One"), in: try CorrectionScope.anyApplication(localeIdentifier: "en-US"))
        XCTAssertFalse(ArchiveSeal.isSealedFile(try Data(contentsOf: lessonsURL)))

        let store = try CorrectionLessonStore(directory: directory, protection: protection(seal))
        XCTAssertEqual(store.lessons.count, 1)
        try store.remember(try CorrectionPhrasePair(sourcePhrase: "invented two", replacementPhrase: "Invented Two"), in: try CorrectionScope.anyApplication(localeIdentifier: "en-US"))
        XCTAssertTrue(ArchiveSeal.isSealedFile(try Data(contentsOf: lessonsURL)))
        XCTAssertEqual(try CorrectionLessonStore(directory: directory, protection: protection(seal)).lessons.count, 2)
    }

    func testSealedFixesUnderAnotherKeyRefuseToOpen() throws {
        let store = try CorrectionLessonStore(directory: directory, protection: protection(seal))
        try store.remember(try CorrectionPhrasePair(sourcePhrase: "invented", replacementPhrase: "Invented"), in: try CorrectionScope.anyApplication(localeIdentifier: "en-US"))
        let other = try ArchiveSeal(material: Data(repeating: 1, count: 32), archiveId: seal.archiveId)
        XCTAssertThrowsError(try CorrectionLessonStore(directory: directory, protection: protection(other)))
        XCTAssertThrowsError(try CorrectionLessonStore(directory: directory))
    }
}

private struct RefusingKeys: KeyProvider {
    func existingKey(for storeId: UUID) throws -> StoreKey? { throw KeyProviderError.unavailable }
    func createKey(for storeId: UUID) throws -> StoreKey { throw KeyProviderError.unavailable }
}
