import AppKit
import VoiceCursorCore

private enum ConvoBrand {
    static let ink = NSColor(calibratedRed: 0.035, green: 0.028, blue: 0.055, alpha: 1.0)
    static let inkLift = NSColor(calibratedRed: 0.075, green: 0.055, blue: 0.11, alpha: 1.0)
    static let purple = NSColor(calibratedRed: 0.49, green: 0.18, blue: 0.82, alpha: 1.0)
    static let violet = NSColor(calibratedRed: 0.72, green: 0.20, blue: 0.84, alpha: 1.0)
    static let magenta = NSColor(calibratedRed: 0.92, green: 0.18, blue: 0.62, alpha: 1.0)
    static let amber = NSColor(calibratedRed: 1.0, green: 0.61, blue: 0.18, alpha: 1.0)
    static let hotAmber = NSColor(calibratedRed: 1.0, green: 0.38, blue: 0.10, alpha: 1.0)
}

enum OutcomeTone {
    case success
    case notice
    case warning
}

/// What actually happened to the dictated text once a session settled.
/// The controller computes this at the same points it archives the session,
/// so the pill can finally tell the user instead of only telling the run log.
indirect enum DictationOutcome {
    case inserted
    case insertedAndSubmitted
    case pasteUnconfirmed
    /// A safety stop kept the text from being typed, and nothing was typed.
    case savedNotPasted(clipboardFallback: Bool)
    /// A safety stop kept the finished version from replacing the live words
    /// already typed in the app.
    case liveWordsKept(fullVersionOnClipboard: Bool)
    case copiedToClipboard
    case copiedNeedsAccessibility
    case archivedOnly
    case noSpeech
    /// No text because the speech engine failed or wasn't ready; carries the
    /// plain reason so the pill doesn't blame the microphone.
    case engineProblem(String)
    /// Apple On-Device (New) stopped before it finished, so the text may be
    /// missing words. It was never sent with an automatic Return; `delivered`
    /// says where it went.
    case partialText(delivered: DictationOutcome)
    /// The Desk window was in front at the last moment, so its shield held
    /// back a paste, typing or Return meant for the outside app (Desk
    /// window, build 9). Shown instead of an outcome that claimed it.
    case deskInFront(DeskDictationPolicy.ShieldNote)
    /// A Desk recording (step 1, PR 2b): where its words went. Nothing was
    /// pasted, typed, copied or sent.
    case desk(DeskDictationPolicy.DeskDelivery)

    var pillMessage: String {
        switch self {
        case .partialText(let delivered):
            return "Partial text: Apple's engine didn't finish — \(delivered.partialDeliveryNote)"
        case .inserted: return "Pasted ✓"
        case .insertedAndSubmitted: return "Pasted + sent ✓"
        case .pasteUnconfirmed: return "Paste not confirmed — text is on your clipboard (⌘V)"
        case .savedNotPasted(true): return DictationOutcome.clipboardNote
        case .savedNotPasted(false): return "Not pasted — your clipboard was kept. Menu: Copy Last Dictation"
        case .liveWordsKept(true): return "Live words kept — full version is on the clipboard"
        case .liveWordsKept(false): return "Live words kept — full version is in Copy Last Dictation"
        case .copiedToClipboard: return "Copied ✓"
        case .copiedNeedsAccessibility: return "Copied — enable Accessibility"
        case .archivedOnly: return "Archived ✓"
        case .noSpeech: return "No speech heard"
        case .engineProblem(let message): return message
        case .deskInFront(let note): return note.pillMessage
        case .desk(let delivery): return DeskDictationPolicy.pillMessage(for: delivery)
        }
    }

    /// Where partial text went, in a few plain words.
    private var partialDeliveryNote: String {
        switch self {
        case .inserted, .insertedAndSubmitted: return "pasted, not sent"
        case .pasteUnconfirmed, .savedNotPasted(true), .liveWordsKept(true): return "it's on your clipboard (⌘V)"
        case .copiedToClipboard: return "copied"
        case .copiedNeedsAccessibility: return "copied; enable Accessibility"
        case .savedNotPasted(false), .liveWordsKept(false): return "it's in Copy Last Dictation"
        case .archivedOnly, .noSpeech, .engineProblem, .partialText: return "saved in history"
        case .deskInFront(let note): return note.partialDeliveryNote
        case .desk(.sentToDraft): return "added to your Desk draft"
        case .desk(.setAside): return "kept in the Desk window"
        case .desk(.notKept): return "not kept; the Desk closed"
        }
    }

    /// Shown when the safety stop kept text from being pasted and put it on
    /// the clipboard instead (The owner's choice: keep the stop, say so clearly).
    static let clipboardNote = "Saved to clipboard — press Cmd+V to paste"

    /// Shown even if the pill was hidden: text that went nowhere visible, any
    /// time True Convo replaced what was on the clipboard, and partial text.
    var mustBeSeen: Bool {
        switch self {
        case .savedNotPasted, .liveWordsKept(true), .partialText, .deskInFront, .desk(.setAside), .desk(.notKept): return true
        default: return false
        }
    }

    var tone: OutcomeTone {
        switch self {
        case .inserted, .insertedAndSubmitted, .copiedToClipboard, .archivedOnly, .desk(.sentToDraft):
            return .success
        case .desk(.setAside), .desk(.notKept):
            return .warning
        case .pasteUnconfirmed:
            return .warning
        case .noSpeech:
            return .notice
        case .savedNotPasted, .liveWordsKept, .copiedNeedsAccessibility, .engineProblem, .partialText, .deskInFront:
            return .warning
        }
    }

    /// Warnings linger long enough to read; successes get out of the way.
    var lingerSeconds: TimeInterval {
        if mustBeSeen { return 9.0 }
        switch tone {
        case .success: return 1.5
        case .notice: return 2.5
        case .warning: return 6.0
        }
    }

    var logDetail: String {
        switch self {
        case .inserted: return "outcome=inserted"
        case .insertedAndSubmitted: return "outcome=inserted-and-submitted"
        case .pasteUnconfirmed: return "outcome=paste-unconfirmed clipboardFallback=true"
        case .savedNotPasted(let clipboard): return "outcome=saved-not-pasted clipboardFallback=\(clipboard)"
        case .liveWordsKept(let clipboard): return "outcome=live-words-kept clipboardFallback=\(clipboard)"
        case .copiedToClipboard: return "outcome=copied-to-clipboard"
        case .copiedNeedsAccessibility: return "outcome=copied-needs-accessibility"
        case .archivedOnly: return "outcome=archived-only"
        case .noSpeech: return "outcome=no-speech"
        case .engineProblem: return "outcome=engine-problem"
        case .partialText(let delivered):
            return "outcome=partial-text delivered=(\(delivered.logDetail))"
        case .deskInFront(let note):
            return "outcome=desk-in-front \(note.logDetail)"
        case .desk(let delivery):
            switch delivery {
            case .sentToDraft: return "outcome=desk-sent-to-draft"
            case .setAside: return "outcome=desk-set-aside"
            case .notKept: return "outcome=desk-not-kept"
            }
        }
    }

    /// The outcome to show instead, when the Desk shield held back what this
    /// outcome claims (a paste, typing, or the Return of "Pasted + sent");
    /// nil when it stays true.
    func correctedForDeskShield(_ heldBack: Set<DeskDictationPolicy.ShieldedInput>) -> DictationOutcome? {
        switch self {
        case .partialText(let delivered):
            return delivered.correctedForDeskShield(heldBack).map { .partialText(delivered: $0) }
        case .inserted, .insertedAndSubmitted:
            let claimsSent: Bool
            if case .insertedAndSubmitted = self { claimsSent = true } else { claimsSent = false }
            guard DeskDictationPolicy.shieldContradicts(claimsInserted: true, claimsSent: claimsSent, heldBack: heldBack),
                  let note = DeskDictationPolicy.shieldNote(heldBack: heldBack)
            else { return nil }
            return .deskInFront(note)
        default:
            return nil
        }
    }
}

