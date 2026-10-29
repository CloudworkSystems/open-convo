# Followed sources engine

Slice 1 of [docs/plans/followed-sources.md](../../docs/plans/followed-sources.md):
a standalone Node ESM library and command. Items from sources the owner
follows (an email sender, a links list, videos) go in, and drafted cards come
out: lessons, ideas, notes and red flags, each pointing back to its item. No
dependencies, network, model, mailbox, app code, storage or real personal
data. Node 22 or later.

```sh
cd packages/followed-sources
npm test
node src/followed.mjs --sources fixtures/sources.json --items fixtures/items.json \
  --state fixtures/state.json --known fixtures/known.json
```

The sample run prints:

```text
3 new items from 2 sources: 3 lessons, 1 red flag
[lesson] Lesson: Always keep keys out of the … (The Example Faction (daily email))
[lesson] Lesson: Check every new dependency before an … (The Example Faction (daily email))
[lesson] Lesson: Teams that never let a pull … (Saved build links)
[red-flag] This item tried to give instructions (The Example Faction (daily email))
```

Add `--json` for the whole result, including the new state. The engine
writes no files: saving the state for the next run is up to the caller.

## The rules it keeps

- **Everything a source says is data, never instructions.** The engine never
  acts on item text. The drafter only proposes cards, and the engine checks
  each one: a known kind, a title of up to 80 characters and a body of up to
  280, cleaned of control characters, with every link removed (a card links
  only to its item's own `http` or `https` URL, as `sourceUrl`).
- **Our words, not theirs.** A card that shares a run of 12 or more words
  with its item is dropped as a quote.
- **Nothing twice.** A card matching something the owner already keeps (equal
  after normalizing, or 80% of words shared, title and body each compared on
  their own) is skipped, and items already handled are skipped by their
  source's checkpoint and the `reported` list.
- **A quiet run asks nothing.** When there are no cards, the summary is
  exactly `Nothing new.`, followed only by any problem lines.

## Red flags are a tripwire, not a wall

An item whose title or text contains a phrase from `INSTRUCTION_PHRASES`
("ignore previous", "forward this", "your password" and so on) gets one
`red-flag` card from the engine itself, whatever the drafter answers, even
when the drafter fails. Rewording gets around the list. **A missing red flag
doesn't mean an item is safe**; the protection is that nothing here acts on
what an item says.

## Failures

The drafter fails on an item when it gives no answer within `timeoutMs`
(30 seconds by default), throws, or returns something that isn't
`{ cards: [...] }`. A failed item stays out of `reported` and holds its
source's checkpoint back, so the next run tries it again. On its third
failed run it is marked `gaveUp` in the state, with a final problem line
(and its red flag, if it has one); from then on it is skipped silently as
`gave-up`. A success before the third failure clears the count. One bad
card in an otherwise good answer is a problem line, not a failure.

## The drafter contract

The engine never talks to a model. It calls `drafter.draft(question)`, which
returns a promise of `{ cards: [{ kind, title, body }] }`. The question holds
only:

- `ref`: `{ source, itemId }`, for matching answers. **A real adapter never
  sends `ref` to a model.**
- `source`: its `name`, `kind` and `topics` (a hint, never a rule).
- `item`: its `title`, `date`, and the first 4,000 characters of `text`.
- `kinds`: the fixed list of card kinds and their meanings.

Nothing else from the inputs is sent. A real local-model drafter must follow
the same contract. This package ships two deterministic drafters:

- `createScriptedDrafter(answers)` for tests: answers keyed by
  `"source/itemId"`, each `{ cards }`, `{ throws }`, `{ hangs: true }` or
  `{ returns }` (verbatim, for bad answers). An unknown ref throws. Every
  question asked is kept in `calls`.
- `createKeywordDrafter()`: **a stand-in, not a product feature.** It turns
  sentences with words like "always", "never" or "check" into short lessons
  so the command runs without a model.

## Library

```js
import { run, createKeywordDrafter } from './src/index.mjs';
const result = await run({ sources, items, state, known, drafter: createKeywordDrafter() });
// { schemaVersion, cards, skipped, problems, state, summary }
```

Inputs are the parsed files described in the plan. `run` throws an
`InputError` for a bad shape; the command prints it as one line,
`Refused <file>: <reason>.`, and exits 1 (2 for a usage error).

## Edge cases

Each has a test in `tests/edge-cases.test.mjs` unless noted.

- **An item listed twice in one run** is drafted once; the second copy
  counts as `already-reported`.
- **An item from a source not in the sources file** is skipped as
  `unknown-source`, with a problem line (the items file isn't refused, so
  one stray item doesn't block the rest).
- **A source id listed twice** refuses the sources file.
- **A malformed item** (missing field, date that isn't ISO 8601) refuses
  the items file, naming the item (`tests/cli.test.mjs`). Items come from
  our own adapters, so a bad one means a bug to fix, not a source to skip.
- **A card repeating an earlier card in the same answer** (same
  fingerprint) is dropped with a problem line.
- **An item already in `reported`** still carries its source's checkpoint
  forward (subject to the failure rule), so handled items aren't re-read
  forever.
- **State entries for items not in this run** are kept as they are.
- **The drafter's own red flags** are kept beside the engine's.
- **An item URL that isn't `http` or `https`** (for example `javascript:`)
  gives `sourceUrl: null` (`tests/engine.test.mjs`).
- **Zero-width and bidi control characters** are removed along with other
  control characters, since they can hide or reorder what the owner reads
  (`tests/engine.test.mjs`).
- **What counts as a link.** Any word with `://` or `:\`, or starting
  with `//`, `www.` or a link scheme (`mailto:`, `javascript:`, `data:` and
  so on); a host name followed by a path, query, anchor or port; an email
  address; and a bare host name such as `evil.com`, unless its ending is a
  common file or tool name (so "Node.js" and "README.md" stay). Fullwidth
  and ideographic dots and fullwidth slashes count. Links are found one word
  at a time with anchored checks, so long hostile input can't make the check
  slow.
- **A datetime with no time zone** (`2026-10-12T09:00`) refuses the items
  or state file, since it would be read in the machine's own time zone. A
  date alone is fine.
- **Instruction phrases are matched in the title and the text separately**,
  so a phrase can't form across the two.
- **Files over 5 MB** are refused before they are read (not tested; the
  limit is a constant, `MAX_FILE_BYTES`).
- **`reported` grows with every handled item.** Pruning it waits for real
  sources in slice 2, where item volumes are known (not tested).
