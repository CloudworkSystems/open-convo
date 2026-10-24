# Calendar merge engine

Reads calendars as `.ics` text and returns one sorted list of occurrences for
a date range, so several calendars (iCloud, Google, Outlook and others) show
correctly in one view. Read only: no fetching, no editing, no files written,
no network, no clock. Plain JavaScript on Node 22 or later, no dependencies;
time zones go through Node's built-in `Intl`. Plan:
[docs/plans/calendar-merge-engine.md](../../docs/plans/calendar-merge-engine.md).

Run every test (Node's built-in runner, invented calendars only):

```sh
cd packages/calendar-merge
npm test
```

## Try it

From this folder, with the invented sample calendars:

```sh
node src/merge.mjs --from 2026-11-01 --to 2026-11-07 --tz America/New_York \
  tests/fixtures/home.ics tests/fixtures/family.ics tests/fixtures/work.ics
```

Add `--json` for the result object, and `--include-cancelled` to show
cancelled occurrences. Each file's name without `.ics` is its `id` and `name`.
A refusal prints its message to stderr and exits with 1. Try the same week in
`--tz Asia/Tokyo`: timed events move, all-day events stay on their dates.

## API

```js
import { mergeCalendars, formatAgenda } from './src/index.mjs';
const result = await mergeCalendars(sources, { from: '2026-11-01', to: '2026-11-07', timeZone: 'America/New_York' });
console.log(formatAgenda(result));
```

- `sources`: up to 20 `{ id, name, ics }`. `id` is 1 to 40 characters and
  unique; `name` is shown in `sources` (it defaults to `id`); `ics` is the
  file's text, at most 5 MB (5,242,880 bytes as UTF-8).
- `query`: `{ from, to, timeZone, includeCancelled? }`. `from` and `to` are
  `YYYY-MM-DD`, `to` not before `from`, at most 400 dates counting both ends.
  The range runs from the start of `from` to the end of `to` in `timeZone`,
  an IANA name (offsets such as `+05:00` are refused). `includeCancelled`
  defaults to false.
- Anything outside these limits, and a file with no `BEGIN:VCALENDAR`, is
  refused: the promise rejects with a plain message. The library prints
  nothing and never calls `process.exit`.
- `formatAgenda(result)` gives the plain agenda the command prints: one line
  per occurrence, grouped by day, every value on one line (`\n`, `\t` and
  other control characters written out), untitled events as "(No title)".

## What is read

- Lines are unfolded (space or tab), CRLF or LF endings, text unescaped
  (`\n`, `\,`, `\;`, `\\`), parameters may be quoted, names in any case.
- Only `VEVENT`s: `UID`, `SUMMARY`, `LOCATION`, `DTSTART`, `DTEND` or
  `DURATION`, `RRULE`, `RDATE`, `EXDATE`, `RECURRENCE-ID`, `STATUS`,
  `SEQUENCE`, `DTSTAMP`, `LAST-MODIFIED`, and the calendar's `METHOD`.
  Descriptions, attendees, attachments, alarms, to-dos and the rest are never
  read into the output. `VTIMEZONE` blocks are not used for offsets.
- Time zones: `TZID` as an IANA name, or a Windows name (as Outlook and
  Exchange write it) mapped through the CLDR table below; anything else is
  not guessed (the event is skipped, "unknown time zone"). `Z` is UTC; a time
  with neither is floating, read in the query's zone and marked
  `floating: true`. Repeats follow local time. A time the clocks skip is read
  with the offset before the gap (2:30 becomes 3:30); a time that happens
  twice is the first one.
- All-day events are dates: the same dates in every zone, `DTEND` exclusive,
  one day when there is no end.
- Repeats: `FREQ` `DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY` with `INTERVAL`,
  `COUNT`, `UNTIL`, `BYDAY` (numbered for monthly and yearly), `BYMONTHDAY`
  (negative too), `BYMONTH`, `BYSETPOS`, `WKST`; `RDATE` (dates, date-times
  and periods) and `EXDATE` (several lines, comma lists, matched by instant,
  or by date for all-day events); changed occurrences (`RECURRENCE-ID`).
  A series without `COUNT` jumps straight to the range; one with `COUNT` is
  counted from `DTSTART`. At most 10,000 occurrences of one series in a range.
- Status: none means `confirmed`. `STATUS:CANCELLED` or a `METHOD:CANCEL` file
  cancels; a cancelled series hides all its occurrences. A cancelled `VEVENT`
  with a `UID` and no `DTSTART` is a cancellation record, matched by `UID`
  (and `RECURRENCE-ID`) across all sources.
- The same `UID` (and `RECURRENCE-ID`) in several sources is one event: the
  copy with the higher `SEQUENCE`, then later `LAST-MODIFIED`, then later
  `DTSTAMP`, then earlier source wins (`matchedBy: "uid"`). Different `UID`s
  with the same title (ignoring case, accents and spaces at the ends), the
  same start and end and the same status are shown once
  (`matchedBy: "title-and-time"`), grouped one to one: occurrences are sorted
  by the smallest source index in their source set, then `uid`, then `key`,
  and each joins the first group whose sources don't overlap its own. All
  fields come from one winning copy.

## Not supported in this slice

`FREQ` of `HOURLY`, `MINUTELY` or `SECONDLY`; `BYHOUR`, `BYMINUTE`,
`BYSECOND`, `BYWEEKNO`, `BYYEARDAY`; `RANGE=THISANDFUTURE`; `COUNT` above
1,000,000; and rules the standard doesn't allow (see E2). Such a series shows
only its first occurrence, marked `repeatNotSupported: true`, and is listed in
`problems`. Fetching, editing, alarms, free/busy and to-dos are out of scope.

## Output

`{ schemaVersion: 1, query, occurrences, problems }`.

- `query`: `{ from, to, timeZone, includeCancelled }`, with `from` and `to` as
  the range's start and end instants, each `{ utc, local }`.
- Each occurrence: `key` (`uid/original start`, the start in UTC, as a
  wall-clock time for floating events, or as a date for all-day events; keys
  merged by title and time are joined with ` + `, sorted), `uid`, `title`
  (`""` when there is none), `location` (or `null`), `allDay`, `start` and
  `end` (`{ utc, local }` for timed events, `local` in the query's zone with
  its offset; dates for all-day events, `end` exclusive), `eventTimeZone`
  (the event's IANA zone, `UTC` for `Z` times, `null` for floating and
  all-day), `floating`, `status` (`confirmed`, `tentative`, `cancelled`),
  `sources` (`[{ id, name }]` in the order given), `matchedBy` (`null`, `uid`,
  `title-and-time`), `isRepeat`, `isChanged`, `repeatNotSupported`.
- Sorted by day; all-day events first (by title), then timed events by start,
  end, title and `key`, in character-code order.
- `problems`: plain messages naming the source, the line and what was skipped.
- The same input gives byte-identical output; the order of events inside a
  file never changes it.
- Because look-alike copies are grouped by the smallest source index first
  (#121 requirement 1), the order of the sources can change which copies pair
  up when three or more look-alike copies collide at the same time: with "c"
  in A and B, "b" in B and "a" in C, the order A, B, C gives {a, c} and {b},
  while C, B, A gives {a, b} and {c}.

## Work limits

Calendars come from outside, so one call's work is bounded, not only its
input size.

- A series may visit at most 100,000 repeat periods and hold at most 50,000
  `RDATE` and `EXDATE` values.
- One call may visit at most 2,000,000 repeat periods and read at most
  200,000 dates through a time zone. Each source gets an equal share of both
  (with 20 sources, 100,000 periods and 10,000 dates each), so a hostile
  calendar can only use up its own share; a series is charged to the source
  of the copy that is shown.
- Dates read through a time zone include `DTSTART`, `DTEND`,
  `RECURRENCE-ID`, `RDATE`, `EXDATE` and a local `UNTIL`. UTC times and
  all-day dates cost nothing. `DTSTAMP` and `LAST-MODIFIED` are always read
  as UTC (E20), so they never need time zone work.
- A series that would go past a limit shows only its first occurrence,
  marked `repeatNotSupported: true`, and is listed in `problems` ("needs too
  much work to expand"). An event whose own `DTSTART`, `DTEND` or
  `RECURRENCE-ID` can't be read because its source's share is used up is
  skipped; each source lists these once ("N events skipped, the first
  here"). Which events those are can depend on their order in the file.
- `RDATE` and `EXDATE` values whose written date is outside the range (with a
  day to spare) are skipped before any time zone work. Time zone offsets are
  cached per zone and hour, and time zone names are cached.

`tests/16-work-budget.test.mjs` covers a hostile 164-byte `COUNT` rule, a
hostile source next to a normal one, large out-of-range `RDATE` lists, and
the per-source date share. Those tests count problems and occurrences rather
than time.

## Edge cases

Cases the plan doesn't name, decided by RFC 5545's defaults where it has one.
Each has a test in `tests/15-edge-cases.test.mjs` under the same number.

- **E1.** `DTSTART` always counts as the first occurrence, even when it
  doesn't match the rule (RFC 5545 3.3.10).
- **E2.** A rule the standard doesn't allow (`COUNT` with `UNTIL`,
  `BYMONTHDAY` with `WEEKLY`, a numbered `BYDAY` with `DAILY` or `WEEKLY`,
  `BYSETPOS` alone, an unknown rule part, `INTERVAL=0`) is handled like an
  unsupported one: first occurrence, marked, and a problem.
- **E3.** Only the first `RRULE` is used (the standard says it SHOULD NOT
  appear more than once).
- **E4.** With both `DTEND` and `DURATION` (not allowed), `DTEND` is used.
- **E5.** An all-day event whose `DTEND` equals `DTSTART`, or with
  `DURATION:P0D`, lasts one day.
- **E6.** `DTEND` of another value type than `DTSTART`, and a `DURATION` with
  hours on an all-day event, make the event unreadable (skipped, listed).
- **E7.** `DURATION` days and weeks are nominal (they follow local time over a
  clock change); hours, minutes and seconds are exact. A `DTEND` gives every
  occurrence the same exact length as the first (RFC 5545 3.8.5.3).
- **E8.** An `EXDATE` written as a date on a timed series removes that date's
  occurrences (in the event's zone).
- **E9.** An `RDATE` of the other value type is skipped and listed; `RDATE`
  periods (`start/end` or `start/duration`) are read.
- **E10.** An `EXDATE` does not hide a changed copy (`RECURRENCE-ID`) of the
  same occurrence: the explicit copy still shows.
- **E11.** A `RECURRENCE-ID` of another value type than the series' `DTSTART`
  matches no occurrence; the changed copy shows on its own.
- **E12.** Floating `RECURRENCE-ID`, `EXDATE`, `RDATE` and `UNTIL` values are
  read in the event's own zone (the query's zone for floating events and for
  cancellation records without `DTSTART`).
- **E13.** `UNTIL` as a date on a timed series includes that whole date in
  the event's zone; on an all-day series a date-time `UNTIL` counts by its
  written date.
- **E14.** `STATUS` values ignore case (RFC 5545 3.2); an unknown value counts
  as `confirmed`.
- **E15.** A line that isn't `NAME:value` is ignored. A leap second (`:60`) is
  read as `:59` (RFC 5545 3.3.12).
- **E16.** Two copies of the same `UID` (and `RECURRENCE-ID`) in one source
  follow the usual order; a full tie is decided by their content, never by
  their place in the file.
- **E17.** A cancellation record with a `RECURRENCE-ID` matches when the
  series exists in any source, even if the series has no occurrence at that
  time; it is not listed as a problem.
- **E18.** An occurrence that began before the range is sorted and listed
  under the range's first day.
- **E19.** The query's time zone must be a name; offset forms are refused.
- **E20.** `LAST-MODIFIED` and `DTSTAMP` are UTC (RFC 5545). One written
  without `Z`, or with a `TZID` (which is ignored), is read as UTC too; they
  only break ties.
- **E21.** `METHOD` applies to its whole `VCALENDAR` wherever it is written,
  and a file may hold several `VCALENDAR`s.
- **E22.** A changed occurrence whose series is in no source shows on its own
  (`isChanged: true`, `isRepeat: true`).
- **E23.** A changed occurrence lists the sources of its series and of its
  changed copies.
- **E24.** A calendar given without a `name` is named by its `id`.
- **E25.** An event missing its `END:VEVENT` (another `BEGIN:VEVENT`,
  `END:VCALENDAR` or the end of the file comes first) is skipped and listed.
- **E26.** Parameter values are decoded as RFC 6868 says (`^n`, `^'`, `^^`).
- **E27.** RFC 5545 folds by octets, so a fold (or several) can split a
  multi-byte UTF-8 character. Before decoding, the command moves the
  unfinished start of a character to just after the fold's space or tab, so
  it reads whole and line numbers stay the same. The
  library takes text, so anything else that hands it text (a later fetch
  layer, for example) needs the same care.

## Windows time zone names

`src/windows-zones.mjs` is the `territory="001"` rows (139 names) of
`common/supplemental/windowsZones.xml` from Unicode CLDR release 46
(`mapTimezones otherVersion="7e11800" typeVersion="2021a"`),
<https://github.com/unicode-org/cldr/blob/release-46/common/supplemental/windowsZones.xml>,
copied as data. Unicode CLDR data is used under the Unicode License v3
(<https://www.unicode.org/license.txt>).

## Tests

`tests/01-…` to `tests/14-…` follow the plan's numbered tests, and
`tests/15-edge-cases.test.mjs` the edge cases above, and
`tests/16-work-budget.test.mjs` the work limits. Every test file loads
`tests/setup/guard.mjs` first, which blocks every network and process entry
point of Node 22's built-in modules and every file write, and fails a test
that calls one; `tests/setup/builtin-modules.json` lists Node's built-in
modules so a new one can't arrive unnoticed. Test 13 runs the merge with
`Date.now`, argument-less `new Date()` and the local-time `Date` methods all
throwing. Fixtures in `tests/fixtures/` are invented calendars in iCloud,
Google and Outlook styles, with `.example` addresses.
