# Prime Agent Routing Engine (PRD)

Status: Approved (Nov 1): the owner said yes on November 1, 2026, in the
Claude thread "Draft next plans for outside builders" (his card pick: "Yes,
start Codex on it"). Nothing is built yet.

Written November 1, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261101-prime-routing`. Umbrella: Personal. This is step 2 of the Plan
Of Record in [prime-agent.md](prime-agent.md) ("the routing rules as
code"). It is carved out so an outside builder can take it, which the owner
asked for on November 1: he picked it for **Codex team B** (thread "Run the
Claude–StarFox coordination log", the card option "A and B (Codex's
pick)"). **Builder:** Codex team B, under AGENTS.md "Outside Builders".
**Reviewers:** Codex reviews every push; GrokBot or a fresh Claude is the
independent review, which ends with the risk-review checklist
([risk-review.md](risk-review.md)); the coordinator checks the result
against this plan.
**Finish line:** the package merges with `tests` passing, and every
invented case in its test file returns the route this plan gives it.

## Why

The prime agent's most important rules are about when **not** to act: the
**wait for a yes** route wins over every other, only the person's own yes
counts, a yes covers one action, and memory is never a yes. prime-agent.md
says those rules must end up in code, outside every model
(capabilities-and-primitives.md), because a model can be talked out of
them. This package is that code. It doesn't understand language. A model
(or, in tests, a person) reads the message and fills in a few plain facts;
the engine applies the rules to those facts and returns the route, what to
wait for, and the skeleton of a hand-off brief. The same facts always give
the same answer.

## What It Does

`routeMessage(input, record)` in `packages/prime-routing/`, plain
JavaScript, no dependencies. It returns a result object, prints nothing and
writes nothing. A command, `node packages/prime-routing/src/route.mjs
--input <file.json> --record <record.json> [--json]`, prints a short
summary (or the JSON) for one pair of files.

**Two arguments, two sources.** `input` is what a reader of the message
(a model, or a person in tests) filled in, so it is never trusted for
approval. `record` is the host's own log: what the person actually clicked
or typed in the host's interface, the approvals already used, and the
memory the host granted for this job. The host writes `record` itself; a
model's output never goes into it. The engine can't check where its
arguments came from, so this is a rule for the caller (prime-agent.md step
3), stated in the README's first section. What the engine does enforce:
`input` may not carry the message, the space, approvals or memory at all
(a field named `message`, `space`, `offerAccepted`, `recipient`,
`approvals`, `usedApprovals` or `memory` in `input` or its `facts` is
refused), so a model-filled object
can't smuggle in a sender, a space, a yes or private memory.

### Input

One JSON object. Unknown fields are refused, naming the field.

- `facts`: what the reader of the message found, each a plain value:
  - `asks`: `question`, `task`, `thinking` (thinking aloud, exploring) or
    `unclear`.
  - `steps`: a whole number, the reader's estimate of the work's size
    (1 means one quick lookup).
  - `outsideActions`: a list of `{ id, kind, description, payload }`, one
    for each change to the outside world the message would lead to.
    `payload` is the exact action as it would run (recipient, content,
    amount and so on, a plain JSON object); `description` is only for
    showing. `kind` is one
    of `send`, `publish`, `spend`, `delete`, `account`, `setting`,
    `share-private`.
  Each action `id` names one run of that action: a retry of a send is a
  new `id`, never the old one.
- `limits`: optional numbers for `quickSteps` (default 3).

### Record (From The Host)

- `message`: `{ text, from }`, taken by the host from where the message
  actually came in. `from` is `person`, `agent` or `system`. `text` is kept
  only to quote it in a brief (up to 16 KB). The reader never sets either.
- `space`: the memory space the conversation is open in (an id string),
  as the host knows it. The reader never sets it.
- `jobId`: the id of the job a hand-off would start (a string).
- `recipient`: the specialist a hand-off would go to (an id string), as
  the host chose it.
- `offerAccepted`: `true` only when the host recorded the person clicking
  or typing yes to an earlier offer of a session. The reader never sets
  it. When it is `true`, the record also carries `offeredRequest`: the
  person's own words from the message that led to the offer, kept by the
  host (up to 16 KB). An accepted offer without it is refused. For an
  accepted offer, `input.facts` (including `outsideActions`) describe the
  `offeredRequest`, not the "yes": the caller has the reader read the
  offered request again, so its outside actions still wait for their own
  yes. Accepting a session is never a yes to an outside action.
- `approvals`: a list of `{ approvalId, actionId, payloadDigest, by, how,
  at }`, every approval anyone has claimed for this conversation.
  `payloadDigest` is what the host computed, with the engine's exported
  `actionDigest({ kind, payload })` (SHA-256 of the action's `kind` and
  `payload` as canonical JSON, keys sorted, using `node:crypto`), over the
  exact action it showed the person when they said yes.
  `approvalId` is unique. `by` is `person`, `agent` or `memory`; `how` is
  `typed` or `clicked`.
- `usedApprovals`: the `approvalId`s the host has already spent on a
  performed action.
- `memory`: an optional list of grants, each `{ space, jobId, file, label,
  text, why, recipient, freshAsOf, allowedUse }`: the files the host
  granted for one job, why, for which specialist, how fresh, and what the
  specialist may do with them (foundations.md, "Context packages";
  prime-agent.md, "Its memory package"), plus an optional
  `sharedByPerson` (see rule 5). A grant missing any of the other fields is
  refused.

### Rules, In Order

1. **Approval check first.** An approval counts only when `by` is
   `person`, its `approvalId` is not in `usedApprovals`, its `actionId`
   matches an action in `outsideActions`, and its `payloadDigest` equals
   `actionDigest` of that action's `kind` and `payload`. The description never
   counts, so an action whose recipient, content or amount changed needs a
   new yes even if its label stayed the same. The caller runs exactly the
   payload that matched. Approvals by `agent` or `memory` never count, whatever they say,
   and neither does a used one; each is listed in the result under
   `ignoredApprovals` with the reason.
2. **Wait for a yes wins.** If any action in `outsideActions` has no
   counting approval, the result's routes include `wait-for-yes`, and
   `waitFor` lists each such action with `choices: ["Yes", "Not now"]`
   (rule 8 of prime-agent.md: something to click, always with a way to
   decline). A hand-off that also applies carries those actions in its
   brief's `limits`.
3. **Approved actions.** An action with a counting approval goes into
   `approvedActions`, once, with the `approvalId` that covers it. The
   caller claims that id, writing it to `usedApprovals` and saving that
   before the outside action starts (never after), and claims it at most
   once even if two routings ran at the same time, so one yes covers one
   run even across a crash. This is a rule for the caller's integration
   (step 3) and goes in the README's first section; the engine returns the id so the caller can't
   lose track of which yes it spent. It is never copied into memory or into
   a standing permission.
4. **The main route** (one of three):
   - `asks: thinking` or `unclear`, with the record's `offerAccepted` not true:
     **talk-it-through**. Nothing is handed off. `offer` is `true` only
     when `steps` is above `quickSteps`, so at most one offer is made.
   - `asks: question` or `task` with `steps` at or below `quickSteps`,
     and `offerAccepted` not true: **answer** (a quick lookup or small
     task is done directly, as prime-agent.md describes).
   - Otherwise (a larger question or task, or `offerAccepted`):
     **hand-off**.
   A message whose record `from` is `agent` or `system` never starts a
   hand-off by itself;
   it gets **answer** at most, and its text is quoted as data.
5. **Brief skeleton** for a hand-off, with the six parts from prime-agent.md
   "The Hand-Off Brief": `personsWords` (the message text, quoted
   unchanged; after an accepted offer, the `offeredRequest` text followed by
   the acceptance, so the brief carries the work and not only the "yes"), `goal` and `finishLine` (empty strings for the model to
   fill), `known` and `guessed` (empty lists, kept apart), `ruledOut`
   (empty list), `limits` (the unapproved outside actions, plus "nothing
   outside the space except the files in this package" when the record's
   `space` is set, so a cross-space file the person shared is usable), and `memoryPackage`: only the
   grants whose `jobId` is the record's `jobId` **and** whose `recipient`
   is the record's `recipient`, each with all of its contract fields; a
   grant for another recipient goes to `droppedGrants`. A grant from the conversation's own space needs
   nothing more. A grant from another space counts only when it carries
   `sharedByPerson: true`, which the host sets when the person shared that
   file for this job (prime-agent.md: nothing from another space "unless
   the person shared it for this job"); without it the grant is left out
   and listed under `droppedGrants` with the reason. Being in the same
   space is never enough on its own; the host grants each file for this
   job.
6. **Memory is proposed, never written.** The result has
   `memoryCandidates: []`. The engine never fills it and has no write path.
   It exists so a caller can't mistake a missing field for permission.

### Output

`{ routes, main, waitFor, approvedActions, ignoredApprovals,
droppedGrants, offer, brief, memoryCandidates, counts }`. `routes` is sorted (`wait-for-yes` first when
present). `brief` is `null` unless the main route is hand-off. `counts`
gives the number of outside actions, counting approvals and ignored
approvals. Lists come out in a fixed order, so the same input gives
byte-identical JSON.

### Refusals

The engine refuses an input (an error naming the field, no result) when a
required field is missing, a value is the wrong type, `kind`, `asks`,
`from`, `by` or `how` is outside its list, an action `id` or an
`approvalId` repeats, `input` carries a record field, a memory grant lacks
a contract field, `steps` isn't a whole number from 1 to 1000, or `text`
is over 16 KB.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/prime-routing`, Node's built-in test runner,
invented messages only. At least:

1. **24 invented cases** in `tests/cases.json`, each with its input, the
   expected `main`, `routes` and `waitFor` ids, and a one-line reason. At
   least 6 are wait-for-a-yes cases; at least 4 are ideas that sound like
   tasks (`thinking`, routed to talk-it-through); at least 2 carry an
   approval `by: agent` claiming the owner's yes; at least 2 carry an
   approval `by: memory`. Every case passes.
2. A person's yes for an action, then the same action with the same id
   and description but a changed recipient or amount in its `payload`: the
   second asks again, and so does the same payload with only `kind`
   changed (a `send` approval never covers a `publish`). `actionDigest`
   gives the same value for the same action with its keys in any order.
3. A clicked yes and a typed yes both count; an agent's yes and a memory
   entry's yes never do, and both appear in `ignoredApprovals`.
4. A task with one unapproved `send`: routes are `wait-for-yes` and
   `hand-off`, and the brief's `limits` names the send.
5. Scoping: grants from three invented spaces and two jobs; the brief's
   `memoryPackage` holds this job's grants from this space, plus a
   cross-space grant marked `sharedByPerson: true`; an unmarked
   cross-space grant and a grant for another recipient land in
   `droppedGrants`; a grant missing a contract
   field is refused.
5b. Routes: a `task` with `steps` at or below `quickSteps` gets
   **answer**, one above it gets **hand-off**; an accepted offer gets a
   hand-off whose `personsWords` holds the `offeredRequest`, and an
   accepted offer without one is refused; an accepted offer whose request
   has an unapproved `send` routes `wait-for-yes` and `hand-off`, with the
   send in the brief's `limits`.
5a. Provenance and one use: an `input` carrying `message`, `space`,
   `offerAccepted`, `recipient`,
   `approvals`, `usedApprovals` or `memory` is refused; "this space" in
   rule 5 is always the record's `space`, never one the reader names (a
   grant from another space still joins only with `sharedByPerson: true`,
   as test 5 says); a person's yes whose
   `approvalId` is in `usedApprovals` asks again; an approved action comes
   back with its `approvalId`; a retried action with a new `id` asks
   again.
