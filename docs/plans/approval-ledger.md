# Approval Ledger: The Host's Record Of Each Yes (PRD)

Status: Draft (Nov 3): waiting on the owner's yes in the Claude thread "Draft next plans for outside builders".

Written November 3, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261103-approval-ledger`. Umbrella: Personal (used by every umbrella).
This is the first standalone piece of **step 3** of the Plan Of Record in
[prime-agent.md](prime-agent.md) ("Then: in True Convo"), where "slice 3
puts the gate in code". The routing engine (`packages/prime-routing/`,
[prime-agent-routing.md](prime-agent-routing.md)) decides **whether** an
action needs a yes, and its README's caller rule says the host owns the
record of approvals and must claim each one exactly once before the action
starts, even when two calls race. This package is that record.
**Builder:** Codex team B, under AGENTS.md "Outside Builders" (it built the
routing engine, #253). **Reviewers:** Codex reviews every push; GrokBot or
a fresh Claude is the independent review, ending with the risk-review
checklist ([risk-review.md](risk-review.md)); the coordinator checks it
against this plan. **Finish line:** the package merges with `tests`
passing, and its command, run on the invented sample, shows a yes being
recorded, claimed once, and refused the second time, and the owner
trial below passes.

## Why

A yes is the most important thing True Convo keeps. If the record of it can
be edited, replayed, used twice after a crash, or written by something
other than the person, then the approval rules in the routing engine mean
nothing. These are rules about storage and order, not judgement, so they
belong in one small tested library before the Desk wires the prime agent
in. The design follows the spending cap's ledger
([media-generation-capability.md](media-generation-capability.md), part 2),
which went through the same review questions.

## What It Does

`packages/approval-ledger/`, plain JavaScript, no dependencies. No clock
reads: every call takes `now` as an RFC 3339 instant.

### What Is Kept

An append-only list of entries, each hash-chained to the one before
(SHA-256 over canonical JSON, the previous entry's hash included), of five
kinds:

- `asked`: `{ requestId, actionId, digest, description, kind, askedAt,
  expiresAt }`. `digest` is the routing engine's `actionDigest({
  description, kind, payload })`, imported from `packages/prime-routing/`
  through its public API. The payload itself is not stored.
- `answered`: `{ requestId, answer: "yes" | "no", answeredAt, source }`.

Every `requestId` is used once. `ask()` refuses an id already in the
ledger (asked, finished, withdrawn or expired, and ids from before a
reset), and `answer()`, `withdraw()`, `claim()` and `finish()` refuse an id
that was never asked, so a yes can only ever belong to the one request the
person saw.
- `claimed`: `{ requestId, claimId, claimedAt }`, written just before the
  action starts.
- `finished`: `{ requestId, claimId, outcome: "done" | "failed" |
  "unknown", finishedAt }`.
- `withdrawn`: `{ requestId, withdrawnAt }`, when the person takes back a
  yes before it is claimed.

### The Rules

1. **Only the person's yes counts.** `answer()` takes a `source` that the
   host fills in from its own record of who pressed the button: `person`,
   `agent` or `system`. Only `person` with `yes` can be claimed. An
   `agent` or `system` answer is stored (so it shows in the history) and
   never counts.
2. **One yes, one action.** `claim({ requestId, actionId, digest, now })`
   succeeds only if the request has a person's yes, the `actionId` and the
   digest both match the ones asked about exactly (the digest leaves out
   the action id, so both are checked), the yes hasn't expired, been withdrawn or been
   claimed, and no `no` came later. It writes `claimed` and returns a
   `claimId`. Every later claim of the same request is refused.
3. **Claim before acting, under one lock.** Every write runs under an
   in-process queue plus a lock file opened with `O_EXCL`, re-reads the
   ledger, checks it, and writes through a temporary file and a rename. So
   two claims racing in two processes give one success and one refusal.
4. **Expiry.** `expiresAt` is set when asking: at most 24 hours after
   `askedAt`, default 30 minutes. An expired yes can't be claimed; it must
   be asked again.
5. **The last answer wins until claimed.** A `no` after a `yes` cancels it.
   A `yes` after a `no` restores it. After a claim, answers are refused.
6. **A crash fails closed.** A request with `claimed` and no `finished` is
   reported as `inFlight`. It is never claimable again; the host shows it
   to the person as "may or may not have happened" (`outcome: "unknown"`).
7. **Damage stops everything.** A missing entry, an edited entry, a broken
   chain, a symlink, or a ledger whose head and count don't match the
   protected state (below) makes every claim refuse with a plain reason
   until the person resets it. A reset writes a new chain that starts with
   a `reset` entry naming the old head and listing every request id the
   readable part of the old chain used (so none can be asked again); nothing from the old chain can be
   claimed afterwards.
8. **Protected state.** The ledger's head hash and count are also kept
   through a store interface `{ read(), write(next, expected) }` (compare
   and swap), as in the cap's part 2, so a copy of an older ledger can't be
   swapped in. In this slice the store is a file, and its path must be
   outside the ledger folder: `open()` refuses a store path inside it (or a
   symlink into it), so restoring a backup of the ledger folder alone is
   caught as damage (rule 7).
9. **Rollback limit, stated plainly.** A file store can't stop someone
   restoring an old backup of both the ledger and the store together; then
   a used yes would look unused. This slice does not claim to stop that.
   The README says so in its first section, and no host may use this
   package to start a real outside action until True Convo's protected
   storage (which keeps a counter outside any backup) supplies the store.
   That wiring is a later plan and must close this gap before it merges.

### Functions

`ask`, `answer`, `withdraw`, `claim`, `finish`, `status(requestId)`,
`pending(now)` (asked, unanswered, not expired), `history({ from, to })`,
`verify()` and `reset()`. Each returns a plain result or a refusal
`{ ok: false, reason }`. The caller opens the ledger with two
locations: `ledgerDir` (the ledger and its lock file) and `storePath` (the
file store's one file, outside `ledgerDir`). The library writes only to
those two, with mode `0600` for new files.

### The Command

`node packages/approval-ledger/src/ledger.mjs --dir <ledger folder>
--store <store file> <verb> ...` for `status`, `pending`, `history` and `verify`. It only reads. Writes
happen through the library, called by the host.

**The sample driver**, for the finish line and the owner trial only:
`node packages/approval-ledger/src/sample.mjs --dir <folder> <verb> ...`
with `ask`, `yes`, `no`, `withdraw`, `claim`, `finish`, `reset` and
`lock` (leaves a lock file as a crash would). It works only on a folder it
created itself: given a missing or empty folder it creates
`<folder>/SAMPLE-ONLY`, the ledger in `<folder>/ledger/` and the store at
`<folder>/state/head.json` (a sibling, so restoring `ledger/` alone is
caught), and it refuses any folder without that marker. The trial's
"restored from an older copy" step copies `ledger/` only. Its actions are invented and fixed in the code (for
example "Send the invented note to Robin"); it takes no action text,
payload or source from the command line, records its yes as a `person`
answer, and runs nothing. The README's owner trial uses it step by step.

## When It Goes Wrong

The command is a screen the owner may see, and the rules above decide what
the Desk will later show, so this answers the five questions in
[when-it-goes-wrong.md](when-it-goes-wrong.md):

1. **No connection.** Doesn't apply: the ledger is local files only.
2. **Interrupted.** Writes are a temporary file plus rename under the lock,
   so an interrupted write leaves the last whole ledger. A crash between
   claim and finish leaves the request in flight, never claimable again
   (rule 6). A lock file left by a crash makes writes refuse with
   "Another approval is being recorded. If nothing is running, remove
   <path>." and never deletes it by itself.
3. **Empty or first run.** An empty folder is an empty ledger: `pending`
   says "Nothing is waiting for your yes."
4. **Denied or stuck.** A refused claim never retries by itself. The host
   asks the person again.
5. **The error message.** Each refusal says what happened in plain words:
   "This yes was for a different action", "This yes expired at 2:15 PM",
   "This yes was already used", "The approval record was changed outside
   True Convo, so nothing can run until you reset it".

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/approval-ledger/` (invented actions only):

