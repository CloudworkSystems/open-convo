import Foundation

/// Section 17's end observers (plan F4; Codex F0 answer 13), for the whole
/// launch, whether or not a Desk window exists: each system signal ends an
/// active confirmation with its `endedBy` and abandons any attempt under way
/// (so a late successful LocalAuthentication result is discarded):
///
/// - `com.apple.screenIsLocked` (distributed; taken in the background too)
///   and `NSWorkspace.sessionDidResignActiveNotification`: `lock`;
/// - `NSWorkspace.willSleepNotification` and
///   `NSWorkspace.screensDidSleepNotification`: `sleep`;
/// - `NSWorkspace.willPowerOffNotification` (logout or power-off): `logout`.
///   Not every way macOS can end a process posts it; the next launch starts
///   `unconfirmed` either way.
///
/// Each handler calls only the owner's `end`, on the thread that delivered
/// the signal: no main-thread hop, no coordinator or Desk call, so it never
/// re-enters the coordinator during the Desk's own lock flow (which
/// `DeskLockSignals` runs separately). The workspace center is injected
/// (`NSWorkspace.shared.notificationCenter` in the app, which this module,
/// with no AppKit, does not name); the AppKit names are spelled here and a
/// test holds them equal to AppKit's own. INACTIVE: nothing in the app
/// constructs this (F7 composes activation).
public final class PaidUsageEndSignals: @unchecked Sendable {
    public static let screenLocked = Notification.Name("com.apple.screenIsLocked")
    public static let sessionResigned = Notification.Name("NSWorkspaceSessionDidResignActiveNotification")
    public static let willSleep = Notification.Name("NSWorkspaceWillSleepNotification")
    public static let screensDidSleep = Notification.Name("NSWorkspaceScreensDidSleepNotification")
    public static let willPowerOff = Notification.Name("NSWorkspaceWillPowerOffNotification")

    /// The workspace signals and the end each gives.
    public static let workspaceEnds: [(name: Notification.Name, end: ParticipantConfirmationEnd)] = [
        (sessionResigned, .lock), (willSleep, .sleep), (screensDidSleep, .sleep), (willPowerOff, .logout)
    ]

    private let owner: PaidUsageConfirmationOwner
    private let distributedCenter: NotificationCenter
    private let workspaceCenter: NotificationCenter
    private let lock = NSLock()
    private var tokens: [NSObjectProtocol] = []
    private var relay: Relay?

    public init(owner: PaidUsageConfirmationOwner, distributedCenter: NotificationCenter = DistributedNotificationCenter.default(),
                workspaceCenter: NotificationCenter) {
        self.owner = owner
        self.distributedCenter = distributedCenter
        self.workspaceCenter = workspaceCenter
    }

    public var isRunning: Bool {
        lock.lock(); defer { lock.unlock() }
        return relay != nil
    }

    public func start() {
        lock.lock(); defer { lock.unlock() }
        guard relay == nil else { return }
        let owner = self.owner
        let relay = Relay { owner.end(.lock) }
        if let distributed = distributedCenter as? DistributedNotificationCenter {
            distributed.addObserver(relay, selector: #selector(Relay.fire(_:)), name: Self.screenLocked, object: nil,
                                    suspensionBehavior: .deliverImmediately)
        } else {
            distributedCenter.addObserver(relay, selector: #selector(Relay.fire(_:)), name: Self.screenLocked, object: nil)
        }
        self.relay = relay
        for (name, end) in Self.workspaceEnds {
            tokens.append(workspaceCenter.addObserver(forName: name, object: nil, queue: nil) { _ in owner.end(end) })
        }
    }

    public func stop() {
        lock.lock()
        let relay = self.relay
        let tokens = self.tokens
        self.relay = nil
        self.tokens = []
        lock.unlock()
        for token in tokens { workspaceCenter.removeObserver(token) }
        if let relay { distributedCenter.removeObserver(relay) }
    }

    deinit {
        stop()
    }

    /// Target for the distributed observer (selector based, so the
    /// suspension behaviour can be chosen).
    private final class Relay: NSObject {
        let action: @Sendable () -> Void
        init(_ action: @escaping @Sendable () -> Void) { self.action = action }
        @objc func fire(_ notification: Notification) { action() }
    }
}
