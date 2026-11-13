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
| Canvas and Atlas (Desk) | Built as Nexus views on sample data. The thin knowledge view reading real session records is a later step in PLAN.md. | They read the same record and follow the "Views Stay In Step" rules below. This plan adds no new Canvas or Atlas screens. |
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
- its kind: **plan**, **task** or **idea**;
- its source, as a link: the plan file, the session that created the task,
  or the document or conversation the idea came from;
- its **source status**, read from the source where the source has one
  (for a plan, the word in its status line). It is a fact about the source
  and is shown as a label on the card. It is not the card's Roadmap stage;
- when it was created and when it was last touched;
- links to outputs, such as a pull request.

Each view stores, per card and separately:

- **the owner's placement** (Roadmap column and position, Navigator group);
- **the agent's suggested placement**, with a one-line reason.

A suggestion never moves a card the owner has placed. A card the owner hasn't
placed sits where the agent suggests and is marked "suggested" until he moves
it or accepts it.

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
- Two windows or tabs of the Desk follow the same rules. If two changes to
  one card collide, the later one is kept and the other window says so.

## What Becomes A Card

1. **Plans.** Every plan in `docs/plans/` is one card. A plan is a Markdown
   file there whose first lines carry a valid status line (`Status: <word>
   (<date>): ...`, the format in that folder's rules). The folder's own
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
3. **Ideas.** An idea becomes a card in Suggested in one of three ways:
   - **From an ideas document.** The document can stay as it is. Each entry
     gets a card that links to its line, and a card made in the Desk can be
     written back to the document later (open question 1).
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
- Retired cards leave the columns and go to a **Retired** list in the same
  view. Nothing is deleted. One action brings a card back where it was.
- A **plan** card the owner hasn't placed retires only when its plan is
  Superseded.
- A card the owner placed himself never retires on its own. It shows a
  "quiet for 30 days" mark instead, or for a plan card a "superseded"
  label, and a row in "Where We Differ" offers to retire it.

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

A **Where we differ** list, reachable from both views, has one row for each
card where the owner's placement and the agent's suggestion disagree. A row
says what he chose, what the agent suggests and why in one line, for example
"You have this in progress, but it depends on a plan that isn't approved."

Each row has three actions: **Keep mine**, **Take the suggestion** and
**Tell it why**. A reason he gives is saved as a correction the agents read
next time. This is how they learn from him. It uses the Desk's existing
memory records and adds no new store.

The first version makes its suggestions from fixed rules only: dependencies
between cards, plan status, pull request state and how long a card has been
quiet. An agent adds its own reasoning in a later part, on the Mac's local
participant only. Card titles, ideas and the owner's corrections are his
private words, and no part of this plan sends them off his device.

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
2. **Idea and hand-made cards.** The "Create Roadmap item" action, and
   reading an ideas document into cards.
3. **Task and idea cards from conversations.** Tasks from the Desk's own
   conversations become cards. So do ideas: the participant records an idea
   card linked to its message, and every message gets "Make this an idea".
   Tasks and ideas from Claude Code sessions follow once the adapter's
   session records carry them.
4. **Retirement.** The Retired list, the 30-day rule and the quiet mark.
5. **Navigator groups hold cards, and views stay in step.** The owner can
   put cards in his groups, the saved arrangement and move history become
   readable to agents, and the "Views Stay In Step" rules hold across the
   Roadmap, Navigator, Canvas and Atlas.
6. **Where we differ.** Suggested placements from fixed rules, the list and
   its three actions.
7. **Agent reasoning.** The Mac's local participant adds suggestions and
   reads the owner's corrections. Nothing leaves the device.

## Requirements For The Code Pull Requests

- One record. No view stores a card's title, state or source on its own.
- The owner's placement and the agent's suggestion are separate values. No
  code path writes the owner's value except his own action.
- A change to a card shows in every open view whose filter includes it,
  without a reload. A browser test proves it with two views open.
- Source status and stage are separate values. A snapshot never writes the
  owner's placement. A test moves a plan card to a column that differs from
  its status mapping, runs a new snapshot, and finds the card where the
  owner put it, with the differing source status shown.
- An idea card made from a conversation links to its message and can be
  undone from the conversation. The participant records it in the same turn,
  with no extra model call.
- A card's ID never changes, so a saved placement survives a rename.
- The change to the record loses no card and no placement. Every card the
  board shows before part 1 (the 13 hand-written ones and every existing
  Desk work item) shows after it, in the same column and position. A test
  proves it with a saved workspace and a saved placement from before the
  change that hold both kinds of ID.
- Plan discovery follows "What Becomes A Card". Tests cover `AGENTS.md`,
  `CLAUDE.md` and a file with no valid status line: none becomes a card,
  and the snapshot doesn't fail.
- Plan cards are built from files in this repo and may be committed. Task
  and idea cards made in the Desk hold the owner's private words and stay on
  his device. They are never committed, logged or sent anywhere.
- Parts 1 to 6 make no network call beyond the ones the Rail Map snapshot
  already makes, and call no model. Part 7 runs on the local participant
  only. It sends no card text, placement, move history or correction to any
  off-device participant or service, and spends nothing. A test proves the
  part 7 code path can't select an off-device participant.
- Having a participant allowed for conversations is not permission to send
  it cards. Using an off-device participant for this reasoning is out of
  this plan. It would need its own plan that lists exactly what is sent and
  what is left out, and the owner's approval of that plan.
- Retiring never deletes. Restore puts a card back in its last column and
  position.
- Tests and samples use invented data only.

## Not In Scope

- Changing the Rail Map or the status feed.
- New Canvas or Atlas screens, and the thread map. This plan only makes the
  existing views read one record and stay in step.
- Syncing cards between devices.
- Importing cards or code from the old Cloudwork Nexus preview.
- Editing plans from the board. A plan's state changes only in its file.
- Business or marketing ideas, which stay out of this repo.
- Sending cards, placements or corrections to an off-device participant.

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
- An idea written in the Desk, an idea the participant records in a Desk
  conversation, a message the owner marks "Make this an idea" and a task
  made in a Desk conversation each appear as a card that links back to
  where it came from.
- A plan card the owner moved stays in his column after the plan's status
  line changes, and shows the new source status.
- The owner drags a card on the Roadmap and puts the same card in a
  Navigator group. Both survive a reload, and the card's title and state are
  the same in both views.
- With two views open, renaming or retiring a card in one changes it in the
  other at once.
- A card left alone past the limit moves to Retired and comes back with one
  action.
- Where we differ lists a card he placed against a rule, with a plain
  reason, and each of its three actions does what it says.
- **Owner trial:** he uses both views on real work for a week, says which
  one helped more, and each behavior in "When It Goes Wrong" is checked once.

## Open Questions For The Owner

1. **The ideas document.** This repo has `docs/plans/idea-harvest.md`, which
   is the process for harvesting ideas, but no file that lists ideas. Which
   document did you mean, and should cards made in the Desk be written back
   to it? Recommended: read it into cards first, and decide on writing back
   after the trial.
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
