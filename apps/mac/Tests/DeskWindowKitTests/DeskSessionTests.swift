import DeskHost
@testable import DeskHostWebKit
@testable import DeskWindowKit
import Foundation
import WebKit
import XCTest

/// One invented Desk per app run, headless. Tests that need the real Desk
/// page use `TRUECONVO_DESK_BUNDLE` and are skipped without it (never
/// faked); the others use it when set and a one-page invented Desk
/// otherwise. Everything lives in a throwaway folder.
@MainActor
final class DeskSessionTests: XCTestCase {
    private var folder: DeskTestFolder!
    private var sessions: [DeskSession] = []

    override func setUp() async throws {
        folder = try DeskTestFolder()
    }

    override func tearDown() async throws {
        for session in sessions { await session.close() }
        sessions.removeAll()
        folder.clean()
    }

    private func session(_ bundle: DeskBundleLocation?, logs: DeskLogCollector = DeskLogCollector()) -> DeskSession {
        let made = makeSession(folder, bundle: bundle, logs: logs)
        sessions.append(made)
        return made
    }

    private func openSession(_ bundle: DeskBundleLocation, logs: DeskLogCollector = DeskLogCollector()) async throws -> DeskSession {
        let opened = session(bundle, logs: logs)
        await opened.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(opened.state, .open)
        return opened
    }

