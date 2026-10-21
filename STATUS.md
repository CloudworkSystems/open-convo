# Status

Updated October 20, 2026. The short version of where the build is. The full
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
| PR 5: Scripted kill-and-reopen proof | Merged (#36) |
| PR 5: Owner's trial in True Convo Test ([checklist](docs/plans/step-2-owner-trial.md)) | Waiting on the owner |

Until the owner's trial passes, the installed Desk is for invented data only.

**Step 3: One real conversation, local first.** Started October 15 with
invented chats only, while the step 2 trial is pending. Scope:
[docs/plans/step-3-local-conversation.md](docs/plans/step-3-local-conversation.md).

| Part | State |
| --- | --- |
| PR 1: Scope | Merged (#37) |
| PR 2: Contract revision 4 and the page codec | Merged (#38) |
| PR 3a: Ollama client, chat runs and alias binding (inactive) | Merged (#42) |
| PR 3b: Local models in availability, preparation and storage (inactive) | Merged (#48) |
| PR 3c: Local start, alias lifecycle, lock and quit (inactive) | Merged (#50) |
| PR 4a: Desk wiring: local model picker, context, reply, Stop, Retry (nothing turned on) | Merged (#54) |
| PR 4b: Turn on the local route in the Mac app (True Convo Test only), default `qwen3:8b` | Merged (#61) |
| PR 4c: Fake-Ollama host cases in the shared local vectors (26 cases, both sides) | Merged (#62) |
| PR 5: Scripted kill-mid-reply proof | Merged (#65) |
| PR 5: Owner's trial in True Convo Test ([checklist](docs/plans/step-3-owner-trial.md)) | Waiting on the owner |
| Trial fixes (Stop, Ollama notice) | In review |

**Next build: the Claude Code adapter** (right after step 3; invented
chats only). Scope:
[docs/plans/claude-code-adapter.md](docs/plans/claude-code-adapter.md).

| Part | State |
| --- | --- |
| PR 1: Scope | In review |

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

- The Claude Code adapter (started; see Now).
- Then a thin Canvas/Atlas/Navigator knowledge view.
4. Clarity tools in the conversation ("Wait—what?" on a local model).
5. Chosen memory in separate spaces.

## Beside The Main Build

**Site Engine, standalone first slice**, built by an outside builder (GrokBot
builds, Codex reviews). Plan:
[docs/plans/site-engine-standalone.md](docs/plans/site-engine-standalone.md).
In review.

**Household lists engine** (Family and Home), built by Codex alongside Site
Engine; implemented, tests pass; awaiting Claude review and planning check. Plan:
[docs/plans/household-lists-engine.md](docs/plans/household-lists-engine.md).
First real use after step 5, synced through iCloud with the owner's approval.

**Habit grid engine** (Personal), starts when Site Engine or the household
lists engine finishes.
Plan: [docs/plans/habit-grid-engine.md](docs/plans/habit-grid-engine.md).

**Annotation rounds checker** (Code), GrokBot (team A) builds, Codex reviews; plan in review: [docs/plans/annotation-rounds.md](docs/plans/annotation-rounds.md).

**Site Engine: what will change** (Business), GrokBot (team B) builds, Codex reviews; plan in review: [docs/plans/site-engine-diff.md](docs/plans/site-engine-diff.md).

**Visibility report** (Business), GrokBot (team C) builds, Codex reviews; plan in review: [docs/plans/visibility-report.md](docs/plans/visibility-report.md).

**Merge gate**: pull requests merge themselves once tests pass and Codex's
review is clean; protected paths still need the owner. Plan:
[docs/plans/merge-gate.md](docs/plans/merge-gate.md). Switched on for `main`
October 20 after the scratch-branch tests passed. The bot account
(`cloudwork-bot`) exists and builders open pull requests with it. Codex doesn't
review the bot's pull requests yet; until it does, the session that opened the
pull request asks for each Codex review from the owner's account.
October 20 fix (OC-261020-gate-package-tests): `tests` now also runs
`npm test` for every other folder in `packages/` that a pull request changes
(Site Engine, household lists, and new ones such as the habit grid), found
by folder so new packages are covered automatically.

## Owner Decisions

Moved to [docs/decisions.md](docs/decisions.md), which only the owner
approves.

## Keeping This File Current

A pull request that changes the step or a part's state updates this file
itself. One that records an owner decision updates
[docs/decisions.md](docs/decisions.md) instead. Keep it under a
page; history belongs in PLAN.md.
