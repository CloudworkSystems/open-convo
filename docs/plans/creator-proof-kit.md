# Creator Proof Kit (PRD)

Status: Draft (Nov 4): waiting on the owner's yes in the Claude thread "Draft next plans for outside builders".

Written November 4, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261104-creator-proof`. Umbrella: Creators (the first public-facing
project, owner's choice November 3). It is the first slice of the creator
protection work in
[creator-protection.md](../design-notes/creator-protection.md), taking
three of the four pieces the Claude thread "Protect creators from content
theft" proposed on November 3: dated proof that each post is the creator's,
filled-in theft, impersonation and fake-fundraiser reports with the
evidence attached, and a "real links" page a fan can check before giving.
The fourth piece, walking the creator through turning on Meta's own
protection, needs current facts from Meta's pages and stays with that
thread. **Builder:** GrokBot team B, under AGENTS.md "Outside Builders",
through Cursor and signed in as `cloudwork-bot`. **Reviewers:** Codex
reviews every push; the coordinator checks the result against this plan.
**Finish line:** the package merges with `tests` passing, the command runs
the invented sample creator end to end (record two originals, build a
report for a sample stolen copy, write the real links page), and the owner
trial below passes.

## Why

When an impostor reposts a creator's videos with their own donation link,
the creator has to prove three things fast, to Meta and to fans: the video
is theirs, it was theirs first, and the real donation links are these.
Today that proof is scattered across a camera roll, old posts and memory,
and the reports are typed from scratch under stress. Outside apps can't
search Facebook or Instagram for the copies (the design note's research),
but none of the three pieces here needs Meta: they are local records,
local text and one static page. That makes them small, testable and
shippable without anyone's approval but the owner's. The design note calls
creator protection a subscription module; this slice runs entirely on the
creator's own computer at no ongoing cost, so it meets the October 22 rule
for joining the core (PLAN.md "What joins the core"), and the paid pieces
(any Meta-approved app) stay for later.

## What It Does

`packages/creator-proof/`, plain JavaScript, no dependencies. The library
reads no clock, no files and no network; the command does the file work and
supplies the time.

### 1. The Proof Ledger

A creator records each original once, ideally the day it is posted.

- `recordOriginal(ledger, original, { recordedAt })` returns a new ledger
  with one entry appended (the input is never changed). `original` is
  `{ title, fileName, fileSha256, sizeBytes, platform, postUrl, postedAt,
  notes }`. `title`, `fileName` and `fileSha256` are required; the rest are
  optional and can be added later with `amendOriginal` (below).
- Each entry gets `id` (`orig-` plus the first 12 hex characters of
  `fileSha256`, with `-2`, `-3` and so on when two files share them),
  `seq` (1, 2, ...), `recordedAt` (an ISO 8601 UTC time from the caller),
  `prevHash` (the previous entry's `entryHash`, or 64 zeros for the first)
  and `entryHash` (SHA-256 of the entry's canonical JSON without
  `entryHash`, keys sorted). SHA-256 comes from `node:crypto`, which is not
  a file or network module.
- `amendOriginal(ledger, id, changes, { recordedAt })` appends an `amend`
  entry naming `id` and the changed fields (`platform`, `postUrl`,
  `postedAt`, `notes` only). The original entry is never rewritten, so the
  ledger shows when each fact was added.
- `verifyLedger(ledger)` recomputes every hash and the chain and returns
  `{ ok, problems }`, where each problem names the entry's `seq` and what
  is wrong (changed, missing, out of order, duplicate id). Every other
  function refuses a ledger that fails it, with the first problem in the
  message.
- `currentOriginals(ledger)` folds amendments in and returns each original
  with its latest facts and the time each fact was recorded.
- Recording the same `fileSha256` twice is refused ("This file is already
  recorded as <id>."), so one video has one id.
- **What the proof means, and what it doesn't** (carried from Codex's
  review on #289). The ledger is the creator's own record on their own
  computer. The hash chain catches an accidental or partial change (one
  entry edited, a middle entry removed, entries reordered). A chain alone
  can't show that the newest entries were cut off the end, so
  `verifyLedger(ledger, { expectedHead })` also takes the last `seq` and
  `entryHash` the creator saw, and reports "The ledger ends at entry <n>, but
  your last record was entry <m>." when they differ. The command keeps that
  head in a small file beside the ledger (`<ledger>.head`) holding the new
  head and the one before it (`{ seq, entryHash, prev }`, where `prev` is
  `null` before the first entry). Each append writes the head file first
  (temporary file plus rename), then the ledger. On every check: the
  ledger's last entry equals the head, so the end is complete; or the ledger
  ends at `prev` (or is missing or empty when `prev` is `null`), so the last
  record didn't finish, and the command says "Your last record didn't
  finish, so nothing was added." and puts the head back to `prev`; anything
  else is the cut-off message above. With no head file at all, it says the
  end of the ledger can't be checked and never calls it complete. Tests
  cover a stop after the head write and before the ledger write, on the
  first record and on a later one.
  Anchors (below) are a second, outside check of the head. Anyone who can
  edit the file can rewrite an entry and recompute every later hash, so a passing `verify` is
  never presented as tamper evidence or as proof of when a file was
  recorded. The README, the pack and the command all say this in plain
  words ("This is your own record. It shows what you recorded, not when,
  to anyone else."). The only thing that pins the ledger in time is a copy
  of its latest `entryHash` placed somewhere the creator can't rewrite
  later: the "proof code" on a published real links page (section 3), or a
  post or email that carries it, whose own date then counts. The pack lists
  any such anchors the creator gives it (`theCase.anchors`, each `{ where,
  date, entryHash }`) and says which originals were recorded before each
  one. The strongest evidence of "first" is still the platform's own post
  date and link, which the report puts first.

### 2. The Report Pack

`buildReport(ledger, theCase)` returns `{ markdown, checklist, missing }`.

- `theCase` is `{ kind, copies, originalIds, seenAt, creatorName, notes,
  anchors, paymentService }` (`anchors` optional). `paymentService` is
  `{ name, accountShownOnCopy }`, the payment service and account the fake
  link points to, as the creator reads them off the copy. It is used only
  for `fake-fundraiser`; when it is absent there, the report still names
  "the payment service on the fake link" and lists it in `missing`.
  `kind` is `stolen-video`, `impersonation` or `fake-fundraiser`. `copies`
  is a list of `{ url, accountName, accountUrl, seenAt, whatItShows }`, at
  least one. `originalIds` name ledger entries; an unknown id is refused.
- `markdown` is one evidence document:
  1. a one-paragraph summary in plain words ("These 2 videos are mine. The
     account below reposted them and asks for donations.");
  2. a timeline sorted by time: each original's `postedAt` and
     `recordedAt`, and each copy's `seenAt`, labeled by source;
  3. a table of the originals: title, platform, post link, posted date,
     file name, size and SHA-256;
  4. the copies, with their links and what each shows;
  5. drafted report text for each place that fits the kind (below), with
     `[brackets]` where only the creator can fill in a fact;
  6. the entry hashes, any anchors with the originals each one covers, and
     the plain-words note on what the ledger does and doesn't show. A
     passing check is reported as "the file is complete and in order", never
     as proof against changes.
- **Where to report**, by kind. The pack names each place in words, never a
  web address, because Meta's forms and their eligibility change (the
  design note's recheck rule). The places come from one table in
  `src/destinations.mjs`:
  - `stolen-video`: Meta's copyright report form; the platform's in-app
    report on each copy.
  - `impersonation`: Meta's impersonation report form (for the person
    impersonated, who may be asked for ID, which goes to Meta directly and
    never through True Convo); the in-app report.
  - `fake-fundraiser`: both of the above, plus the payment service named on
    the fake account's link (`theCase.paymentService.name`), plus a note for
    fans who already gave: ReportFraud.ftc.gov and IC3.gov (the two places
    the design note lists).
- `checklist` lists each step for the creator (open the form, paste section
  5, attach the files named in the table, keep the case number), one per
  place. `missing` lists facts the pack needed and didn't have (an original
  with no `postUrl` or `postedAt`, a copy with no `seenAt`), each with a
  plain sentence on why it matters. A report with missing facts is still
  built, with the gaps marked.
- The pack never sends anything. Filing is the creator's own act.

### 3. The Real Links Page

`realLinksPage({ creatorName, intro, links, updatedAt, ledgerHash })`
returns one HTML document as a string.

- `links` is a list of `{ label, url, kind }`, where `kind` is `donate`,
  `account` or `other`. Only `https:` links are accepted. Each is shown as
  text and as a link, so a fan can compare the address letter by letter.
- The page says, in plain words near the top: "These are the only real
  donation links for <name>. Anything else asking for money in my name is
  not me." It shows `updatedAt` and, if given, the ledger's last
  `entryHash` as a small "proof code".
- Self-contained: no scripts, no external fonts, images or styles, no
  forms, no tracking. Every value is HTML-escaped. A `<meta
  name="robots">` tag is not added (the creator wants it found).
- Publishing the page is out of scope. The README says where it could go
  (the creator's own site or link-in-bio page) and that publishing needs
  the owner's yes when it is on a True Convo domain (AGENTS.md "Limits").

### The Command

`node packages/creator-proof/bin/creator-proof.mjs <command>`, with one
ledger file (`--ledger <file>`, JSON):

- `record <media file> --title <text> [--platform] [--post-url]
  [--posted-at]` hashes the file by streaming it (any size), reads the
  clock once for `recordedAt`, and appends the entry.
- `amend <id> [--platform] [--post-url] [--posted-at] [--notes]`.
- `verify` prints the verify result.
- `report --case <case.json> --out <pack.md>` writes the pack and prints the
  checklist and the missing facts.
- `links --links <links.json> --out <page.html>` writes the page.
- Every write is a temporary file in the same folder plus a rename. The
  ledger is re-read and verified just before each append, and the append is
  refused if the file changed since it was read. `--out` refuses to
  overwrite an existing file without `--force`; the ledger is never
  overwritten except by its own append. Without `--ledger`, the command
  refuses rather than guessing a path.

## When It Goes Wrong

The command's output is a screen the owner (and later a creator) sees, so it
answers the five questions in [when-it-goes-wrong.md](when-it-goes-wrong.md):

1. **No connection.** Doesn't apply: everything is local files, nothing is
   fetched or sent.
2. **Interrupted.** Temporary file plus rename for every write, so a stopped
   run leaves the old ledger, pack or page whole. A `record` or `amend`
   that stops before its ledger write adds nothing ("Your last record
   didn't finish, so nothing was added."); one that stops after the ledger
   write but before the last head write is finished at the next check
   ("Your last record was saved."). Either way, running `record` again
   records the file once: if it was saved, it says "This file is already
   recorded as <id>." The owner trial checks this
   ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465191580)).
3. **Empty or first run.** With no ledger file yet, `record` creates it and
   says "Started a new proof ledger at <file>. Keep a copy somewhere safe."
   `report` and `links` with an empty ledger say "Record at least one
   original first:" and show the `record` command.
4. **Denied or stuck.** A file the command can't read or write says which
   file and why ("Can't read video.mov: permission denied."), and nothing
   is changed. No prompts, permissions or network.
5. **The error message.** Each refusal says what, where and what to do,
   for example "Ledger entry 4 was changed after it was recorded, so
   nothing was added. Restore the ledger from your copy." A ledger that
   fails verification is never written to.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/creator-proof/` (Node's built-in runner, invented
creators, files and links only):

