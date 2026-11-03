# Time Mirror Slice 2: Activity Sources, With ActivityWatch On The Mac (PRD)

Status: Draft (Nov 3): waiting on the owner's yes in the Claude thread "Draft next plans for outside builders".

Written November 3, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261103-time-mirror-aw`. Umbrella: Personal. This is **slice 2** of
[time-mirror.md](time-mirror.md) ("Later Slices": "our own watcher on the
Mac ... ActivityWatch ... through a narrow read-only adapter. App names and
idle time first; window titles and browser URLs only with their own separate
consent"). That plan says each later slice needs the owner's yes; this plan
is where he gives it. **Builder:** Codex team A, under AGENTS.md "Outside
Builders" (it built slice 1's library, #252). **Reviewers:** Codex reviews
every push; GrokBot or a fresh Claude is the independent review, ending with
the risk-review checklist ([risk-review.md](risk-review.md)); the
coordinator checks it against this plan. **Finish line:** the pull request
merges with `tests` passing, and the owner runs the command once on his Mac
against his own ActivityWatch and opens a page of his own time as heat maps,
with no RescueTime account involved, and the owner trial below passes.
RescueTime stays his default source; this run proves the native slot works.

## Why

The owner's rule (November 3, 2026): where he already pays for a tool he
used before True Convo, such as RescueTime, True Convo connects to that tool
as the default, and every such connection also has a documented **native
slot**, a clear interface and a guide, so anyone can build a True Convo
native replacement and plug it in instead. Time Mirror is the first place
this applies. RescueTime (slice 1) stays the owner's default source. This
slice turns the mirror's input into a named **activity source** interface,
wraps RescueTime as one source without changing it, and adds ActivityWatch
as the second: free, open source, running only on the Mac, with no account.
ActivityWatch is the worked example of the native slot, so the guide shows
a real second source rather than a theory. The slice 1 wording still holds:
a mirror, not a judge; the strictest privacy scope; no grades, scores or
nudges.

## The Activity Source Interface (The Native Slot)

`src/sources.mjs` defines what any source gives the mirror:

- A source is `{ id, name, days({ from, to, timeZone }) }`. `days` returns
  `{ days: { "<YYYY-MM-DD>": { "<tag>": minutes } }, missing: [dates],
  skipped: count }`, with whole or decimal minutes, the reserved tag names
  of slice 1, and `untagged` for minutes with no tag.
- `fromSource(source, options)` builds slice 1's trackers, grids and page
  from any source, so the page never knows which tool fed it.
- `rescueTimeSource({ fetchRows, categoryTags })` wraps slice 1's existing
  RescueTime functions as a source. Slice 1's code is not changed.
- `activityWatchSource({ host, appTags, fetchJson })` is this slice's
  adapter (below).
- `checkSource(source, sampleRange)` is a contract check any new source
  can run in its own tests: shape, reserved names, day keys inside the
  range, no negative or impossible minutes (over 1,440 a day), and missing
  days listed rather than zero-filled.
- The README gains **"Add your own activity source"**: the interface, the
  privacy rules every source must keep (no titles, URLs or content leave
  the adapter), how to run `checkSource`, and both built-in sources as
  examples. This is the guide the owner's rule asks for.

## What It Does

Additions to `packages/time-mirror/`, next to slice 1: the interface above,
then two parts:

### The Adapter (Library)

`awDays({ from, to, timeZone, appTags, host, fetchJson })` returns the same
daily per-tag minutes that slice 1 builds its trackers from, so slice 1's
trackers, grids and page are reused unchanged.

- `fetchJson(path)` is injected. The library builds only three kinds of
  path and nothing else: `/api/0/buckets/`, and
  `/api/0/buckets/<id>/events?start=<RFC 3339>&end=<RFC 3339>` for the one
  window bucket and the one idle bucket. Bucket ids are percent-encoded.
- **Buckets.** It uses the bucket of type `currentwindow` and the bucket of
  type `afkstatus` whose `hostname` equals `host`. Zero or more than one of
  either is refused with a plain message naming what's there (types and
  hostnames only).
- **Only the app name is read.** From a window event it reads `timestamp`,
  `duration` and `data.app`. `data.title`, `data.url` and every other field
  are dropped at the point of parsing and never stored, returned, printed or
  written. Events from a web-browser watcher bucket are never requested.
- **Flood first.** ActivityWatch records heartbeats that can have zero
  duration and leaves small gaps for analysis to fill. Before anything
  else, both the window events and the idle events are flooded the way
  ActivityWatch's own query does (its `flood` with the same default pulse
  time: a gap shorter than the pulse time between neighbours is filled by
  extending the earlier event, and overlaps are trimmed). The README names
  the ActivityWatch version whose behavior was copied.
- **Active time.** After flooding, a window event counts only where it
  overlaps an idle event with `data.status` `"not-afk"`. Overlapping window
  events are merged so a minute is never counted twice.
- **Days.** Time is split at midnight in `timeZone` (an IANA name), so an
  event that crosses midnight counts on both days. Days run from `from` to
  `to`, at most 400.
- **Read in chunks.** Events are requested one civil day at a time, each
  window widened by the flood pulse time on both sides so flooding and the
  intersection are right across day edges (the overlap is trimmed after).
  If one day's response is stopped at the 2 MB cap, that day is asked again in
  halves, down to one hour; an hour still over the cap is refused with a
  plain message naming the hour. Every chunk, at every split level, is
  widened by the pulse time on both sides, then trimmed to its own span
  with overlapping events counted once, so the result never depends on
  how a day was split. Only the parsed fields of each chunk are
  kept, so memory stays small for a 400-day range.
- **Tags.** `appTags` maps an app name to one of the owner's tag names (the
  same rules as slice 1's `categoryTags`, including the reserved names).
  Minutes for apps with no tag go into one total named `untagged`; their
  names are not kept.
- Missing days (the Mac was off) are listed, as in slice 1. Malformed
  events are skipped and counted, never guessed.

### The Command

`node packages/time-mirror/src/aw-command.mjs --from <date> --to <date>
--tz <IANA zone> --host <name> --tags <tags.json> --out <page.html>
[--force]`

- Talks to ActivityWatch only at `http://127.0.0.1:5600`, the loopback
  address written as a literal. No other host, no DNS name, redirects
  refused, a 10-second timeout per request, and at most 2 MB per response.
