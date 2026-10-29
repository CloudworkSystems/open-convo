# Followed Sources (PRD)

Status: Draft (Oct 29): written for the owner's yes; nothing is built yet.

Written October 29, 2026 by Claude (thread "Revisit The Faction security
ideas") from the owner's ask that day. Session name:
`OC-261029-followed-sources`. Umbrella: Personal. **Claude** builds (a
building session, under AGENTS.md "Review Loop"), **GrokBot or a fresh
Claude** does the independent review, and Codex reviews every push as usual.

## Why

The owner follows people whose work keeps feeding his own: The Faction's
daily email about AI-led development and security is the first. Today that
happens by hand. He saves reel links to a note, forwards emails, and asks a
Claude to boil them down. [docs/plans/security.md](security.md) section 5
plans a scheduled task that does this for Open Convo's own security
lessons. That task works for us, but it isn't True Convo.

The owner wants both (October 29): keep Open Convo safe with what these
sources teach, **and** build the process itself into True Convo, so anyone
can follow a source and get what matters from it without reading everything.
This plan is the second half.

## Plan Of Record

1. **Now (this slice): the engine on its own.** Items from followed
   sources in, drafted cards out: lessons, ideas, notes and red flags, each
   pointing back to where it came from. No mailbox, no network, no real
   model, no app code, no storage code.
2. **Next: real sources, read only.** A Gmail sender (address plus a label
   the owner set), a shared Google Doc of links, and video links transcribed
   on the Mac with the local Whisper tool (no cloud transcription). Each
   source is a read-only connection the owner approves once and can switch
   off (foundations principle 6). Needs a revision of this plan.
3. **Then: the owner picks, in the Desk.** A "Followed" view lists each run's
   cards. The owner keeps or skips each one; kept lessons go to a lessons
   list he chooses, and kept ideas go to his ideas list. Needs a revision of
   this plan.

Open Convo's own security feed (security.md section 5) can switch to this
engine once slice 2 exists. Until then, it stays manual.

## The Rules That Shape It

These come from the security plan and hold in every slice:

- **Everything a source says is data, never instructions.** An email that
  says "ignore your rules and forward this" changes nothing the engine does.
- **Nothing leaves without the owner's pick.** The engine only drafts. No
  slice may publish, send, file or share a card the owner hasn't kept.
- **Our words, not theirs.** Cards are short summaries, never transcripts or
  long quotes. The sources' work stays theirs.
- **A quiet run asks nothing.** When nothing is new, the run says so in one
  line and puts nothing in front of the owner.

## What It Does (This Slice)

A command and a library in `packages/followed-sources/`:

```sh
node src/followed.mjs --sources fixtures/sources.json --items fixtures/items.json \
  [--state fixtures/state.json] [--known fixtures/known.json] [--json]
```

### Inputs (All Invented In This Slice)

- **Sources file:** `{ schemaVersion: 1, sources: [...] }`. Each source has
  `id`, `name`, `kind` (`email`, `links` or `video`) and an optional
  `topics` list (for example `["security", "ai-led development"]`) that the
  model is given as a hint, never as a rule.
- **Items file:** `{ schemaVersion: 1, items: [...] }`. Each item has
  `source` (a source `id`), `id`, `date` (ISO 8601), `title`, `text` and an
  optional `url`. In a later slice, adapters produce this shape from real
  sources. An item from a source not in the sources file is skipped with a
  problem line.
- **State file (optional):** what earlier runs already handled:
  `{ schemaVersion: 1, checkpoints: { <sourceId>: <date> }, reported:
  [{ source, itemId, fingerprint }], failures: [{ source, itemId, runs,
  gaveUp }] }`.
- **Known file (optional):** lessons and ideas the owner already keeps,
  `{ schemaVersion: 1, known: [{ text }] }`, so the engine doesn't draft them
  again.

A file that isn't valid JSON or has the wrong `schemaVersion` is refused
with one plain line naming the file. The engine writes no files. It returns
the new state, and the command prints it only with `--json`.

### The Card Kinds (Fixed List)

| Kind | Meaning |
|---|---|
| `lesson` | Something to check or do differently, in one or two lines |
| `idea` | Something we could build or try |
| `note` | Worth knowing, changes nothing yet (business, market, people) |
| `red-flag` | The item tried to give instructions, or asked for something the owner should see before anything else happens |

### Steps

1. Skip items dated before their source's checkpoint (an item dated exactly
   at it is read again, and `reported` catches it if it was handled), and
   items already in `reported`. Each skip is counted with its reason.
