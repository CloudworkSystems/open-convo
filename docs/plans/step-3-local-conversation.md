# Step 3 Scope: One Real Conversation, Local First

Status: In progress (Oct 23): all parts merged, including the trial fixes (#76); waiting on the owner's trial.

Written October 15, 2026 by the building session, at the owner's request to
start step 3 while his step 2 trial is pending. A proposal: the owner and the
planning session can change it. PLAN.md step 3 is the authority.

## Finish Line (From PLAN.md)

The owner holds a real conversation with a local model on his Mac, quits,
reopens and continues it. Replies stream in, Stop works, retry is safe, the
session reopens without retelling, and the app shows which model receives what
before Send. Local route only; the Claude Code adapter comes right after.

Real conversations need step 2's trial to pass first. Until then step 3 is
built and tried with invented conversations only.

## What Already Exists

- **Ollama on the owner's Mac** (0.34.0), with three local chat models:
  `qwen2.5:7b-instruct`, `qwen3.5:9b`, `glm-4.7-flash`. It also lists
  `:cloud` models, which run on Ollama's servers, not the Mac.
- **The participant lane** (`ParticipantProcess`, `ParticipantSupervisor`,
  `ParticipantCoordinator`, about 10,000 lines, reviewed and inactive). It
  runs the Claude Code command-line tool, streams its events into a saved
  conversation, and handles Stop, status, crash cleanup, lock and quit. Its
  wire is `docs/desk-native-participant-contract.md`. Much of it is
  Claude-specific: pinned binary paths, `stream-json` parsing, paid-usage
  confirmation.
- **The Desk's page side**: conversation runs and a run transcript
  (`use-conversation-runs.tsx`, `RunTranscript.tsx`, `ParticipantPicker.tsx`).
- **Protected storage** from step 2 for whatever the conversation saves.

## Recommendation: A Direct Local Route Behind The Same Page Wire

Talk to Ollama's local HTTP service (`127.0.0.1:11434`, `/api/chat`,
streaming) from the Mac host directly, with no child process. Present its
replies to the page through the existing `participant.*` operations, so the
Claude Code adapter later shares the same page, transcript and Stop.

Why: a local HTTP stream has no process group to supervise and no paid path,
so the process-group, binary-pinning and paid-usage parts of the participant
lane don't apply. Everything else the contract guarantees still does: the
dispatch receipt, status-based recovery, lifecycle gates and limits.

Trade-off: the contract needs a revision (below) and its codecs and fixtures
change with it, before any host code.

## Contract Changes (Revision 4)

Written as section 20 of `docs/desk-native-participant-contract.md` (step 3
PR 2). In short:

1. **Catalog.** With a local route, availability lists the Claude Code entry
   plus one entry per local chat model (`id` `ollama-local`, `model` =
   name@digest, `executionHost` `this-mac`) and a `routes` item for failures
   with no model entry (`ollama-not-running`, `catalog-unreadable`,
   `host-not-loopback`). Cloud models are listed as never available.
