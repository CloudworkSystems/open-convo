# Merge Gate: Automatic Merging With Enforced Checks

Written October 15, 2026 by the planning session at the owner's request.
Session name: `OC-261015-merge-gate`. Until this is finished and tried, the
owner keeps merging every pull request by hand.

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
| GrokBot | its own account | Write: branches, pull requests |
| Codex (local, on the Mac) | its own account | Write |
| Claude (building sessions) | its own account (see open question 1) | Write |
| Codex reviews | `chatgpt-codex-connector` (already separate) | Reviews only |

A pull request merges itself when all of these are true:

1. **Tests pass** (required check `tests`).
2. **Codex's review is done with nothing open** on the latest commit (required
   check `codex-approved`).
3. **The owner approved it**, but only if it touches a protected path (below).
4. Auto-merge is switched on for the pull request (the author does this when
   opening it).

No bot holds admin, so no bot can turn these rules off.

## Protected Paths (Always Need The Owner)

Listed in `.github/CODEOWNERS` with the owner as code owner, and branch
protection requires a code-owner approval:

- The rules: `AGENTS.md`, `CLAUDE.md`, `.github/` (including the checks
  themselves and `CODEOWNERS`, so no agent can weaken a check to pass it).
- Decisions: `PLAN.md`, `STATUS.md` owner-decision lines, `docs/plans/`.
- Anything handling keys, encryption or recovery in the Mac app (the building
  session lists the exact paths in the first pull request).

Everything else (module code, tests, design notes, annotations) merges
automatically once checks 1, 2 and 4 pass.

## What The Owner Does (Only He Can)

These involve accounts and credentials, so the owner does them himself; the
planning or building session walks him through each one live.

1. Create a GitHub account per agent: `GrokBot`, `Codex`, `Claude` (names
   chosen at creation, for example `cloudwork-grokbot`). Each needs its own
   email; Gmail "plus" addresses (`yourname+grokbot@gmail.com`) arrive in the
   owner's inbox. Turn on two-factor sign-in for each.
2. Invite each account to the repo as a collaborator and accept the invite
   from that account.
3. For each account, create a fine-grained access token limited to this one
   repository (contents and pull requests: read and write; nothing else) and
   put it in that agent's own secret store, never in chat, files or logs.
   Then switch each agent from the owner's login to its own.
4. Approve the repo setting changes in step 3 of the build (the session makes
   them from the owner's Mac login after approval).

## What The Building Session Builds

1. **`tests` check**: a GitHub Actions workflow that runs the tests of every
   package and app the pull request changes; fails if any fail.
2. **`codex-approved` check**: a workflow that reads Codex's review state for
   the pull request's latest commit and passes only when Codex's code review
   has completed with no unresolved findings (or Codex reacted 👍 on that
   commit). Re-runs when Codex comments or reviews. A new commit resets it.
3. **Repo settings**, after owner approval: turn on "Allow auto-merge" and
   "Automatically delete head branches"; update `main`'s protection to require
   `tests` and `codex-approved`, require code-owner review, and keep
   "applies to admins" on.
4. **`CODEOWNERS`** with the protected paths above.
5. **AGENTS.md update**: authors switch on auto-merge when opening a pull
   request; agents never merge by hand; the "owner merges" rule becomes "GitHub
   merges when the gate passes, the owner approves protected paths."
6. **A "needs the owner" list**: one pinned issue, kept current by a workflow,
   listing pull requests waiting on the owner's approval, so he checks one
   place instead of every pull request.

## Tests Before Turning It On

Run on a scratch branch with invented changes:

- A pull request with failing tests never merges.
- A pull request with an open Codex finding never merges; after the fix and a
  clean Codex round, it merges by itself.
- A pull request touching `AGENTS.md` or `.github/` waits for the owner even
  when both checks pass.
- An agent account cannot change branch protection or push to `main`.
- A new commit after Codex's approval blocks the merge until Codex reviews
  again.

## Open Questions

1. **Claude's own login.** Building sessions in the cloud reach GitHub through
   the owner's connected GitHub account. Whether a cloud session can use a
   separate account (or must stay on the owner's login and therefore count as
   the owner) needs checking before step 3. If it can't, Claude's pull requests
   still pass the same checks, but protected-path changes from Claude can't be
   approved by the owner (GitHub doesn't let an author approve their own pull
   request), so those would go through a bot account instead.
2. **Planning check for outside builders.** AGENTS.md has the planning session
   check an outside builder's work against its plan. Proposed: it stays as a
   comment, not a gate, since tests and Codex already gate the merge.
3. **Actions minutes.** Private repos get a monthly allowance of free Actions
   minutes; the tests are small, so this should fit. Watch it after a month.

## Finish Line

All five tests above pass on a scratch branch, every agent signs in as its own
account, and a normal module pull request merges by itself with no owner click.
