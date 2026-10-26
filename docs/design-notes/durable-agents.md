# Design Note: Durable, Proactive Agents

Written October 12, 2026; decision changed October 21, 2026 (owner). Status:
Pi Durable is adopted as the agent runtime for step 6; the ideas below still
guide the Top Five.

## Why This Note Exists

The owner shared an IndyDevDan video (October 2026) about **Pi Durable**, an
experimental, MIT-licensed package from the makers of the Pi coding agent, and
**Jev**, a small, cheap model that only makes yes/no decisions. The video shows a
proactive "on-call" agent: Jev sorts a live event stream, wakes an agent when
something breaks, the agent investigates and prepares a fix, then waits for a
person to approve the deploy.

This note records what Open Convo should take from that, and what it should not.

## Decision (Owner, October 21, 2026)

**Pi Durable is the foundational multi-agent framework for True Convo,
accepted as experimental.** It replaces the October 12 decision ("do not
depend on it yet"). It arrives with step 6, where agents come in; it does not
jump the build order.

Read from the library itself (`github.com/earendil-works/pi`,
`packages/durable`, MIT, version 1.3.0 at the time, Node 22.19 or later):

- Every message, model turn, tool call and state change is saved before
  anything is shown. Tasks save a checkpoint at every step, so after a crash
  or restart the work picks up where it stopped.
- Storage is one SQLite file (or JSONL, IndexedDB, or a Cloudflare Durable
  Object). Conversations are transcripts of entries that never change; they
  can be forked.
- It already has an inbox, steering a run while it works, subagents in the
  foreground and background, child tasks, background compaction, a reviewer
  example, a sandbox per conversation, and hooks that can stop a tool call for
  approval before it runs. A task that crashes five times in a row is parked,
  not retried forever.
- It is marked **Experimental**: the API changes without notice between
  releases, and its newest database upgrade cannot be rolled back.

The safety caveats in IndyDevDan's demo apps (a device token that gives shell
access, plain HTTP between home devices, a command guard off by default) belong
to those apps, not to the library.

### Conditions