2. **Context.** Earlier turns are referenced by run (`contextRunIds`), because
   the Desk keeps each turn as a run, not as separate messages. Native
   resolves them from the committed record and stores only their byte count
   and SHA-256, never their text (the runs list holds no chat text). At
   start it re-resolves and refuses on any difference, then sends exactly
   what it hashed. This replaces the snapshot proposed earlier, so there is
   nothing to compact (Codex round 3 on #37).
3. **One input limit** over resolved context text plus the new message.
4. **Redirects refused** on every local request (Codex round 3 on #37).
   **Digest-bound requests** through a private per-run alias, because Ollama
   can't run a model by digest (Codex round 2 on #38).
5. **Start, Stop and lifecycle** follow sections 7, 10 and 14, with the HTTP
   task in place of a process group.

## Rules For The Local Route

- **Loopback only.** Connect only to `127.0.0.1` or `::1`. Ignore
  `OLLAMA_HOST` and any setting that points elsewhere.
- **Local models only.** Refuse any model whose name ends in `:cloud` or that
  Ollama reports as remote; they send the conversation off the Mac.
- **No fallback.** If Ollama isn't running or the model is missing, say so
  plainly; never switch to another route.
- **Receipt before request.** Start follows section 7 unchanged: the start
  record is written by compare-and-set inside the store's lock *before* any
  HTTP request. An undetermined write answers `unknown` and sends nothing. A
  start whose reply was lost is resolved with `participant.status`, never by
  sending again. Ollama has no request-level idempotency, so nothing resends
  a request on its own.
- **No redirects.** Every HTTP redirect is refused, so nothing follows a
  reply that points somewhere else.
- **After a crash.** A run with a start record and no terminal reopens as
  interrupted: its partial text is kept and labeled as cut off. Only the
  owner's explicit Retry makes a new run (new ids); the old one is never
  re-requested.
- **Lifecycle gates.** The HTTP task lives under the same coordinator,
  lifecycle epoch and push gate as a process run. Lock, Desk close and quit
  cancel the request, drop retained text on lock and close (section 14),
  write the terminal record, and keep quit within section 14's 17-second
  bound. Late text after lock or into a replacement Desk is never delivered.
- **Visible before Send.** The composer shows "Local · <model> · stays on this
  Mac" for the chosen model.
- **Model choice is rules only:** the owner's default plus a per-conversation
  choice.

## Proposed Pull Requests, In Order

1. **Scope** (this document).
2. **Contract revision 4 and the page codec.** Section 20, the page codec
   and its tests, and a separate vectors file
   (`native-participant-local-v1.json`) for catalog entries, route states,
   context ids, the shared input bound and the new reasons. The page codec
   runs the shape cases now; the existing 107 vectors stay byte-identical.
3. **Local route in the Mac host**, in three parts (split October 15 to
   keep each pull request reviewable). **3a** (merged, #42): a new
   `LocalModelRoute` module, inactive (only its tests link it): the catalog,
   per-run aliases, and `LocalChatRun` behind the existing
   `ParticipantRunning` seam, tested against a fake Ollama on loopback and
   checked once against the owner's real Ollama with invented text.
   **3b**: availability, preparation and storage.
   - Availability lists the Claude Code entry, then the local catalog's
     entries and the one `routes` item, read afresh each time (20.2).
   - A preparing commit for a local run reads the catalog afresh before its
     checks; section 6 step 3 accepts `contextRunIds` only for a local run
     on a host with a local route; step 5 checks the run's participant
     against that fresh catalog; the earlier turns are resolved from the
     same record (completed, same session, before the run, in turn order)
     and the runs entry stores only `contextRunIds`, `contextBytes` and
     `contextHash`, never text (20.3, 20.5). Section 17's first-trial bound
     is Claude Code's, so a local run has the one context-plus-input limit.
   - The reply budget fix from Codex round 3 on #42: `LocalChatCore` takes
     the prepared run's `preparedBytes` and counts the reply's JSON escapes
     against the saved run's 785,408-byte bound, as `StreamJSONReader`
     does, beside the 262,144-byte context-plus-input-plus-output bound.
   - The Swift side of `native-participant-local-v1.json`: every
     availability reply and prepared run, and a check that native never
     sends any reply the page refuses. The local start case is counted and
     waits for 3c.
   - A local start is still refused `participant-changed` (step 10), with
     nothing written or sent.
   **3c**: the local start and its lifecycle. Step 10's
   `participant-changed` from a fresh catalog; re-resolving and re-hashing
   the context at start (`run-mismatch` on any difference); step 13's
   availability recheck, alias sweep and alias bind before the start
   record; the start record (`cliVersion` `ollama-local`) before any
   `/api/chat`; `LocalChatRun` launched with `preparedBytes`; the alias
   deleted after the terminal is written and swept at launch; section 14's
   lock, close and quit with `groupCleared` true; status after a lost reply;
   interrupted runs on relaunch; the vectors' start case and seeded host
   cases (`localRoute` seed, fake-server `script` steps). Tested against a
   fake Ollama server, never the network, including unknown outcomes (reply
   lost after the request, crash between receipt and request, crash
   mid-stream) and every section 14 lifecycle case.
   *Built in PR 3c (October 16):* everything above except the seeded host
   cases in the shared vectors file. The same situations (retag, route
   down, alias moved, dropped stream, lock, quit, crash mid-reply) are
   tested in Swift through the real coordinator and store, with Ollama
   played at the route seam (`LocalStartTests.swift`); adding them to
   `native-participant-local-v1.json` changes the shared file on both
   sides and is left for a follow-up, so the page's copy is unchanged.
4. **Desk wiring.** Model picker, "who receives what" label, context from
   earlier turns, streaming reply in the run transcript, Stop, Retry on a
   cut-off reply. Tried in True Convo Test with invented chats.
   *Split October 16* into two pull requests, because turning the route on
   is the first time the Mac app constructs any participant lane at all
   (today nothing in `VoiceCursorMac` builds a `ParticipantCoordinator`;
   the coordinator and `LocalModelRoute` are linked only by tests).
   **4a** (Desk only, nothing turned on): the page keeps every local entry
   and the route from the availability reply; the picker lists each local
   model as "Local · <model> · stays on this Mac", with a plain reason for
   each route reason (`ollama-not-running`, `catalog-unreadable`,
   `catalog-too-large`, `host-not-loopback`), for `model-not-local`, and
   for a saved choice that is missing or changed; Send builds
   `contextRunIds` from the session's earlier completed runs (oldest whole
   runs left out to fit 262,144 bytes, at most 256), saves the prepared run,
   then starts it through the exact local pin (never the Claude entry
   instead); the reply streams into the transcript; Stop works; each ending
   (stopped, reply-too-long, timeout, failed, cut off after a crash) and
   each local start refusal (`run-mismatch`, `participant-changed`,
   `participant-unavailable`, `text-too-large`) has a plain message; Retry
   on a cut-off or failed local reply puts the message back in an empty
   composer and never sends by itself (the owner's Send makes a new run
   with new ids). Tested with the real page codec, connection and runtime
   against a host played inside the page.
   **4b** (Mac): the app builds the coordinator with a real
   `LocalModelRoute` (`OllamaClient` at the fixed loopback base) and hands
   it to the Desk session, on in the Test build only; the package
   tripwire tests change narrowly, with the reason in the pull request;
   the seeded host cases (`localRoute` seed, fake-server `script` steps)
   join `native-participant-local-v1.json` on both sides, byte-identical;
   and one end-to-end run against a fake Ollama through the real app
   wiring. Open question for 4b: the Claude Code entry must still come
   first in availability, so 4b decides with the owner whether the app's
   lane also carries the (unconfirmed, never available) Claude entry or
   whether that waits for the Claude Code adapter.
   *Built in PR 4b (October 16):* a new module, `ParticipantAppWiring`,
   is the one place the app builds a lane: a coordinator with the real
   `OllamaClient` at the fixed loopback base, handed to the Desk session
   in True Convo Test only (the real app's factory is nil). The open
   question is settled by the owner's October 16 decision: the lane
   carries the Claude entry on the wire, first and never available
   (shipping availability, no confirmation owner, a launcher that refuses
   every launch), and the Desk leaves it out of the picker. A session with
   no saved model starts with `qwen3:8b` when the catalog lists it as
   local and usable; otherwise nothing is picked and the composer says
   why. The end-to-end check runs the real page against this Mac's Ollama
   (opt-in), not a fake. The seeded host cases moved to **4c**, to keep
   4b reviewable.
   **4c**: the seeded host cases (`localRoute` seed, fake-server `script`
   steps) join `native-participant-local-v1.json` on both sides,
   byte-identical, run by the Swift harness against a fake Ollama.
   *Built in PR 4c (October 16):* 26 seeded host cases (prepare with an
   earlier turn, the start sequence and its replay, `run-mismatch`,
   `participant-changed` and `participant-unavailable` five ways, Stop
   before and after the reply began, lock, a dropped connection, an HTTP
   error, a redirect, `reply-too-long`, recovery after a crash, and
   availability three ways), each stating every request that reached
   Ollama. The Swift side replays them with the real `OllamaClient` against
   a fake Ollama on loopback (`LocalHostVectorTests`); the page checks the
   same cases through its codec. No product code changed.
5. **Proof and owner trial.** A scripted kill-mid-reply proof (no duplicate
   replies, nothing resent, cut-off replies labeled), then a short checklist
   for the owner: talk, quit, reopen, continue.
   *Built in PR 5 (October 18):* the proof
   (`LocalKillMidReplyProofTests`). A test-only app,
   `LocalConversationProofHost` (debug builds only, never bundled), runs the
   app's own lane (`LocalConversationLane.makeCoordinator`: the real
   coordinator and `OllamaClient`), the real host, router and encrypted
   store, and a small page stand-in that saves each streamed event as the
   Desk does. Ollama is a fake on a loopback port in the test process, so
   it outlives each app and logs every request. Each round prepares a turn
   with an earlier turn as context, starts it, and SIGKILLs the app at an
   exact point, chosen by handshake, never by timing: before Ollama
   answered, and after one, three or six saved pieces of the reply (with a
   seventh in flight). A fresh app on the same folder then finds: the run
   unknown to native (`exit-unrecorded`) with exactly the saved text, no
   reply recorded twice, one `/api/chat` for it, and its leftover alias
   swept at launch. Then the Desk's own recovery (Codex round 1 on #65):
   until the owner closes the run, Retry is refused and Send waits, by the
   Desk's rules (`canRetryLocalRun`, `busy`); the restored page's events
   read answers `lost` `restarted` with no ending, which offers "Close as
   unknown"; the saved closure keeps the text and changes nothing else,
   and Send is free. Only then does Retry send exactly one new chat with
   the same context and message, complete, and leave the closed run
   unchanged. Those rules live in the Desk's TypeScript, so the stand-in
   ports them and a Desk browser test (`local-conversation.test.mjs`)
   shows the real page doing the same with a crashed run: Retry hidden and
   Send disabled, "Close as unknown" saving the closure and showing "Reply
   cut off", then Retry and Send making one new run. A graceful quit
   mid-reply records `stopped` (`local-stop`), not cut off, deletes the
   alias itself, and keeps one chat. Two rounds per moment by default
   (`LOCAL_PROOF_ROUNDS` raises it). No product code changed; the package
   gains the test-only app, and the dependency tripwire names it.

## Model Trial (October 15)

Same invented prompt ("first step to get ten customers for an invented bakery,
three sentences"), 200-token cap, thinking off:

| Model | Load | Speed | Notes |
| --- | --- | --- | --- |
| `qwen2.5:7b-instruct` | 2.6 s | 71 tokens/s | Generic advice |
| `qwen3.5:9b` | 4.4 s | 58 tokens/s | Most specific and concrete |
| `glm-4.7-flash` | 8.6 s | 63 tokens/s | Numbered list, ignored "sentences" |

The owner picks the default by feel once the Desk can talk to them.

## Open Questions

- The owner's default model.
- Whether thinking mode (slower, sometimes better) is offered per conversation.
- Codex's live-conversation candidate in True Convo
  (`codex/live-conversation-main-resolution`) is unreviewed; PLAN says port it
  with step 3. Read it before PR 3 and take only what fits.
