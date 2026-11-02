# Prime Agent routing

## Caller rule: the host owns the record

Call `routeMessage(input, record)` only when `input` contains facts read from the message and `record` comes directly from the host. A model must never create or change `record`. The host records the real sender, conversation space, session-offer response, approvals, used approvals, used offer acceptances, recipient, and memory grants.

Before an approved outside action starts, the caller must save its returned `approvalId` in `usedApprovals`. That claim must happen once even when two routing calls run at the same time. Before a specialist starts from an accepted offer, the caller must likewise save its `acceptanceId` in `usedAcceptances`. Saving after the action or specialist starts would allow one yes to be used twice after a crash.

## Input

`input.facts` contains `asks`, `steps`, and `outsideActions`. Each outside action has an `id`, `kind`, human-readable `description`, and exact JSON `payload`. `input.limits.quickSteps` is optional and defaults to 3. The input is refused if it carries host-owned record fields.

`record` contains the host-owned message and space, the proposed job and recipient, offer state, approvals and their used ids, and memory grants. An approval contains a digest from `actionDigest({ description, kind, payload })`, covering both the description shown to the person and the exact action to run. A memory grant names its space, job, file, label, text, reason, recipient, freshness, and allowed use.

## Rules

Only an unused approval recorded as coming from the person counts, and only for the matching action id, shown description, kind, and exact payload. Every unapproved outside action adds `wait-for-yes` with `Yes` and `Not now` choices. A small question or task is answered, thinking or an unclear request is discussed, and larger requests or a newly accepted offer are handed off. Agent and system messages never start a hand-off.

Hand-off memory is limited to the recorded job and recipient. A file from another space must have `sharedByPerson: true`. Every file sent to an outside recipient must also have `sharedByPerson: true`.

## Output

The result contains `routes`, `main`, `waitFor`, `approvedActions`, `ignoredApprovals`, `droppedGrants`, `offer`, `brief`, `memoryCandidates`, and `counts`. Lists use fixed ordering. `memoryCandidates` is always empty. The library prints nothing, writes nothing, and makes no network or model calls.

Run one pair of JSON files with:

```sh
node src/route.mjs --input input.json --record record.json --json
```

Without `--json`, the command prints a one-line summary.

## Edge cases

- An accepted offer's brief places the original offered request first, then a blank line, then the person's acceptance message. This keeps both unchanged and makes the requested task visible before the yes.
- Empty message text and empty memory text are valid because a host can receive or grant an empty value. Identifiers, descriptions, and memory contract labels must not be empty.
- Extra valid person approvals for one action are ignored after the first approval id in fixed lexical order. This prevents one action from appearing twice while keeping the result deterministic.
- Approvals for absent actions and memory grants for another job are reported as ignored or dropped. They do not make the whole routing request invalid because a host log can legitimately contain earlier entries.
- `quickSteps` must be from 1 through 1000, matching the allowed range for `steps`.

## Tests

Requires Node 22 or later. From this folder run:

```sh
npm test
```

The tests use invented data only and cover the 24 routing cases plus approval use, action digests, offer use, memory sharing, hostile text, fixed output, clock independence, and refused inputs.
