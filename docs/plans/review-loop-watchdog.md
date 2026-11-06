# Review Loop Watchdog: Stop A Pull Request That Keeps Cycling

Status: Draft (Nov 5): proposed; waiting on the owner's yes to merge.

Written November 5, 2026 at the owner's request ("Yes", to "Should I write
the watchdog plan and open it as a pull request?"), after comparing Cole
Medin's AI software factory video with how this repo works. Session: thread
"Sum up the shared YouTube video". **Builder:** Claude (cloud,
`cloudwork-bot`). **Reviewers:** Codex, then GrokBot as the independent
review (a fresh Claude review stands in after 60 minutes); the owner
approves on GitHub, since the code pull request touches `.github/` and
`docs/agent-process.md`. **Finish line:** the code pull request merges with
`tests` passing; the first pull request that reaches its limit gets the
label, the comment and a line on issue #114 within one hourly run; and the
owner lifts one halt by removing the label, after which the watchdog leaves
that pull request alone until it reaches the limit again.

## Why

Most pull requests here are done in one or two Codex rounds. A few cycle for
a day. From the PR history sheet (269 pull requests, October 12 to
November 5, 2026, 961 Codex rounds in all):

- 25 pull requests took 10 or more rounds, and they used 435 rounds (45%).
- The longest: #289 (plans, 39 rounds), #303 (plans, 31, still open), #74
  (28), #299 (25), #146 (22), #111 (21), #127 (20).
- #303 drew about 30 rounds between 2 and 8 AM on November 5, one every
  three minutes, with nobody watching.

Two rules already aim at this, and neither stops a loop of new P1s:

- The triage judge ([codex-triage.md](codex-triage.md)) only rates P2 and P3
  findings. A fresh P1 on every push never reaches it.
- "Plans stop after two Codex rounds" ([agent-process.md](../agent-process.md))
  is a rule for builders, and nothing checks it. #289 and #303 are both plan
  pull requests.

In every long loop the way out was the same: the owner chose to accept the
findings, narrow what the pull request promised, or split it. The watchdog
asks him that question when the loop starts going in circles, not after
30 rounds.

## The Rule

A **round** is a commit of the pull request that Codex left findings on,
counted the way the triage judge counts them (distinct `commit_id`s of
Codex reviews with findings, from `chatgpt-codex-connector[bot]`).

A **plan pull request** is one whose files are all under `docs/`, or are
`PLAN.md` or `STATUS.md` (the Review Guidelines' own definition). Every
other pull request is a **code pull request**.

The watchdog **halts** a pull request when all of these hold for its head:

1. It is open, not a draft, and targets `main`.
2. Its rounds since the last lift (below) reach the limit: **6** for a plan
   pull request (two rounds plus four rounds of carrying P1s to the build),
   **8** for a code pull request.
3. Codex's newest review is on the head and has findings, or the head has
   no Codex review yet and the newest one had findings. (A pull request
   whose head Codex reviewed clean is never halted.)
4. It wasn't opened by the owner's account. His own pull requests are his
   to steer.

Over the 24 days above, these limits would have halted 42 pull requests
(20 plans, 22 code), about 1.75 a day, and saved about 270 rounds. A limit
of 6 for code would have halted 52 and asked the owner about two a day;
8 keeps his calls to the loops that were clearly stuck. Both limits are
constants in one place, so changing them is one line.

### What A Halt Does

- Adds the label `needs-owner: review-loop`. Other scheduled checks
  already treat any `needs-owner:` label as waiting on him.
- Writes one comment on the pull request, marked so it is rewritten rather
  than repeated. It says how many rounds there have been, links the newest
  Codex review, and gives the three choices in plain words:
  1. **Accept the findings:** post `owner-accepts-findings <full head sha>`
     (the existing note; nothing changes about it).
  2. **Narrow it:** tell the building thread what the pull request should
     stop promising; then remove the label so the builder can push.
  3. **Split it:** tell the building thread how to split it; the builder
     opens the new pull requests and closes this one.
- Lists the pull request in a new "Stuck in review" section on issue #114,
  "Needs the owner", with its round count.

### What Builders Do

From the halt until it lifts, no agent pushes to that pull request: not its
builder, not the PR keeper's fix step, and not a GrokBot relay. Agents also
don't post `@codex review` or `@cursor` on it. A builder may still answer
review threads in words. This goes into
[agent-process.md](../agent-process.md), the PR keeper's instructions and
the coordinator playbook in the code pull request.

GitHub can't refuse a push to one pull request, so this is a rule, backed by
a check: when a commit lands on a halted pull request, the watchdog adds
"pushed while halted" with the commit to its comment, and the PR keeper
reports it in its "Not working" comment as
"[#N] pushed while halted (<builder>)".

### What Lifts A Halt

Only these, read on every run:

- The owner removes the label himself. The watchdog reads who removed it
  from the pull request's timeline (the `unlabeled` event's actor); if
  anyone else removed it, it puts it back and says so in its comment.
- The owner posts `loop-resume` on the pull request from his account (for
  when removing a label is awkward on his phone).
