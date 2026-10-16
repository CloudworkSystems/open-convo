# Household lists engine

Standalone, in-memory Node ESM library. No dependencies, app integration, disk
I/O, network, accounts, AI, encryption, or real household data. Node 22 or later.

Run every test:

```sh
cd packages/household-lists
npm test
```

## Try it with invented data

From this folder:

```sh
node --input-type=module <<'JS'
import { HouseholdLists } from './src/index.mjs';
const phone = new HouseholdLists({deviceId: 'example-phone'});
const groceries = phone.createList('Maple household groceries');
phone.addItem(groceries, {text: '2 milk', section: 'dairy'});
const apples = phone.addItem(groceries, {text: 'Apples', quantity: '4'});
phone.setChecked(groceries, apples, true);
console.log(phone.view(groceries)); // Apples stays before milk, even checked.
phone.setChecked(groceries, apples, false);
phone.deleteItem(groceries, apples);
console.log(phone.view(groceries, {trash: true}));
phone.undo(groceries);
console.log(phone.view(groceries));
JS
```

## API

Import `HouseholdLists`, `mergeLists`, `viewList`, `serializeList`,
`deserializeList`, `compareStamps`, `sortKey`, `SORT_ORDERS`, and
`STARTER_SECTIONS` from `src/index.mjs` (the package export).

`new HouseholdLists({deviceId, now = Date.now, undoLimit = 20})` creates an
in-memory collection. Give each independent writer a unique, stable device ID.
Never run two independent writers with the same ID and clock history. `now`
is an injectable function returning integer milliseconds. The logical counter
is instance-wide, increases for each change and advances past **all** stamps in
an imported file, including tombstones. Reload saved lists before editing after
restart. A future sync adapter must persist all list files, including deleted
ones; dropping tombstones would break the offline-deletion guarantee.

- `createList(name, {id}?)` returns a permanent ID (UUID by default).
- `listIds({trash = false}?)` lists active or recoverable deleted list IDs.
- `renameList(id, name)`, `setSort(id, order)`, `deleteList(id)`,
  `restoreList(id)` modify list settings/lifecycle.
- `addItem(id, fields, {itemId}?)` returns a permanent item ID. `text` is
  required; optional `quantity`, `note`, `section`, `addedBy` default to empty
  strings and `checked` defaults to false. All strings are preserved exactly.
- `editItem(id, itemId, fields)` updates only supplied fields;
  `setChecked(id, itemId, boolean)` changes checking independently of text.
- `deleteItem(id, itemId)` moves to Trash; `restoreItem(id, itemId)` restores
  its content and first-added position. Editing a recoverable deleted item
  also restores it. A later item change restores a removed containing list.
- `setSectionWord(id, word, section)` extends or overrides the starter map.
  `suggestSection(id, text)` returns a suggestion or null. Suggestions use the
  normalized whole item text; callers explicitly apply them via `section`.
  A map change never changes existing item sections. Empty section strings
  mean unsectioned. Map words are normalized; map section values stay literal.
- `view(id, {trash = false}?)` returns plain list settings, the effective
  section map, and sorted active or recoverable deleted items. `viewList`
  does the same for a standalone snapshot. Removed lists retain their contents
  in Trash until emptied; check `deleted` before displaying them as active.
- `getList(id)` returns a JSON-compatible snapshot with sync metadata.
  Returned objects are copies; mutating them never changes engine state.
- `save(id)` / `load(json)` serialize and import JSON **strings**. The caller
  owns file I/O. `load` merges with an existing list of the same ID.
  `importList(snapshot)` imports/merges a snapshot directly.
- `mergeLists(a, b)` returns a new merged snapshot of the same list ID.
  Neither input changes. Different list IDs and malformed files are refused.
- `undo(id)` returns true if a change was undone, false if history is empty.
- `emptyTrash(id)` permanently removes the list's recoverable deleted items;
  if the list itself is deleted, it removes all list content instead.

Sort settings are `alphabetical` (default), `section`, and `added`.
Alphabetical keys ignore Unicode combining accents, case and a leading numeric
quantity (integers, decimals, fractions, optional `x`/`×`). These keys are only
for comparison: stored text is never rewritten. Section names sort
alphabetically, items alphabetically within each section, unsectioned last.
As-added compares immutable birth stamps. Ties use birth stamps, then ID.
Checking does not participate in any comparator. Comparisons use JavaScript UTF-16 code
unit string order rather than the host's locale, so devices agree.

