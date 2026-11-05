# Memory Recall: Find The Memories That Matter For A Message (PRD)

Status: Draft (Nov 5): waiting on the owner's yes in the Claude thread "Draft next plans for outside builders".

Written November 5, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261105-memory-recall`. Umbrella: Personal. This is the read side of
PLAN.md step 5 and of the prime agent's "Shared Memory" section
([prime-agent.md](prime-agent.md)). The memory spaces engine
([memory-spaces-engine.md](memory-spaces-engine.md), merged as #300) says
what memory is and who may change it. This slice picks the few kept
entries that bear on one message, so the prime agent reads those and not a
whole space. It is plain code with no app, no storage and no AI.
**Builder:** Codex team B, under AGENTS.md "Outside Builders" (it built
the memory spaces engine). **Reviewers:** Codex reviews every push; GrokBot
or a fresh Claude gives the independent review with the risk-review
checklist; the coordinator checks it against this plan. **Finish line:**
the package merges with `tests` passing, and the owner trial below passes
on the invented sample.

## Why

The prime agent hands off with a short brief, and the brief should carry
only the memory the task needs (prime-agent.md, "the hand-off brief").
Reading a whole space into every brief wastes the small local model's room
and leaks more than the task needs. Which entries match a message, how old
they are, and whether one claims an approval are rules, not judgement, so
they can be written and tested now as a standalone library. Step 5 later
calls it on the protected store, and the prime agent calls it before each
brief.

## Plan Of Record

1. **Now (this slice):** the library, working on a memory spaces state it
   is given, plus a read-only sample command for the owner trial.
2. **Later, separate plans:** the prime agent's call into it (prime-agent
   step 3), and any ranking that uses a model. This slice has none.

## What It Does

`packages/memory-recall/`, plain JavaScript, no dependencies. One main
function:

`recall(state, { space, cloud, query, now, limit, budgetBytes })`

- `state` is a memory spaces state. The library gets the visible entries
  only through `read(state, { space, cloud })` from
  `packages/memory-spaces/`, imported by relative path through its public
  export. It never looks at `proposed`, `trash` or `log` text, so a
  candidate, a forgotten entry or a purged entry can never be recalled.
  If memory spaces lacks something this plan needs, the builder stops and
  reports instead of changing it.
- `query` is the message text, 1 to 4,000 characters. `now` is an ISO
  time from the caller; the library reads no clock. `limit` is 1 to 20
  (default 5). `budgetBytes` is 200 to 4,096 (default 1,024).
- It returns `{ entries, brief, notes }`:
  - `entries`: up to `limit` matches, best first. Each carries `id`,
    `subject`, `text`, `label`, `origin` (when shared from another space),
    `score`, `ageDays` (or `null`), and two flags, `recheck` and
    `approvalClaim`, described below.
  - `brief`: the same entries as plain text lines for a hand-off brief,
    never longer than `budgetBytes` in UTF-8. It opens with the fixed line
    "Memory, not permission: ask the person before any outside action."
  - `notes`: plain sentences for the caller, such as "Nothing kept in this
    space matches." or "2 more matches didn't fit the brief."

### The Rules

1. **Only what `read` returns.** Space separation, sharing and cloud
   permission come from memory spaces as they are. With `cloud: true`,
   only entries the person allowed for cloud use can be recalled. A test
   checks that a recall never returns an entry that `read` with the same
   options leaves out.
2. **Matching is plain and repeatable.** Words are lower-cased, accents
   folded (NFKD, combining marks removed), split on anything that isn't a
   letter or digit, and checked against a fixed English stop-word list in
   the package. Scoring is BM25 with k1 = 1.2 and b = 0.75 over the
   entries `read` returned, using the entry's text and its subject id.
   Ties break by subject id, then entry id. An entry that shares no word
   with the query is never returned. The same inputs give the same output
   byte for byte.
3. **Age comes from the label or the log.** `ageDays` is whole days from
   the time its current text was set to `now`. That time is the `now` of
   the latest log record that kept or corrected that entry and is still in
   effect, or the `owner said` label's date if that is later. A `move`,
   `share`, `restore` or `allowCloud` changes where the entry is filed or
   who may see it, not what it says, so it never makes an entry younger.
   A record that a later `undo` reversed doesn't count, so a correction
   made today and then undone leaves the entry as old as its text really
   is. If neither exists,
   `ageDays` is `null`. The library reads only those records' times and
   entry ids from the log, never their text.
4. **Recheck old facts that name something.** `recheck` is true when
   `ageDays` is over 30 (or `null`) and the text names something that can
   change: a link, a file path, a money amount, a version number, or a
   number with a unit. The brief marks those lines "(recheck before
   relying on this)". This is the prime agent's "stale memory" rule.
5. **An approval claim is never a yes.** `approvalClaim` is true when the
   text matches the package's fixed list of permission phrases ("approved",
   "fine to", "go ahead", "no need to ask", "always allowed", and the
   others the README lists). The brief marks those lines "(says it was
   allowed; ask again)". The library never returns or implies an approval
   (prime-agent.md failure mode 5). The README says so in its first lines.
6. **The brief fits its budget.** Lines go in rank order, each line whole.
   A line that doesn't fit is left out with a note, and the brief never
   cuts a line or a character in half. If even the first entry doesn't
   fit, the brief holds only the opening line and a note says so.
7. **Nothing changes.** `recall` returns new objects and leaves `state` as
   it was (a test compares it before and after). There are no writes.

### The Sample Command

`node packages/memory-recall/src/sample.mjs --state <state.json> --space <id> [--cloud] [--limit n] [--budget n] [--now iso] "message"`
reads one JSON file with a memory spaces state, prints the brief and the
notes, and writes nothing. `--now` defaults to a fixed invented date, so
the command never reads the clock. The package ships
`sample/state.json`: an invented state made with the memory spaces
library, with three spaces (one of them empty), a shared entry, a cloud-allowed entry, a
forgotten entry, a candidate, an old entry naming a price and one entry
claiming an approval. The package's tests rebuild it from the memory
spaces library and check it matches, so it never drifts.

## When It Goes Wrong

The sample command's output is a screen the owner sees in the trial, so it
answers the five questions in [when-it-goes-wrong.md](when-it-goes-wrong.md):

1. **No connection.** Doesn't apply: no network.
2. **Interrupted.** Doesn't apply: nothing is written, so a stopped run
   leaves everything as it was.
3. **Empty or first run.** An empty space prints "Nothing kept in this
   space yet." A query with no match prints "Nothing kept in this space
   matches." A query made only of stop words prints "Say a little more
   about what you need; those words are too common to match on."
4. **Denied or stuck.** A space that doesn't exist prints "There's no
   space called '<id>'." A file that isn't a memory spaces state prints
   "This file isn't a memory state." and the memory spaces check that
   failed. Nothing is half-done, because nothing is done.
5. **The error message.** Each refusal is one plain sentence naming the
   value that was wrong (a limit or budget out of range, an empty query,
   a bad `now`), with no stack trace.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/memory-recall/` (invented data only):

