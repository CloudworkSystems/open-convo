import DeskHost
import DeskHostWebKit
import Foundation
import WebKit

/// Why the app asks before the Desk's page is closed, left or quit: it
/// holds unsaved work (`.unsaved`), or it gave no answer, so it may
/// (`.noAnswer`). A page that answered clean is never asked about.
public typealias DeskUnsavedWork = DeskWebViewHost.UnsavedWorkReason

extension DeskWebViewHost.UnsavedWorkReason {
    /// For the run log: an identifier only.
    public var logName: String {
        switch self {
        case .unsaved: return "unsaved-work"
        case .noAnswer: return "no-answer"
        }
    }
}

/// Why the Desk was locked. Identifiers only, for the run log.
public enum DeskLockReason: String, Sendable, CaseIterable {
    case menu
    case lockButton = "lock-button"
    case screenLocked = "screen-locked"
    case sessionResigned = "session-resigned"
    case willSleep = "will-sleep"
    case screensSlept = "screens-slept"
}

/// One invented Desk per app run: the in-memory key, the run's store
/// folder, and, while open, the store, the host protocol and the web view.
///
/// States:
/// - `lockedNoStack`: at launch (the join contract's "restart locked"), and
///   after a lock while closed. Nothing is built; unlocking asks the owner.
/// - `open`: the page is shown.
/// - `locked`: the stack is kept but the store refuses and the page is
///   hidden; unlocking asks the owner, then loads a fresh document.
/// - `closed`: the window was closed; the store's writer lock is released.
///   Reopening within the run uses the same folder and key without asking
///   again (a lock signal while closed returns to `lockedNoStack`).
/// - `unavailable(message)`: the Desk cannot open (no Desk in this build,
///   its key is gone, another copy holds the store, an unsafe folder).
///
/// The made-up key lives only in memory (`InventedInMemoryKeyProvider`):
/// after a quit, the next run starts a fresh invented Desk in a new folder
/// and says why; earlier folders are left exactly as they were.
///
/// Logging is identifiers only: states, reasons, kinds, URL scheme and
/// host. Never page content, never a host event's detail.
@MainActor
public final class DeskSession {
    public typealias Log = @Sendable (_ event: String, _ detail: String) -> Void

    public enum State: Equatable, Sendable {
        case lockedNoStack
        case open
        case locked
        case closed
        case unavailable(String)

        public var logName: String {
            switch self {
            case .lockedNoStack: return "locked-no-stack"
            case .open: return "open"
            case .locked: return "locked"
            case .closed: return "closed"
            case .unavailable: return "unavailable"
            }
        }
    }

    /// Plain words shown in the window.
    public enum Message {
        public static let keyMissing = "This invented Desk can't open: its made-up key is gone. Nothing was replaced."
        public static let secondWriter = "The Desk is open in another copy of True Convo."
        public static let bundleMissing = "The Desk isn't in this build of True Convo."
        public static let bundleUnreadable = "The Desk in this build can't be read, so it stays closed."
        public static let unsafeFolder = "The invented Desk's folder isn't a plain folder, so the Desk stays closed. Nothing was changed."
        public static let couldNotOpen = "The invented Desk couldn't open. Nothing was replaced."
        public static let notUnlocked = "Not unlocked. The Desk stays locked."
        public static let quitNote = "Earlier invented Desks can't reopen after quitting; their made-up key lived only in memory."
    }

    public let paths: DeskPaths
    public let bundle: DeskBundleLocation?
    public let info: HostInfo
    /// The run's one key provider. Never replaced; gone with the process.
    let keys = InventedInMemoryKeyProvider()
    let log: Log

