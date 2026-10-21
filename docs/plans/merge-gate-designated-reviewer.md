# Merge Gate: A Plan's Designated Reviewer Can Satisfy The Gate (Option 2a)

Written October 20, 2026 at the owner's request. Session name:
`OC-261020-designated-reviewer-plan`. Revised the same day after Codex's
first review (three P1s, written in as requirements; see "Codex Round 1").
This is a plan only. Building it needs
the owner's explicit approval, and the build changes `.github/`, which only
the owner approves. Background: [merge-gate.md](merge-gate.md).

## Why

Two rules collide. AGENTS.md says no agent reviews its own work. The merge
gate says a pull request merges only after Codex's clean review
(`codex-approved`). When Codex is the builder, as for the household lists and
habit grid engines, the only way to pass the gate is for Codex to review its
own work, which the first rule forbids. Those plans name Claude as the
reviewer, but the gate can't see Claude's verdict.

**Stopgap (option 2b, in force now):** Codex still gates those pull requests,
and Claude reviews them as well. That keeps the gate intact but leans on the
builder reviewing itself. Option 2a ends that: for paths a merged plan assigns
to a designated reviewer, that reviewer's clean verdict counts in place of
Codex's.

## Why This Is Not A Way Around The Gate

The gate exists so that GitHub, not an agent's word, proves a different
reviewer looked at the exact code being merged. 2a keeps every part of that:

- It changes **who counts as the reviewer**, and only where the owner has
  said so in a protected file. It doesn't loosen what counts as a clean
  result, skip tests, or touch code-owner approval.
- The verdict must come from an account no builder can sign in as, bound to
  the exact commit, posted after review. Builders can't produce it.
- The status is still computed from `main`'s copy of the script and posted by
  GitHub Actions. No pull request can change how its own gate is judged.
- Turning it on requires the owner to approve the build, and each module's
  entry in the map is a separate owner-approved change.

Without 2a, the honest options are self-review (against the rules) or the
owner merging by hand (what the gate was built to end).

## The Signal: How The Reviewer's Verdict Is Recorded

Every builder signs in as `cloudwork-bot`, so anything the bot posts could
come from any builder and can't count. **Recommended:** a pull request
comment from the owner's account (`CloudworkSystems`), where Claude sessions
act today, carrying a machine-readable marker:

```
Designated review: clean for 0123abc (full commit below).
<!-- oc-designated-review:v1 {"verdict":"clean","sha":"<40-character head>","reviewer":"claude"} -->
```

A comment, not a pull request review, because a review event runs the pull
request's own copy of the workflow, and a comment event runs `main`'s. The
gate accepts a marker only if all of these hold:

1. Its author is `CloudworkSystems`, and the pull request was **not** opened
   by `CloudworkSystems`. A Claude session that opens a pull request as the
   owner can therefore never clear its own work with this marker.
