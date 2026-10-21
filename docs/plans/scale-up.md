# Building Faster (Scale-Up Plan)

Written October 21, 2026 by a building session. Session name:
`OC-261021-scale-up-plan`. Status: approved. The owner agreed to the
direction on October 21 and said yes to all six recommendations at the end
the same day. The pull request that adds this plan also records the
approvals in [decisions.md](../decisions.md), raises the outside-builder
limit in AGENTS.md and adds the three module plans, so the plan and the
decisions log merge together. The other approved changes ((b) to (e)) land
in their own pull requests.

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

**First step.** The planning session writes the three short plans (one per
module, each with its builder rules and the GrokBot team assigned), Codex
reviews them, and the owner merges them along with the limit change.

## (b) Narrow The Mac App's Protected Paths (Later Building PR)

**Why.** Most Mac pull requests wait for the owner only because they touch
`main.swift`, which holds a little sensitive code among a lot of ordinary
code. Moving the sensitive parts out of it into a few clearly named,
protected folders lets `main.swift` lose its protection, so ordinary Desk and
dictation changes stop waiting on him.

**Every reason a file is protected today** (from `.github/CODEOWNERS`). The
refactor keeps every one of these reasons covered:

| Protected | Why |
| --- | --- |
| `AGENTS.md`, `CLAUDE.md`, `.github/` | The rules, the checks and CODEOWNERS itself |
| `PLAN.md`, `docs/plans/`, `docs/decisions.md` | Owner decisions |
| `ArchiveProtection` and its tests; files named `*Keychain*`, `*KeyProvider*`, `*Recovery*`, `*Cipher*`, `*Encryption*`, `*Seal*`, `ProofStore*`; `PayloadHash.swift`, `DeskSession.swift`, `DeskPaths.swift`, `DeskKeptStoreTests.swift` | Keys, encryption, recovery and protected storage |
| `Participant*` modules and files, `ParticipantProcessTests`; files named `*PaidUsage*`, `*Availability*`, `*Wiring*` | Anything that can run a paid AI model, decide whether it is available, confirm or end paid use, or wire it into the app |
| Files named `*OpenAI*`, `*Realtime*`, `*Groq*`, `*Anthropic*`, `*APIKey*` | Other paid cloud calls and API keys |
| `ProtectionProofTests` | The storage protection proof |
| `main.swift` | Two reasons: it wires storage and the paid path into the app, and it holds the OpenAI and Groq batch transcription requests and the API-key lookups (environment and Keychain) |
| `Package.swift` | Decides which modules link, including the paid path, and declares the safety tests |
| `DeskSessionParticipantTests.swift` | Forbids linking the participant path |

Only `main.swift` loses protection, and only once **both** of its reasons are
gone: the storage and paid-path wiring, and every paid-API request and
API-key lookup, have moved into files that CODEOWNERS protects, **and no
unprotected file calls into that protected paid-cloud or API-key code at
all**. Moving the code isn't enough on its own: if `main.swift` could still
call a protected wrapper, an ordinary pull request could switch on paid use
with a stored key by adding one call, without touching a protected file. So
the app's start-up call into the paid path moves into a protected file too,
and `main.swift` keeps no reference to it. Every other entry above stays as
it is.

We chose "no calls at all" over allowing one named, protected entry point
with a listed set of callers, because it is simpler: the check is a single
list of forbidden names, with no allow-list of callers to keep current, and
it fails safe. If the refactor can't remove every such call, `main.swift`
simply stays protected and the owner keeps approving those pull requests, as
today.

**What stays protected.** `Package.swift` stays owner-protected, along with
any other build or test manifest that decides which modules link into the
app or declares the safety tests. It decides whether the app links the paid
participant path (`ParticipantAppWiring`) and declares the tests that catch
a forbidden link; if anyone could change it without approval, the paid path
could be linked in and its tests dropped. Protection narrows only for
ordinary source files. Most Mac pull requests don't touch `Package.swift`,
so the approval burden still drops.

**Cost and risk.** One careful refactor that itself needs his approval (it
touches every protected file). The risk is moving sensitive code somewhere
unprotected; the pull request lists every move and the CODEOWNERS change side
by side.

**How we check it.** The app already links `ParticipantAppWiring` on
purpose, so the check is "nothing changed", not "nothing is linked":

- The pull request only moves files and changes `.github/CODEOWNERS`. No
  code changes inside the moved files.
- Which targets link which is identical before and after: run
  `swift package describe --type json` in `apps/mac` on `main` and on the
  branch, and the targets and their dependencies match exactly. The pull
  request includes both outputs or their comparison.
- Every existing link-guard and safety test passes, none removed, skipped
  or weakened: `PaidUsageGateTests` (which reads `Package.swift` and the
  app's sources), `LocalConversationLaneTests`, `ProcessLauncherTests`, the
  tripwire in `ParticipantWireTests`, `DeskSessionParticipantTests` and the
  `VoiceCursorPolicyCheck` command. Where a test names a moved file by its
  path, only that path string changes, and the pull request lists each one.
- No paid-API or API-key code is left in an unprotected file. A new
  source-scan test (itself protected, like `PaidUsageGateTests`) lists every
  Swift file under `apps/mac/Sources` that CODEOWNERS doesn't protect and
  fails if any of them names a paid provider host (`api.openai.com`,
  `api.groq.com`, `api.anthropic.com` and the like), sends a `URLSession`
  request to one, names an API key (`_API_KEY`, `apiKeyName`,
  `requiredAPIKeyName`) or reads one from Keychain or the environment. It
  must pass on the branch; on today's `main` it would fail on `main.swift`,
  which shows the check works.
- No unprotected file calls into protected paid-cloud or API-key code. The
  same protected test also fails if any of those unprotected files names a
  type or function declared in a protected paid-cloud, paid-use or API-key
  file (the `Participant*`, `*PaidUsage*`, `*Availability*`, `*Wiring*`,
  `*OpenAI*`, `*Realtime*`, `*Groq*`, `*Anthropic*`, `*APIKey*` and
  `*Keychain*` entries above, plus wherever the cloud transcription request
  moves). The test builds that list of names by reading the protected files
  themselves, so a new wrapper is covered without editing the test. Until
  this passes, `main.swift` stays protected.
- The full `swift test` suite in `apps/mac` passes.

**First step.** A building pull request after the Claude Code adapter's
first code pull request, not this one.

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
   **Answer:** yes; the time window is still to be set.
5. **Narrow the protected paths with a refactor (b)?** Recommendation: yes,
   as one building pull request after the adapter's first code pull request.
   **Answer:** yes, including updating a test's path string where it names
   a moved file.
6. **One daily "Needs the owner" list instead of pings?** Recommendation:
   yes; tell us the time of day you want to read it. **Answer:** yes; the
   time of day is still to be set.
