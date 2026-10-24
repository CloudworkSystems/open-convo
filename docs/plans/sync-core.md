# Sync Core (PRD)

Written October 22, 2026 by the planning session from the owner's decisions
that day (recorded in [docs/decisions.md](../decisions.md)). Session name:
`OC-261022-plan-day-one-and-sync`. Umbrella: Personal. First slice of the
iPhone and sync line (PLAN.md, "Day One And Public Launch"). Built by an
outside builder under AGENTS.md "Outside Builders": **GrokBot team B**
builds it as its next module, working through Cursor and signed in as
`cloudwork-bot`; Codex reviews. It takes one of the five outside-builder
places (owner decision, October 23).

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
  scratch if the token has expired, with the same end result. A change token
  is saved only after every record it covers has been applied, so a download
  cut off partway resumes from the last safely applied token. An upload is
  acknowledged by record ID *and* stamp: if the record changes locally while
  an upload is in flight, the acknowledgement clears only the version that
  was sent, and the newer version stays queued until it reaches the cloud.
- **Survives quitting.** The outbox, the last applied change token, the
  logical clock and retry records are saved through a checkpoint: the package
  exports its sync state as bytes and restores it from bytes. The app stores
  those bytes in its protected store later; in this slice tests keep them in
  memory or a temporary file. A device that quits mid-sync and reopens from
  its checkpoint loses no unsent change and duplicates nothing.
- **The clock moves forward.** Every fetched stamp pushes the device's
  logical counter past it, so the next local change always gets a higher
  stamp than anything the device has seen.
- **Conflicts.** When the cloud already holds a newer version of a record,
  the sync core does not pick a winner blindly. It hands both copies to a
  **merge function registered for that record type** and uploads the result.
  **Where decryption happens:** the merge function is supplied by the app,
  which holds the keys. It decrypts both copies, merges the contents with the
  module's own merge rules (for task lists, the household lists engine's
  rules), encrypts the result and hands back ciphertext. The sync core still
  never sees keys or plaintext. In this slice the tests register a stand-in
  merge function over invented, unencrypted test bytes; wiring the real
  decrypt-merge-encrypt function, including calling the JavaScript list
  engine from the app, is the next slice's job. A record type with no merge
  function falls back to "higher stamp wins" and keeps the losing copy as a
  conflict copy the app can show, so nothing is silently lost.
- **Two kinds of deletion.** A *logical deletion* (removing an item or list,
  reversible until Trash is emptied) is an ordinary stamped change: it wins
  over earlier edits and loses to a later edit or re-add, matching the
  household lists engine's rules, and it goes through the registered merge
  function. A *purge* (emptying Trash) leaves a permanent marker (ID, stamp,
  "purged") so no older copy, from any device, can ever bring the record
  back. Markers are kept; compacting them is out of scope.
- **Size limits.** CloudKit refuses ordinary record fields over 1 MB. The
  sync core sets a payload limit below that, leaving room for encryption
  overhead and metadata, and stores larger payloads as asset-style
  attachments in the fake cloud (as the real adapter will with CloudKit
  assets). Oversized payloads never fail silently.
- **Status the app can show.** Synced, waiting, offline, or needs attention
  (with a plain reason), for each record type and overall. No silent failures.

## The Fake Cloud

An in-memory stand-in that behaves like CloudKit's private database in the
ways that matter here: record zones, change tokens, saves that fail when the
cloud copy changed since it was read, batch limits, expired change tokens,
dropped connections partway through a batch (uploads and downloads), the
1 MB limit on ordinary record fields, and asset-style attachments for larger
payloads. The real CloudKit adapter
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
5. A logically deletes a record; B, offline, edits its older copy; after
   sync the deletion wins (older edit). Then A restores the record with a
   later stamp; after sync it is back on both devices.
5b. A purges a record; B, offline, edits its older copy; after sync the
   record stays purged and cannot come back.
6. The connection drops halfway through an upload; after retry, nothing is
   missing and nothing is duplicated.
7. B is offline for many changes, then catches up, including after its change
   token has expired.
8. A device's clock is set an hour wrong; ordering still follows the version
   stamps.
9. The payload bytes that come out on device B are exactly the bytes that went
   in on device A (the core never changes or reads them).
10. Status reports offline, waiting and synced correctly through a sync cycle.
11. The connection drops partway through B's paginated download; after retry
    from the last safely applied token, nothing is missing or duplicated.
12. B fetches a record whose stamp counter is far above its own, then makes a
    local change; the new change's counter is higher than the fetched one and
    wins over it.
13. A device is destroyed and recreated from its checkpoint in the middle of
    an upload and again in the middle of a download; after it syncs, nothing
    is lost or duplicated.
14. A payload over the field limit goes as an attachment and arrives on B
    byte for byte; a payload under the limit stays an ordinary field.
15. A's upload of a record is held before the cloud answers; A edits the same
    record; then the upload completes. Only the uploaded version is
    acknowledged, the newer edit stays queued, and after the next sync B has
    the newer edit.

## Out Of Scope For This Slice

Real CloudKit, any Apple account or entitlement, keys and encryption, the Mac
app's storage, the Desk, the iPhone app, sharing between people (Family
spaces), Windows and Android, compacting deletion markers, and any real data.

## Before The Builder's Pull Request Can Merge

The merge gate runs `npm test` for packages today. A small, owner-approved
change to `.github/` makes it also run `swift test` for `packages/sync-core/`.
The coordinator opens that pull request; the builder does not touch
`.github/`.

## Rules For The Builder (GrokBot Team B)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Work only in a checkout of this repo, through Cursor, on the branch
  `OC-261022-sync-core`, signed in as `cloudwork-bot`. Open a pull request
  into `main` with auto-merge off and the label `agent: grokbot`. Never push
  to `main` directly, and never switch on auto-merge.
- Mark the work as AGENTS.md "Accounts And Provenance" says: `Cursor Agent`
  as commit author, and `— GrokBot team B` as the last line of the pull
  request description and every comment.
- Run **no commands on the owner's Mac** for this job. Nothing here needs it.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented records only.
- Change files only under `packages/sync-core/`. Nothing else, not even
  `STATUS.md`: the coordinator updates STATUS.md.
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

## Review History

Codex reviewed this plan on pull request #116 (October 22). Its P1 findings
are written in above as requirements: durable checkpoints, safe change
tokens on interrupted downloads, the clock moving past fetched stamps, where
decryption and content merging happen, and logical deletion versus purge.
Its P2 on CloudKit's 1 MB field limit is also written in. Its last round on
`faa5594` (reviewed again as #127) added one P1, written in above: an edit
made while an upload is in flight stays queued (test 15). The P2s Codex
raised are listed on #127 under "Requirements carried to the code pull
request" for the builder to meet.

## Review And Finish Line

1. The GrokBot team opens the pull request.
2. Codex reviews it as code, round after round, until it finishes with a 👍.
   The builder fixes every P1 and P2, or explains in the pull request why one
   does not apply; P3s are optional. If Codex builds any part of it, Gemini
   reviews that work as AGENTS.md "Gemini reviews" says.
3. The coordinator (the Claude thread "261012 OC Coordinator") checks the
   result against this document and the requirements carried on #127, posts
   the check on the pull request, gives the owner a short try-it note (run
   the tests and read the two-device conflict case in plain words), and then
   switches on auto-merge. The merge gate merges it; the owner doesn't click
   Merge.

Done when the tests pass with one command, Codex has given a 👍 with no open
P1 or P2, and the coordinator's plan check finds nothing missing from this
document.
The owner sees sync working for real only after the next slice wires it to
CloudKit and the apps.
