# Idea Harvest From True Convo

Status: Draft (Oct 29): written for the owner's yes; no run has happened yet.

Written October 29, 2026 by Claude (thread "Fix failing PR steward and
recycling tasks") from the owner's ask that day. Session name:
`OC-261029-idea-harvest`. **Claude** runs it (a thread the owner or the
coordinator starts). **A fresh Claude reviews each run** (see "Run Review"):
one with no part in that run, either a subagent started with only the run's
outputs and this plan, or another thread. Anything a kept idea leads to
goes through the normal review path for its kind (AGENTS.md "Review Loop").

## Why

The owner remembered the weekly recycling pass as two jobs: clearing stale
material, and going back through the old True Convo work for ideas worth
reviving. Only the first was ever written down. On October 29 he agreed to
split them: the recycling pass stays a weekly cleanup inside this repo, and
this plan is the second job.

True Convo was frozen on October 12, 2026 and is a read-only reference and
parts library (AGENTS.md "Project Facts"). It holds a lot of thinking that
never reached Open Convo: product concepts, agent and tool ideas, Desk
designs, past recycling reviews and strategy notes. Some of it is worth
building; most of it is already here, outdated, or private.

## Sources

1. **The old True Convo repository on GitHub** (private, frozen). Since
   October 29, Claude's GitHub app and the bot can read it. By the owner's
   choice that day, it is attached **only to the thread doing the harvest**,
   never to the project's repository list, so routine threads and scheduled
   tasks don't download its private material and can't fail when its access
   changes.
2. **Not this plan: the frozen `cloudwork_systems` folder on the owner's
   Mac.** Harvesting it, through folder access, needs a plan of its own and
   the owner's yes before the first run on it.

## How A Run Works

1. **One area per run.** The harvest works through the old repo in this
   order, one area at a time: top-level concept and candidate docs; the
   `docs/` concept notes; `tools/`; the Desk app; the Mac app; review and
   session records last.
2. **Check against Open Convo first.** For each idea, the run checks
   `PLAN.md` (including its move log), `docs/plans/`, `docs/design-notes/`
   and `STATUS.md`. An idea that is already here, already decided against
   in `docs/decisions.md`, or overtaken by later work is dropped, not shown.
3. **At most ten ideas per run, shown as cards.** Each card names the idea
   in Claude's own words in one or two sentences, says why it might matter
   now, and gives the owner buttons: **Keep**, **Later** or **Skip**. No
   quotes from the old material, and no names of people, clients or family
   members on any card.
4. **A ledger records what's done.** A private ledger in the project's
   shared files (`idea-harvest/ledger.md`, never in this repo) lists each
   area covered and every card's outcome, so no run shows the same idea
   twice and "Later" ideas come back only when the owner asks.
5. **A quiet run asks nothing.** If an area yields nothing new, the run
   says so in one line and moves the ledger on.

## What Happens To A Kept Idea

A kept idea becomes fresh work in Open Convo, never a copy:

- **An idea for the product** becomes a design note or a plan draft in its
  own pull request, written fresh and reviewed like any other.
- **A piece of old code worth reusing** follows AGENTS.md "Moving Code From
  True Convo" in full: one piece at a time, private material left behind,
  invented data in tests, and the move logged in `PLAN.md`.
- **A business or marketing idea** stays out of this repo (decision of
  October 14) and goes to the owner's private notes instead.

## Run Review

Before any card reaches the owner, the reviewer reads the run's draft cards
and its draft ledger entry, nothing from the old repo itself, and checks
them against "Rules" below: no quotes from the old material; no names of
people, clients or family members; no secret values; nothing written
anywhere except the ledger and the harvesting thread. It answers in one
line, **pass** or **fail** with the card or line that failed. On a fail,
the run fixes or drops that card and asks for the check again; no card is
shown until the run passes. The ledger records each run's result.

## Rules

- Never write to, push to or change the old repo, and never add it to the
  project's repository list.
- Never copy a file from it wholesale. Transcripts, interview and strategy
  answers, review and session records, client or family details,
  credentials and Keychain references are read only to understand an idea,
  and nothing from them is quoted or carried over.
- If a run finds anything that looks like a live secret in the old repo,
  it stops, tells the owner which file and line (not the value), and
  recommends rotating it.
- Runs happen when the owner or the coordinator asks. Making it a
  scheduled task needs a revision of this plan and the owner's yes.

## Finish Line

Every area of the old repo is marked covered in the ledger, every run has
a passing run review, and every kept idea has a home: an open or merged
pull request in this repo, or an entry in the owner's private notes. Then
this plan is marked **Built**. Any harvest of the `cloudwork_systems`
folder runs under its own new plan, never under this one.