1. Recording two originals gives the expected ids, `seq`, chain and hashes
   (fixed `recordedAt`); the same file twice is refused; two files sharing
   12 hex characters get `-2`.
2. `amendOriginal` appends, never rewrites; `currentOriginals` shows the
   latest facts and when each was recorded.
3. `verifyLedger` catches a changed field, a removed entry, a swapped order,
   a changed `prevHash` and a duplicate id, each named by `seq`; with an
   `expectedHead`, a ledger with its last entry removed is caught; with no
   head, the result says the end can't be checked; every other function
   refuses a failing ledger.
4. `buildReport` for each kind gives the expected sections and places; the
   timeline is in time order; an unknown original id is refused; missing
   post links and dates appear in `missing` and as marked gaps; a
   `fake-fundraiser` case names its `paymentService` in the places and the
   checklist, and one without it lists it in `missing`; an anchor
   lists exactly the originals recorded at or before its `entryHash`, and an
   anchor whose `entryHash` isn't in the ledger is refused; the pack never
   calls a passing check proof against changes (a test scans for the
   plain-words note and for the words "tamper" and "proves").
5. The pack contains no web address for any reporting place (a test scans
   the drafted sections).
6. `realLinksPage` escapes every field (a name and label with `<script>`,
   quotes and `&`), refuses an `http:` or `javascript:` link, and the
   output has no `<script`, no `<form`, no `src=` or `href=` to anything
   but the given links.
