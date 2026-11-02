# Desk Message Actions

Status: In progress (Nov 1): approved by the owner November 1, 2026; PR 2 (action row, Copy, ratings, reactions) merged as #224; PR 3 (Reply) merged as #245; PR 4 (Side chat) in review.

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
| Copy | Yes | Yes | Copies the message text exactly as shown, including any part not yet saved (rule 6). A short "Copied" confirms it. |
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
6. **Read-only and unsaved states.** Copy always works and copies exactly the text shown, saved or not: what is on screen is what the owner is copying.
   Rating, reacting, Reply and Side chat change what is saved, so each needs
   two things: the reply has ended, and the Desk can save (not read-only
   after a save conflict or an unknown or unavailable save). While the Desk
   is read-only they stay unavailable, with the reason shown, until saving
   recovers; a mark is never kept only in memory. A reply that is cut off
   or failed can still be copied and rated.
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

## Revision, November 1, 2026: Side Chat Opens In Place

PR 4 first planned a side panel beside the conversation. The Desk shows the
runs of one selected conversation at a time, so a panel would mean showing
two conversations' runs at once, a much larger change. The owner chose on
November 1, 2026, in the Claude thread "Add per-message actions to the
Desk", to open a side chat **in its place, with a back link**: the side chat
replaces the main conversation in the same view, a note at the top says
what message it is about (quoted), and "Back to the message" returns to the
main conversation at that message. Side chats are listed under their parent
in the sidebar, and each message lists links to its side chats. Rules 3, 4
and 6 are unchanged. This replaces the side panel named in the table under
"What The Owner Gets" and in PR 4 above; that wording stays as approved.

Every list of conversations (the sidebar, a folder's session list and the
Canvas) shows a side chat under the conversation it is about, and moving a
conversation to another folder moves its side chats with it.

### When It Goes Wrong (Side Chat)

The five questions of [when-it-goes-wrong.md](when-it-goes-wrong.md), for
the side chat screen:

1. **No connection.** Starting a side chat needs no connection: it is saved
   on the Mac with its quoted draft. Sending from it works like any
   conversation, so when its participant isn't available the line above the
   message box says so and the draft is kept.
2. **Interrupted.** The side chat and its draft are saved when it is
   created. After a quit, crash or sleep it is still listed under its
   parent with the quote in its draft. A reply cut off inside it is handled
   like a reply cut off in any conversation.
3. **Empty or first run.** A new side chat opens with the note "Side chat
   about a message in …", the quoted message, and the quote already in its
   message box, so the first step is to type a question and send. If the
   message it is about is gone, the note says "That message is no longer
   shown." and the side chat still works.
4. **Denied or stuck.** There is no prompt to refuse. "Back to the message"
   always returns to the main conversation; if that message is gone, it
   lands at the conversation. If the main conversation itself is gone, the
   side chat is listed on its own. While the Desk can't save, Side chat is
   off with the reason shown, and the owner can still read and go back.
5. **The error message.** The only new message is that reason, shared with
   the other actions and shown on the button: "Rating, reacting, Reply and
   Side chat are off until saving works again." A side chat started from a
   reply still being written is refused the same way: "Wait until this
   reply has ended to rate, react or reply to it."


**Owner trial checks** (added to the Desk trial for this feature):

- Start a side chat from a reply; the note, the quote and the quoted draft
  show, and it is listed under its conversation.
- Quit and reopen the Desk; the side chat and its draft are still there.
- Use "Back to the message"; the main conversation opens at that message.
- Move the main conversation to another folder; its side chats move too.
- While saving is blocked, Side chat is off and says why; going back works.

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
