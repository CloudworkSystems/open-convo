# Step 2 Scope: Protected Storage on the Mac

Written October 12, 2026 by the planning session. The building session builds
it after step 1. Owner decisions are recorded at the end.

## What Already Works (From True Convo)

- **Saves that cannot half-happen.** `apps/mac/Sources/DeskHost/ProofStore.swift`
  is a file-backed store with one writer (`proof.lock`, held with `flock`),
  atomic replace with full flushes, write-ahead dispatch receipts, a durable
  ledger and delivery receipts. A crash leaves either the old state or the new
  one, and unresolved work is reconciled on reopen, never replayed blindly.
- **Key custody rules.** `DeskHost/KeyProvider.swift` defines them: a key is
  created only for a brand-new store; a store whose key is missing refuses to
  open; nothing is regenerated over saved work; nothing falls back to plaintext
  or browser storage; key material never appears in a response, log or file.
- **Lock and unlock.** `DeskWindowKit/DeskLockSignals.swift` locks the Desk when
  the Mac locks, sleeps or switches users. `DeskUnlockVerifier.swift` unlocks only
  through the Mac's own owner check (password, Touch ID or Apple Watch), with no
  bypass.
- **Separate test identity.** True Convo Test keeps its own settings, Keychain
  items and storage, so every step below can be proved there first.

## What Is Missing

1. **Nothing is encrypted.** `ProofStore` writes plaintext JSON, and the only key
   provider is `InventedInMemoryKeyProvider`, a placeholder whose keys vanish when
   the app quits.
2. **No real key custody.** No Keychain item exists yet.
3. **No recovery.** If the key is lost, so is the data.
4. **Dictation history and word fixes are unprotected.** Dictation sessions and
   recordings live under `~/.tca-dictate` (`~/.tca-dictate-test` for the test
   app); saved word fixes are an owner-only (0600) file written by
   `CorrectionMemory/LocalDataBoundary.swift`. Neither is encrypted.
5. **Installing the Desk is blocked on purpose.** `apps/mac/scripts/package_app.sh`
   refuses to install or sign any build that contains the Desk. That block lifts
   only when this step's finish line is met (step 1, PR 4).

## Proposed Pull Requests, in Order

Each is code, so each follows AGENTS.md's code review path. Every one is proved
with invented data in True Convo Test before anything touches the real app.

1. **Real key in Keychain.** Replace the placeholder with a Keychain key
   provider behind the existing `KeyProvider` protocol: a generic-password item
   that is never synchronized to iCloud and is usable only on this Mac
   (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly` or stricter), scoped by the
   app's identity so the test app and the real app never share a key. Never
   exposed to the Desk's web page. Tests: create once, refuse to replace,
   missing item refuses to open, deleted item is reported, not regenerated.
2. **Encrypt the Desk store.** `state.json` and its siblings become authenticated
   ciphertext (CryptoKit: AES-GCM or ChaChaPoly) with a fresh nonce on every
   write, keeping today's atomic replace, lock and receipts. Tampering or a
   wrong key is reported and refuses to open; it never silently resets. Tests:
   wrong key, flipped byte, truncated file, crash mid-write, full disk,
   read-only folder, two windows.
3. **Recovery key.** At store creation the app makes one recovery key, shows it
   once with guided saving (the owner confirms a few characters back), and keeps
   only a copy of the store key wrapped by it. The app never stores the recovery
   key itself. A restore flow opens the store on a wiped Keychain or a
   replacement Mac when the owner types it in. Tests: restore succeeds, wrong
   recovery key refuses, recovery key never appears in any file or log.
4. **Protect dictation history and word fixes.** New dictation sessions,
   transcripts, kept recordings and the word-fix file are written encrypted under
   the same custody. Existing plaintext files are **left untouched** (the app
   already promises never to sweep or migrate the legacy archive); moving them in
   is a separate, opt-in, reversible step the owner approves later.
5. **Kill-and-reopen proof, then the owner's real trial.** A scripted proof in
   True Convo Test: quit, force-kill, sleep, lock, restart and reopen with
   invented data. Then the owner holds one real conversation and it survives a
   restart. Meeting this lifts the install block for step 1, PR 4.

## Requirements Carried From the Durable-Agents Note

- An interrupted reply or run is recorded as **interrupted**, never silently lost
  and never silently re-sent. The receipts in PR 2 must keep that state across
  encryption.
- An action marked irreversible can never be replayed after a restart.

## Risks

- **Locked Keychain at launch.** If the Mac is unlocked but the Keychain item is
  unavailable, the Desk must stay locked with a plain message, never fall back.
- **Time Machine.** Backups will hold ciphertext; the key stays on this Mac.
  Restoring to a new Mac needs the recovery key (PR 3). Say so in the guided
  saving screen.
- **`main.swift` is about 10,900 lines.** PR 4 touches it; keep changes narrow.

## Owner Decisions (October 12, 2026)

1. **Recovery key in step 2**, not deferred to the device-transfer work.
2. **Protect the Desk plus dictation history and saved word fixes**, not the
   Desk alone.
