# Claude Code Adapter: The Live Check And The Owner's Trial

Status: Draft (Nov 2): written for PR 5 of
[claude-code-adapter.md](claude-code-adapter.md); nothing in it has run yet.

Builder: the Claude building session ("Build the Claude Code adapter").
Reviewers: Codex, plus the independent review. Finish line: every check in
Part 2 and Part 3 passes on a True Convo Test build from `main`, with the
results written into this file, and STATUS.md marks step 5 done.

This is the last part of the Claude Code adapter (PR 5). Every safety proof
already ran against a fake Claude Code before PR 4b turned anything on. This
file is about the real thing: True Convo Test sending invented messages to
Claude through the real Claude Code on your Mac, with your Claude plan.

Use **invented conversations only**. The examples below are made up; use
them or invent your own. Nothing private goes in, and nothing from these
runs is pasted anywhere else.

## What Leaves The Mac

Each Claude reply sends that conversation's text (your message plus the
earlier turns shown in the line above the message box) to Anthropic through
Claude Code, under your Claude plan. Nothing else: no files, no tools, no
memory. Each run counts toward your plan's usage like any Claude Code
message. The app allows at most 5 runs per paid-usage confirmation; when it
asks again, check claude.ai and confirm again.

## Part 1: Before The Live Run (No Live Request)

The building session finishes these first. None of them sends anything to
Anthropic.

1. **Stop during a blocked save** (contract section 16, check 5). A test in
   the test build blocks the store's save in `fsync` while a reply is
   arriving, presses Stop, and checks that the run stops within the usual
   bound and the kept text is what was saved. Built in PR 5's code; it runs
   in CI with the fake Claude Code.
2. **The real quit path** (the contract's F0 answer 22). A test drives the
   app's real `NSApplication.terminate` during a reply and checks that the
   run ends as stopped and no Claude Code or supervisor is left. Built in
   PR 5's code. (Step 3's F11, a normal quit losing the text, is the same
   path for local models; it is fixed in its own thread first.)
3. **`claude auth status` sends nothing** (check 6). Already true by design:
   the sign-in check runs it with the network blocked by macOS, and its
   tests show the blocked services (PR 3b, #195). The live check doesn't
   add to that; it only needs the sign-in check to pass so Claude is
   available.
4. **Build.** A fresh True Convo Test build from `main` (the nightly build,
   or the building session makes one when you say "build").

## Part 2: The Live Check (The Building Session Watches)

You do the clicks; the building session checks your Mac through Remote
Control. It changes nothing in the app, and it never sees, stores or prints
your Claude sign-in. It uses three runs in the app.

Two rules hold throughout:

- **Body only.** Anything that catches what Claude Code sends reads the
  request body in memory and never writes, prints or keeps a header, since
  a signed-in Claude Code puts your sign-in in a header. It prints only
  "found" or "not found" for each canary word and for the message text, and
  answers every request with the same fixed error so nothing is retried.
- **The watcher is quiet while the app runs.** Remote Control is itself
  Claude Code and writes under `~/.claude` all the time, so it can't judge
  check 3 while it runs. The session starts a small watch script on your
  Mac, stops Remote Control, and the script does the watching during runs 1
  to 3. It keeps its notes on your Mac, outside `~/.claude`, and prints
  only differences, never the whole list (file names there include your
  folder names).

A reply alone can't prove a file was *not* sent: Claude need not repeat what
it received. So checks 2 and 7 are proven by catching what Claude Code sends
in step 0.

**Before you start.** The session checks that the pinned Claude Code file
(2.1.283) is still in place; if an update removed it, it stops. It puts an
invented `AGENTS.md` in True Convo Test's invented-data folder,
`~/Library/Application Support/com.trueconvo.voice-cursor.test/desk-invented-proof/`,
which is above the folder each run works in
(`desk-invented-proof/participants/<run>/`). Your own `AGENTS.md` in your
home folder stays where it is and serves as a second canary. It also puts a
made-up canary file at `/tmp/invented-canary`. Each invented file holds a
made-up canary word and a line asking any reader to end its reply with that
word. If Remote Control can't write in that folder, the session gives you
one Finder step.

0. **Catch what Claude Code sends** (checks 2 and 7; no live request). The
   session runs the same pinned Claude Code file, with the app's exact
   arguments and environment, from a scratch folder inside the app's
   `participants` folder, so every folder above it is the app's. The only
   change is that its requests go to a listener on this Mac (body only, as
   above), with all other network blocked by macOS, so nothing reaches
   Anthropic. It sends the two messages of runs 1 and 2 below. The caught
   bodies must hold the message text and **none** of the canary words, nor
   your home `AGENTS.md`'s text (matched on this Mac only, never copied
   out). This repeats the November 2 proof in the app's own folders. If any
   canary shows up, the trial stops before any live run.
