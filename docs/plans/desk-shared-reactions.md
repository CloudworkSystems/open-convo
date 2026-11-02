# Desk Shared Reactions

Status: In progress (Nov 2, 2026): approved by the owner November 2, 2026 (#249); PR 2 (agents see his reactions) merged (#250); PR 3 (agents react back) in review.

Written November 2, 2026 by a Claude building session (thread "Add per-message
actions to the Desk") at the owner's request. On November 1, 2026 he asked:
"Can other agents see the emojis and interpret them to determine the user's
intent, emotion, interpretation, and so forth? And can they use emojis in the
same way to express similar to the user?" On the decision card that followed
he chose "Yes, write a follow-up plan": agents see his reactions in that chat,
with a line saying so, and can react back. Session name:
`OC-261102-desk-shared-reactions`. Builder: a Claude building session.
Reviewer: GrokBot as the independent reviewer (a fresh Claude review after 60
minutes), plus Codex on every push. The coordinator checks each pull request
against this plan.

## Why

Today his reactions are private notes. Rule 1 of
[desk-message-actions.md](desk-message-actions.md) keeps every rating and
reaction on the Mac, and no model sees them. A 👍, ❓ or 😕 on a reply is
often the quickest way to say "yes, that", "I don't follow" or "that missed",
and he wants the agent to take that in. He also wants the agent to answer in
kind, with a reaction on his message instead of only words.

## What The Owner Gets

- **A switch per conversation: "Share my reactions with <participant> in
  this chat."** It sits with the participant line above the message box. It
  is off in every conversation until he turns it on, so nothing he reacted
  to before this plan is shared without his choosing. It is a choice for
  that one participant: when he picks a different participant for the
  conversation (another local model, or Claude instead of a local model),
  the switch turns itself off, the reactions note is removed as when he
  turns it off, and the Desk says "Sharing reactions is off because the
  participant changed." When it is on, the
  line above the message box says so: "Your reactions in this chat go to
  Claude (Anthropic) with your next message." or, for a local model, "...
  go to <model> on this Mac with your next message."
- **His reactions travel with his next message, visibly.** When he reacts to
  a message in a chat where the switch is on, a short note appears at the
  top of his draft, like the Reply quote: for example
  `[My reactions: 👍 ❓ on your reply "Here is the plan for…"]`. It names
  the emoji and the start of the message they are on. He can edit or delete
  the note before Send. Nothing is sent when he reacts; the note goes only
  when he presses Send, as part of the message.
- **The agent can react back.** With the switch on, the note ends with one
  plain sentence telling the agent how: "You can react to this message by
  starting your reply with a line like `Reaction: 👍`." When a reply starts
  with that line and one standard emoji, the Desk shows the emoji as the
  agent's reaction on his message (a chip labelled with the participant, for
  example "Claude reacted 🎉") and shows the rest of the reply as the text.

Ratings (thumbs up and down) stay private. Only reactions, the quick six and
the full emoji set, are shared, and only in a chat where he turned the
switch on.

## Rules

1. **Rule 1 of desk-message-actions.md changes only for reactions, only in a
   chat whose switch is on, and only through the message he sends.** Ratings
   and every chat with the switch off stay as rule 1 says. The Desk never
   sends a reaction on its own, never starts a run because of one, and never
   sends reactions from another conversation (a side chat is its own
   conversation with its own switch).
2. **He sees exactly what goes.** The note is ordinary draft text, counted
   in the input limit and in the line above the box, as the Reply quote is
   (rule 3 of desk-message-actions.md). What leaves the Mac is what the box
   showed. No hidden prompt, no system message, and no change to the
   participant contract: the note is part of `inputChunks`.
3. **The note follows his reactions until he edits it.** Adding or removing
   a reaction updates the note; once he types inside the note, the Desk
   stops changing it and says so ("You edited the reactions note, so new
   reactions won't be added to it."). Sending clears the list, so each
   reaction is shared once.
4. **An agent reaction is shown, not stored.** It is read from the saved
   reply text each time the reply is shown; nothing new is saved and the
   run record keeps the reply exactly as received. Copy copies the text as
   shown, without the reaction line. Only a first line of the exact form
   `Reaction: <one standard emoji>` counts; anything else is left as text.
   The line is read only once it is complete (a line break arrived or the
   reply ended), so a reply that is cut off shows what arrived as text.
5. **The switch is saved with the conversation** in the Desk store, off by
   default, together with the exact participant it was turned on for, and
   checked on load (refused, not repaired, when malformed). It counts as on
   only while that stored participant equals the conversation's current
   participant choice; any change of participant turns it off. It
   needs the same save rules as the other marks: while the Desk can't save,
   the switch is off with the shared reason, and the note isn't changed.
6. **Every part works from the keyboard,** with plain labels, and changes are
   announced (the switch, the note being added or updated, an agent
   reaction arriving).
7. **Invented data only** until step 2's owner trial passes, as for the rest
   of the Desk.
8. **Off means off.** Turning the switch off, or a participant change
   turning it off, removes the whole reactions note from the draft, edited
   or not. The note is the block that starts with `[My reactions:` at the
   top of the draft and runs to its closing `]`. If a draft still holds that
   marker while the switch is off (for example the closing bracket was
   deleted, so the block can't be found whole), Send is held with the reason
   "This draft still has a reactions note. Delete it or turn sharing back
   on." and nothing is sent.
9. **A sent note is part of that message, and earlier turns say so.** Once
   sent, a note is part of that run's message, so it follows the Desk's
   existing rule for earlier turns: a later run in the same conversation,
   to any participant, may carry it as context, and only when the line
   above the box counts that turn. When any earlier turn the next Send would
   carry holds a reactions note, and the switch isn't on for this
   participant, the Desk leaves those turns out of the context and the line
   above the box says so, for example "2 earlier turns with reactions you
   shared are left out, because sharing is off for Claude." Turning the
   switch on for this participant brings them back, counted in the line.
   So reactions never reach a participant he didn't turn sharing on for,
   not even as history.

## Proposed Pull Requests, In Order

1. **Plan** (this document).
2. **Agents see his reactions.** The per-conversation switch and its saved
   field (with the participant it was turned on for, off on any participant
   change), the off-means-off removal and Send hold of rule 8, the line above the box, the reactions note in the draft (added,
   updated, frozen once edited, cleared on Send), unit tests for the note
   text and limits, and browser tests that the sent text is exactly what the
   box showed, that nothing is sent with the switch off (edited note
   included), that a participant change turns the switch off, and that
   earlier turns holding a note are left out of a new participant's
   context (rule 9).
3. **Agents react back.** The instruction sentence in the note, reading a
   first `Reaction:` line from the reply, the agent reaction chip, Copy
   without the line, and tests for complete, cut-off and malformed lines.

Each pull request updates STATUS.md.

## When It Goes Wrong

The five questions of [when-it-goes-wrong.md](when-it-goes-wrong.md):

1. **No connection.** The note is part of his message, so it follows the
   message: if Send fails or the participant is unavailable, the draft,
   note included, stays in the box as today, and the reactions are still
   listed as not yet shared.
2. **Interrupted.** The note is saved with the draft, so after a quit or
   crash it is still there. A reply cut off before its first line ends
   shows what arrived as text and no agent reaction.
3. **Empty or first run.** The switch is off in every conversation at first,
   and the line above the box says nothing about reactions until he turns it
   on. With the switch on and no reactions yet, there is no note.
4. **Denied or stuck.** There is no prompt. If he deletes the note, nothing
   about reactions is sent with that message and the Desk doesn't add it
   back until he reacts again. Turning the switch off, or changing the
   participant, removes the note from the draft, edited or not (rule 8).
5. **The error message.** While saving is blocked, the switch is off with
   the shared reason ("Rating, reacting, Reply and Side chat are off until
   saving works again."). A reply whose first line looks like a reaction but
   isn't one standard emoji is shown as plain text, with no error.

**Owner trial checks:** turn the switch on and see the line above the box
change; react and see the note appear; edit the note and see that a new
reaction no longer changes it; send and see the agent answer the reaction;
see an agent reaction chip on his message; quit and reopen with an unsent
note and see it kept; turn the switch off and see the note go away, both
unedited and after editing it; share a reaction with a local model, switch the
chat to Claude, and see the earlier turn with the note left out of what is
sent until he turns sharing on for Claude; with the switch on for a local model, pick
Claude and see the switch turn off and the note go away; delete the note's
closing bracket, turn the switch off, and see Send held with the reason;
confirm a chat with the switch off sends no note.

## Later, Not In This Plan

- Sharing ratings, or a rating with a written reason.
- Agent reactions on messages other than the one being answered.
- The Prime Agent or other agents outside a Desk conversation seeing
  reactions.

## Finish Line

In the Desk (Start Desk, invented data) and in True Convo Test, in a chat
with the switch on, the owner reacts to a reply, sees the note in his draft,
sends it, and the agent's answer takes the reaction into account and can
carry its own reaction, shown on his message. In a chat with the switch off,
a check shows no reaction reached any model.
