# Agents And A Harness That Improve Themselves, With The Owner's Yes

Status: Draft (Nov 16, 2026): proposed; waiting on the owner's yes to merge. Nothing is built or installed. The build starts only after the push gate (plan PR #321) and slice 1 of the agent ledger (plan PR #312) are built.

Written November 8, 2026 by a Claude thread (project "Claude", task "261108
AGENT SETUP TUNING"), at the owner's request. Session name:
`OC-261108-setup-tuning`. Umbrella: Personal (used by every umbrella). The
owner's words, in the Claude project chat on November 8, 2026 at 09:19 UTC,
replying to the recommendation to borrow Harness2's idea but not install it,
with every change waiting for his yes and guardrails off limits: "Draft that
as a plan". On November 15, 2026 at 08:21 UTC he added the lessons step
("we need to make plans to build the lesson step. As well as the
self-improvement plan"), with the goal "to make it where we can release a
product that the user can build and make their own as soon as possible".
On November 16, 2026 at 04:59 UTC he asked for the harness to improve
itself as well ("Add it to the plan"), quoted in "The Harness Improves
Itself Too". Those cover writing this plan, not merging it or building it.

**Builder:** Claude, in the OPEN-CONVO session on the owner's Mac Studio,
pushing through the push gate as the Cloudwork Agents GitHub App, for
slice 1. **Reviewers:** Codex reviews every
push; GrokBot or a fresh Claude gives the independent review, ending with
the risk-review checklist ([risk-review.md](risk-review.md)); the
coordinator checks the code against this plan. **Finish line:** in "Finish
Line" below.

## The Short Version

An agent is a model plus its **setup**: the written instructions it starts
with, the skills it can follow, the notes on how to use its tools, and the
lessons it has picked up. The model itself never changes here. The setup can.

With this plan, an agent that keeps stumbling on the same kind of task can
write down a small change to its own setup, test the old setup against the
new one on practice runs, and show the owner the result side by side. The
change is used only after the owner says yes. The owner can undo it with one
tap. Some parts of the setup are locked: an agent can never change its own
rules, permissions, spending, or the test it is graded by, and it can't even
propose that.

It also learns from each project. When work in a project wraps up, the
agent writes down what it learned there and can propose a change to the
person's shared **home** (the one folder of skills and starting
instructions that all their projects read). Because every project reads the
home, one approved change improves every project at once: the system builds
the system. The same yes, tests, limits and locks apply.

Last, the **harness** improves too: Open Convo's own machinery (the push
gate, the ledger, the job runner and how work is handed out). It notices
friction in its own records, proposes a fix to its own code, builds and
tests it on the side while live work keeps going, and swaps it in only
after the tests pass and the owner says yes, switching back by itself if it
breaks. It can never change its own safety parts: the push gate, approvals,
permissions or spending.

## Where The Idea Comes From

Harness2 (Google Research, `github.com/google-research/harness2`, Apache 2.0,
paper arXiv 2610.14224, October 2026) was read from its README, its setup and
experiment guides and the first part of its paper. Nothing was installed or
copied.

What it does, in plain words:

- It calls the setup around a model the **harness**, and improves only that.
  It can edit eight parts: the system prompt, guardrails, memory, skills,
  tool guidance, scripts, helper agents and plugins.
- On each task it runs the current setup once, then writes two changed
  setups, runs both on **the same task**, compares what happened, and keeps
  a combined version (it calls this Propose, Probe, Compose).
- After each task it saves the setup it ended with plus an `EXPERIENCE.md`
  of lessons, and only keeps a lesson when the comparison runs back it up.
  The next task starts fresh but reads those lessons first.
