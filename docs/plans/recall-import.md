# Recall Import, Behind A Knowledge Source Slot (PRD)

Status: Draft (Nov 3): waiting on the owner's yes in the Claude thread "Draft next plans for outside builders".

Written November 3, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261103-recall-import`. Umbrella: Personal. **Builder:** Codex team A,
under AGENTS.md "Outside Builders". **Reviewers:** Codex reviews every
push; GrokBot or a fresh Claude gives the independent review with the
risk-review checklist; the coordinator checks it against this plan.
**Finish line:** the package merges with `tests` passing, its command turns
the invented sample export in the package into Atlas source notes that
`packages/atlas-index/` indexes without errors, and the owner trial below
passes.

## Why

The owner uses Recall (a paid knowledge tool) and wants it kept, not
copied (owner rule, November 3, 2026: connect the paid tools he already
uses, and put each connection behind a documented slot with a guide, so
anyone can build a True Convo-native replacement later). Recall's web app
exports the whole knowledge base as a zip of Markdown files (Settings,
Export; [Recall docs](https://docs.recall.it/getting-started/7-exporting-content)).
That export is the connection: no account access, no API key and no
network. This slice reads an unzipped export into the Atlas wiki's notes
folder as **sources**, so they can be found and linked but never count as
the owner's memory until he keeps something (docs/foundations.md, "Anything
in, from anywhere" and "Explicit save first").

## The Knowledge Source Interface (The Native Slot)

`src/sources.mjs` defines the slot, and the README's guide "Add your own
knowledge source" shows how to fill it.

- A **knowledge source** is `{ id, name, read(files) }`. `files` is a list
  of `{ path, text }` the command has already read (relative paths, `/`
  separators). `read` returns `{ items, skipped, warnings }`:
  - `items`: `{ key, title, body, url, tags, created, sourcePath }`. `key`
    is stable for the same file across exports (the relative path,
    normalized), `title` is 1 to 200 characters, `body` is Markdown,
    `url` and `created` may be `null`, `tags` is a list of 0 to 50 short
    strings.
  - `skipped`: `{ sourcePath, reason }` for files it won't read.
  - `warnings`: plain sentences, each naming a file.
- `recallSource()` is the default source in the owner's copy.
- `checkSource(source, files)` is the contract check any new source must
  pass: the shape above, unique keys, limits, no item without a title, and
  the same output for the same input twice.
- `toNotes(items, { sourceName, importedAt })` turns any source's items
  into Atlas notes. So a new source only writes `read`.

## What It Does

`packages/recall-import/`, plain JavaScript, no dependencies.

### Reading Recall's Export

The export's folder layout isn't documented, so the reader is lenient and
names what it can't read instead of guessing:

- Every `.md` file under the given folder is one card. Other files are
  listed in `skipped` ("not a Markdown card"). Hidden files and folders
  (starting with `.`) are skipped silently.
- **Title:** the front matter `title:` if present, else the first `# `
  heading, else the file name without `.md`.
- **Front matter** (a `---` block at the top), if present, is read for
  `title`, `url` or `source`, `tags` and `created` or `date`. Other fields
  are kept in the note's front matter under `recall:` exactly as written.
  A front matter block that doesn't parse as simple `key: value` lines is
  kept in the body as text and named in `warnings`.
- **Images.** An image link to a remote address is never fetched. It
  stays in the body as a plain link, and the note gets one line: "Images
  in this card were not imported. Their links may stop working." This
  follows the known export limit (image links point to signed addresses
  that may expire).
- **Limits.** At most 20,000 cards, 1 MiB per card, 512 MiB in all. A card
  over the size limit is skipped with its size; an export over the count
  or total limit is refused before anything is written.
- Text is kept as written: no rewording, summarizing or AI.

### Writing Atlas Notes

`toNotes` returns `{ path, text }` for each item:

- Path: `sources/recall/<slug>.md`, where the slug comes from the key (a
  folder path inside the export is kept as folders). Two keys giving the
  same slug get a suffix of the first 8 hex characters of the SHA-256 of
  the key (`<slug>-<hash8>.md`), and are named in `warnings`. So a card's
  path depends only on its own key and never shifts when another card is
  added or removed. The manifest also records each key's path, and a key
  already in the manifest keeps the path it was given.
