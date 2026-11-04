# Atlas Link Repair (PRD)

Status: Draft (Nov 3): waiting on the owner's yes in the Claude thread "Draft next plans for outside builders".

Written November 3, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261103-atlas-link-repair`. Umbrella: Personal (the Atlas wiki). It
follows [atlas-index-engine.md](atlas-index-engine.md), whose check lists
broken links but leaves "fixes beyond index and map files" to a separate
plan. This is that plan, for the one fix that needs no judgement: a link
that broke because its note moved to another folder (or only its letter
case changed), where exactly one note still carries that name. A note given
a new name is not repaired; its links are listed for the person. **Builder:** GrokBot team A, under AGENTS.md
"Outside Builders", through Cursor and signed in as `cloudwork-bot`.
**Reviewers:** Codex reviews every push; the coordinator checks the result
against this plan. **Finish line:** the package merges with `tests`
passing, the command repairs the invented sample wiki so that
`packages/atlas-index/` reports none of the repaired links as broken, and
the owner trial below passes.

## Why

Notes get moved into folders as a wiki grows, and every move breaks the
links that pointed at the old place. The Atlas check already
lists them, but fixing each one by hand is the tedious part that makes
people stop tidying. When exactly one note has the name the link was
looking for, the fix is a rule, not a guess. Anything less certain,
including a note that was given a different name (no record of its old name
exists), is listed for the person and left alone.

## What It Does

`planRepairs(notes, snapshot)` in `packages/atlas-links/`, plain
JavaScript, no dependencies. It takes the wiki as data and returns data. It reads and
writes nothing itself.

### Input

`notes` is a list of `{ path, text }`, the same shape and the same path
rules as `buildAtlas` (relative, `/` separators, ends in `.md`; the same
refusals for empty, absolute, backslash, control characters, `.` or `..`
segments, and NFC duplicates). Generated indexes (text starting with the
atlas-index generated header) are skipped: atlas-index rebuilds them. In the
root map `MAP.md`, only the part from the `<!-- atlas-index:start -->`
marker on is skipped; the hand-written part before it is read and repaired
like any note, and its bytes after the marker are never changed.

`snapshot` records each note from the last time the command ran on this
folder, as its path and the SHA-256 of its bytes
(`{ notes: [{ path, sha256 }] }`), or is `null` when there is none. It is
the evidence that a note moved rather than was deleted and replaced: the
current notes alone can't tell the two apart.

### Links It Reads

Exactly the links atlas-index checks, read by exactly its rules (its
README's "Edge cases": `<...>` destinations, balanced parentheses and
brackets, labels across lines, percent-encoded segments decoded before
lookup, schemes, `//`, leading `/`, anchor-only and non-`.md` links
ignored, reference-style links ignored, fenced code, inline code and front
matter not searched).

- Markdown links `[text](target)`, with an optional `#anchor`.
- Wiki links `[[name]]`, `[[name#anchor]]` and `[[name|label]]`.

A link is **broken** exactly when atlas-index would call it broken:
markdown by the decoded path relative to the note's folder; wiki by a
case-sensitive NFC match against any note's front matter `name:`, its file
name without `.md`, or its path without `.md`. So a wiki link that matches a
note's `name:` is never broken here. A test checks that the broken set
equals `buildAtlas`'s `broken-link` entries on the sample wiki, which
includes notes reached only by `name:`, by path, by an encoded name and by
an `<...>` destination.

### The One Rule

For each broken link, take the file name it was looking for (the last
path segment without `.md`, for markdown links and for path-qualified wiki
names such as `[[old/Seeds]]` alike, or the whole wiki `name` when it has no
`/`), NFC-normalize it and compare it
without regard to letter case with every note's file name without `.md`.

