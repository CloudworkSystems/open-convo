# Atlas Related Notes: What Else Do I Have On This? (PRD)

Status: Draft (Nov 5): waiting on the owner's yes in the Claude thread "Draft next plans for outside builders".

Written November 5, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261105-atlas-related`. Umbrella: Personal (the Atlas wiki; PLAN.md
step 7, "Related"). It follows [atlas-index-engine.md](atlas-index-engine.md)
and [recall-import.md](recall-import.md), which brings the owner's Recall
cards into the wiki as notes. With that many notes, a person reading one
wants to know what else they kept on the same subject. This package
answers that: give it one note, and it lists the other notes that share the
most unusual words with it, best first, with the words they share. It only
reads. **Builder:** Codex team A, under AGENTS.md "Outside Builders".
**Reviewers:** Codex reviews every push; GrokBot or a fresh Claude gives
the independent review with the risk-review checklist, because it reads the
owner's personal notes; the coordinator checks it against this plan.
**Finish line:** the package merges with `tests` passing, and the owner
trial below passes on a copy of a small notes folder.

## Why

Search ([atlas-search.md](atlas-search.md)) helps when you know what words
to type. "Related" helps when you don't: you're reading a note about seed
potatoes and the wiki reminds you of the planting calendar and the note on
blight you wrote a year ago. It is plain, repeatable code with no model and
no account, so it can be used this week on the notes Recall import brings
in, and later sit beside each note in the Desk.

## Plan Of Record

1. **Now (this slice):** a library that ranks the notes most like one note,
   and a read-only command.
2. **Later, separate plans:** a "Related" panel in the Desk, writing
   suggested links into notes, a saved index, and any ranking that uses a
   model or embeddings. This slice has none of those.

## What It Does

`packages/atlas-related/`, plain JavaScript, no dependencies.

### The Library

`relatedNotes(notes, { path, limit })` takes `notes` as a list of
`{ path, text }`, the same shape `packages/atlas-index/` uses, plus the
`path` of the note to start from, and returns `{ results, notes }`:

- `results`: up to `limit` (1 to 50, default 10) other notes, best first.
  Each is `{ path, about, score, shared }`:
  - `about` is what the note is about, by atlas-index's documented rule
    (front matter `description:`, then the first `# ` heading, then the
    first non-empty line cut to 120 characters on a word boundary, then
    the file name). atlas-index doesn't export that function, so this
    package follows the rule as its README states it, and a test checks it
    against the link labels in the folder indexes `buildAtlas` generates
    for the sample wiki.
  - `score` is the similarity, from 0 to 1, rounded to 4 decimal places.
  - `shared` is up to 5 words both notes use, the ones that weigh most in
    the score first (ties by the word in UTF-16 order), so the person sees
    why it was picked.
- `notes`: plain sentences for the person, such as "No other note shares
  enough words with this one."

### The Rules

1. **Words, plainly.** Text is lower-cased, accents folded (NFKD,
   combining marks removed), and split on anything that isn't a letter or
   digit. Words of one character, words made only of digits, and a fixed
   English stop-word list in the package are left out. Fenced code, inline
   code, link targets in every form atlas-index reads (the part in `(...)`
   of a markdown link; and inside any `[[...]]` wiki link, everything
   before the first `|`, so the name and any `#anchor` in `[[name]]`,
   `[[name#anchor]]`, `[[name|label]]` and `[[name#anchor|label]]` are
   left out and only a `label` is read) and front matter other than `description:` and `name:` are not read, so two
   notes aren't related just because they link to the same file. Word
   stems aren't joined ("seeds" and "seed" are different words).
2. **Unusual words count most.** Each note becomes a list of word weights:
   the word's count in the note times its rarity, `ln(1 + N / df)`, where
   `N` is the number of notes given (not counting left-out files) and `df`
   the number of them that use the word. The `1 +` keeps every weight above
   zero, so in a folder of two notes, or for a word every note uses, a
   shared word still counts, only less. A word used by only one note can't
   be shared and drops out. The score is the cosine of the two lists. A
   note that shares no word with the starting note is never returned.
3. **Titles count twice.** A word in the file name or the note's `about`
   line counts twice in that note.
4. **Generated files don't compete.** The map (`MAP.md`) and generated
   folder indexes (the atlas-index header) are left out of results and out
   of `N` and `df`, so a note is never "related" to the index that lists
   it. A hand-made `INDEX.md` is an ordinary note.
