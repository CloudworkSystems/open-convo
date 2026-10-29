# Today Agenda (PRD)

Status: In progress (Oct 25): merged in #138; GrokBot team C started the build (#145) after #112 merged.

Written October 24, 2026 by a Claude session (project "261024 OC Steering")
from the owner's choice that day. Session name: `OC-261024-today-agenda`.
Umbrella: Personal. Part of the day-one proof (PLAN.md, "Day One And Public
Launch": a new user should see in the first session that an agent helps
them). Built by an outside builder under AGENTS.md "Outside Builders":
**GrokBot team C** builds, through Cursor and signed in as `cloudwork-bot`,
once its current module (#112) has merged; **Codex** reviews; the
coordinator checks the result against this plan. It takes one of the
outside-builder places.

## Why

The launch set has separate engines for the calendar
([calendar-merge-engine.md](calendar-merge-engine.md)), checklists
([household-lists-engine.md](household-lists-engine.md)), habits
([habit-grid-engine.md](habit-grid-engine.md)) and, soon, tasks
([tasks-engine.md](tasks-engine.md)). What a person actually wants each
morning is one answer: what does today look like? Meetings in order, what
clashes, where the free time is, what's due or overdue, which habits are
still open, and what's on the shopping list. Putting those together, in a
fixed and explainable way, is the agenda. It needs no AI: the order, the
clashes and the free time are rules, and the short morning summary is a
template. A model can later phrase it more warmly; it can't change what's in
it.

## Plan Of Record

1. **Now (this slice):** a composing library on its own. One day's facts in,
   one agenda out. It reads only its own input format and imports no other
   package. No app code, no storage code, no AI, no network.
2. **Next (building lanes):** small adapters in the app that turn each
   engine's output into this input, a Today view in the Desk and on the
   iPhone, and the conversation answering "what's my day?" from it.
3. **Later:** the family wall display (step 11) shows a shared version.

## What It Does

A small library and command in `packages/today-agenda/`:

```
node packages/today-agenda/src/agenda.mjs --day <day.json> [--json]
```

and the same as a function, `buildAgenda(day)`, exported from
`src/index.mjs`. It returns the agenda (synchronously), prints nothing,
never reads the clock and never calls `process.exit`.

### The Day File

`schemaVersion: 1`, at most 2 MB, with:

- `date` (`YYYY-MM-DD`), `timeZone` (IANA, checked with Node's `Intl`) and
  `now` (an RFC 3339 instant with an offset or `Z`). The agenda is for that
  date in that zone, as seen at `now`; `now` may fall on another date (an
  agenda prepared the night before).
- `settings` (optional): `dayStart` and `dayEnd` (`HH:MM`, default 08:00 and
  18:00) bounding free time; `minFreeMinutes` (5 to 240, default 30).
- `events`: up to 500, each `{ key, title, start, end, allDay, calendar,
  location?, status? }`. `start` and `end` are RFC 3339 instants for timed
  events, or `YYYY-MM-DD` dates (end exclusive) when `allDay` is true.
  `status` is `confirmed` (default), `tentative` or `cancelled`. This is the
  shape of one occurrence in the calendar merge engine's JSON output, reduced
  to these fields; the README shows the mapping.
- `tasks`: up to 1,000 open tasks, each `{ id, title, due?, dueTime?,
  priority?, list? }`. `due` is a date; `dueTime` an instant; `priority` is
  `high` or absent. A task with `dueTime` must also have `due`, equal to
  `dueTime`'s date in `timeZone`; anything else is refused. Whether a task
  is overdue is never an input: the agenda works it out (step 7).
- `habits`: up to 100, each `{ id, name, state }` where `state` is
  `open`, `done` or `rest` for this date.
- `lists`: up to 50, each `{ id, name, open }`, `open` being the number of
  unchecked items (0 to 10,000).

Task titles are up to 500 characters; habit and list names, locations and
calendars up to 200. Event titles have no length cap of their own (the
calendar merge engine returns very long titles unchanged); the 2 MB file
limit bounds them.
An event's `title` may be empty (the calendar merge engine gives `""` for an
event without `SUMMARY`), and the agenda shows it as "(No title)"; every
other title and name is at least 1 character. Unknown fields, missing required fields, repeated
`key` or `id` within a section, and bad dates or zones are refused with a
plain message naming the section and position. A refusal produces no
agenda.

## Building The Agenda

1. **Check the input** as above.
2. **Events for the day:** timed events that overlap the day (start of
   `date` to start of the next date in `timeZone`), and all-day events whose
   date range includes `date`. A timed event with no length (`start` equal
   to `end`, as the calendar merge engine gives for an event with neither
   `DTEND` nor `DURATION`) is kept when its start falls inside the day,
   from the day's start up to but not including the next day's start; it
   never clashes and never blocks free time. Cancelled events are left out
   and counted.
   A timed event that started yesterday or runs past midnight is kept and
   marked `startsBefore` or `endsAfter`.
3. **Timeline:** all-day events first (by title, then key), then timed
   events by start, then end, then title, then key. Times are shown as wall
   times in `timeZone`; a day with a clock change shows the true local times.
4. **Clashes:** two confirmed timed events clash when they overlap by at
   least one minute. Tentative events can clash with confirmed ones and are
   marked tentative. Each clash lists both keys and the overlap's local
   times. Back-to-back events (one ends as the next starts) don't clash.
5. **Free time:** gaps of at least `minFreeMinutes` between `dayStart` and
   `dayEnd`, not covered by any confirmed or tentative timed event, in local
   time. All-day events don't block time. If `now` is on `date`, free time
   before `now` is left out.
6. **Next up**, by one rule whatever date `now` falls on, over the day's
   events from step 2: `inProgress`, every confirmed or tentative timed
   event with `start <= now < end` (an event starting exactly at `now`
   counts), in timeline order, possibly empty; and `next`, the timed event
   with the earliest `start` after `now`, ties broken by timeline order,
   with minutes until it starts, or `null`. No-length events are never in
   progress; one starting after `now` can be `next`. So the night before,
   an overnight event that has already begun is in progress, and `next` is
   the first event still to start; the day after, `nextUp` is
   `{ inProgress: [], next: null }` unless an event from `date` is still
   running. The shape is the same in every case.
7. **Tasks:** a task is **overdue** when its due moment is before `now`:
   `dueTime` before `now`, or, for a date-only task, `due` before the date
   of `now` in `timeZone`. It is **due today** when it isn't overdue and
   `due` equals `date`. Overdue tasks come first (earliest due moment
   first, a date-only task counting as the start of its date), then due
   today with a time (by time), then due today without a time; high
   priority first within each, then title, then id. Tasks with no `due`, or
   due on a later date, are left out and counted.
8. **Habits:** open ones listed by name; done and rest counted. The wording
   never grades: "3 habits still open today", never "missed" or "behind" (the
   habit grid's rule).
9. **Lists:** lists with open items, most open first, then name.
10. **The summary:** three to six short plain sentences from a fixed
    template, in a fixed order, only from the facts above, for example:
    "You have 4 events today, starting at 9:00. Two of them overlap at 14:00.
    Your longest free stretch is 10:30 to 12:00. 2 tasks are overdue and 3
    are due today. 3 habits are still open. Groceries has 7 items." Sentences
    with nothing to say are left out. Numbers are written as digits; singular
    and plural are right.

**Same input, same agenda.** The same file gives byte-identical JSON, and
shuffling any section's order gives the same agenda. Nothing depends on the
clock, the machine's time zone, locale or random values.

## Output

`{ schemaVersion: 1, date, timeZone, summary, nextUp, timeline, clashes,
freeTime, tasks, habits, lists, counts }`. `counts` holds the numbers left
out (cancelled events, tasks on other dates, habits done and at rest). The
command's plain summary prints the summary sentences, then the timeline
with clashes marked, then free time, tasks, habits and lists. Text from the
input is printed on one line, with line breaks and tabs written as `\n` and
`\t`, and bidirectional control characters escaped.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/today-agenda`, Node's built-in test runner, invented
data only. At least:

1. A full invented day (events across two calendars, tasks, habits, lists)
   gives an agenda whose JSON matches a saved expected file exactly.
2. Events for the day: an event from yesterday into today, one from today
   into tomorrow, a multi-day all-day event, a cancelled event, an event
   entirely on another day, a no-length event at 12:00, and a no-length
   event at the next day's 00:00 each land (or don't) as the rules say.
3. Clashes: overlap by one minute clashes; back-to-back doesn't; a tentative
   event clashing with a confirmed one is marked; three mutually overlapping
   events give three clashes.
4. Free time: gaps shorter than `minFreeMinutes` are dropped; custom day
   bounds; all-day events don't block; free time before `now` is left out
   only when `now` is on `date`.
5. Clock changes: the spring-forward and fall-back days in
   `America/New_York` show the right local times, durations and free time.
6. Next up: in progress, between events, after the last event, and `now` on
   the evening before; two overlapping events both in progress, listed in
   timeline order; two events starting at the same next time, the first in
   timeline order chosen; `now` at 23:30 the evening before, with an event
   23:00 to 01:00 and one at 09:00, gives the overnight event in progress and
   the 09:00 event as `next`; `now` the day after gives an empty `nextUp`.
7. Tasks, habits and lists order and counts as above. A date-only task due
   yesterday is overdue; a task due today at 09:00 is overdue at 10:00 and
   due today at 08:00; with `now` the evening before `date`, a task due on
   `date` is due today, not overdue; a `dueTime` whose local date doesn't
   match `due` is refused.
8. The summary: each sentence appears only when it has something to say;
   singular and plural are right; no grading words appear in any output (a
   test scans for words such as "missed", "failed", "behind", "score").
9. Input checks: each refusal above, naming the section and position; an
   event with an empty title is accepted and shown as "(No title)", and one
   with a 5,000-character title is accepted unchanged, while a
   task with an empty title is refused; the
   same `key` in events and the same `id` in tasks are refused; the same
   value across different sections is fine.
10. Hostile but valid text (quotes, `<script>`, emoji, right-to-left text,
    bidirectional controls) is returned unchanged in the JSON and safe on one
    line in the summary.
11. Determinism and no clock: shuffled sections give byte-identical JSON;
    the engine runs with `Date.now`, an argument-less `Date` and the
    local-time `Date` methods stubbed to throw.
12. No network and nothing written: the test setup makes Node's network
    built-ins throw if called, and the library writes no files.

## Out Of Scope For This Slice

Reading calendars, tasks, habits or lists from their engines or files (the
app's adapters do that later), any AI or model wording, notifications, app
or Desk screens, the wall display, storage or encryption code, network, and
real personal data.

## Rules For The Builder (GrokBot Team C)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Start only after #112 has merged. Work only in a checkout of this repo,
  through Cursor, on the branch `OC-261024-today-agenda`, signed in as
  `cloudwork-bot`. Open a pull request into `main` with auto-merge off and
  the label `agent: grokbot`. Never push to `main` directly, and never
  switch on auto-merge.
- Mark the work as AGENTS.md "Accounts And Provenance" says: `Cursor Agent`
  as commit author, and `— GrokBot team C` as the last line of the pull
  request description and every comment.
- Run **no commands on the owner's Mac** for this job.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented data only.
- Change files only under `packages/today-agenda/`. Nothing else, not even
  `STATUS.md`. Import nothing from `apps/` or another package.
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network calls, no AI, no paid services, in the code or the tests.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the engine, the command, the tests and a short
  README with the day file, the mapping from the calendar merge engine's
  output, and the output. Finishable in one to two days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Supported setups are macOS and the Linux CI runners on Node 22 (AGENTS.md
  "Review Guidelines"); don't add Windows-specific code.
- Edge cases this plan doesn't name: write each choice in the README's "Edge
  cases" section with a test.

## Review And Finish Line

Codex reviews it as code until it gives a 👍 (GrokBot builds, Codex
reviews). GrokBot fixes every P1 and P2 or explains in the pull request why
one doesn't apply. The coordinator checks it against this plan, posts the
check as a comment, gives the owner a short try-it note, and switches on
auto-merge once the plan check passes. Done when the tests pass with one
command, Codex has no open P1 or P2 on the latest commit (or the Codex triage
judge passes it, [codex-triage.md](codex-triage.md)), and the plan check
finds nothing missing.
