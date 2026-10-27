# Today agenda

One day's facts in, one agenda out. This package does not read calendars, tasks, habits or lists from their engines. It does not use the network, AI, the clock or the machine's time zone. Node 22 or later.

```sh
cd packages/today-agenda
npm test
```

The command, from the repo root:

```sh
node packages/today-agenda/src/agenda.mjs --day <day.json> [--json]
```

`--json` prints the agenda. Without it, the command prints the summary sentences, then the timeline (clashes marked), free time, tasks, habits and lists. A refusal prints one message on standard error and no agenda. `buildAgenda(day)`, exported from `src/index.mjs`, is the same work as a function: it returns the agenda, prints nothing, never reads the clock and never calls `process.exit`.

## Day file

`schemaVersion` is `1`. The file is at most 2,097,152 bytes (2 MB).

```json
{
  "schemaVersion": 1,
  "date": "2026-10-26",
  "timeZone": "America/New_York",
  "now": "2026-10-26T11:00:00-04:00",
  "settings": { "dayStart": "08:00", "dayEnd": "18:00", "minFreeMinutes": 30 },
  "events": [
    {
      "key": "review",
      "title": "Design review",
      "start": "2026-10-26T14:00:00-04:00",
      "end": "2026-10-26T15:30:00-04:00",
      "allDay": false,
      "calendar": "Work",
      "location": "Studio",
      "status": "confirmed"
    }
  ],
  "tasks": [
    { "id": "rent", "title": "Pay the studio rent", "due": "2026-10-20", "priority": "high", "list": "Bills" }
  ],
  "habits": [
    { "id": "read", "name": "Read a chapter", "state": "open" }
  ],
  "lists": [
    { "id": "groceries", "name": "Groceries", "open": 7 }
  ]
}
```

`date` is the agenda's civil date. `timeZone` is an IANA name, checked with `Intl`. `now` is an RFC 3339 instant with `Z` or a numeric offset (`±HH:MM`); it may fall on another date. `settings` may be omitted. `dayStart` and `dayEnd` are `HH:MM` (default `08:00` and `18:00`) and bound free time. `minFreeMinutes` is a whole number from 5 to 240 (default 30).

Limits: 500 events, 1,000 tasks, 100 habits, 50 lists. A list's `open` count is 0 to 10,000. Lengths are JavaScript string lengths (UTF-16 code units). Task titles are 1 to 500 characters. Habit names, list names, a task's `list`, locations and calendars are 1 to 200. **Event titles have no length cap of their own**; the 2 MB limit bounds them. An event title may be `""`. Every other title and name is at least one character.

`status` is `confirmed` (the default), `tentative` or `cancelled`. Habit `state` is `open`, `done` or `rest`. Task `priority`, when present, is `high`. A task with `dueTime` must also have `due`, and `due` must be `dueTime`'s date in `timeZone`. Whether a task is overdue is not an input.

Unknown fields, missing required fields, a repeated `key` or `id` inside one section, and bad dates or zones are refused. The message names the section and, for a list, the 1-based item. The same id in two sections is fine. A refusal produces no agenda.

`tests/fixtures/full-day.json` is a full invented day. `tests/expected/full-day.json` and `tests/expected/full-day.txt` are its agenda.

## Mapping from the calendar merge engine

An adapter reduces one occurrence to an agenda event. This package does not read the other occurrence fields (`uid`, `sources`, `floating`, and the rest); an unknown field is refused.

| Occurrence | Agenda event |
|---|---|
| `key` | `key` |
| `title` | `title` (`""` when the event had no summary) |
| `location` | `location`, omitted or `null` when the occurrence has `null` |
| `allDay` | `allDay` |
| `start.local` / `end.local` | `start` / `end` for a timed event (an RFC 3339 instant) |
| `start` / `end` | the `YYYY-MM-DD` dates for an all-day event; `end` is exclusive |
| `status` | `status` |
| first of `sources` | `calendar` (the adapter chooses the label) |

