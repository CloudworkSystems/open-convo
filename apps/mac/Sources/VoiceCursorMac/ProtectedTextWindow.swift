import AppKit
import ArchiveProtection

/// Opens a word-bearing archive file (step 2, PR 4). A sealed file is shown
/// in True Convo's own read-only window and is never written out readable;
/// a file from before this step still opens in its usual app.
enum ArchiveFileOpener {
    /// Opens `url`, or returns a short status line saying why it didn't.
    static func open(_ url: URL, title: String, missing: String) -> String? {
        switch Archive.readWords(url) {
        case .missing:
            return missing
        case .plaintext:
            RunLog.write("archive-file.open.plaintext", url.lastPathComponent)
            NSWorkspace.shared.open(url)
            return nil
        case .opened(let data):
            RunLog.write("archive-file.open.sealed", url.lastPathComponent)
            ProtectedTextWindow.show(title: title, text: String(decoding: data, as: UTF8.self))
            return nil
        case .locked:
            return "Can't open \(title): its key is missing from this Mac's Keychain"
        case .unreadable:
            return "Can't open \(title): the file is damaged"
        }
    }
}

/// A read-only window for one sealed file's words, with Copy All. The words
/// stay in memory only while the window is open.
final class ProtectedTextWindow: NSWindowController, NSWindowDelegate {
    private static var shown: [ProtectedTextWindow] = []

    private let textView = NSTextView()
    private let text: String

    static func show(title: String, text: String) {
        let controller = ProtectedTextWindow(title: title, text: text)
        shown.append(controller)
        controller.showWindow(nil)
        controller.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private init(title: String, text: String) {
        self.text = text
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 560),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
        window.delegate = self
        build(in: window)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    private func build(in window: NSWindow) {
        let content = NSView()
        window.contentView = content

        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        textView.textContainerInset = NSSize(width: 8, height: 8)
        textView.autoresizingMask = [.width]
        textView.isVerticallyResizable = true
        textView.textContainer?.widthTracksTextView = true
        textView.string = text
        scroll.documentView = textView

        let note = NSTextField(labelWithString: "Encrypted on this Mac. Shown here only; nothing readable is saved.")
        note.translatesAutoresizingMaskIntoConstraints = false
        note.textColor = .secondaryLabelColor
        note.font = NSFont.systemFont(ofSize: 11)

        let copy = NSButton(title: "Copy All", target: self, action: #selector(copyAll))
        copy.translatesAutoresizingMaskIntoConstraints = false
        copy.bezelStyle = .rounded

        content.addSubview(scroll)
        content.addSubview(note)
        content.addSubview(copy)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: content.topAnchor, constant: 12),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
            scroll.bottomAnchor.constraint(equalTo: copy.topAnchor, constant: -10),
            copy.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
            copy.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -12),
            note.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            note.centerYAnchor.constraint(equalTo: copy.centerYAnchor),
            note.trailingAnchor.constraint(lessThanOrEqualTo: copy.leadingAnchor, constant: -10),
        ])
    }

    @objc private func copyAll() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func windowWillClose(_ notification: Notification) {
        textView.string = ""
        Self.shown.removeAll { $0 === self }
    }
}
