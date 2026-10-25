# Design Note: The Portable Capability Layer

Written October 25, 2026 from a conversation with the owner. Status:
direction, not a plan. It builds on
[capabilities-and-primitives.md](capabilities-and-primitives.md) and arrives
with step 6; nothing here jumps the build order.

## Why This Note Exists

Many creators now say "skills are dead" because frontier models can work out a
procedure for themselves. That holds for frontier models. A small local model
such as `qwen3:8b` can't: it needs the steps written out, fewer tools and a
short context. Open Convo's core runs on the person's own keys, sign-ins or
local models, so the weaker the model, the more a written recipe is worth.

The owner's framing: all other things being equal, if frontier providers ever
drop sign-in access and everything moves to API prices, people will lean on
local models, and local models will need recipes. The same layer also has to
stay useful in the other direction, as models get better and need less help.

## What Already Exists, And What Doesn't

The text format is mostly solved. Agent Skills (`SKILL.md`) became an open
standard in December 2025 and is read by Claude Code, Codex, Cursor and others.
`AGENTS.md` carries project instructions across tools, and MCP carries tools.
(This updates the line in capabilities-and-primitives.md that says a skill is
something only one AI program can read.)

What doesn't exist, and what True Convo adds:

1. **Adapting a recipe to the model.** One capability is shown differently to
   each model: explicit steps and few tools for an 8B model, a short brief for
   a frontier one.
2. **Proof per model.** Each capability records which models it actually
   passed on.
3. **The wrapper.** Approvals, cost caps and logs apply whichever model runs
   it.

Working name: the **TCA Format**. It is built on top of `SKILL.md` rather than
as a rival to it: True Convo reads the skills people already write, then
adapts and tests them.

## Rules

- **Tested on the local default.** A capability counts as portable only once
  it passes a small set of example runs on the local default model
  (`qwen3:8b` today). A recipe written against a frontier model is never
  assumed to carry over. Its description lists the models it passed on, which
  extends the existing rule that a description says what it does not prove.
- **Code first for small models.** Deterministic steps go in code; the model
  makes only the judgment calls. That is cheaper and more reliable at any
  price.
- **The install gate (owner, October 25).** Before a skill joins the layer,
  True Convo checks whether the harness and its models can already do it
  natively. The outcome is one of three:
  - *Native:* not installed, or kept only as a reference.
  - *Partial:* a trimmed version that covers only the gap.
  - *Needed:* installed, adapted for each model.
- **Example runs come with the gate.** Most `SKILL.md` files ship without
  examples, so True Convo drafts a few from the skill, the person confirms
  them, and they run with and without the skill on that person's own models.
  The same runs become the capability's tests.
- **Third-party skills are checked for actions.** A skill is instructions
  handed to the person's models, and sometimes scripts too. The install check
  lists what it asks to do (send, spend, delete, reach the network), and those
  actions still go through the usual approvals. Licenses and credit follow the
  existing third-party rule.
- **Recipes retire themselves.** The example runs are repeated when a model
  changes. Once a model passes without the recipe, True Convo stops loading it
  for that model and keeps it for models that still need it. Redundancy is
  measured, not guessed.
- **Small specialist models only for narrow jobs.** Training a small local
  model or adapter to absorb a recipe is possible on a Mac, but an adapter is
  tied to its base model, and base models change every few months. That is
  worth it only for narrow, stable, high-volume jobs. Jeff's local decision
  model is the first case; general capabilities stay as recipes.
- **Personal adapters stay private.** A later adapter trained on one person's
  approved decisions is that person's data in another form. It follows the
  memory rules: it lives on the device, in its own space, is forgotten when
  Forget is used, and is never used in the cloud without approval. New users
  start on shared recipes; the personal layer matters only after weeks of use.
- **Guardrails never move into a model (owner, October 25).** True Convo may
  absorb how a capability is done, through shrinking recipes and small
  specialists, but approvals, cost caps, logs and memory permissions stay as
  code outside every model, however capable the models become. Rules inside
  weights can't be checked.

## Watch List

- Research models that sketch a whole answer and then refine it, or that
  reason without words (shared by the owner, October 25). They aim to make
  small models smarter per token, which would let recipes shrink sooner. They
  are small research models today and not in Ollama; revisit when one is.
  Reasoning without words also pulls against showing what each model
  receives, so any adoption needs a way to read that reasoning back.