2. The comment was never edited. (Anyone with Write access can edit other
   people's comments, so an edited marker could carry the bot's words under
   the owner's name.)
3. The JSON parses, `verdict` is `clean`, `sha` equals the full current head,
   and `reviewer` matches the map entry (below).
4. It is posted strictly later than every findings marker that cancels it
   (next section).

### Findings Markers

The reviewer records findings the same way, so the gate can see them:

```
Designated review: 2 findings on 0123abc (details below).
<!-- oc-designated-review:v1 {"verdict":"findings","sha":"<40-character head>","reviewer":"claude","count":2} -->
```

- **Schema:** the same `v1` marker; `verdict` is `findings`; `sha` is a full
  40-character commit; `reviewer` names the reviewer; `count` is a whole
  number of 1 or more. The findings themselves are written in plain text in
  the same comment (or as linked review comments).
- **Author:** only owner-account markers are read; markers from any other
  account are ignored either way, so a builder can't block or clear anyone.
- **Fails closed:** an owner-account findings marker blocks even if edited or
  malformed. Only clean markers need to be unedited and well-formed.
- **What it cancels:** a findings marker naming the current head, **or** any
  findings marker posted after the latest clean marker whatever commit it
  names, cancels every earlier clean marker. A clean marker counts only if it
  names the head and comes strictly later than all of those; a tie in time
  fails closed (same as Codex today).

### Instructions For The Designated Reviewer

Written into each module plan that names a designated reviewer:

1. Review the exact head commit; put its full SHA in the marker.
2. Post findings with a `findings` marker. **Ordinary comments don't count as
   findings**: the gate can't read prose, so an unmarked finding doesn't
   block the merge.
3. After the builder fixes them, review the new head and post a fresh marker
   (`clean` or `findings`). Never edit an old marker; post a new one.
4. Post markers from the owner account only, and never on a pull request
   that account opened.

**Risks.** The owner account is admin, so anything signed in as the owner
(the owner himself, any Claude session) can post the marker; the marker shows
"owner account", not "Claude". That's acceptable because those parties could
already change branch protection, so 2a gives them nothing new; the rule that
only the designated reviewer posts it is a written rule, like today. The real
break comes when Claude moves to `cloudwork-bot`: its markers would then be
indistinguishable from any builder's. When that happens, 2a's map is emptied
until a separate signal exists.

**Alternatives considered:**

- *A separate reviewer-only account.* Cleanest identity, but GitHub's terms
  allow one free machine account per person, and `cloudwork-bot` is it.
- *The owner's own approval as the designated review.* Strongest (a human),
  but it puts the owner back on every module pull request, which the gate was
  built to avoid. It stays available: his own marker counts.
- *A GitHub App for the reviewer.* Free and within the terms. Its key would
  have to live somewhere builders on the same Mac can't read, which is hard
  to guarantee today. Best long-term answer once Claude leaves the owner's
  account.

**Recommendation:** the owner-account marker now; a reviewer GitHub App when
Claude moves to the bot.

## Which Pull Requests: The Map

A new file, `.github/designated-reviewers.json`, maps paths to reviewers.
`.github/` is code-owner protected, so only the owner can change it; labels
won't do, because Write users can add them. Example entry:
`{ "plan": "docs/plans/household-lists-engine.md", "reviewer": "claude",
"paths": ["packages/household-lists/**"] }`.

- **Read from `main` only**, so a pull request editing the map can't affect
  its own result.
- **Full coverage or nothing.** Every changed path must match one entry:
  added, changed and deleted files, and **both the old and new names** of a
  rename. One unmapped path, or paths from two different entries, and the pull
  request falls back to Codex.
- **New files** are covered when they fall under a mapped folder; that's why
  entries are whole folders, not file lists.
- **Never the rules.** The loader rejects entries that reach `.github/`,
  `AGENTS.md`, `CLAUDE.md`, `PLAN.md`, `docs/plans/` or `docs/decisions.md`.
- If GitHub can't list every file (its limit is 3,000), Codex only.

### STATUS.md In Builder Pull Requests

Builder pull requests usually change their package and one line of
`STATUS.md`. Under full coverage, that line alone would send them back to
Codex. Two ways to handle it:

- **(A) Recommended: builders leave `STATUS.md` alone** on 2a pull requests;
  the planning session updates it in its own pull request after its check.
  A 2a pull request that touches `STATUS.md` simply falls back to Codex
  (fail closed, nothing breaks). Why: the gate stays a plain path match. No
  diff-reading code in a security check, and no way for a builder to word
  its own status. The planning session already checks each outside build
  and switches on auto-merge, so the status update fits there. Cost: one
  small extra docs pull request per milestone. This narrows AGENTS.md's
  "update STATUS.md in any pull request that changes a part's state" for 2a
  pull requests; that wording change waits until #83 merges.
- **(B) A shared-path exception:** each map entry names its module's
  `STATUS.md` paragraph (for example, the line starting
  `**Household lists engine**`), and the gate allows a `STATUS.md` change
  only when every changed line falls inside that paragraph. This saves the
  extra pull request but adds diff parsing to the gate. It breaks if the
  paragraph's heading is reworded, and it lets the builder state its own
  progress.

## Gate Logic

`codex-approved` turns green when **either** Codex is clean on the head
(today's rule, unchanged) **or** the pull request is fully covered by one map
entry, the matching valid marker exists for the head, and Codex has no
findings on the head. A new commit changes the head, so the old marker no
longer matches and the status goes back to pending. A marker from the wrong
account, for an old commit, edited, or malformed is ignored, never success,
and the status description says why (for example, "Marker ignored: not for
the current commit").

**The status name stays `codex-approved`.** Branch protection requires that
exact name from GitHub Actions. Renaming it would mean changing `main`'s
protection, with a window where the old name is gone and nothing new is
required. Keeping it means no settings change; the description says which path
passed ("Designated reviewer (claude) clean on 0123abc").

The workflow's comment filter today skips everything not from Codex; it will
also let through owner-account comments that contain the marker, and the
sparse checkout adds the map file.

## Tests To Write

Pure-function tests beside the existing gate tests:

1. Happy path: fully mapped pull request, valid owner marker on the head.
2. Forged marker from `cloudwork-bot` (and a look-alike login): ignored.
3. Stale marker for the previous commit after a new push: pending.
4. Mixed paths (one mapped, one not) with a valid marker: Codex only.
5. A rename from a mapped to an unmapped path: Codex only.
6. Owner-account comment without the marker, or with a broken marker: pending.
7. Edited marker comment: ignored.
8. Owner-opened pull request with an owner marker: ignored.
9. A later `findings` marker, or Codex findings on the head: pending.
10. A map entry reaching `.github/` or `docs/plans/`: rejected.
11. Every existing Codex test still passes unchanged.
12. A findings marker on the head after a clean one: pending; a new clean
    marker after it: success.
13. A findings marker naming an older commit, posted after the clean marker:
    pending. A findings marker at the same second as a clean one: pending.
14. An edited or malformed owner-account findings marker: still blocks.
15. A findings marker from `cloudwork-bot`: ignored (neither blocks nor
    clears).
16. A mapped pull request that also touches `STATUS.md`: Codex only (under
    recommendation A).
17. Staging: `candidate_ref` from a non-owner actor, on a non-`main` run, or
    against a pull request not based on `gate-test` is refused, and it never
    posts `codex-approved`.

## Rollout

1. **One build pull request, opened as `cloudwork-bot`**, so code-owner
   review holds (scratch test 3). Built by Claude; Codex reviews it under the
   normal rule.
2. **Workflow file:** the bot token has no `workflow` scope, so it can push
   the scripts, tests and map but not `.github/workflows/codex-approved.yml`.
   That one commit is pushed by the owner's login (the owner, or Claude
   acting as him with his go-ahead) to the same branch.
3. **Dry run of the candidate code before merge.** `codex-approved.yml`
   always checks out `main`'s scripts, so dispatching it on the build branch
   would test the old gate. Instead, a small owner-approved staging change
   goes into `main` first (its own pull request, before the build):
   - a `candidate_ref` input on the existing manual dispatch, honoured only
     when the event is `workflow_dispatch`, the run is on `main`
     (`github.ref` is the default branch), and `github.actor` is
     `CloudworkSystems`. Any other run ignores it. Ordinary pull request
     events never read it, so **no pull request can pick its own gate code**;
   - it runs only against a named scratch pull request whose base is
     `gate-test`, and refuses any other;
   - the candidate scripts run in a job with a **read-only** token and only
     print a verdict. A second job, using `main`'s code, posts that verdict
     as a status named `codex-approved-candidate`, which branch protection
     doesn't require. Candidate code never holds a token that can set a
     status, so it can't post `codex-approved` on anything.

   The owner (or Claude acting as him with his go-ahead) then dispatches it
   against scratch pull requests covering tests 1 to 4, 6, 8 and 12 to 14, and
   compares results with the expected ones.
4. **Merge with an empty map**, so 2a is inert; the owner approves.
5. **First real entry** (household lists) in its own small pull request the
   owner approves. Until then, 2b stays in force.

## Open Questions For The Owner

1. **Signal:** owner-account marker now, reviewer GitHub App later?
   *Recommend yes.*
2. **When Claude moves to the bot account:** empty the map (back to 2b) until
   the reviewer App exists? *Recommend yes.*
3. **Codex findings on a 2a pull request:** if Codex comments anyway, do its
   findings still block? *Recommend yes; fails closed.*
4. **Mixed pull requests:** fall back to Codex only, rather than requiring both
   reviewers? *Recommend Codex only; simpler, and builders can split PRs.*
5. **Bad markers:** leave the status pending with a reason, rather than red?
   *Recommend pending; red stays stuck until the next event and adds noise.*
6. **Edited Codex comments:** the same editing gap applies to Codex's clean
   comment today. Close it with the same "never edited" rule? *Recommend yes,
   in its own small pull request.*
7. **STATUS.md in builder pull requests:** builders leave it alone and the
   planning session updates it (A), or a per-module paragraph exception (B)?
   *Recommend A: simpler and safer gate code, at the cost of one small docs
   pull request per milestone.*
8. **Staging input after the build:** keep `candidate_ref` for future gate
   changes, or remove it? *Recommend keep: it's owner-only, posts a status
   nothing requires, and the next gate change needs it too.*
9. **Habit grid plan wording:** it says the gate is Codex's 👍 though Codex
   builds it. *Recommend aligning it with the household lists plan after #83.*

## Codex Round 1 (P1s Written In As Requirements)

1. **STATUS.md:** builders leave it alone on 2a pull requests, and the
   planning session updates it (STATUS.md In Builder Pull Requests).
2. **Dry run must test the candidate code:** an owner-only staging input on
   `main` posts `codex-approved-candidate` (Rollout, step 3).
3. **Findings marker:** schema, author and cancellation rules, plus
   reviewer instructions and tests (Findings Markers; tests 12 to 15).

## What Stays The Same

- `tests` is still required on every pull request.
- Code-owner approval on protected paths, dismissed on new commits.
- Codex is still the reviewer for everything not in the map.
- Enforcement for admins, the hourly backstop, and the status coming only
  from GitHub Actions.
- Outside builders don't switch on auto-merge; the planning session does,
  after its check.
