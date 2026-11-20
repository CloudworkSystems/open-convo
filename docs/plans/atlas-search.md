# Atlas Search: Find A Note By What It Says (PRD)

Status: Draft (Nov 5): waiting on the owner's yes in the Claude thread "Draft next plans for outside builders".

Written November 5, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261105-atlas-search`. Umbrella: Personal (the Atlas wiki). It follows
[atlas-index-engine.md](atlas-index-engine.md) (indexes, the map and the
health check) and [atlas-link-repair.md](atlas-link-repair.md) (moved-note
links). Those keep the wiki tidy. This one finds things in it: a person
types a few words and gets the notes that say them, best first, with the
line that matched. It only reads. **Builder:** GrokBot team A, under
AGENTS.md "Outside Builders", through Cursor and signed in as
`cloudwork-bot`. **Reviewers:** Codex reviews every push; the coordinator
checks the result against this plan. **Finish line:** the package merges
with `tests` passing, and the owner trial below passes on a copy of a
small notes folder.

## Why

A wiki is only worth keeping if things can be found again. Folder indexes
help when you know where a note lives; they don't help when you remember
only what it said. Search by words is plain, repeatable code with no model
and no account, so it can be built now, used this week on the owner's own
notes, and later sit behind the Desk's search box and the prime agent's
"look it up in Atlas" step.

## Plan Of Record

1. **Now (this slice):** a library that ranks notes for a query, and a
   read-only command.
2. **Later, separate plans:** the Desk search box, a saved index for very
   large wikis, and any ranking that uses a model. This slice has none of
   those.

## What It Does

`packages/atlas-search/`, plain JavaScript, no dependencies.

### The Library

`searchNotes(notes, { query, limit })` takes `notes` as a list of
`{ path, text }`, the same shape `packages/atlas-index/` uses, and returns
`{ results, notes }`:

- `results`: up to `limit` (1 to 50, default 10) matches, best first. Each
  is `{ path, about, score, line, lineNumber }`:
  - `about` is what the note is about, by atlas-index's documented rule
    (front matter `description:`, then the first `# ` heading, then the
    first non-empty line cut to 120 characters on a word boundary, then
    the file name). atlas-index doesn't export that function, so this
    package follows the rule as its README states it, and a test checks
    it against the link labels in the folder indexes `buildAtlas`
    generates for the sample wiki.
  - `line` is the first line of the note with the most query words, cut to
    160 characters on a word boundary with "…" where text was left out,
    and `lineNumber` is its 1-based number.
- `notes`: plain sentences for the person, such as "No note matches." or
  "12 more notes match; add a word to narrow it down."

### The Rules

1. **Words, plainly.** Text and query are lower-cased, accents folded
   (NFKD, combining marks removed), and split on anything that isn't a
   letter or digit. A fixed English stop-word list in the package is left
   out. Fenced code, inline code and front matter other than
   `description:` and `name:` are not searched, matching atlas-index's
   rule for links.
2. **Ranking is BM25** with k1 = 1.2 and b = 0.75 over every note given.
   A word in the file name or the note's `about` line counts twice. A
   note that shares no word with the query is never returned. Ties break
   by path in UTF-16 order. The same notes and query, in any input order,
   give the same output byte for byte.
3. **Quotes mean together.** A part of the query in double quotes, such as
   `"seed potatoes"`, matches only notes where those words appear next to
   each other in that order, after folding. An unclosed quote is treated
   as ordinary words.
4. **Generated files don't compete.** The map (`MAP.md`) and generated
   folder indexes (the atlas-index header) are left out of results, so a
   note never loses to the index that lists it. A hand-made `INDEX.md` is
   an ordinary note.
5. **Nothing changes.** The library reads no files, no clock and no
   network, and returns new objects without changing its input.

### The Command

`node packages/atlas-search/src/search.mjs --dir <folder> [--limit n] [--json] "words to find"`

- It reads the folder itself, by the reading rules atlas-index's README
  states: every `.md` file under `--dir`, skipping hidden folders and
  symbolic links, and refusing a `--dir` that holds `.git` or is this
  repository's root. (atlas-index's `scanDirectory` isn't part of its
  public export, so this package doesn't import it.) A test reads the
  sample wiki both ways, this command's reader and `scanDirectory`
  imported from `packages/atlas-index/src/atlas.mjs` in the test only,
  and checks they give the same notes.
- It prints each result as the note's path, its about line, and the
  matched line with its number, then the notes. `--json` prints the
  library's result.
- It writes nothing, anywhere: no index, no cache, no history file.

## When It Goes Wrong

The command's output is a screen the owner sees, so it answers the five
questions in [when-it-goes-wrong.md](when-it-goes-wrong.md):

1. **No connection.** Doesn't apply: no network.
2. **Interrupted.** Doesn't apply: nothing is written, so a stopped run
   leaves everything as it was. Running again gives the same answer.
