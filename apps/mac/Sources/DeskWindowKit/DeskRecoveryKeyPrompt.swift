import AppKit

/// What the owner answered when asked to type part of the key back.
public enum RecoveryCheckAnswer: Equatable, Sendable {
    case typed(String, String)
    case showAgain
    case cancel
}

/// The recovery key's dialogs (step 2, PR 3b). A seam so tests answer
/// without a window; the app uses `SheetRecoveryKeyPrompt`.
@MainActor
public protocol DeskRecoveryKeyPrompting: AnyObject {
    /// Shows the key once. True when the owner says it is written down.
    func show(_ displayText: String, durable: Bool, in window: NSWindow) async -> Bool
    /// Asks for two groups back (`retry`: the last try didn't match).
    func askBack(_ check: RecoveryKeyCheck, retry: Bool, in window: NSWindow) async -> RecoveryCheckAnswer
    /// Asks for the whole key to restore with (`problem`: why the last
    /// try failed). Nil means Cancel.
    func askRestore(problem: String?, in window: NSWindow) async -> String?
    /// Ends any open dialog as Cancel (the Desk locked or closed).
    func dismiss()
}

public enum DeskRecoveryWording {
    public static let missingLine = "No recovery key yet. If this Mac's Keychain is lost, it's the only way back into the Desk."
    public static let unconfirmedLine = "Your recovery key wasn't confirmed as written down. Make a new one and type part of it back."
    public static let makeButton = "Make Recovery Key…"
    public static let restoreButton = "Restore With Recovery Key…"
    public static let showTitle = "Write Down Your Recovery Key"
    public static let showDetail = """
    Write these 55 characters on paper and keep them somewhere safe. If this Mac's Keychain is lost, or you move to \
    a new Mac, they're the only way back into the Desk. True Convo never saves them and never shows them again.
    """
    public static let notDurableNote = "The Mac couldn't fully confirm the save. Write it down anyway, and make a new one later."
    public static let wroteItDown = "I Wrote It Down"
    public static let checkTitle = "Check Your Recovery Key"
    public static let checkRetry = "That didn't match. Look at what you wrote and try again."
    public static let check = "Check"
    public static let showAgain = "Show It Again"
    public static let restoreTitle = "Restore the Desk"
    public static let restoreDetail = "Type your recovery key. Case, spaces and dashes don't matter."
    public static let restore = "Restore"
    public static let malformed = "That isn't a recovery key. Check each group of five."
    public static let wrongKey = "That recovery key doesn't open this Desk. Nothing was changed."
    public static let noCopy = "This Desk has no recovery key saved, so it can't be restored here."
    public static let failed = "The Desk couldn't be restored. Nothing was changed."
    public static let cancel = "Cancel"
    public static let makeFailed = "Couldn't make a recovery key. Nothing was changed; try again."
    public static let confirmNotSaved = "The Mac couldn't save that you confirmed the key. Make a new one and try again."
}

/// The real dialogs: sheets on the Desk window.
@MainActor
public final class SheetRecoveryKeyPrompt: DeskRecoveryKeyPrompting {
    /// The open sheet and the response that means Cancel for it.
    private var open: (alert: NSAlert, window: NSWindow, cancel: NSApplication.ModalResponse)?

    public init() {}

    private func run(_ alert: NSAlert, in window: NSWindow, cancel: NSApplication.ModalResponse) async -> NSApplication.ModalResponse {
        dismiss()
        return await withCheckedContinuation { continuation in
            open = (alert, window, cancel)
            alert.beginSheetModal(for: window) { [weak self, weak alert] response in
                MainActor.assumeIsolated {
                    if let self, let alert, self.open?.alert === alert { self.open = nil }
                }
                continuation.resume(returning: response)
            }
        }
    }

    public func dismiss() {
        guard let (alert, window, cancel) = open else { return }
        open = nil
        window.endSheet(alert.window, returnCode: cancel)
    }