    public private(set) var state: State {
        didSet { if state != oldValue { onChange?() } }
    }
    /// The window's passing notice (a refused unlock, a refused dictation).
    public private(set) var notice: String?
    /// This run's store folder, made on the first unlock.
    public private(set) var runFolder: URL?
    public private(set) var host: DeskWebViewHost?
    public private(set) var store: ProofStore?
    private var hostProtocol: DeskHostProtocol?
    /// Whether run folders from earlier runs were present when this run's
    /// session was made (they can never reopen).
    public let earlierRunsExisted: Bool
    /// The quit note, after a relaunch: it stays for the whole run, next to
    /// any passing notice.
    public var standingNote: String? { earlierRunsExisted ? Message.quitNote : nil }
    /// What the window's notice line shows: the standing note, then the
    /// passing notice.
    public var displayedNotice: String? {
        let lines = [standingNote, notice].compactMap { $0 }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    /// Called after every change of `state` or `notice`.
    public var onChange: (@MainActor () -> Void)?
    /// The page's content process ended (the host reloads it once).
    public var onPageStopped: (@MainActor () -> Void)?
    /// A new document began (after a load, reload or recovery).
    public var onPageStarted: (@MainActor () -> Void)?
    /// Asked before a navigation leaves a page that holds unsaved work or
    /// could not say (the reason); true lets it go and whatever the page
    /// held is lost. Unset keeps the page.
    public var confirmLeavingUnsavedWork: (@MainActor (URL?, DeskUnsavedWork) async -> Bool)?
    /// Test seam: stands in for the page's unsaved-work answer (nil: clean).
    var unsavedWorkCheck: (@MainActor () async -> DeskUnsavedWork?)?

    private var unlocking = false
    /// Counts lock requests: an unlock or open that saw a lock arrive
    /// meanwhile leaves the Desk locked.
    private var lockRequests = 0
    /// Counts closes: an unlock or open that saw the window close meanwhile
    /// leaves the Desk shut (nothing opens in a window nobody sees).
    private var closeRequests = 0

    public init(paths: DeskPaths, bundle: DeskBundleLocation?, info: HostInfo, log: @escaping Log = { _, _ in }) {
        self.paths = paths
        self.bundle = bundle
        self.info = info
        self.log = log
        earlierRunsExisted = !paths.existingRunFolderNames().isEmpty
        state = bundle == nil ? .unavailable(Message.bundleMissing) : .lockedNoStack
    }

    /// `appVersion` from `CFBundleShortVersionString`; `hostBuild` is
    /// `<CFBundleVersion>-desk-<TCDeskSourceCommit>`.
    public static func hostInfo(bundle: Bundle = .main) -> HostInfo {
        func value(_ key: String) -> String? {
            guard let text = bundle.object(forInfoDictionaryKey: key) as? String, !text.isEmpty else { return nil }
            return text
        }
        return HostInfo(appVersion: value("CFBundleShortVersionString") ?? "0.0.0-dev",
                        hostBuild: "\(value("CFBundleVersion") ?? "dev")-desk-\(value("TCDeskSourceCommit") ?? "none")")
    }

    public var keyCustody: String? { store?.keyCustody }
    public var hasStack: Bool { host != nil }
    public var isOpen: Bool { state == .open }

    /// Whether a lock signal (screen lock, fast user switching, sleep) has
    /// anything to lock: the Desk is open, closed within this run (its key
    /// still in memory), or being unlocked.
    public var respondsToLockSignals: Bool {
        state == .open || state == .closed || unlocking
    }

    public func post(notice text: String?) {
        guard notice != text else { return }
        notice = text
        onChange?()
    }

    // MARK: Unlock

    /// From `lockedNoStack`, `locked` or `unavailable`: asks the owner first.
    /// From `closed`: reopens the same folder with the same key without
    /// asking again within the run. A lock requested while this runs wins.
    public func unlock(verifier: DeskUnlockVerifier) async {
        guard !unlocking, bundle != nil else { return }
        let from = state
        guard from != .open else { return }
        unlocking = true
        defer { unlocking = false }
        let lockRequestsAtStart = lockRequests
        let closeRequestsAtStart = closeRequests
        if from != .closed {
            switch await verifier.verify(reason: MacOwnerVerifier.reason) {
            case .verified:
                break
            case .refused:
                log("desk.unlock.refused", "from=\(from.logName)")
                post(notice: Message.notUnlocked)
                return
            case .unavailable(let message):
                log("desk.unlock.unavailable", "from=\(from.logName)")
                post(notice: message)
                return
            }
            guard closeRequests == closeRequestsAtStart else {
                log("desk.unlock.superseded", "from=\(from.logName) now=\(state.logName) reason=window-closed")
                return
            }
            guard lockRequests == lockRequestsAtStart, state == from else {
                log("desk.unlock.superseded", "from=\(from.logName) now=\(state.logName)")
                return
            }
        }
        if notice == Message.notUnlocked || notice == MacOwnerVerifier.unavailableMessage { notice = nil }
        if from == .locked, let host {
            await host.unlock()
            guard lockRequests == lockRequestsAtStart, state == .locked, self.host === host, !host.isLocked else {
                log("desk.unlock.superseded", "from=locked now=\(state.logName)")
                return
            }
            // Unlock requires a fresh document and bootstrap.
            host.reload()
            state = .open
            log("desk.unlocked", "from=locked")
            return
        }
        await openStack(from: from, lockRequestsAtStart: lockRequestsAtStart, closeRequestsAtStart: closeRequestsAtStart)
    }

    /// AssetResolver, ProofStore, event sink, registries, protocol, web
    /// view, then the first load.
    private func openStack(from: State, lockRequestsAtStart: Int, closeRequestsAtStart: Int) async {
        guard let bundle else { return }
        do {
            let resolver = try bundle.makeResolver()
            let folder: URL
            if let runFolder {
                try paths.validateRunFolder(runFolder)
                folder = runFolder
            } else {
                folder = try paths.makeRunFolder()
                runFolder = folder
                log("desk.run-folder.created", "name=\(folder.lastPathComponent)")
            }
            let store = try ProofStore(directory: folder, keys: keys, seed: .inventedRevisionZero())
            let log = self.log
            let sink = WebKitHostEventSink { event in
                // Identities only: never the event's detail (a dictation
                // final carries text).
                log("desk.host.event", "type=\(event.type) generation=\(event.generation)")
            }
            let connections = ConnectionRegistry()
            let drafts = DraftBindingRegistry()
            let hostProtocol = DeskHostProtocol(store: store, connections: connections, drafts: drafts, info: info, events: sink)
            if await hostProtocol.outstandingMutation != nil {
                let kind: String
                do {
                    kind = Self.logKind(try await hostProtocol.recoverUnresolvedDispatch())
                } catch {
                    kind = "refused"
                }
                log("desk.store.recovery", "kind=\(kind)")
            }
            if closeRequests != closeRequestsAtStart {
                // The window closed while the Desk was opening: nothing is
                // shown, and the store's writer lock is released at once.
                store.close()
                log("desk.open.abandoned", "reason=window-closed")
                return
            }
            let host = DeskWebViewHost(hostProtocol: hostProtocol, resolver: resolver, eventSink: sink,
                                       frame: CGRect(x: 0, y: 0, width: 1100, height: 700))
            wire(host)
            self.store = store
            self.hostProtocol = hostProtocol
            self.host = host
            if lockRequests != lockRequestsAtStart {
                // A lock arrived while the Desk was opening: it stays locked
                // and nothing is loaded.
                state = .locked
                log("desk.locked", "reason=while-opening")
                await host.lock()
                return
            }
            host.load()
            state = .open
            log("desk.opened", "from=\(from.logName) store=\(store.status.rawValue)")
        } catch {
            let (message, kind) = Self.describe(error)
            log("desk.open.failed", "reason=\(kind)")
            state = .unavailable(message)
        }
    }

    private func wire(_ host: DeskWebViewHost) {
        let log = self.log
        host.onNavigationRefused = { url in log("desk.navigation.refused", Self.describe(url)) }
        host.onNavigationDropped = { url in log("desk.navigation.dropped", Self.describe(url)) }
        host.onContentProcessTerminated = { [weak self] in
            log("desk.page.stopped", "reloading=\(!(self?.host?.isLocked ?? true))")
            self?.onPageStopped?()
        }
        host.onDocumentBegan = { [weak self] connection in
            log("desk.document.began", "generation=\(connection.generation)")
            self?.onPageStarted?()
        }
        host.confirmLeavingUnsavedWork = { [weak self] url, reason in
            guard let self, let ask = self.confirmLeavingUnsavedWork else { return false }
            return await ask(url, reason)
        }
    }

    // MARK: Lock and close

    /// The synchronous part runs first: the state turns `locked`, so the
    /// window hides the page and shows the overlay, before the host's lock
    /// step. A lock while closed means the next reopen asks the owner.
    public func lock(reason: DeskLockReason) async {
        if let host = beginLock(reason: reason) { await host.lock() }
    }

    /// The same lock, for lock signals and the menu: the visible part
    /// happens now, without waiting for the main queue (an alert shown from
    /// a task holds it), and the host's lock step follows in a task.
    public func lockNow(reason: DeskLockReason) {
        if let host = beginLock(reason: reason) { Task { await host.lock() } }
    }

    /// The synchronous part of a lock; returns the host whose own lock step
    /// is still to run.
    private func beginLock(reason: DeskLockReason) -> DeskWebViewHost? {
        lockRequests += 1
        switch state {
        case .open:
            state = .locked
            log("desk.locked", "reason=\(reason.rawValue)")
            return host
        case .locked:
            // An unlock in flight must not win over this lock.
            return unlocking ? host : nil
        case .closed:
            state = .lockedNoStack
            log("desk.locked", "reason=\(reason.rawValue) closed=true")
            return nil
        case .lockedNoStack, .unavailable:
            return nil
        }
    }

    /// Closes the host (the page is told, the store closes and its writer
    /// lock is released) and drops every reference to the stack. Open
    /// becomes `closed`; locked becomes `lockedNoStack`. An unlock still
    /// asking the owner, or still opening, ends without opening anything.
    public func close() async {
        closeRequests += 1
        guard let host else { return }
        await host.close()
        guard self.host === host else { return }
        store?.close()
        self.host = nil
        hostProtocol = nil
        store = nil
        let locked = state != .open
        state = locked ? .lockedNoStack : .closed
        log("desk.closed", "locked=\(locked)")
    }

    /// Whether the open page may still hold unsaved work: `.unsaved` when
    /// it says so, `.noAnswer` when it could not answer (the close and quit
    /// questions ask all the same), and nil only when it answered clean or
    /// there is nothing left to lose: the Desk is not open, or a lock or
    /// close came while the page was asked (it took the page's work).
    public func holdsUnsavedWork() async -> DeskUnsavedWork? {
        guard state == .open, let host else { return nil }
        let answer: DeskUnsavedWork?
        if let unsavedWorkCheck {
            answer = await unsavedWorkCheck()
        } else {
            answer = await host.pageHoldsUnsavedWork()
        }
        guard state == .open, self.host === host else { return nil }
        return answer
    }

    // MARK: Plain descriptions

    static func describe(_ url: URL?) -> String {
        "scheme=\(url?.scheme ?? "none") host=\(url?.host ?? "none")"
    }

    static func logKind(_ recovery: DispatchRecovery) -> String {
        switch recovery {
        case .nothingOutstanding: return "nothing-outstanding"
        case .inFlight: return "in-flight"
        case .awaitingReconcile: return "awaiting-reconcile"
        case .withdrawn: return "withdrawn"
        }
    }

    static func describe(_ error: Error) -> (message: String, kind: String) {
        switch error {
        case ProofStoreError.keyMissing: return (Message.keyMissing, "key-missing")
        case ProofStoreError.secondWriter: return (Message.secondWriter, "second-writer")
        case is DeskPaths.Failure: return (Message.unsafeFolder, "unsafe-folder")
        case is DeskBundleScanner.ScanError, is BundleManifestError: return (Message.bundleUnreadable, "bundle")
        case let store as ProofStoreError: return (Message.couldNotOpen, "store-\(store)")
        case is DecodingError: return (Message.bundleUnreadable, "bundle-manifest")
        default: return (Message.couldNotOpen, "other")
        }
    }
}
