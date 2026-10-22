# Open Convo Build Plan

## Decision

On October 12, 2026, the owner froze True Convo and made Open Convo the active
product repo. True Convo stays private as the reference and parts library.

## What the Product Is

**Names.** The product is **True Convo**. **Open Convo** is its open-source core
("True Convo core"): the part given away that people can use and label as their
own. Non-core offerings are a True Convo subscription. The Mac app keeps the name True Convo and
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

**Open core, protected name (owner decision, October 22).** Open Convo stays
truly open source. The name **True Convo** is protected by trademark, not by
the code license: anyone may copy and change the core, but a copy that isn't a
subscriber's may not be called True Convo, so it ships under another name or
none. A subscription lets a business put its own brand on the maintained
True Convo, choose which modules its members see, and use the modules that
haven't joined the core yet. Someone who cancels keeps everything they built
and can keep pulling core updates from the public repo; they lose the paid
modules and their own brand on True Convo. Requiring "Powered by True Convo"
in forks is deferred. Pricing and the business plan stay out of this repo.

**What joins the core (owner decision, October 22).** A module joins the core
once it runs well entirely on the user's own keys, sign-ins or local models,
at almost no ongoing cost to the project. Modules that are still in beta,
still expensive or still taking real work stay in the subscription until
they meet that bar. No module is fixed in either place ahead of time.

**Look.** True Convo's brand is **Ember** (warm near-black shell, cream text,
magenta-to-coral-to-amber accent), with Atkinson Hyperlegible Next and JetBrains
Mono. The owner chose on October 14 to make Ember the Desk's look; the tokens,
fonts and logo are in `brand/` (see `brand/README.md`). Moving the Desk and the
Mac app's native surfaces to Ember is a building-session task.

**Reviewing the app:** for now the Desk runs on the owner's Mac. Double-click
`Start Desk.command` in the repo folder, then open http://127.0.0.1:4183 in
Codex's inline browser. No website or ChatGPT hosting is involved.

## Build Plan

The rules every step and module follows are in
[docs/foundations.md](docs/foundations.md) (owner review, October 15, 2026).

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
   right after step 3. Every session gets a durable identity from day one
   (foundations, principle 17), because Canvas/Atlas follows immediately.
   *Finish line:* the owner holds a real
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

**Right after step 3, in this order (owner decision, October 15):**
1. The **Claude Code adapter** (above). Scope and pull requests:
   [docs/plans/claude-code-adapter.md](docs/plans/claude-code-adapter.md).
2. A thin first version of the **Canvas/Atlas/Navigator** knowledge view,
   reading the durable session records. Moved up from step 11. Navigator
   search and sorting stays at step 7.

### Day One And Public Launch (Owner Decision, October 22)

**Day-one proof.** A new user should see in the first session that an agent
helps them. Two things together: a chat that works like the ChatGPT app,
even on a local model such as Qwen (with fewer tools), and **tasks and
productivity** as the first real job it does. Home devices and finances come
later as modules. The owner's starting list, in his order:

1. **Checklists** (groceries and others, as kept in Apple Notes today, but
   better): the household lists engine, already built, wired into the app.
2. **Habit tracking** in a GitHub-style grid: the habit grid engine, already
   built, wired into the app.
3. **Email triage** across several inboxes: group, classify, organize,
   unsubscribe and report spam, with approval before anything is deleted,
   sent or reported. New module.
4. **One calendar** combining iCloud, Google Calendar, his work scheduling
   calendar and more; later shown on a homemade family wall display (an
   alternative to commercial family-hub screens) that syncs locally. New
   module; the wall display stays with the Family umbrella.
5. **Start on the iPhone, continue on the Mac**: sessions and tasks begun on
   one device carry on on the other. This is the sync line below.

**What ships at public launch (owner decision, October 22):** chat, the
checklists, the habit grid, start-on-iPhone-continue-on-Mac, a **Personal
calendar that only reads** (iCloud, Google, his work schedule, more) in one
view, and **email sorting and grouping only**, on a local model so mail
stays on the Mac. Right after launch: unsubscribe, report spam and delete,
each approved once as a standing rule the owner can see and switch off
(foundations principle 1). The shared family calendar, voice to calendar and
the wall display stay at step 11.

**Building your own software.** Every user gets the whole harness. Beyond
simple uses like the list above, it shows them how to build an app they need
for their own business or home, or one they want to sell, starting with
local apps on a home or office network. That growing confidence is the path
to the software factory. Building apps for users waits for step 6 (agents
working together) and comes after launch; until then public copy says it is
coming, never that it works (claim discipline).

