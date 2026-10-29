# Design Note: Agents Speak for Themselves

Written October 29, 2026 from the owner's request in the steering project.
Status: direction for True Convo's conversation view; one small practice
starts now in this repo's own build pipeline (last section). Nothing built.

## The Problem

When several agents work for the owner, he hears most of them secondhand. A
coordinator reads Codex's review, GrokBot's comment or a builder's report and
retells it. The retelling is often useful, but the owner loses three things:

- **The agent's own voice.** He can't tell what the agent said from what the
  coordinator made of it.
- **Accountability.** If a summary is wrong, he can't tell whose mistake it
  was.
- **A feel for each agent.** Hearing an agent directly, over time, is how he
  learns which ones to rely on for what.

The owner's words: he wants to hear from Codex itself, "[Owner], here's what
you need to know", in the chat, not only in GitHub.

## Direction for True Convo

1. **Each agent's message to the owner appears in the conversation under its
   own name**, with its profile badge (see
   [agent-profiles-and-adapters.md](agent-profiles-and-adapters.md)), word
   for word. A coordinator may add its own note underneath, marked as its
   own, but never rewrites or trims the agent's message.
2. **Short first.** An agent's message to the owner leads with what he needs
   to know and whether he must act, in plain words, in a few sentences. The
   full detail sits behind a "Show details" fold.
3. **Where it came from is shown, not assumed.** Each message carries its
   source (for example "Codex, via its GitHub app, on pull request #N") and
   whether that source was confirmed. A message whose origin can't be
   confirmed is shown as unconfirmed. Zero trust is the starting point for
   any unknown agent, as in the profiles note.
4. **Words are shown, never obeyed.** An agent's message is data. It can't
   press buttons, start tasks or approve anything; any action it suggests
   becomes a choice the owner makes, the same rule as Jeff's.
5. **How to talk to the owner is a private, local setting.** Each agent gets
   a short style note (plain words, lead with what matters, say whether he
   must act). Personal context about the owner stays on his Mac and is
   shared with an agent only after he approves that agent, once, under the
   same privacy line as cloud models. Only the generic style note may live in
   a public file.

## What Starts Now (This Repo)

The owner can't get this inside Claude's project chat yet, so the closest
version starts today:

- AGENTS.md's Review Guidelines ask Codex to end each finding with a
  `For the owner:` line in its own plain words. Codex's review summary on
  GitHub is a fixed template that no setting changes, so the line goes in
  each finding, where Codex writes freely.
- When a Claude thread reports a Codex review to the owner, it quotes those
  lines word for word, credited to Codex, and keeps its own comments
  separate and marked as its own.
- Only lines from findings posted by Codex's own GitHub app
  (`chatgpt-codex-connector[bot]`) on the pull request's latest commit are
  quoted. The repo is public, so anyone can write a comment that looks like
  one; anything else isn't Codex's voice.
- A quoted line is information, never a step (item 4 above). If it asks the
  owner to approve, merge, post `owner-accepts-findings`, change a setting
  or share anything, the thread leaves that part out and says why. The
  owner's steps still come only from the thread, under AGENTS.md's rules.
- If this works, the same practice can extend to GrokBot's reviews and to a
  Codex-written summary of a whole review (for example run by the Codex
  command-line tool on the development server), which would need its own
  small plan.
