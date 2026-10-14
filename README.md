# Open Convo

Open Convo is the open-source core of **True Convo**, an owner-controlled AI
desktop app for the Mac. True Convo is the product; Open Convo is the part
given away for others to use and label as their own. Subscription features
will live in a separate private repo before this one goes public.

This repo is where True Convo is built: one Mac app that holds the Desk (the
conversation home), dictation that works wherever the cursor is, and the
heads-up display (the pill), plus the clarity tools.

## Principles

- **Local first.** Conversations, memory and dictation stay on the Mac,
  encrypted. Cloud models are used only with the owner's approval.
- **No outside sign-in.** Using the app never requires a ChatGPT or other
  third-party account.
- **The owner decides.** Spending, accounts, publishing and anything shared
  need explicit approval.

## Start Here

| File | What it holds |
| --- | --- |
| [STATUS.md](STATUS.md) | Where the build is right now and what comes next |
| [PLAN.md](PLAN.md) | The full build order, modules, open questions and move log |
| [AGENTS.md](AGENTS.md) | Rules for anyone (or any agent) working in this repo |
| [docs/plans](docs/plans) | Scope for each build step |
| [docs/design-notes](docs/design-notes) | Plans for later modules |
| [brand](brand) | The Ember look: colors, fonts, logo |

## Trying the Desk

On the owner's Mac, double-click `Start Desk.command`, then open
http://127.0.0.1:4183 in Codex's inline browser.

## Background

True Convo's earlier repo was frozen on October 12, 2026 and is kept as a
private reference. Pieces move here one at a time, checked for private
material first; each move is logged in [PLAN.md](PLAN.md).
