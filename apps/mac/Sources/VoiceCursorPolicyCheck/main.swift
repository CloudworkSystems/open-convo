import Darwin
import Foundation
import VoiceCursorCore

var failures = 0
var checks = 0

func expect(_ condition: @autoclosure () -> Bool, _ name: String) {
    checks += 1
    if condition() {
        print("[ok] \(name)")
    } else {
        failures += 1
        print("[fail] \(name)")
    }
}

let appendPlan = LiveKeyboardPreviewPolicy.revisionPlan(
    currentText: "hello world",
    outputText: "hello world again",
    eventPrefix: LiveKeyboardPreviewPolicy.keyboardPreviewEventPrefix,
    keepLiveText: true
)
expect(appendPlan.prefixLength == 11, "append-only prefix length")
expect(appendPlan.removedCount == 0, "append-only removes nothing")
expect(appendPlan.addedText == " again", "append-only added tail")
expect(!appendPlan.suppressesRevision, "append-only update is not suppressed")

let smallCorrection = LiveKeyboardPreviewPolicy.revisionPlan(
    currentText: "this is a test camera",
    outputText: "this is a test comma",
    eventPrefix: LiveKeyboardPreviewPolicy.keyboardPreviewEventPrefix,
    keepLiveText: true
)
expect(smallCorrection.removedCount == 5, "small tail correction removes only tail")
expect(smallCorrection.addedText == "omma", "small tail correction keeps replacement")
expect(smallCorrection.suppressesRevision, "small live correction is suppressed for stable visible text")
expect(smallCorrection.appendOnlyText.isEmpty, "small live correction does not append replacement fragment")

let correctedContinuation = LiveKeyboardPreviewPolicy.revisionPlan(
    currentText: "this is a test camera",
    outputText: "this is a test comma with more words",
    eventPrefix: LiveKeyboardPreviewPolicy.keyboardPreviewEventPrefix,
    keepLiveText: true
)
expect(correctedContinuation.suppressesRevision, "corrected continuation suppresses already typed rewrite")
expect(correctedContinuation.appendOnlyText == " with more words", "corrected continuation appends only new tail words")

let longCurrent = "This is a long dictated passage that should not suddenly disappear from Hermes."
let largeLiveRewrite = LiveKeyboardPreviewPolicy.revisionPlan(
    currentText: longCurrent,
    outputText: "Hermes.",
    eventPrefix: LiveKeyboardPreviewPolicy.keyboardPreviewEventPrefix,
    keepLiveText: true
)
expect(
    largeLiveRewrite.removedCount >= LiveKeyboardPreviewPolicy.liveRevisionSuppressionThreshold,
    "large live rewrite exceeds suppression threshold"
)
expect(largeLiveRewrite.suppressesRevision, "large live rewrite is suppressed")
expect(largeLiveRewrite.appendOnlyText.isEmpty, "suppressed rewrite does not type unrelated text")

let largeRewriteMode = LiveKeyboardPreviewPolicy.revisionPlan(
    currentText: "This is a long dictated passage that can be replaced in rewrite mode.",
    outputText: "This was rewritten.",
    eventPrefix: LiveKeyboardPreviewPolicy.keyboardPreviewEventPrefix,
    keepLiveText: false
)
expect(!largeRewriteMode.suppressesRevision, "large rewrite allowed outside keep-live-text")

let keyboardCompatibilityRewrite = LiveKeyboardPreviewPolicy.revisionPlan(
    currentText: "Hermes already has this live text in the active composer.",
    outputText: "Hermes rewrote this sentence differently.",
    eventPrefix: LiveKeyboardPreviewPolicy.keyboardPreviewEventPrefix,
    keepLiveText: false,
    keyboardCompatibility: true
)
expect(
    keyboardCompatibilityRewrite.suppressesRevision,
    "keyboard compatibility suppresses live rewrite even outside keep-live-text"
)
expect(
    keyboardCompatibilityRewrite.appendOnlyText.isEmpty,
    "keyboard compatibility suppressed rewrite does not type unrelated replacement"
)

