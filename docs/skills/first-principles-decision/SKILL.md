---
name: first-principles-decision
description: Use for a big decision that costs money or sets direction, when the person says "run first principles on X" or asks to rethink something from its real limits. Lists the assumptions, finds the true minimum cost from sourced facts, ranks the gaps, and returns a bold and a safe option with risks and a first 30-day step. Not for everyday coding or small choices.
---

# First-Principles Decision

A way to take one big decision apart down to what is actually fixed, and
rebuild it from there. Every number comes from a source file, and a separate
reviewer checks the reasoning against that file alone.

## When To Use It

Use it when the person asks for it ("run first principles on X") or names a
decision that spends real money, takes weeks of work, or sets direction, such
as pricing a service, paying for a server, or choosing between two ways of
building something.

Don't use it for everyday coding, small purchases, or questions with one
obvious answer. If the decision is small, say so in one line and answer it
directly instead.

## Ground Rules

- **Never invent a number.** Every figure is either taken from a source in the
  sources file, worked out from figures that are, or labeled as a guess. If a
  figure can't be found, write `unknown` and say what would find it.
- **Keep three kinds of statement apart.** A **fact** has a source and a date.
  An **estimate** is worked out from facts, with the working shown. A
  **guess** is anything else, and is labeled as one.
- **Ask first** before sending an email or message, publishing anything,
  spending money (including paid searches or API calls beyond the normal
  session), or reading or sharing private data (the person's mail, files,
  finances, clients or family). Say what you want to do and why, then wait.
- **No scripts.** This skill is instructions only. It does not run code.
- **Small models:** do one step at a time, write its result down, then move
  to the next. Don't hold the whole analysis in your head.

## Step 0: Pin Down The Decision

Write one sentence: "The decision is whether to ___, by ___ (date), within
___ (budget or limit)." If the person's ask leaves out the deadline, budget
or options, ask one question to fill the biggest gap, then go on. If they
don't answer, state your assumption and carry on.

## Step 1: List The Assumptions

List everything behind how this is done today, or how people normally do it.
Tag each one:

- **Fact**: true whatever anyone thinks (a law, a price on a published page,
  a measured time). Needs a source.
- **Habit**: done this way because it always has been.
- **Opinion**: someone's belief or preference, including the person's own.

Aim for 8 to 15. Habits and opinions are where the room to move is, so don't
skip them.

## Step 2: Find The Real Limits

Choose the set of limits that fits the problem:

- **Physical things** (3D prints, furniture, construction, hardware):
  material, energy, machine time, labor time, cost per part.
- **Software and services** (apps, subscriptions, a local service business):
  time, money, trust, attention, risk.
- **Both** (for example an AI-to-Blender-to-3D-printer pipeline): use both
  sets and say which limit belongs to which part.

Add a limit only if the problem clearly has one the set misses (a legal rule,
a deadline someone else sets), and say why.

For each limit, write its **true minimum**: the lowest it could be if only
facts held and every habit were dropped. Give each minimum a source and the
date it was checked, or mark it `unknown`. Record every fact in the sources
file (below) as you go.

## Step 3: Rank The Gaps

For each limit, compare today's cost (or the usual cost) with the true
minimum. The gap is the difference. Rank the gaps from biggest to smallest,
in money or time where you can, and say for each one which habit or opinion
from Step 1 keeps it open.

## Step 4: Two Options

- **Bold option:** closes the biggest gaps, even if it breaks habits.
- **Safe option:** closes the gaps that can be closed cheaply and reversibly.

For each, give what it costs, what it saves, how long it takes, and whether
it can be undone.

## Step 5: Stress Test

For each option, write:

- **What breaks first**: the weakest assumption it rests on.
- **What a skeptic would say**: the strongest honest objection, in one or two
  sentences.
- **How to test it cheaply**: a small, quick check that would show whether it
  holds before committing.

## Step 6: Check Every Number

Go through every number in Steps 2 to 5 and mark it against the sources file:

- **PASS**: the source says this, and the date is recent enough to trust.
- **FAIL**: the source says something else, or the working is wrong. Fix it
  or drop it.
- **BLOCKED**: no source could be found or reached. Keep it only as a guess.

## Step 7: Hand Off For Review

The facts and the reasoning are checked by different reviewers:

1. Any model may gather facts. Each one goes into the sources file.
2. A **separate reviewer** (a fresh session that didn't do the analysis, on a
   different model where one is available) reads only the sources file and
   the draft verdict. It checks that every PASS is backed by the file, that
   no estimate hides a guess, and that the options follow from the gaps. It
   adds nothing from its own knowledge as fact.
3. Fold in its findings, and note any it raised that you didn't fix and why.

If no separate reviewer is available, say so plainly at the top of the
verdict: "Not independently reviewed."

## The Sources File

Keep one sources file per decision, named
`first-principles-<short-topic>-sources.md`, in the person's working folder
(never in a public repository if it holds private facts). One row per fact:

```markdown
| # | Fact | Value | Source (link or document) | Checked on | Gathered by |
|---|------|-------|---------------------------|------------|-------------|
| 1 | Example: monthly price of the basic plan | $20 | https://example.com/pricing | 2026-10-28 | model or person |
```

A fact without a source and a date doesn't go in the file. Put it under a
`Guesses` heading at the bottom instead.

## What To Return

One short page, in this order:

1. **Verdict**: the recommendation in two or three sentences, and which
   option it picks.
2. **Ranked gaps**: a short table: limit, today, true minimum, gap, what keeps
   it open.
3. **Bold option** and **Safe option**: each with cost, savings, time, risks
   (from Step 5) and whether it can be undone.
4. **First 30-day step**: one concrete action that tests the chosen option
   cheaply, with what result would change the plan.
5. **Checks**: counts of PASS, FAIL and BLOCKED, the BLOCKED items listed, and
   whether the separate review ran.

Mark every figure on the page as fact, estimate or guess. Link the sources
file. Keep the page to about one screen; detail lives in the sources file.

## Credit

The idea of a first-principles prompt for decisions came from a public prompt
card shared by @0xPontiuz. This skill is written fresh in its own words and
adds the sources file, the separate reviewer and the limit sets.
