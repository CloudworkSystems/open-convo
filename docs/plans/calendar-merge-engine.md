# Calendar Merge Engine (PRD)

Status: Approved (Oct 23): owner said yes in the coordinator thread; Codex starts once this plan merges and a builder place is free.

Written October 23, 2026 by the coordinator (Claude, thread "261012 OC
Coordinator") from the owner's decision that day. Session name:
`OC-261023-calendar-merge-engine`. Umbrella: Personal (the shared family
calendar and the wall display stay with Family, step 11). Part of the public
launch set (PLAN.md, "Day One And Public Launch": "a Personal calendar that
only reads ... in one view"). Built by an outside builder under AGENTS.md
"Outside Builders": **Codex** builds, **Gemini Code Assist** reviews, and the
coordinator checks the result against this plan. Codex never reviews its own
work. It takes one of the outside-builder places (AGENTS.md); it doesn't
start while every place is taken.

## Why

The owner keeps his life in several calendars: iCloud, Google, his work
scheduling calendar and more. He wants one view that shows all of them
correctly. The hard part isn't fetching them; it's reading them right: a
meeting that repeats every Tuesday at 9:00 in New York must stay at 9:00
after the clocks change, a cancelled Tuesday must disappear, and the same
invitation in two calendars must show once. Every calendar service can
export the standard `.ics` format, so an engine that reads `.ics` text
correctly, tested on invented calendars, is the core of the launch calendar.
Connecting to the services comes later and only has to hand it text.

## Plan Of Record

1. **Now (this slice):** a read-only merge library on its own. `.ics` text
   in, one sorted list of occurrences for a date range out. No fetching, no
   editing, no app code, no storage code, no network.
2. **Next (building lanes):** reading the owner's calendars through sources
   he approves once as hosts (foundations principle 6), and a calendar view
   in the Desk and on the iPhone.
3. **Later (step 11):** the shared family calendar, voice to calendar and the
   wall display. Editing events is not planned for launch.

## What It Does

A small library and command in `packages/calendar-merge/`:

```
node packages/calendar-merge/src/merge.mjs --from 2026-11-01 --to 2026-11-08 --tz America/New_York <a.ics> <b.ics> ... [--json]
```

and the same as a function, `mergeCalendars(sources, query)`, exported from
`src/index.mjs`:

- `sources`: a list of up to 20 `{ id, name, ics }`, where `ics` is the
  file's text (at most 5 MB each). `id` is 1 to 40 characters and unique.
  The command uses each file's name, without `.ics`, as `id` and `name`.
- `query`: `{ from, to, timeZone, includeCancelled? }`. `from` and `to` are
  dates (`YYYY-MM-DD`), `to` not before `from`, at most 400 days apart; the
  range is the whole of each day from the start of `from` to the end of `to`
  in `timeZone`. `timeZone` is an IANA name (`America/New_York`), checked
  with Node's built-in `Intl`. `includeCancelled` defaults to false.

It returns a promise of the result under Output, prints nothing, reads no
clock, never writes a file and never calls `process.exit`. The command is a
thin wrapper that reads the files and prints a plain agenda (one line per
occurrence, grouped by day), or with `--json` the result object. A refusal
in the wrapper prints the message to stderr and exits with 1.

## Reading `.ics` Text

- Lines are unfolded (a line starting with a space or tab continues the one
  above); both CRLF and LF line endings are accepted. Text values are
  unescaped (`\n`, `\,`, `\;`, `\\`). Parameters may be quoted.
- Only `VEVENT` components are read; `VTODO`, `VJOURNAL`, `VALARM` and the
  rest are skipped without comment. `VTIMEZONE` blocks are read only for
  their `TZID` (see Time Zones).
- From each event: `UID`, `SUMMARY`, `LOCATION`, `DTSTART`, `DTEND` or
  `DURATION`, `RRULE`, `RDATE`, `EXDATE`, `RECURRENCE-ID`, `STATUS`,
  `SEQUENCE`, `DTSTAMP` and `LAST-MODIFIED`. Everything else (descriptions,
  attendees, attachments, alarms) is ignored and never copied to the output.
- An event that can't be read (no `DTSTART`, no `UID`, a date that doesn't
  parse, an end before its start) is skipped and listed in `problems`, naming
  the source and the line number. The rest of the file is still read. A file
  with no `BEGIN:VCALENDAR` is refused as a whole, naming the source.
- A file with `METHOD:CANCEL` marks the events in it as cancelled.

## Time Zones And Daylight Saving

- `DTSTART;TZID=America/New_York:20261103T090000` is 9:00 local time in that
  zone. Times ending in `Z` are UTC. A time with no `TZID` and no `Z`
  ("floating") is read in the query's `timeZone` and marked `floating: true`.
- `TZID` values that are IANA names are used as they are, through `Intl`.
  Windows zone names that Outlook and Exchange write (`Eastern Standard
  Time`) are mapped to IANA names with a fixed table in the package, taken
  from the Unicode CLDR `windowsZones` data (its source and version noted in
  the README). A `TZID` that is neither is not guessed: the event is skipped
  and listed in `problems` as "unknown time zone".
- **Repeats follow local time.** A weekly meeting at 9:00 New York time is at
  9:00 New York time every week, before and after the clocks change; its UTC
  time moves by an hour.
- **Times the clocks skip or repeat** follow RFC 5545: a local time that
  doesn't exist (2:30 on the spring-forward night) is read with the offset
  before the gap, so it lands at 3:30; a local time that happens twice (1:30
  on the fall-back night) is the first one.
- Each occurrence in the output gives its start and end both in UTC and in
  the query's time zone, with the offset written out.

## All-Day Events

- `DTSTART;VALUE=DATE:20261126` is an all-day event. `DTEND` is the day
  after the last day (the standard's rule); with no `DTEND` or `DURATION` it
  lasts one day.
- All-day events are dates, not times: they show on the same dates in every
  time zone and never move with daylight saving. One overlaps the range when
  any of its dates falls between `from` and `to`.

## Repeating Events

- `RRULE` with `FREQ` of `DAILY`, `WEEKLY`, `MONTHLY` or `YEARLY`, and
  `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY` (with numbers for monthly and yearly,
  such as `2TU` or `-1FR`), `BYMONTHDAY` (including negative days),
  `BYMONTH`, `BYSETPOS` and `WKST`. A month without the day asked for (the
  31st, or February 30th) is skipped, as the standard says.
- `RDATE` adds dates; `EXDATE` removes them (several `EXDATE` lines and comma
  lists both work). An `EXDATE` removes the occurrence whose start is the
  same instant, whatever zone each is written in (or the same date, for
  all-day events).
- **Changed occurrences.** An event with the same `UID` and a
  `RECURRENCE-ID` replaces that one occurrence: its new time, title or
  place. If its `STATUS` is `CANCELLED`, that occurrence is cancelled. A
  changed occurrence moved into the range from outside it shows; one moved
  out of it doesn't.
- `RANGE=THISANDFUTURE`, and `FREQ` of `HOURLY`, `MINUTELY` or `SECONDLY`, or
  `BYHOUR`, `BYMINUTE`, `BYSECOND`, `BYWEEKNO` or `BYYEARDAY`, are not
  supported in this slice. Such a series shows only its first occurrence
  (if in range), marked `repeatNotSupported: true`, and is listed in
  `problems`, so nothing silently goes missing.
- **Old series reach the range.** A series is expanded only as far as the
  range needs: one without `COUNT` jumps straight to the first period
  (day, week, month or year, in steps of `INTERVAL`) that can touch the
  range, instead of stepping from `DTSTART`, so a daily meeting that began in
  1990 shows correctly in 2026. One with `COUNT` is counted from `DTSTART`,
  as the standard requires, and stops at the end of the range or at its
  count; a `COUNT` above 1,000,000 is not supported (first occurrence only,
  as above). Changed occurrences are found by their `UID` and
  `RECURRENCE-ID`, not by expanding to them, so one moved into the range from
  far away still shows.
- **Safety limit.** At most 10,000 occurrences of one series are listed in one
  query (only `RDATE` lists can come close inside 400 days); a series that
  would list more shows the first 10,000 in the range and is listed in
  `problems`. The limit counts occurrences in the range, never occurrences
  before it.

## Cancelled Events

- An event, or one occurrence, with `STATUS:CANCELLED` (or from a
  `METHOD:CANCEL` file) is left out of the view, or shown with
  `status: "cancelled"` when `includeCancelled` is true.
- A cancelled series hides every occurrence, including its changed ones.

## The Same Event In Two Calendars

- **Same `UID`** (and the same `RECURRENCE-ID`, or none): one event, shown
  once, with every source it came from (`sources`, in the order the sources
  were given). When the copies differ, the copy with the higher `SEQUENCE`
  wins, then the later `LAST-MODIFIED`, then the later `DTSTAMP`, then the
  earlier source in the list. This is how a cancellation sent to one
  calendar beats an older copy in another. `matchedBy: "uid"`.
- **Different `UID`, same title and time**: two occurrences in different
  sources whose titles match (ignoring case, accents and spaces at the ends)
  and whose start and end are the same instant (or the same dates, for
  all-day events) are shown once, with both sources, and
  `matchedBy: "title-and-time"`. Two such occurrences in the same source are
  never merged. Matching runs after each event's own changes and
  cancellations are applied, and only between occurrences with the same
  status, so a cancelled copy never hides or merges into a live one.
- **Which copy is shown for a title-and-time match.** Every single-value
  field (`title`, `location`, `status`, `eventTimeZone`, `floating`,
  `isRepeat`, `isChanged`, `repeatNotSupported` and `uid`) comes from one
  winning copy, chosen by the same order as for the same `UID`: the higher
  `SEQUENCE`, then the later `LAST-MODIFIED`, then the later `DTSTAMP`, then
  the earlier source in the list, then the smaller `uid` in character-code
  order. Fields are never mixed from different copies. `sources` lists every
  source of every copy (in the order the sources were given), and `key` is
  built from all the merged keys, sorted. Since the winner depends only on
  the copies' contents and the source list, the order of events inside a file
  never changes it.
- Occurrences are merged; series are not. A daily stand-up in one calendar
  and a single copy of one day of it in another merge on that day only.

## Output

`{ schemaVersion: 1, query, occurrences, problems }`:

- `query`: the query as used, with `from` and `to` as the range's start and
  end instants.
- `occurrences`, each with: `key` (stable: `uid`, the occurrence's original
  start in UTC, and, for a title-and-time match, the keys merged into it),
  `uid`, `title`, `location` (or `null`), `allDay`, `start` and `end` (for
  timed events `{ utc, local }`, where `local` is in the query's time zone
  with the offset, such as `2026-11-03T09:00:00-05:00`; for all-day events
  dates), `eventTimeZone` (the event's own zone, or `null`), `floating`,
  `status` (`confirmed`, `tentative` or `cancelled`), `sources`,
  `matchedBy` (`null`, `uid` or `title-and-time`), `isRepeat`, `isChanged`
  (a changed occurrence), and `repeatNotSupported`.
- Sorted by day; on each day, all-day events first (by title), then timed
  events by start, then end, then title, then `key`, all in character-code
  order.
- `problems`: plain messages naming the source, the line and what was
  skipped.
- Same input gives byte-identical output. The order of the sources changes
  only the order of `sources` lists and which copy wins a full tie.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/calendar-merge`, Node's built-in test runner,
invented calendars only (invented people, `.example` addresses, written as
`.ics` fixtures in the package, in the styles iCloud, Google and Outlook
write them). At least:

1. Three invented calendars merged for one week match a saved expected JSON
   file and a saved agenda text exactly.
2. Daylight saving, for `America/New_York` and `Europe/London`: a weekly
   9:00 meeting stays at 9:00 local across the change in both directions
   (its UTC time moves by an hour); a 2:30 event on the spring-forward night
   lands at 3:30; a 1:30 event on the fall-back night is the first 1:30; a
   UTC event shows the right local time on both sides of the change; viewing
   a New York calendar in `Asia/Tokyo` and in `Pacific/Auckland` gives the
   right local times and days.
3. Time zone names: an IANA `TZID`, a Windows name with a `VTIMEZONE` block
   as Outlook writes it, an unknown `TZID` (skipped, in `problems`), a UTC
   time, and a floating time (read in the query's zone, marked floating).
4. All-day events: one day, several days (with the exclusive end), no end, a
   repeating birthday, and all-day events shown on the same dates in
   `America/Los_Angeles` and `Asia/Tokyo`; an all-day event never moves with
   daylight saving.
5. Repeats: daily with `COUNT`; weekly with `BYDAY=MO,WE,FR` and
   `INTERVAL=2`; monthly on `BYMONTHDAY=31` and `-1` (skipping short months
   for the first, the last day of each month for the second); monthly on
   `2TU` and `-1FR`; yearly on February 29 (leap years only); `BYSETPOS=-1`
   for the last weekday of the month; `UNTIL` as a date, a UTC time and a
   local time; `WKST=SU` changing a two-weekly result.
6. Exceptions: `EXDATE` as one line, several lines and a comma list removes
   exactly those occurrences; `RDATE` adds one; a changed occurrence moves
   one meeting to another time and title; one moved into the range shows and
   one moved out doesn't; a cancelled occurrence is gone, and shown as
   cancelled with `includeCancelled`.
7. Unsupported rules (`FREQ=HOURLY`, `BYWEEKNO`, `RANGE=THISANDFUTURE`) show
   the first occurrence marked `repeatNotSupported` and add a problem; so
   does `COUNT=2000000`. Old series: a daily series with no end that began
   in 1990, and a daily series from 2000 with `COUNT=20000`, both show every
   occurrence in a November 2026 range; a weekly series from 1990 with
   `INTERVAL=3` lands on the right weeks; a test checks the no-`COUNT` case
   takes no more steps than the range needs. An `RDATE` list of 10,001 dates
   inside the range shows 10,000 and adds a problem.
8. Cancelled: a cancelled single event, a cancelled series (its changed
   occurrences hidden too), and a `METHOD:CANCEL` file.
9. Duplicates: the same `UID` in two calendars shows once with both
   sources; when they differ, the higher `SEQUENCE` wins, and a cancelled
   copy with the higher `SEQUENCE` cancels it while one with a lower
   `SEQUENCE` doesn't; ties fall to `LAST-MODIFIED`, then `DTSTAMP`, then
   source order. Different `UID`s with the same title (different case, an
   accent, trailing spaces) and the same time show once as
   `title-and-time`; the same title at different times, and two matching
   events in one source, are not merged. Two title-and-time copies that
   differ in title spelling, location, time zone and floating show every
   field from the winner by `SEQUENCE`, then `LAST-MODIFIED`, `DTSTAMP`,
   source order and `uid`, never a mix, and shuffling the events inside each
   file gives the same result; a cancelled copy and a live copy at the same
   time are not merged.
10. Range: an event that starts before `from` and ends inside the range
    shows; one that ends exactly at the range's start doesn't; a range of one
    day; a range of 400 days works and 401 is refused; `to` before `from`
    and a bad `timeZone` are refused with a plain message.
11. Reading: folded lines (space and tab), LF-only files, escaped text, quoted
    parameters, `DURATION` instead of `DTEND`, lower-case property names,
    and a broken event (no `DTSTART`, end before start, bad date) skipped and
    listed with its line number while the rest of the file still shows. A
    file without `BEGIN:VCALENDAR`, a source over 5 MB, more than 20 sources
    and a repeated source `id` are refused.
12. Hostile but valid text in titles and places (quotes, `<script>`, `&amp;`,
    emoji, right-to-left text, very long titles) comes back unchanged in the
    JSON and prints on one line in the agenda (`\n` and `\t` written out).
    Descriptions, attendees and alarms in the input appear nowhere in the
    output (a test puts a marker string in each and checks).
13. Determinism: the same input twice gives byte-identical JSON; shuffling
    the order of events inside a file gives the same result. The engine reads
    no clock and no machine time zone: a test stubs `Date.now`, a `Date`
    built without an argument, and the local-time `Date` methods to throw,
    and the whole merge still runs.
14. No network and nothing written: the shared test setup stubs Node's network
    entry points (as in [visibility-report.md](visibility-report.md), test
    11) and fails if any is called; the library writes no files.

## Out Of Scope For This Slice

Fetching calendars (URLs, CalDAV, iCloud, Google, Exchange, accounts,
sign-ins), any network, creating, editing, accepting or declining events,
reminders and alarms, free/busy, to-dos, the shared family calendar, the wall
display, voice, app or Desk screens, storage or encryption code, AI, and any
real calendar.

## Rules For The Builder (Codex)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Work only in a checkout of this repo, on the branch
  `OC-261023-calendar-merge-engine`. Open a pull request into `main` as
  `cloudwork-bot`, with the label `agent: codex`; the description's last line
  names the builder (for example `— Codex, OC-261023-calendar-merge-engine`).
  Never push to `main` directly.
- Run **no commands on the owner's Mac** for this job. Nothing here needs it.
- Touch no keys, tokens, passwords, accounts, Keychain or private files. Use
  invented data only; never a real calendar, person or event. If anything
  private turns up, stop and say so in the pull request without copying it.
- Change files only under `packages/calendar-merge/`. Nothing else, not even
  `STATUS.md`: the coordinator updates STATUS.md. Touch no app, storage or
  memory code, and import nothing from `apps/` or another package.
- Write it like the other packages: JavaScript modules (`.mjs`), Node 22 or
  later, `"type": "module"`, `"private": true`, tests with `node --test`.
  Time zone work uses Node's built-in `Intl`, nothing else.
- No network calls, no AI, no paid services, in the code or the tests.
- No new dependencies: the `.ics` reading and repeat rules are written in the
  package. The Windows zone table is data copied from Unicode CLDR, with its
  source, version and license (Unicode License v3) named in the README and
  the pull request. Add no license file and no `license` field.
- Keep the first slice small: the engine, the command, the fixtures, its
  tests and a short README documenting the query, what is read, what isn't
  supported and the output, finishable in two to three days. Ideas beyond this
  plan go in the pull request as suggestions, not code.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Don't review your own pull request, and don't review the email sorting
  engine's either if Codex builds both.

## Review And Finish Line

1. Codex opens the pull request.
2. **The independent review.** Gemini Code Assist reviews it as code, round
   after round, once Gemini reviews on this repo. Until then (see Owner
   Questions), the PR steward's Claude review stands in, under AGENTS.md's
   existing rule for Codex-built work. Whichever of the two is reviewing is
   "the independent review" below. Codex fixes every P1 and P2 it raises
   (for Gemini, findings marked critical or high count as P1 and medium as
   P2), or explains in the pull request why one does not apply; P3s (Gemini's
   low findings) are optional. If Gemini starts reviewing partway through,
   both reviews of the latest commit must be clear. Codex's own automatic
   review may also appear and the merge gate's `codex-approved` check still
   applies as AGENTS.md says, but it never counts as the independent review
   of Codex's own work.
3. The coordinator checks the result against this document, posts the check
   as a comment, gives the owner a short try-it note (merge the sample
   calendars for the week the clocks change, then view the same week in
   another time zone), and switches on auto-merge once the independent
   review of the latest commit has no open P1 or P2. The merge gate merges
   it.

Done when the tests pass with one command, the independent review of the
latest commit has no open P1 or P2, and the coordinator's plan check finds
nothing missing from this document.

## Owner Questions

1. **Gemini Code Assist on the repo.** The same question as in
   [email-sorting-engine.md](email-sorting-engine.md): its GitHub app needs
   installing by the owner. Until it reviews, the PR steward's Claude review
   stands in.
2. **Look-alike events with different IDs.** Recommendation: show two events
   with the same title and the same time in different calendars once, naming
   both calendars, as above. The view only reads, so nothing is lost, and
   the owner sees one line instead of two. The alternative is to show both
   and mark them as possible duplicates.