Timed example:

```json
{
  "key": "design-review|2026-10-26T18:00:00Z",
  "title": "Design review",
  "location": "Studio",
  "allDay": false,
  "start": { "utc": "2026-10-26T18:00:00Z", "local": "2026-10-26T14:00:00-04:00" },
  "end": { "utc": "2026-10-26T19:30:00Z", "local": "2026-10-26T15:30:00-04:00" },
  "status": "confirmed",
  "sources": ["Work"]
}
```

becomes:

```json
{
  "key": "design-review|2026-10-26T18:00:00Z",
  "title": "Design review",
  "start": "2026-10-26T14:00:00-04:00",
  "end": "2026-10-26T15:30:00-04:00",
  "allDay": false,
  "calendar": "Work",
  "location": "Studio",
  "status": "confirmed"
}
```

## Output

`buildAgenda` returns `{ schemaVersion, date, timeZone, summary, nextUp, timeline, clashes, freeTime, tasks, habits, lists, counts }`.

- `summary` is the sentences below, in that order, with empty ones left out. Numbers are digits. Singular and plural agree. The wording never grades: it does not add "missed", "failed", "behind" or "score". A title that already contains one of those words is kept.
- `nextUp` is `{ inProgress, next }`. `inProgress` is every confirmed or tentative timed event with `start <= now < end`, in timeline order. `next` is the timed event with the earliest start after `now` (timeline order breaks a tie) plus `minutesUntil`, or `null`. `minutesUntil` is whole minutes, rounded down.
- `timeline` lists all-day events first (by title, then key), then timed events by start, end, title, then key. An empty event title is shown as `(No title)`. Sorting still uses the empty string.
- `clashes` lists each overlapping pair: `keys` in timeline order, the overlap as local times and UTC instants, whole `minutes`, and `tentative` when either event is tentative.
- `freeTime` lists gaps of at least `minFreeMinutes` inside the day bounds. `minutes` is real elapsed time. `startInstant` and `endInstant` are the exact UTC moments.
- `tasks` lists overdue tasks, then tasks due today that have a time, then tasks due today without a time. `group` is `overdue` or `today`.
- `habits` lists the open habits. `lists` lists lists with at least one open item.
- `counts` holds `cancelledEvents`, `tasksNoDue`, `tasksOtherDates`, `habitsDone` and `habitsRest`.

Sentences, in order:

1. `You have 4 events today, starting at 09:00.` The time is the earliest timed event that starts on `date`. With only all-day events, or only events that started the day before, the time is left off.
2. `2 events overlap at 14:00.` Several overlaps: `There are 3 overlaps, the first at 10:30.`
3. `Your longest free stretch is 11:00 to 14:00.` A tie goes to the earlier stretch.
4. `3 tasks are overdue and 2 are due today.` Either half is left out when its count is zero. One task uses `is`.
5. `2 habits are still open.`
6. `Groceries has 7 items and Hardware has 2 items.` Every list with open items is named, most open first.

Wall times are 24-hour `HH:MM`, with `:SS` kept when the instant is not on a whole minute. A fraction of a second counts, so `09:00:00.500` is shown as `09:00:00`, not `09:00`. Local date-times in the timeline are `YYYY-MM-DDTHH:MM` or `YYYY-MM-DDTHH:MM:SS`. A plain-text line shows the clock time when both ends fall on `date`, and the full local date-time when an end falls on another date.

## Edge cases

These are the choices the plan does not spell out. Each one has a test.