1. **Pin an exact version** and upgrade only on purpose, with a test pass and a
   backup of its storage first (upgrades can't be rolled back).
2. **Wrap it.** Open Convo modules talk to a thin layer of our own, never to Pi
   Durable's API directly (replaceable layers), so a breaking change or a
   replacement touches one layer.
3. **Nothing announces itself.** Turn off the attribution headers it sends to
   model providers by default, and keep its telemetry off unless the owner
   turns it on.
4. **Its storage lives in the owner's protected space** (step 2), not as a loose
   file beside the app.
5. **Every tool says whether it is safe to run twice.** Pi Durable resumes after
   a crash; the README is explicit that a tool with outside effects (sending,
   spending, deleting) needs its own protection against running twice. Those
   tools also stop for the owner's approval.
6. **Approvals and the action check go through our layer**, so the approval
   card and Jeff's check (see `capabilities-and-primitives.md`) work the same
   whichever runtime is underneath.

### How It Meets Durable Sessions

Foundations asks every session to carry a lasting identity: its lifespan, its
origin, the provenance of everything in it, and its direction (purpose). Pi
Durable gives the first two layers for free and leaves the last two to us:

| Durable-session need | Pi Durable gives | We add |
| --- | --- | --- |
| Lifespan: survives crashes, renames, model switches | Saved-before-shown entries, checkpointed tasks, a session identity that survives reopen, reset, compaction and model changes | Renames and archive as our own records |
| Provenance: who or what produced each message and result | Entries that never change, each task owned by its conversation or another task, which model ran each turn | The source labels (raw source, owner-approved fact, AI interpretation, proposal) and which provider advised through Jeff |
| Lineage: where it came from, what split off | Forks, child conversations, subagents and child tasks, all linked | The link back to the item or conversation that started it |
| Direction: what it is for, and drift | Nothing; it runs what it is given | Purpose stored as a document beside the transcript, editable, with revisions; drift flagged and an offer to split into a linked session |

So Pi Durable is the durable record; the session's purpose and its labels are
True Convo's, stored as Pi Durable documents through our layer so they are
saved with the same guarantees.

## Ideas to Borrow, Mapped to the Top Five

### 1. Keep the Conversation Engine Separate From the Screens (Steps 1 and 3)

The video's central point: the agent runs in one place, and screens connect to
it. A browser, a terminal, a phone or a coworker's screen are all just clients.

For Open Convo: the Desk, the heads-up display and dictation should talk to one
conversation engine through a clear interface, rather than each holding its own
copy of the conversation. The iOS app (step 12) then becomes another client, not
a rebuild. Design the step 3 conversation so that closing a window never ends
the conversation.

### 2. Conversations Survive Anything (Steps 2 and 3)

A durable agent resumes from its last checkpoint after a refresh, a killed
process or a restart, and long conversations are condensed in the background
instead of stalling.

For Open Convo: step 2 supplies the persistence (kill-and-reopen tests, saves
that survive crashes). Step 3, where replies first stream in, adds the rest: an
in-progress reply that was interrupted is recorded as interrupted, never
silently lost and never silently re-sent.

### 3. Do the Work, Then Wait for a Yes (Project Rules, Step 3)

The video calls this "human near the loop": the agent prepares everything, then
pauses at the risky step until a person approves or declines. An approved step
can only run once, so an irreversible action cannot fire twice by accident.

For Open Convo: this matches the existing rule that spending, publishing,
accounts and credentials need the owner's approval. Build approvals as a
first-class part of the conversation (a visible card with Approve and Decline),
and mark irreversible actions so they can never be replayed after a restart.

### 4. A Cheap Gatekeeper in Front of Risky Actions (Later, With Step 6)

In the video, a Jev add-on checks every shell command and blocked a delete until
it was deliberately switched off. Each check costs a fraction of a cent.

For Open Convo: the categories AGENTS.md already reserves for the owner
(release, deployment, publication, spending, account or credential changes,
services that outlive the session) are fixed rules checked in code first, and
always ask the owner. No model can wave them through. Only actions left after
those rules may go to a small decision model, which sorts them into "just do
it" or "ask the owner." It filters; the owner still decides.

True Convo's `tools/action-guard` and `jev-helper` are the starting points;
both stayed behind in the move and need the owner's choice before porting.
No paid model is added without approval.

### 5. Controls the Owner Can See and Change Mid-Conversation (Steps 3 and 5)

The video switches a running agent to read-only from the screen, and the agent
adapts. Several sessions also share one notebook of state.

For Open Convo: show what the assistant is allowed to do and let the owner
change it during a conversation in plain words (for example, "read only").
The shared notebook is close to the Brain and to step 5's chosen memory; keep it
on the protected store and under the owner's approval.

## What Not to Borrow

- **Agents that act on a schedule or event without the owner present.** The
  video's proactive agents start work on their own. For Open Convo that is a
  service that outlives the session, which needs the owner's approval first.
  Proactive help can come later, and only behind the approval card above.
- **Cloud sandboxes and always-on machines.** The video runs agents on dedicated
  computers and cloud sandboxes. Open Convo stays on the owner's Mac for now.
  This is about the product. The agents that build Open Convo may use one
  always-on VM (owner decision, October 25, 2026;
  [back-end-and-agent-hosts.md](back-end-and-agent-hosts.md)).
- **Shipping without review.** The video's author argues advanced users can let
  agents deploy unreviewed. Open Convo keeps the owner as the final step.

## A Terminal in True Convo (October 25, 2026)

The owner asked whether True Convo should have a terminal, after notes on
Herdr (a terminal multiplexer for coding agents) and two Pi videos. The
earlier terminal talks were in True Convo and never came across, so this is
the first record here. A view, not a plan or a decision:

- **A terminal is one more client.** Idea 1 above already says agents run in
  one place and screens connect to them. True Convo keeps agents alive in Pi
  Durable's saved records, not in open terminal windows, so a tool whose job
  is keeping terminals alive (Herdr) has nothing to add inside the product.
  The owner may still use it on the Mac to juggle Claude Code and Codex jobs;
  agent sessions left running there count as a service that outlives the
  session.
- **A terminal the owner types into** could become a Desk pane later, under
  the OS shell direction (PLAN.md step 12). It needs no new rules.
- **A terminal agents drive** is a channel that runs commands. It waits for
  the real boundary in
  [portable-capability-layer.md](portable-capability-layer.md), with zero
  trust as the baseline for foreign agents
  ([agent-profiles-and-adapters.md](agent-profiles-and-adapters.md)). The
  same goes for a local socket that lets any script start agents (Herdr has
  one), and for community Pi extensions such as `pi-subagents` and
  `pi-mcp-adapter`. In IndyDevDan's demo, the Jev command guard blocks a
  delete, is switched off in one click, and the delete runs. A classifier
  filters (idea 4); it is not the boundary.
- **Worth borrowing for step 6:** a working, blocked or done view across all
  agents ("one screen for all agents"), fed by Pi Durable's records rather
  than by reading terminals; a cheap model for explore sub-agents while the
  main model stays strong; and turning single MCP tools on or off per server.

## Sources

- Pi Durable source and README: https://github.com/earendil-works/pi/tree/main/packages/durable
- Syntax, "You need to check out Pi Durable" (YouTube, `BLRReTwV8Fc`), October 2026.

- IndyDevDan, "Pi Durable PROACTIVE Agents: Jev Triggers My ON-CALL Pi Agent"
  (YouTube, `DNDYYHsypZg`).
- Cloudflare Agents docs, Pi harness: https://developers.cloudflare.com/agents/harnesses/pi/
- Herdr, an agent-aware terminal multiplexer (secondary write-ups, the
  canonical repo not yet confirmed): https://betterstack.com/community/guides/ai/herdr-ai-agent/
- A video on adding sub-agents and MCP to Pi (YouTube, `l3YCoX2i-78`),
  October 2026.
- Pi Durable launch profile: https://kingy.ai/ai-launch-tracker/pi-durable-experimental-package-2026-10-01/
