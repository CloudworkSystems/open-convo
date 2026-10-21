# Merge Gate: Docs-Only Pull Requests Pass Without Open P1s

Owner request, October 21, 2026. Session `OC-261021-plan-docs-p1-gate`.
Builds on [merge-gate.md](merge-gate.md). Plan only: no code changes in this
pull request.

## Why

Plan and doc pull requests loop through many Codex rounds. Each round finds
smaller P2s and P3s, and `codex-approved` passes only on a fully clean result.
The owner's direction: a docs-only pull request passes when Codex's review of
its head commit has no P1. Its P2s and P3s become tracked follow-ups. Code
pull requests keep the full rule.

## 1. What Counts As Docs-Only

The gate reads the changed files from GitHub's pull request files list,
on `main`'s side. It never checks out pull request code. A pull request is
docs-only when **every** path is one of:

- a `.md` file under `docs/` (any depth, `docs/plans/` and
  `docs/decisions.md` included);
- `STATUS.md`, `PLAN.md`, `README.md`, `AGENTS.md` or `CLAUDE.md` at the
  repo root.

Anything else makes it a code pull request. That includes any non-`.md` file
(an annotation screenshot in `docs/annotations/` too), any `.md` file under
`apps/`, `packages/`, `scripts/` or `.github/`, and `.github/CODEOWNERS`.
A rename counts both its old and new path, so moving a file from `apps/`
into `docs/` uses the code rule. So does a deleted file. If the files list is
cut short (GitHub stops at 3,000 files) or can't be read, the code rule
applies.

**Default (recommended, awaiting the owner; see question 3):** the P1-only
rule also needs at least one changed file on a code-owner path:
`AGENTS.md`, `CLAUDE.md`, `PLAN.md`, `docs/plans/`, `docs/decisions.md`, or
any other `.md` file `CODEOWNERS` assigns to the owner. The gate checks this
with the existing `codeowners.mjs`. A protected file makes GitHub require
the owner's approval for the *whole* pull request, so a plan pull request
that also adds a `STATUS.md` line still qualifies. A pull request that
touches only unprotected docs (`STATUS.md`, `README.md`, other `docs/`
files) keeps the full clean rule. That closes the deleted-comment gap
(section 2): every pull request the relaxed rule lets through also waits
for the owner.

**Alternative:** every docs-only pull request qualifies, protected or not,
and the gap is accepted.

## 2. How The Gate Reads Severity

Codex starts each inline finding with a badge, for example
`**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Title**`.
The review body itself carries no badge.

For a docs-only pull request, `codex-signal.mjs` adds a third way to pass,
next to today's signals:

1. **Findings on the head.** These are Codex reviews whose `commit_id` is
   the head commit and whose state is not `APPROVED`. A dismissed review
   still counts unless the owner dismissed it, per #90.
2. **Their findings.** Codex's inline comments are tied to a review by
   `pull_request_review_id`, not by the comment's `commit_id`. GitHub moves
   that field forward on later pushes: on #90 a finding from `d855ce6`
   showed `eefb9cf`. Each comment must pass #88's edit rule: Codex wrote it,
   and nobody but Codex ever edited it. Those edit histories come from
   GraphQL, as for issue comments. Without this rule, the bot could edit a
   P1 badge down to P2.
3. **Classify each comment.** Read the first badge at the start of the
   body. The image text `P<n> Badge` and the URL's `badge/P<n>-` must agree,
   and `n` must be 1, 2 or 3. It counts as **P1** if:
   - the badge is missing or unrecognized;
   - the text and the URL disagree;
   - the comment fails the edit rule.
4. **Fail closed on gaps.** It also counts as a P1 if:
   - a findings review has no trusted inline comment;
   - Codex's review state says the head has findings, but no findings
     review of the head is found;
   - findings are described in a review body or summary with no parseable
     badge.
5. **Pass** only if a Codex findings review of the head exists and none of
   the findings on the head counts as P1. Every review of that head counts,
   not just the latest one, because Codex doesn't repeat a finding when it
   reviews again. Resolving a thread never changes this: anyone with Write
   access can resolve one.

The status then reads, within GitHub's 140 characters, for example:
`Docs-only: no P1 on abc1234. Deferred: 2 P2, 1 P3.` Its link points to the
Codex review, so anyone can open the deferred findings.

**Deleted-comment gap.** Anyone with Write access can delete a Codex
comment. If a review held a P1 and a P2, deleting the P1 leaves only the
P2. Deleting every comment still fails closed (step 4). GitHub records no
deletion event the gate can read. Under the default in section 1, every
pull request that could pass this way also needs the owner's approval, and
he sees the review. Under the alternative, the gap stays open on
unprotected docs. See owner question 3.