private enum CursorWidgetState: Equatable {
    case idle
    case listening
    case processing
    case correcting
    case guarded
    case outcome(OutcomeTone)
}

private enum MeterPresentation {
    case outlineRays
    case coreMeter
}

private enum PillLayout {
    static let rayInsetX: CGFloat = 0
    static let rayInsetY: CGFloat = 0

    static func bodyRect(in bounds: NSRect) -> NSRect {
        bounds.insetBy(dx: rayInsetX, dy: rayInsetY)
    }
}

private final class PillBackgroundView: NSView {
    var state: CursorWidgetState = .idle {
        didSet { needsDisplay = true }
    }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let body = PillLayout.bodyRect(in: bounds)
        let radius = body.height / 2
        let pill = NSBezierPath(roundedRect: body, xRadius: radius, yRadius: radius)

        let gradient = NSGradient(colors: [
            ConvoBrand.inkLift,
            ConvoBrand.ink,
        ])
        gradient?.draw(in: pill, angle: 90)

        NSColor.black.withAlphaComponent(0.42).setStroke()
        pill.lineWidth = 1
        pill.stroke()

        // Each state gets a visually distinct border so "still working" can never
        // be mistaken for "listening" or "done". Processing is deliberately violet,
        // not amber, because that confusion is exactly the bug this fixes.
        let spec: (color: NSColor, alpha: CGFloat, width: CGFloat)
        switch state {
        case .idle: spec = (ConvoBrand.amber, 0.26, 1)
        case .listening: spec = (ConvoBrand.amber, 0.72, 1)
        case .processing: spec = (ConvoBrand.purple, 0.95, 1.6)
        case .correcting: spec = (ConvoBrand.magenta, 0.95, 1.6)
        case .guarded: spec = (ConvoBrand.hotAmber, 0.88, 1.6)
        case .outcome(.success): spec = (ConvoBrand.amber, 0.9, 1.6)
        case .outcome(.notice): spec = (ConvoBrand.violet, 0.9, 1.6)
        case .outcome(.warning): spec = (ConvoBrand.hotAmber, 0.95, 1.8)
        }
        let accent = NSBezierPath(roundedRect: body.insetBy(dx: 0.75, dy: 0.75), xRadius: radius, yRadius: radius)
        spec.color.withAlphaComponent(spec.alpha).setStroke()
        accent.lineWidth = spec.width
        accent.stroke()
    }
}

