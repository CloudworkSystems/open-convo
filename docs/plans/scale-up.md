# Building Faster (Scale-Up Plan)

Written October 21, 2026 by a building session. Session name:
`OC-261021-scale-up-plan`. Status: approved. The owner agreed to the
direction on October 21 and said yes to all six recommendations at the end
the same day. The pull request that adds this plan also records the
approvals in [decisions.md](../decisions.md) and raises the outside-builder
limit in AGENTS.md, so the plan and the decisions log merge together. Each
of the three module plans in (a) has its own plan pull request, and the
other approved changes ((b) to (e)) land in their own pull requests.

## Why

The owner wants features showing up in the Desk soon so he can use them and
annotate them. GrokBot is paid for a few more days and should earn its keep.
Today work waits in five places:

1. **Owner approvals.** About half the Mac app's files are protected in
   `.github/CODEOWNERS`, including `main.swift` and `Package.swift`, so most
   Mac pull requests wait for him.
2. **Pull requests that fall behind `main`** sit stuck until someone updates
   them. A separate pull request ("option B") is building a job that does this.
3. **One building session** runs every bot pull request, so work queues behind it.
4. **The outside-builder limit**: two modules at a time, each with a
   different builder (owner decision, October 16).
5. **A slow dogfooding loop.** Annotations, then a pull request, then a
   build; True Convo Test is rebuilt only when someone asks.

## (a) Three Outside Modules At Once, One Per GrokBot Team

**Why.** GrokBot has three engineering teams, each a senior engineer leading
juniors. Today it may build only one module. Giving each team its own
module triples its output for the days left.

**What stays the same.** Each module stands alone (no app, storage or memory
code), has its own merged plan in `docs/plans/` listing the builder's rules,
changes only its own folder (the planning side keeps STATUS.md), and is reviewed under
the code path: Codex until a 👍, plus Claude wherever Codex built it. No agent
reviews its own work; the planning session or the PR steward checks it
against its plan; the gate merges.

**Cost and risk.** Three times the Codex reviews and planning checks, so the
review side, not GrokBot, may become the bottleneck. The PR steward runs
hourly and absorbs most of it. If GrokBot lapses mid-build, a module stops
half done; small first slices keep that loss small, and any agent can finish
one from its plan.

**The three modules.** Chosen because each touches only its own package,
needs no AI, network or real data, can be finished in a day or two, and has
an obvious later home in the Desk.

1. **Annotation rounds** (`packages/annotation-rounds/`, Code umbrella). Reads
   an annotation file in the format AGENTS.md sets (numbered items with the
   screen, the element, the owner's words and the requested change, plus
   numbered screenshots), checks it, and reports problems plainly: an item
   missing its screen or change, a screenshot named but not present. Outputs
   a checklist (JSON and Markdown) a builder can work through and tick off.
   Invented rounds only. *Later in the Desk:* an "Open annotations" panel
   showing what the owner asked for and what was built. It speeds the
   dogfooding loop directly.
