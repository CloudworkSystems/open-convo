# Step 1 Scope: One App With Desk, Dictation and HUD

Written October 12, 2026. Docs only: nothing here is built until the owner
approves. Step 1 in [PLAN.md](../../PLAN.md).

**Finish line (from PLAN.md):** the owner installs one build and uses dictation
and the Desk from it.

## What Already Works

- **One app already opens the Desk.** The Mac app's menu has "Desk (invented
  data)…", which opens the Desk from `apps/desk` inside a native window
  (`DeskWindowKit`, `DeskHostWebKit`). It starts locked; unlocking asks the
  Mac's owner.
- **Dictation at the cursor** works in any other Mac app, with the floating
  live-transcript window (`LiveTranscriptWindow.swift`) and remembered
  corrections (`CorrectionMemory`).
- **Recordings are off by default** on a fresh install.
- **Packaging** (`apps/mac/scripts/package_app.sh`) builds the Desk into the app.
  The app keeps the True Convo name and bundle ID, so it replaces today's app.

## Partly Built: Dictating Into a Desk Draft

- **Mac side: built.** It binds a draft at recording start and pushes the final
  text once (`DeskHost/DraftBinding.swift`, `dictation.bindDraft`,
  `dictation.final`).
- **Desk side: only a standalone helper.** `apps/desk/src/adapters/dictation-draft.ts`
  applies text to a draft with conflict checks, but nothing in the Desk uses it
  yet: its own comment says it is not connected to the app, the native link or
  storage, and `native-bootstrap.ts` wires only the repository and participants.
  (Corrected after Codex review; the first version of this note overstated it.)
- **One rule blocks it on purpose:** `DeskDictationPolicy.decide` returns "not in
  this build" whenever the Desk is open and in front, so text can't land in the
  wrong app.

## Missing

1. **Desk dictation, both ends.** On the Desk side: capture the composer's
   draft and selection when recording starts, bind and unbind it with the Mac,
   handle the pushed `dictation.final` event, commit the result to the Desk's
   state, and send a delivery receipt back. Unbind when the session changes, the
   composer closes, the Desk locks or the owner navigates away. On the Mac side:
   lift the refusal for an open Desk and call the existing binding at recording
   start and finish. Corrections stay refused in the Desk, and a locked Desk
   still refuses.
2. **The pill as the HUD, with a way back to the Desk.** The owner decided
   (October 12): the HUD *is* the existing dictation pill
   (`LiveTranscriptWindow.swift`, the "convo cursor"), not a new design. What's
   missing is an easy way back: today nothing in the pill opens the Desk.
3. **One installable build the owner tries.** Packaging exists; signing and
   installing need the owner's approval each time.

## Proposed Pull Requests, in Order

Each one ends with something the owner can try on the Mac.

