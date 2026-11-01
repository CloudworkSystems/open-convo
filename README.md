# PR history

One row per pull request in this repository, rebuilt every morning by
`.github/workflows/pr-history.yml` on `main`. `pr-history.csv` is for the
owner's Google Sheet (`=IMPORTDATA` of its raw link); `pr-history.json` holds
the same rows for the Desk, Canvas and Atlas. No authors or emails are kept.
Each run rereads the open pull requests and any closed one that changed, at
most 120 of them, so a full rebuild (the first run, or a new column) fills in
over two or three mornings, newest pull requests first.

Worked-out columns:

- `agent`: the `agent: …` label, else Codex's account or a `codex/` branch,
  else GrokBot (`Cursor Agent` commits), else Claude (`Claude-Session` or
  `Built-by: Claude` in a commit). #58 and #71 are Codex, per their plan.
- `codexRounds`: distinct commits Codex reviewed. `codexP0` to `codexP3`:
  Codex's inline findings by badge, across all rounds.
- `codexLatest`: Codex's summary comment when there is one (`clean`,
  `open findings`, `review failed`, `review running`, or `earlier commit` when it
  describes a commit before the head), else the last round (`clean`,
  `had findings`, with `, earlier commit` added when that round was
  on a commit before the head), else `none`. On a merged pull request, `open findings`
  usually means findings left for the triage judge or accepted by the owner.
- `outsideReviewer`, `outsideRounds`, `outsideLatest`: comments that start
  "Independent review" or end "— GrokBot review". `outsideLatest` is a text
  match on the latest one: `clean` needs "clean", "no findings" or "nothing
  new" and no P0, P1 or P2 counted as still open. Check the pull request when
  it matters.
- `outsideCommit`, `outsideOnHead`: the commit that latest review names (or
  was left on), and whether it is the pull request's head. A `clean` review
  holds only for that commit; `no` also covers a later update from `main`
  alone, which needs no new review.
- `areas`: top folders touched (`apps/desk`, `packages/<name>`, `docs/plans`,
  or a top-level file).
