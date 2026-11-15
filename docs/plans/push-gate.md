# Push Gate: The One Paced Door From The Studio To GitHub

Status: Draft (Nov 12, 2026): proposed; waiting on the owner's yes. Nothing is built.

Written November 12, 2026 by a Claude Duet thread (project "Claude", task
"Draft the push gate plan for your yes?"), from a morning brief suggestion
the owner took up. Session name: `OC-261112-push-gate`. It details Build
Order step 3 of [github-app-switch.md](github-app-switch.md), which calls
this process the "push steward". The owner calls it the push gate (since
November 8), and this plan uses his name; the PR steward, the scheduled
review job, is a different thing. The owner counts this as step 2 of the
move, right after the accounts change (#319, merged November 11).

It also folds in one owner decision: on November 11, 2026 (18:54 UTC, Claude
Duet main chat), to "the Studio's OPEN-CONVO copy still signs in to GitHub
as cloudwork-bot. That's worth switching over during the app move", the
owner answered "Yes, let's be sure to do that."

**Builder:** Claude, in the OPEN-CONVO session on the Mac Studio (a cloud
session can't push). **Reviewers:** Codex, then GrokBot as the independent
review (a fresh Claude review stands in after 60 minutes). The code pull
request touches protected paths (`.github/CODEOWNERS`, `docs/agent-process.md`,
`docs/scheduled-tasks/`), so the owner approves it on GitHub. **Finish
line:** see "Finish Line" below.

## Why

- **The bot works again.** GitHub Support cleared `cloudwork-bot` on
  November 11. The owner chose to keep it idle as a spare. But the Studio's
  OPEN-CONVO folder still holds its sign-in, so any agent there (Claude,
  the local Codex CLI, GrokBot's builders) could push as the bot again,
  with no pace limit, at the volume that got it suspended on November 6.
- **Nothing paces the agents yet.** Since November 8 every push has been a
  command the owner approves in Claude Code, using a one-hour token from the
  Cloudwork Agents app (#313, #314, #319). That is safe but slow, and it
  can't run while he's at work. The app switch plan's answer is one process
  that is the only writer to GitHub and enforces the limits. This plan is
  that process in detail.

## What It Does

1. **Agents never touch GitHub.** They hand finished work to the gate as a
   request: "push this commit to this branch and open a pull request", or
   "post this comment".
2. **The gate checks, paces and writes.** It checks each request against the
   rules below, waits when a limit says so, then writes to GitHub as
   Cloudwork Agents with a one-hour token made for that one action, and
   writes back a plain result.
3. **Nothing else on the Studio is signed in to GitHub.** No agent can go
   around the gate by acting as a person or as the old bot.

## Part 1: Take The Bot's Sign-In Off The Studio (Right After The Owner's Yes)

No code needed, so it goes first. The OPEN-CONVO session on the Studio does
it, and the owner approves every command that signs anything out or deletes
anything.

1. **List what signs in today.** For the macOS user the agents run as:
   `gh`'s accounts; git's saved sign-ins for github.com (in the macOS
   Keychain); OPEN-CONVO's own git settings (sign-in lines, commit author,
   the remote address); Keychain items left from the bot (one dated
   October 20, 2026 is known); and lines in shell start-up files that set a
   GitHub sign-in. Show names and places only, never a token or password.
2. **Remove them.** Sign `gh` out of `cloudwork-bot`, and out of
   `CloudworkSystems` too: the owner's own account must not be reachable by
   agents (AGENTS.md "Accounts And Provenance"); he keeps using GitHub in his
   browser. Remove both from git's saved sign-ins, delete the old bot
   Keychain item, make the remote address plain (no name or token in it),
   and remove any start-up line that sets a GitHub sign-in (show the line
   before removing it).
3. **Commit author.** Set OPEN-CONVO's commit author to the app's own
   no-reply identity (`cloudwork-agents[bot]` and its GitHub no-reply
   address, looked up from GitHub's public user list), so new commits no
   longer show `cloudwork-bot`.
4. **Prove it.** `gh` lists no GitHub accounts; a dry-run push with no token
   is refused; reading the public repo still works.
5. **From then on,** every push is the owner-approved one-hour app token,
   exactly as for #314 and #319, until the gate runs.
6. **Owner, on github.com, when convenient (website, signed in as
   `cloudwork-bot`):** delete the bot's personal access tokens and revoke
   the GitHub CLI's authorization under its authorized apps. This moves one
   item from Build Order step 7 forward, because the account works again.
   The account itself stays as an idle spare; a new token can be made if it
   is ever needed.

The local Codex CLI and GrokBot's builders on the Studio used the same
sign-in. They haven't been able to push since November 6, so nothing new
stops; their pushes go the same way as Claude's.

Not in Part 1: the GitHub link on the owner's Claude account (cloud
sessions; still `cloudwork-bot`, and the routines that used it are paused),
which stays in Build Order step 7; and Cursor's own GitHub connection, if it
has one, checked at step 4.

## Part 2: The Gate

### Where It Lives

- `packages/push-gate/`: the library and its command line, on Node 22, with
  no dependencies, so the `tests` check runs its tests. Invented data only,
  as for every package.
- `scripts/push-gate/`: the small Mac-only part: reading the 1Password
  service account's sign-in, the background job file, and setup notes.
- Both folders are added to `.github/CODEOWNERS`, so every change to the
  gate needs the owner's approval. The gate is where the limits live; an
  agent shouldn't be able to loosen them.

### The Token Helper

- Reads the app's key through a 1Password service account: before Build
  Order step 4, the agents' existing one (shared vault, every run a command
  the owner approves); from step 4 on, the gate's own.
- Makes a short signed request as the app (App ID 5665711) and asks GitHub
  for an installation token for installation 179798275, limited to this
  repo and to the permissions the one action needs (for example contents
  for a push, pull requests for opening one, issues for a comment on #52).
- Before using a token, checks that the installation reaches exactly
  `CloudworkSystems/open-convo` and nothing else, matching the scheduled
  tasks' account check.
- Hands the token to one command, and says so in one line: "Cloudwork Agents
  token: App ID 5665711, installation 179798275, CloudworkSystems/open-convo,
  expires <time>". That is the hand-over the scheduled tasks' account check
  already asks for (docs/agent-process.md, "Accounts And Provenance").
- Revokes the token as soon as the command ends.
- The key and the token are never shown, logged, written to a file, put in
  git settings or the remote address, or passed as a command argument (where
  other processes could read it). The token reaches git through a sign-in
  helper that exists only for that one command.
- Usable on its own as `push-gate token -- <command>`, which replaces the
  hand-built commands used for #313, #314 and #319.

### Requests

A request is a small file the agent drops in the gate's waiting folder. It
names its kind, the agent (`claude`, `codex` or `grokbot`), its thread or
task, and the details below. Kinds in this step:

- **Push:** the branch, the exact commit, and a git bundle file holding that
  commit (a bundle carries commits only, never settings or hooks).
  Optionally: open a pull request, with its title and description.
- **Comment:** on an open pull request, or on issue #52.
- **Reply:** on a review thread of an open pull request.

Not in this step: merging, switching on auto-merge, approving, closing,
editing issue bodies (#254), and labels other than the builder label. Those
come with the routine moves (Build Order step 5), each with its own yes.

### Checks On Every Request

A request that fails a check is refused with one plain sentence and never
retried as it is:

- **Branch:** never `main`; a name with no spaces, no `..` and no leading
  `-`.
- **Push:** the commit in the bundle is exactly the one named; it builds on
  the current `main` (its history reaches `origin/main`); the push moves the
  branch forward only (no force push, ever); the bundle is under 50 MB.
  Changes under `.github/workflows/` are refused up front, since the app has
  no permission to push them.
- **Text** (pull request descriptions, comments, replies): ends with a line
  naming the agent and its thread or task (AGENTS.md "Accounts And
  Provenance"); never contains the owner's `owner-accepts-findings` line; no
  `@` mention of anyone but `@codex` and `@cursor`; nothing that looks like
  a GitHub token, a private key or a 1Password sign-in; under 60,000
  characters.
- **Local review (push requests):** a review record by a different agent
  than the builder, for the same commit, with the result "clean" or
  "findings answered" (github-app-switch.md "Reviews In Two Stages"). The
  gate records it in the pull request description. It shows the process was
  followed; it doesn't prove who reviewed, since every agent runs as the
  same macOS user.
- **Pull requests** open as normal (not draft), with the label `agent:
  <builder>`, auto-merge off.

### Pace Limits

From github-app-switch.md section 3, enforced here:

- **One push per pull request every 10 minutes.** A newer push request for
  the same branch replaces an older one still waiting, so fixes go up as one
  push.
- **Quiet hours, 11 PM to 6 AM New York time** (following daylight saving):
  requests wait until 6 AM. The owner can let one through with `push-gate
  allow <request>`; before step 4 every run is his approved command anyway.
- **About 60 writes an hour for all agents together** (pushes, pull
  requests, comments, replies). Over that, requests wait.
- **Stop on GitHub's limits.** A rate-limit answer (429, or GitHub's
  "secondary rate limit"): stop every write for the wait GitHub names or an
  hour, whichever is longer, then post one note on #52 once writes resume. A
  sign-in failure (401): stop every write until the owner restarts the gate.
  Any other refusal (403, 404, 422): refuse that one request with GitHub's
  reason in plain words; three such refusals in an hour stop every write
  until the owner restarts the gate.
- **The write log:** one line per write (time, kind, branch or pull request,
  result), kept 30 days in the gate's own folder. Never a token, never the
  text of a comment.

### Results

Each request gets a result file: **waiting** (why, and until when),
**done** (the commit, the pull request number and link), or **refused**
(one plain sentence on why and what to change). `push-gate status` lists
them for any agent session to read and pass on.

### Running

- **Attended (now until Build Order step 4):** `push-gate run-once` in the
  OPEN-CONVO session, as a command the owner approves, from a fresh
  worktree of `main`. It handles every waiting request with the same checks
  and limits.
- **Unattended (from step 4, the owner's setup):** a background job under
  the gate's own macOS user, once a minute. A background job can't open the
  Keychain of a macOS user who isn't signed in, so step 4 also picks where
  the gate's 1Password sign-in lives: a file only the gate's user can read,
  protected by FileVault (recommended), or keeping that user signed in in
  the background. The gate refuses a sign-in file anyone else can read.
- **Its own copy, its own code.** The gate pushes only from its own checkout,
  which agents can't write to, with git hooks off and nothing read from the
  agents' repo settings (carried from Codex on #314). It runs its code from
  its own copy of `main`, updated daily at 6 AM; since both its folders are
  owner-protected, only code the owner approved runs.

## When It Goes Wrong

1. **No connection:** requests wait, the result says "Waiting: GitHub can't
   be reached", and the gate tries again each run. Nothing is lost.
2. **Interrupted:** each request moves from waiting to working to done or
   refused, saved to disk before each step. After a crash or restart, a
   request left in "working" is first checked against GitHub (is the branch
   already at that commit, does the pull request or comment already exist)
   before anything is tried again, so nothing is pushed or posted twice.
3. **Empty or first run:** with nothing waiting it does nothing and writes
   nothing; `push-gate status` says "Nothing waiting."
4. **Denied or stuck:** if 1Password or the key can't be opened, every
   request waits with "Waiting: the push gate can't open its key. The owner
   needs to check 1Password." Attended runs show that on screen.
5. **The error message:** every refusal is one sentence naming the request
   and what to change, never a bare code.

## Tests (Code Pull Request)

Invented data, no network: a fake GitHub on `127.0.0.1`, a throwaway key
made in the test, and temporary git repos.

1. The signed request names App ID 5665711 and expires within 10 minutes.
2. A token for an installation that reaches another repo, or more than one,
   is refused.
3. The token never appears in the write log, results, error text or the
   command's arguments; it is revoked after the command.
4. A push to `main`, a force push, or a commit that doesn't build on `main`
   is refused.
5. A bundle whose commit isn't the named one is refused.
6. A change under `.github/workflows/` is refused up front.
7. Text without the sign-off line, with `owner-accepts-findings`, with an
   `@` mention of a person, or with a token look-alike is refused.
8. A push request with no local review, or one reviewed by its own builder,
   is refused.
9. Two pushes to one pull request within 10 minutes: the second waits; a
   newer request replaces an older waiting one.
10. Quiet hours hold requests until 6 AM New York time, across a daylight
    saving change.
11. The 61st write in an hour waits.
12. A 429 stops every write for the longer of GitHub's wait or an hour; a
    401 stops until restart; three other refusals in an hour stop until
    restart.
13. A request left in "working" after a crash isn't pushed or posted twice.
14. With nothing waiting, a run writes nothing.

## Build Order Inside This Step

1. **Part 1** (no pull request), right after the owner's yes.
2. **This plan's pull request:** one new file, this one.
3. **The code pull request:** `packages/push-gate/`, `scripts/push-gate/`,
   the two `.github/CODEOWNERS` lines, and the word "push steward" changed to
   "push gate" in AGENTS.md, `docs/agent-process.md`,
   github-app-switch.md and the scheduled-task files (wording only). Its
   description says it will be held by the risk check, since it names the
   1Password sign-in's setting; the owner approves that.
4. **Attended trial:** one real, small pull request goes up through
   `push-gate run-once` (the STATUS.md line recording the trial), plus one
   request the gate should refuse (a push to `main`), with the owner
   approving each run.

Then Build Order step 4 (the key move, the owner's setup) starts the gate
unattended.

## Finish Line

- **Part 1:** on the Studio's agents' user, `gh` lists no GitHub account,
  git holds no saved github.com sign-in, OPEN-CONVO has no sign-in settings,
  and a dry-run push with no token is refused. The owner has revoked the
  bot's tokens, or chosen to leave that for step 7.
- **Code:** the code pull request merges with `tests` passing, Codex's
  latest round clean or its P1s fixed, and the independent review clean.
- **Trial:** the attended trial's pull request is opened by
  `cloudwork-agents[bot]` through the gate, its write log shows the pace
  limits applied, and the `main` push is refused with a plain sentence.

Then this plan's status becomes In Progress, and Built when step 4 starts
the gate unattended.

## To Check While Building

- How the agents' user hands files to the gate's user on macOS (a shared
  folder with group permissions, writable by agents for requests and only by
  the gate for results).
- Whether Cursor keeps a GitHub sign-in of its own as `cloudwork-bot`.
- The Codex CLI's local review command, for the local review record.

## Not In This Plan

- Merges, auto-merge and the PR keeper's other writes (Build Order step 5).
- The key move and the gate's own macOS user (step 4).
- The agent ledger as the waiting folder (after #312 merges and is built).
- Project status's #254 body (step 5).
- The Mini backup (step 6) and the cloud GitHub link (step 7).
