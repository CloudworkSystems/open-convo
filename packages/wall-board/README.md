# Wall board

One board file in, one wall page out. The page is a single HTML file with the CSS inside it. It does not use the network, a script, a font file or the clock. Node 22 or later.

```sh
cd packages/wall-board
npm test
```

The command, from the repo root:

```sh
node packages/wall-board/src/board.mjs --board <board.json> --out <page.html> [--force] [--json]
```

`--json` still writes the page. Standard output is then `{ "counts", "warnings" }` instead of the plain counts. A refusal prints one message on standard error and writes nothing.

The command will not replace an existing page unless `--force` is given. It writes a temporary file in the same folder, then renames it into place, and creates a new file with mode `0600`. Stopping a run part-way leaves the old page whole. A dot-tmp file can remain only if the process is killed before that cleanup runs.

## Try the invented boards

From the repo root:

```sh
node packages/wall-board/src/board.mjs --board packages/wall-board/samples/maple.json --out /tmp/maple.html
node packages/wall-board/src/board.mjs --board packages/wall-board/samples/empty.json --out /tmp/empty.html
node packages/wall-board/src/board.mjs --board packages/wall-board/samples/counts-only.json --out /tmp/counts.html
node packages/wall-board/src/board.mjs --board packages/wall-board/samples/stale.json --out /tmp/stale.html
node packages/wall-board/src/board.mjs --board packages/wall-board/samples/yesterday.json --out /tmp/yesterday.html
node packages/wall-board/src/board.mjs --board packages/wall-board/samples/busy.json --out /tmp/busy.html
node packages/wall-board/src/board.mjs --board packages/wall-board/samples/repeated-color.json --out /tmp/refused.html
```

Open a page with the network off. `maple.json` is the Maple family's day. `empty.json` says "Nothing on today" and has no lists strip. `counts-only.json` has task and habit counts and no titles. `stale.json` says "Not updated since ...". `yesterday.json` says "This is yesterday's board". `busy.json` shows "Busy" for an event whose calendar was not shared. `repeated-color.json` prints a message naming the person and writes no page. Run the maple command again without `--force` and the first page stays as it was.

These names are invented.

## Board file

`schemaVersion` is `1`. The file is at most 2,097,152 bytes.

