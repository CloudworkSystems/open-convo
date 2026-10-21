# Merge Gate: A Plan's Designated Reviewer Can Satisfy The Gate (Option 2a)

Written October 20, 2026 at the owner's request. Session name:
`OC-261020-designated-reviewer-plan`. Revised the same day after Codex's
first, second and third reviews, and on October 21 after the fourth and
fifth (findings written in as requirements; see "Codex Rounds").
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
come from any builder and can't count. **Recommended:** a **pull request
review** (GitHub's "Comment" kind) from the owner's account
(`CloudworkSystems`), where Claude sessions act today, carrying a
machine-readable marker in the review's body:

```
Designated review: clean for 0123abc (full commit below).
<!-- oc-designated-review:v1 {"verdict":"clean","sha":"<40-character head>","reviewer":"claude"} -->
```

**Why a review, not a comment (Codex round 2).** Anyone with Write access,
the bot included, can delete a pull request comment, and deletion leaves no
trace. A builder could delete the reviewer's findings comment and the gate
would see only the earlier clean one. A submitted review can't be deleted by
anyone. A "Comment" review can't be dismissed either, and a dismissal of
any other kind shows in the timeline with who did it. GitHub also stamps each
review with the commit it was made on (`commit_id`), which nobody can edit.

The gate accepts a clean verdict only if all of these hold:

1. The review's author is `CloudworkSystems`, and the pull request was
   **not** opened by `CloudworkSystems`. A Claude session that opens a pull
   request as the owner can therefore never clear its own work.
2. Its state is `COMMENTED` (not an approval, so it never doubles as a
   code-owner approval).
3. The review body was never edited (GitHub's `lastEditedAt` is empty).
   Write users can edit other people's review bodies, so an edited verdict
   can't be trusted.
4. The marker parses, `verdict` is `clean`, `sha` **and** the review's
   `commit_id` both equal the full current head, and `reviewer` matches the
   map entry (below).
5. It was submitted strictly later than every findings review that cancels
   it (next section).

Markers in ordinary comments are ignored entirely: they could be deleted, so
they can neither clear nor block.

### Findings Reviews

The reviewer records findings the same way, as a review, so the gate can see
them and no one can erase them:

```
Designated review: 2 findings on 0123abc (details below).
<!-- oc-designated-review:v1 {"verdict":"findings","sha":"<40-character head>","reviewer":"claude","count":2} -->
```

- **Schema:** the same `v1` marker; `verdict` is `findings`; `sha` is a full
  40-character commit; `reviewer` names the reviewer; `count` is a whole
  number of 1 or more. The findings are written in the review body or as
  its inline comments (deleting an inline comment doesn't remove the review).
- **Author:** only owner-account reviews are read; reviews from any other
  account are ignored either way, so a builder can't block or clear anyone.
- **Fails closed:** an owner-account review that carries a findings marker
  blocks in any state, even if malformed. An owner-account review with a
  marker of either kind that has been **edited** also blocks for its commit,
  so editing a findings review into a clean one only keeps the gate shut.
- **Edited by someone else blocks, marker or not (Codex round 3).** Why: a
  builder could rewrite a findings review's body so the marker disappears,
  and a review with no marker would otherwise be ignored. So any
  owner-account review on a pull request that touches a mapped path, which
  **anyone other than the owner account** has ever edited, blocks that pull
  request, whatever it says now and whatever commit it was on. (Pull
  requests that touch no mapped path stay Codex-only; see Gate Logic.) The
  gate reads who edited it from GitHub's GraphQL edit history
  (`lastEditedAt`, `editor` and `userContentEdits` editors), the same way
  #88 checks Codex's comments in `codex-signal.mjs`: every revision must be
  present and made by `CloudworkSystems`. If the history can't be read in full (missing,
  partial, a deleted revision, or an editor GitHub no longer names), the
  review blocks. A review's edit history can't be erased, so nothing a
  builder does can unblock it; the work goes forward in a fresh pull
  request, and the owner decides what happens to the old one.
- **Can GitHub let a non-author edit a review at all?** GitHub's
  documentation says anyone with write access can edit other people's
  comments on pull requests, and a review's summary shows the same edit
  menu, so we assume yes for the bot. We haven't tried it on this repo, and
  the API's "update a review" call doesn't say it is author-only. The rule
  stays either way: if GitHub refuses such edits, it never fires; if it
  allows them, it closes the hole.
- **Dismissed findings still block** unless the timeline shows the owner
  account dismissed it. ("Comment" reviews can't be dismissed at all; this
  covers a findings review posted as "Request changes" by mistake.)
- **What it cancels:** a findings review on the current head, **or** any
  findings review submitted after the latest clean review whatever commit it
  names, cancels every earlier clean review. A clean review counts only if
  it is on the head and comes strictly later than all of those; a tie in
  time fails closed (same as Codex today).
- **Any later owner-account review cancels clean (Codex round 5).** Why:
  the reviewer might post findings as an ordinary review, or as inline
  comments, and forget or mistype the marker; the earlier clean verdict
  would then still count and the pull request could auto-merge with an
  open finding. So **any** owner-account review on the pull request
  submitted after the latest clean review cancels it, whatever its body,
  marker or inline comments, and whether it is on the same head or a later
  commit. Only a fresh clean review submitted after it passes again. (A
  tie in time still fails closed.)

### How Review Events Reach `main`'s Code

The plan first chose comments because a `pull_request_review` event runs the
pull request's own copy of a workflow. The fix keeps every decision on
`main`'s code:

- A new workflow, `designated-review-ping.yml`, runs on
  `pull_request_review` (submitted, edited, dismissed). It has **no
  permissions**, checks out nothing and does nothing but finish. It is only
  a doorbell.
- `codex-approved.yml` adds a `workflow_run` trigger on that workflow's
  completion. `workflow_run` always runs the default branch's copy, which
  checks out `main`'s scripts exactly as today. It ignores the event's
  contents and rechecks every open pull request.
- If the doorbell doesn't ring (an old branch without the file, or an
  outage), the hourly backstop catches it within the hour. A missed ring can
  only delay a green result. It can't produce one, because every verdict is
  read fresh from GitHub. Builders can't change either workflow file (no
  `workflow` scope; `.github/` is owner-protected).