2. **Site Engine: what changes** (`packages/site-engine/`, Business). Given
   the old and new public-facts files, lists in plain words what will change
   on the site ("Hours on Saturday: 9–5 becomes 10–4"; "New service: Gift
   cards") and refuses the same things the build refuses. No publishing.
   *Later in the Desk:* the preview the owner approves before a site update
   goes out, which the Site Engine note already requires.
3. **Visibility report** (`packages/visibility-report/`, Business). Takes a
   structured list of checkup findings for one invented business (listing
   present or missing, hours match the website, review count, how it shows up
   when asked in an AI assistant) and renders the plain-English report with a
   short, prioritized fix list. Ranking rules are fixed and tested; gathering
   the findings (web, AI assistants) is a later slice. The old checkup
   template stays behind; this is written fresh from
   [visibility-agent.md](../design-notes/visibility-agent.md). *Later in the
   Desk:* a report page for each business space.

**First step.** Each module gets its own short plan in its own pull request
(with its builder rules and the GrokBot team assigned: annotation rounds,
team A; Site Engine "what changes", team B; visibility report, team C).
Codex reviews each one, and a team starts as soon as its plan merges, so
the three don't wait on each other.

## (b) Narrow The Mac App's Protected Paths (Deferred)

**Why.** Most Mac pull requests wait for the owner only because they touch
`main.swift`, which holds a little sensitive code among a lot of ordinary
code. Narrowing which files need his approval would let ordinary Desk and
dictation changes stop waiting on him.

**Deferred.** Narrowing the Mac app's protected paths is deferred to its
own plan, written when the refactor is ready. Until then all current
CODEOWNERS protection stays as it is; nothing in this plan unprotects any
Mac file.

## (c) Parallel Building Lanes

**Why.** One session is one queue. Two or three Claude building sessions can
each own a lane:

| Lane | Work | Files it owns |
| --- | --- | --- |
| Main step | The Claude Code adapter | Adapter and participant code in `apps/mac`, its plan |
| Desk and dogfooding | Annotation fixes, Desk screens for finished modules | `apps/desk/` |
| Gate and infra | Merge gate, auto-update job, rebuild step, notes | `.github/`, `scripts/` |

**How lanes avoid collisions.** Each session works in its own worktree,
never in `/Users/patrick/OPEN-CONVO`. Branch names carry the lane
(`OC-<date>-main-…`, `OC-<date>-desk-…`, `OC-<date>-infra-…`). A lane changes
only its own files; when it needs another lane's file, it says so in a pull
request comment and that lane makes the change. STATUS.md is shared; each
lane edits only its own rows. All open bot pull requests as `cloudwork-bot`
and follow the Review Loop unchanged.

**Cost and risk.** More usage, and more pull requests for the owner to
approve until (b) lands. Merge conflicts in shared files (STATUS.md,
`Package.swift`) are the main risk; the auto-update job and the file split
above reduce them.

**First step.** Start the Desk lane alongside the current session; add the
infra lane once option B merges.

## (d) A Dogfooding Cadence

**Why.** The owner can only annotate what is installed. Rebuilding True
Convo Test after each merge that touches `apps/` puts new work in front of
him without anyone asking.

**How.** A rebuild step runs on his Mac only when the Mac is idle and True
Convo Test isn't running, at a time window he sets. It builds from `main`,
installs True Convo Test only (never the real True Convo app), and
leaves the old build in place if anything fails. Running it unattended
needs his standing approval (owner question 4). After each build he gets a
short "What's new to try" note: what changed, in plain words, and one or two
things to try, drawn from the merged pull requests' titles and STATUS.md.

**Cost and risk.** A build that installs a broken Test app; the old build
stays in place on failure and the Test app holds invented data only.

## (e) One Daily "Needs The Owner" List

**Why.** Pings scatter his attention. The PR steward already keeps one
"Needs the owner" issue current (`owner-queue.yml`). Agents stop pinging him
for approvals and add to that list; he reads it once a day, at a time he
picks, and urgent items (a security problem, something broken on his Mac)
still reach him in chat.

**Cost and risk.** An approval can wait up to a day. Lanes (c) and the
smaller protected paths (b) mean fewer items wait on him at all.

## Owner Questions (Answered October 21)

The owner said yes to all six recommendations on October 21.


1. **Raise the outside-builder limit to three, one per GrokBot team?**
   Recommendation: yes, for GrokBot's teams, with each team its own module,
   folder and branch. Modules already waiting only on review fixes (habit
   grid, household lists fixes) don't count toward the three.
   **Answer:** yes.
2. **Which three modules?** Recommendation: annotation rounds, Site Engine
   "what changes", and the visibility report, as above. **Answer:** yes.
3. **Run two or three building lanes?** Recommendation: two now (main step,
   Desk and dogfooding); add the infra lane after option B merges.
   **Answer:** yes.
4. **Give a standing approval for the idle-time True Convo Test rebuild?**
   Recommendation: yes, Test app only, in a time window you set, building
   only from `main`, with the old build kept if a build fails.
   **Answer:** yes, from 2 to 6 AM Eastern; it runs as a scheduled task on
   the owner's Mac.
5. **Narrow the protected paths with a refactor (b)?** Recommendation: yes,
   as one building pull request after the adapter's first code pull request.
   **Answer:** yes, including updating a test's path string where it names
   a moved file. How it is done is deferred to its own plan (see (b));
   until then no Mac file loses protection.
6. **One daily "Needs the owner" list instead of pings?** Recommendation:
   yes; tell us the time of day you want to read it. **Answer:** yes, at
   8:00 AM Eastern; it runs as a scheduled task on the owner's Mac.
