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
changes through the API (it still never checks out pull request code; see
"Fail closed" below for how) and looks only at **added lines**, for these
signals:

| Signal | What counts |
| --- | --- |
| New outside host | An `http://` or `https://` URL, or a WebSocket URL, whose host isn't in the allowlist below. Hosts in docs (`*.md`) don't count, and neither do clearly invented hosts anywhere (`example.com`, `example.org`, `example.net`, `*.example`, `*.invalid`, `*.test`, `localhost`, `127.0.0.1`, and any subdomain of these, such as `api.example.com`). Code comments are not exempt. |
| New dependency | A new entry under `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies` or `bundleDependencies` in any `package.json`; a new `.package(` in any `Package.swift`; a new pin in any `Package.resolved`. A version bump of an existing dependency doesn't count. |
| New Mac permission | In any `*.entitlements` file or `Info.plist`, compared parsed at the merge base and at the head commit (like the manifests below, not from added lines): a new key, a value changed from `false` to `true`, a new entry in an existing array (an app group, a path, a domain), or a new `NS…UsageDescription` key. A removed key or a value turned off doesn't count. |
| New outside model or API key | An added string that names an environment variable or secret ending in `_API_KEY`, `_TOKEN` or `_SECRET`, outside `.github/`. |

When any signal fires, the workflow:

- holds `codex-approved` pending, with the description "Risk hold: owner
  approval needed (see comment)", the same way the owner-opened hold already
  works (`withOwnerOpenedHold` in `.github/scripts/codeowners.mjs`);
- posts one comment, as `github-actions[bot]`, listing each hit with its file
  and line, and edits that comment (never adds a second) when the hits change;
- adds the label `needs-owner: risk`, so the `owner-queue` workflow lists the
  pull request on issue #52.

**Fail closed when the diff can't be read.** GitHub's pull request files
API leaves out the patch for large and some generated files (a big
`package-lock.json`, a bundled `.js`, a long `Package.resolved`) and stops
listing files after 3,000. It can also return a patch that is present but
cut short. So the scan never trusts a patch as complete: for every changed
text file it fetches the whole file at the merge base (from the compare
API's `merge_base_commit`, not `main`'s tip, so a branch that is behind
isn't held for lines `main` removed) and at the head commit
through the contents API and works out the added lines itself. A file the
files API marks as added is empty at the merge base, a removed file is empty
at the head, and a renamed file is read at its old path at the merge base;
none of those is an error. A file it can't fetch whole for any other reason
(too large for the contents API, or an error), or a file
list that may be cut short, counts as a hit ("couldn't read the diff for
`<file>`"), unless the file is binary by extension (images, fonts, audio,
video). For
`package.json`, `Package.swift` and `Package.resolved`, the dependency
signal (and for `*.entitlements` and `Info.plist`, the permission signal)
compares the parsed file at the merge base and at the head commit, fetched
through the contents API, instead of reading the patch, so a new entry split
across lines or hidden in an unreadable patch is still caught. The code pull
request's tests cover both cases with invented data.

The hold clears when the owner (`CloudworkSystems`) approves the pull
request's **head commit** after the hold comment last changed (it is posted,
or edited because the hits changed), or when a later commit removes every
hit. An approval submitted before that, for example for a protected path
while the scan was still running, doesn't count, since he hadn't seen the
hits yet. An
`owner-accepts-findings` note does not clear it: that note accepts Codex
findings, not risk. `codex-approved` doesn't run on review events (on
purpose, see the header of `codex-approved.yml`), so after the owner
approves, the hold lifts at the workflow's next run: the hourly run or the
next comment, whichever comes first. The hold comment says so. The run
that clears the hold also removes the `needs-owner: risk` label, so issue
#52 lists only pull requests that still need the owner.

**Owner-opened pull requests.** GitHub doesn't let an author approve his own
pull request, so a held pull request opened from the owner's account can't
be released by approval. It is handled like the existing owner-opened hold
on protected paths (docs/plans/merge-gate.md): the hold comment says so, and
the work is reopened from `cloudwork-bot`, where the owner can approve it.
No other owner signal clears a risk hold.

**The allowlist.** `.github/risk-allowlist.json` lists hosts and dependencies
the owner has already accepted, so he is asked about each one once. It sits
under `.github/`, a protected path, so only a pull request the owner approves
can change it. The workflow reads it from `main`, never from the pull
request. The code pull request seeds it with the hosts and dependencies
already on `main` at that time, listed in the pull request for the owner to
check.

