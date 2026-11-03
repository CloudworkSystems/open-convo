# Approval ledger

This package records a person's yes before a host starts an outside action. It does not run actions.

Important limit: the included file store detects restoring the ledger folder alone, but it cannot detect restoring an older backup of both the ledger and store together. A real outside action must not use this package until True Convo supplies protected storage with a counter kept outside backups.

## Record and rules

The append-only `ledger.json` contains hash-linked entries whose `type` is `asked`, `answered`, `claimed`, `finished`, `withdrawn`, or `reset`. (`kind` on an `asked` entry is the action kind.) The separate store records the head hash, entry count, and every request id ever used. Files are created with mode `0600`.

Only a `yes` whose source is `person` can be claimed. A claim must match the request's action id and digest, must arrive by its supplied expiry, and can succeed once. The last answer before a claim wins. A withdrawal cancels an unclaimed yes. A claim without a finish is reported as `inFlight`, meaning the action may or may not have happened.

Every write re-reads and verifies both files while holding an exclusive lock. A stale lock is left for a person to inspect. Changed, missing, reordered, rolled-back, or symlinked data stops claims until reset. Reset starts a new chain and retains protected request ids, so old ids cannot be asked or answered again.

## API

Import `openApprovalLedger({ ledgerDir, storePath })` from `src/index.mjs`. The store path must be outside the ledger folder. All calls are asynchronous.

- `ask`, `answer`, `withdraw`, `claim`, `finish`
- `status(requestId)`, `pending(now)`, `history({ from, to })`
- `verify()`, `reset()`

Every time value is supplied by the caller as an RFC 3339 UTC instant. No function reads the current time. Results are `{ ok: true, ... }` or `{ ok: false, reason }`.

The read-only command supports `status`, `pending`, `history`, and `verify`:

```sh
node src/ledger.mjs --dir /tmp/invented-ledger --store /tmp/invented-state/head.json verify
```

## Invented sample and owner trial

The driver takes only a folder and one fixed verb. It never takes action text, records a fixed invented action, and runs nothing. It creates a missing or empty root with a `SAMPLE-ONLY` marker and refuses any other folder.

```sh
node src/sample.mjs --dir /tmp/approval-ledger-sample ask
node src/sample.mjs --dir /tmp/approval-ledger-sample yes
node src/sample.mjs --dir /tmp/approval-ledger-sample claim
node src/sample.mjs --dir /tmp/approval-ledger-sample claim
```

The first claim succeeds and the second says the yes was already used. The other verbs are `no`, `withdraw`, `finish`, `reset`, and `lock`. Use a fresh sample folder for each scenario. `lock` leaves the lock in place to demonstrate the crash message. To test rollback detection, copy `ledger/`, add another entry, restore only that older `ledger/`, then run the read-only `verify` command. To test editing, change an entry in `ledger/ledger.json`, verify that claims stop, then run `reset`. After reset, the old request id remains unusable.

## Edge cases

- Ancestor aliases such as macOS `/tmp` are resolved once, and all later file operations use those real locations, so swapping an alias cannot redirect saves. Symlinks in the ledger tree or at the store, journal, or lock cause refusal, including during reset.

- Interrupted saves use `<storePath>.journal.json` beside the store: reads validate its consistent pair without writing, and the next write or reset finishes it under the lock. Restoring the ledger folder alone cannot restore this journal or the store, so their checks still catch an older ledger.

- Used ids include both individual request entries and the lists inside reset entries. Verification requires the store to contain all of those ids. Reset preserves both sources, and refuses malformed reset lists or an unreadable ledger with no readable store.

- A missing store beside a nonempty ledger is damage. Reset refuses rather than replacing the protected used-id list with an empty list. Only an empty ledger can initialize a missing store.

- Approval views and claims use only the last person answer. Agent and system answers remain in history and appear in `status().ignoredAnswers`.
- Reads create, change, and delete no files and ignore stale locks. If a valid chain disagrees with the store, reads retry up to 20 times with a fixed 5 ms timer delay, without reading the clock. A persistent mismatch still reports damage, including an older restored ledger.

- Expiry is inclusive: a claim exactly at `expiresAt` is allowed; one millisecond later is refused.
- Reset refuses damaged data when the protected store no longer contains a readable used-id list. Losing those ids would permit reuse.
- A request id is reserved at `ask`, even if the person says no, it expires, or the ledger is later reset.
- Empty ledgers are valid only when the protected store also says the head and count are empty.

## Tests

Requires Node 22 or later. The tests use invented data only.

```sh
npm test
```
