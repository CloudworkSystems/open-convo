# Status Feed: The Rail Map's Pending View And A Plain Board

Status: Draft (Nov 3, 2026): written on the owner's yes to drafting it; waiting on his yes to the plan and his answers to the open questions below.

Written November 3, 2026 by a Claude building session, after the owner asked
whether Open Convo could install or build something like the "mission
control" dashboard in a creator's video. He answered "Yes to both" in the
Claude project chat on November 3, 2026, at 20:51 UTC, to an offer that
included "Draft the plan PR for that decisions board". **Builder:** Claude
(cloud, `cloudwork-bot`). **Reviewers:** Codex, plus GrokBot or a fresh
Claude review. **Finish line:** in "Finish Line" below.

## Why

The facts about the agent team's work are all on GitHub, but they are spread
over five places: the owner list in #114, the bots' reports on #52, the
status snapshot on #254, `docs/decisions.md` and the PR history branch. No
one place says, for each open piece of work, where it is and whose move it
is. The owner flips between them, and the coordinator rebuilds the same
picture by hand in chat.

This is the feed the Atlas note already called for
([atlas-wiki-and-status-edges.md](../design-notes/atlas-wiki-and-status-edges.md),
section 2): "one data feed, shown twice", built in code from GitHub's own
data, feeding a "Pending" list on the Rail Map first and the Canvas lines
later. This plan makes that feed and its first two views. It is not a new
dashboard beside Cloudwork Nexus: the Rail Map stays the place the owner
reads it on the Mac.

## What We Looked At First

The creator's dashboard (Cole Medin's `factory-mission-control`), his
`ai-software-factory` and the Archon engine were read on November 3 without
running any of their code. The dashboard reads Archon's own run tables, needs
a Neon cloud database and a webhook receiver, and neither it nor the factory
repo carries a license. Archon is MIT, but adopting it means moving every
build off Codex, GrokBot and Claude onto Archon's runner. So nothing is
installed or copied. We borrow ideas only:

- every number says how many pull requests it rests on;
- failure causes sorted by fixed rules, never by a model;
- the view never writes anywhere except its own output;
- one line of totals on top (waiting on you, in flight, merged today).

## How It Fits Cloudwork Nexus

