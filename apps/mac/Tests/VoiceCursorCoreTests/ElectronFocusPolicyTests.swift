import Testing
@testable import VoiceCursorCore

@Suite("Electron focus and Paste and Submit timing")
struct ElectronFocusPolicyTests {
    @Test("The wake attribute is the one Electron listens for")
    func wakeAttributeName() {
        #expect(ElectronFocusPolicy.manualAccessibilityAttribute == "AXManualAccessibility")
    }

    @Test("A 'no value' answer is retried, with short waits")
    func noValueIsRetried() {
        #expect(ElectronFocusPolicy.retryDelay(afterFailedStatus: -25212, retriesSoFar: 0) == 0.06)
        #expect(ElectronFocusPolicy.retryDelay(afterFailedStatus: -25212, retriesSoFar: 1) == 0.12)
        #expect(ElectronFocusPolicy.retryDelay(afterFailedStatus: -25211, retriesSoFar: 0) != nil)
        #expect(ElectronFocusPolicy.retryDelay(afterFailedStatus: -25204, retriesSoFar: 0) != nil)
    }

    @Test("Retries stop after two")
    func retriesAreBounded() {
        #expect(ElectronFocusPolicy.retryDelay(afterFailedStatus: -25212, retriesSoFar: 2) == nil)
        #expect(ElectronFocusPolicy.retryDelay(afterFailedStatus: -25212, retriesSoFar: -1) == nil)
    }

    @Test("Other failures and success are not retried")
    func otherCodesAreNotRetried() {
        #expect(ElectronFocusPolicy.retryDelay(afterFailedStatus: 0, retriesSoFar: 0) == nil)
        #expect(ElectronFocusPolicy.retryDelay(afterFailedStatus: -25202, retriesSoFar: 0) == nil)
        #expect(ElectronFocusPolicy.retryDelay(afterFailedStatus: -25205, retriesSoFar: 0) == nil)
    }

    @Test("All retries together wait no more than a quarter second")
    func totalWaitIsBounded() {
        let total = ElectronFocusPolicy.retryDelays.reduce(0, +)
        #expect(total <= ElectronFocusPolicy.maximumTotalRetryWait)
        #expect(ElectronFocusPolicy.maximumTotalRetryWait <= 0.25)
    }

    @Test("Return follows a paste that happened")
    func returnFollowsRealPaste() {
        #expect(PasteSubmitSequencing.shouldPressReturn(after: .insertedThroughAccessibility))
        #expect(PasteSubmitSequencing.shouldPressReturn(after: .keystrokePosted))
    }

    @Test("Return is skipped when nothing reached the app")
    func returnSkippedWithoutPaste() {
        #expect(!PasteSubmitSequencing.shouldPressReturn(after: .clipboardOnly))
        #expect(!PasteSubmitSequencing.shouldPressReturn(after: .notPerformed))
    }

    @Test("No Return when a newer target took the paste over")
    func returnSkippedWhenSuperseded() {
        #expect(!PasteSubmitSequencing.shouldPressReturn(after: .superseded))
    }

    @Test("A delayed step runs only while its target is still current")
    func generationToken() {
        var generation = PasteTargetGeneration()
        let token = generation.value
        #expect(generation.isCurrent(token))
        generation.advance()
        #expect(!generation.isCurrent(token))
        #expect(generation.isCurrent(generation.value))
    }

    @Test("Only a different app counts as a new target")
    func targetChange() {
        #expect(!PasteTargetGeneration.targetChanged(oldProcessIdentifier: 42, newProcessIdentifier: 42))
        #expect(PasteTargetGeneration.targetChanged(oldProcessIdentifier: 42, newProcessIdentifier: 43))
        #expect(PasteTargetGeneration.targetChanged(oldProcessIdentifier: nil, newProcessIdentifier: 43))
        #expect(PasteTargetGeneration.targetChanged(oldProcessIdentifier: 42, newProcessIdentifier: nil))
        #expect(!PasteTargetGeneration.targetChanged(oldProcessIdentifier: nil, newProcessIdentifier: nil))
    }

