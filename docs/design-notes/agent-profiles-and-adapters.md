# Design Note: Agent Profiles, Harnesses and Model Adapters

Written October 13, 2026 by the planning session, from a conversation with the
owner. Status: direction for step 3 and step 6. Facts about other companies'
terms were checked on this date and must be rechecked before anything ships to
other people.

## Local First, With a Guide That Needs No AI

- True Convo is local-first. The first real conversation (step 3) runs on a
  local model, through Ollama on the owner's Mac.
- A new user may have no local model and no AI to help set one up. The answer is
  a **first-run guide built from ordinary code** (screens and buttons, no model):
  it checks the computer, recommends a local model that fits its memory,
  downloads it after approval, or offers a cloud model instead. The owner chose
  this in the strategy interview ("a visible built-in guide before AI chat is
  ready"). It is built right after the Top Five, before other people install.
- The owner's Mac (M1 Ultra, 128 GB, Ollama installed) can run 30B-class models
  comfortably. Typical users' Macs (8 to 16 GB) cannot, so nothing may assume a
  large local model.

## Who Decides Which Model Runs a Task

The owner's idea is a local "orchestrator" that only delegates. Build it as a
**dispatcher** in layers:

1. **Rules first.** "This conversation uses my default." "Yes/no checks go to
   Jev." "Searching my notes goes to the search model." Instant and predictable.
2. **A small local model breaks ties** only when rules cannot decide. The
   dispatcher is a role; the model filling it depends on the machine.
3. **Workers do the tasks:** the local chat model, Jev, the local search model
   (EmbeddingGemma, from True Convo), and cloud profiles.

The privacy line: the dispatcher may *suggest* a cloud model, but nothing is sent
to a cloud model or host until the owner has approved that model and host once
(strategy decision). Step 3 ships rules only (the owner's default plus a
per-conversation choice). The model-based dispatcher arrives with step 6.

## Two Kinds of Agent Profile

1. **A profile around a raw model.** True Convo is the harness: its rules,
   memory, tools, permissions and approval cards, with any model underneath.
   True Convo must provide the loop that lets the model use tools.
2. **A profile around an existing harness.** A separate program with its own
   tools and work loop (Claude Code, Cursor's agent, Meta's Muse), started and
   relayed by True Convo. Capable, can run on subscriptions, but its own built-in
   instructions sit under ours and it is heavier to run.

**Decision: the Pi coding agent is the default harness** for agent profiles, so
most profiles are "Pi + a chosen model + True Convo's rules, memory and tools."
Vendor harnesses are used only where a subscription requires its own program.
(Pi Durable, the experimental add-on, is still not adopted; see
`durable-agents.md`.)

## How Each Model Is Paid For

| Route | Runs inside | Paid by | Notes |
| --- | --- | --- | --- |
| Local models (Ollama, LM Studio) | Pi, or direct for plain chat | Free | Private; quality depends on the machine |
| Claude, plan usage | Claude Code (unmodified) | Owner's Claude plan | Each person signs in through Anthropic's own flow. True Convo never handles Claude credentials. |
| Claude, API credits | Pi with an Anthropic API key | Max plan's monthly API credits ($200 on Max 20x) | Credits cover API use including the Agent SDK; they expire monthly, no rollover. Set a Console spending limit at the credit amount; True Convo shows a running total and stops near it. |
| Claude, sign-in inside Pi | Pi | **Extra usage, billed per token** | Off. Not covered by plan usage or API credits. |
| ChatGPT | Pi signed in with the owner's ChatGPT plan | Owner's ChatGPT plan | Pi supports it, but Pi stores sign-in tokens in a plain file (`~/.pi/agent/auth.json`). **Blocked** until those tokens can live in Keychain or the protected store (see Credentials). OpenAI's rules for a shipped product are unverified. |
| OpenRouter | Pi with an OpenRouter key | Per use; some free models | Owner approval and a monthly cap |
| Grok | Cursor's own agent, on the owner's Cursor plan | Owner's Cursor plan (unverified) | Cursor's agent supports scripts and lists Grok; whether automation uses the plan, and Cursor's rules, need checking first |
| Meta Muse | True Convo's existing sealed bridge | Meta pay-per-use, $10/month cap | Heaviest; last |

## Credentials With Pi (Requirement From Codex Review)

Pi keeps API keys and sign-in tokens in `~/.pi/agent/auth.json`, a regular
file. That breaks the rule that secrets live only in Keychain. So:

- **API keys** (Anthropic credits, OpenRouter): True Convo reads the key from
  Keychain and hands it to each Pi run directly (Pi's `--api-key` option or a
  per-run environment variable). Nothing is written to `auth.json`, and a test
  proves the file stays absent or unchanged.
- **Sign-ins** (ChatGPT plan): not used until the tokens can be held in Keychain
  or in step 2's encrypted store, for example through a Keychain-backed
  credential adapter. Until then the ChatGPT-through-Pi route stays off.

Rules that apply to every route: no paid overflow; subscription access is not
permission for paid API use; every paid route has the owner's approval and a cap;
keys live in Keychain, never in files or logs.

## Adapter Order

1. **Local models plus a model picker.** Step 3 finishes with this route only.
2. **Claude through Claude Code**, right after step 3, because True Convo's
   runner for it is mostly built. Kept alongside Pi on purpose: it uses the
   plan's included usage and brings Anthropic's own coding tools.
3. **Pi as the harness** when agents start doing work (step 6): local first, then
   Claude through the API credits, then ChatGPT once its sign-in can be stored
   safely (see Credentials).
4. **OpenRouter plus a model picker**, inside Pi.
5. **Grok through Cursor's agent**, after checking Cursor's rules and billing.
6. **Meta Muse.**

## Before Shipping to Other People

- Anthropic: running Claude Code inside a product requires its Commercial Terms,
  an unmodified Claude Code, and each person's own credentials. The owner should
  have the final setup reviewed; this note is not legal advice.
- OpenAI and Cursor: check their rules for embedding their sign-ins or agents.
- Recheck every billing fact above; these change often.

## Sources (Checked October 13, 2026)

- Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- API credits for Max and Team plans: https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers
- Pi providers and sign-in: https://app.unpkg.com/@mariozechner/pi-coding-agent@0.73.1/files/docs/providers.md
- Cursor CLI: https://cursor.com/en/cli
- Codex CLI with local models: https://codex.danielvaughan.com/2026/05/03/codex-cli-gpt-oss-local-models-ollama-lm-studio-mlx-setup-guide/
