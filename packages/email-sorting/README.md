# Email sorting engine

Sorts email into six fixed piles, each message with a one-line reason.
Standalone Node ESM library and command: no dependencies, no mailbox
connection, no model, no network, no files written, no clock. Node 22 or
later. Plan: [docs/plans/email-sorting-engine.md](../../docs/plans/email-sorting-engine.md).

Run every test:

```sh
cd packages/email-sorting
npm test
```

## Try it with the invented sample mailbox

```sh
cd packages/email-sorting
node src/sort.mjs --messages fixtures/mailbox.json --settings fixtures/settings.json
node src/sort.mjs --messages fixtures/mailbox.json --settings fixtures/settings.json --json
```

Then add a sender rule to `fixtures/settings.json`, for example
`{ "match": "t.ortega@wrenfield.example", "category": "people" }`, and run it
again: Ms. Ortega's message moves from Other to People with the reason
"Your rule: ...".

The command uses the keyword classifier (below). It prints one line per pile
("Newsletters: 4 from 3 senders"), then each group with its count. With
`--json` it prints the result object. A refusal prints a plain message to
standard error and exits with code 1.

## API

```js
import { sortMessages, createScriptedClassifier, createKeywordClassifier } from './src/index.mjs';
const result = await sortMessages(input, settings, classifier);
```

`sortMessages(input, settings, classifier)` returns a promise of the result.
It prints nothing, never reads the clock and never calls `process.exit`.
`input` is the parsed messages file; `settings` is the parsed settings file
or `undefined`. A refusal rejects with `EmailSortError` and sorts nothing.

Also exported: `parseMessagesFile(text)` and `parseSettingsFile(text)` (size
limit, JSON and checks), `validateInput`, `validateSettings`,
`formatSummary(result)` (the command's plain summary), `cleanReason`,
`oneLine`, `CATEGORIES`, `CATEGORY_DESCRIPTIONS`, `PILE_NAMES`, `DECIDED_BY`,
`DEFAULTS`, `LIMITS`, `SCHEMA_VERSION` and `EmailSortError`.

## The messages file

`{ "schemaVersion": 1, "messages": [...] }`, at most 5 MB and 10,000
messages. Each message has exactly these fields:

| Field | Rule |
| --- | --- |
| `id` | 1 to 128 characters, unique within its inbox |
| `inbox` | 1 to 40 characters (`home`, `work`, `school`) |
| `from` | `{ name?, address }` |
| `to` | list of `{ name?, address }`, may be empty |
| `subject` | up to 1,000 characters, may be empty |
| `date` | RFC 3339 date-time with an offset or `Z` (`2026-10-14T09:12:00-04:00`) |
| `snippet` | up to 2,000 characters of plain text |
| `headers` | object of header name to text, or to a list of texts |

Addresses need exactly one `@` and are compared in lower case. Unknown
fields, missing fields, repeated ids within an inbox, and control characters
other than line feed and tab are refused with a plain message naming the
message and the field (never the contents of an unknown field). Headers
read: `Message-ID`, `In-Reply-To`, `References`, `List-Id`,
`List-Unsubscribe`, `Precedence`, `Auto-Submitted` and `Reply-To`; others
are accepted and ignored.

## The settings file (optional)

```json
{
  "schemaVersion": 1,
  "myAddresses": ["jordan@quillhome.example"],
  "workDomains": ["northglass-tutoring.example"],
  "senderRules": [{ "match": "orders@marrowlane.example", "category": "receipts" },
                  { "match": "@marrowlane.example", "category": "newsletters" }],
  "confidenceFloor": 0.6,
  "timeoutMs": 30000
}
```

A rule's `category` must be one of the six piles exactly; any other value
(`vip`, `Receipts`, `""`) refuses the whole file, naming the rule's position
and the pile. `confidenceFloor` is 0.5 to 0.95 (default 0.6); `timeoutMs` is
a whole number from 1,000 to 120,000 (default 30,000).

## Piles

`people`, `work`, `alerts`, `receipts`, `newsletters`, `other`, always in
this order. No other pile exists.

## How a conversation is sorted

1. Copies with the same `Message-ID` are one message, listed with every
   inbox it arrived in; its fields come from the copy whose inbox, then id,
   comes first.
2. Messages linked by `Message-ID`, `In-Reply-To` and `References` form a
   conversation. Its key is `id:` plus the smallest normalized ID (E21), or
   `msg:` plus `JSON.stringify([inbox, id])` for a message with no IDs.
3. The newest message not sent by the owner decides. Only the owner's own
   messages: `other`, `decidedBy: "fallback"`, "Only messages you sent".
4. A matching sender rule (exact address before domain, first rule among
   equals): `decidedBy: "rule"`.
5. Otherwise the classifier, accepted at or above the floor:
   `decidedBy: "model"`. Below the floor: `other`, `decidedBy: "not-sure"`.
6. If the classifier throws, times out or breaks the contract: header facts
   (`List-Id`/`List-Unsubscribe`, then `Auto-Submitted`/`Precedence`, then
   work domain, else `other`), `decidedBy: "fallback"`, and a line in
   `problems`.

Questions go to the classifier one at a time, in conversation-key order. The
same input and answers always give byte-identical JSON.

## The classifier contract

A classifier is an object with `classify(question)` returning a promise of
`{ category, confidence, reason }`. A real local-model adapter must follow
this shape. The question holds only:

```js
{
  ref: { inbox, id },          // to match the answer; never send it to the model
  from: { name?, address },
  to: [{ name?, address }],
  subject, date,
  snippet,                     // first 1,000 characters
  facts: { hasListId, hasListUnsubscribe, autoSubmitted, precedence, isReply, senderIsWorkDomain },
  messageCount,                // messages in the conversation
  categories: [{ category, description }],  // the six piles, in order
}
```

The question is frozen. Mail is data: the answer is checked (category in the
fixed list, confidence a number from 0 to 1, reason text), and the owner's
rules always win. The reason is cleaned (line breaks, tabs and control
characters become spaces, spaces collapse, cut to 160 characters ending in
`…`; edge case E19); an
empty cleaned result becomes "The model chose *Pile*". A literal `…` is kept.
An answer that takes longer than
`timeoutMs` is ignored.

Two classifiers ship, both deterministic and offline:

- `createScriptedClassifier(entries)` for tests: entries are
  `{ inbox, id, answer }`, `{ inbox, id, throws: true }` or
  `{ inbox, id, hang: true }`. An unknown `ref` throws. Asked questions are
  kept in `.questions`.
- `createKeywordClassifier()`: a small fixed keyword table so the command
  runs without a model. It is a stand-in for the local model, not a product
  feature. With no keyword it answers `people` at 0.55, which is below the
  default floor, so the message goes to Other as "Not sure".

## Output

```js
{ schemaVersion: 1, piles: [{ category, count, groups: [{ key, label, count, messages }] }], problems: [] }
```

Each message: `id`, `inboxes`, `from`, `subject`, `date` (as written), `pile`,
`decidedBy` (`rule`, `model`, `not-sure` or `fallback`, nothing else),
`reason` and `conversation`. Snippets and headers are not copied. Groups:
newsletters with a `List-Id` by that list (`key` `list:<id>`), everything
else by sender address (`key` `address:<address>`). The label is the
sender's name when every message gives the same one, otherwise the address
when all share one, otherwise the normalized `List-Id`. Groups are newest
first, then by key; messages in a group newest first, then by inbox and id.

## Edge cases

Choices for cases the plan doesn't name, following RFC 5322 (and RFC 3339
for dates, RFC 2919 for `List-Id`, RFC 3834 for `Auto-Submitted`). Each has
a test in `tests/edge-cases.test.mjs` under the same number.

