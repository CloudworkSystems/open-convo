# GitHub App Switch: Agents Work On The Mac, One App Pushes

Status: Draft (Nov 7, updated Nov 8): proposed; waiting on the owner's yes to
merge. Owner setup (Build Order step 1) is done apart from the Mini; see
"Setup And First Test (Nov 8)". Updated after Codex's review of #314: the
app key moves out of the agents' reach (Build Order step 4) and the
emergency steps now suspend the app first (section 4).

Written November 7, 2026 at the owner's request: "Plan the GitHub App"
(Nov 7, 01:17 UTC, main chat), then "Let's explore the local option"
(02:34 UTC) and "Yes, make the PR" (04:47 UTC, Nov 6 11:47pm ET), each in
the owner's Claude Duet main chat. Session: task "261106 GITHUB APP SWITCH".
**Builder:** Claude (cloud). **Reviewers:** Codex, then GrokBot as the
independent review (a fresh Claude review stands in after 60 minutes); the
build pull requests that follow touch `.github/`, `docs/agent-process.md`
and `docs/scheduled-tasks/`, so the owner approves those on GitHub. **Finish
line:** every agent that writes to GitHub does so as the app or through the
Mac's push steward; no agent signs in as a user account; the bot's classic
tokens are revoked; and one full week passes with the pace limits below
never exceeded.

This plan is direction for three build pull requests (see "Build Order").
Each needs its own owner yes.

## Why

On November 6, 2026 GitHub suspended `cloudwork-bot`, the one machine
account every agent signs in as (AGENTS.md "Accounts And Provenance"). No
reason was given. Every push, comment and merge by every agent stopped at
once. The likeliest cause is volume: on #303 a builder pushed and Codex
reviewed about every 3 minutes from 2 to 8 AM ET on November 5, on top of
the hourly PR keeper and project status jobs.

Two problems, one cause:

- **One account is a single point of failure.** Everything rides on one
  person-style account.
- **The agents talk to GitHub far more than they need to.** Every fix is a
  push, every push is a Codex round, and the loop runs on GitHub.

## The Design In Short

1. **A GitHub App** owned by `CloudworkSystems`, installed on this repo only,
   is the one identity agents use to write to GitHub. It isn't a user
   account, so the one-free-machine-account limit doesn't apply, and the
   owner approves its pull requests as he approves the bot's today.
2. **Local-first work.** Claude, Codex and GrokBot's builders do their
   building, reviewing and fixing in the repo on the owner's Mac Studio. Only
   finished work goes to GitHub.
3. **One paced door out.** A push steward on the Mac is the only process that
   writes to GitHub, within a shared cap.
4. **GitHub stays the gate and the backup.** `tests`, `codex-approved`,
   code-owner approvals, Codex's review app, issues #52, #114 and #254, and
   the `pages` and `front-porch-deploy` workflows are unchanged.

GitHub is not made backup-only: the merge gate, the owner's approvals and
the deploys live there, and rebuilding them on the Mac isn't worth it.

## Where cloudwork-bot Is Used Today

| Agent | How it reaches GitHub |
| --- | --- |
| Claude in the cloud (Claude Duet threads, steering threads) | The GitHub account linked to the owner's Claude account, `cloudwork-bot` since October 23 (merge-gate.md "Cloud Claude") |
| Scheduled routines: PR keeper (hourly at :10), project status (hourly at :40), PR steward (8:41 AM and 5:41 PM), daily list (7:52 AM), security sweep (Mondays), recycling pass (Sundays) | The same linked account; each starts by checking that GitHub says `cloudwork-bot` |
| Claude Code and the local Codex CLI on the Mac | The bot's classic token |
| GrokBot's builders (Cursor) | Listed as `cloudwork-bot` in AGENTS.md; comments post as `cursor[bot]` |
| Builders' VM on exe.dev (planned) | A separate classic bot token |

Not affected: Codex's own app (`chatgpt-codex-connector[bot]`) and the
Actions workflows (`github-actions[bot]`).

Files that name the bot and change in the build pull requests:
`.github/scripts/codex-triage.mjs` (`JUDGE_AUTHORS`),
`.github/scripts/codeowners.mjs` and `.github/scripts/risk-check.mjs` (the
"reopen it from cloudwork-bot" messages), `.github/scripts/tests/gate.test.mjs`,
AGENTS.md and `docs/agent-process.md` ("Accounts And Provenance", the Who
Does What table), and every file in `docs/scheduled-tasks/` (their account
checks and "count only comments by `cloudwork-bot`" rules). Plans and design
notes that mention the bot in passing are left to the recycling pass.

