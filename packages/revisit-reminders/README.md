# Revisit reminders

A reminder list and a date in, what's due and what's next out. Adding, editing, snoozing, finishing or removing a reminder returns a new list. This package does not store the list, open a Desk view, send a notification, look up the item, or use the network, AI, or the clock. The caller passes `today` as a `YYYY-MM-DD` date. Reminders are by day. Node 22 or later.

```sh
cd packages/revisit-reminders
npm test
```

The command, from the repo root:

```sh
node packages/revisit-reminders/src/revisit.mjs --file <reminders.json> --today YYYY-MM-DD [--days N] [--json]
```

`--today` is required. `--days` is the coming-up window (default 14). `--json` prints the list view. Without it, the command prints five sections: Overdue, Due today, Coming up, Missing item, and Done. A refusal prints one message on standard error and no view. The command reads one file and writes nothing.

`tests/fixtures/sample.json` is an invented list. On `--today 2026-11-02` it prints `tests/expected/sample.txt` (and `tests/expected/sample.json` with `--json`). The garden plan is 13 days overdue. The fence note was due in October and is due today because its snooze is later. The seed note is due today because 14 days from 19 October is 2 November. The path link is the last day of the 14-day window. The shed list is later than that window, so the command does not print it. The porch note is done.

## A reminder

```json
{
  "id": "garden-plan",
  "itemId": "session-garden",
  "itemKind": "session",
  "title": "Come back to the garden plan session",
  "when": { "on": "2026-10-20" },
  "note": "Check the bean rows.",
  "createdOn": "2026-10-01"
}
```

`when` is either `{ "on": "YYYY-MM-DD" }` or `{ "afterDays": 14, "from": "YYYY-MM-DD" }`. `itemKind` is `session`, `note`, `link` or `other`. `note`, `snoozedUntil` and `doneOn` are omitted when absent. The engine never looks the item up.

## Rules

`dueOn` is `when.on`, or `from` plus `afterDays`, counted on the calendar. If `snoozedUntil` is strictly later, it wins. An equal or earlier snooze date is kept and does not pull the due date forward.

An open reminder with `dueOn` before `today` is overdue, and the view includes `daysOverdue`. `dueOn` of `today` is due today. `dueOn` after `today` and on or before `today` plus `days` is coming up. A later open reminder is in none of those lists. A reminder with `doneOn` is done and is never due again. Each of those lists is sorted by due date, then title, then id.

`listView(reminders, { today, days, knownItems })` returns `{ overdue, dueToday, comingUp, missingItem, done, counts }`. `counts` holds the length of each list. `knownItems` is an optional list of `{ itemKind, itemId }` pairs the caller knows still exist. An open reminder whose pair is missing is also listed under `missingItem`. It is not removed from its due list, and it is not deleted. Omit `knownItems` and nothing is listed as missing. Pass `[]` and every open reminder is missing. A done reminder is never missing. A known note does not cover a session with the same `itemId`. The command does not take known items, so its missing section is empty.

`addReminder`, `editReminder`, `snoozeReminder`, `markDone` and `removeReminder` return `{ reminders, warnings }` or throw `RevisitError`. They do not change the list passed in. `addReminder(reminders, reminder)` refuses a duplicate `id`. It warns, and still adds, when another open reminder has the same `itemKind`, `itemId` and effective due date. A done reminder does not warn. A different kind does not warn. A different due date does not warn. One warning is returned per matching reminder: `{ field: "itemId", id, existingId, message }`. The message names `itemId`.

`editReminder(reminders, id, patch)` replaces `title`, `note` or `when` and checks the reminder again. `note: ""` or `note: null` clears the note. `snoozedUntil`, `doneOn`, the item and `createdOn` stay. Edit does not warn. `snoozeReminder(reminders, id, change, today)` takes `{ until }` or `{ days }`. The resulting date must be after `today`. A done reminder cannot be snoozed. `markDone(reminders, id, today)` sets `doneOn` to `today` and refuses a reminder that is already done. `removeReminder(reminders, id)` takes it out. An unknown id is refused. Add, edit, snooze, done and remove keep the existing order. A new reminder is appended.

`dueOn(reminder)` is the due date of a reminder the engine has already checked.

## Saved form

