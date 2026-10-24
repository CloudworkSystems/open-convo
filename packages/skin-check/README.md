# Skin check engine

Slice 1 of [docs/plans/skin-check.md](../../docs/plans/skin-check.md): a
standalone, in-memory Node ESM library for the Health module's Skin check.
No dependencies, app integration, disk I/O, network, accounts, AI, camera,
image handling, encryption, or real personal data. Node 22 or later.

It records spots and the owner's own self-check answers. **It never
diagnoses**: there is no score, no ranking of spots and no reassuring state.
Every outcome and the visit summary carry the standard reminder (`REMINDER`):

> Skin check keeps a record of your own observations. It is not a diagnosis.
> See a doctor or dermatologist about any spot that is new, changing, or
> worries you, whatever this app shows.

Run every test:

```sh
cd packages/skin-check
npm test
```

## Try it with invented data

From this folder:

```sh
node --input-type=module <<'JS'
import { SkinCheck } from './src/index.mjs';
const mac = new SkinCheck({ deviceId: 'example-mac', timeZone: 'America/New_York' });
const spot = mac.addSpot({ region: 'upperBack', label: 'Shoulder mole' });
mac.addCheckIn({
  spotId: spot,
  capturedAt: '2026-10-24T09:15:00-04:00',
  answers: { asymmetry: 'no', border: 'notSure', color: 'no', diameter: 'no', evolving: 'no',
    bleeding: 'no', sore: 'no', different: 'no', newSpot: 'no', nonMole: 'no', worry: 'no' },
  photo: { ref: 'example-photo-1', distanceGuide: true, scaleMarker: false, light: 'daylight' },
  source: 'phone',
});
console.log(mac.spotOutcome(spot).label); // Worth showing a clinician
console.log(mac.nextCheck(spot));         // { setting: 'monthly', anchor: '2026-10-24', due: '2026-11-24' }
console.log(mac.visitSummary().text);
JS
```

## The rules

Each check-in answers the questions in `QUESTIONS` (IDs `asymmetry`,
`border`, `color`, `diameter`, `evolving`, the urgent `bleeding` and `sore`,
`different`, `newSpot`, `nonMole`, `worry`) with `yes`, `no` or `notSure`.

- Any urgent `yes`: **Book an appointment soon**.
- Any other `yes` or `notSure` (including `notSure` on an urgent question):
  **Worth showing a clinician**. A missing answer counts as `notSure`.
- Only when every question is `no`: **No warning sign noted by you**, with
  the reminder.

Each reason repeats the question in the owner's words, for example
`You answered yes to "Has it bled without being hurt?"`.

A spot's outcome is the most cautious outcome of every check-in since the
latest "seen by a clinician" entry, with every reason kept and dated. A
check-in at the same instant as the visit or later counts as after it. Right
after a visit, the spot is **Not checked since your clinician visit** until a
new check-in arrives. A spot with no check-ins at all is **Not checked yet**
(see Edge cases).

Check-ins are ordered by capture instant (offsets don't matter), then by
check-in ID; clinician visits the same way. "Latest", "previous" and
"earliest" always mean that order.

## API

Import `SkinCheck`, `mergePeople`, `serializePerson`, `deserializePerson`,
`evaluateAnswers`, `compareStamps`, `civilDate`, `startOfDay`, `addDays`,
`addMonths`, `SCHEMA_VERSION`, `REMINDER`, `QUESTIONS`, `ANSWERS`, `OUTCOMES`,
`REGIONS`, `SOURCES`, `LIGHTS` and `DEFAULT_REMINDER` from `src/index.mjs`.

`new SkinCheck({ deviceId, now = Date.now, personId, timeZone = 'UTC' })`
starts a new file for one person; `new SkinCheck({ deviceId, now, person })`
opens an existing snapshot. Give each independent writer a unique, stable
device ID. `now` returns integer milliseconds. The logical counter advances
past every stamp in a loaded or imported file, including deletion markers.
`timeZone` is the owner's IANA time zone, used for date-only clinician visits,
reminder dates and the summary date.

- `addSpot({ region, note, label, createdAt }, { id }?)` returns a permanent
  ID. `region` is a key of `REGIONS`; `other` needs a short `note` saying
  where, and other regions take none. `createdAt` is a date and time with UTC
  offset (default: now, in UTC).
- `renameSpot(id, label)`, `moveSpot(id, region, note?)`,
  `archiveSpot(id, archived = true)`, `setReminder(id, 'monthly' | 'off' | 1..12)`.
- `removeSpot(id)` moves a spot to Trash; `restoreSpot(id)` brings it back;
  `emptyTrash()` deletes spots in Trash for good, with their check-ins and
  visits, and returns how many spots went.
- `addCheckIn({ spotId, capturedAt, answers, worryNote, photo, source }, { id }?)`
  returns a permanent ID. `capturedAt` must carry its UTC offset. `photo` is
  `null` or `{ ref, distanceGuide, scaleMarker, light }`: `ref` is a short
  opaque ID, never image data. `source` is `phone`, `mac` or `import`
  (reserved). An unknown, permanently deleted or Trashed spot is refused
  with a plain message, and so is the ID of a record that was permanently
  deleted with its spot.
- `recordClinicianVisit(spotId, { at | date, note }, { id }?)`
  records "seen by a clinician". With `date` (YYYY-MM-DD), the visit counts
  from the start of that day in the owner's time zone; the resulting instant
  is stored, with `dateOnly: true`.
- `setTimeZone(timeZone)`.
- `spots({ trash = false }?)`, `spot(id)`: plain views (`region`,
  `regionName`, `note`, `label`, `createdAt`, `archived`, `reminder`,
  `inTrash`, `returned`).
- `checkInOutcome(checkInId)` and `evaluateAnswers(answers)` return
  `{ outcome, label, reasons, reminder }`. `spotOutcome(spotId)` adds
  `visit` and, for the two "not checked" outcomes, a `prompt`.
- `timeline(spotId)` returns the check-ins in order with their outcomes,
  `earliest`, `previous` and `latest` check-in IDs, `photoPairs`
  (`latestWithEarliest` and `latestWithPrevious` among check-ins that have a
  photo, as `{ from, to }` or `null`), and `evolving` (each check-in's
  evolving answer and whether it `changed` from the one before).
- `nextCheck(spotId)` returns `{ setting, anchor, due }`. The anchor is the
  civil date, in the owner's time zone, of the latest check-in (or of the
  spot's creation when it has none). Monthly adds one calendar month,
  clamped to the month's last day (January 31 gives February 28 or 29);
  weeks add whole civil days, so daylight-saving changes never shift it.
  `off` gives `due: null`. The engine only computes dates and sends nothing.
- `visitSummary({ date, includeArchived = false }?)` returns `{ html, text,
  groups }`. Groups, in order: Book an appointment soon, Worth showing a
  clinician, Not checked since your clinician visit, Other spots. Within a
  group spots follow the body-region list, then label, then ID, never a
  severity order. The reminder is at the top and under every "no warning
  sign" spot. Each spot shows its outcome and dated reasons, region, dates
  checked, clinician visits, every check-in's answers, the owner's notes and
  photo references. All owner text is escaped. The HTML is self-contained,
  with no images, scripts or links.
- `getPerson()` returns a JSON-compatible copy. `save()` / `load(json)`
  serialize and merge JSON strings; `importPerson(snapshot)` merges a
  snapshot. A file for another person is refused.

`mergePeople(a, b)` is a pure, commutative merge of two copies of the same
person's file. Spot fields are version-stamped registers (higher counter,
then time, then device ID wins). Check-ins and clinician visits never change
once made, so they merge as sets of records by ID; the same record arriving
twice counts once, and two different records sharing an ID are refused.

