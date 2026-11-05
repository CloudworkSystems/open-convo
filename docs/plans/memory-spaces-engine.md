# Memory Spaces Engine: Propose, Keep, Correct, Forget, Undo (PRD)

Status: In progress (Nov 5): the owner chose "Yes, all four" in the Claude thread "Draft next plans for outside builders" on November 5, 2026; building from issue #297.

Written November 3, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261103-memory-spaces`. Umbrella: Personal. This is the rules part of
PLAN.md step 5 ("Chosen memory on real storage": remember, correct, forget
and Undo; candidates wait for the owner; forgotten items leave AI use at
once, with a 30-day Trash; separate spaces) and of the prime agent's
"Shared Memory" section ([prime-agent.md](prime-agent.md)), as plain code
with no app and no storage. **Builder:** Codex team B, under AGENTS.md
"Outside Builders". **Reviewers:** Codex reviews every push; GrokBot or a
fresh Claude gives the independent review with the risk-review checklist;
the coordinator checks it against this plan. **Finish line:** the package
merges with `tests` passing, the sample driver runs the owner trial below
on an invented sample folder, and the owner trial passes.

## Why

Memory is the part of True Convo that has to be right before anything
reads it: what counts as memory, who may write it, which space it belongs
to, and what "forget" means. Those are rules, not judgement, so they can
be written and tested now as a standalone library. Step 5 later puts the
same library on the protected store (step 2), and the prime agent and the
Memory Steward call it instead of writing files themselves.

## Plan Of Record

1. **Now (this slice):** the library, working on a state object it is
   given and returning the new state and the files to write. A sample-only
   driver for the owner trial.
2. **Later, separate plans:** the protected-store adapter (step 5), the
   Desk's memory view, and the prime agent's calls into it.

**No real memory goes into this slice.** The driver refuses any folder
without a `SAMPLE-ONLY` marker, the same rule as the approval ledger's
driver, until step 5 supplies protected storage.

## What It Does

`packages/memory-spaces/`, plain JavaScript, no dependencies. Every
function takes `state` and an operation and returns `{ state, writes,
result }`. It reads no clock (each operation carries `now`), no files and
no network.

### The State

- `spaces`: 1 to 20, each `{ id, name, kind }` with `kind` `personal`,
  `business` or `family`. Ids are lowercase letters, digits and `-`.
- `subjects`: per space, files of kept entries, one file per subject.
  A subject id is one path segment: 1 to 64 lowercase letters, digits and
  `-`, starting with a letter, not `index` and not starting with `-`. Any
  other id (a `/`, `..`, a dot, upper case, `INDEX`) is refused, naming
  it. Because ids are lowercase only, two subjects can't differ by case.
  Before returning `writes`, the engine checks that every path is one of
  the layout's paths below and sits inside its own space folder or the
  dot folders, and refuses the whole call otherwise.
- `proposed`: candidates, kept apart from every space.
- `trash`: forgotten entries with the time they were forgotten.
- `log`: every operation in order, each with an id, so Undo has a target.

### The Rules

1. **Nothing is memory until the person keeps it.** `propose` adds a
   candidate to `proposed` only. No read ever returns a candidate. A
   skipped candidate is dropped and logged.
2. **Only the person keeps, corrects, forgets or undoes.** Each of those
   operations carries `actor` from the host's own record (never from model
   text, as in prime-routing's caller rule). An actor other than
   `person` is refused. Agents may only `propose`, and a proposal from an
   unconfirmed agent is marked so.
3. **Every kept entry has exactly one label**: `owner said` (with the
   date), `agent's reading, kept` (naming the agent) or `from a source`
   (with a link). An entry without one, or with two, is refused.
4. **Separate spaces.** An entry belongs to one space. `read({ space })`
   returns only that space's kept entries. An entry from another space is
   included only when the person has shared it with that space by a
   `share` operation, and is shown with where it came from. Nothing moves
   between spaces without a `share` or `move` by the person.
5. **Sensitive entries need an explicit save.** A candidate marked
   `sensitive` can only be kept with `save: true`. Keeping never allows
   cloud use: each entry carries `cloud: false` until the person runs
   `allowCloud` on it, and `read({ cloud: true })` returns only those.
6. **Memory is never a yes.** The library never returns an approval. An
   entry whose text sounds like permission ("fine to post without asking")
   is still just text. The README says so in its first lines, for callers.