**Rejected alternative:** a tombstone the gate keeps (for example, a status or
file recording every findings verdict it has seen). It needs storage only
Actions can write and adds moving parts, while reviews are already permanent.

### Instructions For The Designated Reviewer

Written into each module plan that names a designated reviewer:

1. Review the exact head commit; put its full SHA in the marker.
2. Submit every verdict as a **review** of kind "Comment" with the marker.
   Findings go in a `findings` review. **Ordinary pull request comments
   (not reviews) don't count as findings**: the gate can't read prose, so
   a finding left only as an ordinary comment doesn't block the merge.
3. After the builder fixes them, review the new head and submit a fresh
   review (`clean` or `findings`). Never edit a review; submit a new one.
4. **If you post anything after clean, post clean again when you're
   satisfied.** Any review you submit after a clean one, even a quick note
   or an inline comment without a marker, cancels that clean verdict, and
   the pull request waits until a new clean review comes after it.
5. Submit reviews from the owner account only, and never on a pull request
   that account opened.

**Risks.** The owner account is admin, so anything signed in as the owner
(the owner himself, any Claude session) can post the marker; the marker shows
"owner account", not "Claude". That's acceptable because those parties could
already change branch protection, so 2a gives them nothing new; the rule that
only the designated reviewer posts it is a written rule, like today.
(Reviews from the owner account appear under the owner's name in the pull
request, the same as Claude's comments do today.) The real
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
- **Every changed path is checked** against the map: added, changed and
  deleted files, and **both the old and new names** of a rename. If even
  one path matches an entry, the pull request needs that entry's designated
  reviewer (see Gate Logic). Unmapped paths alongside it don't remove that
  need; they add Codex as a second required reviewer. If paths match two
  different entries, each entry's reviewer must post a clean review.
- **New files** are covered when they fall under a mapped folder; that's why
  entries are whole folders, not file lists.
- **Never the rules.** The loader rejects entries that reach `.github/`,
  `AGENTS.md`, `CLAUDE.md`, `PLAN.md`, `docs/plans/` or `docs/decisions.md`.
- If GitHub can't list every file (its limit is 3,000), the gate can't
  tell whether a mapped path is touched, so it stays pending (fails
  closed). Such a pull request should be split into smaller ones.

### STATUS.md In Builder Pull Requests

Builder pull requests usually change their package and one line of
`STATUS.md`. `STATUS.md` is unmapped, so that line alone would make the
pull request need Codex's clean review on top of the designated reviewer's.
Two ways to handle it:

- **(A) Recommended: builders leave `STATUS.md` alone** on 2a pull requests;
  the planning session updates it in its own pull request after its check.
  A 2a pull request that touches `STATUS.md` anyway still needs the
  designated reviewer, and also needs Codex clean (fail closed, nothing
  breaks). Why: the gate stays a plain path match. No
  diff-reading code in a security check, and no way for a builder to word
  its own status. The planning session already checks each outside build
  and switches on auto-merge, so the status update fits there. Cost: one
  small extra docs pull request per milestone. This narrows AGENTS.md's
  "update STATUS.md in any pull request that changes a part's state" for 2a
  pull requests. #83 has merged, so that wording change can go into
  AGENTS.md alongside the build, with the owner's approval (AGENTS.md is
  owner-protected).
