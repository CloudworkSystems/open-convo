# Work Record: One Set Of Cards, Shown In Every Cloudwork Nexus View

Status: Draft (Nov 13, 2026): proposed, not approved. Nothing here is built.

Written November 13, 2026 by a Claude building session on the owner's Mac. The
owner asked for it in that session: every plan, every task a session creates
and every idea should appear as a card on the Roadmap, he should be able to
rearrange the cards, and the Roadmap and Nexus Navigator together should tell
the agents what he intends and in what order. Offered a plan for the Roadmap
alone (1) or one that also covers the Navigator (2), he answered "2" on
November 13, 2026, and added that the two are views of the same thing. He
then said the same holds for Cloudwork Canvas and Cloudwork Atlas: all of
them are alternative views, and a change made in one shows in the others
wherever their filters include it.
**Builder:** Claude (cloud, `cloudwork-bot`). **Reviewers:** Codex, plus
GrokBot or a fresh Claude review. **Finish line:** in "Finish Line" below.

## Why

The Desk already has a Roadmap board and a Navigator, but nothing feeds them:

- The Roadmap board shows 13 cards from a hand-written file
  (`apps/desk/src/content/recovery-roadmap.json`), last changed October 12.
  Plans written since then, tasks agents created in sessions and ideas the
  owner raised are not on it.
- The Navigator groups sample sessions into domains and folders. How the
  owner arranges them is saved, but no agent reads it.
- Ideas live as text in documents and chats. An idea that isn't a card can't
  be ordered against the rest of the work.

So the owner's picture of the work and the agents' picture drift apart, and
each session rebuilds the picture by hand.

The owner's direction is one record of the work, shown in more than one view,
so he can use whichever view helps most. The views differ in what his
arrangement says:

- **Roadmap:** the order and column of a card say **when**. This is his
  sense of timing and sequence.
- **Nexus Navigator:** the groups he makes and what he puts in them say
  **what belongs together and what matters**. This is his intent.

Cloudwork Canvas and Cloudwork Atlas are further views of the same record.
This plan connects the three views that exist (Roadmap, Navigator and
Canvas). Atlas is only a placeholder today, so it joins when it is built.
All the views stay in step: a change made in one shows in every other view
whose filter includes that card.

The agents then compare his arrangement with their own read of what is
possible and what should come first, say where the two differ, and learn from
his corrections.

## What Exists Today

