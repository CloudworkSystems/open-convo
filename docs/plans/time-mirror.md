# Time Mirror: Observability Layer, Slice 1 (PRD)

Status: Draft (Oct 29): plan only; the code follows in a separate pull request.

Written October 29, 2026 by a Claude session (project "261024 OC Steering",
thread "Plan the observability layer") at the owner's request: he wants to
see where his computer time goes, tagged productive or not, as heat maps
like the habit grid, and to start using it soon, ahead of the core build
order. Umbrella: Personal. **Builder:** Claude (cloud, `cloudwork-bot`).
**Reviewers:** Codex, and GrokBot or a fresh Claude as the independent
review, which also answers the risk-review checklist
([risk-review.md](risk-review.md)). **Finish line:** the package merges with
`tests` passing, and the owner runs it once on his Mac and opens a page
showing his own time as heat maps (Gate 0 below).

## Why

The owner already pays for RescueTime, which watches the apps and sites he
uses and lets him mark each one productive or distracting. It holds months of
history, but its picture lives on RescueTime's site, apart from the habit
grids he keeps for everything else. He wants one honest mirror.

This is the first, smallest piece of what the True Convo plans called the
observability layer. The careful wording written then still holds and this
plan carries it over (sources: the frozen `cloudwork_systems` plans of July
31, 2026, "Productivity Steward candidate contract" and "Productivity
dashboards v1 build shape", and the July 23 research on RescueTime-like
trackers):

- **A mirror, not a judge.** It shows where time went. No grades, scores,
  streak pressure, nudges, or comments on rest, energy or sleep. It never
  calls one number "productivity".