let finalRewrite = LiveKeyboardPreviewPolicy.revisionPlan(
    currentText: "This is a long dictated passage.",
    outputText: "Clean final text.",
    eventPrefix: "completion.live-preview.final",
    keepLiveText: true
)
expect(!finalRewrite.suppressesRevision, "final rewrite event not suppressed by live keyboard policy")
expect(
    LiveKeyboardPreviewPolicy.shouldSkipFinalRewrite(keepLiveText: true, keyboardCompatibility: false),
    "keep-live-text skips final rewrite"
)
expect(
    LiveKeyboardPreviewPolicy.shouldSkipFinalRewrite(keepLiveText: false, keyboardCompatibility: true),
    "keyboard compatibility skips final rewrite"
)
expect(
    !LiveKeyboardPreviewPolicy.shouldSkipFinalRewrite(keepLiveText: false, keyboardCompatibility: false),
    "plain accessibility rewrite can still run when requested"
)
expect(
    LiveKeyboardPreviewPolicy.shouldCommitLiveTextOnStop(keepLiveText: true, keyboardCompatibility: false),
    "keep-live-text commits live text immediately on stop"
)
expect(
    LiveKeyboardPreviewPolicy.shouldCommitLiveTextOnStop(keepLiveText: false, keyboardCompatibility: true),
    "keyboard compatibility commits live text immediately on stop"
)
expect(
    !LiveKeyboardPreviewPolicy.shouldCommitLiveTextOnStop(keepLiveText: false, keyboardCompatibility: false),
    "plain accessibility rewrite can wait for final cleanup when requested"
)

expect(
    LiveKeyboardPreviewPolicy.commonPrefixLength("cafe test", "cafe tone") == 6,
    "common prefix ASCII"
)
expect(
    LiveKeyboardPreviewPolicy.commonPrefixLength("cafe test", "cafe tone") == 6,
    "common prefix repeated stable check"
)

let noFirstGuess = LiveKeyboardPreviewPolicy.stabilizedPreviewText(
    previousText: nil,
    currentText: "Okay this is a Convo",
    alreadyInsertedText: "",
    holdBackWords: 2
)
expect(noFirstGuess.isEmpty, "stabilized preview does not type the first unstable guess")

let stablePrefix = LiveKeyboardPreviewPolicy.stabilizedPreviewText(
    previousText: "Okay this is a Convo Cursor Hermes",
    currentText: "Okay this is a Convo Cursor Hermes test",
    alreadyInsertedText: "",
    holdBackWords: 2
)
expect(
    stablePrefix == "Okay this is a Convo",
    "stabilized preview holds back the unstable tail words"
)

let stableNoShrink = LiveKeyboardPreviewPolicy.stabilizedPreviewText(
    previousText: "Okay this is a Convo Cursor Hermes",
    currentText: "Okay this is a Convo Cursor",
    alreadyInsertedText: "Okay this is a Convo",
    holdBackWords: 2
)
expect(
    stableNoShrink == "Okay this is a Convo",
    "stabilized preview never shrinks already typed live text"
)

// A short phrase has no live text at the stop, because live typing holds back
// its last two words. Made-up phrases.
let shortFirstPartial = LiveKeyboardPreviewPolicy.stabilizedPreviewText(
    previousText: nil,
    currentText: "fix this",
    alreadyInsertedText: "",
    holdBackWords: 2
)
let shortThreeWords = LiveKeyboardPreviewPolicy.stabilizedPreviewText(
    previousText: "fix this",
    currentText: "fix this now",
    alreadyInsertedText: "",
    holdBackWords: 2
)
expect(
    shortFirstPartial.isEmpty && shortThreeWords.isEmpty,
    "a three-word phrase has no live text when the dictation stops"
)
expect(
    LiveKeyboardPreviewPolicy.noLiveTextStopPlan(safetyStopFired: false, targetAppAvailable: true) == .typeFinalWhenReady,
    "no live text and no safety stop: the final text is typed when ready"
)
expect(
    LiveKeyboardPreviewPolicy.noLiveTextStopPlan(safetyStopFired: true, targetAppAvailable: true) == .holdFinalBack,
    "no live text after a safety stop: the final text is held back"
)
expect(
    LiveKeyboardPreviewPolicy.noLiveTextStopPlan(safetyStopFired: false, targetAppAvailable: false) == .holdFinalBack,
    "no live text and no app to type into: the final text is held back"
)