1. **Desk side of dictation.** Wire `dictation-draft.ts` into the Desk. The Mac
   sends the Desk no "recording started" signal: `beginRecording()` only
   captures whatever binding already exists. So the Desk keeps the binding
   current *before* recording: bind whenever the composer is focused and
   unlocked, rebind when the selection or session changes, unbind on blur,
   lock or navigation. Then handle `dictation.final`, commit, and send the
   receipt. Tested in the browser against a stand-in that behaves like the real
   Mac side (captures only an existing binding), so the stand-in can't hide this
   gap. (Revised after Codex's third review.)
   **Never lose words:** the Desk refuses a delivery if anything changed since
   capture (even an unrelated update), and the Mac already counts it as
   delivered, so the Mac can't rescue it. Whenever the Desk can't apply or save
   dictated text, it keeps the text and shows it to the owner to copy or insert.
   (Added after Codex's fourth review.)
   *Owner tries:* in the review copy, a simulated dictation lands in the draft,
   not sent; a simulated conflict shows the words instead of dropping them.
2. **Mac side switch-on.** Change `DeskDictationPolicy` so an open, focused Desk
   returns a new "Desk draft" decision; call the existing binding at recording
   start and finish; update the policy check and tests. Also handle **held
   text**: if the Desk unbinds mid-recording (session change, composer closed,
   navigation), the Mac keeps the words (`deliverFinal` returns `.held`) but
   nothing shows or uses them today. Surface held text to the owner (for
   example in the pill, with a copy or insert option) and clear it once used,
   so dictated words are never stranded. (Added after Codex review.)
   **A separate route for Desk recordings:** today every dictation that isn't
   refused goes through the outside-app path (remembering the cursor target,
   live typing, final paste), and paste can bring the last outside app forward
   first. A Desk recording must skip all of that and send its words only through
   `deliverFinal`, so private Desk text can never land in another app.
   (Added after Codex's fourth review.)
   *Owner tries:* open the Desk, unlock it, dictate with auto-paste and live
   preview on, and the words appear only in the Desk draft, not sent and not in
   any other app. Lock it and dictation is refused.
3. **Pill and Desk, both directions.** Proposed default, open to change:
   - In the pill: a small Desk button that opens the Desk where it was left.
   - In the Desk: a "shrink to pill" button that hides the Desk window and
     leaves the pill showing.
   - One keyboard shortcut that toggles between them. Changed October 13
     after the owner tried it: the default is now **double-tap Right Option**,
     because Control+Option+Cmd+T was too far to reach. The menu's "Desk
     Switch Shortcut" choice offers double-tap Right Option, the old four-key
     shortcut, or off. A tap only counts if it is quick and nothing else is
     pressed between the taps, so typing with Option never switches. Also in
     the menu as "Switch Desk and Pill".
   - Shrinking only hides the Desk window. An open Desk keeps its page and
     draft, and a locked one stays locked.
   *Owner tries:* shrink the Desk to the pill, dictate into another app, click
   the pill's Desk button, and the Desk is back with its draft intact.
4. **One build to install.** Today `package_app.sh` deliberately refuses to
   install or Developer ID-sign any build that includes the Desk ("trial build
   only"). This PR changes that rule, with tests, so a Desk build can be signed
   and installed once the owner approves; the owner approved replacing today's
   True Convo app on October 12. Signing and installing still happen only when
   the owner says so. (Added after Codex review.)
   As built: a Desk build that is installed or Developer ID-signed must come
   from a clean checkout. It is checked before building and again before
   signing, at the same commit, which the app records as `TCSourceCommit`.
   Other builds are byte-for-byte unchanged.
   *Owner tries:* the finish line above.

## Risks

- `apps/mac/Sources/VoiceCursorMac/main.swift` is about 10,900 lines in one
  file. Changes in it are hard to review. PRs 2 and 3 should touch it as little as
  possible and keep new rules in `VoiceCursorCore`, where they can be tested
  without the app running.
- The Desk port is still awaiting Codex review. If that review finds problems
  in the draft code, fix those before PR 1.

## Questions for the Owner

1. **Answered October 12:** the HUD is the existing pill, with an easy way back
   to the Desk. The owner accepted the PR 3 default (Desk button in the pill,
   shrink button in the Desk, one toggle shortcut) as a starting point.
2. **Answered October 12:** the step 1 build replaces today's True Convo app and
   keeps its permissions.
3. **Answered October 12 (decision A):** dictated words are kept through a
   lock, in memory only. They are lost on quit or crash until step 2 adds
   saving to disk. PR 2 is split: **2a** keeps the words (the Mac holds each
   final until the Desk confirms it saved, and sets aside anything unplaced)
   and shows set-aside words as a row in the Desk window with Copy and
   Dismiss, plus a short note on the pill. A locked Desk shows only how many,
   never the words, and closing the window with set-aside words asks first.
   **2b** switches dictation on with the separate Desk route. A Desk
   recording starts only once the host confirms the draft binding (otherwise
   the pill says to click into a draft first). It skips everything the
   outside route does: no cursor target, live typing, paste, Return,
   clipboard, history entry, kept audio or "Copy Last Dictation". Its words
   reach the Desk only through `deliverFinal`, and the pill says where they
   went. Outside clicks and keys never stop a Desk recording, since nothing
   is typed anywhere.

## Requirements Carried Into PR 1 (Codex's Fifth Review)

These are build-level details. PR 1 must meet them, and Codex checks them again
on the actual code.

- **Confirmed binding before recording.** Binding is asynchronous, so the Mac
  can read a missing or stale target if dictation starts right after the owner
  clicks into the draft. Add a readiness check or start handshake: recording
  into the Desk begins only once the Mac has confirmed the current binding. The
  browser stand-in reproduces that delay.
- **Failed deliveries survive a lock, reload or crash.** Keeping rejected text
  only on the Desk page can still lose it. The Mac keeps each final's text until
  the Desk confirms it was saved, and otherwise moves it to the held-text path
  from PR 2.
- **Rebind after every relevant revision**, not only on selection or session
  changes, coordinated with the Desk's save queue, so unrelated updates don't
  send every dictation to the fallback.