7. The library never imports `fs`, `child_process`, `net`, `http`, `https`
   or `dgram` and never reads the clock (a test checks the source).
8. The command: `record` on a sample file larger than 64 MB (generated in
   the test's temporary folder, never committed) streams it; `--out`
   refuses to overwrite without `--force`; a ledger changed between read
   and append is refused; every write is a temporary file plus rename; no
   `--ledger` is refused.

**Owner trial checks** (the owner, or an agent on his Mac for him, with
invented sample files from the package, nothing real committed): `record`
two sample videos and see the "Started a new proof ledger" message; record
one again and see the refusal; edit one character in the ledger and see
`verify` name the entry; restore it, `amend` a post link, and build a
`fake-fundraiser` report for the sample case; read the pack and confirm a
creator under stress could follow its checklist; write the real links page
and open it in Safari with the network off, and confirm it shows fully,
links included; run `report` and `links` on an empty ledger and see the
"Record at least one original first:" message; point `record` at a file
he can't read (permissions removed on a copy) and see it named with
nothing changed; stop a `record` of the large sample part-way (Control-C)
and confirm `verify` still passes and says either "nothing was added" or
"Your last record was saved.", then `record` it again and see it recorded
once. He confirms each message says what to do
next.

## Out Of Scope For This Slice

Finding copies on any platform, any Meta or other API, filing reports,
uploading anything, publishing the page, third-party timestamps, reading a
post's date from its link, the Meta protection walkthrough (the other
thread's piece), wiring into the app, and any AI.

## Carried To The Build

Plans stop after two Codex rounds (AGENTS.md "Keeping Finished Work
Moving"); these later findings are requirements for the code pull request.

- Every public function that reads the ledger (`buildReport`,
  `currentOriginals`, `amendOriginal`, `recordOriginal`) takes the expected
  head (or a value returned by `verifyLedger` that carries it) and refuses or
  marks the result incomplete when the ledger's end doesn't match it, so a
  report never omits a cut-off newest entry while calling the ledger
  complete ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4464855303)).
  Tests remove the last entry and the last amendment and run each of these
  functions.
