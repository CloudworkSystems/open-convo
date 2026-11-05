# Creator proof kit

A local record of a creator's original posts, a report pack for a stolen video, an impersonation or a fake fundraiser, and a one-file page of the creator's real links. It sends nothing and publishes nothing. Node 22 or later. No dependencies.

```sh
cd packages/creator-proof
npm test
```

The command, from the repo root:

```sh
node packages/creator-proof/bin/creator-proof.mjs <command> --ledger <file>
```

`--ledger` is required. The kit will not guess a path.

## What the record shows

This is your own record. It shows what you recorded, not when, to anyone else.

The ledger is a list of entries on your computer. Each entry is hashed, and each hash includes the hash before it. `verify` checks that the file is complete and in order. A passing check means that. It does not show that nobody could have rewritten the file, and it does not show the time to anyone else.

The only outside mark of time is a copy of the latest proof code that you cannot edit later. In this kit that mark is an email you sent, dated when it arrived in someone else's inbox. A post can be edited without a new date, so a post is only your own statement. A page on your own site can be edited too, so the pack says only that the page shows the proof code today. The strongest evidence that a video was yours first is still the platform's own post date and link.

## Commands

```sh
node packages/creator-proof/bin/creator-proof.mjs record <media file> --title "<text>" [--platform "<text>"] [--post-url <url>] [--posted-at <time>] --ledger <file>
node packages/creator-proof/bin/creator-proof.mjs amend <original id> [--platform "<text>"] [--post-url <url>] [--posted-at <time>] [--notes "<text>"] --ledger <file>
node packages/creator-proof/bin/creator-proof.mjs verify --ledger <file>
node packages/creator-proof/bin/creator-proof.mjs report --case <case.json> --out <pack.md> [--force] --ledger <file>
node packages/creator-proof/bin/creator-proof.mjs links --links <links.json> --out <page.html> [--force] --ledger <file>
node packages/creator-proof/bin/creator-proof.mjs unlock --ledger <file>
```

`record` hashes the file in pieces, reads the clock once, and appends one entry. `amend` reads the clock once and appends the new facts. The original entry is not rewritten. `verify`, `report` and `links` do not read the clock.

Every save writes a small head file beside the ledger (`<ledger>.head`), then the ledger, then the head file again. Each write is a temporary file in the same folder, renamed into place. The ledger, the head and a report pack are owner-only (`0600`). The real links page uses the usual new-file mode, because it is meant to be public.

The first `record` says `Started a new proof ledger at <file>. Keep a copy somewhere safe.` Recording the same file again says `This file is already recorded as <id>.`

## Try the invented creator

River Lane is invented. The two `.mov` files are tiny text files, not films. The links use `example` hosts.

```sh
node packages/creator-proof/bin/creator-proof.mjs record packages/creator-proof/samples/river-lane/meadow-morning.mov --title "Meadow morning" --platform Townstage --ledger /tmp/river-lane.json
node packages/creator-proof/bin/creator-proof.mjs record packages/creator-proof/samples/river-lane/lantern-talk.mov --title "Lantern talk" --ledger /tmp/river-lane.json
node packages/creator-proof/bin/creator-proof.mjs amend orig-a866ffa25fc7 --post-url https://social.example/riverlane/meadow --posted-at 2026-01-02T00:00:00.000Z --ledger /tmp/river-lane.json
node packages/creator-proof/bin/creator-proof.mjs report --case packages/creator-proof/samples/river-lane/case.json --out /tmp/river-lane-pack.md --ledger /tmp/river-lane.json
node packages/creator-proof/bin/creator-proof.mjs links --links packages/creator-proof/samples/river-lane/links.json --out /tmp/river-lane.html --ledger /tmp/river-lane.json
```

Open `/tmp/river-lane.html` with the network off. The page should show in full, including the links. The pack's checklist is also printed.

`--out` will not replace an existing pack or page unless you pass `--force`. The ledger is only extended by `record` and `amend`.

## Where the page can go

The page is one HTML file. It has no script, no form, and no file from anywhere else. It can sit on the creator's own site or link-in-bio page. Putting it on a True Convo domain publishes it, and that needs the owner's yes (AGENTS.md "Limits"). This kit does not publish it.

## Report pack

`report` writes one markdown file and prints a checklist and any missing facts. The case `kind` is `stolen-video`, `impersonation` or `fake-fundraiser`. A fake fundraiser also names `paymentService.name` and the account shown on the copy. If that is missing, the pack still names "the payment service on the fake link" and lists it under missing.

