# Tasks And Reminders Engine (PRD)

Status: Draft (Oct 24): owner chose this module for GrokBot team A on Oct 24; plan in review.

Written October 24, 2026 by a Claude session (project "261024 OC Steering")
from the owner's choice that day. Session name: `OC-261024-tasks-engine`.
Umbrella: Personal. Part of the day-one proof (PLAN.md, "Day One And Public
Launch": "**tasks and productivity** as the first real job it does"). Built
by an outside builder under AGENTS.md "Outside Builders": **GrokBot team A**
builds, working through Cursor and signed in as `cloudwork-bot`; **Codex**
reviews; the coordinator checks the result against this plan. It takes one
of the outside-builder places.

## Why

The household lists engine keeps checklists (groceries, house to-dos) that
stay on the list and get checked and unchecked. What it doesn't do is time:
"renew the car registration by November 30", "water the plants every three
days", "call the dentist on Monday, remind me at 9". Those are tasks. A new
user's first session should show an agent helping with them: "what's due
today", "what did I miss", "snooze this to tomorrow". The hard, testable part
is the dates: repeats that land on the right day across month ends, leap
years and clock changes, a repeat that counts from when it was done versus
from when it was due, and which reminders are due at a given moment. That
can be built and tested now on invented tasks.

## Plan Of Record

1. **Now (this slice):** the engine on its own, tested on invented data. No
   app code, no storage code, no notifications, no AI, no network.
2. **Next (building lanes):** a Tasks view in the Desk and on the iPhone,
   reminders shown by the apps, tasks added in conversation ("remind me to
   ..."), and sync through the sync core
   ([sync-core.md](sync-core.md)).
3. **Later:** shared family tasks (Family umbrella, step 11).

## What It Does

A small library in `packages/tasks/`, in the style of the household lists
and habit grid engines (an in-memory collection with permanent IDs, saved to
and loaded from one JSON file per person):

- **Tasks** have a title (1 to 500 characters), an optional note (up to
  5,000), an optional list name for grouping (`Home`, `Work`, `Errands`), an
  optional priority (`high` or none; no other levels), and a state: `open`,
  `done` or `dropped`.
- **Due** is optional and is one of:
  - a **date** (`2026-11-30`): due that day, wherever the owner is;
  - a **date and time in a time zone** (`2026-11-02T09:00`,
    `America/New_York`): due at that wall time in that zone.
- **Reminders**: zero to five per task, each either a fixed moment (a date,
  time and time zone) or an offset before the due time (for example 1 day,
  2 hours). A date-only task's offset counts from 09:00 on its due day in the
  owner's zone (a setting, default 09:00).
- **Repeats** (optional), one of:
  - every N days (N 1 to 365);
  - every N weeks, plain: no weekdays are stored; on schedule each next
    due date is N weeks after the previous due date (so it keeps the first
    due date's weekday), and after done it is N weeks after the completion
    date;
  - every N weeks on chosen weekdays (at least one weekday; an empty set is
    refused);
  - every N months on a day of the month (1 to 31; a month without that day
    uses its last day, so "the 31st" falls on November 30) or on a numbered
    weekday ("the second Tuesday", "the last Friday");
  - every N years on a date (February 29 falls on February 28 in other
    years).
  Each repeat is either **on schedule** (the next due date follows the
  pattern from the previous due date, whenever it was done) or **after done**
  (the next due date counts from the day it was completed: "water every three
  days" after you actually water). **After done** is allowed only for plain
  intervals: every N days, every N weeks without chosen weekdays, every N
  months and every N years. A repeat with chosen weekdays, a day of the
  month, a numbered weekday or a yearly date is on schedule only; asking for
  after done on one is refused with a plain message. A repeat may end after
  a count or on a date.
- **Completing a repeating task** records the completion and moves the task
  to its next due date, keeping one task with a history, not a pile of
  copies. Completing it early, late or twice in a day follows the rules
  under Dates. Skipping an occurrence moves it on without recording a
  completion.
- **Snooze** moves a task's next reminder (and, if asked, its due date) to a
  chosen moment, or by a preset: later today (+3 hours), tomorrow at the
  reminder time, next Monday. Snoozing a repeating task changes only the
  current occurrence.
- **Drop** (the task won't be done) and **delete** are different: a dropped
  task stays in history; a delete goes to Trash, reversible until Trash is
  emptied.
- **Undo** for the last few changes, as in the household lists engine.

### Views

The engine answers questions for a given moment. The caller always passes
`now` (an instant) and the owner's `timeZone`; the engine never reads the
clock and never uses the machine's time zone.

- `today(now)`: open tasks due on today's date in the owner's zone, plus
  overdue tasks, plus tasks with a reminder already due today. Overdue first
  (oldest first), then by due time (date-only tasks after timed ones), then
  high priority first, then title, then ID.
- `upcoming(now, days)`: open tasks due in the next 1 to 60 days, grouped by
  date, repeating tasks shown once per occurrence in the window.
- `overdue(now)`: open tasks whose due moment has passed. A date-only task is
  overdue from the start of the next day in the owner's zone.
- `remindersDue(from, to)`: every reminder whose moment falls in the half-open
  range `[from, to)`, at most 31 days, each with its task and occurrence. A
  caller that checks every minute passes the last check and now, so no
  reminder is shown twice or missed.
- `history(taskId)`: completions, skips, snoozes and drops, newest first.

Output is plain data. Words are plain and never grade: no "failed", "late
again", streaks or scores (the same rule as the habit grid).

## Dates

- Date arithmetic works on calendar dates and never adds 24 hours, so a
  daylight-saving change can't skip or repeat a day.
- A timed due in a zone stays at that wall time across clock changes (9:00 in
  New York is 9:00 before and after the change). A wall time that doesn't
  exist on a spring-forward day moves forward by the gap (02:30 becomes
  03:30); one that happens twice on a fall-back day uses the first.
- Viewing from another zone converts the instant; date-only tasks stay on
  their date.
- **On schedule** repeats: completing an occurrence late moves to the next
  pattern date after the completed occurrence, and if that is also past, the
  task shows as overdue on the oldest missed occurrence only once (missed
  occurrences are not piled up). Completing early moves to the next
  occurrence after the one completed.
- **After done** repeats: the next due date is N days, weeks, months or
  years after the completion date in the owner's zone, keeping the task's
  time of day. Months and years keep the completion's day of the month, and
  a month without that day uses its last day (completed January 31, every
  month: due February 28 or 29); the next step counts again from the next
  completion, so it doesn't drift back.
- Time zones are IANA names, checked with Node's built-in `Intl`. No time
  zone data is bundled.

## Built For Sync Later

The same rules as the household lists engine
([household-lists-engine.md](household-lists-engine.md), "Built For Sync
Later"): permanent IDs, version stamps (a logical counter that moves past any
stamp seen, then wall time, then device ID), field-level merge with the higher
stamp winning, permanent deletion markers, and merging A into B equals B into
A. Two rules specific to tasks:

- **Completions are records, not a field.** Each completion, skip and snooze
  is its own record with an ID and the occurrence it belongs to, merged as a
  set, so two devices completing different occurrences both count and the
  same record arriving twice counts once. The next due date is computed from
  the merged records, never stored as the winner of a field race.
- **An occurrence is named by its scheduled due date** (the date, or the
  date and wall time with its zone) as it was when the record was made, and
  the record stores that name and, for a completion, the completion instant.
  Records never change when the rule changes.
- **The next due date always comes from the winning rule and the merged
  records**, whichever device's edit won: take the latest recorded
  occurrence name (completion or skip; for after done, the latest completion
  date). On schedule, the next due date is the winning rule's first date
  after that occurrence's date; after done, it is N units after that
  completion date. A record whose occurrence isn't a date of the winning
  rule stays in history and still moves the series on; it is never dropped.
  With no records, the next due date is the rule's first date on or after
  its start date. So a completion made under the old rule, merged with a
  rule edit from another device, gives the same next due date on every
  device.
- **Completing the same occurrence on two devices** keeps both records and
  counts the occurrence once.

The merge must also pass the sync core's merge-law check (commutative,
associative, idempotent; [sync-core.md](sync-core.md), test 16) so it can be
registered later. No network code in this slice.

## Data Format

One JSON file per person, with a `schemaVersion`, documented in the package
README so the Mac app, the iPhone app and a later Today view read the same
thing. Plain text only.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/tasks`, Node's built-in test runner, invented people
and tasks only. At least:

1. Add, edit, complete, reopen, drop, delete, restore and empty Trash; undo
   restores the previous state exactly.
2. Each repeat kind produces the right dates for two years from a start,
   including "the 31st" in short months, "the last Friday", "the second
   Tuesday", every 2 weeks on Monday and Thursday, and February 29 in leap
   and other years.
3. On schedule versus after done: completing late, early and twice on one
   day each give the next due date the rules above say; after done on a
   patterned repeat (chosen weekdays, a month day, a numbered weekday) is
   refused; after done every month from January 31 gives the last day of
   February; missed on-schedule
   occurrences show once as overdue, not piled up.
4. Repeat ends: after a count and on a date; the last completion leaves the
   task done.
5. Time zones: a 9:00 New York task stays at 9:00 across both clock changes;
   a nonexistent and a repeated wall time resolve as above; viewing from
   London and Tokyo converts timed tasks and leaves date-only tasks on their
   dates.
6. Views: `today`, `upcoming`, `overdue` and their ordering, on a fixed
   invented set, match a saved expected file exactly.
7. Reminders: fixed and offset reminders, a date-only task's 09:00 base, and
   `remindersDue` over back-to-back ranges returns each reminder exactly once,
   including across a daylight-saving change and a month end.
8. Snooze: each preset; snoozing one occurrence of a repeating task leaves
   the next occurrence alone.
9. Merge: the household lists engine's cases (different tasks, same field,
   delete versus edit, equal timestamps, clock skew, an offline copy after
   Trash is emptied), plus two devices completing different occurrences, the
   same occurrence, and a completion on one device while the other edits the
   repeat rule (weekly on Monday changed to weekly on Thursday: the Monday
   completion stays in history and the next due date is the first Thursday
   after it, on both devices, whichever order they merge in). Merging is commutative, associative and idempotent on random
   invented histories (a fixed seed, at least 500 cases).
10. No grading words in any text the engine produces (as in the habit grid,
    test 7).
11. Saving and loading round-trips exactly; an unknown `schemaVersion`, an
    unknown field and a bad time zone are each refused with a plain message.
12. Hostile but valid text (quotes, `<script>`, emoji, right-to-left text,
    very long titles) is stored and returned unchanged.
13. No clock: every operation runs with `Date.now`, an argument-less `Date`
    and the local-time `Date` methods stubbed to throw (`now` always comes
    from the caller or the collection's injected clock). No network and
    nothing written: the test setup makes Node's network built-ins throw if
    called, and the library writes no files.

## Out Of Scope For This Slice

App or Desk screens, notifications, the iPhone, voice or conversation input,
AI, network or iCloud, storage or encryption code, calendars (the calendar
merge engine is separate), shared tasks, attachments, subtasks, real personal
data.

## Rules For The Builder (GrokBot Team A)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Work only in a checkout of this repo, through Cursor, on the branch
  `OC-261024-tasks-engine`, signed in as `cloudwork-bot`. Open a pull request
  into `main` with auto-merge off and the label `agent: grokbot`. Never push
  to `main` directly, and never switch on auto-merge.
- Mark the work as AGENTS.md "Accounts And Provenance" says: `Cursor Agent`
  as commit author, and `— GrokBot team A` as the last line of the pull
  request description and every comment.
- Run **no commands on the owner's Mac** for this job.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented data only.
- Change files only under `packages/tasks/`. Nothing else, not even
  `STATUS.md`: the coordinator updates STATUS.md. Import nothing from
  `apps/` or another package.
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network calls, no AI, no paid services, in the code or the tests.
- No new dependencies. Add no license file and no `license` field.
- Keep the first slice small: the engine, the tests and a short README with
  the data format, the API and a try-it snippet. Finishable in one to two
  days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Supported setups are macOS and the Linux CI runners on Node 22 (AGENTS.md
  "Review Guidelines"); don't add Windows-specific code.
- Edge cases this plan doesn't name: follow RFC 5545's recurrence defaults
  where one applies. Write each choice in the README's "Edge cases" section
  with a test.

## Review And Finish Line

Codex reviews it as code until it gives a 👍 (AGENTS.md "Gemini reviews":
GrokBot builds, Codex reviews). GrokBot fixes every P1 and P2 or explains in
the pull request why one doesn't apply. The coordinator checks it against
this plan, posts the check as a comment, gives the owner a short try-it note,
and switches on auto-merge once the plan check passes. Done when the tests
pass with one command, Codex has no open P1 or P2 on the latest commit (or
the Codex triage judge passes it, [codex-triage.md](codex-triage.md)), and
the plan check finds nothing missing.