7. **Correct keeps history.** `correct` replaces an entry's text and keeps
   the old text in the entry's history, with who and when. Reads return
   the current text only.
8. **Forget acts at once.** `forget` moves an entry to `trash` and out of
   every read in the same call. `purge({ now })` removes trash entries
   older than 30 days for good, and removes every copy of their text: the
   entry's correction history, the candidate it came from, and the text in
   every log entry about it, which keeps only the operation, its id, time
   and actor, marked `purged`. Restoring from trash is `undo` of that
   forget, or `restore` within the 30 days.
9. **Undo.** `undo({ opId })` reverses one logged keep, correct, forget,
   share, move or allowCloud, if nothing later depends on it. If something
   does (for example, an entry corrected after it was kept), the undo is
   refused with what depends on it. A purge can't be undone, and the
   README says so.
10. **Files stay small.** A subject file is at most 4 KB and the space's
    index at most 4 KB, as prime-agent.md requires. A keep or correct that
    would pass 4 KB is refused with "This subject is full. Split it or
    correct an older entry." The index is generated from the subject files'
    first lines after every write and is never edited by hand.

### The Files

`writes` lists `{ path, text }` for every file a call changed, in this
layout, so the protected-store adapter later writes the same files:

- `<space>/INDEX.md`: a generated-file header, then one line per subject
  file.
- `<space>/<subject>.md`: a first line saying what the subject is about,
  then each entry with its label, date and id.
- `.proposed/candidates.json`, `.trash/trash.json`, `.log/log.jsonl`:
  outside every space folder, so nothing that reads a space can read them.

### The Sample Driver

`node packages/memory-spaces/src/sample.mjs --dir <sample folder> <verb> [...]`,
with verbs `init`, `propose`, `keep`, `skip`, `correct`, `forget`,
`restore`, `undo`, `share`, `read`, `purge` and `show`. It refuses any
folder without a `SAMPLE-ONLY` marker (`init` creates one in an empty
folder), uses only invented subjects and spaces from the package's sample,
writes through a temporary file and a rename, and passes `now` from a
`--now` flag (default: a fixed invented date), so it never reads the
clock either.

## When It Goes Wrong

The driver's output is a screen the owner sees in the trial, so it answers
the five questions in [when-it-goes-wrong.md](when-it-goes-wrong.md):

1. **No connection.** Doesn't apply: no network.
2. **Interrupted.** Each file is a temporary file plus a rename, and the
   log entry is written last. A run stopped part-way leaves the last whole
   state; `show` then says "The last change didn't finish and was not
   saved." if a file and the log disagree, and rebuilds from the log (a purged entry stays gone,
   since its log entries no longer hold its text).
3. **Empty or first run.** A folder without the marker says "This isn't a
   sample memory folder. Run init in an empty folder first." `read` on an
   empty space says "Nothing kept in this space yet."
4. **Denied or stuck.** A refused operation (wrong actor, missing label,
   full subject, blocked undo) names the rule and says what to do. No
   prompt or permission is involved.
