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

## The Findings File

- `schemaVersion: 1`.
- `business`: `name`, and optionally `siteUrl` (a complete `https://`
  address).
- `reportDate`: the date the report is for (`YYYY-MM-DD`). The report uses
  this date, never the computer's clock, so the same file always gives the
  same report.
- `findings`: a list. Each finding has an `id`, a `check` (one of the kinds
  below), a `status` (`ok`, `problem` or `unknown`), the details for its
  kind, and where and when it was found: `source` (`{ label, url? }`, `url`
  a complete `https://` address) and `checkedOn` (`YYYY-MM-DD`, not after
  `reportDate`).

Check kinds (fixed list; the schema in the package is the single authority):

| Kind | What it records |
| --- | --- |
| `listing-present` | Whether the business has a listing on a named directory or map service |
| `listing-details-match` | Whether a listing's name, address, phone or hours match the website, with both values for any that don't |
| `ai-mention` | Which AI assistant was asked which question, and whether the business was mentioned, mentioned with wrong details (with what was wrong), or not mentioned |
| `reviews` | Review count, how many in the last 90 days, and how many have no reply |
| `website-basics` | Whether the business has a website, and whether it has a page title, a description, a way to contact, and works on a phone |

## Ranking Rules (Fixed And Tested)

Only findings with status `problem` are ranked. Each kind and detail falls
in one fixed group, and the fix list runs group by group:

1. **Wrong information customers act on:** a listing whose address, phone or
   hours differ from the website; an AI assistant that gives wrong details.
2. **Hard to find:** no listing on a named service; not mentioned by an AI
   assistant; no website, or a site that doesn't work on a phone.
3. **Weak trust signals:** few reviews (fewer than 10), none in the last 90
   days, or reviews with no reply.
4. **Polish:** a listing whose name is written differently; a missing page
   title or description; no visible way to contact.

A finding that records more than one problem (for example a listing whose
phone and name both differ) is ranked once, in the group of its most
serious problem, and the report names every problem in it.

Inside a group, quicker fixes come first, using a fixed effort per kind
(stated in the package README), then the order of the kinds in the table
above, then `id`. The same findings always give the same order.

- The **fix list** shows the first five problems. The rest appear under
  "Also found", in the same order.
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
  and when (the source label, its link when there is one, and `checkedOn`).
  Every claim in the report cites its finding's source and date, as the
  design note requires.
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
3. Inside a group, quicker fixes come first, then kind order, then `id`.
   Shuffling the input order never changes the output.
4. Only five problems are in the fix list; the sixth and later go under
   "Also found".
5. A finding checked 31 days before `reportDate` is marked "Check again
   before acting"; one checked 30 days before is not.
6. `unknown` findings appear only under "Couldn't check"; `ok` findings only
   under "What's working".
7. Every ranked problem in the Markdown shows its source label and
   `checkedOn` date.
8. The schema refuses an unknown field (with a marker string that then
   appears in no output), an unknown check kind, a missing `reportDate`, a
   `checkedOn` after `reportDate`, and a source URL that isn't `https://`,
   each with a plain message.
9. Output contains no grading or promise words (a test scans for words such
   as "grade", "score", "guarantee", "failing", "#1").
10. Hostile text in a finding (`[link](https://evil.example)`, `# heading`,
    `<img src=x>`) appears escaped and adds no link, heading or tag.
11. The code makes no network requests and reads no file other than the
    findings file (a test checks the package's source files import no
    network module).

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