- The owner's `owner-accepts-findings <full head sha>` for the head. The
  gate passes as it does today, and the label comes off.
- Codex is clean on the head, in any form the gate counts as clean
  (including its 👍 reaction). The loop ended on its own.
- The pull request closes or merges. Nothing needs to run for this: the
  watchdog and the "Stuck in review" list read only open pull requests, so
  it drops off issue #114 at its next rewrite. The label stays on the
  closed pull request as a record of the halt, and no workflow trigger is
  added for closing.

A lift resets the count: the next halt comes only after another full limit
of rounds after the lifting event.

## Where It Runs

Inside the existing `codex-approved` workflow, which already runs on Codex's
comments, on pushes and hourly, only from `main`, never checking out pull
request code, and already holds `issues: write` and `pull-requests: write`
for the risk hold's label and comment. The watchdog needs no new
permission, secret, outside host or dependency. It reads the timeline
endpoint (`/issues/<N>/timeline`), which those permissions cover.

The watchdog never changes the `codex-approved` status. The gate already
blocks while findings are open, and a halt only stops more rounds. So if the
watchdog breaks, the gate behaves exactly as it does today.

`owner-queue` reads the label to build the "Stuck in review" section.

## What Changes Where (Code Pull Request)

- `.github/scripts/review-loop.mjs` (new): pure functions for counting
  rounds (shared with `codex-triage.mjs` rather than copied), telling plan
  from code pull requests, deciding halt and lift from the reviews,
  comments, reactions, labels and timeline, and writing the comment.
  Whether Codex is clean on the head comes from the gate's own
  `evaluateCodexSignal` in `codex-signal.mjs`, never a second reading, so
  every clean form the gate accepts (including the summary comment plus
  Codex's 👍 reaction) lifts a halt and resets the count, and the tests
  cover each of those forms.
- `.github/scripts/codex-approved.mjs`: calls it for each pull request it
  evaluates, then adds or removes the label and writes the comment. Before
  its first add in a run, it makes sure the label `needs-owner: review-loop`
  exists in the repository (`GET /labels/<name>`, and `POST /labels` on a
  404), so a halt never fails on a missing label.
- `.github/scripts/owner-queue.mjs`: the "Stuck in review" section.
- `.github/scripts/tests/review-loop.test.mjs` (new): each halt condition,
  each lift (including a label removed by someone other than the owner),
  the reset after a lift, plan versus code limits, the owner's own pull
  requests, a push while halted, an unreadable timeline (no halt, no
  lift, an error in the log), and a repository without the label yet (it
  is created, then added).
- `docs/agent-process.md`: a new bullet, "A pull request stuck in review
  stops", next to "Plans stop after two Codex rounds".
- `docs/scheduled-tasks/pr-keeper.md`: skip pushes, relays and restarts on
  halted pull requests; report "pushed while halted".
- `docs/coordinator-playbook.md`: the same skip, and how to read the halt
  comment when the owner asks about a stuck pull request.
- `AGENTS.md`: one line in the Agent Process summary pointing to the new
  bullet (a rules file, so it needs the owner's yes quoted with its date).

## When It Goes Wrong

The watchdog adds no screen, so the five questions in
[when-it-goes-wrong.md](when-it-goes-wrong.md) don't strictly apply. Its
failure cases:

- **GitHub's API fails or a page can't be read:** no halt and no lift that
  run; the next run tries again. It never guesses from partial data.
- **The label call works but the comment fails (or the reverse):** the next
  run finishes the other half, since both are idempotent.
- **The owner removes the label by mistake:** the pull request runs another
  full limit of rounds before it halts again. He can halt it sooner by
  adding the label back himself; the watchdog treats a label the owner adds
  as a halt.
- **A builder keeps pushing anyway:** the gate still blocks on findings; the
  comment and the keeper's report name the push.

## Risks

- **Halting real progress.** A pull request at round 8 may be one push from
  clean. The cost is one decision for the owner, and Codex clean on the head
  lifts the halt by itself.
- **Too many asks.** About 1.75 a day at these limits, on top of the risk
  holds. If that is too many, raising the limits is one line.
- **Anyone can comment.** Only the owner's account lifts by comment or label,
  checked by login from GitHub's own data, never from comment text.

## Not Doing (Yet)

- **A floor on how many tests run.** A test job that runs zero tests passes
  today. It hasn't caused a problem yet, so it waits until it does or the
  owner asks.
- **Hidden test scenarios the builder never sees.** The owner's Mac trials
  already play that part, and builders gaming tests isn't what fails here.
- **Halting on speed** (rounds per hour). The round limit already stops an
  overnight loop like #303's within its first half hour.

## Carried To The Build (Codex Round 3 On)

Requirements for the code pull request, carried from this plan's review
under "Plans stop after two Codex rounds":

- A `loop-resume` comment counts only when its whole edit history, read
  the way `ownerAcceptance` reads `owner-accepts-findings` (GraphQL
  `userContentEdits`, every editor the owner, fail closed when the
  history can't be read), shows only the owner's account. Tests cover an
  owner comment edited by another account and an unreadable history
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/307#discussion_r4486447466)).
