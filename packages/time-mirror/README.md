# Time Mirror

Pure, in-memory Node 22 ESM library for turning invented or caller-supplied
RescueTime daily totals into habit-grid trackers and one self-contained HTML
page. It has no dependencies and does not read the network, clock, disk,
Keychain, or any key.

The caller supplies a date range and an asynchronous `fetchRows(parameters)`
function. The library calls it once for daily productivity totals and once for
daily category totals. Each call may return RescueTime's
`{ row_headers, rows }` response or an array with the headers as its first row.
Dates may be `YYYY-MM-DD` or `YYYY-MM-DDT00:00:00`.

An optional `categoryTags` object maps selected category names to local tag
names. Unmapped categories are omitted. The names `productive`, `neutral`,
`distracting`, and `total` are reserved for the built-in summaries and are
refused as owner tag names so the same minutes cannot be counted twice.

The result contains the request range, missing dates, the in-memory targetless
count trackers in minutes, their SVG grids, and the HTML page string. The
separate Mac command will handle RescueTime access and writing the page.

Run the invented-data tests:

```sh
cd packages/time-mirror
npm test
```

## ActivityWatch on your Mac

This source reads app names and active time from ActivityWatch on the same Mac.
It never asks for a browser-watcher bucket. Window titles, web addresses and
all fields other than timestamp, duration and app name are discarded as each
response is read. Activity data is not sent to RescueTime or anywhere else.

Install ActivityWatch from its official instructions, open it, and leave it
running. In Terminal, find the host name ActivityWatch uses:

```sh
curl -s http://127.0.0.1:5600/api/0/buckets/ | grep hostname
```

Create a `tags.json` file outside this repository. Start with an empty object
if you do not know the app names:

```json
{}
```

List the app names and active minutes. Replace the dates, time zone, host name
and tags-file path with yours:

```sh
node packages/time-mirror/src/aw-command.mjs --from 2026-10-01 --to 2026-10-07 --tz America/New_York --host your-host --tags /path/to/tags.json --list-apps
```

Only app names and minutes print. Nothing is written. Add the names you want
to the file, for example:

```json
{
  "Example Editor": "coding",
  "Example Reader": "reading"
}
```

Build the private local page:

```sh
node packages/time-mirror/src/aw-command.mjs --from 2026-10-01 --to 2026-10-07 --tz America/New_York --host your-host --tags /path/to/tags.json --out /path/to/time.html
```

The command refuses to replace an existing page. Add `--force` only when you
intend to replace it. It talks only to the literal loopback address
`127.0.0.1:5600`, refuses redirects, stops each request after 10 seconds and
limits each response to 2 MB. It creates the page with mode `0600`, using a
temporary file and rename so an interrupted run leaves the prior page whole.

ActivityWatch events are read one civil day at a time, up to 400 days. A
response at the 2 MB limit is retried in halves down to one hour. Events are
flooded using aw-core v0.5.17's five-second default pulse behavior before
active time is calculated. Each read is widened by five seconds so flooding
continues correctly at day and split edges.

Gaps up to and including five seconds go to the longer neighbouring event,
or the earlier event on a tie. Equal app/status values merge during flooding,
and zero-duration leftovers are dropped, following `aw_transform/flood.py`.

## Add your own activity source

An activity source has this interface:

```js
{
  id: 'example',
  name: 'Example source',
  async days({ from, to, timeZone }) {
    return {
      days: { '2026-10-01': { coding: 45, untagged: 10 } },
      missing: [],
      skipped: 0
    };
  }
}
```

Dates use `YYYY-MM-DD`. Minutes may be whole numbers or decimals. A day with
no source data belongs in `missing`; do not return it as a zero-filled day.
`skipped` counts malformed events the source deliberately ignored. Keep each
tag at or below the real length of that civil day, including 23-hour and
25-hour daylight-saving days. The built-in summary names `productive`,
`neutral`, `distracting` and `total` are reserved. Use `untagged` for activity
that has no mapped tag.

The adapter is the privacy border. Drop window titles, web addresses, content
and any other private detail while parsing. Never return, print, log or write
those fields. Test the contract and build a page through the common path:

```js
import { checkSource, fromSource } from './src/sources.mjs';

await checkSource(source, { from, to, timeZone });
const result = await fromSource(source, { from, to, timeZone });
```

`rescueTimeSource({ fetchRows, categoryTags })` wraps the original daily-total
reader. `activityWatchSource({ host, appTags, fetchJson })` is the local worked
example. The library accepts injected readers and never reads the network,
disk or clock itself.

## Edge cases

- If two window events overlap, the later event keeps the overlapping time.
  The minute is counted once, never under two app tags.
- A valid day containing events but no active overlap is present with empty
  totals. A day with no valid window or idle events is listed as missing.
- Malformed events are skipped one by one. A malformed whole response stops
  the run because its contents cannot be separated safely.
- App names not found in the tags file are combined into `untagged`; their
  individual names are not kept in the page result.
- With an empty tags file, the page says all activity is untagged and suggests
  `--list-apps`. A range with no activity says no activity was found.