    private static func field(_ placeholder: String, width: CGFloat) -> NSTextField {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: width, height: 24))
        field.placeholderString = placeholder
        field.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
        return field
    }

    public func show(_ displayText: String, durable: Bool, in window: NSWindow) async -> Bool {
        let alert = NSAlert()
        alert.messageText = DeskRecoveryWording.showTitle
        alert.informativeText = DeskRecoveryWording.showDetail + (durable ? "" : "\n\n" + DeskRecoveryWording.notDurableNote)
        let key = NSTextField(wrappingLabelWithString: displayText.replacingOccurrences(of: "-", with: " "))
        key.font = .monospacedSystemFont(ofSize: 17, weight: .semibold)
        key.isSelectable = false
        key.frame = NSRect(x: 0, y: 0, width: 380, height: 52)
        alert.accessoryView = key
        alert.addButton(withTitle: DeskRecoveryWording.wroteItDown)
        alert.addButton(withTitle: DeskRecoveryWording.cancel)
        return await run(alert, in: window, cancel: .alertSecondButtonReturn) == .alertFirstButtonReturn
    }

    public func askBack(_ check: RecoveryKeyCheck, retry: Bool, in window: NSWindow) async -> RecoveryCheckAnswer {
        let alert = NSAlert()
        alert.messageText = DeskRecoveryWording.checkTitle
        alert.informativeText = check.prompt + (retry ? "\n\n" + DeskRecoveryWording.checkRetry : "")
        let entry = RecoveryGroupEntry(check: check)
        alert.accessoryView = entry.view
        alert.addButton(withTitle: DeskRecoveryWording.check)
        alert.addButton(withTitle: DeskRecoveryWording.showAgain)
        alert.addButton(withTitle: DeskRecoveryWording.cancel)
        alert.window.initialFirstResponder = entry.first
        // The app lives in the menu bar: bring it and the Desk forward so
        // the sheet takes the keyboard.
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        let answer = await run(alert, in: window, cancel: .alertThirdButtonReturn)
        let typed = (entry.first.stringValue, entry.second.stringValue)
        entry.clear()
        switch answer {
        case .alertFirstButtonReturn: return .typed(typed.0, typed.1)
        case .alertSecondButtonReturn: return .showAgain
        default: return .cancel
        }
    }

    public func askRestore(problem: String?, in window: NSWindow) async -> String? {
        let alert = NSAlert()
        alert.messageText = DeskRecoveryWording.restoreTitle
        alert.informativeText = DeskRecoveryWording.restoreDetail + (problem.map { "\n\n" + $0 } ?? "")
        let field = Self.field("XXXXX-XXXXX-…", width: 380)
        alert.accessoryView = field
        alert.addButton(withTitle: DeskRecoveryWording.restore)
        alert.addButton(withTitle: DeskRecoveryWording.cancel)
        alert.window.initialFirstResponder = field
        return await run(alert, in: window, cancel: .alertSecondButtonReturn) == .alertFirstButtonReturn ? field.stringValue : nil
    }
}

/// The recovery key check's code entry (step 2 trial, F1): two visible
/// boxes, each labeled with the group it asks for, a line under each that
/// counts the characters typed ("3 of 5"), and the rule about spaces.
/// Laid out with plain frames: in a stack view the boxes had no width, so
/// they were never drawn and typing never reached them.
@MainActor
final class RecoveryGroupEntry: NSObject, NSTextFieldDelegate {
    static func rule(_ length: Int) -> String {
        "Type each group's \(length) characters. Spaces, dashes and capital letters don't matter."
    }

    let view: NSView
    let first: NSTextField
    let second: NSTextField
    let firstProgress: NSTextField
    let secondProgress: NSTextField
    /// The typing rule, under the boxes.
    let rule: NSTextField
    private let check: RecoveryKeyCheck

    init(check: RecoveryKeyCheck) {
        self.check = check
        let width: CGFloat = 340, box: CGFloat = 150, gap: CGFloat = 40
        view = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 128))
        first = Self.box(frame: NSRect(x: 0, y: 62, width: box, height: 30))
        second = Self.box(frame: NSRect(x: box + gap, y: 62, width: box, height: 30))
        firstProgress = Self.small(frame: NSRect(x: 0, y: 42, width: box, height: 16))
        secondProgress = Self.small(frame: NSRect(x: box + gap, y: 42, width: box, height: 16))
        // Two lines, wrapped: on one 11-point line the sentence ran past
        // the dialog and its end was cut off (GrokBot review, ca1a0fd).
        rule = Self.small(frame: NSRect(x: 0, y: 0, width: width, height: 34))
        super.init()
        rule.stringValue = Self.rule(check.groupLength)
        rule.lineBreakMode = .byWordWrapping
        rule.maximumNumberOfLines = 2
        rule.preferredMaxLayoutWidth = width
        rule.cell?.wraps = true
        rule.cell?.truncatesLastVisibleLine = false
        let firstLabel = Self.label("Group \(check.asked[0] + 1)", frame: NSRect(x: 0, y: 96, width: box, height: 18))
        let secondLabel = Self.label("Group \(check.asked[1] + 1)", frame: NSRect(x: box + gap, y: 96, width: box, height: 18))
        for field in [first, second] {
            field.delegate = self
            field.setAccessibilityLabel(field === first ? firstLabel.stringValue : secondLabel.stringValue)
        }
        first.nextKeyView = second
        second.nextKeyView = first
        for subview in [firstLabel, secondLabel, first, second, firstProgress, secondProgress, rule] { view.addSubview(subview) }
        update()
    }

    /// The progress lines, from what is typed now.
    func update() {
        firstProgress.stringValue = check.progress(first.stringValue)
        secondProgress.stringValue = check.progress(second.stringValue)
    }

    /// Forgets what was typed, once it has been read.
    func clear() {
        first.stringValue = ""
        second.stringValue = ""
        update()
    }

    func controlTextDidChange(_ notification: Notification) { update() }

    private static func box(frame: NSRect) -> NSTextField {
        let field = NSTextField(frame: frame)
        field.isEditable = true
        field.isSelectable = true
        field.isBezeled = true
        field.bezelStyle = .roundedBezel
        field.drawsBackground = true
        field.alignment = .center
        field.font = .monospacedSystemFont(ofSize: 18, weight: .medium)
        field.placeholderString = "•••••"
        field.usesSingleLineMode = true
        field.cell?.isScrollable = true
        return field
    }

    private static func label(_ text: String, frame: NSRect) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.frame = frame
        label.font = .systemFont(ofSize: 12, weight: .semibold)
        return label
    }

    private static func small(frame: NSRect) -> NSTextField {
        let label = NSTextField(labelWithString: "")
        label.frame = frame
        label.font = .systemFont(ofSize: 11)
        label.textColor = .secondaryLabelColor
        return label
    }
}