5. **The error message.** Each refusal is one plain sentence naming the
   entry or candidate, and nothing is half-applied.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/memory-spaces/` (invented data only):

1. A candidate is never returned by `read`; keep makes it readable in its
   space only; skip drops it.
2. An agent actor is refused for keep, correct, forget, undo, share and
   allowCloud; an unconfirmed agent's proposal is marked.
3. Each label rule: none, two, and each valid kind with its required
   field.
4. Spaces: a business space's read never shows Personal entries; a shared
   entry shows with its origin; move needs the person.
5. A sensitive candidate is refused without `save: true`; keeping sets
   `cloud: false`; only `allowCloud` entries appear in a cloud read.
6. Correct keeps history and reads return the new text.
7. Forget removes the entry from every read in the same call; restore and
   undo bring it back within 30 days; purge after 30 days removes it and
   can't be undone, and after purge the entry's text (and every earlier
   version of it) appears nowhere in the returned state or in any file in
   `writes`, the log included.
8. Undo of each operation kind, and a refused undo that names what depends
   on it.
9. The 4 KB limits on subject files and the index, and the generated
   index matches the subject files' first lines.
10. `writes` match the layout, and the proposed, trash and log files are
    outside every space folder. Subject ids such as `../business/client`,
    `INDEX`, `index`, `Work`, `a.b` and an empty id are refused, and no
    returned path leaves its space.
11. The same operations in the same order give the same state and files
    byte for byte, and the library never reads the clock, imports
    `child_process` or a network module, or uses `fs` (a test checks the
    source).
12. The sample driver refuses a folder without the marker and finishes or
    reports an interrupted run as "When It Goes Wrong" says.

**Owner trial checks** (the owner, or an agent on his Mac for him, on an
invented sample folder made by `init`): propose a memory as an agent and
see it isn't in `read`; keep it and see it in Personal only; try to keep
it as an agent and see the refusal; correct it and see the new text;
forget it and see it gone from `read` at once, then `restore` it; try a
sensitive candidate without `save` and see the refusal; run `undo` on a
keep that was later corrected and see the refusal name the correction;
run the driver on a folder without the marker and see the message;
`read` an empty space and see "Nothing kept in this space yet."; keep a
candidate with no label and see the missing-label refusal; keep entries
into one subject until it passes 4 KB and see "This subject is full.
Split it or" the rest of that message; copy the
folder, run a `correct`, then put the old log file back from the copy
(the state a stop before the log write leaves) and run `show` to see the
"didn't finish" message and the last whole state. He confirms each message says what to do next.

## Carried To The Build

Codex findings from the plan review's later rounds, which the code pull
request must meet (docs/agent-process.md "Plans stop after two Codex
rounds"):

- Purge stays purged after a crash: the redacted log is committed before the trash and state files change (or a durable purge marker is written first and honored by recovery), with a test that interrupts a purge at each step and checks the text never comes back ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4460901326)).
- `restore`, `skip` and `purge` also need `actor: person` (an agent can never purge), and the actor-refusal test covers all three ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465421005)) ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4460939032)).
- The 4 KB cap is checked before every operation that adds or restores content to a subject or its index (keep, correct, move, share, restore, undo), and an overflow refuses the whole call; tests cover a move into a nearly full subject and a restore after the subject filled ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4461031776)).
- Space ids are nonempty and unique; a state with two spaces sharing an id is refused before anything else runs, and the separation tests cover it ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4461031769)).
- Operation ids are nonempty and unique: a state whose log repeats an id is refused, an operation arriving with an id already in the log is refused (or, if identical, returns the earlier result without a second write), and `undo` targets exactly one record; tests cover both duplicate cases ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4461092017)).
- Candidate and entry ids are nonempty and unique across proposed, kept and trash records together, and an entry keeps its id as it moves between them; a state with a repeated id is refused before anything runs, with a test for each set ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4461703582)).
- The 30-day limit holds on every restore path: `restore` and an `undo` of a forget both take `now` and refuse a trash entry forgotten more than 30 days earlier, even if `purge` hasn't run yet, with "This memory's 30 days in Trash are over."; tests cover both paths one day past the limit and one day inside it ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4464984468)).

## Out Of Scope For This Slice

The protected store, real memory, the Desk view, any model or AI
(proposals in the tests are invented), Family's shared rules, sync, and the
Memory Steward's weekly run.

## Rules For The Builder (Codex Team B)

The builder must follow these; the setup does not enforce them, so breaking
one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, on the branch `OC-261103-memory-spaces`, signed in
  as `cloudwork-bot` (or as Codex's own GitHub app for a cloud task). Open
  a pull request into `main` with auto-merge off and the label
  `agent: codex`. Never push to `main` directly, and never switch on
  auto-merge.
- End the pull request description and every comment with
  `— Codex team B, OC-261103-memory-spaces`.
- Run **no commands on the owner's Mac** apart from `npm test` inside
  `packages/memory-spaces/` and the `git` and `gh` commands needed to
  commit, push and open the pull request.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented data only, with no real names, businesses or memories.
- Change files only under `packages/memory-spaces/`. Touch no app,
  storage or existing memory code (PLAN.md, "Modules that stand on their
  own"). Nothing else, not `STATUS.md` (the coordinator updates it).
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network, no AI, no paid services, no `child_process`, no clock, in the
  code or the tests. `node:fs` only in the sample driver, and only inside a
  folder with the `SAMPLE-ONLY` marker or the tests' temporary folders.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the library, the sample driver, the tests, the
  sample data and a README (the caller rules first, then the state, the
  rules, the functions and the driver). Finishable in two days.
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
because it sets the rules for the owner's memory. The coordinator checks it
against this plan and switches on auto-merge once both are clean on the
same head. Done when the tests pass with one command, the reviews are clean
(or the Codex triage judge passes it, [codex-triage.md](codex-triage.md)),
the plan check finds nothing missing, and the owner trial passes.
