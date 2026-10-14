# Status

Updated October 14, 2026. The short version of where the build is. The full
plan is in [PLAN.md](PLAN.md).

## Now

**Step 2: Protected storage on the Mac.** Scope:
[docs/plans/step-2-protected-storage.md](docs/plans/step-2-protected-storage.md).

| Part | State |
| --- | --- |
| PR 1: Keychain key for the Desk store | Merged (#17) |
| PR 2 and 2b: Desk store encrypted, reopens after restart | Merged (#18, #20) |
| PR 3 and 3b: Recovery key and its screens | Merged (#23, #25, #29) |
| PR 4: Dictation words and word fixes sealed on disk | Merged (#30) |
| PR 4b: Dictation archive key under the same recovery key | Merged (#32) |
| PR 4c: Kept recordings sealed | Merged (#34, #35) |
| PR 5: Scripted kill-and-reopen proof | In review (#36) |
| PR 5: Owner's trial in True Convo Test ([checklist](docs/plans/step-2-owner-trial.md)) | Waiting on the owner |

Until the owner's trial passes, the installed Desk is for invented data only.

## Done

- **Step 1: One app (Desk, dictation, HUD).** Built: the pill and the Desk
  switch with the pill's Desk button or a double tap of Right Option. The
  owner recalls trying it in True Convo Test (noted October 14). It has not
  replaced the real True Convo app; that waits for step 2's PR 5.
- **Brought over from True Convo:** clarity library, Desk, Mac app,
  Desk-to-Mac specs, Ember brand, load alarm, four module concept notes.
- **Design notes written:** agent profiles and adapters, Convo Engine, Site
  Engine, Visibility Agent, capabilities and primitives, Sage, durable agents.

## Next

3. One real conversation on a local model (Ollama), then the Claude Code adapter.
4. Clarity tools in the conversation ("Wait—what?" on a local model).
5. Chosen memory in separate spaces.

## Recent Owner Decisions

- **Oct 14:** Ember is the Desk's look. Business material stays out of this repo.
- **Oct 14:** Dictation protection: words first, app-only reading, one recovery
  key for everything. Accepted the known limit noted on #30.
- **Oct 13:** Step 3 runs on a local model first; the model-based dispatcher
  waits for step 6.
- **Oct 13:** The "Wait—what?" explainer runs on a local model.
- **Oct 13:** Memory lives in separate spaces (Personal, one per business,
  later Family).
- **Oct 13:** Try each step in True Convo Test before the real app.

## Keeping This File Current

Whoever merges a pull request that changes the step, a part's state or an
owner decision updates this file in the same pull request. Keep it under a
page; history belongs in PLAN.md.
