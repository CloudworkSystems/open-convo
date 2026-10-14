import AppKit
import VoiceCursorCore

final class ArchiveHistoryWindowController: NSWindowController, NSTableViewDataSource, NSTableViewDelegate {
    private let tableView = NSTableView()
    private let detailView = NSTextView()
    private let statusLabel = NSTextField(labelWithString: "")
    private let isDictationBusy: () -> Bool
    private var entries: [ArchiveEntry] = []
    private let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter
    }()
    private let isoFormatter = ISO8601DateFormatter()

    init(isDictationBusy: @escaping () -> Bool = { false }) {
        self.isDictationBusy = isDictationBusy
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 820, height: 620),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "True Convo Archive"
        window.center()
        super.init(window: window)
        buildContent()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func showWindow(_ sender: Any?) {
        refresh()
        super.showWindow(sender)
        window?.makeKeyAndOrderFront(sender)
        NSApp.activate(ignoringOtherApps: true)
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

        statusLabel.textColor = .secondaryLabelColor
        statusLabel.font = .systemFont(ofSize: 12)
        stack.addArrangedSubview(statusLabel)

        let splitView = NSSplitView()
        splitView.isVertical = true
        splitView.dividerStyle = .thin
        splitView.translatesAutoresizingMaskIntoConstraints = false
        splitView.heightAnchor.constraint(greaterThanOrEqualToConstant: 500).isActive = true

        tableView.delegate = self
        tableView.dataSource = self
        tableView.usesAlternatingRowBackgroundColors = true
        tableView.headerView = nil
        tableView.addTableColumn(column("date", width: 115))
        tableView.addTableColumn(column("provider", width: 85))
        tableView.addTableColumn(column("text", width: 230))

        let tableScroll = NSScrollView()
        tableScroll.hasVerticalScroller = true
        tableScroll.borderType = .bezelBorder
        tableScroll.documentView = tableView
        splitView.addArrangedSubview(tableScroll)

        let detailScroll = NSScrollView()
        detailScroll.hasVerticalScroller = true
        detailScroll.borderType = .bezelBorder
        detailView.isEditable = false
        detailView.isRichText = false
        detailView.font = .systemFont(ofSize: 14)
        detailView.textContainerInset = NSSize(width: 10, height: 10)
        detailScroll.documentView = detailView
        splitView.addArrangedSubview(detailScroll)
        stack.addArrangedSubview(splitView)

        tableScroll.widthAnchor.constraint(greaterThanOrEqualToConstant: 320).isActive = true
        detailScroll.widthAnchor.constraint(greaterThanOrEqualToConstant: 360).isActive = true

        let buttonRows = NSStackView()
        buttonRows.orientation = .vertical
        buttonRows.spacing = 8

        let copyButtons = NSStackView()
        copyButtons.orientation = .horizontal
        copyButtons.spacing = 8
        copyButtons.addArrangedSubview(button("Refresh", #selector(refresh)))
        copyButtons.addArrangedSubview(button("Copy Text", #selector(copyText)))
        copyButtons.addArrangedSubview(button("Copy Markdown", #selector(copyMarkdown)))
        copyButtons.addArrangedSubview(button("Copy Content Packet", #selector(copyContentPacket)))
        buttonRows.addArrangedSubview(copyButtons)

        let fileButtons = NSStackView()
        fileButtons.orientation = .horizontal
        fileButtons.spacing = 8
        fileButtons.addArrangedSubview(button("Open Transcript", #selector(openTranscript)))
        fileButtons.addArrangedSubview(button("Open Packet", #selector(openContentPacket)))
        fileButtons.addArrangedSubview(button("Reveal Audio", #selector(revealAudio)))
        fileButtons.addArrangedSubview(button("Reprocess Selected", #selector(reprocessSelected)))
        fileButtons.addArrangedSubview(button("Open Archive", #selector(openArchive)))
        fileButtons.addArrangedSubview(button("Close", #selector(closeWindow)))
        buttonRows.addArrangedSubview(fileButtons)

        stack.addArrangedSubview(buttonRows)
    }

    private func column(_ id: String, width: CGFloat) -> NSTableColumn {
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
        column.width = width
        return column
    }

    private func button(_ title: String, _ action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        return button
    }

    @objc private func refresh() {
        entries = Array(Archive.readHistory().reversed())
        tableView.reloadData()
        let notShown = Archive.historyLinesNotShown
        var status = entries.isEmpty
            ? "No archived sessions yet."
            : "\(entries.count) archived sessions in \(Archive.history.path)"
        if notShown > 0 {
            status += Archive.currentSeal() == nil
                ? " \(notShown) more are locked: the archive's key is missing from this Mac's Keychain."
                : " \(notShown) more can't be read."
        }
        statusLabel.stringValue = status
        if entries.isEmpty {
            detailView.string = ""
        } else {
            tableView.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
            updateDetail()
        }
    }

    func numberOfRows(in tableView: NSTableView) -> Int {
        entries.count
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row >= 0, row < entries.count else {
            return nil
        }
        let entry = entries[row]
        let id = tableColumn?.identifier.rawValue ?? "text"
        let text: String
        switch id {
        case "date":
            text = displayDate(entry.timestamp)
        case "provider":
            text = entry.provider
        default:
            text = snippet(entry.text)
        }

        let identifier = NSUserInterfaceItemIdentifier(id)
        let cell = tableView.makeView(withIdentifier: identifier, owner: self) as? NSTableCellView
            ?? makeCell(identifier)
        cell.textField?.stringValue = text
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        updateDetail()
    }

    private func makeCell(_ identifier: NSUserInterfaceItemIdentifier) -> NSTableCellView {
        let cell = NSTableCellView()
        cell.identifier = identifier

        let field = NSTextField(labelWithString: "")
        field.translatesAutoresizingMaskIntoConstraints = false
        field.lineBreakMode = .byTruncatingTail
        cell.addSubview(field)
        cell.textField = field

        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6),
            field.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -6),
            field.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])

        return cell
    }

    private func selectedEntry() -> ArchiveEntry? {
        let row = tableView.selectedRow
        guard row >= 0, row < entries.count else {
            return nil
        }
        return entries[row]
    }

    private func updateDetail() {
        guard let entry = selectedEntry() else {
            detailView.string = ""
            return
        }
        detailView.string = [
            "ID: \(entry.id)",
            "Timestamp: \(entry.timestamp)",
            "Duration: \(String(format: "%.1f", Double(entry.durationMs) / 1000.0))s",
            "Provider: \(entry.provider)",
            "Model: \(entry.model)",
            "Language: \(entry.language)",
            "Derived from: \(entry.derivedFromSessionId ?? "none")",
            "Capture mode: \(entry.captureMode ?? "unknown")",
            "Audio: \(entry.audioPath ?? "none")",
            "Content packet: \(entry.contentPacketPath ?? Archive.contentPacketURL(for: entry.id).path)",
            "Injected: \(entry.injected ? "yes" : "no")",
            "",
            entry.text.isEmpty ? "(empty)" : entry.text,
        ].joined(separator: "\n")
    }

    @objc private func copyText() {
        guard let entry = selectedEntry() else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(entry.text, forType: .string)
        statusLabel.stringValue = "Copied transcript text."
    }

    @objc private func copyMarkdown() {
        guard let entry = selectedEntry() else { return }
        let url = Archive.transcriptURL(for: entry.id)
        let markdown = Archive.readWordsText(url) ?? detailView.string
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(markdown, forType: .string)
        statusLabel.stringValue = "Copied transcript Markdown."
    }

    @objc private func copyContentPacket() {
        guard let entry = selectedEntry() else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(Archive.contentPacketBody(for: entry), forType: .string)
        statusLabel.stringValue = "Copied content packet."
    }

    @objc private func openTranscript() {
        guard let entry = selectedEntry() else { return }
        let url = Archive.transcriptURL(for: entry.id)
        if let problem = ArchiveFileOpener.open(url, title: "Transcript", missing: "Transcript file is missing for \(entry.id).") {
            statusLabel.stringValue = problem
        }
    }

    @objc private func openContentPacket() {
        guard let entry = selectedEntry() else { return }
        let url = entry.contentPacketPath.map(URL.init(fileURLWithPath:)) ?? Archive.contentPacketURL(for: entry.id)
        if let problem = ArchiveFileOpener.open(url, title: "Content Packet", missing: "Content packet file is missing for \(entry.id).") {
            statusLabel.stringValue = problem
        }
    }

    @objc private func revealAudio() {
        guard let path = selectedEntry()?.audioPath else {
            statusLabel.stringValue = "This session has no retained audio path."
            return
        }
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: url.path) else {
            statusLabel.stringValue = "Audio file is missing at \(path)."
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    @objc private func reprocessSelected() {
        guard !isDictationBusy() else {
            statusLabel.stringValue = "Stop dictation before reprocessing audio."
            return
        }

        guard let entry = selectedEntry() else { return }
        let provider = Settings.provider
        guard provider != .appleLocal, provider != .appleSpeechAnalyzer else {
            statusLabel.stringValue = "Choose Local Whisper, OpenAI, or Groq before reprocessing."
            RunLog.write("archive-history.reprocess.blocked", "reason=\(provider.rawValue)-provider id=\(entry.id)")
            return
        }
        guard let audioPath = entry.audioPath, !audioPath.isEmpty else {
            statusLabel.stringValue = "This session has no retained audio path."
            return
        }

        let audioURL = URL(fileURLWithPath: audioPath)
        guard FileManager.default.fileExists(atPath: audioURL.path) else {
            statusLabel.stringValue = "Audio file is missing at \(audioPath)."
            RunLog.write("archive-history.reprocess.blocked", "reason=missing-audio id=\(entry.id) path=\(audioURL.path)")
            return
        }

        let language = entry.language.isEmpty ? Settings.language : entry.language
        statusLabel.stringValue = "Reprocessing \(entry.id) with \(provider.label)..."
        RunLog.write("archive-history.reprocess.requested", "from=\(entry.id) provider=\(provider.rawValue) audio=\(audioURL.path)")

        Task { @MainActor [weak self] in
            do {
                let reprocessStartedAt = Date()
                let result = try await TranscriptionService.transcribe(
                    provider: provider,
                    audioURL: audioURL,
                    language: language
                )
                let transcriptionMs = milliseconds(between: reprocessStartedAt, and: Date())
                // Saved fixes use the archived session's app and language,
                // not today's settings.
                let cleanedText = SavedCorrections.preview(
                    cleanedDictationText(result.text),
                    targetBundleID: entry.target?.bundleIdentifier,
                    language: language
                )
                let id = "voice-cursor-reprocess-\(Int(Date().timeIntervalSince1970 * 1000))"
                let reprocessed = ArchiveEntry(
                    id: id,
                    timestamp: ISO8601DateFormatter().string(from: Date()),
                    durationMs: entry.durationMs,
                    text: cleanedText,
                    audioPath: audioURL.path,
                    contentPacketPath: Archive.contentPacketURL(for: id).path,
                    derivedFromSessionId: entry.id,
                    captureMode: "reprocess",
                    timing: ArchiveTiming(
                        liveFirstPartialMs: nil,
                        liveFirstFinalMs: nil,
                        postStopTranscriptionMs: transcriptionMs,
                        archiveFinalizeMs: nil,
                        totalStopProcessingMs: milliseconds(between: reprocessStartedAt, and: Date())
                    ),
                    provider: provider.rawValue,
                    model: result.model,
                    language: language,
                    source: "voice-cursor-mac-prototype",
                    injected: false,
                    target: entry.target,
                    correction: nil
                )
                try Archive.append(reprocessed)
                RunLog.write(
                    "archive-history.reprocess.wrote",
                    "id=\(id) from=\(entry.id) provider=\(provider.rawValue) packet=\(Archive.contentPacketURL(for: id).path)"
                )
                self?.refresh()
                self?.statusLabel.stringValue = "Reprocessed \(entry.id) with \(provider.label)."
            } catch {
                RunLog.write("archive-history.reprocess.failed", "from=\(entry.id) provider=\(provider.rawValue) error=\(error.localizedDescription)")
                self?.statusLabel.stringValue = "Reprocess failed: \(error.localizedDescription)"
            }
        }
    }

    @objc private func openArchive() {
        NSWorkspace.shared.open(Archive.root)
    }

    @objc private func closeWindow() {
        window?.close()
    }

    private func displayDate(_ timestamp: String) -> String {
        if let date = isoFormatter.date(from: timestamp) {
            return dateFormatter.string(from: date)
        }
        return timestamp
    }

    private func snippet(_ text: String) -> String {
        let cleaned = text
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleaned.count > 80 else {
            return cleaned.isEmpty ? "(empty)" : cleaned
        }
        return String(cleaned.prefix(77)) + "..."
    }
}
