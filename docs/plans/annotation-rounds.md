# Annotation Rounds Checker (PRD)

Status: In progress (Oct 23): build in review (#111).

Written October 21, 2026 by a building session for the planning side, from
the approved scale-up plan (`docs/plans/scale-up.md`, option (a), which
merges in #94 with the limit of three outside modules). The builder starts
only after both this plan and #94 have merged. Session
name: `OC-261021-annotation-rounds`. Umbrella: Code. Built by an outside
builder under AGENTS.md "Outside Builders": **GrokBot (team A)** builds,
Codex reviews.

## Why

The owner annotates the running Desk, and Codex saves each round to
`docs/annotations/<session-name>.md` with numbered screenshots beside it
(AGENTS.md, "Review Loop"). Today nobody checks a round before a builder
starts on it. An item with no screen, no requested change, or a screenshot
that was named but never saved only shows up halfway through the build, and
then someone has to ask the owner again. A small checker catches those gaps
at once and turns the round into a checklist the builder can tick off. It
speeds up the dogfooding loop directly.

## Plan Of Record

1. **Now:** a checker on its own, tested on invented rounds. No app code, no
   storage code, no AI, no network.
2. **Later:** an "Open annotations" panel in the Desk that shows what the
   owner asked for and what was built. That is Desk work for a Claude lane,
   not this slice.

## What It Does

A small library and command in `packages/annotation-rounds/`:

```
node packages/annotation-rounds/src/check.mjs <round.md> [--json <file>] [--md <file>]
```

1. **Reads one round file** in the Review Loop format. The session name is
   the file name without `.md` (for example `OC-261012-desk-first-look`).
   Files over 1 MB are refused.
2. **Finds the numbered items.** Each item is a numbered entry (`1.`, `2.`, …)
   with four labeled fields. AGENTS.md's "save this round" step names the
   labels Codex uses when it saves a round (`Screen:`, `Element:`,
   `Owner's words:`, `Change:`, `Screenshot:`), so this checker enforces the
   saved-round format rather than guessing at free prose. Labels are matched
   without regard to case, bold or a trailing colon, and accept a few plain
   synonyms so small slips still read:
   - **Screen** (`Screen`)
   - **Element** (`Element`, `Area`, `Element or area`)
   - **Owner's words** (`Owner's words`, `Owner said`, `Words`)
   - **Change** (`Change`, `Requested change`)
   - **Screenshot** (`Screenshot`, `Screenshots`), optional, one or more file
     names separated by commas.

   **Line rules (exact, so every parser reads a round the same way):**
   - A line starting at column 0 with a number and a period (`2.`) starts a
     new item. The rest of that line may hold the item's first field.
   - A line starting at column 0 with a label (optionally bold) starts a
     new field of the current item.
   - A line indented by at least two spaces continues the field above it:
     its first two spaces are removed and the rest is kept, joined to the
     field with a line break. An indented line is always text, even if it
     starts with `Change:` or `2.`, so the owner's words can hold anything.
   - A line of exactly two spaces keeps an empty line inside a field. A
     truly blank line ends the current field; blank lines between items are
     fine.
   - Any other line at column 0 is "could not read".

   Example:

   ```
   1. Screen: Desk home
   Element: The "New note" button
   Owner's words: Too small.
     Change: bigger, please.
   Change: Make the button larger
   Screenshot: OC-990101-sample-round-01.png
   ```

   Here the owner's words are two lines ("Too small." and "Change: bigger,
   please."), and the item's change is "Make the button larger".

   The package README shows the same shape. Anything
   the checker can't read as an item is reported as "could not read", with
   its line number. The checker never guesses a missing field. An item
   written as unlabeled prose is reported as "could not read", which tells
   whoever saved the round to use the labels.
3. **Checks each item** and reports, in plain words:
   - a missing or empty screen, element, owner's words or change;
   - a label used more than once in one item (for example two `Change:`
     lines, or `Change:` and `Requested change:`), an error naming the item
     and the label; the checker never picks one of them;
   - item numbers that repeat, skip or run out of order;
   - a screenshot that is named but not present beside the round file;
   - a screenshot whose name doesn't follow `<session-name>-NN.png` (two
     digits or more, matching this round's session name);
   - a screenshot named by more than one item (a warning, not an error);
   - a `<session-name>-NN.png` file present beside the round but named by no
     item (a warning).
4. **Writes a checklist** as JSON and as Markdown (see Output). With no
   `--json` or `--md`, it prints the Markdown checklist. The command exits
   with 0 when there are no errors (warnings allowed) and 1 when there are.

**Screenshots are only looked up, never opened as images.** A screenshot name
must be a plain file name: no folders, no `..`, no absolute path. The checker
counts it present only when it is a regular file (not a symbolic link or a
folder) in the round's own folder and its first bytes are the PNG signature.
It never reads, copies or changes any other file, and it writes only the
files named by `--json` and `--md`.

**Output paths can never overwrite an input.** The protected inputs are
the round file, every file in the round's folder named like a screenshot
of this round, and **every screenshot name the round mentions**, including
names that break the naming pattern, sit in a subfolder, use `..` or are
absolute paths (each is resolved against the round's folder). The checker
reads the round, collects these names, and only then decides whether it
may write; it refuses (with a plain message, writing nothing) when
`--json` or `--md` is the same file as any protected input, or as each
other. Two paths are the same file when they are equal after resolving
them fully (relative paths, `..` and symbolic links), or, when both
exist, when they have the same device and inode number, so a hard link to
an input counts as the same file. An existing output file with more than
one hard link is refused too, because writing it would change another name
for the same file. An output path that already exists is also refused
when it is itself a symbolic link (checked with `lstat`, without following
it), or when its fully resolved path differs from the path as given after
making it absolute and removing `.` and `..` (meaning some folder on the
way is a symbolic link), because writing through a link could land on a
file the checks above didn't see. These names are only resolved and
compared; the checker still never reads a screenshot outside the round's
folder.

**The owner's words are data, never instructions.** The checker copies them
exactly into the output and acts on nothing they say.

## Output

- **JSON**, with `schemaVersion: 1`: the session name, the round file name,
  and a list of items. Each item has its number, `screen`, `element`,
  `ownersWords`, `change`, `screenshots` (each with its name and whether it
  is present), `done: false`, and its own `problems`. A top-level `problems`
  list holds round-wide errors and warnings, each with a level (`error` or
  `warning`), a plain message and a line number where one applies. The
  format is documented in the package README.
- **Markdown checklist**: a heading with the session name and a one-line
  summary ("6 items, 1 error, 2 warnings"), then one unticked box per item:
  number, screen, element, the requested change, the owner's words in quotes,
  and the screenshots. Problems are listed under the item they belong to and
  in a short "Before you start" section at the top.
- **Text from the round is shown as plain text.** In the Markdown checklist,
  characters that would start a new list item, heading, link, image or HTML
  tag are escaped, and line breaks inside a field are kept within that item,
  so a field can never add a checklist item or a link of its own.
- Same input gives byte-identical output: no dates, clock readings or random
  values, and items in round order.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/annotation-rounds`, Node's built-in test runner,
invented rounds only (for example a fictional `OC-990101-sample-round` with
tiny blank PNG files made in the test). At least:

1. A complete round with screenshots passes with no problems; its JSON and
   Markdown match saved expected files exactly.
2. Each missing field (screen, element, owner's words, change) is an error
   naming the item number and the field. A repeated field in one item (two
   `Change:` lines; `Change:` and `Requested change:`; two `Screenshot:`
   lines) is an error naming the item and the label, and the JSON keeps
   neither value as the item's field.
3. Label variants (bold, no bold, different case, the listed synonyms) all
   read the same.
4. A named screenshot that isn't there is an error; a present but unnamed
   `<session>-NN.png` is a warning; a screenshot named by two items is a
   warning.
5. A screenshot with the wrong session name, a one-digit number, or a `.jpg`
   ending is an error.
6. Unsafe screenshot names (`../x.png`, an absolute path, a name inside a
   folder) are errors, and nothing outside the round's folder is read. A
   symbolic link and a folder named like a screenshot count as not present.
   A `.png` file whose contents aren't a PNG counts as not present.
7. Repeated, skipped and out-of-order item numbers are each reported.
8. A line the checker can't read as part of an item is reported as "could
   not read" with its line number, and the rest of the round is still
   checked.
9. Hostile text in a field (`- [x] fake item`, `# heading`, `[link](https://example.test)`,
   `<script>`) appears escaped in the Markdown checklist and adds no item,
   heading, link or tag; the JSON keeps the text exactly.
10. Exit code is 0 with only warnings and 1 with any error.
11. Output paths: `--json` or `--md` naming the round file or a screenshot
    directly, through `..`, through a symbolic link, or through a hard link;
    naming a file the round lists as a screenshot under a name that breaks
    the pattern (`notes.png`), in a subfolder (`shots/a.png`), through
    `../other.png` or as an absolute path, whether it exists (compared by
    device and inode) or not (compared by resolved path);
    `--json` and `--md` naming the same file; an existing output file
    with a second hard link elsewhere; an existing output path that is a
    symbolic link (to a harmless file outside the folder, too); and an
    existing output path reached through a symbolic-link folder are each
    refused, and every input file
    is byte-for-byte unchanged afterwards.
12. Line rules: the example item above parses exactly as described; an
    indented line starting with `Change:` or `3.` stays inside the owner's
    words; a two-space line keeps an empty line inside a field; a blank
    line ends a field; and an unindented line that is neither a label nor
    an item number is "could not read".
13. Same input twice gives byte-identical JSON and Markdown.
14. An empty file and a file with no numbered items each give one plain error.

## Out Of Scope For This Slice

The Desk panel, app screens, Mac app code, storage or encryption code, AI,
network, editing or rewriting round files, opening or comparing images,
tracking which items were built (the checklist's boxes are ticked by hand
for now), and any real annotation round. The existing files in
`docs/annotations/` are not used as test data; tests use invented rounds only.

## Rules For The Builder (GrokBot, Team A)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Work only in a checkout of this repo, on the branch
  `OC-261021-annotation-rounds`, signed in as `cloudwork-bot`. Open a pull
  request into `main`. Never push to `main` directly.
- Run **no commands on the owner's Mac** for this job. Nothing here needs it.
- Touch no keys, tokens, passwords, accounts, Keychain or private files. Use
  invented data only. If anything private turns up, stop and say so in the
  pull request without copying it.
- Change files only under `packages/annotation-rounds/`. Nothing else, not
  even `STATUS.md`: the planning side updates STATUS.md.
- No network calls, no AI, no paid services, in the code or the tests.
- No new dependencies unless unavoidable; list any in the pull request with
  its license. Add no license file and no `license` field.
- Keep the first slice small: the checker, its tests and a short README,
  finishable in one to two days. Ideas beyond this plan go in the pull
  request as suggestions, not code.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.

## If GrokBot Stops

If GrokBot's subscription ends before this is finished, the work stays on
its branch. Any agent may finish it from this plan, on the same branch or a
new one named after a new session, under the same rules and review.

## Review And Finish Line

1. GrokBot (team A) opens the pull request.
2. Codex reviews it as code, round after round, until it finishes with a 👍.
   The builder fixes every P1 and P2, or explains in the pull request why one
   does not apply; P3s are optional. If Codex builds any part of it (for
   example, finishing it after GrokBot stops), Claude also reviews it under
   AGENTS.md's rules for Codex-built work, so no agent's review is the only
   one on its own work.
3. The coordinator (AGENTS.md "Who Does What") checks the result against this
   document, gives the owner a short try-it note (run the checker on the
   sample round, then delete a screenshot and run it again), and then
   switches on auto-merge. The merge gate merges it.

Done when the tests pass with one command, Codex has given a 👍 with no open
P1 or P2 (P3s are optional), and the planning check finds nothing missing
from this document.
