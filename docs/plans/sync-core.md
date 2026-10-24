# Sync Core (PRD)

Status: Draft (Oct 24): in review on #127; GrokBot team B builds it once it merges.

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
  device it came from, a "purged" flag (sync metadata, see "Two kinds of
  deletion"), and an encrypted payload the sync core never opens. The sync
  core never sees a key or plaintext.
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
  logical clock, retry records and each record's last acknowledged stamp
  and last-seen change tag are saved through a checkpoint: the package
  exports its sync state as bytes and restores it from bytes. The app stores
  those bytes in its protected store later; in this slice tests keep them in
  memory or a temporary file. A device that quits mid-sync and reopens from
  its checkpoint loses no unsent change and duplicates nothing.
- **Reconciling after a crash.** In the app, a record and its outbox entry
  live in different places, so a crash can save one without the other. The
  checkpoint keeps, for each record, the last stamp the cloud acknowledged
  and the last cloud version (change tag) the device saw, updated on every
  acknowledged upload and every applied fetch, so it doesn't depend on the
  outbox entry surviving. On start, the app hands the sync core every local record in full (the
  whole record shape above, including the purged flag), and the core makes the outbox
  match the local store both ways. It queues any record whose stamp is newer
  than its last acknowledged one, carries this device's ID (so it is a
  local edit or a local merge result, not a copy fetched from another
  device; the device ID is part of the checkpoint, so a device recreated
  from its checkpoint keeps the same ID, and the core refuses to start
  from a checkpoint with a different ID passed in) and isn't already queued, using the payload
  it was handed and that record's saved change tag as the entry's base, so
  an edit another device made in the meantime is still found as a conflict
  and merged. (If the saved tag is older than the true base, the only cost
  is a merge that changes nothing, since merges are idempotent.) It also
  pushes the logical counter past every local stamp it was handed, so the
  next local edit can't reuse or sort below a stamp saved just before the
  crash. A record whose stamp carries another device's ID was fetched, not
  edited here, so reconciliation never queues it, even when a crash lost
  the checkpoint that recorded the fetch; when that fetch is replayed from
  the older change token, a fetched copy with the same stamp as the local
  record counts as already applied, with no conflict and no merge. The same
  holds for uploads: an outbox entry, of any kind, is uploaded only after
  both the checkpoint holding it is saved and the app confirms it saved the
  matching local record, so the cloud never receives an edit the device
  could still drop on reconciliation; and whenever an upload or a fetch meets a cloud copy
  with the queued entry's record ID and stamp, that entry counts as
  acknowledged, whatever base it carries, with no conflict, no merge and no
  new revision. It drops any queued entry whose record ID and stamp
  aren't in the local store, so an edit that was never saved locally is
  never uploaded and doesn't leave the status stuck on "waiting". An edit
  saved just before a crash is therefore never stranded, and one that wasn't
  saved never leaks out, whichever side was saved first.
- **The clock moves forward.** Every fetched stamp, and every local stamp
  handed over in reconciliation, pushes the device's logical counter past it, so the next local change always gets a higher
  stamp than anything the device has seen.
- **Conflicts.** Every outbox entry saves the cloud version (change tag) its
  edit was based on, and keeps it through checkpoints and through later
  fetches. A conflict is any upload where the cloud's copy differs from that
  base version, whichever has the higher stamp: two devices edited it while
  apart. Fetching another device's edit before uploading doesn't move the
  base, so the queued edit is still merged with it, never written over it.
  A fetch never replaces a local record that has a queued edit: the core
  first merges the fetched copy with the queued edit, queues the result
  with the fetched version as its new base, and only then hands it to the
  app to save. With no merge function it applies the same "higher stamp
  wins" rule an upload would: if the queued edit has the higher stamp, it
  stays queued with the fetched version as its new base and the fetched
  copy is saved as a conflict copy; if the fetched copy is higher, it
  replaces the local record, the queued edit leaves the outbox and is kept
  as a conflict copy, and nothing is uploaded. Either way the result
  doesn't depend on whether the fetch or the upload ran first. So the local store always holds
  the version that is queued, and reconciliation after a restart finds it.
  The record's last-seen change tag moves to the fetched version only once
  the app confirms it saved the merged record (and the fetch's change token
  is saved only then too). The same holds for every fetched record, merged
  or not: a fetch's change tags and change token reach the checkpoint only
  after the app confirms it saved every record that fetch covers, so a
  crash between the two replays the fetch instead of skipping a record. If the device crashes after queuing the merge
  but before that save, reconciliation drops the merged entry, re-queues
  the old local edit with its old base, and the next upload finds the
  conflict and merges again, so the other device's edit is never written
  over. A merged entry also becomes uploadable only once the app confirms
  that local save, so the cloud can't commit a merge result the device
  might still drop. The sync core does not
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
  conflict copy the app can show, so nothing is silently lost. Conflict
  copies are part of the checkpoint until the app confirms it has saved
  them in its own store, so a quit before then doesn't lose them.