- **Strictest privacy scope.** Activity data is private and sensitive. It
  stays on the Mac (apart from what already lives in RescueTime's cloud
  because of the owner's own subscription) and is not given to any agent,
  model, memory or other module unless he says so, each time.
- **Read-only.** The tool reads activity data. It never installs, turns on
  or changes capture software, and never adds a source without his separate
  approval for that source.
- **Narrow collection.** Daily totals, not site names, window titles, URLs,
  screenshots or typed text.
- **Gaps are gaps.** A day with no data shows as no data, never as zero and
  never filled in.
- **Not the learner.** Learning from his behavior to change how agents work
  is a later, separately approved idea (the "Observation Steward"), not this.

## Fastest Route: Read RescueTime, Don't Build A Watcher Yet

Building our own watcher means new Mac permissions (Accessibility, browser
automation), a background service and an empty history. Reading RescueTime
needs none of those and comes with his history. So slice 1 reads RescueTime's
Analytic Data API and draws the grids locally. Our own on-device watcher is
slice 2 (below), which also ends the dependence on RescueTime's cloud.

The tool asks RescueTime only for **daily totals by productivity level** and
**daily totals by category** (RescueTime's own fixed categories, such as
"Software Development"). It never asks for per-site or per-app rows, so site
and app names never reach the Mac through this tool at all.

## What It Does

Two parts, both Node 22 ESM with no dependencies, so the package follows
[packages/AGENTS.md](../../packages/AGENTS.md) (no package reads the
Keychain or real personal data, or writes to disk):

- **`packages/time-mirror/`, a pure library.** It builds the request
  parameters (never the key), turns RescueTime rows into habit-grid trackers,
  and returns the HTML page as a string. It takes an injected `fetchRows`
  function and never touches the network, the Keychain or the disk. All of
  its tests use invented rows.
- **`scripts/time-mirror.mjs`, the command the owner runs on his Mac.** It is
  the only part that reads the Keychain, calls RescueTime and writes the page.
  It stays small, so nearly all of the logic is tested in the library. Its own
  tests (`scripts/time-mirror.test.mjs`) cover the key and error handling
  with an invented key and a fake fetch.

Steps 1, 2, 5 and 6 below are the command's. Steps 3 and 4, and building the
page in step 5, are the library's.

1. **Fetch.** `GET https://www.rescuetime.com/anapi/data` with
   `perspective=interval`, `resolution_time=day`, `format=json`, a date
   range, and `restrict_kind` of `productivity` or `category`. Nothing else
   is ever requested. The default range is the last 365 days, fetched a
   month at a time. This is the only network call, to that one host.
2. **Key.** The API key is read from the macOS Keychain (generic password,
   service `rescuetime-api-key`) with `security find-generic-password -w`
   and sent only to that host. It is never taken from a command-line
   argument, an environment variable or a file, and never printed, logged or
   written. RescueTime documents the Analytic Data API with the key in the
   `key=` query parameter (its `Authorization: Bearer` form is for OAuth
   apps), so the code pull request uses the query parameter unless Gate 0
   shows the header works. Either way, an error shows only the HTTP status
   and a fixed message: never the request URL with its query string, and
   never RescueTime's response body.
3. **Turn into tags.** Productivity levels map to three tags: **productive**
   (RescueTime's +1 and +2), **neutral** (0) and **distracting** (-1 and
   -2), plus **total**. An optional local file, `tags.json`, kept next to
   the output and never in the repo, maps RescueTime categories to the
   owner's own tags (for example "Software Development" to "coding").
   Categories he hasn't mapped are left out of the page. That matters
   because custom categories can carry names he chose (a client's name, for
   example): only the category names he maps ever get written, and only as
   his tag names.
4. **Draw.** Each tag becomes an **amount** tracker in the habit grid engine
   (`packages/habit-grid/`, imported by relative path, not copied), in
   minutes per day, with check-ins marked `source: 'automatic'`, a value the
   engine already accepts. The engine's `renderSvg` draws each grid, built
   fresh in memory on every run; nothing is merged into a saved habit file.
   The grids have no targets, so they shade by the tracker's own range and
   never show "missed".
5. **Write one page.** One self-contained HTML file (no outside scripts,
   fonts or images) with a grid per tag, the date range held, and the days
   with no data. It is written to
   `~/Library/Application Support/OpenConvo/time-mirror/time.html` (folder
   mode 0700, file 0600), first to a temporary file and then renamed, so a
   failed run keeps the last good page. The page holds daily minutes per tag
   only. Raw API rows are kept in memory and never written anywhere. The
   file is protected only by its permissions: anything running as the owner
   on his Mac, local agents included, could read it. No agent is pointed at
   it, but that is a rule, not a wall, until slice 3 moves the history into
   the protected store.
6. **Forget.** `--forget` deletes that folder. Revoking the key on
   RescueTime's site and deleting the Keychain item stops all access.

Nothing runs unless the owner runs the command. No background service, no
launch agent and no schedule in this slice; a schedule later needs his
approval, since it outlives a session.

## Gate 0 (The Owner, Once, On His Mac)

1. Create a RescueTime API key on RescueTime's site.
2. Store it in the Keychain with one Terminal command the code pull request
   gives him (it prompts for the key, so it never lands in shell history).
3. Run the command and open the page.

If RescueTime's API no longer works for his plan, slice 1 stops there and the
source question reopens (ActivityWatch, below, becomes the likely substitute;
the grids and page stay the same).

## Privacy And Risk Check (risk-review.md Checklist)

1. **Data leaving the device:** the Keychain key and a date range go to
   `www.rescuetime.com`, the service that already holds this data. Nothing
   about the owner is sent anywhere new. That host is new to the repo, so the
   code pull request trips the risk hold, and the owner approves it once with
   an allowlist entry.
2. **Secrets:** the key lives only in the Keychain, as in AGENTS.md. Tests
   use an invented key and an injected fetch that makes no network call.
3. **Real personal data:** none in the repo. Fixtures are invented. The
   owner's tags file and page live outside the repo.
4. **Storage:** one page of daily per-tag minutes in Application Support,
   readable only by him. It is outside the protected Desk store, which this
   plan allows because it holds daily totals only, never site, app or window
   names. Time Machine backs that folder up like the rest of his Library,
   and any program running as him could read it (step 5 above).
   Moving it into the protected store is slice 3.
5. **Permissions:** no new Mac permission, no entitlement, no agent access.
   RescueTime keeps the permissions he already gave it.

**Legal.** This slice is for the owner's own data on his own Mac. Offering it
to other users (consent screens, workplace-monitoring and privacy laws, the
public privacy policy on trueconvo.com) needs its own plan and his approval
before anything ships.

## Which True Convo Modules It Touches

- **Habit grid** (`packages/habit-grid/`): used as is, for the first
  `automatic` check-ins. No engine change. If one turns out to be needed,
  it goes in its own pull request.
- **Personal space and the Desk** (step 5): later, a Time view, and these
  grids next to his habits (slice 3).
- **Protected storage** (step 2): later, where the history is kept (slice 3).
- **Today agenda, memory, agents and the steward ideas:** not touched. No
  agent or model reads this data in any slice without his yes for that case.
- **Security** ([security.md](security.md)) and the risk hold: the new host.

## Later Slices (Not Built Here, Each Needs His Yes)

- **Slice 2, our own watcher on the Mac:** read a local, open-source
  collector, most likely ActivityWatch (local server, no account, editable
  categories, pause controls), through a narrow read-only adapter. App names
  and idle time first; window titles and browser URLs only with their own
  separate consent, since they can reveal clients, health topics and
  messages. Ends the need for RescueTime's cloud.
- **Slice 3, in the app:** a Time view in the Desk, history kept in the
  protected store, and a per-day breakdown by tag.

## Not Doing

- Per-site or per-app names, window titles, URLs, screenshots, screen text
  or keystrokes.
- Any AI reading the data, a weekly summary, or nudges.
- A background service, a schedule, or any change to RescueTime's settings.
- Screenpipe or other screen-recording sources.

## Proof In The Code Pull Request

- Tests on invented RescueTime responses: normal days, missing days,
  malformed rows, an auth failure, a rate-limit reply and a network error
  (each keeps the last good page and says plainly what failed).
- A test that the only requests made are the two allowed kinds, to that one
  host, and that no request asks for per-site or per-app rows.
- A test (in the command's tests) that the key never appears in output,
  errors or the page, and that an error shows no response body.
- A test that the library itself never imports `fs`, `child_process` or a
  network module, so the package rule holds.
- A test that the written page contains no URL, no outside resource, and
  only daily per-tag numbers.
- A README with the Gate 0 steps, written for someone new to Terminal.
