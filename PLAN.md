# Open Convo Build Plan

## Decision

On October 12, 2026, the owner froze True Convo and made Open Convo the active
product repo. True Convo stays private as the reference and parts library.

## What the Product Is

**Names.** The product is **True Convo**. **Open Convo** is its open-source core
("True Convo core"): the part given away that people can use and label as their
own. Non-core offerings are a True Convo subscription. Whether relabeling at all
requires a subscription is still open. The Mac app keeps the name True Convo and
its existing identity (`com.trueconvo.voice-cursor`), so an installed build
replaces today's True Convo app and keeps its permissions and settings.


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
   real conversation survives a restart. Scope and pull requests:
   [docs/plans/step-2-protected-storage.md](docs/plans/step-2-protected-storage.md).
   Owner decisions: a recovery key ships in this step, and dictation history
   and saved word fixes are protected along with the Desk.
3. **One real conversation, local first.** The first route is a local model
   through Ollama on the owner's Mac, chosen with a model picker; no paid
   fallback. Replies stream in, Stop works, safe retry, and the session reopens
   later without retelling. The app shows which model receives what before
   Send, and each cloud model and host needs the owner's one-time approval.
   Model choice is rules only for now (the owner's default plus a
   per-conversation choice). The building session tests two or three local chat
   models on the Mac and the owner picks by feel. Step 3 finishes with the
   local route only; Claude through Claude Code is the next adapter, built
   right after step 3. *Finish line:* the owner holds a real
   conversation, quits, reopens and continues it. Profiles, harnesses, billing
   and adapter order:
   [docs/design-notes/agent-profiles-and-adapters.md](docs/design-notes/agent-profiles-and-adapters.md).
4. **Clarity tools in the conversation.** Design rules from the owner: the
   explainer is an outsider. Like the old Codex "More detail" right-click, it
   answers from outside the conversation and never receives the main assistant's
   system prompt, instructions or project rules, which is why its explanations
   read more plainly. The owner highlights any part of a reply and right-clicks
   for it. Owner decision (October 13): the outsider runs on a **local model**,
   so the highlighted text never leaves the Mac. Connect `packages/clarity` to
   the Desk:
   Wait—what? on any assistant reply, select-a-phrase corrections, saved wording
   lessons that shape later replies, with Undo. *Finish line:* the owner uses
   Wait—what? and a correction in a real conversation and sees the next reply
   follow the lesson.
   Voice corrections belong here too: "when I said this, I meant that" teaches
   dictation the owner's voice and phrasing. The Mac app's `CorrectionMemory`
   ("remember this fix") is the start of it, and it feeds the later Convo engine
   for content creation.
5. **Chosen memory on real storage.** Remember, correct, forget and Undo on the
   protected store; memory candidates wait for the owner's approval; forgotten
   items leave AI use immediately, with a 30-day Trash. Owner decision
   (October 13): memory lives in **separate spaces** (Personal, one per
   business, later Family). A memory applies only in its own space unless the
   owner shares it. Sensitive details need an explicit Save, and saving never
   permits cloud use without separate approval. *Finish line:* the owner
   teaches, corrects and forgets something real and sees it respected.

### After the Top Five

- **First-run guide** (ordinary code, no AI): checks the computer, sets up a
  local model or a cloud model. Needed before anyone else installs.

6. Agents working together: the Pi harness for agent profiles, the model-based
   dispatcher, Claude and Codex visible in one session, scoped delegation.
7. Navigator search and sorting; Related and Revisit-when reminders.
8. Reading the owner's real old sessions on the Mac, read-only.
9. First creator beta: worksheet, Site Engine's first site, encrypted transfer between devices.
10. Business features: one-change card, business messaging, phone handoff.
11. Canvas/Atlas knowledge view, browser annotations, family and shared spaces.
12. iOS app; later the OS shell.

### Modules Planned (Order Within Each Decided)

- **Convo Engine** (voice): ramble-to-polished-piece, then Write Mode, then a
  Voicebox adapter for speech. Plan:
  [docs/design-notes/convo-engine.md](docs/design-notes/convo-engine.md).
- **Site Engine**: builds sites for True Convo users, the owner's businesses
  first; export plus one-click publish to the person's own free host, after a
  preview and approval. Replaces the creator beta's one-page website. Plan:
  [docs/design-notes/site-engine.md](docs/design-notes/site-engine.md).
- **Visibility Agent**: the checkup as an agent plus AI visibility, for users
  and for the owner's agency work, the owner's businesses first; ongoing watch
  later. Plan:
  [docs/design-notes/visibility-agent.md](docs/design-notes/visibility-agent.md).

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

- Which parts are open core and which are subscription-only. Everything lives
  in this private repo for now. Before the repo goes public, the subscription
  parts move to a separate private repo that builds on Open Convo.
- The license and trademark approach, which decides whether others may relabel
  the core freely or only with a subscription.
- License, and when (or whether) the repo goes public.
- Whether the in-progress True Convo branches (native host proof, build 8
  trial, participant wiring) get finished here or restarted fresh.

- Before the repo goes public: start its public history fresh or scrub it, since
  early commits contain the owner's name in code comments.
- Codex's live-conversation candidate (True Convo branch
  `codex/live-conversation-main-resolution`, 11 Desk files beyond `c527e36`) is
  not reviewed or merged. Port it with step 3 once reviewed.
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
| 2026-10-12 | Desk and Mac app brought up to date | True Convo GitHub `main` (`apps/desk`, `apps/true-convo-mac`) | True Convo `c527e36` | The first ports came from the Mac's older local copy (`78ebb50`); this applies the 3 days of reviewed work on GitHub (`78ebb50..c527e36`, 147 files): native host and storage proof, participant coordinator, paid-usage controls, test identity. Same files left behind as before. Privacy fix across `apps/mac` and `packages/clarity`: owner's name in comments and AI instructions now "the owner", owner's surname in a dictation test replaced with an invented one, memory steward's personal name now "Memory Steward". Earlier commits in this private repo still contain those words. On the Mac: library 47/47, Desk typecheck and 559/559, `swift build` passes, `swift test` 129 XCTest (37 skipped) and 692 Swift Testing tests pass. |
