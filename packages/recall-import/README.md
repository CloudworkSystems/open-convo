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

Sources may also supply `emptyGuidance`, a nonempty text message explaining what to do when their reader returns no items. `checkSource` validates it. For example, an invented bookmark source could use `emptyGuidance: "No bookmarks found. Export bookmarks as Markdown and select that folder."` Recall supplies its own export instructions. Omitting the field gives neutral guidance to check the selected folder and the source's supported format. Removal messages use the selected source's `name`.

## Edge cases

- Hidden export entries are ignored. Symbolic links are listed and never followed.
- Simple front matter means one `key: value` per line, plus block-style tag lists. Tags may also be comma-separated inside brackets; commas inside quoted tags stay in that tag. Front matter outside these supported forms stays in the body and produces a warning.
- Scalar front-matter values are preserved as text. Unknown values are written under the source id.
- Unknown values that resemble numbers, dates, null or booleans are quoted under the source id so they remain text, including leading zeroes such as `"001"`.
- The same text-preserving quoting applies to titles, descriptions, source names, URLs, tags, created dates, and nested source fields. All quoted export scalars and tags use one decoder: double quotes support YAML escapes (including escaped quotes, backslashes, and hexadecimal Unicode), while single quotes use doubled apostrophes and keep backslashes literal. Invalid or unsupported quoted forms preserve the original front matter with a warning. Unknown flow-list fields remain text as written; unsupported block-list fields remain in the body with a warning.
- Front-matter delimiters and header lines accept LF or CRLF, including mixed header endings and a leading UTF-8 BOM. Only header parsing uses those line boundaries; the original body bytes and line endings are kept. Heading fallback, block tags, code fences, and image references also recognize CRLF.
- The command scans file sizes and the Markdown count before reading any export content. Oversized cards are listed without being read. Recall attachments are listed without reading their content, but their sizes count toward the export total. Files that change size between the scan and the read are refused with a retry message. Reads allocate only the checked file size.
- Source readers receive files only after count and total checks. Recall tags are read one at a time, stopping before storing a 51st tag or a tag longer than 100 characters.
- The source contract requires every item field, including `sourcePath`, `url`, and `created` (use `null` for absent URL or date). Skipped entries need a relative `sourcePath` and a nonempty text reason. Warnings must be nonempty text naming an input, item, or skipped file. Extra fields accept plain JSON data, without cycles, functions, undefined values, or non-finite numbers.
- A write re-import reconciles saved and pending manifest entries even when every card was removed or skipped. It retains notes and reports removed cards. Pending writes are resolved against the note's current hash; owner edits stay protected. A first empty run still writes nothing, and dry runs leave the manifest unchanged.
- Image conversion and heading selection ignore backtick and tilde fenced code, indented code, and inline backtick spans (including multiline spans). Code text keeps its original bytes and line endings. Escaped image syntax stays unchanged. Only converted remote images add the image notice. Ordinary links and wiki links are left as written.
- Titles and descriptions use Atlas's simple quoted-line format, with literal quotes and backslashes rather than JSON escapes. Tabs and line breaks in these two fields become spaces, with a warning naming the file. The source item and body remain unchanged. Other metadata retains its existing text-preserving serialization.
- Remote image syntax includes inline destinations (plain or angle-wrapped) and full, collapsed, or shortcut references whose definition appears anywhere outside code. Conversion removes only the image marker, keeping the link text, destination, reference definition, and optional title as written. Missing or local reference targets stay unchanged.
- The image scanner follows the [CommonMark title and destination forms](https://spec.commonmark.org/0.31.2/#links), including double-quoted, single-quoted, and parenthesized titles, escaped punctuation, balanced bare destinations, and line breaks between parts. Remote detection includes protocol-relative URLs and escaped or numeric-entity scheme punctuation. HTML `img` tags and uncertain image destinations stay as written and receive the expiry notice, rather than being silently missed. Code examples remain unchanged and get no image notice. Appended notices use the last body line-ending style.
- A per-note record is appended to `.import-journal.jsonl` before replacement, recording its previous manifest entry as well as its intended result. The journal is compacted into the manifest at the end or on recovery, so metadata writes grow with the number of cards rather than its square. An unterminated final journal line is ignored as an interrupted append; damage to any complete line refuses. Existing valid pending manifests still recover. Nested objects and arrays in extra fields are serialized recursively, with scalar values kept as text.
- Source-keyed maps have no inherited properties, including after loading a manifest or replaying its journal. Keys such as `__proto__`, `constructor`, and `toString` are stored and looked up as ordinary own data. Front-matter fields use the same kind of map, and field names may start with an underscore.
- Dry re-imports read the saved manifest and complete journal records without changing either file or taking a lock. They use the same path selection and change checks as writes, including removed cards and pending writes. Reports include `paths` (`key`, `path`) and `changes` (`key`, `path`, `action`), with actions `created`, `updated`, `unchanged`, `kept`, and `removed`. A dry report describes the files at the time it runs; a later edit or another import can change the eventual write result.
- Temporary notes, manifests, and locks use a short `data` filename in a private temporary directory beside the destination, rather than adding a suffix to its filename. Completed replacements remove that directory. New generated path components exceeding 255 UTF-8 bytes are shortened between characters with a stable hash; collision suffixes also fit within 255 bytes. Valid saved manifest paths are retained exactly, including multibyte names.
- `checkSource` gives readers read-only file records sharing their original text strings. It checks repeatability with a SHA-256 comparison fed in small chunks, without cloning the export text or serializing the full result.
- Slug collisions, paths differing only by letter case, and reserved `INDEX.md` names receive a stable hash suffix.
- Existing folders keep their permissions. New import folders use mode `0700`; new notes use `0600`.
- A source has one writer at a time. A dead same-computer lock is recovered. A recovery lock requires the printed manual command after its process is confirmed gone.
- The printed `unlock` command accepts only an absolute `.import.lock.reclaim` path. It refuses locks from another computer, unreadable lock records, and locks naming a running process. It removes a recovery lock only after confirming its process no longer exists on this computer.
- The command tests overlap imports at explicit hooks during note replacement and lock recovery. The second import attempts to run while the first still holds its lock. No child processes or network connections are used.

## Odd cards and reader bugs

Recall owns the conversion of export text into contract items. A filename or heading is a derived title: it is shortened to the existing 200 UTF-16-unit limit at a whole Unicode grapheme boundary, with a file warning. Astral characters use two units; a combining sequence stays together. A derived title with no usable text becomes `Untitled card` with a warning. The body is unchanged. Explicit invalid titles and invalid tags skip only their card, with the file and reason listed. An unsupported front-matter shape still follows the plan: preserve it in the body and warn.

**The line between card input and a reader bug:** Recall catches only recognized card-value errors. `checkSource` and `toNotes` never repair a source author's malformed result. Wrong field types, unsafe or duplicate keys, invalid result shapes, invalid extra values, and nondeterministic output remain errors that stop the import. Aggregate export limits also stop the whole import, as the plan requires.

| Limit or contract check | Handling |
| --- | --- |
| Title: nonblank, at most 200 UTF-16 units | Shorten derived filename/heading titles with a warning. Skip an invalid explicit title. Invalid author-produced titles are reader errors. |
| Tags: 0–50 tags, each nonblank and at most 100 UTF-16 units | Skip the offending Recall card, for both flow and block lists. Invalid author-produced tags are reader errors. |
| Input card: 1 MiB | Skip that card before parsing, or before reading content in the command. |
| Export: 20,000 Markdown cards and 512 MiB total input bytes | Refuse the whole export before writes. The command checks before content reads. Source output over 20,000 items is a reader error. |
| URL and created: required nullable strings | No separate length cap. Recall input is limited by 1 MiB per card. Wrong author-produced types are reader errors. |
| Body: required string | No separate output-body cap. Recall input is limited by 1 MiB per card; an appended image notice can make output slightly larger. Wrong author-produced types are reader errors. |
| Extra data: optional plain object containing finite JSON values, without cycles | No separate numeric size/depth cap. Recall produces flat string fields within the input-card limit. Unsupported nested YAML stays in the body with a warning. Invalid author-produced data is a reader error. |
| Input files: relative paths and text; items: unique safe relative keys and a sourcePath | Unsafe paths, duplicate keys, missing fields, or wrong author-produced types are reader errors. Keys disallow absolute paths, backslashes, controls, empty/dot segments, and hidden segments. |
| Output file/folder component: 255 UTF-8 bytes | Shorten new generated components with stable hashes. Keep valid manifest paths. Reserved `INDEX.md` names and case-insensitive collisions get hash suffixes, trying 8, 16, then 64 hex digits. An unresolved collision refuses the import. |
| Source id: 1–64 lowercase letters/digits/hyphens, starting with a letter | Reader configuration error. Source name must be nonblank text; optional emptyGuidance must be nonblank text. Neither has a numeric length cap. |
| Result: items, skipped, and warnings arrays | Every item field is required except extra. Skipped entries require a safe sourcePath and nonblank reason; warnings require nonblank text naming a file. Invalid author-produced records are reader errors. |
| Repeatability: identical input must give identical output | Reader error if the comparison differs. |
| Conversion time: importedAt must be a real ISO timestamp with an explicit UTC offset | Caller error if absent/invalid; the command supplies it when omitted. Stored as UTC with exactly three fractional digits. |

## Accepted command and API inputs

Flags may appear only once. Unknown flags/options, missing/empty values, and values supplied to switches are refused before opening files. Path components must be at most 255 UTF-8 bytes and contain no control characters or `..` segments. Input and Atlas folders must be separate, with neither inside the other. Filesystem metadata is checked before reading export content; existing Atlas/source roots must be real folders.

| Flag or API option | Accepted form |
| --- | --- |
| `--in` | Required readable, unzipped export-folder path, absolute or relative. |
| `--atlas` | Required absolute or relative Atlas-folder path; missing folders may be created in write mode. |
| `--source` | Registered source id: 1–64 lowercase letters/digits/hyphens, starting with a letter. Defaults to `recall`. |
| `--imported-at`, `toNotes.importedAt` | `YYYY-MM-DDTHH:mm:ss[.SSS]Z` or an explicit `±HH:mm` offset. Seconds are required; fractional seconds may contain 1–3 digits. Years are 0001–9999, hours 00–23, minutes/seconds 00–59, with real calendar dates and valid offset fields. No implicit timezone, leap-second value, or normalization of impossible dates. |
| `--write` | Switch without a value; permits writes. |
| `--dry-run` | Switch without a value; explicit read-only preview, also the default when `--write` is absent. Cannot be combined with `--write`. |
| `--json` | Switch without a value; emits the report as JSON. |
| `unlock <path>` | Exactly one absolute `sources/<id>/.import.lock.reclaim` path; the owner must be confirmed dead on this computer before removal. |
| `runImport(argv, options)` | String argument array and a plain options object. Supported options are `sources`, `hashKey`, `beforeRename`, `afterRename`, and `afterReclaimLock`. |
| `options.sources` | Nonempty array of validated source objects with unique ids. |
| `options.hashKey`, `toNotes.hashKey` | Trusted deterministic function returning exactly 64 hexadecimal characters; used for collision tests. |
| Callback options | Trusted functions used by tests; non-functions are refused. |
| `toNotes(items, options)` | Validated items plus only `source`, `importedAt`, `manifest`, and `hashKey`. Source metadata is validated at this boundary too. |
| `toNotes.manifest` | Object whose own keys are safe source keys and whose records contain safe `.md` paths under the selected source folder. |
| Limits | Fixed, frozen package constants. CLI/API overrides are unsupported and refused. |

The normalized stored timestamp is **UTC `YYYY-MM-DDTHH:mm:ss.SSSZ`**, for example `2026-11-05T12:00:00.000Z`. The same normalization runs in the CLI and library. Parsing an explicitly supplied timestamp never reads the current clock. Source content such as `created` remains source text under its existing contract; it is not treated as the import command's timestamp.

## Saved-state recovery and refusal

Only `ENOENT` means a state file is absent. Permission errors, directories, symbolic links, other read errors, malformed/truncated JSON, duplicate JSON fields, schema/version mismatches, invalid hashes/paths, and contradictory journals refuse before import writes. Dry runs use the same checks. Each refusal names the exact file and tells the owner to restore a readable valid copy or back it up and move that exact path aside to start fresh. The published import lock has the Carried 13 exception: an empty or unparseable lock is treated as stale, with the usual cleared-lock message. Read errors and invalid lock schemas still refuse.

Recovery covers a valid version-1 pending manifest, or complete journal records that agree with their checkpoint baseline. A journal left after completed compaction is safe to replay when its result already matches the manifest. Legacy records without a baseline recover only when an existing manifest record agrees or the note's full hash establishes the recorded replacement. An empty journal with a valid manifest is safe; a journal without its checkpoint refuses. An unterminated final line is ignored, while every complete line must pass validation. Readable notes changed by the owner are kept. A valid same-computer lock naming a dead process can be reclaimed; live or foreign locks are kept. A reclaim lock is cleared only through the explicit `unlock` command after its valid owner is confirmed gone. Empty or unparseable published import locks are reclaimed automatically. Reclaim locks and temporary lock files retain strict validation. Locks are written whole to a temporary file and published with an exclusive hard link, so competing imports cannot observe a half-created lock.

Temporary leftovers are inspected read-only, including the earlier filename-suffix format. Empty temporary directories and readable note data are retained. Temporary manifest/lock data must have the corresponding valid schema; unreadable or malformed leftovers refuse. Note bodies and note temporary data are raw bytes, not JSON, so JSON schema checks do not apply to them. Existing notes, including removed cards, and every planned target are checked before publishing the import lock or checkpoint. Refusal tests hash every file and track every directory under Atlas in both dry and write modes; permission tests skip explicitly when running as root.

## Not included

There is no Recall API or account connection, sync back to Recall, page or image fetching, AI summary or tagging, schedule, memory move, or Desk view.
