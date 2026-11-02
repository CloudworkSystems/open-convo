# Step 3: The Owner's Trial

Status: In progress (Nov 2): first trial run done. Ten checks passed; quit
mid-reply (8) failed. The F11 fix is built (see "F11 Fix Built" below);
waiting on a re-check of check 8.

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
| 10. Crash while it's writing | Passed (text kept, not resent; wording: F12) |
| 11. Retry the cut-off reply | Passed, after **Close as unknown** (F12) |

Nothing was ever sent again on its own, and nothing went anywhere but the
local model.

Step 3 stays open until F11 is fixed; then the owner repeats check 8 on a
fresh build. F12 is a wording change and doesn't block the re-check.

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
- **F12. Crash recovery is correct but unclear.** A force quit mid-reply
  kept the text so far and nothing was resent. The reply then showed a red
  "Some response updates have not arrived. Check this run to recover the
  missing updates; the received prefix is retained." with the buttons "Check
  run status" and "Close as unknown". By design (step 3 plan, the
  kill-mid-reply proof), Retry appears only after **Close as unknown**. The
  trial first tried "Check run status" (it became "Run status unknown" with a
  live Stop) and Stop (it became "retry stop"); neither shows Retry. After
  Close as unknown, Retry put the message back in the box unsent, and Send
  started a new reply that finished. The fix is wording, not behavior: plain
  words instead of run, prefix, participant and unknown, and a line saying to
  close the unfinished reply before Retry. The checklist's check 10 should
  name that step too.

### F11 Fix Built (November 2, 2026)

Built by Claude in thread "Fix trial issues so Patrick can dogfood".

**What the Mac's log showed.** Both October 31 quits mid-reply logged that a
reply was still owed (`desk.terminate.participants owed=true limit=17s`) and
that the page held unsaved work (`desk.terminate.not-asked
page=unsaved-work`), then closed the Desk in the same second. The page saves
a reply's text on a timer, and the quit also ends the Mac's pushes to the
page, so the stop never reached it. The text since the last save was lost,
and the reopened reply was marked cut off. The quit was an ordinary quit
(`osascript`), which takes the same path as the menu's Quit once the owner
has answered its question.

**The fix.**
- When the Mac asks the page whether it holds unsaved work (it does so on
  every quit), the page saves every reply's text so far at once, instead of
  waiting for its next timed save.
- While a reply is owed and the page says it holds unsaved work, the quit
  waits for the page to confirm those saves landed (the page marks the
  Desk while they are under way) before closing the Desk, for at most ten
  seconds and inside the existing 17-second limit. The log says how it
  ended: `desk.terminate.save-wait outcome=saved`, `outcome=no-answer` or
  `outcome=limit`. After the menu's Quit, the page is asked once more at
  that point, because only then has the last of the reply arrived.
- On reopen, the Mac's record of the stop comes right after the saved text,
  so the reply reads "Stopped on this Mac. The reply so far is kept.", with
  that text, and Retry only refills the message box. If a few words reached
  the Mac after its pushes ended but before the stop took hold, they can't
  be shown; the reply then reads "Reply cut off. The text so far is kept."
  with everything before them.

A Desk browser test plays the whole sequence (text after the last timed
save, the Mac's question, the saving mark clearing, reopen) and fails
without the fix. Mac tests check that the Desk closes only after the page
says its save landed, that a page that never finishes or can't say holds
the quit no longer than the limit, and that a quit with nothing owed or a
clean page never waits.

Re-check: check 8 on a fresh True Convo Test build, quitting both from the
menu and with `osascript -e 'tell application "True Convo Test" to quit'`.
The run log should show `desk.terminate.save-wait outcome=saved` before
`desk.closed`.