final class DecibelMeterView: NSView {
    private var presentation: MeterPresentation = .coreMeter
    private var energy = 0.0
    private var targetEnergy = 0.0
    private var peak = 0.0
    private var spectrumBars = Array(repeating: CGFloat(0), count: 42)
    private var targetSpectrumBars = Array(repeating: CGFloat(0), count: 42)
    private var animationTimer: Timer?
    private var lastInputAt = Date.distantPast
    var isActive = false {
        didSet { needsDisplay = true }
    }

    override var isFlipped: Bool { true }

    deinit {
        animationTimer?.invalidate()
    }

    func push(level newLevel: Double) {
        push(spectrum: [], level: newLevel)
    }

    func push(spectrum newBars: [CGFloat], level newLevel: Double) {
        let clamped = min(max(newLevel, 0), 1)
        let amplitudeGain = Settings.scopeAmplitudeGain
        let gate = 0.14
        let gated = clamped <= gate ? 0 : (clamped - gate) / (1 - gate)
        targetEnergy = gated <= 0 ? 0 : min(1, pow(gated, 0.30) * 1.85 * amplitudeGain)
        targetSpectrumBars = normalizedSpectrumBars(newBars).enumerated().map { index, value in
            let accent = 0.86 + CGFloat(sin(Double(index) * 1.91)) * 0.10
            return min(1, max(0, value * CGFloat(max(0.10, targetEnergy)) * accent))
        }

        if targetEnergy > 0.01 {
            lastInputAt = Date()
            isActive = true
            startAnimation()
        } else if animationTimer == nil {
            animateFrame()
        }
    }

    func reset() {
        animationTimer?.invalidate()
        animationTimer = nil
        energy = 0
        targetEnergy = 0
        peak = 0
        spectrumBars = Array(repeating: 0, count: spectrumBars.count)
        targetSpectrumBars = Array(repeating: 0, count: targetSpectrumBars.count)
        isActive = false
        needsDisplay = true
    }

