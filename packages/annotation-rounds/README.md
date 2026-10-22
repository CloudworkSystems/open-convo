# Annotation rounds checker

A small checker for one saved annotation round. It reads the round Codex writes
under `docs/annotations/`, reports gaps in plain words, and prints a checklist
a builder can tick off by hand.

It does not open images, edit the round, talk to the network, or follow
instructions written in the owner's words. Those words are copied into the
checklist as text. There are no dependencies. Node 22 or later.

```sh
cd packages/annotation-rounds
npm test
node src/check.mjs tests/fixtures/OC-990101-sample-round.md
```

To see a missing screenshot, copy that fixture folder somewhere else, delete
one of the `.png` files, and run the checker on the copy.

```sh
node src/check.mjs <round.md> [--json <file>] [--md <file>]
```

With neither `--json` nor `--md`, the Markdown checklist is printed. The
command exits 0 when there are no errors (warnings are allowed) and 1 when
there is an error, or when it refuses a round or an output path.

## Round format

The session name is the file name without `.md`. A file over 1 MB
(1,048,576 bytes) is refused and nothing is written.

Each item is a numbered line at column 0 (`1.`, `2.`, …). The rest of that
line may hold the first field. A label at column 0 starts a field. A line
indented by at least two spaces continues the field above it: the first two
spaces are removed and the rest is joined with a line break. An indented line
is always text, even when it starts with `Change:` or `2.`. A line of exactly
two spaces keeps an empty line inside the field. A blank line ends the field.
Any other line at column 0 is reported as "could not read", with its line
number, and the rest of the round is still checked.

Labels ignore case, a trailing colon, and `**bold**` or `__bold__`. The
synonyms are:

| Field | Labels |
| --- | --- |
| Screen | `Screen` |
| Element | `Element`, `Area`, `Element or area` |
| Owner's words | `Owner's words`, `Owner said`, `Words` |
| Change | `Change`, `Requested change` |
| Screenshot | `Screenshot`, `Screenshots` (optional) |

Screenshot names are separated by commas. A name has to be a plain file in
the round's own folder, named `<session>-NN.png` with two or more digits.
The checker counts it present only when that path is a regular file whose
first bytes are the PNG signature. A symbolic link, a folder, a missing
file, or any other contents count as not present. Nothing outside the
round's folder is read.

```
1. Screen: Desk home
Element: The "New note" button
Owner's words: Too small.
  Change: bigger, please.
Change: Make the button larger
Screenshot: OC-990101-sample-round-01.png
```

Here the owner's words are `Too small.` and then `Change: bigger, please.`.
The item's change is `Make the button larger`.

## What it reports

Errors:

- a missing or empty screen, element, owner's words, or change
- the same label twice in one item (neither value is kept)
- an item number that repeats, skips, or is out of order. A skip of 20 numbers or fewer names each missing number. A longer skip is one range. A number with more than 15 digits is one "too large" error and is left out of that check
- a screenshot name that is not `<session>-NN.png`, including a folder, `..`, or an absolute path
- a screenshot that is named but not present
- a line that could not be read
- an empty round, or a round with no numbered items

Warnings:

- one screenshot named by more than one item
- a `<session>-NN.png` file beside the round that no item names

## Checklist

JSON uses `schemaVersion: 1`. It has the session name, the round file name,
`items`, and round-wide `problems`. Each item has `number`, `screen`,
`element`, `ownersWords`, `change`, `screenshots` (`name` and `present`),
`done: false`, and its own `problems`. A problem has `level` (`error` or
`warning`), `message`, and `line` (a line number, or `null`). The same round
produces the same bytes every time.

```json
{
  "schemaVersion": 1,
  "session": "OC-990101-sample-round",
  "roundFile": "OC-990101-sample-round.md",
  "items": [
    {
      "number": 1,
      "screen": "Desk home",
      "element": "The \"New note\" button",
      "ownersWords": "Too small.\nChange: bigger, please.",
      "change": "Make the button larger",
      "screenshots": [{ "name": "OC-990101-sample-round-01.png", "present": true }],
      "done": false,
      "problems": []
    }
  ],
  "problems": []
}
```

The Markdown checklist starts with the session name, a one-line summary
(`2 items, 0 errors, 0 warnings`), and a "Before you start" section. Then
one unticked box per item, with the screen, element, change, the owner's
words in quotes, and the screenshots. Problems are listed again under the
item they belong to. Text from the round is escaped so it cannot add a
heading, list item, link, image, or HTML tag. A backslash already in the
text is escaped first, so it cannot bring a link back. A bare web address
(`https://...` or `www.`) or an email address is escaped too, so it stays
plain text. A checklist lists at most 500 numbered items. Further items are
counted in one error, and a screenshot name among them is still protected.
Each problem list keeps the first 200 entries and then says how many were
left out. Warnings count in that same top-level list. A screenshot that is
present is listed with the item and is not turned into a problem.

From code:

```js
import { checkRound } from '@open-convo/annotation-rounds';

const { report, markdown } = checkRound('OC-990101-sample-round.md');
```

## Output paths

`--json` and `--md` are refused, and nothing is written, when either path is
the round file, a `<session>-NN.png` file beside the round, or any screenshot
name the round mentions (a bad name, a subfolder, `..`, and an absolute path
included). A screenshot name still counts when it sits before the first
numbered item, and when the round has no numbered items at all. On a volume
that treats names differing only by case as one file, a missing screenshot is
reserved under that rule as well. Two paths are the same file when their fully
resolved paths match, or, when both exist, when they have the same device and
inode. An output that
already exists is also refused when it has another hard link, when it is
itself a symbolic link, when it is not a regular file (a device or a pipe),
or when a folder on the way is a symbolic link. Letter
case alone does not count as that kind of folder on a volume that ignores case.
`--json` and `--md` cannot name the same file.

## Library

`checkRound(roundPath)` returns `{ report, markdown }`. `reportJson(report)`
is the checklist JSON, including the trailing newline. `SCHEMA_VERSION` is
`1`. A round that cannot be opened, is not a file, or is over 1 MB throws
`RoundError` with a plain message.
