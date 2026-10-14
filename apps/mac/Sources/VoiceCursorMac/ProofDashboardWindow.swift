import AppKit

final class ProofDashboardWindowController: NSWindowController {
    private let textView = NSTextView()
    private let statusLabel = NSTextField(labelWithString: "")
    private let openStartHere: () -> Void
    private let openPhase2EvidenceReceipt: () -> Void
    private let openCrossAppTargets: () -> Void
    private let openLiveProofSummary: () -> Void
    private let openLiveTestGuide: () -> Void
    private let openFirstRunChecklist: () -> Void
    private let openScratchpad: () -> Void
    private let openLiveTranscript: () -> Void
    private let copyGuidedAcceptanceCommand: () -> Void
    private let recordProof: (String) -> Void

    init(
        openStartHere: @escaping () -> Void,
        openPhase2EvidenceReceipt: @escaping () -> Void,
        openCrossAppTargets: @escaping () -> Void,
        openLiveProofSummary: @escaping () -> Void,
        openLiveTestGuide: @escaping () -> Void,
        openFirstRunChecklist: @escaping () -> Void,
        openScratchpad: @escaping () -> Void,
        openLiveTranscript: @escaping () -> Void,
        copyGuidedAcceptanceCommand: @escaping () -> Void,
        recordProof: @escaping (String) -> Void
    ) {
        self.openStartHere = openStartHere
        self.openPhase2EvidenceReceipt = openPhase2EvidenceReceipt
        self.openCrossAppTargets = openCrossAppTargets
        self.openLiveProofSummary = openLiveProofSummary
        self.openLiveTestGuide = openLiveTestGuide
        self.openFirstRunChecklist = openFirstRunChecklist
        self.openScratchpad = openScratchpad
        self.openLiveTranscript = openLiveTranscript
        self.copyGuidedAcceptanceCommand = copyGuidedAcceptanceCommand
        self.recordProof = recordProof

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 820, height: 620),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "True Convo Proof Dashboard"
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

        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .bezelBorder
        textView.isEditable = false
        textView.isRichText = false
        textView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        textView.textContainerInset = NSSize(width: 10, height: 10)
        scrollView.documentView = textView
        scrollView.heightAnchor.constraint(greaterThanOrEqualToConstant: 430).isActive = true
        stack.addArrangedSubview(scrollView)

        let buttonRows = NSStackView()
        buttonRows.orientation = .vertical
        buttonRows.spacing = 8

        let rowOne = NSStackView()
        rowOne.orientation = .horizontal
        rowOne.spacing = 8
        rowOne.addArrangedSubview(button("Refresh", #selector(refresh)))
        rowOne.addArrangedSubview(button("Open Start Here", #selector(showStartHere)))
        rowOne.addArrangedSubview(button("Evidence Receipt", #selector(showPhase2EvidenceReceipt)))
        rowOne.addArrangedSubview(button("Cross-App Targets", #selector(showCrossAppTargets)))
        rowOne.addArrangedSubview(button("Proof Summary", #selector(showProofSummary)))
        rowOne.addArrangedSubview(button("Live Test Guide", #selector(showLiveTestGuide)))
        rowOne.addArrangedSubview(button("First Run", #selector(showFirstRunChecklist)))
        rowOne.addArrangedSubview(button("Close", #selector(closeWindow)))
        buttonRows.addArrangedSubview(rowOne)

        let rowTwo = NSStackView()
        rowTwo.orientation = .horizontal
        rowTwo.spacing = 8
        rowTwo.addArrangedSubview(button("Scratchpad", #selector(showScratchpad)))
        rowTwo.addArrangedSubview(button("Live Transcript", #selector(showLiveTranscript)))
        rowTwo.addArrangedSubview(button("Record Safe", #selector(recordSafe)))
        rowTwo.addArrangedSubview(button("Record Paste", #selector(recordPaste)))
        rowTwo.addArrangedSubview(button("Record Reprocess", #selector(recordReprocess)))
        rowTwo.addArrangedSubview(button("Record Live Paste", #selector(recordLivePaste)))
        rowTwo.addArrangedSubview(button("Record Realtime", #selector(recordRealtimeTarget)))
        buttonRows.addArrangedSubview(rowTwo)

        let rowThree = NSStackView()
        rowThree.orientation = .horizontal
        rowThree.spacing = 8
        rowThree.addArrangedSubview(button("Copy Guided Acceptance", #selector(copyGuidedAcceptance)))
        buttonRows.addArrangedSubview(rowThree)

        stack.addArrangedSubview(buttonRows)
    }

    @objc private func refresh() {
        do {
            let url = try Archive.writeStartHereReport()
            textView.string = Archive.readWordsText(url) ?? ""
            statusLabel.stringValue = "Refreshed \(Archive.startHere.path)"
            RunLog.write("proof-dashboard.refreshed", url.path)
        } catch {
            textView.string = "Proof dashboard failed: \(error.localizedDescription)"
            statusLabel.stringValue = "Refresh failed"
            RunLog.write("proof-dashboard.refresh.failed", error.localizedDescription)
        }
    }

    @objc private func showStartHere() {
        openStartHere()
        refresh()
    }

    @objc private func showPhase2EvidenceReceipt() {
        openPhase2EvidenceReceipt()
        refresh()
    }

    @objc private func showCrossAppTargets() {
        openCrossAppTargets()
        refresh()
    }

    @objc private func showProofSummary() {
        openLiveProofSummary()
        refresh()
    }

    @objc private func showLiveTestGuide() {
        openLiveTestGuide()
    }

    @objc private func showFirstRunChecklist() {
        openFirstRunChecklist()
    }

    @objc private func showScratchpad() {
        openScratchpad()
    }

    @objc private func showLiveTranscript() {
        openLiveTranscript()
    }

    @objc private func copyGuidedAcceptance() {
        copyGuidedAcceptanceCommand()
        statusLabel.stringValue = "Copied guided acceptance command"
    }

    @objc private func recordSafe() {
        recordProof("safe")
        refresh()
    }

    @objc private func recordPaste() {
        recordProof("paste")
        refresh()
    }

    @objc private func recordReprocess() {
        recordProof("reprocess")
        refresh()
    }

    @objc private func recordLivePaste() {
        recordProof("live-paste")
        refresh()
    }

    @objc private func recordRealtimeTarget() {
        recordProof("realtime-target")
        refresh()
    }

    @objc private func closeWindow() {
        window?.close()
    }

    private func button(_ title: String, _ action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.bezelStyle = .rounded
        return button
    }
}
