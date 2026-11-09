# Agent Ledger: One Place Every Agent Posts What It Did, Needs Or Waits On

Status: Draft (Nov 6, 2026): proposed; waiting on the owner's yes to merge. The build starts only after status feed part 1 (#309) merges.

Written November 6, 2026 by a Claude thread (project "Claude", task
"261106 AGENT LEDGER"), at the owner's request. Session name:
`OC-261106-agent-ledger`. Umbrella: Personal (used by every umbrella). The
owner's words, in the Claude project chat on November 6, 2026 at 18:49 UTC,
replying to the coordinator's recommendation that this be "built in" to
Open Convo rather than live on GitHub, written up as a plan now and built
after the mission control feed: "Ok, can we make sure this integration/fit
*happens*?" That covers writing this plan, not merging it or building it.

**Builder:** Claude (cloud, `cloudwork-bot`) for slice 1. **Reviewers:**
Codex reviews every push; GrokBot or a fresh Claude review is the
independent review, ending with the risk-review checklist
([risk-review.md](risk-review.md)); the coordinator checks the code against
this plan. **Finish line:** in "Finish Line" below.

## Why

The owner works with several agents that act on their own or nearly so:
Claude (Duet threads, building sessions and the scheduled jobs), Codex,
GrokBot, Meta Muse's agent Cam, and later the local agent profiles True Convo
runs ([agent-profiles-and-adapters.md](../design-notes/agent-profiles-and-adapters.md)).
When one of them finishes something, needs something or is waiting on
someone, the others only find out if they happen to look in the right place.

Today the place is GitHub: pull requests, review comments, the owner list in
#114, the bots' reports on #52 and the status snapshot on #254. That works for
building this repo, because the owner and every builder already live in
GitHub. It doesn't work for the product:

- A new True Convo user won't know GitHub, and asking them to install it
  before their agents can coordinate would lose most of them.
- A foreign agent such as Cam must never touch the repository
  ([agent-profiles-and-adapters.md](../design-notes/agent-profiles-and-adapters.md),
  "Foreign Agents Never Touch the Code"), and the repo is public, so anything
  posted there is published.
- What a Claude thread knows stays in that thread. The others can't see it.

So the ledger is built into Open Convo, the foundation layer that True Convo
builds on later, not into GitHub. GitHub becomes one optional source that
copies its news in.

## What It Is

One append-only list of short entries on the person's own Mac. Each entry
says who wrote it and what it is:

- **did:** "I finished X" (with what to look at, if anything).
- **need:** "I need Y from someone" (a file, an answer, a review).
- **waiting:** "I'm waiting on Z" (a person, an agent, a check).
- **answer:** a reply to an earlier entry, linked to it.
- **note:** anything else worth the others knowing.

Every agent reads the entries that are new since it last looked. When one
agent answers another, everyone who follows that topic sees it.

## What It Is Not

