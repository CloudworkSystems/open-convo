# Status

Updated October 29, 2026. The short version of where the build is. The full
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
| Trial fixes (Stop, Ollama notice) | Merged (#76) |

**Next build: the Claude Code adapter** (right after step 3; invented
chats only). Scope:
[docs/plans/claude-code-adapter.md](docs/plans/claude-code-adapter.md).

| Part | State |
| --- | --- |
| PR 1: Scope | Merged (#75) |
| PR 2: Contract revision 5 and the page codec (invented chats only; started on the owner's yes, October 28) | Merged (#181) |
| PR 3a: Close the contract's pre-activation items (stale replies without a lane, the combined renderer proof, the shared handle rule, the nine page cases; inactive) | Merged (#188) |
| PR 3b: Availability for real: the sign-in check with its network blocked by macOS, Pro and Max only (the owner's D1 choice, October 29; inactive). It relies on macOS's deprecated `sandbox-exec`: if an update removes it, Claude reads as unavailable (`check-failed`, `network-block`), not as a bug. Retest the denied services on each major macOS release before relying on the block there | Merged (#195) |
| PR 3c: Context and launch: Claude runs take earlier turns (a local model's or Claude's) in the contract's fixed stdin layout, checked against the first-trial bound and resolved again at start; the app's lane pins Claude to Sonnet 5.5, the owner's choice of October 29; still never available, and the app's launcher still refuses | In review |
| PR 3d: The approval state (`host-not-approved`) and the fake-CLI host cases in the Claude vectors file, run by the Swift harness; split from 3b and 3c to keep each review small. Must pass before PR 4b | Not started |

## Done

- **Step 1: One app (Desk, dictation, HUD).** Built: the pill and the Desk
  switch with the pill's Desk button or a double tap of Right Option. The
  owner recalls trying it in True Convo Test (noted October 14). It has not
  replaced the real True Convo app; that waits for step 2's PR 5.
- **Brought over from True Convo:** clarity library, Desk, Mac app,
  Desk-to-Mac specs, Ember brand, load alarm, four module concept notes.
- **Design notes written:** agent profiles and adapters, Convo Engine, Site
  Engine, Visibility Agent, capabilities and primitives, Sage, durable agents,
  portable capability layer, agents speak for themselves, Atlas wiki and
  status lines on Canvas.

## Next

- The Claude Code adapter (started; see Now).
- Then a thin Canvas/Atlas/Navigator knowledge view.
4. Clarity tools in the conversation ("Wait—what?" on a local model).
5. Chosen memory in separate spaces.

## Beside The Main Build

**Site Engine, standalone first slice**, built by an outside builder (GrokBot
builds, Codex reviews). Plan:
[docs/plans/site-engine-standalone.md](docs/plans/site-engine-standalone.md).
Merged (#55, fixes #60 and #64).

**Household lists engine** (Family and Home), built by Codex alongside Site
Engine; P2 follow-up implements the October 17 plan and purge guard; the fixes merged as #71 on October 21. Plan:
[docs/plans/household-lists-engine.md](docs/plans/household-lists-engine.md).
First real use after step 5, synced through iCloud with the owner's approval.

**Habit grid engine** (Personal), merged as #74 on October 21.
Plan: [docs/plans/habit-grid-engine.md](docs/plans/habit-grid-engine.md).

**Annotation rounds checker** (Code), GrokBot (team A) builds, Codex reviews; plan approved (`docs/plans/annotation-rounds.md`); built and merged in #111 (Oct 23).

**Site Engine: what will change** (Business), GrokBot (team B) builds, Codex reviews; merged as #119 on October 23.

**Visibility report** (Business), GrokBot (team C) builds, Codex reviews; plan approved (`docs/plans/visibility-report.md`); built and merged in #112 (Oct 25).

**Sync core** (Personal; first slice of the iPhone and sync line, owner
decision October 22): GrokBot team B builds it as its next module, Codex
reviews. Plan approved (merged as #127 on October 24):
[docs/plans/sync-core.md](docs/plans/sync-core.md). Build in review (#139).

**Email actions preview** (Personal, right after launch), Codex builds through the local Codex CLI, GrokBot or a fresh Claude reviews; plan merged in #138; built through the Codex CLI job (#142) and merged in #144 (Oct 25) (`packages/email-actions/`, `docs/plans/email-actions-preview.md`).

**Tasks and reminders engine** (Personal, day one), GrokBot team A builds, Codex reviews; plan merged in #138, build started Oct 25 (#141) (`docs/plans/tasks-engine.md`).

**Today agenda** (Personal, day one), GrokBot team C builds, Codex reviews; plan merged in #138; built and merged in #147 (Oct 28) (`packages/today-agenda/`, `docs/plans/today-agenda.md`).

**Email sorting engine** (Personal, launch set), Claude builds (the owner's choice on October 24, in place of Codex), GrokBot or a fresh Claude reviews; plan `docs/plans/email-sorting-engine.md`; merged as #128 on October 24 (`packages/email-sorting/`).

**Calendar merge engine** (Personal, launch set), Claude builds (the owner's choice on October 24, in place of Codex), GrokBot or a fresh Claude reviews; plan approved (`docs/plans/calendar-merge-engine.md`); build in review (#130).

**Cloudwork Rail Map** (Desk, Cloudwork Nexus), Claude builds; a fifth Nexus view showing this repository's branches, commits and pull requests from a saved snapshot (`apps/desk/scripts/rail-map-snapshot.mjs`); merged October 24 (#132).

**Skin check** (Personal, new Health module), Claude builds, GrokBot or a fresh Claude reviews; plan approved (`docs/plans/skin-check.md`). Slice 1, the standalone engine in `packages/skin-check/`, is built; the iPhone source joins the iPhone app on the parallel sync line, and the Desk view follows.

**Public website (trueconvo.com)**, Claude builds, Codex reviews; a home page (with two Desk preview screenshots) and a plain-language privacy policy in `site/`, published by `.github/workflows/pages.yml` from `main` (#153, October 25). For Meta's developer early-access application and regular visitors. The owner turned on Pages and set the custom domain, and the site is published at trueconvo.com (latest deploy October 26).

**Security** (all work; owner asked October 28): plan
[docs/plans/security.md](docs/plans/security.md), in progress.
Baseline in #166: the Desk's Vite patched, Dependabot, `SECURITY.md`, and the
triage judge closed to outside pull requests. A security checklist on every
review, a weekly sweep, controls tied to triggers (sync core first), and a
weekly feed of lessons from followed senders follow.

**Followed sources** (Personal; owner asked October 29), Claude builds, GrokBot or a fresh Claude reviews: plan
[docs/plans/followed-sources.md](docs/plans/followed-sources.md), approved by the owner October 29. True Convo's own version of the
security feed: follow a sender, a links list or videos, get drafted lessons and ideas, and keep only what the
owner picks. Slice 1, the standalone engine in `packages/followed-sources/`, is built; real sources and the
Desk "Followed" view each need a plan revision.

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
October 29 (risk review, [docs/plans/risk-review.md](docs/plans/risk-review.md)):
`codex-approved` also holds a pull request that adds an outside host, a
dependency, a Mac permission or a key name until the owner approves it
(`.github/risk-allowlist.json` lists what he has already accepted), and every
independent review ends with the privacy and security checklist. Code pull
request in review; Built once the first real hold and checklist have run.

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
