# Step 3 Scope: One Real Conversation, Local First

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
3. **Local route in the Mac host** also runs every case in the new vectors
   file through the Swift harness, plus the hash binding and
   `participant-changed` on a changed digest.
   The host itself: catalog from Ollama; start with receipt
   before request; streaming events; Stop; status after a lost reply;
   interrupted runs on relaunch; lock, close and quit gates. Tested against a
   fake Ollama server, never the network, including unknown outcomes (reply
   lost after the request, crash between receipt and request, crash
   mid-stream) and every section 14 lifecycle case.
4. **Desk wiring.** Model picker, "who receives what" label, context from
   earlier turns, streaming reply in the run transcript, Stop, Retry on a
   cut-off reply. Tried in True Convo Test with invented chats.
5. **Proof and owner trial.** A scripted kill-mid-reply proof (no duplicate
   replies, nothing resent, cut-off replies labeled), then a short checklist
   for the owner: talk, quit, reopen, continue.

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