`renderBoard(board)` returns `{ html, counts, warnings }`. It reads no clock and no files. The caller passes `now`.

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
      "calendars": ["cal-family", "cal-school"],
      "sources": {
        "calendars": [
          { "id": "cal-family", "name": "Family" },
          { "id": "cal-school", "name": "School" }
        ],
        "taskLists": []
      },
      "agenda": { "...": "one today-agenda output object, unchanged" }
    }
  ],
  "lists": [
    { "id": "groceries", "name": "Groceries", "items": ["Milk", "Apples"], "more": 4 }
  ],
  "private": ["key:dentist|2026-11-03T14:00:00Z"]
}
```

The full invented day is `samples/maple.json`.

- `people`: 1 to 8. Each `agenda` is the object `buildAgenda` returns. This package reads the agenda's `timeline`, `clashes`, `tasks` and `habits`. It does not work out times or clashes again.
- `color`: `teal`, `coral`, `gold`, `blue`, `green`, `plum`, `rust` or `slate`. Two people may not share one. Each color has a light-theme fill and a dark-theme fill, and the text on that fill clears 4.5:1.
- `lists`: 0 to 6. Each list has up to 12 items and a `more` count. The caller prepares them.
- `sources.calendars` and `sources.taskLists` are `{ "id", "name" }` pairs. `id` is the host's permanent id. `name` is the name the agenda shows today. Names are never matched. Every calendar name on the timeline, and every task list name, must appear once in `sources`, or the board is refused. Two sources with the same name are refused.
- `calendars` lists source ids whose event titles may appear. Any other id shows as "Busy" at that event's time, with no title and no place. A typo in an id is refused, because the id is not in `sources`. A renamed calendar stays shared only when its id is still listed.
- `private`: optional `key:<event key>` rules. A matching event is shown as "Busy" the same way, even on a shared calendar. A key that matches nothing today is kept and listed in `warnings`.
- `show`: optional. `list:<task list id>`, `task:<id>` and `habit:<id>`. Without `show`, no task title or habit name is shown, only a count such as "2 more tasks". A task with no list is shown only by its own `task:` rule. A rule that names nothing on this day is refused. An empty `show` list hides every title.
- `layout.size`: `1080p` (1920 by 1080) or `4k` (3840 by 2160). `layout.theme`: `light` or `dark`.
- `generatedAt` is when the facts were collected.

Unknown fields, missing required fields, repeated ids, bad dates or zones, and an agenda whose `date` or `timeZone` string differs from the board are refused. The message names the section and, for a list, the 1-based item. A refusal produces no page.

## Page

- One HTML file. The CSS is in the file. No scripts, no outside fonts, images, links or addresses, and no refresh.
- The header has the title, the date ("Tuesday, November 3") and "Updated 7:25 AM".
- One column per person, in board order. All-day events, then timed events in the agenda's order. The time is one line. Overlaps, Tentative and Cancelled sit at the start of the title line, or on their own line when they do not fit beside the title, so a wrap cannot cover them. A task name is its own line, above the due label. Then shared habits, then the count of the ones left off.
- A lists strip along the bottom. No lists, no strip.
- Text sizes stay fixed for the size. One column budget covers the heading, the entries, every "and N more" line and the hidden counts, after the header and the lists strip have taken their height. Events are kept first, then tasks, then habits. What does not fit is left off and counted. 4k type is larger than 1080p type and smaller than twice that size, so 4k shows more. Each entry is at most two lines tall, and a long word wraps inside the column.
- If `now` is more than 30 minutes after `generatedAt`, the header says "Not updated since 7:25 AM" and `warnings` says so. Thirty minutes on the dot does not. If `now` falls on a later civil date than `date`, in the board's time zone, the page says "This is yesterday's board".
- A person with no events, tasks or habits shows "Nothing on today".
- Values are escaped. Control characters and bidirectional marks are written out.

## Counts

`counts.people` has, for each person, `eventsShown`, `eventsCut`, `busyShown`, `tasksShown`, `tasksCut`, `tasksHidden`, `habitsShown`, `habitsCut` and `habitsHidden`. `busyShown` counts Busy lines on the page, not Busy events that were cut. `tasksHidden` and `habitsHidden` are the ones left off by `show`, not the ones cut for space. `listsShown` is the number of lists. `listItemsShown` is the chips on the page. `listItemsMore` is the caller's `more` plus any chips the page had to leave off.

## Edge cases

These are the choices the plan does not spell out. Each one has a test.

- Sharing uses source ids only. A calendar that was shared as "Work", then renamed to "Office", stays shared by its id. A private calendar that later takes the name "Work" stays "Busy". The same rule is used for task lists. "Work" and "work" are different names. Names are not trimmed.
- An id in `calendars` that is not in `sources` is refused. An id that is in `sources` but has no event today is allowed, so a quiet shared calendar is not a typo.
- A `key:` rule hides every event with that key, on every person. The key is the text after the first `key:`. A repeated key, or `key:` with nothing after it, is refused. A key with no event today is a warning, not a refusal.
- A missing `show` and `"show": []` both hide every task and habit title. A task named by both `list:` and `task:` is shown once. Tasks stay in the agenda's order.
- The page does not print a task's list name. The title is the shared fact.
- All-day events are drawn before timed events. Within each group the agenda's order is kept, even when that order is not chronological. Clashes are not worked out again. A clash on a Busy event says "Overlaps" and does not name the other event.
- A timeline entry whose status is `cancelled` is shown with the word "Cancelled". `buildAgenda` leaves cancelled events out, so a normal agenda has none. Tentative events say "Tentative". High-priority tasks say "High".
- "Nothing on today" is only for a person whose agenda has no events, tasks or habits. Hidden tasks still show a count.
- The yesterday sentence is used for any later civil date, including one more than a day away. An earlier `now` does not show it. The civil date is the board's time zone, not the offset written on the instant. Elapsed time for the stale warning is absolute milliseconds. `now` before `generatedAt` is not stale.
- The header clock is 12-hour, in the board's time zone. Seconds are shown when the stamp is not a whole minute, and a fraction is shown when there is one. Event times use the agenda's local text, in 12-hour form. A timed event that starts or ends on another date includes that month and day. The header date does not include the year.
- The page is English (`Tuesday, November 3`), so the machine's locale cannot change the wording.
- List items are shown in the caller's order, as chips. `more` of 0 does not add a line when every chip fits. A list with no items still shows its name. The strip keeps the chips that fit in the height left after the header and a minimum column. Chips that do not fit are left off, added to `more`, and reported in `listItemsMore`. A chip is at most two lines tall.
- The column budget charges a task as two lines and an event as two lines, or three when its marks need their own line. A habit is the lines its name needs (at most two). Each "and N more" or hidden-count line is the lines that text needs. Hidden counts are reserved first. A section that fits completely does not keep a spare "and N more" line. When a section is cut and none of its rows fit, the line names them, such as "and 12 more tasks". With no lists, the page grid has two rows and one gap. A lists strip is a third row and a second gap. The page box is exactly 1920 by 1080, or 3840 by 2160. Type is not shrunk when more people are added. A character is counted as one em, which is wider than the fallback sans, so the budget does not under-count a line.
- Text is escaped after controls are written out. A backslash is doubled, line breaks become `\n`, tabs become `\t`, and other controls and bidirectional marks become `\uXXXX`. The same treatment is used for the title, names, events, tasks, habits and list items.
- The library does not mutate the board. The same board returns the same page bytes. Nothing in the library or the command reads the clock.
- Duplicate keys inside one JSON object follow `JSON.parse` (the last one wins) before the repeated-id check.
- A board whose `JSON.stringify` text is over 2 MB is refused. The command also refuses a file over 2 MB before parsing it.
- The command resolves the output path, refuses a folder, and refuses a missing folder. `--force` replaces a file. It does not create folders.