- The ledger, its head file and report packs are written owner-only:
  temporary files are created with mode `0600`, and replacing an existing
  file keeps that file's mode only when it is no wider than `0600`, so a
  rename never broadens it. The real links page is meant to be public and
  keeps the default mode. A test checks the modes under umask `022`
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4464882002)).
- Ledger entries and originals have separate identities: every entry has
  a unique entry id (for example `entry-<seq>`), originals keep their
  `orig-` id in a separate `originalId` field, and an `amend` entry carries
  its own entry id plus `targetOriginalId` naming the original it changes.
  `verifyLedger` rejects duplicate entry ids, duplicate `originalId`s on
  record entries, and an amendment whose target doesn't exist earlier in
  the chain. A test amends an original and checks the ledger still
  verifies and `currentOriginals` folds the change in
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4464984476)).
- The head file tells a finished append from a cut-off one: it carries
  `state` (`pending` or `committed`). An append writes the head as
  `pending`, then the ledger, then the head again as `committed`, each
  through a temporary file and a rename. Recovery puts the head back to
  `prev` only when the state is `pending` and the ledger still ends at
  `prev`. A `pending` head whose entry is already the ledger's last entry
  (a stop after the ledger rename, before the final head write) is
  finished instead: recovery verifies that entry and rewrites the head as
  `committed`, and says "Your last record was saved." A `committed` head whose entry
  is missing from the ledger is always the cut-off message, never "didn't
  finish". Tests delete the newest finished entry (and the newest
  amendment) and check `verify` reports the cut-off, plus a stop at each
  of the three writes
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465013053),
  [thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465077539)).