- **Exactly one note matches, and the snapshot shows a move:** propose a
  repair. A move means all three of these: the snapshot is present; the
  old target was a note in the snapshot and is gone now (for a markdown
  link and a path-qualified wiki link such as `[[old/Seeds]]`, its exact
  resolved old path; for a bare wiki link such as `[[Seeds]]`, the one
  snapshot path whose file name matches the same way, and only if exactly
  one did); and the one matching note's path is **not** in the
  snapshot, so it appeared since the last run; and that note's SHA-256
  equals the hash the snapshot recorded for the old path, so it is the same
  note, moved unchanged. A note that was already there before is never a
  move target, and a new note with different bytes (an unrelated note, or
  the moved note edited after the move) is listed, not repaired. A markdown link's
  target becomes the relative path from the linking note's folder to that
  note, each segment percent-encoded the way atlas-index writes links
  (every octet that is not an RFC 3986 unreserved character), keeping any
  `#anchor`; a `<...>` destination is replaced by the plain encoded form.
  A wiki link's `name` becomes that note's file name exactly as spelled on
  disk, keeping any `#anchor` or `|label`; when that file name contains
  `#`, `|`, `[` or `]`, or is not a unique wiki match by atlas-index's rule,
  the note's path without `.md` is used instead, and if that is not unique
  or safe either the link goes to `needsYou`. Only the target text changes;
  the link text, label and every other byte of the note stay as they are.
- **Anything else:** no repair. That covers no match, more than one match,
  no snapshot (the first run), and one match without move evidence (for
  example, `old/Seeds.md` deleted while an unrelated `archive/Seeds.md`
  was already there). The link is listed under `needsYou` with the
  candidate paths (empty for none) and a `reason`, so the person decides.
- A link from a note to itself is never proposed.

### Output

```json
{
  "repairs": [
    { "path": "garden/tomatoes.md", "line": 4, "from": "../seeds.md",
      "to": "../archive/seeds.md" }
  ],
  "needsYou": [
    { "path": "pantry.md", "line": 9, "link": "[[flour]]",
      "candidates": ["baking/flour.md", "shop/flour.md"] }
  ],
  "writes": [{ "path": "garden/tomatoes.md", "text": "..." }],
  "counts": { "notes": 12, "broken": 3, "repairs": 2, "needsYou": 1 }
}
```

Lists sort by path, then line, then the link's column. The same notes give
byte-identical JSON. `writes` holds each note with at least one repair,
with every repair in it applied; a note with none is not in `writes`.

### The Command

`node packages/atlas-links/src/repair.mjs --dir <folder> [--write | --record] [--json]`

- It reads every `.md` file under `--dir`, skipping hidden folders and
  symbolic links, as atlas-index does. A `--dir` that contains `.git`, or
  is this repository's root, is refused.
- **Dry run by default:** it prints each repair (`path:line from → to`) and
  each `needsYou` entry, and changes nothing.
- With `--write` it applies only `writes`, each through a temporary file in
  the same folder and a rename, keeping the file's mode. Just before each
  rename it reads the note again; if its bytes changed since the scan, or
  it disappeared or became a link, that note is left as it is and reported
  as skipped. It never creates, deletes, renames or moves a file, and never
  writes a generated index. In `MAP.md` it may change only link targets in
  the hand-written part before the marker; the bytes from the marker on are
  written back unchanged (running atlas-index afterwards rebuilds them).
- The snapshot lives at `<dir>/.atlas-links/paths.json` and holds only the
  relative note paths and their SHA-256 hashes, no text from the notes. `--record` saves it
  and changes nothing else; `--write` saves it only when every planned
  repair was written. If any repair was skipped (a note changed between the
  scan and its write), it keeps the old snapshot, so the next run still has
  the old path as evidence, and says "Kept the old snapshot so the skipped
  links can be repaired next run." A test covers a skipped repair followed
  by a second run that repairs it. Both
  write it through a temporary file and a rename, mode `0600`, and refuse
  if `.atlas-links` is a symbolic link. A dry run never writes it. A
  snapshot that is missing is `null`; one that is unreadable or malformed
  refuses the run.
- A refusal prints one plain message and exits 1. A result exits 0.

## When It Goes Wrong

- **Two notes share the name:** no repair; listed under `needsYou` with
  both paths.
- **The note was deleted, or given a new name:** no repair; listed with
  no candidates, or with any older note of that name as a candidate.
- **No snapshot yet, or the move happened before it:** no repair; listed
  for the person. Running `--record` after tidying makes later moves
  repairable.
- **The note changed while the command ran:** that note is skipped and
  named; the others are still written.
- **A write fails halfway:** each note is written whole or not at all (the
  temporary file and rename); notes already written stay repaired, and the
  next run finds nothing left to do for them.
- **Unreadable or unsafe input:** a path that breaks the input rules, or a
  file that is not valid UTF-8, refuses the whole run before anything is
  written, naming the file.

## Tests (Must Pass, Run By One Command)

`npm test` inside `packages/atlas-links/`, all on an invented sample wiki
in `tests/fixtures/` (invented notes only).

