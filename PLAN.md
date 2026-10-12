# Open Convo Build Plan

## Decision

On October 12, 2026, the owner froze True Convo and made Open Convo the active
product repo. True Convo stays private as the reference and parts library.

## Proposed Move Order

Each step is a fresh copy with a private-content check (see AGENTS.md). The
owner confirms the order before step 2.

1. **Correction and clarity library. Done October 12.** The original Open Convo core: 12 small
   modules, 41 passing tests, in `cloudwork_systems/true_convo/open-convo`.
   Smallest, already self-contained, and the intended open core.
2. **Conversation Desk. Ported October 12, awaiting review.** (`apps/desk`, 186 tracked files in True Convo). The
   TypeScript/Vite workspace. Strip sample data, review records and anything
   tied to the old helpers before moving.
3. **Mac app** (`apps/true-convo-mac`, 134 tracked files). Swift package. Native
   builds and checks need the Mac. Signing and release settings stay with the
   owner.
4. **Shared tooling, case by case** (`tools/capability-adapter`, `tools/action-guard`,
   `tools/agent-bridge`). Paid bridges and evaluation tools (`glm-bridge`,
   `muse-bridge`, `jev-helper`, `jeff`) stay in True Convo unless the owner
   chooses otherwise.

## Stays in True Convo

Strategy and interview files, `docs/reviews`, `docs/sessions`, session audits,
`USER-INTENT-HEIRARCHY`, `.claude` settings and worktrees, and any private records.

## Open Questions

- License, and when (or whether) the repo goes public.
- Whether the in-progress True Convo branches (native host proof, build 8
  trial, participant wiring) get finished here or restarted fresh.

- Whether Open Convo gets a hosted preview. The Desk still contains the hosted
  preview-update code (`src/app/preview-updates.ts`, the `desk-build.json` build
  step) and two tests that need a hosted build (`tests/cloud-preview.test.mjs`,
  `tests/annotation-styles.test.mjs`). True Convo's publish pipeline stayed
  behind, so those two tests are not wired to any npm script and fail without a
  hosted build. Keep and rewire, or remove, once this is decided.

## Move Log

| Date | Piece | Source path | True Convo commit | Removed before move |
| --- | --- | --- | --- | --- |
| 2026-10-12 | Clarity library → `packages/clarity` | `cloudwork_systems/true_convo/open-convo` (src, tests, contracts, fixtures, scripts) | cloudwork_systems `3afa8144` | Owner's name in test actors and one fixture (now "owner"); `session-view-controls` test (it read a separate Studio app by relative path); `status` script (checked docs not moved); all docs and workbench receipts held back pending review. 47/47 tests and 4 proofs pass. |
| 2026-10-12 | Conversation Desk → `apps/desk` | True Convo `apps/desk` (committed files only) | True Convo `78ebb50` | README, PRODUCT.md, review docs, `.openai` hosting target, ChatGPT-site publish scripts and their tests, Mac preview launcher and its tests. Roadmap content rewritten as the Open Convo roadmap (same card IDs except `first-run-guide`); evidence links now point at this repo. Owner name removed from comments. Typecheck, build, 541/541 unit tests, 231 browser tests across 24 files and 4 native-proof tests pass. Awaiting Codex review. |