let stableResetFragment = LiveKeyboardPreviewPolicy.stabilizedPreviewText(
    previousText: "the main thing I am watching for repeated chunks flickering",
    currentText: "the main thing I am watching for repeated chunks flickering selection missing punctuation",
    alreadyInsertedText: "Okay this is earlier text",
    holdBackWords: 2
)
expect(
    stableResetFragment == "the main thing I am watching for repeated",
    "stabilized preview can pass a stable reset fragment to the stitcher"
)

let suffixOverlapStitch = LiveKeyboardPreviewPolicy.stitchedPartialResetText(
    base: "graphic assets and website building as far as",
    fragment: "as far as website appearance UI UX etc"
)
expect(
    suffixOverlapStitch == "graphic assets and website building as far as website appearance UI UX etc",
    "partial reset stitch uses suffix-prefix overlap instead of duplicating words"
)

let repeatedHermesFragment = LiveKeyboardPreviewPolicy.stitchedPartialResetText(
    base: "website appearance UI UX etc I actually created a a profile",
    fragment: "as far as website appearance UI UX etc I actually created a profile on the bottom of the session sidebar"
)
expect(
    repeatedHermesFragment == "website appearance UI UX etc I actually created a a profile on the bottom of the session sidebar",
    "partial reset stitch appends only the new tail when fragment contains the current live suffix"
)

let alreadyVisibleFragment = LiveKeyboardPreviewPolicy.stitchedPartialResetText(
    base: "front end design graphic assets website appearance UI UX etc I created a profile",
    fragment: "website appearance UI UX etc"
)
expect(
    alreadyVisibleFragment == "front end design graphic assets website appearance UI UX etc I created a profile",
    "partial reset stitch suppresses a fragment whose prefix is already visible earlier"
)

let noOverlapStitch = LiveKeyboardPreviewPolicy.stitchedPartialResetText(
    base: "one agent is ready",
    fragment: "another agent begins"
)
expect(
    noOverlapStitch == "one agent is ready another agent begins",
    "partial reset stitch still appends genuinely new fragments"
)

expect(
    SpokenPunctuationNormalizer.normalize("does punctuation work question mark") == "does punctuation work?",
    "spoken question mark becomes symbol"
)
expect(
    SpokenPunctuationNormalizer.normalize("this is better comma and this continues") == "this is better, and this continues",
    "spoken comma becomes symbol"
)
expect(
    SpokenPunctuationNormalizer.normalize("this is better comma comma and this continues") == "this is better, and this continues",
    "duplicate spoken comma collapses"
)
expect(
    SpokenPunctuationNormalizer.normalize("does punctuation work question mark question mark") == "does punctuation work?",
    "duplicate spoken question mark collapses"
)
expect(
    SpokenPunctuationNormalizer.normalize("that is done period period") == "that is done.",
    "duplicate spoken period collapses"
)
expect(
    SpokenPunctuationNormalizer.normalize("wait dot dot dot continue") == "wait... continue",
    "spoken dot dot dot becomes ellipsis"
)
expect(
    SpokenPunctuationNormalizer.normalize("wait ellipsis ellipsis continue") == "wait... continue",
    "duplicate spoken ellipsis collapses"
)
expect(
    SpokenPunctuationNormalizer.normalize("open bracket alpha close bracket") == "[alpha]",
    "spoken brackets become square brackets"
)
expect(
    SpokenPunctuationNormalizer.normalize("say word comma literally") == "say word comma literally",
    "literal cue keeps comma as a word"
)
expect(
    SpokenPunctuationNormalizer.normalize("the trial period is over") == "the trial period is over",
    "period context can stay literal"
)
expect(
    SpokenPunctuationNormalizer.normalize("version one dot two") == "version one. two",
    "spoken dot becomes symbol outside literal context"
)