1. A note moved into a folder: links to it from the root, a sibling folder
   and a deeper folder are each repaired to the right relative path, and
   `buildAtlas` then reports none of them as broken.
2. A renamed letter case (`Seeds.md` linked as `seeds.md`) is repaired.
3. Wiki links: `[[seeds]]` and `[[seeds|the seed list]]` are repaired to
   the note's exact spelling, keeping the label, and `[[old/Seeds]]` after
   the note moved to `archive/Seeds.md` is repaired by its last segment.
4. An `#anchor` is kept. A repaired target to `archive/Seed Plans.md`,
   `plan#1.md` and `a (draft).md` is encoded, and `buildAtlas` resolves it.
   A hand-written link in `MAP.md` above the marker is repaired; the bytes
   from the marker on are unchanged.
5. Two notes with the same name: no repair, one `needsYou` entry with both
   paths. A deleted note: `needsYou` with no candidates. A deleted
   `old/Seeds.md` while `archive/Seeds.md` was already in the snapshot: no
   repair, `needsYou` with that candidate. `[[old/Seeds]]` when the
   snapshot held `other/Seeds.md`, not `old/Seeds.md`, and that note moved
   to `archive/Seeds.md`: no repair. `old/Seeds.md` deleted and a new,
   different `archive/Seeds.md` created: no repair. A moved note edited
   before the repair run: no repair, listed. No snapshot: every broken link
   is in `needsYou`, none repaired. `--record`, then a move, then `--write`:
   repaired.
6. Links in fenced code blocks and inline code are not touched; external
   links and absolute paths are not touched.
7. Only target text changes: the repaired note matches the original byte
   for byte outside the changed targets (including CRLF line endings and a
   missing final newline).
8. The broken-link set matches `buildAtlas`'s `broken-link` entries for the
   sample wiki (test-only import of `packages/atlas-index/`).
9. Unsafe paths, NFC duplicates and invalid UTF-8 are refused with a plain
   message; nothing is written.
10. The command: dry run writes nothing; `--write` writes only the notes in
    `writes` (plus the snapshot, lock and journal under `.atlas-links/`), keeps each file's mode, and a second run finds nothing to do.
11. A note edited between the scan and its rename is skipped and named; the
    other notes are written.
12. A `--dir` that holds `.git`, or is the repository root, is refused;
    hidden folders and symbolic links are skipped.
13. The same notes give byte-identical JSON twice, in either input order.

## Owner Trial

On a copy of a small notes folder (never the only copy):

1. Run the command with `--record` once, then move one note into a new
   folder.
2. Run the command without `--write`: it lists the repairs it would make.
3. Run it with `--write`, then run atlas-index on the folder: those links
   are no longer broken, and nothing else in the notes changed.

## Out Of Scope For This Slice

- Any judgement: matching by title, content or similarity, and choosing
  between two candidates. Those go to the person.
- Deleting, moving or renaming notes; orphans, duplicates and long notes.
- Running on its own, watching a folder, the Desk view, and any model.
- Real notes. Nothing from anyone's actual wiki goes into the tests or the
  repo.

## Carried To The Build

Plans stop after two Codex rounds (AGENTS.md "Keeping Finished Work
Moving"); these later findings are requirements for the code pull request.

- Just before writing a note's repairs, `--write` also rechecks every
  destination those repairs point to: it is still a regular file (not a
  symbolic link) at the planned path inside the wiki, and its SHA-256 still
  equals the hash the move evidence matched, or the hash of the exact bytes
  this same run wrote to it (a destination that is itself a repaired note,
  for example two moved notes that link to each other). A destination that fails the
  recheck skips every repair pointing to it, lists them as skipped with the
  reason, and keeps the old snapshot (as for any skipped repair). Tests
  delete, replace, edit and symlink a destination between the scan and the
  write, and two moved notes that link to each other are both repaired in
  one run
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4464930305),
  [thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4464959789)).
