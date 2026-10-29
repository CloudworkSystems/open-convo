# Capture Inbox Engine (PRD)

Status: Draft (Oct 29): plan only; waiting on the owner's yes.

Written October 29, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261029-capture-inbox`. Umbrella: Personal. First slice of the **iPhone
capture app** (PLAN.md, "After the Top Five": a "Share to True Convo" button
for links and the owner's own video clips, landing as sources in the inbox;
until then an Apple Shortcut saves shared items into an iCloud Drive folder
the Mac app watches). Built by an outside builder under AGENTS.md "Outside
Builders": **GrokBot team B** builds, through Cursor and signed in as
`cloudwork-bot`; **Codex** reviews; the coordinator checks the result
against this plan. It takes one of the outside-builder places.

## Why

The owner shares links and clips from his phone all day (reels, videos,
articles) and today they scatter across notes and chats. The Shortcut can
drop each one into a folder, but what lands there is messy: `.webloc` and
`.url` files, plain text with a link somewhere inside, the same reel shared
twice with different tracking tags, video files, and now and then something
that shouldn't be there. Turning that into clean, de-duplicated inbox
sources is rules, not judgement, so it belongs in one small tested library
that both the Mac's folder watcher and, later, the iPhone share button use.

## Plan Of Record

1. **Now (this slice):** a sorting library on its own. A list of dropped
   items in, inbox sources, duplicates and refusals out. It reads no
   folders, opens no files, fetches no pages and calls no network.
2. **Next (building lanes):** the Mac folder watcher that reads the iCloud
   Drive folder (after the owner's one-time approval of iCloud Drive as a
   host, foundations principle 6), hands this library each item's text or
   file details, and stores the sources in the inbox; the Desk inbox view.
   The same slice writes the Apple Shortcut, which must keep the iCloud
   Drive folder within the approval: on the phone, before anything is
   saved, it pulls out only the link (Shortcuts' "Get URLs from Input") or
   the video clip, and never writes a caption, message or other shared
   text. This library's dropping of extra words (step 5) is a second guard
   for files that arrive anyway, not the first.
3. **Later:** the iPhone share button on the parallel sync line calls the
   same library before sending a source through the sync core.

## What It Does

A small library and command in `packages/capture-inbox/`:

```
node packages/capture-inbox/src/sort.mjs --drop <drop.json> [--json]
```

and the same as a function, `sortDrop(drop)`, exported from
`src/index.mjs`. It returns the result synchronously, prints nothing, never
reads the clock and never calls `process.exit`.

### The Drop File

`schemaVersion: 1`, at most 8 MB, with:

- `items`: up to 500, each `{ id, name, addedAt, kind, text?, file? }`.
  `id` is the adapter's own key for the item (1 to 200 characters), `name`
  the dropped file's name, `addedAt` an RFC 3339 instant with an offset or
  `Z`. `kind` is `text` (the adapter read the file's text: `.webloc`,
  `.url`, `.txt`, or text shared directly; `text` is required, at most
  64 KB) or `file` (the adapter did not read it; `file` is required:
  `{ sizeBytes, type, sha256? }`, `type` being the Apple uniform type
  identifier, for example `public.mpeg-4`; `sha256` is the adapter's
  SHA-256 of the file's bytes as 64 lowercase hex characters, required for
  a clip).
- `known`: up to 50,000 `sourceKey` strings already in the inbox, so a
  re-shared item is caught as a duplicate.

Unknown fields, missing required fields, repeated `id`, and bad instants are
refused with a plain message naming the item's position. A refused file
produces no result; a single bad item inside a good file is not a file
refusal, it goes to `refused` (below).

## Sorting Each Item

1. **Names.** A `name` that is empty, longer than 255 bytes, contains `/`,
   `\`, a control character, or is `.` or `..` is refused, so the watcher
   never moves a file outside its folder because of a name.
2. **Links.** For a `text` item the link is found by format: a `.webloc`
   (an Apple property list with a `URL` string), a `.url` file (the `URL=`
   line under `[InternetShortcut]`), or else the first `http://` or
   `https://` link in the text. Only `http` and `https` are accepted; any
   other scheme (`javascript:`, `file:`, `data:` and the rest) is refused.
   A link with a user name or password in it is refused, never stored.
3. **Cleaning a link:** lowercase scheme and host, drop the default port
   and an empty `#`, and remove tracking parameters from a fixed list in
   the README (at least every `utm_*`, `fbclid`, `gclid`, `igsh`, `igshid`,
   `mc_eid`, and `si` on YouTube links). Other parameters keep their order.
   Only YouTube links that carry a video id are rewritten: `youtu.be/<id>`,
   `youtube.com/shorts/<id>` and `/watch?v=<id>` on `m.youtube.com` or
   `youtube.com` become `https://www.youtube.com/watch?v=<id>`; any other
   YouTube link (a playlist, a channel) is only cleaned, never rewritten.
   The same holds for every rewrite: a link it doesn't fit is kept as
   cleaned, never refused; `twitter.com` becomes
   `x.com`; `www.` is dropped from Instagram and TikTok links. A non-empty
   fragment is kept (on hash-routed sites it names the page), except where
   a YouTube rewrite builds the link afresh, which keeps only `v` and `t`.
   The cleaned link is the `sourceKey`.
4. **Site label:** `youtube`, `instagram`, `tiktok`, `x`, `facebook` or
   `web`, from a fixed host table in the code (subdomains of those hosts
   included).
