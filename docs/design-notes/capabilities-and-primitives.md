# Design Note: Capabilities and Nexus Primitives

Written October 13, 2026 by the planning session, from a conversation with the
owner. Status: direction; the layer is built with step 6, and design
capabilities arrive with Site Engine.

## Capabilities, Not Skills (Owner Decision)

- A **skill** is a set of instructions only one AI program (Claude Code, Codex)
  can read; it lives inside that program.
- A **capability** is something True Convo itself can do, offered through one
  interface, usable by any model (local, Claude, ChatGPT) through any harness
  (Pi, Claude Code), wrapped in True Convo's approvals, cost caps and logs.

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
| `judge` (typed yes/no answers) | Jev, or OpenAI Decisions API ($2/month cap each, owner-approved) | capability-adapter | Step 6 |
| `find_lines`, `rank_files` | Jev | capability-adapter | Step 6 |
| `search_local`, `index_local` | EmbeddingGemma 2, on the Mac (search model; it does not chat or write) | capability-adapter | Step 6, or earlier for memory search |
| `action_check` (pass, review or deny before an agent acts) | Jeff's local rules | capability-adapter + `tools/action-guard` | Step 6, private side only (see below) |
| Design: `design_audit`, `design_polish`, `typeset`, layout and color passes | Impeccable (Apache 2.0, includes an anti-pattern detector) | `cloudwork_systems/.claude/skills/impeccable` v4.0.4 | Site Engine |
| Scroll: scroll-driven pages, layered heroes, video scrubbing | ScrollCraft by Nate Herk (MIT, `github.com/nateherkai/scroll-craft`, pinned at `0b81622`) | `cloudwork_systems/true_convo/tca_brain/brain/skills/portable/scroll-craft` (local adaptation 0.3.0-tca.1) | Site Engine |

Later capabilities come from the modules: voice (Convo Engine), visibility
checks (Visibility Agent).

## Rules

- **Jeff stays private.** True Convo's rules require a legal review before Jeff
  is shared publicly, and Jeff never stores, learns from or copies Jev answers.
  Jeff's rules live on the subscription side, not in Open Convo, until that
  review is done.
- **Paid providers are optional,** approved by the owner, capped, and never a
  silent fallback; a capability with no approved provider returns an error.
- **Third-party code keeps its license and credit.** Impeccable (Apache 2.0) and
  ScrollCraft (MIT) are adopted as pinned copies with their license files and a
  source lock; upstream changes are reviewed before replacing them, never pulled
  automatically. Each goes in the license and attribution register before the
  repo goes public.
- A capability's description says what it does and what it does not prove.
