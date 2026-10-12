# Codex Review Brief: Desk Port

**Requested:** October 12, 2026
**Reviewer:** Codex, on the owner's Mac, using the existing ChatGPT subscription (no paid overflow).
**Author of the work:** Claude.

## What to Review

Commit `76446a1` ("Port the Conversation Desk into apps/desk") and `ebb23b1`
("Move the clarity library into packages/clarity") in
`/Users/patrick/OPEN-CONVO`. Compare against the frozen sources (read-only;
never write, merge into or push them):

- Desk: `/Users/patrick/True-Convo-AI/apps/desk` at commit `78ebb50`
- Library: `/Users/patrick/cloudwork_systems/true_convo/open-convo` at `3afa8144`

## Questions to Answer

1. **Private material.** Does anything in `apps/desk` or `packages/clarity`
   contain the owner's name, family or client details, business plans or prices,
   transcript excerpts, session or audit IDs (such as `B0042:C3820:3` or `DK-25`),
   real file paths, account or project IDs, keys or tokens? Check fixtures
   (including the 1 MB `tests/fixtures/native-participant-v1.json`), comments,
   CSS, test strings and `brand/`.
2. **Removed pieces.** The move log in `PLAN.md` lists what stayed behind. Did
   removing them break anything still referenced (imports, npm scripts, vite
   config, `scripts/development-source.mjs` file lists)?
3. **Roadmap rewrite.** `apps/desk/src/content/recovery-roadmap.json` was
   rewritten and `src/domain/recovery-roadmap.ts` now links evidence to this
   repo. Is the link allow-list still safe (no arbitrary URLs)? Do the three
   rewritten tests at the end of `tests/foundation/roadmap.test.ts` still prove
   what the originals proved, minus the True Convo history check?
4. **Behavior.** Anything in the Desk that differs from True Convo `78ebb50`
   other than the listed removals and the roadmap content?

## Commands

From `apps/desk`: `npm ci`, `npx tsc --noEmit`, `npm test` (expect 541/541),
`npm run test:browser`, `npm run test:native-proof`.
From `packages/clarity`: `npm test` (expect 47/47).

## Reporting

Write findings to `docs/reviews/2026-10-12-codex-review-desk-port.md`, one per
item with file, line, severity (blocker, should-fix, minor) and a suggested
fix. Do not change code, commit or push; Claude applies fixes after the review.
