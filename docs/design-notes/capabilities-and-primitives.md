# Design Note: Capabilities and Nexus Primitives

Written October 13, 2026 by the planning session, from a conversation with the
owner. Status: direction; the layer is built with step 6, and design
capabilities arrive with Site Engine.

## Capabilities, Not Skills (Owner Decision)

- A **skill** is a set of instructions an AI program reads. Agent Skills
  (`SKILL.md`) is now an open standard that several programs (Claude Code,
  Codex, Cursor) read, but a skill still runs inside whichever program loads
  it, without True Convo's approvals, caps or logs (owner, October 25).
- A **capability** is something True Convo itself can do, offered through one
  interface, usable by any model (local, Claude, ChatGPT) through any harness
  (Pi, Claude Code), wrapped in True Convo's approvals, cost caps and logs.

How capabilities adapt to each model, get tested on the local default, pass
an install gate and retire: [portable-capability-layer.md](portable-capability-layer.md)
(October 25).

True Convo's `tools/capability-adapter` (October 11) is the starting point: one
JSON command plus a tools-only MCP server, no HTTP port or background service,
keys in Keychain. It moves to `packages/capabilities`.

## Three Layers

1. **Nexus primitives: what the person asks for.** Plan, Build, Research,
   Investigate, Remember, Delegate, Review, Publish (already in the Desk as
   "planned, not connected", `apps/desk/src/content/nexus-primitives.ts`).
2. **The dispatcher (Classify): who handles it.** Picks the agent profile and
   model (see `agent-profiles-and-adapters.md`). Classify is a routing step, not
   a ninth primitive.
3. **Capabilities: the tools a worker uses.** Listed below.

Step 6 starts with a Plan pilot: one approved worker returns a saved plan with
goal, steps and finish line, then stops for review. Build runs only after a
separate yes; Publish never sends or releases without approval.

## Capabilities Planned

| Capability | Provider | From | When |
| --- | --- | --- | --- |
| `judge` (typed yes/no answers) | Through Jeff (below): a local open-source decision model, Jev, the OpenAI Decisions API, or a small cloud model; paid ones capped at $2/month each and owner-approved | capability-adapter | Step 6 |
| `find_lines`, `rank_files` | Through Jeff (Jev to start) | capability-adapter | Step 6 |
| `search_local`, `index_local` | EmbeddingGemma 2, on the Mac (search model; it does not chat or write) | capability-adapter | Step 6, or earlier for memory search |
| `action_check` (pass, review or deny before an agent acts) | Jeff's local rules | capability-adapter + `tools/action-guard` | Step 6, private side only (see below) |
| Design: `design_audit`, `design_polish`, `typeset`, layout and color passes | Impeccable (Apache 2.0, includes an anti-pattern detector) | `cloudwork_systems/.claude/skills/impeccable` v4.0.4 | Site Engine |
| Scroll: scroll-driven pages, layered heroes, video scrubbing | ScrollCraft by Nate Herk (MIT, `github.com/nateherkai/scroll-craft`, pinned at `0b81622`) | `cloudwork_systems/true_convo/tca_brain/brain/skills/portable/scroll-craft` (local adaptation 0.3.0-tca.1) | Site Engine |

Later capabilities come from the modules: voice (Convo Engine), visibility
checks (Visibility Agent).

## Rules

- **Jeff is the one door for classifiers (owner, October 21).** Every typed
  question (yes or no, pick one, rate, sort this source) goes through Jeff, an
  adapter in Open Convo. Behind it sits whichever provider the owner chooses
  for that kind of question: a local open-source decision model (Laya,
  Apache 2.0, is the first local candidate, owner October 21; its license and
  benchmarks are checked before adoption), Jev, the OpenAI Decisions API,
  Cloudflare's equivalent, or a small cloud model such as a Claude Haiku-class
  model. Modules ask Jeff, never a provider directly, so swapping providers
  changes no module. Jeff applies the caps, records which provider advised,
  and works with a local provider alone.
- **What stays private.** Jeff's trained rules, and anything that learns from
  decisions, stay on the subscription side until their legal review. Jeff
  never stores, learns from or copies Jev answers (or any provider's answers
  whose terms forbid it); only owner decisions are kept.
- **Paid providers are optional,** approved by the owner, capped, and never a
  silent fallback; a capability with no approved provider returns an error.
- **Third-party code keeps its license and credit.** Impeccable (Apache 2.0) and
  ScrollCraft (MIT) are adopted as pinned copies with their license files and a
  source lock; upstream changes are reviewed before replacing them, never pulled
  automatically. Each goes in the license and attribution register before the
  repo goes public.
- A capability's description says what it does and what it does not prove.