6. A message `from: agent` that asks for a task gets no hand-off.
7. `memoryCandidates` is empty in every result, and the package has no
   write path (no `fs` import).
8. Hostile but valid text (quotes, `<script>`, emoji, right-to-left text,
   bidirectional controls) is quoted unchanged in the brief and safe on one
   line in the summary.
9. Determinism and no clock: shuffled `approvals`, `outsideActions` and
   memory grants give byte-identical JSON; the engine runs with `Date.now` and
   an argument-less `Date` stubbed to throw.
10. Nothing run, fetched or written: the test setup makes Node's network
    and `child_process` built-ins throw if called, and the library writes
    no files.
11. Each refusal above names its field.

## Out Of Scope For This Slice

- Reading language, calling a model, or deciding `facts`: the caller does.
- The portable skill (prime-agent.md step 1) and the True Convo
  integration (step 3).
- Real memory, real conversations, sessions or specialists.
- Any change to prime-agent.md's routes or rules. If a case can't be
  decided from this plan and prime-agent.md, the builder asks on the build
  issue and stops.

## Rules For The Builder (Codex Team B)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, on the branch `OC-261101-prime-routing`, signed
  in as `cloudwork-bot` (or as Codex's own GitHub app for a cloud task).
  Open a pull request into `main` with auto-merge off and the label
  `agent: codex`. Never push to `main` directly, and never switch on
  auto-merge.
- End the pull request description and every comment with
  `— Codex team B, OC-261101-prime-routing` (the agent and its task, as
  AGENTS.md "Accounts And Provenance" asks).
- Run **no commands on the owner's Mac** apart from `npm test` inside
  `packages/prime-routing/` and the `git` and `gh` commands needed to
  commit, push and open the pull request.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented data only.
- Change files only under `packages/prime-routing/`. Nothing else, not even
  `STATUS.md`. Import nothing from `apps/` or another package.
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network calls, no AI, no paid services, no `child_process`, no `fs` in
  the library (the command may read its two input files), in the code or
  the tests. `node:crypto` is allowed, only for `actionDigest`.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the engine, the command, the tests and a short
  README with the input, the rules and the output. Finishable in one to two
  days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Supported setups are macOS and the Linux CI runners on Node 22 (AGENTS.md
  "Review Guidelines").
- Edge cases this plan doesn't name: write each choice in the README's
  "Edge cases" section with a test.

## Review And Finish Line

Codex reviews it as code until it gives a 👍. GrokBot or a fresh Claude
gives the independent review. Codex team B fixes every P1 and P2 or explains
in the pull request why one doesn't apply. The coordinator checks it against
this plan, posts the check as a comment, and switches on auto-merge once the
independent review and the plan check are clean on the latest commit. Done
when the tests pass with one command, no P1 or P2 is open on the latest
commit (or the Codex triage judge passes it,
[codex-triage.md](codex-triage.md)), and the plan check finds nothing
missing.