**Public launch needs the Mac and iPhone with private sync.** The same
conversations, tasks and memory on both, with no visible sync errors and
data the project can't read. **Apple-only at launch:** sync runs on CloudKit,
each user's private iCloud database, so the project runs no sync server.
What is synced is the already-encrypted data, unlocked on each device with
the user's recovery key; turning sync on is a one-time host approval
(foundations principle 6). Windows and Android come later with their own sync.

**A parallel line, starting now.** The iPhone app and sync no longer wait for
step 5. Their standalone first slice, the sync core, is built beside the main
build by an outside builder:
[docs/plans/sync-core.md](docs/plans/sync-core.md). Wiring it into the Mac
app's storage and building the iPhone app itself stay with the building
lanes, because they touch app and storage code.

### After the Top Five

- **iPhone capture app** (owner decision, October 15; on October 22 the
  iPhone app and sync moved to a parallel line, see Day One And Public Launch
  above): a
  "Share to True Convo" button for links and the owner's own video clips,
  landing as sources in the inbox. Until then an Apple Shortcut saves shared
  items into an iCloud Drive folder the Mac app watches. That sends the items
  to Apple's iCloud, so it follows foundations principle 6: the owner approves
  iCloud Drive once as a host, seeing what goes there (links and video clips)
  and that it is end-to-end encrypted only with Advanced Data Protection on.
  AirDrop to the Mac is the local-only alternative. Automatic secure sync
  now comes from the sync core and CloudKit (October 22). The full iOS app stays at step 12.
- **First-run guide** (ordinary code, no AI): checks the computer, sets up a
  local model or a cloud model. Needed before anyone else installs.

6. Agents working together: the Pi harness for agent profiles, the model-based
   dispatcher, Claude and Codex visible in one session, scoped delegation.
   Ideas borrowed from Scion (own space per agent, agent-to-agent messages,
   one screen for all agents) are in
   [agent-profiles-and-adapters.md](docs/design-notes/agent-profiles-and-adapters.md).
7. Navigator search and sorting; Related and Revisit-when reminders.
8. Reading the owner's real old sessions on the Mac, read-only.
9. First creator beta: worksheet, Site Engine's first site. (Encrypted
   transfer between devices moved to the sync line, October 22.)
10. Business features: one-change card, business messaging, phone handoff.
11. Browser annotations, family and shared spaces (Canvas/Atlas moved up to
    right after step 3).
12. iOS app showing the same modules as the Mac, in a phone layout; later the
    OS shell.

### Beside The Main Build

Modules that stand on their own (touch no app, storage or memory code) can be
built in parallel by an outside builder under AGENTS.md "Outside Builders":

- **Site Engine, standalone slice**:
  [docs/plans/site-engine-standalone.md](docs/plans/site-engine-standalone.md).
- **Household lists engine** (Family and Home), after Site Engine:
  [docs/plans/household-lists-engine.md](docs/plans/household-lists-engine.md).
- **Habit grid engine** (Personal), after the household lists engine:
  [docs/plans/habit-grid-engine.md](docs/plans/habit-grid-engine.md).
- **Merge gate** (first piece of the Code umbrella): automatic merging once
  tests pass and Codex's review is clean, with protected paths still needing
  the owner. Plan:
  [docs/plans/merge-gate.md](docs/plans/merge-gate.md). It is an owner
  decision that changes AGENTS.md's merge rules, including the planning check
  for outside builders; until that AGENTS.md change is merged and the gate's
  tests pass, every merge stays manual and the current rules apply.

### Umbrellas (Owner Decision, October 15)

Modules group under umbrellas, each paired with a memory space type:
**Personal**, **Family** (with Home), **Business**, **Creator**, **Code** and
**Agents** (a submodule of Cloudwork Nexus at first). Each module has one
default home; the owner can move, rename or hide it. Personal is where each
Top Five step is first used and proven. Ideas for each umbrella are parked with
the step that unlocks them and surface when that step lands. Home and Family
tools (wall screen, household lists, home devices) will likely build on Home
Assistant rather than connect devices one by one.

### Modules Planned (Order Within Each Decided)

- **Convo Engine** (voice): ramble-to-polished-piece, then Write Mode, then a
  Voicebox adapter for speech. Plan:
  [docs/design-notes/convo-engine.md](docs/design-notes/convo-engine.md).
