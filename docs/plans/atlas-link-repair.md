# Atlas Link Repair (PRD)

Status: Draft

Written November 3, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261103-atlas-link-repair`. Umbrella: Personal (the Atlas wiki). It
follows [atlas-index-engine.md](atlas-index-engine.md), whose check lists
broken links but leaves "fixes beyond index and map files" to a separate
plan. This is that plan, for the one fix that needs no judgement: a link
that broke because its note moved or was renamed, where exactly one note
still carries that name. **Builder:** GrokBot team A, under AGENTS.md
"Outside Builders", through Cursor and signed in as `cloudwork-bot`.
**Reviewers:** Codex reviews every push; the coordinator checks the result
against this plan. **Finish line:** the package merges with `tests`
passing, the command repairs the invented sample wiki so that
`packages/atlas-index/` reports none of the repaired links as broken, and
the owner trial below passes.

## Why

Notes get moved into folders and renamed as a wiki grows, and every move
breaks the links that pointed at the old place. The Atlas check already
lists them, but fixing each one by hand is the tedious part that makes
people stop tidying. When exactly one note has the name the link was
looking for, the fix is a rule, not a guess. Anything less certain is
listed for the person and left alone.

## What It Does

`planRepairs(notes)` in `packages/atlas-links/`, plain JavaScript, no
dependencies. It takes the wiki as data and returns data. It reads and
writes nothing itself.

### Input

`notes` is a list of `{ path, text }`, the same shape and the same path
rules as `buildAtlas` (relative, `/` separators, ends in `.md`; the same
refusals for empty, absolute, backslash, control characters, `.` or `..`
segments, and NFC duplicates). Generated indexes (text starting with the
atlas-index generated header) and the root map `MAP.md` are skipped: they
are rebuilt by atlas-index, never repaired here.

### Links It Reads

- Markdown links `[text](target)` whose target is relative and ends in
  `.md`, with an optional `#anchor`. `https:`, `mailto:` and any other
  scheme are ignored, as are absolute paths.
- Wiki links `[[name]]` and `[[name|label]]`.
- Links inside fenced code blocks (lines between ```` ``` ```` or `~~~`
  fences) and inline code spans are ignored.

A link is **broken** when its target does not resolve to a note by the
same rule atlas-index uses (markdown: the path relative to the note's
folder; wiki: a note whose file name without `.md` matches `name` after
NFC). A test checks that every link this package calls broken in the
sample wiki is also a `broken-link` in `buildAtlas` for the same notes,
and the other way round for the link kinds above.

### The One Rule

For each broken link, take the file name it was looking for (the last
segment without `.md`, or the wiki `name`), NFC-normalize it and compare it
without regard to letter case with every note's file name without `.md`.

- **Exactly one note matches:** propose a repair. A markdown link's
  target becomes the relative path from the linking note's folder to that
  note, keeping any `#anchor`. A wiki link's `name` becomes that note's
  file name exactly as spelled on disk, keeping any `|label`. Only the
  target text changes; the link text, label and every other byte of the
  note stay as they are.
- **No note or more than one note matches:** no repair. The link is listed
  under `needsYou` with the candidate paths (empty for none), so the
  person decides.
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

`node packages/atlas-links/src/repair.mjs --dir <folder> [--write] [--json]`

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
  writes an index or the map (running atlas-index afterwards rebuilds
  those).
- A refusal prints one plain message and exits 1. A result exits 0.

## When It Goes Wrong

- **Two notes share the name:** no repair; listed under `needsYou` with
  both paths.
- **The note was deleted, not moved:** no repair; listed with no
  candidates.
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
   the note's exact spelling, keeping the label.
4. An `#anchor` is kept.
5. Two notes with the same name: no repair, one `needsYou` entry with both
   paths. A deleted note: `needsYou` with no candidates.
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
    `writes`, keeps each file's mode, and a second run finds nothing to do.
11. A note edited between the scan and its rename is skipped and named; the
    other notes are written.
12. A `--dir` that holds `.git`, or is the repository root, is refused;
    hidden folders and symbolic links are skipped.
13. The same notes give byte-identical JSON twice, in either input order.

## Owner Trial

On a copy of a small notes folder (never the only copy):

1. Move one note into a new folder.
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
  under `--dir` and writes only the notes in `writes`, or the tests'
  temporary folders.
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
