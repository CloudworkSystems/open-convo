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
   the sign-in check runs it with the network blocked by macOS (PR 3b,
   #195). Part 2 rechecks that the check still passes on your Mac.
4. **Build.** A fresh True Convo Test build from `main` (the nightly build,
   or the building session makes one when you say "build").

## Part 2: The Live Check (The Building Session Watches)

You do the clicks; the building session watches your Mac through Remote
Control and runs read-only checks beside the app. It changes nothing in the
app, and it never sees your Claude sign-in. It uses three runs.

**Before you start.** The session saves a list of file names and times
under `~/.claude` (names only, never contents), and puts an invented
`AGENTS.md` with a made-up canary line in True Convo Test's invented-data
folder, `~/Library/Application Support/com.trueconvo.voice-cursor.test/desk-invented-proof/`,
the folder above the one each run works in. Your own `AGENTS.md` in your
home folder stays where it is and serves as a second canary. If Remote
Control can't write in that folder, the session gives you one Finder step.

1. **First run** (checks 1, 3 and 7). Open the Desk, start a new
   conversation, pick "Claude · … · Anthropic (not on this Mac)" (the
   model is Sonnet 5.5, your October 29 choice), and send: "I run an invented bakery called Maple Crumb. Suggest one
   name for a new muffin." Approve Anthropic when asked, then confirm paid
   usage is off when asked (check claude.ai Settings > Usage first). While
   the reply arrives, the session checks:
   - Claude Code's arguments and environment match the contract's section
     11 exactly (from the process list), with no API key or proxy setting.
   - Every process Claude Code starts stays in its process group, checked
     every half second until the run ends. If any leaves, Claude stays
     unavailable and the trial stops.
   - The reply finishes. The app only keeps text once Claude Code's start
     line matches the recorded values and a usage message shows paid usage
     is off, so a finished reply proves both (check 1's init and rate-limit
     parts).
   - Afterwards: nothing new under `~/.claude` (check 3), and the reply
     names neither canary (check 7). The session also reads the app's own
     log lines, which hold run ids and reasons, never text.
2. **Inert input** (check 2). In the same conversation, send exactly:
   "@/tmp/invented-canary /config What did I call my bakery?" The session
   first puts a made-up canary line in `/tmp/invented-canary`. The reply
   should answer about Maple Crumb and should not contain the canary line or
   any settings screen. Nothing new under `~/.claude` again.
3. **Kill the app mid-reply** (check 4). Send: "Write a long story about a
   muffin that travels the world." While it is still arriving, the session
   sends `kill -9` to True Convo Test. Within 10 seconds there should be no
   Claude Code and no supervisor left. Reopen the app: the reply is marked
   cut off with the text so far, and nothing was sent again.

Then the session deletes both canary files and its file list, and stops
Remote Control. If any check fails, Claude stays out of daily use until it
is fixed and the whole of Part 2 passes again.

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
