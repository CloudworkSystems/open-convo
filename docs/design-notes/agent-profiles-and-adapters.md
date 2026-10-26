# Design Note: Agent Profiles, Harnesses and Model Adapters

Written October 13, 2026 by the planning session, from a conversation with the
owner. Status: direction for step 3 and step 6. Facts about other companies'
terms were checked on this date and must be rechecked before anything ships to
other people.

## Local First, With a Guide That Needs No AI

- True Convo is local-first. The first real conversation (step 3) runs on a
  local model, through Ollama on the owner's Mac.
- A new user may have no local model and no AI to help set one up. The answer is
  a **first-run guide built from ordinary code** (screens and buttons, no model):
  it checks the computer, recommends a local model that fits its memory,
  downloads it after approval, or offers a cloud model instead. The owner chose
  this in the strategy interview ("a visible built-in guide before AI chat is
  ready"). It is built right after the Top Five, before other people install.
- The owner's Mac (M1 Ultra, 128 GB, Ollama installed) can run 30B-class models
  comfortably. Typical users' Macs (8 to 16 GB) cannot, so nothing may assume a
  large local model.

## Who Decides Which Model Runs a Task

The owner's idea is a local "orchestrator" that only delegates. Build it as a
**dispatcher** in layers:

1. **Rules first.** "This conversation uses my default." "Yes/no checks go to
   Jeff." "Searching my notes goes to the search model." Instant and predictable.
2. **A small local model breaks ties** only when rules cannot decide. The
   dispatcher is a role; the model filling it depends on the machine.
3. **Workers do the tasks:** the local chat model, Jeff (the one door for
   classifiers, with Jev or another decision model behind it; see
   `capabilities-and-primitives.md`), the local search model (EmbeddingGemma,
   from True Convo), and cloud profiles.

The privacy line: the dispatcher may *suggest* a cloud model, but nothing is sent
to a cloud model or host until the owner has approved that model and host once
(strategy decision). Step 3 ships rules only (the owner's default plus a
per-conversation choice). The model-based dispatcher arrives with step 6.

### Scaling Down Once a Task Is Proven (October 25)

Added at the owner's request, from an IndyDevDan video on token costs (its
usage and price figures are the video's and were not checked). The idea: a
strong model works a new kind of task out first, and repeat runs move to the
cheapest model that does it well.

- **The cheapest model that passed.** For a task with a capability behind it,
  the dispatcher picks the cheapest approved model listed as passing that
  capability's example runs (`portable-capability-layer.md`, proof per model).
  A model that hasn't passed is never picked to save money. A new kind of task
  with no passing model goes to the conversation's default or a model the owner
  picks, and its runs can become the capability's first examples.
- **Moving down is checked, not assumed.** A model is added to the passing
  list only by the example runs, which are repeated when a model changes. If a
  cheaper model starts failing, it drops off the list and the dispatcher moves
  back up.
- **Unsure means move up or ask.** When the tie-break layer can't tell, or a
  decision model's "none of these" score is high, the dispatcher doesn't guess:
  it moves to the next stronger approved model or asks the owner.
- **Free models get no private data.** Free hosted models may keep and train on
  what is sent to them. They are approved only for public or invented
  material, never for the owner's messages, memory or files.
- **Costs show per route.** The running total each paid route already keeps
  (see "How Each Model Is Paid For") is shown next to the work it paid for, so
  the owner can see what scaling down saved. Caps and approvals stay in code,
  outside any model.

### Jeff Surfaces Choices; the Owner Makes Them (October 25)

Jeff has other jobs (action checks, sorting what comes in, typed yes/no
answers; see `capabilities-and-primitives.md`). The owner's rule for all of
them (October 25): where a choice needs his judgement, Jeff and the provider
behind it never make the final call. They decide which options to show him,
such as which memory to file and where, what to show interest in, or which tone
to take with a paragraph.

- **Jeff ranks; the owner picks.** Jeff orders the options and drops the
  unlikely ones, and the owner sees a short list on an approval card. Nothing is
  filed, sent or rewritten on Jeff's ranking alone.
- **Low confidence shows more, not less.** When the top options score close
  together, or "none of these" scores high, the card shows more options and an
  open answer instead of a single suggestion.
- **Private content stays local by default.** These choices are about the
  owner's memory and writing, so the default provider behind Jeff for them is
  a local one. A cloud provider such as Jev sees that text only after the owner
  has approved it for that kind of choice, under the caps in
  `capabilities-and-primitives.md`.
- **Only the owner's picks are kept.** As that note already says, Jeff keeps
  the owner's decisions, never the provider's answers.
- **Final calls that need reasoning go elsewhere.** Where a verdict has to be
  worked out, such as whether a code finding is a real bug, a full model
  decides (the Codex triage judge, `docs/plans/codex-triage.md`). A decision
  model may only screen first there.

## Two Kinds of Agent Profile

1. **A profile around a raw model.** True Convo is the harness: its rules,
   memory, tools, permissions and approval cards, with any model underneath.
   True Convo must provide the loop that lets the model use tools.
2. **A profile around an existing harness.** A separate program with its own
   tools and work loop (Claude Code, Cursor's agent, Meta's Muse), started and
   relayed by True Convo. Capable, can run on subscriptions, but its own built-in
   instructions sit under ours and it is heavier to run.

**Decision: the Pi coding agent is the default harness** for agent profiles, so
most profiles are "Pi + a chosen model + True Convo's rules, memory and tools."
Vendor harnesses are used only where a subscription requires its own program.
(Pi Durable, the experimental add-on, is still not adopted; see
`durable-agents.md`.)

## How Each Model Is Paid For

| Route | Runs inside | Paid by | Notes |
| --- | --- | --- | --- |
| Local models (Ollama, LM Studio) | Pi, or direct for plain chat | Free | Private; quality depends on the machine |
| Claude, plan usage | Claude Code (unmodified) | Owner's Claude plan | Each person signs in through Anthropic's own flow. True Convo never handles Claude credentials. |
| Claude, API credits | Pi with an Anthropic API key | Max plan's monthly API credits ($200 on Max 20x) | Credits cover API use including the Agent SDK; they expire monthly, no rollover. Set a Console spending limit at the credit amount; True Convo shows a running total and stops near it. |
| Claude, sign-in inside Pi | Pi | **Extra usage, billed per token** | Off. Not covered by plan usage or API credits. |
| ChatGPT | Pi signed in with the owner's ChatGPT plan | Owner's ChatGPT plan | Pi supports it, but Pi stores sign-in tokens in a plain file (`~/.pi/agent/auth.json`). **Blocked** until those tokens can live in Keychain or the protected store (see Credentials). OpenAI's rules for a shipped product are unverified. |
| OpenRouter | Pi with an OpenRouter key | Per use; some free models | Owner approval and a monthly cap |
| Grok | Cursor's own agent, on the owner's Cursor plan | Owner's Cursor plan (unverified) | Cursor's agent supports scripts and lists Grok; whether automation uses the plan, and Cursor's rules, need checking first |
| Meta Muse | True Convo's existing sealed bridge | Meta pay-per-use, $10/month cap | Heaviest; last |

## Credentials With Pi (Requirement From Codex Review)

Pi keeps API keys and sign-in tokens in `~/.pi/agent/auth.json`, a regular
file. That breaks the rule that secrets live only in Keychain. So:

- **API keys** (Anthropic credits, OpenRouter): True Convo reads the key from
  Keychain and hands it to each Pi run directly (Pi's `--api-key` option or a
  per-run environment variable). Nothing is written to `auth.json`, and a test
  proves the file stays absent or unchanged.
- **Sign-ins** (ChatGPT plan): not used until the tokens can be held in Keychain
  or in step 2's encrypted store, for example through a Keychain-backed
  credential adapter. Until then the ChatGPT-through-Pi route stays off.

Rules that apply to every route: no paid overflow; subscription access is not
permission for paid API use; every paid route has the owner's approval and a cap;
keys live in Keychain, never in files or logs.

## Adapter Order

1. **Local models plus a model picker.** Step 3 finishes with this route only.
2. **Claude through Claude Code**, right after step 3, because True Convo's
   runner for it is mostly built. Kept alongside Pi on purpose: it uses the
   plan's included usage and brings Anthropic's own coding tools.
3. **Pi as the harness** when agents start doing work (step 6): local first, then
   Claude through the API credits, then ChatGPT once its sign-in can be stored
   safely (see Credentials).
4. **OpenRouter plus a model picker**, inside Pi.
5. **Grok through Cursor's agent**, after checking Cursor's rules and billing.
6. **Meta Muse.**

## Knowing When an Agent Isn't Working (October 26)

Added at the owner's request. The repo's own review rules name Gemini Code
Assist as a reviewer, but Gemini was never set up, and nothing said so: work
could wait on a review that was never coming. The owner's rule (October 26):
every agent True Convo brings in, whether or not it touches code, needs a way
to show that it isn't set up or isn't answering, so nobody waits on it
forever. That covers local models, cloud profiles, vendor harnesses (Claude
Code, Cursor's agent), Jeff's providers and arms-length agents such as Cam.

Requirements for every adapter (the model picker routes in step 3, agents in
step 6):

1. **Every adapter has a setup check.** Ordinary code, no model. It answers:
   is the program installed or the host reachable, is it signed in or is its
   key in Keychain, has the owner approved it, is it under its cap. The result
   is one of **Ready**, **Not set up** (naming the missing step), **Blocked**
   (waiting on the owner's approval, a cap, or rules still unchecked) or
   **Unreachable**. It runs when a profile is added, when the Desk starts and
   before each dispatch. It sends no private content: it uses a call that
   costs nothing, or a fixed prompt with invented text. A check that would
   cost money counts against the route's cap and stays off until the owner
   approves it.
2. **Nothing is sent to an agent that isn't Ready.** The dispatcher skips it,
   moves to the next approved route or asks the owner, and says why. A
   profile that names a worker or reviewer that isn't set up shows "Not set
   up" from the start, never "waiting".
3. **Every request has a deadline.** Each adapter declares how soon its first
   sign of life and its answer should arrive. Harness agents report progress
   as they work; if nothing arrives within the silence window, the agent is
   **Silent**, and the owner sees "<agent> hasn't answered in N minutes" with
   four choices: wait longer, retry once, send to another approved agent, or
   stop. Progress alone never keeps a request open: each request also has an
   answer deadline counted from when it was sent, and an agent still working
   at that deadline is shown as **Overdue** with the same four choices, even
   if it is still reporting progress. At most one automatic retry, logged;
   after that the request is parked and the owner is told (the same idea as
   Pi Durable parking a task that keeps crashing, see `durable-agents.md`).
   Starting windows, which the owner can change: 2 minutes for a local chat
   model, 5 for a cloud model, 20 minutes without progress for an agent
   doing a task, 30 after a push for a review bot. Starting answer deadlines:
   10 minutes for a chat reply, 2 hours for an agent's task unless the owner
   gives it longer when he starts it.
4. **Status is visible.** The "one screen shows every agent" view (Scion idea
   3 below) shows each agent as Ready, Working (with its last sign of life),
   Silent, Overdue, Not set up, Blocked or Stopped, plus when it last finished a run.
5. **Arms-length agents are watched from outside.** For an agent True Convo
   doesn't run (Cam, a GitHub review app), the check is only an observation:
   when it last answered. One that is expected but has never answered shows
   "never answered" after its first deadline, not "pending".
6. **Checks only report.** Like the watchers in "Superfans" below, a health
   check never fixes, reinstalls, signs in or changes settings beyond the one
   logged retry. Being alive says nothing about being trusted: a working
   foreign agent still starts at zero trust.

### The Same Rule for Our Own Build Pipeline (Proposal)

Today only Codex is covered: the PR keeper restarts a hung Codex review once
and the 8 AM list shows "Codex silent" (AGENTS.md, "Coordinating On
GitHub"). Proposed, for the owner to approve as a change to AGENTS.md and the
PR keeper's prompt (AGENTS.md is an owner-only path):

- **Each reviewer and builder has a stated setup status** in AGENTS.md, for
  example "Gemini Code Assist: not set up (October 26)". While one is not set
  up, no pull request waits on it: its stand-in (a fresh Claude review for
  Gemini) is used from the first round.
- **The PR keeper checks every expected reviewer, not just Codex.** If a
  reviewer the rules expect hasn't posted on a pull request's latest commit
  within its window (20 minutes for Codex as now, 30 for Gemini), the keeper
  reports "<agent> silent on #N". If it has never posted on any pull request,
  the keeper reports "<agent> not set up" once on issue #52 instead of on
  every pull request.
- **Builders are covered too.** When a GrokBot builder hasn't pushed within
  four hours of a relayed fix, the keeper reports "GrokBot team X silent on
  #N" instead of relaying again.
- **The 8 AM list gets a "Not working" line** naming any agent that is
  silent or not set up, so the owner learns it once, from one place.

## Borrowed From Scion (Step 6)

Added October 14, 2026 by the planning session, at the owner's request.
Scion is Google's experimental, open-source system for running teams of
agents (Apache-2.0, pre-1.0). It is unrelated to Anthropic's internal
source-control system of the same name, covered in the next section. Its templates match our agent profiles, its
harnesses match Pi and the vendor harnesses, and its hub matches our
dispatcher. **Decision: borrow three ideas for step 6; do not adopt Scion as a
dependency now.** It is still changing quickly, and its container-per-agent
design is too heavy for typical 8 to 16 GB Macs. Its cloud runtimes
(Kubernetes, Cloud Run) conflict with local first and stay out. Because of its
license, Scion can be revisited later as an optional engine for power users.

The three ideas, as requirements for step 6:

1. **Each agent works in its own space.** An agent that changes files gets its
   own Git worktree (a separate working copy of the project) or its own
   folder, so two agents never edit the same files at once. The owner reviews
   and merges an agent's work, the same way pull requests work today.
   Containers are not required.
2. **Agents can pass findings to each other.** A simple, logged message channel
   between agents in one session, visible to the owner. Messages carry only
   what the sending agent's permissions and the memory space rules allow, and
   a message never sends anything to a cloud model or host the owner has not
   approved.
3. **One screen shows every agent.** The Desk gets a view listing each running
   agent: its profile, model, what it is working on, its space, and a Stop
   button. This is the design for "Claude and Codex visible in one session."

## Lessons From Anthropic's Internal Scion

Added October 15, 2026. The owner's original question came from a YouTube
video, "Anthropic Just Ditched Git (Claude Broke It)"
(https://www.youtube.com/watch?v=6Ozh4BKmtvs). Anthropic's own account is the
primary source: "Redesigning source control at Anthropic"
(https://www.anthropic.com/engineering/redesigning-source-control, published
October 13, 2026, read October 15).

What Anthropic's post says: Claude writes so much code that git could not keep
up with Anthropic's monorepo (merged changes rose from about 2,500 a day in May
2026 to over 30,000 a day by September, with about 25 million CI checkouts a
day). A team of seven spent five months building Scion, a server-side version
control system, and Antique, a code review tool. Checkouts became "seconds
rather than minutes," and the infrastructure is far smaller. Scion is internal
and, in Anthropic's words, not a suitable git replacement for general use. The
video adds a figure the post does not give (fresh agent workspace setup from 7
minutes to 5 seconds); treat that one as the video's claim only.

We need none of that tool. The five lessons are what is worth keeping:

1. **Time the whole loop, not just the typing.** Here the slow part is waiting
   on review rounds, not writing code. *Applies now.*
2. **The owner's main job is saying "no."** Read each change for its intent and
   ask two questions: does it break a rule of this system, and does it fix a
   problem the owner actually has? *Applies now;* proposed as a review rule in
   AGENTS.md, pending the owner's approval.
3. **Spend saved time on tests.** Step 2's kill-and-reopen proof already does
   this. Good tests are what make later rewrites safe. *Applies now.*
4. **"Superfans."** Give each part of the system its own agent whose only job
   is watching that part's logs and flagging anything strange. *Planned for
   step 6, and fits the Visibility Agent's "ongoing watch."*
5. **Question rules that exist only because people are slow.** For example, a
   full Codex review round on every docs pull request may be more process than
   a plan doc needs. *An idea only; the review rules in AGENTS.md are
   unchanged.*

**Superfans as a step 6 idea.** One watcher agent per part of the system (for
example storage, memory, the Desk, the dispatcher), each reading only its own
part's logs. A watcher only reports: it shows findings to the owner on the
Desk and never fixes, restarts or changes anything without the owner's
approval, in line with the approval rules in AGENTS.md. Watchers follow the
same memory space and privacy rules as every other agent and send nothing to a
cloud model the owner has not approved.

## Before Shipping to Other People

- Anthropic: running Claude Code inside a product requires its Commercial Terms,
  an unmodified Claude Code, and each person's own credentials. The owner should
  have the final setup reviewed; this note is not legal advice.
- OpenAI and Cursor: check their rules for embedding their sign-ins or agents.
- Recheck every billing fact above; these change often.

## Sources (Checked October 13, 2026)

- Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- API credits for Max and Team plans: https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers
- Pi providers and sign-in: https://app.unpkg.com/@mariozechner/pi-coding-agent@0.73.1/files/docs/providers.md
- Cursor CLI: https://cursor.com/en/cli
- Codex CLI with local models: https://codex.danielvaughan.com/2026/05/03/codex-cli-gpt-oss-local-models-ollama-lm-studio-mlx-setup-guide/
- Scion (GoogleCloudPlatform/scion) README, checked October 14, 2026: https://github.com/GoogleCloudPlatform/scion
- Anthropic, "Redesigning source control at Anthropic", October 13, 2026 (primary
  source): https://www.anthropic.com/engineering/redesigning-source-control
- Video "Anthropic Just Ditched Git (Claude Broke It)", summarized from its
  transcript October 15, 2026 (secondary; its 7-minute-to-5-second figure is not
  in Anthropic's post):
  https://www.youtube.com/watch?v=6Ozh4BKmtvs
