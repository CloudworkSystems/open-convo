# Time Mirror library

Pure, in-memory Node 22 ESM library for turning invented or caller-supplied
RescueTime daily totals into habit-grid trackers and one self-contained HTML
page. It has no dependencies and does not read the network, clock, disk,
Keychain, or any key.

The caller supplies a date range and an asynchronous `fetchRows(parameters)`
function. The library calls it once for daily productivity totals and once for
daily category totals. An optional `categoryTags` object maps selected category
names to local tag names. Unmapped categories are omitted.

The result contains the request range, missing dates, the in-memory targetless
count trackers in minutes, their SVG grids, and the HTML page string. The
separate Mac command will handle RescueTime access and writing the page.

Run the invented-data tests:

```sh
cd packages/time-mirror
npm test
```
