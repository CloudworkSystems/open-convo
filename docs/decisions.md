# Owner Decisions

The owner's decisions, newest first. Only the owner approves changes to this
file (`.github/CODEOWNERS`), so agents can't add or change a decision on
their own. A pull request that records a decision updates this file and waits
for the owner. Where the build is now lives in [STATUS.md](../STATUS.md); the
full plan and history are in [PLAN.md](../PLAN.md).

- **Oct 21:** The PR steward counts as part of the planning side: after its
  own passing planning check on an outside builder's pull request, it may
  switch on auto-merge, and it may post the `@codex review` fallback when a
  builder can't start a Codex review. It still never merges, approves or
  changes code.
- **Oct 20:** Sage follows the lab-notebook pattern from the MOSAN research
  agent (Sagnelli et al.): a notebook per run, separate roles (analyst,
  proposer, critic, doer with a step budget, checked summarizer), a weighted
  memory of what worked, and borrowed hints that stay provisional and inside
  their memory space (docs/design-notes/sage.md).
- **Oct 20:** The merge gate is on for `main` (scratch tests passed).
  Builders open pull requests as `cloudwork-bot`. Until the bot has Codex
  access, the session that opened a bot pull request asks for each Codex
  review from the owner's account (option 2; a Codex account for the bot is
  to be tried later). Docs and plans get a Codex review, and after its
  findings are folded in, a clean follow-up review of the latest commit
  before the gate merges them. Letting the gate accept a plan's designated
  reviewer in place of Codex (Claude for Codex-built modules) is planned and
  needs the owner's approval before it's built; until then, Codex's review still gates Codex-built pull requests and Claude also
  reviews them, so no agent's review is the only one on its own work. Outside
  builders don't switch on auto-merge; the planning session does after its
  plan check passes. Main-build authors switch it on when they open a pull
  request.
- **Oct 19:** Agents coordinate on GitHub: verdicts are posted on the pull
  request; GrokBot watches open-convo pull requests, reports to the owner and
  sends fixes only to its own builders for pull requests it launched; no agent
  merges or approves; the planning session starts Codex reviews a builder
  can't (the PR steward too, from Oct 21; AGENTS.md "Coordinating On GitHub").
- **Oct 16:** Step 3 local conversation: Retry puts the cut-off message back
  in the message box and the owner presses Send (nothing resends on its own);
  the Claude entry stays out of the model picker until the Claude Code adapter
  works; the default local model is `qwen3:8b`.
- **Oct 16:** Up to two outside modules at a time, each with a different
  builder: GrokBot builds Site Engine (Codex reviews); Codex builds the
  household lists engine in its cloud (a Claude session reviews); the habit
  grid engine starts when either finishes.
- **Oct 15:** Foundations set ([docs/foundations.md](foundations.md)). Claude Code adapter,
  then Canvas/Atlas/Navigator, right after step 3; iPhone capture app right after step 5; modules
  group under umbrellas (Personal, Family, Business, Creator, Code, Agents).
- **Oct 15:** Every review asks two questions of each change: does it break a
  rule of this system, and does it fix a problem the owner actually has
  (AGENTS.md Review Loop; approved by merging #43).
- **Oct 15:** Build the merge gate (one shared write-only bot account for
  the builders, enforced checks, auto-merge). `main` is protected from now on.
  Owner decisions move to this file, which only the owner approves.
  No interim "agents merge docs after Codex's 👍"; wait for the gate.
- **Oct 15:** Outside builders may build standalone modules (AGENTS.md).
  First: Site Engine's standalone slice, GrokBot builds and Codex reviews.
- **Oct 15:** Start step 3 now; the owner runs the step 2 trial when he's home.
- **Oct 14:** Ember is the Desk's look. Business material stays out of this repo.
- **Oct 14:** Dictation protection: words first, app-only reading, one recovery
  key for everything. Accepted the known limit noted on #30.
- **Oct 13:** Step 3 runs on a local model first; the model-based dispatcher
  waits for step 6.
- **Oct 13:** The "Wait—what?" explainer runs on a local model.
- **Oct 13:** Memory lives in separate spaces (Personal, one per business,
  later Family).
- **Oct 13:** Try each step in True Convo Test before the real app.
