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
5. **The Desk can now be installed before its storage is protected.** Step 1,
   PR 4 (#13) let `apps/mac/scripts/package_app.sh` install a Desk build from a
   clean checkout, with the owner's approval. Until this step lands, the
   installed Desk keeps plaintext, invented-data storage: real private material
   stays out of it, and the Desk should say so plainly.

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
   *As built (October 13):* split in two. **PR 2** encrypts the store's
   state and attempted records (AES-256-GCM, fresh nonce per write, each file
   bound to its store and role) while the Desk keeps its in-memory key, so a
   real key never guards plaintext. **PR 2b** switches the Desk to the
   Keychain key and lets it reopen its store after a restart: one
   `kept-store/` folder inside the Desk's base folder, made on the first
   unlock. Builds before it only ever made and opened `run-` folders, so they
   never touch it; earlier run folders are left exactly as they were. The
   workspace marker stays plaintext: it holds only ids and the format version.
   The Desk still shows "invented data only" until PR 5's proof and trial.
3. **Recovery key.** At store creation the app makes one recovery key, shows it
   once with guided saving (the owner confirms a few characters back), and keeps
   only a copy of the store key wrapped by it. The app never stores the recovery
   key itself. A restore flow opens the store on a wiped Keychain or a
   replacement Mac when the owner types it in. Tests: restore succeeds, wrong
   recovery key refuses, recovery key never appears in any file or log.
   *As built (October 13):* split in two. **PR 3** is the core: a 256-bit
   recovery key written as 55 Crockford base32 characters, the last three
   check symbols over GF(32) that catch any single mistyped character before
   decryption, the store key sealed under it in
   `recovery-key.sealed` (HKDF-SHA256 per store, AES-GCM, bound to the store
   id), a new recovery key retiring the old copy, and a restore that hands
   the store key back to the Keychain without ever replacing a held key.
   **PR 3b** is the guided screens: while the open Desk has no confirmed key,
   a row offers "Make Recovery Key…"; the key is shown once, then two random
   groups must be typed back; the store notes the confirmation as a hash of
   the copy it vouches for, so a new key reads as unconfirmed. When the
   Keychain key is missing, "Restore With Recovery Key…" puts it back and
   leaves the Desk locked for a normal unlock.
4. **Protect dictation history and word fixes.** New dictation sessions,
   transcripts, kept recordings and the word-fix file are written encrypted under
   the same custody. Existing plaintext files are **left untouched** (the app
   already promises never to sweep or migrate the legacy archive); moving them in
   is a separate, opt-in, reversible step the owner approves later.
   *As built (October 14):* split in three, on the owner's answers (words
   first; app-only reading is fine; one recovery key for everything).
   **PR 4** seals the words: the archive gets its own Keychain key
   (`<app's Keychain service>.archive-key`, this-device-only, never
   synchronized) named by a plaintext marker, `protected-archive.json`, under
   the Desk store's custody rules (made only when there is no marker; a
   missing key is reported, never replaced; no plaintext fallback). New
   history lines, transcripts, content packets, the latest-* copies, the
   reports and handoffs built from history, and the word-fix file are
   AES-256-GCM, each bound to its path in the archive. Sealed files are
   written as text that says what they are; the app shows them in its own
   read-only window. Earlier per-session files and history lines stay
   plaintext and are still read; files the app rewrites in place (the
   latest-* copies, the reports, the word-fix file) become sealed on their
   next write. While the key is missing, dictation still pastes but nothing
   new is saved, and saved word fixes stay closed. **PR 4b** puts the
   archive key under the same recovery key as the Desk. **PR 4c** seals kept
   recordings.
5. **Kill-and-reopen proof, then the owner's real trial.** A scripted proof in
   True Convo Test: quit, force-kill, sleep, lock, restart and reopen with
   invented data. Then the owner holds one real conversation and it survives a
   restart. Meeting this is what makes the installed Desk safe for real private
   material.

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