1. Ask, a person's yes, claim, finish: one success; the second claim is
   refused.
2. An agent's yes and a system yes are kept but never claimable.
3. A claim with a digest that differs in only the description, only the
   kind, or one payload byte is refused, and so is a claim with the same
   digest but another action's `actionId`.
4. Expiry: a claim one second after `expiresAt` is refused; `expiresAt`
   more than 24 hours out is refused when asking.
5. Asking again with a used request id (including one from before a
   reset) is refused, and answering an id that was never asked is refused
   and leaves nothing claimable. No after yes cancels; yes after no restores; answers after a claim are
   refused; withdraw before claim works, after claim is refused.
6. **Race.** 20 claims of the same request from `worker_threads` give
   exactly one success.
7. Crash between claim and finish: the request is in flight and never
   claimable again.
8. Damage: a deleted entry, an edited entry, a reordered pair, a symlinked
   file and an older copy of the ledger folder (store kept current) each
   make claims refuse with a reason; `reset()` recovers, and nothing from
   before it can be claimed. A store path inside the ledger folder is
   refused at `open()`.
9. A stale lock file makes writes refuse with the plain message and is not
   removed.
10. The sample driver refuses a folder without its marker and takes no
    action text from the command line.
11. The library reads no clock, opens no network, uses no `child_process`,
    and imports `packages/prime-routing/` only through its public API (a
    test checks the source).