## 3. Where Deferred P2s And P3s Go

The workflow token can't write issues, and it should stay that way. So the
gate only *reports* deferred findings: the count in the status
description, plus a link. The build adds a read-only script,
`.github/scripts/deferred-findings.mjs`, that lists a merged pull request's
deferred findings with links. After a docs-only pull request merges with
deferred findings, the PR keeper (a session, as the bot) runs it and adds
one comment to a single open issue, **Deferred doc findings**. The issue
holds one comment per merged pull request. Fixing a finding later means
ticking it in that comment. Everything stays in one place, written by one
account, and checkable against the script's output.

## 4. What Stays The Same

- `tests` is still required on the exact head.
- Code-owner approval is still required on code-owner paths, and stale
  approvals are still dismissed.
- Code pull requests still need a fully clean Codex result on the head.
  Nothing about them changes.
- #88's edit rule and #90's dismissal rule still apply to every signal.
- Code-owner rules in `CODEOWNERS` are unchanged. `AGENTS.md`'s wording
  changes, but only in the build pull request (section 6).

## 5. Tests The Build Pull Request Must Add

These go in `.github/scripts/tests/`, and each needs to fail without the
change:

- docs-only, P2 only: passes, and the status names the deferred P2;
- docs-only with a P1: pending;
- docs-only with an unknown or missing badge, or a text/URL mismatch:
  pending;
- docs plus code (for example `docs/x.md` and `apps/desk/a.ts`), P2 only:
  pending (code rule);
- under the default: `STATUS.md` alone with a P2 only, pending (full rule);
  `docs/plans/x.md` plus `STATUS.md` with a P2 only, passes;
- a Codex comment edited by the bot, such as a P1 badge rewritten to P2:
  pending (#88);
- a rename from `apps/` to `docs/`: code rule;
- a `.md` file under `packages/`, or an image in `docs/annotations/`: code
  rule;
- a truncated or unreadable files list: code rule;
- a findings review with no inline comments: pending;
- a P1 review dismissed by the owner: passes; dismissed by the bot: pending
  (#90);
- a finding whose comment `commit_id` moved forward but whose review is on
  the head: still counted;
- the existing suite unchanged, with code pull requests on the full rule.

## 6. Rollout

One bot pull request carries the script change **and**, in the same
pull request, the `AGENTS.md` Review Loop update. The script can't land
without it, or the gate would pass pull requests that the written rules
still forbid. The `AGENTS.md` change rewrites the "Plans and other docs"
bullet: docs-only pull requests that qualify under section 1 need no open
P1 on the head. Their P2s and P3s go to the "Deferred doc findings" issue
(section 3) instead of being fixed first. Code pull requests are unchanged.
`AGENTS.md` is a code-owner path, so the owner approves both changes
together. The build pull request touches `.github/`, so it is itself held
to the full rule. No workflow change is expected: the files list, reviews and review comments are all readable
with today's `pull-requests: read`, and Codex's reviews already re-run the
gate through its summary comment edit. If a workflow change does turn out
to be needed, the owner's login pushes that one commit, as with #87. Before
merging, do a read-only dry run on #94, #97, #98 and #99. It posts no
statuses, and the pull request lists each one's verdict before and after,
plus its deferred findings.

## 7. Owner Questions

1. **Should the rule files qualify as docs?** That means `AGENTS.md`,
   `CLAUDE.md`, `PLAN.md`, plans and decisions. *Recommendation: yes.* You
   approve each of them anyway.
2. **Should annotation rounds with screenshots qualify?** *Recommendation:
   not yet.* Images keep the code rule. Revisit if annotation pull requests
   start looping.
3. **What about the deleted-comment gap? (Awaiting owner.)**
   *Recommendation, and the plan's default:* the P1-only rule applies
   only to pull requests that touch a code-owner doc (section 1).
   Unprotected docs alone keep the full clean rule, so the owner's
   approval covers every pull request the relaxed rule passes.
   *Alternative:* accept the gap on unprotected docs, and add a line to
   `AGENTS.md` saying no agent deletes or edits another account's review
   comments. The build follows the default unless the owner picks the
   alternative.
4. **Should a P1 on any earlier review of the same head still block?**
   *Recommendation: yes*, as specified above.
5. **Should deferred findings have a cap, such as five P2s turning the
   status pending?** *Recommendation: no cap for now.* Watch the issue
   for a month instead.