// Safety stop: where the finished text goes, and what the note says.
expect(
    SafetyStopClipboardPolicy.fallback(liveWordsInApp: false, clipboardChangedDuringDictation: false)
        == .clipboardNothingTyped,
    "safety stop with nothing typed puts the text on the clipboard"
)
expect(
    SafetyStopClipboardPolicy.fallback(liveWordsInApp: true, clipboardChangedDuringDictation: false)
        == .liveWordsKeptFullVersionOnClipboard,
    "safety stop after live words were typed says live words kept, not paste"
)
let cutDuringDictation = SafetyStopClipboardPolicy.clipboardChangedDuringDictation(
    changeCountAtStart: 41,
    changeCountNow: 41,
    sawCopyOrCutShortcut: SafetyStopClipboardPolicy.isCopyOrCutShortcut(characters: "x", commandDown: true)
)
let cutStop = SafetyStopClipboardPolicy.fallback(liveWordsInApp: true, clipboardChangedDuringDictation: cutDuringDictation)
expect(
    cutDuringDictation && !cutStop.writesClipboard,
    "a Cmd+X-triggered stop does not overwrite the clipboard, even before the cut lands"
)
expect(
    !SafetyStopClipboardPolicy.fallback(liveWordsInApp: false, clipboardChangedDuringDictation: true).writesClipboard,
    "a clipboard changed during the dictation is left alone when nothing was typed"
)
expect(
    SafetyStopClipboardPolicy.clipboardChangedDuringDictation(changeCountAtStart: 41, changeCountNow: 42, sawCopyOrCutShortcut: false),
    "a clipboard change count that moved means the clipboard changed"
)
expect(
    !SafetyStopClipboardPolicy.clipboardChangedDuringDictation(changeCountAtStart: 41, changeCountNow: 41, sawCopyOrCutShortcut: false),
    "an unmoved clipboard change count means the clipboard is free to use"
)
expect(
    SafetyStopClipboardPolicy.isCopyOrCutShortcut(characters: "C", commandDown: true)
        && !SafetyStopClipboardPolicy.isCopyOrCutShortcut(characters: "v", commandDown: true)
        && !SafetyStopClipboardPolicy.isCopyOrCutShortcut(characters: "c", commandDown: false),
    "only Cmd+C and Cmd+X count as copy or cut"
)

// Silent-recording guard (2026-09-28): Whisper must never paste text made up from
// silence, and must never throw away real speech.
func silent(ok: Bool = true, heard: Bool = false, seconds: Double = 11, near: Int, strict: Int, total: Int = 500) -> Bool {
    SilentRecordingPolicy.treatAsNoSpeech(
        liveListenerRanWithoutError: ok, liveListenerHeardWords: heard, recordingSeconds: seconds,
        slicesAtOrAboveNearSilent: near, slicesAtOrAboveStrictSilent: strict, totalSlices: total
    )
}
expect(silent(near: 0, strict: 0), "the 11-second silent recording (nothing near speech level) is dropped")
expect(silent(near: 4, strict: 6), "a cough or bump (a few loud slices) does not let invented text through")
expect(!silent(near: 300, strict: 400), "real speech is kept even if Apple heard no words")
expect(!silent(heard: true, near: 0, strict: 0), "when Apple heard words, the transcript is always kept")
expect(!silent(ok: false, heard: true, near: 0, strict: 0), "Apple heard words and then reported an error: the transcript is still kept")
expect(!silent(seconds: 3, near: 0, strict: 80), "short dictation before Apple's first words: quiet real speech is kept")
expect(silent(seconds: 3, near: 0, strict: 2), "short dictation of true silence is still dropped")
expect(!silent(ok: false, near: 0, strict: 300), "Apple listener error: quiet speech around -47 dBFS is kept")
expect(silent(ok: false, near: 0, strict: 3), "Apple listener error: true silence is still dropped")
expect(!silent(near: 0, strict: 0, total: 0), "unknown loudness never drops a transcript")
expect(
    abs(SilentRecordingPolicy.dbfs(fromNormalizedLevel: 0.25) - (-45)) < 0.001
        && SilentRecordingPolicy.dbfs(fromNormalizedLevel: 0) == -60,
    "meter level converts back to dBFS"
)

