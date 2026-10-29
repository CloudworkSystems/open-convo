# Visibility Report (PRD)

Status: Built (Oct 25): merged in #112.

Written October 21, 2026 by a building session for the planning side, from
the approved scale-up plan (`docs/plans/scale-up.md`, option (a), which
merges in #94 with the limit of three outside modules). The builder starts
only after both this plan and #94 have merged. Session
name: `OC-261021-visibility-report`. Umbrella: Business. Design background:
[docs/design-notes/visibility-agent.md](../design-notes/visibility-agent.md).
Built by an outside builder under AGENTS.md "Outside Builders":
**GrokBot (team C)** builds, Codex reviews.

## Why

The Visibility Agent gathers a business's public picture and turns it into a
plain-English report with a short, prioritized fix list. Gathering (web
pages, listings, AI assistants) raises open questions about sign-ins, site
terms and cost that are decided later. The report itself doesn't depend on
any of them: given findings, it decides what to fix first and says it
plainly. Building that half now, with fixed and tested ranking rules, means
the gathering slice later only has to produce findings in this format.

The old checkup template in the archive stays behind. This is written fresh
from the design note, with invented businesses only.

## Plan Of Record

1. **Now:** a report renderer on its own: findings in, report out. No
   gathering, no app code, no storage code, no AI, no network.
2. **Later:** gathering the findings (web pages, listings, AI assistants,
   with approved routes and caps), a report page in each business's space in
   the Desk, and fixes handed to Site Engine.

## What It Does

A small library and command in `packages/visibility-report/`:

```
node packages/visibility-report/src/report.mjs --findings <findings.json> [--json <file>] [--md <file>]
```

1. **Reads one findings file** (JSON, up to 1 MB) for one business and
   checks it against the package's findings schema. Any field not in the
   schema, or a check kind not in the fixed list below, stops it with a
   plain message naming the field.
2. **Ranks the problems** with the fixed rules below.
3. **Writes the report** as Markdown and JSON. With no `--md` or `--json`, it
   prints the Markdown.

**It never overwrites its input or one output with the other.** Before
reading anything else, it refuses (with a plain message, writing nothing)
when `--json` or `--md` names the findings file, or when `--json` and `--md`
name the same file. Two paths count as the same file when any of these
holds:
- they are equal after resolving them fully (a relative path, a `..` or a
  symbolic link);
- both exist and have the same device and inode numbers (a hard link);
- their fully resolved paths are equal after Unicode NFC normalization and
  lowercasing, because on a case-insensitive file system (the macOS
  default) `Report.md` and `report.md` are one file even before either
  exists.

The same three rules apply to every pair: each output against the findings
file, and the two outputs against each other. On a case-sensitive file
system the third rule may refuse two paths that are really different; that
is deliberate, since a refusal costs only a renamed output.

## The Findings File

- `schemaVersion: 1`.
- `business`: `name`, and optionally `siteUrl` (a complete `https://`
  address).
- **Dates.** Every date (`reportDate`, `checkedOn`, `websiteCheckedOn`) is
  written `YYYY-MM-DD` and must be a real calendar date: it must match that
  pattern exactly, parse as a UTC date, and format back to the same text
  (so `2026-02-30`, `2026-02-29`, `2026-13-01` and `2026-00-10` are
  refused, and `2028-02-29` is accepted). A refused date names its field.
- `reportDate`: the date the report is for (`YYYY-MM-DD`). The report uses
  this date, never the computer's clock, so the same file always gives the
  same report.
- `findings`: a list. Each finding has an `id`: a string of 1 to 64
  characters using only `A`–`Z`, `a`–`z`, `0`–`9`, `.`, `_` and `-`, unique
  in the file. A repeated `id`, an `id` that breaks these rules, or an `id`
  that isn't a string (a number, for example) is refused with a plain
  message naming it. Ids are compared by plain character-code order (as
  JavaScript's `<` compares strings; no locale or number-aware sorting), so
  `B-2` comes before `a-1` and `item-10` before `item-9`. Then a `check` (one of the kinds
  below), a `status` (`ok`, `problem` or `unknown`), a `details` object for
  its kind (see "Details And Status" below), and where and when it was
  found: `source` and `checkedOn`
  (`YYYY-MM-DD`, not after `reportDate`).
- `source` is `{ label, url?, locator? }`. `url` is a complete `https://`
  address. `locator` is plain text saying exactly where to look again when
  there is no stable web address, for example "Asked Claude on 2026-10-14:
  'Who repairs bikes in Hearthwick?'". **Every finding, whatever its status,
  must have a `url` or a `locator`**, or the file is refused, because claims
  under "What's working" need provenance too.
- **Listing comparisons cite both sides.** A `listing-details-match`
  finding compares a listing with the website, so it needs two sources:
  `source` is where the listing was read, and `websiteSource` (same shape
  and rules: a label plus a `url` or a `locator`) is where the website was
  read, with its own `websiteCheckedOn` (not after `reportDate`). Both are
  required for this kind, whatever the status, and refused on every other
  kind.

Check kinds (fixed list; this plan sets each kind's fields, and the
package's schema implements them exactly):

| Kind | What it records |
| --- | --- |
| `listing-present` | Whether the business has a listing on a named directory or map service |
| `listing-details-match` | Whether a listing's name, address, phone or hours match the website, with both values for any that don't |
| `ai-mention` | Which AI assistant was asked which question, and whether the business was mentioned, mentioned with wrong details (with what was wrong), or not mentioned |
| `reviews` | Review count, how many in the last 90 days, and how many have no reply |
| `website-basics` | Whether the business has a website, and whether it has a page title, a description, a way to contact, and works on a phone |

### Details And Status

Each kind's `details` has **subject** fields, which say what was checked and
are always required, and **result** fields, which say what was found. Result
fields are required when `status` is `ok` or `problem` and must be absent
when it is `unknown`. No other fields are allowed. Text fields are 1 to 500
characters; counts are whole numbers from 0 to 1,000,000. A `mismatches`
entry whose `listing` and `website` values are the same text (compared
after removing leading and trailing spaces) is refused with a plain message
naming the finding's `id` and the field, because it isn't a mismatch.

**No hidden or line-breaking characters in displayed text.** Every text
field the report can show is checked when the file is read:
`business.name`, `source.label`, `source.locator`, `source.url`, the same
three in `websiteSource`, and every
text field in `details` (`service`, `assistant`, `question`,
`wrongDetails`, and each mismatch's `listing` and `website`). These are
refused, with a plain message naming the finding's `id` (where there is
one) and the field's path (for example `findings[3].source.locator`):
- U+0000 to U+001F, except a line feed (U+000A) in a multi-line field;
- U+007F to U+009F;
- U+2028 and U+2029.

The multi-line fields are `wrongDetails` and a mismatch's `listing` and
`website` (hours, for example, often run over several lines). In the
Markdown, a line feed inside one of them is written as a line break within
the same entry, indented so it can never start a new list item, heading or
paragraph. Every other text field is single-line.

| Kind | Subject | Result | Problems it can record (rank) |
| --- | --- | --- | --- |
| `listing-present` | `service` (text) | `present` (true or false) | `present` false: no listing (5) |
| `listing-details-match` | `service` (text) | `mismatches`: a list of `{ field, listing, website }`, where `field` is `name`, `address`, `phone` or `hours` (each at most once) and `listing` and `website` are text; the list may be empty | hours (1), phone (2), address (3), name (12), one per entry |
| `ai-mention` | `assistant`, `question` (text) | `result`: `mentioned`, `wrong-details` or `not-mentioned`; `wrongDetails` (text), required when `result` is `wrong-details` and absent otherwise | `wrong-details` (4), `not-mentioned` (8) |
| `reviews` | `service` (text) | `count`, `last90Days`, `unanswered` (counts; `last90Days` and `unanswered` each at most `count`) | `unanswered` above 0 (9), `last90Days` 0 (10), `count` below 10 (11) |
| `website-basics` | none (an empty object when `unknown`) | `hasWebsite` (true or false); when true, also `title`, `description`, `contact`, `worksOnPhone` (true or false), which must be absent when `hasWebsite` is false | `hasWebsite` false (6), `worksOnPhone` false (7), `title` false (13), `description` false (14), `contact` false (15) |

**Status must match the details.** `status` is `problem` exactly when at
least one problem in the last column applies, and `ok` exactly when none
does. A finding whose status disagrees with its details (for example
`reviews` marked `problem` with 20 reviews, 3 recent and none unanswered,
or marked `ok` with no reviews in the last 90 days) is refused with a plain
message naming its `id`. So every `problem` finding has at least one rank,
and the same finding is always ranked the same way.

## Ranking Rules (Fixed And Tested)

Only findings with status `problem` are ranked. Findings with status `ok`
or `unknown` have no group, no effort and no place in the fix list.

Every problem a finding can record has a fixed group, a fixed effort and a
fixed rank, set here and nowhere else:

| Rank | Problem | Kind | Group | Effort |
| --- | --- | --- | --- | --- |
| 1 | Listing hours differ from the website | `listing-details-match` | 1 | Quick |
| 2 | Listing phone differs from the website | `listing-details-match` | 1 | Quick |
| 3 | Listing address differs from the website | `listing-details-match` | 1 | Medium |
| 4 | An AI assistant gives wrong details | `ai-mention` | 1 | Slow |
| 5 | No listing on a named service | `listing-present` | 2 | Medium |
| 6 | No website | `website-basics` | 2 | Slow |
| 7 | Website doesn't work on a phone | `website-basics` | 2 | Slow |
| 8 | Not mentioned by an AI assistant | `ai-mention` | 2 | Slow |
| 9 | Reviews with no reply | `reviews` | 3 | Quick |
| 10 | No reviews in the last 90 days | `reviews` | 3 | Medium |
| 11 | Fewer than 10 reviews | `reviews` | 3 | Medium |
| 12 | Listing name written differently | `listing-details-match` | 4 | Quick |
| 13 | Website has no page title | `website-basics` | 4 | Quick |
| 14 | Website has no description | `website-basics` | 4 | Quick |
| 15 | No visible way to contact | `website-basics` | 4 | Quick |

The groups are: 1, wrong information customers act on; 2, hard to find;
3, weak trust signals; 4, polish. Inside a group, quicker fixes come first
(quick, then medium, then slow), and the rank column already follows that
rule, so the ranking is simply: sort problems by rank, then by `id` in
character-code order. The
same findings always give the same order, whatever order they arrive in.

A finding that records more than one problem (for example a listing whose
phone and name both differ) is ranked once, at the lowest rank number among
its problems, and the report names every problem in it.

- The **fix list** shows the first five ranked findings, not the first five
  individual problems: a finding with several problems takes one slot and
  lists all its problems in it. The rest appear under "Also found", in the
  same order. Every count in the report (the summary's "We found 4 things
  to fix", and how many are in the fix list and under "Also found") counts
  ranked findings the same way.
- A finding checked more than 30 days before `reportDate` (for a listing
  comparison, either side) keeps its place
  but is marked "Check again before acting: found *date*", because facts go
  stale.
- Findings with status `unknown` are never ranked; they are listed under
  "Couldn't check".
- Findings with status `ok` are listed under "What's working", each with
  its source and date.

## The Report

- A title with the business name and `reportDate`, then a two- or
  three-sentence summary built from fixed sentences (for example, "We found
  4 things to fix. The first two affect customers right now.").
- The fix list: for each problem, what's wrong, why it matters, and what to
  do, in plain words from fixed templates per kind, plus where it was found
  and when (the source label, then its link, or its locator in quotation
  marks when there is no link, and `checkedOn`). A listing comparison
  cites both: "Listing: *source* (*checkedOn*); website: *websiteSource*
  (*websiteCheckedOn*)", each written the same way. Every entry in every
  section (fix list, "Also found", "Couldn't check" and "What's working")
  cites its source with a link or a locator and its date, as the design
  note requires.
- "Also found", "Couldn't check" and "What's working" sections.
- **No grades, scores, guarantees or alarm words in the report's own
  wording.** Every sentence and template the renderer writes shows what was
  found and what to do; it never gives a letter grade or a number score,
  never promises results ("guaranteed", "#1 on Google"), and never uses
  words like "failing" or "terrible". Text copied from the findings (a
  business called "Score Bikes", a locator that mentions a review score) is
  shown as given; this rule is about the renderer's words, not the data.
- **Text from the findings is shown as plain text.** In the Markdown,
  characters that would make a link, image, heading, list item or HTML tag
  are escaped, and every `&` is written as `&amp;`, so text such as
  `&copy;` shows literally instead of becoming `©`. Only source URLs that
  passed the `https://` check become links.
- **Bare web and email addresses in text stay plain.** Some Markdown
  renderers (GitHub's among them) turn a bare `https://...`, `www....` or
  email address in ordinary text into a clickable link. So in every text
  field copied from the findings (names, labels, locators, details), each
  word that could become one is written as an inline code span, which
  renders as readable plain text and is never turned into a link. A word
  here is a run of characters without spaces, and it is wrapped when it
  contains `://`, starts with `www.` (any case), starts with `mailto:` or
  `xmpp:`, or contains `@`. The code span uses a run of backticks one
  longer than the longest run of backticks inside the word, with a space
  on each side when the word starts or ends with a backtick, as CommonMark
  requires; the word's own characters, `&` included, are not otherwise
  escaped inside it, because CommonMark shows code spans exactly as written
  and decodes no entities there.
  Only source URLs, written as links as below, are clickable.
- **Link addresses are made safe before they go in the Markdown.** A source
  URL is written as a link destination wrapped in angle brackets
  (`[label](<https://...>)`), after percent-encoding every `<` (`%3C`), `>`
  (`%3E`), space (`%20`), `(` (`%28`), `)` (`%29`) and backslash (`%5C`).
  Every `&` is written as the entity `&amp;`: CommonMark decodes it back to
  `&`, so the link's address is exactly the URL (a query string such as
  `?a=1&b=2` keeps both parameters), while something like `&copy;` in the
  URL becomes `&amp;copy;` and is never decoded into `©`. (Percent-encoding
  `&` as `%26` would change what the link points to, so it isn't used.)
  A URL containing a line break, tab or any other control character
  (U+0000 to U+001F, U+007F to U+009F, U+2028, U+2029) can't be made safe
  and is refused when the findings file is read, with a plain message
  naming the finding's `id`. The JSON form keeps the URL exactly as given.
- The JSON form (`schemaVersion: 1`) holds the same ranked list with each
  problem's group, position, sentences and source, and the other sections.
- Same input gives byte-identical output.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/visibility-report`, Node's built-in test runner,
invented businesses only (for example a fictional bike repair shop with a
street address and a fictional online bookkeeper, using `.example` web
addresses and 555 phone numbers). At least:

1. A complete findings file gives a report whose Markdown and JSON match
   saved expected files exactly.
2. Group order: one problem from each group, given in reverse order, comes
   out in group order.
3. All fifteen problems in the rank table, given in shuffled order, come out
   in rank order; two problems of the same rank come out by `id`; a finding
   with two problems takes the lower rank number and names both. Shuffling
   the input order never changes the output.
4. Only five ranked findings are in the fix list; the sixth and later go
   under "Also found". With six findings, one of which records two problems
   and ranks first (seven problems in all), the fix list holds five findings (that one
   listing both its problems), "Also found" holds one, and the summary says
   six things to fix.
5. A finding checked 31 days before `reportDate` is marked "Check again
   before acting"; one checked 30 days before is not.
6. `unknown` findings appear only under "Couldn't check"; `ok` findings only
   under "What's working".
7. Every entry in every section, including "What's working", in the
   Markdown shows its source label, its link or quoted locator, and its `checkedOn`
   date.
8. The schema refuses an unknown field (with a marker string that then
   appears in no output), an unknown check kind, a missing `reportDate`, a
   `checkedOn` after `reportDate`, a source URL that isn't `https://`, a
   finding of any status (including `ok`) with neither a `url` nor a
   `locator`, two findings with the same `id` (the message names the
   repeated `id`), an empty `id`, a 65-character `id`, an `id` with a space
   or `/`, and a numeric `id`, each with a plain message. Ids `item-10`,
   `item-9`, `B-2` and `a-1` on problems of the same rank come out as
   `B-2`, `a-1`, `item-10`, `item-9`.
8b. Dates: `2026-02-30`, `2026-13-01`, `2026-02-29`, `2026-00-10`,
   `2026-1-05` and `2026-01-05T00:00` are each refused in `reportDate`,
   `checkedOn` and `websiteCheckedOn`, naming the field; `2028-02-29` is
   accepted.
8c. Listing comparisons: a `listing-details-match` finding without
   `websiteSource`, or whose `websiteSource` has neither a `url` nor a
   `locator`, or with `websiteCheckedOn` after `reportDate`, is refused;
   `websiteSource` on any other kind is refused; the Markdown shows both
   sources with their dates; a website side checked 31 days before
   `reportDate` marks the finding "Check again before acting".
9. The renderer's own wording contains no grading or promise words. The
   test scans every fixed sentence and template the package defines, and a
   full report rendered from findings whose text fields hold only neutral
   invented words, for words such as "grade", "score", "guarantee",
   "failing" and "#1". A separate case renders a business named "Score
   Bikes" with a locator mentioning a review score, and the report shows
   both exactly as given (escaped as plain text) without being refused.
10. Hostile text in a finding (`[link](https://evil.example)`, `# heading`,
    `<img src=x>`) appears escaped and adds no link, heading or tag. Source
    URLs with `)`, `(`, `<`, `>`, a space and a backslash
    (`https://a.example/x) [y](https://evil.example`) render as exactly
    one link, wrapped in `<...>` with those characters percent-encoded, and
    a source URL with a line break, a tab or U+2028 is refused with a
    message naming the finding. Rendering the Markdown with the
    GitHub-flavored renderer from test 10a: a source URL ending
    `?a=1&b=2` gives a link whose address ends exactly `?a=1&b=2`; a source
    URL containing `&copy;` gives a link whose address contains `&copy;`
    and no `©`; a business name, label and locator containing `&copy;` and
    `AT&T` show exactly that text, with no `©`; and the same inside a word
    wrapped as a code span shows `&copy;` as written.
10a. Bare addresses: a business name, a locator and a `wrongDetails` text
    containing `https://evil.example/x`, `www.evil.example`,
    `owner@evil.example`, `mailto:owner@evil.example` and a word with a
    backtick in it each come out as inline code spans, and rendering the
    report with a GitHub-flavored Markdown renderer (a dev dependency for
    tests only, listed with its license) produces no link other than the
    source links.
11. No network, enforced at run time. Every test runs with network access
    blocked. A shared test setup replaces each network entry point that
    Node 22's built-in modules offer with a function that records the call
    and throws:
    - globals: `fetch` and `WebSocket` (Node 22's `fetch` uses the bundled
      undici internally, so stubbing `fetch` covers it; if an `undici`
      package is ever importable, its `fetch`, `request`, `stream`,
      `connect`, `Client`, `Pool` and `Agent` are stubbed too);
    - `net`: `connect`, `createConnection` and `Socket.prototype.connect`;
    - `tls`: `connect` and `TLSSocket.prototype.connect`;
    - `http` and `https`: `request` and `get`;
    - `http2`: `connect`;
    - `dgram`: `createSocket`;
    - `dns` and `dns/promises`: `lookup`, `resolve` and every other
      `resolve*` function;
    - `inspector`: `open` (it listens on a port);
    - no spawning: `child_process` (`spawn`, `exec`, `execFile`, `fork`
      and their `Sync` forms), `cluster.fork` and `worker_threads.Worker`,
      because a child process or worker would run without these stubs.

    After each test, the setup asserts that none were called; one test calls
    `fetch` and one calls `net.connect` on purpose to show the guard throws.
    The command also reads no file other than the findings file (a test
    checks which files it opens by stubbing `fs` reads the same way).

    The list follows Node 22's built-in modules. A snapshot test keeps it
    current: the package holds a list of every name in
    `module.builtinModules` on Node 22, each marked "network or process:
    stubbed above" or "no network". The test fails if the running Node has
    a built-in that isn't in the snapshot, so a new built-in that might
    reach the network can't arrive unnoticed; whoever updates the snapshot
    adds its entry points to the list above first.

    Why stubs, not Node's permission model: the tests workflow runs Node
    22, and in Node 22 the permission model (`--experimental-permission`,
    later `--permission`) limits the file system, child processes and
    workers but has no network permission, so it can't block a network
    call. Stubbing every network entry point works on Node 22 and fails
    loudly if anything tries.
12. Output paths: `--json` or `--md` naming the findings file (directly,
    through `..`, through a symbolic link, through a hard link, or with
    different letter case, such as `FINDINGS.json` for `findings.json`),
    and `--json` and `--md` naming the same file (including `Out.md` and
    `out.md`, neither of which exists yet), are each refused, and the
    findings file is byte-for-byte unchanged afterwards.
13. Details and status: for each kind, details that record each problem in
    its row give exactly that rank; a status that disagrees with the details
    (in both directions, for every kind), result fields on an `unknown`
    finding, a missing subject field, `wrongDetails` without
    `wrong-details`, a repeated `mismatches` field, `last90Days` above
    `count`, and `title` present when `hasWebsite` is false are each refused
    with a plain message naming the finding's `id`. A `reviews` finding
    with a count of 0 records ranks 10 and 11, takes rank 10 and names both.
    A mismatch whose `listing` and `website` are equal (and equal apart
    from surrounding spaces) is refused, naming the `id` and the field.
14. Displayed text: for each checked field (`business.name`, a source
    label, locator and URL, and each `details` text field), a U+0000, a tab,
    a carriage return, a U+001B, a U+007F, a U+0085, a U+2028 and a U+2029
    are each refused with a message naming the field's path; a line feed is
    refused in a single-line field such as `business.name` and accepted in
    `wrongDetails` and a mismatch's `listing`, where the Markdown keeps it
    inside the same entry without starting a new item or heading.

## Out Of Scope For This Slice

Gathering findings from anywhere (websites, listings, review sites, AI
assistants), any network or AI, PDF export, competitors, ongoing watch,
agency or client features, Desk or app screens, storage, and the owner's
real businesses.

## Rules For The Builder (GrokBot, Team C)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Work only in a checkout of this repo, on the branch
  `OC-261021-visibility-report`, signed in as `cloudwork-bot`. Open a pull
  request into `main`. Never push to `main` directly.
- Run **no commands on the owner's Mac** for this job. Nothing here needs it.
- Touch no keys, tokens, passwords, accounts, Keychain or private files. Use
  invented data only; never a real business, listing or review. If anything
  private turns up, stop and say so in the pull request without copying it.
- Change files only under `packages/visibility-report/`. Nothing else, not
  even `STATUS.md`: the planning side updates STATUS.md.
- No network calls, no AI, no paid services, in the code or the tests.
- No new dependencies unless unavoidable; list any in the pull request with
  its license. Add no license file and no `license` field.
- Keep the first slice small: the renderer, its tests and a short README,
  finishable in one to two days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- *Added October 25 (agreed change):* the report supports macOS and Linux
  only, and it refuses an output path that contains a backslash, a colon or
  a trailing dot.

## If GrokBot Stops

If GrokBot's subscription ends before this is finished, the work stays on
its branch. Any agent may finish it from this plan, on the same branch or a
new one named after a new session, under the same rules and review.

## Review And Finish Line

1. GrokBot (team C) opens the pull request.
2. Codex reviews it as code, round after round, until it finishes with a 👍.
   The builder fixes every P1 and P2, or explains in the pull request why one
   does not apply; P3s are optional. If Codex builds any part of it (for
   example, finishing it after GrokBot stops), Claude also reviews it under
   AGENTS.md's rules for Codex-built work, so no agent's review is the only
   one on its own work.
3. The coordinator (AGENTS.md "Who Does What") checks the result against this
   document, gives the owner a short try-it note (read the sample report,
   then change one finding's status and see the fix list reorder), and then
   switches on auto-merge. The merge gate merges it.

Done when the tests pass with one command, Codex has given a 👍 with no open
P1 or P2 (P3s are optional), and the planning check finds nothing missing
from this document.
