# Design Note: One Memory For Every Agent The Person Uses

Written November 1, 2026 at the owner's request, in the thread "Learn from
Riley Brown's AI setup". Status: idea, not planned or built. A plan in
`docs/plans/` comes first if the owner wants it built. It arrives after
step 5 (chosen memory on real storage) and jumps nothing in the build order
in [PLAN.md](../../PLAN.md).

## Why This Note Exists

The owner watched a creator walk through his full agent setup: Claude
Projects for making things, OpenAI's Dots driving Codex by voice for email
and admin, GrokBot for Twitter research, and Composio holding the logins
for about 30 apps so that every agent can use them. The creator called the
one piece he couldn't solve "the memory problem". Claude Code, Codex,
GrokBot, Claude Duet and Meta's Muse each keep their own memory of him, and
none of it carries over when he switches tools. He tried a hosted memory
service connected through Composio, but couldn't get it to update often
enough to switch tools mid-task.

True Convo already plans one memory that belongs to the person:
[docs/plans/prime-agent.md](../plans/prime-agent.md) ("Shared Memory"),
the Atlas wiki and the Memory Steward
([atlas-wiki-and-status-edges.md](atlas-wiki-and-status-edges.md)), and
step 5. Those cover agents that run inside True Convo. This note covers what
they leave open: the outside agents the person already uses, which run in
other companies' apps with their own memory.

The app-login half of the same problem (Composio's "agent passport") is
already answered by [connections-layer.md](connections-layer.md): one
sign-in per app, with the tokens in Keychain on the person's device. This
note is the memory half.

## The Idea In One Line

The person's kept memory lives once, on their device, and every agent they
use reads from it and proposes to it through one door. No agent's own
memory is the source of truth.

## 1. One Store, Many Readers

- **The store is step 5's protected store**, in separate spaces (Personal,
  one per business), with the shape prime-agent.md already sets: one file
  per subject, each under 4 KB, and a generated index per space.
- **Outside agents reach it through one local door**: a small MCP server
  on the person's Mac (the same pattern connections-layer.md uses for apps)
  that answers "what do you know about X in space Y". MCP is what Claude
  Code, Codex, Cursor and most other harnesses already speak. It runs on
  the device and never listens to the network.
- **Each agent profile gets a share level** that the person sets once and
  can change:
  - *Nothing* (the default for any foreign agent, per the zero-trust rule
    in [agent-profiles-and-adapters.md](agent-profiles-and-adapters.md)).
  - *Per job*: a context package (foundations.md, "Context packages") built
    for one task and discarded when it ends.
  - *Read one space*: standing read access to the files in one space.
  An agent whose model runs in another company's cloud gets nothing the
  person hasn't shared with it, and nothing at all until the person has
  approved that model and host once, as prime-agent.md rules 5 and 7
  already require.
  Every read is logged where the person can see it.
- **Freshness is the point.** The creator's complaint was that his memory
  service lagged. Here a reader always gets the store as it is now, because
  there is only one copy. There is nothing to sync between agents.

## 2. Agents Propose, The Person Keeps

- **Nothing enters memory until the person keeps it** (foundations.md,
  "Explicit save first"). An outside agent can only add a candidate to the
  proposed list, marked with the agent that sent it and whether that agent
  is confirmed, exactly as prime-agent.md describes for specialists.
- **Capture at the end of a session, not by polling.** Where a harness can
  run something when a session ends (Claude Code's hooks, for example), it
  sends the door a short "what I learned" candidate. Where it can't, the
  person says "save that" and the candidate goes in by hand. Either way the
  person keeps, corrects or skips it, and the Memory Steward's plain-code
  rebuild updates the index right after a kept write.
- **Memory is never a yes.** A kept entry that says the person approved
  something is context, not approval, whichever agent reads it.

## 3. Each Agent's Own Memory Stays Out Of The Way

- **Treat a harness's built-in memory as a cache, not a record.** Where
  the person uses an outside agent with True Convo's memory, that agent's
  own memory is switched off where it can be, as prime-agent.md already
  requires for its skill. Where it can't be, nothing from it counts as kept
  memory.
- **A one-time import.** What Claude, ChatGPT and the others already
  remember about the person can be brought in once, through each product's
  own export, as candidates for the person to sort into spaces. Nothing is
  kept automatically, and the import never runs again in the background.

## 4. What This Is Not

- **No hosted memory service.** A memory that lives on a company's server
  puts every agent's view of the person in one place someone else controls.
  That is the same reason Composio was set aside (connections-layer.md).
- **No shared memory between people.** Family and team spaces are later and
  need their own plan.
- **Not this repo's build memory.** The Claude threads that build Open
  Convo keep their own project memory, outside the public repo. This note is
  about a True Convo user's memory.

## Rules It Must Keep

- The store stays on the person's device. Nothing from it goes into Git, a
  shared space or a cloud model without that space's existing approval.
- A foreign agent starts with no access, and every grant can be seen and
  taken back.
- Personal and each business stay separate spaces. A reader gets only the
  space it was given.
- Every read and every proposal is logged, and every kept write can be
  undone (step 5's Remember, correct, forget, Undo).

## How It Fits The Order

1. Step 5 builds the store, the spaces and the keep/forget flow.
2. The prime agent's slices use it from inside True Convo.
3. Then a first slice of this note: the local door, read-only, for Claude
   Code and Codex on the Mac, tested with invented memory only. Proposals
   and the one-time import come after it.

## Open Questions For The Owner

- Should the first outside readers be only the coding agents (Claude Code,
  Codex), or also the chat apps (Claude, ChatGPT) once they can reach a
  local server?
- What should the default share level be for an agent the person has
  confirmed: per job, or one space?
- Should session-end capture be on by default for confirmed agents, or
  only after the person turns it on?
