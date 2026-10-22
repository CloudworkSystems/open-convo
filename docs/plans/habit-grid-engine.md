# Habit Grid Engine (PRD)

Status: In progress (Oct 21): build in review (#74).

Written October 16, 2026 by the planning session from the owner's decisions
(all recommendations accepted). Session name: `OC-261016-habit-grid-engine`.
Umbrella: Personal (also a wall-hub tile). Built by an outside builder under
AGENTS.md "Outside Builders" (up to three outside modules at a time since
October 21, 2026). It started after Site Engine and merged as #74 on
October 21, so it no longer counts toward the three.

## Why

The owner wants build-your-own habit and productivity trackers in the
contribution-grid style (seven rows for the days of the week, weeks running
across), with the kind of flexible settings he likes in the iOS app Habit
Stack. We study what makes good tracker settings and build our own design; we
don't copy any app's look or code. The rule from the foundations: it shows,
it never grades.

## Plan Of Record

1. **Now:** the engine on its own, tested on invented data. No app code, no
   storage code, no AI.
2. **Later:** real use after step 5 (the Personal space), on the Mac, the
   iPhone and the wall hub. Logging by voice (step 3) and automatic logging
   from other sources (for example a phone's step count, or the home hub) are
   later; the engine leaves room for them but builds neither.

## What It Does

A small library in `packages/habit-grid/`:

- **Trackers**, each with a name, a color and one of three kinds:
  - **Done / not done** (took vitamins).
  - **Count** (glasses of water), with an optional daily target. Without a
    target, any count above zero makes the day "done", and the shade steps
    show how that day compares with the tracker's own amounts in the range
    shown (quarters of its highest day); there is no "full" level.
  - **Amount toward a target** (30 minutes of exercise), with a unit.
- **How often:** daily; a number of times per week ("3 times a week"); or
  chosen days of the week. Days a tracker isn't due, and days the owner marks
  as rest, show as rest, never as misses.
  - **Daily and chosen-days trackers** work day by day: each due day is met
    or not met once it has passed.
  - **Times-per-week trackers** work week by week. No single day is due: a
    day with a check-in shows as done, other days show as open (neither rest
    nor miss). The week is met when its total reaches the target; the current
    week shows "in progress" until it ends, never "missed" early. Their
    streaks count weeks, not days.
- **Stacks:** trackers grouped into a named set ("morning stack: water,
  vitamins, stretch") that can be checked off together or one by one.
  Checking a whole stack marks its done/not-done members done. For count and
  amount members the engine never invents a value: it writes the member's
  "usual amount" only if the user has set one, and otherwise lists that member
  as needing a value and writes nothing for it.
- **Check-ins:** each entry is its own record with a permanent ID, a date, a
  value, and where it came from
  (`manual` now; `voice` and `automatic` reserved for later). A day's value
  is the sum of that day's check-in records, so two people logging water on
  the same day both count. Entries can be edited and removed; removal is
  reversible until Trash is emptied.
- **The grid:** for any tracker or stack, a grid of days (rows by weekday,
  columns by week). Each square's shade shows how close that day came to the
  target: empty, partial steps, full. Rest days have their own look.
- **Week start:** Sunday or Monday, chosen by the user (Sunday by default).
- **Range:** the caller asks for a span; defaults are about six months for the
  Mac and wall, about three months for the phone.
- **Streaks, shown plainly:** current and longest streak, counting only due
  days, so rest days don't break a streak. No guilt messages, no "you broke
  your streak", no badges or scores anywhere in the engine's output.

## Output

The engine returns plain data describing the grid (each square's date, state
and shade level) and can also render it as a self-contained SVG, so any
surface can draw it. Colors come from the tracker; the default palette uses
the Ember tokens in `brand/`. Rendering must meet WCAG AA contrast and must
not rely on color alone (rest and full days are also distinguishable by
shape or pattern).

## Built For Sync Later

The same rules as the household lists engine
([household-lists-engine.md](household-lists-engine.md)): permanent IDs,
version stamps with a device-ID tie-breaker, field-level merge, and permanent
deletion markers, so the phone, Mac and wall hub can later merge cleanly. No
network code in this slice. Check-ins merge as a set of records by ID (never
as a single "day total" field), so the same record arriving twice counts once
and two devices' separate check-ins both survive.

## Data Format

One JSON file per person's trackers, with a `schemaVersion`, documented in the
package README.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/habit-grid`, Node's built-in test runner, invented
people only. At least:

1. Each tracker kind records and shades correctly (none, partial, full), and
   a count tracker without a target shades by quarters with no "full" level.
2. Chosen days mark non-due days as rest, not misses. A "3 times a week"
   tracker shows checked days as done and others as open, meets the week at
   three, shows the current week as in progress, and counts its streak in
   weeks.
3. Rest days never break a streak; a missed due day ends it; current and
   longest streaks are right across month and year boundaries.
4. Week start on Sunday and on Monday both lay out the grid correctly,
   including a daylight-saving change and a leap day.
5. Stacks: checking a stack marks done/not-done members done, writes a usual
   amount only where one is set, and lists other count or amount members as
   needing a value; members can still be checked alone.
6. Editing and removing check-ins, Trash and restore.
7. Output contains no grading words (a test scans for words such as "failed",
   "broke", "score" in any text the engine produces).
8. The SVG passes contrast checks and marks rest and full days with more than
   color.
9. Merge: the same cases as the household lists engine (different trackers,
   same field, delete vs edit, equal timestamps, clock skew, offline copy
   after Trash is emptied), and merging A into B equals B into A. Also: two
   devices log the same water tracker on the same day and both entries count;
   merging the same file twice doesn't double-count.
10. Saving and loading round-trips exactly; an unknown `schemaVersion` is
    refused with a plain message.

## Out Of Scope For This Slice

App screens, phone, wall hub, network or iCloud, Mac app or Desk code,
storage or encryption code, AI, voice, automatic logging, reminders or
notifications, real personal data.

## Rules For The Builder

Same as the Site Engine and household lists plans: own branch named after the
session, a pull request into `main`, never push to `main`; no commands on the
owner's Mac; no keys, accounts or private files; invented data only; files only
under `packages/habit-grid/` plus one line in `STATUS.md`; no new dependencies
unless unavoidable (listed with license); no repo license file.

## Review And Finish Line

A different agent reviews it as code until Codex gives a 👍; the planning
session or the PR steward checks it against this document and gives the owner a short try-it
note, then switches on auto-merge, and the merge gate merges it. Done when the tests pass with one command, Codex has
given a 👍, and the planning check finds nothing missing.