- **(B) A shared-path exception:** each map entry names its module's
  `STATUS.md` paragraph (for example, the line starting
  `**Household lists engine**`), and the gate allows a `STATUS.md` change
  only when every changed line falls inside that paragraph. This saves the
  extra pull request but adds diff parsing to the gate. It breaks if the
  paragraph's heading is reworded, and it lets the builder state its own
  progress.

## Gate Logic

What a pull request needs depends on which paths it touches (owner
decision, October 21, replacing the earlier answer to question 4):

- **Touches any mapped path:** it **requires** a valid clean review from
  the designated reviewer of every map entry it touches, on the head, with
  **no owner-account review of any kind submitted after it** (a later
  review, marked or not, on any commit, cancels it; see Findings Reviews),
  and with no owner-account review edited by someone else. Adding unmapped
  files never removes this requirement.
- **Also touches unmapped paths** (for example `README.md` or
  `STATUS.md`): it needs **both** the designated reviewer's clean review
  **and** Codex clean on the head.
- **Codex findings on the head always block**, on every pull request.
- **Touches no mapped path:** Codex only, exactly today's rule. Owner
  reviews and markers neither clear nor block these.

So a clean result from Codex alone never clears a pull request that
touches a mapped path. Why (Codex rounds 3 and 4): otherwise a Codex-built
pull request could pass on Codex's own clean review, either directly or by
adding one unmapped file such as `README.md` to fall back to Codex. Both
reopen the self-review 2a exists to remove.

