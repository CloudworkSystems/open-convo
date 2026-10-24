# Sync core

Sync logic for one person's devices, with an in-memory fake of a private
cloud. Swift only, no Apple-only frameworks. No network, accounts, keys,
iCloud, or real CloudKit. Records in tests and samples are invented.

Run every test:

```sh
cd packages/sync-core
swift test
```

## Record shape

A record is an id, a type (for example `conversation-page`, `task-list`,
`memory-item`), a version stamp, a purged flag, and a payload. The payload
is opaque. This package measures its size and copies the bytes; it never
reads what they mean, and it never sees a key.

The stamp's device ID is the device the change came from.

## Version stamps

A stamp is a logical counter, then wall-clock milliseconds, then device ID.
A higher stamp is later. The counter moves past every stamp the device has
fetched or been handed, so the next local edit sorts above those even when
the wall clock is wrong or set back.

`SyncDevice.nextStamp()` issues the next stamp. Call it only after the first
checkpoint is saved.

## Merge function

Register one with `registerMerge(for:_:)` for a record type. The app supplies
it. In the real app the function decrypts both copies, merges the contents
with that module's own rules, encrypts the result, and returns ciphertext.
Here it is handed the bytes it is handed.

```swift
registerMerge(for: "task-list") { left, right in
    MergeOutput(payload: mergedBytes, purged: false)
}
```

Laws, judged on the payload and the purged flag:

- Commutative: `merge(a, b)` equals `merge(b, a)`.
- Associative: `merge(merge(a, b), c)` equals `merge(a, merge(b, c))`.
- Idempotent: `merge(a, a)` equals `a`, and merging a copy that is already
  folded in changes nothing.

`MergeLaws.check(_:samples:)` reports any break. A type with no merge
function keeps the higher stamp and holds the other copy as a conflict until
the app says it has stored that copy. Sync status is then "needs attention".

Logical deletion is an ordinary payload change and goes through the merge
function. A purge is the record's purged flag. A purge wins over every edit,
whatever the stamp, and the losing payload is not kept.

## Checkpoint

`saveCheckpoint()` returns the outbox, clock, device ID, change tokens,
per-record acknowledgement, and conflict copies as bytes. `restore(from:)`
brings that device back, including its ID. Restoring with a different
expected ID fails.

A new device accepts no edit until that first checkpoint exists. On launch
the app calls `reconcile` with every local record. The core queues this
device's edits that the cloud has not acknowledged, drops queued edits the
store does not have, and moves the clock past the stamps it was given.
Register merge functions again after restore; they are code, not checkpoint
data.

An upload waits until the checkpoint contains the entry and the app has
confirmed the local save (`confirmLocalSave`). A download's change token is
stored only after the app has confirmed every record in that page.

## Size limit

CloudKit refuses an ordinary record field over 1 mebibyte (1,048,576 bytes).
The fake cloud refuses those fields too. Payloads at or under
`SyncLimits.inlinePayloadLimit` (that limit minus 64 KiB) stay ordinary
fields. The 64 KiB is room for encryption overhead and record metadata in
the real adapter. Larger payloads travel as asset-style attachments. An
oversized ordinary field is a reported error, never a silent drop.

## Fake cloud

`FakeCloud` is the stand-in the tests sync through: zones, change tokens,
saves that fail when the cloud copy changed, batch limits, expired tokens,
dropped connections, the field limit, and attachments. The real CloudKit
adapter is a later slice and has to satisfy the same tests.

## Out of scope

Real CloudKit, Apple accounts, keys, encryption, the Mac app's storage, the
Desk, the iPhone app, sharing between people, Windows, Android, compacting
deletion markers, and any real data.
