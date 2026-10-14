import Foundation
import XCTest
@testable import ArchiveProtection

/// Invented audio bytes and invented keys only.
final class SealedRecordingsTests: XCTestCase {
    private var root: URL!
    private var temporary: URL!
    private var seal: ArchiveSeal!
    private var recordings: SealedRecordings!
    private let audio = Data("RIFF....WAVEfmt invented-audio".utf8) + Data((0..<512).map { UInt8($0 % 251) })

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("sealed-recordings-\(UUID().uuidString)", isDirectory: true)
        root = base.appendingPathComponent("archive", isDirectory: true)
        temporary = base.appendingPathComponent("opened", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("recordings"), withIntermediateDirectories: true)
        seal = try ArchiveSeal(material: Data(repeating: 5, count: 32), archiveId: UUID())
        recordings = SealedRecordings(files: ArchiveFiles(root: root), temporaryRoot: temporary)
    }

    override func tearDownWithError() throws {
        DurableFile.failFlushOfFolderForTesting = nil
        try? FileManager.default.removeItem(at: root.deletingLastPathComponent())
    }

    func testARemovalThatCantBeFlushedIsReported() throws {
        let url = try plainRecording()
        let folder = url.deletingLastPathComponent().standardizedFileURL
        // The sealed copy's own flush succeeds; the flush after the
        // plaintext's removal fails.
        var flushes = 0
        DurableFile.failFlushOfFolderForTesting = { candidate in
            guard candidate.standardizedFileURL == folder else { return false }
            flushes += 1
            return flushes > 1
        }
        guard case .sealedPlaintextLeft = recordings.seal(url, seal: seal) else { return XCTFail("a failed flush must be reported (Codex P1 on #34)") }
        DurableFile.failFlushOfFolderForTesting = { $0.standardizedFileURL == folder }
        let other = try plainRecording("b.wav")
        XCTAssertEqual(recordings.seal(other, seal: nil), .notSealedPlaintextLeft)
    }

    func testASealedNameWithPlainBytesIsRefused() throws {
        let url = root.appendingPathComponent("recordings/swapped.wav.sealed")
        try Data("plain bytes under a sealed name".utf8).write(to: url)
        XCTAssertNil(recordings.data(of: url, seal: seal), "Codex P2 on #34")
    }

    private func plainRecording(_ name: String = "a.wav") throws -> URL {
        let url = root.appendingPathComponent("recordings/\(name)")
        try audio.write(to: url)
        return url
    }

    func testSealingReplacesThePlaintext() throws {
        let url = try plainRecording()
        guard case .sealed(let sealed) = recordings.seal(url, seal: seal) else { return XCTFail("not sealed") }
        XCTAssertEqual(sealed.lastPathComponent, "a.wav.sealed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        let stored = try Data(contentsOf: sealed)
        XCTAssertTrue(ArchiveSeal.isSealedFile(stored))
        XCTAssertNil(stored.range(of: Data("invented-audio".utf8)))
        XCTAssertEqual(recordings.data(of: sealed, seal: seal), audio)
        XCTAssertNil(recordings.data(of: sealed, seal: nil))
    }

    func testWithoutAKeyThePlaintextIsNotKept() throws {
        let url = try plainRecording()
        XCTAssertEqual(recordings.seal(url, seal: nil), .notSealed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.appendingPathExtension("sealed").path))
    }

    func testOlderRecordingsAreUsedAsTheyAre() async throws {
        let url = try plainRecording("old.wav")
        XCTAssertEqual(recordings.data(of: url, seal: nil), audio)
        let seen = try await recordings.withReadableCopy(of: url, seal: seal) { $0 }
        XCTAssertEqual(seen, url)
        XCTAssertEqual(try Data(contentsOf: url), audio, "untouched")
    }

    func testTheReadableCopyIsPrivateAndGoneAfterward() async throws {
        guard case .sealed(let sealed) = recordings.seal(try plainRecording(), seal: seal) else { return XCTFail("not sealed") }
        var seenCopy: URL?
        let bytes: Data = try await recordings.withReadableCopy(of: sealed, seal: seal) { copy in
            seenCopy = copy
            XCTAssertEqual(copy.lastPathComponent, "a.wav")
            let folderMode = try FileManager.default.attributesOfItem(atPath: copy.deletingLastPathComponent().path)[.posixPermissions] as? NSNumber
            XCTAssertEqual(folderMode?.intValue, 0o700)
            let fileMode = try FileManager.default.attributesOfItem(atPath: copy.path)[.posixPermissions] as? NSNumber
            XCTAssertEqual(fileMode?.intValue, 0o600)
            return try Data(contentsOf: copy)
        }
        XCTAssertEqual(bytes, audio)
        XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(seenCopy).deletingLastPathComponent().path))
    }

    func testTheCopyIsRemovedWhenTheToolFails() async throws {
        guard case .sealed(let sealed) = recordings.seal(try plainRecording(), seal: seal) else { return XCTFail("not sealed") }
        struct ToolFailed: Error {}
        var seenCopy: URL?
        do {
            _ = try await recordings.withReadableCopy(of: sealed, seal: seal) { copy -> Int in
                seenCopy = copy
                throw ToolFailed()
            }
            XCTFail("should throw")
        } catch is ToolFailed {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(seenCopy).deletingLastPathComponent().path))
    }

    func testALockedOrDamagedRecordingIsRefused() async throws {
        guard case .sealed(let sealed) = recordings.seal(try plainRecording(), seal: seal) else { return XCTFail("not sealed") }
        do {
            _ = try await recordings.withReadableCopy(of: sealed, seal: nil) { $0 }
            XCTFail("should refuse")
        } catch let failure as SealedRecordings.Failure {
            XCTAssertEqual(failure, .notReadable)
        }
        var bytes = try Data(contentsOf: sealed)
        bytes[bytes.count - 5] ^= 0x01
        try bytes.write(to: sealed)
        XCTAssertNil(recordings.data(of: sealed, seal: seal))
    }

    func testTheSweepRemovesOnlyLeftCopies() throws {
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        let left = temporary.appendingPathComponent(SealedRecordings.openedCopyPrefix + "left", isDirectory: true)
        let other = temporary.appendingPathComponent("someone-else", isDirectory: true)
        try FileManager.default.createDirectory(at: left, withIntermediateDirectories: false)
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: false)
        XCTAssertEqual(recordings.sweepOpenedCopies(), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: left.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: other.path))
    }
}
