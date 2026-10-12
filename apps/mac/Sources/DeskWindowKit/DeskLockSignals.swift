import AppKit
import Foundation

/// Locks the Desk when the Mac locks, the user switches away (fast user
/// switching), or the Mac or its screens go to sleep:
/// - `com.apple.screenIsLocked` (distributed; undocumented but long-standing),
/// - `NSWorkspace.sessionDidResignActiveNotification`,
/// - `NSWorkspace.willSleepNotification`,
/// - `NSWorkspace.screensDidSleepNotification`.
///
/// Each signal calls `onLock(reason)` once, and only while `isSessionOpen`
/// says there is a Desk to lock; with the Desk never opened nothing
/// happens. The notification centers are injected so tests can post
/// invented signals. The screen-lock signal is taken even while True
/// Convo is in the background (`deliverImmediately`).
@MainActor
public final class DeskLockSignals {
    public static let screenLockedName = Notification.Name("com.apple.screenIsLocked")

    private let distributedCenter: NotificationCenter
    private let workspaceCenter: NotificationCenter
    private let isSessionOpen: @MainActor () -> Bool
    private let onLock: @MainActor (DeskLockReason) -> Void
    private var tokens: [(NotificationCenter, NSObjectProtocol)] = []
    private var relay: Relay?
    public private(set) var isRunning = false

    public init(distributedCenter: NotificationCenter = DistributedNotificationCenter.default(),
                workspaceCenter: NotificationCenter = NSWorkspace.shared.notificationCenter,
                isSessionOpen: @escaping @MainActor () -> Bool,
                onLock: @escaping @MainActor (DeskLockReason) -> Void) {
        self.distributedCenter = distributedCenter
        self.workspaceCenter = workspaceCenter
        self.isSessionOpen = isSessionOpen
        self.onLock = onLock
    }

    /// The app's wiring: each signal locks `session` with `lockNow`, so the
    /// Desk hides at once, even while an alert shown from a task holds the
    /// main queue.
    public static func locking(distributedCenter: NotificationCenter = DistributedNotificationCenter.default(),
                               workspaceCenter: NotificationCenter = NSWorkspace.shared.notificationCenter,
                               _ session: @escaping @MainActor () -> DeskSession?) -> DeskLockSignals {
        DeskLockSignals(distributedCenter: distributedCenter, workspaceCenter: workspaceCenter,
                        isSessionOpen: { session()?.respondsToLockSignals ?? false },
                        onLock: { reason in session()?.lockNow(reason: reason) })
    }

    public func start() {
        guard !isRunning else { return }
        isRunning = true
        if let distributed = distributedCenter as? DistributedNotificationCenter {
            let relay = Relay { [weak self] in self?.signal(.screenLocked) }
            distributed.addObserver(relay, selector: #selector(Relay.fire(_:)), name: Self.screenLockedName, object: nil,
                                    suspensionBehavior: .deliverImmediately)
            self.relay = relay
        } else {
            observe(distributedCenter, Self.screenLockedName, .screenLocked)
        }
        observe(workspaceCenter, NSWorkspace.sessionDidResignActiveNotification, .sessionResigned)
        observe(workspaceCenter, NSWorkspace.willSleepNotification, .willSleep)
        observe(workspaceCenter, NSWorkspace.screensDidSleepNotification, .screensSlept)
    }

    public func stop() {
        isRunning = false
        for (center, token) in tokens { center.removeObserver(token) }
        tokens.removeAll()
        if let relay {
            distributedCenter.removeObserver(relay)
            self.relay = nil
        }
    }

    private func observe(_ center: NotificationCenter, _ name: Notification.Name, _ reason: DeskLockReason) {
        let token = center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
            Self.onMain { self?.signal(reason) }
        }
        tokens.append((center, token))
    }

    private func signal(_ reason: DeskLockReason) {
        guard isRunning, isSessionOpen() else { return }
        onLock(reason)
    }

    /// Runs `work` on the main thread: now when already there, otherwise as
    /// a main run-loop block in the common modes. Not through the main
    /// queue, which an alert shown from a task holds until it is answered.
    nonisolated static func onMain(_ work: @escaping @MainActor () -> Void) {
        if Thread.isMainThread {
            MainActor.assumeIsolated(work)
        } else {
            let main = CFRunLoopGetMain()
            CFRunLoopPerformBlock(main, CFRunLoopMode.commonModes.rawValue) { MainActor.assumeIsolated(work) }
            CFRunLoopWakeUp(main)
        }
    }

    /// Target for the distributed observer (selector based, so the
    /// suspension behaviour can be chosen).
    private final class Relay: NSObject {
        let action: @MainActor () -> Void
        init(_ action: @escaping @MainActor () -> Void) { self.action = action }
        @objc func fire(_ notification: Notification) { DeskLockSignals.onMain(action) }
    }
}