- **Keys must stay inside.** `checkSource` and `toNotes` both refuse a key
  that is empty, absolute, contains a backslash, a control character or a
  `.` or `..` segment, or has a segment starting with `.`, naming the key.
  Each slug segment is limited to letters, digits, `-` and `_` (other
  characters become `-`), and the finished path is checked to sit under
  `sources/recall/` before it is returned. Two keys whose slugs differ only
  by letter case get the hash suffix like a collision, since the Mac's
  disk ignores case.
- Front matter: `kind: source`, `title: <title>`, `description:
  <title>` (the field `packages/atlas-index/` reads for a note's about
  line), `source: <sourceName>` (the name passed to `toNotes`, so `Recall`
  only for the Recall source), `label: from a source`, `status:
  unchecked`, `imported: <importedAt>`, then `url`, `tags` and `created`
  when present, and the source's own kept fields under a key named after
  the source id (`recall:` for Recall). The body follows unchanged.

### The Command

`node packages/recall-import/src/import.mjs --in <export folder> --atlas <atlas folder> [--write] [--json]`

- Without `--write` it is a dry run: it prints the counts (cards, notes,
  skipped, warnings), each skipped file with its reason, and every
  warning. Nothing is written.
- With `--write` it writes only under `<atlas folder>/sources/recall/`,
  each file through a temporary file and a rename, new files with mode
  `0600`. It keeps a manifest, `sources/recall/.import-manifest.json`,
  with each written file's hash.
- **Re-import.** A file in the manifest whose hash still matches is
  replaced if the card changed and left alone if not. A file the owner
  edited by hand (hash no longer matches) is never overwritten: it is
  listed as "kept, edited since the last import". A card gone from the
  new export is listed as "no longer in Recall" and not deleted. Files
  not in the manifest are never touched.
- **Last check before each replace.** Just before renaming a new note over
  an existing one, the command reads that file again and compares its
  hash with the manifest. If it changed during the run (the owner edited
  it while the import was going), the new note is not written, the
  temporary file is removed, and the note is listed as "kept, edited
  since the last import". A file that appeared during the run at a path
  the import meant to create is kept the same way.
- `--in` must be a folder: a `.zip` is refused with "Unzip the export
  first, then point --in at the folder." (no zip library is added).
- The command reads nothing outside `--in`, and follows no symlinks.

## When It Goes Wrong

The command's output is a screen the owner sees, so it answers the five
questions in [when-it-goes-wrong.md](when-it-goes-wrong.md):

1. **No connection.** Doesn't apply: it reads a folder on the Mac and
   makes no network calls, images included.
2. **Interrupted.** Each file is a temporary file plus a rename, and the
   manifest is written last the same way. An interrupted run leaves every
   note whole, and the next run finishes it (a note written but not yet in
   the manifest is treated as the import's own only if its hash matches
   what this run would write; otherwise it is kept and listed).
3. **Empty or first run.** A folder with no `.md` files says "This folder
   has no Recall cards. In Recall's web app, open Settings, choose Export,
   unzip the download, then run this again on that folder." and writes
   nothing. The README's first step uses the sample export.
4. **Denied or stuck.** A folder it can't read names the folder and says
   to check it was unzipped and is readable. No prompt or permission is
   involved.