    func testStartsLockedWithNoStoreFiles() throws {
        let desk = session(try anyDeskBundle(folder))
        XCTAssertEqual(desk.state, .lockedNoStack)
        XCTAssertNil(desk.host)
        XCTAssertNil(desk.store)
        XCTAssertNil(desk.runFolder)
        XCTAssertNil(desk.notice, "no earlier runs, no note")
        XCTAssertNil(desk.standingNote)
        XCTAssertNil(desk.displayedNotice)
        XCTAssertFalse(desk.respondsToLockSignals)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.base.path), "nothing is created before the first unlock")

        let noDesk = session(nil)
        XCTAssertEqual(noDesk.state, .unavailable(DeskSession.Message.bundleMissing))
    }

    func testRefusedVerificationStaysLockedAndCreatesNothing() async throws {
        let logs = DeskLogCollector()
        let desk = session(try anyDeskBundle(folder), logs: logs)
        let verifier = StubUnlockVerifier(.refused, .unavailable(MacOwnerVerifier.unavailableMessage))
        await desk.unlock(verifier: verifier)
        XCTAssertEqual(desk.state, .lockedNoStack)
        XCTAssertEqual(desk.notice, DeskSession.Message.notUnlocked)
        await desk.unlock(verifier: verifier)
        XCTAssertEqual(desk.state, .lockedNoStack)
        XCTAssertEqual(desk.notice, MacOwnerVerifier.unavailableMessage)
        XCTAssertEqual(verifier.reasons, ["Unlock the invented Desk", "Unlock the invented Desk"])
        XCTAssertNil(desk.host)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.base.path), "nothing created")
        XCTAssertEqual(logs.all, ["desk.unlock.refused from=locked-no-stack", "desk.unlock.unavailable from=locked-no-stack"])
    }

    func testUnlockOpensStoreAndLoadsDesk() async throws {
        let logs = DeskLogCollector()
        let desk = try await openSession(try realDeskBundle(), logs: logs)
        let store = try XCTUnwrap(desk.store)
        XCTAssertEqual(store.status, .ready)
        XCTAssertEqual(desk.keyCustody, InventedInMemoryKeyProvider.custody)
        let run = try XCTUnwrap(desk.runFolder)
        XCTAssertEqual(run.deletingLastPathComponent().standardizedFileURL.path, folder.base.path)
        XCTAssertEqual(store.directory.path, run.standardizedFileURL.path)
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.base.appendingPathComponent(DeskPaths.markerFileName).path))
        XCTAssertEqual(try posixMode(folder.base), 0o700)
        XCTAssertEqual(try posixMode(run), 0o700)
        let connection = try await waitForRealDesk(desk)
        XCTAssertEqual(connection.generation, desk.host?.currentConnection?.generation)
        XCTAssertTrue(desk.respondsToLockSignals)
        let opened = logs.all.filter { $0.hasPrefix("desk.") && !$0.hasPrefix("desk.host.event") && !$0.hasPrefix("desk.document.began") }
        XCTAssertEqual(opened, ["desk.run-folder.created name=\(run.lastPathComponent)", "desk.opened from=locked-no-stack store=ready"])
        XCTAssertTrue(logs.all.contains("desk.host.event type=host.connection generation=\(connection.generation)"))
    }

    func testLockHidesContentBeforeHostLockFinishes() async throws {
        let desk = try await openSession(try anyDeskBundle(folder))
        let host = try XCTUnwrap(desk.host)
        let store = try XCTUnwrap(desk.store)
        var seen: [(state: DeskSession.State, storeLocked: Bool, hostLocked: Bool)] = []
        desk.onChange = { seen.append((desk.state, store.isLocked, host.isLocked)) }
        await desk.lock(reason: .menu)
        XCTAssertEqual(seen.first?.state, .locked, "the window is told first")
        XCTAssertEqual(seen.first?.storeLocked, false, "content is hidden before the host's lock step runs")
        XCTAssertEqual(seen.first?.hostLocked, false)
        XCTAssertTrue(store.isLocked)
        XCTAssertTrue(host.isLocked)
        XCTAssertNil(host.currentConnection)
        XCTAssertEqual(desk.state, .locked)
        XCTAssertFalse(desk.respondsToLockSignals)
    }

    func testUnlockAfterLockLoadsFreshDocument() async throws {
        let desk = session(try realDeskBundle())
        let verifier = StubUnlockVerifier(.verified, .refused, .verified)
        await desk.unlock(verifier: verifier)
        let first = try await waitForRealDesk(desk)
        await desk.lock(reason: .screenLocked)
        await desk.unlock(verifier: verifier)
        XCTAssertEqual(desk.state, .locked, "a refused owner check keeps it locked")
        await desk.unlock(verifier: verifier)
        XCTAssertEqual(desk.state, .open)
        let second = try await waitForRealDesk(desk, after: first)
        XCTAssertNotEqual(second.id, first.id, "a new connection")
        XCTAssertGreaterThan(second.generation, first.generation, "a fresh document")
        XCTAssertEqual(verifier.askedCount, 3)
    }

    func testCloseReleasesWriterAndReopenInSameRunShowsSameWorkspace() async throws {
        let desk = session(try realDeskBundle())
        let verifier = StubUnlockVerifier(.verified)
        await desk.unlock(verifier: verifier)
        let first = try await waitForRealDesk(desk)
        let store = try XCTUnwrap(desk.store)
        let workspaceId = store.workspaceId
        let handle = store.workspaceHandle
        let run = try XCTUnwrap(desk.runFolder)
        let oldHost = try XCTUnwrap(desk.host)

        await desk.close()
        XCTAssertEqual(desk.state, .closed)
        XCTAssertNil(desk.host)
        XCTAssertNil(desk.store)
        XCTAssertTrue(oldHost.isClosed)
        XCTAssertTrue(desk.respondsToLockSignals, "a closed Desk still has its key in memory")
        let holder = try XCTUnwrap(WriterLockHolder(folder: run), "the writer lock was released")
        holder.release()

        await desk.unlock(verifier: verifier)
        XCTAssertEqual(verifier.askedCount, 1, "reopening within the run does not ask again")
        XCTAssertEqual(desk.state, .open)
        XCTAssertEqual(desk.runFolder, run)
        XCTAssertEqual(desk.store?.workspaceId, workspaceId)
        XCTAssertEqual(desk.store?.workspaceHandle, handle)
        let reopened = try await waitForRealDesk(desk)
        XCTAssertNotEqual(reopened.id, first.id, "a fresh document on the same workspace")
    }

    func testNewRunUsesNewFolderLeavesOldByteIdenticalAndShowsQuitNote() async throws {
        let bundle = try anyDeskBundle(folder)
        let earlier = try await openSession(bundle)
        let earlierRun = try XCTUnwrap(earlier.runFolder)
        await earlier.close()
        let before = try snapshot(earlierRun)
        XCTAssertFalse(before.isEmpty)

        // A new app run: a new session with its own in-memory key.
        let later = session(bundle)
        XCTAssertTrue(later.earlierRunsExisted)
        XCTAssertEqual(later.standingNote, DeskSession.Message.quitNote)
        XCTAssertEqual(later.displayedNotice, DeskSession.Message.quitNote)
        XCTAssertEqual(later.state, .lockedNoStack)
        await later.unlock(verifier: StubUnlockVerifier(.verified))
        XCTAssertEqual(later.state, .open)
        let laterRun = try XCTUnwrap(later.runFolder)
        XCTAssertNotEqual(laterRun, earlierRun)
        XCTAssertNotEqual(later.store?.workspaceId, nil)
        await later.close()
        XCTAssertEqual(try snapshot(earlierRun), before, "the earlier run's folder is byte-identical")
        XCTAssertEqual(Set(folder.paths.existingRunFolderNames()), [earlierRun.lastPathComponent, laterRun.lastPathComponent])
    }

    func testSecondWriterOnSameFolderShowsPlainMessage() async throws {
        let logs = DeskLogCollector()
        let desk = try await openSession(try anyDeskBundle(folder), logs: logs)
        let run = try XCTUnwrap(desk.runFolder)
        await desk.close()
        let other = try XCTUnwrap(WriterLockHolder(folder: run), "another copy takes the writer lock")
        let before = try snapshot(run)

        await desk.unlock(verifier: StubUnlockVerifier())
        XCTAssertEqual(desk.state, .unavailable(DeskSession.Message.secondWriter))
        XCTAssertNil(desk.host)
        XCTAssertTrue(logs.all.contains("desk.open.failed reason=second-writer"))
        XCTAssertEqual(try snapshot(run), before)

        other.release()
        let verifier = StubUnlockVerifier(.verified)
        await desk.unlock(verifier: verifier)
        XCTAssertEqual(verifier.askedCount, 1, "trying again asks the owner")
        XCTAssertEqual(desk.state, .open)
        XCTAssertEqual(desk.runFolder, run)
    }

    func testMissingKeyShowsPlainMessageAndReplacesNothing() async throws {
        let logs = DeskLogCollector()
        let desk = try await openSession(try anyDeskBundle(folder), logs: logs)
        let run = try XCTUnwrap(desk.runFolder)
        let workspaceId = try XCTUnwrap(desk.store?.workspaceId)
        await desk.close()
        let before = try snapshot(run)
        desk.keys.forgetKey(for: workspaceId)

        await desk.unlock(verifier: StubUnlockVerifier())
        XCTAssertEqual(desk.state, .unavailable(DeskSession.Message.keyMissing))
        XCTAssertEqual(DeskSession.Message.keyMissing, "This invented Desk can't open: its made-up key is gone. Nothing was replaced.")
        XCTAssertNil(desk.store)
        XCTAssertEqual(desk.keys.heldKeyCount, 0, "no new key was made")
        XCTAssertEqual(try snapshot(run), before, "nothing was replaced")
        XCTAssertTrue(logs.all.contains("desk.open.failed reason=key-missing"))
    }

    private static let sessionCount = "document.body.innerText.split('New conversation').length - 1"

    func testSavedDraftSurvivesCloseAndReopen() async throws {
        let desk = session(try realDeskBundle())
        await desk.unlock(verifier: StubUnlockVerifier(.verified))
        _ = try await waitForRealDesk(desk)
        let webView = try XCTUnwrap(desk.host?.webView)
        let countBeforeValue = try await evaluate(webView, Self.sessionCount)
        let countBefore = try XCTUnwrap(countBeforeValue as? Int)
        let clicked = try await evaluate(webView, """
        (function () {
          var b = Array.from(document.querySelectorAll('button')).find(function (x) { return x.textContent.trim() === 'New session' && !x.getAttribute('aria-label'); })
               || Array.from(document.querySelectorAll('button')).find(function (x) { return x.getAttribute('aria-label') === 'New session'; });
          if (!b) return 'missing';
          b.click();
          return 'clicked';
        })()
        """) as? String
        XCTAssertEqual(clicked, "clicked", "one invented change through the page's own control")
        let store = try XCTUnwrap(desk.store)
        try await waitUntil("the store to save the change") { ((try? store.read().revision) ?? 0) >= 1 }
        try await waitUntil("the page to say it was saved") {
            (try? await evaluate(webView, "document.body.innerText.indexOf('Invented workspace saved by the native host') >= 0")) as? Bool == true
        }
        let countSavedValue = try await evaluate(webView, Self.sessionCount)
        let countSaved = try XCTUnwrap(countSavedValue as? Int)
        XCTAssertGreaterThan(countSaved, countBefore, "the new invented session shows")

        await desk.close()
        await desk.unlock(verifier: StubUnlockVerifier())
        XCTAssertEqual(desk.state, .open)
        _ = try await waitForRealDesk(desk)
        let reopenedView = try XCTUnwrap(desk.host?.webView)
        try await waitUntil("the reopened page to show the saved change") {
            (try? await evaluate(reopenedView, Self.sessionCount)) as? Int == countSaved
        }
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(desk.store).read().revision, 1)
    }
}