- On its own benchmarks it reports gains of up to 11.8 points from one round
  (the paper's numbers, not checked here).

Why we borrow the idea and not the tool:

- **It has no approval step.** Every change is adopted by the program.
- **It may rewrite its own guardrails.** "Guardrails" is one of the eight
  files it edits. That breaks the owner's direction of November 3, 2026,
  that an agent adjusting its own interface must never be able to change its
  own permissions.
- **It runs wide open.** Its guide says network access is unrestricted and
  Codex runs "with its sandbox disabled", and that in one test run a Codex
  agent downloaded its task's grading sheet "without being instructed to".
  An agent that can see the answer sheet can look better without getting
  better.
- **It checks itself on the task it is tuning on**, with no answer key.
  That is fine for a research benchmark; for the owner's own work it means a
  change can look good on the one task and be worse everywhere else.
- **It is research code for Linux and Google Cloud.** Its README says it "is
  not an officially supported Google product", and it is set up for Linux,
  Python 3.12 and Vertex AI. Open Convo is local first, on the owner's Macs.

## Words This Plan Uses

- **Profile:** one agent as the owner defines it (its job, its rules, its
  permissions, its memory spaces). From the agent team plan
  (drafted November 7, 2026, not yet in the repo), "One Agent, Many Bodies".
- **Setup:** the parts of a profile that shape how it works but not what it
  is allowed to do. Listed in "What Can Change" below.
- **Version:** one saved copy of a profile's setup. Version 1 is the one the
  owner first approves. Every adopted change makes a new version.
- **Proposal:** a suggested change from one version to the next, with its
  reason and its test results.
- **Practice runs:** the profile's example runs, the same ones the
  portable capability layer already asks for
  ([portable-capability-layer.md](../design-notes/portable-capability-layer.md),
  "Example runs come with the gate"). The person confirms each one before it
  counts.
- **Lesson:** a short saved note about what worked or didn't, with the runs
  that show it.
- **Home:** the person's own shared folder of agent skills and starting
  instructions, which their agents in every project read. For the owner it
  is `AGENT-HOME`, a local git folder on the Mac Studio that Claude Code and
  Codex read their skills from through links. Another person's home can be
  any folder they choose, with or without git.
- **Harness:** in this plan, Open Convo's own machinery that agents run
  inside: the job runner and its schedules, how work is handed out, the
  push gate, the agent ledger's plumbing, the adapters and the agent
  screen. (Harness2 uses "harness" for what this plan calls the setup.)
- **Friction:** a problem that keeps coming back in the harness's own
  records, like a job that stalls the same way or a limit that keeps
  tripping.
- **Wrap-up:** the moment a piece of project work ends: its pull request
  merges or closes, its task closes, or the person marks the project done.

## What Can Change And What Is Locked

### What An Agent May Propose

Only these, and only for its own profile:

1. **Its starting instructions** (the text it reads at the start of each
   session), within its job.
2. **Its skills' instructions** (`SKILL.md` text). Instructions only:
   skills carry no scripts until True Convo has a tested permission boundary
   ([docs/skills/README.md](../skills/README.md)).
3. **Tool guidance**: notes on how and when to use tools it already has.
   Never which tools it has.
4. **New practice runs**, as suggestions. A suggested run counts only after
   the person confirms it.

### What Is Locked

An agent can't change these and can't propose a change to them. A proposal
that touches one is refused by the code before any test runs, with "This
part of the setup is locked. Only the owner can change it."

- **Rules and guardrails**: the hard rules, the guard hook and deny rules,
  and anything that says what needs a yes.
- **Permissions**: the registry of who may read and write what, trust
  levels, memory spaces, and the team tree (who reports to whom, and adding
  helper agents).
- **Approvals**: the approval rules and the approval ledger
  ([approval-ledger.md](approval-ledger.md)).
- **Money**: spending caps, paid routes and which model a task runs on.
  Moving a task to a cheaper model already has its own checked rule
  ([agent-profiles-and-adapters.md](../design-notes/agent-profiles-and-adapters.md),
  "Scaling Down Once a Task Is Proven").
- **Code**: scripts, plugins, MCP servers and anything else that runs.
- **The grading**: the practice runs' checks, how results are compared, and
  this plan's limits. An agent never grades itself and never sees the
  answer sheet.
- **The person's memory**: what the person keeps about themselves stays in
  the memory store. Lessons live in their own store, apart from it.
- **Foreign agents' setups**: a foreign body (Cam, for example) never
  proposes and never receives changes.

When an agent thinks a locked part is wrong, it can say so in plain words as
a ledger **need** entry. That reaches the owner as a request and changes
nothing until the owner edits the locked part himself.

### Why Words Can't Unlock Anything

Permissions are enforced by the host's code, not by what an agent reads. So
even an approved instruction that said "you may merge" or "skip the yes"
would change nothing: the host would still ask. The test runner also checks
each proposed text for wording that claims an approval or a permission, and
puts that sentence first on the owner's card, marked, so he sees it before
anything else.

## How A Proposal Works, Step By Step

1. **Something goes wrong or slowly.** A real task fails, the owner corrects
   the agent, or the same kind of task keeps taking long. The agent notes it.
2. **The agent writes one small change.** One proposal at a time, about one
   thing, with a plain reason ("I keep forgetting to check the calendar
   before suggesting a time"). It reads earlier lessons first, so it doesn't
   try something the owner already turned down.
3. **The code checks the change.** It refuses anything that touches a locked
   part, anything over the size limit, and a change the owner already turned
   down (same text) in the last 30 days, unless it comes with new evidence.
4. **The old and new setups are tested side by side.** Both versions run the
   same practice runs, with the same model, in a practice space: invented or
   copied data, no network, nothing sent, no real accounts, and tools
   replaced by stand-ins that record what would have happened. The agent that
   proposed the change doesn't run the tests and can't see the checks.
5. **The results are compared by plain rules in code.** A proposal passes
   only if the new version does better on at least one practice run and
   worse on none that the old version passed. Otherwise it is marked
   "didn't help" and goes no further.
6. **The owner sees one card.** It shows, in this order:
   - what changes, in one sentence, with the full before and after text
     behind a tap;
   - why the agent asked for it;
   - the results, as a small table: each practice run, old version, new
     version (passed or failed), plus time and cost;
   - what the test can't prove (for example, "practice runs used invented
     emails");
   - two buttons: **Use this** and **Not now**.
7. **Only his yes adopts it.** "Use this" records one yes in the approval
   ledger for exactly this proposal and this version. The host claims that
   yes once, then makes the new version current. A yes can't be reused for a
   later change. "Not now" closes it.
8. **A lesson is saved either way.** For an adopted change: what changed and
   which runs showed it. For a turned-down one: that the owner said no, in
   his words if he gave any. Lessons are read only by the next proposal.
   They never go straight into a working agent's instructions; only an
   adopted version does.
9. **Every body of the profile picks it up.** One agent, many bodies: the
   new version applies to the profile, so each body (in Open Convo, Claude
   Code, Codex) starts its next session on it. A ledger **did** entry says
   "Profile X is now on version 7".

## Where Things Live

| What | Where | Why there |
|---|---|---|
| Versions, proposals, test results, lessons | A new **setup store** on the owner's Mac: append-only files, hash-chained, the same pattern as the approval ledger | It holds whole texts and tables, which are too big for ledger entries, and its history must not be rewritten |
| News that a proposal exists, waits, was adopted or undone | The **agent ledger** (plan PR #312), as short entries whose `about` is the proposal's work name | So every agent and the agent screen see it, and nobody has to check GitHub |
| The owner's yes | The **approval ledger** | One yes for one action, claimed once |
| An adopted home change | The person's **home** folder, written only by the host after the yes (one local commit in a git home) | So every project reads the same approved text |
| The status of the job | The **agent screen** (agent team plan, part 5, not yet in the repo), as "Setup tuning: testing / waiting for you / adopted / undone" | Visible state, as the owner asked on November 3 |

The setup store is separate from the agent ledger and from the approval
ledger, and reads neither. A ledger entry saying "the owner approved
version 7" is never treated as a yes; only the approval ledger's claimed
record is.

## Undoing A Change

- **One tap back.** Every version is kept. The owner can go back to any
  earlier version he approved, from the profile's history. Going back is
  itself recorded as a new version ("version 8 = version 6 again"), so
  nothing is erased.
- **Automatic step back if real work gets worse.** For 14 days after a
  change, the host compares the profile's real results with the two weeks
  before (failed tasks, owner corrections, the watchdog's halts). If they
  clearly get worse, the host switches back to the previous approved version
  by itself and tells the owner why (owner decision, November 8, 2026,
  below). The switch can only restore a version he already approved, never
  a new or edited one, and never a version he later turned off. He can turn
  the change back on with one tap.
- **A turned-down change stays turned down.** It stays in history marked
  "not now", and the same text can't come back for 30 days unless the agent
  brings new evidence.
- **Damage stops changes, not work.** If the setup store's history doesn't
  check out, no new version can be adopted until the owner resets it, and
  the profile keeps running on its last good version.

## Limits On Cost And Retries

The owner kept these on November 8, 2026 (below). He can change them; the
agent can't:

- **One open proposal per profile at a time**, and at most **3 per week**
  per profile.
- **One candidate per proposal.** Harness2 tries several at once; its own
  results show one round already gets most of the gain, and one is cheaper
  and easier to read.
- **At most 10 practice runs per version** per proposal, so at most 20 runs.
- **Local models first.** Practice runs use the person's local model when
  the profile normally runs on it. A profile that runs on a paid model tests
  on that model, inside the existing spending cap, with a ceiling of **$2
  per proposal** and **$10 per month** for all tuning together. Past the
  ceiling, tuning pauses until next month or the owner raises it.
- **Retries:** a practice run that fails to start (not a run that fails its
  check) is tried once more, then marked "couldn't run". A proposal that
  "didn't help" may be revised **twice**. After three tries it closes, the
  same way the review loop watchdog stops a pull request that keeps cycling
  ([review-loop-watchdog.md](review-loop-watchdog.md)).
- **Safe restart:** each proposal has a fixed id. If the Mac restarts mid
  test, the test starts over under the same id, and the claim-once yes means
  a change can never be adopted twice.

## Where It Runs

The owner's Mac Studio is his desk and main agent setup; the Mac Mini is the
agents' own machine for experiments (owner decision, November 7, 2026).
Practice runs belong on the Mini once it is set up for them, so tests never
slow down the owner's desk. Until then they run on the Studio in the
practice space. Adopted versions live with the profile on the Studio. The
Mini holds no keys and no GitHub sign-in, so paid-model practice runs stay
on the Studio.

## Lessons From Each Project

The idea, as the owner took it from IndyDevDan's "Tiny Software Factories"
videos (not checked here): every project a factory is used in teaches it
something, so the next project starts with a better factory.

### At Each Wrap-Up

1. **The agent writes a wrap-up note.** In a few lines: what the project
   needed, what went well, what went wrong or took long, and what it would
   do differently. It is saved as lessons in the setup store, tagged with
   the project, and posted to the agent ledger as one **did** entry. Writing
   it changes nothing about how any agent works.
2. **A lesson that points at the home can become a proposal.** If the same
   kind of problem would come up in other projects, the agent may propose a
   change to the home instead of to its own profile. It goes through the
   same steps as any proposal (checked, tested, shown on a card, adopted
   only on the person's yes) and counts toward the same limits: 3
   proposals a week per agent, $2 each, $10 a month for all tuning.
3. **Nothing reaches the home without the yes.** The agent never writes to
   the home itself. After the yes, the host makes the change. In a home
   kept in git (like `AGENT-HOME`), the host adds one local commit that
   names the proposal and the date of the yes, and never pushes it
   anywhere. In a plain folder, the setup store keeps the before and after.

### What A Home Change May Touch

- **Skills in the home:** their `SKILL.md` instructions, as for a profile.
  Scripts stay locked.
- **The guidance part of the home's starting instructions** (for example
  `AGENTS.md`). The rules part (what needs a yes, what is never allowed,
  who may do what) is locked, like every other rule. The person marks
  where the rules part starts and ends. Until they do, the whole file
  counts as rules, and only skills can be proposed.

Everything on the locked list above stays locked in the home too.

### Tested Wider, Shown Wider

- **More than one project.** A home change is tested on practice runs from
  every project that uses that skill or file, up to the same 10 runs per
  version. A change that helps one project and breaks a run in another
  doesn't pass.
- **The card says how far it reaches.** It lists every project that reads
  the changed skill or file, so the person knows "Use this" changes all of
  them.
- **No project's private details travel.** A lesson written into the home
  reaches every project, so it is written in general terms. The card shows
  the full text, and the same key-and-token check refuses anything shaped
  like a secret.

### Undo In The Home

The same one-tap undo and the same automatic switch back (owner decision 2)
apply. Switching back restores only a home version the person already
approved. In a git home, it is one more local commit that restores the
earlier text, so the history shows both.

### Any Person's Home, Not Only The Owner's

Open Convo is meant to be something each person builds on and makes their
own, so nothing here assumes the owner's setup:

- The host is told where the home is (a setting). It doesn't assume the
  name `AGENT-HOME`, a Mac Studio, git, GitHub or the owner's projects.
- A person with no home yet still gets wrap-up notes and profile
  proposals. Open Convo can offer to start an empty home.
- A new person's home starts empty and fills from their own work and their
  own yeses.
- The owner's `AGENT-HOME` is the first real home it runs on, so the owner
  uses it himself before anyone else does.

## The Harness Improves Itself Too

Everything above improves the agents. This part improves the **harness**:
Open Convo's own machinery that the agents run inside. The owner asked for
this on November 16, 2026: "What we didn't talk about is having the harness
improve itself. And I think that's what we want to build is the harness
that improves itself, not just the agents that improve themselves", built
so it can "improve itself without losing any momentum".

The idea is the same loop with a bigger lock list. The harness notices
where it gets in its own way, proposes a fix to its own code, builds and
tests that fix on the side while the live work keeps going, and swaps it in
only after the tests pass and the owner says yes. If the swap makes things
worse, it switches back by itself. The owner is near the loop, not in it:
the work waits for him when he comes back, and nothing changes without him.

### What It Watches For

The harness reads only its own records (the agent ledger, the push gate's
log, the job runner's history and the review-loop watchdog's halts). It
looks for friction that keeps coming back, for example:

- jobs that stall or time out the same way more than once;
- a limit that keeps tripping on ordinary work (the push gate's pace, the
  ledger's 60 entries an hour, a retry limit);
- work that waits a long time for a step a machine could do;
- review loops the watchdog has to halt;
- the same correction from the owner more than once.

Each kind of friction has a fixed threshold in the code (for example, the
same stall three times in a week). Crossing one adds a line to a
read-only **friction list** on the agent screen, with the records that show
it. A line on the list is news, never a change.

### How A Harness Change Works

1. **A friction line becomes a proposal.** A builder agent writes what it
   would change, why, and which friction line it answers. One harness
   proposal is open at a time.
2. **It is built on the side.** The change is made on its own branch in a
   separate working copy (on the Mac Mini once that is set up for practice
   runs, on the Studio until then). The live harness keeps running the
   current approved version the whole time, so no live job pauses or slows
   for it.
3. **It goes through the normal build path.** A harness change is code, so
   it is an ordinary pull request: Codex reviews every push, an independent
   review ends with the risk-review checklist, and it travels through the
   push gate like any other push. The watchdog's limit for code (8 review
   rounds) applies.
4. **It is tested twice.** The repo's tests must pass, with no test removed,
   skipped or weakened. Then it replays recorded job histories (invented or
   scrubbed, never the owner's real mail or accounts) through both the
   current and the new version and compares them: the new one must reduce
   the friction it names and must not make any other measure worse.
5. **The owner says yes.** The card shows the friction line, the change in
   plain words, the test and replay results side by side, and two choices:
   **Use this** (merge) and **Not now**. A harness change merges only on his
   yes, quoted in the pull request, as every plan and code change does today.
6. **It swaps in at a quiet moment.** After the merge, the harness waits
   until the jobs in flight finish, starts the new version, and keeps the
   old one ready to restart. Jobs that start meanwhile queue for the new
   version instead of being cut off.
7. **It checks itself and can step back.** For 14 days the harness compares
   live friction to the weeks before. If the new version breaks, fails its
   health check or makes friction worse, it switches back by itself to the
   last approved version and tells the owner (his decision 2 below, applied
   to the harness). Switching back only ever restores a version he approved.

### What The Harness Can Never Change About Itself

The owner's rule of November 3, 2026 is that an agent never changes its own
permissions. The harness gets the same rule, made wider: it never changes
its own safety parts, and it can't even propose to. Locked:

- the push gate (its pace, its checks and who may push);
- the approval ledger and every rule about what needs the owner's yes;
- permissions, the profile registry and the team tree;
- spending caps, model choice and the limits in this plan;
- the guard hook and any rule that blocks an action;
- every file the repo protects with an owner review (`.github/`,
  `.claude/`, `docs/agent-process.md`, `docs/scheduled-tasks/`, `PLAN.md`,
  `docs/decisions.md`, and the protected Mac app files);
- the friction thresholds, the replay comparison and its pass rule (so it
  can't grade itself easier);
- this improvement process itself;
- any existing test.

A proposal that touches a locked path is refused by a fixed path list in
the code before a pull request is even opened. If one got past that list,
the repo's owner review rule would still stop it from merging without him.

### Limits

The same limits the owner kept on November 8 apply: one open harness
proposal at a time, at most 3 harness proposals a week, $2 per proposal and
$10 a month (shared with the agent proposals, not on top of them), and 2
revisions of a proposal that didn't help. A declined change can't come back
for 30 days without new friction records.

### Any Person's Copy

Like the lessons step, this works for anyone who runs Open Convo. A
person's harness proposes changes to their own copy, and their own yes
decides. Sending an improvement back to the shared Open Convo code is a
separate choice for later, decided in its own revision of this plan.

## What We Are Not Doing

- Not installing Harness2, or anything from Google Cloud.
- Not changing any model.
- Not letting an agent adopt anything by itself, even a small change.
- Not tuning the build team's own rules files (`AGENTS.md`, `CLAUDE.md`,
  `docs/agent-process.md`). Those keep changing only by pull request and the
  owner's yes, as today.
- Not running tests on the owner's real email, calendar or accounts.
- Not letting the harness change its own safety parts, or merge any change
  to itself without the owner's yes.

## Slices

1. **The setup store and its rules** (this plan approves it in full):
   `packages/setup-tuning/`, plain JavaScript, no dependencies, no network,
   no clock (the host passes `now`). It keeps versions, proposals, results
   and lessons; refuses locked parts; applies the limits; compares results
   by the rules above; adopts only with a claimed approval record passed in
   by the host; and undoes. Invented data only, with a sample driver and a
   read-only command.
2. **The practice runner:** runs practice runs in the practice space with
   stand-in tools, on a local model first.
3. **The proposer:** the agent's side, writing a proposal and its reason
   after a failed or slow task, reading earlier lessons.
4. **The owner's card and the agent screen line** in the Desk.
5. **The ledger link:** news entries through the agent ledger's local door
   (its slice 2).
6. **Lessons from each project:** the wrap-up note, home proposals tested
   across projects, and the host writing an adopted change into the home.
7. **The harness improves itself:** the friction list, harness proposals as
   ordinary pull requests, the replay comparison, the quiet swap and the
   automatic switch back.

Slices 2 to 7 are direction only. Each gets a dated revision of this plan
with its details and the owner's yes before its build starts. Slices 4 and 7
add things the owner sees, so each of their revisions answers the five questions in
[when-it-goes-wrong.md](when-it-goes-wrong.md) and adds an owner trial.

## Sequencing

Slice 1 waits its turn: the push gate (plan PR #321), then the agent
ledger's slice 1 (plan PR #312), then this. It doesn't need the ledger to
work, but the team finishes one usable path before starting the next
coordination piece. Slice 6, the lessons step, follows the same order and
gets its own dated revision before it is built. Slice 7, the harness
improving itself, comes last of all: it needs the push gate, the ledger
and the job runner's history to exist first, because those are what it
reads and what keeps it safe.

## Slice 1 In Detail

### Functions

`open({ dir, storePath })`, then:

- `propose({ now, profile, target, from, change, reason, proposalId })`:
  `target` is `profile` or `home`. It checks the change against the locked
  list, the size limit (at most 4,000 characters
  of changed text) and the limits; refuses or records it as "waiting for
  test".
- `recordResults({ now, proposalId, runs })`: takes each practice run's
  result for both versions, as the host gives them, and marks the proposal
  "passed" or "didn't help" by the rule in step 5.
- `adopt({ now, proposalId, approval })`: needs `approval` to be a claimed
  approval-ledger record naming this proposal id and the new version's
  hash. Anything else is refused ("This change needs the owner's yes").
- `wrapUp({ now, profile, project, text })`: saves a wrap-up note as
  lessons tagged with the project. It changes no version.
- `decline({ now, proposalId, words })`, `rollback({ now, profile, to,
  reason })`, `history({ profile })`, `lessons({ profile })`, `verify()`
  and `reset()`.

Each returns a plain result or `{ ok: false, reason }`. A change is a list
of parts (`instructions`, `skill:<name>`, `toolGuidance:<tool>`,
`practiceRun` for a profile; `home:skill:<name>` and `home:guidance` for the
home), each with its new text. `home:guidance` is refused while the host
reports no marked rules part for the home. Slice 1 records home proposals
like any other but writes nothing into a real home; that is slice 6. The locked list is a fixed list in
the code, not data passed in, so no caller can widen what is editable. Any
part not on the editable list is refused, so a new kind of part is locked
until a revision of this plan adds it.

### The Command

`node packages/setup-tuning/src/tuning.mjs --dir <folder> --store <file>
<verb>` with `history`, `lessons` and `verify`. It only reads.

The sample driver (`src/sample.mjs`) works only on a folder it created
itself, marked `SAMPLE-ONLY`, with an invented profile ("Helper Robin") and
invented results.

### Tests (One Command, `npm test`, Invented Data Only)

1. A proposal that touches instructions passes the check; one that touches
   permissions, guardrails, approvals, spending, scripts, the team tree, the
   grading or an unknown part is refused before anything else happens.
2. A second open proposal for the same profile, and a fourth in one week,
   are refused.
3. Results where the new version improves one run and breaks none pass;
   results where it breaks any run the old version passed are "didn't help".
4. `adopt` without an approval record, with one for another proposal or
   version, or with one already used is refused; with the right one it makes
   the new version current, once.
5. A third revision of a proposal that didn't help is refused; so is the
   same declined text within 30 days without new evidence.
6. `rollback` makes a new version equal to an earlier approved one; history
   keeps every version.
7. An edited, deleted or reordered record stops `adopt` and `rollback` with a
   reason, while `history` still returns the checked part with a warning;
   `reset()` recovers.
8. A proposal or lesson that carries something shaped like a key or token is
   refused, the same check the agent ledger uses.
9. A home proposal to `home:skill:<name>` passes the check; one to the
   home's rules part, or to `home:guidance` while no rules part is marked,
   is refused; and home proposals count toward the same weekly limit as
   profile proposals.
10. `wrapUp` saves lessons tagged with the project and leaves every version
    as it was.

## Finish Line

Slice 1's pull request merges with `tests` passing, and the sample driver,
run on invented data, shows: a locked-part proposal refused; a proposal
tested and passed; `adopt` refused without a yes and accepted with one; a
rollback back to version 1; the fourth proposal of the week refused; and a
home proposal to a skill recorded while one to the home's rules part is
refused.

## Owner Decisions

Asked in the Claude project chat on November 8, 2026; his answers at 09:31
and 09:32 UTC.

1. **The limits** (3 proposals a week per profile, $2 per proposal, $10 a
   month): kept. His words: "1 - yes."
2. **Automatic step back** (switch back to the previous approved version
   by itself when real results get worse, and tell him, rather than only
   asking): yes. His words: "2 - yes.", then "yes to 2" when asked to
   confirm. The switch only ever restores a version he already approved.
3. **Order:** after the agent ledger, as written in "Sequencing", so every
   proposal, result and yes or no has a shared record from day one. His
   words, after weighing the pros and cons: "After the ledger".

## Sources

- Harness2 README, `docs/SETUP.md` and `docs/EXPERIMENTS.md`, read November
  8, 2026: `https://github.com/google-research/harness2`
- "Harness^2: Recursive Agent Harnessing for an Open World", arXiv
  2610.14224, abstract and sections 1 to 3 read November 8, 2026:
  `https://arxiv.org/abs/2610.14224`
