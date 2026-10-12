# Open Convo Build Plan

## Decision

On October 12, 2026, the owner froze True Convo and made Open Convo the active
product repo. True Convo stays private as the reference and parts library.

## What the Product Is

One desktop app. The full Desk is its home; it shrinks down to a heads-up display
and dictation that works wherever the cursor is in any Mac app. The Mac app
(step 3) and the Desk (step 2) become the same application, not two products.
An iOS app that works the same way on iPhone comes later.

Longer term, the owner has discussed making it the shell for a whole operating
system people can install and customize, in the spirit of Omarchy (a configured
Linux setup). This is why it is sometimes called an OS. It is a direction, not
yet a plan.

**Reviewing the app:** for now the Desk runs on the owner's Mac. Double-click
`Start Desk.command` in the repo folder, then open http://127.0.0.1:4183 in
Codex's inline browser. No website or ChatGPT hosting is involved.

## Build Plan

Agreed October 12, 2026. **Done** means it runs, its checks pass, and the owner
has tried it. Each step ends with something the owner can try.

### Top Five, In Order

1. **One app: Desk, dictation and HUD.** Port the Mac app from True Convo
   (`apps/true-convo-mac`), with recordings off by default. The Desk opens inside
   the app; the app shrinks to the heads-up display; dictation works at the cursor
   in any Mac app and can drop text into a Desk draft without sending it.
   *Finish line:* the owner installs one build and uses dictation and the Desk
   from it.
2. **Protected storage on the Mac.** Conversations and memory saved locally,
   encrypted, with keys in Keychain; lock, restart and crash recovery tested with
   invented data first. Saves survive crashes, full disks and two windows
   editing at once. *Finish line:* kill-and-reopen tests pass and the owner's
   real conversation survives a restart.
3. **One real conversation.** One approved model route using an existing
   subscription, no paid fallback. Replies stream in, Stop works, safe retry,
   and the session reopens later without retelling. The app shows which model
   receives what before Send. *Finish line:* the owner holds a real conversation,
   quits, reopens and continues it.
4. **Clarity tools in the conversation.** Connect `packages/clarity` to the Desk:
   Wait—what? on any assistant reply, select-a-phrase corrections, saved wording
   lessons that shape later replies, with Undo. *Finish line:* the owner uses
   Wait—what? and a correction in a real conversation and sees the next reply
   follow the lesson.
5. **Chosen memory on real storage.** Remember, correct, forget and Undo on the
   protected store; memory candidates wait for the owner's approval; forgotten
   items leave AI use immediately, with a 30-day Trash. *Finish line:* the owner
   teaches, corrects and forgets something real and sees it respected.

### After the Top Five

6. Claude and Codex visible together in one session, with scoped delegation.
7. Navigator search and sorting; Related and Revisit-when reminders.
8. Reading the owner's real old sessions on the Mac, read-only.
9. First creator beta: worksheet, website export, encrypted transfer between devices.
10. Business features: one-change card, business messaging, phone handoff.
11. Canvas/Atlas knowledge view, browser annotations, family and shared spaces.
12. iOS app; later the OS shell.

## Moving Pieces From True Convo

1. **Correction and clarity library. Done October 12.** (`packages/clarity`)
2. **Conversation Desk. Ported October 12, awaiting Codex review.** (`apps/desk`)
3. **Mac app. Ported October 12 to `apps/mac`, awaiting review.** (`apps/true-convo-mac`, 134 tracked files). Swift package; built
   and checked on the Mac. Signing and release settings stay with the owner.
4. **Shared tooling, case by case** (`tools/capability-adapter`, `tools/action-guard`,
   `tools/agent-bridge`). Paid bridges and evaluation tools (`glm-bridge`,
   `muse-bridge`, `jev-helper`, `jeff`) stay in True Convo unless the owner
   chooses otherwise.

## Stays in True Convo

Strategy and interview files, `docs/reviews`, `docs/sessions`, session audits,
`USER-INTENT-HEIRARCHY`, `.claude` settings and worktrees, and any private records.

## Open Questions

- The app's name and identity. It is still named True Convo with bundle ID
  `com.trueconvo.voice-cursor`. Keeping that ID means an installed Open Convo
  build replaces the installed True Convo app and keeps its microphone and
  Accessibility permissions and settings; a new ID installs side by side and asks
  for permissions again.
- License, and when (or whether) the repo goes public.
- Whether the in-progress True Convo branches (native host proof, build 8
  trial, participant wiring) get finished here or restarted fresh.

- Where the review copy of the Desk lives. The owner reviews the app by
  annotating it inside an inline browser (Codex's in-app browser so far), and the
  Desk's update check (`src/app/preview-updates.ts`, `desk-build.json`) reloads
  that copy when a newer build is put up. Keep this feature. ChatGPT Sites
  hosting stays behind; pick a host that does not tie users to ChatGPT. The two
  tests that need a hosted build (`tests/cloud-preview.test.mjs`,
  `tests/annotation-styles.test.mjs`) get rewired once that host is chosen.

## Move Log

| Date | Piece | Source path | True Convo commit | Removed before move |
| --- | --- | --- | --- | --- |
| 2026-10-12 | Clarity library → `packages/clarity` | `cloudwork_systems/true_convo/open-convo` (src, tests, contracts, fixtures, scripts) | cloudwork_systems `3afa8144` | Owner's name in test actors and one fixture (now "owner"); `session-view-controls` test (it read a separate Studio app by relative path); `status` script (checked docs not moved); all docs and workbench receipts held back pending review. 47/47 tests and 4 proofs pass. |
| 2026-10-12 | Conversation Desk → `apps/desk` | True Convo `apps/desk` (committed files only) | True Convo `78ebb50` | README, PRODUCT.md, review docs, `.openai` hosting target, ChatGPT-site publish scripts and their tests, Mac preview launcher and its tests. Roadmap content rewritten as the Open Convo roadmap (same card IDs except `first-run-guide`); evidence links now point at this repo. Owner name removed from comments. Typecheck, build, 541/541 unit tests, 231 browser tests across 24 files and 4 native-proof tests pass. Awaiting Codex review. |
| 2026-10-12 | Mac app → `apps/mac` | True Convo `apps/true-convo-mac` (committed files only) | True Convo `78ebb50` | BUILD-PLAN.md (project history, owner's name and business notes), RELEASING.md (names the owner's signing certificate and release history), LICENSE (license is still the owner's decision). Source and tests unchanged. On the Mac: `swift build` passes; `swift test` passes 116 XCTest (37 skipped, mostly needing the packaged Desk) and 279 Swift Testing tests. |
