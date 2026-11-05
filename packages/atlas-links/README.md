# Atlas link repair

A folder of markdown notes goes in. Links that broke because a note moved, and a list of links that need a person, come out. The library does not read or write files, and it does not use the network. The command reads one folder and, only with `--write`, updates the notes it can repair.

Node 22 or later. No dependencies.

```sh
cd packages/atlas-links
npm test
```

## The rule

`planRepairs(notes, snapshot)` takes the same `{ path, text }` notes as atlas-index. `snapshot` is `{ notes: [{ path, sha256 }] }` from the last run, or `null` when there is none.

A link is broken by the same rules atlas-index uses. For each broken link, the file name it was looking for is compared with every note's file name, ignoring letter case. When exactly one note matches, and the snapshot shows that note moved unchanged, the link is repaired. The old target has to be gone, the matching note has to be new since the snapshot, and its SHA-256 has to equal the hash stored for the old path. Anything else is listed under `needsYou` with the candidate paths and a reason. A link is never repaired so that it points at its own note.

A markdown target becomes the relative path, with each segment percent-encoded the way atlas-index writes links, keeping any `#anchor` or `?query`. A `<...>` destination is replaced by that plain encoded path. A wiki name becomes the note's file name as spelled on disk, keeping any anchor or label. If that name is not a safe unique wiki link, the path without `.md` is used instead. If that is not safe either, the link is left for the person.

Generated indexes are skipped. In `MAP.md`, only the hand-written part before `<!-- atlas-index:start -->` is read, and the bytes from the marker on are never changed.

## Command

From the repo root:

```sh
node packages/atlas-links/src/repair.mjs --dir <folder>
node packages/atlas-links/src/repair.mjs --dir <folder> --json
node packages/atlas-links/src/repair.mjs --dir <folder> --record
node packages/atlas-links/src/repair.mjs --dir <folder> --write
node packages/atlas-links/src/repair.mjs --dir <folder> --unlock
```

Without `--write` it changes nothing. It prints each repair as `path:line from → to` and each link that needs a person. `--json` prints the result. `--record` saves the snapshot and changes nothing else. `--write` applies the repairs and saves the snapshot when every planned repair was written. A skipped repair keeps the old snapshot, updates the hashes of notes this run did rewrite, and says `Kept the old snapshot so the skipped links can be repaired next run.`

The snapshot is `<folder>/.atlas-links/paths.json`. It holds paths and SHA-256 hashes only. A missing snapshot is `null`. An unreadable or malformed snapshot refuses the run, including `--record` and a run that is finishing a journal, before any alias is applied. `--record` does not replace a damaged snapshot. A snapshot saved after a successful `--write` re-reads notes this run did not change, so an edit made while the command waited is the hash that is stored. `.atlas-links` is refused when it is a symbolic link.

One `--write` or `--record` runs at a time. The lock is `.atlas-links/run.lock`, and a second run stops without writing. A lock whose process on this computer is gone, or a lock that is empty or unreadable, is cleared with `An earlier run stopped without finishing; cleared its lock.` A lock from another computer is left alone. Recovering a stale lock takes `.atlas-links/run.lock.reclaim` first. If that reclaim lock is already held, the run says `Another command is recovering; try again in a moment.` If the reclaim lock's process is gone, it is left in place. `--unlock` removes it after checking that process is gone.

Before it changes a note, `--write` saves `.atlas-links/journal.json` with each planned note's path and its hash before and after. If a destination check drops some of that note's repairs, the journal's after-hash is rewritten to the bytes actually written, before the note is renamed. Entries for notes an earlier run already finished are kept in that journal, so a second interruption does not forget those moves. When that same note is repaired again, the new entry still starts at the original hash. The journal is removed only after the snapshot is saved or kept. A later run treats a note whose bytes match the journal's after-hash as still matching the before-hash, then finishes the snapshot.

`--write --pause-before-write` prints `Paused before writing. Change a note now if you're testing, then press Enter.` and waits for Enter.

A refusal prints one plain message and exits 1. A result exits 0.

## Owner trial

On a copy of a small notes folder (never the only copy):