5. **The error message.** Each refusal says what, where and what to do,
   in plain words. Skipped files and kept edits are always listed, so
   nothing vanishes silently.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/recall-import/` (invented cards only):

1. The sample export (cards with and without front matter, a nested
   folder, an image link, a non-Markdown file) gives the expected notes
   byte for byte, and `checkSource(recallSource(), files)` passes.
2. Title, url, tags and created are read from front matter, a heading or
   the file name, in that order; unknown fields are kept under `recall:`;
   unparseable front matter stays in the body with a warning.
3. Image links are kept as text, never fetched (the test fails on any
   network use), and the note gets the images line.
4. Each limit gives its message; the count and total limits write nothing.
5. Two keys with the same slug get hash-suffixed paths and a warning, and
   adding or removing a colliding card on re-import leaves every other
   card's path unchanged.
6. The output notes pass through `buildAtlas` from `packages/atlas-index/`
   (imported through its public export) with no refusals, and each note's
   about line in the generated index is the card's title, including a card
   whose title was only in its original front matter.
7. Re-import: an unchanged card is left alone, a changed card is replaced,
   a hand-edited note is kept and listed, a removed card is listed and not
   deleted, a file outside the manifest is never touched.
8. An interrupted write (the test stops after a note's rename and before
   the manifest) is finished correctly by the next run.
9. A `.zip`, a symlink inside the export and a path with `..` are refused
   or skipped as described. A source returning keys such as `../x`,
   `/x`, `a/./b`, `.hidden` or `A` beside `a` is refused or numbered, and
   no returned path leaves `sources/recall/`.
12. A note edited after the manifest check and before its rename (the
    test edits it from a hook between the two steps) is kept and listed,
    and its temporary file is removed.
10. A second invented source written only against the README guide passes
    `checkSource` and produces notes through `toNotes` unchanged, labeled
    with its own source name, never `Recall`.
11. The library never imports `child_process` or a network module and
    never reads the clock (`importedAt` is passed in; a test checks the
    source).

**Owner trial checks** (the owner, or an agent on his Mac for him, with his
real Recall export unzipped on his Mac and never committed): a dry run
shows sensible counts and lists skipped files; a write into a test Atlas
folder creates notes he recognizes, each marked as a source from Recall;
editing one note by hand and importing again keeps his edit and says so;
pointing `--in` at the zip gives the unzip message; an empty folder gives
the "no Recall cards" message; stopping a write part-way (Control-C) and
running it again finishes the import with every note whole; pointing `--in`
at a folder he can't read (permissions removed on a copy) names the folder
and says what to check. He confirms each message says what to do
next. Only counts, never card text, go into the pull request.

## Carried To The Build

Codex findings from the plan review's later rounds, which the code pull
request must meet (docs/agent-process.md "Plans stop after two Codex
rounds"):

- `toNotes` takes the source itself (`toNotes(items, { source, importedAt })`), not just a name: it writes under `sources/<source id>/`, labels notes with the source's `name`, and keys kept fields by its `id`, with a test where a second source's id differs from its name ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4460901340)).
- The command takes `--imported-at <ISO time>` and, when it is left out, reads the clock once in the command layer only (the library itself never reads the clock), passing that value to `toNotes`; a test runs the command with a fixed `--imported-at` and checks every note carries it ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4460939038)).
- `checkSource` and `toNotes` refuse a source id that is not 1–64 characters of `[a-z0-9-]` starting with a letter, and every destination path is checked to sit under `sources/<source id>/` before any write; a test supplies `../../private` as an id and checks nothing is written ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4460939021)).
- Items gain an optional `extra` object for source-specific front matter; `toNotes` writes it under the source id key, and tests cover an unknown Recall field and an `extra` field from the second source surviving the import ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4460939047)).
- Ownership survives an interrupted run: before each note's rename, the command records that note's key, path and new hash in a pending section of the manifest (written by temporary file and rename), so a retry treats a note it wrote itself as its own even when the export changed in between; a test interrupts a run after a rename, changes the card, retries and checks the note is updated, not reported as an owner edit ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4460970020)).
- The command reaches the slot: sources register in a small list in `src/sources.mjs` (Recall is the only entry this slice), `--source <id>` picks one (default `recall`), and writes go under `sources/<source id>/`; a test registers an invented second source and imports it through the command ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4460970030)).
- Change detection ignores the run's `imported` time, but edit protection does not: the manifest keeps two hashes per note, a full-file hash used for the hand-edit check and the race check just before each rename, and a hash without the `imported` line used only to tell whether the source card changed. An unchanged card is left alone; a changed card's note keeps edit protection on every byte, including a hand-edited `imported` line. Tests run two imports of an unchanged export with different `--imported-at` values (no note rewritten) and hand-edit only the `imported` line before a card change (the note is kept) ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4461092011), [thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4461703568)).
- No write follows a symbolic link: before any write, every folder from `<atlas>` down to the note's folder (and the manifest's) must exist as a real folder or be created by the command, none may be a symbolic link, and the real path of the destination must sit under the real path of `<atlas>/sources/<source id>/`; otherwise the run refuses before writing. Tests plant a symbolic link at each level ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4461730514)).
- Slugs never land on a file name Atlas reserves (`INDEX.md` in any letter case, in any folder); such a card gets the stable `<slug>-<hash8>.md` path, with a test covering nested folders and case variants ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4461092002)).
- Every final path is unique: after suffixes are applied, `toNotes`
  checks all output paths (case-folded, as macOS compares them) together
  with the manifest's paths; a path that still repeats gets a longer hash
  suffix (16, then the full 64 hex characters), and if any still repeats,
  the whole import is refused before anything is written. A test forces a
  `hash8` collision with an injected hash function and checks both cards
  get distinct files
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465077546)).
- Every directory the import creates (`sources/<source id>/` and any
  folder below it) is created with mode `0700`, and an existing one is
  never widened. A test under umask `022` imports nested keys and checks
  every new directory is `0700`
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465108422)).
- Only one `--write` import changes a source at a time: it takes an
  exclusive lock (`sources/<source id>/.import.lock`, created with `wx`,
  holding the process id and host name) before reading the manifest and
  releases it after the manifest rename. A second import that finds the
  lock stops with "Another import is running for this source. Try again
  when it finishes." and writes nothing, unless the lock is stale: when
  its host is this computer and its process is no longer running (checked
  with `process.kill(pid, 0)`), the import says "An earlier import stopped
  without finishing; cleared its lock." and removes it, then finishes the
  pending import as the interruption rule promises. A lock whose process
  is still running, or from another host, is never removed. Tests cover a
  stale lock followed by a finished import
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465191576)).
  A test starts two overlapping imports and checks one is
  refused and the manifest matches the notes on disk
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465135931)).
- Locks are published whole: the process id and host name are written to
  a temporary file first, which is then linked into place with
  `fs.linkSync` (which fails if the lock already exists) and the temporary
  file removed, so a lock is never empty or half-written. A lock file that
  is empty or can't be parsed is treated as stale and cleared with the
  same message. A test leaves an empty lock and checks the next run
  recovers
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465321707)).
- Reclaiming a stale lock has one winner. A command that finds a stale
  lock first takes a short reclaim lock (`<lock>.reclaim`, published whole
  the same way, failing if it exists), then reads the stale lock again and
  removes it only if it still names the same dead process it inspected,
  publishes its own lock, and removes the reclaim lock. A command that
  finds a reclaim lock stops with "Another command is recovering; try
  again in a moment." and writes nothing. A reclaim lock whose own process
  is gone (both runs stopped) is never cleared automatically: the command
  names it and prints the one `unlock` command, which removes it only after
  checking that process is gone. Tests run two recoverers against one
  stale lock and check exactly one proceeds
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465380765)).

## Out Of Scope For This Slice

Recall's API or account, syncing back to Recall, fetching images or pages,
any AI summary or tagging, moving anything into memory, a schedule, and the
Atlas view in the Desk.

## Rules For The Builder (Codex Team A)

The builder must follow these; the setup does not enforce them, so breaking
one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, on the branch `OC-261103-recall-import`, signed in
  as `cloudwork-bot` (or as Codex's own GitHub app for a cloud task). Open
  a pull request into `main` with auto-merge off and the label
  `agent: codex`. Never push to `main` directly, and never switch on
  auto-merge.
- End the pull request description and every comment with
  `— Codex team A, OC-261103-recall-import`.
- Run **no commands on the owner's Mac** apart from `npm test` inside
  `packages/recall-import/` and the `git` and `gh` commands needed to
  commit, push and open the pull request.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented cards only, with no real names, links or notes.
- Change files only under `packages/recall-import/`. Import
  `packages/atlas-index/` by relative path through its public export, in
  the tests only; if it lacks something, stop and report. Nothing else,
  not `STATUS.md` (the coordinator updates it).
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network, no AI, no paid services, no `child_process`, in the code or
  the tests. No clock in the library or the tests; the command alone may
  read it once, only when `--imported-at` is left out (see Carried To The
  Build). `node:fs` only in the command, and only under `--in` (read) and
  `<atlas>/sources/<selected source id>/` (write, after the id is
  validated; `recall` by default), or the tests' temporary folders.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the library, the command, the tests, the sample
  export and a README (the slot, the guide "Add your own knowledge
  source", the command, and the owner's export steps). Finishable in one
  to two days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Supported setups are macOS and the Linux CI runners on Node 22 (AGENTS.md
  "Review Guidelines").
- Edge cases this plan doesn't name: write each choice in the README's
  "Edge cases" section with a test.

## Review And Finish Line

Codex reviews it as code until it gives a 👍. Codex team A fixes every P1
and P2 or explains in the pull request why one doesn't apply. GrokBot or a
fresh Claude gives the independent review with the risk-review checklist,
because it reads the owner's personal notes. The coordinator checks it
against this plan and switches on auto-merge once both are clean on the
same head. Done when the tests pass with one command, the reviews are clean
(or the Codex triage judge passes it, [codex-triage.md](codex-triage.md)),
the plan check finds nothing missing, and the owner trial passes.