    @Test("Text goes into a text box only in the target app while it is in front")
    func deliveryIntoTargetTextBox() {
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: 42, frontmostProcessIdentifier: 42, elementProcessIdentifier: 42) == .accessibilityThenKeystroke)
    }

    @Test("A text box from another app is never typed into; Cmd+V goes to the target")
    func elementFromOtherApp() {
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: 42, frontmostProcessIdentifier: 42, elementProcessIdentifier: 7) == .keystrokeOnly)
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: 42, frontmostProcessIdentifier: 42, elementProcessIdentifier: nil) == .keystrokeOnly)
    }

    @Test("Nothing is typed when the target app is not in front")
    func targetNotFrontmost() {
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: 42, frontmostProcessIdentifier: 7, elementProcessIdentifier: 42) == .clipboardOnly)
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: 42, frontmostProcessIdentifier: 7, elementProcessIdentifier: 7) == .clipboardOnly)
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: 42, frontmostProcessIdentifier: nil, elementProcessIdentifier: 42) == .clipboardOnly)
    }

    @Test("Nothing is typed when there is no target app or it has quit")
    func targetMissingOrQuit() {
        // No target captured: whatever is in front is never typed into.
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: nil, frontmostProcessIdentifier: 7, elementProcessIdentifier: 7) == .clipboardOnly)
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: nil, frontmostProcessIdentifier: nil, elementProcessIdentifier: nil) == .clipboardOnly)
        // The target quit, even if its old process ID still looks in front.
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: 42, targetIsRunning: false, frontmostProcessIdentifier: 42, elementProcessIdentifier: 42) == .clipboardOnly)
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: 42, targetIsRunning: false, frontmostProcessIdentifier: 7, elementProcessIdentifier: nil) == .clipboardOnly)
        // And no Return follows a clipboard-only result.
        #expect(!PasteSubmitSequencing.shouldPressReturn(after: .clipboardOnly))
    }

    @Test("Return waits a short settle after the paste")
    func settleDelay() {
        #expect(PasteSubmitSequencing.settleDelayAfterPaste == 0.15)
    }

    @Test("An Electron or Chromium target gets Cmd+V only, never an Accessibility insert")
    func webEditorTargetIsKeystrokeOnly() {
        // Even with a usable text box in the target app.
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: 42, frontmostProcessIdentifier: 42, elementProcessIdentifier: 42, targetUsesWebEditor: true) == .keystrokeOnly)
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: 42, frontmostProcessIdentifier: 42, elementProcessIdentifier: nil, targetUsesWebEditor: true) == .keystrokeOnly)
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: 42, frontmostProcessIdentifier: 42, elementProcessIdentifier: 7, targetUsesWebEditor: true) == .keystrokeOnly)
        // Return still follows a Cmd+V that was sent.
        #expect(PasteSubmitSequencing.shouldPressReturn(after: .keystrokePosted))
    }

    @Test("A native target keeps the Accessibility insert, with Cmd+V as the fallback")
    func nativeTargetKeepsAccessibilityFirst() {
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: 42, frontmostProcessIdentifier: 42, elementProcessIdentifier: 42, targetUsesWebEditor: false) == .accessibilityThenKeystroke)
    }

    @Test("Electron and Chromium targets still get nothing when not in front or quit")
    func webEditorTargetKeepsSafetyChecks() {
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: 42, frontmostProcessIdentifier: 7, elementProcessIdentifier: 42, targetUsesWebEditor: true) == .clipboardOnly)
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: 42, frontmostProcessIdentifier: nil, elementProcessIdentifier: nil, targetUsesWebEditor: true) == .clipboardOnly)
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: 42, targetIsRunning: false, frontmostProcessIdentifier: 42, elementProcessIdentifier: 42, targetUsesWebEditor: true) == .clipboardOnly)
        #expect(PasteDeliveryCheck.route(targetProcessIdentifier: nil, frontmostProcessIdentifier: 7, elementProcessIdentifier: 7, targetUsesWebEditor: true) == .clipboardOnly)
    }

    @Test("Known Electron apps are recognised by bundle ID alone")
    func knownAppsAreWebEditors() {
        for bundleIdentifier in ["com.anthropic.claudefordesktop", "com.openai.codex", "com.tinyspeck.slackmacgap", "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92"] {
            #expect(WebEditorDetection.usesWebEditor(bundleIdentifier: bundleIdentifier, frameworkNames: [], frameworkHasEngineMarker: { _ in false }))
        }
    }

    @Test("Any app shipping an Electron or Chromium framework is recognised, even renamed")
    func frameworkMarksWebEditor() {
        #expect(WebEditorDetection.usesWebEditor(bundleIdentifier: "com.example.someapp", frameworkNames: ["Electron Framework.framework"], frameworkHasEngineMarker: { _ in false }))
        #expect(WebEditorDetection.usesWebEditor(bundleIdentifier: "com.example.someapp", frameworkNames: ["Chromium Embedded Framework.framework"], frameworkHasEngineMarker: { _ in false }))
        // A renamed engine framework is found by Chromium's resource pack inside it.
        #expect(WebEditorDetection.usesWebEditor(bundleIdentifier: "com.example.someapp", frameworkNames: ["Sparkle.framework", "Example Framework.framework"], frameworkHasEngineMarker: { $0 == "Example Framework.framework" }))
        // No bundle ID at all still works from the framework.
        #expect(WebEditorDetection.usesWebEditor(bundleIdentifier: nil, frameworkNames: ["Electron Framework.framework"], frameworkHasEngineMarker: { _ in false }))
    }

    @Test("Native apps are not web editors")
    func nativeAppsAreNotWebEditors() {
        #expect(!WebEditorDetection.usesWebEditor(bundleIdentifier: "com.apple.TextEdit", frameworkNames: [], frameworkHasEngineMarker: { _ in true }))
        #expect(!WebEditorDetection.usesWebEditor(bundleIdentifier: "com.example.nativeapp", frameworkNames: ["Sparkle.framework", "Example Kit.framework"], frameworkHasEngineMarker: { _ in false }))
        // Only .framework entries are looked at.
        #expect(!WebEditorDetection.usesWebEditor(bundleIdentifier: "com.example.nativeapp", frameworkNames: ["libexample.dylib"], frameworkHasEngineMarker: { _ in true }))
        #expect(!WebEditorDetection.usesWebEditor(bundleIdentifier: nil, frameworkNames: [], frameworkHasEngineMarker: { _ in true }))
    }
}
