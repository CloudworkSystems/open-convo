# Revisit Reminders Engine (PRD)

Status: Approved (Nov 2): the owner picked "Yes, both" on the card "Approve both GrokBot plans so teams A and B start?" in the Claude thread "Draft next plans for outside builders". GrokBot team B builds it.

Written November 1, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261101-revisit-reminders`. Umbrella: Personal. First slice of
**Navigator step 7** in [PLAN.md](../../PLAN.md) ("Related and Revisit-when
reminders"), the Desk roadmap card "Bring back Related and Revisit when":
"set a visible reminder to return to [an older session]", with the checks
"Revisit reminders survive a restart and can be edited or removed." The
owner picked this module for **GrokBot team B** on November 1 (card "Give
GrokBot teams A and B these next modules?", option "Yes, both").
**Builder:** GrokBot team B, under AGENTS.md "Outside Builders", through
Cursor and signed in as `cloudwork-bot`. **Reviewers:** Codex reviews every
push; the coordinator checks the result against this plan. **Finish line:**
the package merges with `tests` passing, and its command, run on the
invented sample in the package with a given date, prints what's due, what's
coming up and what was refused.

## Why

A reminder to come back to something is small but easy to get wrong:
dates across time zones and month ends, a "remind me in 3 days" that
drifts, a reminder whose item was deleted, a list that silently loses
entries after a restart. Those are rules, not judgement, so they belong in
one tested library that the Desk (and later the iPhone app) uses, built
before the Navigator view exists.

## Plan Of Record

1. **Now (this slice):** the reminder rules as a library with a command.
   A reminder list and a date in; what's due, what's next, and a new list
   after an add, edit, snooze, done or remove out. Plus a strict reader and
   writer for the saved list, so a restart loses nothing.
2. **Later, separate plans:** storing the list in True Convo's protected
   storage, the Desk's reminder view and notifications, and "Related"
   lookups.

## What It Does

`packages/revisit-reminders/`, plain JavaScript, no dependencies. Every
function takes data and returns new data. Nothing reads the clock: the
caller passes `today` as a `YYYY-MM-DD` date in the person's own time zone.
Reminders are by day, never by hour, so time zones don't move them.

### A Reminder

`{ id, itemId, itemKind, title, when, note, createdOn, snoozedUntil,
doneOn }`

- `id`: a string the caller makes (1 to 64 characters, letters, digits,
  `-` and `_`). Ids are unique in a list.
- `itemId`, `itemKind`: what to come back to. `itemKind` is `session`,
  `note`, `link` or `other`. The engine never looks the item up.
- `title`: up to 200 characters, one line. `note`: optional, up to 2,000.
- `when`: one of
  - `{ on: "YYYY-MM-DD" }` (a set day), or
  - `{ afterDays: n, from: "YYYY-MM-DD" }` (n from 1 to 3,650; due on
    `from` plus n days, counted on the calendar, so month ends and leap
    years are right).
- `createdOn`: a date. `snoozedUntil`: optional date. `doneOn`: optional
  date; a done reminder is never due again.

### Rules

1. **Due date.** `dueOn` is `when.on`, or `from` plus `afterDays`. If
   `snoozedUntil` is later, it wins.
2. **Due today.** Not done and `dueOn` on or before `today`. A reminder
   that was due earlier and wasn't handled stays due (it shows as overdue
   with its number of days), never silently dropped.
3. **Coming up.** Not done, `dueOn` after `today` and within `days`
   (default 14).
4. **Snooze** sets `snoozedUntil` to a later date, or to `today` plus a
   number of days. Snoozing to a date on or before `today` is refused.
5. **Done** sets `doneOn` to `today`. **Remove** takes it out of the list.
   **Edit** replaces `title`, `note` or `when` and re-checks the reminder.
   Each refers to a reminder by `id`; an unknown id is refused.
6. **Add** refuses a duplicate `id`, and returns a warning (not a refusal)
   when another open reminder already points to the same `itemId` with the
   same due date.
7. **Missing items.** `listView(reminders, { today, days, knownItems })`
   takes an optional list of `itemId`s the caller knows still exist; an open
   reminder whose item isn't in it is listed under `missingItem`, never
   deleted by the engine.

### Functions And Output

- `listView(reminders, options)` returns `{ overdue, dueToday, comingUp,
  missingItem, done, counts }`, each a list sorted by due date, then
  title, then id.
- `addReminder`, `editReminder`, `snoozeReminder`, `markDone`,
  `removeReminder`: each returns `{ reminders, warnings }` or throws an
  error that names the field. They never change the list passed in.
- `parseSaved(text)` and `formatSaved(reminders)`: the saved form is JSON
  with a `version: 1` field and the list. `parseSaved` checks every field
  and refuses the whole file on any error, naming the reminder and the
  field, so a bad file is never half-read. `formatSaved` sorts by id, so
  the same list always gives the same text, and `parseSaved(formatSaved(x))`
  gives back `x`.

### Refusals

A function refuses (an error naming the field, nothing returned) when a
required field is missing, a value is the wrong type, a date isn't a real
calendar day in `YYYY-MM-DD` form, `afterDays` is outside 1 to 3,650, a
text field is too long or holds a control character (a tab inside `note` is
allowed, a newline too), `itemKind` is outside its list, or an id repeats.

### The Command

`node packages/revisit-reminders/src/revisit.mjs --file <reminders.json>
--today YYYY-MM-DD [--days N] [--json]` reads one saved file and prints the
list view (or its JSON). It writes nothing. `--today` is required, so the
command never reads the clock.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/revisit-reminders`, Node's built-in test runner,
invented reminders only (for example "Come back to the garden plan
session"). At least:

1. Due dates: a set day, `afterDays` across a month end, across February
   in a leap year and a normal year, and a snooze that wins.
2. Overdue, due today, coming up inside and outside the window, and done.
3. Snooze to a later date, snooze by days, and a refused snooze to today.
4. Add with a duplicate id (refused) and with the same item and day
   (warning). Edit, done and remove by id; unknown ids refused.
5. `missingItem` lists a reminder whose item is gone and deletes nothing.
6. The input list is unchanged after every function (frozen in the test).
7. Saved form: a round trip gives the same list; a file with one bad
   field is refused as a whole and the error names the reminder and field;
   an unknown `version` is refused.
8. Refusals: each one above names its field, including `2026-02-30`.
9. Determinism and no clock: shuffled input gives byte-identical output,
   and every function runs with `Date.now` and an argument-less `Date`
   stubbed to throw.
10. The command prints the view for the fixture with `--today`, refuses to
    run without it, and writes nothing.
11. The library imports no `fs`, network or `child_process` module, and
    the command no network or `child_process` module.

## Out Of Scope For This Slice

- Where the list is stored, the Desk view, notifications and sounds.
- Repeating reminders, times of day, and shared or family reminders.
- "Related" lookups and Navigator search.
- Any AI suggestion of what or when to revisit.

## Rules For The Builder (GrokBot Team B)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, through Cursor, on the branch
  `OC-261101-revisit-reminders`, signed in as `cloudwork-bot`. Open a pull
  request into `main` with auto-merge off and the label `agent: grokbot`.
  Never push to `main` directly, and never switch on auto-merge.
- Mark the work as AGENTS.md "Accounts And Provenance" says: `Cursor Agent`
  as commit author, and `— GrokBot team B, OC-261101-revisit-reminders` as
  the last line of the pull request description and every comment.
- Run **no commands on the owner's Mac** for this job.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented data only.
- Change files only under `packages/revisit-reminders/`. Nothing else, not
  even `STATUS.md` (the coordinator updates it). Import nothing from
  `apps/` or another package.
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network calls, no AI, no paid services, no `child_process`, no clock,
  in the code or the tests. No `fs` in the library; the command may read
  its one input file.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the library, the command, the tests, a fixture and
  a short README with the reminder shape, the rules, the saved form and the
  command. Finishable in one to two days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Supported setups are macOS and the Linux CI runners on Node 22 (AGENTS.md
  "Review Guidelines"); don't add Windows-specific code.
- Edge cases this plan doesn't name: write each choice in the README's
  "Edge cases" section with a test.

## Review And Finish Line

Codex reviews it as code until it gives a 👍. GrokBot fixes every P1 and P2
or explains in the pull request why one doesn't apply. The coordinator
checks it against this plan, posts the check as a comment, and switches on
auto-merge once the plan check passes. Done when the tests pass with one
command, Codex has no open P1 or P2 on the latest commit (or the Codex
triage judge passes it, [codex-triage.md](codex-triage.md)), and the plan
check finds nothing missing.
