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
replies to the page through the existing `participant.*` operations, with the
route named, so the Claude Code adapter later shares the same page, transcript
and Stop.

Why: a local HTTP stream has no process group to supervise and no paid path,
so most of the participant lane's machinery (process groups, binary pinning,
paid-usage confirmation) doesn't apply. Reusing the page wire keeps one
conversation screen for every route.

Trade-off: the contract gains a route field and a few local-only rules, which
needs Codex's review of the wire before code.

## Rules For The Local Route

- **Loopback only.** Connect only to `127.0.0.1` or `::1`. Ignore
  `OLLAMA_HOST` and any setting that points elsewhere.
- **Local models only.** Refuse any model whose name ends in `:cloud` or that
  Ollama reports as remote; they send the conversation off the Mac.
- **No fallback.** If Ollama isn't running or the model is missing, say so
  plainly; never switch to another route.
- **Visible before Send.** The composer shows "Local · <model> · stays on this
  Mac" for the chosen model.
- **Model choice is rules only:** the owner's default plus a per-conversation
  choice.

## Proposed Pull Requests, In Order

1. **Wire and scope** (this document), reviewed first.
2. **Local route in the Mac host.** List installed local models; stream a
   reply; Stop cancels the request; loopback and `:cloud` refusals. Tested
   against a fake Ollama server, never the network.
3. **Desk wiring.** Model picker, "who receives what" label, streaming reply in
   the run transcript, Stop. Tried in True Convo Test with invented chats.
4. **Saved and reopened.** Conversations on the protected store; reopening
   sends the earlier turns back as context, so nothing is retold. Safe retry: a
   reply cut off by a crash is marked as cut off, never duplicated or resent
   silently.
5. **Proof and owner trial.** A scripted kill-mid-reply proof, plus a short
   checklist for the owner.

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
