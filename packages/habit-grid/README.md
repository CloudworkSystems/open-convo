# Habit grid engine

Standalone, in-memory Node ESM library. No dependencies, app integration, disk
I/O, network, accounts, AI, encryption, or real personal data. Node 22 or later.

Run every test:

```sh
cd packages/habit-grid
npm test
```

## Try it with invented data

From this folder:

```sh
node --input-type=module <<'JS'
import { HabitGrid } from './src/index.mjs';
const phone = new HabitGrid({ deviceId: 'example-phone', now: () => Date.UTC(2026, 2, 18) });
const river = phone.createPerson('River');
const water = phone.addTracker(river, { name: 'Water', kind: 'count', target: 8, unit: 'glasses', color: 'coral' });
phone.logCheckIn(river, water, { date: '2026-03-16', value: 3 });
phone.logCheckIn(river, water, { date: '2026-03-17', value: 8 });
console.log(phone.grid(river, water, { start: '2026-03-15', end: '2026-03-18' }).squares);
console.log(phone.svg(river, water, { start: '2026-03-15', end: '2026-03-18' }));
JS
```

## API

Import `HabitGrid`, `mergePeople`, `viewPerson`, `buildGrid`, `buildStackGrid`,
`renderSvg`, `serializePerson`, `deserializePerson`, `compareStamps`,
`contrastRatio`, `addDays`, `weekdayName`, `SCHEMA_VERSION`, `KINDS`,
`WEEKDAYS`, `WEEK_STARTS`, `SOURCES`, `SURFACES`, `DAY_STATES`, `WEEK_STATUSES`,
`RANGE_DAYS`, and `EMBER` from `src/index.mjs`.

`new HabitGrid({ deviceId, now = Date.now })` creates an in-memory collection.
Give each independent writer a unique, stable device ID. Never run two
independent writers with the same ID and clock history. `now` returns integer
milliseconds. The logical counter is instance-wide, increases for each change,
and advances past every stamp in an imported file, including tombstones.
Reload saved files before editing after restart. A future sync adapter must
persist every person file, including deleted ones; dropping tombstones would
break the offline-deletion guarantee.

Civil dates are `YYYY-MM-DD`. The constructor takes `timeZone`, an IANA name.
When it is omitted, `today` is the civil date of `now` in the runtime's time
zone, so an evening check-in stays on that local day. Pass `timeZone: 'UTC'`
for the UTC date. Callers can still pass `today` or `date`. Calendar
arithmetic uses the UTC calendar and never adds 24 hours, so a
daylight-saving change cannot skip or repeat a day.

- `createPerson(name, { id, weekStartsOn = 'sunday' }?)` returns a permanent ID.
- `personIds({ trash = false }?)` lists active or recoverable deleted people.
- `renamePerson(id, name)` and `setWeekStartsOn(id, 'sunday' | 'monday')` change
  person fields. Either one can bring back a person whose Trash was emptied,
  because it writes a person field newer than the cutoff. Erased fields stay
  erased. `addTracker`, `addStack`, and `markRest` do not write a person field;
  on an emptied person they are refused and the stored file stays as it was.
  `restorePerson` refuses an emptied person.
- `addTracker(personId, fields, { trackerId }?)` returns a permanent tracker ID.
  `name` and `kind` (`done`, `count`, or `amount`) are required. `color` is
  `coral`, `magenta`, `amber`, or `#rrggbb` (default `coral`). `schedule`
  defaults to `{ type: 'daily' }`. Also `{ type: 'timesPerWeek', times }` with
  `times` from 1 to 7, or `{ type: 'days', days }` with weekday names.
  `startedOn` defaults to today. `usualAmount` defaults to null. A count
  `target` is null or a number above zero. An amount tracker needs a target
  above zero and a unit. A done tracker stores no target.
- `editTracker`, `deleteTracker`, `restoreTracker` change one tracker.
  Editing or restoring a recoverable deleted tracker brings it back.
  A key outside `name`, `color`, `kind`, `target`, `unit`, `usualAmount`,
  `schedule`, and `startedOn` is refused and the file stays unchanged.
- `addStack(personId, { name, members = [] }, { stackId }?)`, `renameStack`,
  `setStackMember(personId, stackId, trackerId, included)`, `deleteStack`,
  `restoreStack`. Membership is its own stamped boolean per tracker, so two
  devices can add different members and both survive.
- `logCheckIn(personId, trackerId, { date, value, source, checkInId }?)`
  returns a permanent check-in ID. This version writes `source: 'manual'` only.
  `voice` and `automatic` are accepted in saved files so a later logger can
  use them; this slice does not record voice or automatic data. A done
  check-in defaults to 1. Count and amount check-ins require a value. The
  engine does not invent one.
