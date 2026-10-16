# Desk and Mac host: one subscription participant

In plain words: the Desk page asks the Mac app to run one AI participant (the
Claude Code command-line tool on the user's claude.ai plan) and stream its
reply into a saved conversation, with no API key, other provider or paid
fallback. The main risk is a bill from the plan's paid extra usage
("overflow"), so the participant stays unavailable until that is confirmed
off (section 17) and section 16's checks pass.

Revision 4 (October 15, proposed) adds local models through Ollama in
section 20; it changes nothing for the Claude Code entry or the existing
vectors.

Status: Claude's proposed wire, revision 2 (October 10). It applies Codex's
review of a4165ef: four corrections and its answers to the twelve decisions
(section 18). Revision 3 (October 10, later) rewrites section 17 for
The user's chosen owner confirmation and adds section 5's display-only
`confirmation` object and the 4,096-byte first-trial input bound, with vectors.
Within revision 3, section 15 later gained one paragraph (October 10, inactive
store slice S2) recording Codex's storage answers Q2-Q5 and the per-entry
shape checks the store enforces; no wire or vector changed. Sections 3, 6
and 19 later gained the inactive commit slice S3's clarifications (October
10, Codex Q6-Q9 and Q22, plus four S3 readings Codex confirmed in its S3
review, inbox 9b6e7a98): the
order of section 6's checks, a non-string input chunk at step 6, the
lenient reading of a legacy committed record, start ids in
`workspace.reconcile` and `workspace.commitProof`, and two commit vectors
(#106, #107); no wire changed and the existing 105 cases are
byte-identical. Section 8 later gained the inactive launch slice S5's
reading of when `reply-too-long` is decided (on arrival, which vector #48
already requires; accepted in Codex's S5 review, inbox 6ddc36e8, report
0efbc9f); no wire or vector changed.
Sections 8 and 17 later gained S5 fix R1's reading: a paid-overflow signal
after another end still ends a confirmation, and a start waits, as
`participant-busy`, for the run's updates to finish (passed: Codex's S5 fix
recheck, inbox 10e30722, report 20bc4a6, found its ordinary paths corrected
and required R1-f, a failed read is not EOF, which its re-review passed,
inbox 6c69b7ad, report 089b699); no wire or vector changed. Sections 9, 10 and 19 later gained the
inactive read-side slice S7's readings (Codex Q23 and Q24, plus readings
Codex's S7 review accepted, inbox 68524fc3, report 8032ddb; its cursor fix
R1 passed re-review, inbox f3ba99ef, report 089b699); no wire or vector
changed. Sections 7, 9, 10, 17, 18 and 19
later gained the inactive start slice S8's readings (Codex Q25 and Q27-Q30,
plus further readings); no wire or vector changed. Codex's S8 review
(October 11, inbox 59dfb711, report 6e003da) accepted those readings with
one should-fix, R1, now
applied in sections 7 and 17 (section 17's five seconds, and any
confirmation end they require, settle before a start is admitted), and
answered that a request id a proven absence released may start again at
native while the page's rule stays a new id (section 7); the R1 fix passed
Codex's re-review (inbox 3fb3ffe8, report bd22dca); no wire or vector
changed. Sections 7, 10, 17 and 19 later
gained the inactive Stop slice S9's readings. Codex's S9 review (October 11)
accepted them with qualifications, recorded in section 10, and one
should-fix, S9-R1 (a cleanup upgrade must name its exact terminal inside the
store's lock), now applied, and ruling (a) is now applied to a never-spawned
run's pending terminal too (section 10); Codex's re-review passed both
(inbox c9e0cb5c, report a59d555); no wire
or vector changed. Sections 7, 8, 9, 10, 14 and 19 later gained the inactive
lifecycle slice S10's readings (lock, unlock, window close and quit; Codex
Q21 and Q31-Q34 applied), which Codex's S10 review (inbox fcc67dfe) later
passed. Section 14's quit bound
is now Codex Q33's single 17 s overall maximum; no wire or vector changed,
and the harness runs all 107 cases. The S10 review's fixes followed: a quit
now says so when it begins (`beginShutdown(quitting:)`), its bound runs
from there whatever detach comes between, and no stack attaches during a
close or quit (section 14); section 7's paragraph on lock, close or quit
during `starting` is amended to what S10 does; Codex's S10 review passed
these too and ruled on that amendment (below). Sections 2, 3, 8, 10 and 14 later gained
the inactive app-wiring slice S11's readings (the WebKit handler's
participant routing, the Desk session's one lane per launch, the quit's one
participant bound, and S9 ruling (c)'s remaining boundary: owed participant
writes before a workspace commit or the app's dispatch recovery), and S11
amends S10 reading 1 on what a quit can observe between the lane's step and
the revocation; Codex's S11 review (October 11, inbox 237d63fc, report
a819387) passed them and accepted them, that amendment included, in its
ruling (d). No wire
or vector changed. Codex's S10 review (October 11, inbox fcc67dfe) passed
S10 and accepted three of its readings, now marked accepted where they
stand (every S10 reading is now marked passed; S11's amendment of one is
marked accepted by the S11 review): section 7's `store-locked` for a lock, close or quit seen before step
14 (ruling 1), section 14's leaving a standalone confirmation revocation out
of the quit obligations for the present in-memory owner (ruling 2), and
section 8's nonblocking sink (ruling 3). S11's follow-through (October 11,
Codex's carried requirements 1-6) makes the coordinator the one lane a Desk
stack can attach (section 2), adds native stale-reply and stale-push
suppression in the WebKit transport (section 3), checks the unlock's epoch
from the owner check through the host's and the lane's unlock, which
replaces S11 reading 4 and withdraws its amendment of S10 reading 1
(section 14), checks a push under way during lock and close with the real
coordinator (section 8), and records an end-to-end proof with the real page
(section 14, S11 reading 9). The
follow-through's own review then tightened section 3's stale-reply rule: an
answer to a request admitted before a lock, window close or quit began is
dropped even while the host's own step is still to run, through a new
`ParticipantLane.lifecycleEpoch` and the host's locked and closed flags;
it corrected section 3's claim that WebKit drops a reply to a gone
document, recording the shipping (no lane) path as an open item;
and it records that ruling 1's renderer check is still open (section 7).
Section 14's S11 reading 10 records their checks. No wire or vector changed.
Codex's S11 review (October 11, inbox 237d63fc, report a819387) passed S11,
its follow-through and that review's changes as an inactive source slice,
with no blocking or should-fix finding. Its ruling (d) accepted S11
readings 1-10, section 3's participant transport rule and section 8's
nonblocking-sink rule, reading 6's quit gap included, with its stated
limits (recorded in sections 3, 8 and 14); its ruling (b) kept the
host-owned push and revocation order (section 3). It kept two items open:
ruling (a), native reply-time stale suppression on the path with no lane,
and ruling (c), S10 ruling 1's combined renderer proof, required before
participant activation. Section 18 lists them by name, with the activation
work still ahead and the earlier items still open (F9 consumption of the
accepted nine `requires` `pageCases`, and the shared opaque-handle
rule). The page-conformance follow-up (October 11) corrects only page vectors
5 and 6's cleanup expectation and vector 11's missing complete replay, and
adds execution of all 15 page cases with the production controller (section
19). Claude's review of 37d1a0f accepted those fixture corrections and requested
runner fixes. His exact re-review of dfbf67e passed (October 12,
inbox 2d7d91e2 (True Convo review record, not moved));
this revision applies its four wording follow-ups without changing test logic.
Consumption of the accepted vectors/tests by F9 remains open.

This copy lives on the activation base (October 11): main 38ef649 with the
True Convo Test identity (ae01e6e; Codex PASS a7a8d268, report 032833d)
and the inactive engine S1-S11 (ae1caaa) folded in: S1-S10 passed in their
own Codex reviews, and S11 at ae1caaa passed Codex's S11 review (inbox
237d63fc, report a819387). Codex passed the exact F0 fold at 50afbea (report
863375a, inbox 56085bb1); it is on main. This copy also preserves reviewed F2
and F1 main at fd8a38e
(Codex's F1 PASS, report 3f885db (True Convo review record, not moved));
their packaging, fixed environment and predicted CLI fixture changes do not
activate the app.
It is still inactive: the app lists the seven operations, its Desk session
has no lane, and nothing in Sources constructs a coordinator.
Nothing is run, installed or live. Invented
vectors: [native-participant-v1.json](../apps/desk/tests/fixtures/native-participant-v1.json).

## 1. Scope

This extends [desk-native-join-contract.md](desk-native-join-contract.md):
its envelope, reply echo, outcomes `ok | refused | conflict | unknown`,
base-only `unknown`, id rules, UTF-8 byte counting and limits apply, except:

- The capabilities list is amended (section 2).
- For `participant.*`, `unknown` holds no workspace barrier on either side;
  it means only that this request's effect on the run is undetermined, and
  the page resolves it with `participant.status`, never `workspace.reconcile`.
- After native reports `not-dispatched`, a user-initiated start may use a new
  request id; native allows one dispatch per run whatever the id.

The page owns the conversation record. Native owns process truth: which runs
were prepared and started, the process group, events and how each run ended.
Native also owns cleanup: within a launch, a run's process group stays
native's until it is confirmed gone (or, if its supervisor is lost, until the
CLI's output pipes close), whatever the transcript says (section 10).

## 2. Version and capabilities

- `v` and `contractVersion` stay 1; capability keys and `limits` are
  unchanged.
- A participant host lists exactly, in order: `host.capabilities,
  workspace.read, workspace.commitProof, dictation.bindDraft,
  dictation.unbindDraft, workspace.reconcile, dictation.receipt,
  participant.availability, participant.start, participant.stop,
  participant.status, participant.events`.
- Rollout: the pinned page codec (2e1f37d and `main`, unchanged since
  ef76b87) rejects capabilities listing any unknown name, so the page would
  not load. Page and host ship as one build. Native lists the five names, and
  accepts `participant.*` and `participantRun`, only with section 13's codec
  bundled; otherwise they are `unknown-operation` and `unknown-field`. The
  page enables participants only when all five are listed.
- `native-host-v1.json` is unchanged; its five-operation reply and today's
  seven-operation host both stay valid without participants.
- Eight new reasons (section 12) take the Swift enum, its count test and the
  codec from 24 to 32.

Reading (S11, passed by Codex's S11 review, inbox 237d63fc, report
a819387): the app's one Desk session is made
with no participant lane, so every stack it builds is a v1 host and lists
the seven operations. A session given a lane (tests only) has the lane build
each stack's host. Reading (S11 follow-through, passed by the same review;
Codex's carried requirement 1): the lane that can be given is
`ParticipantCoordinator`, which conforms to `ParticipantStackAttaching`; its
`makeHost` builds each stack's participant host with the coordinator's own
`ParticipantHostConfiguration`, so the same pin, input bound and
`RequestIdentityIndex` (by reference) that its `attach` checks. That is the
one place in Sources that hands a participant configuration to a host; the
tripwires admit exactly it, and nothing in the app constructs a coordinator
(`main.swift` passes the session no factory, whose default is nil), so the
app still lists seven operations.

## 3. Lane, identity and replay

- `participant.*` never touches the workspace barrier or gets
  `mutation-outstanding`; native routes it to a `ParticipantCoordinator`
  actor before `DeskHostProtocol.handle`.
- Connection and generation checks are v1's; any valid current connection may
  start, stop or read any run.
- `runId`, `userMessageId`, `assistantMessageId`: canonical lowercase UUIDv4.
  `sessionId`: the record-id rule (versions 1-5, case kept), compared exactly.
  The four are distinct ignoring case, else `invalid-identity`.
- `participant.start` joins v1's one request-identity space (commit results
  and identity records, dispatch receipts, bind/unbind results, the barrier
  holder's id). A start under any of those ids, or a commit, bind or unbind
  under a recorded or `starting` start's id, is `payload-mismatch`.
  `workspace.reconcile` for a start's id answers `unknown`, never
  `not-dispatched`: a recorded start, one reserved because its write is not
  yet confirmed (section 15), and one still `starting`. Any host answers so;
  a store without runs reserves nothing, so a host without participants
  answers as before.
- Availability, status, events and stop keep no identity and answer from
  current state (Stop is idempotent by run state). Refusals leave no
  identity.

Reading (S11; section 3's participant transport rule, accepted by Codex's
S11 review, inbox 237d63fc, report a819387, ruling (d)): in the app the
router is the WebKit message handler. Given a lane, which it accepts only beside a participant
host, it hands a decoded `participant.*` request to the lane before
`DeskHostProtocol.handle`, under the same shutdown guard and observer; the
lane runs v1's preflight itself against its attached stack's registry. A
`workspace.commitProof` that passes v1's preflight first waits for the
lane's one bounded pass of the participant writes it owes (section 10,
ruling (c)); no other request waits, and `HostRouter` (not built in
Sources) does the same. Each reply goes back only to the promise that
asked, and once the handler shuts down it is a transport failure.
(Corrected by the S11 follow-through's review: this reading also said
WebKit drops a reply if that document is gone. It does not reliably; see
the next reading's observation and the open item on the path with no
lane.)

Reading (S11 follow-through, passed by the same S11 review, within the
limits of its rulings (b) and (d) after this list; Codex's carried
requirement 3 and Q21's "never into an old or different generation"): with
a lane, native itself drops what has gone stale, whatever the page would do.
- Replies. A request admitted while the connection it names is valid gets
  its answer only if, when the answer is ready (checked on the main thread
  in the same turn as the reply), all of these still hold: that connection
  is valid (current generation, not revoked); the lane's `lifecycleEpoch`,
  read at admission, has not moved; and the host is neither locked nor
  closed. `lifecycleEpoch` is a lane requirement added by the
  follow-through's review: it moves inside every `lockNow()` and every
  `beginShutdown(quitting:)`, before either returns, so it moves at the
  moment a lock, window close or quit begins, even while the host's own
  step is still to run (the Desk session leaves that step to a task, and
  the quit's reply starts the lane's step before the window closes). A
  reload, navigation or content-process crash revokes the asking document's
  connection before any new document can begin; a lock, window close or
  quit moves the lane's epoch and marks the host before it revokes anything
  (a host step run on its own does both in one main-thread turn; the
  session moves the epoch first and marks the host in its later step). So an
  answer computed across any of them is dropped: the promise gets only the
  content-free `host-transport-failure`, never the answer. That covers an
  availability call already waiting during a close and its detach (no other
  document can receive it or take it for a fresh availability), and a
  participant answer computed before `lockNow()` or `beginShutdown` that
  still holds run text: it never reaches the page, not even the same page
  before `locked` or `revoked`. Before that review the check was the
  connection alone, and such an answer could reach the same, already
  hidden, page before `locked`. An answer to a request admitted after the
  lane's step but before the host's is the lane's own (text-free, section
  9) or v1's, and may reach that same page before `locked` or `revoked`,
  never after: the host is marked locked or closed before its step pushes
  either. Observed once in a headless `WKWebView` (October 11), not pinned
  by a test: after a reload WebKit may still run the old document's own
  promise callback, and that callback's `window` is then the new
  document's (the WindowProxy). So whatever native hands WebKit for a gone
  document must carry nothing: only the fixed failure, or v1's preflight
  refusal for a request that named a connection already gone (it gets no
  later check, and comes after the lane's or the host's hop), which echoes
  only that old request's own identifiers and a reason. The coordinator
  keeps no availability answer, so nothing there can be reused either.
- Open item (the path with no lane, which is the app as
  shipped; unchanged here): every reply goes back to the promise that asked
  with no native check, and by the observation above WebKit does not
  reliably drop it once the document is gone. A v1 answer computed across a
  reload, a `workspace.read` with workspace content included, can therefore
  reach the old document's callback running against the new document's
  `window`. The current page's transport discards answers after it is
  disposed, the old realm's state is not the new page's, and it is the same
  origin and the same person, so the risk is low. Codex's S11 review ruled
  (ruling (a)) that this path gets native reply-time stale suppression, as
  a scoped follow-up; WebKit's disposal is not its safety argument. It is
  still open (section 18).
- Pushes. A `participant.event` is delivered only if, on the main thread at
  delivery, its connection and generation are the live document's own valid
  connection (the host's current connection, the one its committed document
  holds) and the host is neither locked nor closed; otherwise it is dropped,
  never handed to whatever document the view then shows. The coordinator
  keeps the event; a new document pages it by sequence (section 9).
  Lifecycle and dictation events are delivered as before, for a different
  reason: the host's protocol actor pushes them in step with its own
  generation changes (`revoked` and `locked` to the connection it is
  revoking, `ready` to the one it just issued, a dictation final to its
  bound draft's connection once checked valid), so the main queue runs each
  ahead of the document step that follows it.

Codex's S11 review (inbox 237d63fc, report a819387) set these limits.
Ruling (b): keep the host-owned push and revocation order and the delivery
checks above. The host's locked and closed flags cover its lock and close
steps, and a replacement document is issued only after its generation
change completes. This is no promise about an arbitrary sink. Ruling (d):
the push boundary is the weaker one stated in section 8. A participant push
already queued before the lane's step can reach the same old page before
the host is marked locked or closed, never after that flag and never into a
replacement generation. None of this erases synchronously what was already
handed to WebKit.

## 4. Operations

| Operation | Exact request payload | Fields added to an `ok` reply |
| --- | --- | --- |
| `participant.availability` | `{}` | `participants` |
| `participant.start` | `{workspaceHandle, runId, sessionId, userMessageId, assistantMessageId, participant, inputChunks}` | `runId` |
| `participant.stop` | `{workspaceHandle, runId, sessionId}` | `runId, state, terminal, groupCleared, providerCancelConfirmed` |
| `participant.status` | `{workspaceHandle, runId, sessionId}` | `runId, state, lastSequence, terminal, groupCleared, unknownReason` |
| `participant.events` | `{workspaceHandle, runId, sessionId, afterSequence, maxEvents}` | `runId, events, more, lastSequence, lost, terminal` |
| `workspace.commitProof` | v1 payload plus optional `participantRun` | v1 (`revision`) |

Listed `ok` fields are always present, `null` where stated. `participant` is
`{id, label, model, executionHost}`; `terminal` and `events` elements are
events (section 8). Checks run as in v1: envelope, shape and identities,
handle, then the operation's steps. A missing or ill-formed
`workspaceHandle`, `runId`, `sessionId`, `userMessageId` or
`assistantMessageId` (also inside `participantRun`) is `invalid-identity`;
other missing keys or wrong types `malformed-envelope`; extra keys
`unknown-field`; a wrong handle `unknown-handle`; a `sessionId` other than the
native run's `run-mismatch`; a run native never prepared `unknown-run`.

## 5. Availability

The reply holds one entry, `{id, label, model, executionHost, available,
reason}`: native's current pin, fixed per app build and pinned CLI version
(`id` is `claude-code`), each string nonblank and at most 256 UTF-8 bytes,
returned even when unavailable. An app update may change the pin; runs keep
the identity they were prepared with (section 15). Stop, status and events
never depend on availability or the current pin. `reason` is `null` exactly
when available, else the first failing check:

| Reason | Meaning |
| --- | --- |
| `cli-missing` | Pinned binary absent. |
| `cli-version-mismatch` | `--version` is not the pinned version. |
| `provider-override` | Settings, environment or `auth status` show an API key, key helper, other base URL or provider. |
| `signed-out` | No CLI login. |
| `not-subscription` | Not a claude.ai plan login. |
| `overflow-unverified` | Paid overflow cannot be confirmed off. |
| `check-failed` | A check timed out or was unreadable. |

A host with section 17's confirmation built adds an optional, display-only
`confirmation` to the entry, exactly one of:

- `{state: "unconfirmed"}`: no confirmation in this launch;
- `{state: "active", confirmedAt, runsLeft}`: `confirmedAt` as
  `YYYY-MM-DDTHH:MM:SS.mmmZ`, `runsLeft` an integer 1-5;
- `{state: "ended", endedBy}`: `endedBy` one of `lock` (screen lock or
  session resign), `sleep` (sleep or screens sleeping), `logout` (logout or
  power-off), `cli-changed` (pinned CLI version or file identity),
  `login-changed` (login or account), `run-limit` (the fifth run started) or
  `paid-overflow`.

Quit needs no state: the next launch starts `unconfirmed`. Native sources it;
it is never an input, never part of `id`, `label`, `model`, `executionHost`,
the saved choice or any identity, and never carries an account identifier.
`available` is `true` only when every check passes and the state is
`active`; otherwise the first failing check gives `reason`, which is
`overflow-unverified` for a missing, ended or used-up confirmation (no new
reason). An earlier failing check, such as `provider-override`, wins; the
confirmation is still reported as it is. A host without section 17 built
omits the key.

Checks are local: the pinned file, `claude --version` and the settings
sources below; the design adds `claude auth status` (account fields dropped
in memory), which production does not run until the D1 decision (step 4,
below). No model
request, billing read or provider probe; no configured key, refresh, proxy,
headers or policy helper is ever run; the app never reads the CLI's own
Keychain item. That guarantee holds as built only because production never
runs `claude auth status` until the D1 decision (Codex F34-D1, below): for an
account the CLI treats as eligible for server-managed settings, that command
can fetch new settings and run a policy helper they name before any
inspection can see it. Nothing in 2.1.283 skips that fetch for an eligible
account, and no check beforehand can tell whether the account is eligible.
By the same byte reading, a proxy address given to that probe alone and
held closed by the app would make the fetch fail; that is one of the D1
options, not built. Each subprocess runs under section 11's environment rule (the
same allow-list and fixed values, Codex F0 answer 10), not the app's whole
environment. Limits: 5 s per subprocess, 12 s total (file reads included),
else `check-failed`.
Results may be reused for 30 s; every start rechecks. A shipping host
answers `overflow-unverified` until section 17's confirmation is built and
reviewed (F4 built it inactive, below; the release app keeps
`ShippingAvailability`).