| Piece | Today | What this plan does |
|---|---|---|
| Roadmap board (Desk) | Built. Five columns: Suggested, Planned, In progress, Review & try, Finished. Cards can be dragged. Placement is saved in the browser. Cards come from one hand-written file plus the Desk's own work items. | Cards come from the work record. The hand-written file's 13 cards become the record's first cards. |
| Nexus Navigator (Desk) | Built on sample data: domains, folders, pins, rename. | Groups can hold work-record cards as well as sessions, and the arrangement is saved as a signal. |
| Canvas (Desk) | Built on sample data: a map of domains, sessions and work items with links between them. | Shows work-record cards as nodes, under the filter in "Views Stay In Step", and follows those rules. |
| Atlas (Desk) | A "Planned · not connected" placeholder that shows no records. | Nothing in this plan. Atlas is the owner's fourth view of the same record, but it has no screen to connect yet. The plan that builds Atlas must read this record and follow the same rules. |
| Rail Map (Desk) | Built (#132). Git branches, commits and pull requests. The status feed plan adds a Pending tab. | Unchanged. A card can link to its pull request, and the Rail Map stays the git view. |
| Thread map (design note) | Direction only. | Unchanged. It keeps the rule this plan follows: the owner's value and the agent's value are stored separately. |

An earlier version of the Roadmap exists outside this repo, in the frozen
Cloudwork Nexus preview (September 2026): four columns (Proposed, Planned, In
progress, Released) and a "Create Roadmap item" action on any session, file,
decision or work item, which made a card linked to its source. This plan
brings that action back. No code is copied from it.

## One Record, Several Views

There is one list of cards, the **work record**. A view never keeps its own
copy of a card. It keeps only the owner's arrangement for that view.

A card holds:

- an ID that never changes;
- a title and a one-line outcome;
- its kind: **plan**, **task**, **idea** or **work**. Work is every card
  that is none of the first three: the 13 hand-written cards carried over in
  part 1, the Desk's existing work items, and cards made by hand with
  "Create Roadmap item";
- its source, as a link: the plan file, the session that created the task,
  or the document or conversation the idea came from;
- its **source status**, read from the source where the source has one
  (for a plan, the word in its status line). It is a fact about the source
  and is shown as a label on the card. It is not the card's Roadmap stage;
- when it was created and when it was last touched;
- links to outputs, such as a pull request;
- **depends on:** a list of the IDs of cards that must come first. This is
  the causal link between pieces of work: this one can't sensibly start or
  finish until that one is done. The list is written in three ways only.
  The 13 carried-over cards keep the `dependsOn` lists they already have in
  `recovery-roadmap.json`. On any card, the owner can add or remove a
  "Depends on" link to another card. And the owner can accept a link the
  agent proposed (see "Asking The Owner What He Meant"). Nothing else
  writes this list: an agent's proposal is not a link until he accepts it,
  and nothing is read out of titles, plan text or sources. A link to a card
  that no longer exists is dropped.

The Roadmap and the Navigator each store, per card and separately:

- **the owner's placement** (Roadmap column and position, Navigator group);
- **the agent's suggested placement**, with a one-line reason.

Canvas stores only where the owner put each node. The agent makes no
suggestion about Canvas positions, so Canvas has no suggested placement and
no rows in "Where We Differ". A node the owner hasn't moved is laid out by
the Canvas's existing automatic layout.

A suggestion never moves a card the owner has placed. A card the owner hasn't
placed sits where the agent suggests and is marked "suggested" until he moves
it or accepts it.

Every card has a suggested Roadmap column from the moment it exists, so no
card is ever without a stage. The starting suggestion is fixed by kind:

- **plan:** from its status line, as set out in "What Becomes A Card";
- **idea:** Suggested;
- **task:** Planned while its status is open, and Finished once its status
  is done;
- **work:** Suggested for a card made with "Create Roadmap item". A card
  carried over in part 1 keeps the column and position it already had, as
  the owner's placement where he had moved it.

If no rule gives a column, the suggestion is Suggested.

A card's **stage** is its Roadmap column: the owner's placement if he has
placed it, otherwise the suggested one. Source status and stage are two
separate values. A new snapshot can change a card's source status label and
the suggested placement. It never changes the owner's placement. When the two
disagree (the plan file says Approved and he has the card in In progress),
the card stays where he put it, shows both, and gets a row in "Where We
Differ".

## Views Stay In Step

- A change to a card itself (its title, source status, kind, links, or retiring and
  restoring it) is one change to the record. Every open view shows it at
  once, with no reload.
- Each view has a filter: which cards it shows. A card appears in a view
  when the filter includes it and leaves when it no longer does. For
  example, retiring a card on the Roadmap removes it from a Navigator group
  that shows only live cards.
- An arrangement belongs to its view. Moving a card to another Roadmap
  column doesn't move it between Navigator groups, because the two
  arrangements mean different things (when, and what belongs together).
- Where two views show the same fact, they show the same value. A Roadmap
  column is a card's stage (defined above), so any view that shows a stage
  shows that one, and any view that shows source status shows the same
  label.
- Canvas shows every live card (not retired) as a node, linked to the
  session or work item it came from and to the Navigator group the owner
  put it in. A card with neither link sits in an "Unplaced" area. Where a
  node sits on the Canvas is that view's own arrangement.
- Two windows or tabs of the Desk follow the same rules. If two changes to
  one card collide, the later one is kept and the other window says so.

## What Becomes A Card

1. **Plans.** Every plan in `docs/plans/` is one card. A plan is a Markdown
   file there whose first lines carry a valid status line (`Status: <state>
   (<date>): ...`, the format in that folder's rules). The state is one of
   Draft, Approved, In progress, Built, or Superseded by followed by one or
   more file names, as in the existing `Superseded by STATUS.md and PLAN.md
   (Oct 21)`. Everything from "Superseded by" up to the date counts as the
   Superseded state. The folder's own
   rules files, `AGENTS.md` and `CLAUDE.md`, are never cards. Any other file
   without a valid status line gets no card, and the snapshot names it in a
   "not read as a plan" list instead of failing or guessing a state. The
   word in the status line is the card's source status. It also sets the
   suggested placement only: Draft suggests Suggested, Approved suggests
   Planned, In progress suggests In progress, Built suggests Finished, and
   Superseded suggests retiring. A new plan gets its card with no one adding
   it by hand.
2. **Tasks.** When an agent in a session decides something is worth a task,
   that task becomes a card that links back to the session. If the agent
   thought it mattered enough to make a task, it is a card.
3. **Ideas.** An idea becomes a card in Suggested in one of four ways:
   - **Typed by the owner.** The Roadmap has an "Add idea" action. He types
     a title, and an outcome line if he wants, and gets an idea card with no
     source link.
   - **From an ideas document.** The first one is the owner's "True Convo
     Ideas: November 13, 2026", a private document outside this repo (a
     claude.ai Artifact), which he named on November 13 as the one he meant.
     It stays as it is. The Desk can't open it where it lives, so he brings
     it in by pasting its text or choosing an exported file. Each numbered
     entry becomes one idea card that keeps its section heading and its
     mark: "His idea" or "Suggestion (Claude)". A suggestion card says he
     hasn't approved it. Bringing the same document in again adds only
     entries that are new and never duplicates or moves a card. The
     document's text is his private material: it is never copied into this
     repo, and its cards stay on his device.
   - **From a conversation, by the agent in it.** When the participant in a
     Desk conversation recognises an idea, it records an idea card that
     links to the message, the same way it records a task. The conversation
     shows a line saying the card was made, with an undo.
   - **From a conversation, by the owner.** Every message has a "Make this
     an idea" action.

   The promise is that an idea recorded in one of these ways is a card. No
   separate model reads through past conversations looking for ideas the
   participant and the owner both let pass.
4. **Anything else, by hand.** Any session, file, decision or work item in
   the Desk has a "Create Roadmap item" action that makes a linked card.

## Cards That Retire

So the board doesn't fill with stale cards:

- A **task** or **idea** card nobody has touched for 30 days is retired
  (open question 2). Touching means the owner moved, opened or edited it, or
  its source changed.
- A **work** card follows the task and idea rule.
- Retiring is a change to the card itself, not to one view. A retired card
  leaves the Roadmap columns, the Navigator groups and the Canvas together
  and goes to one **Retired** list, reachable from every view. Nothing is
  deleted. One action brings it back, and it returns to the placement it
  had in each view.
- Restoring is the owner's own act, so it counts as touching the card and
  as placing it. The 30-day count starts again from the restore, and a
  restored card is treated from then on as one he placed: it never retires
  on its own again, whatever its source says. A restored plan card whose
  plan is still Superseded stays, with its "superseded" label. Later he can
  only be offered retirement, in a retire offer, and not before another
  full 30 quiet days or a new reason.
- A **plan** card the owner hasn't placed retires only when its plan is
  Superseded.
- A card the owner placed himself never retires on its own. It shows a
  "quiet for 30 days" mark instead, or for a plan card a "superseded"
  label, and "Where We Differ" offers to retire it in a card-level row
  (see "Retire offers" there).

## The Owner's Arrangement As A Signal

Every time the owner moves a card or changes a group, the Desk saves the move
with its time: which card, from where, to where. These moves are the signal.
They are kept on his device with the rest of the Desk's data.

The agents read:

- the current arrangement in both views;
- the history of his moves, including suggestions he accepted or undid.

They never change his arrangement. They write only their own suggested
placements and reasons.

## Where We Differ

A **Where we differ** list, reachable from every view, has one row for each
card in each view where the owner's placement and the agent's suggestion
disagree. The views that take part are the Roadmap and the Navigator. Canvas
doesn't, because it has no suggestions. A card that disagrees on the Roadmap
and in the Navigator has two rows, each naming its view. A row's actions and its saved rejection apply
to that view's placement only and never touch the card's placement in
another view. A row
says what he chose, what the agent suggests and why in one line, for example
"You have this in progress, but it depends on a plan that isn't approved."

Each row has three actions:

- **Keep mine** saves a rejection of that suggestion: the card, the
  placement suggested and the rule or reason behind it. The row leaves the
  list and his placement stays.
- **Take the suggestion** moves the card to the suggested placement and
  saves the move as his own. The row leaves the list.
- **Tell it why** does what Keep mine does and also saves his reason as a
  correction the agents read next time. This is how they learn from him. It
  uses the Desk's existing memory records and adds no new store.

**Retire offers** are a second kind of row, about the card and not about a
view. There is at most one per card. It says why ("quiet for 30 days", or
"its plan was superseded") and has two actions:

- **Retire** retires the card in the record, so it leaves every view at
  once and can be restored from the Retired list.
- **Keep** saves a rejection keyed by the card and the reason, and removes
  the row. No placement changes in any view. The offer returns only for a
  new reason, or after another full 30 quiet days.

Placement rows never retire a card, and a retire offer never moves one.

A rejected suggestion doesn't come back. A row for that card opens again
only when the suggestion is materially new (a different placement, or the
same placement for a different rule or reason) or when he moves the card
again and the new placement disagrees with a suggestion he hasn't rejected.

The first version makes its suggestions from fixed rules only: the "depends
on" links between cards (a card is suggested no further along than Planned
while a card it depends on isn't Finished), plan status, pull request state and how long a card has been
quiet. An agent adds its own reasoning in a later part, on the Mac's local
participant only. Card titles, ideas and the owner's corrections are his
private words, and no part of this plan sends them off his device.

## Asking The Owner What He Meant

The owner's direction (November 14, 2026): when something he did looks odd
or unexpected to the agent, the agent should ask what he meant by offering
possible readings and letting him pick, and "depends on" is the causal link
it should be reasoning about. This plan builds the asking. It doesn't yet
build the agent asking less as it gets better at guessing (see the end of
this section).

- **Readings to pick from.** When a rule in part 6, or the agent in part 7,
  finds one of his moves unexpected, the row in "Where We Differ" doesn't
  only say "we differ". It offers up to three short readings of what he may
  have meant, most likely first, plus "Something else", which opens the
  "Tell it why" box. For example, for a card moved to In progress while a
  card it depends on isn't finished: "The other card is done in practice",
  "This one doesn't really depend on it" or "I'm starting early on
  purpose". Picking a reading resolves the row as Keep mine does and saves
  the reading as a correction. Picking "This one doesn't really depend on
  it" also removes that link, because that is what he said.
- **Proposed links.** The agent may propose that one card depends on
  another, with a one-line reason. A proposal shows on the card as a dashed
  "proposed" link and as a row with **Accept** and **Dismiss**. Accept adds
  the link to the card's "depends on" list. Dismiss saves a rejection, and
  the same pair isn't proposed again. A proposed link has no effect on any
  suggestion until it is accepted. Part 6 proposes none, since fixed rules
  have nothing to go on. Part 7's local participant proposes them.
- **Keeping score.** For each kind of question (a placement, a retire
  offer, a proposed link, a set of readings), the Desk counts how often the
  agent's first reading or proposal was the one he chose. He can see the
  counts. They stay on his device.

**Not built here: asking less.** The owner's fuller idea is progressive
trust: the more often the agent reads him correctly on one kind of task,
the less it needs to ask before acting on similar ones. In this plan the
score changes nothing. The agent asks every time and never acts on a
guess. Turning the score into permission changes when an agent may act
without asking him, so it gets its own design note and plan, built on the
counts this plan collects.

## Parts

Each part is one pull request.

1. **The work record and plan cards.** The card type, its storage in the
   Desk, and a snapshot script that reads `docs/plans/` status lines into
   cards the way `rail-map-snapshot.mjs` reads git. The 13 hand-written
   cards move into the record with their IDs and current placement kept.
   The Desk's existing work items, which the board already shows as cards,
   keep showing in the same change: each one is carried into the record, or
   still projected from the workspace, with its ID and saved placement
   unchanged. Only then does the Roadmap board switch to reading the record.
   Part 3 adds new task cards and removes nothing part 1 kept.
2. **Idea and hand-made cards.** The "Add idea" action, the "Create Roadmap
   item" action, and bringing a pasted or exported ideas document in as
   cards.
3. **Task and idea cards from conversations.** Tasks from the Desk's own
   conversations become cards. So do ideas: the participant records an idea
   card linked to its message, and every message gets "Make this an idea"
   and "Make this a task".

   A participant can only tell the Desk it recorded something through an
   event, and the participant contract
   ([desk-native-participant-contract.md](../desk-native-participant-contract.md),
   section 8) has none for this today: its event types are `started`,
   `text`, `completed`, `stopped` and `failed`. So this part starts with a
   dated revision to that contract, in its own pull request, that adds two
   event types, one for a recorded task and one for a recorded idea. Each
   carries a title, belongs to the run's reply message, and carries an item
   ID that is unique within the session and never reused. Every task event
   also carries the task's resulting status, `open` or `done`. A later
   event about the same task carries the same item ID with the title and
   status as they now are, so a rename is the same ID and status with a new
   title, and finishing is the same ID with status `done`. A card is made
   only from one of these events. The Desk never reads a reply's text to
   guess that a task or idea was meant. Until a participant sends the
   events, the owner's two message actions are the way cards get made from
   a conversation.

   Claude Code sessions are part 8.
4. **Retirement.** The Retired list, the 30-day rule and the quiet mark.
5. **Navigator groups hold cards, and views stay in step.** The owner can
   put cards in his groups, the saved arrangement and move history become
   readable to agents, and the "Views Stay In Step" rules hold across the
   Roadmap, Navigator and Canvas, with Canvas showing cards as nodes.
6. **Where we differ.** Suggested placements from fixed rules, the list and
   its three actions, the readings to pick from, and the score.
7. **Agent reasoning.** The Mac's local participant adds suggestions,
   readings and proposed "depends on" links, and reads the owner's
   corrections. Nothing leaves the device.
8. **Cards from Claude Code sessions.** A task Claude creates in a session
   run through the Claude Code adapter becomes a task card linked to that
   session, and an idea it records becomes an idea card, under the same
   rules as part 3. The adapter plan
   ([claude-code-adapter.md](claude-code-adapter.md)) carries neither task
   events nor idea events in its session records today, so this part starts
   with a dated revision to that plan, in its own pull request, that adds
   both: a task event when Claude creates, renames or finishes a task, and an
   idea event when Claude records an idea. Every event carries an item ID
   that is unique within the session and never reused, and every later
   event about the same task carries the same one. Every task event carries
   the task's resulting status, `open` or `done`, and its current title. The
   cards stay on the owner's device like every other card that isn't a
   plan card.
   Part 8 can be built any time after part 3.

A Claude Code session started outside the app (for example in a plain
terminal) is not read by the adapter, so its tasks are not captured. The
owner can still add a card for it by hand. Covering those sessions needs its
own plan.

### What Produces The Events (Parts 3 And 8)

Both participants are plain text in and text out, and the Claude Code
adapter allows no tools ([claude-code-adapter.md](claude-code-adapter.md),
"In And Out"). That stays. The signal is a **record block**: a short block
in one fixed, documented format that the participant may put at the end of a
reply, with one line per task or idea giving its item ID, its kind, its title
and, for a task, its status.

The code that already receives the reply (native for the local participant,
the adapter for Claude) reads only that block. It checks every line against
the format, sends one event per valid line, and removes the block from the
reply the owner sees. Text outside the block never makes an event, whatever
it says.

The participant learns the format from a fixed instruction added to what it
is sent. For Claude, that instruction is part of the context shown to the
owner before Send, like the rest. Each revision (the contract's in part 3,
the adapter plan's in part 8) sets the exact format and the instruction's
wording, and each needs the owner's yes.

The promise is that a valid record block becomes cards. Whether a model
writes one for a given reply is up to the model, and the owner's message
actions cover what it leaves out.

## Requirements For The Code Pull Requests

- One record. No view stores a card's title, state or source on its own.
- The owner's placement and the agent's suggestion are separate values. No
  code path writes the owner's value except his own action.
- A change to a card shows in every open view whose filter includes it,
  without a reload. A browser test proves it across the Roadmap, Navigator
  and Canvas: a rename in one shows in the other two, and a retired card
  leaves the Canvas.
- The record is read through one interface that takes a filter and reports
  changes, so a later view such as Atlas can use it without changes to the
  record.
- Every card has exactly one kind: plan, task, idea or work. The 13
  carried-over cards, existing Desk work items and hand-made cards are kind
  work. Kind filters in every view include work, and a test proves no
  carried-over or hand-made card is dropped or given another kind.
- Rows and rejections are keyed by card and view. Acting on a card's
  Roadmap row leaves its Navigator placement, suggestion and row unchanged,
  and the reverse. A test covers one card that disagrees in both views.
- Keep mine and Tell it why save a rejection (card, view, suggested
  placement, rule or reason) and remove the row. The same suggestion never reopens it.
  A different placement or a different rule or reason may. Take the
  suggestion saves the move as the owner's. Tests cover all three actions
  and the reopen rule.
- Source status and stage are separate values. A snapshot never writes the
  owner's placement. A test moves a plan card to a column that differs from
  its status mapping, runs a new snapshot, and finds the card where the
  owner put it, with the differing source status shown.
- Bringing in an ideas document reads only text the owner pastes or a file
  he chooses, on his device. It makes no network call. Entries keep their
  "His idea" or "Suggestion" mark, and a second import of the same text
  creates no duplicate. Tests use an invented document.
- "Add idea" makes a card of kind idea in Suggested. "Create Roadmap item"
  makes a card of kind work. A test covers each and checks the kind.
- An idea card made from a conversation links to its message and can be
  undone from the conversation. The participant records it in the same turn,
  with no extra model call.
- Task and idea events are produced only by parsing a record block at the
  end of a reply, in parts 3 and 8 alike. No tool is added to either
  participant, and nothing is inferred from other reply text. A line that
  doesn't match the format makes no event and is counted. The block never
  shows in the reply the owner reads. The instruction that teaches the
  format is fixed text, and for Claude it is included in what the owner
  sees before Send. Tests cover a valid block, a block with one bad line
  (the good lines still count), a reply that discusses the format without a
  real block, and a block that is cut off mid-line.
- A participant's task or idea becomes a card only from the contract's
  task and idea events, added by the contract revision that opens part 3.
  Tests cover both: a run that sends the event gets one card linked to its
  message, a run whose reply only talks about a task or an idea gets none,
  and a repeated or malformed event creates no second card and breaks no
  run.
- Part 8 reads task events and idea events only from the adapter's own
  session records. It opens no other session files, makes no new model
  call, and adds no key, permission or outside host. A task event becomes a
  task card and an idea event becomes an idea card, each linked to its
  session. A task the session later marks done updates the card's source
  status and never the owner's placement. Tests cover both event kinds,
  with invented session records.
- Canvas has no agent suggestion and no "Where We Differ" rows. A test
  moves a Canvas node and finds no row created and no Roadmap or Navigator
  placement changed.
- A task or idea card from a session is identified by the session and the
  event's item ID, never by its title. An event with a known item ID updates
  that card. An event with a new one makes a new card. An event with no item
  ID is ignored and counted, and makes no card. Tests for parts 3 and 8
  cover two tasks with the same title (finishing one leaves the other
  untouched), a task renamed before it is finished (one card, updated), and
  a create event delivered twice (one card).
- Every task event states the resulting status, `open` or `done`. The card's
  source status comes only from that field, never from the title or from
  the order of events. A task event without a valid status is ignored and
  counted. Tests cover a rename (title changes, status stays open, the card
  stays in its column) and a finish (status becomes done, the suggested
  column becomes Finished, and a card the owner placed doesn't move).
- Every new card has a starting suggested column by its kind, as listed in
  "One Record, Several Views". A test creates one card of each kind by each
  route (plan snapshot, "Add idea", document import, message action,
  participant event, adapter event, "Create Roadmap item") and finds each
  one in a Roadmap column.
- A card's ID never changes, so a saved placement survives a rename.
- The change to the record loses no card and no placement. Every card the
  board shows before part 1 (the 13 hand-written ones and every existing
  Desk work item) shows after it, in the same column and position. A test
  proves it with a saved workspace and a saved placement from before the
  change that hold both kinds of ID.
- Plan discovery follows "What Becomes A Card". Tests cover `AGENTS.md`,
  `CLAUDE.md` and a file with no valid status line: none becomes a card,
  and the snapshot doesn't fail. Tests also cover each state, including the
  multiword `Superseded by STATUS.md and PLAN.md (Oct 21): ...` form, which
  must give a Superseded plan card. One test runs the snapshot over this
  repo's real `docs/plans/` and finds a card for every plan and an empty
  "not read as a plan" list.
- Only two sets of cards may be in the repo: plan cards, which are built
  from files already in it, and the 13 hand-written cards already committed
  in `recovery-roadmap.json`. Every other card stays on the owner's device:
  task cards, idea cards and work cards, whether carried over from an
  existing Desk work item or made by hand. That covers the whole card (its
  title, outcome, source link and output links) and everything saved about
  it (placements, move history, rejections and corrections). None of it is
  committed, written to a log or sent anywhere.
- The committed plan snapshot and the on-device cards are stored apart, so
  writing the snapshot can't include an on-device card. A test builds a
  record holding all four kinds, writes the snapshot, and finds only plan
  cards in it.
- Parts 1 to 6 make no network call beyond the ones the Rail Map snapshot
  already makes, and call no model. Part 7 runs on the local participant
  only. It sends no card text, placement, move history or correction to any
  off-device participant or service, and spends nothing. A test proves the
  part 7 code path can't select an off-device participant.
- Having a participant allowed for conversations is not permission to send
  it cards. Using an off-device participant for this reasoning is out of
  this plan. It would need its own plan that lists exactly what is sent and
  what is left out, and the owner's approval of that plan.
- Retiring never deletes. Restore puts a card back in its last placement in
  every view.
- A restored card is never retired automatically again. Tests restore a
  task card that was quiet for more than 30 days and a plan card whose plan
  is still Superseded, run the retirement pass again at once, and find both
  still in their columns with no retire offer.
- A proposed "depends on" link is stored apart from the card's list and
  joins it only on the owner's Accept. Until then no rule or suggestion
  uses it. A dismissed pair is not proposed again. Tests cover accept,
  dismiss and a proposal left unanswered.
- A row offers at most three readings plus "Something else". Picking one
  resolves the row and saves the reading as a correction, and only the
  "doesn't really depend on it" reading changes a card (it removes that one
  link). A test covers each.
- The score is counted on the device and shown to the owner. No code path
  uses it to skip a question, pick a reading for him or act without asking.
  A test sets a perfect score and finds the agent still asks.
- The dependency rule in part 6 reads only each card's "depends on" list.
  Part 1 carries the 13 cards' existing lists over unchanged, and part 6
  adds the owner's "Depends on" control. A test adds a dependency on an
  unfinished card and finds the suggestion and its row appear, then removes
  it and finds them gone. Another test finds no dependency created from a
  card's title or source text.
- Retiring is record-level. A retire offer is one card-level row, separate
  from the per-view placement rows. A test takes a retire offer on a card
  placed in the Roadmap and the Navigator and shown on the Canvas, finds it
  gone from all three and in the Retired list, restores it, and finds each
  view's placement as it was. A second test chooses Keep and finds no
  placement changed and no repeat offer for the same reason.
- Until the Desk's protected storage has passed its owner trial, nothing in
  this plan asks the owner to put real task, idea or work text into the
  Desk, and no part removes or weakens the Desk's "invented data only"
  notice. Importing the real ideas document and capturing tasks from real
  sessions (part 8) are used on real material only after that.
- Tests and samples use invented data only.

## Not In Scope

- Changing the Rail Map or the status feed.
- Atlas. It is a placeholder with no records, so connecting it belongs to
  the plan that builds it. That plan must read this record.
- New Canvas screens, and the thread map. This plan only makes the three
  existing views read one record and stay in step.
- Syncing cards between devices.
- Tasks from Claude Code sessions started outside the app.
- Importing cards or code from the old Cloudwork Nexus preview.
- Editing plans from the board. A plan's state changes only in its file.
- Business or marketing ideas, which stay out of this repo.
- Sending cards, placements or corrections to an off-device participant.
- Progressive trust: the agent asking less, or acting without asking, as
  its score rises. That needs its own design note and plan.

## When It Goes Wrong

1. **No connection.** Both views work from what is saved on the device. The
   plan snapshot shows the time it was last made. Nothing the owner arranged
   is lost.
2. **Interrupted.** Each move is saved when it happens. After a quit, crash
   or sleep, the next launch shows the last saved arrangement. A move that
   didn't finish saving is shown where it was before, with a line saying
   that the last move was not saved.
3. **Empty or first run.** The Roadmap shows the plan cards from the
   snapshot in their columns, marked "suggested". An empty column says what
   goes there. The Where we differ list says "Nothing to compare yet. Move a
   card to start."
4. **Denied or stuck.** No part asks for a permission or password. If the
   local participant in part 7 isn't installed or doesn't answer, the views keep
   working with the fixed-rule suggestions and say that agent suggestions
   are off.
5. **The error message.** If the record can't be read, the view says "Your
   cards couldn't be opened. The saved copy was kept. Reload to try again."
   If a save fails, it says "That move wasn't saved. Your earlier
   arrangement is still there." The board's existing warnings for saved
   placement stay.

## Finish Line

- A plan added to `docs/plans/` appears on the Roadmap after the next
  snapshot, with no one adding it by hand.
- An idea typed with "Add idea" appears as an idea card. An idea the
  participant records in a Desk conversation, a message the owner marks
  "Make this an idea" and a task made in a Desk conversation each appear as
  a card that links back to where it came from.
- A task Claude creates and an idea Claude records in a session run through
  the adapter each appear as a card linked to that session.
- A plan card the owner moved stays in his column after the plan's status
  line changes, and shows the new source status.
- The owner drags a card on the Roadmap and puts the same card in a
  Navigator group. Both survive a reload, and the card's title and state are
  the same in both views.
- With the Roadmap, Navigator and Canvas open, renaming a card in one
  changes it in the other two at once, and retiring it removes its Canvas
  node.
- A card left alone past the limit moves to Retired and comes back with one
  action.
- Where we differ lists a card he placed against a rule, with a plain
  reason, and each of its three actions does what it says.
- **Owner trial, in two steps.**
  1. **On invented data,** which is all the installed Desk may hold today
     (STATUS.md: "Until the owner's trial passes, the installed Desk is for
     invented data only"). He tries the Roadmap, Navigator and Canvas with
     sample cards, and each behavior in "When It Goes Wrong" is checked
     once. This step can run as soon as the parts are built.
  2. **On real work,** for a week, after which he says which view helped
     most. This step waits until the Desk's protected storage has passed its
     own owner trial and STATUS.md no longer limits the Desk to invented
     data. This plan adds no storage and doesn't lift that limit.

  The plan's status becomes Built only after step 2.

## Open Questions For The Owner

1. **The ideas document.** Answered November 13, 2026: it is your "True
   Convo Ideas: November 13, 2026" document. Still open: should a card made
   in the Desk be written back to that document? The Desk has no way to
   write to it today. Recommended: no for now, and decide after the trial.
2. **Retirement.** Is 30 days untouched the right limit for tasks and
   ideas? Recommended: yes, with cards you placed yourself never retiring.
3. **Agent reasoning.** This plan keeps part 7 on the Mac's local
   participant, so your task and idea wording never leaves your device. Is
   that enough for the trial? If you later want Claude to do this reasoning,
   that takes a separate plan saying exactly what would be sent, and your
   approval of it.
4. **Columns.** Keep the five the board has now (Suggested, Planned, In
   progress, Review & try, Finished)? The old Nexus preview had four, ending
   in Released. Recommended: keep the five.