A new commit changes the head, so the old marker no
longer matches and the status goes back to pending. A marker from the wrong
account, for an old commit, edited, or malformed is ignored, never success,
and the status description says why (for example, "Marker ignored: not for
the current commit").

**The status name stays `codex-approved`.** Branch protection requires that
exact name from GitHub Actions. Renaming it would mean changing `main`'s
protection, with a window where the old name is gone and nothing new is
required. Keeping it means no settings change; the description says which path
passed ("Designated reviewer (claude) clean on 0123abc").

The comment filter stays Codex-only (comment markers don't count). The
workflow adds the `workflow_run` trigger above, and the sparse checkout adds
the map file.

## Tests To Write

Pure-function tests beside the existing gate tests:

1. Happy path: fully mapped pull request, valid owner-account "Comment"
   review with a clean marker on the head.
2. Forged clean review from `cloudwork-bot` (and a look-alike login):
   ignored.
3. Stale clean review for the previous commit after a new push: pending.
4. Mixed paths (a mapped package plus `README.md`): a valid designated
   clean review alone is pending; Codex clean alone is pending; both on the
   head is success.
5. A rename from a mapped to an unmapped path: counts as touching the
   mapped path, so it needs the designated review and Codex clean.
6. Owner-account review without the marker, or with a broken clean marker:
   pending.
7. Edited clean review: blocks (and never counts as clean).
8. Owner-opened pull request with an owner-account clean review: ignored.
9. Codex findings on the head with a valid clean review: pending.
10. A map entry reaching `.github/` or `docs/plans/`: rejected.
11. Every existing Codex test still passes unchanged.
12. A findings review on the head after a clean one: pending; a new clean
    review after it: success.
13. A findings review on an older commit, submitted after the clean review:
    pending. A findings review at the same second as a clean one: pending.
14. An edited or malformed owner-account findings review: still blocks.
15. A findings review from `cloudwork-bot`: ignored (neither blocks nor
    clears).
16. A mapped pull request that also touches `STATUS.md`, with Codex clean
    and no designated review: pending. With both: success.
17. Staging: `candidate_ref` from a non-owner actor, on a non-`main` run, or
    against a pull request not based on `gate-scratch` is refused, and it
    never posts `codex-approved`.
18. Deletion: a clean marker in an ordinary comment never counts, and
    removing a findings comment changes nothing, since only reviews count.
19. A dismissed findings review: blocks unless the timeline shows the owner
    account dismissed it.
20. A clean review whose `commit_id` differs from the `sha` in its marker:
    ignored.
21. Workflow test: `designated-review-ping.yml` has no permissions and no
    checkout, and `codex-approved.yml`'s `workflow_run` path checks out the
    default branch.
22. Fully mapped pull request with Codex clean on the head and no
    designated review: pending (Codex alone never clears it).
23. Fully mapped pull request with Codex clean on the head and a designated
    findings review on the head: pending.
24. Pull request touching no mapped path with Codex clean on the head:
    success, exactly as today; an owner-account review there changes
    nothing.
25. An owner-account review on a pull request touching a mapped path,
    edited by `cloudwork-bot`, with its marker removed: blocks. The same
    with a clean marker added: blocks. One edited only by the owner account: no extra
    block (the edited-marker rules above still apply).
26. An owner-account review whose edit history can't be read in full
    (missing, partial, a deleted revision, or an unnamed editor): blocks.
27. Mixed pull request (mapped package plus `README.md`) with a valid
    designated clean review and a Codex findings review on the head:
    pending (Codex findings always block).
28. Paths from two different map entries: pending until each entry's
    reviewer has a valid clean review on the head.
29. More files than GitHub can list: pending, whatever the reviews say.
30. A clean review, then a later owner-account "Comment" review with inline
    findings and no marker (or a mistyped one), on the same head: pending.
    The same with the later review on an earlier commit: pending.
31. An unmarked owner-account review, then a fresh clean review on the
    head submitted after it: success.

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
     `gate-scratch` (a scratch branch protected like `main`), and refuses
     any other;
   - the candidate scripts run in a job with a **read-only** token and only
     print a verdict. A second job, using `main`'s code, posts that verdict
     as a status named `codex-approved-candidate`, which branch protection
     doesn't require. Candidate code never holds a token that can set a
     status, so it can't post `codex-approved` on anything.

   The owner (or Claude acting as him with his go-ahead) then dispatches it
   against scratch pull requests covering tests 1 to 4, 6, 8, 12 to 14,
   16, 18 to 20, 22 to 25, 27, 28, 30 and 31, and compares results with the
   expected ones.
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
4. **Mixed pull requests:** fall back to Codex only, or require both
   reviewers? **Owner's answer (October 21, replacing the earlier
   recommendation of Codex only): require both.** Any pull request touching
   a mapped path needs the designated reviewer's clean review; if it also
   touches unmapped paths, it needs Codex clean too. Codex findings always
   block, and only pull requests with no mapped paths stay Codex-only. Why:
   with a Codex-only fallback, a Codex-built pull request could add one
   unmapped file and clear itself (Codex round 4).
5. **Bad markers:** leave the status pending with a reason, rather than red?
   *Recommend pending; red stays stuck until the next event and adds noise.*
6. **Today's gate, dismissed Codex reviews:** treat a dismissed Codex
   review as blocking unless the owner account dismissed it, as 2a does for
   findings reviews? **Owner's answer (October 20): yes.** A dismissed Codex
   review blocks unless the owner's account dismissed it. It will be built
   in its own small pull request, separate from 2a. (Today Codex posts
   "Comment" reviews, which can't be dismissed, so this guards against a
   future change in how Codex reviews.) The editing hole in "Today's Gate"
   needed no new pull request: #88 fixed it and has merged.
7. **STATUS.md in builder pull requests:** builders leave it alone and the
   planning session updates it (A), or a per-module paragraph exception (B)?
   *Recommend A: simpler and safer gate code, at the cost of one small docs
   pull request per milestone.*
8. **Staging input after the build:** keep `candidate_ref` for future gate
   changes, or remove it? *Recommend keep: it's owner-only, posts a status
   nothing requires, and the next gate change needs it too.*
9. **Habit grid plan wording:** it says the gate is Codex's 👍 though Codex
   builds it. *Recommend aligning it with the household lists plan in its
   own small docs pull request; #83 has merged, so nothing waits on it.*

## Today's Gate: Deletion And Editing

Codex round 2 asked whether today's `codex-signal.mjs` can be beaten the same
way. Checked against the script:

- **Deletion: no path to green.** Codex's findings are read only from its
  pull request reviews (on this repo they are "Comment" reviews, for example
  on this pull request). Submitted reviews can't be deleted, and "Comment"
  reviews can't be dismissed. Deleting Codex's inline comments leaves the
  review itself in place. Every comment the script reads (the clean comment,
  the summary) is a *clean* signal, so deleting one can only remove a
  reason to pass. Reactions can only be removed by their author.
  Remaining edge: the script skips `DISMISSED` reviews. If Codex ever posted
  "Request changes", the bot could dismiss it. The owner has decided this
  gets closed in its own small pull request (owner question 6).
- **Editing: a real hole.** Write users can edit other accounts' comments,
  and an edited comment keeps its original author. The bot could edit any
  old Codex comment on a pull request to read "Didn't find any major issues"
  plus **Reviewed commit:** and the head's short SHA. On a head Codex hasn't
  reviewed yet there are no findings to outweigh it, so signal 1 would turn
  `codex-approved` green. Editing the summary comment's review-state block
  could do the same through signal 2. The author is shown correctly; the
  words aren't Codex's.
- **Fixed by #88** (`OC-261020-gate-edited-comments`, now merged). It
  accepts a Codex comment as a signal only if GitHub's edit history
  (`userContentEdits`) shows Codex made every edit, and it fails closed when
  the history can't be read. (A plain "never edited" rule wouldn't work,
  because Codex edits its own summary comment.) 2a's rule for edited
  owner-account reviews is modelled on it.