- Event titles are not capped at 500 characters. A 5,000-character title is kept unchanged. Task titles stay at 500. Names, locations, calendars and a task's `list` stay at 200.
- An empty event title is shown as `(No title)` and sorts before any other title. A title of only spaces is kept as written. An empty task title, habit name, list name, calendar, location, key or id is refused. `location` may be omitted or `null`.
- `status` omitted means `confirmed`. `priority` omitted means not high. Only the string `high` is accepted.
- `dayStart` must be earlier than `dayEnd` as clock text, and still earlier after the local time is placed. `24:00` is not a valid clock time. The free-time window is from `dayStart` inclusive to `dayEnd` exclusive.
- A local time that does not exist (a spring-forward gap) is read with the offset in effect just before the gap, so `02:30` in `America/New_York` lands at `03:30`. The free-time line shows that real local time. A local time that happens twice (a fall-back hour) is the earlier instant. This applies to `dayStart`, `dayEnd` and the start of a civil date, including a date-only task's due moment.
- Free-time minutes are elapsed minutes, not a subtraction of the wall clock. A spring-forward morning from `01:00` to `04:00` is 120 minutes. A fall-back morning from `01:00` to `03:00` is 180 minutes. Labels can repeat an hour; the UTC instants do not.
- Two confirmed timed events clash when they overlap by at least one minute (60,000 ms). Exactly one minute clashes. 59 seconds does not. Back-to-back events do not. Two tentative events do not clash. A tentative event clashing with a confirmed one is marked `tentative`. Clashes are ordered by the timeline order of the pair. All-day events and no-length events never clash.
- A no-length timed event (`start` equal to `end`) is kept when its start falls on the day, from the day's start inclusive to the next day's start exclusive. It never blocks free time and is never in progress. It can be `next`.
- A timed event is on the day when it overlaps `[start of date, start of the next date)`. Ending exactly at the start of the day leaves it out. An all-day event is on the day when `start <= date < end` (end exclusive). `startsBefore` and `endsAfter` are only for timed events.
- Cancelled events that fall on the day are left out and counted. Cancelled events on another day, and other events that are not on the day, are left out and not counted.
- A task with no `due` increments `tasksNoDue`. A task that is not overdue and whose `due` is not `date` increments `tasksOtherDates`. Overdue means `dueTime` is before `now`, or, for a date-only task, `due` is before the civil date of `now` in `timeZone`. A task due exactly at `now` is not overdue. A date-only task due on `date` is due today, not overdue, when `now` is the previous evening.
- Within overdue tasks, and within due-today tasks that have a time, the earlier due moment comes first (a date-only task counts as the start of its date). High priority is the next key, then title, then id. Due-today tasks with no time share one moment, so they sort by high priority, then title, then id.
- Open habits sort by name, then id. Lists with `open` of 0 are omitted and not counted. Lists sort by `open` descending, then name, then id.
- The plain-text command puts input text on one line. A backslash is doubled, line breaks (`\n`, `\r`, U+2028, U+2029) are written as `\n`, tabs as `\t`, and bidirectional controls and the other ASCII controls as `\uXXXX` with lowercase hex. The JSON agenda keeps the original characters.
- Instants require seconds. Fractional seconds are accepted; digits past milliseconds are dropped for the math, and the original text is kept on the event. Years run from 0001 to 9999. `UTC` is a valid zone because `Intl` accepts it.
- The command refuses a file larger than 2,097,152 bytes before parsing it. `buildAgenda` refuses a value whose `JSON.stringify` text is larger than that. Duplicate keys inside one JSON object follow `JSON.parse` (the last one wins) before the repeated-key check.
- The engine does not mutate its input. The same value gives byte-identical JSON, including when a section's order is shuffled. Nothing depends on the clock, the machine zone, the locale or random values.
- `nextUp` is `{ inProgress: [], next: null }` when nothing is underway and nothing remains to start, including when `now` is on the day after and no event from `date` is still running. An event that starts exactly at `now` is in progress. One that ends exactly at `now` is not.
- When `now`'s civil date is `date`, free time before `now` is dropped, and a gap that crosses `now` starts at `now`. If the remainder is shorter than `minFreeMinutes`, it is dropped. When `now` is on another date, free time is not trimmed. Confirmed and tentative timed events block free time. All-day events do not.
