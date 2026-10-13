import Testing
@testable import VoiceCursorCore

@Suite("Pill and Desk switching")
struct DeskSwitchPolicyTests {
    @Test("The shortcut shrinks a focused Desk to the pill and otherwise shows the Desk")
    func toggle() {
        #expect(DeskSwitchPolicy.toggle(hasDesk: true, deskWindowHoldsFocus: true) == .shrinkToPill)
        #expect(DeskSwitchPolicy.toggle(hasDesk: true, deskWindowHoldsFocus: false) == .showDesk)
        #expect(DeskSwitchPolicy.toggle(hasDesk: false, deskWindowHoldsFocus: false) == .noDesk)
        #expect(DeskSwitchPolicy.toggle(hasDesk: false, deskWindowHoldsFocus: true) == .noDesk)
    }

    @Test("The pill's Desk button always shows the Desk when there is one")
    func pillButton() {
        #expect(DeskSwitchPolicy.pillDeskButton(hasDesk: true) == .showDesk)
        #expect(DeskSwitchPolicy.pillDeskButton(hasDesk: false) == .noDesk)
    }

    @Test("The shortcut never shares a key with dictation's D shortcuts or the correction shortcut")
    func shortcutLabel() {
        #expect(DeskSwitchPolicy.shortcutLabel == "Control+Option+Cmd+T")
    }

    @Test("Showing the Desk hides an idle pill, never a busy, kept or still-reporting one")
    func pillStepsAside() {
        #expect(DeskSwitchPolicy.hidesPillWhenShowingDesk(dictationBusy: false, pillShowingOutcome: false, pillKeptOnScreen: false))
        #expect(!DeskSwitchPolicy.hidesPillWhenShowingDesk(dictationBusy: true, pillShowingOutcome: false, pillKeptOnScreen: false))
        #expect(!DeskSwitchPolicy.hidesPillWhenShowingDesk(dictationBusy: false, pillShowingOutcome: true, pillKeptOnScreen: false),
                "an outcome still lingering (set-aside words, clipboard fallback) stays readable")
        #expect(!DeskSwitchPolicy.hidesPillWhenShowingDesk(dictationBusy: false, pillShowingOutcome: false, pillKeptOnScreen: true))
    }

    @Test("Double-tapping Right Option is the default; unknown stored values fall back to it")
    func shortcutChoice() {
        #expect(DeskSwitchShortcut.stored(nil) == .doubleTapRightOption)
        #expect(DeskSwitchShortcut.stored("nonsense") == .doubleTapRightOption)
        #expect(DeskSwitchShortcut.stored("off") == .off)
        #expect(DeskSwitchShortcut.stored("control-option-command-t") == .controlOptionCommandT)
        #expect(DeskSwitchShortcut.doubleTapRightOption.label == "Double-Tap Right Option")
    }

    /// Feeds inputs in order; the result of the last one.
    private func feed(_ tap: inout ModifierDoubleTap, _ inputs: ModifierDoubleTap.Input...) -> Bool {
        var last = false
        for input in inputs { last = tap.handle(input) }
        return last
    }

    @Test("Two quick taps count; holds, slow taps and anything in between do not")
    func doubleTap() {
        var tap = ModifierDoubleTap()
        let firstHalf = feed(&tap, .down(0.00), .up(0.08), .down(0.20))
        #expect(!firstHalf)
        let quick = feed(&tap, .up(0.28))
        #expect(quick, "two quick taps")
        let third = feed(&tap, .down(0.40), .up(0.45))
        #expect(!third, "a third tap right after starts fresh")

        var slowGap = ModifierDoubleTap()
        let slow = feed(&slowGap, .down(0), .up(0.1), .down(0.6), .up(0.7))
        #expect(!slow, "too long between taps")
        let restarted = feed(&slowGap, .down(0.8), .up(0.85))
        #expect(restarted, "but that slow tap can start a new double tap")

        var held = ModifierDoubleTap()
        let heldFirst = feed(&held, .down(0), .up(0.5), .down(0.6), .up(0.65))
        #expect(!heldFirst, "a held first press is not a tap")

        var typing = ModifierDoubleTap()
        let typed = feed(&typing, .down(0), .up(0.1), .down(0.2), .other, .up(0.3))
        #expect(!typed, "Option+letter in between never switches")

        var heldSecond = ModifierDoubleTap()
        let heldLast = feed(&heldSecond, .down(0), .up(0.1), .down(0.2), .up(0.9))
        #expect(!heldLast, "a held second press is not a tap")
    }
}