5. **Same answer every time.** Ties break by path in UTF-16 order. The
   same notes and starting path, in any input order, give the same output
   byte for byte. Scores are computed in a fixed order so rounding never
   depends on input order.
6. **Nothing changes.** The library reads no files, no clock and no
   network, and returns new objects without changing its input.

### The Command

`node packages/atlas-related/src/related.mjs --dir <folder> [--limit n] [--json] <note path>`

- `<note path>` is relative to `--dir`, as the person would see it in the
  map (`garden/seed-potatoes.md`). It must name a `.md` file inside the
  folder; a path with `..` that leaves the folder, or an absolute path, is
  refused.
- It reads the folder itself, by the reading rules atlas-index's README
  states: every `.md` file under `--dir`, skipping hidden folders and
  symbolic links, and refusing a `--dir` that holds `.git` or is this
  repository's root. (atlas-index's `scanDirectory` isn't part of its
  public export, so this package doesn't import it.) A test reads the
  sample wiki both ways, this command's reader and `scanDirectory`
  imported from `packages/atlas-index/src/atlas.mjs` in the test only, and
  checks they give the same notes.
- It prints the starting note's about line, then each result as the note's
  path, its about line, and "shares: " with the shared words, then the
  notes. `--json` prints the library's result.
- It writes nothing, anywhere: no index, no cache, no history file.

## When It Goes Wrong

The command's output is a screen the owner sees, so it answers the five
questions in [when-it-goes-wrong.md](when-it-goes-wrong.md):

1. **No connection.** Doesn't apply: no network.
2. **Interrupted.** Doesn't apply: nothing is written, so a stopped run
   leaves everything as it was. Running again gives the same answer.
3. **Empty or first run.** A folder with no notes prints "There are no
   notes in this folder yet." A folder whose only note is the starting
   note prints "This is the only note here, so nothing can be related to
   it yet." A note with nothing in common with the rest prints "No other
   note shares enough words with this one. Related notes show up as the
   wiki grows." A starting note with no words left after the rules (empty,
   or only code or links) prints "This note has no words to compare yet."
4. **Denied or stuck.** A folder that doesn't exist or can't be read
   prints "Can't read that folder: <the folder as typed>." A refused
   folder prints atlas-index's own refusal. A note path that isn't in the
   folder prints "There's no note at <the path as typed> in that folder."
   A note that isn't valid UTF-8 is left out and named in a note ("Skipped
   1 file that isn't plain text: <path>."), and the rest are compared; if
   it is the starting note, the command prints "Can't compare <path>: it
   isn't plain text." and stops with exit code 1.
5. **The error message.** Each refusal is one plain sentence naming what
   was wrong (no note path, a path outside the folder, a generated index or
   `MAP.md` given as the starting note, a limit out of range), with no
   stack trace, and exit code 1.

## Tests (Must Pass, Run By One Command)

`npm test` inside `packages/atlas-related/`, on an invented sample wiki in
`tests/fixtures/` (invented notes only, at least 12 notes in three folders):

1. The note on the same subject ranks ahead of one that shares only common
   words; an exact score for a small hand-worked example of three notes.
2. Folding: upper case, accents (`café` and `cafe` are one word),
   punctuation, one-character words, digit-only words and stop words.
3. A word in only one note never counts; a word in every note weighs
   least but more than zero; a folder of exactly two related notes returns
   the other note.
4. File name and about-line words count twice, and the about line matches
   the label atlas-index's `buildAtlas` gives every sample note in its
   generated folder index (test-only import, labels unescaped).
5. Fenced code, inline code, link targets (markdown and every `[[...]]`
   form, including `[[name#anchor|label]]`; two notes linking to the same
   target or section score zero) and other front matter are
   not read; `description:` and `name:` are.
6. `MAP.md` and generated indexes never appear and don't change any score;
   a hand-made `INDEX.md` can appear.
7. `shared`: at most 5 words, heaviest first, ties by word.
8. Limits: default 10, `--limit 1` and `--limit 50`, and each out-of-range
   value refused.
9. The same output byte for byte twice, and with the notes in reverse
   order.
10. The library never reads the clock, imports `child_process` or a network
    module, or uses `fs` (a test checks the source).
11. The command: reads the same notes as atlas-index's `scanDirectory` on
    the sample wiki, writes no file (a test lists the folder, hidden files
    included, before and after), skips hidden folders and symbolic links,
    refuses a folder holding `.git`, refuses a note path outside the
    folder, skips and names a file that isn't valid UTF-8, and prints each
    "When It Goes Wrong" message.

