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

**Default (recommended, awaiting the owner; see question 3):** every
docs-only pull request qualifies, protected or not. The durable P1 record
(section 2) closes the deleted-comment gap without relying on the owner's
approval. **Alternative:** only docs-only pull requests that touch a
code-owner doc qualify (`AGENTS.md`, `CLAUDE.md`, `PLAN.md`, `docs/plans/`,
`docs/decisions.md`, or another `.md` file `CODEOWNERS` assigns to the
owner, checked with `codeowners.mjs`). Unprotected docs alone would keep the
full clean rule.

## 2. How The Gate Reads Severity

Codex starts each inline finding with a badge, for example
`**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Title**`.
The review body itself carries no badge.

For a docs-only pull request, `codex-signal.mjs` checks in this order:

- **A. The veto first.** If any finding on the head counts as P1 (steps
  1 to 4 below), or the durable record shows one (below), the result is
  pending. Nothing else is looked at. Today's clean receipt and 👍 can't
  override the veto, even when Codex later gives the same head a clean
  round.
- **B. Then a clean signal is required.** That's today's receipt, review
  state or 👍, or the P1-only pass in step 5.

Code pull requests keep today's order unchanged: a later clean Codex round
on the same head still passes.

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

**Durable P1 record.** Anyone with Write access can delete a Codex comment,
and GitHub records no deletion the gate can read. Owner approval doesn't
help, because it can come before the findings or after a deletion. So the
gate keeps its own record. Commit statuses can't be edited or deleted, and
`GET /commits/{sha}/statuses` returns every status ever posted for a commit.
(Checked read-only on `d855ce6`: both of its `codex-approved` statuses are
listed, created by `github-actions[bot]`.) The workflow already has
`statuses: write`.

- Whenever the gate sees a P1 on a head commit, it posts that commit's
  `codex-approved` status as pending, with a fixed marker:
  `P1 seen: review <id>`.
- On every later evaluation, it reads the full status list for the head
  (all pages). Any status carrying the marker vetoes, even if the comment
  is gone.
