# Agent Team: One Screen, A Task Board, Agents That Wake Each Other, And Steering You Can See

Status: Draft (Nov 7, 2026, updated Nov 8): proposed; waiting on the owner's yes. Nothing is built or installed. Meant for `docs/plans/agent-team.md`, opened through the Cloudwork Agents app from the Mac Studio, the way the GitHub app switch plan (#314) was.

Written November 7, 2026 by a Claude thread (project "Claude", task "261107 HERDR COMPARISON"), from the owner's picks while reading the Herdr comparison (`herdr-vs-open-convo.md`, the same folder). Session name: `OC-261107-agent-team`. Umbrella: Personal (used by every umbrella). The owner's words, in the Claude project chat on November 7, 2026:

- 04:53 UTC, on "one agent, many bodies": "Many bodies, sharing knowledge, thoughts, but not necessarily (visible) speech".
- 05:53 UTC: "we needed like an agent, a singular agent screen", and "I do like the point about agents talking together with hooks being integral to the rhythm of the conversation."
- 05:54 UTC: "If the hierarchy is the one agent is ordinate to the one below it, I should be able to see that that agent is responding. I should be able to delegate that authority to that agent to be in charge of an agent below it".
- 06:01 UTC: he has a Mac Mini whose only purpose is running AI harnesses and agents; he sees "a use down the road for a terminal pane"; "I agree overall."
- 06:28 UTC, on splitting the two Macs (the Mac Studio as his desk and main agent setup, the Mac Mini as the agents' own machine): "Yes, split it that way".
- November 8, 19:37 UTC, on two ideas from BAND Desktop (a task board where agents claim work, and cost shown per agent): "Add both to the plan".

Those cover writing this plan, not merging or building it.

**Builder:** Claude for slice 1, writing to GitHub as `cloudwork-agents[bot]` from the Mac Studio (the GitHub app switch plan, #314), since `cloudwork-bot` is suspended. **Reviewers:** Codex reviews every push; GrokBot or a fresh Claude gives the independent review, ending with the risk-review checklist (`risk-review.md`); the coordinator checks the code against this plan. **Finish line:** in "Finish Line" below.

## Why

The owner works with more and more agents: Claude (Duet threads, building sessions, scheduled jobs), Codex, GrokBot, Cam, and later the local agent profiles. Today he finds out what each one is doing by asking, or by reading GitHub. Herdr, a terminal app for running AI agents, showed three things that make a team of agents feel easy to run:

- one screen that says which agents are done, which need you, which are working and which are idle;
- when an agent it started finishes or gets stuck, the main agent hears about it right away, without checking on a timer;
- agents can talk to each other, and you can watch them do it.

Herdr does this with no limits: any agent can start other agents, answer their questions and run commands. Open Convo keeps the speed and adds the limits it already has.

## What We Looked At First

Herdr was read from the full transcript of the video the owner saved (NetworkChuck's walkthrough) and his Recall summary. Nothing was installed or copied. The repo already looked at Herdr on October 25 (`durable-agents.md`, "A Terminal in True Convo") and decided that a terminal is one more screen in the app, not the place agents live. This plan keeps that.

On November 8 the owner also looked at BAND Desktop, a free Mac app where Claude Code, Codex and other agents share one room, message each other, claim items on a task board and show tokens and cost per agent. It is a design reference only: nothing was installed, and Open Convo doesn't connect to it. Its page makes no security or permission claims and doesn't say whether agents' work stays on the Mac, and it would be a second place where agents coordinate. Parts 9 and 10 borrow its task board and its usage per agent, built on the ledger.

## The Picture: One Agent, Many Bodies

Plain meanings for the words this plan uses:

- **Profile:** one agent as the owner defines it: its job (its domain), its rules, its permissions and the memory spaces it may use. A steward is a profile.
- **Body:** one running copy of a profile inside one harness. The same profile can have a body in Open Convo, one in Claude Code on the Mac Mini and one in Codex. Each body keeps its own native conversation in its own harness.
- **Harness:** the program a body runs in (Open Convo itself, Claude Code, Codex, Cursor, Meta's Muse).
- **Ledger:** the shared list from the agent ledger plan (PR 312) where every body posts what it did, needs or is waiting on.
- **Space:** a memory space (Personal, or one per business), the shared context underneath a set of agents.
- **Group (the owner's "meta agent"):** a parent in the team tree (part 1) whose children share one space. A domain agent is like a Claude Duet channel; a group is the agent above several of them that sees the context they share. The team tree is where the owner's Pantheon idea would live.

Bodies share knowledge, decisions and handoffs through the ledger and the memory spaces. They don't copy each other's whole conversations. When a body needs something, it pulls it through its door, and what it pulls becomes part of its own conversation as a cache. The ledger stays the one record. Everything that crosses between bodies is readable by the owner, even when it isn't shown in any agent's chat.

**Trust follows the body, not the profile.** A body inside a harness the owner's trusted builders use gets that body's permissions. A body inside another company's product (Muse, for example) is a foreign body and starts with nothing, whatever profile it carries. The host holds each body's permissions separately.

## The Parts

### 1. Who Reports To Whom (The Team Tree)

- The host keeps a team tree in the same registry the ledger plan uses (rule 3 there: held by the host, changed only by the owner, read-only to every agent). Each body has one parent. The owner is at the top, the prime agent (the PA) is under him, and specialists sit under the PA or under another specialist.
- The tree is the owner's. No agent adds itself, moves itself, changes its parent or adds a child. An agent can *propose* a change ("start a research body under me"), which reaches the owner as a request, never as a change.
- A foreign body can be a child but never a parent. It can't steer anyone.
- The tree is what the agent screen draws, and what the wake and steering rules below read.

### 2. Agents Wake Each Other (Hooks In The Rhythm Of The Conversation)

- Any body can **follow** a piece of work (a work name or a pull request, the ledger's `about` field). A parent follows the work it handed out by default.
- When a new ledger entry lands on followed work, the host **wakes** each follower: for a body Open Convo runs, it starts that body's next turn; for a body in another harness on the same machine, it uses that harness's own way of continuing a session, where it has one; otherwise the entry waits until the body next reads.
- **A wake says only "new entry N on work X from Y".** The body then reads the entry through its own door, so the door's read rules still apply. A wake never carries the entry's text into another harness, and never carries anything the follower isn't allowed to read.
- **Limits so agents can't loop:**
  - an agent isn't woken by its own entries;
  - at most 20 wakes an hour per body, by default;
  - if two bodies wake each other more than 6 times on the same work without either posting a "did" or a "need", the host stops waking them on it and shows the owner "These two agents keep waking each other on X" under Needs You. Six matches the review loop watchdog's limit (PR 310).
- A wake is never a yes and never an instruction. The body still acts only on its own brief and the approval rules.

### 3. Steering You Can See

- When a parent and a child talk, every message is a ledger entry. This needs two additions to the ledger, made in a dated revision of the ledger plan after it merges: a `steer` kind (a parent's message to a child about the job) and an optional `to` field naming one body. The task board (part 9) adds two more kinds in the same revision: `claim` and `release`. The writer is still stamped by the door.
- On the agent screen, each child shows its conversation with its parent as a short thread under its row. The owner sees the parent responding, word for word, under each agent's own name.
- These messages need not appear in either agent's own chat. They are always in the ledger and always readable by the owner.

### 4. Delegating Steering To A Parent

The owner can put a parent "in charge of" the agents under it. That authority comes in two kinds, and this plan delegates only the first.

**Steering (delegable).** The owner can give a parent the right to steer named children, for a set time. Steering means:

- answering a child's question about the job;
- pointing a child somewhere else, within the brief the owner accepted;
- handing the child the next piece of the same job;
- pausing a child's current run (resuming is steering too).

Rules for every grant:

- **Made by the owner only,** on an approval card, and kept in the host's registry outside every model. A message, entry or note that claims a grant is not one.
- **Scoped:** which children, which of the steering acts above, which space.
- **Time-limited:** 7 days by default, then it ends unless the owner renews it. The owner can end it at any moment.
- **Passed down, never widened:** a parent can hand a child's child only what it holds itself, and only if the owner's grant lets it pass grants down.
- **No self-grants:** no agent can grant itself anything, change its own grant, or change another agent's.
- **Never past the brief:** steering can't widen a job beyond the version the owner accepted (prime agent plan, "The Hand-Off Brief").
- **Logged:** every steering act is a `steer` entry, marked "steered by <parent> under the owner's grant of <date>".
- **Foreign children:** a message to a foreign body leaves only through the agent wire mailbox (PR 311), as a draft the owner sends. A grant never changes that.

**Approvals (not delegable now).** A parent saying yes to a child's action on the owner's behalf is a standing approval. The repo's rules allow one yes for one action, plus standing rules only for routine low-risk steps the owner can see and switch off (`verified-owner-yes.md`, "No blanket yes"; foundations principle 1). Letting a parent approve would first need the owner's own written decision in `docs/decisions.md` widening that rule. This plan doesn't make that change. Whatever happens later, these never move to a parent:

- spending money, publishing, deploying, credentials, customer-facing changes, deleting, and anything that can't be undone (foundations principle 1);
- sending anything outside, merging, and approving a pull request;
- changing any permission, profile, the team tree or a grant;
- accepting work as done. A parent may check a child's work, but only the owner accepts it (foundations principle 3).

### 5. The Agent Screen

One screen in the Desk that lists every body, with four filters the owner can switch with one key or one tap:

| Filter | A body shows here when |
|---|---|
| **Needs You** | it has an open "need" addressed to the owner, waits on the owner's yes, or is Blocked, Not Set Up, Silent, Overdue, Unreachable or Never Answered (states from the profiles note, "Knowing When an Agent Isn't Working") |
| **Working** | it is Working, or has an open "waiting" |
| **Done** | it posted a "did" since the owner last opened the screen, and nothing is open after it |
| **Idle** | it is Ready, with nothing open and nothing new |

When more than one fits, the first in this order wins. A body no rule fits shows as Unknown, never as missing (the status feed's rule).

Each row shows: the agent's name and profile badge, its machine, its space, what it is working on (its claimed board items, part 9), its last sign of life, its parent, its detailed state as a small label, and its usage (part 10). Clicking a row opens that body's own conversation. Children's steering threads sit under their parent's row (part 3).

**Alerts:** a sound and a pop-up only when a body moves into Needs You, bundled if several move at once, and silent during the owner's quiet hours. Nothing else alerts.

The screen only reads. It changes nothing except the owner's own "last opened" mark.

### 6. Which Agent Is In Which Working Copy

Each agent that edits files already works in its own copy of the project, so two agents never change the same files (the repo calls these worktrees). The owner should see which agent is in which copy. That view goes on the Nexus Rail Map, which already shows branches and pull requests, as a label on each branch's lane naming the agent and machine working there. Atlas reads the same record later. No new screen. It reads the record of which session opened which branch; where that record doesn't exist yet, the label says "unknown agent".

### 7. One List Of Machines

- The owner's machines are listed once, each with its job (owner's split, November 7):
  - **Mac Studio:** his desk and the main agent setup. He talks to agents, reviews and approves their work here. **The ledger and the team registry live here.**
  - **Mac Mini:** the agents' own machine, for agent experiments and a backup copy of the repository that keeps itself up to date, so a GitHub suspension never locks the owner out of his code.
  - **The exe.dev VM:** the builders' cloud machine, as today.
- Each body's row on the agent screen names its machine.
- **Pull only.** The Studio reads status from the Mini and the VM. Nothing on another machine can reach into the Studio, write to its ledger or change its registry. That's the same direction the agent wire plan already uses. A body on the Mini posts to the ledger only through a door the Studio opens to it, under the same rules as any other body.

### 8. Later: A Terminal Pane

Many people, the owner included when he started, work in the command line before they use desktop apps. Open Convo can have a terminal pane later, built on the same profiles, ledger and team tree, not by installing Herdr. A terminal the owner types into can come with the Desk shell work. A terminal that **agents drive** waits until the app has its own built-in lock: code outside every model that blocks any step an agent wasn't allowed, plus a test proving no agent can get around it (foundations principle 12, `portable-capability-layer.md`). Today's limits are rules agents are told to follow, which isn't enough for an agent running commands. Direction only; its own plan later.

### 9. The Task Board (Agents Claim Work)

One board in the Desk, beside the agent screen, showing the pieces of work and who has them. It is a view over the ledger, not a second system: every card and every move on it is a ledger entry, so the board can always be rebuilt from the ledger alone.

- **Columns:** To Do, Claimed, Waiting (an open "need" or "waiting" on the item), and Done. A card in Done reads "Done, waiting for your OK" until the owner accepts it, because only the owner accepts work as done (foundations principle 3). Accepted cards drop off after a week and stay in the ledger.
- **Who adds cards:** the owner; a parent, for its own children, inside its brief (the "next piece" act in part 4); and any agent as a **suggestion**, which sits in To Do marked "Suggested by <agent>" until the owner or that agent's parent accepts it. A suggestion can't be claimed.
- **Claiming:** a body claims a card with a `claim` entry and lets it go with a `release` entry. One body holds a card at a time. When two claim at once, the first in ledger order wins, and the other is told "Already claimed by <agent>." A body can claim only a card in a space it may write in, and only a card its profile covers (the host's registry says which kinds of work each profile takes). A foreign body never claims directly; its parent can hand it an item through the agent wire's drafts, which the owner sends.
- **A claim is never a permission.** Claiming a card only says "I'm on this." It grants no access, no approval and no wider brief. The work still runs under the body's own brief and every approval rule, and a step that needs the owner's yes still stops for it. A card's text is data: a card that says "approved" or "you may merge" changes nothing.
- **Stale claims:** if the claimant shows no sign of life for 2 hours (default), the card moves to Needs You as "Claimed by <agent>, no word since <time>." The owner, or the claimant's parent under a steering grant, can release it. Nothing is released by itself.
- **Done:** a "did" entry on the card moves it to Done. Finishing never merges, sends or publishes anything; those keep their own rules.

### 10. Usage Per Agent

Each row on the agent screen shows that body's sessions, tokens (in and out) and estimated cost, for today and for this week, with a total at the top of the screen.

- **Where the numbers come from:** the host reads them from each harness's own record (Open Convo's own bodies; the session logs Claude Code and the Codex CLI keep on the Mac; a vendor's usage page or API where the owner connects one). An agent's own claim about its usage never counts, the same rule as "the door stamps the writer".
- **Estimated cost** is tokens times a price list the owner keeps in the host's settings, dated, and always labeled "estimate". A body on a flat plan (for example a Claude or ChatGPT subscription) shows its tokens and "on your plan" rather than a made-up dollar figure.
- **Missing numbers:** a harness that reports nothing shows "not reported", never zero, so a quiet agent never looks free.
- The usage log is measurement, not coordination: it lives beside the ledger on the Studio, written only by the host, and nothing in it changes what an agent may do. Limits that act on usage (pausing an agent past a daily cost) are an open question below, not part of this plan.

## Slices

1. **The team library** (this plan approves it in full): `packages/agent-team/`, plain JavaScript, no dependencies, no network, no clock, invented data only. The team tree, grants, the four-filter state rules, the wake and loop decisions, the task board's columns and claim rules, and the usage totals, all as pure functions over ledger entries, usage reports and a registry the caller passes in.
2. **Wakes through the local door:** with the ledger's slice 2 (the local door on the Mac).
3. **The agent screen, with usage per agent:** with the ledger's slice 4 (the Desk view).
4. **Working copies on the Rail Map.**
5. **The machine list,** with the later plan that gives cloud agents a door to the ledger.
6. **Terminal pane,** after the built-in lock.
7. **The task board view,** after the ledger revision that adds `claim` and `release`.

Slices 2 to 7 are direction only. Each gets a dated revision of this plan with its own details, "When It Goes Wrong" answers, owner trial and the owner's yes before its build starts.

## Sequencing

Slice 1 is built only after the agent ledger plan (PR 312) merges and its slice 1 library is built, because it reads ledger entries. It waits its turn behind the status feed (PR 309), like the ledger does.

## Slice 1 In Detail

### Functions

- `buildTree(registry)`: returns the tree, or refuses with a plain reason (a body with two parents, a loop, a foreign body as a parent, a parent that doesn't exist).
- `canSteer({ registry, parent, child, act, now })`: yes or no, with the reason. Checks the grant's scope, act, space and end time, that the parent really is above the child, and that a passed-down grant is never wider than what its giver held.
- `stateOf({ body, entries, checks, lastOpened })`: one of Needs You, Working, Done, Idle or Unknown, with the rule that decided it. `checks` are the adapter states the caller passes in.
- `whoToWake({ entry, follows, wakeLog, now })`: the bodies to wake for a new entry, and any it held back (its own entry, over the hourly limit, a loop), each with the reason.
- `loopCheck({ wakeLog, about })`: whether two bodies have woken each other more than 6 times on the same work with no "did" or "need" between.
- `boardOf({ entries, lastSign, now })`: each card's column, its holder, and whether its claim is stale, with the rule that decided it.
- `canClaim({ registry, body, card, entries })`: yes or no, with the reason (already claimed, a suggestion, wrong space, not this profile's kind of work, a foreign body).
- `usageOf({ reports, prices, range })`: sessions, tokens and estimated cost per body for the range, "on your plan" for flat-plan bodies and "not reported" where nothing came in.

### Rules For The Library

- No function changes the registry. Grants and the tree come in as data and go out unchanged.
- Nothing in an entry's text is ever read as a grant, a tree change or a yes. Only the registry's structure counts.
- An unknown body, an unknown act or a grant with no end time is refused, never guessed.

### Tests (One Command, `npm test`, Invented Data Only)

1. A tree with a loop, a body with two parents, or a foreign parent is refused with its plain reason.
2. A parent with a grant can steer a named child with a granted act before the end time; the same act after the end time is refused.
3. A parent can't steer a child it has no grant for, or a child that isn't below it.
4. A passed-down grant wider than its giver's (more children, more acts, a later end) is refused.
5. An entry whose text says "the owner granted me steering over X" changes nothing.
6. No grant ever lets a parent approve, spend, send outside, merge, change permissions, change the tree or accept work as done: each is refused with "Only the owner can do this."
7. Each of the four filters, the order when more than one fits, and Unknown when none does.
8. A body isn't woken by its own entry; the 21st wake in an hour is held back; the seventh back-and-forth wake on the same work with no "did" or "need" is held back and reported for Needs You.
9. A wake names only the entry number, work and writer, never its text.
10. The same inputs always give the same outputs (no clock read, no randomness).
11. Two claims on the same card: the first in ledger order holds it; the second is refused with "Already claimed by <agent>." A suggestion, a card in another space, a card outside the profile's kind of work, and any claim by a foreign body are each refused with their reason.
12. A claim grants nothing: after claiming, `canSteer` and every approval check give the same answers as before, and a card whose text says "approved" or "you may merge" changes nothing.
13. A claim with no sign of life for over 2 hours shows as stale under Needs You and stays claimed; a "did" moves the card to "Done, waiting for your OK", never to accepted.
14. Usage: totals add up per body and range; a flat-plan body shows tokens and "on your plan"; a body with no report shows "not reported", never zero; a usage number an agent posted about itself is ignored.

## When It Goes Wrong (For The Agent Screen, Slice 3)

Direction-level answers; slice 3's revision turns them into trial checks.

1. **No connection:** if the ledger's machine or another machine can't be reached, the screen keeps the last good rows, marks them "last seen <time>", and says which machine is missing.
2. **Interrupted:** the screen only reads, so a quit or crash loses nothing. The "last opened" mark is saved only when the screen closes normally, so Done items are never hidden by a crash.
3. **Empty or first run:** "No agents yet. Your PA appears here once it's set up," with one button to the profile setup.
4. **Denied or stuck:** the screen needs no permissions of its own. If the ledger refuses reads because it's damaged, the screen shows what checks out and says "Part of the agent list couldn't be checked", with the way to the ledger's reset.
5. **The error message:** plain words naming the agent or machine and what to do, never codes.

## Finish Line

Slice 1 is done when: the library and its sample driver are merged; `npm test` passes on the fourteen tests above; Codex's latest round is clean or its P1s are fixed; the independent review is clean with the risk-review checklist; and the coordinator's plan check finds nothing missing. Then this plan's status becomes In Progress, and Built when the last approved slice ships.

## Rules For The Builder

- Build slice 1 only. No screen, no door, no wake sent to any real harness, no network, no clock.
- Invented data only: no real agent names beyond the sample ones, no real ledger.
- Don't change the ledger, the approval ledger, the status feed, the watchdog or the agent wire. The ledger's `steer`, `claim` and `release` kinds and its `to` field come in the ledger plan's own revision.
- Keep the library's words plain: every refusal is a sentence the owner can read.

## Not In Scope

- Letting a parent approve anything (needs the owner's own decision first).
- Installing Herdr or any terminal multiplexer, or installing or connecting to BAND Desktop.
- Any limit or pause that acts on usage (open question 5).
- Slices 2 to 7 beyond the direction above.
- Copying any agent's whole conversation into another harness.
- Changing the zero-trust rule for foreign agents, or the October 30 rule that they never touch the code.

## Open Questions For The Owner

1. **Grant length:** is 7 days the right default for a steering grant?
2. **Who is at the top:** is the PA always the top agent under you, or can you put a specialist directly under you?
3. **The Pantheon:** should "Pantheon" be the name of the team tree in the app? It isn't written down anywhere in the repo yet.
4. **Stale claims:** is 2 hours without a sign of life the right time before a claimed card shows under Needs You?
5. **Usage limits:** do you want a heads-up, or an automatic pause, when one agent passes a daily cost you set? Not in this plan until you say.
