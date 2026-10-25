# Claude Code Adapter Scope: Claude Joins The Conversation

Status: Approved (Oct 23): scope merged (#75); building starts after step 3 (see STATUS.md).

Written October 19, 2026 by a building session. A proposal: the owner and
the planning session can change it. PLAN.md is the authority. It comes
"right after step 3" (owner decision, October 15) and has no step number of
its own; PLAN.md's step 4 is clarity tools.

## What It Is

Why: step 3 gives the owner a private conversation with a local model.
Some questions need a stronger model, and the owner already pays for a
Claude plan. This adapter lets Claude answer in the same Desk conversation,
on that plan, with no API key and no paid extra usage.

How: True Convo runs the Claude Code command-line tool (the CLI) on the Mac,
the same way it talks to Ollama in step 3. The Desk sends the message, the
reply streams into the saved conversation, and Stop, quit, crash and Retry
behave exactly as they do for the local model. The difference the owner
must always see: **the conversation leaves the Mac and goes to Anthropic.**

Most of the machinery already exists, reviewed but switched off: the
participant lane (`ParticipantProcess`, the supervisor helper, the pinned
command line in contract section 11, the local checks in section 5 and the
paid-usage confirmation in section 17). This step finishes the open items,
adds conversation context and the consent screens, and turns it on in True
Convo Test.

## Finish Line

In True Convo Test, with invented conversations, the owner picks
"Claude · not on this Mac", approves sending once, holds a conversation that
remembers earlier turns, and sees Stop, quit, crash and Retry behave as they
do for the local model. The real True Convo app is unchanged.

## In And Out

**In:**

- Claude Code on the owner's own Claude plan login, one pinned CLI version.
- Plain conversation: text in, text out. No tools.
- Earlier turns of the same conversation sent as context (local or Claude
  turns), shown before Send.
- The picker entry, the one-time approval, the per-launch paid-usage
  confirmation, and the same lifecycle as step 3.
- True Convo Test only.

**Out:**

- Other cloud agents or models (Codex, ChatGPT, OpenRouter, Grok, Muse,
  Ollama's `:cloud` models). They follow the adapter order in
  `docs/design-notes/agent-profiles-and-adapters.md`.
- Claude through Pi or API credits (step 6).
- Any tool that reads, writes or runs anything: files, shell, web, MCP
  servers, slash commands, skills, plugins, hooks.
- Claude Code sessions saved by the CLI (`--no-session-persistence` stays).
- Attachments, images, dictation straight to Claude, memory (step 5), the
  "Wait—what?" explainer (it stays local, October 13 decision).
- Automatic model choice (step 6) and any fallback between models.
- The real True Convo app, other users, and anything shipped.

## The Safety Model

1. **What leaves the Mac, and when.** Only on the owner's Send: the new
   message and the earlier turns listed above the composer, through the
   CLI, to Anthropic. Nothing on availability checks (they run the CLI only
   for `--version`; see question 2 for `auth status`). Nothing on
   dictation, lock or quit. The picker says "Claude · <model> · Anthropic
   (not on this Mac)", never "stays on this Mac". Above the composer:
   "Sends this message and N earlier turns to Anthropic."
2. **Owner consent before the first send.** Two gates, both in the app's
   own window, never the page:
   - *Approve Anthropic once* (foundations principle 6): a screen showing
     what leaves (messages and earlier turns), where (Anthropic, through
     Claude Code on your plan) and what doesn't (files, other
     conversations, memory). Saved in the protected store; revocable.
   - *Paid usage off, each launch* (contract section 17, unchanged): the
     owner checks claude.ai Settings > Usage, then confirms with the Mac
     password dialog. Held in memory only; ends on quit, lock, sleep or a
     login change.
   Neither gate is ever passed by the page or by an agent.
3. **How the CLI is found and launched.** Exactly one pinned file,
   `<home>/.local/share/claude/versions/<pinned version>`, home taken from
   the user database, never `$HOME`, `PATH` or the `~/.local/bin/claude`
   link. Ownership and permission checks as section 5. Launched with
   `posix_spawn` through the bundled supervisor, an argument list, never a
   shell string. Fixed environment allow-list (section 11): no inherited
   keys, proxies or base URLs reach it.
4. **Permissions and tools.** None. The run keeps section 11's
   `--safe-mode --restricted --disable-slash-commands --tools ""
   --strict-mcp-config`, and the init check fails the run if the CLI reports
   any tool or MCP server. Why: a tool that reads a file sends that file to
   Anthropic, and one that writes or runs things acts on the Mac without an
   approval card. A conversation needs neither. Tools come later, one
   approved pass at a time (foundations, Agents).
5. **Working folder.** Each run starts in a fresh, empty, app-owned folder
   (mode 0700), removed afterwards, so there is nothing for it to see. This
   is a starting point, not a sandbox: with no tools there is nothing to
   contain, so the plan doesn't claim one (principle 12).
6. **Credentials.** They stay in Claude Code's own login and its own
   Keychain item. True Convo never reads, copies, stores or logs them, and
   refuses to run when it sees an API key, key helper, other provider or
   base URL (`provider-override`). Logs hold ids, event types, byte counts
   and fixed reasons only, never text or account fields.
7. **Invented data only** until two trials have passed: step 2's trial
   and this adapter's own owner trial. After both, a real conversation goes
   to Claude only when the owner picks Claude in that conversation
   (question 6). (Codex P1 on #75.)

## Lifecycle, Same As Step 3

| Moment | What happens |
| --- | --- |
| Before the send | The start record is saved (section 7) before the CLI is spawned. An undetermined save answers `unknown` and spawns nothing. |
| While it streams | Each piece is saved as it arrives. Section 11's overflow rule holds text until the CLI shows paid usage is off, then releases it. |
| Stop | Stops the CLI's whole process group; the text so far stays, marked stopped. |
| Quit mid-reply | The run is stopped and recorded `stopped`, not cut off, within section 14's 17-second bound. |
| Crash mid-reply | On reopen the run reads cut off (`exit-unrecorded`); the Desk offers "Close as unknown", and Retry waits until it is closed. The supervisor kills any leftover CLI within 6 seconds. |
| Retry | Puts the message back in the composer. The owner presses Send; that makes a new run with new ids. |
| No double send | Nothing resends on its own, after a crash, a lost reply or a refusal. A lost start reply is resolved with `participant.status`. |

## Contract Changes (Revision 5)

Written as section 21 of `docs/desk-native-participant-contract.md` in PR 2.
Sections 1-20 stay in force; every existing vector stays byte-identical.

1. **Context for Claude runs.** Section 20.3's `contextRunIds` (resolved
   from the record, bound by hash, never stored as text, re-checked at
   start) is allowed for a `claude-code` run too. Earlier turns go on stdin
   in one fixed, documented layout before the new message.
2. **Input bound.** Section 17's 4,096-byte first-trial bound counts context
   plus the new message (question 3).
3. **The pin.** The Claude entry gets its real label and model, and states
   that it sends off the Mac, so the page never words it as local.
4. **Section 5 step 4.** The owner's D1 choice (question 2) replaces
   "never run in production".
5. **Approval state.** Availability reports whether Anthropic has been
   approved, as a new reason `host-not-approved`, display only.
6. A new vectors file, `native-participant-claude-v1.json`, for the shapes
   above and the fake-CLI host cases.

## Pull Requests, In Order

1. **Scope** (this document) and STATUS.md.
2. **Contract revision 5 and the page codec.** Section 21, page codec and
   tests, shape cases in the new vectors file.
3. **Mac host**, in parts:
   - **3a** Close contract section 18's pre-activation items: reply-time
     stale suppression on the no-lane path, the combined renderer proof,
     the shared opaque-handle rule, and the nine named page cases.
   - **3b** Availability for real: the local checks, the D1 choice, the
     paid-usage owner and the approval state, inactive.
   - **3c** Context and launch: Claude runs take `contextRunIds`, the
     stdin layout, the real launcher through the supervisor in place of
     `ClaudeNotConnected`, still inactive, tested against the fake CLI
     only. Includes the fake-CLI host cases and the tools refusal (below).
4. **Desk wiring.**
   - **4a** Picker entry, "not on this Mac" labels, the "sends N earlier
     turns" line, both consent screens, plain messages for every reason,
     Retry for Claude runs; nothing turned on. Includes the consent proof
     (below).
   - **4-proof** The fake-CLI kill proof (below), through the real app
     wiring with the launcher still off for the real CLI.
   - **4b** Turn it on in True Convo Test (`LocalConversationLane` gains
     the real launcher); the Claude entry joins the picker only here (see
     "October 16 decision"). **PR 4b may merge only after every safety
     proof below has passed** in 3c, 4a and 4-proof. (Codex P1 on #75.)
5. **Live check and owner trial.** Section 16's acceptance checks with one
   live run on invented text after the owner's OK, then the owner's
   checklist. No safety proof waits for this pull request.

## Proofs

Every proof that guards safety runs against the fake CLI and passes before
PR 4b turns anything on. Only section 16's live run waits for PR 5.

- **Fake-CLI kill proof** (PR 4-proof), built like step 3's `LocalKillMidReplyProofTests`:
  a test app runs the real lane, supervisor and store with a fake CLI that
  streams scripted events. SIGKILL the app at exact points (before the
  first piece, after one, three and six), chosen by handshake, never by
  timing. A fresh app finds: the run cut off with exactly the saved text,
  no reply saved twice, one spawn for the run, no live fake or supervisor
  within 10 seconds. Then Close as unknown, Retry and Send make exactly one
  new run. A graceful quit records `stopped` and one spawn.
- **Fake-CLI host cases** in the new vectors file (PR 3c): overflow held and
  released, overflow signal, tools in init, a provider override, an
  oversize reply, Stop before and after the first piece, lock, supervisor loss.
- **Tools refused** (PR 3c): a fake CLI that reports any tool, MCP server,
  skill or plugin at start is stopped before any text is kept, and the
  argument list always carries the no-tools flags.
- **Nothing leaves without consent** (PR 4a, rechecked in 4-proof): no
  spawn happens unless both gates are passed, a revoked approval or an
  ended paid-usage confirmation stops the next spawn, and the CLI never
  receives an API key or proxy setting.
- **Section 16 acceptance** (PR 5, the one live step), on invented text, with the owner present for
  the one live run: argv and init values, inert `@file` and `/config`
  input, nothing new under `~/.claude`, kill -9 cleanup, Stop during a
  blocked save.

## Owner Trial Outline

Written in full as `docs/plans/claude-code-owner-trial.md` with PR 5, like
step 3's. Invented conversations only.

1. The picker shows "Claude · … · Anthropic (not on this Mac)" next to the
   local models.
2. First send asks you to approve Anthropic, showing what leaves.
3. It asks you to confirm paid usage is off; check claude.ai first.
4. Reply streams in. A second message remembers the first.
5. Switch one conversation from the local model to Claude: the line above
   the composer counts the earlier turns that will leave.
6. Stop, quit mid-reply (stopped), force quit mid-reply (cut off, not
   resent), Retry (message back, you press Send).
7. Lock the screen: the paid-usage confirmation ends and is asked again.
8. Sign out of Claude Code in Terminal: the picker says signed out, Send
   does nothing, nothing goes to the local model instead.

## The October 16 Decision

docs/decisions.md, October 16: "the Claude entry stays out of the model
picker until the Claude Code adapter works." This plan keeps it: the entry
stays hidden through PR 4a and appears only in PR 4b, in True Convo Test.
What counts as "works" is the owner's call (question 1).

## Open Questions For The Owner

1. **When does Claude appear in the picker?** *Recommend:* in True Convo
   Test when PR 4b merges, which it may do only after every fake-CLI safety
   proof has passed, so the trial can run. The real app waits until this trial passes. Trade-off: it is
   visible before a live run has been checked; it stays unusable until both
   gates pass.
2. **The D1 choice: may True Convo run `claude auth status`?** It is the
   only local way to learn "signed in, on a plan, no API key", but on Team
   or Enterprise plans it can fetch settings from Anthropic and run a
   helper program they name. True Convo's D1 record (not moved) lists four
   options, most protective first:
   1. Let macOS block all network use for that one check, and accept only
      Pro and Max plans.
   2. Point that one check at a proxy address the app holds closed, so the
      fetch fails, and accept only Pro and Max plans.
   3. Run the check normally and refuse non-Pro/Max plans afterwards (one
      fetch per launch can still happen).
   4. Keep refusing, so Claude is never available (today's setting).

   *Recommend* option 1, with option 2 as a backup, the order Codex already
   recommended there. Trade-offs: Team and Enterprise logins can't use the
   adapter; option 1 relies on a macOS tool Apple calls deprecated and must
   be retested on each macOS version. Neither option alone guarantees that
   no helper ever runs: one changed on the Mac between the check and the
   run, or a login changed in that gap, isn't caught. So the owner's
   choice also accepts a narrower promise, written into the contract and
   reviewed by Codex.
3. **Section 17's limits: 5 runs per confirmation, 4,096 bytes per send.**
   With earlier turns included, 4,096 bytes is about two short exchanges.
   *Recommend:* keep 5 runs for the first trial and raise the byte bound to
   32,768 (context plus message) once the fake-CLI proofs pass. Trade-off:
   larger sends can cost more plan usage, never money, while paid usage is
   off.
4. **Can one conversation mix local and Claude turns?** *Recommend:* yes;
   the line above the composer says how many earlier turns go to Anthropic,
   and the owner can start a fresh conversation instead. Trade-off: a turn
   that stayed on the Mac leaves it once Claude is picked there.
5. **Re-pinning when Claude Code updates.** The pin is 2.1.283 (installed
   now). When the CLI updates, the old file goes and Claude shows
   "Claude Code updated; True Convo hasn't caught up yet". *Recommend:* a
   small re-pin pull request each time, re-recording section 16's init
   values. Trade-off: Claude can be unavailable for a day or two after an
   update.
6. **When may real conversations go to Claude?** The plan requires both
   trials, step 2's and this adapter's, and then the owner picking Claude
   in that conversation (safety model, item 7). *Recommend:* keep it that
   way. Trade-off: real use waits for both trials.
7. **Which Claude model?** *Recommend:* one pinned model per app build,
   chosen by the owner at PR 3c; no model menu inside Claude yet.