    private func startAnimation() {
        guard animationTimer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.animateFrame()
        }
        RunLoop.main.add(timer, forMode: .common)
        animationTimer = timer
    }

    private func animateFrame() {
        let isStale = Date().timeIntervalSince(lastInputAt) > 0.18
        let desiredEnergy = isStale ? 0 : targetEnergy
        let energyResponse = desiredEnergy > energy ? 0.92 : 0.34
        energy += (desiredEnergy - energy) * energyResponse
        peak = max(energy, peak * 0.74)

        let speed = max(0.6, Settings.scopeSweepSpeed)
        let attack = min(0.62, CGFloat(0.22 + speed / 130.0))
        let release: CGFloat = 0.24
        if isStale {
            targetSpectrumBars = Array(repeating: 0, count: targetSpectrumBars.count)
        }

        for index in spectrumBars.indices {
            let target = targetSpectrumBars[index]
            let current = spectrumBars[index]
            let response = target > current ? attack : release
            spectrumBars[index] = current + (target - current) * response
        }

        if energy < 0.01, peak < 0.01, spectrumBars.allSatisfy({ $0 < 0.01 }) {
            spectrumBars = Array(repeating: 0, count: spectrumBars.count)
            targetSpectrumBars = Array(repeating: 0, count: targetSpectrumBars.count)
            isActive = false
            animationTimer?.invalidate()
            animationTimer = nil
        } else {
            isActive = true
        }

        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        switch presentation {
        case .outlineRays:
            drawOutlineGlow(in: bounds)
            drawSpectrumBars(in: bounds)
        case .coreMeter:
            drawCoreMeter(in: bounds.insetBy(dx: 1, dy: 2))
        }
    }

    private func drawOutlineGlow(in rect: NSRect) {
        guard isActive, peak > 0.02 else { return }
        let body = PillLayout.bodyRect(in: rect)
        let glow = NSBezierPath(
            roundedRect: body.insetBy(dx: -2.4, dy: -2.4),
            xRadius: body.height / 2 + 2.4,
            yRadius: body.height / 2 + 2.4
        )
        ConvoBrand.magenta.withAlphaComponent(0.06 + CGFloat(peak) * 0.08).setStroke()
        glow.lineWidth = 4.5
        glow.stroke()
    }

    private func drawSpectrumBars(in rect: NSRect) {
        guard !spectrumBars.isEmpty else { return }

        let body = PillLayout.bodyRect(in: rect)
        let radius = body.height / 2
        let topOutset = max(1, body.minY - rect.minY - 0.8)
        let bottomOutset = max(1, rect.maxY - body.maxY - 0.8)
        let activeMinX = body.minX + radius * 0.32
        let activeMaxX = body.maxX - radius * 0.32
        let activeWidth = max(1, activeMaxX - activeMinX)
        let gap: CGFloat = 0.72
        let barWidth = max(0.9, min(2.0, (activeWidth - gap * CGFloat(max(0, spectrumBars.count - 1))) / CGFloat(spectrumBars.count)))
        let totalWidth = barWidth * CGFloat(spectrumBars.count) + gap * CGFloat(max(0, spectrumBars.count - 1))
        let startX = body.midX - totalWidth / 2

        for index in spectrumBars.indices {
            let ratio = CGFloat(index) / CGFloat(max(1, spectrumBars.count - 1))
            let amount = max(0.015, spectrumBars[index])
            let x = startX + CGFloat(index) * (barWidth + gap)
            let topHeight = max(0.9, topOutset * (0.14 + amount * 1.02))
            let bottomHeight = max(0.9, bottomOutset * (0.14 + amount * 1.02))
            let color = bandColor(at: ratio)
            let topRay = NSRect(x: x, y: body.minY - topHeight + 0.7, width: barWidth, height: topHeight)
            let bottomRay = NSRect(x: x, y: body.maxY - 0.7, width: barWidth, height: bottomHeight)
            let radius = min(barWidth / 2, 1.2)

            for ray in [topRay, bottomRay] {
                let glow = NSBezierPath(roundedRect: ray.insetBy(dx: -0.8, dy: -1.0 - amount * 1.3), xRadius: radius + 1.0, yRadius: radius + 1.0)
                color.withAlphaComponent(isActive ? 0.12 + amount * 0.22 : 0.05).setFill()
                glow.fill()

                let bar = NSBezierPath(roundedRect: ray, xRadius: radius, yRadius: radius)
                color.withAlphaComponent(isActive ? 0.44 + amount * 0.42 : 0.13).setFill()
                bar.fill()
            }

            if amount > 0.18 {
                drawSpectrumCap(at: NSPoint(x: topRay.midX, y: topRay.minY), color: color, amount: amount)
                drawSpectrumCap(at: NSPoint(x: bottomRay.midX, y: bottomRay.maxY), color: color, amount: amount)
            }
        }
    }

    private func drawCoreMeter(in rect: NSRect) {
        guard !spectrumBars.isEmpty else { return }
        let displayBars = mirroredSpectrumBars()

        let baseline = NSBezierPath()
        baseline.move(to: NSPoint(x: rect.minX, y: rect.midY))
        baseline.line(to: NSPoint(x: rect.maxX, y: rect.midY))
        ConvoBrand.violet.withAlphaComponent(isActive ? 0.28 : 0.10).setStroke()
        baseline.lineWidth = 0.9
        baseline.lineCapStyle = .round
        baseline.stroke()

        let gap: CGFloat = 1.0
        let barWidth = max(1.0, min(2.4, (rect.width - gap * CGFloat(max(0, displayBars.count - 1))) / CGFloat(displayBars.count)))
        let totalWidth = barWidth * CGFloat(displayBars.count) + gap * CGFloat(max(0, displayBars.count - 1))
        let startX = rect.midX - totalWidth / 2

        for index in displayBars.indices {
            let ratio = CGFloat(index) / CGFloat(max(1, displayBars.count - 1))
            let amount = max(0.012, displayBars[index])
            let x = startX + CGFloat(index) * (barWidth + gap)
            let halfHeight = max(0.7, rect.height * (0.06 + amount * 0.50))
            let color = mirroredBandColor(at: ratio)
            let ray = NSRect(
                x: x,
                y: rect.midY - halfHeight,
                width: barWidth,
                height: halfHeight * 2
            )
            let radius = min(barWidth / 2, 1.1)

            let glow = NSBezierPath(
                roundedRect: ray.insetBy(dx: -0.9, dy: -1.0 - amount * 1.5),
                xRadius: radius + 1.0,
                yRadius: radius + 1.0
            )
            color.withAlphaComponent(isActive ? 0.14 + amount * 0.24 : 0.05).setFill()
            glow.fill()

            let bar = NSBezierPath(roundedRect: ray, xRadius: radius, yRadius: radius)
            color.withAlphaComponent(isActive ? 0.52 + amount * 0.38 : 0.16).setFill()
            bar.fill()
        }
    }

    private func bandColor(at ratio: CGFloat) -> NSColor {
        if ratio < 0.42 {
            return ConvoBrand.violet.blended(withFraction: ratio / 0.42, of: ConvoBrand.magenta) ?? ConvoBrand.magenta
        }
        return ConvoBrand.magenta.blended(withFraction: (ratio - 0.42) / 0.58, of: ConvoBrand.amber) ?? ConvoBrand.amber
    }

    private func mirroredBandColor(at ratio: CGFloat) -> NSColor {
        let distanceFromCenter = min(1, abs(ratio - 0.5) * 2)
        if distanceFromCenter < 0.52 {
            return ConvoBrand.amber.blended(withFraction: distanceFromCenter / 0.52, of: ConvoBrand.magenta) ?? ConvoBrand.magenta
        }
        return ConvoBrand.magenta.blended(withFraction: (distanceFromCenter - 0.52) / 0.48, of: ConvoBrand.violet) ?? ConvoBrand.violet
    }

    private func mirroredSpectrumBars() -> [CGFloat] {
        let maxIndex = max(1, spectrumBars.count - 1)
        let center = CGFloat(maxIndex) / 2
        return spectrumBars.indices.map { index in
            let distance = abs(CGFloat(index) - center) / max(1, center)
            let sourceIndex = min(maxIndex, Int((distance * CGFloat(maxIndex)).rounded()))
            return spectrumBars[sourceIndex]
        }
    }

    private func normalizedSpectrumBars(_ bars: [CGFloat]) -> [CGFloat] {
        guard !bars.isEmpty else {
            return Array(repeating: 0, count: spectrumBars.count)
        }
        if bars.count == spectrumBars.count {
            return bars.map { min(1, max(0, $0)) }
        }
        return spectrumBars.indices.map { index in
            let sourceIndex = Int((CGFloat(index) / CGFloat(max(1, spectrumBars.count - 1))) * CGFloat(max(0, bars.count - 1)))
            return min(1, max(0, bars[sourceIndex]))
        }
    }

    private func drawSpectrumCap(at point: NSPoint, color: NSColor, amount: CGFloat) {
        let radius = 0.65 + amount * 1.05
        let dot = NSBezierPath(ovalIn: NSRect(
            x: point.x - radius,
            y: point.y - radius,
            width: radius * 2,
            height: radius * 2
        ))
        color.withAlphaComponent(0.26 + amount * 0.28).setFill()
        dot.fill()
    }
}

