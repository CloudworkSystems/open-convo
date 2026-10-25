# Tasks and reminders engine

Standalone in-memory Node library. No dependencies, app code, disk I/O, network, accounts, AI, or real personal data. Node 22 or later.

Run every test:

```sh
cd packages/tasks
npm test
```

## Try it with invented data

From this folder:

```sh
node --input-type=module <<'JS'
import { Tasks } from './src/index.mjs';

const phone = new Tasks({
  deviceId: 'example-phone',
  id: 'example-person',
  timeZone: 'America/New_York',
  now: () => Date.parse('2026-11-02T14:00:00.000Z'),
});
const renew = phone.addTask({
  title: 'Renew the registration',
  due: '2026-11-30',
  list: 'Errands',
  priority: 'high',
}, { taskId: 'renew' });
console.log(phone.today(Date.parse('2026-11-30T15:00:00.000Z'), 'America/New_York'));
phone.complete(renew, Date.parse('2026-11-30T15:00:00.000Z'));
phone.undo();
phone.addTask({
  title: 'Water the plants',
  due: { dateTime: '2026-11-02T09:00', timeZone: 'America/New_York' },
  repeat: { kind: 'days', every: 3, mode: 'afterDone' },
  reminders: [{ days: 0 }],
}, { taskId: 'water' });
console.log(phone.upcoming(Date.parse('2026-11-02T14:00:00.000Z'), 7, 'America/New_York'));
console.log(phone.save());
JS
```

The caller owns the file. `save()` returns a string and `load(json)` reads one. Pass every instant in. The engine does not read the clock or the machine's time zone.

## API

Import `Tasks`, `mergePeople`, `serializePerson`, `deserializePerson`, `compareStamps`, `occurrenceDates`, `wallToInstant`, `civilDate`, `wallClock`, and `SCHEMA_VERSION` from `src/index.mjs`.

`new Tasks({ deviceId, id, timeZone, dayStart = '09:00', now = Date.now, undoLimit = 20 })` holds one person. Give each writer a unique device id. `now` returns integer milliseconds and is used only for version stamps. `dayStart` is the clock time a date-only offset reminder counts from (default `09:00`).

