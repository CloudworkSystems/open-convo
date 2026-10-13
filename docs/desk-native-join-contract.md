# Desk and Mac host: bounded join proof

This is the implementation boundary for the October 8 selected one-app
capability. Claude agreed to the five operations and native trust model in
its exact first-slice review (True Convo review record, not moved). The October 9
wire agreement (True Convo review record, not moved)
confirms the limits and first five request variants. The build order then lived in True Convo's docs/desk-build-plan.md (not moved; see PLAN.md).
No host, protected store or real provider is connected by this document.

## First working join

Use invented records in an app-owned WKWebView showing the pinned bundled Desk.
The native actor owns the proof store and serializes its transactions. Keep
private readiness unavailable until the independent storage and native checks
pass. Host initialization selects one repository; a native read, key or commit
failure never falls back to browser storage.

The proposed versioned request envelope includes request identity, document
generation and a host-issued connection identity. The host verifies its own
webview, actual main frame, expected app origin and current navigation state
on every request. A JavaScript global, URL or copied nonce does not establish
native trust. Navigation, close and lock invalidate the connection.

| Proof operation | Constraint |
| --- | --- |
| `host.capabilities` | Version, pinned build, store/lock status and supported operations; no credentials or private text. |
| `workspace.read` | A native-issued workspace handle, never a filesystem path or arbitrary database name. |
| `workspace.commitProof` | Invented-data schema, immutable snapshot and required expected revision; validate and compare/commit atomically on the native side. |
| `dictation.bindDraft` / `unbindDraft` | Ephemeral target bound to one workspace, session and document generation. |
| Final-dictation delivery and receipt | Literal text and delivery identity; distinguish receipt, durable application, conflict and refusal. |

Agreed proof limits are 1 MiB per serialized workspace payload, 1 MiB + 64 KiB
per envelope, 64 KiB per text item (all UTF-8 bytes), one outstanding mutation,
and nonnegative safe-integer revisions. Existing record identities retain
accepted UUID versions 1–5 and their case; new request/binding/delivery IDs
are canonical lowercase UUIDv4. These proof limits are not silent
truncation or final limits for real histories: reject oversize proof records
plainly and leave the original intact.

A repeated request with identical identity and payload returns its original
result. Changed payload under the same identity is refused. A stale revision
preserves both the committed record and attempted work. A timeout is an unknown
outcome, requiring reconciliation rather than a new-ID retry. Success follows
durable commit, not receipt.

The inert TypeScript codec and its
[shared invented vectors](../apps/desk/tests/fixtures/native-host-v1.json)
implement `host.capabilities`, `workspace.read`, `workspace.commitProof`,
`dictation.bindDraft` and `dictation.unbindDraft`. The request envelope is
`{v, requestId, connectionId, generation, operation, payload}`; responses
echo its correlation fields and contain the exact operation/outcome variant.
The host-issued connection and workspace handle are opaque, not paths or
authentication supplied by JavaScript. Host revision equals `DeskState.revision`;
commits compare the expected revision and accept an advancing snapshot, including
queued-command gaps. The pinned client validates the full existing DeskState
before commit and after read. Native checks envelope, size, identity and revision
and stores content opaquely; that is not full native content-schema validation.
The first store contains a native-provisioned invented fixture; missing or corrupt
established storage never becomes a fresh workspace. The codec does not connect
the hosted preview. The ordinary browser build cannot select a native runtime
through a URL parameter or page global.

The later reconciliation and delivery agreement (True Convo review record, not moved)
adds read-only `workspace.reconcile` and `dictation.receipt`. Their executable
client variants await the exact tested native source. Capabilities may advertise
them without the current five-operation client invoking them. After reconnect,
reconciliation identifies the original request separately from the query ID.
Only the mutation actually holding a workspace barrier can resolve that barrier;
an unrelated or random query cannot release it. Missing/corrupt dispatch or replay
evidence remains unknown. No automatic retry under a new connection is implemented.

Final dictation is a native-to-page event, followed by normal compare-and-commit
with an explicitly correlated delivery ID. The host must atomically persist the
snapshot, request result and delivery receipt. A later unrelated workspace save
does not acknowledge dictation. The client draft helper returns only an unsaved
candidate; event/receipt integration and actual native replay tests remain pending.

## Canonical wire agreement (October 9)

This section records the agreed interface, including extensions whose executable
client variants are still pending. The shared vectors exercise the five current
operations plus a correlated commit; an advertised extension is not proof that
App invokes it. Unknown versions, operations and extra fields refuse.

Requests have exactly `{v:1, requestId, connectionId, generation, operation,
payload}`. Replies echo those five correlation fields (without `payload`) and
add `outcome`. Generation and revisions are nonnegative safe integers.
`connectionId` and `workspaceHandle` are opaque host-issued strings. Selection
offsets are UTF-16 code units; a selection may not split a surrogate pair, and
text containing an unpaired surrogate is refused. Byte limits count UTF-8.

