# Merge Gate: Automatic Merging With Enforced Checks

Written October 15, 2026 by the planning session at the owner's request.
Revised the same day after Codex's first review (five P1s, answered under
"Codex Round 1" below) and three owner decisions. Session name:
`OC-261015-merge-gate`. Until this is finished and tried, the owner keeps
merging every pull request by hand.

## Why

As more modules are built at once, the owner can't spend the day merging pull
requests. Merging should happen by itself, but only when GitHub itself can
prove the review and tests are done. A written rule isn't enough, because
today every agent signs in to GitHub as the owner (`CloudworkSystems`, the repo
owner and its only admin), so GitHub can't tell agents apart and any agent
could change the rules.

## The Design In One Picture

| Who | Signs in as | Access |
| --- | --- | --- |
| Owner | `CloudworkSystems` | Admin. Used by the owner only. |
| GrokBot, local Codex, Claude on the Mac | one shared bot account, `cloudwork-bot` | Write: branches, pull requests |
| Claude in the cloud | the owner's connected account today (see "Cloud Claude" below) | Admin today; Write once switched |
| Codex reviews | `chatgpt-codex-connector[bot]` (already separate) | Reviews only |

**One bot account, not one per agent (owner decision, October 15).** GitHub's
terms allow one free personal account plus one free machine account per person.
Three free bot accounts would break that and could be suspended, taking the
gate down with them. One shared account is enough for the gate: what GitHub
must tell apart is the owner (who can change rules) from the builders (who
can't), and the reviewer is already a separate app. Which agent built a pull
request is recorded in its branch name and a `Built-by:` line in each commit
message. If per-agent identities are needed later, use one GitHub App per
agent (free, within the terms), not more accounts.

A pull request merges itself when all of these are true:

1. **Tests pass** (required check `tests`).
2. **Codex gave a clean result for the latest commit** (required check
   `codex-approved`; exact rule below).
3. **The owner approved the latest version**, but only if it touches a
   protected path (below). Any new commit after his approval cancels it.
4. Auto-merge is switched on for the pull request (the author does this when
   opening it).

No bot holds admin, so no bot can turn these rules off.

## What Counts As Codex Approval

The `codex-approved` check passes only on an affirmative signal posted by
`chatgpt-codex-connector[bot]` itself for the pull request's current head
commit. Resolved conversations never count, since any account with write
access can resolve a finding without fixing it. Accepted signals:

- Codex's clean-result comment ("Didn't find any major issues") whose
  "Reviewed commit" matches the current head; or
- Codex's 👍 on the pull request together with its summary comment showing
  the code review completed on the current head, and no Codex review with
  findings on that head.

The check is computed by a workflow that runs from `main` (never from the pull
request's copy), and it reports a commit status that only GitHub Actions can
set. Branch protection requires that status from GitHub Actions specifically,
so no token can fake it.

## Protected Paths (Always Need The Owner)

Listed in `.github/CODEOWNERS` with the owner as code owner. Branch protection
requires a code-owner approval and **dismisses approvals when new commits are
pushed**, so the owner always approves the final version.

- The rules: `AGENTS.md`, `CLAUDE.md`, `.github/` (including the checks
  themselves and `CODEOWNERS`, so no agent can weaken a check to pass it).
- Decisions: `PLAN.md`, `docs/plans/`, and a new `docs/decisions.md`.
  CODEOWNERS works on whole files, so the "Recent Owner Decisions" list moves
  out of `STATUS.md` into `docs/decisions.md` (owner decision, October 15).
  `STATUS.md` stays open so normal pull requests can update it and still merge
  themselves.
- Keys, encryption and recovery in the Mac app, plus the paid-usage controls
  (they spend money). The exact files are listed in `CODEOWNERS`.

Everything else (module code, tests, design notes, annotations) merges
automatically once checks 1, 2 and 4 pass.

## What The Owner Does (Only He Can)

These involve accounts and credentials, so the owner does them himself; the
building session walks him through each one live. No token is ever pasted into
chat, files or logs.

1. Create one machine account, `cloudwork-bot` (or similar), with its own
   email (a Gmail "plus" address works). Turn on two-factor sign-in.
2. Invite it to the repo as a collaborator and accept from that account. On a
   personal-account repo, collaborators get Write and can never change
   settings.
3. Create one **classic** token for it with only the `repo` scope. GitHub's
   fine-grained tokens can't write to a repo owned by another personal account
   when the token's user is only a collaborator, which is the case here.
   Because the bot collaborates only on this repo, `repo` reaches only this
   repo. **No `workflow` scope**: builders can't edit `.github/workflows/`,
   which is also owner-protected. `repo` does let the token set commit
   statuses, so branch protection accepts `codex-approved` and `tests` only
   from GitHub Actions, and every workflow's own token is read-only except
   the one that posts `codex-approved`, which runs from `main` and never
   runs pull request code. Expires in 90 days. Put it in Keychain, then point
   each builder (GrokBot, local Codex) at it instead of the owner's login.
4. Approve the repo setting changes before the session makes them.

## Cloud Claude

Cloud Claude sessions reach GitHub through the account connected to the
owner's Claude account, which is today the owner's. Until that changes, cloud
Claude acts with admin rights, and the gate binds it by rule only (AGENTS.md),
not by GitHub. It also means the owner can't approve Claude's protected-path
pull requests, because GitHub doesn't let an author approve their own.

Fix, tried during the scratch tests: reconnect the Claude GitHub connection
as `cloudwork-bot`. Cloud Claude then has Write only, like the other builders.
(Cloud sessions turned out unable to change repo settings or branch
protection at all, so the owner makes those changes himself in the browser.)

**Found in scratch test 3 (#68, October 19):** GitHub does not hold a pull
request for code-owner review when the code owner opened it. A PR opened
under the owner's login that changed `AGENTS.md` merged itself once `tests`
and `codex-approved` passed. So while cloud Claude opens PRs as the owner,
protected paths bind only the bot, not Claude. The gate is not switched on
for `main` until test 3 passes with a bot-opened PR. If Claude can't be moved
to the bot, the owner merges Claude's protected-path PRs himself with
auto-merge off.

## What The Building Session Builds

1. **`tests` check**: a GitHub Actions workflow that runs the tests of every
   package and app the pull request changes; fails if any fail. The Mac app's
   tests run on a macOS runner only when `apps/mac` changes, because macOS
   minutes count ten times against the monthly allowance.
2. **`codex-approved` check**: as described above. Re-runs when Codex
   comments or reviews, on new commits, and hourly as a backstop
   for 👍 reactions (GitHub sends no event for those).
3. **Repo settings**, after owner approval: turn on "Allow auto-merge" and
   "Automatically delete head branches"; update `main`'s protection to require
   `tests` and `codex-approved` (from GitHub Actions), require code-owner
   review, dismiss stale approvals, and keep "applies to admins" on. Set the
   default workflow token to read-only and leave "Allow GitHub Actions to
   create and approve pull requests" off.
4. **`CODEOWNERS`** with the protected paths above.
5. **`docs/decisions.md`** with the decision list moved out of `STATUS.md`.
6. **AGENTS.md update**: authors switch on auto-merge when opening a pull
   request; agents never merge by hand; the "owner merges" rule becomes "GitHub
   merges when the gate passes, the owner approves protected paths."
7. **A "needs the owner" list**: one issue, kept current by a workflow,
   listing pull requests waiting on the owner's approval, so he checks one
   place instead of every pull request. The owner pins it once.

## Tests Before Turning It On

Results so far (October 19, on `gate-test`, protected like `main` will be):
1 pass (#66), 2 pass (#67), 5 pass (#69), 3 fails for owner-opened PRs (#68,
see Cloud Claude), 4 and 6 wait for the bot. Also found and fixed on the way:
an emoji in a status description that GitHub rejected (#63) and the computing
job sharing the check's name (#70).

Run on a scratch branch protected exactly like `main`, with invented changes:

1. A pull request with failing tests never merges.
2. A pull request with an open Codex finding never merges; after the fix and a
   clean Codex round, it merges by itself.
3. A pull request touching `AGENTS.md` or `.github/` waits for the owner even
   when both checks pass.
4. The bot account cannot change branch protection or push to the protected
   branch.
5. A new commit after Codex's approval blocks the merge until Codex reviews
   again.
6. A new commit after the owner's approval of a protected-path change cancels
   that approval.

## Codex Round 1 (P1s Written In As Requirements)

1. **Account limit**: one shared bot account; per-agent GitHub Apps if ever
   needed. (The Design In One Picture.)
2. **Workflow permission**: the building session writes the workflows while
   it still has the owner's access; the bot token never gets Workflows.
3. **Affirmative Codex signal**: only Codex's own clean result for the current
   head counts; resolved threads don't. (What Counts As Codex Approval.)
4. **Stale owner approval**: dismissed on every new commit; test 6 added.
5. **STATUS.md decisions**: moved to `docs/decisions.md`, which is protected.

## Open Questions

1. **Cloud Claude's login.** Whether reconnecting Claude's GitHub link as the
   bot works is checked during the scratch tests (above).
2. **Planning check for outside builders.** AGENTS.md has the planning session
   check an outside builder's work against its plan. Proposed: it stays as a
   comment, not a gate, since tests and Codex already gate the merge.
3. **Actions minutes.** Private repos get a monthly allowance of free Actions
   minutes, and macOS minutes count ten times. The Linux tests are small; the
   Mac tests are the cost to watch after a month.
4. **Owner override.** With "applies to admins" on, the owner can't merge past
   an open Codex finding with one click. For now he can switch the rule off
   briefly in settings. A safer override waits until cloud Claude no longer
   signs in as the owner.

## Finish Line

All six tests above pass on a scratch branch, every builder signs in as the
bot account, and a normal module pull request merges by itself with no owner
click.