// Desk window, build 9 (2026-10-09), and step 1 PR 2b (2026-10-12): with the
// Desk focused nothing goes to the last outside app; a dictation into the open
// Desk takes the Desk's own route, and only with a confirmed draft; with it
// not focused, nothing changes.
let deskFocused = DeskDictationPolicy.focus(deskWindowHoldsFocus: true, availability: .open)
expect(
    DeskDictationPolicy.decide(.dictation, focus: deskFocused) == .deskDraft,
    "Desk focused and open: dictation takes the Desk route, never the old cursor target"
)
expect(
    DeskDictationPolicy.deskStart(hasConfirmedDraft: true, focusNow: deskFocused) == .deskDraft
        && DeskDictationPolicy.deskStart(hasConfirmedDraft: false, focusNow: deskFocused) == .refuseDesk(.noDraftReady)
        && DeskDictationPolicy.deskStart(hasConfirmedDraft: true, focusNow: .focused(.locked)) == .refuseDesk(.locked)
        && DeskDictationPolicy.deskStart(hasConfirmedDraft: true, focusNow: .notFocused) == .refuseDesk(.noDraftReady),
    "Desk route: records only with a confirmed draft and the open Desk still focused"
)
expect(
    DeskDictationPolicy.decide(.typedCorrection, focus: deskFocused) == .refuseDesk(.correctionNotInDesk)
        && DeskDictationPolicy.decide(.servicesCorrection, focus: deskFocused) == .refuseDesk(.correctionNotInDesk)
        && DeskDictationPolicy.decide(.correctionOnce, focus: deskFocused) == .refuseDesk(.correctionNotInDesk),
    "Desk focused: typed, Services and one-shot corrections refused"
)
expect(
    DeskDictationPolicy.decide(.dictation, focus: .focused(.locked)) == .refuseDesk(.locked)
        && DeskDictationPolicy.decide(.dictation, focus: .focused(.unavailable)) == .refuseDesk(.unavailable),
    "Desk focused while locked or unavailable: dictation refused"
)
expect(
    DeskDictationPolicy.DictationEntry.allCases.allSatisfy { DeskDictationPolicy.decide($0, focus: .notFocused) == .externalCursor },
    "Desk not focused: outside dictation and corrections unchanged"
)
expect(
    DeskDictationPolicy.decide(.dictation, focus: DeskDictationPolicy.focus(deskWindowHoldsFocus: false, availability: .open))
        == .externalCursor,
    "Scratchpad or Settings in front: today's path, the Desk is not the target"
)
expect(
    DeskDictationPolicy.shieldBlocksSyntheticInput(deskWindowIsKey: true)
        && !DeskDictationPolicy.shieldBlocksSyntheticInput(deskWindowIsKey: false),
    "No Return, typing or paste lands in the Desk; outside apps unchanged while it is not key"
)
expect(
    DeskDictationPolicy.shieldContradicts(claimsInserted: true, claimsSent: true, heldBack: [.returnKey])
        && DeskDictationPolicy.shieldNote(heldBack: [.returnKey])?.pillMessage.hasPrefix("Not sent") == true,
    "Desk in front at the stop: a held-back Return never shows as \"Pasted + sent\""
)
expect(
    DeskDictationPolicy.shieldContradicts(claimsInserted: true, claimsSent: false, heldBack: [.paste])
        && DeskDictationPolicy.shieldNote(heldBack: [.paste])?.pillMessage.hasPrefix("Not pasted") == true,
    "Desk in front at the final paste: the pill says the text is on the clipboard, never \"Pasted\""
)
expect(
    !DeskDictationPolicy.shieldContradicts(claimsInserted: true, claimsSent: true, heldBack: []),
    "Nothing held back: outside dictation outcomes unchanged"
)

if failures > 0 {
    print("Keyboard preview policy check failed: \(failures) failure(s) across \(checks) checks.")
    exit(1)
}

print("Keyboard preview policy check passed: \(checks) checks.")