| Operation | Exact request payload | Fields added to an `ok` reply |
| --- | --- | --- |
| `host.capabilities` | `{}` | `capabilities` |
| `workspace.read` | `{workspaceHandle}` | `record`, `revision` equal to `record.revision` |
| `workspace.commitProof` | `{workspaceHandle, expectedRevision, record, dictationDeliveryId?}` | `revision` equal to the attempted record's revision |
| `dictation.bindDraft` | `{workspaceHandle, sessionId, expectedRevision, expectedText, selection:{start,end}}` | `bindingId`, `revision` equal to the captured expected revision |
| `dictation.unbindDraft` | `{bindingId}` | None |

The optional delivery ID is a canonical lowercase UUIDv4. Unbinding an old
binding can affect only that binding. Bindings capture the workspace revision;
even an unrelated intervening edit can conservatively produce a conflict.

`capabilities` has exactly `contractVersion:1`, `hostBuild`, `appVersion`,
`store` (`ready|missing|corrupt`), `lock` (`unlocked|locked`), `operations`,
`workspaceHandle`, and `limits`. The limits object is
`{recordBytes:1048576, envelopeBytes:1114112, textItemBytes:65536,
outstandingMutations:1}`. The operation list contains all five current variants
and may also contain `workspace.reconcile` and `dictation.receipt`.

For any current operation, `refused` adds only `reason` and means the attempted
action is proven not applied; `conflict` adds `reason:"revision-mismatch"` and
the current `revision`. `unknown` adds no fields, is nonterminal and keeps the
mutation barrier. The agreed refusal reasons are:

```
unknown-connection stale-generation unknown-operation malformed-envelope
unknown-field unsupported-version payload-too-large text-too-large
payload-mismatch mutation-outstanding invalid-identity invalid-revision
revision-not-advanced revision-mismatch store-missing store-corrupt
store-locked unknown-handle unknown-binding binding-stale duplicate-delivery
locked unknown-delivery unknown-request
```

### Read-only reconciliation extension

The query payload is `{workspaceHandle, targetRequestId}`. Its own request ID
is separate from the original mutation's ID. An `ok` query adds
`targetRequestId` and `original:{outcome, revision?, reason?}`; the applicable
terminal result determines the optional fields. Exact executable extension
validation will be checked against the Swift source before App uses it.

The host records receipt before dispatch and persists terminal results in its
ledger. Only the request actually holding the workspace barrier can resolve
it. A proven terminal result, or authoritative evidence from both receipt log
and ledger that the original was never dispatched, can resolve that request.
A random query cannot release another request's barrier. Missing or corrupt
evidence stays unknown and further writes refuse with `store-corrupt` until
explicit recovery. Authoritative `not-dispatched` for the actual pending
request releases its barrier. With no active barrier, an absent
target may return `original.outcome:"not-dispatched"` without changing state.

After reconnect there is no transparent retry. Only an authoritative
`not-dispatched` result can permit an explicit attempt with the original ID
and the new connection envelope. In-flight and completed mutations never
become a blind new dispatch. The current client's same-connection reconcile
helper instead resends the original retained bytes and depends on native
idempotence; this is distinct from the future read-only query.

### Host-pushed dictation and receipts

The proposed page operation `dictation.deliverFinal` is withdrawn. The host
pushes `{type:"dictation.final", connectionId, generation, bindingId,
deliveryId, text}`. The captured-draft helper produces an unsaved candidate;
the page then uses ordinary `workspace.commitProof` with `dictationDeliveryId`.
The host must verify the active binding, captured revision and pending delivery,
then atomically persist snapshot, request result and delivery receipt. Neither
an unrelated commit nor receipt of a message means dictation was saved.
When no binding is current at final delivery, the host holds the literal text
natively as a pending delivery and pushes nothing; it must not fall back to
paste, Return or a different session.

The host may push `dictation.receipt` with connection/generation, `deliveryId`,
`commitRequestId` and committed `revision`. The separately advertised read-only
query has payload `{deliveryId}`. Its `ok` reply adds exactly
`{deliveryId, commitRequestId, revision}` to the echoed reply base. A known but
uncorrelated delivery answers `unknown`, nonterminal; an unknown delivery is
refused with `unknown-delivery`. Executable extension validation remains part
of the native-source compatibility check. Recording-start binding, final events and
receipt UI are not connected by the repository proof alone.

### WKWebView bridge names and lifetime

The host installs frozen, nonwritable `window.trueConvoHostBootstrap` at main-frame
document start, with exactly `{v:1, connectionId, generation}`. The page calls
`window.webkit.messageHandlers.trueConvoHost.postMessage(envelopeObject)`.
`WKScriptMessageHandlerWithReply` resolves a plain response object; a contract
refusal is a resolved protocol reply, while transport failure is an unknown
delivery. No JSON string or interpolated JavaScript is used to convey content.

