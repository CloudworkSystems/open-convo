# Notes checklist import

A checklist copied out of Notes goes in. A household list file comes out. The library reads no files, no clock, and no network. The command reads one note and, only with `--out`, writes one list.

Node 22 or later. No dependencies.

```sh
cd packages/notes-import
npm test
```

## Command

From the repo root:

```sh
node packages/notes-import/src/import.mjs --in packages/notes-import/samples/grocery.txt
node packages/notes-import/src/import.mjs --in <note.txt> [--title <name>] [--out <list.json>] [--force]
pbpaste | node packages/notes-import/src/import.mjs --in -
```

Without `--out` it only prints a preview. Nothing is written. `--in -` reads pasted text. `--out` writes the list. An existing file is left as it is unless you add `--force`. The new file is private to you (mode `0600`). A refusal prints one plain message and writes nothing. The exit code is 1 for a refusal and 0 for a preview or a saved list.

`parseChecklist(text, { title })` reads the note. It returns `{ list, items, sections, skipped, warnings }`. `list.title` is the list name. `list.titleFrom` is `note`, `option`, or `fallback`. `toListFile(parsed, { deviceId, now })` returns the JSON string the household lists engine would save. Both throw a plain error and return no list when the note is refused.

## Marks

A line that starts with one of these, after any leading spaces, is an item. The mark and the spaces after it are removed. The words stay as written.

Unchecked: `- [ ]`, `* [ ]`, `[ ]`, `☐`, `○`, `◦`, `•`, `-`, `*`, `–` (en dash), and a numbered line such as `1.` or `1)`.

Checked: `- [x]`, `- [X]`, `* [x]`, `* [X]`, `[x]`, `[X]`, `☑`, `☒`, `✓`, `✔`, `●`.

A later plain line is a section when the next line is an item. The first plain line is the list name, not a section. Anything left over is skipped with its line number.

## Copy a note on the Mac

1. Open the note in Notes.
2. Click in the note, choose Edit > Select All, then Edit > Copy.
3. Preview it without writing a file. In Terminal, from this repo:

```sh
pbpaste | node packages/notes-import/src/import.mjs --in -
```

4. Save it when the preview looks right:

```sh
pbpaste | node packages/notes-import/src/import.mjs --in - --out saturday.json
```

Put the list's name on the first line of the note. Later plain lines become sections. To use a different name, add `--title "Saturday market"`. Checked rows show as `[x]` in the preview. A second save to the same file needs `--force`.

`pbpaste` is already plain text. To save the paste as a file instead, open TextEdit, choose Format > Make Plain Text, paste, and save.

## Preview

```text
Title: Weekend groceries

Produce
[ ] apples
[ ] bananas
[x] lemons
[ ] limes

Dairy
[ ] whole milk
[x] yogurt
[ ] butter

Bakery
[ ] sourdough loaf
```

## What gets saved

The file is the household lists engine's own JSON. Sections are turned on only when the note had a heading. The command writes device id `notes-import` and time `0`, because this command does not read a clock. The engine's usual view sorts A to Z. The order from the note is kept as the order the rows were added.

Open the saved file with the household lists example in `packages/household-lists/README.md`. The same rows, checks, and sections are there.

`samples/large.txt` is an invented note of 2,000 rows, the most this import accepts. Saving it takes about two minutes, because each row is added through the household lists engine. The list is built in memory first. The file is written only at the end. Stop a `--force` save with Control-C before it says `Wrote`, and the previous file stays whole.

## When it goes wrong

An empty paste says: "This note has no checklist items. Copy the note in Notes, then paste it as plain text." Nothing is written. A line the importer cannot use is listed with its number. A control character, a note over 1,048,576 bytes, more than 2,000 items, or more than 100 sections refuses the whole note and writes nothing. The list is built in memory, then written as a temporary file in the same folder and renamed into place. Stopping before the command says `Wrote` leaves an existing list whole. A failed write deletes its temporary file.

## Edge cases

These are the choices the plan does not spell out.

1. A title you pass in replaces the list name. The first plain line of the note is still not a section and not an item.
2. A note that starts with an item is named `Checklist`.
3. A bare `-`, `*`, or en dash counts only when a space follows, so `-5` is not an item. `* [X]` is checked, the same as `- [X]`. The bracket marks are exact: `* [ X ]` is an unchecked row whose text starts with the brackets.
4. An em dash, a plus, and `(1)` are not marks. `1.2 liters` is not a numbered row. A numbered mark is 1 to 6 digits, then `.` or `)`, then a space.
5. Indentation does not nest. The row stays in the current section. A blank line does not end a section.
6. The 500-character limit counts Unicode code points, on the words after a mark, or on the whole plain line when there is no mark. A longer line is left out. A heading that long is left out and does not change the section. A mark with no words is left out. A plain line still becomes a section when the next line is an item, even if that item is later left out.
7. A repeated row is the same text after trimming the ends, in any section. Every copy is kept. Later copies are listed under warnings. `Milk` and `milk` are different.
8. The same section name can appear twice. Each row records the heading above it.
9. A leading byte-order mark is ignored. The whole note is measured in UTF-8 bytes, and that mark counts.
10. Tabs are kept inside a row. A tab at either end is trimmed. Any other control character, including Unicode line separators, refuses the note. Line breaks are `\n`, `\r\n`, and `\r` only.
11. Exactly 2,000 items, 100 sections, 500 characters, and 1,048,576 bytes are accepted. One more item, section, or byte refuses the note. One more character on a single line leaves that line out and keeps the rest.
12. The output folder is not created for you. `--in` and `--out` cannot be the same path. `--in -` means pasted text, not a file named `-`.
13. A failed save deletes its temporary file and leaves an existing list whole.