## JSON schema version 1

One JSON object/file per list. Strings are plain text, never HTML. Applications
must render them as text rather than execute/interpret them.

```json
{
  "schemaVersion": 1,
  "id": "example-list",
  "life": {"value": true, "stamp": {"counter": 1, "time": 100, "device": "example-phone"}},
  "purge": null,
  "fields": {
    "name": {"value": "Maple groceries", "stamp": {"counter": 1, "time": 100, "device": "example-phone"}},
    "sort": {"value": "alphabetical", "stamp": {"counter": 1, "time": 100, "device": "example-phone"}}
  },
  "sections": {},
  "items": []
}
```

A **stamp** is `{counter, time, device}`: a positive safe-integer logical
counter, safe-integer wall-clock milliseconds, and a nonempty device string.
Compare counter first, time second, device ID last. Clock skew alone cannot
outweigh a greater counter. Concurrent equal counters and times resolve by
device ID. Conflicting values with an identical stamp are refused: they indicate
reused writer identity or corrupt input.

A **register** is `{value, stamp}`. List `fields` contain `name` and `sort`.
`sections` maps each normalized word to an independent string-valued register,
so distinct additions survive together. A null value is an undo removal of a
custom override (revealing the starter word, if any).

Each `items` entry is `{id, life, purge, fields}`. Its fields are `text`,
`quantity`, `note`, `section`, `addedBy`, `checked`, and `added`; the last is a
stamp-valued register containing the original birth stamp. Each list/item's
`life` is a boolean register: true means present, false means deleted.
Every local item edit also writes true to item and list life. List settings
write true to list life; deletion writes false. Highest stamp wins per
register. This preserves simultaneous check and text edits and lets a later
edit/re-add defeat an earlier deletion. Different item IDs never coalesce,
even when their text is identical. Array order is canonical ID order;
presentation sorting is derived by `view` and never changes the JSON order.

`purge` is null or a permanent stamp cutoff. Delete preserves fields only in
Trash. Emptying Trash erases fields and keeps a content-free marker:

```json
{
  "id": "example-deleted-item",
  "life": {"value": false, "stamp": {"counter": 8, "time": 200, "device": "example-phone"}},
  "purge": {"counter": 8, "time": 200, "device": "example-phone"},
  "fields": {}
}
```

A purged list keeps `schemaVersion`, `id`, false `life`, `purge`, empty
`fields`, empty `sections`, and empty `items`. Its cutoff also fences all older
item content. During merge only fields with stamps above the relevant item/list
cutoff survive. An old offline copy cannot restore that content or put it back
in recoverable Trash. Cutoffs are never compacted or removed in this slice.
A deliberate fresh `addItem` may reuse an emptied item's permanent `itemId`
with new text and defaults; it retains the cutoff. A purged list can similarly
be reactivated by a later rename/new item; erased fields stay erased. New
content and stamps above the cutoff can survive; fields erased by a purge are
not reconstructed from an older copy. A future UI should present missing
metadata with defaults (the list view already defaults name/sort).

Serialization preserves snapshots exactly, including tombstones. Loading
checks the schema, field types, IDs, duplicate item IDs, and stamps. Unknown
versions fail with `Unsupported schemaVersion; expected 1.` No migration is
silently attempted. Importing clears local undo history for that list, since
undoing an old snapshot after external changes would overwrite unseen work.

## Undo and Trash

Undo retains up to 20 previous snapshots **per list**, in memory only. It
restores the previous user-visible state exactly: text, checking, ordering,
settings, section map, active/Trash membership and IDs. Sync metadata receives
fresh compensating stamps, so a merged copy honors the undo instead of
reapplying the undone changes. Undo of an addition leaves a content-free
marker to prevent an offline copy from restoring it. Undo history and counters
are not part of the JSON file. Emptying Trash clears that list's undo history,
so purged content is neither retained there nor recoverable by Undo. Creating
a new list is not on its undo stack; remove it with `deleteList`.

## Validation coverage

`npm test` uses only Node's built-in test runner and invented data. It covers
the plan's ten groups: CRUD/checking, alphabetical/section/as-added sorting,
independent lists, undo, Trash, field-level and lifecycle merges, equal clocks
and skew, permanent purge markers against offline copies, exact JSON round
trips/version rejection, and hostile text. Additional cases check prototype-like
words, atomic invalid operations, immutable returned snapshots, explicit re-add,
self merge, and deterministic three-device histories under all delivery orders.