1. Separation: a recall in a business space never returns a Personal
   entry; a shared entry comes back with its origin; a cloud recall
   returns only cloud-allowed entries; for every sample query, the
   returned ids are a subset of what `read` returns with the same options.
2. A candidate, a forgotten entry and a purged entry are never returned,
   even when their text matches the query word for word.
3. Matching: case and accent folding, stop words, subject ids counted,
   no-overlap entries left out, the tie-break order, and an exact score
   for a small hand-worked example.
4. Same inputs, same output byte for byte, across two runs and after a
   JSON round trip of the state.
5. Age: from the log, from a later `owner said` date, and `null` when
   neither exists; a `correct` resets the age; a `correct` that is then
   undone doesn't, so an old price corrected and undone today is still
   flagged `recheck`; a `move`, `share`, `restore` or `allowCloud` today
   leaves a 60-day-old price flagged.
6. Recheck: each kind of changeable thing at 31 days is flagged, the same
   text at 30 days isn't, and plain text at 300 days isn't.
7. Approval claims: each listed phrase is flagged; "not approved yet" is
   flagged too, because it talks about approval; "a proven method" isn't;
   and the brief's opening line is always present.
8. Budget: a brief exactly at the budget, one byte over (the last line
   dropped with a note), multi-byte text, and a first entry too long for
   the budget.
9. Limits and refusals: each out-of-range option, an empty or 4,001
   character query, a bad `now`, an unknown space and a bad state, each
   with its exact message.
10. `recall` leaves `state` unchanged, and the library never reads the
    clock, imports `child_process` or a network module, or uses `fs` (a
    test checks the source). `fs` appears only in the sample command.
