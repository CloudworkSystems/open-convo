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
        let first = Self.field("Group \(check.asked[0] + 1)", width: 120)
        let second = Self.field("Group \(check.asked[1] + 1)", width: 120)
        let row = NSStackView(views: [first, second])
        row.orientation = .horizontal
        row.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        alert.accessoryView = row
        alert.addButton(withTitle: DeskRecoveryWording.check)
        alert.addButton(withTitle: DeskRecoveryWording.showAgain)
        alert.addButton(withTitle: DeskRecoveryWording.cancel)
        alert.window.initialFirstResponder = first
        switch await run(alert, in: window, cancel: .alertThirdButtonReturn) {
        case .alertFirstButtonReturn: return .typed(first.stringValue, second.stringValue)
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