- **Site Engine**: builds sites for True Convo users, the owner's businesses
  first; export plus one-click publish to the person's own free host, after a
  preview and approval. Replaces the creator beta's one-page website. Plan:
  [docs/design-notes/site-engine.md](docs/design-notes/site-engine.md).
- **Capabilities layer and Nexus primitives**: primitives (what you ask for),
  dispatcher (who handles it), capabilities (the tools: Jev/Decisions judge,
  EmbeddingGemma search, Jeff checks, Impeccable design, ScrollCraft scroll).
  Plan: [docs/design-notes/capabilities-and-primitives.md](docs/design-notes/capabilities-and-primitives.md).
- **Visibility Agent**: the checkup as an agent plus AI visibility, for users
  and for the owner's agency work, the owner's businesses first; ongoing watch
  later. Plan:
  [docs/design-notes/visibility-agent.md](docs/design-notes/visibility-agent.md).

## Moving Pieces From True Convo

1. **Correction and clarity library. Done October 12.** (`packages/clarity`)
2. **Conversation Desk. Ported October 12, awaiting Codex review.** (`apps/desk`)
3. **Mac app. Ported October 12 to `apps/mac`, awaiting review.** (`apps/true-convo-mac`, 134 tracked files). Swift package; built
   and checked on the Mac. Signing and release settings stay with the owner.
4. **Shared tooling: brought with step 6** (owner decision, October 13). See
   "Still in the Old Folders" below.

## Stays in True Convo

Strategy and interview files, `docs/reviews`, `docs/sessions`, session audits,
`USER-INTENT-HEIRARCHY`, `.claude` settings and worktrees, and any private records.

## Open Questions

- Where the subscription modules live. The rule for what joins the core is
  set (October 22, above). Everything lives in this private repo for now;
  before the repo goes public, the subscription parts move to a separate
  private repo that builds on Open Convo.
- Registering the True Convo trademark and writing the repo's trademark
  policy, with a lawyer's review, before the repo goes public. Whether forks
  must say "Powered by True Convo" is deferred.
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

## Still in the Old Folders

Owner decisions from the group-by-group review, October 13 and 14, 2026. Nothing
here moves until its trigger; each move is privacy-checked and logged below.

**Bring with step 6 (the Pi adapter):** True Convo `tools/capability-adapter`
(becomes `packages/capabilities`), `tools/action-guard` and `tools/jev-helper`.

**Bring later, on a trigger:**
- `tools/muse-bridge`, with the Meta Muse adapter (last in the adapter order).
- The alpha app's release scripts (`cloudwork_systems/true_convo/tca_desktop/scripts`),
  rewritten for `apps/mac` at the first release, without signing details.
- Continuity's memory model
  (`cloudwork_systems/true_convo/cloudwork_continuity/docs/CONTINUITY_MEMORY_CONTEXT_MODEL.md`),
  as a reference when step 5 is planned.
- The `BrowserTrial` source (`cloudwork_systems/true_convo/tca_desktop/BrowserTrial`),
  when the inline browser is built.
- The Local Visibility Checkup template (`cloudwork_systems/louder_locally/customer-zero/local-visibility-checkup`),
  made generic (no business name or pricing) as the Visibility Agent's report
  template. Its `clients` folder never moves.
