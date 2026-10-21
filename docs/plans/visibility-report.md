# Visibility Report (PRD)

Written October 21, 2026 by a building session for the planning side, from
the approved scale-up plan ([scale-up.md](scale-up.md), option (a)). Session
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
name the same file. Paths are compared after resolving them fully, so a
relative path, a `..`, a symbolic link or a hard link to the same file
counts as the same file (for files that already exist, the check compares
the file's device and inode numbers).

## The Findings File

- `schemaVersion: 1`.
- `business`: `name`, and optionally `siteUrl` (a complete `https://`
  address).
- `reportDate`: the date the report is for (`YYYY-MM-DD`). The report uses
  this date, never the computer's clock, so the same file always gives the
  same report.
- `findings`: a list. Each finding has an `id` (unique in the file: a
  repeated `id` is refused with a plain message naming it, because the
  ranking breaks ties by `id`), a `check` (one of the kinds
  below), a `status` (`ok`, `problem` or `unknown`), the details for its
  kind, and where and when it was found: `source` and `checkedOn`
  (`YYYY-MM-DD`, not after `reportDate`).
- `source` is `{ label, url?, locator? }`. `url` is a complete `https://`
  address. `locator` is plain text saying exactly where to look again when
  there is no stable web address, for example "Asked Claude on 2026-10-14:
  'Who repairs bikes in Hearthwick?'". **Every finding whose status is
  `problem` or `unknown` must have a `url` or a `locator`**, or the file is
  refused; only `ok` findings may have a label alone.

Check kinds (fixed list; the schema in the package is the single authority):

| Kind | What it records |
| --- | --- |
| `listing-present` | Whether the business has a listing on a named directory or map service |
| `listing-details-match` | Whether a listing's name, address, phone or hours match the website, with both values for any that don't |
| `ai-mention` | Which AI assistant was asked which question, and whether the business was mentioned, mentioned with wrong details (with what was wrong), or not mentioned |
| `reviews` | Review count, how many in the last 90 days, and how many have no reply |
| `website-basics` | Whether the business has a website, and whether it has a page title, a description, a way to contact, and works on a phone |

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
rule, so the ranking is simply: sort problems by rank, then by `id`. The
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
- A finding checked more than 30 days before `reportDate` keeps its place
  but is marked "Check again before acting: found *date*", because facts go
  stale.
- Findings with status `unknown` are never ranked; they are listed under
  "Couldn't check".
- Findings with status `ok` are summed up under "What's working".

## The Report

- A title with the business name and `reportDate`, then a two- or
  three-sentence summary built from fixed sentences (for example, "We found
  4 things to fix. The first two affect customers right now.").
- The fix list: for each problem, what's wrong, why it matters, and what to
  do, in plain words from fixed templates per kind, plus where it was found
  and when (the source label, then its link, or its locator in quotation
  marks when there is no link, and `checkedOn`). Every problem and every
  "Couldn't check" entry cites its source with a link or a locator and its
  date, as the design note requires.
- "Also found", "Couldn't check" and "What's working" sections.
- **No grades, scores, guarantees or alarm words.** The report shows what was
  found and what to do; it never gives a letter grade or a number score,
  never promises results ("guaranteed", "#1 on Google"), and never uses
  words like "failing" or "terrible".
- **Text from the findings is shown as plain text.** In the Markdown,
  characters that would make a link, image, heading, list item or HTML tag
  are escaped; only source URLs that passed the `https://` check become
  links.
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
7. Every ranked problem and every "Couldn't check" entry in the Markdown
   shows its source label, its link or quoted locator, and its `checkedOn`
   date.
8. The schema refuses an unknown field (with a marker string that then
   appears in no output), an unknown check kind, a missing `reportDate`, a
   `checkedOn` after `reportDate`, a source URL that isn't `https://`, a
   `problem` or `unknown` finding with neither a `url` nor a `locator`, and
   two findings with the same `id` (the message names the repeated `id`),
   each with a plain message.
9. Output contains no grading or promise words (a test scans for words such
   as "grade", "score", "guarantee", "failing", "#1").
10. Hostile text in a finding (`[link](https://evil.example)`, `# heading`,
    `<img src=x>`) appears escaped and adds no link, heading or tag.
11. The code makes no network requests and reads no file other than the
    findings file (a test checks the package's source files import no
    network module).
12. Output paths: `--json` or `--md` naming the findings file (directly,
    through `..`, through a symbolic link, or through a hard link), and
    `--json` and `--md` naming the same file, are each refused, and the
    findings file is byte-for-byte unchanged afterwards.

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
3. The planning session or the PR steward checks the result against this
   document, gives the owner a short try-it note (read the sample report,
   then change one finding's status and see the fix list reorder), and then
   switches on auto-merge. The merge gate merges it.

Done when the tests pass with one command, Codex has given a 👍 with no open
P1 or P2 (P3s are optional), and the planning check finds nothing missing
from this document.