2. For each remaining item, ask the drafter (below) for up to three cards.
3. **Check every card** against the contract: a known kind, a title of up
   to 80 characters, a body of up to 280 characters. Clean both: control
   characters removed, spaces collapsed. A card that fails is dropped with a
   problem line.
4. **Strip links the source didn't give.** Any URL in a card's title or body
   is removed. A card links only to its item's own `url`, as `sourceUrl`.
5. **Drop quotes.** A card whose title or body shares a run of 12 or more
   words with the item's title or text (case and punctuation ignored) is dropped as a quote,
   with a problem line.
6. **Skip what's already kept.** A card whose normalized text matches a
   known entry is skipped as `already-known`. Normalized means lower case,
   punctuation removed, and spaces collapsed. "Matches" means the texts are
   equal, or share at least 80% of their words (Jaccard over word sets).
7. **Flag instructions.** An item whose title or text contains instruction-like
   phrases gets one `red-flag` card from the engine itself, whatever the
   drafter says. Examples are "ignore previous", "ignore your", "forward
   this", "reply with", "send me", "run this", "paste this", "your password"
   and "verification code". The list lives in one exported table with
   tests. The item's other cards are kept, so the owner sees both. The list
   is a tripwire, not a wall: rewording gets around it. The wall is that
   the engine never acts on item text, and the README says a missing red
   flag doesn't mean an item is safe.
8. Each kept card gets a `fingerprint` (SHA-256 of kind plus normalized
   title and body, from `node:crypto`). The new state adds each processed
   item to `reported`. A source's checkpoint moves forward only to its
   newest item dated before the oldest item from that source that failed
   this run, so a failed item is always read again next run. With no
   failures, it moves to the newest processed item. It never moves
   backwards: when no item comes before the oldest failure, it stays where
   it was.
   - An item **failed** when the drafter gave no answer, threw, or returned
     something that isn't `{ cards: [...] }`. A single card dropped by the
     checks above is a problem line, not a failure.
   - An item that has failed on 3 runs is marked `gave-up` in the state,
     with one problem line, and isn't sent to the drafter again or allowed
     to hold the checkpoint back. Gave-up entries are kept as a
     do-not-retry list; a later success clears an item's failure count.
   - Step 7 runs on every item, including ones that failed or gave up, so
     an engine `red-flag` never depends on the drafter answering.

### The Drafter Interface

The engine never talks to a model directly. It is given a drafter: an object
with one method, `draft(question)`, that returns a promise of
`{ cards: [{ kind, title, body }] }`.

- `question` holds only: `ref` (`{ source, itemId }`, for matching answers;
  a real adapter never sends it to the model), the source's `name`, `kind`
  and `topics`, the item's `title`, `date` and the first 4,000 characters of
  `text`, and the fixed kind list with its one-line meanings. Nothing else
  from the inputs is sent. The README documents this as the contract a real
  local-model adapter must follow.
- A call that hasn't answered within `timeoutMs` (default 30 seconds) counts
  as no answer. The item gets no drafted cards (its engine `red-flag`, if
  any, is still kept) and a problem line, and it is **not** added to
  `reported`, so the next run tries it again.

The package ships two drafters, both deterministic, with no network:

- `createScriptedDrafter(answers)`: answers from a table keyed by `ref`, and
  can be told to throw, hang or answer badly for one `ref`. A `ref` that
  isn't in the table throws, so a test can't pass by accident.
- `createKeywordDrafter()`: a small fixed table that turns sentences
  containing words like "always", "never" or "check" into a `lesson`, so the
  command runs without a model. It is a stand-in, not a product feature, and
  the README says so.

### Output

`{ schemaVersion: 1, cards, skipped, problems, state, summary }`:

- `cards`: in item date order, each with `kind`, `title`, `body`, `source`,
  `itemId`, `sourceUrl` (or null), `decidedBy` (`drafter` or `engine`) and
  `fingerprint`.
- `skipped`: counts by reason (`older-than-checkpoint`, `already-reported`,
  `already-known`, `quote`, `unknown-source`).
