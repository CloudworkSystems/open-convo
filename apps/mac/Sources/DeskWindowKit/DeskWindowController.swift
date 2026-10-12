import AppKit
import DeskHost
import DeskHostWebKit
import WebKit

/// The Desk's window. The app has no main menu (it is a menu-bar app), so
/// the standard edit keys are mapped here, for this window only: Cmd+X, C,
/// V, A, Z and Shift+Cmd+Z go to the first responder as `cut:`, `copy:`,
/// `paste:`, `selectAll:`, `undo:` and `redo:`. Every other key equivalent
/// passes through unchanged.
public final class DeskWindow: NSWindow {
    struct EditKey {
        let key: String
        let shift: Bool
        let action: Selector
    }

    static let editKeys: [EditKey] = [
        EditKey(key: "x", shift: false, action: #selector(NSText.cut(_:))),
        EditKey(key: "c", shift: false, action: #selector(NSText.copy(_:))),
        EditKey(key: "v", shift: false, action: #selector(NSText.paste(_:))),
        EditKey(key: "a", shift: false, action: #selector(NSText.selectAll(_:))),
        EditKey(key: "z", shift: false, action: Selector(("undo:"))),
        EditKey(key: "z", shift: true, action: Selector(("redo:")))
    ]

    /// The edit action a key event maps to, if any.
    static func editAction(for event: NSEvent) -> Selector? {
        guard event.type == .keyDown else { return nil }
        let flags = event.modifierFlags.intersection([.command, .shift, .option, .control])
        guard flags == .command || flags == [.command, .shift] else { return nil }
        guard let key = event.charactersIgnoringModifiers?.lowercased() else { return nil }
        let shift = flags.contains(.shift)
        return editKeys.first { $0.key == key && $0.shift == shift }?.action
    }

    public override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if let action = Self.editAction(for: event), let responder = firstResponder, responder.tryToPerform(action, with: self) {
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

/// What the unsaved-work question is about.
public enum DeskUnsavedWorkQuestion: Equatable, Sendable {
    case closeWindow
    case leavePage
    case quitApp
}

/// The words of an unsaved-work question. They say why it is asked: the
/// page holds unsaved changes, or it couldn't confirm the work is saved.
/// The second names no cause: no answer can come from a listener that
/// threw (at once, on a working page) as well as from the 2 s limit or a
/// page process that ended. Keep is always the first (default) button;
/// only the second loses anything, so no answer but that one leaves the
/// page.
public struct DeskUnsavedWorkWording: Equatable, Sendable {
    public static let unsavedMessage = "You have unsaved changes in the Desk."
    public static let noAnswerMessage = "The Desk page couldn't confirm your work is saved."

    public let message: String
    public let detail: String
    public let keepButton: String
    public let loseButton: String

    public init(_ question: DeskUnsavedWorkQuestion, _ reason: DeskUnsavedWork) {
        let unsaved = reason == .unsaved
        message = unsaved ? Self.unsavedMessage : Self.noAnswerMessage
        let loss = unsaved ? "loses them" : "may lose any changes it holds"
        switch question {
        case .closeWindow:
            detail = "Closing the window now \(loss). Everything here is invented data."
            keepButton = "Keep Editing"
            loseButton = unsaved ? "Close and Lose Changes" : "Close Anyway"
        case .leavePage:
            detail = "Leaving this page now \(loss). Everything here is invented data."
            keepButton = "Keep Editing"
            loseButton = unsaved ? "Leave and Lose Changes" : "Leave Anyway"
        case .quitApp:
            detail = "Quitting now \(loss). Everything in the Desk is invented data."
            keepButton = "Keep"
            loseButton = unsaved ? "Quit and Lose Changes" : "Quit Anyway"
        }
    }

    /// The alert: these words, Keep first. Only its second button
    /// (`.alertSecondButtonReturn`) means lose.
    @MainActor
    public func makeAlert() -> NSAlert {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = detail
        alert.addButton(withTitle: keepButton)
        alert.addButton(withTitle: loseButton)
        return alert
    }
}

/// Asks whether to lose unsaved Desk work, or work the page could not
/// vouch for (`reason`). True means lose it.
@MainActor
public protocol DeskUnsavedWorkPrompting: AnyObject {
    func ask(_ question: DeskUnsavedWorkQuestion, reason: DeskUnsavedWork, in window: NSWindow) async -> Bool
    /// Ends an open question as Keep (a lock arrived).
    func dismissAsKeep()
}

/// The real question: a sheet on the Desk window, Keep Editing first.
@MainActor
public final class SheetUnsavedWorkPrompt: DeskUnsavedWorkPrompting {
    private var open: (alert: NSAlert, window: NSWindow)?

    public init() {}

    public func ask(_ question: DeskUnsavedWorkQuestion, reason: DeskUnsavedWork, in window: NSWindow) async -> Bool {
        dismissAsKeep()
        let alert = DeskUnsavedWorkWording(question, reason).makeAlert()
        return await withCheckedContinuation { continuation in
            open = (alert, window)
            alert.beginSheetModal(for: window) { [weak self, weak alert] response in
                MainActor.assumeIsolated {
                    if let self, let alert, self.open?.alert === alert { self.open = nil }
                }
                continuation.resume(returning: response == .alertSecondButtonReturn)
            }
        }
    }

    public func dismissAsKeep() {
        guard let (alert, window) = open else { return }
        open = nil
        window.endSheet(alert.window, returnCode: .alertFirstButtonReturn)
    }
}

/// The Desk window: a native strip ("Invented data only · not private ·
/// key: …", a notice line, Lock), the Desk's web view, a native Locked
/// overlay with Unlock…, and a banner when the page's process stopped.
/// Not restorable. Closing asks first when the page holds unsaved work or
/// cannot say; a lock dismisses an open question as Keep.
@MainActor
public final class DeskWindowController: NSWindowController, NSWindowDelegate {
    public static let windowIdentifier = NSUserInterfaceItemIdentifier("trueconvo.desk")
    public static let windowTitle = "True Convo Desk (invented data)"

    public let session: DeskSession
    private let verifier: DeskUnlockVerifier
    let prompt: DeskUnsavedWorkPrompting
    private let log: DeskSession.Log

    /// Called whenever the window becomes key.
    public var onBecameKey: (@MainActor () -> Void)?
    /// Called after the window shows a new state (for the app's menu).
    public var onStateChange: (@MainActor () -> Void)?

    let stripLabel = NSTextField(labelWithString: "")
    let noticeLabel = NSTextField(wrappingLabelWithString: "")
    let lockButton = NSButton(title: "Lock", target: nil, action: nil)
    let pageContainer = NSView()
    let lockedOverlay = NSView()
    let lockedTitle = NSTextField(labelWithString: "Locked")
    let lockedMessage = NSTextField(wrappingLabelWithString: "")
    let unlockButton = NSButton(title: "Unlock…", target: nil, action: nil)
    let stoppedBanner = NSView()
    let reloadButton = NSButton(title: "Reload", target: nil, action: nil)
    private(set) var embeddedWebView: WKWebView?
    private var closingNow = false
    private var closeInProgress = false

    public init(session: DeskSession, verifier: DeskUnlockVerifier, prompt: DeskUnsavedWorkPrompting? = nil,
                log: @escaping DeskSession.Log = { _, _ in }) {
        self.session = session
        self.verifier = verifier
        self.prompt = prompt ?? SheetUnsavedWorkPrompt()
        self.log = log
        let window = DeskWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                                styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: true)
        window.identifier = Self.windowIdentifier
        window.title = Self.windowTitle
        window.isRestorable = false
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 640, height: 420)
        super.init(window: window)
        window.delegate = self
        buildViews(in: window)
        session.onChange = { [weak self] in self?.render() }
        // The banner says the page is reloading, which happens only while
        // the Desk is open; a locked Desk loads a fresh page on Unlock.
        session.onPageStopped = { [weak self] in
            guard let self else { return }
            self.stoppedBanner.isHidden = self.session.state != .open
        }
        session.onPageStarted = { [weak self] in self?.stoppedBanner.isHidden = true }
        session.confirmLeavingUnsavedWork = { [weak self] _, reason in
            guard let self, let window = self.window else { return false }
            return await self.prompt.ask(.leavePage, reason: reason, in: window)
        }
        render()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    // MARK: Showing

    /// Shows the window in front. A Desk closed earlier in this run reopens
    /// at once (same folder, same key); a locked one shows its overlay.
    public func showDesk() {
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        if session.state == .closed {
            Task { await session.unlock(verifier: verifier) }
        }
    }

    /// Whether the Desk window holds the focus: True Convo is the active
    /// app, the window is visible, and it (or a sheet on it) is key, or it
    /// is the main window.
    public var holdsFocus: Bool {
        guard let window else { return false }
        let app = NSApplication.shared
        return Self.holdsFocus(appIsActive: app.isActive, windowIsVisible: window.isVisible, keyWindow: app.keyWindow,
                               window: window, windowIsMain: window.isMainWindow)
    }

    static func holdsFocus(appIsActive: Bool, windowIsVisible: Bool, keyWindow: NSWindow?, window: NSWindow, windowIsMain: Bool) -> Bool {
        appIsActive && windowIsVisible && (keyWindow === window || keyWindow?.sheetParent === window || windowIsMain)
    }

    public func showNotice(_ text: String) {
        session.post(notice: text)
    }

    // MARK: Actions

    @objc func lockPressed(_ sender: Any?) {
        Task { await session.lock(reason: .lockButton) }
    }

    @objc func unlockPressed(_ sender: Any?) {
        Task { await session.unlock(verifier: verifier) }
    }

    @objc func reloadPressed(_ sender: Any?) {
        stoppedBanner.isHidden = true
        session.host?.reload()
    }

    // MARK: Closing

    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closingNow { return true }
        guard !closeInProgress else { return false }
        closeInProgress = true
        Task { await closeAfterAsking() }
        return false
    }

    /// Asks first when the page holds unsaved work or cannot say (Keep
    /// Editing / Close and Lose Changes, or Close Anyway), then closes the
    /// session and the window. Only the lose answer closes.
    func closeAfterAsking() async {
        defer { closeInProgress = false }
        if let reason = await session.holdsUnsavedWork() {
            guard let window, await prompt.ask(.closeWindow, reason: reason, in: window) else {
                log("desk.close.kept", "reason=\(reason.logName)")
                return
            }
        }
        await session.close()
        closingNow = true
        window?.close()
        closingNow = false
    }

    public func windowDidBecomeKey(_ notification: Notification) {
        onBecameKey?()
    }

    // MARK: Views

    private func buildViews(in window: NSWindow) {
        let content = NSView()
        window.contentView = content

        stripLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize, weight: .semibold)
        noticeLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        noticeLabel.textColor = .secondaryLabelColor
        lockButton.target = self
        lockButton.action = #selector(lockPressed(_:))
        lockButton.bezelStyle = .rounded
        let texts = NSStackView(views: [stripLabel, noticeLabel])
        texts.orientation = .vertical
        texts.alignment = .leading
        texts.spacing = 2
        let strip = NSStackView(views: [texts, lockButton])
        strip.orientation = .horizontal
        strip.alignment = .centerY
        strip.edgeInsets = NSEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
        texts.setContentHuggingPriority(.defaultLow, for: .horizontal)
        lockButton.setContentHuggingPriority(.required, for: .horizontal)

        let bannerLabel = NSTextField(labelWithString: "Desk page stopped, reloading")
        reloadButton.target = self
        reloadButton.action = #selector(reloadPressed(_:))
        let bannerStack = NSStackView(views: [bannerLabel, reloadButton])
        bannerStack.orientation = .horizontal
        bannerStack.edgeInsets = NSEdgeInsets(top: 4, left: 12, bottom: 4, right: 12)
        pin(bannerStack, in: stoppedBanner)
        stoppedBanner.wantsLayer = true
        stoppedBanner.layer?.backgroundColor = NSColor.systemYellow.withAlphaComponent(0.25).cgColor
        stoppedBanner.isHidden = true

        lockedTitle.font = .systemFont(ofSize: 22, weight: .semibold)
        lockedMessage.alignment = .center
        lockedMessage.preferredMaxLayoutWidth = 420
        unlockButton.target = self
        unlockButton.action = #selector(unlockPressed(_:))
        unlockButton.bezelStyle = .rounded
        unlockButton.keyEquivalent = "\r"
        let lockedStack = NSStackView(views: [lockedTitle, lockedMessage, unlockButton])
        lockedStack.orientation = .vertical
        lockedStack.alignment = .centerX
        lockedStack.spacing = 12
        lockedStack.translatesAutoresizingMaskIntoConstraints = false
        lockedOverlay.addSubview(lockedStack)
        lockedOverlay.wantsLayer = true
        lockedOverlay.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        NSLayoutConstraint.activate([
            lockedStack.centerXAnchor.constraint(equalTo: lockedOverlay.centerXAnchor),
            lockedStack.centerYAnchor.constraint(equalTo: lockedOverlay.centerYAnchor),
            lockedStack.widthAnchor.constraint(lessThanOrEqualTo: lockedOverlay.widthAnchor, constant: -40)
        ])

        let column = NSStackView(views: [strip, stoppedBanner, pageContainer])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 0
        column.distribution = .fill
        pin(column, in: content)
        for view in [strip, stoppedBanner, pageContainer] {
            view.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        pageContainer.setContentHuggingPriority(.defaultLow, for: .vertical)
        pageContainer.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        pin(lockedOverlay, in: pageContainer)
    }

    private func pin(_ view: NSView, in container: NSView) {
        view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            view.topAnchor.constraint(equalTo: container.topAnchor),
            view.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
    }

    private func embed(_ webView: WKWebView) {
        guard embeddedWebView !== webView else { return }
        embeddedWebView?.removeFromSuperview()
        webView.translatesAutoresizingMaskIntoConstraints = false
        pageContainer.addSubview(webView, positioned: .below, relativeTo: lockedOverlay)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: pageContainer.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: pageContainer.trailingAnchor),
            webView.topAnchor.constraint(equalTo: pageContainer.topAnchor),
            webView.bottomAnchor.constraint(equalTo: pageContainer.bottomAnchor)
        ])
        embeddedWebView = webView
    }

    /// Shows the session's state. Locking hides the page here, at once,
    /// before the host's own lock step runs.
    func render() {
        let state = session.state
        stripLabel.stringValue = "Invented data only · not private · key: \(session.keyCustody ?? "not opened yet")"
        noticeLabel.stringValue = session.displayedNotice ?? ""
        noticeLabel.isHidden = session.displayedNotice == nil
        lockButton.isEnabled = state == .open
        switch state {
        case .open:
            if let webView = session.host?.webView { embed(webView) }
            embeddedWebView?.isHidden = false
            lockedOverlay.isHidden = true
        case .locked, .lockedNoStack, .closed, .unavailable:
            embeddedWebView?.isHidden = true
            lockedOverlay.isHidden = false
            stoppedBanner.isHidden = true
            if session.host == nil {
                embeddedWebView?.removeFromSuperview()
                embeddedWebView = nil
            }
            if case .unavailable(let message) = state {
                lockedTitle.stringValue = "Desk unavailable"
                lockedMessage.stringValue = message
                unlockButton.title = "Try Again…"
                unlockButton.isHidden = session.bundle == nil
            } else {
                lockedTitle.stringValue = "Locked"
                lockedMessage.stringValue = "Invented data only. Unlock with your Mac password or Touch ID."
                unlockButton.title = "Unlock…"
                unlockButton.isHidden = false
            }
            if state == .locked || state == .lockedNoStack {
                // A lock answers any open question as Keep.
                prompt.dismissAsKeep()
            }
        }
        onStateChange?()
    }
}