- `editCheckIn(personId, checkInId, fields)` updates only the supplied fields.
  `deleteCheckIn` moves it to Trash. `restoreCheckIn` brings it back.
  Editing a recoverable deleted check-in with a supplied field also restores it.
  An empty edit is refused and the file stays unchanged.
  A key outside `trackerId`, `date`, `value`, and `source` is refused and the
  file stays unchanged.
- `markRest(personId, date, { trackerId = '', restId }?)` marks one date.
  An empty `trackerId` applies to every tracker. The same date and tracker
  mark returns the existing record. `deleteRest` and `restoreRest` use Trash.
- `checkStack(personId, stackId, { date }?)` returns
  `{ date, written, needsValue, alreadyLogged }`. Done members are written as
  1. Count and amount members are written only when `usualAmount` is a number
  above zero. Other count and amount members are listed in `needsValue` and
  nothing is written for them. A member that already has a check-in on that
  date is listed in `alreadyLogged` and is not written again. Members can
  still be logged alone with `logCheckIn`.
- `grid(personId, trackerId, options)` and `stackGrid(personId, stackId, options)`
  return plain grid data. `svg` and `stackSvg` render that grid.
  Options are `start`, `end`, `surface` (`mac`, `wall`, or `phone`), and
  `today`. Pass both dates or neither. The default span is 183 days for `mac`
  and `wall` (about six months) and 92 days for `phone` (about three months),
  ending today.
- `view(id, { trash = false }?)` returns plain person data.
  `getPerson(id)` returns a JSON-compatible snapshot with sync metadata.
  Returned objects are copies; mutating them never changes engine state.
- `save(id)` / `load(json)` serialize and import JSON strings. The caller owns
  file I/O. `load` merges with an existing person of the same ID.
  `importPerson(snapshot)` imports or merges a snapshot directly.
- `mergePeople(a, b)` returns a new merged snapshot of the same person ID.
  Neither input changes. Different person IDs and malformed files are refused.
- `emptyTrash(id)` permanently removes recoverable deleted records. If the
  person is deleted, it removes the person's content instead. Emptying a
  deleted tracker also purges that tracker's check-ins and tracker-specific
  rest days, and drops the tracker from stack membership. A rest day with an
  empty tracker ID stays. An older check-in for that tracker, merged from
  another device, stays purged. A tracker cutoff drops only the check-in or
  rest fields stamped at or before it. A newer partial check-in stays in the
  file and stays hidden until another replica fills the missing fields, and
  every merge order keeps that completed check-in. Restore refuses a hidden
  fragment and leaves the file unchanged. Moving a check-in keeps
  every tracker it left, including one it only visited in the middle of a
  longer move. Merge applies each of those cutoffs before it keeps the new
  tracker id, in either merge order, so fields that were not written again
  do not show up on the new tracker. A cutoff is applied to a replica only
  from the trackers that replica used. A newer deletion made on a replica
  that never used the purged tracker stays deleted in every merge order.
  Emptying Trash on the device that moved
  the check-in applies those same cutoffs, so the purge succeeds and the
  older fields do not stay on the tracker it moved to. A later call leaves
  an already emptied tracker's cutoff unchanged, so a check-in that moved
  off it afterward, with every field newer than that cutoff, stays.
  A later call also leaves an already emptied person's cutoff unchanged, so
  a name written on another device after that first empty still revives the
  person. Reusing the tracker ID
  starts from an empty grid when nothing newer than the cutoff remains.

Comparisons use JavaScript UTF-16 code unit order, so devices agree.

## Shades, weeks, and streaks

A day's value is the sum of that day's live check-in records. It is not stored.

Each square is `{ date, weekday, state, shade, value, due, inRange }`.
`state` is `empty`, `partial`, `full`, `rest`, `open`, or `done`. `shade` is
0 through 4. `due` is true only on a daily or chosen day that counts toward a
streak. `inRange` is false for days added to complete a week outside the
requested span.

- Done, count with a target, and amount: 0 is empty (shade 0). Below the
  target, shade steps at one quarter, one half, and above one half (shades
  1, 2, and 3) and the state is `partial`. Reaching the target is `full`,
  shade 4. A done tracker's target is 1, so a normal check-in is full and a
  value between 0 and 1 is partial.
- Count without a target: any value above zero is `done`. Shade is the
  quarter of that day's value against the highest shown amount in the
  requested span (shade 4 is the top quarter). There is no `full` state.
  `fullLevel` on the grid is false.
- Chosen weekdays that are not selected are `rest`, including when a check-in
  exists. The value remains on the square. They are not due.