/// The pill never becomes key, so its button takes the first click.
private final class FirstClickButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class LiveTranscriptWindowController: NSWindowController, NSWindowDelegate {
    private let backgroundView = PillBackgroundView()
    private let logoImageView = NSImageView()
    private let decibelMeterView = DecibelMeterView()
    private let statusLabel = NSTextField(labelWithString: "")
    /// Step 1, PR 3: brings the Desk back where it was left. Shown only
    /// when the app wires it (a build with a Desk).
    private let deskButton = FirstClickButton()
    /// Called when the Desk button is clicked. Setting it shows the button.
    var onDeskButton: (() -> Void)? {
        didSet { deskButton.isHidden = onDeskButton == nil }
    }
    private var latestTranscript = ""
    private var hideWorkItem: DispatchWorkItem?
    private var hiddenAfterStop = false
    private var didPlaceWindow = false
    private var correctionArmedUntil = Date.distantPast
    private var guardedUntil = Date.distantPast
    private var outcomeExpiresAt = Date.distantPast
    private var activeOutcomeTone: OutcomeTone?
    private var outcomeWorkItem: DispatchWorkItem?
    private var settleToReadyAfterOutcome = false
    private var isProgrammaticFrameChange = false
    private static let baseWindowWidth: CGFloat = 170

    private var hasActiveOutcome: Bool {
        Date() < outcomeExpiresAt
    }

    init() {
        let window = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 170, height: 42),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        window.title = ""
        window.minSize = NSSize(width: 170, height: 42)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.level = .statusBar
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        window.isFloatingPanel = true
        window.becomesKeyOnlyIfNeeded = true
        window.hidesOnDeactivate = false
        window.isMovable = true
        window.isMovableByWindowBackground = true

        super.init(window: window)
        window.delegate = self
        buildContent()
        placeWindowIfNeeded()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func showWindow(_ sender: Any?) {
        present(state: .idle)
        hideAfterDelay()
    }

    func updateDictationState(isRecording: Bool, isBusy: Bool, keepVisible: Bool = false) {
        if hasActiveOutcome, !isRecording {
            // An outcome message is on screen; let it finish its linger instead
            // of being clobbered by a generic state refresh.
            return
        }
        if hiddenAfterStop, !isRecording {
            return
        }
        if isRecording {
            present(state: .listening)
        } else if isBusy {
            present(state: .processing)
        } else if keepVisible {
            showReady()
        } else {
            updateInputLevel(0)
            hideAfterDelay()
        }
    }

