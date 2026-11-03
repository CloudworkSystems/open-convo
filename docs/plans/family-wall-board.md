# Family Wall Board Page (PRD)

Status: Draft (Nov 3): waiting on the owner's yes in the Claude thread "Draft next plans for outside builders".

Written November 3, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261103-wall-board`. Umbrella: Family (with Home). First slice of the
**homemade family wall display** in [PLAN.md](../../PLAN.md), Top Five item 4
("later shown on a homemade family wall display ... that syncs locally"; the
wall display stays with the Family umbrella). **Builder:** GrokBot team B,
under AGENTS.md "Outside Builders", through Cursor and signed in as
`cloudwork-bot`. **Reviewers:** Codex reviews every push; the coordinator
checks the result against this plan. **Finish line:** the package merges with
`tests` passing, and its command, run on the invented sample family in the
package, writes one page that opens in a browser with no network and shows
the family's day, and the owner trial below passes.

## Why

The owner wants one screen on the wall that shows the family's day: who has
what on, what's on the shared lists, which chores and habits are still open.
The engines that work those facts out already exist and are tested: calendar
merge, today agenda, household lists, tasks and the habit grid. What's
missing is the page itself. A wall page has its own rules (readable across a
room, nothing private by accident, no scrolling, stale data shown as stale),
and those are layout rules, not judgement, so they belong in a small tested
library before any screen hardware or Home Assistant work starts.

## Plan Of Record

1. **Now (this slice):** a library that turns one board file (each family
   member's agenda for the day plus shared lists) into one self-contained
   HTML page sized for a wall screen, and a command that writes that page.
2. **Later, separate plans:** reading the engines' output directly from
   True Convo's protected storage, refreshing on a schedule, showing it on a
   real screen (likely through Home Assistant, PLAN.md "Umbrellas"), and
   sync between devices.

## What It Does

`packages/wall-board/`, plain JavaScript, no dependencies. The library
function `renderBoard(board)` takes data and returns `{ html, counts,
warnings }`. It reads no clock and no files: the caller passes the board,
including `now`.

### The Board File

`schemaVersion` is `1`. At most 2,097,152 bytes.

```json
{
  "schemaVersion": 1,
  "title": "The Maple family",
  "date": "2026-11-03",
  "timeZone": "America/New_York",
  "now": "2026-11-03T07:30:00-05:00",
  "generatedAt": "2026-11-03T07:25:00-05:00",
  "layout": { "size": "1080p", "theme": "light" },
  "people": [
    {
      "id": "sam",
      "name": "Sam",
      "color": "teal",
      "agenda": { "...": "one today-agenda output object, unchanged" }
    }
  ],
  "lists": [
    { "id": "groceries", "name": "Groceries", "items": ["Milk", "Apples"], "more": 4 }
  ],
  "private": ["calendar:Doctor"]
}
```

- `people`: 1 to 8. Each `agenda` is exactly the object `buildAgenda`
  returns in `packages/today-agenda/` (its JSON output). The board reads only
  the agenda's `timeline` (all-day and timed events), `clashes`, `tasks` and
  `habits`; it never re-works times or clashes.
- `color`: one of 8 named colors the library defines, each with a matching
  dark-theme value and at least 4.5:1 contrast with its text. Two people may
  not share a color.
- `lists`: 0 to 6 shared lists, each up to 12 shown items plus a `more`
  count, as the caller (later, the household lists engine) prepares them.
- `private`: optional rules that hide an event's title on the wall. A rule
  is `calendar:<name>` (every event from that calendar) or `key:<event key>`.
  A hidden event shows as "Busy" in its person's color, at its time, with no location. The
  agenda has no privacy field of its own, so these rules are the only way
  to hide a title.
- **Tasks and habits are hidden unless shared.** Each person has an
  optional `show` list naming the task lists (`list:<task list name>`),
  single tasks (`task:<id>`) and single habits (`habit:<id>`) that may
  appear on the wall. Everything else from that person's `tasks` and
  `habits` is left off by default: the column shows only a count, such as
  "2 more tasks" and "1 more habit", with no titles. A task with no `list`
  can be shown only by its own `task:` rule. A `show` rule naming nothing
  in the agenda is refused, so a typo can't be mistaken for privacy.
- `layout.size`: `1080p` (1920 by 1080) or `4k` (3840 by 2160), landscape.
  `layout.theme`: `light` or `dark`.
- `generatedAt`: when the caller collected the facts. Required.

Unknown fields, missing required fields, repeated ids, bad dates or zones,
and an agenda whose `date` or `timeZone` differs from the board's are
refused. A refusal produces no page and one plain message that names the
section and, for a list, the 1-based item.

### The Page

- One HTML file with inline CSS only: no scripts, no outside fonts, images,
  links or URLs of any kind, no `<meta http-equiv="refresh">`. It renders
  the same with the network off.
- A header with the title, the date written out ("Tuesday, November 3") and
  "Updated 7:25 AM".
- One column per person, in board order, each with their name and color:
  all-day events first, then timed events in order, clashes marked, then
  shared open tasks due today or overdue (at most 5, then "and 3 more"),
  then shared open habits, then the count of unshared ones.
- A lists strip along the bottom.
- **Fits without scrolling.** Text sizes are fixed per `size`, and the
  library cuts content to fit: each column shows at most a set number of
  lines, then "and N more". It never shrinks text below the size's minimum.
  `counts` reports what was shown and what was cut.
- **Stale is visible.** If `now` is more than 30 minutes after
  `generatedAt`, the header says "Not updated since 7:25 AM" in a warning
  style, and `warnings` says so. If `now` is on a later date than `date`,
  the page shows "This is yesterday's board" across the top.
- **Empty is calm.** A person with nothing today shows "Nothing on today".
  A board with no lists leaves the strip out.
- Every value is HTML-escaped. Control characters are written out. Long
  words wrap and never push a column wider.

### The Command

`node packages/wall-board/src/board.mjs --board <board.json> --out
<page.html> [--force]` writes the page and prints the counts and warnings.
It refuses to overwrite an existing file unless `--force` is given, writes
through a temporary file and a rename, and creates a new file with mode
`0600`. `--json` prints `{ counts, warnings }` instead. A refusal prints one
message on standard error and writes nothing.

## When It Goes Wrong

This page is a screen the owner's family sees, so it answers the five
questions in [when-it-goes-wrong.md](when-it-goes-wrong.md):

1. **No connection.** Doesn't apply to this slice: the page needs no
   network, and the command reads one local file.
2. **Interrupted.** The command writes a temporary file and renames it, so
   an interrupted run leaves the old page whole and no half-written page.
3. **Empty or first run.** "Nothing on today" per person, and no lists
   strip without lists. The sample board in the package is the first thing
   to try, named in the README.
4. **Denied or stuck.** Doesn't apply: there's no prompt or permission.
5. **The error message.** A refusal names the section and item and what's
   wrong, for example "people, item 2: the color teal is already used by
   Sam". A stale board says so in plain words on the page itself.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/wall-board/` (Node's built-in runner, invented data
only):

