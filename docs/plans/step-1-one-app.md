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

## Built but Switched Off

**Dictating into a Desk draft.** Both halves exist: the Mac side binds a draft
at recording start and pushes the final text once (`DeskHost/DraftBinding.swift`,
`dictation.bindDraft`, `dictation.final`), and the Desk side applies it with
conflict checks (`apps/desk/src/adapters/dictation-draft.ts`). But one rule
refuses it: `DeskDictationPolicy.decide` returns "not in this build" whenever
the Desk is open and in front. Today, pressing the dictation key in the Desk
does nothing, by design, so text can't land in the wrong app.

## Missing

1. **The switch-on and wiring for Desk dictation**: lift the refusal for an open
   Desk, bind the draft when recording starts, deliver the final text into the
   draft without sending it. Corrections stay refused in the Desk, and a locked
   Desk still refuses.
2. **Shrinking to the HUD and growing back to the Desk.** Nothing does this yet.
   This needs the owner's description first (see Questions).
3. **One installable build the owner tries.** Packaging exists; signing and
   installing need the owner's approval each time.

## Proposed Pull Requests, in Order

Each one ends with something the owner can try on the Mac.

1. **Desk dictation on.** Change `DeskDictationPolicy` so an open, focused Desk
   returns a new "Desk draft" decision; wire the existing draft binding into the
   dictation start and finish paths; update the policy check and tests.
   *Owner tries:* open the Desk, unlock it, dictate, and the words appear in the
   draft, not sent. Lock it and dictation is refused.
2. **Shrink to HUD, grow to Desk.** Built to the owner's description.
   *Owner tries:* collapse the Desk to the HUD, dictate into another app, grow
   back, and the Desk is where it was.
3. **One build to install.** Run packaging and checks; the owner signs and
   installs. *Owner tries:* the finish line above.

## Risks

- `apps/mac/Sources/VoiceCursorMac/main.swift` is about 10,900 lines in one
  file. Changes in it are hard to review. PR 1 should touch it as little as
  possible and keep new rules in `VoiceCursorCore`, where they can be tested
  without the app running.
- The Desk port is still awaiting Codex review. If that review finds problems
  in the draft code, fix those before PR 1.

## Questions for the Owner

1. **What does "shrink to the HUD" look like to you?** For example: a button or
   shortcut that collapses the Desk window into the small floating dictation
   bar, and clicking the bar opens the Desk again. Or something else.
2. **Installing:** the build replaces today's True Convo app and keeps its
   permissions. OK to plan on that for the step 1 finish line?
