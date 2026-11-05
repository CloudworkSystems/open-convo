# Recall import

This package reads an unzipped Recall Markdown export and writes Atlas source notes. It makes no network calls, fetches no images, uses no AI, and never changes Recall.

## Try the invented sample

From the repository root:

```sh
node packages/recall-import/src/import.mjs --in packages/recall-import/sample-export --atlas /tmp/invented-atlas --imported-at 2026-11-05T12:00:00.000Z
```

This is a dry run. Add `--write` to create notes. Use `--json` for JSON output. Use `--source <id>` to select a registered source. Without `--imported-at`, the command reads the current time once. Run `npm test` in this package to run the tests.

## Import an owner's export

In Recall's web app, open Settings, choose Export, and unzip the download. Run the command above with `--in` pointing to that folder and `--atlas` pointing to the Atlas folder. Run once without `--write`, read every skipped-file message and warning, then run with `--write`. A zip is refused because the package has no zip dependency.

## Add your own knowledge source

Add a source object to the small list in `src/sources.mjs`: `{ id, name, read(files) }`. Its id is 1 to 64 lowercase letters, digits or hyphens, begins with a letter, and becomes the folder under `sources/`. `read` receives already-read `{ path, text }` files and returns `{ items, skipped, warnings }`. Each item has `key`, `title`, `body`, `url`, `tags`, `created`, `sourcePath`, and optional `extra`. Run `checkSource(source, files)`, then pass its items to `toNotes(items, { source, importedAt })`. The source reader needs no file-system access.

## Edge cases

- Hidden export entries are ignored. Symbolic links are listed and never followed.
- Simple front matter means one `key: value` per line. Tags may be comma-separated inside brackets. Front matter outside that shape stays in the body and produces a warning.
- Scalar front-matter values are preserved as text. Unknown values are written under the source id.
- Unknown values that resemble numbers, dates, null or booleans are quoted under the source id so they remain text, including leading zeroes such as `"001"`.
- The same text-preserving quoting applies to titles, descriptions, source names, URLs, tags, created dates, and nested source fields. Quoted Recall tags lose only their surrounding export quotes before being written as text.
- The command scans file sizes and the Markdown count before reading any export content. Oversized cards are listed without being read. Recall attachments are listed without reading their content, but their sizes count toward the export total. Files that change size between the scan and the read are refused with a retry message. Reads allocate only the checked file size.
- Source readers receive files only after count and total checks. Recall tags are read one at a time, stopping before storing a 51st tag or a tag longer than 100 characters.
- The source contract requires every item field, including `sourcePath`, `url`, and `created` (use `null` for absent URL or date). Skipped entries need a relative `sourcePath` and a nonempty text reason. Warnings must be nonempty text naming an input, item, or skipped file. Extra fields accept plain JSON data, without cycles, functions, undefined values, or non-finite numbers.
- A write re-import reconciles saved and pending manifest entries even when every card was removed or skipped. It retains notes and reports removed cards. Pending writes are resolved against the note's current hash; owner edits stay protected. A first empty run still writes nothing, and dry runs leave the manifest unchanged.
- Image conversion and heading selection ignore backtick and tilde fenced code, indented code, and inline backtick spans (including multiline spans). Code text keeps its original bytes and line endings. Escaped image syntax stays unchanged. Only converted remote images add the image notice. Ordinary links and wiki links are left as written.
- Titles and descriptions use Atlas's simple quoted-line format, with literal quotes and backslashes rather than JSON escapes. Tabs and line breaks in these two fields become spaces, with a warning naming the file. The source item and body remain unchanged. Other metadata retains its existing text-preserving serialization.
- Remote image syntax includes inline destinations (plain or angle-wrapped) and full, collapsed, or shortcut references whose definition appears anywhere outside code. Conversion removes only the image marker, keeping the link text, destination, reference definition, and optional title as written. Missing or local reference targets stay unchanged.
- A per-note record is appended to `.import-journal.jsonl` before replacement. The journal is compacted into the manifest at the end or on recovery, so metadata writes grow with the number of cards rather than its square. A torn final journal record is ignored because its note was not yet replaced. Existing pending manifests still recover. Nested objects and arrays in extra fields are serialized recursively, with scalar values kept as text.
- Source-keyed maps have no inherited properties, including after loading a manifest or replaying its journal. Keys such as `__proto__`, `constructor`, and `toString` are stored and looked up as ordinary own data. Front-matter fields use the same kind of map, and field names may start with an underscore.
- Dry re-imports read the saved manifest and complete journal records without changing either file or taking a lock. They use the same path selection and change checks as writes, including removed cards and pending writes. Reports include `paths` (`key`, `path`) and `changes` (`key`, `path`, `action`), with actions `created`, `updated`, `unchanged`, `kept`, and `removed`. A dry report describes the files at the time it runs; a later edit or another import can change the eventual write result.
- `checkSource` gives readers read-only file records sharing their original text strings. It checks repeatability with a SHA-256 comparison fed in small chunks, without cloning the export text or serializing the full result.
- Slug collisions, paths differing only by letter case, and reserved `INDEX.md` names receive a stable hash suffix.
- Existing folders keep their permissions. New import folders use mode `0700`; new notes use `0600`.
- A source has one writer at a time. A dead same-computer lock is recovered. A recovery lock requires the printed manual command after its process is confirmed gone.
- The printed `unlock` command accepts only an absolute `.import.lock.reclaim` path. It refuses locks from another computer, unreadable lock records, and locks naming a running process. It removes a recovery lock only after confirming its process no longer exists on this computer.
- The command tests overlap imports at explicit hooks during note replacement and lock recovery. The second import attempts to run while the first still holds its lock. No child processes or network connections are used.

## Not included

There is no Recall API or account connection, sync back to Recall, page or image fetching, AI summary or tagging, schedule, memory move, or Desk view.