    /// While the pill is in its processing state, controller status strings
    /// ("Transcribing with OpenAI Cloud", "Finalizing") become the badge text.
    func updateStatus(_ status: String) {
        guard backgroundView.state == .processing else { return }
        let trimmed = status.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        statusLabel.stringValue = trimmed
        statusLabel.toolTip = trimmed
        resizeWindowToFitLabel()
    }

    func updateTranscript(_ transcript: String) {
        latestTranscript = transcript
    }

    func updateInputLevel(_ level: Double) {
        decibelMeterView.push(level: level)
    }

    func updateInputWaveform(_ samples: [CGFloat], level: Double) {
        decibelMeterView.push(spectrum: samples, level: level)
    }

    func reset(provider: DictationProvider) {
        _ = provider
        hiddenAfterStop = false
        latestTranscript = ""
        correctionArmedUntil = Date.distantPast
        guardedUntil = Date.distantPast
        cancelOutcome()
        decibelMeterView.reset()
        present(state: .listening)
    }

    func showPendingStart(
        correctionArmed: Bool = false,
        targetApplication: NSRunningApplication? = nil
    ) {
        prepareForPresentation(targetApplication: targetApplication)
        hiddenAfterStop = false
        if correctionArmed {
            correctionArmedUntil = Date().addingTimeInterval(1.0)
        }
        guardedUntil = Date.distantPast
        cancelOutcome()
        decibelMeterView.reset()
        present(state: .listening)
    }

    func showCorrectionArmed() {
        correctionArmedUntil = Date().addingTimeInterval(1.0)
        present(state: .correcting)
    }

    func showGuarded() {
        guardedUntil = Date().addingTimeInterval(1.2)
        present(state: .guarded)
    }

    func showProcessing(detail: String = "Finishing…") {
        statusLabel.stringValue = detail
        statusLabel.toolTip = detail
        present(state: .processing)
        resizeWindowToFitLabel()
    }

    /// Flash what happened to the text. Warnings linger; successes flash.
    /// The caller follows up with settleAfterOutcome to say what comes next.
    func showOutcome(_ outcome: DictationOutcome) {
        if outcome.mustBeSeen {
            hiddenAfterStop = false
        }
        guard !hiddenAfterStop else { return }
        showLingeringMessage(outcome.pillMessage, tone: outcome.tone, seconds: outcome.lingerSeconds)
    }

    /// A short note that a key press was not acted on. It may replace a
    /// success badge, but never a warning (such as "Saved to clipboard") that
    /// is still on screen, which matters more.
    func showBriefNote(_ text: String, seconds: TimeInterval = 1.8) {
        if hasActiveOutcome, activeOutcomeTone == .warning { return }
        hiddenAfterStop = false
        showLingeringMessage(text, tone: .notice, seconds: seconds)
    }