**How an approval sticks.** The hold comment tells the builder to add each
hit to `.github/risk-allowlist.json` in the same pull request. That edit is
on a protected path, so the owner's approval of the head commit covers both
the change and the new allowlist entries, and once it merges later pull
requests using the same host or dependency aren't held. If the owner wants a
one-off yes instead, the builder leaves the entry out and he is asked again
next time. The risk check still reads the allowlist from `main` only, so a
pull request's own additions never clear its own hold; only the approval
does.

**Why deterministic.** A pattern match can't be talked out of a hold by text
in the diff, and it costs nothing per run. It will miss things (a host built
from parts at run time); the second change covers what a pattern can't see.

### 2. A Privacy And Security Checklist In The Independent Review

Every pull request already gets a second look besides Codex's: the
independent review on Claude-built and Codex-built work, and the
coordinator's plan check on GrokBot-built work. Both gain a fixed checklist,
answered in one block at the end of that review or plan-check comment, so it
adds no review round. Plan and other docs-only pull requests, which today
get only Codex's review, also get the checklist block from an agent that
didn't write them (the independent reviewer, answering the checklist only,
not a full review), and the coordinator doesn't switch on auto-merge until
it is posted for the latest commit. On a GrokBot pull request the coordinator doesn't pass
the plan check, or switch on auto-merge, until the block is posted for the
latest commit:

1. **Data leaving the device.** Does anything new send the owner's data, or
   data about him, to a host, model or service? If so, which, and does a plan
   allow it?
2. **Secrets.** Any key, token or credential in code, logs, test output or
   files? Anything that should be in Keychain but isn't?
3. **Real personal data.** Any real names, emails, phone numbers, chats or
   records in any file the pull request adds or changes: source,
   configuration, tests, samples or docs (AGENTS.md: replace with invented
   data)? Contact details the owner chose to publish (such as the business
   address on the public site) are listed in the answer but aren't a
   finding.
4. **Storage.** Does anything new write private data to disk outside the
   protected store, or to a place backups or sync would pick up?
5. **Permissions.** Does the change ask for a new Mac permission or widen
   what an agent may do?

Each answer is "no", or "yes" with the file and line. A "yes" to question 2
(a secret in code, logs, test output or files) or question 3 (real personal
data in any file) is always a P1, whatever any plan says:
AGENTS.md keeps secrets in Keychain only and private records and personal
details out of every file. Any other "yes" that no plan allows is a P1 for
that review. If the reviewer thinks the owner should see
it even when a plan allows it, it ends the block with the line
`risk-escalate: <one-line reason>`. The coordinator doesn't switch on
auto-merge while that line stands on the latest commit, and puts the pull
request on issue #52 with its own label, `needs-owner: risk-escalate`
(separate from the hold's label, so clearing one never drops the other).
Only an approval
of the head commit that the owner submits **after** the `risk-escalate`
comment clears it; an approval he gave before (for example, for a protected
path) doesn't count, since he hadn't seen the escalation yet. When it clears,
the coordinator removes `needs-owner: risk-escalate`; the workflow never
touches that label. On a pull request opened from the owner's account, which he can't
approve, an escalation is handled like the owner-opened hold above: the work
is reopened from `cloudwork-bot`, where he can approve it.

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
  reviews" and in the coordinator's plan check for GrokBot work, and one
  line in Review Guidelines pointing to this plan.
- `.github/scripts/owner-queue.mjs`: list pull requests labeled
  `needs-owner: risk` or `needs-owner: risk-escalate` under one risk heading (it reads no labels today).
- STATUS.md and this plan's status line.

## Risks

- **Too many holds.** Every hold is an ask of the owner, who wants as few as
  possible. The allowlist means each host or dependency is asked about once;
  version bumps, docs and invented test hosts don't count. After two weeks,
  count holds and how many the owner approved without change; if most were,
  narrow the signals.
- **Missed risks.** The scan sees literal text only. The checklist and the
  judge rule are the backstop, and neither is a guarantee.
- **Gemini isn't posting yet.** As of October 26 Gemini Code Assist isn't
  set up on the repo, so the fresh Claude review that stands in for it
  (AGENTS.md) answers the checklist. Once Gemini posts, it may still skip
  the block; until it answers it reliably, a fresh Claude review keeps
  answering it.
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