- **E1.** Header names match without regard to case (E20). When one message has
  the same header under several keys (`references` and `REFERENCES`), their
  values join in character-code order of the keys.
- **E2.** A header counts as present only when one of its values holds more
  than white space; an empty list is absent.
- **E3.** `Message-ID` is the first `<...>` token of the first non-empty
  value (comments around it are ignored; RFC 5322 allows one Message-ID).
  Without a token, the value with spaces and angle brackets trimmed. An
  empty ID (`<>`) is no ID, so such messages are never merged.
- **E4.** `Auto-Submitted` and `Precedence` use the keyword before any `;`,
  trimmed and in lower case, from the first non-empty value.
- **E5.** `List-Id` is the `<...>` part (RFC 2919), or the whole trimmed
  value when there is none, in lower case.
- **E6.** Dates follow RFC 3339 exactly: lower-case `t` and `z`, fractional
  seconds and a leap second (`:60`, see E22) are accepted; `-00:00` equals `Z`.
  Ordering uses the instant, fractions included; a leap second sorts after
  every `:59` instant of its minute and before the next minute's `:00`
  (`23:59:60.5Z` is older than the next day's `00:00:00Z`). The output keeps
  the date as written.
- **E7.** An address needs text on both sides of its one `@` (RFC 5322
  addr-spec). Addresses compare trimmed and in lower case.
- **E8.** Domain rules (`@shop.example`) and `workDomains` match the exact
  domain, not subdomains (`mail.shop.example`).
- **E9.** When the newest messages tie on date, the deciding one is chosen
  by inbox, then id, in character-code order.
- **E10.** Character limits count Unicode code points, so an emoji is one
  character, and cuts (snippet, reason) never split one.
- **E11.** Control characters are Unicode category Cc: U+0000 to U+001F
  (except line feed and tab), U+007F and U+0080 to U+009F. Carriage return
  is refused; mail text uses line feeds. Format characters (right-to-left
  marks) are text.
- **E12.** 5 MB means 5 MiB (5,242,880 bytes) of the file as stored. The
  same limit applies to the settings file.
- **E13.** In the plain summary, mail text is one line: `\` is written as
  `\\`, and line feed, tab, carriage return, U+2028 and U+2029 as `\n`,
  `\t`, `\r`, `\u2028` and `\u2029`. Every Unicode Bidi_Control character—
  U+061C, U+200E, U+200F, U+202A to U+202E and U+2066 to U+2069—is also
  written as a lower-case, four-digit `\u` escape.
- **E14.** A blank sender name counts as no name for group labels.
- **E15.** A classifier answer (or failure) that arrives after the timeout is
  ignored and never surfaces as an error.
- **E16.** Settings that are supplied must be an object: a settings file
  holding `null` (or a list, text or number) is refused. Only leaving the
  settings out gives the defaults.
- **E17.** A sender rule shows in its reason as one line, cleaned as in
  E19, trimmed after the `@` too for a domain rule, and cut to 80
  characters. Letter case is kept as written.
- **E18.** A file path that opens but can't be read (for example a folder)
  is refused with the same plain message and exit code 1 as one that can't
  be opened.
- **E19.** Every reason is one line of at most 160 characters. All text
  placed in a reason (a rule's match, an `Auto-Submitted` or `Precedence`
  keyword, a work domain, the model's reason) goes through one helper:
  each run of white space or control characters (carriage return, line
  feed, tab, U+2028, U+2029 and the rest of Unicode Cc) becomes one space,
  the text is trimmed and cut, ending in `…` when real text is cut. Work is
  bounded before flattening: a separate leading allowance is followed by a
  body of five times the output limit and fixed-size suffix inspection.
  Detected text past the body bound, or any input left beyond the inspected
  suffix, adds `…`; inspected white space or control characters alone do not.
  An empty cleaned model reason uses the model-choice fallback; a literal `…`
  is kept.
  Values inside a reason are cut to 80 characters; the whole reason to 160.
- **E20.** Headers are looked up in one place, the same way everywhere: a
  key matches a header name exactly apart from the case of ASCII letters.
  Keys are never trimmed, so `" List-Id "` or `"Precedence\t"` is an
  unknown header and is ignored.
- **E21.** Every ID read from a header (`Message-ID`, `In-Reply-To`,
  `References`, `List-Id`) is bounded before it is compared, stored or
  copied: one over 200 characters (after trimming and lower case) becomes
  `SHA256:` plus the SHA-256 of its UTF-16 code units in hex. The same long
  ID always gives the same value and two different ones stay apart; the
  upper-case prefix can't occur in a lower-cased ID, so a hash never equals
  a real ID. Conversation keys and newsletter group keys built from them
  are therefore at most about 200 characters.
- **E22.** A leap second (`:60`) is accepted only at 23:59:60 UTC on the
  last day of a month, after applying the offset (`2017-01-01T00:59:60+01:00`
  is fine, `2026-10-14T09:12:60Z` is refused). Every timestamp is checked by
  the same function.
- **E23.** Sender rules are indexed once per sort, before any
  conversation is decided: exact-address rules by trimmed lower-case
  address and domain rules by trimmed lower-case domain, each keeping only
  the first rule for its key. A rule that repeats an earlier one (in any
  case or spacing) never applies; an exact rule beats a domain rule wherever
  it sits in the file. The owner's addresses and work domains are
  indexed the same way.
- **E24.** A classifier answer's `category`, `confidence` and `reason` are
  each read once into plain values. Only those values are checked and used,
  and every decision is checked against the six fixed piles before grouping.
- **E25.** Every Bidi_Control character named in E13 is escaped in a
  plain-summary group label, so it cannot visually reorder the count.
- **E26.** Reason cleanup examines at most five times its output limit before
  flattening. After a cut it inspects at most eight times the output limit in
  code units. Real text in that fixed-size window ends the result in `…`; white
  space or control characters alone do not when the entire suffix fits in the
  window. Leading padding does not create a separate absolute boundary; for
  example, 641 spaces followed by 160 letters keeps all 160 letters.
- **E27.** Any input beyond the fixed suffix-inspection window is treated as
  truncated because it was not inspected, even when it is white space. Thus a
  multi-megabyte white-space suffix after a short reason ends in `…`, as does
  real text hidden in the middle of a long padded suffix.
- **E28.** Leading white space and control characters have a separate bounded
  allowance of eight times the output limit, so they do not consume the
  five-times body bound. If that allowance is exhausted before text is found,
  `oneLine` returns `""` and does not inspect the rest of the input.
- **E29.** The reason-cleanup `oneLine` helper returns `""` when the flattened
  value is empty, or when the leading allowance described in E28 runs out
  before any real text is found. A literal `…` is preserved. For model reasons,
  `cleanReason` returns `The model chose <Pile>` only when the cleaned result is
  empty.

## What this slice does not do

No mailbox connection, model adapter, network, unsubscribe, spam reports,
deleting or moving mail, replies, summaries, app screens, storage, or
learning from corrections. All mail in this package is invented.
