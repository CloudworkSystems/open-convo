# Media Generation, The First Capability With Paid Routes (PRD)

Status: Draft (Nov 2, 2026): plan only, waiting on the owner's yes; nothing is built.

Written November 2, 2026 by a Claude session (project "261024 OC
Steering", thread "Plan media generation as a portable capability"), from
the owner's handoff of the same day out of the websites project. Session
name: `OC-261102-media-capability`. Umbrella: Creator, used by Business
(Site Engine). **Builder:** parts 1 to 3 stand on their own and can go to an
outside builder (AGENTS.md "Outside Builders") or a Claude building session;
parts 4 to 6 touch the Mac app and go to a Claude building session, label
`agent: claude`. **Reviewers:** Codex on every commit, plus the usual
independent review (GrokBot, or a fresh Claude review that didn't build it).
**Finish line:** the owner trial in part 6 passes in True Convo Test.

Background: [portable-capability-layer.md](../design-notes/portable-capability-layer.md),
[capabilities-and-primitives.md](../design-notes/capabilities-and-primitives.md),
[site-engine.md](../design-notes/site-engine.md),
[verified-owner-yes.md](../design-notes/verified-owner-yes.md) and
foundations principles 1, 6, 12, 14, 16 and 18.

## What The Owner Decided (November 2, 2026)

1. **Paid media is never mandatory.** Making an image or a video is one
   capability with several routes, and the person picks one: their own
   pay-as-you-go key (for example fal, kie or Replicate), sign-in with the
   provider only where the provider's terms allow it, a free local model on
   their own machine (for example Wan or LTX-Video), or uploading a clip they
   made themselves.
2. **It is not a Claude-only skill.** It lives in the portable capability
   layer, so any model running in True Convo, including a local one, can use
   it the same way.
3. **The website project's paid clips are separate.** The websites repo may
   spend a little on a few clips for the site that sells True Convo, through a
   one-off script with a hard cap. That is not the product path, and nothing
   in this plan copies it.

## Answers To The Four Steering Questions

### 1. Where the layer sits, and what a capability declares

The layer is ordinary code on the person's own machine, in
`packages/capabilities` (the planned home of True Convo's
`tools/capability-adapter`; PLAN.md "Bring with step 6"). It is not a model,
a prompt or a skill. Models reach each capability as one tool, through the
same tools-only MCP server and JSON command the adapter already uses, so a
local model, Claude or ChatGPT all call it the same way. The code, not the
model, picks up the route the person chose, checks the cap, asks for
approval, runs the job, keeps the receipt and writes the log (principle 18;
"Guardrails never move into a model").

Each capability ships a `capability.json` record. Today's record for skills
(`docs/skills/*/capability.json`) gains the fields below; one format serves
both, so a skill that grows a runner doesn't change shape.

| Field | What it says |
|---|---|
| `id`, `version`, `status`, `title` | As today |
| `inputs` | Typed fields, for example `kind` (image or video), `prompt`, `seconds`, `width`, `height`, `reference_files`. Each has a limit. |
| `outputs` | What comes back and where it lands: a file in the person's media folder plus a receipt (below). |
| `routes` | The ways it can run. Each route declares the fields in the next table. |
| `recipe` | Optional `SKILL.md` that helps a model fill the inputs well (prompt writing, shot length). The recipe never runs anything. |
| `actions_needing_approval`, `models_passed`, `not_proven`, `install_gate`, `credit` | As today |

Each route declares:

| Field | What it says |
|---|---|
| `kind` | `upload`, `local`, `own_key` or `sign_in` |
| `provider`, `model` | Who runs it, and which model |
| `hosts` | Every outside host it contacts. Empty for `upload` and `local`. A host here is held by the risk review like any other ([risk-review.md](risk-review.md)). |
| `leaves_machine` | Plain words on exactly what is sent (for example "your prompt text and the one reference picture you attach"). `nothing` for `upload` and `local`. |
| `cost` | How the price is worked out (per second, per image, per credit), the price used, its source and the date it was checked, and a `max_per_run` the code computes before running. The recorded price is only for showing a rough figure in settings; it never authorizes a run (see "The price is checked again" below). `free` for `upload` and `local`. |
| `needs` | What the machine needs (memory, disk, model files to download, a local server such as ComfyUI) |
| `terms` | For `sign_in` only: a link to the provider's terms that allow third-party apps to use the sign-in this way, and the date checked. No link, no route. |
| `license` | For `local` only: the model's license, checked before adoption, and whether it allows the person's intended use |

`upload` is always present and always works. It is the floor that makes
paid media optional in fact, not just in name.

### 2. Seeing the cost first, and a cap no model can raise

**Before a paid run** the person sees one card, drawn by the app from the
request itself, never from words a model supplies: what will be made, which
route, what leaves the machine, the most it can cost ("up to $0.40"), what is
left under the cap after it, and the free routes as other choices. A batch is
one card covering the exact batch and its total maximum. Nothing paid runs
without this card and its yes (principle 1: spending always stops).

**The cap** has three levels, all in the person's own currency:

- a most-per-run,
- a monthly limit per capability,
- one monthly limit across all paid capabilities.

The starting value of every cap is **$0**, so every paid route is off until
the person sets a cap. Lowering a cap or pausing paid routes takes effect at
once and needs nothing more.

**Raising a cap needs the person, proven, not just a message.** The cap is
kept as a small record on the Mac, signed by a key the Mac keeps in its
Secure Enclave that only signs after the person's own Mac password, Touch ID
or Face ID (a system prompt the app can't fill in). The capability runner
reads the record and refuses any cap whose signature doesn't check out. So:

- a model, a skill or an agent with shell access can't raise the cap: it can't
  make the signature, and an edited record fails the check;
- a deleted or broken record means a $0 cap (fail closed, principle 7);
- later, the iPhone yes in [verified-owner-yes.md](../design-notes/verified-owner-yes.md)
  can sign a raise too, using the same check.

This is called *enforced* only once part 2 ships a test showing that an
agent running as the same user can't raise the cap, and can't reset the
ledger below (principle 12). Until then it is described as designed, not
enforced.

**The price is checked again just before each paid run.** A price recorded
in the route can go stale. So a paid route runs only when, immediately
before sending, the runner can get a maximum that holds for this request
from the provider itself: a quote for this exact request, or a request
field that tells the provider to refuse or stop anything above a set amount.
That maximum is what the card shows, what the ledger reserves, and what is
sent with the request. If the runner can't get one, the route isn't offered
for paid runs. If a provider later bills more than the approved maximum, the
receipt says so in plain words, the route is switched off until the person
looks, and the extra counts against the cap.

**The ledger.** Before each paid run the runner reserves the run's maximum
against the caps, and refuses if it doesn't fit. The check and the
reservation are one step: reservations across all capabilities go through a
single lock, so two runs started together can't both fit into the same
remaining budget. Part 2 has a test that starts several paid runs at once
and shows their reservations never add up past any cap. After the run it records
the actual cost when the provider reports it, or keeps the estimate marked
"estimated" when it doesn't. Unknown stays unknown on screen (principle 2).
The ledger and caps live on the device, travel with export, and never depend
on GitHub or any True Convo server.

**The ledger can't be wound back.** Each entry is chained to the one before
by a hash, and the latest chain head and entry count are kept in a Keychain
item that only the signed capability runner may change (the Keychain's
per-app access list). A ledger that is missing, edited, or older than that
head is treated as fully spent for the month: paid routes stop and the
person is told why, until they confirm a reset with the same Mac password
prompt used to raise a cap. Part 2's bypass test covers deleting, editing
and restoring an older ledger, as well as editing the cap. Where the
provider reports usage for the key, the runner also compares the month's
total with it and takes the higher figure.

**A second wall at the provider.** Key setup recommends the provider's own
protection: prepaid credit with auto-reload off, or the provider's spending
limit where it has one. Our cap protects against our mistakes; theirs
protects against everything else.

**Keys** live in the Keychain, readable only by the capability runner, never
handed to a model (principle 6, "keys live in the system keychain").

### 3. Visible cloud: the same rule, plus a yes for each spend

Yes, the chat rule applies unchanged: each cloud host is approved once, with
what will leave the machine shown first (principle 6, and
agent-profiles-and-adapters.md "nothing is sent ... until the owner has
approved that model and host once"). Media adds one thing chat doesn't have:
every paid run also gets its own yes on the cost card above, because
spending always stops for the owner (principle 1). A host approval is never a
spending approval.

The card's buttons are "Make it (up to $0.40)" and "Not now", with the free
routes listed beside them. There is no "always allow" for paid runs; a
standing rule can cover only free routes (principle 1, routine low-risk
actions).

`local` and `upload` routes send nothing, so they need no host approval.
A local model that downloads its files does so once, as its own approved
step, showing the size and where they come from.

### 4. Is Site Engine the first user, and does it drive the layer?

Site Engine is the first module that will **use** media. It should not
**shape** the layer. The websites project's own lessons
(cloudwork-sites `docs/site-engine-lessons.md`, on its branch
`claude/project-thread-uqecyb`, not merged yet) found that for a product
site, drawn screens beat stock or AI footage, and video earns its place only
for atmosphere. So Site Engine needs media the least of the modules that will
want it (Convo Engine and creator work need it more). And the layer's shape
comes from what every capability needs: a contract, routes, a cost check, a
cap and a receipt. Media is the right first capability because it is the
first with paid routes, which forces the cap and ledger to be real.

When to build it: see "When To Build" below.

## What It Does

```
make_media(kind, prompt, seconds?, width?, height?, reference_files?, route?)
  -> { file, receipt }
```

- With no `route`, the runner offers the routes the person has set up,
  free ones first, and the person picks. A model can suggest a route; it can
  never pick a paid one by itself.
- **Upload:** the person picks a file they made. The runner checks its type
  and size, copies it to the media folder and writes a receipt.
- **Local:** the runner sends the job to a local server on the same machine
  (ComfyUI first, since Wan and LTX-Video both run there), shows progress and
  a time estimate, and can be cancelled.
- **Own key:** the cost card, then the call, then the receipt with the actual
  cost.
- **Sign-in:** only for a provider whose terms allow it (route field `terms`).
  None is known yet, so this route ships empty.

**The receipt**, saved beside each file: route, provider and model, the
prompt, what left the machine, the cost (actual or estimated), the time, and
"made by AI" for every route except upload (uploads: see the requirements
carried to the build). Site Engine's honesty gate reads
that label, so AI footage on a person's site is never passed off as filmed.

## Not In This Plan

- The websites repo's one-off paid clip script (owner decision 3).
- Audio, voice and music. Voice belongs to Convo Engine.
- Editing, cutting or joining clips.
- Picking a default paid provider for anyone.
- Sharing or publishing media; Publish keeps its own approval.

## The Parts

1. **Capability contract.** `packages/capabilities`: the `capability.json`
   schema above, a validator, and tests on invented records. The existing
   `first-principles-decision` record must still validate. Stands alone.
2. **Cap and ledger.** Signed cap records, the three cap levels, reserve and
   settle, $0 when missing or broken, and the bypass test from question 2
   (signing is faked with a test key here; the real Secure Enclave key comes
   in part 4). Stands alone.
3. **`make_media` with `upload` and `local` routes.** The runner, receipts,
   and a ComfyUI route tested against a fake local server. No outside host.
   Stands alone.
4. **Mac: cap settings, Secure Enclave signing, cost card and route picker.**
   Touches Keychain and key code, so it needs the owner's approval on GitHub
   (`.github/CODEOWNERS`).
5. **One `own_key` route,** for a provider the owner picks when this part
   starts. Adds an outside host, so the risk review holds it for the owner.
   Off until the person sets a cap.
6. **Owner trial** (below).

## Requirements Carried To The Build (Codex Round 3)

The plan review stops after two Codex rounds (AGENTS.md); these later
findings are requirements for the code pull requests named.

- **Part 2: an old signed cap can't be replayed.** The protected Keychain
  item also holds the current cap record's revision number and hash. The
  runner accepts only the record that matches, so restoring an older,
  validly signed, higher cap fails like an edit. The bypass test covers
  restoring an earlier valid cap.
- **Part 2: lowering or pausing needs no prompt.** A lower cap or a pause
  is saved as a tightening in the same protected Keychain item, written
  only by the signed runner, with no signature needed. The runner always
  uses the lower of the signed cap and any tightening. A tightening can
  only lower; going back up, or removing a pause, is a raise and needs the
  signed path. The bypass test covers deleting a tightening.
- **Part 4: Macs without a Secure Enclave.** On a supported Intel Mac with
  no T2 chip, the signing key is a Keychain key whose access control asks
  for the Mac password (user presence) on every signature. If no such key
  can be made, paid routes stay off and the picker says why ("This Mac
  can't protect a spending limit"), while upload and local keep working.
- **Parts 1 and 2: every amount names its currency.** Each price, quote,
  cap and ledger entry carries an ISO currency code. When a provider's
  quote or bill is in another currency than the cap, the runner refuses
  the paid route unless the person has turned on conversion, which uses a
  dated rate plus a safety margin, rounds up, and shows both amounts on the
  card.
- **Part 3: uploads don't claim to be filmed.** An upload's receipt asks
  the person how it was made (filmed or drawn by me, made with AI, or not
  sure) and reads any provenance data in the file (such as C2PA). "Made by
  AI" or "not sure" is kept as such; only the person's own "filmed or drawn
  by me", with no AI provenance in the file, counts as not AI. Site Engine's
  honesty gate treats "not sure" as AI.

## Revision, November 2, 2026: Parts 2 And 3 For GrokBot Team C

This revision adds detail for parts 2 and 3 and changes no requirement
above; it only names the builder. Parts 2 and 3 go to GrokBot team C, one after the other in
`packages/capabilities`, the package part 1 created. Part 2 starts when part
1 has merged and the coordinator's build issue names it. Part 3 starts when
part 2 has merged. Everything in "Requirements Carried To The Build" for
these parts is part of the job.

### Part 2: what to build

A library in `packages/capabilities/src/cap/` that the part 3 runner and the
Mac (part 4) call. It reads no clock: every call that needs the date or time
takes it as an argument (`now`, an ISO time from the caller).

- **Money.** Amounts as in part 1: decimal text plus an ISO 4217 currency.
  Sums and comparisons use whole-number micro-units (`BigInt`), never
  floating point. Amounts in different currencies are never added or
  compared. A quote in another currency than the cap is refused unless the
  caller passes a conversion the person turned on: a dated rate and a
  safety margin, rounded up, with both amounts in the result for the card.
- **The cap record.** `{ revision, currency, perRun, monthlyByCapability,
  monthlyAll, paused }`, signed with ECDSA P-256 and SHA-256 (`node:crypto`,
  DER-encoded signature) over canonical JSON. That is the one algorithm the
  Mac's Secure Enclave signs with (Apple's
  `ecdsaSignatureMessageX962SHA256`), so part 4's key fits without a format
  change. A test vector signed the way part 4 will sign (P-256, X9.62 DER)
  must verify. `verifyCap(record, signature, publicKey, protectedState)` accepts
  it only when the signature checks out and its revision and hash match the
  ones in `protectedState`. A missing, broken, unsigned or replayed record
  (an older one with a valid signature) means a $0 cap.
- **The protected state.** One small object `{ capRevision, capHash,
  tightening, ledgerHead, ledgerCount }` in a store the caller supplies;
  the library reads and changes it only through that store. In this part it lives in
  an in-memory test double. In part 4 the Mac keeps it in the Keychain item
  only the signed runner may change. Its interface is `read()` and
  `write(next, expected)`, where `write` fails if the stored value isn't
  `expected` (compare and swap).
- **Tightenings.** `tighten(protectedState, change)` lowers a level or
  pauses, with no signature. It refuses anything that raises a level or
  un-pauses: those go through a new signed cap. The effective cap is always
  the lower of the signed cap and the tightening. The protected state
  always carries the `tightening` field, set to `none` only by a signed
  cap; a protected state whose `tightening` field is missing or broken
  gives a $0 cap, so deleting a tightening never brings back the higher
  signed cap. Only a new signed cap clears a tightening.
- **The ledger.** Entries `{ seq, kind, capabilityId, routeId, amount,
  estimated, jobId, at, prevHash, hash }`, where `kind` is `reserve`,
  `settle`, `release` or `over-bill`, each chained to the one before by
  SHA-256. `ledgerHead` and `ledgerCount` in the protected state must match
  the file's last entry. Each reservation writes the ledger entry and the
  new head under the lock; a crash between the two leaves them unequal,
  which fails closed like an edit. A ledger that is missing, edited, broken in the
  chain or shorter than the protected head counts as fully spent for the
  month, until `resetLedger` is called with a fresh signed cap (part 4 adds
  the password prompt).
- **Reserve and settle.** `reserve({ capabilityId, routeId, max, jobId,
  now, providerTotal? })` checks all three levels (per run, this
  capability's month, the month across all paid capabilities) against
  reservations plus settled costs. When the caller passes the provider's
  own month figure for the key, the check inside the lock uses the higher
  of that figure and the ledger's settled total for that route's spend, so
  use elsewhere on the same key still counts. The check and the write are one step under a single lock: an
  in-process queue plus an exclusive lock file in the ledger folder, so
  two processes can't both fit into the same budget. `settle({ jobId,
  actual, estimated, now })` records the real cost, or keeps the reserved
  maximum marked estimated when no figure comes back. A bill above the
  approved maximum writes an `over-bill` entry, counts in full against the
  cap, and returns `routeOff: true` for the caller to switch the route off.
  `release` frees a reservation for a run that never started.
- **Month totals.** `monthSpent({ capabilityId?, now, providerTotal? })`
  returns the month's total; when the caller passes the provider's own
  figure for the key, it takes the higher one.
- **Command.** `node packages/capabilities/src/cap/show.mjs --ledger <dir>
  --state <state.json> --now <iso>` prints the effective cap, what is
  reserved and spent this month, and whether the ledger checks out. It
  changes nothing.

Part 2 tests (all with invented amounts and a test key made in the test):

1. A signed cap verifies. An edited one, an unsigned one, a missing one and
   an older validly signed one (replay) all give $0.
2. A tightening lowers and pauses at once with no signature. A tightening
   that raises or un-pauses is refused. Deleting or breaking a tightening
   gives $0, and only a new signed cap clears it.
3. Each level refuses a reservation that doesn't fit: per run, this
   capability's month, the month across all.
4. Twenty reservations started together (in this process and from two
   `worker_threads`) never add up past any level.
5. Deleting, editing (one byte) and restoring an older copy of the ledger
   each stop paid runs and say why.
6. An over-bill counts in full and returns `routeOff: true`; an estimated
   settle stays marked estimated.
7. The provider's figure is used when it is higher, both in `monthSpent`
   and inside `reserve`: a $10 cap with $9 reported by the provider and $2
   in the ledger refuses a $2 reservation.
8. A quote in another currency is refused without a conversion, and with
   one is rounded up after the margin and shows both amounts.
9. `0.1 + 0.2` style sums are exact; no amount ever passes through a
   JavaScript number.
10. Determinism and no clock: the library never calls `Date.now()` or
    `new Date()` without an argument.

The bypass test above covers what this package can show. Part 4's test adds
the proof that a process running as the same user can't write the Keychain
item; until part 4 passes, the cap is "designed", not "enforced".

### Part 3: what to build

The runner for `make_media` in `packages/capabilities/src/media/`, with
the `upload` and `local` routes only. It reads the capability record and
checks it with part 1's validator first.

- **Route list.** With no `route`, `listRoutes(record, setUp)` returns the
  routes the person has set up, free ones first. `own_key` and `sign_in`
  routes come back as "not available yet" (parts 4 and 5), never offered.
- **Upload.** Checks the file's type and size against the record's inputs,
  copies it into the media folder the caller names under a new name, and
  writes the receipt beside it. The receipt asks how the file was made
  (`filmed-or-drawn-by-me`, `made-with-ai` or `not-sure`, from the
  caller). It scans the file's bytes for AI provenance (the IPTC
  `trainedAlgorithmicMedia` or `compositeWithTrainedAlgorithmicMedia`
  source type, which C2PA manifests and XMP both use). Only the person's
  own "filmed or drawn by me" with no AI provenance found counts as not
  AI; "not sure" is kept as "not sure", which Site Engine treats as AI.
- **Local.** Sends the job to ComfyUI's HTTP API at a loopback address the
  caller gives (`127.0.0.1` or `::1` only; anything else is refused before
  any connection). It queues the workflow, reports progress through a
  callback, gives a time estimate from progress so far and the elapsed
  time (the caller passes a `now()` function), fetches the output into the
  media folder, and writes the receipt with "made by AI". An `AbortSignal`
  cancels it: the runner asks ComfyUI to interrupt and marks the run
  stopped. A server that isn't running gives "ComfyUI isn't running on this
  Mac" and how to start it. Nothing is retried in the background. The
  runner never follows a redirect: every request is made with redirects
  off, and any redirect answer fails the run before anything else is sent
  or fetched. Before sending, the runner checks every node in the workflow
  against a fixed allowlist of ComfyUI's built-in local nodes kept in the
  package (loaders, text encoders, samplers, decoders, image and video
  save and load nodes). Any other node is refused before anything is sent,
  including API or Partner nodes (which call outside providers and can
  spend credits) and custom nodes, so a local run can't send the prompt
  out or spend money while its receipt says "nothing" and "free".
- **Receipt.** JSON beside each file: route, provider and model, the
  prompt, `leaves_machine` (`nothing` for both routes), cost `free`, the
  time from the caller, and the AI label as above.
- **Command.** `node packages/capabilities/src/media/make.mjs --record
  <capability.json> --route upload --file <path> --made-how <answer>
  --media <dir>` for upload, and `--route local --server
  http://127.0.0.1:<port> --workflow <file.json> --prompt <text>` for
  local.

Part 3 tests (a fake ComfyUI server made with `node:http` on `127.0.0.1`
inside the test, and invented files only):

1. With no route, upload and local come first and paid routes are never
   offered.
2. An upload of the wrong type or over the size limit is refused and
   nothing is copied.
3. An upload with "filmed or drawn by me" and no provenance is not AI; the
   same answer on a file carrying `trainedAlgorithmicMedia` is AI; "not
   sure" stays "not sure".
4. A local run against the fake server returns a file and a receipt that
   says "made by AI" and "nothing" left the machine.
5. A non-loopback server address (`192.168.1.5`, `example.com`, a
   name such as `localhost`) is refused before any connection, and a fake
   server that answers with a redirect to another address fails the run
   without the runner contacting that address. A workflow with an API or
   Partner node, or a custom node, is refused before anything is sent.
6. Cancelling mid-run sends the interrupt and marks the run stopped.
7. A server that isn't running gives the plain message and no retry.
8. Hostile prompt text (quotes, script tags, right-to-left marks, line
   breaks) is kept as text in the receipt and never breaks the JSON.
9. A record that fails part 1's validator is refused before anything runs.

### Carried to the build (Codex, November 2)

These later review findings are requirements for the part 2 and part 3
pull requests.

- **Part 2: the cap month is the person's calendar month.** The cap record
  names an IANA time zone (`timeZone`, for example `America/Los_Angeles`).
  A month runs from local midnight on the first to local midnight on the
  first of the next month in that zone, worked out with `Intl` from the
  caller's `now`. Tests cover both sides of a non-UTC month boundary.
- **Part 2: conversion rates expire.** A rate older than 24 hours before
  `now` is refused and the paid route stays off (fail closed); a test
  covers a stale rate.
- **Part 3: the prompt goes to a named place.** A local workflow marks
  where the prompt goes with the exact text `{{prompt}}` in one text field.
  The runner refuses a workflow with no such field or more than one, puts
  the prompt there (as JSON text, never by splicing strings), and test 4
  checks that the queued workflow holds the prompt.

### Rules for the builder

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Start only when the coordinator's build issue names the part. Work in a
  checkout of this repo, through Cursor, signed in as `cloudwork-bot`, on
  the branch `OC-261102-media-cap` (part 2) or `OC-261102-media-runner`
  (part 3). Open a pull request into `main` with auto-merge off and the
  label `agent: grokbot`. Never push to `main` directly, and never switch
  on auto-merge.
- Mark the work as AGENTS.md "Accounts And Provenance" says: `Cursor Agent`
  as commit author, and `— GrokBot team C, <branch name>` as the last line
  of the pull request description and every comment.
- Run **no commands on the owner's Mac** for this job.
- Touch no keys, tokens, passwords, accounts, real Keychain, iCloud or
  private files. Signing keys are made inside the tests and thrown away.
  Invented data only.
- Change files only under `packages/capabilities/`, and leave part 1's
  validator as it is unless a test shows it wrong (say so in the pull
  request). Nothing else, not even `STATUS.md` or this plan (the
  coordinator updates them). Import nothing from `apps/` or another
  package.
- JavaScript modules (`.mjs`), Node 22 or later, tests with `node --test`
  through the package's existing `npm test`.
- No outside network, no AI, no paid services, no `child_process`, in the
  code or the tests. Part 3 may open connections to loopback addresses
  only; part 2 opens none. `node:crypto` and `worker_threads` are allowed.
- No new dependencies. Add no license file and no `license` field.
- Keep each part small: the library, its command, the tests and a README
  section with the inputs, the rules, the outputs and the command.
  Finishable in one to two days each.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Supported setups are macOS and the Linux CI runners on Node 22 (AGENTS.md
  "Review Guidelines"); don't add Windows-specific code.
- Edge cases this plan doesn't name: write each choice in the README's
  "Edge cases" section with a test.

### Review and finish line

Codex reviews each part as code until it gives a 👍. GrokBot fixes every P1
and P2 or explains in the pull request why one doesn't apply. The
coordinator checks it against this plan and posts the check as a comment.
Part 2 also gets an independent review from a fresh Claude review, because
it guards the owner's money. A part is done when its tests pass with one
command, Codex has no open P1 or P2 on the latest commit (or the Codex
triage judge passes it, [codex-triage.md](codex-triage.md)), and the plan
check finds nothing missing.

## When It Goes Wrong

The screens are the route picker, the cost card and the cap settings
([when-it-goes-wrong.md](when-it-goes-wrong.md)).

1. **No connection.** A paid route offline says so before any charge and
   offers the local and upload routes. A local server that isn't running says
   which one and how to start it. Nothing is retried in the background.
2. **Interrupted.** A paid run in flight when the app quits keeps its
   reservation and its provider job number. On the next launch the runner
   asks the provider for that job's result once, never sends it again, and
   says plainly whether a file came back and what was charged. A local run is
   simply marked stopped.
3. **Empty or first run.** With nothing set up, the picker shows Upload (ready)
   and two set-up choices: a local model, or your own key. Paid routes show
   "Set a cap first" while the cap is $0.
4. **Denied or stuck.** If the password or Touch ID prompt for raising a cap
   is refused or closed, the old cap stays and the screen closes normally.
   When a cap is reached, the card says how much is used, offers the free
   routes, and says raising it needs your Mac password.
5. **The error message.** Plain words for what happened, what was charged
   (or "nothing was charged"), and the next step, for example "Your fal key
   was refused. Nothing was charged. Check the key in Settings, or make it on
   this Mac instead."

## Owner Trial (Part 6)

In True Convo Test, with invented prompts:

1. Make a short clip by upload, then an image by upload; each receipt shows
   no cost and no AI label.
2. Make a short clip, then an image, with a local model; nothing leaves the Mac (checked with
   the app's network log), and the receipt says "made by AI".
3. With the cap at $0, the paid route shows "Set a cap first".
4. Set a $1 monthly cap (the Mac password prompt appears). Make one paid clip and one paid image:
   each card shows the most it can cost first, and each receipt shows the
   cost.
5. Ask a model in a conversation to raise the cap: it can't, and says why.
6. A paid run that would go over the cap is refused before anything is sent.
7. Quit mid-run on a paid clip; the next launch says what came back and what
   was charged, and doesn't charge twice.
8. Turn the network off; the paid route says so and offers the free ones.
9. With the local server not running, the local route names it and says how
   to start it.
10. Quit mid-run on a local clip; the next launch marks it stopped.
11. With nothing set up (a fresh test profile), the picker shows Upload as
    ready and the two set-up choices, and the paid route says "Set a cap
    first".
12. Start raising the cap and cancel the password prompt; the old cap stays
    and the screen closes normally.
13. Reach the cap; the card says how much is used, offers the free routes,
    and says raising it needs your Mac password.
14. Use a refused key (an invented one); the message says what happened,
    "Nothing was charged", and the next step.
15. Replace the ledger file with an older copy; paid routes stop and say
    why.

## When To Build

Parts 1 to 3 stand on their own and start now, beside the main build. Step 6
is still several steps away (steps 2 and 3 are in their owner trials, then
the Claude Code adapter, Canvas, steps 4 and 5), and the cap and ledger are
needed by step 6's paid judge anyway. The owner leaned this way on November
2 in this thread; the PLAN.md line in this pull request records it and
needs his approval on GitHub. Parts 4 to 6 wait for the Mac work in step 6.