| Nexus piece | Today | What this plan does |
|---|---|---|
| Rail Map (the git rail) | Built (#132): branches, commits and pull requests from a saved snapshot | Adds a fourth tab, Pending, with one state per open pull request, read from the feed through the same snapshot script |
| Canvas status lines | Idea; waits on a record of which session opened which pull request | Nothing yet. The feed is the data those lines will read |
| Thread Map | Direction only; private, never in this repo | Nothing. Claude threads stay off GitHub |
| Atlas | Planned, not connected | Nothing |
| PR history branch | Built (#185): one row per pull request, daily | Reused for the "how long" and "how many rounds" numbers; not changed |

The one place this repeats Nexus is the plain board on GitHub (part 3): the
same rows as the Rail Map's Pending tab, as text, for the owner's phone. If
he only wants the Rail Map, part 3 is dropped (open question 2).

## The States

Every open pull request gets exactly one state, computed in code from
GitHub's own data. When more than one fits, the first in this order wins. A
pull request no rule fits shows as Unknown, never as missing, so a gap in
the rules is visible. The names are the owner's six; the
rules follow the Atlas note's table, mapped as shown.

| Order | State | Atlas note name | Rule |
|---|---|---|---|
| 1 | Blocked | Stuck | A "silent on" line in the PR keeper's latest "Not working" comment on #52, written by `cloudwork-bot`, names this pull request. Only those missed-deadline lines count: the comment's "Waiting on someone" section and its "not set up" lines never make a pull request Blocked |
| 2 | Returned | Being fixed | The builder owes the next move: a draft; `tests` red on the latest commit; a merge conflict; Codex findings on the latest commit while `codex-approved` is not passing there; or an independent review of the latest commit with open findings |
| 3 | Needs You | Waiting on you | Only the owner can move it: a protected path without his approval on the latest commit, or a risk-hold label (the same rules `owner-queue` uses today); or a pull request that would otherwise be Checked but changes a plan in `docs/plans/`, an `AGENTS.md` or `CLAUDE.md` file, or a path the `pages` workflow publishes (`site/`, `brand/tokens.css`, `brand/fonts/`), with auto-merge still off. Those merge only on his quoted yes, and auto-merge goes on only after it |
| 4 | Under Way | In review | A reviewer has it: Codex hasn't reviewed the latest commit yet, the triage judge is pending, or the independent review of the latest commit hasn't arrived |
| 5 | Checked | Ready to merge | `tests` and `codex-approved` pass on the latest commit, the owner's approval is there where a protected path needs it, and a clean independent review of that commit is there where the rules ask for one. Auto-merge being on is shown, never required, except for the yes-to-merge paths in Needs You |
| 6 | Unknown | Unknown | None of the above |

`codex-approved` passing counts as "no open Codex findings", whatever
Codex's own summary still says, because that check already honors the triage
judge's nit verdict and an `owner-accepts-findings` line for that commit.

**A red `tests` that isn't the builder's.** `tests` runs on pull requests
only, so `main` has no result of its own to compare with. The feed therefore
doesn't guess: a red `tests` is Returned. When the same failing job is red on
the latest commit of two or more open pull requests, each of those rows says
"also red on #N", so a shared break shows without blaming anyone. A real
`main` baseline would need `tests` to run on `main` too, which is a change to
the merge gate's own workflow and out of scope here.

Open review findings are the builder's move (Returned), even though the
owner could accept them, so the board never hands him a review loop as a
task by default. Each row also shows "your approval also needed" when a
protected path is waiting, whatever its state, so a pull request being fixed
doesn't hide his approval.

**Loop flag.** A pull request whose last three Codex reviews, on three
different commits, each raised a new P0 or P1 gets a "review loop" badge,
with the number of rounds. It's a flag, not a state, and it never stops
anything. Whether a looping pull request also moves into Needs You is open
question 3.

## What Each Row Holds

Pull request number, title and link; the work name (its branch); the
builder label; state and the rule that put it there, in plain words; the
latest commit and whether it's the one the checks and reviews looked at;
what the next move is and whose; how long it has been in that state; the
loop flag and round count. No authors, emails or file contents, the same
limit the Rail Map and PR history keep. Titles and branch names are already
public on this repo.

On top: how many are in each state, merged today and in the last 7 days,
each with the count it rests on.

## Parts

1. **The feed.** `.github/scripts/status-feed.mjs` and a workflow that runs
   the default branch's copy hourly and on pull request events, the way
   `owner-queue` does, never checking out pull request code. It reads GitHub
   only (open pull requests, their checks and statuses, reviews, Codex's
   summary through `codex-signal.mjs`, labels, CODEOWNERS, the keeper's #52
   comment) and writes `status-feed.json` to its own branch,
   `status-feed-data`, never `main`. Pure state rules in their own module,
   with tests on invented pull requests covering every state, the order
   between them, the loop flag and Unknown. Read-only toward pull requests
   and issues.
2. **The Rail Map's Pending tab.** `rail-map-snapshot.mjs` also fetches
   `status-feed-data` with git and copies the feed into the Rail Map
   snapshot, so the Desk reads one file as it does now. The Pending tab lists
   rows grouped by state, Needs You first, and each row opens the pull
   request. Desk tests use invented data.
3. **The plain board** (if the owner wants it, open question 2). The feed
   rendered as text for the phone, either inside #114 under its current
   sections or in its own pinned issue (open question 1). If it goes in
   #114, its current sections, wording and hidden auto-merge line stay
   exactly as they are, because the PR keeper reads that line.

Each part is its own pull request, in this order. Parts 1 and 3 touch
`.github/`, so each needs the owner's approval on GitHub.

## Not In Scope

- Installing or copying any of the creator's code, Archon included.
- Run traces and agent cost: no source records them today.
- Anything that lives only in Claude threads (the keeper's run threads, plan
  yeses, the Thread Map).
- A scorecard (rework, the owner's attention, cost per merged pull request).
  It comes later from the PR history branch, in its own plan.
- Stopping or restarting review loops. The flag only reports; changing what
  the keeper does is a rules change.
- Retiring #52 or #254. Once the feed proves itself, that is a separate
  rules pull request.

## When It Goes Wrong

1. **No connection.** If GitHub's API fails or runs out of calls, the run
   writes nothing and the last feed stays. The Pending tab and the board show
   when the feed was taken, and say "not refreshed since <time>" when it is
   more than 3 hours old.
2. **Interrupted.** The feed is written as one commit of one file, so a run
   cut short leaves the previous feed whole. The board is one issue edit.
3. **Empty or first run.** No open pull requests shows "Nothing open". No
   feed yet shows "No status feed yet. It appears after the first hourly
   run" on the Pending tab.
4. **Denied or stuck.** A missing permission fails the workflow run, which
   shows red in Actions, and the keeper reports it with the other silent
   jobs. The Desk never blocks on the feed: the other Rail Map tabs keep
   working.
5. **The error message.** Plain words: "The status feed couldn't be read.
   The other views still work." No codes.

## Finish Line

The feed refreshes hourly on its branch; the state rules pass tests for
every state, the order, the yes-to-merge paths and the loop flag; and the
Rail Map's Pending tab shows it. Then the owner's trial, one check per line:

1. Five open pull requests: each one's state and next move is right.
2. No connection: with the Mac offline, the Pending tab still shows the last
   feed and its time, and the other Rail Map tabs work.
3. Interrupted: a feed run cancelled in Actions midway leaves the previous
   feed whole, and the tab shows it.
4. Empty or first run: a snapshot with no feed shows "No status feed yet"
   and a feed with no open pull requests shows "Nothing open".
5. Denied or stuck: a feed more than 3 hours old shows "not refreshed since
   <time>", and the Desk never waits on it.
6. The error message: a damaged feed file shows "The status feed couldn't be
   read. The other views still work." and nothing in code words.

If part 3 is built, its board gets checks 1, 3 and 5 too. When the trial
passes, this status becomes Built.

## Open Questions For The Owner

1. Does the plain board go inside #114 or in its own pinned issue?
2. Do you want the plain board at all, or only the Rail Map's Pending tab?
3. Should a pull request with the review-loop flag move into Needs You (as
   your call to accept findings or narrow the plan), or stay with the
   builder as the Atlas note says?
4. Do the six state names and the order above match what you meant?