`formatSaved(reminders)` writes JSON. `parseSaved(text)` reads it. The document is `{ "version": 1, "reminders": [] }`. `version` is the number 1. One bad field refuses the whole text. The error names the reminder and the field (`reminder "garden-plan", field when.on: ...`). When the id is not usable, the place is 1-based (`reminder 2, field id: ...`). A file-level problem names the field and no reminder (`field version: version must be 1`).

`formatSaved` sorts by id and uses one key order, with a two-space indent and one trailing newline. The same reminders in any order give the same text. `parseSaved` returns that same order. `parseSaved(formatSaved(x))` gives back `x` sorted by id, and `formatSaved(parseSaved(text))` gives back `text` for any text `formatSaved` wrote.

## Refusals

A refusal throws `RevisitError`. `field` is the field name, and the message contains `field <name>`. Nothing is returned, and the caller's list is unchanged.

The engine refuses a missing required field, a value of the wrong type, a date that is not a real `YYYY-MM-DD` day (including `2026-02-30`), `afterDays` outside 1 to 3,650, a text field that is too long or holds a control character, an `itemKind` outside its list, or a repeated id. A tab or a newline inside `note` is allowed. A tab or a newline inside `title` is not.

## Edge cases

These are the choices the plan does not spell out. Each one has a test.

- Due buckets do not overlap. `missingItem` is an extra list, so one open reminder can appear there and in overdue, due today, or coming up. A reminder after the window appears only in `missingItem`, and only when `knownItems` was passed and does not include it.
- `days` defaults to 14. The last included day is `today` plus `days`. `days` is a whole number from 0 to 3,650. 0 makes coming up empty. `-0` is refused.
- `snoozedUntil` wins only when it is strictly later than the date from `when`. Snooze still stores a date that is after `today` but not later than `when`.
- Snooze `days` is a whole number from 1 to 3,650, added to `today` on the calendar. Set `until` or `days`, not both. A date on or before `today` is refused with field `snoozedUntil`. A done reminder is refused with field `doneOn` before the snooze date is checked.
- `markDone` on a reminder that already has `doneOn` is refused, so the original day stays. A stored `doneOn` may be any real date, including one before `createdOn` or after `today`. The reminder is done either way.
- An empty edit, or a patch that is not an object, is refused with field `title`. Any other patch field is refused under its own name. Edit of a done reminder is allowed, and it stays done.
- Lengths are JavaScript characters (UTF-16 code units). An emoji counts as two. `title` and `itemId` are 1 to 200 characters and one line. A stored `note` is 1 to 2,000 characters, or the key is omitted. Spaces are kept. `id` is 1 to 64 ASCII letters, digits, `-` or `_`, and it is case-sensitive.
- Control characters are Unicode Cc, plus the line and paragraph separators U+2028 and U+2029. `note` may contain tab (U+0009) and line feed (U+000A). A carriage return is refused. `title` and `itemId` refuse every control and both separators.
- Dates run from `0001-01-01` through `9999-12-31`, zero-padded. Adding days walks the calendar. A year has a February 29 when it divides by 4, except a century year that does not divide by 400. Year 1900 does not. Year 2000 does. `afterDays` of 1 from `9999-12-31`, or a window that would pass `9999-12-31`, is refused.
- Unknown fields are refused. `null` is the wrong type, except `note: null` on an edit, which clears the note. A missing optional key means absent. Duplicate keys in one JSON object follow `JSON.parse`: the last one wins. A leading BOM is not JSON.
- Returned lists from add, edit, snooze, done and remove keep input order. View lists and the saved list sort by UTF-16 code unit order, so `Z` sorts before `a`. Done rows sort by the effective due date, not by `doneOn`. A snooze that is later still sets that due date.
- A view row is a copy of the reminder plus `dueOn`. `daysOverdue` is the number of calendar days before `today`, and only on an open row that is overdue, including the copy under `missingItem`. Done rows have no `daysOverdue`. `counts` has `overdue`, `dueToday`, `comingUp`, `missingItem` and `done`.
- The command accepts `--file`, `--today`, `--days` and `--json` as separate arguments, in any order. `--today=2026-11-02` is refused. `--days` must be `0` or digits without a leading zero. The file must be UTF-8, a regular file, and at most 1,048,576 bytes. A file of exactly that size is read. A larger file is refused before parsing. A path that is not a regular file is refused and not read. The command does not read the clock and does not write a file.
- `parseSaved` and `formatSaved` agree byte for byte on text this package wrote, using `\n` only. A file with `\r\n` still parses. The same reminders come back, and writing them again uses `\n`.