- Days before `startedOn` are `open`.
- A due day after today, and today before it is met, are `open`. A check-in
  stored on a future due day stays on the square and does not change that
  `open` state. A past due day with no value is `empty`.
- Owner rest is `rest` for that tracker, or for every tracker when the mark
  has an empty tracker ID. Rest is never an empty due day.
- Times per week: no day is due. A day with a value above zero is `done`
  (shade still follows the rules above). Other days are `open`. A week is met
  when the number of those done days reaches `times`. The current week stays
  `inProgress` until its last day has passed, even when the total is already
  met. A finished week is `met`, `unmet`, or `rest`. A week whose days on or
  after the start date are all rest is `rest`, and that week does not change
  the streak. `unmet` is a plain fact about the total. The grid does not add
  praise, blame, or badges.

Streaks are `{ current, longest, unit }`. Daily and chosen-day streaks count
due days whose state is `full` or `done`. Rest, off-days, and days before the
tracker started do not change the streak. Today does not end it before it is
met. A past due day that is `empty` or `partial` ends it. Times-per-week
streaks count weeks. A met week counts, including the current week once its
total is met. A finished week that is entirely rest is skipped. The current
week does not end the streak while it is still in progress. Streaks use the
whole history from `startedOn` through today, not
only the requested span.

A stack square ignores members in `rest` or `open`. It is `full` when every
remaining member is `full` or `done`, `partial` when some progress is in, and
`empty` when a past member has no value. Its streaks count days, unless every
member is times-per-week, in which case they count weeks met by every member
who has started.

## SVG

`renderSvg(grid)` returns one self-contained SVG. It does not load a font,
image, or stylesheet. The title and description ids are built from the grid type, the person
id, the grid id, and the start and end dates. Each piece keeps its own length and
escapes other characters, so a tracker and a stack that share an id, two
ranges with the same start and a different end, `ab` and `a.b`, or `a-b`
with `c` and `a` with `b-c`, do not share an id on one page. Square `date`, `state`, and `shade` are escaped before
they are written into attributes, so a hand-built grid cannot add an event
handler. Ember values come from `brand/tokens.css`: page
`#15110f`, text `#f7f2ee`, body `#cec3bc`, magenta `#c8298b`, coral `#f37a4a`,
amber `#f7b267`. A tracker color that would fall under WCAG AA non-text
contrast (3:1) against the page is lightened. Small labels use the cream text
color (above 4.5:1). Full days add a check mark. Rest days add a circle and a
bar. Done days are a diamond that grows from shade 1 to shade 4. Partial days are bars. Open days are dashed.
Empty days are an outline. Shape does not depend on color alone.

## JSON schema version 1

One JSON object per person. Strings are plain text, never HTML. Applications
must render them as text.

```json
{
  "schemaVersion": 1,
  "id": "example-person",
  "life": {"value": true, "stamp": {"counter": 1, "time": 100, "device": "example-phone"}},
  "purge": null,
  "fields": {
    "name": {"value": "River", "stamp": {"counter": 1, "time": 100, "device": "example-phone"}},
    "weekStartsOn": {"value": "sunday", "stamp": {"counter": 1, "time": 100, "device": "example-phone"}}
  },
  "trackers": [],
  "stacks": [],
  "checkIns": [],
  "restDays": []
}
```

A **stamp** is `{counter, time, device}`: a positive safe-integer logical
counter, safe-integer wall-clock milliseconds, and a nonempty device string.
Compare counter first, time second, device ID last. Clock skew alone cannot
outweigh a greater counter. Concurrent equal counters and times resolve by
device ID. Conflicting values with an identical stamp are refused.

A **register** is `{value, stamp}`. Person fields are `name` and
`weekStartsOn`. Tracker fields are `name`, `color`, `kind`, `target`, `unit`,
`usualAmount`, `schedule`, and `startedOn`. Stack fields are `name`, plus a
`members` map of tracker ID to a boolean register. Check-in fields are
`trackerId`, `date`, `value`, and `source`. A check-in may also keep
`formerTrackers`, a map of every tracker it left, each `{value: true, stamp}`
from that move. A check-in may also keep `emptied`, a stamp written only when
that check-in is emptied from Trash. Copying a tracker fence onto `purge`
does not set `emptied`. It records `fenced`, the tracker cutoff copied onto
the check-in. Rest fields are `date` and
`trackerId` (empty means every tracker).

Each record is `{id, life, purge, fields}` and a stack also has `members`.
`life` true means present and false means deleted. The highest stamp wins per
register. A later edit or re-add beats an earlier deletion. Different IDs
never coalesce. Array order in the file is permanent-ID order. The grid is
derived and is not stored.