5. **No notes in this slice.** The owner's iCloud Drive approval covers
   links and video clips only (PLAN.md, iPhone capture app), so a `text`
   item with no link is refused ("Only links and video clips go in the
   capture folder"). In text with a link and other words, only the link is
   kept; the other words are dropped and counted, never stored (the
   Shortcut is meant to have dropped them already; see Plan Of Record). Notes can
   come later, once an owner decision widens that approval.
6. **Clips.** A `file` item of type `public.mpeg-4` or
   `com.apple.quicktime-movie`, up to 8 GB, is a clip. Its `sourceKey` is
   `clip:` plus its `sha256`, so two different clips that share a name and
   size are never taken for each other; a clip without `sha256` is refused.
   Every other file type is refused,
   images included, with the message "Only links and video clips go
   in the capture folder"; health photos never travel this way
   ([skin-check.md](skin-check.md)).
7. **Duplicates.** An item whose `sourceKey` is in `known`, or repeats an
   earlier item in this drop (earliest `addedAt`, then `id`, wins), goes to
   `duplicates` with the key and the item it repeats. A duplicate is only
   reported: the later watcher never deletes or moves a file because this
   library called it a duplicate; it leaves it for the owner.
8. **Titles.** No page is fetched, so a link's title is its site label and
   a shortened host and path (at most 80 characters); a clip's title is its file name
   without the extension.

**Same input, same result.** The same file gives byte-identical JSON, and
shuffling `items` or `known` gives the same result. Nothing depends on the
clock, the machine's time zone, locale or random values.

## Output

`{ schemaVersion: 1, sources, duplicates, refused, counts }`. Each source is
`{ id, kind (link or clip), sourceKey, site?, url?, title,
addedAt, file? }`, ordered by `addedAt`, then `id`. Each refusal is `{ id,
reason }` in plain words. The command's plain summary prints the counts,
then each source on one line, then duplicates and refusals. Text from the
input is printed on one line, with line breaks and tabs written as `\n` and
`\t`, and bidirectional control characters escaped.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/capture-inbox`, Node's built-in test runner,
invented data only (made-up links on `example.com` and invented video ids).
At least:

1. A mixed invented drop (`.webloc`, `.url`, plain text, a no-link note,
   two clips, one image, one duplicate) gives a result whose JSON matches a saved
   expected file exactly.
2. Each link format is read; a `.webloc` with no `URL` and a `.url` with no
   `URL=` line are refused; text with a link and other words keeps only
   the link and counts the dropped words.
3. Cleaning: each tracking parameter on the list is removed and others kept
   in order; the YouTube, X, Instagram and TikTok rewrites; upper-case hosts,
   default ports; an empty `#` dropped; an `m.youtube.com` playlist and a
   channel link kept as cleaned, not rewritten; `https://example.com/#/post/1` and
   `#/post/2` kept as two sources; the YouTube rewrite keeping `t`.
4. Refusals: each scheme other than `http` and `https`, a link with a user
   name or password, each bad name above, an image, an unknown file type and
   an over-size clip.
5. Duplicates: two clips with the same name and size but different
   `sha256` are both sources; the same `sha256` under two names is a
   duplicate; the same reel shared twice with different tracking tags, a
   key already in `known`, and the earliest item winning.
6. Input checks: each file refusal above names the item's position; a
   repeated `id` is refused.
7. Hostile but valid text (quotes, `<script>`, emoji, right-to-left text,
   bidirectional controls) in link paths and clip names, and a 64 KB text
   item, is returned unchanged in the JSON
   and safe on one line in the summary.
8. Determinism and no clock: shuffled `items` and `known` give
   byte-identical JSON; the engine runs with `Date.now` and an
   argument-less `Date` stubbed to throw.
9. Nothing fetched, nothing written: the test setup makes Node's network
   built-ins throw if called, and the library writes no files.

## Out Of Scope For This Slice

Reading or watching folders, opening or moving files, fetching pages or
their titles, the Apple Shortcut itself, iCloud, the iPhone share button,
any app or Desk screen, any AI, storage or encryption code, network, and
real personal data.

## Rules For The Builder (GrokBot Team B)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, through Cursor, on the branch
  `OC-261029-capture-inbox`, signed in as `cloudwork-bot`. Open a pull
  request into `main` with auto-merge off and the label `agent: grokbot`.
  Never push to `main` directly, and never switch on auto-merge.
- Mark the work as AGENTS.md "Accounts And Provenance" says: `Cursor Agent`
  as commit author, and `— GrokBot team B` as the last line of the pull
  request description and every comment.
- Run **no commands on the owner's Mac** for this job.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented data only; no real links the owner shared.
- Change files only under `packages/capture-inbox/`. Nothing else, not even
  `STATUS.md`. Import nothing from `apps/` or another package.
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`. Parse `.webloc` files with
  a small reader written here, not a dependency; it accepts only the XML
  property-list form and refuses the binary form.
- No network calls, no AI, no paid services, in the code or the tests.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the engine, the command, the tests and a short
  README with the drop file, the tracking list, the host table, and the
  output. Finishable in one to two days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Supported setups are macOS and the Linux CI runners on Node 22 (AGENTS.md
  "Review Guidelines"); don't add Windows-specific code.
- Edge cases this plan doesn't name: write each choice in the README's "Edge
  cases" section with a test.

## Review And Finish Line

Codex reviews it as code until it gives a 👍 (GrokBot builds, Codex
reviews). GrokBot fixes every P1 and P2 or explains in the pull request why
one doesn't apply. The coordinator checks it against this plan, posts the
check as a comment, gives the owner a short try-it note, and switches on
auto-merge once the plan check passes. Done when the tests pass with one
command, Codex has no open P1 or P2 on the latest commit (or the Codex triage
judge passes it, [codex-triage.md](codex-triage.md)), and the plan check
finds nothing missing.
