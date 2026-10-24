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
2. **Next (building lanes):** an adapter from this package to real
   CloudKit; the Mac app's storage split into separately encrypted, stamped
   records it can hand to the sync core; a way for a new device to get the
   keys; and the iPhone app on the same package. This is more than a thin
   adapter: see "Requirements For The Next Slice" below, which its own plan
   must meet. Turning sync on is a one-time host approval in the app
   (foundations principle 6).
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
- **Reconciling after a crash.** In the app, a record and its outbox entry
  live in different places, so a crash can save one without the other. The
  checkpoint keeps, for each record, the last stamp the cloud acknowledged.
  On start, the app hands the sync core every local record in full (ID,
  stamp, record type and opaque payload), and the core makes the outbox
  match the local store both ways. It queues any record whose stamp is newer
  than its last acknowledged one and isn't already queued, using the payload
  it was handed. It drops any queued entry whose record ID and stamp
  aren't in the local store, so an edit that was never saved locally is
  never uploaded and doesn't leave the status stuck on "waiting". An edit
  saved just before a crash is therefore never stranded, and one that wasn't
  saved never leaks out, whichever side was saved first.
- **The clock moves forward.** Every fetched stamp pushes the device's
  logical counter past it, so the next local change always gets a higher
  stamp than anything the device has seen.
- **Conflicts.** A conflict is any upload where the cloud's copy of the
  record differs from the version this device last saw, whichever has the
  higher stamp: two devices edited it while apart. The sync core does not
  pick a winner blindly. It hands both copies to a **merge function
  registered for that record type** and uploads the result, so the edit that
  reaches the cloud second never simply overwrites the first. Stamps decide
  only in the no-merge-function fallback below.
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
- **Merge laws.** With three or more devices, copies can reach the cloud in
  any order and any grouping, so a registered merge function must be
  commutative (`merge(a, b)` equals `merge(b, a)`), associative
  (`merge(merge(a, b), c)` equals `merge(a, merge(b, c))`) and idempotent
  (`merge(a, a)` equals `a`, and merging a copy already folded in changes
  nothing), judged on the decrypted contents. The README states these laws
  as part of the merge-function interface, and the test helper that checks
  them (test 16) is exported so each module's real merge function can be
  checked against them in the next slice.
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
  assets). Oversized payloads never fail silently. The README states the
  limit and why.
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
   syncs first, including when the higher-stamped edit reaches the cloud
   second (the merge function is still called; nothing is overwritten).
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
16. A, B and C each change the same record while offline. For every order
    in which the three reach the cloud (all six), and again when one
    device's sync is replayed, all three devices end with the same contents.
    The stand-in merge function passes a check of the merge laws above; a
    deliberately non-associative stand-in fails that check.
17. A device saves an edit to its local records and is destroyed before its
    checkpoint is saved; recreated from the older checkpoint and reconciled
    against its records, it queues the edit and B has it after sync. In the
    reverse (checkpoint saved with a queued entry, record not saved), the
    entry is dropped: it is never uploaded, B never sees it, status returns
    to synced, and nothing that was acknowledged is lost.

## Out Of Scope For This Slice

Real CloudKit, any Apple account or entitlement, keys and encryption, the Mac
app's storage, the Desk, the iPhone app, sharing between people (Family
spaces), Windows and Android, compacting deletion markers, and any real data.

## Requirements For The Next Slice

Not built in this slice. Written here because Codex's review of #127 found
that the next slice can't be a thin adapter; its own plan must cover each of
these before it is approved. It touches the Mac app's storage and keys, which
are protected paths, so it goes to the owner.

1. **Per-record storage.** The Mac app's protected store seals one whole
   workspace file today; it has no separately encrypted `conversation-page`,
   `task-list` or `memory-item` records with version stamps. The next plan
   defines the record boundaries, gives each record its own encryption and
   version stamp, and migrates an existing store to that shape without loss
   (including a store that is interrupted partway through migrating).
2. **Keys on a new device.** A new iPhone can't decrypt anything with
   today's recovery flow: the recovery secret isn't stored, and only the
   local sealed file can unwrap the store key. The next plan designs an
   authenticated, wrapped store-key envelope that syncs alongside the
   records, how a new device joins (for example, the user enters the
   recovery key once), what happens when the key is replaced (rewrapping,
   and devices that were offline during the change), and how a device is
   removed.
3. **Record and outbox stay in step.** The app either saves a record and
   its outbox entry in one atomic write to its store, or runs the
   reconciliation above on every start; either way it tests a crash on both
   sides of that save.
4. **Real merge functions meet the merge laws.** Each module's
   decrypt-merge-encrypt function passes the test-16 law check before it is
   registered.

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
made while an upload is in flight stays queued (test 15). The one P2 Codex
carried to the builder (the 1 MB field limit, modelled in the fake cloud
with attachments for larger payloads and stated in the README) is written
in above under "Size limits" and test 14; the plan itself is the whole
contract. Its round on `7e98760` added three P1s: the
merge laws and the three-device test are written in above (test 16), and
per-record storage and key provisioning are written in as "Requirements For
The Next Slice". Its round on `406d89c` added a P1 on crashes between
saving a record and saving the outbox, written in as "Reconciling after a
crash" (test 17) and next-slice requirement 3. Its round on `c71c082`
added a P1 on queued entries whose record was never saved (dropped on
reconciliation, test 17) and a P2 to keep the builder's requirements in
this plan rather than on the pull request (done). Its round on `0cf717e` added two
P1s: every divergent cloud copy goes through the merge function, not only
an older-stamped one ("Conflicts"), and reconciliation receives full
records, so it can rebuild an outbox entry with its payload.

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