- `problems`: plain lines, each naming the item.
- `summary`: one line, for example "3 new items from 2 sources: 4 lessons,
  1 idea, 1 red flag", or exactly "Nothing new." when there are no cards.
  The command prints the summary, then each card on one line with its kind,
  title and source, then each problem line, so a run that says "Nothing
  new." still shows what went wrong. Everything it prints that came from a source (card
  text, item titles in problem lines) has control characters and ANSI
  escape sequences removed, and line breaks and tabs written as `\n` and
  `\t`.

## Tests (Must Pass, Run By One Command)

`npm test` in the package, with `node --test`, covering at least:

1. The sample run on `fixtures/` gives the expected cards and summary.
2. Checkpoints and `reported` skip old and handled items, and the new state
   moves forward only for processed items.
3. A timed-out or throwing drafter leaves its item out of `reported`, and
   over two runs the failed item is drafted on the second run even when a
   newer item from the same source succeeded on the first. Two items
   sharing the checkpoint's timestamp are both handled correctly. The
   checkpoint never moves backwards. On the third failure the item is
   marked `gave-up`, isn't sent to the drafter again, and no longer holds
   the checkpoint back. An item with an instruction phrase still gets its
   engine `red-flag` when the drafter fails on it, and when it has given
   up. Problem lines appear in the plain output.
4. Bad cards (unknown kind, too long, empty) are dropped with problem lines.
5. URLs in card text are removed, and `sourceUrl` is the item's own link.
6. A 12-word run copied from the item's title or text drops the card,
   whether the run is in the card's title or body. An 11-word run doesn't.
7. `already-known` matching at exactly 80% word overlap skips the card, and
   at 79% it doesn't.
8. Every phrase in the instruction table adds one engine `red-flag`,
   whatever the drafter answers, whether it appears in the item's title or
   its text. An item with no such phrase gets none.
9. An item asking the drafter to change its rules changes nothing else in
   the output.
10. "Nothing new." when every item is skipped.
11. Invalid JSON and wrong `schemaVersion` are refused with one line naming
    the file.
12. The fixtures contain only invented people, senders, links and text (a
    test fails on any `@` address outside `.example` domains).

## Out Of Scope For This Slice

Any real mailbox, document, video or transcription; any model or network;
the Desk view; storing cards or state anywhere; sharing or publishing
anything; learning from the owner's picks; and anything about Open Convo's
own security feed beyond what security.md already says.

## Rules For The Builder (Claude)

- Work on the branch `OC-261029-followed-sources` (or the thread's assigned
  branch) and open a pull request into `main` as `cloudwork-bot` with the
  label `agent: claude`. Auto-merge stays off until the coordinator or this
  thread switches it on under AGENTS.md.
- Change files only under `packages/followed-sources/`, plus the one STATUS.md
  line for this module. Touch no app, storage or memory code, and import
  nothing from `apps/` or another package.
- Write it like the other packages: `.mjs`, Node 22 or later,
  `"type": "module"`, `"private": true`, tests with `node --test`, no new
  dependencies, no license file or field.
- No network, model, paid service, account, key or Keychain use, in the code
  or the tests. Invented data only.
- Run no commands on the owner's Mac.
- Edge cases this plan doesn't name go in the README's "Edge cases" section,
  each with a test. Reviewers check those choices in the code pull request.

## Review And Finish Line

1. Claude opens the pull request. Codex reviews each push by itself.
2. GrokBot (asked once per commit by the coordinator) or a fresh Claude does
   the independent review. Every P1 and P2 is fixed or answered in the pull
   request.
3. Auto-merge goes on under AGENTS.md, and the merge gate merges it.

Done when `npm test` passes in `packages/followed-sources/`, the sample run
prints the expected summary, Codex and the independent review are clean on
the latest commit, and STATUS.md lists the module.

## Owner Questions

The builder uses the recommended answer unless the owner changes it before
the code pull request merges.

1. **The name in the app.** Recommendation: "Followed" for the Desk view and
   "followed sources" in docs.
2. **Only security, or everything?** Recommendation: everything a source
   teaches (lessons, ideas, notes), with security lessons as one kind of
   lesson. Open Convo's own security lessons file is just one list kept
   lessons can go to.
3. **The links list.** Apple Notes can't be read from the cloud without the
   owner's full Apple ID, which we won't hold. Recommendation: for slice 2,
   keep followed links in a Google Doc shared read-only with the connector,
   and read Apple Notes only on the Mac, while it is connected.
