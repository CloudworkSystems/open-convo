import AppKit
@testable import DeskWindowKit
import Foundation
import XCTest

/// Lock signals, posted as invented notifications on injected centers.
@MainActor
final class DeskLockSignalsTests: XCTestCase {
    private let distributed = NotificationCenter()
    private let workspace = NotificationCenter()

    private var signals: [(NotificationCenter, Notification.Name, DeskLockReason)] {
        [
            (distributed, DeskLockSignals.screenLockedName, .screenLocked),
            (workspace, NSWorkspace.sessionDidResignActiveNotification, .sessionResigned),
            (workspace, NSWorkspace.willSleepNotification, .willSleep),
            (workspace, NSWorkspace.screensDidSleepNotification, .screensSlept)
        ]
    }

    func testEachSignalLocksOnceWithItsReason() {
        var reasons: [DeskLockReason] = []
        let lockSignals = DeskLockSignals(distributedCenter: distributed, workspaceCenter: workspace,
                                          isSessionOpen: { true }, onLock: { reasons.append($0) })
        lockSignals.start()
        lockSignals.start()
        XCTAssertEqual(DeskLockSignals.screenLockedName.rawValue, "com.apple.screenIsLocked")
        for (center, name, reason) in signals {
            reasons.removeAll()
            center.post(name: name, object: nil)
            XCTAssertEqual(reasons, [reason], name.rawValue)
        }
        lockSignals.stop()
    }

    func testNothingHappensAfterStop() {
        var reasons: [DeskLockReason] = []
        let lockSignals = DeskLockSignals(distributedCenter: distributed, workspaceCenter: workspace,
                                          isSessionOpen: { true }, onLock: { reasons.append($0) })
        lockSignals.start()
        lockSignals.stop()
        XCTAssertFalse(lockSignals.isRunning)
        for (center, name, _) in signals { center.post(name: name, object: nil) }
        XCTAssertEqual(reasons, [])
    }

    func testNothingHappensWithoutAnOpenSession() throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        // The Desk never opened: the session has nothing to lock.
        let session = makeSession(folder, bundle: try folder.fixtureBundle())
        XCTAssertFalse(session.respondsToLockSignals)
        var reasons: [DeskLockReason] = []
        let lockSignals = DeskLockSignals(distributedCenter: distributed, workspaceCenter: workspace,
                                          isSessionOpen: { session.respondsToLockSignals }, onLock: { reasons.append($0) })
        lockSignals.start()
        for (center, name, _) in signals { center.post(name: name, object: nil) }
        XCTAssertEqual(reasons, [])
        XCTAssertEqual(session.state, .lockedNoStack)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.base.path))
        lockSignals.stop()
    }

    /// Review finding LC-2: an alert shown from a main-actor task holds back
    /// every other main-actor task while it is up. A lock signal still
    /// hides the Desk at once (the app's wiring, `locking`).
    func testSignalHidesTheDeskAtOnceWhileTheMainQueueIsBusy() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let session = makeSession(folder, bundle: try anyDeskBundle(folder))
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let host = try XCTUnwrap(session.host)
        let lockSignals = DeskLockSignals.locking(distributedCenter: distributed, workspaceCenter: workspace) { session }
        lockSignals.start()
        var stateRightAfterSignal: DeskSession.State?
        let done = expectation(description: "the busy main-queue job ended")
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                self.workspace.post(name: NSWorkspace.screensDidSleepNotification, object: nil)
                stateRightAfterSignal = session.state
                done.fulfill()
            }
        }
        await fulfillment(of: [done], timeout: 10)
        XCTAssertEqual(stateRightAfterSignal, .locked, "hidden at once, not once the main queue is free")
        try await waitUntil("the host's own lock step") { host.isLocked }
        lockSignals.stop()
        await session.close()
    }

    /// Review finding LC-2: a signal posted on another thread reaches the
    /// Desk inside the nested run loop of an alert shown from a main-actor
    /// task.
    func testSignalFromAnotherThreadLocksInsideANestedRunLoop() async throws {
        let folder = try DeskTestFolder()
        defer { folder.clean() }
        let session = makeSession(folder, bundle: try anyDeskBundle(folder))
        await session.unlock(verifier: StubUnlockVerifier(.verified))
        let lockSignals = DeskLockSignals.locking(distributedCenter: distributed, workspaceCenter: workspace) { session }
        lockSignals.start()
        let workspace = self.workspace
        var stateDuringNestedLoop: DeskSession.State?
        let done = expectation(description: "the nested run loop ended")
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                Thread.detachNewThread { workspace.post(name: NSWorkspace.sessionDidResignActiveNotification, object: nil) }
                spinNestedRunLoop(upTo: 3) { session.state == .locked }
                stateDuringNestedLoop = session.state
                done.fulfill()
            }
        }
        await fulfillment(of: [done], timeout: 10)
        XCTAssertEqual(stateDuringNestedLoop, .locked)
        lockSignals.stop()
        await session.close()
    }
}
