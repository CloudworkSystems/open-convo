# Calendar Through The Mac (PRD)

Status: Draft (Oct 30): the owner said yes to this piece on October 30, in the Claude thread "Plan an in-house connector layer for TCA"; this text still needs his yes.

Written October 30, 2026 by a Claude session (project "261024 OC
Steering", thread "Plan an in-house connector layer for TCA"). Session name:
`OC-261030-calendar-through-the-mac`. Umbrella: Personal. It is the first
slice of the connections layer
([docs/design-notes/connections-layer.md](../design-notes/connections-layer.md),
route 1, the Mac itself). **Builder:** a Claude building session, label
`agent: claude`. **Reviewers:** Codex on every commit, plus an independent
review by GrokBot, or by a fresh Claude review that didn't build it
(AGENTS.md "Independent reviews"). **Finish line:** the owner's trial below
passes in True Convo Test.

## Why

The owner keeps his life in Google Calendar and prefers Google's views,
especially the month view, to Apple Calendar's, above all on the iPhone. He
would rather have True Convo's own calendar view than either app's. A Mac
that has the Google account added under System Settings, Internet Accounts,
already gives other apps that account's calendars through Apple's calendar
framework (EventKit). So True Convo can read his Google calendars, and his
iCloud and others, for free, with no Google sign-in of ours and no Google
review, and then draw them its own way.

For places, he chose the cheap middle path (October 30): Apple's maps
framework works out travel time, and a place opens in Google Maps through a
plain link. Nothing is billed per use.

## Plan Of Record

1. **This plan:** read the calendars on the Mac, show them in True Convo's
   own month, week and day views in the Desk, add travel time between
   meetings, and open places in Google Maps. Reading only.
2. **Later, separate plans:** the iPhone (the same framework exists there,
   but it waits for the iPhone app), adding or changing events (not planned
   for launch, as in calendar-merge-engine.md), and mail.

## What It Does

### Reading the calendars (PR 1)

- A new module, `apps/mac/Sources/CalendarReader/`, asks for calendar
  access once. The app still supports macOS 13 (`apps/mac/Package.swift`),
  so it takes the path for each system. On macOS 14 and later it uses
  Apple's full-access request, because reading needs full access, with the
  `NSCalendarsFullAccessUsageDescription` text. On macOS 13 it uses the
  older calendar access request, with the `NSCalendarsUsageDescription`
  text. Both texts say what it's for: "True Convo shows your calendars in
  its own views. It only reads them, on this Mac. Meeting places are shared
  only if you turn on travel time (sent to Apple) or open a place in Google
  Maps." The two
  paths sit behind one interface, and the fake store tests both: granted,
  refused, and revoked later. CI's macOS runner builds with both
  availability branches compiled in.
- It lists the calendars the Mac knows (name, color, account type such as
  iCloud, Google, Exchange or On My Mac) and returns the event occurrences
  in a date range of up to 400 days. Apple's framework already expands
  repeating events and applies changed and cancelled occurrences, so this
  module doesn't repeat that work.
- Each occurrence carries only what the views need: a stable key, title,
  location text, calendar id, status, the original start of a repeating
  occurrence (none for a one-off event), and its time. A timed occurrence
  has a start and end (UTC and local, with the offset). An all-day
  occurrence has a start date and an end date, with the end date exclusive,
  and no clock times, as in calendar-merge-engine.md and the Today agenda,
  so it never shifts a day when the time zone changes. Tests cover an
  all-day event read in two time zones and a two-day all-day event. Notes,
  attendees, links and alarms are not read into True Convo.
- **The same meeting in two calendars shows once.** Occurrences are grouped
  with all the rules in calendar-merge-engine.md ("The Same Event In Two
  Calendars"), and the builder carries them over unchanged:
  - The same invitation identifier and the same occurrence count as one.
    "The same occurrence" means the same original start of the repeating
    occurrence (EventKit's occurrence date, which stays fixed when one
    occurrence is moved), or none for both in a one-off event. Tests cover
    a repeating meeting in two calendars with one occurrence moved.
  - With different identifiers, a match on title (ignoring case, accents and
    spaces at the ends) plus the exact start and end (or the same dates, for
    all-day events) also counts as one, provided the copies are from
    different calendars and have the same status.
  - The one-to-one grouping order, the choice of which copy is shown, and
    the rule that two copies from the same calendar never merge all stay
    the same.

  EventKit's external identifier stands in for `UID`.
- **Which copy wins, carried to the build** (Codex, PR #204 review thread
  4425672904). EventKit exposes no `SEQUENCE`, so the merge engine's order
  can't be carried over as is, and a last-modified date can't stand in for
  it: a copy with older details can be touched later (a color or alarm
  change), so "newest touch wins" would show stale details. The rule is:
  the copy from the organizer's own calendar wins when the Mac has it
  (EventKit marks the organizer as the current user); otherwise the copy
  from the earliest calendar in the person's list wins. Last-modified dates
  are never used to pick. Tests show an organizer copy beating a
  later-touched attendee copy, and the list order deciding when neither is
  the organizer's. Each group lists every
  calendar it came from. Tests repeat the merge engine's duplicate cases,
  "Dentist" included, against the fake store.
- The owner picks which calendars show, in the app. The choice is stored
  with his other Desk settings, inside the protected store.
- If access is refused, or later revoked in System Settings, the views say
  so plainly and offer the button that opens that settings page. Nothing
  else fails.
- Changes made in Google Calendar on the web show up when the Mac's own
  sync brings them in. The module listens for the framework's "store
  changed" notice and refreshes, with no polling loop of its own.

### True Convo's own views (PR 2)

- A calendar view in the Desk with month, week and day modes. The month view
  is the main one: every day shows its events in order with their calendar
  colors, all-day events sit on top, and a day with more than fits shows "+N
  more" and opens that day.
- It reads only through the native host bridge (a new message pair for
  "list calendars" and "occurrences in range"). Its tests use invented
  calendars, run in the Desk's existing test setup and need no Mac.
- The Today agenda (#147) gets its meetings from the same occurrences
  through a small adapter, so "what's my day?" and the views agree.

### Places and travel time (PR 3)

- **Open in Google Maps.** An event with location text shows a link that
  opens Google Maps' public search page for that text in the person's
  browser. It's a plain link the person clicks. True Convo itself sends
  nothing, and the link needs no key.
- **Calendar text is outside input.** Titles and locations come from
  whoever sent the invitation. The link is always built as Google Maps'
  fixed search address with the location text percent-encoded as the
  query, never pasted in as an address. Tests feed locations that look
  like web addresses, `javascript:` links, quotes, `&` and `#`, and check
  the link always points at the maps search page. Titles and locations are
  shown as plain text, never as markup or links, and nothing in them is
  ever acted on by True Convo or its agents (security.md checklist,
  item 6).
- **Travel time.** Between two timed meetings on the same day that both have
  a location, the views show the driving time, worked out with Apple's maps
  framework. This sends the two locations to Apple's maps service, so it is
  **off by default**. The person switches it on once, in settings that say
  exactly that. Only location text or coordinates and a departure time are
  sent: no titles, no attendees, no calendar names.
- **Turning a location into a place.** Directions need two map places, not
  text. The reader also passes on an event's structured location
  coordinates when the calendar has them (often the case when a place was
  picked from a map). Without coordinates, the location text is looked up
  with Apple's place search (`MKLocalSearch`), under the same opt-in and
  sending only that text. The search's first result is used only when it
  is a single clear match. When the search finds nothing, finds several
  equally likely places, or fails, the view shows "travel time unavailable"
  for that pair, and the Google Maps link still works. A looked-up place is
  kept for the day under the same rules as travel times (below).
  Directions then run between the two places (`MKDirections`). Tests cover
  coordinates, a clear match, no match, several matches and a failed search
  with a fake maps service.
- When the travel time is longer than the gap between the meetings, the day
  view marks the clash ("about 35 minutes' drive, 20 minutes free").
- Results are kept for the day so the same pair isn't asked twice. Looked-up
  places and travel times are held in memory only, or in the protected
  store, never in a plain file, cache folder or anything a backup copies
  unsealed. Turning travel time off clears them. Apple limits how often an app can ask. When that limit is reached,
  the view shows "travel time unavailable" and doesn't retry in a loop.

## Rules For The Builder

- **Read only.** No call that creates, changes or deletes an event,
  calendar or reminder. A test checks that the module's store access exposes
  no write method.
- **Nothing leaves the Mac,** except the travel-time request above, and only
  after the person turns it on. Calendar content never goes into logs,
  crash output or test output; logs name counts and calendar ids, never
  titles or places.
- **Invented data only** in tests and samples. EventKit is reached through a
  small interface, and the tests use a fake store. The real store is
  touched only in the owner's trial.
- **New outside hosts:** Apple's maps service (through the framework) and
  the Google Maps search link. Each is approved once by the owner
  (foundations, principle 6). The pull request that adds each one carries
  the risk hold, and the owner approves it on GitHub.
- **New Mac permission:** calendar access (full access on macOS 14 and later, the older access on macOS 13), with the usage texts above.
  It needs the owner's approval in PR 1 (security.md checklist, item 5).
- **Protected paths.** Wiring a new module into the app touches
  `apps/mac/Package.swift` and `apps/mac/Sources/VoiceCursorMac/main.swift`,
  which need the owner's approval on GitHub. Keep the change there to the
  wiring line. Everything else goes in the new module.
- **No new dependencies.** Apple's own frameworks only.
- **Mac builds and Mac test runs on the owner's Mac** go one at a time and
  only with his yes. CI's macOS runner is the normal place for Mac tests.

## Pull Requests

| PR | What | Needs the owner on GitHub |
|---|---|---|
| 1 | CalendarReader module, permission text, fake-store tests, wiring | Yes: Mac permission, protected wiring files |
| 2 | Desk calendar views (month, week, day), bridge messages, Today adapter | No, unless the bridge change touches a protected file |
| 3 | Open in Google Maps link, travel time (off by default), clash marks | Yes: the two outside hosts |
| 4 | Owner's trial checklist and its results | No |

STATUS.md gets a row for this plan in PR 1 and is updated as each part
merges.

## Owner's Trial (Finish Line)

In True Convo Test on the owner's Mac, with his Google account already
under Internet Accounts:

1. Grant calendar access when asked. The Desk lists his calendars, Google
   ones included, and he picks which show.
2. The month view for this month matches Google Calendar's month view on
   the web: same events, same days, same times, and no duplicates for an
   invitation that sits in two calendars.
3. Change an event in Google Calendar on the web. It appears changed in
   True Convo once the Mac has synced, with no restart.
4. Click a place on an event. Google Maps opens to that place in his
   browser.
5. Turn travel time on. Two meetings in different places on the same day
   show a driving time, and a too-short gap is marked.
6. Revoke calendar access in System Settings. True Convo says so and offers
   the settings button. Nothing crashes.

## Out Of Scope

The iPhone, editing events, reminders, mail, contacts, any Google sign-in of
our own or Google's APIs, paid maps services, and sharing calendars with the
family (step 11).
