# Sync Core (PRD)

Written October 22, 2026 by the planning session from the owner's decisions
that day (recorded in [docs/decisions.md](../decisions.md)). Session name:
`OC-261022-plan-day-one-and-sync`. Umbrella: Personal. First slice of the
iPhone and sync line (PLAN.md, "Day One And Public Launch"). Built by an
outside builder under AGENTS.md "Outside Builders": **the next free GrokBot
team** builds, Codex reviews. It takes the first of the three outside-builder
places that frees up; it does not make a fourth.

## Why

Public launch needs the same conversations, tasks and memory on the Mac and
the iPhone, with no visible sync errors and data the project can't read. Sync
runs on CloudKit: each user's private iCloud database, so there is no sync
server to run or pay for. The Mac app already encrypts what it stores, so
what travels is ciphertext, unlocked on each device with the user's recovery
key.

Most of the hard part of sync is not CloudKit itself. It is deciding what to
send, what to fetch, what happens when two devices change the same thing
while apart, how deletions stay deleted, and how a device that was offline
for a week catches up without losing or resurrecting anything. That logic can
be built and tested now, on its own, with a fake cloud. Wiring it to the real
CloudKit, the Mac app's storage and an iPhone app comes after, in the
building lanes.

## Plan Of Record

1. **Now (this slice):** a Swift package with the sync logic and an in-memory
   fake of CloudKit's private database, tested with invented records. No real
   CloudKit, no Apple account, no keys, no app or storage code.
2. **Next (building lanes):** a thin adapter from this package to real
   CloudKit; the Mac app hands its already-encrypted records to the sync core;
   the iPhone app is built on the same package. Turning sync on is a one-time
   host approval in the app (foundations principle 6).
3. **Later:** Windows and Android sync behind the same interface.

## What It Does

A Swift package in `packages/sync-core/` (Swift, because CloudKit, the Mac
app and the iPhone app are all Swift). Pure Swift, no Apple-only frameworks,
so it builds and tests on Linux too.

- **Records are opaque.** A record is an ID, a record type (for example
  `conversation-page`, `task-list`, `memory-item`), a version stamp, the
  device it came from, and an encrypted payload the sync core never opens.
  The sync core never sees a key or plaintext.
- **Version stamps** follow the household lists engine's rule
  ([household-lists-engine.md](household-lists-engine.md), "Built For Sync
  Later"): a logical counter that always moves past any stamp seen, then wall
  time, then device ID as the final tie-breaker. "Later" always means "higher
  stamp", never a device's clock alone.
- **Outbox and catch-up.** Local changes queue in an outbox and upload in
  batches; a device fetches everything changed since its last change token.
  An upload that fails or is cut off is retried without duplicating anything.
  A device offline for a long time catches up from its last token, or from
  scratch if the token has expired, with the same end result.
- **Conflicts.** When the cloud already holds a newer version of a record,
  the sync core does not pick a winner blindly. It hands both copies to a
  **merge function registered for that record type** (the household lists
  engine already has one) and uploads the result. A record type with no merge
  function falls back to "higher stamp wins" and keeps the losing copy as a
  conflict copy the app can show, so nothing is silently lost.
- **Deletions stay deleted.** Deleting leaves a permanent marker (ID, stamp,
  "deleted"), so an offline device's older copy can never bring a record
  back. Markers are kept; compacting them is out of scope.
- **Status the app can show.** Synced, waiting, offline, or needs attention
  (with a plain reason), for each record type and overall. No silent failures.

## The Fake Cloud

An in-memory stand-in that behaves like CloudKit's private database in the
ways that matter here: record zones, change tokens, saves that fail when the
cloud copy changed since it was read, batch limits, expired change tokens,
and dropped connections partway through a batch. The real CloudKit adapter
later must pass the same tests the fake passes.

## Tests (Must Pass, Run By One Command)

Every case uses two or three simulated devices and invented records.

1. A change on device A appears on device B after both sync.
2. A and B change different records while offline; both changes survive.
3. A and B change the same record while offline; the registered merge
   function decides, and both devices end with the same result whichever
   syncs first.
4. Same as 3 with no merge function: higher stamp wins, the other copy is kept
   as a conflict copy, and status says "needs attention".
5. A deletes a record; B, offline, edits its older copy; after sync the
   record stays deleted.
6. The connection drops halfway through an upload; after retry, nothing is
   missing and nothing is duplicated.
7. B is offline for many changes, then catches up, including after its change
   token has expired.
8. A device's clock is set an hour wrong; ordering still follows the version
   stamps.
9. The payload bytes that come out on device B are exactly the bytes that went
   in on device A (the core never changes or reads them).
10. Status reports offline, waiting and synced correctly through a sync cycle.

## Out Of Scope For This Slice

Real CloudKit, any Apple account or entitlement, keys and encryption, the Mac
app's storage, the Desk, the iPhone app, sharing between people (Family
spaces), Windows and Android, compacting deletion markers, and any real data.

## Before The Builder's Pull Request Can Merge

The merge gate runs `npm test` for packages today. A small, owner-approved
change to `.github/` makes it also run `swift test` for `packages/sync-core/`.
The planning side opens that pull request; the builder does not touch
`.github/`.

## Rules For The Builder (Next Free GrokBot Team)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Work only in a checkout of this repo, on the branch `OC-261022-sync-core`,
  signed in as `cloudwork-bot`. Open a pull request into `main`. Never push to
  `main` directly.
- Run **no commands on the owner's Mac** for this job. Nothing here needs it.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented records only.
- Change files only under `packages/sync-core/`. Nothing else, not even
  `STATUS.md`: the planning side updates STATUS.md.
- No network calls, no AI, no paid services, in the code or the tests. No
  real CloudKit; the fake cloud only.
- No new dependencies unless unavoidable; list any in the pull request with
  its license. Add no license file and no `license` field.
- Keep the first slice small: the sync logic, the fake cloud, the tests and a
  short README that documents the record shape and the merge-function
  interface. Finishable in two to three days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.

## If GrokBot Stops

If GrokBot's subscription ends before this is finished, the work stays on its
branch. Any agent may finish it from this plan, on the same branch or a new
one named after a new session, under the same rules and review.

## Review And Finish Line

1. The GrokBot team opens the pull request.
2. Codex reviews it as code, round after round, until it finishes with a 👍.
   The builder fixes every P1 and P2, or explains in the pull request why one
   does not apply; P3s are optional. If Codex builds any part of it, Claude
   also reviews it under AGENTS.md's rules for Codex-built work.
3. The planning session or the PR steward checks the result against this
   document, gives the owner a short try-it note (run the tests and read the
   two-device conflict case in plain words), and then switches on auto-merge.
   The merge gate merges it.

Done when the tests pass with one command, Codex has given a 👍 with no open
P1 or P2, and the planning check finds nothing missing from this document.
The owner sees sync working for real only after the next slice wires it to
CloudKit and the apps.