- Only a new head commit starts fresh. The one other exception: the owner
  dismissed the named review (#90's rule).
- **Fake markers block.** A marker status posted by anyone, the bot
  included, counts. Statuses are only ever used to block, never to pass,
  so a fake can only hold a pull request back. Checking the creator
  wouldn't help anyway: every workflow in the repo, including a pull
  request's own run of `tests.yml`, posts as `github-actions[bot]`.
- **What's left.** The record exists only if the gate ran while the P1
  comment existed. The gate runs on Codex's summary comment edit, seconds
  after each review, and hourly. A deletion inside that window is
  possible, but needs a deliberate, fast act. AGENTS.md gains the rule
  "no agent deletes or edits another account's review comments" (section
  6), so such a deletion breaks a written rule.

**One evaluation per pull request at a time.** Today the workflow's
concurrency group is the pull request number for event runs, but `all` for
hourly and blank manual runs. So an hourly run could post success for a head
right after a per-pull-request run recorded a P1 on it. The build changes
this:

- **Per-PR lock.** Concurrency moves to the job level, keyed only on the
  pull request (`codex-approved-pr-<number>`), with `cancel-in-progress:
  false`.
- **Scheduled and blank runs.** A first job lists the open pull requests.
  A matrix job then evaluates each one under that same per-PR key. Job-level
  concurrency can use the matrix value, so no extra token permission is
  needed. GitHub keeps at most one running and one waiting run per group, and
  a newer waiting run replaces an older one. That's safe, because every run
  re-reads everything from scratch, and a replaced run posts nothing.
- **Compare and set.** Just before posting success, the gate re-reads the
  head's status history, Codex's reviews and Codex's inline comments. It
  posts success only if none of them changed since its first read.
  Otherwise it starts the evaluation over.
- **What's left.** A Codex P1 could land in the second or so between that
  final read and the success status. Codex's summary comment edit then
  queues another run for the pull request, which records the P1 and posts
  pending. Auto-merge respects that only if it hasn't merged yet. A merge
  needs `tests` and, on protected paths, the owner's approval too, so it
  rarely follows within seconds, but it can. If it does, section 3's merge
  workflow lists the late P1 at the top of that pull request's entry in the
  issue, flagged for a fix. It is never silently dropped.

## 3. Where Deferred P2s And P3s Go

**Recommended: a small merge-time workflow (option a).** It's
`.github/workflows/deferred-findings.yml`, on `pull_request_target: closed`,
and runs only when the pull request merged. Like the gate, it runs `main`'s
copy and never checks out pull request code.

**Which pull requests.** It uses the same docs-only classification as the
gate (section 1, including the scope the owner picks in question 3), from
the same shared module. Any other pull request is skipped with a log line
and nothing is written: code pull requests can't merge with open findings
anyway.

**Which findings.** It reads only the findings on the merged head commit:
the Codex reviews whose `commit_id` is that head (minus any the owner
dismissed, per #90), and their inline comments, matched by review as in
section 2. It keeps only trusted comments (#88's edit rule). Findings on
earlier commits are left out, because a later commit may have fixed them
and the gate never judged them on the merged head. It then appends one
comment to the single open issue titled **Deferred doc findings**:

- the merged head;
- each deferred P2 and P3 on that head, with its link;
- any P1 on that head found after the gate's final read (see "What's
  left").

**Permissions.** `issues: write`, `pull-requests: read`, `contents: read`,
nothing else. It's a separate workflow, so the gate keeps its read-only
token.

**Safety.**
- Pull request text never reaches a shell. The script passes it to the API
  as data.
- The comment opens with a marker, `<!-- deferred:pr-<number> -->`. A
  re-run skips any pull request that already has one, and a manual run
  (`workflow_dispatch` with a number) catches up on missed ones.
- If there isn't exactly one open issue with that title, the run fails
  loudly rather than guessing.

**Why (a) over a daily keeper copying from status descriptions.** It records
every merge with no session involved. It reads the findings themselves, not
a 140-character summary. It also leaves one auditable trail: one run log
and one comment per merge. The cost is one more workflow file with
`issues: write`, pushed with the owner's login. Fixing a finding later
means ticking it in that comment.

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
- `STATUS.md` alone, P2 only: passes under the default;
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
- the veto beats every path: a clean receipt plus a P1 on the head, pending;
  a Codex 👍 plus a P1 on the head, pending;
- durable record: P1 seen, then the comment deleted, still pending; a new
  head commit, evaluated fresh; a marker on the review the owner dismissed,
  cleared; a marker status posted by the bot, blocks (never passes);
- under the alternative only: `STATUS.md` alone with a P2 only, pending;
- compare and set: the status history or reviews change between the first
  and final read, so no success is posted;
- concurrency: every job that evaluates a pull request in
  `codex-approved.yml` uses the per-PR key, and none uses a shared key such
  as `all` (a text check on the workflow file, like today's job-name check);
- deferred findings: the comment body for a merged pull request lists its
  P2s and P3s, skips untrusted comments, flags a late P1, and is skipped
  when the marker is already present;
- deferred findings only on the merged head: a P2 on an earlier commit is
  left out;
- deferred findings only for docs-only pull requests: a merged code pull
  request (or, under the alternative, an unprotected docs pull request)
  writes nothing;
- the existing suite unchanged, with code pull requests on the full rule.

## 6. Rollout

One bot pull request carries the script change **and**, in the same
pull request, the `AGENTS.md` Review Loop update. The script can't land
without it, or the gate would pass pull requests that the written rules
still forbid. The `AGENTS.md` change rewrites the "Plans and other docs"
bullet: docs-only pull requests that qualify under section 1 need no open
P1 on the head. Their P2s and P3s go to the "Deferred doc findings" issue
(section 3) instead of being fixed first. Code pull requests are unchanged.
It also adds the rule that no agent deletes or edits another account's
review comments.
`AGENTS.md` is a code-owner path, so the owner approves both changes
together. The build pull request touches `.github/`, so it is itself held
to the full rule.

It also changes workflow files: the concurrency change in
`codex-approved.yml`, and the new `deferred-findings.yml`. The bot's token
can't push those, so the owner's login pushes that one commit, as with #87.
The scripts, tests and `AGENTS.md` are pushed by the bot. The issue
**Deferred doc findings** is opened once, by the bot, before merge. The
gate itself needs no new permission: the files list, reviews, review
comments and status history are all readable today, and the record uses
the existing `statuses: write`. Before
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
3. **Which docs-only pull requests get the P1-only rule? (Awaiting
   owner.)** *Recommendation, and the plan's default:* all docs-only pull
   requests. With the durable P1 record, this is now safe. *Alternative:*
   only those touching a code-owner doc, with unprotected docs keeping the
   full clean rule. The build follows the default unless the owner picks
   the alternative.
4. **Should a P1 on any earlier review of the same head still block?**
   *Recommendation: yes*, as specified above.
5. **Should deferred findings have a cap, such as five P2s turning the
   status pending?** *Recommendation: no cap for now.* Watch the issue
   for a month instead.