## Owner Trial

On a copy of a small notes folder (never the only copy), or the sample
wiki:

1. Pick a note and see, first in the list, another note he'd agree is on
   the same subject, with the shared words that explain it.
2. Pick a note with a common word in its title and see that the common
   word alone doesn't pull in unrelated notes.
3. Run on an empty folder and see "There are no notes in this folder yet."
4. Run on a folder with one note and see "This is the only note here".
5. Pick a note on a subject nothing else covers and see the "No other note
   shares enough words" message.
6. Run on a folder that doesn't exist and see "Can't read that folder".
7. Give a note path that isn't there and see "There's no note at".
8. Add a file that isn't plain text and see it named as skipped while the
   rest are compared; then pick that file as the starting note and see the
   "Can't compare <path>: it isn't plain text."
9. Pick an empty note, or one holding only code, as the starting note and
   see "This note has no words to compare yet."
10. Run on a folder of exactly two notes on the same subject and see the
    other note listed.
11. Run with `--limit 0`, with no note path, with `MAP.md` as the note,
    and with `../` in the note path, and see each refusal.
12. Run with `--dir` set to a folder that holds `.git` (for example this
    repository's root) and see atlas-index's refusal.
13. Check the folder afterwards: nothing in it changed.

He confirms each message says what to do next.

## Carried To The Build

Codex findings from the plan review's later rounds, which the code pull
request must meet (docs/agent-process.md "Plans stop after two Codex
rounds"):

- The `about` line is still shown by atlas-index's rule, but the title boost counts only words of the `about` line that are themselves read under rule 1: when atlas-index's rule picks a heading or line from inside fenced code, inline code or excluded front matter, those words get no boost and are not read at all; the file name boost still applies. A test gives two notes the same `# heading` only inside fenced code and checks it adds nothing to either note's weights ([thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4480225564)).

## Out Of Scope For This Slice

- Any model, embedding or "smart" ranking; word stems; synonyms.
- Writing links or a "Related" section into notes; a saved index, a cache,
  a watch mode, or a Desk panel.
- Using the links between notes in the score (a later slice may show
  "already linked" beside a result).
- Comparing anything but the notes in the folder given.
- Real notes in the repo. Nothing from anyone's actual wiki goes into the
  tests or the sample.

## Rules For The Builder (Codex Team A)

The builder must follow these; the setup does not enforce them, so breaking
one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, on the branch `OC-261105-atlas-related`, signed in
  as `cloudwork-bot` (or as Codex's own GitHub app for a cloud task). Open
  a pull request into `main` with auto-merge off and the label
  `agent: codex`. Never push to `main` directly, and never switch on
  auto-merge.
- End the pull request description and every comment with
  `— Codex team A, OC-261105-atlas-related`.
- Run **no commands on the owner's Mac** apart from `npm test` inside
  `packages/atlas-related/` and the `git` and `gh` commands needed to
  commit, push and open the pull request.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented notes only, with no real names.
- Change files only under `packages/atlas-related/`. Import
  `packages/atlas-index/` by relative path through its public export
  (`src/index.mjs`) in the library, if at all; the tests may also import
  its `src/atlas.mjs` to compare readers. Don't import
  `packages/atlas-search/`, which is built in parallel. If atlas-index
  lacks something else, stop and report instead of changing it. Nothing
  else, not even `STATUS.md` (the coordinator updates it).
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network calls, no AI, no paid services, no `child_process`, no clock,
  in the code or the tests. No `fs` in the library; the command only
  reads, by the reading rules above, and writes nothing. The tests may
  write only in their own temporary folders.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the library, the command, the tests, the sample
  wiki and a short README (the rules, the command, and the owner's trial
  steps). Finishable in one day.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Supported setups are macOS and the Linux CI runners on Node 22 (AGENTS.md
  "Review Guidelines"); don't add Windows-specific code.
- Edge cases this plan doesn't name: write each choice in the README's
  "Edge cases" section with a test.

## Review And Finish Line

Codex reviews it as code until it gives a 👍. Codex team A fixes every P1
and P2 or explains in the pull request why one doesn't apply. GrokBot or a
fresh Claude gives the independent review with the risk-review checklist.
The coordinator checks it against this plan and switches on auto-merge once
both are clean on the same head. Done when the tests pass with one
command, the reviews are clean (or the Codex triage judge passes it,
[codex-triage.md](codex-triage.md)), the plan check finds nothing missing,
and the owner trial passes.
