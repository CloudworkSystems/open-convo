import Foundation
import Testing

/// Step 1, PR 2b, Codex review of #9: the Desk route's wiring in the app
/// target, checked on its source (the app target has no unit-test seam).
@Suite("Desk route wiring")
struct DeskRouteWiringTests {
    private func source() throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent("Sources/VoiceCursorMac/main.swift"), encoding: .utf8)
    }

    private func body(_ signature: String, in source: String) throws -> String {
        let declaration = try #require(source.range(of: signature))
        let start = try #require(source[declaration.lowerBound...].firstIndex(of: "{"))
        var depth = 0
        for index in source[start...].indices {
            if source[index] == "{" { depth += 1 }
            if source[index] == "}" { depth -= 1 }
            if depth == 0 { return String(source[start...index]) }
        }
        throw NSError(domain: "DeskRouteWiringTests", code: 1)
    }

    @Test("A Desk recording clears any stale live preview and never updates one")
    func deskRouteNeverFeedsALivePreview() throws {
        let source = try source()
        let begin = try body("static func beginLivePreviewIfNeeded(allowed: Bool = true)", in: source)
        let guardStart = try #require(begin.range(of: "guard allowed else {"))
        let afterGuard = String(begin[guardStart.lowerBound...])
        let guardBody = try body("guard allowed else", in: afterGuard)
        #expect(guardBody.contains("livePreviewAcceptsPartials = false"))
        #expect(guardBody.contains("clearLivePreviewState()"))
        #expect(source.components(separatedBy: "TextInjector.updateLivePreview(").count - 1 == 2)
        #expect(source.contains("if self.deskRoute == nil { TextInjector.updateLivePreview(combinedText) }"))
        #expect(source.contains("if deskRoute == nil { TextInjector.updateLivePreview(normalized) }"))
    }

    @Test("Only the latest start goes on after a permission answer, and capture never starts twice")
    func oneRoutePerStartAttempt() throws {
        let source = try source()
        let start = try body("func start(deskRoute: DeskRoute? = nil)", in: source)
        #expect(start.contains("startAttempt += 1"))
        #expect(start.components(separatedBy: "isCurrentStart(attempt)").count - 1 == 3, "each microphone callback checks its start is still the latest")
        #expect(start.contains("requestSpeechPermission(recognizer: recognizer, language: language, attempt: attempt)"))
        let speech = try body("private func requestSpeechPermission(", in: source)
        #expect(speech.contains("guard self.isCurrentStart(attempt) else { return }"))
        let capture = try body("private func startCapture(", in: source)
        #expect(capture.contains("guard !isBusy else {"))
    }

    @Test("Letting go of the key while a Desk start waits for permission calls it off")
    func releaseCancelsPendingDeskStart() throws {
        let source = try source()
        let cancel = try body("func cancelPendingDeskStart() -> Bool", in: source)
        #expect(cancel.contains("guard !isBusy, deskRoute != nil else { return false }"))
        #expect(cancel.contains("startAttempt += 1"), "the pending permission callback is superseded")
        let release = try body("private func handleHotKeyReleased()", in: source)
        #expect(release.contains("if !controller.isRecording, controller.cancelPendingDeskStart() {"))
    }

    @Test("Pill and Desk switching keeps lingering outcomes and treats every way back to the Desk alike")
    func pillDeskSwitchWiring() throws {
        let source = try source()
        let shrink = try body("private func showPillAfterShrink()", in: source)
        let outcomeCheck = try #require(shrink.range(of: "if liveTranscriptWindow.isShowingOutcome {"))
        let ready = try #require(shrink.range(of: "liveTranscriptWindow.showReady()", options: .backwards))
        #expect(outcomeCheck.lowerBound < ready.lowerBound, "a lingering outcome is never replaced by the ready pill")
        #expect(shrink.contains("settleAfterOutcome(returnToReady: true)"))
        let menu = try body("@objc private func openDeskFromMenu()", in: source)
        #expect(menu.contains("hideIdlePillForDesk()"))
        #expect(source.contains("deskMenuItem.action = hasDesk ? #selector(openDeskFromMenu) : nil"))
        let hide = try body("private func hideIdlePillForDesk()", in: source)
        #expect(hide.contains("liveTranscriptWindow.settleAfterOutcome(returnToReady: false)"),
                "a lingering outcome hides when it ends, never returning over the Desk")
        for wrapper in ["private func showDeskFromPill()", "@objc private func toggleDeskAndPill()"] {
            #expect(try body(wrapper, in: source).contains("hideIdlePillForDesk()"), "\(wrapper)")
        }
    }

    @Test("Hiding the persistent pill calls off a pending Desk start in either phase")
    func hidingPersistentPillCancelsPendingDeskStart() throws {
        let source = try source()
        let cancel = try body("private func cancelPendingDeskStart(reason: String)", in: source)
        #expect(cancel.contains("if deskStartPending { deskStartReleased = true }"), "still asking the host")
        #expect(cancel.contains("controller.cancelPendingDeskStart()"), "waiting for a permission answer")
        let toggle = try body("private func togglePersistentPill()", in: source)
        #expect(toggle.components(separatedBy: "cancelPendingDeskStart(reason: \"persistent-pill-hidden\")").count - 1 == 2)
    }
}
