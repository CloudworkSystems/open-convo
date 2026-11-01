# Capture inbox

A drop of shared links and video clips in, inbox sources, duplicates and refusals out. This package does not read folders, open the dropped files, fetch pages or use the network, AI, the clock or the machine's time zone. Node 22 or later.

```sh
cd packages/capture-inbox
npm test
```

The command, from the repo root:

```sh
node packages/capture-inbox/src/sort.mjs --drop <drop.json> [--json]
```

`--json` prints the result. Without it, the command prints the counts, then each source on one line, then duplicates and refusals. A file-level refusal prints one message on standard error and no result. `sortDrop(drop)`, exported from `src/index.mjs`, is the same work as a function: it returns the result, prints nothing, never reads the clock and never calls `process.exit`.

## Drop file

`schemaVersion` is the number `1`. The file is at most 8,388,608 bytes (8 MB).

```json
{
  "schemaVersion": 1,
  "items": [
    {
      "id": "reel",
      "name": "reel.webloc",
      "addedAt": "2026-11-01T15:00:00Z",
      "kind": "text",
      "text": "<plist version=\"1.0\"><dict><key>URL</key><string>https://example.com/reel</string></dict></plist>"
    }
  ],
  "known": ["https://example.com/already"]
}
```

`items` holds up to 500 entries. `known` holds up to 50,000 `sourceKey` strings already in the inbox, in the cleaned form this library returns. `id` is 1 to 200 JavaScript characters (UTF-16 code units). `addedAt` is an RFC 3339 instant with seconds and either `Z` or a numeric offset. `kind` is `text` or `file`.

A `text` item is a `.webloc`, a `.url` file, a `.txt`, or text shared directly. `text` is required and at most 65,536 UTF-8 bytes (64 KB). A `file` item was not read by the adapter. `file` is required: `{ sizeBytes, type, sha256? }`. `type` is an Apple uniform type identifier. `sha256`, when present, is 64 lowercase hex characters. A clip must have it.

`tests/fixtures/mixed.json` is an invented drop. `tests/expected/mixed.json` and `tests/expected/mixed.txt` are its result.

Unknown fields, missing required fields, a repeated `id` and a bad instant refuse the whole drop. The message names the 1-based item when the problem is in an item (`items, item 2`). One bad name, link or clip inside an otherwise good drop does not refuse the file: that item goes to `refused`, and the others are still sorted.

## Sorting

The final extension, compared without regard to case, chooses how a text item is read.

- **`.webloc`.** An XML property list. The first `URL` string is the link. The binary form (`bplist`, or a NUL byte) is refused. The reader does not fetch the DTD.
- **`.url`.** The first `URL=` line under `[InternetShortcut]`. A `URL=` line in another section is ignored.
- **Anything else.** The first `http://` or `https://` link in the text. Only the link is kept. The other words are counted and dropped, never stored.

A text item with no link is refused: "Only links and video clips go in the capture folder." A link whose scheme is not `http` or `https`, and a link with a user name or password, is refused and not stored.

A file of type `public.mpeg-4` or `com.apple.quicktime-movie`, up to 8,589,934,592 bytes (8 GB), is a clip. Its `sourceKey` is `clip:` plus its `sha256`. Any other type, including an image, is refused with the same sentence.

A name that is empty, longer than 255 UTF-8 bytes, contains `/` or `\`, contains a control character, or is exactly `.` or `..` is refused.

## Cleaning

The cleaned link is the `sourceKey`. ASCII letters in the scheme and host are lowercased. The path, query and fragment are not re-encoded. The default port (80 or 443) is dropped, and an empty `#` is dropped. A non-empty fragment is kept.

These query names are removed, matched without regard to case, as written (not percent-decoded). The others keep their order:

| Name | Removed |
|---|---|
| `utm_*` | every name that starts with `utm_` |
| `fbclid`, `gclid`, `igsh`, `igshid`, `mc_eid` | always |
| `si` | only on a YouTube host |

YouTube hosts for `si` are `youtube.com`, `youtu.be`, `youtube-nocookie.com` and their subdomains.

A rewrite that does not fit is cleaned, never refused. These are rewritten to `https://www.youtube.com/watch?v=<id>`, keeping the first `v` and the first query `t` and nothing else (the fragment is dropped):

- `youtu.be/<id>` and `www.youtu.be/<id>`
- `/shorts/<id>` and `/watch?v=<id>` on `youtube.com`, `www.youtube.com` and `m.youtube.com`

A video id is exactly 11 characters from `A–Z`, `a–z`, `0–9`, `_` and `-`. A playlist, a channel, an embed, and any other YouTube subdomain (such as `music.youtube.com`) is only cleaned.

`twitter.com` and `www.twitter.com` become `x.com`. Any other `*.twitter.com` host becomes the same subdomain of `x.com`. `www.` is dropped from `www.instagram.com` and `www.tiktok.com` only.

## Site label

Decided from the host after rewriting. A host matches when it equals the suffix or ends with `.` plus the suffix.

| Site | Hosts |
|---|---|
| `youtube` | `youtube.com`, `youtu.be`, `youtube-nocookie.com` |
| `instagram` | `instagram.com` |
| `tiktok` | `tiktok.com` |
| `x` | `x.com`, `twitter.com` |
| `facebook` | `facebook.com`, `fb.com`, `fb.watch` |
| `web` | anything else |

## Output

`{ schemaVersion, sources, duplicates, refused, counts }`.

