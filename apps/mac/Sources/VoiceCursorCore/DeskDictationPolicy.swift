import Foundation

/// Where a dictation or correction may start while the Desk window is in
/// front. Pure rules, so the policy check and the unit tests can prove them
/// without AppKit.
///
/// Build 9 shows the Desk but cannot dictate into it yet. Today a dictation
/// started from one of True Convo's own windows targets the last outside
/// app (`rememberCursorTarget` skips our own bundle), so pressing the
/// dictation key in the Desk could type, paste or press Return in an app
/// the person is not looking at. The rule closes that: with the Desk
/// focused every entry is refused before any cursor target is remembered.
/// With the Desk not focused (another app, or Scratchpad or Settings in
/// front) nothing changes.
public enum DeskDictationPolicy {
    /// What the Desk window can do right now.
    public enum DeskAvailability: Equatable, Sendable, CaseIterable {
        case open
        case locked
        case unavailable
    }

    /// Whether the Desk window holds the focus, and if so in what state.
    public enum DeskFocus: Equatable, Sendable {
        case notFocused
        case focused(DeskAvailability)
    }

    /// The ways a dictation or correction can start.
    public enum DictationEntry: Equatable, Sendable, CaseIterable {
        /// The dictation key, the menu item, or the idle wake.
        case dictation
        /// A dictation armed as a one-shot correction.
        case correctionOnce
        /// The typed correction shortcut.
        case typedCorrection
        /// The Services menu correction.
        case servicesCorrection

        public var isCorrection: Bool { self != .dictation }
    }

    /// Why a start in the Desk was refused.
    public enum DeskRefusal: Equatable, Sendable, CaseIterable {
        /// Dictation into the Desk comes in a later build.
        case notInThisBuild
        case locked
        case unavailable
        /// Corrections never run in the Desk.
        case correctionNotInDesk

        /// The identifier for the run log (`reason=desk-<logName>`); never
        /// any text.
        public var logName: String {
            switch self {
            case .notInThisBuild: return "not-in-this-build"
            case .locked: return "locked"
            case .unavailable: return "unavailable"
            case .correctionNotInDesk: return "correction-not-in-desk"
            }
        }
    }

    public enum StartDecision: Equatable, Sendable {
        /// Today's path: the outside app under the cursor.
        case externalCursor
        /// Refused: nothing is recorded, typed, pasted or copied.
        case refuseDesk(DeskRefusal)
    }

    /// The focus as the app sees it: only the Desk window holding the focus
    /// counts. Scratchpad, Settings or any other True Convo window in front
    /// keeps today's path.
    public static func focus(deskWindowHoldsFocus: Bool, availability: DeskAvailability) -> DeskFocus {
        deskWindowHoldsFocus ? .focused(availability) : .notFocused
    }

    /// The one decision every entry point asks before remembering a cursor
    /// target. In this build any Desk focus refuses.
    public static func decide(_ entry: DictationEntry, focus: DeskFocus) -> StartDecision {
        switch focus {
        case .notFocused:
            return .externalCursor
        case .focused(let availability):
            if entry.isCorrection { return .refuseDesk(.correctionNotInDesk) }
            switch availability {
            case .open: return .refuseDesk(.notInThisBuild)
            case .locked: return .refuseDesk(.locked)
            case .unavailable: return .refuseDesk(.unavailable)
            }
        }
    }

    /// The last-moment shield in the text injector: while the Desk window
    /// is key, no synthetic Return, typing or paste is sent, because it
    /// would land in the Desk instead of the outside app.
    public static func shieldBlocksSyntheticInput(deskWindowIsKey: Bool) -> Bool {
        deskWindowIsKey
    }

    /// What the shield can hold back.
    public enum ShieldedInput: String, Equatable, Hashable, Sendable, CaseIterable {
        /// The final paste. Its text goes on the clipboard instead.
        case paste
        /// Typing live or final words with the keyboard.
        case typing
        /// The automatic Return of Paste and Submit.
        case returnKey = "return"
    }

    /// What the pill says once the shield held something back during a
    /// dictation, so it never claims a paste, typing or Return that did not
    /// happen ("Pasted + sent" while Return was held back).
    public struct ShieldNote: Equatable, Sendable {
        public let heldBack: Set<ShieldedInput>

        public var pillMessage: String {
            let notSent = heldBack.contains(.returnKey)
            if heldBack.contains(.paste) {
                return notSent
                    ? "Not pasted or sent — the Desk was in front. Text is on your clipboard (⌘V)"
                    : "Not pasted — the Desk was in front. Text is on your clipboard (⌘V)"
            }
            if heldBack.contains(.typing) {
                return notSent
                    ? "Typing stopped, not sent — the Desk was in front. Menu: Copy Last Dictation"
                    : "Typing stopped — the Desk was in front. Menu: Copy Last Dictation"
            }
            return "Not sent — the Desk was in front, so Return wasn't pressed"
        }

        /// Where partial text went, for the partial-text pill.
        public var partialDeliveryNote: String {
            if heldBack.contains(.paste) { return "not pasted (the Desk was in front); it's on your clipboard (⌘V)" }
            if heldBack.contains(.typing) { return "typing stopped (the Desk was in front); it's in Copy Last Dictation" }
            return "pasted, not sent"
        }

        /// Identifiers only, in a fixed order: `held-back=paste,return`.
        public var logDetail: String {
            "held-back=" + ShieldedInput.allCases.filter { heldBack.contains($0) }.map(\.rawValue).joined(separator: ",")
        }
    }

    /// The note for what the shield held back during one dictation; nil
    /// when it held nothing back.
    public static func shieldNote(heldBack: Set<ShieldedInput>) -> ShieldNote? {
        heldBack.isEmpty ? nil : ShieldNote(heldBack: heldBack)
    }

    /// Whether a dictation's own outcome claims something the shield
    /// stopped: words pasted or typed into the app (`claimsInserted`), or
    /// sent with Return (`claimsSent`). The app then shows the shield's note
    /// instead of that outcome.
    public static func shieldContradicts(claimsInserted: Bool, claimsSent: Bool, heldBack: Set<ShieldedInput>) -> Bool {
        if claimsSent && heldBack.contains(.returnKey) { return true }
        if claimsInserted && (heldBack.contains(.paste) || heldBack.contains(.typing)) { return true }
        return false
    }
}