**Owner trial checks** (the owner, or an agent on his Mac for him, runs
the command on throwaway invented folders the README sets up, and he reads
each message): an empty folder says "Nothing is waiting for your yes."; a
yes is claimed once and the second claim shows "This yes was already used";
a claim after expiry shows the expiry time; a claim for a changed action
shows "This yes was for a different action"; a request claimed with no
finish shows as "may or may not have happened" and can't be claimed; a
left-behind lock file gives the plain lock message naming the path and is
still there afterwards; an edited ledger file, and a ledger folder restored
from an older copy, each show the "changed outside True Convo" message
until reset; after reset nothing old can be claimed. He confirms each
message tells him what to do next.

## Out Of Scope For This Slice

The Desk's approval screen, notifications, the Face ID or password
confirmation (the owner's decision of #163 applies when the app wires this
in), using True Convo's protected storage, the dispatcher, and running any
action.

## Rules For The Builder (Codex Team B)

The builder must follow these; the setup does not enforce them, so breaking
one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, on the branch `OC-261103-approval-ledger`, signed
  in as `cloudwork-bot` (or as Codex's own GitHub app for a cloud task).
  Open a pull request into `main` with auto-merge off and the label
  `agent: codex`. Never push to `main` directly, and never switch on
  auto-merge.
- End the pull request description and every comment with
  `— Codex team B, OC-261103-approval-ledger`.
- Run **no commands on the owner's Mac** apart from `npm test` inside
  `packages/approval-ledger/` and the `git` and `gh` commands needed to
  commit, push and open the pull request.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented data only.
- Change files only under `packages/approval-ledger/`. Import
  `packages/prime-routing/` by relative path through its public API only;
  if it lacks something, stop and report instead of changing it. Nothing
  else, not `STATUS.md` (the coordinator updates it).
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network, no AI, no paid services, no `child_process`, no clock, in the
  code or the tests. `node:crypto`, `node:fs` (only the given ledger folder and store
  file, or the tests' temporary folders)
  and `worker_threads` (tests) are allowed.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the library, the read-only command, the tests and a
  README with the entry kinds, the rules, the functions and the command.
  Finishable in one to two days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Supported setups are macOS and the Linux CI runners on Node 22 (AGENTS.md
  "Review Guidelines").
- Edge cases this plan doesn't name: write each choice in the README's
  "Edge cases" section with a test.

## Review And Finish Line

Codex reviews it as code until it gives a 👍. Codex team B fixes every P1
and P2 or explains in the pull request why one doesn't apply. GrokBot or a
fresh Claude gives the independent review with the risk-review checklist,
because this package guards every outside action. The coordinator checks it
against this plan and switches on auto-merge once both are clean on the
same head. Done when the tests pass with one command, the reviews are clean
(or the Codex triage judge passes it, [codex-triage.md](codex-triage.md)),
and the plan check finds nothing missing.