`counts` is `{ items, sources, links, clips, duplicates, refused, droppedWords }`. `sources`, `duplicates` and `refused` add up to `items`. `links` and `clips` add up to `sources`. `droppedWords` is the number of whitespace-separated words removed from plain-text items around a link that was kept.

A link source is `{ id, kind: "link", sourceKey, site, url, title, addedAt }`. A clip source is `{ id, kind: "clip", sourceKey, title, addedAt, file }`. `file` is `{ sizeBytes, type, sha256 }`. A duplicate is `{ id, sourceKey, repeats }`, where `repeats` is the earlier item's `id` or `"known"`. A refusal is `{ id, reason }`.

Sources, duplicates and refusals are ordered by the instant, then by `id`. The earliest instant wins a duplicate. The same instant is broken by `id`, in UTF-16 code-unit order, not by the order in the file. A key in `known` wins over every copy in the drop.

A link title is the site, a space, the host, the path, and a non-empty fragment, at most 80 characters. The query is not in the title, so a rewritten YouTube title does not contain the video id. A clip title is the file name without its last extension.

The plain summary puts input text on one line. A backslash is doubled, line breaks (`\n`, `\r`, U+2028, U+2029) are written as `\n`, tabs as `\t`, and bidirectional controls and the other ASCII controls as `\uXXXX` with lowercase hex. The JSON result keeps the original characters.

## Edge cases

These are the choices the plan does not spell out. Each one has a test.

- A file-level problem throws `CaptureError` and produces no result. A bad name, scheme, userinfo, missing link or bad clip is one `refused` entry, and the other items are still sorted.
- Positions are 1-based: `items, item 3`. `schemaVersion` must be the number `1`. Duplicate keys inside one JSON object follow `JSON.parse` (the last one wins). A leading BOM is not valid JSON.
- `id` length is JavaScript characters. An emoji counts as two. `text` and `name` limits are UTF-8 bytes. Empty `text` is present, and is refused because it has no link.
- `addedAt` requires seconds and a real calendar date. All fraction digits, up to 9, are used when ordering, so two captures in the same millisecond stay in time order. The original text is kept. `-00:00` and `Z` are the same instant. Years run from 0001 to 9999.
- A present `sha256` must be 64 lowercase hex characters on every file item, or the drop is refused. Omitting the field is allowed until a clip is sorted, and then that clip is refused. `null` and `""` are present and refused with the drop.
- `sizeBytes` is a safe whole number, 0 or more, and not `-0`. A 0-byte clip is allowed. Exactly 8 GB is allowed. One byte over is refused. The check applies only after the type is a clip, so an over-size image is still refused as not a clip.
- Clip types match the two names exactly, including case. A longer name is not a clip.
- A name with a single leading dot, such as `.webloc`, is plain text. `notes.webloc.txt` is plain text. Only ASCII `/` and `\` are separators. A fullwidth slash is kept. Format characters such as bidirectional controls are not control characters, so they are allowed in a name. C0 and C1 controls, and Unicode line and paragraph separators, are refused.
- `.webloc` comments are ignored. The five predefined XML entities and numeric character references are decoded. Custom entities are left as written. There is no network fetch.
- `[InternetShortcut]` and `URL=` match without regard to case. Whitespace around `=` is ignored.
- Plain text keeps the first `http://` or `https://` token even when a `javascript:` appears earlier. That earlier scheme is not stored. With no http(s) link, another `scheme:rest` token (no space after the colon) is refused by its scheme name. `Note: hello` is not a scheme.
- Trailing `.,;:!?` and an unmatched `)` or `]` or `>` are removed from a plain-text token. Characters inside the link stay, including `@` in the path.
- Only ASCII `A–Z` in the scheme and host are lowercased. An empty path is written as `/`, so `https://example.com` and `https://example.com/` are one source. An empty query is dropped. Empty `&&` pieces are dropped. Repeated parameters stay, in order, values as written.
- A port of more than five digits, or a number above 65535, is refused. A numeric default port is dropped, including `:0443`. Any other port is written without leading zeros.
- `si` is removed on every YouTube host, including `music.youtube.com`, but only the hosts named above are rewritten. The query names `v` and `t` are case-sensitive. A bare `t` is kept. The first `t` wins. `V` does not count as a video id, so that watch link is only cleaned.
- `www.` is not dropped from `www.facebook.com`, `www.youtube.com` (except by the video rewrite) or `www.x.com`. `shop.instagram.com` stays, and its site is `instagram`. `notyoutube.com` is `web`.
- A link title is cut to 80 UTF-16 code units on a boundary that does not split a surrogate pair, with `…` when it is cut. The `sourceKey` is not cut. A clip title uses the last dot as the extension. No dot, or a dot only at the start, keeps the whole name, so `.hidden` stays `.hidden` and `...` has the title `..`. A name of only spaces is not empty.
- Dropped words are whitespace-separated (`/\s+/`). The word that contains the link is not counted. Duplicates count. Refusals count as zero. `.webloc` and `.url` files count as zero, because the link is a field, not prose.
- `known` is an exact match on the cleaned `sourceKey`. A raw shared URL that still has tracking tags does not match.
- `sortDrop` refuses a value whose `JSON.stringify` text is over 8,388,608 UTF-8 bytes. The command refuses a larger file before parsing. A file of exactly that size is read.
- The engine does not mutate its input. The same value gives byte-identical JSON, including when `items` or `known` is shuffled. Nothing depends on the clock, the time zone, the locale or random values. The library writes no files and calls no network.
