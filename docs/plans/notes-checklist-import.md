# Notes Checklist Import (PRD)

Status: Draft (Nov 3): waiting on the owner's yes in the Claude thread "Draft next plans for outside builders".

Written November 3, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261103-notes-import`. Umbrella: Family (with Home). This serves item 1 of
the owner's day-one list in [PLAN.md](../../PLAN.md) ("Checklists
(groceries and others, as kept in Apple Notes today, but better)"): the
household lists engine (`packages/household-lists/`) is built, but the
owner's real lists still live in Apple Notes. This slice turns a checklist
copied out of Notes into a household list file, so moving over is one
paste, not retyping. **Builder:** GrokBot team A, under AGENTS.md "Outside
Builders", through Cursor and signed in as `cloudwork-bot`. **Reviewers:**
Codex reviews every push; the coordinator checks the result against this
plan. **Finish line:** the package merges with `tests` passing, the command
turns the invented sample notes in the package into list files that the
household lists engine loads and shows correctly, and the owner trial below
passes.

## Why

Nobody switches list apps if it means retyping every list. Apple Notes has
no export for checklists, but copying a note and pasting it as plain text
works on the Mac and the iPhone, and gives a predictable shape: one line per
item, with a checkbox mark or a bullet, and headings as plain lines. Reading
that text is rules, not judgement, so it belongs in a small tested library.

## What It Does

`packages/notes-import/`, plain JavaScript, no dependencies.
`parseChecklist(text, { title })` returns `{ list, items, sections,
skipped, warnings }`. It reads no clock, no files and no network.

### Reading The Text

- Lines are split on `\n`, `\r\n` or `\r`. Blank lines are ignored.
- **Items.** A line that starts (after spaces) with one of these marks is an
  item, with the mark and the spaces after it removed:
  - unchecked: `- [ ]`, `* [ ]`, `[ ]`, `☐`, `○`, `◦`, `•`, `-`, `*`, `–`
  - checked: `- [x]`, `- [X]`, `* [x]`, `[x]`, `[X]`, `☑`, `☒`, `✓`, `✔`,
    `●`
  - a numbered line (`1.` or `1)`) is an unchecked item.
- **Headings.** A line with no mark is a heading if the next non-blank line
  is an item. It becomes the section for the items under it, until the next
  heading. The first line of the text, if it has no mark, is the title
  suggestion and not a section.
- **Anything else** (a line with no mark that isn't followed by an item) is
  kept in `skipped` with its 1-based line number, never guessed into an
  item.
- **Text is kept as written.** No quantity guessing, no spelling changes,
  no merging of repeated items (a repeated item is kept and listed in
  `warnings`). Spaces at the ends are trimmed; inner spaces are kept.
- **Limits.** At most 1,048,576 bytes of text, 2,000 items and 100
  sections. Item text 1 to 500 characters (longer lines are skipped with a
  reason). Control characters other than tab are refused with the line
  number.

### Making The List

`toListFile(parsed, { deviceId, now })` builds the list with the household
lists engine's **public API only** (`HouseholdLists`, `createList`,
`setSectionsEnabled`, `addItem`, `setChecked`, `save`), so the file is
exactly what the engine itself writes. Sections are switched on only when
the text had headings. `deviceId` and `now` are passed in; nothing reads
the clock. It returns the saved JSON string.

### The Command

`node packages/notes-import/src/import.mjs --in <note.txt> [--title
<name>] [--out <list.json>] [--force]`

- Without `--out` it is a dry run: it prints the title, each section with
  its items (checked ones marked), the skipped lines with their numbers,
  and the warnings. Nothing is written.
- With `--out` it writes the list file. It refuses to overwrite without
  `--force`, writes a temporary file and renames it, and creates a new
  file with mode `0600`.
- `--in -` reads standard input, so `pbpaste | node ... --in -` works.

## When It Goes Wrong

The command's output is a screen the owner sees, so it answers the five
questions in [when-it-goes-wrong.md](when-it-goes-wrong.md):

1. **No connection.** Doesn't apply: one local file in, one out.
2. **Interrupted.** The temporary file plus rename means an interrupted
   run leaves no half-written list and an existing file whole.
3. **Empty or first run.** An empty note says "This note has no checklist
   items. Copy the note in Notes, then paste it as plain text." and writes
   nothing. The README's first step uses the sample note.
4. **Denied or stuck.** Doesn't apply: no prompt, permission or network.
5. **The error message.** Each refusal says what and where in plain words,
   for example "Line 14 has a control character, so nothing was written.
   Remove it and run again." Skipped lines are listed so nothing vanishes
   silently.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/notes-import/` (Node's built-in runner, invented
notes only):

1. The sample grocery note (headings, checked and unchecked items, a
   numbered list) gives the expected items, sections and title.
2. Every mark in the list above is read, checked or unchecked as stated.
3. Text is kept exactly: quantities, emoji, accents, inner spaces and a
   repeated item (with its warning).
4. A loose paragraph line goes to `skipped` with its line number; a line
   over 500 characters is skipped with a reason.
5. Each limit and the control-character refusal give their message and no
   list.
6. `toListFile` output loads in `HouseholdLists` (`load`) and its `view`
   shows the same items, checked states and sections; sections stay off
   for a note with no headings.
7. `\r\n` and `\r` line endings give the same result as `\n`.
8. The library never imports `fs`, `child_process` or a network module and
   never reads the clock, and it imports `packages/household-lists/` only
   through its public export (a test checks the source).
9. The command's dry run writes nothing; `--out` refuses to overwrite
   without `--force`; a write is a temporary file plus rename.

**Owner trial checks** (the owner, or an agent on his Mac for him, with one
of his real Notes checklists copied as plain text, kept on his Mac and never
committed): the dry run shows his items, headings as sections and checked
items marked; a note with a stray paragraph lists it as skipped with its
line number; an empty paste gives the "no checklist items" message; a
second run to the same `--out` without `--force` refuses and leaves the
first file; the written list opens in the household lists engine's example
(README) with the same items. He confirms each message says what to do
next.

## Out Of Scope For This Slice

Reading the Notes database or iCloud directly, Notes' rich text or
attachments, syncing back to Notes, wiring into the app, merging into an
existing list, quantity or section guessing, and any AI.

## Rules For The Builder (GrokBot Team A)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, through Cursor, on the branch
  `OC-261103-notes-import`, signed in as `cloudwork-bot`. Open a pull
  request into `main` with auto-merge off and the label `agent: grokbot`.
  Never push to `main` directly, and never switch on auto-merge.
- Mark the work as AGENTS.md "Accounts And Provenance" says: `Cursor Agent`
  as commit author, and `— GrokBot team A, OC-261103-notes-import` as the
  last line of the pull request description and every comment.
- Run **no commands on the owner's Mac** for this job.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented notes only, with no real names or real lists.
- Change files only under `packages/notes-import/`. Import
  `packages/household-lists/` by relative path through its public export
  only; if it lacks something, stop and report instead of changing it.
  Nothing else, not even `STATUS.md` (the coordinator updates it).
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network calls, no AI, no paid services, no `child_process`, no clock,
  in the code or the tests. No `fs` in the library; the command may read
  its one input and write its one output.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the library, the command, the tests, a sample note
  and a short README (marks read, the command, and the owner's steps for
  copying a note as plain text on the Mac). Finishable in one to two days.
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
