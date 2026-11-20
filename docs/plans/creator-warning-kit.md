# Creator Warning Kit (PRD)

Status: Draft (Nov 5): proposed for GrokBot team B in pull request #303; waiting on the owner's yes.

Written November 5, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261105-creator-warnings`. Umbrella: Creators (the first public-facing
project). It is slice 2 of the creator protection work in
[creator-protection.md](../design-notes/creator-protection.md): candidate
feature 4, the **follower warning kit** ("posts and pinned comments that
warn followers without sounding like a scam"), which the owner listed among
the pieces that matter on October 2 ("official link with follower
warnings"). It builds on slice 1, the creator proof kit
([creator-proof-kit.md](creator-proof-kit.md), merged November 5 as #301),
and reuses its confirmed links file and proof ledger. **Builder:** GrokBot
team B, under AGENTS.md "Outside Builders" (it built slice 1).
**Reviewers:** Codex reviews every push; the coordinator checks the result
against this plan. **Finish line:** the pull request merges with `tests`
passing, the command writes the warning kit for the invented sample creator,
and the owner trial below passes.

## Why

When an impostor reposts a creator's videos with their own donation link,
fans can't tell which account is real. Slice 1 gives the creator one page
of real links. Fans still need to hear it where they already are: in the
bio, under the videos and in a pinned comment. Under stress, a creator
writes warnings that sound panicked, include the wrong link, or look like
the scam itself ("DM me to donate"). This slice turns the creator's
confirmed links into short, calm, ready-to-paste text, checked so that it
names only the confirmed links and never asks fans to do anything a scammer
would ask. It is local text from local files: no Meta, no network, no AI,
no cost.

## What It Does

Inside `packages/creator-proof/`, plain JavaScript, no dependencies. The
library reads no clock, no files and no network.

### 1. The Library

`warningKit({ creatorName, links, impostors, limits, ledgerHash, updatedAt })`
returns `{ pieces, warnings }`.

- `creatorName`, `links` and `updatedAt` are the same fields, with the same
  checks, as slice 1's links file (`realLinksPage`): only `https:` links,
  each `{ label, url, kind }` with `kind` one of `donate`, `account` or
  `other`. The kit reuses slice 1's link checks rather than copying them, so
  a link the page refuses is refused here too.
- At least one `donate` link is required ("Add your donation link to the
  links file first; the warnings point fans to it."). The first `donate`
  link in the file is the **main link**.
- `impostors` is optional: a list of `{ handle, platform }` for accounts the
  creator has seen copying them. Handles are shown as plain text, never as
  links.
- `limits` is optional: `{ <piece key>: <number of characters> }`. Platform
  limits change and differ by platform, so the kit has **no built-in
  limits**: the creator (or the sample) supplies them, and the README says to
  check the platform's current limit.
- `ledgerHash`, when given, is the ledger's last `entryHash`. It appears in
  the pinned comment as the same "proof code" the links page shows, so a fan
  can match the two.

`pieces` is a list, always in this order, each
`{ key, title, text, characters, limit, overLimit }`:

1. `bio-line`: one line for the profile bio. "My only donation link:
   <main link>."
2. `caption-footer`: two short lines to end every caption. "Real account:
   <creatorName>. I only take donations at <main link>."
3. `pinned-comment`: a few sentences for a pinned comment. It says that
   copies of the creator's videos are being posted by other accounts, that
   the creator never asks for money in messages, lists every `donate` link,
   and, when a `ledgerHash` is given, gives the proof code and says it
   matches the real links page.
4. `impostor-post`: only when `impostors` is not empty. A short post that
   names each impostor handle and platform as text, says it is not the
   creator, asks fans to report it with the platform's own report button and
   not to send it money, and gives the main link.

`characters` counts what a person sees (Unicode code points after
normalizing to NFC). When `limits` names a piece, `limit` is that number and
`overLimit` is `true` if `characters` is greater; otherwise `limit` is
`null` and `overLimit` is `false`.

`warnings` lists plain sentences for anything the creator should fix, for
example "The bio line is 172 characters; your limit for it is 150." or "No
impostors listed, so there is no impostor post."

### 2. The Calm-Words Rules

Every piece is built from fixed sentence templates in one file
(`src/warning-words.mjs`), so wording is reviewed once. A check run on every
piece before it is returned refuses (throws) if a piece:

- holds any web address that isn't one of the confirmed links, exactly as
  written;
- asks fans to message, DM, call, text, email or reply to get a link or to
  give;
- uses pressure words: "urgent", "act now", "hurry", "last chance",
  "immediately", "limited time" (case-insensitive, whole words);
- holds a link shortener's address or any `http:` address.

The check is exported (`checkWarningText(text, links)`) so tests and later
slices can use it.

### 3. The Command

`node packages/creator-proof/bin/creator-proof.mjs warnings --ledger <file>
--links <links.json> [--impostors <impostors.json>] [--limits <limits.json>]
--out <kit.md>`

- Reads the ledger and verifies it exactly as the `links` command does, and
  uses its last `entryHash` as the proof code. An empty or failing ledger is
  refused with slice 1's own messages.
- Writes one Markdown file: a short note at the top ("Paste each piece where
  its title says. Check each platform's current character limit."), then
  each piece under its title in a fenced text block with its character
  count and limit, then the `warnings`.
- Prints each piece's title, character count and any warning.
- Writes with slice 1's temporary-file-plus-rename helper; `--out` refuses
  to overwrite without `--force` and refuses any path that is the ledger or
  one of its companion files, exactly like `report` and `links`.

## When It Goes Wrong

The command's output is a screen the owner (and later a creator) sees, so it
answers the five questions in [when-it-goes-wrong.md](when-it-goes-wrong.md):

1. **No connection.** Doesn't apply: local files only, nothing is fetched or
   sent.
2. **Interrupted.** One write, a temporary file plus rename, so a stopped
   run leaves no kit or the old kit whole; running it again writes it.
3. **Empty or first run.** An empty ledger says slice 1's "Record at least
   one original first:" with the `record` command. A links file with no
   `donate` link says "Add your donation link to the links file first; the
   warnings point fans to it."
4. **Denied or stuck.** A file the command can't read or write is named with
   why ("Can't read impostors.json: permission denied."), and nothing is
   written.
5. **The error message.** Each refusal says what, where and what to do. A
   piece that fails the calm-words check is never written; the message names
   the piece and the rule ("The pinned comment would ask fans to message
   you, which is what scammers ask. Nothing was written."). A malformed
   impostors or limits file names the file and the entry ("impostors.json
   entry 2 has no handle.").

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/creator-proof/` (the existing tests plus these, all
with invented creators, handles and links):

