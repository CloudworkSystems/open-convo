# Household Lists Engine (PRD)

Written October 16, 2026 by the planning session from the owner's decisions.
Session name: `OC-261016-household-lists-engine`. Umbrella: Family and Home.
Built by an outside builder under AGENTS.md "Outside Builders", after the Site
Engine slice (one outside module at a time).

## Why

The owner and his wife keep shared grocery and to-do lists in Apple Notes
every day. Items stay on the list: unchecked when something runs out, checked
when it's bought. What Notes can't do is sort the checklist items themselves
(alphabetically or otherwise). True Convo's household lists do the same daily
job and sort.

## Plan Of Record (Owner Decision, October 16)

1. **Now:** build the list engine on its own, tested on invented data. No app
   code, no storage code, no AI.
2. **Later:** first real use once the iPhone capture app exists (after step 5),
   syncing between phones through iCloud with the owner's one-time approval
   (foundations principle 6). The engine must not change for that; only where
   the data lives changes. Voice ("add eggs") comes once conversations work
   (step 3) and is not part of this slice.

## What It Does

A small library in `packages/household-lists/`:

- **Several lists** (grocery, warehouse store, hardware store, house to-dos),
  each with its own name and settings. Lists can be created, renamed and
  removed (removal is reversible until emptied from Trash).
- **Items** have text, an optional quantity ("2"), an optional short note, an
  optional store section, an optional "added by" name, and a checked state.
- **Checking never deletes.** Checking or unchecking an item only flips its
  state. The item stays where it is: in a sorted list it keeps its sorted
  position whether checked or not (owner, October 16). Deleting is a separate,
  deliberate action, reversible until Trash is emptied.
- **Three sort orders per list**, chosen per list:
  - **A to Z** (the default): by item text, ignoring case, accents and a
    leading quantity, so "2 milk" sorts under M.
  - **By store section**: grouped (produce, dairy, frozen and so on), A to Z
    within each group, unsectioned items last.
  - **As added**: the order items were first added.
- **Store sections**: a small built-in starter map from common grocery words
  to sections, which the user can override per item and extend. Changing the
  map never changes items silently; it only suggests.
- **Undo** for the last few changes on a list.

## Built For Sync Later

Two phones will edit the same list while apart (at the store and at home), so
the engine records changes in a way that merges cleanly:

- Every list and item has a permanent ID; text is never used as identity.
- Every change carries the device it came from and a **version stamp** that
  puts all changes in one total order, even when two phones' clocks disagree
  or two changes share a time: a logical counter (a Lamport-style clock that
  always moves past any stamp it has seen), then the wall-clock time, then the
  device ID as the final tie-breaker. "Later" in the rules below means "higher
  version stamp", never the phone's clock alone.
- **Merge** takes two copies of a list and produces one result, the same
  whichever copy goes first. Rules: changes to different items both survive;
  for the same field of the same item, the later change wins; a deletion wins
  over an earlier edit and loses to a later re-add; checking and editing the
  text of the same item at the same time keeps both.
- **List-level changes follow the same rules.** Renaming a list, changing its
  sort order, and editing its section map are fields of the list, so the
  higher version stamp wins per field. Removing a list wins over earlier edits
  inside it and loses to a later edit or re-add, which restores the list.
  Section-map additions from two phones are both kept; for the same word, the
  higher stamp wins.
- **Deletions leave a permanent marker.** Deleting an item or list, and
  emptying Trash, removes the content but keeps a small record (ID, version
  stamp, "deleted"), so an offline phone's older copy can never bring it back.
  These markers are kept indefinitely in this slice; compacting them is
  deferred until sync exists and can confirm every device has seen them.
- No network code in this slice: merge works on two files.

## Data Format

One JSON file per list, with a `schemaVersion`. Plain text only. The format is
documented in the package README so a later iPhone app, the Mac app and the
wall hub read the same thing.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/household-lists`, Node's built-in test runner,
invented households only. At least:

1. Add, check, uncheck, edit and delete items; checking never removes an item.
2. A to Z sorting ignores case, accents and leading quantities; checked items
   keep their sorted place.
3. Section sorting groups correctly, with unsectioned items last.
4. "As added" keeps first-added order through edits and re-checks.
5. Several lists stay independent.
6. Undo restores the previous state exactly.
7. Delete goes to Trash and can be restored; emptying Trash removes it.
8. Merge: two devices editing different items; the same field; delete vs
   edit; check vs text edit; merging A into B equals merging B into A; merging
   a copy with itself changes nothing.
   Also: two changes with the same time, and a phone whose clock runs hours
   behind, both resolve the same way on every device; one phone renames a
   list, changes its sort and adds a section word while the other edits items;
   one phone removes a list while the other edits an item in it (later stamp
   wins); and phone A empties Trash while phone B is offline with the old
   item, then they merge and the item stays deleted.
9. Saving and loading a list file gives back exactly the same list, and a file
   with an unknown `schemaVersion` is refused with a plain message.
10. Hostile but valid text (quotes, `<`, `&`, emoji, very long names) is
    stored and returned unchanged.

## Out Of Scope For This Slice

App screens, iPhone, iCloud or any network, Mac app or Desk code, storage or
encryption code, AI or voice, real household data.

## Rules For The Builder

Same as the Site Engine plan: own branch named after the session, a pull
request into `main`, never push to `main`; no commands on the owner's Mac; no
keys, accounts or private files; invented data only; files only under
`packages/household-lists/` plus one line in `STATUS.md`; no new dependencies
unless unavoidable (listed with license); no repo license file.

## Review And Finish Line

A different agent reviews it as code until Codex gives a 👍; the planning
session checks it against this document and gives the owner a short try-it
note; the owner merges. Done when the tests pass with one command, Codex has
given a 👍, and the planning check finds nothing missing.