- **Retries reuse the merge result.** The merge result is stamped and saved
  in the outbox (and so in the checkpoint) before it is uploaded, and a
  retry sends those same bytes; the merge function is not called again for
  that conflict. If the cloud saved the result but the answer was lost, the
  next fetch finds the cloud copy carrying that stamp and treats it as
  acknowledged, so no second revision is written. (Encryption with a fresh
  nonce would make a re-run merge produce different bytes, so re-running it
  can't be how a retry works.)
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
  back. "Purged" is sync metadata the core reads, not part of the opaque
  payload, and it wins over every edit whatever its stamp, with or without
  a merge function: a device whose counter ran ahead through other work
  still can't revive a purged record. When a purge wins, the losing payload
  is discarded, not kept as a conflict copy (the conflict-copy fallback
  never applies to a purge), and any queued edit to that record leaves the
  outbox, so no purged content stays on any device. Markers are kept;
  compacting them is out of scope.
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
   as a conflict copy, and status says "needs attention". When the device is
   recreated from its checkpoint before the app confirms it saved the
   conflict copy, the copy is still there and the status still says "needs
   attention". Also run with A fetching B's version before A uploads, once
   with A's stamp lower and once higher: both devices end with the
   higher-stamped version and the other kept as a conflict copy, the same
   as when A uploads first.
5. A logically deletes a record; B, offline, edits its older copy; after
   sync the deletion wins (older edit). Then A restores the record with a
   later stamp; after sync it is back on both devices.
5b. A purges a record; B, offline, edits its older copy; after sync the
   record stays purged and cannot come back. This holds when B's edit has a
   higher stamp than the purge (B's counter ran ahead through other work)
   and the record type has no merge function. Afterwards neither device
   holds B's edited payload anywhere: not as the record, a conflict copy or
   an outbox entry.
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
    entry is dropped: it is never uploaded (the uploader was holding it for
    the app's save confirmation, so the cloud received nothing even while A
    was still online), B never sees it, status returns to synced, and
    nothing that was acknowledged is lost. A third case: A
    saves a purge marker locally and is destroyed before its checkpoint;
    after reconciling, the purge is queued as a purge, reaches the cloud, and
    a stale edit from B still can't bring the record back. A fourth case: A
    saves an edit locally and is destroyed before its checkpoint, and B
    changes the same record and syncs before A restarts; after reconciling,
    A's upload is treated as a conflict against B's version and merged, so
    B's edit isn't overwritten. In the first case, A then makes another local
    edit (with its wall clock set back), which gets a higher stamp than the
    reconciled one and reaches B. A fifth case: A fetches B's edit and
    saves it locally, then is destroyed before its checkpoint; after
    reconciling and fetching again, A uploads nothing for that record, the
    merge function isn't called, and both devices hold B's version. A sixth
    case: the cloud saves A's upload, then A is destroyed before the
    checkpoint that records the acknowledgement; after reconciling, A's
    rebuilt entry is recognized as already in the cloud, the cloud holds
    exactly one revision of that edit, the merge function isn't called, and
    status returns to synced. A seventh case: A fetches B's edit, the app's
    save is held back, and A is destroyed; recreated from its checkpoint,
    A fetches the edit again and saves it. Every case recreates A from the
    checkpoint alone, without passing in its device ID again, and A keeps
    its ID.
18. A merged result is saved by the cloud but the connection drops before
    A hears back. After A retries, the cloud holds exactly one new revision,
    the merge function was called once for that conflict, and B ends with
    the same bytes A saved. The stand-in merge function for this test adds
    random bytes to its output, as real encryption would.
19. A edits a record offline and queues it; B edits the same record and
    syncs; A then fetches before it uploads. A's upload still goes through
    the merge function, and both devices end with both edits. The same holds
    when A is recreated from its checkpoint and reconciled after the fetched
    copy was saved locally and before the upload: A's edit is not dropped.
    And when A is destroyed after the merged entry reaches its checkpoint
    but before the merged record is saved locally, A reconciles from the old
    local edit, the upload is still treated as a conflict, and both devices
    end with both edits. The merged entry isn't uploaded in that window:
    with the app's save held back, the cloud receives nothing for that
    record until the save is confirmed.

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
records, so it can rebuild an outbox entry with its payload. Its round on
`20b4dc9` added a P1 on retrying an encrypted merge, written in as "Retries
reuse the merge result" (test 18). Its round on `fd602d9` added a P1: each
outbox entry keeps the cloud version its edit was based on, so a fetch
before upload can't hide a conflict ("Conflicts", test 19). Its round on
`88dfe79` added two P1s: a fetch merges with a queued edit before the local
record is replaced, so reconciliation can't drop it (test 19), and "purged"
is sync metadata that beats any stamp (test 5b). Its round on `ba4386e`
added a P1: the purged flag is part of the record shape reconciliation
receives (test 17). Its round on `0c40e11` added two P1s: the checkpoint
keeps each record's last-seen change tag so reconciliation can rebuild the
base, and reconciliation pushes the logical clock past every local stamp
(test 17, fourth case and the follow-up edit). Its round on `93bfb99`
added two P1s: conflict copies stay in the checkpoint until the app has
saved them (test 4), and a fetch-merge moves the record's base only after
the merged record is saved locally (test 19). Its round on `db8b8d2` added
a P1: with no merge function, a fetch applies "higher stamp wins" too, so
the result doesn't depend on fetch-or-upload order (test 4). Its round on
`da67bdb` added a P1: reconciliation queues only stamps carrying this
device's ID, and a replayed fetch with an equal stamp is already applied
(test 17, fifth case). Its round on `7b3c28a` added a P1: an entry uploads
only once it is checkpointed, and a cloud copy with its ID and stamp counts
as its acknowledgement (test 17, sixth case). Its round on `ab45302` added
two P1s: the device ID is kept in the checkpoint, and a fetch's change
token waits for the app's save of every record it covers (test 17, seventh
case). Its round on `bd3d676` added
two P1s: a winning purge discards the losing payload instead of keeping a
conflict copy (test 5b), and a merged entry uploads only after the app
confirms the local save (test 19). Its round on `4db0ee9` added a P1:
every entry, not only a merge, waits for the app's local-save
confirmation before it uploads (test 17, reverse case).

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