    private func showLingeringMessage(_ text: String, tone: OutcomeTone, seconds: TimeInterval) {
        outcomeWorkItem?.cancel()
        statusLabel.stringValue = text
        statusLabel.toolTip = text
        outcomeExpiresAt = Date().addingTimeInterval(seconds)
        activeOutcomeTone = tone
        present(state: .outcome(tone))
        resizeWindowToFitLabel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.performOutcomeSettle()
        }
        outcomeWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: workItem)
    }

    /// Called when the session is fully over: hide (one-shot) or return to the
    /// ready pill (persistent) — but only after any outcome finishes lingering.
    func settleAfterOutcome(returnToReady: Bool) {
        settleToReadyAfterOutcome = returnToReady
        guard !hasActiveOutcome else { return }
        performOutcomeSettle()
    }

    func showReady() {
        hiddenAfterStop = false
        correctionArmedUntil = Date.distantPast
        guardedUntil = Date.distantPast
        cancelOutcome()
        updateInputLevel(0)
        present(state: .idle)
        restoreBaseWidth()
    }

    func hideSoon() {
        hideAfterDelay()
    }

    func hideNow() {
        hiddenAfterStop = true
        correctionArmedUntil = Date.distantPast
        guardedUntil = Date.distantPast
        cancelOutcome()
        hideWorkItem?.cancel()
        window?.orderOut(nil)
        decibelMeterView.reset()
        restoreBaseWidth()
    }

    private func cancelOutcome() {
        outcomeWorkItem?.cancel()
        outcomeWorkItem = nil
        outcomeExpiresAt = Date.distantPast
        activeOutcomeTone = nil
    }

    private func performOutcomeSettle() {
        cancelOutcome()
        if settleToReadyAfterOutcome {
            showReady()
        } else {
            hideNow()
        }
    }

    func refreshSettingsControls() {}

    /// Keep the pill on the display where dictation was invoked. A saved pill
    /// position on another monitor is technically visible but functionally
    /// invisible, which defeats the shortcut's only immediate feedback.
    func prepareForPresentation(targetApplication: NSRunningApplication?) {
        guard let targetScreen = Self.preferredScreen(for: targetApplication),
              let window
        else { return }

        window.level = .statusBar
        guard !isVisible(window.frame, on: targetScreen) else { return }

        positionNearBottomCenter(on: targetScreen)
        Settings.pillWindowOrigin = window.frame.origin
        RunLog.write(
            "pill.window.repositioned",
            "reason=active-app-screen x=\(Int(window.frame.origin.x)) y=\(Int(window.frame.origin.y)) screen=\(Self.screenNumber(targetScreen))"
        )
    }

    func windowDidMove(_ notification: Notification) {
        guard let window, !isProgrammaticFrameChange else { return }
        didPlaceWindow = true
        Settings.pillWindowOrigin = window.frame.origin
        RunLog.write(
            "pill.window.moved",
            "x=\(Int(window.frame.origin.x)) y=\(Int(window.frame.origin.y))"
        )
    }

    private func buildContent() {
        guard let contentView = window?.contentView else { return }
        contentView.wantsLayer = true
        contentView.layer?.backgroundColor = NSColor.clear.cgColor

        backgroundView.translatesAutoresizingMaskIntoConstraints = false
        backgroundView.wantsLayer = true
        contentView.addSubview(backgroundView)

        logoImageView.translatesAutoresizingMaskIntoConstraints = false
        logoImageView.imageScaling = .scaleProportionallyUpOrDown
        logoImageView.image = loadLogo()
        contentView.addSubview(logoImageView)

        decibelMeterView.translatesAutoresizingMaskIntoConstraints = false
        decibelMeterView.toolTip = "Input meter: bright movement means True Convo is hearing your microphone."
        contentView.addSubview(decibelMeterView)

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        statusLabel.textColor = NSColor.white.withAlphaComponent(0.92)
        statusLabel.alignment = .center
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.maximumNumberOfLines = 1
        statusLabel.isHidden = true
        contentView.addSubview(statusLabel)

        deskButton.translatesAutoresizingMaskIntoConstraints = false
        deskButton.isBordered = false
        deskButton.bezelStyle = .regularSquare
        deskButton.imagePosition = .imageOnly
        deskButton.image = NSImage(systemSymbolName: "macwindow", accessibilityDescription: "Open the Desk")
        deskButton.contentTintColor = NSColor.white.withAlphaComponent(0.85)
        deskButton.toolTip = "Open the Desk where you left it (\(DeskSwitchPolicy.shortcutLabel))"
        deskButton.setAccessibilityLabel("Open the Desk")
        deskButton.target = self
        deskButton.action = #selector(deskButtonPressed(_:))
        deskButton.isHidden = true
        contentView.addSubview(deskButton)

        // The meter and words end before the Desk button when it shows.
        let trailingEdge = deskButton.leadingAnchor
        NSLayoutConstraint.activate([
            deskButton.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -8),
            deskButton.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            deskButton.widthAnchor.constraint(equalToConstant: 20),
            deskButton.heightAnchor.constraint(equalToConstant: 20),
        ])

        NSLayoutConstraint.activate([
            statusLabel.leadingAnchor.constraint(equalTo: logoImageView.trailingAnchor, constant: 8),
            statusLabel.trailingAnchor.constraint(equalTo: trailingEdge, constant: -6),
            statusLabel.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
        ])

        NSLayoutConstraint.activate([
            backgroundView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            backgroundView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            backgroundView.topAnchor.constraint(equalTo: contentView.topAnchor),
            backgroundView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),

            logoImageView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 8),
            logoImageView.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            logoImageView.widthAnchor.constraint(equalToConstant: 22),
            logoImageView.heightAnchor.constraint(equalToConstant: 22),

            decibelMeterView.leadingAnchor.constraint(equalTo: logoImageView.trailingAnchor, constant: 8),
            decibelMeterView.trailingAnchor.constraint(equalTo: trailingEdge, constant: -6),
            decibelMeterView.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            decibelMeterView.heightAnchor.constraint(equalToConstant: 22),
        ])
    }

    @objc private func deskButtonPressed(_ sender: Any?) {
        RunLog.write("pill.desk-button.pressed")
        onDeskButton?()
    }

    private func loadLogo() -> NSImage? {
        guard let url = Bundle.main.url(forResource: "TrueConvoIcon", withExtension: "png") else {
            return NSImage(named: NSImage.touchBarAudioInputTemplateName)
        }
        return NSImage(contentsOf: url)
    }

    private func present(state: CursorWidgetState) {
        hideWorkItem?.cancel()
        let now = Date()
        let displayState: CursorWidgetState
        if state == .listening, now < correctionArmedUntil {
            displayState = .correcting
        } else if state == .listening, now < guardedUntil {
            displayState = .guarded
        } else {
            displayState = state
        }
        backgroundView.state = displayState
        // While working or reporting an outcome, words replace the meter;
        // while listening, the meter is the star and words stay out of the way.
        let showsLabel: Bool
        switch displayState {
        case .processing, .outcome:
            showsLabel = true
        default:
            showsLabel = false
        }
        statusLabel.isHidden = !showsLabel
        decibelMeterView.isHidden = showsLabel
        decibelMeterView.isActive = displayState != .idle && !showsLabel
        if displayState == .processing, statusLabel.stringValue.isEmpty {
            // Auto-stop can enter processing before any status text arrives;
            // never show a wordless working badge.
            statusLabel.stringValue = "Finishing…"
            statusLabel.toolTip = statusLabel.stringValue
        }
        if !showsLabel {
            statusLabel.stringValue = ""
            restoreBaseWidth()
        }
        placeWindowIfNeeded()
        window?.orderFrontRegardless()
    }

    private func resizeWindowToFitLabel() {
        let textWidth = statusLabel.attributedStringValue.size().width
        // logo inset 8 + logo 22 + gap 8 + text + gap 6 + Desk button 20 +
        // trailing 8, capped so a long status can't turn the pill into a banner.
        let desired = min(max(Self.baseWindowWidth, 50 + textWidth + 34), 320)
        setWindowWidth(desired)
    }

    private func restoreBaseWidth() {
        setWindowWidth(Self.baseWindowWidth)
    }

    private func setWindowWidth(_ width: CGFloat) {
        guard let window else { return }
        let current = window.frame
        guard abs(current.width - width) > 0.5 else { return }
        // Grow and shrink around the pill's center so it stays where the user put it.
        let delta = width - current.width
        let frame = NSRect(
            x: current.origin.x - delta / 2,
            y: current.origin.y,
            width: width,
            height: current.height
        )
        isProgrammaticFrameChange = true
        window.setFrame(frame, display: true)
        isProgrammaticFrameChange = false
    }

    private func hideAfterDelay(seconds: TimeInterval = 1.0) {
        hideWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.window?.orderOut(nil)
            self?.decibelMeterView.reset()
        }
        hideWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: workItem)
    }

    private func placeWindowIfNeeded() {
        guard !didPlaceWindow, let window else { return }
        if let savedOrigin = Settings.pillWindowOrigin {
            let savedFrame = NSRect(origin: savedOrigin, size: window.frame.size)
            if isVisibleOnAnyScreen(savedFrame) {
                window.setFrameOrigin(savedOrigin)
                didPlaceWindow = true
                return
            }
        }
        positionNearBottomCenter()
        didPlaceWindow = true
    }

    private func positionNearBottomCenter(on preferredScreen: NSScreen? = nil) {
        guard let window else { return }
        let screenFrame = (preferredScreen ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let frame = window.frame
        let x = screenFrame.midX - frame.width / 2
        let y = screenFrame.minY + 58
        isProgrammaticFrameChange = true
        window.setFrameOrigin(NSPoint(x: x, y: y))
        isProgrammaticFrameChange = false
        didPlaceWindow = true
    }

    private func isVisibleOnAnyScreen(_ frame: NSRect) -> Bool {
        NSScreen.screens.contains { screen in
            isVisible(frame, on: screen)
        }
    }

    private func isVisible(_ frame: NSRect, on screen: NSScreen) -> Bool {
        let intersection = screen.visibleFrame.intersection(frame)
        return intersection.width >= min(48, frame.width * 0.35)
            && intersection.height >= min(24, frame.height * 0.50)
    }

    private static func preferredScreen(for application: NSRunningApplication?) -> NSScreen? {
        if let application, let applicationScreen = screenForApplication(application) {
            return applicationScreen
        }
        let pointer = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { NSMouseInRect(pointer, $0.frame, false) })
            ?? NSScreen.main
            ?? NSScreen.screens.first
    }

    private static func screenForApplication(_ application: NSRunningApplication) -> NSScreen? {
        guard let windowRows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]]
        else { return nil }

        let applicationWindows = windowRows.compactMap { row -> CGRect? in
            guard let ownerPID = row[kCGWindowOwnerPID as String] as? NSNumber,
                  ownerPID.int32Value == application.processIdentifier,
                  let layer = row[kCGWindowLayer as String] as? NSNumber,
                  layer.intValue == 0,
                  let bounds = row[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: bounds),
                  frame.width >= 80,
                  frame.height >= 80
            else { return nil }
            return frame
        }
        // Quartz returns windows front-to-back, so the first normal app window
        // is a better match for the active field than the physically largest.
        guard let applicationWindow = applicationWindows.first else { return nil }

        return NSScreen.screens.first { screen in
            guard let displayID = displayID(for: screen) else { return false }
            return CGDisplayBounds(displayID).contains(
                CGPoint(x: applicationWindow.midX, y: applicationWindow.midY)
            )
        }
    }

    private static func displayID(for screen: NSScreen) -> CGDirectDisplayID? {
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
            return nil
        }
        return CGDirectDisplayID(number.uint32Value)
    }

    private static func screenNumber(_ screen: NSScreen) -> UInt32 {
        displayID(for: screen) ?? 0
    }
}