11. The sample command prints the "When It Goes Wrong" messages, writes
    no file (a test lists the folder before and after), and the shipped
    `sample/state.json` matches the one rebuilt in the test.

**Owner trial checks** (the owner, or an agent on his Mac for him, with
the shipped sample):

1. Ask about the invented topic that has a Personal entry and see it
   first in the brief.
2. Ask the same in the business space and see that entry left out.
3. Ask about the shared entry and see where it came from.
4. Run with `--cloud` and see only the cloud-allowed entry.
5. Ask about the forgotten entry's words and see "Nothing kept in this
   space matches."
6. Ask about the old price and see "(recheck before relying on this)".
7. Ask about the entry that claims an approval and see "(says it was
   allowed; ask again)".
8. Run with `--budget 200` and see the note about matches that didn't
   fit.
9. Ask with only "the and of" and see the "say a little more" message.
10. Run with a space that doesn't exist and see its message.
11. Ask anything in the sample's empty space and see "Nothing kept in
    this space yet."
12. Point `--state` at the package's `package.json` and see "This file
    isn't a memory state." with the check that failed.
13. Run with `--limit 0`, then `--budget 100`, then `--now yesterday`,
    then an empty message, and see each one-sentence refusal naming the
    value that was wrong.

He confirms each message says what to do next.

## Carried To The Build

Codex findings from the plan review's later rounds, which the code pull
request must meet (docs/agent-process.md "Plans stop after two Codex
rounds"):

- BM25's word weight is the smoothed form `idf = ln(1 + (N - df + 0.5) / (df + 0.5))`, where `N` is the number of entries `read` returned and `df` the number that hold the word, so it is never negative, even for a word in most of them. The hand-worked exact-score test uses this formula ([thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4479950988)).
- An `owner said` label whose date isn't a valid `YYYY-MM-DD` calendar date is ignored for age, which then comes from the keep or correct still in effect, so `ageDays` is always a whole number and never `NaN`. A test gives a stale price an unparseable label date and checks it is still flagged `recheck` ([thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4480141627)).

## Out Of Scope For This Slice

The protected store, real memory, the prime agent's call, the Desk view,
any model, embedding or AI ranking, languages other than English for stop
words, and changing memory in any way.

## Rules For The Builder (Codex Team B)

The builder must follow these; the setup does not enforce them, so breaking
one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, on the branch `OC-261105-memory-recall`, signed
  in as `cloudwork-bot` (or as Codex's own GitHub app for a cloud task).
  Open a pull request into `main` with auto-merge off and the label
  `agent: codex`. Never push to `main` directly, and never switch on
  auto-merge.
- End the pull request description and every comment with
  `— Codex team B, OC-261105-memory-recall`.
- Run **no commands on the owner's Mac** apart from `npm test` inside
  `packages/memory-recall/` and the `git` and `gh` commands needed to
  commit, push and open the pull request.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented data only, with no real names, businesses or memories.
- Change files only under `packages/memory-recall/`. Import
  `packages/memory-spaces/` by relative path through its public export
  only; if it lacks something, stop and report instead of changing it.
  Nothing else, not `STATUS.md` (the coordinator updates it).
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network, no AI, no paid services, no `child_process`, no clock, in the
  code or the tests. `node:fs` only in the sample command, which reads the
  one state file it is given and writes nothing, and in the tests'
  temporary folders.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the library, the sample command, the tests, the
  sample state and a README (the caller rule first, then the options, the
  rules, the output and the command). Finishable in one to two days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Supported setups are macOS and the Linux CI runners on Node 22 (AGENTS.md
  "Review Guidelines").
- Edge cases this plan doesn't name: write each choice in the README's
  "Edge cases" section with a test.

## Review And Finish Line

Codex reviews it as code until it gives a 👍. Codex team B fixes every P1
and P2 or explains in the pull request why one doesn't apply. GrokBot or a
fresh Claude gives the independent review with the risk-review checklist,
because it decides which of the owner's memories an agent sees. The
coordinator checks it against this plan and switches on auto-merge once
both are clean on the same head. Done when the tests pass with one
command, the reviews are clean (or the Codex triage judge passes it,
[codex-triage.md](codex-triage.md)), the plan check finds nothing missing,
and the owner trial passes.
