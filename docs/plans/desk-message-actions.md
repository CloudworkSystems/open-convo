# Desk Message Actions

Status: Draft (Nov 1): proposed, waiting on the owner's yes.

Written November 1, 2026 by a Claude session (project "261024 OC Steering")
at the owner's request that day: every message in a Desk conversation gets
its own actions, namely copy, thumbs up, thumbs down, reply, and reply in a
side chat. Session name: `OC-261101-desk-message-actions`. New Desk scope,
not one of the step 2 or step 3 trial findings. Builder: a Claude building
session. Reviewer: GrokBot as the independent reviewer (a fresh Claude
review after 60 minutes), plus Codex on every push. The coordinator checks
each pull request against this plan.

## Why

Today a reply in the Desk is a block of text with a Stop button and a
details row. The owner can't copy it in one step, can't say whether it was
good, and can't answer one particular message without retyping it. He also
wants the side-chat pattern other assistants now have: ask about one
message off to the side without adding to the main conversation.

Other assistant apps are a reference only (the owner shared screenshots of
one: a hover row with a reaction button, copy, and a "more" menu holding
quick reactions, "Copy message" and "Copy message as Markdown"). The design
below is our own.

## What The Owner Gets

A small row of actions under each message, shown when the pointer is over
the message or it has keyboard focus, and always shown under the latest
reply:

| Action | On his messages | On replies | What it does |
|---|---|---|---|
| Copy | Yes | Yes | Copies the message text exactly as saved. A short "Copied" confirms it. |
| Thumbs up / thumbs down | No | Yes | His rating of the reply. One at a time; pressing it again clears it. |
| React | Yes | Yes | A fixed set of six reactions (for example 👍 ❤️ 🎉 👀 ✅ ❓) to tag a message for himself. |
| Reply | Yes | Yes | Starts a new message in the main box that quotes this message. |
| Side chat | Yes | Yes | Opens a side panel with a separate chat about this one message. |

"Copy as Markdown" is left out for now: the Desk shows a reply's text
exactly as received, so plain copy and Markdown copy would give the same
text. It arrives with Markdown rendering, if the Desk ever renders it.

## Rules

1. **Ratings and reactions stay on this Mac.** They are the owner's own
   notes. Nothing sends them to Anthropic, Ollama or anyone else, and no
   model sees them as context. If the owner later wants a rating to reach a
   model maker, that is a separate decision with its own consent screen.
2. **Saved with the conversation, apart from the reply record.** Marks
   (rating, reactions) are saved in the Desk store next to the conversation,
   keyed by message id, never inside the saved run record, whose shape the
   participant contract fixes. Adding them needs no contract change. In the
   Mac app the protected store's checks and the shared fixtures learn the
   new field in the same pull request.
3. **Reply sends only what he sees.** Reply puts a visible quote block at
   the top of the draft (the quoted message, trimmed to a stated limit with
   "…" when longer). The quote is part of the message text, so the line
   above the message box ("Sends this message and N earlier turns to …")
   still tells the truth, and the input limit counts the quote. He can edit
   or delete the quote before Send.
4. **A side chat is its own conversation.** It is saved as a new session
   linked to the main one and to the message it is about. Its first message
   carries that one message as a visible quote, as in rule 3, and nothing
   else from the main conversation. It never adds turns to the main
   conversation's context. Its participant follows the same choice and
   availability rules as any conversation, and the line above its message
   box says where it goes.
5. **Every action works from the keyboard.** The row is reachable by Tab,
   each button has a plain label, and copy, rating and reaction changes are
   announced.
6. **Read-only and unsaved states.** While the Desk is read-only or a reply
   is still streaming, Copy works on what is shown; rating, reacting, Reply
   and Side chat wait until the reply has ended. A reply that is cut off or
   failed can still be copied and rated.
7. **Invented data only** until step 2's owner trial passes, as for the
   rest of the Desk.

## Proposed Pull Requests, In Order

1. **Plan** (this document).
2. **The action row, Copy, ratings and reactions.** The row on both the
   participant runs and the older simulated messages; a `messageMarks`
   record in the Desk store (message id, rating, reactions, updated time),
   with limits and checks on load; the Mac store's checks and the shared
   fixtures; unit and browser tests.
3. **Reply.** The quote block in the draft, its limit, its count against the
   input limit, and browser tests that the sent text is exactly what the box
   showed.
4. **Side chat.** A linked session (`sideOf`: parent session id and message
   id), the side panel with its own message box, the quote as its first
   message, its own participant line, and a way back to the message it came
   from. Side chats are listed under their parent, not as separate top-level
   conversations.

Each pull request updates STATUS.md.

## Later, Not In This Plan

- A side chat that also sees the main conversation's earlier turns. Today a
  local or Claude run can only take earlier turns from its own session
  (contract sections 20.3 and 21.2), so this needs a contract revision.
- A full emoji picker, ratings with a written reason, and Markdown copy.
- The same actions in the HUD.

## Finish Line

In the Desk (Start Desk, invented data) and in True Convo Test, the owner
can, on any message: copy it, rate a reply up or down, react, reply with a
quote, and open a side chat about it. Ratings and reactions are still there
after he quits and reopens, and a check shows nothing about them was sent
to any model.
