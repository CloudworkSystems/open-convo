import DeskHost
import Foundation
import XCTest
@testable import ArchiveProtection

/// Invented keys only; nothing here touches the Keychain.
private extension ArchiveKeyCustody.MarkerRead {
    var id: UUID? {
        if case .present(let id) = self { return id }
        return nil
    }
}

final class ArchiveRecoveryTests: XCTestCase {
    private var root: URL!
    private var keys: InventedInMemoryKeyProvider!
    private var recovery: ArchiveRecovery!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("archive-recovery-\(UUID().uuidString)", isDirectory: true)
        keys = InventedInMemoryKeyProvider()
        recovery = ArchiveRecovery(root: root, keys: keys)
    }

    override func tearDownWithError() throws {
        DurableFile.failFolderFlushForTesting = nil
        try? FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o700)], ofItemAtPath: recovery.folder.path)
        try? FileManager.default.removeItem(at: root)
    }

    private func sealed() -> [String] { copies().filter { $0.hasSuffix(".sealed") } }

    private func openArchive() throws -> ArchiveSeal {
        try XCTUnwrap(ArchiveKeyCustody.open(root: root, keys: keys).seal)
    }

    private func copies() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: recovery.folder.path)) ?? []).sorted()
    }

    func testTheRecoveryKeyBringsTheArchiveKeyBack() throws {
        let seal = try openArchive()
        let words = try seal.sealFile(Data("invented dictation".utf8), purpose: "transcripts/a.md")
        let key = try RecoveryKey.generate()
        try recovery.seal(under: key)
        XCTAssertEqual(copies(), ["\(key.fingerprint).sealed"])

        keys.forgetKey(for: seal.archiveId)
        XCTAssertTrue(recovery.keyIsMissing)
        guard case .keyMissing = ArchiveKeyCustody.open(root: root, keys: keys) else { return XCTFail("not missing") }

        XCTAssertEqual(recovery.restore(typed: key.displayText.lowercased()), .done(.restored))
        XCTAssertFalse(recovery.keyIsMissing)
        let back = try openArchive()
        XCTAssertEqual(try back.openFile(words, purpose: "transcripts/a.md"), Data("invented dictation".utf8))
    }

    func testAnotherKeyIsNotCoveredAndAHeldKeyIsLeftAlone() throws {
        let seal = try openArchive()
        try recovery.seal(under: try RecoveryKey.generate())
        XCTAssertEqual(recovery.restore(with: try RecoveryKey.generate()), .alreadyHeld,
                       "a held key is reported as held even for a key with no copy (Codex P2)")
        let key = try RecoveryKey.generate()
        try recovery.seal(under: key)
        XCTAssertEqual(recovery.restore(with: key), .alreadyHeld)
        XCTAssertEqual(keys.heldKeyCount, 1)
        keys.forgetKey(for: seal.archiveId)
        XCTAssertEqual(recovery.restore(with: try RecoveryKey.generate()), .notCovered)
        XCTAssertEqual(keys.heldKeyCount, 0)
    }

    func testMalformedTypedKey() {
        XCTAssertEqual(recovery.restore(typed: "not a key"), .malformed)
    }

    func testAChangedCopyFailsAndImportsNothing() throws {
        let seal = try openArchive()
        let key = try RecoveryKey.generate()
        try recovery.seal(under: key)
        let url = recovery.folder.appendingPathComponent("\(key.fingerprint).sealed")
        var bytes = try Data(contentsOf: url)
        bytes[bytes.count - 3] ^= 0x01
        try bytes.write(to: url)
        keys.forgetKey(for: seal.archiveId)
        XCTAssertEqual(recovery.restore(with: key), .failed)
        XCTAssertEqual(keys.heldKeyCount, 0)
    }

    func testSealingWithoutAnArchiveKeyChangesNothing() throws {
        try recovery.seal(under: try RecoveryKey.generate())
        XCTAssertFalse(FileManager.default.fileExists(atPath: recovery.folder.path), "no marker yet: nothing to cover")

        let seal = try openArchive()
        let kept = try RecoveryKey.generate()
        try recovery.seal(under: kept)
        keys.forgetKey(for: seal.archiveId)
        let newer = try RecoveryKey.generate()
        try recovery.seal(under: newer)
        XCTAssertFalse(recovery.retireAllBut(newer))
        XCTAssertEqual(copies(), ["\(kept.fingerprint).sealed"], "the copy that can still restore the key stays")
        XCTAssertEqual(recovery.restore(with: kept), .restored)
    }

    func testRetireKeepsOnlyTheNewCopyAndOnlyOnceItIsThere() throws {
        _ = try openArchive()
        let old = try RecoveryKey.generate()
        let new = try RecoveryKey.generate()
        try recovery.seal(under: old)
        XCTAssertFalse(recovery.retireAllBut(new))
        XCTAssertEqual(sealed(), ["\(old.fingerprint).sealed"], "the new copy isn't there, so nothing is retired")
        try recovery.seal(under: new)
        XCTAssertTrue(recovery.retireAllBut(new))
        XCTAssertEqual(sealed(), ["\(new.fingerprint).sealed"])
        keys.forgetKey(for: try XCTUnwrap(ArchiveKeyCustody.readMarker(root.appendingPathComponent(ArchiveKeyCustody.markerName)).id))
        XCTAssertEqual(recovery.restore(with: old), .notCovered, "a retired key no longer restores")
        XCTAssertEqual(recovery.restore(with: new), .restored)
    }

    func testDiscardTakesBackOneCopy() throws {
        _ = try openArchive()
        let old = try RecoveryKey.generate()
        let unseen = try RecoveryKey.generate()
        try recovery.seal(under: old)
        try recovery.seal(under: unseen)
        recovery.discard(unseen)
        XCTAssertEqual(sealed(), ["\(old.fingerprint).sealed"])
    }

    func testNeedsARecoveryKeyOnlyWhileAHeldKeyIsUncovered() throws {
        XCTAssertFalse(recovery.needsRecoveryKey, "no archive key yet")
        let seal = try openArchive()
        XCTAssertTrue(recovery.needsRecoveryKey)
        let key = try RecoveryKey.generate()
        try recovery.seal(under: key)
        XCTAssertTrue(recovery.needsRecoveryKey, "a copy that was never paired doesn't count (Codex P1)")
        XCTAssertTrue(recovery.retireAllBut(key))
        XCTAssertFalse(recovery.needsRecoveryKey)
        keys.forgetKey(for: seal.archiveId)
        XCTAssertFalse(recovery.needsRecoveryKey, "a missing key is restored, not re-covered")
    }

    func testASealWhoseFlushFailsLeavesNoCopy() throws {
        _ = try openArchive()
        let key = try RecoveryKey.generate()
        DurableFile.failFolderFlushForTesting = { $0.lastPathComponent.hasSuffix(".sealed") }
        XCTAssertThrowsError(try recovery.seal(under: key))
        DurableFile.failFolderFlushForTesting = nil
        XCTAssertEqual(sealed(), [], "the copy that landed before the failed flush is taken back (Codex P1)")
        XCTAssertTrue(recovery.needsRecoveryKey)
    }

    func testAFailedRetireIsReportedAndLeavesTheKeyUnpaired() throws {
        _ = try openArchive()
        let old = try RecoveryKey.generate()
        try recovery.seal(under: old)
        XCTAssertTrue(recovery.retireAllBut(old))
        let new = try RecoveryKey.generate()
        try recovery.seal(under: new)
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o500)], ofItemAtPath: recovery.folder.path)
        XCTAssertFalse(recovery.retireAllBut(new), "an earlier copy that can't be removed is reported (Codex P2)")
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o700)], ofItemAtPath: recovery.folder.path)
        XCTAssertEqual(sealed().count, 2)
        XCTAssertTrue(recovery.retireAllBut(new), "the next try finishes it")
        XCTAssertEqual(sealed(), ["\(new.fingerprint).sealed"])
        XCTAssertFalse(recovery.needsRecoveryKey)
    }

    func testCopiesAreOwnerOnlyAndHoldNoPlainKey() throws {
        let seal = try openArchive()
        let key = try RecoveryKey.generate()
        try recovery.seal(under: key)
        let folderMode = try FileManager.default.attributesOfItem(atPath: recovery.folder.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(folderMode?.intValue, 0o700)
        let url = recovery.folder.appendingPathComponent("\(key.fingerprint).sealed")
        let fileMode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(fileMode?.intValue, 0o600)
        let material = try XCTUnwrap(keys.existingKey(for: seal.archiveId)).material
        XCTAssertNil(try Data(contentsOf: url).range(of: material))
        XCTAssertFalse(String(decoding: try Data(contentsOf: url), as: UTF8.self).contains(key.displayText))
    }
}
