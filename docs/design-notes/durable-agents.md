# Design Note: Durable, Proactive Agents

Written October 12, 2026. Status: guidance for the Top Five, not a new build step.

## Why This Note Exists

The owner shared an IndyDevDan video (October 2026) about **Pi Durable**, an
experimental, MIT-licensed package from the makers of the Pi coding agent, and
**Jev**, a small, cheap model that only makes yes/no decisions. The video shows a
proactive "on-call" agent: Jev sorts a live event stream, wakes an agent when
something breaks, the agent investigates and prepares a fix, then waits for a
person to approve the deploy.

This note records what Open Convo should take from that, and what it should not.

## Decision

- **Do not depend on Pi Durable yet.** It is weeks old and labeled experimental;
  even the video's author will not run it in production before a stable release.
  Open Convo is meant to be a dependable core others build on.
- **Borrow its design now.** The ideas below cost little to adopt while building
  the Top Five and keep the door open to Pi Durable, or something like it, later.
- Revisit when Pi Durable has a stable release, or when step 6 (Claude and Codex
  together with scoped delegation) starts.

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
- **Shipping without review.** The video's author argues advanced users can let
  agents deploy unreviewed. Open Convo keeps the owner as the final step.

## Sources

- IndyDevDan, "Pi Durable PROACTIVE Agents: Jev Triggers My ON-CALL Pi Agent"
  (YouTube, `DNDYYHsypZg`).
- Cloudflare Agents docs, Pi harness: https://developers.cloudflare.com/agents/harnesses/pi/
- Pi Durable launch profile: https://kingy.ai/ai-launch-tracker/pi-durable-experimental-package-2026-10-01/
