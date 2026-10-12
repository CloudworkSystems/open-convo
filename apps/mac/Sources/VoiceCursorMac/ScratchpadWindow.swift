import AppKit

final class ScratchpadWindowController: NSWindowController {
    private let textView = NSTextView()

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 300),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "True Convo Scratchpad"
        window.minSize = NSSize(width: 420, height: 240)
        window.center()
        super.init(window: window)
        buildContent()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func showWindow(_ sender: Any?) {
        super.showWindow(sender)
        window?.makeKeyAndOrderFront(sender)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeFirstResponder(textView)
    }

    func updateDictationState(isRecording: Bool, isBusy: Bool) {
        _ = isRecording
        _ = isBusy
    }

    private func buildContent() {
        guard let contentView = window?.contentView else { return }

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -14),
            stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -14),
        ])

        let hint = NSTextField(labelWithString: "Place the cursor below, then use Cmd+D to test True Convo paste.")
        hint.textColor = .secondaryLabelColor
        hint.font = .systemFont(ofSize: 12)
        stack.addArrangedSubview(hint)

        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .bezelBorder
        textView.isEditable = true
        textView.isRichText = false
        textView.font = .systemFont(ofSize: 15)
        textView.string = ""
        scrollView.documentView = textView
        scrollView.heightAnchor.constraint(greaterThanOrEqualToConstant: 170).isActive = true
        stack.addArrangedSubview(scrollView)

        let buttons = NSStackView()
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let clearButton = NSButton(title: "Clear", target: self, action: #selector(clear))
        clearButton.bezelStyle = .rounded
        clearButton.toolTip = "Clear the scratchpad text."
        let copyButton = NSButton(title: "Copy", target: self, action: #selector(copyText))
        copyButton.bezelStyle = .rounded
        copyButton.toolTip = "Copy the scratchpad text to the clipboard."
        let closeButton = NSButton(title: "Close", target: self, action: #selector(closeWindow))
        closeButton.bezelStyle = .rounded
        closeButton.toolTip = "Close this scratchpad window."
        buttons.addArrangedSubview(clearButton)
        buttons.addArrangedSubview(copyButton)
        buttons.addArrangedSubview(closeButton)
        stack.addArrangedSubview(buttons)
    }

    @objc private func clear() {
        textView.string = ""
        window?.makeFirstResponder(textView)
    }

    @objc private func copyText() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(textView.string, forType: .string)
    }

    @objc private func closeWindow() {
        window?.close()
    }
}