1. The sample creator's kit gives the four pieces in order with the expected
   text (a fixed snapshot), and without impostors gives three pieces and the
   "No impostors listed" warning.
2. Every piece passes `checkWarningText`; every web address in every piece
   is one of the confirmed links; impostor handles never appear as links.
3. `checkWarningText` refuses each rule with a test case: an unlisted link,
   "DM me", "message me for the link", "urgent", an `http:` link and a
   shortener address; and it passes the sample's pieces.
4. A links file with no `donate` link is refused; an `http:` or `javascript:`
   link is refused with the same message as `realLinksPage`; a name, label
   or handle with `<script>`, quotes, backticks and `&` comes out as plain
   text and can't break out of its fenced block.
5. Character counts: a piece with an emoji and an accented name counts what
   a person sees; a `limits` entry under the count sets `overLimit` and adds
   the warning; with no `limits`, nothing is flagged.
6. The proof code in the pinned comment equals the ledger's last
   `entryHash`, and is left out when no ledger hash is given to the library.
7. The library still imports no `fs`, `child_process`, `net`, `http`,
   `https` or `dgram` and reads no clock (the existing source test covers the
   new files).
8. The command: writes the kit for the sample; refuses an empty ledger, a
   failing ledger, `--out` over an existing file without `--force`, and
   `--out` naming the ledger or a companion file; a malformed impostors file
   names the entry.

**Owner trial checks** (the owner, or an agent on his Mac for him, with the
package's invented sample, nothing real committed):

1. Run `warnings` for the sample creator with the sample impostors and
   limits, open the kit, and read the four pieces.
2. Confirm each piece sounds calm and would not look like a scam to a fan,
   and that the only links in it are the sample's real ones.
3. Confirm the proof code in the pinned comment matches the one on the real
   links page from slice 1.
4. Shorten one limit in a copy of the limits file and see the over-limit
   warning name the piece.
5. Remove the donation link from a copy of the links file and see "Add your
   donation link to the links file first".
6. Run it on an empty ledger and see "Record at least one original first:".
7. Run it again with the same `--out` and see the refusal to overwrite.
8. Change the creator name in a copy of the links file to "Urgent River
   Lane" and see the calm-words refusal name the piece and the rule, with
   nothing written.
9. Delete the handle from one entry in a copy of the impostors file, then
   put a word where a number belongs in a copy of the limits file, and see
   each message name the file and the entry.
10. Point `--impostors` at a copy he can't read (permissions removed) and
    see the file named with nothing written.

He confirms each message says what to do next.

## Out Of Scope For This Slice

Posting anything, any platform or Meta API, finding impostors, reading a
platform's limits, translations, images or video overlays, scheduling, any
AI wording, and wiring into the app. Built-in platform character limits are
left out on purpose (they change); the creator supplies them.

## Rules For The Builder (GrokBot Team B)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, through Cursor, on the branch
  `OC-261105-creator-warnings`, signed in as `cloudwork-bot`. Open a pull
  request into `main` with auto-merge off and the label `agent: grokbot`.
  Never push to `main` directly, and never switch on auto-merge.
- Mark the work as AGENTS.md "Accounts And Provenance" says: `Cursor Agent`
  as commit author, and `— GrokBot team B, OC-261105-creator-warnings` as
  the last line of the pull request description and every comment.
- Run **no commands on the owner's Mac** for this job.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented creators, handles and links only: no real names, accounts,
  posts or donation links, and nothing about the real case that started
  this work.
- Change files only under `packages/creator-proof/`. Nothing else, not even
  `STATUS.md` (the coordinator updates it). Keep slice 1's behavior and
  tests unchanged, except to share its link checks and write helper.
- JavaScript modules (`.mjs`), Node 22 or later, tests with `node --test`.
- No network calls, no AI, no paid services, no `child_process`, in the code
  or the tests. No `fs` and no clock in the library.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the library, the command, the tests, a sample
  impostors file and limits file for the existing sample creator, and a
  README section (what the kit is for, the command, that limits come from
  the creator). Finishable in one to two days.
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
