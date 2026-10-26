# Risk Review: Escalate By What A Change Does, Not Only Where It Lives

Status: Draft (Oct 26): plan only; the code follows in a separate pull request.

Written October 26, 2026 at the owner's request ("Do it"), after comparing a
video on Claude Code "software factories" with how this repo already works.
Session: thread "Compare Recall card to our factory". **Builder:** Claude
(cloud, `cloudwork-bot`). **Reviewers:** Codex and Gemini (Gemini as the
independent review; a fresh Claude review stands in until it posts); the
owner approves, since both pull requests touch protected paths. **Finish
line:** the code pull request merges with `tests` passing, the first pull
request that adds an unlisted outside host or a new dependency is held with a
risk comment until the owner approves it, and the first independent review
after the merge posts the privacy checklist (then the status becomes Built).

## Why

Most of what the video showed, this repo already does: plans before builds,
separate builders and reviewers, a capped review loop with a judge, worktrees
for parallel lanes (docs/plans/scale-up.md), state in STATUS.md and issue #52.
Two ideas were new here:

1. The video's approver escalates by **what** a change does (billing, access),
   wherever it shows up in the code. Our gate escalates only by **where**:
   protected paths in `.github/CODEOWNERS`. A package outside those paths can
   start sending data to a new host, or pull in a new dependency, and merge
   without the owner ever seeing it.
2. The video runs **specialist reviewers** (security, UX, UI, code). Our
   reviewers are generalists. Privacy is this product's core promise, and no
   review is asked to check it on purpose.

## Two Changes

### 1. A Risk Hold In `codex-approved` (Deterministic)

A new step in the existing `codex-approved` workflow reads the pull request's
diff through the API (it still never checks out pull request code) and looks
only at **added lines**, for these signals:

| Signal | What counts |
| --- | --- |
| New outside host | An `http://` or `https://` URL, or a WebSocket URL, whose host isn't in the allowlist below. Hosts in comments, docs (`*.md`) and test fixtures that are clearly invented (`example.com`, `example.org`, `*.invalid`, `*.test`, `localhost`, `127.0.0.1`) don't count. |
| New dependency | A new entry under `dependencies`, `devDependencies` or `optionalDependencies` in any `package.json`; a new `.package(` in any `Package.swift`; a new pin in any `Package.resolved`. A version bump of an existing dependency doesn't count. |
| New Mac permission | An added key in an `*.entitlements` file, or an added `NS…UsageDescription` key in an `Info.plist`. |
| New outside model or API key | An added string that names an environment variable or secret ending in `_API_KEY`, `_TOKEN` or `_SECRET`, outside `.github/`. |

When any signal fires, the workflow:

- holds `codex-approved` pending, with the description "Risk hold: owner
  approval needed (see comment)", the same way the owner-opened hold already
  works (`withOwnerOpenedHold` in `.github/scripts/codeowners.mjs`);
- posts one comment, as `github-actions[bot]`, listing each hit with its file
  and line, and edits that comment (never adds a second) when the hits change;
- adds the label `needs-owner: risk`, so the `owner-queue` workflow lists the
  pull request on issue #52.

The hold clears when the owner (`CloudworkSystems`) approves the pull
request's **head commit**, or when a later commit removes every hit. An
`owner-accepts-findings` note does not clear it: that note accepts Codex
findings, not risk.

**The allowlist.** `.github/risk-allowlist.json` lists hosts and dependencies
the owner has already accepted, so he is asked about each one once. It sits
under `.github/`, a protected path, so only a pull request the owner approves
can change it. The workflow reads it from `main`, never from the pull
request. The code pull request seeds it with the hosts and dependencies
already on `main` at that time, listed in the pull request for the owner to
check.

**Why deterministic.** A pattern match can't be talked out of a hold by text
in the diff, and it costs nothing per run. It will miss things (a host built
from parts at run time); the second change covers what a pattern can't see.

### 2. A Privacy And Security Checklist In The Independent Review

The independent review already happens on every Claude-built and Codex-built
pull request. It gains a fixed checklist, answered in one block at the end of
the review comment, so it adds no review round:

1. **Data leaving the device.** Does anything new send the owner's data, or
   data about him, to a host, model or service? If so, which, and does a plan
   allow it?
2. **Secrets.** Any key, token or credential in code, logs, test output or
   files? Anything that should be in Keychain but isn't?
3. **Real personal data.** Any real names, emails, phone numbers, chats or
   records in tests, samples or docs (AGENTS.md: replace with invented data)?
4. **Storage.** Does anything new write private data to disk outside the
   protected store, or to a place backups or sync would pick up?
5. **Permissions.** Does the change ask for a new Mac permission or widen
   what an agent may do?

Each answer is "no", or "yes" with the file and line. Any "yes" that no plan
allows is a P1 for that review. If the reviewer thinks the owner should see
it even when a plan allows it, it ends the block with the line
`risk-escalate: <one-line reason>`. The coordinator doesn't switch on
auto-merge while that line stands on the latest commit, and puts the pull
request on issue #52 with the label `needs-owner: risk`. Only the owner's
approval of the head commit clears it.

The triage judge (docs/plans/codex-triage.md) gains one rule in its prompt: a
finding about data leaving the device, a secret, real personal data or a new
permission is always `real`, never a nit.

## What Changes Where (Code Pull Request)

- `.github/scripts/risk-check.mjs`: the diff scan and the hold, with tests
  under `.github/scripts/tests/` built on invented diffs.
- `.github/scripts/codex-approved.mjs`: calls the risk check after the
  owner-opened hold.
- `.github/risk-allowlist.json`: seeded as above.
- `.github/scripts/codex-triage.mjs`: the judge rule above.
- `AGENTS.md`: the checklist and `risk-escalate` line, under "Gemini
  reviews", and one line in Review Guidelines pointing to this plan.
- `.github/scripts/owner-queue.mjs`: list `needs-owner: risk` pull requests
  under their own heading, if it doesn't already pick up the label.
- STATUS.md and this plan's status line.

## Risks

- **Too many holds.** Every hold is an ask of the owner, who wants as few as
  possible. The allowlist means each host or dependency is asked about once;
  version bumps, docs and invented test hosts don't count. After two weeks,
  count holds and how many the owner approved without change; if most were,
  narrow the signals.
- **Missed risks.** The scan sees literal text only. The checklist and the
  judge rule are the backstop, and neither is a guarantee.
- **Gemini ignores the checklist.** Gemini reads AGENTS.md but may not answer
  the block. Until it does reliably, the coordinator asks for the checklist
  in a `/gemini review` comment from `cloudwork-bot`, or a fresh Claude
  review answers it.
- **Who posts the hold comment.** It posts as `github-actions[bot]`, the same
  account and the same exposure as the triage judge's verdicts.

## Not Doing

- An LLM approver that decides to merge, as in the video. The merge stays
  with the gate and the owner.
- Splitting review into separate security, UX and UI agents with their own
  rounds. Review rounds are already the slowest part of this system; the
  checklist rides on the review that already happens.
- Post-launch monitoring (Sentry and similar). Nothing ships to users yet;
  revisit when something does.