## Codex Rounds (Findings Written In As Requirements)

Round 5:

1. **Treat later unmarked reviews as cancelling clean verdicts (Findings
   Reviews):** if the reviewer posted clean, then an ordinary review with
   inline findings but no marker (or a mistyped one), the earlier clean
   verdict still counted and the pull request could auto-merge with an open
   finding. Resolved: any owner-account review submitted after the latest
   clean review cancels it, whatever it says and whichever commit it is on;
   only a fresh clean review afterwards passes. The reviewer instructions
   say so (Findings Reviews; Instructions For The Designated Reviewer;
   tests 30 and 31).

Round 4:

1. **Prevent mixed paths from bypassing designated review (Gate Logic):**
   mixed pull requests fell back to Codex only, so a Codex-built pull
   request could add any unmapped file (`README.md`, `STATUS.md`) and pass
   on Codex's own clean result. Resolved by the owner's decision of
   October 21: any pull request touching a mapped path requires the
   designated reviewer's clean review; one that also touches unmapped paths
   needs Codex clean as well; Codex findings always block; only pull
   requests with no mapped paths stay Codex-only. A file list GitHub can't
   return in full now stays pending instead of falling back to Codex
   (Which Pull Requests; Gate Logic; question 4; tests 4, 5, 16 and 27 to
   29).

Round 3:

1. **Require designated review for mapped pull requests (P1, Gate
   Logic):** as written, a fully mapped, Codex-built pull request could turn
   `codex-approved` green on Codex's own clean result, before Claude
   reviewed or while Claude had findings. Resolved: on fully mapped pull
   requests only the designated-review route can pass; Codex's clean result
   alone never does, though Codex findings still block. Unmapped and mixed
   pull requests stay Codex-only (Gate Logic; tests 22 to 24). Round 4
   replaced the mixed-pull-request part: see above.
2. **Block findings markers that are edited away (Findings Reviews):** a
   builder could rewrite a findings review to remove its marker. Resolved:
   any owner-account review on a fully mapped pull request that anyone
   other than the owner account has edited blocks it, marker or not, read
   from GraphQL edit history as #88 does; unreadable history also blocks
   (Findings Reviews; tests 25 and 26).

Also this round: the owner answered question 6 (yes, its own pull request),
and the staging base is now `gate-scratch`, since `gate-test` was deleted.

Round 2:

1. **Deleted findings comments:** verdicts are now pull request reviews,
   which can't be deleted; comment markers count for nothing; dismissed
   findings still block unless the owner dismissed them (The Signal;
   Findings Reviews; tests 18 to 20).
2. **Review events and `main`'s code:** a permission-less doorbell workflow
   triggers `main`'s gate through `workflow_run`, with the hourly backstop
   behind it (How Review Events Reach `main`'s Code; test 21).

Round 1:

1. **STATUS.md:** builders leave it alone on 2a pull requests, and the
   planning session updates it (STATUS.md In Builder Pull Requests).
2. **Dry run must test the candidate code:** an owner-only staging input on
   `main` posts `codex-approved-candidate` (Rollout, step 3).
3. **Findings marker:** schema, author and cancellation rules, plus
   reviewer instructions and tests (Findings Reviews; tests 12 to 15).

## What Stays The Same

- `tests` is still required on every pull request.
- Code-owner approval on protected paths, dismissed on new commits.
- Codex is still the reviewer for everything not in the map.
- Enforcement for admins, the hourly backstop, and the status coming only
  from GitHub Actions.
- Outside builders don't switch on auto-merge; the planning session does,
  after its check.