The pack names where to report in words. It does not open a form and it does not send anything. For fans who already gave, it names ReportFraud.ftc.gov and IC3.gov, which are the two places named for that note. Meta's forms are not given as web addresses, because those forms change.

## Library

`src/index.mjs` exports `recordOriginal`, `amendOriginal`, `verifyLedger`, `currentOriginals`, `buildReport` and `realLinksPage`. They do not read the clock, the disk or the network. Pass `expectedHead` from the head file, or pass a complete result from `verifyLedger`. Without a head, the result says the end of the ledger can't be checked, and the other functions refuse it.

## Owner trial

Use the sample files above, or other invented files. Do not use a real creator, post or donation link.

1. `record` two sample files and read "Started a new proof ledger".
2. `record` one of them again and read the refusal that names its id.
3. Change one character in the ledger and `verify`. It names the entry and says to restore your copy. Restore the file.
4. `amend` a post link, then `report` the sample fake-fundraiser case. Read the checklist and see that you could follow it under stress.
5. `links` writes the page. Open it in Safari with the network off. It shows in full, links included.
6. `report` and `links` with a ledger path that does not exist yet say "Record at least one original first:" and show the `record` command.
7. Copy a sample file, remove your permission to read it, and `record` it. The message names that file. The ledger is unchanged. Put the permission back.
8. Start `record` on a large sample and stop it with Control-C. `verify` still passes and says either "nothing was added" or "Your last record was saved." `record` the file again and it is recorded once.

## Edge cases

These are choices the plan does not spell out.

- The ledger file is a JSON array. The head file is `<ledger>.head` and holds `state` (`pending` or `committed`), `seq`, `entryHash` and `prev`. The lock is `<ledger>.lock`. A recovery lock is `<ledger>.lock.reclaim`.
- Each entry's id is `entry-<seq>`. An original's id is `orig-` plus the first 12 hex digits of the file hash. A different file that shares those 12 digits gets `-2`, then `-3`. The same file hash cannot be recorded twice.
- Facts you do not have yet are left out. `amend` stores the new facts under `changes`. Empty text clears a fact. Only platform, post link, posted date and notes can be added later.
- An omitted expected head means the end was not checked. `null` means the ledger is expected to be empty. A missing ledger file and a missing head file start a new ledger. A ledger file with no head file is not called complete.
- A save that stops before the ledger write adds nothing. The next check puts the head back. A save that stops after the ledger write and before the last head write is finished on the next check ("Your last record was saved."). A committed head whose entry is no longer in the ledger is reported as cut off, not as an unfinished save.
- Text fields are at most 100,000 characters. The ledger file is at most 32 MB, and a ledger is at most 100,000 entries. A case file or a links file is at most 1 MB. The media file itself has no size cap; it is hashed in 64 KB pieces.
- `recordedAt` and `postedAt` are UTC times ending in `Z`, with no leap second. The page shows `updatedAt` as you wrote it.
- The command stores the media file's base name, not its folder.
- The clock is read once, only for `record` and `amend`, and only after the file and the ledger have been checked.
- A link page accepts only `https` addresses with a host, up to 2,000 characters, and refuses spaces, quotes and a user name in the address. An empty link list is allowed. The page then says no donation link is listed.
- `paymentService` is only for a fake fundraiser. If the service is named but the account on the copy is missing, the pack is still written and that account is listed under missing. `anchors`, when present, must be a list. An anchor `kind` is `email`, `post` or `page`. Any other kind is refused. An anchor whose proof code is not in the ledger is refused.
- `--out` cannot be the ledger, its head file, or its lock, even with `--force`.
- A lock from another computer is left in place. `unlock` removes a recovery lock only when that computer is this one and that process is gone, or when the recovery lock cannot be read. A process id that a new process has reused looks live, so that lock stays until the process exits.
- If the existing ledger, head or pack is tighter than `0600`, that mode is kept. If it is wider, the new file is `0600`. The real links page keeps the usual new-file mode.
- A symlink at the ledger, head, lock, pack or page path is refused. Nothing is followed.
- A temp file can remain if the process is killed during a write. The previous ledger, pack or page stays whole.
- Notes may be more than one line. Tables show them on one line. Copy links and post links are text in the pack. The kit does not open them.