## 1. The App

- **Owner:** `CloudworkSystems` (Settings > Developer settings > GitHub
  Apps). Installable only on that account, installed on **open-convo only**.
  Webhook off.
- **Name:** something other than `cloudwork-bot`, for example "Cloudwork
  Agents" (login `cloudwork-agents[bot]`), so nobody mixes the two up.
- **Repository permissions:**

| Permission | Level | Why |
| --- | --- | --- |
| Metadata | Read | Required |
| Contents | Read and write | Push branches; the keeper's merges |
| Pull requests | Read and write | Open, comment, review, switch on auto-merge |
| Issues | Read and write | Comments on #52, the #254 body, #114 |
| Actions, Checks | Read | Read runs and results |
| Commit statuses | Read | The app must not post `tests` or `codex-approved` |
| Workflows | None | As today: no agent edits `.github/workflows/` |
| Administration, Secrets, Environments, Deployments, Pages | None | No agent changes settings, secrets or deploys |

- **Keys:** only the push steward can read the app's private key. The key
  lives in its own 1Password vault, separate from "True Convo AI", and the
  only thing that can open that vault is a second service account used by
  the push steward alone. The agents' service account (docs/decisions.md,
  October 31 and November 1) loses access to the key. The push steward runs
  as its own macOS user on the Studio, and that second service account's
  sign-in sits in that user's Keychain, which the agents' macOS user can't
  read. So an agent can't make its own app token and skip the paced door:
  its only way to GitHub is to hand work to the push steward's queue. The
  push steward uses the key to get an installation token that lasts one
  hour and reaches only this repo. No token is written to a file or a log.
  If an Actions workflow ever needs to act as the app, the key goes in a
  repository secret and the workflow uses `actions/create-github-app-token`
  pinned to a commit hash. Keys are rotated yearly (GitHub allows two at
  once), and at once on any doubt, using the emergency steps in section 4.
- **Limits:** for one repo the app gets the same 5,000 requests an hour as a
  user. It gives a safer identity, not more headroom; the pace limits are
  what stop a repeat.
- **Branch protection on `main`:** unchanged requirements. The app is on no
  bypass list, and `tests` and `codex-approved` are accepted only from
  GitHub Actions.
- **Authorship:** pull requests show the app as author. The owner isn't the
  author, so he can approve them and code-owner review works as today.
  Commits keep each tool's own marks. Pushes made with an app token start
  workflows, unlike pushes made by a workflow with its own built-in
  credentials.

Not used: linking the owner's Claude account's GitHub to `CloudworkSystems`
(agents would act as the owner, and he couldn't approve their pull
requests), and any new user account for agents (GitHub treats that as
dodging a suspension).

## 2. Local-First Work On The Mac

### Two Macs, Two Jobs (Owner Decision, November 7, 2026)

The owner chose this split ("Yes, split it that way", Nov 7, 06:28 UTC,
main chat):

- **Mac Studio: the owner's desk and the main agent setup.** The owner works here,
  talks to agents, reviews their work and approves it. Everything in the
  rest of this section runs here: the Remote Control server, Claude
  Desktop's local scheduled tasks, the Codex CLI, GrokBot's builders, the
  agent ledger and the push steward with the app key. It is always on and
  kept awake.
- **Mac Mini: the agents' own machine.** Always on, with no display or
  keyboard; the owner never sits at it and reaches it only through Screen
  Sharing from the Studio. It has two jobs:
  1. **Experiments.** Software-factory-style trials (long unattended agent
     runs, new harnesses, new models) happen here, away from the real work.
     The Mini holds no app key and no 1Password service account, so nothing
     it runs can push, comment or merge. An experiment worth keeping is
     handed to the Studio as a patch or branch and goes through the normal
     path there: local review, the push steward, GitHub's gate.
  2. **A backup copy of open-convo that updates itself.** A local scheduled
     job on the Mini fetches every branch and tag from GitHub into a bare
     mirror once an hour. The repo is public, so this needs no sign-in and
     no key, and a suspended or lost account can't stop it. If GitHub ever
     locks the owner out, the mirror holds every branch up to the last
     hour and can be pushed to any other host. Work on the Studio that
     isn't pushed yet is not in this mirror; covering it means the Studio
     also sends its branches to the Mini over the home network, which needs
     Remote Login (SSH) switched on on the Mini, key-only and reachable
     from the home network only. That second part waits for the owner's yes.

