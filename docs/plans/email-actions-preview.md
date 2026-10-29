# Email Actions Preview (PRD)

Status: Approved (Oct 25): merged in #138; build handed to the local Codex CLI job (#142).

Written October 24, 2026 by a Claude session (project "261024 OC Steering")
from the owner's choice that day. Session name:
`OC-261024-email-actions-preview`. Umbrella: Personal. First piece of the
email actions that come right after launch (PLAN.md, "Day One And Public
Launch": "Right after launch: unsubscribe, report spam and delete"). Built by
an outside builder under AGENTS.md "Outside Builders": **Codex** builds
(through the local Codex CLI the coordinator runs, so the pull request comes
from `cloudwork-bot`), **Gemini Code Assist** reviews, and the coordinator
checks the result against this plan. Codex never reviews its own work. It
takes one of the outside-builder places.

## Why

Sorting mail into piles is in the launch set and built
([email-sorting-engine.md](email-sorting-engine.md), merged as #128). The
next thing the owner wants is to clear mail out: unsubscribe from senders he
no longer reads, report spam, delete. Those actions can't be undone, so
foundations principle 1 says each one stops for the owner first, with a
preview. The owner's direction on October 24 (#127) is concrete: before any
delete, unsubscribe or spam action, the user sees the list of messages that
*will be* acted on, grouped by sender and by the sort piles, reviews it and
confirms before anything happens.

The hard, testable part is the preview itself: given messages and a request
("unsubscribe from this sender", "delete this group"), work out exactly which
messages would be touched, how an unsubscribe would be done for each sender,
what can't be done and why, and seal that list so the later step can carry
out only what was shown. None of that needs a real mailbox, so it can be built
and tested now on invented mail.

## Plan Of Record

1. **Now (this slice):** a preview library on its own. Messages and requests
   in, a reviewed-ready action plan out. It never acts: no mailbox, no
   network, no URL fetched, no mail sent, nothing deleted.
2. **Next (building lanes):** the Desk screen that shows the preview inline
   (the owner's direction above) and an executor that carries out a confirmed
   plan through mail connectors the owner approves once as hosts (foundations
   principle 6). The executor refuses any plan whose seal doesn't match what
   was shown.
3. **Later:** standing rules for routine sorting only. Each delete,
   unsubscribe and spam report still asks first, unless the owner changes
   principle 1 in its own decision.

## What It Does

A small library and command in `packages/email-actions/`:

```
node packages/email-actions/src/preview.mjs --messages <messages.json> --requests <requests.json> [--json]
```

and the same as a function, `previewActions(input, requests)`, exported from
`src/index.mjs`. It returns the plan described under Output (synchronously),
prints nothing, never reads the clock and never calls `process.exit`. The
command reads the two files and prints a plain summary, or with `--json` the
plan object.

### The Messages File

The same format as the email sorting engine's messages file
([email-sorting-engine.md](email-sorting-engine.md), "The Messages File"),
`schemaVersion: 1`, with the same limits and refusals, plus one optional
field per message:

- `pile`: one of the six fixed piles (`people`, `work`, `alerts`,
  `receipts`, `newsletters`, `other`), as the sorting engine decided it. A
  message without `pile` is unsorted: sender, domain and list targets
  leave it out (see the guards below).

This package doesn't import the sorting package (packages stay independent);
it checks the file itself, the same way. The headers it reads are
`Message-ID`, `List-Id`, `List-Unsubscribe` and `List-Unsubscribe-Post`.

### The Requests File

`schemaVersion: 1` and `requests`: a list of 1 to 200 requests. Each has:

- `action`: `unsubscribe`, `spam` or `delete`;
- `target`: exactly one of:
  - `{ sender: "<address>" }`: every message from that address;
  - `{ domain: "@<domain>" }`: every message from that domain;
  - `{ listId: "<List-Id>" }`: every message with that `List-Id` (compared
    on the part inside angle brackets, in lower case);
  - `{ messages: [{ inbox, id }, ...] }`: exactly those messages, 1 to 1,000;
- `pile` (optional): narrows a sender, domain or list target to one pile.

Unknown fields, a missing field, a target with more or less than one kind,
and a `messages` entry naming a message that isn't in the input are refused
with a plain message naming the request's position.

## Building The Plan

1. **Check the input** as above. A refusal produces no plan.
2. **The same message in two inboxes is one message**, as in the sorting
   engine: same `Message-ID` (trimmed, angle brackets removed, lower case),
   shown once with every inbox it arrived in. Its other fields (`pile`,
   sender, date, headers, unsubscribe headers) and its `id` come from the
   copy whose inbox, then `id`, comes first in character-code order, the
   sorting engine's rule, so the file's order never changes a guard, a
   group, an unsubscribe method or the seal. Acting on it acts on every
   copy, and the plan lists each copy, because each inbox needs its own
   action later.
3. **Match each request** to its messages, in request order.
4. **Guards** (each one blocks the request and says why in `blocked`; a
   blocked request adds no messages to the plan):
   - **People and work are never swept up.** A sender, domain or list target
     never matches messages in the `people` or `work` piles. Those messages
     are left out and counted in the request's `leftOut`, with the reason
     "In People (or Work): pick these messages one by one". Only a
     `messages` target can include them.
   - **Unsorted mail is never swept up either.** A message with no `pile`
     may be personal or work mail, so a sender, domain or list target
     leaves it out the same way and counts it in `leftOut` with the reason
     "Not sorted yet: pick these messages one by one". Only a `messages`
     target can include it.
   - **A domain target can't cover a common mail provider.** The package
     ships a fixed list of large consumer mail domains (for example
     `gmail.com`, `icloud.com`, `outlook.com`, `yahoo.com`); a domain target
     naming one is blocked: "This would match everyone who uses *domain*;
     choose a sender instead". The list is in the README.
   - **Nothing matched.** A request that matches no messages (after the
     guards) is blocked: "Nothing matches this request".
   - **Addresses that also receive mail here.** A sender target is blocked
     when its address also appears in a `to` field of a message in the input
     from someone else, because that is likely the owner himself or a person
     he writes to: "This address also receives mail here; pick messages one
     by one". A domain target is blocked the same way when any address in
     that domain appears in such a `to` field.
5. **Overlaps.** Unsubscribing is about a sender; deleting and reporting
   spam are about messages. They are independent, so an unsubscribe is
   always kept for its sender group even when the same messages are also
   deleted or reported. Between the two message actions, a message matched
   by both keeps `spam` (a spam report also removes the message) and is
   listed once, under `spam`. The plan says, for each such message, which
   requests matched it and which message action it kept, and lists every
   unsubscribe in `unsubscribe` whatever happens to its messages.
6. **How each unsubscribe would be done**, per sender group, from the
   newest message's `List-Unsubscribe` (RFC 2369) and `List-Unsubscribe-Post`
   (RFC 8058) headers:
   - `oneClick`: an `https:` URL in `List-Unsubscribe` and
     `List-Unsubscribe-Post: List-Unsubscribe=One-Click` present. The later
     executor would send one POST and nothing else.
   - `mailto`: a `mailto:` URI in `List-Unsubscribe`, parsed as RFC 6068
     says. The plan lists the exact message the later executor would send:
     its `to` addresses, `subject` and `body` (each empty if the URI gives
     none). Any other header field in the URI (`cc`, `bcc`, `from` and the
     rest) makes the method `none`, reason "This unsubscribe address asks to
     send extra mail fields". The executor would send exactly that message,
     with nothing added, after the owner has seen it.
   - `webPage`: only an `https:` URL without the one-click header. The
     executor would not open it on its own; the Desk would show the link for
     the owner to open himself.
   - `none`: no usable header (missing, empty, only `http:` or other
     schemes, or not parseable). The plan says "This sender gives no way to
     unsubscribe; you can delete or report it instead".
   Every URL is checked as text only, with Node's `URL` parser: never
   fetched, resolved or opened. `http:` URLs are listed as `none` with the
   reason "Only an insecure link"; credentials in a URL, and URLs over 2,000
   characters, also count as `none`.
7. **Grouping.** Inside each action, messages are grouped by pile (the fixed
   pile order), then by sender (by `List-Id` where the message has one,
   otherwise the sender's address), the same grouping as the sorting engine.
   Groups are newest first, then by key in character-code order; messages
   inside a group are newest first, then by inbox and `id`.
8. **The seal.** The plan carries `seal`: the SHA-256 (Node's built-in
   `crypto`) of a canonical JSON form of exactly what would be done: each
   action, each message copy (`inbox`, `id`) under it, and each unsubscribe
   method with everything the executor would send: the URL for one-click
   and web page, and the `to`, `subject` and `body` for mailto. Same actions, same seal; any change to
   what would be done changes it. The README documents the canonical form so
   the later executor can recompute it and refuse a plan that doesn't match.
   The seal is not a secret and not a signature; it only proves the executed
   plan is the one that was shown.

**Same input, same plan.** The same files give byte-identical JSON, and
shuffling the messages gives the same plan and seal. Reordering requests
that don't overlap gives the same `seal`, `actions` minus `matchedBy`, and
`unsubscribe`; `matchedBy`, `requests` and `blocked` name requests by their
position in the file, so they follow the new order. Nothing depends on the
clock, time zone, locale or random values.

## Output

`{ schemaVersion: 1, seal, actions, unsubscribe, blocked, requests, summary }`:

- `actions`: `spam`, `delete` and `unsubscribe`, in that order, each with
  `count` (distinct messages), `copies` (message copies across inboxes) and
  `groups` (by pile, then sender, as above). Each message lists `inboxes`,
  `ids` per inbox, `from`, `subject`, `date`, `pile` and `matchedBy`
  (request positions). Snippets and headers are not copied.
- `unsubscribe`: one entry per sender group being unsubscribed: `key`,
  `label`, `method`, and what it would use: the `url`, or for mailto the
  `to`, `subject` and `body` (or the reason for `none`).
- `blocked`: each blocked request with its position and reason.
- `requests`: per request, how many messages it matched, kept and left out,
  and why.
- `summary`: plain lines for the command ("Delete: 42 messages from 6
  senders", "Unsubscribe: 5 senders (3 one-click, 1 by email, 1 has no
  way)").

The command's plain summary prints those lines, then each group with its
count. Text from mail is printed on one line, with line breaks and tabs
written as `\n` and `\t`, and bidirectional control characters escaped, as in
the sorting engine.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/email-actions`, Node's built-in test runner, invented
mail only (`.example` addresses, invented people and businesses). At least:

1. A complete invented mailbox and a set of requests produce a plan whose
   JSON matches a saved expected file exactly.
2. Each target kind (sender, domain, list, messages) matches exactly the
   right messages; `pile` narrows a sender target to one pile.
3. People and work: a sender target that would match a `people` message
   leaves it out and counts it in `leftOut` with the reason; a `messages`
   target can still include it. A sender target matching a message with no
   `pile` leaves it out with the "Not sorted yet" reason; a `messages`
   target can still include it.
4. A domain target naming `gmail.com` (and each other listed provider) is
   blocked with the plain reason.
5. A request matching nothing is blocked; a target address that also
   receives mail in the input is blocked.
6. Overlaps: a message matched by a delete and a spam request keeps spam,
   and lists both requests; a sender matched by an unsubscribe and a delete
   keeps both the unsubscribe and the delete.
7. Unsubscribe methods: one-click (with the RFC 8058 header), mailto, web
   page only, `http:` only, a URL with credentials, an oversized URL, an
   empty header and a missing header each give the right method and reason.
   A header holding both a `mailto:` and an `https:` URL, in either order,
   prefers one-click when allowed, then mailto, then the web page. A
   `mailto:` with `subject` and `body` lists both, and changing either
   changes the seal; one with `cc` or `bcc` is `none`.
8. Duplicates: the same `Message-ID` in two inboxes is one message with two
   copies, and the seal covers both copies; two copies that disagree on
   `pile`, sender and `List-Unsubscribe` give the same plan and seal in
   either file order, taken from the representative copy.
9. The seal: the same files give the same seal; adding, removing or
   changing any message copy, action or unsubscribe URL changes it;
   shuffling the messages file doesn't; swapping two requests that don't
   overlap keeps the seal and actions and renumbers only `matchedBy`,
   `requests` and `blocked`. A test recomputes the seal from the
   README's canonical form.
10. Input checks: everything the sorting engine refuses is refused here too;
    plus a bad `pile`, an unknown action, a target with two kinds, more than
    200 requests and a `messages` entry for a missing message.
11. Hostile but valid text (quotes, `<script>`, emoji, right-to-left text,
    bidirectional controls) comes back unchanged in the JSON and safe on one
    line in the summary.
12. Determinism and no clock: the engine runs with `Date.now`, an
    argument-less `Date` and the local-time `Date` methods stubbed to throw.
13. No network and nothing written: the shared test setup makes Node's
    network and process built-ins throw if called, deny by default (as the
    visibility report's guard does, `packages/visibility-report/`, once
    merged), and the library writes no files. A test confirms no URL from
    any message is ever passed to a network call.

## Out Of Scope For This Slice

Connecting to any mailbox, carrying out any action, opening or fetching any
URL, sending any message, a model or AI, the Desk screen, storage or
encryption code, standing rules, learning from the owner's choices, and any
real email.

## Rules For The Builder (Codex)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Work only in a checkout of this repo, on the branch
  `OC-261024-email-actions-preview`, through the local Codex CLI the
  coordinator runs, so the pull request opens as `cloudwork-bot` with the
  label `agent: codex` and auto-merge off. The description's last line names
  the builder (`— Codex, OC-261024-email-actions-preview`). Never push to
  `main` directly.
- Run nothing on the owner's Mac beyond the coordinator's Codex CLI job in
  its sandbox and the package's own tests.
- Touch no keys, tokens, passwords, accounts, Keychain or private files.
  Invented data only. If anything private turns up, stop and say so without
  copying it.
- Change files only under `packages/email-actions/`. Nothing else, not even
  `STATUS.md`. Touch no app, storage or memory code, and import nothing from
  `apps/` or another package.
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network calls, no AI, no paid services, in the code or the tests.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the engine, the command, the tests and a short
  README documenting the inputs, the guards, the unsubscribe methods, the
  seal's canonical form and the output. Finishable in one to two days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Edge cases this plan doesn't name: follow the governing standard's default
  (RFC 5322 for headers, RFC 2369 and RFC 8058 for unsubscribe headers,
  WHATWG URL parsing). Write each choice in the README's "Edge cases" section
  with a test.

## Review And Finish Line

1. Codex's pull request is opened by the coordinator's CLI job.
2. Gemini Code Assist reviews it as code; until Gemini posts reviews on this
   repo, a fresh Claude review (by an agent that didn't build it) stands in
   (AGENTS.md "Gemini reviews"). Codex fixes every P1 and P2, or the pull
   request explains why one doesn't apply. Codex's own automatic review and
   the merge gate's `codex-approved` check still apply.
3. The coordinator checks the result against this plan, posts the check as a
   comment, gives the owner a short try-it note (run the command on the
   sample mailbox and requests), and switches on auto-merge once the
   independent review of the latest commit has no open P1 or P2.

Done when the tests pass with one command, the independent review of the
latest commit has no open P1 or P2, and the coordinator's plan check finds
nothing missing from this plan.
