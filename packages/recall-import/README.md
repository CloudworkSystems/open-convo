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
- Slug collisions, paths differing only by letter case, and reserved `INDEX.md` names receive a stable hash suffix.
- Existing folders keep their permissions. New import folders use mode `0700`; new notes use `0600`.
- A source has one writer at a time. A dead same-computer lock is recovered. A recovery lock requires the printed manual command after its process is confirmed gone.
- The printed `unlock` command accepts only an absolute `.import.lock.reclaim` path. It refuses locks from another computer, unreadable lock records, and locks naming a running process. It removes a recovery lock only after confirming its process no longer exists on this computer.
- The command tests overlap imports at explicit hooks during note replacement and lock recovery. The second import attempts to run while the first still holds its lock. No child processes or network connections are used.

## Not included

There is no Recall API or account connection, sync back to Recall, page or image fetching, AI summary or tagging, schedule, memory move, or Desk view.
