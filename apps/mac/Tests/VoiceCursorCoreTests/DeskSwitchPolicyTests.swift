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

    @Test("Showing the Desk hides an idle pill, never a busy or kept one")
    func pillStepsAside() {
        #expect(DeskSwitchPolicy.hidesPillWhenShowingDesk(dictationBusy: false, pillKeptOnScreen: false))
        #expect(!DeskSwitchPolicy.hidesPillWhenShowingDesk(dictationBusy: true, pillKeptOnScreen: false))
        #expect(!DeskSwitchPolicy.hidesPillWhenShowingDesk(dictationBusy: false, pillKeptOnScreen: true))
    }
}