For host events, `callAsyncJavaScript` passes an argument value which becomes
the detail of a `trueconvo-host` DOM event. A lifecycle detail is
`{type:"host.connection", connectionId, generation, state, reason}` with
`state` equal to `ready`, `locked` or `revoked`. Matching lock/revoke permanently
closes the old runtime, removes listeners and clears retained state. Unlock
requires a fresh document and bootstrap; a later `ready` event cannot reopen
the old runtime. The host must independently enforce this lifetime as well as
actual webview/frame/origin checks. Bootstrap values and DOM events do not
authenticate a page to native code.

The native custom-scheme name proposed for the bundled assets is `trueconvo-desk`.
Its runtime proof remains a Mac check. A custom scheme may lack
`crypto.randomUUID`; the page's injected ID factory uses `crypto.getRandomValues`
to create canonical UUIDv4 values instead. No provider or private-store readiness
is implied by a successful invented-data handshake.

Serve only manifest-listed bundled assets through a constrained custom-scheme
handler. Refuse traversal, unlisted files and filesystem requests. Block
external navigation/new windows in the privileged view. External content has
no handler. Use structured request/reply messages; keep keys outside JavaScript.

## Dictation stays an unsent draft

Capture the intended session, draft value/revision and selection at recording
start. Apply final literal text once to that captured target through the Desk
draft command with its expected-text check. If the target or draft changed,
offer explicit insertion rather than overwrite or switch to another session.
Deduplicate delivery identities. Never synthesize Enter, submit the form or
activate a provider. A saved-draft receipt follows the committed revision.

Claude owns the native target-routing change: at recording start, recognize
the app's own Desk window before the legacy external cursor-target path
excludes the app itself. For that target, disable both live-insert partials
and legacy paste completion, including Cmd+V insertion and the delayed Return
in Paste and Submit.
The external-app Auto Submit setting never applies to Desk dictation. Use
only the bound unsent-draft route, once; a missing host, conflict or failed
delivery must not fall back to paste or Return. Verify this with Auto Submit
enabled, session/window switching during a recording and failed delivery.

## Protected mode covers every durable path

Replacing App's BrowserRepository alone is insufficient. Canvas, Roadmap,
identity, tab selection and layout use separate browser records; recovery
downloads are plaintext; the native dictation completion also has an archive
write. Protected mode must route those paths through its protected authority
or disable them. Use a nonpersistent webview data store and check caches and
crash copies. Private attempted drafts need encrypted native recovery.

Enforce lock in the native service, including restart locked, actual macOS lock
signals, owner inactivity and verified unlock. Lock/revocation invalidates
pending contexts and responses, prevents late operations and clears visible
private content. Missing keys or corrupt ciphertext refuse replacement,
regeneration and plaintext fallback.

Key custody uses a non-synchronizable native Keychain item. It is not copied
to iCloud or exposed to JavaScript. Create a key only when no protected store
exists. If a store exists but its key is missing, refuse opening or replacing
it and explain recovery; never regenerate a key over saved work. This records
the agreed protection requirement without activating or changing any account
or credential. Encryption implementation and native storage proof still need
their own review and checks.

Whether Desk-targeted dictation retains a transcript archive is a separate
owner choice. Claude proposes no plaintext archive by default. The invented
join proof grants no private archive write; private use cannot proceed while
that route can still write plaintext. The archive decision does not block
building or checking the invented-data proof.

## Reader and provider boundaries

The old-session reader is a separate memory-only view. Its loopback guard is
not native authentication. Custom-origin support needs a genuinely host-bound
read-only surface/handle; closing or locking invalidates it. Reading never
migrates, indexes, creates memories, fills drafts or grants provider access.

Provider operations are absent from the join proof. A later service broker
checks exact recipient, model, sources, current permissions, policy and cost
before dispatch. Quota, uncertain policy or missing permission stops a run.
There is no paid fallback. Stable run/session/message identities, cancellation,
safe checkpoints and uncertain-delivery reconciliation precede real use.

## Required integration checks

- Hostile frames/origins, stale generations, traversal and external navigation
  cannot read or mutate; unknown protocol/verbs/fields and oversize data refuse.
- Competing commits produce one durable success and one recoverable conflict;
  a lost acknowledgment plus exact retry creates one result.
- Key/ciphertext/native failures create no replacement or browser fallback.
- Dictation arrives once in its captured unsent draft; session switching and
  intervening typing cannot overwrite another draft. With external Auto Submit
  on, a Desk target still receives no live-insert partials, legacy Cmd+V,
  Return or duplicate insert.
- Reader canaries stay out of workspace stores, logs, memory, provider input
  and exports; private canaries stay out of all plaintext managed paths.
- Lock, restart and revocation stop late reads/writes/context use; provider
  limits stop without another route or paid retry.

Cloud implements the repository/protocol/draft adapter with invented transports
after Claude confirms the matching native interface. Claude builds and checks
the real host/storage side. These are acceptance requirements, not executed
native checks or permission to upload history, sign, spend or publish.