## JSON schema version 1

One JSON object per person. It holds no image data. Strings are plain text
and must be rendered as text.

```json
{
  "schemaVersion": 1,
  "id": "example-person",
  "fields": {
    "timeZone": {"value": "America/New_York", "stamp": {"counter": 1, "time": 100, "device": "example-mac"}}
  },
  "spots": [{
    "id": "example-spot",
    "life": {"value": true, "stamp": {"counter": 2, "time": 100, "device": "example-mac"}},
    "purge": null,
    "purged": {"checkIns": [], "visits": []},
    "fields": {
      "place": {"value": {"region": "upperBack", "note": ""}, "stamp": {"counter": 2, "time": 100, "device": "example-mac"}},
      "label": {"value": "Shoulder mole", "stamp": {"counter": 2, "time": 100, "device": "example-mac"}},
      "createdAt": {"value": "2026-10-24T13:00:00.000Z", "stamp": {"counter": 2, "time": 100, "device": "example-mac"}},
      "archived": {"value": false, "stamp": {"counter": 2, "time": 100, "device": "example-mac"}},
      "reminder": {"value": "monthly", "stamp": {"counter": 2, "time": 100, "device": "example-mac"}}
    }
  }],
  "checkIns": [{
    "id": "example-check-in",
    "spotId": "example-spot",
    "capturedAt": "2026-10-24T09:15:00-04:00",
    "answers": {"asymmetry": "no", "border": "notSure"},
    "worryNote": "",
    "photo": {"ref": "example-photo-1", "distanceGuide": true, "scaleMarker": false, "light": "daylight"},
    "source": "phone",
    "stamp": {"counter": 3, "time": 100, "device": "example-phone"}
  }],
  "visits": [{
    "id": "example-visit",
    "spotId": "example-spot",
    "at": "2026-10-30T00:00:00-04:00",
    "dateOnly": true,
    "note": "",
    "stamp": {"counter": 4, "time": 100, "device": "example-mac"}
  }]
}
```

A spot whose Trash was emptied keeps only a deletion marker: `life` is
`false` with the same stamp as `purge`, its fields are gone, and `purged`
lists the IDs of the check-ins and of the visits deleted with it, each
under its own type. A merge drops a record only when its own spot lists its
ID under that record's type. A future sync
adapter must keep these markers; dropping them would let an offline copy
bring deleted records back. Unknown keys, an unknown `schemaVersion`, or a
check-in or visit for a spot that is not in the file are refused.

## Edge cases

Cases the plan doesn't name, each read the cautious way and covered by a test:

- **A spot with no check-ins** is "Not checked yet" with a prompt to add one,
  listed under Other spots. It is never "No warning sign noted by you".
- **The reminder line** is on every outcome, not only "No warning sign".
- **A check-in the emptying device never saw.** Emptying Trash deletes the
  spot's check-ins and visits by ID. If another device adds a check-in or
  visit for that spot before it hears about the deletion, the spot comes
  back (`returned: true`, region `other` until the owner moves it) instead
  of that observation vanishing. A copy of the old records alone never
  brings the spot back. A restore stamped after the emptying also brings it
  back, without its old details.
- **Delete versus offline edit.** A concurrent rename keeps its new label,
  but the spot stays in Trash until someone restores it.
- **Archived spots** keep their outcome, accept check-ins, and are left out
  of the visit summary unless `includeArchived` is set.
- **Date-only visits** store the start-of-day instant when recorded. A later
  time zone change doesn't move them. On a day whose midnight is skipped by a
  daylight-saving change, the day starts at its first real minute.
- **Dates shown in the summary** are the date part of each capture time as
  the device recorded it.
- **Photo references** longer than 200 characters, containing spaces or
  angle brackets, or starting with `data:` are refused, so image data can't
  slip in as a reference.
