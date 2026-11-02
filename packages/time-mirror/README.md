# Time Mirror library

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