1. The sample family board renders to the expected page byte for byte
   (`tests/expected/sample.html`), and the expected page contains no `http`,
   `src=`, `<script`, `url(` or `@import`.
2. A hidden calendar and a `key:` rule show "Busy" with no title or location anywhere in
   the page, including attributes and comments. A person with no `show`
   list has no task title or habit name anywhere in the page, only the
   counts; `list:`, `task:` and `habit:` rules show exactly what they name;
   a `show` rule naming nothing is refused.
3. Overflow: a person with 40 events and 30 tasks gets cut with "and N
   more", and `counts` matches. The same board at `4k` shows more lines.
4. Stale: `now` 31 minutes after `generatedAt` shows the warning; 30
   minutes doesn't. A next-day `now` shows the yesterday banner.
5. Escaping: titles with `<script>`, `&`, quotes, a newline and an escape
   sequence come out escaped or written out.
6. Each refusal in "The Board File" gives its message and no page.
7. The 8 colors meet 4.5:1 contrast in both themes (computed in the test).
8. The library never imports `fs`, `child_process` or a network module and
   never reads the clock (a test checks the source).
9. The command refuses to overwrite without `--force`, and a write is a
   temporary file plus rename.

**Owner trial checks** (the owner, or an agent on his Mac for him, runs
the command on the invented sample boards the README names, and he looks at
each page): the sample page opens with Wi-Fi off and shows the family's
day; a board with nobody busy shows "Nothing on today" and no lists strip;
a person with no `show` list shows only task and habit counts, no names;
a board 31 minutes old shows "Not updated since ..." in the warning style,
and a next-day board shows "This is yesterday's board"; a hidden calendar
shows "Busy" with no title or place; a board with a repeated color prints
the plain message naming the section and item and writes no page; running
again without `--force` leaves the old page as it was; stopping a run
part-way (Control-C on a large sample) leaves the old page whole. He
confirms each message and warning reads clearly from across a room where
it's on the page.

## Out Of Scope For This Slice

Reading engine output from storage, any schedule or refresh, Home
Assistant, a real screen, touch or interaction, photos, weather, sync,
notifications, and editing anything from the wall.

## Rules For The Builder (GrokBot Team B)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, through Cursor, on the branch
  `OC-261103-wall-board`, signed in as `cloudwork-bot`. Open a pull request
  into `main` with auto-merge off and the label `agent: grokbot`. Never push
  to `main` directly, and never switch on auto-merge.
- Mark the work as AGENTS.md "Accounts And Provenance" says: `Cursor Agent`
  as commit author, and `— GrokBot team B, OC-261103-wall-board` as the last
  line of the pull request description and every comment.
- Run **no commands on the owner's Mac** for this job.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented data only: an invented family, with no real names.
- Change files only under `packages/wall-board/`. Nothing else, not even
  `STATUS.md` (the coordinator updates it). You may import
  `packages/today-agenda/` through its public API by relative path, in
  tests only, to make the sample agendas; if it lacks something, stop and
  report instead of changing it.
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network calls, no AI, no paid services, no `child_process`, no clock,
  in the code or the tests. No `fs` in the library; the command may read its
  one input file and write its one output file.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the library, the command, the tests, a sample board
  and a short README with the board file, the page rules and the command.
  Finishable in one to two days.
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
