# Status

Updated October 21, 2026. The short version of where the build is. The full
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
Engine; P2 follow-up implements the October 17 plan and purge guard; the fixes merged as #71 on October 21. Plan:
[docs/plans/household-lists-engine.md](docs/plans/household-lists-engine.md).
First real use after step 5, synced through iCloud with the owner's approval.

**Habit grid engine** (Personal), merged as #74 on October 21.
Plan: [docs/plans/habit-grid-engine.md](docs/plans/habit-grid-engine.md).

**Annotation rounds checker** (Code): plan approved; GrokBot team A starts once #94 merges.

**Site Engine: what will change** (Business), GrokBot (team B) builds, Codex reviews; plan approved (`docs/plans/site-engine-diff.md`); team B can start.

**Visibility report** (Business), GrokBot (team C) builds, Codex reviews; plan approved (`docs/plans/visibility-report.md`); team C can start.

**Sync core** (Personal; first slice of the iPhone and sync line, owner
decision October 22): GrokBot team B builds it as its next module, Codex
reviews. Plan in review: [docs/plans/sync-core.md](docs/plans/sync-core.md).

**Email sorting engine** (Personal, launch set), Codex builds, Gemini Code Assist reviews; plan approved (`docs/plans/email-sorting-engine.md`); Codex can start when a builder place is free.

**Calendar merge engine** (Personal, launch set), Codex builds, Gemini Code Assist reviews; plan approved (`docs/plans/calendar-merge-engine.md`); Codex can start when a builder place is free.

**Merge gate**: pull requests merge themselves once tests pass and Codex's
review is clean; protected paths still need the owner. Plan:
[docs/plans/merge-gate.md](docs/plans/merge-gate.md). Switched on for `main`
October 20 after the scratch-branch tests passed. The bot account
(`cloudwork-bot`) exists, and since October 23 every agent works as it, apart
from Codex's GitHub app and the Actions workflows (AGENTS.md "Accounts And
Provenance"). Codex reviews pull requests by
itself, the bot's included (first seen on #120); nobody asks for reviews from
the owner's account.
October 20 fix (OC-261020-gate-package-tests): `tests` now also runs
`npm test` for every other folder in `packages/` that a pull request changes
(Site Engine, household lists, and new ones such as the habit grid), found
by folder so new packages are covered automatically.
October 21 (OC-261021-owner-accepts-findings): the owner can accept the
remaining Codex findings on one exact head commit: post a comment containing
only this line, `owner-accepts-findings <full head sha>`. Any other text in
the comment makes it not count. It satisfies only `codex-approved`.

**Building faster** (more outside modules, parallel lanes, a dogfooding
cadence): approved by the owner October 21. The limit of three outside
modules merged with the plan and was raised to five on October 23 (GrokBot's
teams plus Codex as a builder); each module plan above and the other
changes follow in their own pull requests. Plan:
[docs/plans/scale-up.md](docs/plans/scale-up.md).

## Owner Decisions

Moved to [docs/decisions.md](docs/decisions.md), which only the owner
approves.

## Keeping This File Current

A pull request that changes the step or a part's state updates this file
itself. One that records an owner decision updates
[docs/decisions.md](docs/decisions.md) instead. Keep it under a
page; history belongs in PLAN.md.