1. Run the command with `--record` once, then move one note into a new folder.
2. Run the command without `--write`: it lists the repairs it would make.
3. Run it with `--write`, then run atlas-index on the folder: those links are no longer broken, and nothing else in the notes changed.
4. Give two notes the same name and see both listed. Delete a moved note and see it listed with no candidates. Run on a fresh copy with no snapshot and see the `run --record` advice. Stop a `--write` part-way and see the next run finish with nothing left half-done. Add a file that isn't valid UTF-8 and see the whole run refused with the file named. Run `--write --pause-before-write`, edit one of the listed notes while it waits, press Enter, and see that note skipped and named while the others are written.

## Edge cases

Each of these is covered by a test.

- The same notes produce byte-identical JSON in either input order. Repair fields are `path`, `line`, `from`, and `to`. `needsYou` fields are `path`, `line`, `link`, `candidates`, and `reason`. `counts` are `notes`, `broken`, `repairs`, and `needsYou`. `counts.notes` does not include a generated index. `counts.broken` counts every occurrence, so two identical `[[seeds]]` links are two repairs even though atlas-index lists that detail once. The set of path plus detail still matches atlas-index's broken links.
- A wiki link that already matches one note is left alone, including a match on a front matter `name:`. Two notes that share a name make a broken link `needsYou` only when the link does not already match. `[[Flour]]` with `baking/flour.md` and `shop/flour.md` is listed. `[[flour]]` would already match those files, so it is not broken.
- A `?query` on a destination is kept, the same way an `#anchor` is kept. A `<...>` destination is replaced, brackets included, by the plain encoded path.
- A link whose `%` encoding cannot be read is `needsYou` with no candidates. A link from a note to itself is `needsYou` even when the snapshot shows a move.
- A generated index, including one that starts with a byte-order mark, is not searched and is not a repair target. Links in fenced code, inline code, and front matter are not searched. `https:`, `mailto:`, and a leading `/` are not links.
- Only the target text changes. CRLF line endings and a missing final newline stay as they were. The bytes in `MAP.md` from the marker on stay as they were.
- Paths that are empty, absolute, contain a backslash or a control character, or use `..` are refused. Two paths that are the same after Unicode NFC are refused. A snapshot must be an object or `null`. Unknown snapshot fields are refused. A hash must be 64 lowercase hex characters. The notes passed in are not changed.
- A file that is not valid UTF-8 refuses the run before a note or a snapshot is written, and the message names the file. A leading byte-order mark is kept and the note is still read. A folder that contains `.git`, including this repository's root, is refused. Hidden folders and symbolic links are not read. A symbolic link `.atlas-links` is refused.
- A dry run writes nothing and does not create `.atlas-links`. `--record` writes `paths.json` as mode `0600` and creates `.atlas-links` as mode `0700`. `--write` keeps each note's mode. A second `--write` finds nothing left to repair. A snapshot whose `notes` list is not usable, including `null`, is refused before a journal is applied, and the file is left as it is. A note this run did not write is hashed again from the disk before a successful snapshot is saved, so an edit made during the pause is the stored hash.
- A note edited between the scan and its rename is skipped and named. The other notes are still written. The old snapshot is kept, with the hash of each note this run rewrote updated and its path unchanged, so the next run can repair the skipped link.
- Just before a note is written, every destination is checked again. It must still be a regular file inside the folder, and its SHA-256 must still match the move, or match the bytes this same run already wrote. Deleting, editing, replacing, or replacing the destination with a symbolic link skips the repairs that point at it and keeps the old snapshot. Two moved notes that link to each other are both repaired in one run.
- A run that stops after a note is written and before the snapshot is renamed leaves the journal. `--record` is refused until `--write` finishes that journal. The next `--write` still repairs the skipped link, then removes the journal. When a destination check drops some of a note's repairs, the journal records the hash of the partial note before that note is renamed, so the next run can still see the move. A later journal keeps the entries for notes an earlier run already finished, and a further repair of that same note still starts at the original hash, so two interruptions in a row can still repair a link to that moved note.
- An empty `run.lock`, or one whose process on this computer is gone, is cleared and the run continues. A lock from another computer is not removed. A dead `run.lock.reclaim` is not removed until `--unlock`. While one run holds the reclaim lock, a second run stops and writes nothing. While one `--write` is paused, a second `--write` stops and writes nothing.