- Sage's method (`cloudwork_systems/sage`), being rewritten as
  `docs/design-notes/sage.md` (pull request #22, not yet merged); its catalog
  is used only as local seed data.
- The full illustration brief from the old brand record, when a surface needs it.
- A license and attribution register, if one turns up; it belongs with the first
  release.

**Bring now, separately:** the load alarm (`cloudwork_systems/tools/load-alarm.sh`),
cleaned of old names and fixed core counts.

**Reference only:** `cloudwork_systems/true_convo/tca_brain` (its ScrollCraft copy
is named in the capabilities note).

**Stays private:** Jeff (`tools/jeff`, `docs/2026-09-28-jeff-proposal.md`) until
its legal review.

**Business material** stays in the old workspace until a separate private
business repo is created (later, owner decision October 14). It never comes
into Open Convo.

**Leave behind:** `tools/agent-bridge` and `tools/glm-bridge` (the adapter plan
replaces them); the old status checker, router, Shared Home and Studio; the
steward, control-room and traffic-control tools; receipts, ideation,
`STRATEGY.md`, consolidation plans and founding snapshots; Sage's catalog and
receipts; the type-exploration boards and domain-routing decision; review and
session records; build output, `output/`, `tmp/` and archives.

## Move Log

| Date | Piece | Source path | True Convo commit | Removed before move |
| --- | --- | --- | --- | --- |
| 2026-10-12 | Clarity library → `packages/clarity` | `cloudwork_systems/true_convo/open-convo` (src, tests, contracts, fixtures, scripts) | cloudwork_systems `3afa8144` | Owner's name in test actors and one fixture (now "owner"); `session-view-controls` test (it read a separate Studio app by relative path); `status` script (checked docs not moved); all docs and workbench receipts held back pending review. 47/47 tests and 4 proofs pass. |
| 2026-10-12 | Conversation Desk → `apps/desk` | True Convo `apps/desk` (committed files only) | True Convo `78ebb50` | README, PRODUCT.md, review docs, `.openai` hosting target, ChatGPT-site publish scripts and their tests, Mac preview launcher and its tests. Roadmap content rewritten as the Open Convo roadmap (same card IDs except `first-run-guide`); evidence links now point at this repo. Owner name removed from comments. Typecheck, build, 541/541 unit tests, 231 browser tests across 24 files and 4 native-proof tests pass. Awaiting Codex review. |
| 2026-10-12 | Mac app → `apps/mac` | True Convo `apps/true-convo-mac` (committed files only) | True Convo `78ebb50` | BUILD-PLAN.md (project history, owner's name and business notes), RELEASING.md (names the owner's signing certificate and release history), LICENSE (license is still the owner's decision). Source and tests unchanged. On the Mac: `swift build` passes; `swift test` passes 116 XCTest (37 skipped, mostly needing the packaged Desk) and 279 Swift Testing tests. |
| 2026-10-12 | Desk and Mac app brought up to date | True Convo GitHub `main` (`apps/desk`, `apps/true-convo-mac`) | True Convo `c527e36` | The first ports came from the Mac's older local copy (`78ebb50`); this applies the 3 days of reviewed work on GitHub (`78ebb50..c527e36`, 147 files): native host and storage proof, participant coordinator, paid-usage controls, test identity. Same files left behind as before. Privacy fix across `apps/mac` and `packages/clarity`: owner's name in comments and AI instructions now "the owner", owner's surname in a dictation test replaced with an invented one, memory steward's personal name now "Memory Steward". Earlier commits in this private repo still contain those words. On the Mac: library 47/47, Desk typecheck and 559/559, `swift build` passes, `swift test` 129 XCTest (37 skipped) and 692 Swift Testing tests pass. |
| 2026-10-13 | Desk-to-Mac connection specs → `docs/desk-native-join-contract.md`, `docs/desk-native-participant-contract.md` (same names, because 15 code and test files in `apps/mac` and `apps/desk` cite them by these paths) | True Convo `docs/desk-native-join-contract.md`, `docs/desk-native-participant-contract.md` | True Convo `c527e36` | Owner's name (17 times) now "the user", with matching pronouns (the spec already uses "owner" for a code object, so "the owner" would have been ambiguous). Links to True Convo issue comments and review records turned into plain text marked "(True Convo review record, not moved)". The pointer to True Convo's old build plan is marked as not moved. Text otherwise unchanged. |
| 2026-10-13 | Four module concepts → `docs/design-notes/inline-browser-annotation.md`, `joint-sessions.md`, `business-phone.md`, `creator-protection.md` (rewritten, not copied) | True Convo `docs/2026-10-02-inline-browser-annotation-concept.md`, `docs/2026-09-30-joint-session-design.md`, `docs/2026-10-02-business-phone-product-concept.md`, `docs/2026-09-30-creator-protection-idea.md` | True Convo `c527e36` | Owner's name and nickname (now "the owner" / "[Owner]"); a link to a private Codex conversation; trial conversation and session IDs and a local record path; the owner's home-folder path in a command; an example customer count; the personal story behind creator protection and the line about the creator who inspired it; secondary news and blog sources. Meta facts marked for recheck. `docs/2026-09-28-jeff-proposal.md` stays in True Convo until Jeff's legal review. |
| 2026-10-14 | True Convo brand → `brand/` (Ember tokens, fonts with their OFL licenses, logo kit, palette swatch; `brand.md` rewritten as `brand/README.md`) | `cloudwork_systems/true_convo/brand` | cloudwork_systems `098a9de0c` | Owner's name in the rules and a token comment; the owner's local file paths; source anchors on his Desktop and Downloads; the three type-exploration boards; the domain-routing decision; the sibling-brand section (business material); the full illustration brief (summarized, kept in the old workspace); retired-mascot history. Logo files checked for embedded names (only Inkscape and cairo creator tags). |