0b. **Hand over to the watch script.** The session starts the script, then
   stops Remote Control. Once no Remote Control process is left, the script
   takes its first list of names and times under `~/.claude`, and from then
   on watches every half second. The session tells you in this thread when
   it's your turn.

1. **First run** (checks 1, 3 and 7). Open the Desk, start a new
   conversation, pick "Claude · … · Anthropic (not on this Mac)" (the
   model is Sonnet 5.5, your October 29 choice), and send: "I run an
   invented bakery called Maple Crumb. Suggest one name for a new muffin."
   Approve Anthropic when asked, then confirm paid usage is off when asked
   (check claude.ai Settings > Usage first). While the reply arrives, the
   script records:
   - Claude Code's arguments and environment from the process list, matched
     on the Mac against the contract's section 11: the variable names, and
     the values of the fixed ones only (never HOME, USER and the like), with
     no API key or proxy setting.
   - Every process Claude Code starts, checked every half second until the
     run ends: each must stay in Claude Code's process group. If any
     leaves, Claude stays unavailable and the trial stops.
   - The reply finishes. The app only keeps text once Claude Code's start
     line matches the recorded values and a usage message shows paid usage
     is off, so a finished reply proves both (check 1's init and rate-limit
     parts).
   - Any new or changed path under `~/.claude` is a failure of check 3.
     Nothing is excused: the script runs only while no Claude Code but the
     app's is running.
   - The reply holds no canary word (a second sign for check 7, after step
     0).
2. **Inert input** (check 2). In the same conversation, send exactly:
   "@/tmp/invented-canary /config What did I call my bakery?" The reply
   should answer about Maple Crumb, with no canary word and no settings
   screen (step 0 already showed the file's text isn't sent). Still nothing
   new under `~/.claude`.
3. **Kill the app mid-reply** (check 4). Send: "Write a long story about a
   muffin that travels the world." While it is still arriving, open
   Activity Monitor, select True Convo Test (check that its name says Test,
   not the real True Convo), and choose Force Quit from the stop button.
   Within 10 seconds the script should find no Claude Code and no
   supervisor left. Reopen the app: the reply is marked cut off with the
   text so far, and nothing was sent again.

   The other half of check 4, a kill during a Stop's wait, is proven with a
   fake Claude Code that ignores Stop, which a live run can't do on demand:
   `ParentDeathTests` "Killed during a Stop's wait" (the 10-second wait is cut
   to the 3-second bound, and nothing is left). PR 5 records that test's
   result on the build used here.

When you've done run 3, say "done" in this thread, and the session starts
Remote Control again. The script stops watching the moment it sees any
Claude Code that isn't the app's, so it can't mistake the session's own
files for the app's; every change it recorded before then counts. If it
stops before you've finished run 3, check 3 is unproven and Part 2 is done
again. Its half-second looks could miss something that appears and goes
between two looks; that's accepted because Claude Code has no tools here and
the start check fails closed, but it means this check is strong evidence,
not complete proof. The session reads the script's results (differences and
found/not found only), then deletes the canary files, the scratch folder,
the script and its notes, and stops Remote Control. If any check fails,
Claude stays out of daily use until it is fixed and the whole of Part 2
passes again.

## Part 3: Your Checklist

The trial outline from the plan, on invented text. Tick each one and write
down anything that surprises you. Labels may differ a little from what you
see; note it and carry on.

1. **The picker.** "Claude · … · Anthropic (not on this Mac)" is listed next to your local models.
2. **Approve Anthropic.** In a fresh install's first Claude send, the app
   asks you to approve Anthropic and shows what leaves. (Done in Part 2 if
   that was the first send; it shows as approved now.)
3. **Paid usage.** It asks you to confirm paid usage is off. Check claude.ai
   first.
4. **It remembers.** Send: "What muffin name did you suggest?" The answer
   matches the earlier suggestion.
5. **Switching models.** Start a new conversation with a local model, send
   one invented message, then pick Claude. Before you send, the line above
   the message box says how many earlier turns will go to Anthropic.
6. **Stop, quit and retry.** Press Stop during a long reply (it stays,
   marked stopped). Quit from the menu during a reply (marked stopped, text
   kept). Force quit during a reply (marked cut off, not sent again). On the
   cut-off reply, close the unfinished reply, press Retry: the message comes
   back into the box unsent, and only your Send starts a new reply.
7. **Lock the screen.** Lock and unlock your Mac. The paid-usage
   confirmation has ended, and the next send asks again.
8. **Signed out.** In Terminal, `claude auth logout` (sign in again after
   with `claude auth login`). The picker says Claude is signed out, Send does
   nothing, and nothing goes to a local model instead.

## When Something Is Wrong

Write down the check number and what you saw: a message, a missing reply, a
wrong label, a reply that came back twice. Send the number and a one-line
description to the building session. Don't paste the conversation into any
other app.

## When Every Check Passes

Step 5 is done, and Claude can join invented conversations in True Convo
Test. Real conversations still wait for steps 2 and 3's trials to pass (the
plan's safety model, item 7).
