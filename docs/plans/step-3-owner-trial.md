# Step 3: The Owner's Trial

Status: In progress (Nov 1): first trial run done. Eight checks passed; quit
mid-reply (8) failed and crash recovery (10, 11) fell short. Waiting on fixes
F11 and F12, then a re-check of 8, 10 and 11.

The last part of step 3 (PR 5). The scripted proof checks the local route
with a fake Ollama and a test store. This trial checks the real True Convo
Test app talking to the real Ollama on your Mac.

Use **invented conversations only** until step 2's trial has passed. The
examples below are all made up; use them or invent your own.

Written before PR 4 was finished, so a label or button name may differ a
little from what you see. If it does, note it and carry on.

## Before You Start

- Install the newest True Convo Test build (the building session makes it
  when you say "build").
- Make sure Ollama is running (its llama icon is in the menu bar).
- Open the Desk and start a new conversation.

## The Trial

Tick each one. Write down anything that surprises you.

1. **Pick the model.** Open the model picker. You should see your local
   models labeled "Local · <model> · stays on this Mac", with `qwen3:8b`
   chosen by default (your choice on October 16, recorded in
   [docs/decisions.md](../decisions.md)). If `qwen3:8b` isn't installed,
   pick any local model and note it. Cloud models should say
   "Cloud · … · not on this Mac (can't be used)" and stay greyed out.
2. **Check who receives what.** Before you press Send, the label above the
   conversation should name the model and say it stays on this Mac.
3. **First message.** Send: "I run an invented bakery called Maple Crumb.
   Suggest one name for a new muffin." The reply should appear as it is
   written, word by word, not all at once at the end.
4. **It remembers.** Send: "What is my bakery called?" The answer should say
   Maple Crumb. That shows the earlier turn went along with the new message.
5. **Stop.** Send: "Write a long story about a muffin that travels the
   world." Press Stop partway through. The text so far should stay, marked as
   stopped.
6. **Quit and reopen.** Quit True Convo Test (its menu, Quit). Open it again
   and go back to the conversation. Every message and reply should still be
   there.
7. **Continue.** Send: "Remind me what muffin name you suggested." The
   answer should match the earlier suggestion, without you retelling it.
8. **Quit while it's writing.** Send a message that needs a long answer and
   quit True Convo Test from its menu while the reply is still coming in.
   Reopen. That reply should be marked as stopped on this Mac, with the text
   so far kept, and it should not have been sent again.
9. **Ollama closed.** Quit Ollama from its menu bar icon. The picker should
   say Ollama isn't running, and Send should do nothing. Nothing should be
   sent anywhere else. Open Ollama again; the models should come back.
10. **Crash while it's writing.** Send another message that needs a long
    answer. While the reply is still coming in, force quit True Convo Test
    (Option-Command-Escape, pick True Convo Test, Force Quit). Reopen. That
    reply should be marked as cut off, and it should **not** have been sent
    again on its own.
11. **Retry the cut-off reply.** On that cut-off reply, press Retry. The
    message should come back into the message box without being sent. Press
    Send yourself. A new reply should start; the cut-off one stays as it was.

## When Something Is Wrong

Write down the step number and what you saw: a message, a missing reply, a
wrong label, a reply that came back twice. Don't paste the conversation into
any other app. Send the step number and a one-line description to the
building session.

## When Every Step Passes

Step 3 is done. Once step 2's trial has also passed, you can hold real
conversations with a local model. The Claude Code adapter comes next, so
Claude can join the same conversations.

## First Trial Run (October 31, 2026)

Build: True Convo Test from commit 544432b on a Mac Studio, with Ollama
0.40.13 (it updated itself at a restart) and `qwen3:8b`. Invented chats only:
the Maple Crumb bakery prompts above, in a fresh session. Because the app's
menu couldn't be opened (step 2 findings F2 and F3), quit used `osascript -e
'tell application "True Convo Test" to quit'` and force quit used `killall
-KILL "True Convo Test"`.

| Check | Result |
| --- | --- |
| 1. Pick the model | Passed |
| 2. Who receives what | Passed |
| 3. First message | Passed (streams, but too fast to watch: F7) |
| 4. It remembers | Passed |
| 5. Stop | Passed ("Stopped on this Mac. The reply so far is kept.") |
| 6. Quit and reopen | Passed |
| 7. Continue | Passed (recalled the suggested name) |
| 8. Quit while it's writing | **Failed** (F11) |
| 9. Ollama closed | Passed (typed text stayed unsent in the box) |
| 10. Crash while it's writing | **Partly passed** (F12) |
| 11. Retry the cut-off reply | **Blocked** (F12) |

Nothing was ever sent again on its own, and nothing went anywhere but the
local model.

Step 3 stays open until F11 and F12 are fixed; then the owner repeats checks
8, 10 and 11 on a fresh build.

### Findings

Numbered after step 2's F1 to F6.

- **F7. The reply area is narrow.** Much of the window is unused, long lines
  run off the right edge, and replies stream too fast to watch.
- **F8. Send and Stop are oversized.**
- **F9. Raw Markdown.** Replies print `**bold**` asterisks instead of bold.
- **F10. Closed.** The stopped mark is there, as a status line above the
  reply's text, which at first read as if it came before the reply.
- **F11. A normal quit mid-reply loses the text.** Twice, quitting while a
  reply was streaming (once with several paragraphs on screen) reopened as
  "Reply cut off. The text so far is kept." with "Some response updates
  could not be verified. The retained response is incomplete." and no text.
  Expected: "stopped on this Mac" with the text so far. The quit was a normal
  quit Apple event, which should match the menu's Quit; the builder should
  confirm.
- **F12. After a crash the reply is left open, with no Retry.** A force quit
  mid-reply kept the text so far, but the reply showed "Where it runs", a red
  "Some response updates have not arrived. Check this run to recover the
  missing updates; the received prefix is retained." and the buttons "Check
  run status" and "Close as unknown". "Check run status" changed it to "Run
  status unknown" with a live Stop; Stop changed to "retry stop". No Retry
  ever appeared. The wording (run, prefix, participant, unknown) is for
  engineers; the owner expects a plain "cut off" mark and Retry.