3. **Empty or first run.** A folder with no notes prints "There are no
   notes in this folder yet." A query with no match prints "No note
   matches. Try fewer words, or a word you'd expect in the note's title."
   A query made only of stop words prints "Those words are too common to
   search on. Add a word that's special to the note."
4. **Denied or stuck.** A folder that doesn't exist or can't be read
   prints "Can't read that folder: <the folder as typed>." A refused
   folder prints atlas-index's own refusal. A note that isn't valid UTF-8
   is left out and named in a note ("Skipped 1 file that isn't plain
   text: <path>."), and the rest are searched.
5. **The error message.** Each refusal is one plain sentence naming what
   was wrong (an empty query, a query over 500 characters, a limit out of
   range), with no stack trace, and exit code 1.

## Tests (Must Pass, Run By One Command)

`npm test` inside `packages/atlas-search/`, on an invented sample wiki in
`tests/fixtures/` (invented notes only):

1. A query finds the note that says it, ahead of a note that says it once
   in passing; an exact score for a small hand-worked example.
2. Folding: upper case, accents (`café` finds `cafe`), punctuation, and
   stop words; a stop-word-only query gives its message.
3. File name and about-line words count twice, and the about line matches
   the label atlas-index's `buildAtlas` gives every sample note in its
   generated folder index (test-only import, labels unescaped).
4. Quoted phrases: a match, a non-adjacent miss, the wrong order missing,
   and an unclosed quote treated as words.
5. Fenced code, inline code and other front matter are not searched;
   `description:` and `name:` are.
6. `MAP.md` and generated indexes never appear; a hand-made `INDEX.md`
   can.
7. The matched line: the line with the most query words wins, ties go to
   the earlier line, a long line is cut on a word boundary with "…", and
   `lineNumber` is right with CRLF line endings.
8. Limits: default 10, `--limit 1` and `--limit 50`, the "more notes
   match" note, and each out-of-range value refused.
9. The same output byte for byte twice, and with the notes in reverse
   order.
10. The library never reads the clock, imports `child_process` or a
    network module, or uses `fs` (a test checks the source).
11. The command: reads the same notes as atlas-index's `scanDirectory`
    on the sample wiki, writes no file (a test lists the folder, hidden
    files included, before and after), skips hidden folders and symbolic
    links,
    refuses a folder holding `.git`, skips and names a file that isn't
    valid UTF-8, and prints each "When It Goes Wrong" message.

## Owner Trial

On a copy of a small notes folder (never the only copy), or the sample
wiki:

1. Search for a word he knows is in one note and see that note first,
   with the line that says it.
2. Search for two words in quotes and see only notes with that phrase.
3. Search with an accent or capital letters the note doesn't use and see
   it still found.
4. Search for something no note says and see the "No note matches"
   message.
5. Search for "the and of" and see the "too common" message.
6. Run on an empty folder and see "There are no notes in this folder
   yet."
7. Run on a folder that doesn't exist and see "Can't read that folder".
8. Add a file that isn't plain text and see it named as skipped while the
   rest are searched.
9. Run with `--limit 0`, with an empty query, and with a query over 500
   characters, and see each refusal.
10. Run with `--dir` set to a folder that holds `.git` (for example this
    repository's root) and see atlas-index's refusal.
11. Check the folder afterwards: nothing in it changed.

He confirms each message says what to do next.

## Carried To The Build

Codex findings from the plan review's later rounds, which the code pull
request must meet (docs/agent-process.md "Plans stop after two Codex
rounds"):

- A note matched only by its file name or about line (no searched content line holds a query word, or the note is empty) is still returned, with `line: null` and `lineNumber: null`. The command shows "(matched by its title)" in place of a line, never an unrelated first line. Tests cover an empty `seed-potatoes.md` and a note whose only match is its file name ([thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4479814048)).
- BM25's word weight is the smoothed form `idf = ln(1 + (N - df + 0.5) / (df + 0.5))`, where `N` is the number of notes ranked (generated files left out) and `df` the number that hold the word, so it is never negative, even for a word in most of them. The hand-worked exact-score test uses this formula ([thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4479950988)).
- A quoted phrase matches only within one line: words that end one line and start the next are not "next to each other", so the matched `line` always shows the whole phrase. The phrase and snippet tests include a phrase split across two lines that does not match ([thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4480005713)).
- The matched `line` is chosen only from searchable lines: a line inside fenced code, front matter other than `description:` and `name:`, or a line whose only query words are in inline code is never shown as the match. A test gives a note one searchable match and a code line with more query words, and checks the searchable line is shown ([thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4480032811)).
- When the query holds a quoted phrase, the matched `line` is chosen only among lines that hold the most of the query's quoted phrases (every one, when a line has them all); the most-query-words rule and the earlier-line tie-break apply within those. A test with `"seed potatoes" crop calendar planting` checks the phrase line is shown over a line with more unquoted words ([thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4480109993)).
- The `about` line is still shown by atlas-index's rule, but the title boost counts only words of the `about` line that are themselves read under rule 1: when atlas-index's rule picks a heading or line from inside fenced code, inline code or excluded front matter, those words get no boost and are not read at all; the file name boost still applies. A test gives two notes the same `# heading` only inside fenced code and checks it adds nothing to the score or the match ([thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4480225555)).
- A generated index is recognized with atlas-index's exported `isGeneratedIndex` (imported through `src/index.mjs`), so one that starts with a byte-order mark is left out too. A test adds a BOM-prefixed generated index and checks it never appears and changes no score ([thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4480247770)).
- Any span left out of reading inside a line (inline code, a link target, the part of `[[...]]` before `|`) is a phrase boundary: the words on either side of it are not "next to each other", so ``seed `x` potatoes`` never matches `"seed potatoes"`. A test puts a quoted phrase's two words on either side of an inline-code span and checks the note is not returned for that phrase ([thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4480537688)).
- Stop words are dropped only for scoring. A quoted phrase is checked against the folded words with stop words kept, so `"state of the art"` matches only `state of the art` in that order, never `state art`. A test covers a quoted phrase that holds stop words ([thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4480311634)).
- A matched line over 160 characters is cut to a 160-character window that starts at a word boundary before the first query word (or quoted phrase) on that line, with "…" on each side where text was left out, so the shown text always holds the words that matched. When the query's quoted phrases on that line don't all fit in one 160-character window, the snippet joins one short window per quoted phrase, in line order, separated by " … ", so every quoted phrase that made the note match stays visible. When the query's quoted phrases sit on different lines, so no one line holds them all, `line` and `lineNumber` stay the one chosen line, and the result adds `also`: one `{ lineNumber, line }` for each phrase missing from the chosen line, taken from the earliest searchable line that holds it, in note order, each cut by the same window rule. `also` is an empty list otherwise. The command prints each `also` line under the main one with its own line number, so no text is ever shown under a line number it didn't come from. Every quoted phrase that made the note match is visible in what is shown. Tests put the only match near the end of a long line, two quoted phrases more than 160 characters apart on one line, and two quoted phrases on separate lines ([thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4480433535), [thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4480358784), [thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4480383843)).
- Generated files are left out before any ranking number is computed: `MAP.md` and generated folder indexes count toward no document frequency, note count or average length, so rebuilding the map or indexes never changes a real note's score or place. A test adds them to the sample and checks the real notes' scores and order are unchanged ([thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4479923966)).
- The owner trial covers every refusal the command promises, including a query over 500 characters and a `--dir` holding `.git` (trial steps 9 and 10) ([thread](https://github.com/CloudworkSystems/open-convo/pull/303#discussion_r4479836666)).

## Out Of Scope For This Slice

- Any model, embedding or "smart" ranking; spelling correction; word
  stems ("seeds" and "seed" are different words in this slice).
- A saved index, a cache, a watch mode, or the Desk search box.
- Searching anything but the notes in the folder given: no email, no
  Recall export, no memory.
- Real notes in the repo. Nothing from anyone's actual wiki goes into the
  tests or the sample.

## Rules For The Builder (GrokBot Team A)

These are rules the builder must follow; the setup does not enforce them,
so breaking one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, through Cursor, on the branch
  `OC-261105-atlas-search`, signed in as `cloudwork-bot`. Open a pull
  request into `main` with auto-merge off and the label `agent: grokbot`.
  Never push to `main` directly, and never switch on auto-merge.
- Mark the work as AGENTS.md "Accounts And Provenance" says: `Cursor Agent`
  as commit author, and `— GrokBot team A, OC-261105-atlas-search` as the
  last line of the pull request description and every comment.
- Run **no commands on the owner's Mac** for this job.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented notes only, with no real names.
- Change files only under `packages/atlas-search/`. Import
  `packages/atlas-index/` by relative path through its public export
  (`src/index.mjs`) in the library, if at all; the tests may also import
  its `src/atlas.mjs` to compare readers. If it lacks something else,
  stop and report instead of changing it. Nothing else, not even
  `STATUS.md` (the coordinator updates it).
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network calls, no AI, no paid services, no `child_process`, no clock,
  in the code or the tests. No `fs` in the library; the command only
  reads, by the reading rules above, and writes nothing. The
  tests may write only in their own temporary folders.
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

Codex reviews it as code until it gives a 👍. GrokBot fixes every P1 and P2
or explains in the pull request why one doesn't apply. The coordinator
checks it against this plan, posts the check as a comment, and switches on
auto-merge once the plan check passes. Done when the tests pass with one
command, Codex has no open P1 or P2 on the latest commit (or the Codex
triage judge passes it, [codex-triage.md](codex-triage.md)), the plan check
finds nothing missing, and the owner trial passes.