**The local checks as built (plan F3, October 11; fixes for Codex's F3/F4
review R1-R3 and D1, and for the re-review of those fixes, October 12,
awaiting Codex's re-review; Codex F0 answers 9, 10 and 11).**
`ClaudeLocalChecks` (`ParticipantProcess`) is inactive: only the test-only
availability probe constructs it, and nothing calls its production roots
(`ClaudeCheckRoots.forCurrentUser`) in Sources (one unit test calls it to
compare it with the user database, reading no file), so the app reads no
Claude file and runs
nothing; the release app does not link the module. It never answers
`available`: when every check passes it answers `overflow-unverified`, which
only section 17's owner (F4) can lift. It returns the first failing reason
in the table's order, or an in-memory snapshot: `cliVersion`, the pinned
file's identity, the login kind (the claude.ai plan) and an opaque account
comparator (an HMAC of the account and organization under a random key made
with the checks object, so it matches only within that object, in one
launch). Every path root is injected, the git walk's top included; the tests
use invented trees only and assert that nothing outside them is touched
(paths as requested), the two that run the test-only probe through the
probe's own count of paths outside its folder (Codex F4-1, F34-2). In order:

1. The pinned file (answer 9): exactly
   `<home>/.local/share/claude/versions/2.1.283`, `<home>` the user
   database's (`getpwuid_r`), never `$HOME`, the environment or the
   `~/.local/bin/claude` link. Each folder from the home down is opened
   without following a link and must be this user's and not writable by
   group or others (the existing safe-path rules); the file is stat'ed,
   never followed, and must be a regular file of this user's, executable by
   its owner, with no group or other write and no setuid or setgid bit.
   Absent (the file or any folder on the way): `cli-missing`. Anything else
   (a link, another owner's, writable by others, not executable,
   unreadable): `check-failed`. Its device, inode, size, mtime and ctime are
   kept in memory, compared again after each probe (a change during a check
   is `check-failed`) and before any reuse (a change means a new check);
   section 17's owner compares the snapshot's identity at confirmation and
   at every check and start. This is metadata, not an immutable-execution
   guarantee: the probe runs the path. The write rules read mode bits only:
   an ACL that lets another user write a folder on the way or the file is
   not checked (answer 18's ACL refusal covers the app's own folders, not
   this path).
2. `--version` must print exactly `2.1.283 (Claude Code)`, one line, exit 0:
   another version is `cli-version-mismatch`; any other shape, exit or
   ending is `check-failed`. The CLI answers it before reading any setting,
   so it can start no helper.
3. Provider overrides (answer 11), checked before `auth status` would run
   and, on the path that runs it (the tests and the test-only probe only,
   step 4), again after it, however it ended (`auth status` may refresh a
   cached source; an override found then wins over its answer, an
   unresolved source over a pass, Codex F3-6). In production step 4 refuses
   first, so there is no second inspection there. First the probe environment: its `HOME`
   and `USER`, when passed, must be the user database's home and name,
   else whose files the CLI reads is unresolved: `check-failed`. Then every
   settings source below, whatever the managed precedence (a shadowed
   source counts too). An override in any is `provider-override`; otherwise
   an unreadable, oversized (1 MiB per settings file, 32 MiB for
   `~/.claude.json`), unparseable, non-regular or unresolved one is
   `check-failed`. Sources read, and why:
   - Managed, which still apply under `--restricted` and `--safe-mode` (the
     F1 reading, Q4): `/Library/Application Support/ClaudeCode/managed-settings.json`;
     every `.json` file that is not a dot-file in `managed-settings.d/`
     there (through links, as the CLI reads them);
     `/Library/Managed Preferences/<user>/com.anthropic.claudecode.plist`
     and `/Library/Managed Preferences/com.anthropic.claudecode.plist`
     (parsed directly, never through `plutil`); server-managed
     `~/.claude/remote-settings.json`; and, conservatively,
     `~/.claude/policy-limits.json`. Searched at every depth, since a cached
     file's wrapper is not known. The SDK parent tier exists only if passed
     (`--managed-settings` or SDK options); nothing passes it, so there is
     nothing to read. A policy helper is never run (below).
   - `~/.claude.json`: its `env` and `primaryApiKey` apply apart from the
     settings files, under `--restricted` too; top level only (nested
     records, such as an MCP server's own `env`, are not the CLI's). Also,
     conservatively and unconfirmed by the reading, `~/.claude/.config.json`
     (an older name for it) if present.
   - `~/.claude/settings.json`, top level only: the run ignores it under
     `--restricted`, but `auth status` runs without that flag, so its
     helpers and its `env` apply to that probe.
   - Project and local settings, for `auth status` (the F3 review's byte
     reading of 2.1.283, never run; Codex F3-5): project settings come from
     its working folder, which is new and empty, so there are none; local
     settings come from `<root>/.claude/settings.local.json`, `<root>` the
     canonical git root of that folder when it is not the folder itself or
     the user's home and it, its `.git` and its `.claude` are the user's,
     otherwise from the working folder. The checks do not resolve that
     root: from the probe parent up to `/` (an injected top; tests give
     their temporary folder), the first folder holding a `.git` entry
     decides, by `lstat` only: the home is clear (the CLI never takes it as
     that root), any other is `check-failed` (`local-settings`,
     `git-root`). F7 must put the probe parent where no such root is above
     it (`~/Library/Application Support/...` normally is). No other user,
     project or local settings file is read.
   - The app's environment reaches the CLI only through section 11's
     allow-list, so an API key or provider switch in it is dropped, not an
     override; what does reach it is the `HOME` and `USER` check above.

   An override: any of `apiKeyHelper`, `awsCredentialExport`,
   `awsAuthRefresh`, `gcpAuthRefresh`, `proxyAuthHelper`,
   `otelHeadersHelper`, `policyHelper` or `policyHelpers` set (a configured
   executable helper is an unsupported override, never run to see what it
   prints, and its path is never even stat'ed); `forceLoginGatewayUrl` or
   `modelOverrides` set; a `forceLoginMethod` other than `claudeai`;
   `primaryApiKey` set; or an `env` name from the reading's provider,
   base-URL, key, token and transport list, or any `ANTHROPIC_` or
   `CLAUDE_CODE_USE_` name, whatever its value, in any source.
   `check-failed` instead (answer 10: an effective policy must not silently
   undo the run's restrictions; answer 11: unresolved applicability):
   - in any source, an `env` that changes one of section 11's fixed values
     (an empty value included);
   - in a source the run also reads (managed, server-managed or
     `~/.claude.json`), an `env` with any other name, except the few that
     only turn traffic off (`DISABLE_TELEMETRY`, `DO_NOT_TRACK`,
     `DISABLE_ERROR_REPORTING`, `DISABLE_GROWTHBOOK`, `DISABLE_UPDATES`):
     section 11's environment is an allow-list, and such a source must not
     add to it (Codex F3-2). So a proxy, extra TLS trust, a client
     certificate or telemetry export there fails the checks;
   - in user settings (`auth status` only, whose environment answer 10's
     restrictions cover too, Codex F3-1), an `env` that redirects or routes:
     `CLAUDE_CONFIG_DIR`, `HOME`, `USER`, `CLAUDE_CODE_MAX_RETRIES`,
     `CLAUDE_CODE_RETRY_WATCHDOG`, a proxy (`HTTPS_PROXY`, `HTTP_PROXY`,
     `ALL_PROXY`, `NO_PROXY`, and their lowercase forms), TLS trust
     (`NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `SSL_CERT_FILE`,
     `SSL_CERT_DIR`), a client certificate (`CLAUDE_CODE_CLIENT_CERT`,
     `CLAUDE_CODE_CLIENT_KEY`, `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`),
     telemetry export (`CLAUDE_CODE_ENABLE_TELEMETRY`, any `OTEL_` name) or
     `NODE_OPTIONS`; other names there never reach the run and are ignored;
   - a managed `hooks` entry (a program the run would start, not reviewed);
     a value of an unexpected type.

   An unresolved source stops the checks before `auth status` (no auth
   command runs while a startup override cannot be ruled out), so it can
   hide a later `signed-out` or `not-subscription`.
4. **Not run in production until the D1 decision (Codex F34-D1;
   `docs/reviews/2026-10-12-claude-f34-d1-decision.md`, a True Convo review record, not moved).** A byte reading of
   2.1.283 (never run) shows that `auth status` starts a background fetch of
   server-managed settings for an eligible account (a Team, Enterprise or
   unknown claude.ai plan, a profile login, or a stored key; not a Pro or Max
   plan without one); that a non-interactive command applies a new payload
   needing consent in memory without writing `remote-settings.json`; and that
   a policy helper the payload names can then run before the command exits.
   Nothing in that build skips the fetch for an eligible account (the
   essential-traffic switch is not consulted; the settings-path and mock
   overrides are compiled out), and eligibility depends on the plan in the
   CLI's Keychain login, which the app never reads. Making the fetch fail is
   another matter: by the same reading, a proxy address set for this probe
   only (`HTTPS_PROXY` and `HTTP_PROXY`), on a loopback port the app holds
   and refuses, takes every route the fetch can travel, with no direct
   fallback, while `auth status --json` still answers from local data. It
   covers the probe, not the run, and is not built: it is option 2 of the
   decision. So production (`ClaudeLocalChecks`'s
   public initializer) stops here: after every earlier check passes, step 4
   is `check-failed` (log `source=remote-settings detail=unguarded`) and the
   command never runs; earlier failures still win. Only the test target and
   the test-only probe can run it, over invented trees and the fake CLI (a
   source scan holds that), and what follows describes that path, kept for
   whichever option is decided. The same reading says the run itself, for an
   eligible account, can fetch and run such a helper too; the decision
   covers it.

   `auth status --json` (tests and the test-only probe only): exit 0 or 1 and one JSON object whose read fields
   have their types (`configDirectory` included: the reading says it is
   always present), `loggedIn` true exactly when exit 0. Then, in order:
   `provider-override` for any `apiKeySource` (so a stored Console key,
   which reads `authMethod` `claude.ai`, is one), an `apiProvider` other than
   `firstParty`, or a method `api_key`, `api_key_helper`, `oauth_token` or
   `third_party`; `check-failed` (`config-mismatch`) for a `configDirectory`
   other than `<home>/.claude` (trailing slashes aside): it reported on a
   config folder the checks did not inspect, which catches a
   `CLAUDE_CONFIG_DIR` or `HOME` redirect the sources did not show (Codex
   F3-1); `signed-out` when logged out; `not-subscription` for a claude.ai
   login with no `subscriptionType`; an unknown method or plan (known:
   `pro`, `max`, `team`, `enterprise`), no account, or any other shape is
   `check-failed`. Only the plan and the comparator are kept; email,
   organization and the output are dropped in memory.

Each probe (answer 10) runs the pinned file directly, not through the
supervisor (it carries no conversation text), under section 11's
environment rule, in a fresh empty app-owned 0700 folder removed afterwards,
with stdin a pipe already at EOF, stdout capped at 64 KiB (more is
`check-failed`), stderr drained and dropped, in its own process group: once
the leader exits the group is killed before the leader is reaped, and at
the 5 s bound (or what is left of the 12 s) the group is killed and the
check is `check-failed`. The deadline is checked again immediately before
the spawn, after the folder and pipes are made: a probe whose preparation
blocked past it (or whose check the watchdog already gave up on) closes its
descriptors, removes its folder and spawns nothing (Codex F34-R1; a test
holds the folder's inspection past short bounds, releases it after the
timeout and sees no execution; another gives the probe pipes whose other
halves it keeps and sees, from those, all six descriptors closed). That last
look and the spawn are not one step: holding them together would make the
watchdog wait through `posix_spawn`, which can itself block. So a check given
up on in the instant between them still starts its probe; the collector
looks again at its first turn and kills the probe and its group at once (a
test gives up on the check right after that look and sees the probe end at
once, not at its deadline; it fails against a collector that looks at the
deadline only). Each read turn is bounded (at most four
16 KiB reads per pipe, the deadline checked before each), so writers that
keep stderr full cannot hold the loop away from the deadline and the
leader's exit (Codex F34-R2; one test floods stderr from the probe's group
and sees, from outside, the whole group dead at the probe's own bound, but
passes against the earlier unbounded loop too; a second, deterministic one
gives the loop a stderr that never runs dry, and fails against that loop).
The 12 s bound covers the file work too (Codex
F3-3): each check runs on a thread of its own, and one still blocked at the
bound (a read on a stalled network or FUSE volume, a slow reap) is
abandoned and answers `check-failed` (`total-timeout`, with the step and
source it was at); it cannot be stopped, so until its thread returns every
check, a start's included, answers `check-failed` (`stalled`) at once and
nothing new starts. Its late result is dropped and no earlier result is
reused after it. `auth status` may still contact Anthropic (section 16.6).
Results are reused for 30 s by an availability read while the pinned
file's identity is unchanged (that look at the file has the same bound); a
start's step 13 (`recheck`, which section 7's coordinator now calls) and
section 17's owner (`evaluateFresh`) never reuse. One piece of work runs at
a time, and the look at the pin before a reuse is such a piece (Codex
F34-R3): callers that may reuse share the check or look under way; a fresh
check first waits for whatever is under way and then starts its own, after
its caller's request (a test holds the look and sees one worker enter while
concurrent cached and fresh calls wait). A look that finds the pin changed
drops the cached result. So step 13 can take up to about 24 s in the worst
case, longer than the page's 20 s start timeout,
whose unknown result and exact replay already cover it (real checks take
about a second). The log holds fixed codes only (fresh or reused, the
reason, the step, a source kind, a detail), never a path, value, account
field or output. Remaining limits, for review and for the user's decision:
the shapes are F1's predictions, unconfirmed by a run, so the first real
check may answer `check-failed`; the run itself, for an account the CLI
treats as eligible, may still fetch server-managed settings at its own start,
after the check, and run a policy helper they name (the D1 reading); and
`auth status`, were it run, could do the same inside the probe, applying a
new payload that needs consent in memory only, so the second inspection
could not even see it (Codex F34-9 and F34-D1: why production does not run
it, and the options, are in the D1 decision); were `auth status` or the run
started, the CLI would also run, at its start, a policy helper named in a
local managed source that another program (the user's own Claude Code
session writing newly fetched server-managed settings, say) changed after
the inspection: the second inspection detects that, it does not prevent it,
and the same gap lies between a start's recheck and the run (the D1
decision, shared by every option); `auth status` makes the CLI read
its own login credential (the OAuth token, or a stored Console key through
`/usr/bin/security`) from the login Keychain, and converts the MDM files
with `/usr/bin/plutil` when they exist (the F1 reading, Q3 and Q4; Codex
F3-10); a proxy, extra TLS trust or telemetry export in managed settings or
`~/.claude.json` fails the checks, so a network that requires a proxy set
there makes the participant unavailable (a product choice, Codex F3-2); and
reading `~/.claude.json`, `~/.claude/` and the managed folders is
privacy-sensitive real access that the user's concrete decision must name.
The comment in `ParticipantSupervisorCore`'s `EnvironmentRule.swift` still
says these checks are unbuilt: it is left unchanged so the shared core
module, and F2's packaged evidence, stay byte-identical.

**The report with section 17's owner, as built (plan F4, October 11;
inactive; the R4 fix of October 12 awaiting Codex's re-review of the combined
F3+F4 candidate).** Over the public `ClaudeLocalChecks` it can never answer
`available` until the D1 decision, since those checks stop at step 4.
`PaidUsageConfirmationOwner` (`ParticipantProcess`) is the reporter a host
with section 17 built uses; nothing in the app constructs it, and the release
app keeps `ShippingAvailability` and links neither module. `report()` asks the
local checks (which may reuse a result, above), `recheck()` (a start's step
13) and the native "Check Claude" ask fresh ones (`recheck` has no default
in `AvailabilityChecking` or `AvailabilityReporting`, so no wrapper can
answer a start with a reused check, Codex F3-9). It is the one place besides
`ParticipantAvailability`'s own definition that can answer `available`, and
does so only when the local checks pass, this launch's confirmation is
`active` and the check's snapshot matches the one confirmed. Any check, a
start's included, that shows a change ends an active confirmation first:
a passing snapshot with another file identity or version, `cli-missing` or
`cli-version-mismatch` gives `cli-changed`; another plan or account,
`signed-out` or `not-subscription` gives `login-changed`. `provider-override`
and `check-failed` end nothing (they show no change of what was confirmed):
they win as the reason while they last, and any later pass must still match
the confirmed snapshot exactly (its identity includes the ctime, so a
replaced or modified file never matches). The display is always present and
carries no account field; an earlier failing check wins, the confirmation
reported as it is.

Availability comes from an injected Swift protocol whose fake exists only in
the test target. No environment, defaults, argument, file or page path changes
it in Release; a Release check with all of those set still answers
`overflow-unverified`.

## 6. Preparing a run: `participantRun`

The commit introducing a run adds `participantRun:{runId, sessionId,
userMessageId, assistantMessageId, participantId, createdAt}` (`createdAt`
`YYYY-MM-DDTHH:MM:SS.mmmZ`), never with `dictationDeliveryId`
(`malformed-envelope`). It has no hash: native derives one from the record,
so the page needs no SHA-256, which a custom scheme may lack like `randomUUID`.

The claim is not evidence: native checks the run in the same request's
`record`, after v1's checks through exact replay. Steps 8-9 read the
committed record inside the store's commit, before the dispatch receipt.

| Step | Check | Refusal |
| --- | --- | --- |
| 1 | Claim keys, types, identities. | `unknown-field`, `malformed-envelope`, `invalid-identity` |
| 2 | `record.schemaVersion` 2; `conversationRuns` an array with exactly one element of the claimed `runId` ("the run"). | `run-not-found` |
| 3 | The run has exactly `version, runId, sessionId, userMessageId, assistantMessageId, participant, inputChunks, outputChunks, lastSequence, phase, createdAt, updatedAt`; `version` 1, `phase` `prepared`, `lastSequence` 0, `outputChunks` `[]`, `updatedAt` = `createdAt`. | `run-not-prepared` |
| 4 | Its `sessionId`, message ids and `createdAt` equal the claim's, exact strings. | `run-mismatch` |
| 5 | `participantId` and all four `run.participant` fields equal native's current pin. | `run-mismatch` |
| 6 | `inputChunks`: at least one string, each 1-16,384 bytes, total at most 262,144, and at most the host's first-trial input bound when it has one (4,096, section 17). | `text-too-large` |
| 7 | The run's canonical JSON is at most 785,408 bytes (768 KiB less a 1 KiB terminal reserve). | `payload-too-large` |
| 8 | No native entry uses any of the three ids (ignoring case), and the committed record lacks this `runId`. | `duplicate-run` |
| 9 | Introduced runs, below. | `unknown-run` |

Step 3's keys are 2e1f37d's twelve prepared keys, unchanged. Its optional
`reason` and `closure` belong only to later evidence, so a new run carrying
either is `run-not-prepared`.

Introduced runs apply to every commit on a participant host: a `runId` in the
attempted record's `conversationRuns` but not the committed record's. A record
without `conversationRuns` (schema 1) has none, so ordinary schema-1 edits
commit exactly as in v1. A present `conversationRuns` that is not an array of
objects each with a string `runId` is `malformed-envelope`. A commit may
introduce only the run its `participantRun` names; any other, including any
run in a commit without a claim, is `unknown-run`. Native parses nothing else
in the record, closures included.

Order and reading rules (October 10). Codex's answers Q6-Q9 and Q22 settle
the bullets below. The four marked "S3 reading" are the inactive commit
slice's own stricter or more specific readings, which no vector depends on;
Codex confirmed all four in its S3 review (October 10, inbox 9b6e7a98,
report 2ca2ed3).

- After v1's checks through exact replay (the barrier holder and
  `mutation-outstanding` included), any host refuses a commit under a
  recorded or reserved start's id as `payload-mismatch` (section 3, Q22).
  A participant host then checks a claim beside `dictationDeliveryId`
  (`malformed-envelope`); then the attempted `conversationRuns` shape
  (`malformed-envelope`, with or without a claim, before step 2; Q7); then
  steps 1-7; then v1's delivery check (Q6). Steps 8-9 run inside the
  store's commit, before the dispatch receipt, so a refusal there writes
  nothing and leaves the barrier free.
- Step 1, in order (Q6): unknown keys, `unknown-field`; each identity's
  presence, type and form in the order `runId`, `sessionId`,
  `userMessageId`, `assistantMessageId`, `invalid-identity` (a missing one
  included); `participantId` (nonblank, at most 256 UTF-8 bytes, the pin
  field rule) and `createdAt` (a real UTC time that formats back to the
  same 24 bytes, so February 30 fails), each `malformed-envelope`; then the
  four ids distinct ignoring case, `invalid-identity`. S3 reading: a claim
  that is not an object is `malformed-envelope`, before all of these.
- S3 reading: steps 3-5 compare strings byte for byte, as the page's `===`
  does, and step 5's `run.participant` must be exactly the pin object, so
  an extra key is `run-mismatch`.
- Step 6 owns `inputChunks`: an element that is not a string is
  `text-too-large` there, in an otherwise exact prepared run, and a failure
  at steps 2-5 still wins (Q8); an empty list fails the table's "at least
  one string". S3 reading: an `inputChunks` that is not a list is step 6
  too.
- S3 reading: step 8 compares the committed record's run ids ignoring case
  (the table says only that the committed record lacks the `runId`; Q4's
  case-insensitive namespace covers native's entries); step 9 compares them
  byte for byte, so another spelling of a committed run is introduced.
- Two readings of `conversationRuns`. The attempted record's is strict, as
  above. The committed record is opaque and may be older arbitrary
  workspace JSON, so steps 8-9 read it leniently: every string `runId` on an
  object element counts, and malformed siblings or a missing or non-list
  `conversationRuns` add nothing, which lets a valid replacement repair it
  (Q9). A run found that way is only "not introduced": it never creates an
  entry, a receipt or a start. Native's own `runs` stays strict at load
  (section 15).

v1 then continues. A stale revision is `conflict` and writes no entry. On
success one atomic `state.json` replacement holds the record, ledger entry,
identity record (gaining `runId`, like `deliveryId`) and the run entry, which
binds the full prepared `participant` (section 15). An exact retry replays
`ok`; the same id with other bytes is `payload-mismatch`; a new id for the
same run is `duplicate-run`.

`inputHash` is the lowercase hex SHA-256 of DeskHost's
`JSONValue.array(inputChunks).canonicalData()`, which equals
`JSON.stringify(inputChunks)` (see `hashVectors`). Chunk boundaries count.

## 7. `participant.start`

`participant` and `inputChunks` repeat the prepared run. In order:

1. v1 envelope, connection and text-item checks; `store-locked` when the
   coordinator's lock flag is set.
2. Shape and identities.
3. `unknown-handle`.
4. Identity: a recorded start with the same id and payload hash replays its
   `ok`; the same id with another hash, or any v1 identity, is
   `payload-mismatch`; the bytes of a start still `starting` or undetermined
   get `unknown`.
5. Runs list unreadable: `store-corrupt` (absent: `store-missing`).
6. No entry: `unknown-run`.
7. A start exists, or is `starting`, under another id: `duplicate-run`.
8. Stopped before starting: `run-not-prepared`. (A preparing commit that is
   not yet durable has no entry, so step 6 answers `unknown-run`.)
9. Ids, any `participant` field or the input hash differ from the entry:
   `run-mismatch`.
10. The entry's prepared `participant` differs from native's current pin:
    `participant-changed`. Native never runs a prepared run under another
    model.
11. Chunk limits, including the first-trial input bound (section 17), which
    also refuses a run prepared above it: `text-too-large`.
12. Another run is starting, running or stopping, or any run is
    `cleanup-pending` (section 10), or any participant terminal or cleanup
    write of this launch is unresolved (Codex Q31: a spawned run's terminal
    or `groupCleared` upgrade not yet durable, or a never-spawned run's
    terminal in flight or pending; a conflicted one until the app quits:
    section 10, ruling (a)), or a run's confirmation end (section 17)
    is decided and the owner has not yet applied it (Codex S8 R1), across
    Desk windows and close/reopen: `participant-busy` (retryable).
13. Mark `starting`; availability recheck fails: `participant-unavailable`.
14. Write the start record: one compare-and-set in ProofStore's lock that
    refuses, as steps 7-8, if a start or terminal exists. Definite failure
    with nothing applied: `store-corrupt`; undetermined: `unknown`, nothing
    spawned.
15. Spawn (section 11); reply `ok` with `runId`.

`ok` means recorded and dispatched, unless a Stop came first (then the one
event is `stopped` at sequence 1). Events may precede the reply. A spawn or
init failure's one event is `failed` at sequence 1.

Section 17's run claim (Codex F0 answer 12; built inactive in plan F4,
awaiting review). A host with section 17 built counts a run at the
commit-to-spawn boundary: after step 14's durable start record and the
lifecycle checks that follow it (a Stop, lock, window close, quit or detach
seen there takes the cancellation path below and claims nothing), the
coordinator calls the owner's `claimRun()` once, synchronously on its own
actor, immediately before step 15's dispatch, with no await, UI or I/O
between a successful claim and the launch. A successful claim counts the run
against the active confirmation, whether or not the spawn then succeeds (a
launch that throws after it is counted and is `failed` `process-error` as
before); nothing refunds or retries a counted run. The fifth claim ends the
confirmation (`run-limit`), and that fifth run may finish; Stop, lock, close,
quit and detach keep their existing effects on it, and one that lands after
the start last looked still stops the spawned run when it registers (S10
reading 2). A refused claim (no active confirmation, for example one ended by
a sleep, logout or paid overflow while the record was written) spawns
nothing and takes the never-spawned failure path a throwing launch takes:
`failed` `process-error` at sequence 1 with `groupCleared:null`, the
start-recorded terminal obligation (starts are `participant-busy` until that
terminal is durable, section 10), the start answering `ok` (or
`unknown-connection` once its stack was let go), the recorded start replaying
`ok` and never dispatching or claiming again, its identity never released;
the confirmation keeps its honest `ended` display and no charge is assumed.
Never claimed: every refusal at steps 1-13, a definite or undetermined step
14, an exact replay of a recorded start, and the authoritative re-read (a
found record is `failed` `process-error`; an absent one releases the id, and
only a later explicit Start that passes every step again may claim). The wire
is unchanged and no vector is added: the vector harness's owner grants every
claim, and all 107 cases pass unchanged.

Concurrency: the coordinator never calls ProofStore synchronously. Writes
run on an executor; reads use an immutable runs copy published after each
durable write, so stop, status and events never wait for the store lock. It
keeps its own lock and closed flags and sets `starting` before its first
await. Stop during `starting` sets stop-requested and waits for the start.
Seen before step 14: the start writes nothing and is refused
`run-not-prepared`; Stop records `stopped` at sequence 1. Seen after: the
start spawns nothing, records `stopped` `local-stop` at sequence 1 and
replies `ok`; Stop replies with that terminal. Lock, window close or quit
during `starting` sets no stop-requested: seen before step 14 with no Stop
waiting, the start writes nothing, not even a terminal, and is refused
`store-locked` (as step 1 refuses it now); the run stays `not-dispatched`.
Seen at or after step 14: as after a Stop, except that the terminal is held
unwritten while locked or with no stack (S10 reading 2).

S10 amendment, accepted by Codex's S10 review (inbox fcc67dfe, ruling 1;
S10 review finding 4): a later retry stays an explicit Start, and
unlocking or reopening never starts the run. Still open, and required
before participant activation (Codex's S11 review, inbox 237d63fc, ruling
(c); section 18 gives the exact proof): the ruling asked
S11 to verify the combined interaction with the renderer (a lock during
`starting`, then an unlock: no automatic start, and Start offered
explicitly). No S11 check exercises it yet; S11's end-to-end proof
(section 14, S11 reading 9) never locks during `starting`. The paragraph above read
"Stop, lock, close or quit during `starting` sets stop-requested and waits
for the start. Seen before step 14: the start writes nothing and is refused
`run-not-prepared`; Stop records `stopped` at sequence 1." For lock, close and quit, S10 answers `store-locked` and
records nothing instead. The two differ on the wire and on disk only for a
window close or quit with the stack still attached and the store open: the
earlier text cancelled the run for good (a `stopped` terminal and the
permanent `run-not-prepared`); S10 leaves it `not-dispatched` and answers
the retryable `store-locked`. Under lock both answer `store-locked`, since a
cancellation write is refused while locked (S8 reading 7; Codex Q32). The
reasons: nobody asked to stop that run, so no terminal should claim it was
stopped, and `run-not-prepared` would claim a recorded terminal that does
not exist. Restoring the earlier text would mean treating a lock, close or
quit seen before step 14 as that Stop is treated there (one never-dispatched
`stopped` write, then `run-not-prepared` once it is durable).

After an undetermined start record, native never spawns for that attempt,
and nothing for the run while its record is present or undetermined; nothing
resumes the attempt (Codex Q27: "this launch" means the unresolved attempt).
Before the run's next start, stop or status, native re-reads `state.json`
authoritatively (a folder flush, then the file). Record present: nothing ran;
native records and pushes `failed` `process-error` at sequence 1 with
`groupCleared:null`. Absent: `not-dispatched` again, and the attempt's id is
released; an explicit user Start with a new request id may then dispatch the
run in the same launch, as sections 1 and 13 allow. Re-read fails: start and
stop answer `unknown`, status `unknown` `start-uncertain` with `lastSequence`
0. After a restart, a start without a terminal is `unknown` `exit-unrecorded`.

Two rules about the released id, kept apart (Codex S8 answer 1, which
clarifies its Q27 wording):

- The caller's rule (page, transport, coordinator) is unchanged: nothing
  resends or resumes an uncertain start by itself. The page keeps its status
  recovery and dispatches only on an explicit user Start with a new request
  id (section 13).
- Native's identity release: an id freed by a re-read that proved the record
  absent is released, not kept as a permanent tombstone. Native may admit a
  new incoming start under that same id (the exact retry of the uncertain
  start included, which makes the re-read itself) provided the prepared
  entry is still startable and every admission, availability and
  compare-and-set check runs again (steps 1-15). While the record is present
  or the re-read unresolved, nothing under that id dispatches; a durable
  exact replay never dispatches twice; concurrent retries of the id launch at
  most once (one is admitted, the others are `unknown` while it starts). No
  new refusal or permanent reservation exists for the abandoned id.

Readings (S8). Codex confirmed: `participant-changed` is its own permanent
refusal at step 10, never folded into `run-mismatch` (Q25); the paragraph
above (Q27); a Stop during an undetermined start re-reads first: record
present, Stop replies with that `failed` terminal; absent, the
never-dispatched `stopped` `local-stop` at sequence 1; re-read failed,
`unknown`; a failed terminal write is `store-corrupt` if definite, else
`unknown`, never a pretended cancellation (Q28); a definite step-14 failure
while a Stop waits leaves `start` null, and the Stop records `stopped`
`local-stop` at sequence 1 (Q29). Codex accepted the thirteen below in its
S8 review (October 11): 1 and 13 for that inactive slice only (S10 still
owns the coordinator's own lock and closed flags, their ordering before any
await, and full detach, lock and close), and 6 with R1 (section 17):

1. Step 1's lock flag is, until the lifecycle slice gives the coordinator its
   own, the store's published `locked` (or closed) flag. (S10 gives it its
   own: see the S10 readings below.)
2. Step 2: `participant` is an object of exactly its four keys, each a
   string, and `inputChunks` a list of strings, else `malformed-envelope`,
   after the five ids in section 4's order and before their distinctness. A
   value that cannot be the prepared one (an empty list included) is
   `run-mismatch` at step 9; sizes are step 11's.
3. Step 4: a durable start record (the published runs copy) under the id
   replays `ok` with the same hash and is `payload-mismatch` with another.
   Otherwise the shared identity index decides and claims in one step: a v1
   identity is `payload-mismatch`; a start still `starting`, or written but
   not proven durable, is `unknown` with the same hash and
   `payload-mismatch` with another. An id that only the published copy
   still reserves (the index never saw it; Codex S6) is `unknown`, since its
   hash is not known, and claims nothing. Every later refusal gives the
   claim back.
4. Step 5: a ready runs copy that is not yet durable or settled and lacks
   the run answers outcome `unknown`.
5. Between steps 8 and 9: while a never-dispatched Stop's terminal is being
   written, or is undetermined, a start is `unknown`: whether the run was
   stopped is not known, and it must not start meanwhile.
6. Step 12: an undetermined start record spawned nothing and never will, so
   it blocks no other run. A spawned run blocks every start until both its
   cleanup is released and its updates have all been consumed (section 17),
   and (S9, Codex Q31) its terminal and cleanup writes are durable, and (S8
   R1) any confirmation end section 17 requires of it has been applied by
   the owner.
7. A Stop seen before step 14 wins over the recheck's answer. The start and
   the waiting Stops share one cancellation write; the start answers
   `run-not-prepared` only once it is durable, else that write's
   `store-corrupt`, `store-locked`, `store-missing` or `unknown`.
8. A Stop seen at or after step 14, with the record durable: the start
   replies `ok`, spawns nothing and records `stopped` `local-stop` at
   sequence 1 beside its start, `groupCleared:null`; every waiting Stop
   replies with that write's result (`store-corrupt` if it failed
   definitely, `unknown` if undetermined; the run keeps that terminal, as
   section 10's S8 readings say).
9. A definite step-14 failure answers as the store refused: `store-locked`
   (locked or closed), `store-missing`, `duplicate-run`, `run-not-prepared`,
   `unknown-run`, `payload-mismatch` (the id is the store's), otherwise
   `store-corrupt`. Anything else is undetermined.
10. A launch that throws records its `failed` `process-error` before the
    start replies `ok`. The start replies `ok` even if that write fails:
    its record is durable, and the run keeps the terminal (section 10).
11. After a re-read finds the record, the same request's exact retry
    replays `ok`; once that `failed` terminal is durable it is the run's
    one event (until then the run reads as section 10's S8 readings say).
12. Step 13 also refuses `participant-unavailable` when the report carries
    a confirmation and the coordinator has no section 17 owner to end it
    (section 17's S8 note).
13. A detach during the availability recheck writes nothing, not even a
    waiting Stop's cancellation: the start and that Stop answer
    `unknown-connection`, and the run stays as the folder shows it.

One refusal may write for other runs (Codex S9 ruling b, a narrow exception
to Codex Q26's "a refusal writes nothing"): a start that reaches step 12 and
answers `participant-busy` queues one bounded pass of the participant
terminal and cleanup writes this launch already owed for other runs, so it
may make those exact writes durable, and push a never-spawned terminal made
durable that way once. It launches nothing, does no new work for itself,
and leaves its own prepared run, request identity, dispatch receipt and
workspace record, and every unrelated record and file, unchanged. Every
refusal at steps 1-11 still queues and writes nothing. A refusal at steps
13-14 writes nothing of its own either: a Stop seen before step 14 records
its own `stopped` terminal, which belongs to that Stop (above), and step
14's definite failure applied nothing. Section 10's S9 rulings give the
detail.

Readings (S10, passed by Codex's S10 review, inbox fcc67dfe; Codex Q21, Q32
and the S8 review's reading 1 and lifecycle obligations):

1. Step 1's flag is the coordinator's own lock and closed flags, set by
   lock (`lockNow`) and by the start of a window close or quit
   (`beginShutdown`) on the app's thread before they return, so before any
   await of the lane. The store's published locked or closed flag stays a
   backstop with the same answer, `store-locked`. A close or quit is "closed"
   from its start until a stack is attached again.
2. Lock, window close, quit or detach during `starting`. Step 1 reads a
   lifecycle counter that each of them moves; the start compares it before
   step 14 and after it.
   - Seen before step 14 with no Stop waiting: nothing is written, not even
     a terminal, since nobody asked to stop that run; it stays
     `not-dispatched` and an explicit Start may run it later. The start
     answers `store-locked`, as step 1 would now, never `run-not-prepared`
     (which would claim a recorded terminal). This changes section 7's
     paragraph, which named lock, close and quit with Stop; it is amended
     there, and Codex's S10 review accepted it (inbox fcc67dfe, ruling 1).
     With a Stop also waiting, S8 reading 7 applies unchanged (under lock
     its cancellation is refused before writing, `store-locked`, and a
     never-dispatched run keeps nothing).
   - Seen at or after step 14: nothing is spawned and the run's terminal is
     `stopped` `local-stop` at sequence 1, as for a Stop. Decided while
     nothing may be pushed, it is never pushed. While locked, or with the
     stack let go, it is not written either: it is kept text-free in memory
     (pending, busy) and written by the unlock or by the next attach over
     the same folder (Codex Q32). The start answers `ok` (`unknown-connection`
     once its stack was let go).
   - Detach, during the start record's write or the availability recheck:
     the start and every Stop waiting on it answer `unknown-connection`,
     whatever the write did; nothing is spawned; no store work starts through
     the let-go stack's store. An undetermined record stays undetermined and
     the next attached stack re-reads it. Detach during the cancellation
     write of a Stop that came before step 14: the start answers
     `unknown-connection`; the Stops that made or joined that write answer
     by it (it was already handed over, so it completes).
   - A lock or close that lands after the start last looked and before its
     spawned run is registered for lifecycle stops still stops it: the
     registration sees the counter moved and sends `stop` at once (either
     the lock's sweep sees the handle or the handle sees the sweep). Such a
     run was spawned and then stopped, and ends like any stopped run; this
     is the one case in which a start in progress spawns at all under lock,
     close or quit.

## 8. Participant events

An event is exactly `{runId, sessionId, sequence, at, type}`, plus `text` on
text events and `reason`, always, on `stopped` and `failed`. `sessionId` is
the prepared run's exact string.

- `type`: `started | text | completed | stopped | failed`. `stopped` reason
  `local-stop | stop-incomplete`; `failed` reason `reply-too-long |
  paid-overflow | timeout | process-error`; `completed` none.
- Sequences start at 1 and rise by one. The first event is `started`, or a
  terminal if the run ends before starting. Text follows `started`. Exactly
  one terminal, last; `completed` at sequence 2 or later. A recorded terminal
  is never rewritten into another event.
- `at`: UTC ISO with milliseconds, the latest of native's clock, the previous
  `at` and the run's `createdAt`.
- `text`: 1-16,384 UTF-8 bytes, cut between Unicode scalars, only from text
  deltas, only after the overflow rule passes (section 11).
- `started` follows spawn and an init message passing section 11.
- `completed` needs a success result, then exit 0; any other exit is
  `failed` `process-error`.
- Once native decides to end a run it emits accepted text and discards later
  and held output.

User Stop, lock, window close and quit give `stopped` `local-stop` when the
group is confirmed gone; the UI says "Stopped on this Mac", which does not say
who stopped it. If the group is not confirmed gone the reason is
`stop-incomplete` ("Stop not confirmed on this Mac") and cleanup continues
(section 10). Native ends are `failed`: `reply-too-long`, `paid-overflow`,
`timeout` (init 30 s, no output 120 s, total 15 min) or `process-error`
(spawn failure, unreadable stream, init mismatch, a line over 1 MiB, other
exits, a lost supervisor), with the terminal after the same stop sequence and
probe. A native end whose group survives records `groupCleared:false`, like
`stop-incomplete`.

Native ends with `reply-too-long` rather than emit text making input plus
output exceed 262,144 bytes or the projected run exceed 785,408: projected =
`preparedBytes` + 3 + the sum over text events of (escaped JSON string bytes
+ 3) + 64. It first emits the longest scalar-aligned prefix that fits. The
1 MiB workspace budget stays the page's. Native decides this when the text
delta that cannot fit arrives, not at the next 250 ms flush: the prefix and
the decision share that delta's millisecond (vector #48), and a Stop, a
paid-overflow signal or an exit that arrives later finds the run already
ending `reply-too-long`. A later paid-overflow signal still ends a section 17
confirmation.

Pushed detail: `{type:"participant.event", connectionId, generation, event}`
(nested because v1 details use `type`). The page checks the outer connection
and generation, then the exact inner event, before routing it to a run. It
goes, in sequence order and at most once, to each connection valid for the
current generation at push time; with none, it is only retained. Text is
emitted 250 ms after the first unemitted byte, before the buffer passes
16,384 bytes, on the CLI's result message, or before any terminal, whichever
is first. Nothing is pushed once lock, window close or quit begins; the
terminal is still recorded.

Reading (S10, passed by Codex's S10 review, inbox fcc67dfe, which accepted
its nonblocking-sink requirement as ruling 3): the lane's step comes before the
host's (`lockNow` before v1's `locked`, `beginShutdown` before v1's
`revoked`), and pushes are suspended inside it, once any push under way
has finished, so no participant event follows `locked` or `revoked`. A
terminal that arrives, or a never-spawned terminal decided, while pushes are
suspended is never pushed, even when the unlock or a later attach writes it.
After an unlock, a run still in its stop sequence pushes its later events to
the connections issued from then on. The lane's step waits for one thing:
a participant push already under way, until the sink's `push` returns. The
app calls it on the main thread, so a sink's `push` must return promptly
and never wait on the main thread (it hops there asynchronously, as the
WebKit sink does; S11 keeps that).

Reading (S11; section 8's nonblocking-sink rule, accepted by Codex's S11
review, inbox 237d63fc, report a819387, ruling (d)): the WebKit sink's `push` runs its
observer (identifiers only) on the pushing thread and hands the event to the
main thread asynchronously; it takes no lock the main thread holds. The lane
is attached with that same sink, the stack's own. Checked with the lane's
lock and close steps holding the main thread while a push from another
thread, through that sink, returns.

Reading (S11 follow-through, passed by the same S11 review, within ruling
(d)'s stated limit: the push boundary below is the weaker one, and it is not a
synchronous erasure of what was already handed to WebKit; Codex's ruling 3
and carried requirement 5): checked with the real coordinator too. A push it
has under way is held in the sink's observer, on the pushing thread with
the coordinator's push gate held, when the host's lock or close (and, with
the real page, the session's lock or window close) runs the lane's step on
the main thread. The step waits for that push alone: it returns without the
main thread and without calling back into the coordinator, and then the
step goes on. The sink documents the rule for its observer too (return
promptly, never wait on the main thread, never call the lane). The event of
that push may still reach the page before v1's `locked` or `revoked`, never
after: it is queued to the main thread ahead of the host's own step, and
from the moment the host is locked or closed the sink drops it at delivery
(section 3). Nothing is pushed after the step. Answers are held to more
(section 3): one to a request admitted before the lane's step is dropped
even before the host is marked.

## 9. `participant.events`

`afterSequence` is a nonnegative safe integer and `maxEvents` 1-64, else
`malformed-envelope`. `ok` fields:

- `events`: retained events from `afterSequence+1`, contiguous, at most
  `maxEvents`, stopping before the reply's canonical JSON passes 1,048,576
  bytes; at least one when any is retained after `afterSequence`.
- `more`: true exactly when retained events remain after the last returned.
- `lastSequence`: highest assigned this launch or recorded as a terminal;
  `null` when unknown (restart without a terminal). It may grow between pages
  of a live run.
- `lost`: `null`, or `{fromSequence, throughSequence, reason}` when event
  `afterSequence+1` is gone (a recorded terminal is never gone); `events` is
  then `[]`. `fromSequence` = `afterSequence+1`; `throughSequence` = known
  terminal's sequence minus one, else `null`; `reason` is `locked | closed |
  restarted | replaced`.
- `terminal`: the recorded terminal when `lost` is non-null and one is known,
  else `null`.

Native keeps the current or most recent run's events in memory (at most
256 KiB of text) until lock (`locked`), window close (`closed`), quit or crash
(`restarted`) or another run's start (`replaced`); reload and web content
crash keep them. A start replaces them only when its start record is
confirmed durable: its write returned, or a later re-read finds it (Codex
Q30; S8 reading, accepted in Codex's S8 review: a re-read that finds it after
another run started leaves that newer run's events). An availability refusal, a
definitely failed write or an undetermined one keeps them. The previous run's recorded terminal stays replayable;
`replaced` covers only the events before it. Event text never touches disk.
`afterSequence` at or past
`lastSequence` gives `[]`. So does `afterSequence` at the largest safe
integer, even with `lastSequence` `null`: no representable event follows it,
so `lost` and `terminal` are `null` and `lastSequence` is as known (Codex S7
R1). Outcome `unknown` only when native cannot read the
run's entry and holds nothing for it.

Readings (S7). Codex Q24: when `afterSequence+1` is exactly the recorded
terminal's sequence, `events` is `[terminal]`, `lost` and the outer
`terminal` are `null`, `more` is false and `lastSequence` is that sequence;
native never sends a zero-length lost range. Events of a run this launch
dispatched whose memory another run's replaced are lost `replaced`; those of
a run an earlier launch dispatched, `restarted`. Accepted in Codex's S7
review (inbox 68524fc3, report 8032ddb, answer (a)): while
a never-dispatched run's cancellation write (section 10) is undetermined,
native can read the entry and holds the pending terminal, so events answers
`ok` as status does: `events:[]`, `more:false`, `lost` and `terminal` null,
`lastSequence` 0. The pending terminal's sequence 1 is not counted until its
write is durable (nothing vouches for it before, and a definite failure of a
retry leaves the run `not-dispatched` at 0, so `lastSequence` never goes back
down); once durable the terminal is event 1.

Readings (S10, passed by Codex's S10 review, inbox fcc67dfe; Codex Q21 and
the S7 review's item 4):
lock and the start of a window close or quit drop the retained text at once:
before any later request is answered, and before the stack is detached.
Every retained event except a terminal (text-free, and never lost) goes;
`lost` reaches the last one dropped, with reason `locked` or `closed` (the
latest drop's). While lock or close is under way no text is kept: an event
the stop sequence emits (its accepted text) is counted, lost for that
reason, and a terminal is kept. Only text-free numbers remain: `lastSequence`,
the loss and the terminal. After an unlock a run still emitting keeps its
later events again. Reload, navigation and a new connection keep the text
(vector #94). A bare detach keeps it too; it is a test-only path, since the
app detaches only after a close.

## 10. `participant.status`, `participant.stop` and cleanup

| Status `state` | Meaning |
| --- | --- |
| `not-dispatched` | Durable entry, no start, no terminal, nothing undetermined. Start only by explicit user action. |
| `starting` | Between start checks and spawn. |
| `running` | Live group owned by this launch. |
| `stopping` | Stop inside its 12 s bound. |
| `cleanup-pending` | Terminal recorded (any reason), but this launch owns a group not confirmed gone, or lost its supervisor while either of the CLI's output pipes has not reached EOF (a failed read is not EOF). Blocks every start. |
| `exited` | Terminal recorded; group cleared, never spawned, an earlier launch's, or ownership lost (supervisor gone and both output pipes at EOF). |
| `unknown` | See `unknownReason`. |

`unknownReason`: `store-unreadable`, `start-uncertain` or `exit-unrecorded`
(dispatched by an earlier launch, no terminal); otherwise `null`. Status
never answers outcome `unknown`. `lastSequence` follows section 9 (`0` before
any event). `groupCleared` is `null` until a terminal, then `true`, `false`,
or `null` when nothing was spawned. It is stored with the terminal and later
set to `true` if the group clears; the terminal is never rewritten.

Stop replies `state` `exited`, `cleanup-pending` or `not-owned`, and
`providerCancelConfirmed:false` always: it proves only what happened on this
Mac. Concurrent stops share one terminal.

- Running or stopping: emit accepted text, run the stop sequence (section 11);
  terminal `stopped` `local-stop` with `groupCleared:true` (`exited`), or
  `stop-incomplete` with `groupCleared:false` (`cleanup-pending`), within
  about 12 s plus one write.
- Cleanup-pending: one more SIGKILL to the still-reserved group and a 2 s
  probe; if it is now empty, write `groupCleared:true` and reply `exited`,
  else `cleanup-pending`. No new event. Without a supervisor nothing is
  signalled: `cleanup-pending` until both pipes reach EOF, then `exited`.
- Starting, or undetermined start: section 7 decides.
- Never dispatched: durably record `stopped` `local-stop` at sequence 1, so a
  later start is `run-not-prepared`. Write failure: `store-corrupt` if
  definite, else `unknown`.
- Already ended, group cleared or nothing spawned: `exited` with the
  terminal; nothing signalled.
- Earlier launch: with a terminal, `exited` with it and the stored
  `groupCleared` (a stored `false` stays `false`); without one, `not-owned`,
  `terminal:null`. Never signalled.
- Store unreadable, nothing in memory: outcome `unknown`.

Readings (S7). Codex Q23: with the store missing or unreadable and nothing in
memory, status is `ok` with `state:unknown`, `unknownReason:store-unreadable`
and `lastSequence`, `terminal` and `groupCleared` null; Stop and events answer
outcome `unknown`; `unknown-run` only when the readable, durable store proves
no prepared entry. Accepted in Codex's S7 review (inbox 68524fc3, report
8032ddb, answers (a)-(c); (c), that is (3), only for that unreachable,
test-seeded state): (1) an undetermined never-dispatched
cancellation keeps its exact terminal in memory; status then reads `unknown`
`start-uncertain` with `lastSequence` 0, never `not-dispatched` (Codex Q5), a
repeated Stop retries that same terminal (until it fails closed: S9 ruling
(a), section 10 below), and nothing is pushed until it is durable; if another answer's folder flush makes it durable first, it is
pushed once when native first sees it there; (2) a cancellation the store
refuses before writing, with nothing pending, is definite for that attempt:
locked or closed is `store-locked`, missing `store-missing`, unreadable
`store-corrupt` (the page maps each to unknown); a retry of a pending one that
the store refuses is outcome `unknown`, since the first attempt may still
prove durable; (3) a start of this launch with no terminal and no memory of
its run, a state the coordinator does not reach, reads as an earlier
launch's: status `exit-unrecorded`, Stop `not-owned`.

Readings (S8, accepted in Codex's S8 review, October 11: the never-spawned
terminal kept through definite and uncertain failures, `start-uncertain` at
0 until durable, and exact Stop retry; leaving live Stop to S9 was accepted
only for that inactive slice). Every start of this launch has memory
from its starting mark until it refuses, its run is spawned, or a terminal
for a run that never spawned is durable, so (3) above never applies to it
(Codex S7 reading (c)). Once such a run's start record is durable (a Stop
at or after step 14, a launch that throws, or a re-read that finds the
record), its never-spawned terminal stays pending in memory through every
failed write, definite ones included, until a retry makes it durable (or
it fails closed, kept in memory and never retried: S9 ruling (a) below);
only a never-dispatched run's cancellation is dropped on a definite failure
(it is then `not-dispatched`, which is true). A Stop that made or joined
the write answers by it (Codex Q28: `store-corrupt`, or the store's
`store-locked` or `store-missing`, if definite; `unknown` if undetermined);
a start whose launch threw still replies `ok`.
Until a retry is durable, status reads `unknown` `start-uncertain` at 0 and
events nothing at 0, as (1), nothing is pushed, a new start is
`duplicate-run`, and the next Stop retries that exact terminal (a retry the
store refuses before writing is that refusal after a definite failure, and
`unknown` after an undetermined one; a conflicted one is never retried and
answers `unknown`: S9 ruling (a) below). Status answers a run from memory:
`starting` (`lastSequence` 0); `running` with its last sequence;
`cleanup-pending` once a terminal is in while `groupCleared` is `false` and
cleanup is not released; otherwise `exited` (the group cleared, nothing
spawned, or ownership lost), with the terminal and `groupCleared` memory
holds (Codex Q31: a pending write does not change them). Stop of an ended
run answers `exited` by the same rule. `exited` can come while starts are
still `participant-busy` (section 7 step 12 waits for the run's updates
too). S8 answered Stop of a spawned run that had not ended, or whose
cleanup was pending, `unknown` and signalled nothing; S9 replaces that (the
readings below).

Codex Q31 (accepted, no new wire): once a start was conclusively recorded
and a real run's terminal or cleanup state is observed, Stop and status may
report that launch-local process truth even while its terminal or cleanup
write is pending. Such replies prove the process and cleanup state, not a
native disk write. The exact pending terminal (same `at`, sequence and
reason) and its cleanup evidence are kept apart from the durable runs copy,
never published into it and never written over another terminal;
`groupCleared` becomes true only on actual group-probe evidence, and a lost
supervisor keeps false even after EOF. Signal first; the write is queued,
bounded and idempotent, before later store work (S9 stages this only:
ruling (c) below); Stop, status and events never wait for the store lock or
an unbounded retry. Every new start stays `participant-busy` while such a
write is unresolved (section 7 step 12). A
never-dispatched cancellation still needs its durable write (Q28, Q29). A
restart recovers only durable evidence: a native terminal that never
became durable leaves `exit-unrecorded`, never rebuilt from the page's
record.

Readings (S9; Codex's S9 review, October 11, accepted all eight with the
qualifications in its rulings after this list):

1. Stop of a running or stopping run writes `stop` (`ParticipantRunning
   .stop()`) synchronously, before any await or store access. Only the
   first Stop signals; it and every later Stop wait for the run's terminal
   in memory, so concurrent Stops share one terminal. The reply is
   `exited` (`groupCleared` true or null) or `cleanup-pending` (false, not
   released) as memory then holds it, within the stop sequence's bound
   (about 12 s; a lost supervisor ends it at once). Its write follows in
   the background: the reply no longer waits for "one write" (Q31).
2. Status reads `stopping` from the first Stop's signal until the
   terminal. A run native decided to end (a timeout, reply-too-long, paid
   overflow) reads `running` until its terminal; a Stop then joins it.
3. Stop of a `cleanup-pending` run signals the retry (`stop()` again: one
   SIGKILL and a 2 s probe), shared by concurrent Stops, and answers when
   the retry does: `exited` with `groupCleared` true when an actual probe
   found the group gone (that `true` is a separate write after the
   terminal's), else `cleanup-pending`. No new event. `stop()` false (no
   supervisor) signals nothing and answers from memory at once:
   `cleanup-pending` until both pipes reach EOF, then `exited`, with
   `groupCleared` false. Stop of an ended run whose group cleared, that
   spawned nothing, or whose cleanup was released signals nothing.
4. A Stop whose wait ends because the run's updates ended with no terminal
   answers outcome `unknown` (no reader path reaches this; it bounds the
   wait).
5. Persistence of a spawned run: the exact terminal with the
   `groupCleared` recorded with it, then the cleanup upgrade, each
   idempotent in the store. One pass at a time per run makes at most one
   attempt per owed write, in that order, stopping at the first that does
   not prove durable. Passes come with the update that owes the write, a
   Stop of the run, and every busy start's admission (all in the
   background; staging for this inactive slice, not Q31's whole ordering:
   ruling (c)); never a timer. Each pass first adopts what the store's
   durable copy already holds (a re-read: another path's folder flush may
   have made an undetermined write durable). `replacedUnsynced` is
   uncertain and retried (the store retries the folder flush first);
   `writeFailed` is definite and retried; locked, closed, missing or
   unreadable stays owed; `runEntryConflict` or `unknownRun` (another
   terminal on disk, a `groupCleared` null under the cleanup upgrade, or no
   entry, found by the store inside its lock for the cleanup upgrade as for
   the terminal: S9-R1) is never retried and never replaced, and the write
   stays unresolved, so starts stay busy until the app quits (ruling (a)),
   with one text-free `write-conflict` log entry for the run. A pass writes only through a stack still
   attached: after a detach the write stays owed.
6. Step 12's Q31 extension covers a never-spawned run's terminal in flight
   or pending as well: every other run's start is `participant-busy`, and
   that start's admission queues the pending terminal's retry (the run's
   own start still answers by section 7's S8 reading 5). The busy refusal
   writes nothing for its own run, but the retries it queues are other
   runs' owed writes: one that becomes durable changes `state.json`, and a
   never-spawned terminal made durable that way is pushed once. This is
   the one exception to the harness's Q26 rule that a refusal writes
   nothing (ruling (b)), which no vector reaches with a write owed. A
   pending never-spawned terminal that meets another terminal or no entry
   fails closed under ruling (a) and is never queued again.
7. Events of a spawned run of this launch answer from memory, store
   readable or not: its retained events while they are kept (else lost
   `replaced`), and its terminal as process truth, a pending one included,
   as status and Stop do.
8. Store unreadable (missing, corrupt, or no durable copy): status, Stop
   and events agree, from run memory only: a spawned run from its memory; a
   never-spawned terminal still pending as S8's reading (1); one made
   durable (kept text-free as an ended run) `exited` with it,
   `groupCleared` null. Retained events alone never answer (every run whose
   events are kept has run memory beside them), so a run with no run
   memory is status `unknown` `store-unreadable`, Stop and events outcome
   `unknown`. This replaces S7's events answer from retained events alone.

Codex's S9 rulings (October 11). Readings 1-4, 7 and 8 are accepted as
stated; 5 subject to S9-R1 and (c), with full detach and store lifetime
left to S10; 6 under the exception in (b), with its conflict path now
under (a) as well (passed by Codex's S9-R1 re-review, inbox c9e0cb5c,
report a59d555).

- S9-R1 (should-fix, applied; passed by Codex's re-review, inbox
  c9e0cb5c, report a59d555): a cleanup upgrade
  names the exact terminal. Both of a spawned run's writes go through the
  store's terminal write with the exact pending terminal, which the store
  compares inside its lock, in the same step as the change; the upgrade is
  that terminal's monotonic `groupCleared` false-to-true change (already
  true changes nothing). Another terminal on disk, a `groupCleared` null,
  or no entry is refused with nothing changed, even when it reaches the
  folder after the coordinator's snapshot and before the executor's
  mutation: a snapshot check alone is not enough. Nothing recreates a
  missing run or moves `true` back to `false`. Terminal-before-cleanup
  order, idempotent flush recovery and Stop's independence from disk
  writes are unchanged. Two edges, named for the re-review, which accepted
  both: an entry that
  holds no terminal (the folder lost the one this launch proved durable)
  gets the run's own exact terminal with `true` in that one locked write,
  replacing no other terminal (the earlier `markGroupCleared` refused it);
  and a cleanup upgrade owed with no terminal in memory (no reader order
  produces one: a cleared group is reported only after a terminal that
  recorded false) fails closed as (a) says, never attempted, logged once.
- (a) For a spawned run's terminal and cleanup writes (reading 5), a
  conflicting terminal or a missing run fails closed, busy until quit, for
  this inactive slice. The pending fact stays in memory, the
  irreconcilable write is not attempted again, and one fixed text-free
  `write-conflict` entry is logged. Nothing overwrites another terminal,
  recreates a missing entry, silently drops the owed evidence, or lifts
  admission because a write was refused. Process cleanup and the bounded
  quit path work independently of it. A restart uses only durable
  evidence: this gives no authority to rebuild a terminal from the page,
  and quitting proves no write completed.

  Applied to a never-spawned run's pending terminal as well (reading 6;
  the S8 readings; accepted by the same re-review, inbox c9e0cb5c): a
  terminal kept in memory
  because its run's start record is durable (a Stop at or after step 14, a
  launch that throws, a re-read that finds the record), or because an
  earlier attempt of a never-dispatched cancellation was undetermined.
  When its write meets another terminal or no entry (`runEntryConflict`
  or `unknownRun`, found inside the store's lock), or a status, events or
  Stop read finds the run's published durable entry holding another
  terminal, or this exact terminal with a non-null `groupCleared` (the
  store refuses the write's null there as `runEntryConflict`, so a read
  treats it the same and never settles it as durable), the run fails
  closed exactly as above: the exact terminal stays in memory,
  conflicted; it is never retried (busy starts, Stops and reconciliation
  skip it), never dropped, never written over the other terminal or into
  a recreated entry, and never pushed; one fixed text-free
  `write-conflict` entry is logged (its type and sequence, no text); and
  every start stays `participant-busy` until the app quits. Status,
  events and Stop keep answering the run from that memory, as for a
  pending one, never from the other terminal or the missing entry:
  status `unknown` `start-uncertain` at 0, events nothing at 0, and Stop
  outcome `unknown` with no retry (the S8 reading's Stop retry ends
  here). The same memory answers when the run's entry is missing, where
  these reads answered `unknown-run` before; a read that finds no entry
  logs nothing itself, and the next write attempt (a busy start's or a
  Stop's) meets it and fails closed. For a run whose start record is
  durable, the same memory also answers before the terminal's first
  write returns: from the moment that write is taken (it holds the exact
  terminal), status and events give the pending answer whenever the
  entry does not hold exactly that terminal, the entry missing included,
  and a Stop joins the write and answers by it (`unknown` once it fails
  closed). So no read answers from another terminal or a missing entry
  while that write is in flight and differently after it returns.

  The never-dispatched cancellation rules of Codex Q28 and Q29 are
  otherwise unchanged: a first attempt with nothing pending (its write
  in flight, or one that meets another terminal or no entry) still reads
  as the folder shows it, answers `unknown` and keeps nothing (so no
  start of it can follow), and a definite failure still drops it. Only a
  never-dispatched cancellation already pending after an undetermined
  attempt changes, in two cases, both named for the re-review:
  - another terminal on disk: before, every busy start retried its write
    with nothing logged, and the first status, events or Stop read that
    found the other terminal dropped the pending terminal silently and
    lifted the busy barrier (a Stop answering `exited` with the other
    terminal). This is the silent discard the change was allowed to
    close.
  - no entry: before, nothing was dropped, but every busy start retried
    its write for ever with nothing logged, and status, events and Stop
    answered `unknown-run` (a Stop with no retry). This is not a silent
    discard; it is changed so that the same fault on the same kind of
    pending write ends the same way. Status and events now answer from
    memory and log nothing, the next busy start's or Stop's retry meets
    no entry and fails closed as above, and that Stop and every later
    one answer `unknown`.
- (b) A busy start may reconcile older owed writes, and it is the only
  refusal that may queue or make durable writes for other runs (section 7,
  after its readings). A
  `participant.start` that reaches step 12 and answers `participant-busy`
  may queue one bounded pass of the terminal and cleanup writes already
  owed for earlier runs; it may thereby make a never-spawned terminal
  durable and push it once. It launches nothing and leaves its own
  prepared run, request identity, dispatch receipt and workspace record,
  and every unrelated record and file, unchanged; only those exact
  pre-existing owed changes may happen, with no new work for the refused
  request. Every earlier refusal keeps the rule that it queues and writes
  nothing. The vector harness states the same exception (section 19); no
  frozen vector reaches it, and the coordinator's tests cover it.
- (c) The three retry triggers (the update that owes a write, a Stop of the
  run, every busy start's admission) are staging for inactive S9, not the
  completion of Q31's general rule that an owed write goes before later
  store work. With the all-starts busy barrier they keep a new start
  record from overtaking an owed participant write; they do not order
  arbitrary later workspace mutations or flushes, and independent
  background tasks are not first-in-first-out. The remaining ordering
  boundary belongs to S10/S11: before later eligible store work, native
  submits a bounded reconciliation attempt through the same ordering
  boundary; reconciling on unlock or re-attach is necessary but is not, by
  itself, the whole requirement. Failed or uncertain writes stay owed;
  attempts stay bounded (no retry loop, no timer); Stop, status and events
  never wait on the store; no quit bound grows.

  S10 (passed by Codex's S10 review, inbox fcc67dfe) adds the unlock and
  re-attach triggers as that
  boundary's lane side: attaching a stack over the same folder, and an
  unlock that no newer lock overtook, each queue one bounded pass for every
  owed terminal, cleanup and never-spawned write, synchronously on the
  coordinator, so before that stack's next request is handled. A run's
  later store work queues behind its own pass (one pass per spawned run at a
  time, one never-spawned write per run), new start records wait behind step
  12's busy barrier, and a conflicted run (ruling a) is never queued and
  stays busy until quit. While locked, nothing is queued or attempted (Codex
  Q32). Passes of different runs remain independent tasks, not
  first-in-first-out; ordering against workspace commits and any other later
  store work outside the lane is S11's (below). A write still in flight on a stack
  let go is skipped by the next attach's flush (one write per run at a
  time); when it returns, a terminal it leaves owed is queued once more
  through the stack attached then, as a spawned run's pass is, never on the
  same store again and never while locked.

  S11 (passed by Codex's S11 review, inbox 237d63fc, report a819387) adds
  the rest of the boundary
  (`ParticipantLane.reconcileBeforeStoreWork()`). The later store work
  outside the lane is a page's `workspace.commitProof` and the app's
  dispatch recovery when a Desk stack opens; the page's other operations
  write nothing. Before each, native asks the lane for one bounded pass:
  every terminal, cleanup and never-spawned write owed for the attached
  stack's folder is queued as an attach or unlock queues it, and the call
  returns once each of those writes, and each one already in flight, has
  had its attempt. A commit waits for it after v1's preflight passes (one
  refused there does no store work and asks nothing), in the WebKit message
  handler and in `HostRouter` alike; a stack's open asks after the lane's
  attach and unlock and before the recovery. Failed or uncertain writes stay
  owed and the store work goes on; nothing retries them before the next
  trigger, and nothing waits for a write that a pass queues once more after
  it began. Locked, nothing is attempted (Q32): a commit that slips past the
  lane's lock before the host's lock step goes on as in v1, and a lock that
  lands while a stack opens leaves the lane locked through that open's
  recovery. Stop, status and events never ask; lifecycle steps never ask,
  so no quit bound grows.
- (d) A slow or held write no longer ends the confirmation on its own
  (section 17): accepted. Updates, overflow observations included, are
  applied to memory in order, so a held write is no unfinished
  observation; starts still wait for it (step 12). This neither closes
  nor weakens S8 R1.

Cleanup ownership is independent of the transcript terminal and of who ended
the run: Stop, lock, close, quit or a native end. While an owned group stays
uncleared, its supervisor re-probes every 5 s and sends SIGKILL to the
reserved group while members remain; when it is empty, native writes
`groupCleared:true`, the leader is reaped and the busy guard lifts. Native
never signals a group whose leader was reaped.

Supervisor lost (crash, or killed alone) while the app lives: native records
`failed` `process-error` if the run has no terminal (`stopped`
`stop-incomplete` if a Stop is in progress), always with
`groupCleared:false`, which is never later set `true`. It cannot signal the
group (the CLI's parent was the supervisor; once launchd reaps the leader its
group id may be reused), so it keeps draining stdout and stderr without emitting text
and stays `cleanup-pending` until both read ends reach EOF. EOF needs no
process id: no live process still holds a write end. If they never close, the
participant stays busy until the app quits. Reading (R1-f, passed by
Codex's re-review, inbox 6c69b7ad, report 089b699): a failed read (any error but EINTR) is not EOF; closing native's read
end proves no writer gone, so after one on either pipe a lost supervisor's run
stays `cleanup-pending` until the app quits, even after the run's updates
finish.

Limits, stated plainly: cleanup covers members of the CLI's process group
that die on SIGKILL. A descendant that calls `setsid` or `setpgid` leaves the
group and escapes every probe and signal; section 16.1 checks that the pinned
CLI does not do this. A group from an earlier launch is untracked: native
keeps no process id, cannot prove it gone, and does not let it block a start.
Its supervisor's parent-death cleanup (section 11) is its only bound.

## 11. Process rules

The pinned binary runs with exactly `-p --safe-mode --restricted
--disable-slash-commands --tools "" --strict-mcp-config
--no-session-persistence --output-format stream-json --verbose
--include-partial-messages --model <pinned>`, never `--bare`,
`--fallback-model` or `--mcp-config` (all in `claude --help` 2.1.283;
`--strict-mcp-config` with no `--mcp-config` at all is Codex's F0 answer 10).
Environment: only `HOME`, `USER`, `TMPDIR`, `LANG`/`LC_ALL` from the app's
own, then fixed values (answer 10) that the app's pass and the supervisor's
pass each set, whatever the app's environment holds (an inherited value for
one of these names is dropped, never passed on):
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`,
`CLAUDE_CODE_DISABLE_ATTACHMENTS=1` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`;
in an empty app-owned 0700 folder. Init expectations are recorded under
exactly this argv and environment. These do not make the CLI network-silent
(a login refresh and the model request still reach Anthropic), and an
effective managed policy must not silently override them (section 5's
checks). Section 5's availability subprocesses take this same environment
rule (built inactive in F3, awaiting review: section 5). Production code carries
this argv and environment, still inactive (no lane constructs a run).
Input goes to stdin (SIGPIPE disabled), then closes. Output and stderr are
bounded; stderr maps to fixed reasons. The log holds only ids, event types,
byte counts, exit codes and reasons. One live run per app.

- Supervisor: for each run the app spawns a small helper bundled and signed
  with it, in its own process group, with `POSIX_SPAWN_CLOEXEC_DEFAULT` and
  exactly five descriptors: the CLI's stdin read end, stdout and stderr write
  ends, a lifeline pipe's read end and a control socket. The app keeps the
  lifeline's write end, close-on-exec, so it closes only when the app process
  ends. The supervisor spawns the CLI with `POSIX_SPAWN_SETPGROUP` (a new
  group) and `POSIX_SPAWN_CLOEXEC_DEFAULT`, passing only stdin, stdout and
  stderr, then closes its copies; CLI text never passes through it. The app
  closes its copies of the CLI's pipe ends once the supervisor is spawned, so
  EOF on its read ends means no process holds the write ends. Control
  messages are fixed and textless: `stop` (also a cleanup retry) in;
  `spawned`, `spawn-failed`, `exit <status>`, `cleared`, `uncleared` out. The
  supervisor ignores SIGPIPE and sets `SO_NOSIGPIPE` on the socket; a failed
  write means the app is gone, so it stops reporting and finishes cleanup. If
  the socket closes before `cleared` while the app lives, section 10's
  supervisor-lost rule applies.
- Group: the supervisor reads the CLI's exit status without reaping (kqueue
  `NOTE_EXIT`, `NOTE_EXITSTATUS`) and reaps the leader only after a probe
  finds the group empty, so its group id stays reserved. Stop sequence:
  SIGTERM the group, wait up to 10 s, one SIGKILL, probe 2 s with
  `proc_listpids(PROC_PGRP_ONLY)` ignoring the zombie leader. Never signal a
  group whose leader was reaped. After any exit, probe and stop what remains.
  The app's stop path reads memory only and writes `stop` before any store
  access.
- Parent death: lifeline EOF, or kqueue `NOTE_EXIT` on the app's pid
  (registered, then confirmed with `getppid()`), starts cleanup at once:
  SIGTERM the group, SIGKILL at 3 s, probe until 6 s, reap, exit; a Stop in
  progress is cut to the same bound. If the app is gone before the CLI is
  spawned, it spawns nothing. A supervisor lives until its group is cleared
  and reported, and at most 6 s after the app dies. It is not a launchd job,
  login item or lasting service; none exists without a run or an owned
  uncleared group.
- Parent-death test, before section 16: a test-target host starts the real
  supervisor with a fake CLI that ignores SIGTERM and forks a child in its
  group; the test SIGKILLs the host, not its close handler, and within 10 s
  `proc_listpids(PROC_PGRP_ONLY)` finds no member and the supervisor is gone.
  Variants: kill while `starting`; kill during a Stop's wait; a host that
  closes the lifeline without exiting; a fake leader that exits on SIGTERM
  while its forked child ignores it (the zombie leader keeps the group id
  reserved); a host that leaks the lifeline's write end to a sleeper process
  before it is SIGKILLed, so lifeline EOF cannot report the death and cleanup
  must still be bounded within 6 s (control EOF, `NOTE_EXIT` or the periodic
  `getppid()` check may start it; Codex F2-M2); a test-build supervisor that
  records why, with the control socket leaked too, so `NOTE_EXIT` must report
  it; a test-build supervisor that pauses before registering `NOTE_EXIT` while
  the host is killed, so the `getppid()` check must catch it. Supervisor-loss
  test: SIGKILL only the supervisor mid-run; the run records `failed`
  `process-error` with `groupCleared:false` and another Start is
  `participant-busy`; the test then kills the fake by its own recorded
  process id, and once the pipes close Start is accepted.
- Init rule: `model` is the pinned model; `tools` and `mcp_servers` empty;
  `slash_commands`, `skills`, `plugins` and `apiKeySource` equal the values
  recorded in section 16's run. Else `failed` `process-error` at sequence 1.
- Overflow rule: text is held until a rate-limit message shows
  `overageStatus` `rejected` with `isUsingOverage` and `overageInUse` not
  true. The run fails `paid-overflow` on any other `overageStatus` or a true
  flag, or if a result arrives first (API-key sessions never carry rate-limit
  information). A missing `overageStatus` means unverified, not off: text
  stays held and the run fails closed at the result (Codex F0 answer 8);
  neither `status` `allowed` nor `isUsingOverage:false` shows that paid
  overflow is disabled. The preventive control is the account's extra-usage
  setting being off. This rule acts after the provider answers: a late event
  may stop later work, but it cannot prevent or reverse a charge already
  incurred.

Field names come from the 2.1.283 stream schema in the installed binary, not
from a run.

Packaging (F2, 2026-10-11): the helper is now bundled and signed in the test
copy only (`package_app.sh --test-identity`: `Contents/MacOS/ParticipantSupervisor`,
ad hoc, identifier `com.trueconvo.voice-cursor.test.participant-supervisor`,
the app signed after it without `--deep`). It is still inactive: no lane, no
activation, and the release app does not carry it. `PackagedSupervisorTests`
runs this section's shipping parent-death variants and the live
supervisor-loss run (`process-error`, `groupCleared:false`, owned until the
pipes close) against that bundled helper, after checking that the copy's
`TCSourceCommit` is the checkout's HEAD; unset, the tier is skipped and
supplies no packaged evidence. The supervisor-loss test's `participant-busy`
and Start-accepted parts stay in the scripted coordinator tests. Question 21,
as Codex's F2 review ruled it (PASS with two nonblocking follow-ups, exact
candidate 4a431db; F2-M1 and F2-M2 were fixed in c2ff10e and c78abf0 and
passed Codex's F1 review of fd8a38e, report 3f885db): split evidence counts
for section 16.4's packaged-helper
mechanism with FakeCLI and the test host, when both layers come from the same
exact candidate: the packaged tier against a copy packaged from that commit,
and the test-build-only checks below from that same commit. The core module
is shared, so any change to it needs both layers again. Each evidence receipt
keeps the exact candidate and the separately reported clean checkout: the
tier reports a checkout with local changes but does not refuse it, so a
matching `TCSourceCommit` alone is not proof of an unmodified reviewed tree.
The packaged runs prove bounded cleanup outcomes; they do not say which
trigger started a cleanup. Two checks stay test-build-only, with the same
supervisor core and driver plus test-only hooks: the pause before `NOTE_EXIT`
is registered (`parentChanged`, no CLI spawned) and which trigger caused a
cleanup (`appExitNote`, with lifeline and control both leaked). Pause or cause
hooks, and the pausing program, never go into the shipped helper. Killed while
starting records the branch each run took (`cli-spawned=yes` or `no`); one run
is not evidence of both. This is not proof that the real CLI cannot escape,
nor all of section 16, nor the activated app's termination wiring: section
16.5's blocked-save test and F0 answer 22's real `NSApplication.terminate`
proof remain separately required.

## 12. Refusal reasons and page mapping

| Reason | Why it is needed | Where |
| --- | --- | --- |
| `run-not-found` | The claim names a run the record lacks, or twice. | commit |
| `run-not-prepared` | Commit: not the exact prepared form. Start: the run was stopped before it started. | commit, start |
| `run-mismatch` | Claim, ids, participant or input hash differ from the record, entry or pin at prepare. | commit, start, stop, status, events |
| `duplicate-run` | Run or message ids already known, or another request started or is starting the run. | commit, start |
| `unknown-run` | Never prepared (including a preparing commit not yet durable), or introduced without its claim. | commit, start, stop, status, events |
| `participant-unavailable` | Availability failed at start. | start |
| `participant-busy` | Another run is starting or live, or any run is `cleanup-pending`. | start |
| `participant-changed` | The run was prepared for a participant identity native no longer pins. | start |

Oversize input reuses `text-too-large`; an oversize run `payload-too-large`.

Start: `ok` is **accepted**. **unknown** (ask status): `duplicate-run`,
`payload-mismatch`, `store-corrupt`, `store-missing`, outcome `unknown`,
transport failure or timeout. Any other refusal is **not-started** with its
reason; retryable only for `participant-busy`, `participant-unavailable`,
`store-locked`, `unknown-connection` and `stale-generation`, else permanent
for the run. Not-started means this request dispatched nothing, not that no
earlier attempt did: events that contradict it latch the run unknown. The page
starts only after its preparing commit is confirmed saved, so a start's
`unknown-run` is not the not-yet-durable window and stays permanent. A
start's `run-not-prepared` always means the run was stopped before it
started, a confirmed cancellation of this run; copy may say "Stopped before
it started".

Commits with `participantRun` map as in v1. Stop: `exited` with
`groupCleared` `true` or `null` is **confirmed** with `terminal`;
`cleanup-pending` is **cleanup-uncertain**, owned (native still tracks it
and blocks starts, even without a supervisor); `exited` with
`groupCleared:false` is **cleanup-uncertain**, not owned; refused
`unknown-run` is **not-prepared** (native has no durable prepared receipt
now; never a cancellation); anything else, including `not-owned`,
**unknown**. Status: `ok` is the status result, else **unknown**.

## 13. Page changes

Codec: `advertisedOperations` gains the five names as optional entries (not
in `NATIVE_PROOF_OPERATIONS`); the issuable guard, `NativeProofOperation` and
the client's operation set gain them; `reasons` gains the eight;
`commitProof` metadata allows `participantRun` of the exact shape, never with
`dictationDeliveryId`; `decode` gains the five `ok` variants with nested
event, `lost` and `terminal` checks, and decodes a `participant.*` `unknown`
as a settled result, not silence until timeout.

Client and recovery:

- A separate `NativeHostClient` and codec for `participant.*` with its own
  capacity, never waiting on saves: timeouts 20 s for start and 15 s
  otherwise, `maxWireBytes` at least 1,114,112, a fresh request id for every
  poll and user retry, and timers that end with the controller.
- The repository save boundary derives the one `participantRun` for every
  save introducing a prepared run: ordinary saves, global Retry and
  reconciliation. An unknown commit is resolved by resending its original
  envelope, never a rebuilt request under its id.
- Reads: on each `ready`, on restoring an unfinished run, and after 15 s
  without a push while an open run is visible or owned: `participant.status`,
  then `participant.events` from the controller's last accepted sequence (the
  saved sequence on restore). Reading is not dispatch. At 64 pages the
  adapter returns what it has with `more:true`; the controller keeps those
  events and continues. After any terminal, however it arrived (push, events,
  Stop or status), the page reads `participant.status`, and keeps reading
  every 15 s while `groupCleared` is `false`.
- Restored runs: a restored record, empty event list, load, reconnect or poll
  grants no Start. Only an explicit user Start after a fresh
  `participant.status` of `not-dispatched` for the same `runId` dispatches,
  with a new request id; until the port has `status`, restored runs stay
  read-only. The same holds in one launch after an `unknown` start. This is
  the page's rule; native's identity layer may still admit a start under an
  id a proven absence released (section 7, Codex S8 answer 1), which never
  permits the page to resend one by itself.
- A recovery-only port (Start disabled) exists whenever the five are listed,
  even when unavailable. A run whose prepared `participant` differs from
  native's current pin gets a restored-mode controller with a recovery-only
  port whose `identity` is the run's own prepared participant (2e1f37d's
  controller refuses a port with any other identity). It gets status, events
  and Stop; Start stays disabled, and native would refuse it
  `participant-changed`.
- No dispatch while any run, in any session or controller and after reload,
  has output or a terminal not confirmed saved: first recover and save it, or
  save a permitted closure that claims no omitted text. The controller
  rechecks its latches immediately before each dispatch.
- A not-prepared Stop keeps the local Stop latch, so a late preparing commit
  cannot lead to a dispatch; once it settles, the page Stops or reads again.
- Cleanup: the page keeps `groupCleared:false` and never shows it as
  stopped. Any terminal (`stop-incomplete` or a native end) closes the
  transcript, not cleanup: `cleanup-pending` keeps a Stop control and status
  reads continue until `groupCleared` is `true` or the state is `exited`.
- Closures are page-only; native never reads them and they stop nothing.
  2e1f37d's `{kind:'unknown', reason:'user-closed', at}` and
  `{kind:'interrupted', reason:'event-refused'|'workspace-limit', at,
  terminalEvent}` gain `{kind:'interrupted', reason:'replay-lost', at,
  terminalEvent, lost:{fromSequence, throughSequence, reason}}`, allowed only
  when an events reply's `lost` runs from the run's `lastSequence + 1` to
  `terminal.sequence - 1` with a real recorded `terminal`. It keeps the
  accepted prefix and `lastSequence`. Without a terminal the run stays
  unknown and offers explicit user closure. An out-of-order terminal is
  buffered and reconciled, never by itself evidence of loss.

Port results; the port gains `status(target)`, and `reconcile` pages
`participant.events`:

```ts
type ParticipantStartResult = { kind: 'accepted' } | { kind: 'unknown' }
  | { kind: 'not-started'; reason: string; retryable: boolean };
type ParticipantStopResult = { kind: 'confirmed'; event: ParticipantTerminalEvent }
  | { kind: 'cleanup-uncertain'; event: ParticipantTerminalEvent; owned: boolean }
  | { kind: 'not-prepared' } | { kind: 'unknown' };
type ParticipantStatusResult = { kind: 'unknown' } | { kind: 'status'; state: StatusState;
  lastSequence: number | null; terminal: ParticipantTerminalEvent | null; groupCleared: boolean | null;
  unknownReason: 'store-unreadable' | 'start-uncertain' | 'exit-unrecorded' | null };
type ParticipantReconcileResult = { kind: 'events'; events: ParticipantEvent[]; more: boolean }
  | { kind: 'lost'; lost: LostRange; terminal: ParticipantTerminalEvent | null } | { kind: 'unknown' };
```

`StatusState` is section 10's states, `LostRange` section 9's `lost`. An
`afterSequence` above a non-null `lastSequence`, or pages that disagree about
an event, give `unknown`; a growing `lastSequence` does not.

## 14. Lifecycle

| Event | Native action | Pushes | Retained text | Durable writes | Page sees |
| --- | --- | --- | --- | --- | --- |
| Lock (manual, macOS, inactivity) | Lock flag; `stop` to every supervisor; stop finishes in background. | v1 `locked`, then none. | Dropped (`locked`). | Terminals held, written at unlock. | `exited`; unsaved text `lost`. |
| Unlock | Nothing restarts. | v1 fresh document, `ready`. | None. | Held terminals. | As above. |
| Reload, navigation, web content crash | Run continues. | v1 `revoked`; later events to the new connection. | Kept. | None. | Pages from saved `lastSequence`. |
| Desk window close | v1 revoke; stop every group (12 s); write terminals; then close the store. | v1 `revoked` (`shutdown`), then none. | Dropped (`closed`). | Terminals. | `exited`; `lost`. |
| Quit | Delay termination; as close, bounded at 17 s overall for every participant obligation (Codex Q33), then quit anyway. | Same. | Gone. | Terminals if in time. | `exited` or `exit-unrecorded`; `lost` (`restarted`). |
| Crash, force quit, `kill -9`, power loss | Supervisors clean up within 6 s (section 11); after restart native signals nothing. | None. | Gone. | None. | Started: `unknown` `exit-unrecorded`, Stop `not-owned`; never started: `not-dispatched`. |

Orphaned runs and earlier launches' groups are not busy. Quit while locked
leaves `exit-unrecorded`.

Codex's lifecycle answers to the coordinator questions (4ca10c1f): Q21, one launch-scoped coordinator
that keeps text-free run memory and owned groups across close and reopen,
never routing a late reply or push into an old or different generation;
Q31, every new Start stays busy across sessions and close/reopen while a
terminal or cleanup write is unresolved; Q32, only text-free pending
terminal and cleanup metadata is kept, for the exact same workspace folder
in this launch, flushed after its legitimate unlock, with no key kept to
pass the lock, no wrong-folder replay and no stale connection reuse, and a
quit while locked invents no write; Q33, below; Q34, silence is fine for
these unreachable inactive slices.

Readings (S10, passed by Codex's S10 review, inbox fcc67dfe; where S11
amends one, that amendment says so, and Codex's S11 review accepted it,
inbox 237d63fc, ruling (d)):

1. Order of calls. Lock: the lane's `lockNow()`, then the host's `lock()`.
   Unlock: the host's `unlock()`, then the lane's
   `unlock(ifNoLockSince:)` with the lock epoch read when verification
   began, for a kept locked stack and a stack built by the unlock alike
   (S11 reading 4 as replaced by the S11 follow-through; its earlier
   amendment here, which read it at the host's `unlock()` entry for a kept
   stack, is withdrawn). Window close and quit: the lane's
   `beginShutdown(quitting:)` (false for a window close, true for the app's quit), the host's
   `revokeForShutdown()`, the lane's `finishShutdown(quitting:)` with the
   same value, the host's `closeStore()`, then the lane's detach. `close()` is still
   `revokeForShutdown()` then `closeStore()` for every existing caller. The
   table's "revoke; stop every group" keeps its meaning: both steps are
   synchronous with nothing observable between them, and the lane's comes
   first because its push suspension must precede `revoked` (section 8).
   (Amended by S11 reading 6, which Codex's S11 review accepted, ruling
   (d): that holds
   for a window close; on quit, Codex Q33 puts the lane's step at the
   termination reply, so the page can observe the gap before `revoked`.)
2. Lock is synchronous and idempotent on the app's thread, waiting for no
   lane work but a participant push already under way (section 8): the flag, a new epoch (moved by every call), pushes
   suspended, `stop` to every live run's supervisor (a cleanup-pending
   group's `stop` is one more cleanup retry), and the text dropped
   (section 9). No participant write is attempted while locked. Unlock
   applies only if no lock came since its epoch; then nothing restarts, and
   the held terminal and cleanup writes are queued once for the attached
   stack's folder (section 10). A newer lock leaves everything locked.
3. Window close waits for every start in progress to end, every spawned
   run's terminal, and their writes, bounded as quit is (reading 5); it does
   not wait for cleanup. A cleanup-pending group stays owned by the
   coordinator across close and reopen (Codex Q21): every start stays busy,
   status and Stop answer it from memory, and its later `groupCleared:true`
   is written through the reopened stack. A reopened stack must be the same
   workspace folder; a closed store is refused (its writer lock is
   released and never reused). The closed flag holds until the next
   attach, so nothing is kept or pushed with no window. No stack attaches
   while a close is under way, before its detach (an attach still
   refreshing its store when a close or quit begins attaches nothing), nor
   at all once a quit began: nothing reopens starts or pushes while one
   runs.
4. Window close while locked, and any write held when the stack goes:
   nothing is written; the text-free metadata stays in memory for this
   launch, written only once both a stack over the same folder is attached
   and no lock is in force (Codex Q32).
5. Quit (Codex Q33): one overall maximum of 17 s from the quit's
   `beginShutdown(quitting: true)`, `ParticipantLimits.shutdownMillis`, for
   every participant obligation together: starting, live, stopping,
   cleanup-pending, or terminal or cleanup writes pending, with or without a
   Desk window or stack. The lane reports them (`obligations()`, read after
   the quit's `beginShutdown`, so no start can be admitted after the choice);
   the host's plain 3 s path applies only when there are none (S11 wires
   that choice). There is no separate bound per run or phase: the stop
   sequence's 12 s and any write share the one 17 s, and calling
   `finishShutdown` again never extends it. A quit during a window close
   shares that close's bound (it then ends at most 17 s after the quit
   began, sooner when the close began earlier); a quit after one ended, with
   no window, begins its own. The quit's start is kept for the launch: it
   does not move however late its `finishShutdown` comes, a close's detach
   between the two calls included. A confirmation revocation still with its
   owner (section 17) keeps starts busy but is not an obligation here: its
   owner call returns promptly and nothing is written for it, so a quit
   neither waits for it nor takes the participant bound for it (S10 choice,
   accepted by Codex's S10 review, inbox fcc67dfe, ruling 2, under the
   current contract: the confirmation is launch-local, the owner call
   returns promptly and no durable revocation write is owed; a persistent
   approval or a required asynchronous cleanup there would reopen it).
   Quitting waits also for groups to be confirmed gone or released and for
   every run's updates to end. With no stack or while
   locked it writes nothing; with a stack, beyond the writes its runs'
   updates queue, it makes at most one more bounded pass for writes still
   owed. At the bound it returns whatever is unfinished: nothing it waited
   for is cancelled, nothing stands in for a write that did not happen, and
   a write that lands after the store closed fails and stays owed in memory
   only, so the next launch reads `exit-unrecorded`. Parent-death cleanup
   (section 11) still bounds every group once the app is gone.
6. Quit while locked (Codex Q32): nothing is written, and the next launch
   reads `exit-unrecorded` for a run whose terminal was held.
7. Detach, precisely (Codex S7 and S8): it refuses every new request
   (`unknown-connection`), every push and every new piece of store work
   through the let-go stack's store, and stops a start in progress from
   spawning. Store work already handed to the executor is drained, not
   recalled: a never-spawned terminal's write still returns its own result
   to the Stop that made or joined it (S7's cross-stack case: `store-locked`
   once that store closed). Every other request admitted on the stack that is
   still waiting answers `unknown-connection`, even when the same store is
   attached again (each attach is its own epoch), and a re-read that returns
   after its stack was let go decides nothing, nor does one that had not
   reached the store when its stack was let go start there; a request on
   another stack never joins it, but waits for it and re-reads through its
   own stack. A never-spawned terminal such a drained write leaves owed is
   queued once more through the stack attached when it returns (section 10,
   ruling (c)). A window close's detach ends that close's bound; it never
   ends a quit's (reading 5). Suppressing a reply to a document that is gone
   is the transport's (S11).

Readings (S11; Codex Q21, Q33, Q34, S7, S10 and S9 ruling (c)). Codex's
S11 review (inbox 237d63fc, report a819387) passed them and, in its ruling
(d), accepted readings 1-10 with its stated limits, recorded in readings 6
and 9 and in sections 3 and 8. The app wires none of this: its session has
no lane.

1. One lane per launch. The Desk session makes its lane once, with its first
   stack, and keeps the same object across every close and reopen.
2. Each stack, in order: the lane builds its host over a new store on the
   same folder; the lane is attached with that host, store, registry and
   the stack's own sink; after an owner's check, the lane's unlock
   (reading 4); the lane's one bounded pass of the writes it owes (section
   10, ruling (c)); the dispatch recovery, if the store holds an unresolved
   dispatch; then the page loads. A refused attach shows nothing, closes
   that store and leaves the Desk unable to open until the next unlock,
   unless a window close or the app's quit came meanwhile: then it is an
   abandoned open (logged `window-closed` or `quit`), not a failure. A
   window close or quit that lands after the attach lets the attached stack
   go in S10 reading 1's close order, as a quit when it was one, never
   shown; a lock that lands there leaves the new stack locked.
3. Lock: the lane's `lockNow()` runs first and synchronously in every state
   of the session (open, locked, unlocking, closed, locked with no stack,
   unavailable), before the host's step, which a menu or signal lock leaves
   to a task an alert can hold up. With a lane, the Mac's lock signals reach
   the session in every state too. Changed by the S11 follow-through
   (accepted, ruling (d)): the host's step does not call `lockNow()` again
   for the session's lock (`DeskWebViewHost.lock(laneLockedByCaller:)`), so
   each lock request moves the lane's epoch exactly once; a host used
   without the session still locks its lane first itself (`lock()`). Before,
   the host's own `lock()` called it again and the repeat moved the epoch.
4. Unlock, after the owner's check only. Replaced by the S11 follow-through
   (accepted, ruling (d); Codex's carried requirement 4): the lane's epoch
   is read once, when the owner check begins (or when the lane was made, if
   that was later), and the lane's `unlock(ifNoLockSince:)` carries it in
   both cases: after a new stack is attached, and, for a kept locked stack,
   queued by the host's unlock step, which the session hands that epoch
   (`DeskWebViewHost.unlock(laneEpoch:)`). So a lock observed anywhere from
   the start of the owner check, through the host's unlock step, until the
   lane's unlock applies under the coordinator's own lock, refuses the
   lane's unlock: a lock request the session sees during the check drops
   the whole unlock before the host is asked; one during the host's step
   leaves host and lane locked; and one that reaches only the lane (its
   epoch moved, as by a direct `lockNow()`) leaves the lane locked even
   though the host unlocked, which is the safe side. What changed from the
   earlier reading 4: a kept stack's lane unlock no longer reads the epoch
   at the host's unlock step's entry. That later read had covered a menu
   lock whose host step ran in a task after the next unlock's check began
   and called `lockNow()` a second time; reading 3's change removes that
   second call, so the check's own epoch no longer refuses an unlock that
   no later lock request overtook. A host used without the session (tests)
   reads the epoch at its `unlock()` entry. The host's step never awaits the
   lane's unlock (no new hop or step in lock or unlock); the session waits
   for it, in both cases, before the page loads, so the page's first
   request finds the lane unlocked and its first commit waits for the
   writes the lane held. Reopening a closed Desk asks nobody and unlocks
   nothing.
5. Window close: the lane's `beginShutdown(quitting: false)`, then one host
   step with `revokeForShutdown()`, the lane's `finishShutdown`, and
   `closeStore()`, then the lane's detach. A second close while one runs
   waits for it rather than letting the stack go under it. The window stays
   up while it runs, silently (Codex Q34).
6. Quit (Codex Q33). With a lane, the app's termination reply calls
   `beginShutdown(quitting: true)` synchronously before returning
   `.terminateLater`, then reads `obligations()` off the main actor. One
   time limit of 17 s from that call applies whenever anything is owed, and
   while the answer is not yet in; the plain 3 s limit applies only once
   the lane said nothing is owed (at 3 s, or as soon as that answer comes
   after it). They never add up. The stack, if any, closes as a quit (S11
   reading 5 with `quitting` true; a quit during a window close waits for
   that close), then the lane's own `finishShutdown(quitting: true)` runs
   within the same bound (the only wait when there is no window), and the
   app gets its one yes when that ends or at the limit. A session with a
   lane always answers `.terminateLater`, even with no window and nothing
   owed, because the answer is not known synchronously; it then replies as
   soon as the lane has nothing left. Inside a main-queue job no main-actor
   task runs before the reply, so the close waits as before; the lane was
   already told, its answer still arrives, and the chosen limit still fires
   in the nested wait (owed work then holds the quit for the full limit,
   since only that task replies early). Q33's synchronous call also means
   that, on quit, the page can observe a gap before `revoked`: the page is
   first asked whether it holds unsaved work (up to about 2 s), and
   meanwhile participant starts answer `store-locked`, participant pushes
   have stopped and events give `lost` `closed`, while the page's
   connection is still valid and its v1 requests are answered. This amends
   S10 reading 1's "nothing observable between them" for a quit. Codex's
   S11 review accepted this gap (ruling (d)): shutdown stops new starts and
   push production before the asynchronous page question and the host's
   revocation, answers to requests admitted before the shutdown are
   dropped, and the one overall timer starts at the shutdown. A commit in that gap still waits for the lane's
   pass (section 10, ruling (c)). Since the follow-through's review, an
   answer to a request admitted before the quit began is dropped, whenever
   it is ready (section 3); requests admitted in the gap are answered as
   above. Checked with the real coordinator through the real termination
   reply both ways: with a run streaming (reading 9) and with nothing owed
   (the page's question skipped), when the lane says so, the 3 s limit is
   chosen and the one yes comes well inside it. As that ruling limits it,
   the two kinds of check prove different parts: the fake-lane tests prove
   the timer inside the nested wait, and the real-coordinator tests prove
   the ordinary main-actor path. Neither is an end-to-end trial of a real
   `NSApp.terminate`.
7. S9 ruling (c)'s remaining boundary is wired (section 10, after ruling
   (c)'s S10 paragraph): a page's commit, in the WebKit message handler,
   and a stack's dispatch recovery, in the session, each wait for the lane's
   one bounded pass first. Outside the lane nothing else in the app writes
   workspace state once a stack is open (opening a store, and a read's
   retried folder flush, write no new record).
8. (S11 follow-through, accepted, ruling (d); Codex's carried requirement
   1.) The lane the session carries is the real `ParticipantCoordinator`
   (section 2's reading): it builds each stack's host, is attached to it
   with the stack's own sink, and is let go after its store closes, the
   same object across every close and reopen of a launch. Still inactive:
   only tests construct one.
9. (S11 follow-through, accepted, ruling (d); Codex's carried requirement
   2.) End-to-end proof, invented data only: the built page in a real
   `WKWebView`, through the app's `DeskSession`,
   `DeskWebViewHost` and WebKit glue, to the real coordinator, whose runs
   are scripted on a virtual clock moved along with real time (the real
   run core and stream reader, a simulated process group; never the real
   CLI). The page's own participant client asks for availability, the
   picker saves the choice, Send prepares the run through
   `workspace.commitProof` before `participant.start`, the streamed text
   appears, and the page's Stop records `stopped`. A second run goes on
   across a reload, its later events pushed to the new connection only and
   shown by the new page. A lock while it streams (with a push under way:
   section 8's S11 follow-through reading) stops it, drops its text
   (`lost` `locked`), pushes nothing more, and holds its terminal until the
   unlock writes it. A window close with a third run streaming ends well
   inside 17 s; its `stopped` terminal is read from the run folder on its
   own right after the close, before any reopen could write it. Once runs
   one to three settle, the coordinator reports nothing owed. A quit with a
   fourth run streaming takes the participant bound and answers once, well
   inside it, leaving no participant write owed and the fourth terminal on
   disk, read the same way. It runs only with `TRUECONVO_DESK_BUNDLE` set,
   is skipped when it is unset, and fails when it is set but names no built
   Desk. Page provenance: the next combined run uses the native-proof build
   of the page in the activation base (page source today equal to main
   38ef649, which includes NF-1 65fe9a0 and the integrated navigation fixes;
   if reviewed NF-2/NF-3 changes join the combined candidate first, the page
   is that candidate's), and that run records the exact commit its bundle
   was built from. The Mac gate attributed in Codex's S11 review ran it with the 3c51a28 page
   bundle. What it does not show: native stale-answer and stale-push
   suppression (it sets up no stale case, and it counts pushes where the
   sink's observer logs them, before the delivery check; reading 10's tests
   hold that), the renderer check section 7 leaves open, and the quit inside
   `NSApp.terminate`'s own nested loop (the test drives the termination
   reply on the main actor; reading 6's nested-loop behaviour rests on the
   fake-lane tests).
10. (S11 follow-through review; accepted, ruling (d).) The stale-answer
   rule of section 3 is checked with a fake lane and the invented page: an
   answer held across the lane's `lockNow()` or `beginShutdown` alone (the
   host's step not yet run, the connection still valid) is dropped and the
   asking page gets only the fixed failure; with the host's lock step held
   before it revokes anything and the lane's epoch unmoved, an answer and a
   participant push for the still-valid connection are both dropped by the
   host's flag; and a push queued from inside the lane's step during the
   host's lock or close is dropped the same way. Each check was shown to
   fail with its own guard removed. The real coordinator's
   `lifecycleEpoch` moves on every lock and shutdown begin, repeats
   included. A session lock that lands during the host's unlock step, after
   it reopened the store, leaves the host, the session and the real
   coordinator locked, and the next verified unlock opens all three.

## 15. Limits and storage

| Item | Limit |
| --- | --- |
| Event text | 1-16,384 bytes, coalesced (section 8) |
| Input | chunks 1-16,384 bytes; total at most 262,144 |
| First-trial input bound | total at most 4,096 UTF-8 bytes (section 17) |
| Input plus output | at most 262,144 bytes |
| Serialized run | at most 786,432; prepared or open at most 785,408 |
| Record, envelope, text item | v1: 1,048,576; 1,114,112; 65,536 |
| Events page | 1-64 events; reply at most 1,048,576 canonical bytes |
| Live runs | one per app; one unfinished per session (page rule) |
| Stop; checks; parent death | about 12 s; 5 s each, 12 s total; 6 s |

`state.json` gains `runs`, outside the receipt log and never evicted (no
barrier, reconcile or 512-entry eviction). `formatVersion` stays 3; a file
without `runs` decodes as `[]`. Each entry is exactly `{runId, sessionId,
userMessageId, assistantMessageId, participant, createdAt, inputHash,
inputBytes, preparedBytes, prepareRequestId, preparedRevision, start,
terminal, groupCleared}`. `participant` is the exact prepared `{id, label,
model, executionHost}`, written once at prepare; start compares against it.
`start` is `null` or `{requestId, payloadHash, at, launchId, cliVersion}`;
`terminal` `null` or `{type, sequence, at, reason}`.

Load invariants, else the store is corrupt: run and message ids unique across
entries; each `prepareRequestId` names an `ok` identity with that `runId`, and
each identity `runId` an entry; no `start.requestId` is a commit identity;
`participant` has four nonblank strings of at most 256 bytes; terminal
sequences at least 1; `start:null` allows only no terminal or `stopped` at
sequence 1; `groupCleared` non-null only with a terminal, and never `null`
with `stop-incomplete`.

Codex's storage answers (October 10, Q2-Q5) make these exact. A failed
invariant makes the whole store corrupt, like any damaged `state.json`:
never reseeded, repaired or overwritten. `runId`, `userMessageId` and
`assistantMessageId` share one namespace across all entries, ignoring case; a
`sessionId` may recur across runs, and within one entry all four differ
ignoring case. The `prepareRequestId` identity also has the entry's
`preparedRevision`, and a start id is no ledger, receipt or other start id
either. Each entry also keeps sections 6, 8 and 10: `inputBytes` 1-262,144,
`preparedBytes` 1-785,408, `completed` at sequence 2 or later, and
`start:null` with a terminal only as `stopped` `local-stop` at sequence 1
with `groupCleared:null` (nothing was spawned). A store with no runs writes no
`runs` key. Format 3 with `runs` is for
the inactive, invented-data stores only: an older build drops `runs` on its
next write, so downgrading a store that holds runs is unsupported, and a
reviewed forward-only format marker that older writers refuse must replace it
before any enabled or reusable-store build. The published runs copy holds
durable writes only; a start visible but not yet durable has its id reserved,
never replayed `ok`, until an authoritative re-read settles it.

The runs list, log and event buffers hold no prompt or reply text, account
field, process id or path; the page's record (and `attempted/<id>.json` after
a conflict) is stored as in v1, with text. Memory only: groups, supervisors
and their sockets, pipes, held and retained text, counters, start and stop
state, held terminals, availability.

## 16. Acceptance before private use

Participants stay unavailable until all pass, on invented text:

1. One run proves argv, environment and streaming, records the init values,
   and shows a rate-limit message with `overageStatus` before the result.
   Throughout, walking `proc_listchildpids` from the CLI finds every
   descendant still in its process group; if any leaves, participants stay
   unavailable.
2. `@/tmp/invented-canary` and `/config` in the input stay inert: no canary
   file read, no canary text in the reply.
3. No new text under `HOME/.claude` (history, projects, paste cache, todos,
   debug logs).
4. `kill -9` of the app mid-run, and during a Stop's wait, leaves no live CLI
   and no supervisor within 10 s (section 11's mechanism and test).
5. Stop works while a commit is blocked in fsync.
6. `claude auth status` makes no network request, or the user approves it.

## 17. Owner confirmation that paid usage is off (approved direction; built inactive in plan F4, awaiting review)

No local, nonbilling check reads the paid-usage setting (Claude's "usage
credits", formerly "extra usage"), so every run is blocked today. On
2026-10-10 the user chose this direction for a limited first trial (option A,
inbox 4b9e1f62 and 2dbde293). It replaces the earlier proposal of a 30-day
Touch ID record signed by a Secure Enclave key, which is withdrawn: their Mac
Studio keyboard has no Touch ID, and nothing is stored now.

- **Before.** The user opens claude.ai Settings > Usage and checks that usage
  credits are off. True Convo cannot see that setting and never claims to.
- **Confirming.** In the app's native window (never the page), they confirm
  with macOS device-owner authentication (LocalAuthentication
  `.deviceOwnerAuthentication`). macOS shows its own dialog, which accepts
  the Mac login password, or an Apple Watch approval where macOS and the
  Mac's policy support it.
  True Convo never collects, receives, stores or logs the password; there is
  no password field in the app or the page. The page can neither start nor
  answer the dialog.
- **Held in memory only.** A confirmation is `{confirmedAt, cliVersion,
  loginKind, accountIdentity, runsStarted}` in native memory for this app
  launch. `accountIdentity` is compared, in memory, with the account and
  organization from `claude auth status` at every availability check and
  start. Nothing is written to disk, defaults or the Keychain.
- **Scope.** The Claude participant only, invented or non-private text, at
  most 5 runs per confirmation, and no automatic retries. Five runs is a trial
  limit, not a spending cap. A run counts when native commits to the spawn
  (section 7), whether or not the spawn succeeds; a refusal never counts.
  "No automatic retries" means native never re-dispatches and the page never
  starts again by itself after a refusal; section 12's `retryable` only means
  the user may press Send again. The CLI's own internal API retries are
  outside True Convo's control (the environment rule already drops
  `CLAUDE_CODE_MAX_RETRIES`).
- **Short input.** A host with this confirmation built has a first-trial input
  bound of 4,096 UTF-8 bytes in total, below section 6's generic ceiling. It is
  enforced at preparation (section 6, step 6) and again at start (section 7,
  step 11), with `text-too-large` on refusal. Native never truncates, splits
  or makes additional calls, and the page keeps the full draft. It counts
  bytes, not characters, and is not a spending cap.
- **It ends** at app quit; at screen lock, session resign, sleep, screens
  sleeping, logout or power-off; on a CLI version, file identity, login or
  account change; when the fifth run has started; and when native observes
  paid overflow (the backstop below; any `paid-overflow` end is one). The
  fifth run, once started, may finish: ending at the fifth start
  blocks a sixth start and never cancels the fifth. These observers run whether or not the Desk is open, not through the
  Desk's own lock gate. An ended confirmation is never revived; a new one
  needs the dialog again.
- **Availability.** Before a confirmation and after it ends, section 5
  answers `overflow-unverified`, so Send is disabled with that honest reason.
  Stop, status, events, and reading or restoring the saved conversation never
  depend on it (sections 8 and 10).
- **Wording.** The interface says "You confirmed paid usage was off at
  <time>. True Convo cannot see your billing setting." It never says
  "verified", "no charge" or "free". This text never goes in the section 5
  `label`, which is part of the pin compared exactly at preparation and
  start.
- **Backstop, with its limit.** The stream's `paid-overflow` rule stays: on
  any overflow signal the run ends and the confirmation ends. It cannot
  prevent a first charge if the provider setting was actually on.
  Reading (S5 fix R1, passed: Codex's S5 fix recheck, inbox 10e30722,
  report 20bc4a6, found its ordinary paths corrected, accepted its
  interpretations (i)-(iii) and required R1-f, which its re-review passed,
  inbox 6c69b7ad, report 089b699):
  the confirmation's end does not
  wait on the terminal. Native observes overflow at most once per run, apart
  from the terminal and never on the wire: with any `paid-overflow` end; for
  a rate-limit line failing the overflow rule before init, whose end stays
  `process-error`; or for such a line complete in stdout after another end
  was decided, whose terminal stays. After a decision, a result with no
  passing rate limit before it does not count: section 11's result-first
  rule chooses a terminal, and a run cut short by a Stop or timeout normally
  has no rate-limit line. After a decision it reads stdout lines
  only for that signal, within the 1 MiB line and 32 MiB stdout bounds, and
  observes anyway if it must stop reading before stdout's EOF. Reading (R1-f,
  passed by Codex's re-review, inbox 6c69b7ad, report 089b699): a failed
  stdout read (any error but EINTR), before
  or after a decision, is such a stop, not EOF: a buffered partial line is
  never read as complete, and native observes at once. For the terminal,
  stdout then counts as done: a decided run keeps its terminal, text and
  sequence; an undecided one is decided by the existing rules with that line
  unread. It is never cleanup evidence (section 10). Each observation ends
  the confirmation with `endedBy` `paid-overflow` (paid
  usage may have been in use; no new value). It reaches the owner before the
  run's updates finish, which can be after `cleanup-released` (bytes still in
  the pipe after `cleared`). Until they finish, the run counts as live for
  section 7 step 12: a start gets `participant-busy` (retryable). If they
  have not finished 5 s after `cleanup-released` (something outside the
  group holds stdout open), the owner ends the confirmation the same way;
  starts stay `participant-busy` until the updates finish or the app quits,
  as for a lost supervisor's open pipes (section 10). S8 (its relay time
  origin and conservative counting accepted in Codex's S8 review, subject
  to R1 below), as S9 changed it (accepted in Codex's S9 review, ruling
  (d), which neither closes nor weakens R1 below): the coordinator
  applies every update to its memory in order, and ends the confirmation
  through one internal call to this section's owner (not built; tests pass
  a fake). The five seconds are a wake-up on the coordinator's monotonic
  clock from when `cleanup-released` reaches it: a relay reads each run's
  updates as they arrive. The rule is met once the coordinator has applied
  every update and seen their end before the five seconds pass (R1 below:
  an end seen at or after them misses it). As built in S8, each update's store
  write finished before the next update was applied, so a store write still
  running five seconds after the release ended the confirmation too,
  conservatively (an overflow observation could be queued behind it). S9
  changes that as-built rule (Codex Q31): a terminal or cleanup write runs
  in the background behind the update that owes it, so no update, overflow
  observations included, ever waits for a store write, and a slow or held
  write no longer ends the confirmation on its own; only updates that have
  not ended five seconds after the release do. Starts still wait for that
  write (section 7 step 12). Each run ends the
  confirmation at most once, by observation or by the rule. Nothing here
  extends a quit bound. A coordinator built without an owner (the public
  configuration, until this section is built) lowers any available report
  that carries a confirmation to `overflow-unverified`, the display kept,
  so its availability never pairs `available` with a confirmation it could
  not end, and a start is `participant-unavailable` (Codex Q13).

  R1 (Codex S8 review, should-fix; the fix passed Codex's re-review, inbox
  3fb3ffe8, report bd22dca): the wake-up
  alone is no proof the deadline was met or missed. It may run late
  (scheduling, sleep), and cancelling it stops only a wake-up not yet taken
  to run, never one already taken, so it checks the run's state when it
  runs. The coordinator keeps the deadline (the release's monotonic time
  plus 5,000 ms) and reads the monotonic clock when it sees the updates
  end: before the deadline the rule is met, and a wake-up that runs later
  ends nothing; at or after it the five seconds were missed, and the
  confirmation ends even if the wake-up has not run. A run's one end is
  claimed by the first of an overflow observation, the wake-up or such a
  late end; the others find it claimed and call nothing. From the claim
  until the owner's call returns, no start passes admission, so none runs
  while the confirmation may still read active, and the next start's
  availability recheck sees it ended. The wake-up makes its call on its own
  thread and a late end makes it off the coordinator, and nothing waits for
  either: on those two paths every start meanwhile is `participant-busy`
  (retryable; section 7 step 12), and status, events and Stop keep
  answering (status may say `exited` while starts are busy). An overflow
  observation's call the coordinator still makes itself, in the run's
  order, as before R1: every request, status, events and Stop included,
  waits until it returns, and a start is delayed rather than answered busy.
  So the owner, when built, must return promptly: no wait
  on the main thread, no user interaction, no slow or blocking I/O, and the
  confirmation reads ended before it returns. Codex's re-review accepted
  that duty and keeping this one call on the coordinator (inbox 3fb3ffe8);
  the owner, still unbuilt, must meet it in its own exact review before
  activation. No wire
  state is added, and the quit bound is unchanged.
- **Not completable by an agent.** The authentication call sits behind an
  injected native protocol whose fake exists only in the test target, as in
  section 5. Bypass tests: a synthetic click without a completed system
  dialog; any environment variable, defaults key, argument, file or page
  message; and a confirmation from an earlier launch all still give
  `overflow-unverified`.
- **Section 16 still applies.** Its first run (16.1) is itself a live
  request: it needs the user's own OK for that run and a confirmation, and it
  counts against the five. The section 5 provider-override check also reads
  managed settings, which still apply under `--restricted`.
- **Showing it.** The page shows the state from section 5's display-only
  `confirmation` object (Codex chose this, inbox c69044cc; no new reason).
  "Not yet confirmed", "active, at <time>, <n> runs left" and "ended, <why>"
  are distinct.
- Until it is built, cross-reviewed and tried by the user, nothing reads or
  writes a confirmation, and a shipping host answers `overflow-unverified`.
  (Plan F4 built it, inactive: nothing in the app constructs it; see "As
  built" below.)

Codex (October 10): a confirmation proves the user's statement, not the live
setting, and the stream check cannot prevent a first charge. That remains
true of this direction; it is why the scope is one launch and five runs.

**As built (plan F4, October 11; inactive; the R4 fix of October 12 awaiting
Codex's re-review of the combined F3+F4 candidate; Codex F0 answers 9, 12, 13
and 14).** Where the
S5 and S8 readings above say the owner is not built or that tests pass a
fake, this is that owner; the readings' rules are unchanged.

- **Inactive.** `PaidUsageConfirmationOwner`, `LocalAuthenticationOwnerCheck`
  and `PaidUsageEndSignals` (`ParticipantProcess`) and the window adapter
  `PaidUsageDeskControls` (`ParticipantDeskControls`) are constructed by
  nothing in the app (only tests and the test-only availability probe);
  `ParticipantCoordinator.Configuration`'s owner initializer, which makes
  the owner both its availability and its confirmation and stops (a
  precondition) unless the host configuration carries the 4,096-byte
  first-trial input bound, so a host with the confirmation never lacks it
  (Codex F34-3; the Desk host is built from that same configuration, since
  attach refuses another bound; Sources still builds no host configuration,
  which DeskHost's lane tripwire holds), is called by nothing in Sources; `DeskWindowController`'s `paidUsage`
  defaults to nil and the app gives none, so the shipping window shows
  nothing new; the app links neither `ParticipantProcess` nor
  `ParticipantDeskControls`, and the release path keeps
  `ShippingAvailability`. F7 composes activation.
- **One way in, held by the compiler (Codex F34-6).** The owner's only
  public initializer takes section 5's real `ClaudeLocalChecks` and uses
  `LocalAuthenticationOwnerCheck`; `OwnerAuthentication`, its outcome and
  request types and that conformer are internal, and the initializer that
  takes fakes is internal (tests reach it through `@testable`). No module
  can give the owner other checks or another authenticator.
- **The ledger** is `{confirmedAt, cliVersion, cliFileIdentity, loginKind,
  accountIdentity, runsStarted}` (the account as F3's opaque comparator),
  in the owner's memory only: nothing writes or reads a file, default,
  Keychain item or log for it, and no environment, argument, default, file,
  page message or earlier launch can make or restore one. It is constructed
  in one place, inside the owner's own confirmation: a fresh local check,
  then one LocalAuthentication request (`OwnerAuthentication`; its one
  Sources conformer uses `.deviceOwnerAuthentication` with a fixed reason,
  a fresh `LAContext` each time; the Desk's unlock verifiers are not
  reused), then a fresh local check again. Only a successful request whose
  attempt was not abandoned meanwhile, with both checks passing and naming
  the same pinned file identity, version, login and account, makes it
  `active` with five runs. Cancel, failure, an unavailable request (for
  example no login password set) or one that never completes leaves it as
  it was. One attempt at a time, never over an active confirmation; an ended
  one is never revived, and a new one needs the request again. An ended one
  keeps its first reason, except that `paid-overflow` replaces any other
  (for example the fifth run's `run-limit` when that run then sees paid
  overflow), so the display says paid usage may have been used (Codex
  F4-1). What the user sees is macOS's own LocalAuthentication request (two
  per launch with the Desk's unlock), which may accept an Apple Watch where
  the Mac's policy allows; it is not a guaranteed password box, and the app
  has no password field (answer 13).
- **Runs** are claimed as section 7 says; the fifth claim ends it
  `run-limit`. The vector harness checks, over every vector, exactly one
  claim per launch attempt (Codex F4-4).
- **Ends.** For the whole launch, with or without a Desk window:
  `com.apple.screenIsLocked` and session resign give `lock`, sleep and
  screens sleeping give `sleep`, `NSWorkspace.willPowerOffNotification`
  gives `logout` (not every way macOS ends a process posts it; the next
  launch starts `unconfirmed` anyway); section 5's check and start ends give
  `cli-changed` and `login-changed`; `endForPaidOverflow` gives
  `paid-overflow`. Each end abandons an attempt under way: its request is
  cancelled and a late success is discarded. So does a change any local
  check shows while an attempt is pending (Codex F34-R4): from the attempt's
  first fresh check on, a check that `report()`, a start's recheck or the
  native "Check Claude" makes and that would end an active confirmation
  (`cli-missing`, `cli-version-mismatch`, `signed-out`, `not-subscription`,
  or a pass naming another file identity, version, plan or account than the
  attempt's first snapshot) abandons the attempt at once, even if the facts
  return to that snapshot before the request completes; checks seen while
  the first one ran are compared with its snapshot as soon as it is known.
  A result `report()` reuses (up to 30 s old, section 5) counts as seen too,
  even one from a check made before the attempt began: a reused
  `signed-out` from before the user signed in, say, interrupts an attempt they
  makes just after. That only refuses, and a retry is not hit again: the
  interrupted attempt's own fresh check has already replaced the cached
  result. A result does not say when its check ran, so the two are not told
  apart (the F34 re-review, M2). `provider-override` and `check-failed` abandon nothing, as they end no
  active confirmation. A test holds the request after snapshot A, lets
  `report()` or a recheck see signed-out or account B, restores A and
  delivers success: `interrupted`, nothing confirmed, the request cancelled.
  So does
  `abandonPendingConfirmation` (which ends nothing else), which the window
  calls on a Desk lock and on a window close; a quit reaches it through the
  session's close when the window is open, and F7's quit path must call it
  too (Codex F34-4). The attempt begins synchronously
  (`beginConfirmation`): the window's adapter begins it on the main actor
  with no suspension after the window's open-Desk check, so a Desk lock or
  close handled after that check always finds it (Codex F4-2; a test with
  the real adapter and owner shows it, and fails against the earlier
  adapter). The observers call only the owner, on the delivering thread,
  never the coordinator or the Desk, so they never re-enter the coordinator
  during the Desk's own lock flow (which `DeskLockSignals` runs separately).
  Production wiring, for F7's composition test (Codex F4-7): the screen
  lock is observed on `DistributedNotificationCenter.default()` with
  `.deliverImmediately` (so it arrives while the app is in the background;
  a source test holds both), and F7 must give
  `NSWorkspace.shared.notificationCenter` as the workspace center (it has
  no default) and start the observers at launch.
- **Promptness (Codex S8 R1).** The claim, every end and an abandonment take
  one lock and return at once: no main-thread wait, user interaction or I/O
  (a cancelled request is ended on a queue of its own, and the window's
  change handler only queues a redraw). A test holds the main queue and
  times them.
- **Native controls** (the Desk window, only when given the adapter): the
  state line, "Not yet confirmed" as "Paid usage: not yet confirmed in this
  launch.", active as "You confirmed paid usage was off at <time>. True
  Convo cannot see your billing setting. <n> runs left.", ended as "Paid
  usage confirmation ended, <why>. Send stays off until you confirm again.",
  except after paid overflow: "… paid usage may have been used. Send stays
  off. Check claude.ai Settings > Usage; the trial needs review before you
  confirm again." (answer 8: stop and review first); "Check Claude"
  (section 5's local checks only, shown as one line; it works before
  unlock and needs no store or Keychain); "Confirm paid usage is off…"
  (with the Desk open), which opens a native statement sheet telling
  the user to check claude.ai Settings > Usage themselves and that True Convo
  cannot see the setting, that macOS then asks them to confirm it's them
  (his Mac login password, or an Apple Watch where the Mac allows it), and
  every way it ends, before the request. Confirm stays off from the press
  to the attempt's result. The words are plain: no string names the
  framework ("LocalAuthentication"), and none says "verified", "no charge"
  or "free"; a source test holds that.
- **The page's refresh (answer 14).** After a confirmation, and when the
  confirmation stops being active while the Desk is open (an end, the run
  limit; Codex F4-6), the window makes the Desk's web view first responder,
  so the page gets a focus event and reads availability again; it grants
  nothing and dispatches nothing. Already first responder: it resigns at
  once and becomes first responder again 100 ms later (once, unless the
  Desk locked or closed or something else took the focus): WebKit sends
  focus changes once per run-loop turn, and a resign and focus in one turn
  reach the page as nothing. A real-WebKit test
  (`PaidUsageDeskRefreshTests`, skipped without `TRUECONVO_DESK_BUNDLE`)
  starts from the page's cached unavailable answer and shows, for both
  cases, the page's own availability read, Send enabled and its blocked
  message gone, with no reload, no picker interaction after the setup, no
  injected DOM focus and no dispatch; an end then blocks Send again with no
  call from the test. It runs the window on screen (small, at the screen's
  corner, without activating the app) and dispatches the test process's
  AppKit events, as the app's own event loop does; without them WebKit
  never learns the window is visible and the page stays `hidden`. It
  changes process-wide AppKit state (it gives the activation policy back),
  so it runs alone, with its own filter. The bounded native-to-page refresh
  notification is therefore not built, and the page needs no change.
- **Remaining, for review and the user's trial.** The LocalAuthentication
  request in the menu-bar (LSUIElement) app is first seen by the user; the
  real-WebKit proof uses a fake authenticator and a statement that
  continues at once, so whether the real request takes the key window or
  changes the page's focus events is first seen in their trial (a failure is
  safe: Send stays blocked until the page reads again; the bounded
  native-to-page notification remains the fallback, Codex F34-5); the
  already-focused refresh relies on a 100 ms gap reaching WebKit as two
  focus updates, a timing assumption, not a guarantee (proven 9 runs in a
  row; the same fallback applies, Codex F4-5); the local checks' real-CLI
  shapes are F1's predictions (section 5); a confirmation proves his
  statement, not the live setting.

## 18. Decisions confirmed by Codex (2026-10-10)

1. One-build rollout; the seven-operation host stays valid (section 2).
2. Nested pushed `event`, checked outer then inner before routing (8).
3. No caller hash; native derives `inputHash` from the committed record (6).
4. The twelve prepared keys are unchanged at 2e1f37d; a new run has no
   `reason` or `closure` (6).
5. One introduced run and claim per commit, schema 1 allowed; claims derived
   at the save boundary; unknown commits resend the original envelope (6, 13).
6. Closed start mapping with `retryable`; contradictions stay unknown;
   latches rechecked right before dispatch (12, 13).
7. A restored run (or, in one launch, a run after an unknown start) starts
   only by explicit user action after a fresh `not-dispatched` for the same
   `runId`, with a new request id (13).
8. Separate bounded client, fresh poll ids, 20/15 s timeouts, 15 s quiet
   reads, progress kept at 64 pages (13).
9. `replay-lost` only from a validated lost range plus a real terminal;
   out-of-order terminals are buffered (13).
10. `local-stop` once the group is cleared, without saying who stopped it (8).
11. No dispatch while any run has unsaved output; native adds the
    uncleared-group guard (7, 10, 13).
12. `not-prepared` is not a cancellation; the late-prepare race has vectors
    (12, 13).

Codex Q25 settled `participant-changed`: its own permanent start refusal
(sections 7 and 12).

Current status (October 11, after Codex's S11 review, inbox 237d63fc,
report a819387). This replaces the earlier "still open for Codex" list,
which named the supervisor helper, the recovery-only port and the nine
`pageCases` marked `requires`:

- The supervisor helper is built (`ParticipantSupervisor`, section 11),
  with the parent-death and supervisor-loss tests section 11 asks for.
  Codex's 45e37b2 recheck (report ca5da66) accepted a per-run supervisor
  under section 11's lifecycle and acceptance gate; Codex's process review
  of ec294dc (report 10e0174) found one should-fix, and its recheck of the
  fix, a52ce88 (report 67e1e98), passed the code. What remains is shipping
  it: packaging (item 3 below).
- The same 45e37b2 recheck accepted the recovery-only port for runs
  prepared under an earlier pin, using the run's exact historical
  participant identity (chosen here over relaxing the controller's
  identity check). The port is the adapter change one of the nine
  `pageCases` needs (item 4 below). The recheck's harness passed that case
  with an injected port. The later reviewed page adapter implements it:
  `NativeParticipantConnection.portFor(identity)` retains the saved pin;
  `runtime.participantForRun` connects it to restored controllers. A changed
  pin prevents Start while preserving status, events and Stop.

Still open, by name:

1. Reply-time stale suppression on the path with no lane (Codex's S11
   ruling (a); section 3). Native adds a reply-time stale check to the v1
   path as a scoped follow-up, whose safety argument is not WebKit's
   disposal. It keeps correct replies and identifier-only refusals, and
   its tests hold v1 content across reload, lock and close. Codex's ruling
   is that it is tracked explicitly before that path is extended to private
   persistent work. Native's own proposal, a question for Codex (native's
   pre-activation questions, 27(a)), is stricter: until it lands, that
   path is not extended to private persistent work.
2. The combined renderer proof (Codex's S10 ruling 1 and S11 ruling (c);
   section 7), required before participant activation. With the real page,
   the real coordinator and invented data: hold a Start before step 14,
   lock, let the refused start settle, unlock into a fresh document, and
   show zero launches and no native start record through a bounded
   no-auto-start interval, not only an immediate count; then one separate
   explicit Start succeeds once with the retained prepared identity. It
   runs on the combined page, including main's NF-1 and the reviewed
   NF-2/NF-3 changes when they are available. The existing streaming-lock
   proof (section 14, S11 reading 9) does not exercise it.
3. The activation work still ahead. None of it is done, and these source
   reviews grant no permission for installation, Keychain creation,
   signing, provider calls or extra usage:
   - section 17's confirmation owner, meeting the duty the S8-R1 re-review
     set for it, in its own exact review (built inactive in F4, with the
     native controls, the end observers and section 7's run claim; awaiting
     review with F3: section 17's "As built");
   - real section 5 availability: the pinned binary and login checks, and
     the subscription and paid-overflow checks (the local checks are built,
     inactive, in F3 and await review with F4: section 5);
   - a protected store that survives quit and relaunch, its key held in
     the Keychain, with a full quit and relaunch proof (and section 15's
     forward-only format marker, Codex Q3);
   - extended ACLs refused, fail-closed, at the participant parent and
     working-folder boundaries, and a failed folder removal reported to
     its owner, bounded (Codex's S5 fix recheck);
   - supervisor packaging: the helper bundled and signed with the app, and
     proven with the packaged copy (section 11). F2 bundles and signs it in
     the test copy only; Codex passed it with two nonblocking follow-ups
     (exact candidate 4a431db; F2-M1 and F2-M2 were fixed in c2ff10e and
     c78abf0 and passed the F1 review of fd8a38e, report 3f885db) and ruled
     question 21 as split evidence from
     one exact candidate (section 11's packaging note);
   - activation confined to the True Convo Test identity;
   - section 16's acceptance checks, on invented text, its first live run
     with the user's own OK (section 17).
4. Named execution of the nine `pageCases` marked `requires` (section 19).
   Codex's 45e37b2 recheck (report ca5da66) called their implementation
   future; the later reviewed page now implements these behaviors with
   descriptive tests. By name: `replay-lost` closure;
   out-of-order terminal buffering (that recheck found this marker already
   stale against renderer 8c086f0; the fixture still carries it); a
   stop-incomplete run keeping cleanup open; that cleanup ending only when
   native reports the group cleared; a status read after a native end with
   an uncleared group; a restored prepared run's explicit Start after
   authoritative `not-dispatched`; the same launch's explicit re-Start after
   an unknown start; the recovery-only port under an earlier pin; and
   `more` continuation. Codex's F0 answer 4 requires their named conformance
   before activation and assigns it to the cloud page owner, separately
   from the local renderer author's NF-2/NF-3 changes. The new
   `native-participant-page-cases.test.ts` exercises all 15 page cases
   through the production controller and adds production-adapter checks.
   The corrected runner's exact review passed at dfbf67e (inbox 2d7d91e2);
   this item closes when F9 consumes the accepted vectors/tests in the
   combined candidate. This is separate from the real-page/native-coordinator
   proof in item 2: neither test boundary substitutes for that combined proof.
   The controller matrix uses test-local reply mappings. The separate case 13
   check runs a controller through the production codec/client/adapter; case
   15's separate adapter check covers only merging its two pages, by calling
   the port directly without a controller or a final expected-state check.
   The harness uses an in-memory NativeHostTransport and EventTarget, not
   WKHostTransport, WKWebView or DeskHost. Swift counts and walks pageCases;
   that walk does not execute the page controller.
5. One shared opaque-handle rule (Codex's S7 review, inbox 68524fc3, report
   8032ddb, open item 1; kept, not waived, by the S8 review, inbox
   59dfb711, report 6e003da): byte equality, as a small separate reviewed
   change with ASCII-compatibility tests and canonically equivalent,
   different-byte examples, and no silent normalization of stored handles.
   Not done: v1's workspace-handle checks still compare with Swift's `==`,
   which treats canonically equivalent text as equal, while the
   participant path compares exact bytes. Today's `ws-<uuid>` handles are
   ASCII, so nothing differs now. Whether it ships with the protected store
   or must come first is a question for Codex (native's pre-activation
   questions, 27(b)).

## 19. Vectors file

[native-participant-v1.json](../apps/desk/tests/fixtures/native-participant-v1.json)
follows native-host-v1.json: `description`, `context`, `hashVectors`,
`records`, and `cases` with `name`, `request` and exact `reply`, plus:

- `seed`: state before the request; `{afterCase}` reuses a case's end state,
  other keys overriding: `record`, `runs`, `memory` (`{runId, state,
  lastSequence, retained, lost, process}`, `state` `running | cleanup-pending
  | exited`, `process` `exits-on-sigterm | survives-sigkill | supervisor-lost
  | null`; `supervisor-lost` means the supervisor is gone and the CLI's pipes
  are open), `process` for a run a case starts (default `exits-on-sigterm`),
  `store`, `availability` and `pin` (test fakes; `pin` defaults to
  `context.participant`; `availability` may carry the section 5
  `confirmation` the fake reports), `inputBound` (the host's first-trial input
  bound; absent means none), `clock`, `connection`, `script`, `faults`. Seeded
  entries imply their preparing `ok` identity; a seeded `running` run has
  passed the init and overflow rules. Faults carry through `afterCase` until
  `faults:[]`.
- `script`: fake CLI steps at `atMs` after `clock`: `init-clean` (passes the
  init rule), `init-with-tools` (fails it), `rate-limit-ok` (`overageStatus`
  `rejected`, nothing in use), `rate-limit-overage-allowed`, `text-delta`,
  `result-success`, `exit`. The fake exits on SIGTERM unless seed `process`
  says otherwise.
- `faults`: `start-record-undetermined` (that write and later confirmations
  stay undetermined; with `faults:[]` the next read finds the seeded `runs`),
  `hold-start-record-write` and `hold-availability-recheck` (held until the
  case request arrives), `hold-commit-write` (held until the case request is
  answered), `pushes-fail`.
- `inFlight`: `{request, reply}` sent before `request`, undecided when it
  arrives; `reply` is its exact later reply.
- `actions` before the request: `lock`, `unlock`, `begin-generation`,
  `issue-connection`, `run-script`, `group-clears` (surviving members exit;
  the next probe finds the group empty), `supervisor-dies` (only the
  supervisor is killed; the CLI keeps its pipes), `pipes-close` (every holder
  of the CLI's stdout and stderr write ends exits). `pushed`: every pushed
  detail in order. `afterRuns`: the runs list after.
- `pageCases`, page-only: `name`, `mode` (`new | restored`), `clock`, saved
  `run`, ordered `received` steps (`user` `start | stop | close-as-unknown`;
  `start` with `outcome` and `reason`; the `ok` fields of a `stop`, `status`
  or `events` reply; `pushed`, optionally `admitted:false`), and `expect`
  (`run`, controller `status`, `startAllowed`, `cleanup` `none | pending |
  cleared`, sometimes `stopAllowed` or `startRequested`). `requires` names
  the capability historically needed by a case, not a current assertion that
  its implementation is absent. The fixture description's sentence saying
  these cases need a renderer change is historical and deliberately unchanged
  under this follow-up's three-case correction scope. `currentPin`, when
  present, is native's pin, differing from the run's prepared participant.

Page-case execution boundaries (Codex F0 conformance follow-up, October 11):

- `pushed` delivers at the controller's subscriber boundary. Case 5's text
  event with `reason` tests the controller's own refusal when injected there.
  The production codec always rejects that malformed event and the adapter
  drops it before the controller; the real path sees a gap and recovers by
  replay rather than closing as `interrupted/event-refused` for this wire
  event. On the native path, `event-refused` requires a codec-valid event the
  controller refuses. Separate codec/adapter tests retain the earlier boundary.
- `received` orders response delivery and explicit user actions; it is not
  a complete transcript of recovery reads. Unlisted reads can remain held
  or answer unknown, never receive invented authoritative Start permission,
  terminal, cleared-group or completed-replay evidence. Assert final state
  after the listed responses and their effects settle. The corrected runner
  requires the constructor's restore read before advancing time, and uses
  the production quiet-poll timer for cases 2, 4 and 14; it does not call
  public `reconcile()` to substitute for those automatic triggers. Terminal
  evidence must initiate a status read before advancing the clock. Call
  attempts are logged before validation, and captured validation failures
  are asserted independently of the controller's error handling.
- `startRequested:false` means no outstanding or automatic Start after the
  listed explicit actions settle. Assert the exact explicit dispatch count
  and no additional dispatch through a bounded no-action interval; it does
  not mean zero historical requests when the case already includes Start.
  The interval covers elapsed quiet-poll periods, not necessarily completed
  poll cycles: an unanswered read can keep reconciliation in flight. Start
  and Stop counts are checked again after that interval.
- The controller has five `cleanupState` values: `none`, `unknown`, `owned`,
  `unowned` and `cleared`, plus a derived `cleanupPending` boolean. Fixture
  `none` and `cleared` match the literal state; `pending` means
  `cleanupPending:true` with native-owned (`owned`) cleanup, as in cases 7
  and 12. There is no page case for `unknown` or `unowned`. Cases 5 and 6 now
  expect `cleared` after their existing native confirmed Stop. Case 11 now
  explicitly supplies complete empty replay
  after `not-dispatched` before expecting restored Start to be available.
  These three page-only corrections preserve the replay barrier and stronger
  cleanup evidence; no native request/reply case, saved run or limit changes.
- The matrix's start/stop/status/replay conversions are test-local copies,
  not proof of production adapter mapping for all 15 cases. The separate
  case 13 controller check exercises the production codec/client/adapter
  over an in-memory transport and EventTarget. It requires decoded lost-replay
  evidence before Stop and bounded Stop settlement, so a silently dropped
  reply followed by client timeout cannot satisfy it. Case 15's separate
  adapter check calls the port directly and verifies only two-page merging
  into one `more:false` result: no controller, EventTarget push or final
  expected-state check. The other 13 cases retain the test-local mapping
  limitation. Production checkpoint scheduling supplies the saved-run check:
  a restored saved-record seed, Start's own save, immediate saves after
  closure, or otherwise the interval timer (which supplies case 9's final
  save). Its acknowledgement is in memory, not a native durable-storage proof.
- The controller `more:true` case is distinct from native-adapter paging:
  the adapter normally combines its two small fixture pages. Check both
  boundaries without claiming that two pages exercise the adapter's 64-page
  yield boundary; its existing bounded-pagination tests cover that limit.

Checked this session (before S3's additions, below): records and page runs
come from 2e1f37d's own functions, and every record except the two
deliberately malformed ones (a
`conversationRuns` element without `runId`, and a new run carrying `reason`)
passes its `validateState`; all 136 events pass its validator; every reply
and in-flight reply echoes its request, every request uses an issued
connection and generation, and every `ok` prepare leaves an entry naming
that commit's request id; 7 page cases reproduce their run, status, Start
and Stop permission through its `ConversationRunController` (the six without
`requires`, and the earlier-pin case with the recovery-only port it needs,
after confirming a port with the current pin is refused); DeskHost's Swift
writer reproduced every hash, `preparedBytes`, participant binding and start
payload hash (118 entries, 82 starts). No host, CLI run, supervisor or login
is proven.

Revision 3 adds eight cases: the four `confirmation` states (including an
earlier failing check winning), three first-trial bound preparations (exactly
4,096 bytes prepares; 4,097 bytes with the same character count, and two chunks
totalling 4,097, are `text-too-large`), and a start refused at the bound for
a run prepared above it, plus a 4,096-byte multibyte `hashVectors` entry. Their
records pass the renderer's `validateState` at c843eb7, and their hashes and
`preparedBytes` follow the rules above. They have not yet been reproduced by
DeskHost's Swift writer, except #102-#104, which S3's harness (below) runs.

The inactive commit slice S3 (October 10) appends two commit cases, leaving
the first 105 byte-identical:

- #106 (Codex Q8): `prepared-r5` with a number added to the run's
  `inputChunks` is `text-too-large`.
- #107 (Codex Q9): over `records.legacy-runs-r6`, a legacy committed record
  whose `conversationRuns` holds malformed siblings (an object without
  `runId`, a string, an object whose `runId` is a number) around one
  well-formed run, a valid replacement that keeps that run commits `ok`:
  nothing is introduced.

These three records are not renderer output. S3 derived them by hand:
#106's request record from `prepared-r5`, and `legacy-runs-r6` and #107's
request record from `running-r6`. #106's request record and
`legacy-runs-r6` are deliberately invalid to the renderer's `validateState`
at ea771d3, and each passes once its one deliberate defect is removed;
#107's request record passes. So the "Checked this session" paragraph above
describes the file before S3: with S3's additions it holds three
deliberately malformed request records and one deliberately legacy seed
record, and the fixture's `description` says the same. Neither case writes
a run entry, so no hash or `preparedBytes` is new. The page's participant
codec and bootstrap tests at ea771d3 pass with the file.

DeskHost's vector harness (`Tests/ParticipantProcessTests`) reads a byte
copy of this file and fails if the two differ. It seeds each case's `runs`
with their implied `ok` identities under a deterministic invented
`payloadHash` (Q11), never for a request id a case sends, and replays
`afterCase` chains from the root with genuine hashes. It compares replies,
pushes and runs as canonical bytes, never as Swift strings (canonically
equivalent text is still different bytes), and checks that a refusal left
every file in the store's folder byte-identical (with one exception, Codex
S9 ruling b: a start refused `participant-busy` at section 7 step 12 may
make durable exactly the participant writes this launch already owed for
other runs before it arrived, and push a never-spawned terminal made
durable that way once; every other file stays byte-identical, `state.json`
too when no owed write was made durable, and otherwise its own run's entry,
every other entry and every other `state.json` field keep their canonical
values, the store having rewritten the file; anything more fails the
case). In S3 it ran 25
cases (#1, #6-#22, #90, #92, #102-#104, #106, #107) and the four
`hashVectors`. With the coordinator's read side (S7) it replays cases
through `HostRouter` and runs 51, adding #2-#5, #49-#54, #59-#65, #75, #85,
#87, #89, #91 and #98-#101, all passing. With start (S8) it drives
`inFlight` and four faults: `hold-commit-write` holds the commit's result
write (its second replacement, after its dispatch receipt) before its rename
until the case's reply is compared; `hold-start-record-write` holds the next
store write, and `hold-availability-recheck` the next availability report,
until the case request is admitted (a Stop waits on the start, or the reply
came); `start-record-undetermined` fails every folder flush while armed, and
`faults: []` with a later `runs` writes those runs as the folder holds them.
Every case then settles on the virtual clock (Codex Q15) while the
coordinator consumes its runs' updates. A hold fault without an `inFlight`
request is refused; a hold or gate that lets itself go after its 10 s bound
fails the case, and settling stops at the first drain that stalls. A drain
also waits for every claimed confirmation end to return from the owner (S8
R1: a late end calls it after the end is published). Those 10 s bound holds
and gates for real. The harness's polling waits only check a 10 s deadline
between polls, and nothing in the package bounds an awaited call that never
returned: no suite sets a time limit, and Swift Testing's `.timeLimit` could
not interrupt a call that ignores cancellation, so such a hang would last
until the test command is killed from outside (Codex S8 follow-up). Only an
`ok` start whose record was not on disk before the step may launch (a
replay launches nothing). After each chain, every launched run whose stream
observed paid overflow must have ended the confirmation, with exactly one
owner call per run that ended it. It runs 82, adding #23-#33, #35-#48,
#86, #88, #95-#97 and #105, all passing; the other 25 wait for live Stop,
cleanup and supervisor loss (S9) and lifecycle (S10).

With live Stop, cleanup and supervisor loss (S9, accepted in Codex's S9
review with the rulings in section 10) it
replays `running` and `cleanup-pending` memory seeds of this launch: from
the first retained event's `at`, `init-clean` and `rate-limit-ok`, then each
retained text's delta 250 ms before its `at`, through the real reader and
supervisor engine, the coordinator owning the run as a start would; a
`cleanup-pending` seed then gets, with `survives-sigkill`, a Stop through
the router 12 s before its `stop-incomplete` terminal, and with
`supervisor-lost`, `supervisor-dies` at its `process-error` terminal. The
seeded entry is written without terminal and `groupCleared`; the replayed
events must equal `retained` and the folder the seed's `runs`, byte for
byte, and the replay's pushes are dropped. The world's clock starts at the
replay when that is earlier than the chain's first clock. It drives the
actions `run-script` (the case's `script` on the one live run, from the case
clock), `group-clears`, `supervisor-dies` and `pipes-close`, each on the one
scripted run it fits, then settles before the request; `pushes-fail` drops
every push while armed; `process` sets the group of a run the case starts.
A later `record` and `runs` (#79) must keep every entry the chain wrote and
only add fresh prepared ones (with their implied identities); the store then
re-reads the folder. A request waiting on a run's process (a Stop waiting for
its terminal or a cleanup retry) has virtual time settled under it, and the
folder "at the reply" is taken once the coordinator's queued writes have
returned. Any other action (`lock`, `unlock`, `begin-generation`,
`issue-connection`) is refused. It runs 105, adding #34, #55-#58, #66-#74,
#76-#84, all passing; #93 and #94 wait for lifecycle (S10).

With the lifecycle (S10, passed by Codex's S10 review, inbox fcc67dfe) it
drives the four stack
actions, one at a time, the world settled after each: `lock` (the lane's
`lockNow()`, then the host's `lock()`), `unlock` (the host's `unlock()`,
then the lane's `unlock(ifNoLockSince:)` with the epoch read just before
the host's `unlock()`; the harness has no owner check, so that read is
where S11 reading 4's check would begin), `begin-generation` (the host's) and
`issue-connection` (the host's `ready` for the case request's own
connection id, through a test-only `issueConnection(adopting:)`). Settling
after each action lets a lock's stop sequence end while it is locked, before
the unlock that follows; no earlier case has more than one action. It runs
all 107, adding #93 and #94, both passing; any other action is refused.

## 20. Revision 4: local models through Ollama (proposed, October 15)

In plain words: the same page wire also runs the owner's local chat models
through Ollama on this Mac. A local run sends nothing off the Mac, has no
paid path and no child process, and continues the conversation by sending
earlier turns as context. Scope and order:
[docs/plans/step-3-local-conversation.md](plans/step-3-local-conversation.md).
Everything in sections 1-19 stays in force for the Claude Code entry; this
section only adds. A host without a local route is revision 3 exactly, and
every existing vector stays byte-identical.

### 20.1 The local route

- A host may have one local route, `ollama-local`. Native reaches it only at
  the fixed base `http://127.0.0.1:11434` (or `http://[::1]:11434`). It reads
  no environment variable (including `OLLAMA_HOST`), default, argument, file
  or page value that could change the address.
- **Every HTTP redirect is refused** (the URL session's redirect hook
  answers no redirect), whatever its target. A redirected availability read
  answers the route `catalog-unreadable`; a redirected chat request ends the
  run `failed` `process-error`. Fake-server tests cover both.
- Native uses `/api/tags` to list models and `/api/chat` (streaming) to run
  one, plus `/api/copy` and `/api/delete` only for its own per-run aliases
  (20.4). It sends no other request. A name in native's exact alias format
  (20.4) is never listed as an entry; any other name, including one the
  owner chose that merely starts `open-convo-run-`, is an ordinary model.
- Only chat models with a usable identity are listed: a model whose
  `capabilities` include `completion` and whose `digest` is 64 lowercase hex.
  Embedding-only models and models without such a digest are left out
  entirely. A listed model counts as local only when Ollama shows it without
  `remote_host` or `remote_model` and its name does not end in `:cloud`;
  every other listed model is never available (20.2). Checked
  against Ollama 0.34.0 on October 15, which marks its cloud models with
  `remote_host` (for example `https://ollama.com:443`).

### 20.2 Availability with a local route

The reply keeps `participants` and gains one key, `routes`, only on a host
with a local route:

- `participants`: the Claude Code entry first, exactly as section 5, then one
  entry per chat model Ollama lists, sorted by name (code-point order), at most
  256. With more than 256 the route is unavailable `catalog-too-large` and
  lists no local entries, so a saved choice is never hidden behind a cut-off
  list (Codex round 4 on #38). A local entry is exactly `{id, label, model,
  executionHost, available, reason}`: `id` `ollama-local`, `label` the model
  name, `model` the name, `@`, and Ollama's full 64-hex digest
  (`qwen3.5:9b@6488c96f...`, 64 hex in full), `executionHost` `this-mac`, each at most
  256 bytes. `reason` is `null` exactly when available, else
  `model-not-local`; a name ending in `:cloud` is always unavailable with
  `model-not-local`, and the page refuses a reply that says otherwise. A local
  entry never has `confirmation`.
- `routes`: exactly one item, `{route, state, reason}`: `route`
  `ollama-local`; `state` `ready` with `reason` `null`, or `unavailable` with
  `reason` `ollama-not-running` (no answer on the fixed base),
  `catalog-unreadable` (an answer that isn't a valid model list, including a
  redirect), `catalog-too-large` (more than 256 chat models) or
  `host-not-loopback` (the fixed base resolved off loopback). An
  unavailable route lists no local entries.
- The page derives "model missing" (its saved choice's name is absent from a
  ready route) and "model changed" (the name is present with another digest)
  itself; native never invents an entry for a model it can't list.

### 20.3 Context: earlier turns of the same session

- A prepared run whose participant is a local entry has exactly section 6's
  twelve keys plus `contextRunIds`: an array, possibly empty, of at most 256
  distinct run ids, in the order the turns happened. A Claude Code run never
  has it, so section 6 step 3 is unchanged for it.
- **Section 6 step 5 for a local run.** Instead of native's Claude Code pin,
  `run.participant` must equal (all four fields, exact strings) an entry of
  native's current local catalog that is available in a ready route, and
  `participantId` must be `ollama-local`; else `run-mismatch`. Native reads
  the catalog afresh for this check (no reused answer), with section 20.1's
  rules. A Claude Code run keeps step 5 exactly.
- In the preparing commit (section 6, after step 5), native resolves each id
  in the same request's `record`: the run must exist, belong to the same
  `sessionId`, have phase `completed`, and come before this run in the
  record's `conversationRuns` order; else `run-mismatch`. Each resolved run
  contributes two turns, `{role: "user", text: join(inputChunks)}` then
  `{role: "assistant", text: join(outputChunks)}`.
- **One input limit.** The resolved turns' text bytes plus the new run's
  `inputChunks` bytes are at most 262,144 (section 6 step 6's bound, measured
  on resolved text, not ids); else `text-too-large`. The page counts the
  same way before preparing and leaves out the oldest whole runs until it
  fits; it never cuts a turn.
- **Bound by hash, never stored as text.** The runs entry (section 15)
  stores `contextRunIds`, `contextBytes` and `contextHash`: SHA-256 of the
  canonical JSON array of the resolved turns. No context text is stored in
  the runs list, which keeps section 15's rule that it holds no prompt or
  reply text, and leaves nothing to compact later.
- At start (section 7, after step 9), native resolves the same ids again from
  the committed record and recomputes the hash. A difference, a missing run
  or a changed phase is `run-mismatch`; nothing is sent. Native sends exactly
  the turns it just hashed, then the new message.

### 20.4 Start, events and stop for a local run

- Section 7 applies unchanged up to and including step 14: the start record
  is written by compare-and-set **before** any `/api/chat` request. The only
  calls before it are step 13's alias calls below (`/api/copy`,
  `/api/tags`, and `/api/delete` when the check fails), which carry no
  conversation text and dispatch nothing; an undetermined
  write answers `unknown` and sends nothing; a lost reply is resolved with
  `participant.status`, never by sending again. Ollama has no request-level
  idempotency, so nothing in native or the page resends on its own.
- Step 10 for a local run: `participant-changed` when no local entry in a
  ready route has the run's exact `model` (name and digest). Step 13:
  `participant-unavailable` when the route is not ready or the entry is not
  available. Reading (step 3 PR 3c): a route that is not ready at step 10
  has no list to judge a change by, so step 10 passes it and step 13
  answers `participant-unavailable`; "Ollama is not running" is never
  reported as a permanent model change. Section 17's confirmation and
  first-trial input bound do not apply to local runs.
- **Digest-bound request.** Ollama can't run a model by digest (checked on
  0.34.0: `name@digest` and `name@sha256:digest` are refused as invalid
  names), and a tag can be moved to another model at any time. So step 13
  for a local run, after its availability recheck, binds the run to its
  digest with a private alias: `/api/copy` from the model name to
  `open-convo-run-<runId>:pin`, where `<runId>` is the run's lowercase v4 id
  with its dashes removed, so the name matches exactly
  `^open-convo-run-[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}:pin$`; unique
  to this run and never reused; then a fresh `/api/tags` read must list that alias with the
  run's exact digest, without `remote_host` or `remote_model`. Any other
  result deletes the alias and refuses `participant-changed` (or
  `participant-unavailable` if the route went down), with nothing sent. A
  copy keeps the digest and the remote marker (checked on 0.34.0 with a
  local and a cloud model), so a tag moved before the copy is caught by
  this check. The chat request names only the alias. Because these calls come
  before the start record, their failures are ordinary refusals with nothing
  dispatched, and a crash between the copy and the record leaves only an
  alias. The alias is deleted after the run's terminal is written (reading,
  step 3 PR 3c: while a lock, Desk close or quit holds the terminal
  unwritten, the alias is deleted as soon as the request has ended, so
  none is left behind; a start that refuses or sends nothing after the
  copy deletes it at once); at
  launch, and before any new start, native deletes every alias whose name
  matches that exact format and that no live run of this launch owns.
  Native never deletes any other name: an owner's own tag is never touched,
  whatever it starts with. Trust boundary: a process that deliberately rewrites this
  exact alias in the moment between the check and the request is outside
  what native can prevent through Ollama's API; Ollama and other programs
  able to call it on this Mac are trusted not to do that.
- Step 15 for a local run issues one streaming `/api/chat` request
  (`model` the run's alias, `stream: true`, `think: false`, the turns from
  20.3 then the new message) in place of a spawn. `started` follows the response's HTTP 200; `text`
  events carry the streamed content under section 8's rules; `completed`
  follows Ollama's `done: true`. Any other status, a malformed line, a
  redirect or a dropped connection is `failed` `process-error`. Section 8's
  timeouts apply (no first byte 30 s, no output 120 s, total 15 min).
  `paid-overflow` never occurs. **Reply budget:** section 8's
  `reply-too-long` for a local run counts `contextBytes + inputBytes +
  output` against 262,144 (section 15's input-plus-output bound with the
  context included; Codex round 4 on #38).
- **No process group.** For a local run the "group" is its HTTP task:
  cleared means the task finished or was cancelled and native accepts no more
  bytes from it. Stop cancels the task; Stop's reply is `exited` with
  `groupCleared:true`; `cleanup-pending` never occurs. `start.cliVersion` is
  `ollama-local`.
- **Lifecycle (section 14).** The task runs under the same launch-scoped
  coordinator, lifecycle epoch and push gate as a process run. Lock, Desk
  close and quit cancel it in place of SIGTERM; retained text is dropped on
  lock and close exactly as section 14; terminals are held while locked and
  written at unlock; quit stays inside the 17 s overall bound. No text
  reaches a locked document or a replacement generation.
- **After a crash.** A started local run with no terminal reads as section
  14's crash row (`unknown` `exit-unrecorded`); the page labels its partial
  reply as cut off. Only the owner's explicit Retry makes a new run with new
  ids; the old one is never re-requested.

### 20.5 Storage, reasons and vectors

- Runs entries for local runs add exactly `contextRunIds`, `contextBytes`
  (0-262,144) and `contextHash` (64 lowercase hex); Claude Code entries never
  have them. Load invariants: the three appear together, only with
  `participant.id` `ollama-local`.
- New availability reasons: `model-not-local` (entry) and
  `ollama-not-running`, `catalog-unreadable`, `catalog-too-large`,
  `host-not-loopback` (route).
  No new refusal reasons: the local route reuses `run-mismatch`,
  `participant-changed`, `participant-unavailable` and `text-too-large`.
- Vectors live in a separate file, `native-participant-local-v1.json`, beside
  section 19's file and in its format, plus seed keys `localRoute` (`{state,
  reason, models}`, the fake Ollama's catalog) and fake-server `script` steps
  (`http-200`, `chunk`, `done`, `http-error`, `redirect`, `drop`,
  `retag` (the fake moves a tag to another digest or to a cloud model at a
  chosen point between the catalog read and the copy), `alias-swap`). The page
  codec runs its shape cases now; the Swift harness runs all of them with the
  host change (step 3 PR 3).
