import Testing
@testable import VoiceCursorCore

@Suite("Desk dictation policy")
struct DeskDictationPolicyTests {
    typealias Policy = DeskDictationPolicy

    @Test("With the Desk focused, every entry is refused in every Desk state")
    func deskFocusedRefusesEveryEntry() {
        for entry in Policy.DictationEntry.allCases {
            for availability in Policy.DeskAvailability.allCases {
                let decision = Policy.decide(entry, focus: .focused(availability))
                guard case .refuseDesk(let refusal) = decision else {
                    Issue.record("\(entry) in a \(availability) Desk was not refused: \(decision)")
                    continue
                }
                if entry.isCorrection {
                    #expect(refusal == .correctionNotInDesk, "\(entry) in a \(availability) Desk")
                } else {
                    let expected: Policy.DeskRefusal = availability == .open ? .notInThisBuild
                        : availability == .locked ? .locked : .unavailable
                    #expect(refusal == expected, "\(entry) in a \(availability) Desk")
                }
            }
        }
    }

    @Test("With the Desk not focused, every entry keeps today's outside path")
    func deskNotFocusedKeepsTodaysPath() {
        for entry in Policy.DictationEntry.allCases {
            #expect(Policy.decide(entry, focus: .notFocused) == .externalCursor, "\(entry)")
        }
    }

    @Test("Scratchpad or Settings in front, with the Desk not focused, keeps today's path")
    func ownNonDeskWindowKeepsTodaysPath() {
        // Another of True Convo's own windows is key: the Desk window does
        // not hold the focus, whatever state the Desk is in.
        for availability in Policy.DeskAvailability.allCases {
            let focus = Policy.focus(deskWindowHoldsFocus: false, availability: availability)
            #expect(focus == .notFocused)
            for entry in Policy.DictationEntry.allCases {
                #expect(Policy.decide(entry, focus: focus) == .externalCursor, "\(entry) with a \(availability) Desk behind")
            }
        }
        #expect(Policy.focus(deskWindowHoldsFocus: true, availability: .locked) == .focused(.locked))
    }

    @Test("The injector shield blocks synthetic input only while the Desk window is key")
    func shieldOnlyWhenDeskKey() {
        #expect(Policy.shieldBlocksSyntheticInput(deskWindowIsKey: true))
        #expect(!Policy.shieldBlocksSyntheticInput(deskWindowIsKey: false))
    }

    @Test("A Return held back by the shield never shows as sent")
    func heldBackReturnIsNeverShownAsSent() {
        // Review finding F1: with the Desk key at the stop, the shield skips
        // the Return of Paste and Submit, while the dictation's own outcome
        // still says "Pasted + sent".
        let returnHeld: Set<Policy.ShieldedInput> = [.returnKey]
        #expect(Policy.shieldContradicts(claimsInserted: true, claimsSent: true, heldBack: returnHeld))
        let note = Policy.shieldNote(heldBack: returnHeld)
        #expect(note?.pillMessage == "Not sent — the Desk was in front, so Return wasn't pressed")
        #expect(note?.logDetail == "held-back=return")
        // The words are in the app, so a plain "Pasted" claim stays true.
        #expect(!Policy.shieldContradicts(claimsInserted: true, claimsSent: false, heldBack: returnHeld))
    }

    @Test("A paste or typing held back by the shield never shows as pasted")
    func heldBackPasteOrTypingIsNeverShownAsPasted() {
        #expect(Policy.shieldContradicts(claimsInserted: true, claimsSent: false, heldBack: [.paste]))
        #expect(Policy.shieldContradicts(claimsInserted: true, claimsSent: false, heldBack: [.typing]))
        #expect(Policy.shieldNote(heldBack: [.paste])?.pillMessage == "Not pasted — the Desk was in front. Text is on your clipboard (⌘V)")
        #expect(Policy.shieldNote(heldBack: [.paste, .returnKey])?.pillMessage == "Not pasted or sent — the Desk was in front. Text is on your clipboard (⌘V)")
        #expect(Policy.shieldNote(heldBack: [.typing])?.pillMessage == "Typing stopped — the Desk was in front. Menu: Copy Last Dictation")
        #expect(Policy.shieldNote(heldBack: [.returnKey, .typing, .paste])?.logDetail == "held-back=paste,typing,return")
        #expect(Policy.shieldNote(heldBack: [.paste])?.partialDeliveryNote.contains("clipboard") == true)
        // Outcomes that claim nothing about the app (clipboard, archive,
        // safety stops) stay as they are, and nothing held back changes
        // nothing.
        for input in Policy.ShieldedInput.allCases {
            #expect(!Policy.shieldContradicts(claimsInserted: false, claimsSent: false, heldBack: [input]))
        }
        #expect(!Policy.shieldContradicts(claimsInserted: true, claimsSent: true, heldBack: []))
        #expect(Policy.shieldNote(heldBack: []) == nil)
    }

    @Test("Refusal log names are identifiers only")
    func refusalLogNamesAreIdentifiers() {
        let names = Policy.DeskRefusal.allCases.map(\.logName)
        #expect(Set(names).count == names.count)
        for name in names {
            #expect(name.allSatisfy { $0.isLowercase || $0 == "-" }, "\(name)")
        }
    }
}