- A real links page on the creator's own site is never a dated anchor,
  since the creator can edit it and its `updatedAt` comes from the caller.
  The pack lists it as a current claim only ("Your page shows this proof
  code today."). Only anchors the creator can't rewrite count as dated: a
  platform post's own date, or an email's received date in someone else's
  inbox, each entered by the creator with `kind: "post"` or `"email"`; an
  anchor of kind `"page"` is never used to say an original was recorded
  before a date. The README and the pack say this in plain words, with a
  test for each kind
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465013064)).
- A post is not a dated anchor on its own date either, since many posts
  can be edited later without changing their date. The only anchor the
  pack treats as independently dated is an email the creator sent with
  the proof code, by its received date in someone else's inbox
  (`kind: "email"`). A `post` anchor is listed as the creator's own
  statement ("You say this code was in the post when it was first
  published on <date>. Anyone checking will look at the post's edit
  history.") and is never used on its own to say an original was recorded
  before a date. Tests cover a `post` anchor and an `email` anchor
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465420996)).
- Only one save changes a ledger at a time: `record` and `amend` take an
  exclusive lock beside the ledger (`<ledger>.lock`, created with `wx` so
  creation fails if it exists, holding the process id and host name)
  before reading the ledger, and release it after the committed head is
  written. A second save that finds the lock stops with "Another save is
  running on this ledger. Try again when it finishes." and writes nothing,
  unless the lock is stale: when its host is this computer and its process
  is no longer running (checked with `process.kill(pid, 0)`, no clock
  needed), any command says "An earlier save stopped without finishing;
  cleared its lock.", removes it and runs the head recovery at once. A lock
  whose process is still running, or from another host, is never removed.
  Tests force-stop a save at each write and check the very next `verify`
  recovers
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465234726)).
  A test starts two overlapping saves and checks one is refused and
  the other's entry is kept
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465048573)).
- Every command that can recover or rewrite the head (`verify`,
  `report`, `links` and any other reader that runs the "on every check"
  recovery) takes the same lock first; if a save holds it, the reader
  stops with the "Another save is running" message and changes nothing.
  Reading without recovering is allowed without the lock only when it
  changes no file and its result says the end couldn't be checked. Tests
  run a reader against a save paused at each of the three writes
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465166903)).
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
- `record` hashes a stable file: it reads the file's size and change time
  before streaming and again after, and refuses if either changed ("This
  file changed while it was being read. Wait until it has finished copying
  or saving, then record it again."), writing nothing. A test changes the
  file mid-read and checks the refusal
  ([thread](https://github.com/CloudworkSystems/open-convo/pull/289#discussion_r4465602365)).

## Rules For The Builder (GrokBot Team B)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, through Cursor, on the branch
  `OC-261104-creator-proof`, signed in as `cloudwork-bot`. Open a pull
  request into `main` with auto-merge off and the label `agent: grokbot`.
  Never push to `main` directly, and never switch on auto-merge.
- Mark the work as AGENTS.md "Accounts And Provenance" says: `Cursor Agent`
  as commit author, and `— GrokBot team B, OC-261104-creator-proof` as the
  last line of the pull request description and every comment.
- Run **no commands on the owner's Mac** for this job.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented creators, files and links only: no real names, accounts,
  posts or donation links, and nothing about the real case that started
  this work.
- Change files only under `packages/creator-proof/`. Nothing else, not even
  `STATUS.md` (the coordinator updates it).
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network calls, no AI, no paid services, no `child_process`, in the code
  or the tests. No `fs` and no clock in the library; the command may read
  the files it is given, write its outputs and the ledger, and read the
  clock once per `record` or `amend`.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the library, the command, the tests, a sample
  creator (two tiny sample media files, a case, a links file) and a short
  README (what the proof does and doesn't show, the commands, the owner's
  steps). Finishable in two to three days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Supported setups are macOS and the Linux CI runners on Node 22 (AGENTS.md
  "Review Guidelines"); don't add Windows-specific code.
- Edge cases this plan doesn't name: write each choice in the README's
  "Edge cases" section with a test.

## Review And Finish Line

Codex reviews it as code until it gives a 👍. GrokBot fixes every P1 and P2
or explains in the pull request why one doesn't apply. The coordinator
checks it against this plan, posts the check as a comment, and switches on
auto-merge once the plan check passes. Done when the tests pass with one
command, Codex has no open P1 or P2 on the latest commit (or the Codex
triage judge passes it, [codex-triage.md](codex-triage.md)), the plan check
finds nothing missing, and the owner trial passes.
