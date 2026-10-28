# Codex Triage: Ending Review Loops On Minor Findings

Status: In progress (Oct 24): built in this pull request, judge off until the owner adds the API key.

Written October 24, 2026 at the owner's request ("do the changes"). Session:
thread "Stop Codex review loops on nits". **Builder:** Claude (cloud,
`cloudwork-bot`). **Reviewers:** Codex and Gemini; the owner approves, since
it touches protected paths. **Finish line:** this pull request merges with the
gate tests passing, the owner adds the `ANTHROPIC_API_KEY` secret, and the
first pull request that reaches the judge gets a verdict comment and the
matching `codex-approved` result (then the status becomes Built).

## Why

Codex reviews every commit, and on several pull requests each fix drew new
P2 edge cases: #112 went about 15 rounds, #127 17. Each loop ended only when
the owner posted `owner-accepts-findings <sha>`. The owner wants those loops
to end without him, while real bugs still block.

## Two Changes

1. **Review guidelines in AGENTS.md.** A "Review Guidelines" section that
   Codex reads when it reviews: supported platforms only, what P1, P2 and P3
   mean here, plan and docs pull requests flag only P0 and P1, no re-raising
   answered findings. This should cut the loops at the source.
2. **A judge for what's left.** When a pull request still has only P2 and P3
   findings after three Codex rounds, the `codex-approved` workflow asks an
   independent model to rate each remaining finding as a real bug or a nit,
   with a confidence. If every finding is a nit with confidence 0.8 or more,
   `codex-approved` passes for that head commit.

## What "JEV" Turned Out To Be

The owner asked whether "JEV or something" could estimate how trivial the
findings are. JEV is a real tool: a small decision-only judge model from
TypeSafe AI that returns a label with probabilities and no written reasoning.
A recent paper (arXiv 2609.26550) reports it close to large models where a
verdict can be read off the text, and behind them where it must be worked
out, as in code. Deciding whether a code finding is a real bug is the second
kind, and using JEV would also mean a new account and key. So the judge here
is Claude (`claude-opus-5-5`, through the Anthropic API), called with plain
`fetch` like the rest of the gate's scripts. The judge sits behind one
function (`judgeFindings` in `.github/scripts/codex-triage.mjs`), so JEV can
be tried later, for example as a cheap first pass that hands unsure cases to
Claude.

The owner has a JEV account and asked how OpenAI's Decisions API compares.
Both are fast decision models: they return a label from a fixed set with
probabilities, not reasoning (OpenAI's runs on `gpt-6-luna` at
`POST /v1/decisions`; it reached general availability on October 22, 2026).
They're built for high-volume routing and classification where speed and cost
per call matter. Here the judge runs a few times a week, cost per call is
cents either way, and the hard part is working out whether a code edge case is
real, which is where the paper above finds decision models weakest. So a full
model reasoning over each finding fits better as the deciding judge. Neither
API's exact request schema could be checked from the session that wrote this,
so neither is wired in yet. If wanted, JEV goes in as a first pass: a
confident "real" from JEV blocks without asking Claude, anything else goes to
Claude as now.

## The Rule

`codex-approved` passes through the judge only when all of these hold for the
pull request's current head commit:

1. Codex reviewed the head and left findings (otherwise the normal Codex
   signals decide).
2. Codex has left findings on at least three different commits of this pull
   request, the head included.
3. Every finding on the head is P2 or P3, read from Codex's own priority
   badge. A P0 or P1, a finding with no readable priority, a Codex review with
   no readable findings, or more than eight findings: no judge.
4. Every finding comment is Codex's own and was edited by nobody else.
5. The pull request wasn't opened by the owner's account.
6. A judge verdict comment, posted by GitHub Actions (`github-actions[bot]`)
   and edited by nobody else, names this head and exactly these findings, was
   posted after the last finding, and rates every finding `nit` with
   confidence of at least 0.8.

The judge is told to answer `real` when unsure. Anything odd (an error, a
refusal, a missing or repeated finding, a malformed confidence) means no
verdict, and the check stays pending.

Nothing else changes: `tests` must pass, protected paths still need the
owner's approval, and the owner's `owner-accepts-findings` note still works.

## Where It Runs

Inside the existing `codex-approved` workflow, which runs only from `main`
and never checks out pull request code. Only runs for a single pull request
ask the judge; they share that pull request's concurrency group, so two runs
never ask at once (the hourly run over every pull request only reads posted
verdicts). Before the paid call it posts a claim comment, which it then edits
into the verdict, so a run that fails after the call never pays for it again
(only an error reply from the API, which bills nothing, releases the claim;
an answered but unusable call or a lost connection keeps it, and the check
stays pending until the next commit or the owner's note). Editing or deleting a verdict re-runs the
gate. It asks the judge at most once per head commit and set of findings, and records the verdict as a comment on the
pull request so everyone can read why it passed. To post that comment, the
workflow's token gains `issues: write` (it had `statuses: write` only).

The judge needs an Anthropic API key, stored as the repository secret
`ANTHROPIC_API_KEY`. That is a spending decision, so it is the owner's: until
he adds the secret, the judge is never asked and the gate behaves exactly as
before. Expected cost is a few cents per judged commit.

## Risks

- **Prompt injection.** The judge sees each finding's text and the lines of
  code it points at, which a builder writes. The prompt marks them as data,
  but a determined builder could try to talk the judge round. Limits: P0 and
  P1 findings never reach the judge, three rounds must pass first, protected
  paths still need the owner, and every verdict is posted for anyone to see.
- **Judge errors.** A judge can call a real bug a nit. The 0.8 confidence bar
  and "real when unsure" reduce this; the verdict comment makes each call
  reviewable, and any session that disagrees can raise it on the pull request.
- **Cost.** One request per judged head commit; no request without the secret.
- **Dismissed serious findings.** The judge sees only the head's findings, so
  it relies on Codex repeating anything still wrong. The review guidelines
  therefore let Codex drop an answered finding only if it is P2 or P3; a P0
  or P1 is raised again until the code fixes it or Codex agrees.
- **Who posts verdicts.** A verdict counts because `github-actions[bot]`
  posted it, and any workflow on a same-repo branch posts as that account.
  That is the same exposure the existing `codex-approved` status already
  has, so it adds no new hole.

## Follow-Ups

- Count how often the judge passes a pull request, and whether any judged
  nit later turned out to be a bug, after two weeks.
- Try JEV as a first pass if the owner wants to cut cost further.

## Revision, October 28, 2026: Only The Project's Own Builders

The repo is public, so anyone can open a pull request, and a judged pull
request puts its diff in front of the judge and spends the API key. Rule 5
now also requires that the pull request was opened by `cloudwork-bot` (every
agent's account) or by Codex's cloud builds (`chatgpt-codex-connector[bot]`),
from a branch in this repository rather than a fork. Anyone else's pull
request never reaches the judge; the normal Codex signals and the owner's
note still apply to it. The judge's prompt also stops calling the repository
private.
