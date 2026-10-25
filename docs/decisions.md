# Owner Decisions

The owner's decisions, newest first. Only the owner approves changes to this
file (`.github/CODEOWNERS`), so agents can't add or change a decision on
their own. A pull request that records a decision updates this file and waits
for the owner. Where the build is now lives in [STATUS.md](../STATUS.md); the
full plan and history are in [PLAN.md](../PLAN.md).

- **Oct 25:** More work per dollar, without the owner or his Mac awake.
  The PR keeper moves to the cloud, counts a Codex review as hung after 20
  minutes instead of 60 (restarting it at its next hourly run), updates a pull request from `main` only once it is
  otherwise ready to merge, and relays Codex findings on GrokBot pull
  requests to the builder with an `@cursor` comment. After three Codex
  rounds, builders fix only P0 and P1 findings and leave P2 and P3 to the
  triage judge, unless no verdict arrives within two hours; Codex keeps
  raising a finding left for the judge until the judge rates it (AGENTS.md
  "Review Guidelines" and "Coordinating On GitHub").
- **Oct 24:** Next outside modules: the email actions preview (Codex builds
  through the local Codex CLI, Gemini reviews), the tasks and reminders
  engine (GrokBot team A) and the Today agenda (GrokBot team C, after #112),
  both reviewed by Codex. Plans: `docs/plans/email-actions-preview.md`,
  `tasks-engine.md` and `today-agenda.md`.
- **Oct 23:** Gemini Code Assist is the impartial reviewer (installed on
  open-convo Oct 23). Codex reviews GrokBot's work; Gemini reviews Codex's
  and Claude's, and Codex never counts as the independent review of its own
  work. Gemini is advisory to start: critical and high findings count as P1,
  medium as P2, fixed or answered before auto-merge goes on; no required
  check reads it yet. Until it posts reviews, a fresh Claude review stands
  in. Claude-built and Codex-built pull requests open with auto-merge off;
  the coordinator switches it on once the independent review and any plan
  check are clean on the latest commit.
  Agents ask for `/gemini review` only from `cloudwork-bot` (AGENTS.md
  "Review Loop"). Open: Argon through the Gemini CLI or an API key kept as a
  repository secret, and whether Gemini becomes a required check.
- **Oct 23:** Mac app builds and full Mac test runs on the owner's Mac go one
  at a time, and no stress or load testing there without his OK. Agents run
  on their own servers, so there is no cap on how many work at once; True
  Convo's old two-heavy-sessions limit doesn't apply here (AGENTS.md
  "Limits").
- **Oct 23:** Hung Codex reviews restart by themselves. Codex's review of
  #120 hung twice ("running" with no result) and an empty commit restarted it
  both times, so the PR keeper now does that once per commit when a review
  hangs (AGENTS.md "Coordinating On GitHub"). Codex may also use the owner's
  credits for reviews after a rate limit (owner's Codex setting).
- **Oct 23:** Codex builds two standalone engines from the public launch
  set as an outside builder: email sorting
  ([docs/plans/email-sorting-engine.md](plans/email-sorting-engine.md)) and
  calendar merge
  ([docs/plans/calendar-merge-engine.md](plans/calendar-merge-engine.md)).
  Gemini Code Assist reviews them (Codex never reviews its own work), and
  the coordinator checks each pull request against its plan. The plans'
  owner questions are still open; builders use the recommended answers
  unless the owner changes them before the code pull request merges.
- **Oct 23:** One account per role. `CloudworkSystems` is the owner's alone;
  every agent, Claude scheduled task and app connection that writes to GitHub
  uses `cloudwork-bot` (one bot for all agents; Codex keeps its own app and
  the repo's GitHub Actions workflows post as `github-actions[bot]`), and
  each marks its work with an `agent:` label and a sign-off line (AGENTS.md
  "Accounts And Provenance"). The PR steward no longer runs planning checks
  or switches on auto-merge; the coordinator does both, including where older
  plans name the steward, and for Codex-built work only after Claude's review
  of the latest commit is clean.
  Codex reviews every pull request on each push by itself, so no agent asks
  for reviews from the owner's account. Outside-builder pull requests merge
  by auto-merge after the coordinator's plan check, with no owner click.
  Agents may show the owner the exact `owner-accepts-findings` line but never
  post it. The coordinator is the Claude thread "261012 OC Coordinator" (the
  planning session in earlier decisions); AGENTS.md "Who Does What" gives
  every agent its one job. Up to five outside modules at a time (was three):
  GrokBot's teams plus Codex as a builder, each from its own plan.
- **Oct 22:** Day one and public launch (owner interview, planning session
  `OC-261022-plan-day-one-and-sync`). The day-one proof is a ChatGPT-style
  chat that works on a local model plus tasks and productivity as its first
  real job. Public launch needs the Mac and iPhone with private sync;
  Apple-only (CloudKit) at launch, Windows and Android later. The iPhone app
  and sync move from after step 5 to a parallel line starting now; its first
  slice is the standalone sync core ([docs/plans/sync-core.md](plans/sync-core.md)),
  built by the next free GrokBot team. Open Convo stays truly open source;
  the True Convo name is protected by trademark, so copies that aren't a
  subscriber's can't use it; "Powered by True Convo" in forks is deferred.
  A module joins the core once it runs on the user's own keys or local
  models at almost no ongoing cost to the project. Pricing and the business
  plan stay out of this repo. The owner's starting tasks list, in order:
  checklists (household lists engine), habit grid, email triage across
  several inboxes, one combined calendar (later on a family wall display),
  and start-on-iPhone, continue-on-Mac. Every user gets the whole harness,
  which also teaches building their own local apps. The multi-level
  white-label tiers from October 15 stay on top of the flat subscription.
  Launch scope: chat, checklists, habit grid, iPhone-to-Mac continuity, a
  read-only Personal calendar, and email sorting only (local model); email
  actions follow right after launch, each asking first with a preview
  (foundations principle 1; the owner asked for standing rules, which stay
  limited to sorting unless he changes that principle); the family calendar,
  voice to calendar and wall display stay at step 11. Building apps for users
  comes after launch with step 6, and public copy says it is coming.
- **Oct 21:** Scale-up plan approved ([docs/plans/scale-up.md](plans/scale-up.md)).
  Up to three outside modules at a time, each with its own builder or builder
  team; modules waiting only on review fixes don't count. None is waiting
  only on review fixes today: the habit grid merged as #74 and the
  household lists fixes merged as #71, both on October 21. GrokBot's three teams build annotation
  rounds (team A), Site Engine "what will change" (team B) and the
  visibility report (team C), each from its own plan, which has its own plan
  pull request, with Codex reviewing. Two Claude building lanes run now (main step; Desk and
  dogfooding), with an infra lane added after the auto-update job merges.
  Standing approval to rebuild True Convo Test on the owner's Mac when it is
  idle and the Test app isn't running: Test app only, built from `main`, old
  build kept if a build fails, in a window from 2 to 6 AM Eastern.
  Narrowing the Mac app's protected paths is approved in principle but
  deferred to its own plan, written when the refactor is ready; until then
  all current CODEOWNERS protection stays as it is, and nothing unprotects
  any Mac file. Agents add approvals to one daily "Needs the
  owner" list instead of pinging, which the owner reads at 8:00 AM Eastern;
  urgent items still come in chat. The rebuild and the daily list each run
  as a scheduled task on the owner's Mac.
- **Oct 21:** Pi Durable (MIT, from the makers of Pi) is the foundational
  multi-agent framework for step 6, accepted as experimental: pinned to an
  exact version, reached only through Open Convo's own thin layer, attribution
  headers off, storage in the owner's protected space, and every tool marked
  safe or unsafe to run twice (docs/design-notes/durable-agents.md).
- **Oct 21:** The PR steward counts as part of the planning side: after its
  own passing planning check on an outside builder's pull request, it may
  switch on auto-merge, and it may post the `@codex review` fallback when a
  builder can't start a Codex review. It still never merges, approves or
  changes code.
- **Oct 21:** For Codex-built modules, the planning session or the PR steward
  switches on auto-merge only when Claude's review of the latest commit has
  no open P1 or P2 (fixed, or explained as not applying; P3s don't block);
  until then auto-merge stays off. Claude's review counts only for the commit
  it reviewed: whoever pushes a commit that changes the content switches
  auto-merge off until Claude reviews the new head; an update from `main`
  that leaves the pull request's own changes the same needs no new review.
  Any session that finds an open P1 or P2 in Claude's review may switch
  auto-merge off and comment why. (Claude's review
  doesn't gate the merge yet, so otherwise a Codex-built pull request could
  merge before Claude looks at it.)
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
