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

    @Test("Return waits a short settle after the paste")
    func settleDelay() {
        #expect(PasteSubmitSequencing.settleDelayAfterPaste == 0.15)
    }
}