`purge` is null or a permanent stamp cutoff. Delete keeps fields in Trash.
Emptying Trash erases fields and keeps a content-free marker. A purged person
keeps `schemaVersion`, `id`, false `life`, `purge`, empty `fields`, and empty
collections. During merge, only fields stamped after the cutoff survive. An
old offline copy cannot restore purged content. Cutoffs are not removed in
this slice. A fresh `addTracker` or `logCheckIn` may reuse an emptied ID; the
cutoff stays, and only the new fields survive. Emptying a check-in records
that empty on the check-in itself, including when the same Trash call also
empties a tracker it left, so the two stamps can match. Former-tracker history
stamped at or before that empty stays erased, and an older copy cannot attach
the reused check-in to a tracker it left before the empty. Re-creating that
tracker and emptying it later does not remove the reused check-in. A cutoff
copied from another tracker's fence is not that empty, so it does not erase
history of a different tracker the check-in left. A replica that merely lacks
one of those trackers, and whose purge was copied from a different tracker's
fence, does not erase it either. A file saved before `emptied` was stored
still counts when that purge is the check-in's own: it is not the person
cutoff, and it is not the cutoff of any tracker in the file. A purge copied
from a tracker stays that tracker's fence after the check-in id is reused on
another tracker, so a move saved on an older copy is kept. An
`emptied` stamp with no purge, or newer than the check-in's purge, is refused.
History stamped at or before that empty is refused too. A purge that matches
a tracker cutoff and has neither `emptied` nor `fenced` is refused, including
an older file from one Trash call that emptied the check-in and a tracker
together. A `fenced` stamp with no `emptied` must equal that check-in's purge
and a tracker cutoff. When a later person cutoff supersedes that fence, the
check-in records the newer cutoff as its fence, so a reused check-in still merges.
Former-tracker history stamped at or before that person cutoff is cleared with
the old fence, and every later merge applies the same cutoff, including after
the check-in's fence stamp has been updated to it. The merge that first records
that person cutoff as the fence clears the same history before it returns.
Emptying one of those earlier trackers leaves the reused check-in in place.

Check-ins merge as records by ID. The same ID arriving twice counts once.
Two devices' different IDs on the same tracker and date both survive, and the
day's value is their sum. There is no stored day-total field.

Serialization preserves engine snapshots exactly, including tombstones.
Loading checks the schema, field types, IDs, duplicate IDs, and stamps.
A record that is present or still in Trash must include every field for its
type, unless a purge cutoff left a fragment whose surviving fields are newer
than that cutoff. A field or stack member stamped at or before that cutoff is
refused even when the record is otherwise complete, with `Field is older than
its purge cutoff.` A nested record uses the later of its own cutoff and the
person's cutoff. A check-in, tracker-specific rest day, or stack membership
stamped at or before the purge cutoff of the tracker it names is refused the
same way, even when the person has no cutoff. A fragment whose remaining
fields and life are newer than that tracker cutoff still loads and stays
hidden. A life register at or before that cutoff is refused unless
the record is already an empty purged marker, with `Life is older than its
purge cutoff.` A purged marker has empty fields and may omit them. A saved
file that drops `date` from a live check-in with no cutoff fails at load with
`Incomplete record in person file.` A person who is live or still in Trash
must include `name` and `weekStartsOn` unless a purge fragment explains the
gap; dropping either fails the same way. A tracker whose `kind`, `target`, and
`unit` cannot describe that kind fails with
`Invalid tracker shape in person file.` Unknown versions fail with
`Unsupported schemaVersion; expected 1.` No migration is attempted.

Changing `kind`, `target`, or `unit` writes all three again at the same stamp.
Merge compares those fields on their own, and because they share a stamp the
newest shape write wins together. Every merge order agrees. A purged field is
never copied back. A cutoff can leave a record with only the fields stamped
after it. A tracker, stack, check-in, or rest day keeps a life stamp newer than
that cutoff when no field survives, and it stays hidden until a newer
field arrives. Every merge order keeps that life. An emptied person still
refuses `addTracker`, `addStack`, and `markRest`. That fragment stays in the file so a later replica can fill the
gaps, and it stays out of the live grid, the live view, and the commands
that log a check-in or mark a rest day. A new tracker with that same
permanent ID can replace the fragment. `kind`, `target`, and `unit` travel
together: a record that has one of them must have all three, and those three
must describe a real tracker. Merge checks the result again, so two fragments
cannot be joined into an impossible tracker. A saved file that drops `date`
from a live check-in with no cutoff still fails at load.

## Undo

This slice does not keep an undo stack. Trash and restore are the way back
from a delete until Trash is emptied.
