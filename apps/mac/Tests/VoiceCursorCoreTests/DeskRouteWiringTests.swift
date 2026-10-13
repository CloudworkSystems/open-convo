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
}