What the split changes: a crash or runaway experiment on the Mini can't
touch the real work or the app key, and the Studio's load stays on the work
the owner is watching. What it doesn't change: the Studio is still the one
machine the real agents run on, so "What Gets Worse" below still applies to
it, and the Mini's backup doesn't keep the agents working if the Studio is
down.

The rest of this section describes the Studio.

- **Claude:** Claude Code's Remote Control runs Claude sessions on the Mac
  while the owner talks to them from claude.ai or the Claude app. It makes
  outgoing HTTPS connections only and opens no port. It needs a claude.ai
  subscription sign-in on the Mac (not an API key) and a running
  `claude remote-control` process in worktree mode, so parallel sessions
  each get their own worktree. This also solves cloud Claude's problem:
  claude.ai's GitHub link is always a person, so a cloud session can't use
  the app; a session on the Mac uses the app through the push steward.
- **Codex:** the local Codex CLI keeps building on the Mac
  ([coordinator-playbook.md](../coordinator-playbook.md) "Running The Local
  Codex CLI"). Codex's cloud builds stop being used for this repo.
- **GrokBot:** its builders work in Cursor on the Mac against the local
  repo. Cursor's cloud agents only see GitHub, so they stop being used for
  this repo if that's where they run today (to check).
- **The push steward:** one process on the Mac is the only writer to
  GitHub. It reads the ready-to-push queue, pushes the branch, opens the
  pull request with its `agent:` label and sign-off line, posts the comments
  other agents hand it, and copies GitHub results back into the queue.

### Reviews In Two Stages

1. **On the Mac, before any push.** A different agent reviews the work
   locally (Codex CLI reviews Claude's and GrokBot's; Claude reviews
   Codex's), using the Review Guidelines in AGENTS.md and the privacy and
   security checklist. Fixes loop here, under the watchdog's limits
   ([review-loop-watchdog.md](review-loop-watchdog.md): 6 rounds for a plan,
   8 for code), counted locally the same way.
2. **On GitHub, once.** The push steward pushes the finished branch. Codex's
   GitHub review and `tests` run as now. Findings go back to the Mac and
   return as one batched push.

The local review is extra; it never replaces the GitHub gate.

### Scheduled Jobs

Claude Desktop's local scheduled tasks run on the Mac, at most hourly from
the form, only while the Desktop app is open and the Mac is awake, with one
catch-up run after a sleep.

- **Move to the Mac:** PR keeper, PR steward, recycling pass, security sweep
  (it can then also check the app key's age and the service account's
  reach). Their GitHub writes go through the push steward.
- **May stay in the cloud, read-only:** daily list and project status. The
  repo is public, so reading needs no sign-in. Their writes go through the
  push steward, or project status moves into the agent ledger.
- Each move is a change to `docs/scheduled-tasks/` and to the routine
  itself, both with the owner's yes.

### The Agent Ledger As The Shared Desk

The agent ledger ([PR #312](https://github.com/CloudworkSystems/open-convo/pull/312),
unmerged) is a local, append-only list on the Mac with each entry stamped by
its writer. Here it carries: claims ("working on branch X"), "ready for
local review" and its result, "ready to push" (the push steward's queue), and
what happened on GitHub. An entry is never a yes; approvals stay where they
are, and the approval ledger stays separate. Until the ledger is built, the
queue is a plain file the push steward reads.

## 3. Pace Limits

On top of the watchdog's round limits:

- **One push per pull request every 10 minutes at most.** Builders batch
  fixes.
- **No pushes between 11 PM and 6 AM ET** unless the owner asked for that
  job.
- **About 60 GitHub writes an hour for all agents together** (pushes,
  comments, reviews, merges), enforced by the push steward. GitHub's
  guidance caps content-creating requests at roughly 80 a minute and 500 an
  hour; staying well under keeps the activity ordinary.
- **Stop at once** on a "secondary rate limit", 403 or 429 reply, and report
  it on issue #52.
- **Project status every 2 hours**, and the keeper skips a run when nothing
  changed since its last one.

## 4. Security

- No inbound ports or tunnels into either Mac from the internet: Remote
  Control, the push steward and the Mini's backup job only make outgoing
  connections.
- The Studio holds the work and the running agents. The app key is
  reachable only from the push steward's own macOS user, through its own
  service account (section 1, "Keys"). FileVault stays on and the screen
  locks when the owner is away. The agents' service account stays limited
  to the "True Convo AI" vault, which no longer holds the app key.
- No user account's GitHub sign-in stays where agents run. `gh` and git's
  credential store on the agents' macOS user are signed out of
  `cloudwork-bot` and `CloudworkSystems`; the owner uses GitHub in the
  browser. Otherwise an agent could skip the push steward by acting as a
  person.
- The Mini holds no app key, no 1Password service account and no GitHub
  sign-in. Screen Sharing on it is reachable from the home network only,
  never forwarded to the internet. Experiments that need other sign-ins get
  their own, kept on the Mini, never the Studio's.
- The app's reach stays one repo, Write-level, no workflows, no settings,
  one-hour tokens.
- **If the key or a token may have leaked**, in this order:
  1. Suspend the app's installation on this repo (CloudworkSystems'
     settings, GitHub Apps, Cloudwork Agents, Configure, Suspend). GitHub
     then refuses every token the app already made, at once.
  2. Generate a new private key on the app's page and delete the old one.
     Deleting a key alone is not enough: tokens made from it keep working
     until they expire, up to an hour later.
  3. Put the new key in the push steward's vault.
  4. Check the repo's recent pushes, comments and pull requests by the app
     for anything the owner didn't expect.
  5. Unsuspend the installation only on the owner's yes.
- Remote Control keeps session transcripts on Anthropic's servers, as cloud
  sessions do today.

## 5. What Gets Worse

- **The Studio runs everything.** A restart, power cut or network outage
  stops every agent. After a restart with FileVault on, nothing runs until
  the owner signs in; then the Remote Control server and Claude Desktop must
  start as login items. A keep-alive script restarts the Remote Control
  server, which exits after about 10 minutes without network.
- **Shared processor and memory:** fewer lanes at once, especially with
  Swift builds.
- **Unpushed work is invisible** to anything that reads GitHub, and to the
  Mini's backup until the Studio-to-Mini copy is set up.
- **The Mini is headless.** After a restart with FileVault on, it waits at
  the unlock screen and its backup job pauses until it is unlocked.
- **The backup copy is not a second setup.** If the Studio is down, the
  agents stop; the Mini keeps the code safe, not the work moving.

## 6. What Open Convo Users Could Get From This

Local-first is how Open Convo and True Convo users are most likely to run
agents, without GitHub. Pieces this setup tries first that could become the
product's defaults: the local folder as the source of truth; the agent
ledger as the coordination layer; a second agent's review before work counts
as finished; one paced, capped door off the machine, with the user's yes for
anything that matters; and reaching local agents from a phone (Remote
Control here, Open Convo's own mailbox and front porch for users). Only for
this repo: the GitHub App, branch protection, CODEOWNERS, the `tests` and
`codex-approved` checks, the review bots and the GitHub-hosted reports.

## Build Order

Each step is its own pull request after the owner's yes for it.

1. **Owner setup (no pull request):** create and install the app, put its
   key in 1Password, check branch protection, check where GrokBot's builders
   run, start the Remote Control server and Claude Desktop at login on the
   Studio; on the Mini, turn on Screen Sharing (home network only).
2. **Accounts pull request** (protected paths): add the app's login next to
   `cloudwork-bot` everywhere comments or authors are trusted, so old and new
   both count during the move; change the scheduled tasks' account check
   (an installation token can't call `GET /user`, so the check becomes "this
   is the app's installation on this repo"); update Accounts And Provenance
   and Who Does What; update the tests.
3. **Push steward pull request:** the token helper (reads the key through
   its own service account, gets a one-hour token, passes it to `gh` and `git`
   for one command), the queue, the pace limits and the local review step.
   Required (carried from [Codex on #314](https://github.com/CloudworkSystems/open-convo/pull/314#discussion_r4506809626)):
   the steward pushes only from its own checkout, which agents can't write to, with hooks and repository config from agents ignored.
4. **Key isolation (owner setup, before any agent pushes on its own):**
   make the push steward's macOS user and its 1Password vault and service
   account; generate a new app key into that vault and delete the old one
   (the agents' service account could read the old one); sign `gh` and git
   out of `cloudwork-bot` and `CloudworkSystems` on the agents' macOS user;
   then start the push steward. It comes after steps 2 and 3 because those
   pull requests have to be pushed first. Until this step is done, no agent
   pushes on its own: every push from the Studio is a command the owner
   approves in Claude Code, reading the key from the shared vault, as with
   #313 and #314.
   Required (carried from [Codex on #314](https://github.com/CloudworkSystems/open-convo/pull/314#discussion_r4506943499)):
   suspend the installation before the key swap and keep it suspended until tokens made from the old key have expired, up to an hour, so the app can't write to GitHub during that time.
   Required (carried from [Codex on #314](https://github.com/CloudworkSystems/open-convo/pull/314#discussion_r4507207368)):
   by the end of this step, the owner's GitHub browser session is out of agents' reach, including their browser tools, through a separate macOS user or by staying signed out while agents run; the owner chooses which at this step.
5. **Routine moves:** one at a time, PR keeper first, each a change to its
   file in `docs/scheduled-tasks/` and to its routine.
   Required (carried from [Codex on #314](https://github.com/CloudworkSystems/open-convo/pull/314#discussion_r4506809630)):
   before step 7, project status keeps issue #254 updated, either by moving to the Mac or through a defined handoff to the steward with no inbound connection.
   Required (carried from [Codex on #314](https://github.com/CloudworkSystems/open-convo/pull/314#discussion_r4507181134)):
   before the security sweep moves, the owner gives the app read-only access to Dependabot, code scanning and secret scanning alerts, or the sweep gets its own read-only access.
6. **Mini backup (no pull request, owner's yes):** a bare mirror of the
   public repo on the Mini, fetched hourly by a local scheduled job, with
   git's reflog kept for every branch so a bad force-push on GitHub doesn't
   erase the older copy. The Studio-to-Mini copy of unpushed branches comes
   later, on its own yes, because it needs Remote Login on the Mini.
7. **Cleanup:** revoke the bot's classic tokens; remove `cloudwork-bot` from
   the trusted lists once nothing posts as it.
   Required (carried from [Codex on #314](https://github.com/CloudworkSystems/open-convo/pull/314#discussion_r4507023970)):
   the owner disconnects the GitHub link on his Claude account and revokes Claude's authorization on `cloudwork-bot`, so a restored bot account gives cloud sessions no way around the steward.

## Setup And First Test (Nov 8)

- **App:** "Cloudwork Agents" (App ID 5665711, login `cloudwork-agents[bot]`),
  owned by CloudworkSystems, installed on this repo only, with the
  permissions above. For now its key is in the "True Convo AI" vault and the
  agents' service account can read it; Build Order step 4 moves it.
- **Branch protection on `main`:** `tests` and `codex-approved` must come
  from GitHub Actions, and bypassing is off for everyone, so the app can't
  post its own passing checks or skip them.
- **Studio:** the owner's Claude app serves this folder through Remote
  Control in worktree mode.
- **First test (#313, draft, closed unmerged):** from the Studio, Claude read
  the key through the service account, got a one-hour token, pushed a
  scratch branch and opened a draft pull request. GitHub showed
  `cloudwork-agents[bot]` as the pull request and commit author, and `tests`
  passed. Codex did not review it, so `codex-approved` stayed pending. The
  key and tokens never appeared on screen or in a file.
- **Second test (#314, this plan):** opened by the app as a normal pull
  request. Codex reviewed it within about 3 minutes, so #313 was skipped
  only because it was a draft. Codex's two P1 findings (agents could reach
  the key; deleting a key doesn't stop tokens already made) are fixed in
  section 1 "Keys", section 4 and Build Order step 4. Commits pushed with
  git are unsigned; `main` doesn't require signed commits today.

## To Check Before Building

- That GrokBot answers `@cursor` review requests posted by the app. (#314
  confirms Codex's automatic review of the app's normal pull requests and its
  answer to `@codex review` posted by the app.)
- That suspending the installation stops tokens the app already made, as
  GitHub's documentation says; try it once during Build Order step 4.
- Whether Claude Duet threads can be started on the Mac through Remote
  Control by default, or only when started that way.
- The Codex CLI's local review command (`codex --help`).
- How the Mini is unlocked after a restart with FileVault on, given that
  nobody sits at it.
- Where GrokBot's builders run today (Cursor on the Mac or Cursor's cloud).
- How GitHub shows open pull requests authored by a suspended account
  (#311, #312), and whether they need reopening under the app.

## Not In This Plan

- Gemini review (still not set up), the builders' VM (if it's ever set up, it
  gets no app key, and its work reaches GitHub through the push steward), and
  per-agent apps (possible later; one app is enough while `agent:` labels and
  sign-offs show who did what).
