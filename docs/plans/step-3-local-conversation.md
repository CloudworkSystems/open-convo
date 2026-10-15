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

## Contract Changes (Revision 4, Its Own PR Before Host Code)

These change `docs/desk-native-participant-contract.md`, the Swift and page
codecs and the vectors file together. Page and host already ship as one build
(section 2), so the pinned page codec moves with them.

1. **A catalog, not one pin.** `participant.availability` returns a list of
   entries: the Claude Code entry (unchanged) plus one entry per installed
   local chat model. Each entry keeps today's four persisted fields: `id`
   (`ollama-local` for every local model), `label`, `model` and
   `executionHost` (`this-mac`). `model` is the Ollama name plus its digest
   (`qwen3.5:9b@6488c96fa5fa`), so a re-downloaded or changed model is a
   different identity. The run's persisted `participant` stays four fields,
   compared as exact strings on replay. `:cloud` and remote models appear as
   entries that are never available (`model-not-local`), so the Desk can say
   why they can't be picked.
2. **Route-level state.** Some failures have no model entry to hang on, so
   the reply also carries `routes`: one item per route, for example
   `{route: "ollama-local", state, reason}`, with `reason` `null` when ready,
   else `ollama-not-running` or `host-not-loopback`. A model the owner chose
   that is absent from a ready route's catalog is shown as missing; one whose
   name is present with a new digest is shown as changed. The Desk works
   these out by comparing its saved choice with the catalog.
3. **Prepared-run check (section 6, step 5)** compares `run.participant` with
   *an entry* of native's current catalog instead of the one pin. **Start
   (section 7, step 10)** answers `participant-changed` when that entry is
   gone or its digest changed; native never runs a prepared run under another
   model.
4. **Conversation context in the first wire.** A prepared run gains
   `contextMessageIds`: the ordered ids of earlier completed messages in the
   same session to send as context. In the preparing commit, native reads
   their role and text from the committed record (a missing, uncompleted or
   out-of-session id is `run-mismatch`) and saves that resolved sequence as
   an **immutable snapshot** in its own prepared entry, with its byte count
   and SHA-256. Start sends exactly the snapshot, so a later edit to an
   earlier message can't change what goes out; status and the proof can
   check the hash.
5. **One input limit over everything sent.** The resolved context's roles
   and text plus the new message's `inputChunks` count together against the
   existing 262,144-byte input bound (section 6, step 6), measured on the
   resolved text, not the ids. Over the bound is `text-too-large`. The page
   does the same count from its own record before preparing and leaves out
   the oldest whole turns until it fits, so the refusal only catches a page
   that got it wrong. The composer says "Earlier turns not sent" when any
   were left out; a turn is never cut in half. Context applies from the
   first host PR, so every second turn continues the conversation.
6. **Local-only entries.** Model-level reasons are `model-not-local`;
   route-level reasons are above. Section 17's paid-usage confirmation and
   the first-trial input bound apply to the Claude Code entry only.

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
2. **Contract revision 4, codecs and vectors.** The changes above, with new
   vectors for catalog entries, route states, context ids and their
   snapshot, the shared input bound, the new reasons and
   `participant-changed` on a changed digest. No host behavior yet.
3. **Local route in the Mac host.** Catalog from Ollama; start with receipt
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