- A partial `--write` keeps move evidence for the notes this run
  rewrote: the kept snapshot is the old one with each successfully written
  note's hash updated to the bytes this run wrote (paths unchanged), so a
  note that is both repaired and the moved destination of a skipped link
  still matches next run. A test repairs note A, skips note B whose broken
  link points to A's old path, and checks a second run repairs B
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465013068)).
- Only one `--write` or `--record` run changes a wiki at a time: it takes
  an exclusive lock (`<dir>/.atlas-links/run.lock`, created with `wx`)
  before reading the snapshot and releases it after the snapshot is saved
  or kept. A second run that finds the lock stops and writes nothing,
  unless the lock is stale: the lock holds the process id and host name,
  and when its host is this computer and that process is no longer
  running (checked with `process.kill(pid, 0)`, no clock needed), the run
  says "An earlier run stopped without finishing; cleared its lock." and
  removes it, then does journal recovery before anything else. A lock
  whose process is still running, or from another host, is never removed.
  Tests cover a stale lock followed by journal recovery
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465191563)). A test runs two
  overlapping writes (the same rule Codex raised for the Recall import)
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465135931)).
- Before changing any note, `--write` saves a journal
  (`<dir>/.atlas-links/journal.json`, temporary file plus rename, mode
  `0600`) listing each planned note write with its path, hash before and
  hash after. The journal is removed only after the snapshot is saved or
  kept. A run that finds a journal (an earlier run stopped) treats a note
  whose current hash equals its journaled after-hash as still matching its
  before-hash move evidence, then finishes the snapshot as above and
  removes the journal. Tests stop a run after a note write and before the
  snapshot rename, and check the next run still repairs the skipped link
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465166908)).
- Locks are published whole: the process id and host name are written to
  a temporary file first, which is then linked into place with
  `fs.linkSync` (which fails if the lock already exists) and the temporary
  file removed, so a lock is never empty or half-written. A lock file that
  is empty or can't be parsed is treated as stale and cleared with the
  same message. A test leaves an empty lock and checks the next run
  recovers
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465321707)).
- Reclaiming a stale lock has one winner. A command that finds a stale
  lock first takes a short reclaim lock (`<lock>.reclaim`, published whole
  the same way, failing if it exists), then reads the stale lock again and
  removes it only if it still names the same dead process it inspected,
  publishes its own lock, and removes the reclaim lock. A command that
  finds a reclaim lock stops with "Another command is recovering; try
  again in a moment." and writes nothing. A reclaim lock whose own process
  is gone (both runs stopped) is never cleared automatically: the command
  names it and prints the one `unlock` command, which removes it only after
  checking that process is gone. Tests run two recoverers against one
  stale lock and check exactly one proceeds
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465380765)).

## Rules For The Builder (GrokBot Team A)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, through Cursor, on the branch
  `OC-261103-atlas-link-repair`, signed in as `cloudwork-bot`. Open a pull
  request into `main` with auto-merge off and the label `agent: grokbot`.
  Never push to `main` directly, and never switch on auto-merge.
- Mark the work as AGENTS.md "Accounts And Provenance" says: `Cursor Agent`
  as commit author, and `— GrokBot team A, OC-261103-atlas-link-repair` as
  the last line of the pull request description and every comment.
- Run **no commands on the owner's Mac** for this job.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented notes only, with no real names.
- Change files only under `packages/atlas-links/`. Import
  `packages/atlas-index/` by relative path through its public export, in
  the tests only; if it lacks something, stop and report instead of
  changing it. Nothing else, not even `STATUS.md` (the coordinator updates
  it).
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network calls, no AI, no paid services, no `child_process`, no clock,
  in the code or the tests. No `fs` in the library; the command reads only
  under `--dir` and writes only the notes in `writes`, the snapshot file,
  and its safety files under `.atlas-links/` (`run.lock`,
  `run.lock.reclaim`, `journal.json`, and the temporary files used to
  publish each of them whole, which are removed once published; see
  "Carried To The Build"), or the tests' temporary folders.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the library, the command, the tests, the sample
  wiki and a short README (the rule, the command, and the owner's trial
  steps). Finishable in one to two days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Supported setups are macOS and the Linux CI runners on Node 22 (AGENTS.md
  "Review Guidelines"); don't add Windows-specific code.
- Edge cases this plan doesn't name: write each choice in the README's
  "Edge cases" section with a test.

## Review And Finish Line

Codex reviews it as code until it gives a 👍. GrokBot fixes every P1 and P2
or explains in the pull request why one doesn't apply. The coordinator
checks it against this plan, posts the check as a comment, and switches on
auto-merge once the plan check passes. Done when the tests pass with one
command, Codex has no open P1 or P2 on the latest commit (or the Codex
triage judge passes it, [codex-triage.md](codex-triage.md)), the plan check
finds nothing missing, and the owner trial passes.
