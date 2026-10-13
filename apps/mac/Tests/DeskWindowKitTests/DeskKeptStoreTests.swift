import DeskHost
@testable import DeskWindowKit
import Foundation
import TrueConvoIdentity
import XCTest

/// Step 2, PR 2b: the app's Desk keeps one store, reopened on every run,
/// under a key that outlives the process. A shared in-memory provider
/// stands in for the Keychain here, so the tests never touch the owner's.
@MainActor
final class DeskKeptStoreTests: XCTestCase {
    private var folder: DeskTestFolder!
    private var sessions: [DeskSession] = []
    /// Outlives every session, as the Keychain outlives a run.
    private var keychain: InventedInMemoryKeyProvider!

    override func setUp() async throws {
        folder = try DeskTestFolder()
        keychain = InventedInMemoryKeyProvider()
    }

    override func tearDown() async throws {
        for session in sessions { await session.close() }
        sessions.removeAll()
        folder.clean()
    }

    /// A new app run: a new session over the same folder and the same keys.
    private func newRun(_ storage: DeskSession.Storage? = nil, logs: DeskLogCollector = DeskLogCollector()) throws -> DeskSession {
        let made = DeskSession(paths: folder.paths, bundle: try anyDeskBundle(folder),
                               info: HostInfo(appVersion: "0.0.0-test", hostBuild: "unit-desk-none"),
                               storage: storage ?? .kept(keychain), log: logs.log)
        sessions.append(made)
        return made
    }

    func testKeptStoreReopensOnTheNextRun() async throws {
        let firstLogs = DeskLogCollector()
        let first = try newRun(logs: firstLogs)
        await first.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(first.state, .open)
        let folderURL = try XCTUnwrap(first.runFolder)
        XCTAssertEqual(folderURL.lastPathComponent, DeskPaths.keptStoreFolderName)
        let workspaceId = try XCTUnwrap(first.store?.workspaceId)
        XCTAssertTrue(firstLogs.all.contains("desk.kept-store.opened new"))
        await first.close()

        let laterLogs = DeskLogCollector()
        let later = try newRun(logs: laterLogs)
        XCTAssertFalse(later.earlierRunsExisted, "the kept store is not an earlier run")
        XCTAssertNil(later.standingNote)
        await later.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(later.state, .open)
        XCTAssertEqual(later.runFolder, folderURL, "the same folder")
        XCTAssertEqual(later.store?.workspaceId, workspaceId, "the same store, opened again")
        XCTAssertEqual(later.store?.status, .ready)
        XCTAssertTrue(laterLogs.all.contains("desk.kept-store.opened existing"))
        XCTAssertEqual(folder.paths.existingRunFolderNames(), [], "no run folder is made")
        XCTAssertEqual(keychain.heldKeyCount, 1, "one key, made once")
    }

    func testMissingKeychainKeyRefusesAndReplacesNothing() async throws {
        let first = try newRun()
        await first.unlock(verifier: StubUnlockVerifier(.verified))
        let folderURL = try XCTUnwrap(first.runFolder)
        let workspaceId = try XCTUnwrap(first.store?.workspaceId)
        await first.close()
        let before = try snapshot(folderURL)
        keychain.forgetKey(for: workspaceId)

        let logs = DeskLogCollector()
        let later = try newRun(logs: logs)
        await later.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(later.state, .unavailable(DeskSession.Message.keychainKeyMissing))
        XCTAssertNil(later.store)
        XCTAssertEqual(keychain.heldKeyCount, 0, "no new key was made")
        XCTAssertEqual(try snapshot(folderURL), before, "nothing was replaced")
        XCTAssertTrue(logs.all.contains("desk.open.failed reason=key-missing"))
    }

    func testUnreachableKeychainOnFirstOpenIsReportedAsSuch() async throws {
        let logs = DeskLogCollector()
        let desk = try newRun(.kept(UnreachableKeychain()), logs: logs)
        await desk.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(desk.state, .unavailable(DeskSession.Message.couldNotOpen))
        XCTAssertNil(desk.store)
        XCTAssertTrue(logs.all.contains("desk.open.failed reason=key-unavailable"), "\(logs.all)")
        let store = folder.base.appendingPathComponent(DeskPaths.keptStoreFolderName)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: store.path), ["proof.lock"],
                       "no state or marker was written; only the writer lock, which is taken before the key")
    }

    func testEarlierRunFoldersAreLeftAndNamedOnce() async throws {
        let older = try newRun(.perRunInMemory)
        await older.unlock(verifier: StubUnlockVerifier(.verified))
        let oldRun = try XCTUnwrap(older.runFolder)
        await older.close()
        let before = try snapshot(oldRun)

        let kept = try newRun()
        XCTAssertTrue(kept.earlierRunsExisted)
        XCTAssertEqual(kept.standingNote, DeskSession.Message.earlierVersionsNote)
        await kept.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(kept.state, .open)
        XCTAssertNotEqual(kept.runFolder, oldRun)
        await kept.close()
        XCTAssertEqual(try snapshot(oldRun), before, "the earlier run's folder is byte-identical")
        XCTAssertEqual(folder.paths.existingRunFolderNames(), [oldRun.lastPathComponent])
    }

    func testKeptStoreFolderIsReusedAndALinkIsRefused() throws {
        let paths = folder.paths
        XCTAssertFalse(paths.keptStoreFolderExists())
        let made = try paths.openKeptStoreFolder()
        XCTAssertTrue(paths.keptStoreFolderExists())
        XCTAssertEqual(try paths.openKeptStoreFolder(), made, "opened again, never replaced")
        XCTAssertNoThrow(try paths.validateRunFolder(made))
        var info = stat()
        XCTAssertEqual(lstat(made.path, &info), 0)
        XCTAssertEqual(info.st_mode & 0o777, 0o700)

        let linked = try DeskTestFolder()
        defer { linked.clean() }
        let elsewhere = linked.root.appendingPathComponent("elsewhere", isDirectory: true)
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        try linked.paths.prepareBase()
        try FileManager.default.createSymbolicLink(at: linked.base.appendingPathComponent(DeskPaths.keptStoreFolderName),
                                                   withDestinationURL: elsewhere)
        XCTAssertThrowsError(try linked.paths.openKeptStoreFolder()) {
            XCTAssertEqual($0 as? DeskPaths.Failure, .symlinkedFolder("store"))
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: elsewhere.path), [], "nothing written through the link")
    }

    func testAppStorageIsTheKeychainScopedByIdentity() throws {
        for (identity, service) in [(AppIdentity.release, "com.trueconvo.voice-cursor.desk-store-key"),
                                    (AppIdentity.test, "com.trueconvo.voice-cursor.test.desk-store-key")] {
            guard case .kept(let keys) = DeskSession.Storage.keychain(identity: identity),
                  let keychain = keys as? KeychainKeyProvider else {
                return XCTFail("the app's storage is the Keychain")
            }
            XCTAssertEqual(keychain.service, service)
        }
        let main = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/VoiceCursorMac/main.swift")
        let text = try String(contentsOf: main, encoding: .utf8)
        XCTAssertTrue(text.contains("storage: .keychain(identity: .current)"), "the app's Desk keeps its store under the Keychain")
    }
}

/// A Keychain that can be neither read nor written.
private struct UnreachableKeychain: KeyProvider {
    func existingKey(for storeId: UUID) throws -> StoreKey? { throw KeyProviderError.unavailable }
    func createKey(for storeId: UUID) throws -> StoreKey { throw KeyProviderError.unavailable }
}
