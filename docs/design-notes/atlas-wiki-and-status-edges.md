# Design Note: Atlas Wiki, Status Lines On Canvas, And The Memory Steward

Written October 29, 2026 at the owner's request. Status: idea, not planned
or built. A plan in `docs/plans/` comes first if the owner wants it built,
and the build order in [PLAN.md](../../PLAN.md) doesn't change: the thin
Canvas/Atlas/Navigator view still comes right after the Claude Code adapter.

## Why This Note Exists

The owner watched a creator's video on the "AI second brain": a local folder
of markdown files, a short `AGENTS.md` routing map, an index file in each
folder, insights saved instead of raw data, a daily update routine, a weekly
cleanup, and dashboards built on top. He asked whether it fits Cloudwork
Atlas, the planned knowledge view in the Desk's Nexus module
(`apps/desk/src/features/NexusViews.tsx`), which promises a 3D graph, a
Karpathy-style LLM wiki and graph retrieval.

The conclusions, which the owner agreed with:

- **The wiki is the useful part; the graph is mostly for looks.** The
  relationship between folders and the files in them, kept current, is what
  helps a model find the right context. A 3D graph mostly shows that things
  are connected. It can come later as a skin and a hook for new users, once
  there is real data under it.
- **Lines are worth drawing when they mean "whose turn".** On Canvas, a line
  between two things is decoration unless it says who owes the next move.
- **The brain needs one owner, and that owner is the Memory Steward.**

Much of the video's routine already exists for this repo's own work: the
cloud PR keeper runs hourly, the Sunday recycling pass cleans up stale docs,
and the Rail Map is the dashboard. This note is about doing the same for a
True Convo user's own knowledge and work.

## 1. The Atlas Wiki Comes First

- **A folder of markdown, on the user's device.** One root map (what lives
  where, when to use it, where new things go) under about 200 lines, and a
  short index in every folder that grows past a handful of files, listing
  each file and what it's about. A model reads the map, then the index, then
  only the files it needs.
- **Insights, not raw data.** Mail, transcripts and tool exports stay where
  they are. The wiki keeps the takeaways and decisions, each linked to its
  source so it can be checked.
- **Not in Git.** This repo is public. The Atlas engine (the code that builds
  indexes and checks the wiki) can live here; a user's notes never do. They
  stay in their memory space, under the same rules as other memories
  (foundations: explicit save first; Personal and business spaces kept apart).
- **The folder layout stays fixed.** Moving folders breaks the map and the
  indexes, so a layout change is the owner's call, not a cleanup step.

## 2. Status Lines On Canvas

Canvas already shows work items and sessions as boxes, and a box can carry a
status. The addition: a line from a work item or session to each pull
request it produced, colored by **who owes the next move**:

| Line | Meaning |
|---|---|
| Waiting on you | Only the owner can make the next move: a protected-path approval, or a decision he was asked for. Open review findings are the builder's move ("Being fixed"), even though an `owner-accepts-findings` line could clear them; that line is his option, never a task the status hands him |
| In review | Codex, the independent reviewer or the triage judge has it |
| Being fixed | The builder owes a push: open review findings, a failing check such as `tests`, or a merge conflict |
| Ready to merge | Every gate prerequisite passes on the latest commit: `tests`, `codex-approved`, the owner's approval of any protected path and, where a rule needs them, a clean independent review and plan check. Auto-merge being on is one more input, never enough on its own |
| Stuck | An agent missed its deadline (AGENTS.md "Agent Setup And Silence") |

Every open pull request gets exactly one state. When more than one fits, the
first in this order wins: Stuck, Being fixed, Waiting on you, In review,
Ready to merge. A pull request no row fits shows as "Unknown", never as
missing, so a gap in the rules is visible instead of hidden.

- **One data feed, shown twice.** A complete per-PR status feed, built from
  GitHub's own data for every open pull request (checks, reviews, the
  reviewer, judge and relay state, whose turn), feeds a "Pending" list on the
  Rail Map and the lines on Canvas. Issue #52 is not that feed: it lists only
  pull requests waiting on the owner, plus the keeper's "Not working" report.
  It becomes one filtered view of the feed (the "Waiting on you" rows).
- **What it depends on.** A line needs to know which session produced which
  pull request, and nothing records that yet. The Claude Code adapter
  (`docs/plans/claude-code-adapter.md`) is plain text with no tools, so its
  durable session records hold no pull-request identity. The link needs its
  own saved record (session, repository, pull request number), written by the
  builder integration that opens the pull request, at the moment it opens
  it, never guessed afterwards from branch names or titles. So the Canvas
  lines wait until a builder integration writes that record; that is its own
  plan. The Rail Map list needs no such link and can come first from a
  scheduled snapshot, the way `apps/desk/scripts/rail-map-snapshot.mjs`
  works now.
- **Status is computed in code**, from GitHub's own data and the rules in
  AGENTS.md. No model decides whose turn it is.

## 3. The Memory Steward Owns The Brain

The Memory Steward already keeps the owner's private preferences in True
Convo (`packages/clarity`). It is the natural owner of the Atlas wiki and of
the Syntactic Index (the owner's glossary of short codes, terms and commands).

- **Start as a scheduled job, not a standing agent.** A standing agent waits
  until there is enough steady work to justify it. Until then the Steward is
  a weekly run that:
  1. rebuilds the root map and folder indexes so they match what's there;
  2. finds broken links, duplicates and notes nothing links to;
  3. flags notes that contradict each other, and files that are too long;
  4. writes a short health report with a score.
- **One owner per index.** Every index file in a memory space is generated
  by the Steward's plain-code rebuild, and nobody edits one by hand. Other
  agents, such as a front door or a specialist, write only kept entries to
  subject files (an agent proposes, the owner keeps: foundations, "explicit
  save first") and trigger that rebuild after each kept write, so an index
  never waits for the weekly run. The front-door plan (#186) uses the same
  split.
- **Mostly code, with a small model.** Steps 1 and 2 are plain code. Steps 3
  and 4 need a model only to compare and phrase, so they should work on the
  local default model (`qwen3:8b`). This matches the agent profiles design
  ([agent-profiles-and-adapters.md](agent-profiles-and-adapters.md)): a
  profile around a cheaper model, so the work keeps running if frontier
  prices rise or subscription sign-ins go away.
- **The owner makes the calls.** The Steward fixes mechanical things (an
  index entry, a broken link) and proposes the rest. Keeping, merging,
  deleting or rewriting a note, and any change to the folder layout, wait for
  the owner's yes. The rule for Jev applies here too: an agent ranks the
  options, the owner decides.
- **One brain per memory space, not per project.** Subfolders and the map
  route to the right context. Personal and each business stay separate spaces.

## Rules It Must Keep

- Nothing from a user's wiki goes into Git, a shared space or a cloud model
  without that space's existing approval.
- Every automatic change is visible in the health report and can be undone.
- The 3D graph waits until the wiki and the status lines carry real data.

## Open Questions For The Owner

- Should the Rail Map "Pending" list come before the adapter, from the
  scheduled snapshot, or wait and arrive together with the Canvas lines?
- Weekly or every two weeks for the Steward's run?
- Should Atlas read the existing Canvas folders as its top-level layout, or
  keep its own?