- Writes the page through a temporary file and a rename, refuses to
  overwrite without `--force`, and creates a new file with mode `0600`.
- `--list-apps` instead prints each app name seen in the range with its
  active minutes, to the terminal only, so the owner can write his tags
  file. Nothing is written in this mode.
- Prints which days were missing and how many events were skipped.

## When It Goes Wrong

The page and the command are things the owner sees, so they answer the five
questions in [when-it-goes-wrong.md](when-it-goes-wrong.md):

1. **No connection.** If ActivityWatch isn't running, the command says
   "ActivityWatch isn't answering at 127.0.0.1:5600. Open ActivityWatch,
   then run this again." and writes nothing, so the last page stays.
2. **Interrupted.** The temporary file plus rename means an interrupted run
   leaves the old page whole.
3. **Empty or first run.** With no tags file entries, everything shows as
   `untagged` and the command suggests `--list-apps`. A range with no
   activity shows empty grids and says no activity was found.
4. **Denied or stuck.** Doesn't apply: ActivityWatch's local API asks for no
   password, and the command asks for no permission. The timeout stops a
   stuck request.
5. **The error message.** Each failure says what happened and what to do,
   in plain words (the two bucket messages name the hostnames found and
   suggest `--host`).

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/time-mirror/` (invented ActivityWatch responses
only):

1. A normal week of invented window and idle events gives the expected
   per-tag minutes, and slice 1's page is built from them through
   `fromSource`. The same invented RescueTime rows through
   `rescueTimeSource` give the same page slice 1 gives today, and both
   built-in sources pass `checkSource`; a deliberately broken source fails
   it with a plain reason.
2. **Titles never leak.** Window events carry invented titles and URLs with
   a marker string; the marker appears nowhere in the result, the page, the
   command's output or `--list-apps`.
3. Only the three allowed path kinds are requested, and no browser bucket.
4. Idle time is subtracted; overlapping window events count once.
   Zero-duration heartbeats a few seconds apart are flooded into one
   visit and counted, a gap longer than the pulse time is not filled, and
   a short not-afk gap at an idle boundary is flooded as ActivityWatch's
   own query would.
5. An event crossing midnight in `America/New_York` splits correctly, and a
   daylight-saving change day has 23 or 25 hours.
6. Zero or two matching buckets are refused with the plain message.
7. Malformed events are skipped and counted.
8. A 400-day range of invented events totalling well over 2 MB is read
   day by day and gives the same minutes as one big read; a 3 MB day is
   split and still counted; events flooded across a day edge count once;
   a floodable gap across a half-day or hour split gives the same minutes
   as the unsplit day.
9. The command refuses any base other than `127.0.0.1:5600`, refuses a
   redirect, times out, and caps the response size (with a local test
   server on loopback).
10. The library never imports `fs`, `child_process` or a network module and
   never reads the clock.
11. The command refuses to overwrite without `--force`, and a write is a
    temporary file plus rename.

**Owner trial checks** (on his Mac, with his own ActivityWatch, following
the README's steps; an agent may run the commands for him): with
ActivityWatch quit, the command prints the "isn't answering" message and
the last page is unchanged; with it running, `--list-apps` prints app names
and minutes only, with no window titles or web addresses; with an empty
tags file everything shows as `untagged` and the command suggests
`--list-apps`; a range before he installed ActivityWatch shows empty grids
and says no activity was found; a wrong `--host` prints the bucket message
naming the host names found; running again without `--force` leaves the
old page as it was; stopping a run part-way (Control-C) leaves the old page
whole; and the finished page shows his week with no titles or addresses
anywhere in it. He confirms each message tells him what to do next.

## Out Of Scope For This Slice

Window titles, browser URLs and the browser watcher; any background service
or schedule; changing ActivityWatch's settings; the Desk's Time view and
storing history in the protected store (slice 3); any AI reading the data.

## Rules For The Builder (Codex Team A)

The builder must follow these; the setup does not enforce them, so breaking
one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, on the branch `OC-261103-time-mirror-aw`, signed in
  as `cloudwork-bot` (or as Codex's own GitHub app for a cloud task). Open a
  pull request into `main` with auto-merge off and the label `agent: codex`.
  Never push to `main` directly, and never switch on auto-merge.
- End the pull request description and every comment with
  `— Codex team A, OC-261103-time-mirror-aw`.
- Run **no commands on the owner's Mac** apart from `npm test` inside
  `packages/time-mirror/` and the `git` and `gh` commands needed to commit,
  push and open the pull request. Never connect to a real ActivityWatch.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or real
  activity data. Invented events only.
- Change files only under `packages/time-mirror/`. Leave slice 1's code as
  it is unless a test shows it wrong (say so in the pull request). Nothing
  else, not `STATUS.md` (the coordinator updates it).
- JavaScript modules (`.mjs`), Node 22 or later, tests with `node --test`
  through the package's existing `npm test`.
- The library never imports `fs`, `child_process` or a network module,
  never calls `fetch` and never reads the clock. The command may use
  `fetch` to `127.0.0.1:5600` only, and the tests may run a local server on
  loopback only.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the source interface and `checkSource`, the
  RescueTime wrapper, the ActivityWatch adapter, the command, the tests, the
  README's "Add your own activity source" guide, and a README section with
  the inputs, the rules, the output and the owner's steps
  (install ActivityWatch, find the host name, write the tags file, run the
  command), written for someone new to Terminal. Finishable in one to two
  days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Supported setups are macOS and the Linux CI runners on Node 22 (AGENTS.md
  "Review Guidelines").
- Edge cases this plan doesn't name: write each choice in the README's
  "Edge cases" section with a test.

## Review And Finish Line

Codex reviews it as code until it gives a 👍. Codex team A fixes every P1
and P2 or explains in the pull request why one doesn't apply. GrokBot or a
fresh Claude gives the independent review with the risk-review checklist.
The coordinator checks it against this plan and switches on auto-merge once
both are clean on the same head. Done when the tests pass with one command,
the reviews are clean (or the Codex triage judge passes it,
[codex-triage.md](codex-triage.md)), and the owner's run on his Mac (the
finish line above) shows his page.