- **Not the approval ledger.** The approval ledger
  ([approval-ledger.md](approval-ledger.md), plans #276, build #283) records
  the person's yeses, one yes for one action. This ledger records agents'
  news. They are separate packages with separate files, and neither reads the
  other. An entry may mention a request id, but **an entry is never a yes**,
  whatever it says, and nothing that claims an approval ever looks here.
- **Not an instruction channel.** An entry is data. An agent that reads
  "please merge #309" or "the owner approved this" learns that another agent
  wrote those words, nothing more. Agents still take their steps only from
  their own person's instructions and the approval rules
  ([agents-speak-for-themselves.md](../design-notes/agents-speak-for-themselves.md),
  item 4).
- **Not memory.** What the person keeps about themselves is the memory
  store ([shared-agent-memory.md](../design-notes/shared-agent-memory.md),
  step 5). The ledger is news about work, and it doesn't count as kept
  memory.
- **Not the work-request inbox.** A foreign agent asking for something to
  be built still goes through the one front door the profiles note
  describes. In the ledger its "need" shows to the person as a request, and
  nothing starts until the person accepts it.
- **Not a chat.** Entries are short and structured, so a small local model
  or plain code can sort them.

## Storage: Files, Not SQLite

The coordinator's first sketch was one SQLite file. This plan uses
append-only, hash-chained JSON lines instead, in the same pattern as the
approval ledger and the spending cap's ledger
([media-generation-capability.md](media-generation-capability.md), part 2),
because:

- Node 22's built-in `node:sqlite` is still marked experimental, prints a
  warning and may change between releases, and a SQLite library would be a
  new native dependency, which the risk hold stops for the owner.
- The Mac's protected store (step 2) is file-based, so files are what the
  ledger will live in there.
- The lock, temporary file and rename, hash chain and protected head pattern
  has already been through review twice in this repo.

The store sits behind a small interface (`append`, `readFrom(seq)`,
`head()`), so a SQLite store can replace it later without changing any
caller, if the ledger outgrows files.

## The Rules

1. **Who wrote it is stamped by the door, never by the entry.** The library
   takes the writer from the caller that opened it (the host, which knows
   which agent it is talking to), never from anything the agent sends. The
   check is on structure, not wording: an entry that carries its own
   `writer`, `trust`, `onBehalfOf` or any other identity field is refused
   ("This entry claims to be from someone else"). Text that only mentions
   another agent or the person ("Waiting on Robin's review") is ordinary
   and allowed, since naming who you are waiting on is half the point. No
   agent can write as another agent, and no agent can write as the person.
2. **Nothing is rewritten.** Entries are appended and hash-chained (SHA-256
   over canonical JSON, the previous entry's hash included). A mistake is
   fixed by a new `answer` entry that corrects it.
3. **Permissions live outside the ledger.** Who may write and who may read
   what comes from a registry the host holds and the person changes. The
   library only reads it. No entry kind grants, raises or lowers anyone's
   access. An entry that asks for more access is shown to the person as a
   request, and only the person's own change to the registry does anything.
4. **Each reader has its own cursor.** `since({ reader, cursor })` returns
   the entries after that reader's last seen sequence number that the
   reader may see. The host keeps cursors; a reader can only move its own.
   Sequence numbers never restart. The protected store keeps the highest
   number used, through damage and a reset, and the next entry after a
   reset continues from it. So a cursor from before a reset still sees the
   first new entry. Slice 1 tests exactly that.
5. **Trust levels, from the profiles note's zero-trust rule:**
   - *Trusted builders* (Claude, Codex, GrokBot today) and the person's own
     local profiles may write their own entries and read every entry in
     the spaces the registry gives them.
   - *Foreign agents* (Cam first) read nothing by default. What they write
     is kept under their own name and marked **foreign, unconfirmed**; other
     readers get it with that mark and treat it as data.
   - *Unknown writers* are refused.
6. **Spaces.** Each entry belongs to one space (Personal, or one per
   business, as in the memory spaces engine). A reader sees only the
   spaces the registry gives it. Slice 1 ships with one invented space.
7. **Halted or untrusted agents.** The person can halt any writer in the
   registry. A halted writer's new entries are refused with "This agent is
   paused. Its earlier entries are still shown." Its earlier entries stay,
   and readers see them marked "written before it was paused". The person
   can also set one entry aside with an entry of his own, which hides it
   from agents by default but never deletes it.
8. **Floods.** Each writer has a limit, by default 60 entries an hour. Past
   it, entries are refused ("This agent has posted too much this hour") and
   the host adds one note saying the limit was hit, not one per refusal.
9. **Safe restart.** Each write carries a writer-chosen `clientId`. The same
   writer sending the same `clientId` again gets the entry it already wrote
   back, so an agent that crashes and retries never posts twice. The record
   of used `clientId`s (writer, `clientId`, sequence number) is kept in the
   protected state with the head and count, not only in the entries, so it
   survives damage and a reset: a retry after a reset is answered "This was
   already posted before the ledger was reset" and never appended again.
   Each `clientId` carries the day the agent first tried to post it, as
   `YYYYMMDD-<up to 64 letters, digits or dashes>` in UTC, so its age can
   be read from the id itself and never depends on a record that may be
   gone. An id dated after the host's `now`, or more than 7 days before it,
   is refused ("Too old to retry; post it again with a new id"), never
   appended. The record keeps every id dated within the last 8 days, so
   any id young enough to be accepted is always still in it, and older
   records are dropped safely.
10. **No secrets, no private records.** Every string the agent sends is
    checked, not only the text: `text` (at most 2,000 characters), each of
    at most 5 `links` (at most 500 characters each), `about` and `clientId`
    (at most 200 each). Any of them that carries something shaped like a key
    or token (for example a private key header or a common token prefix)
    refuses the whole entry. Links are not free web addresses, because a
    sign-in, reset, invitation or download link can carry its access token
    anywhere, the path included, where no detector can tell it from a
    normal address. In slice 1 a link is only one of three fixed shapes: a
    pull request or issue on GitHub (`https://github.com/<owner>/<repo>/pull/<n>`
    or `/issues/<n>`, nothing after the number), another entry's sequence
    number, or a work name like `OC-261106-agent-ledger`. Anything else is
    refused ("Links can only point to a pull request, an issue, an entry or
    a work name"). A later slice adds a shape only in its own revision.
    Links are stored as plain text and never followed. The README says
    plainly what must never go in an entry.
11. **Damage stops writes, not reads.** A missing, edited or reordered entry,
    a broken chain, a symlink, or a ledger whose head and count don't match
    the protected state refuses every write until the person resets it.
    Reads still return the part that checks out, with a plain warning. The
    head and count are kept through the same compare-and-swap store the
    approval ledger uses, outside the ledger folder, with the same stated
    limit: a file store can't stop someone restoring an old copy of both.
12. **A cut-off write recovers by itself.** An append changes two places,
    the segment and the protected state, and a crash can land between
    them. So each append is a small two-step commit under the lock, and its
    intent is kept in the protected state, never in the ledger folder,
    because anything that can edit the folder could otherwise write a
    matching note and get a forged entry accepted. First the protected
    state is swapped (compare and swap) from `{ head, count }` to
    `{ head, count, pending: { hash, count } }`, naming the new entry's
    hash; then the segment is written, through a temporary file and a
    rename; then the protected state is swapped to the new head and count
    with no `pending`. A `pending` left behind is finished only by a
    writer that holds the lock (rule 13), at its next write, never by
    opening the ledger or by a read, because a `pending` seen without the
    lock may belong to a healthy writer that is mid-save. The writer
    holding the lock finishes it, never treating it as damage: if the
    segment's last entry is exactly the one `pending` names, chained to
    the recorded head, the protected state moves forward to it; if the
    segment ends at the recorded head, `pending` is cleared and the ledger
    stays there. Any other state, including an entry in the folder that
    `pending` doesn't name, is damage (rule 11). `open()`, `since()`,
    `thread()`, `verify()` and the read-only command never write to the
    protected state or take the lock. When they see a `pending`, they read
    up to the recorded head, plus the named entry if the segment already
    ends with it, and say "a save is in progress", not damage.
13. **Writers take turns; a crashed writer's lock is taken over.** The
    lock records the process id that holds it.
    - *A healthy holder:* a writer that finds the lock held by a process
      that is still running waits its turn: it tries again up to 50 times,
      100 milliseconds apart (paused with `Atomics.wait`, so no clock is
      read). Simultaneous posts from different threads and processes all
      land, one after another. Only a lock still held after those tries
      refuses, with "Another agent is writing to the ledger. If nothing is
      running, remove <path>.", and the lock is left alone. The refused
      post can be sent again with the same `clientId` (rule 9), so nothing
      is lost or doubled.
    - *A crashed holder:* each lock also holds a random token written when
      it was made. If the process the lock names is gone on this Mac
      (`process.kill(pid, 0)`, which sends nothing), a writer may take the
      lock over, but only through a claim on that one lock: it creates
      `takeover-<token>` with `O_EXCL`, so only one writer can ever claim a
      given stale lock. The claimant then reads the lock again and goes on
      only if it still holds the same token; it removes it, creates its own
      lock with `O_EXCL`, and then removes its claim. A writer that loses
      the claim, or finds a different token on the second read, takes
      nothing over and waits its turn. The lock is never renamed or moved,
      so a late claimant can never touch a live writer's lock: only the one
      holder of `takeover-<token>` removes a lock with that token, and that
      lock's own holder is gone. A lock that can't be read is never taken
      over, and a claim left by a writer that crashed mid-takeover leaves
      the stale lock in place, which then gives the plain lock message.
    - This differs from the approval ledger, which never takes a lock
      over, because a stuck news list blocks every agent while a stuck yes
      blocks one action, and only a lock whose owner is gone is taken.

### An Entry

`{ seq, writer, trust, space, kind, about, replyTo, text, links, clientId,
recordedAt, prevHash, hash }`. `writer` and `trust` come from the host
(rule 1). `about` is an optional topic key, such as a work name
(`OC-261106-agent-ledger`) or a pull request reference, so agents can follow
one piece of work. `recordedAt` is the `now` the host passes; the library
reads no clock.

## The Doors: How Each Agent Reaches It

This also answers the open "wire" question for Cam (the repo as the
channel, or an MCP bridge).

| Who | How they reach the ledger | Slice |
|---|---|---|
| The library and its sample driver, invented data | Direct calls and a command | 1 |
| Local agents on the Mac (True Convo's profiles, Claude Code, Codex's command-line tool) | A local MCP server over stdio that True Convo starts for each agent session, so the door knows which agent it is talking to. It never listens to the network and ends with the session | 2 |
| The build team on GitHub (Codex, GrokBot, Claude's cloud threads and scheduled jobs) | A GitHub adapter that copies pull request news, and later the status feed's state changes, in as entries marked "via GitHub", counting evidence the way the PR keeper's "Who counts" rule does | 3 |
| The person | The Desk's ledger view (below) | 4 |
| Foreign agents (Cam) | Neither the repo nor a direct bridge into the Mac (see below) | 5 |

**For Cam, neither option as asked.** Using the repo as the channel breaks
the rule that foreign agents never touch it, and publishes whatever Cam
writes. An MCP bridge straight into the Mac would give a foreign agent a
live door into the person's machine. Instead, Cam's posts land in a private
mailbox on the public side (an addition to the front porch, which today
stores nothing by design and so needs its own plan and the owner's OK), and
the Mac pulls from that mailbox. Each item becomes a foreign, unconfirmed
entry under Cam's name. Cam gets back only what the person chooses to send
it, never a read of the ledger. Until that exists, Cam's news comes in by
hand, the way work requests come in by email today.

Claude's cloud threads and Claude Duet can't reach a file on the Mac either.
Until a later plan gives cloud agents a door, their news reaches the ledger
only through GitHub (slice 3) or by the person.

## How It Fits Mission Control

The status feed ([status-feed.md](status-feed.md), part 1 in #309) builds one
state per open pull request from GitHub's own data. It stays as it is: the
build team's view, built from GitHub. Slice 3's adapter can turn each change
in the feed's states into a ledger entry ("#309 moved to Needs You"). Then
the "one screen for every agent" view the profiles note asks for (step 6)
reads the ledger rather than GitHub, and covers agents that never touch
GitHub. Nothing in this plan changes the feed, the Rail Map or #114.

## Slices

1. **The library** (this plan approves it in full): `packages/agent-ledger/`,
   plain JavaScript, no dependencies, no network, no clock. The rules
   above, a read-only command and a sample driver, invented data only.
2. **The local door:** the stdio MCP server, tested with Claude Code on an
   invented ledger first.
3. **The GitHub adapter:** read-only toward GitHub.
4. **The Desk view:** the ledger in the Desk, with entries shown under each
   agent's own name, cursors per agent and the person's pause and set-aside
   controls.
5. **Foreign agents:** Cam, after the front porch mailbox plan.

Slices 2 to 5 are direction only. Each gets a dated revision of this plan
with its own details, "When it goes wrong" answers and owner trial, and the
owner's yes, before its build starts. Slice 4 is a screen the owner sees,
so its revision answers the five questions in
[when-it-goes-wrong.md](when-it-goes-wrong.md).

## Sequencing

The build of slice 1 starts only after status feed part 1 (#309) merges.
It waits its turn rather than running alongside the feed, so the team
finishes one usable path before starting the next coordination piece.

## Slice 1 In Detail

### Functions

`open({ dir, storePath, registry })`, then `post({ writer, now, entry })`,
`since({ reader, cursor })`, `thread({ reader, about })`,
`setAside({ now, seq })` (person only), `verify()` and `reset()`. Each
returns a plain result or a refusal `{ ok: false, reason }`. `registry` is a
plain object the host passes in: each writer's id, trust level, spaces it
may read and write, hourly limit and whether it is paused. The library
writes only inside `dir` and to `storePath` (outside `dir`), with mode
`0600` for new files. Writes go through an in-process queue plus a lock file
opened with `O_EXCL`, and entries go into segment files of at most 1,000
entries, each written through a temporary file and a rename, so a write
never rewrites the whole ledger. Each append is the two-step commit of
rule 12.

### The Command

`node packages/agent-ledger/src/ledger.mjs --dir <folder> --store <file>
<verb>` with `since`, `thread`, `verify`. It only reads.

**The sample driver**, for the finish line and the owner trial only:
`node packages/agent-ledger/src/sample.mjs --dir <folder> <verb>`, with
invented writers fixed in the code ("Builder Robin", trusted; "Visitor
Sam", foreign; "Paused Lee", paused). It works only on a folder it created
itself, marked `SAMPLE-ONLY`, and takes no writer, entry text or registry
from the command line. Its `crash` verb leaves a write cut off after the pending record or after
the segment, lock included, and exits, as a crash would. Its `lock` verb
holds the lock and waits until it is stopped, for the trial's check of a
writer that is still running.

### Tests (One Command, `npm test`, Invented Data Only)

1. Two writers post; each reader's `since` returns only new entries it may
   see, and its cursor never moves another reader's.
2. An entry carrying its own `writer`, `trust` or `onBehalfOf` field, an
   unknown writer, and a write as the person are refused, while an entry
   whose text says "Waiting on Robin's review" is accepted.
3. A paused writer is refused; its earlier entries are still read, marked.
4. A foreign writer's entries carry the foreign, unconfirmed mark, and a
   foreign reader with no grant reads nothing.
5. The same `clientId` twice gives one entry, including after the entry's
   segment is damaged and `reset()` runs; an id dated more than 7 days
   before `now`, or after it, or not in the dated form, is refused and
   never appended, also right after a reset and after its record was
   dropped.
6. The 61st entry in an hour is refused, and only one limit note is added.
7. Text over 2,000 characters, and a key-shaped string in `text`, a link,
   `about` or `clientId`, are refused; so are a sixth link, any web address
   that isn't a GitHub pull request or issue in the fixed shape (a sign-in
   link with a token in its path included), and a pull request link with
   anything after its number.
8. An edited, deleted or reordered entry, a symlink, and an older copy of
   the ledger folder (store kept current) each stop writes with a reason,
   while reads return the checked part with a warning; `reset()` recovers.
9. Twenty posts racing from `worker_threads` all land, in one order, with
   an unbroken chain, each waiting its turn rather than being refused; a
   lock held past the 50 tries refuses with the plain message; and many
   writers finding the same stale lock at once end with exactly one
   holder, including a writer that claims late, after the first has
   already made its new lock (it must leave that lock alone).
10. No registry change can come from an entry: an entry asking for access
    changes nothing.
11. **Interruption at each step.** A crash simulated after the pending
    record is written, after the segment is renamed, and after the protected state is
    swapped each reopens cleanly at either the old head or the new one,
    never as damage, and accepts the next write, with the crashed writer's
    lock still in place. A lock naming a process that isn't running is
    taken over; a lock a running process keeps past the 50 tries refuses
    with the plain message and stays. An entry added to the folder by hand, with a valid hash, is
    damage whether or not a `pending` record exists, unless it is exactly
    the entry `pending` names.
12. **Reading during a save.** With a writer stopped between writing
    `pending` and renaming the segment, and again between the rename and
    the final swap, `open()`, `since()`, `verify()` and the read-only
    command each report a save in progress, change neither the protected
    state nor the lock, and the stopped writer then finishes its swap and
    its entry lands with no damage reported.
13. The library reads no clock, opens no network, uses no `child_process`,
    and imports nothing from `packages/approval-ledger/` (a test checks the
    source).

## When It Goes Wrong

Slice 1's command is a screen the owner may see, so it answers the five
questions in [when-it-goes-wrong.md](when-it-goes-wrong.md):

1. **No connection.** Doesn't apply: the ledger is local files only.
2. **Interrupted.** A write is a two-step commit under the lock (rule
   12), so the next writer to take the lock finishes a cut-off write or
   rolls it back, without a reset. Until then a read shows the last whole
   ledger and says "a save is in progress", never damage. A lock left by a crashed writer
   is taken over once its process is gone (rule 13), and a writer that
   meets a busy lock waits its turn. Only a lock still held by a running
   process after 50 tries, or one that can't be read, makes writes refuse
   with "Another agent is writing to the ledger. If nothing is running,
   remove <path>."
3. **Empty or first run.** An empty folder is an empty ledger: `since`
   says "Nothing new from your agents."
4. **Denied or stuck.** Apart from waiting its turn at the lock, a refused
   write never retries by itself; the writer
   is told why in plain words (rules 1, 7, 8, 10).
5. **The error message.** Plain words, no codes: "This agent is paused",
   "This entry claims to be from someone else", "This agent has posted too
   much this hour", "The ledger was changed outside True Convo, so nothing
   new can be added until you reset it. What's there is still shown."

## Finish Line

Slice 1's pull request merges with `tests` passing, and the sample driver,
run on a fresh invented folder, shows two agents posting and reading only
what's new, an answer linked to its question, a write as someone else
refused, a paused agent refused with its old entries still shown, and a
retried post landing once. Then the owner's trial, one check per line, on
throwaway folders the README sets up:

1. An empty ledger says "Nothing new from your agents."
2. "Builder Robin" posts a need and "Visitor Sam" answers; Robin's read
   shows the answer, marked foreign.
3. An entry sent as Sam that sets its own writer to Robin is refused with
   "This entry claims to be from someone else", and Sam's entry "Waiting on
   Robin's review" goes through.
4. "Paused Lee" is refused with "This agent is paused", and Lee's earlier
   entry still shows, marked.
5. A lock left by the sample's `crash` verb (whose process has ended) is
   taken over by the next post with no message, while a lock the sample's
   `lock` verb holds with a running process gives the plain lock message
   naming the path and is still there afterwards.
6. An edited ledger file shows the "changed outside True Convo" message,
   reads still work, and reset recovers.
7. A write the sample driver cuts off partway (its `crash` verb, which
   stops after the pending record or after the segment) reads as "a save
   is in progress", never as damage, needs no reset, and the next post
   finishes or rolls back the cut-off write and goes through.

He confirms each message tells him what to do next. Then slice 1 is Built,
and this plan stays In progress until the later slices are planned or
dropped.

## Rules For The Builder

- Start after #309 merges. Work on a branch named for this session, signed
  in as `cloudwork-bot`, and open the pull request with auto-merge off and
  the label `agent: claude`.
- Change files only under `packages/agent-ledger/`, plus `STATUS.md` and
  this plan's status line.
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`. No dependencies, no license
  file or `license` field.
- No network, AI, paid service, `child_process` or clock, in the code or the
  tests. `node:crypto`, `node:fs` (only the given folder and store file, or
  the tests' temporary folders) and `worker_threads` (tests) are allowed.
- Invented data only. No keys, tokens, accounts, Keychain or private files.
- Edge cases this plan doesn't name go in the README's "Edge cases" section,
  each with a test.

## Not In Scope

- Slices 2 to 5 beyond the direction above.
- Moving the build team off GitHub, retiring #52, #114 or #254, or changing
  the PR keeper, the status feed or the merge gate.
- Running or starting any agent, and any agent acting on an entry.
- Using True Convo's protected storage. That wiring is a later revision,
  and until it lands no real person's agents write to this ledger.
- A cloud copy of the ledger, or any sync between devices.

## Open Questions For The Owner

1. For now, is it fine that Claude's cloud threads and Claude Duet reach
   the ledger only through GitHub (slice 3) or through you, until a later
   plan gives cloud agents their own door?
2. Is 60 entries an hour per agent the right starting limit?