- `addTask(fields, { taskId }?)` returns a permanent id. `title` is 1 to 500 characters. Optional `note` (up to 5,000), `list` (up to 200), `priority` (`high` or none), `due`, `repeat`, and up to five `reminders`.
- `editTask(id, fields)` changes only the supplied fields. Editing a trashed task restores it. A repeat on a task with no due date is refused. A patterned repeat whose start is not one of its dates is refused. `afterDone` is refused for `weekdays`, `monthDay`, and `monthWeekday`.
- `complete(id, now, { recordId }?)` finishes a one-off task, or records a repeating occurrence and moves to the next one.
- `skip(id, now, { recordId }?)` moves a repeating occurrence on without a completion.
- `reopen(id, { occurrence, now, recordId }?)` opens a one-off task again, or reopens one repeating occurrence.
- `drop(id, now?, { recordId }?)` keeps the task in history as dropped. `deleteTask` / `restoreTask` / `emptyTrash` use Trash. Emptying Trash clears that person's undo history.
- `snooze(id, request, now, { recordId }?)` moves the next reminder. `request` is `{ preset }` or `{ at: { dateTime, timeZone } }`, with optional `moveDue: true`. Presets are `laterToday` (+3 hours), `tomorrow` (tomorrow at the reminder's clock time), and `nextMonday`.
- `today(now, timeZone)`, `upcoming(now, days, timeZone)`, `overdue(now, timeZone)`, `remindersDue(from, to, timeZone)`, `history(id)`, and `task(id)` return plain copies.
- `getPerson()`, `save()`, `load(json)`, `importPerson(snapshot)`, and `mergePeople(a, b)` are the sync surface. `mergePeople` does not change its inputs. `undo()` restores the previous visible task state and returns false when the history is empty.

A due value is `'YYYY-MM-DD'`, `{ date }`, or `{ dateTime, timeZone }`. A repeat is `{ kind, every, mode, weekdays?, monthDay?, weekday?, which?, endAfter?, endOn? }`. Kinds are `days`, `weeks`, `weekdays`, `months`, `monthDay`, `monthWeekday`, and `years`. `every` is 1 to 365 for days and 1 to 99 otherwise. `mode` is `onSchedule` or `afterDone`. `which` is 1 to 5 or `'last'`. An offset reminder is `{ days, hours, minutes }`. A fixed reminder is `{ dateTime, timeZone, occurrence? }`.

`upcoming` covers today and the following `days - 1` dates (`days` is 1 to 60). An on-schedule task is listed once per occurrence still inside its `endAfter` / `endOn` limits. An after-done task is listed only on its current date, with `repeatsAfterDone: true`. `remindersDue` uses the half-open range `[from, to)` and refuses a range longer than 31 times 24 hours.

## JSON schema version 1

One JSON document per person. Strings are plain text. Applications must render them as text.

```json
{
  "schemaVersion": 1,
  "id": "example-person",
  "fields": {
    "timeZone": { "value": "America/New_York", "stamp": { "counter": 1, "time": 1793628000000, "device": "example-phone" } },
    "dayStart": { "value": "09:00", "stamp": { "counter": 1, "time": 1793628000000, "device": "example-phone" } }
  },
  "tasks": []
}
```

A **stamp** is `{ counter, time, device }`: a positive safe-integer counter, safe-integer milliseconds, and a nonempty device id. Compare counter, then time, then device id. The same stamp with two different values is refused.

Each task is `{ id, life, purge, fields, records }` plus an optional `pendingLife` after a purge. `life` is a boolean register. `purge` is null or a stamp. Fields are `title`, `note`, `list`, `priority`, `state` (`open`, `done`, or `dropped`), `due`, `repeat`, and `reminders`, each a `{ value, stamp }` register. Array order in the file is id order. Views compute presentation order and never write it back.

A **repeat** value keeps this shape: `kind`, `every`, `mode`, `start`, `weekdays`, `monthDay`, `weekday`, `which`, `endAfter`, `endOn`. Unused pattern fields are null. `which` is stored as `-1` for the last weekday. Weekday names are stored in Sunday-to-Saturday order. The next due date is not stored. It is computed from the winning repeat and the completion and skip records that still count.

**Records** are completions, skips, snoozes, reopens, and drops. Each is `{ id, type, occurrence, instant, actionDate, actionZone, stamp, fields }`. Record fields are `withdrawn`, `seen`, `reminderAt`, and `due`. Records are not deleted. Undo sets `withdrawn` to true. A withdrawn record stays in the file and shows in history as undone. A reopen lists the completion and skip ids it saw (`seen`). Those records are set aside and show in history as undone while that reopen is active. A record it did not list still counts, including one that arrives later with a lower stamp. Undoing the reopen withdraws it, so the records it listed count again.

An **occurrence name** is the scheduled due date (`2026-11-30`) or the scheduled wall time and zone (`2026-11-02T09:00[America/New_York]`). A snooze that moves the due date does not rename the occurrence. Names compare by date, then time, then zone.

Deleting a task sets `life` false and keeps the contents in Trash. Emptying Trash stores a cutoff and drops older fields and records:

```json
{
  "id": "example-task",
  "life": { "value": false, "stamp": { "counter": 8, "time": 200, "device": "example-phone" } },
  "purge": { "counter": 8, "time": 200, "device": "example-phone" },
  "fields": {},
  "records": []
}
```

An older copy cannot bring that content back. A later `addTask` may reuse the id. Registers newer than the cutoff, including a `pendingLife` event that arrived without a new title, are kept so three copies still merge in any order. Unknown `schemaVersion`, unknown fields, and unknown time zones are refused. There is no silent migration.

Undo keeps up to 20 before/after snapshots in memory, not in the file. It writes a new stamp on each value that the undone change wrote, so a merged copy keeps the undo. Adding a task and undoing it leaves a purge marker. Importing clears undo history. Emptying Trash does too.

`mergePeople` is commutative, associative, and idempotent. The logical counter moves past every stamp in an imported file.

## Edge cases

- Weekday intervals use Monday as the week start, RFC 5545's default (`WKST=MO`). "Every 2 weeks on Monday and Thursday" repeats inside that Monday-based week, then skips the next week.
- A numbered weekday a month does not have, such as the fifth Monday, is skipped. The following matching month is used.
- `endAfter` and `endOn` may both be set. The series stops at the first limit reached. `endOn` is inclusive. `endAfter` counts distinct closed occurrence names, so two records for one occurrence count once and a skip counts.
- `upcoming` projects only the occurrences still left. Dates before the window use up what remains of `endAfter`. Nothing is shown after `endOn`. An untouched daily task with `endAfter: 2` shows two dates in a 30-day window that contains its start.
- A wall time that does not exist on a spring-forward morning moves forward by the gap (`02:30` becomes `03:30` when the clock jumps an hour). A wall time that happens twice on a fall-back morning uses the earlier instant. The typed wall time is what the file stores. Views add `instant` and `resolved`.
- A date-only task is overdue from the start of the next day in the zone passed to the view. A timed task is overdue when `now` is at or after its instant. Overdue tasks are listed once, on the current occurrence, not once per missed date.
- `today` lists open tasks due that calendar day, overdue tasks, and tasks with a reminder whose instant is on that day and at or before `now`. A reminder later today does not pull the task in before it fires. Overdue rows come first, oldest first. Then by due date, timed before date-only, then high priority, then title, then id. Comparison uses JavaScript UTF-16 order.
- A date-only offset reminder counts from `dayStart` on the due date in the zone passed to `remindersDue`. Day offsets are calendar days. Hours and minutes are then subtracted as a duration, so a daylight-saving change is not a 24-hour step.
- A fixed reminder stores the occurrence it was set for, on a one-off task as well as a repeating one. `remindersDue` returns it only while that occurrence is still the open one. Completing, skipping, or rescheduling the due date makes a named reminder lapse. It follows the new occurrence only when an edit sets the new occurrence name. A fixed reminder with no occurrence name stays while the task is open. Offset reminders are recalculated for the current open occurrence.
- `laterToday` adds three hours to the instant and can fall on the next calendar day. `nextMonday` on a Monday is seven days later, never today.
- A snooze replaces the earliest reminder of its occurrence. The snooze with the highest stamp wins. A snooze for any other occurrence changes nothing, and a snooze never moves an on-schedule or after-done series on.
- On-schedule months and years keep the start date's day and clamp a short month to its last day, then return to the original day. After-done months and years count from the completion or skip's action date, so they do not drift back to the original day. February 29 in a yearly rule falls on February 28 in other years.
- The next due date is never before the winning rule's `start`. Editing a rule sets `start` to the new rule's first date on or after the current due date, in the same stamped change. If an after-done result lands on an occurrence that is already closed, whole intervals are added until the date is open.
- Reminder text, titles, and errors do not grade the person. There are no scores or streaks.
- One-off reopen is a stamped change of `state`. Repeating reopen is a record. Skip is only for a repeating task.

## Out of scope

Screens, notifications, voice, AI, network, iCloud, storage, encryption, calendars, shared tasks, attachments, and subtasks. The merge is ready for a later sync adapter. This package does not register one.
