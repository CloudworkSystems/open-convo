# Capabilities

The contract every True Convo capability record (`capability.json`) follows,
and a validator for it. This is part 1 of
[docs/plans/media-generation-capability.md](../../docs/plans/media-generation-capability.md).
It only checks records. It runs nothing, reads no keys, contacts no host and
spends nothing. Part 2, below, is the signed spending cap and the ledger.
`make_media` (part 3) comes later in this package.

Node 22 or later. No dependencies.

```sh
cd packages/capabilities
npm test
```

## Command

From the repo root:

```sh
node packages/capabilities/src/check.mjs docs/skills/*/capability.json
```

It prints `ok` or each problem for every file. The exit code is 1 if any
file fails, the file can't be read, it isn't JSON, or no file was given.

`validateCapability(record)` is the same check as a function. It takes a
parsed record and returns `{ ok, errors }`, where each error is
`{ path, message }`, such as `routes[2].cost.price.currency`. It reports
every problem at once, never changes the record and does no I/O.
`formatErrors(errors)` turns the list into lines.

## The record

At most 64 KB. Unknown fields are refused at every level, so a typo can't
pass silently and nothing like an "always allow" switch can be slipped in.

| Field | Rule |
|---|---|
| `id` or `skill_id` | Exactly one. Lower-case words joined by hyphens, up to 64 characters. `skill_id` is the name today's skill records use. |
| `title` | Required text, up to 120 characters. |
| `version` | Required, `major.minor.patch`. |
| `status` | Required: `draft`, `tested` or `retired`. A `tested` record names at least one model in `models_passed`. |
| `created` | Optional date, `YYYY-MM-DD`. |
| `body`, `example_runs`, `recipe` | Optional `.md` files inside the capability's folder (no `..`, no absolute path). `recipe` points to a `SKILL.md`; it helps a model fill the inputs and never runs anything. |
| `kind`, `trigger_phrases`, `credit` | Optional text, as today's skill records use them. |
| `scripts` | Optional, and must be empty: no capability ships scripts until a tested permission boundary exists. |
| `actions_needing_approval`, `not_proven` | Required lists of text (may be empty). |
| `models_passed` | Required list of model names, each once. |
| `install_gate` | Required: `outcome` is `not run yet`, `native`, `partial` or `needed`; optional `expected` (one of the last three) and `note`. |
| `inputs` | Optional. Named fields (`lower_case`), each with a `type` and its limit: `string` needs `max_length`; `integer` and `number` need `min` and `max`; `enum` needs `values`; `files` needs `max_items`, `max_bytes` and `types` (file types such as `image/png`). `boolean` needs none. Each may say `required` and `description`. |
| `outputs` | Optional. Named outputs with `type` `file`, `receipt`, `text` or `data`. A `file` names the app `folder` it lands in (for example `media`), never a path. |
| `routes` | Optional list of the ways it can run (below). |

### Routes

| Field | Rule |
|---|---|
| `id` | Required, unique in the record, hyphenated like `id`. |
| `kind` | Required: `upload`, `local`, `own_key` or `sign_in`. |
| `title` | Optional text. |
| `provider`, `model` | Required for every kind except `upload`. |
| `hosts` | Required list of every outside host, each written as its https origin (`https://api.example.com`: lower case, no port, path, wildcard or IP address), each once. Empty for `upload` and `local`; at least one for `own_key` and `sign_in`. |
| `leaves_machine` | Required plain words on exactly what is sent. Exactly `nothing` for `upload` and `local`; never `nothing` for the others. |
| `cost` | `"free"` for `upload` and `local`. For the others: `unit` (`per_run`, `per_second`, `per_image` or `per_credit`), `price`, `source` (an https link), `checked` (date) and `max_per_run`, plus an optional `note`. |
| `needs` | Optional, and never on `upload`: `memory_gb`, `disk_gb`, `server` (such as ComfyUI) and `downloads` (each `what`, `size_gb` and an https `from`). |
| `terms` | `sign_in` only, and required there: an https `url` to the provider's terms that allow this use, and the date `checked`. No link, no route. |
| `license` | `local` only, and required there: `name`, `checked` (date), `allows_intended_use` (must be `true`: a model whose license doesn't allow the use isn't offered as a route), optional https `url` and `note`. |

A record with routes has exactly one `upload` route, the floor that always
works and needs nothing set up (no `needs`), so it also has a `file`
output. Every record with routes has a `receipt` output too. A record with a paid route
(`own_key` or `sign_in`) must also have an `upload` or `local` route, so paid
is never the only way.

**Money.** Every amount is an object with `amount` as decimal text (`"0.40"`,
up to six decimal places, never a JSON number, so sums don't drift) and an
ISO 4217 `currency` (`USD`). A route's `max_per_run` uses the same currency
as its price and is more than 0. The recorded price is only for showing a
rough figure; it never authorizes a run (the plan's "The price is checked
again").

A route's `hosts` are what the risk review holds for the owner
([docs/plans/risk-review.md](../../docs/plans/risk-review.md)). They are
written as `https://` origins because that is the form the risk check reads,
so a real host in any record holds the pull request for the owner; a test
checks this. This package lists them; it never contacts them.

## Tests

The tests check every `docs/skills/*/capability.json` (today,
`first-principles-decision`) and an invented media record in
`tests/fixtures/make-media.json` with an upload, a local and an own-key
route. All names, hosts (`example.com`) and prices there are invented.

## Part 2: signed cap and ledger

A spending cap and a ledger the part 3 runner and the Mac app (part 4) call.
Signing uses ECDSA P-256 and SHA-256 over the canonical JSON of the cap,
with the signature in X9.62 DER. That is the shape the Mac Secure Enclave
produces (`ecdsaSignatureMessageX962SHA256`), so part 4's key fits without a
format change. This package checks signatures. It does not hold a key, read
the clock, open a network connection or spend anything.

Until part 4 keeps the protected state in the Keychain, the cap is designed,
not enforced. A test here shows that an edited, missing, unsigned or older
cap is treated as $0, and that a damaged ledger stops paid runs. It cannot
show that another process running as the same person is unable to write the
Keychain item. That proof is part 4.

### Money

An amount is `{ amount, currency }`. `amount` is decimal text such as
`"0.40"`, up to six decimal places, never a JSON number. `currency` is an
ISO 4217 code. Sums and comparisons use whole micro-units (`BigInt`,
millionths of the unit). Two currencies are never added or compared.
`0.1 + 0.2` is `0.3`.

### Cap record

| Field | Rule |
|---|---|
| `revision` | Whole number, 1 or more. A new cap must be a higher revision than the one installed. It does not have to be the next integer. |
| `currency` | The person's currency. Every level uses it. |
| `timeZone` | An IANA zone, such as `America/Los_Angeles`. The month is that zone's calendar month. |
| `perRun`, `monthlyByCapability`, `monthlyAll` | Money in `currency`. Zero is allowed: a signed zero is a real cap, and a paid run does not fit. |
| `paused` | `true` or `false`. A paused cap checks out, and paid runs stop. |
| `conversion` | `null`, or the one rate the person signed. See conversion below. |

Unknown fields are refused. The canonical JSON (sorted keys, no extra
space) is what gets signed and hashed. `verifyCap(record, signature, publicKey, protectedState)`
accepts the record only when the signature checks out and the revision and
hash match the protected state. A missing record before any cap is installed
means "Set a cap first." An edited record, a bad signature, a missing record
after a cap was installed, or an older validly signed record all come back
as a $0 cap.

`acceptCap(store, record, signature, publicKey)` installs a higher signed
revision and clears any tightening. The caller passes the public key. Part
4 passes the Secure Enclave key. This part does not pin a key of its own.

### Protected state

`{ capRevision, capHash, tightening, ledgerHead, ledgerCount }`. The library
reads and writes it only through a store: `read()` and `write(next, expected)`.
`write` returns false when the stored value is no longer `expected`.
`memoryStore()` and `fileStore(path)` are the doubles for this part. Part 4
puts the same object in the Keychain.

`tightening` is the string `"none"`, or an object with `perRun`,
`monthlyByCapability`, `monthlyAll` and `paused`. `"none"` is written only
by a new signed cap. If the field is missing, damaged, higher than the
signed cap, or turns a pause off, the effective cap is $0.

`tighten(store, change, record, signature, publicKey)` lowers a level or
sets `paused` to true. It needs no new signature. The signed record is
checked first, because the store keeps only the hash. A change that raises
a level, even one that stays under the signed cap, or that sets `paused`
to false, is refused. A change that does not lower anything is refused.
The effective cap is the lower of the signed cap and the tightening.

### Ledger

The ledger file is `entries.jsonl` in the folder the caller names. Each
line is one entry:

`{ seq, kind, capabilityId, routeId, amount, estimated, jobId, at, month, prevHash, hash }`

`kind` is `reserve`, `settle`, `release`, `over-bill` or `checkpoint`. `hash` is the
SHA-256 of the canonical entry without `hash`, and `prevHash` is the
previous entry's hash (`null` on the first). `month` is the cap's calendar
month when the entry was written (`YYYY-MM`). A later cap with another time
zone does not move that month. Changing currency while the ledger has
entries is refused; `resetLedger` with the new currency clears the record
and installs that cap. The protected state's
`ledgerHead` and `ledgerCount` must match the file. A missing file (when
the state expects entries), a broken chain, a symlink in place of the
file, or a file longer than the head stops paid runs and says the record
was changed or is missing. A shorter file that still chains says it is an
older copy. The head is written before the new line. If the two disagree
after a crash, the next read stops paid runs the same way.

On the first write of a later month, completed runs from earlier months
fold into one `checkpoint` per capability and route: the settled total for
that month, covered by the same hash chain. Open runs are kept, so they
can still settle, and they still count in the month they were reserved.
The file is also refused, before it is saved, if it would pass 10,000
entries or 2 MiB. A saved ledger stays readable. The reason is that this
month's record is full.

`reserve`, `settle`, `release`, `resetLedger` and `monthSpent` take one
in-process queue per folder and an exclusive lock file (`ledger.lock`), so
two processes cannot both fit a run into the same remaining budget. A lock
that is already held is not taken. The run is refused.

| Call | What it does |
|---|---|
| `reserve({ ledgerDir, store, record, signature, publicKey, capabilityId, routeId, max, jobId, now, providerTotal? })` | Holds `max` against all three levels. Refuses a paused cap, a max of zero, a max over the per-run level, or a month that would go over. |
| `settle({ ...same, jobId, now, actual?, estimated? })` | `estimated: true` keeps the reserved maximum and marks it estimated. An `actual` at or under the reservation, including zero, settles that figure. An `actual` over it writes `over-bill`, counts the full bill, and returns `routeOff: true`. |
| `release({ ...same, jobId, now })` | Drops an open reservation. The job id stays used while that run is still in the ledger. After the month is folded, the id can be used again. |
| `monthSpent({ ...same, now, capabilityId?, routeId?, providerTotal? })` | `{ reserved, spent, counted }` for that month. `counted` is what the cap uses. A `providerTotal` also needs `capabilityId` and `routeId`, the route that key belongs to. |
| `resetLedger({ ledgerDir, store, record, signature, publicKey })` | Empties the ledger only when the caller presents a new signed cap, one with a higher revision than the cap already stored. The stored cap is refused, on a healthy ledger and on a damaged one. An older signed cap is refused. The new cap clears a tightening. |

`now` is an ISO time with a zone, such as `2026-11-15T18:00:00.000Z`. The
library does not call `Date.now()` or `new Date()` without an argument.

A run counts in the calendar month of its reservation, in the cap's time
zone, even when it is settled in a later month. The month runs from local
midnight on the first to local midnight on the first of the next month.
Open reservations and settled amounts both count. A release counts as
nothing. A settle replaces its reservation, so the two are not added.

When `providerTotal` is passed, it is the provider's own month figure for
one route's key, in the cap's currency. `reserve` already knows the route.
`monthSpent` needs `capabilityId` and `routeId` too, and refuses the call
without them. The check uses the higher of that figure and the settled
total on that route only, then adds open reservations and the settled
totals of the other routes. Comparing the figure with every route at once
would hide those other routes. A provider figure below that route's own
settled total does not lower it. A provider figure in another currency is
refused.

### Conversion

A quote in the cap's currency is used as it is. A quote in another currency
is refused unless the signed cap has a `conversion` for that currency:

| Field | Rule |
|---|---|
| `currency` | The foreign currency. It must not be the cap's currency. |
| `rate` | Cap-currency units for one unit of the foreign currency. Decimal text, up to 12 places, greater than 0. |
| `margin` | A fraction added on top, such as `"0.02"` for two percent. |
| `asOf` | When the person signed the rate. An ISO time. |

The cap amount is `quote × rate × (1 + margin)`, rounded up to the next
micro-unit. The result carries both amounts, for the card. A rate older
than 24 hours before `now` is refused, and so is a rate dated after `now`.
A rate that is exactly 24 hours old is still used. A third currency, one
the cap does not name, is refused.

`convertQuote({ quote, record, signature, publicKey, protectedState, now, rate })`
reads the rate from the signed cap. The `rate` argument is ignored, so a
caller cannot pass a friendlier one. `reserve` does not convert. It stores
the cap-currency maximum the card already showed. A bill in another
currency is converted the same way at settle, including when paid routes are
paused, because the run already started. If it cannot be converted, the
route is marked off and the reservation stays open. A pause still refuses
a new reservation.

### Command

```sh
node packages/capabilities/src/cap/show.mjs --ledger <dir> --state <state.json> --now <iso>
```

It prints the effective cap, what is reserved and spent this month across
every capability, and whether the ledger checks out. It creates no files
and takes no lock. The ledger folder may hold `cap.json`, `cap.signature`
(base64 DER) and `public-key.pem` beside `entries.jsonl`. With no cap file,
the command says to set a cap first.

### Edge cases

These are the choices the plan does not spell out. Each one has a test in
`tests/cap.test.mjs`.

- A signed cap of zero is a real cap. A missing or broken cap is $0 for a
  different reason ("Set a cap first", or the record does not check out).
- A pause on the signed cap and a pause in a tightening both stop paid
  runs. Turning paid runs back on, or raising a tightening, needs a new
  signed cap. Editing a tightening so it sits above the signed cap, or
  deleting it, gives $0 rather than the higher signed figures.
- A tightening that names another currency, or that changes nothing, is
  refused and the stored tightening stays as it was.
- The reservation's month is the one that is charged. Settling it later
  does not move the spend. An over-bill that arrives in a later month
  still counts, in full, in the reservation's month. It does not reduce
  the next month's room.
- A `ledger.lock` left behind after a crash is not removed. Paid runs stay
  refused until that file is deleted. The lock is not taken over while it
  is held.
- The show command reads without the lock, so a read in the moment between
  writing the ledger head and writing the line can say the ledger does not
  check out. The next read, after the write finishes, checks out.
- The provider's figure replaces only this route's settled total, and only
  when it is higher. Open reservations and other routes are added on top.
- An estimated settle ignores any `actual` sent with it. A real bill of
  zero closes the run and stops the reservation counting. `release` is
  only for a run that never started.
- A job id stays used after release, settle or over-bill, until that month is folded.
- `now` has to be a real ISO instant. `2026-02-31` is refused.
- A symlink in place of `entries.jsonl` is treated as a changed ledger.
- The show command's directory listing is unchanged after it runs.
- A closed month is kept as checkpoint totals, not every settled line.
  Which of those amounts were estimates is not kept. An open run from a
  closed month is kept until it settles or is released. A job id from a
  folded month can be used again.
- Amounts are stored and printed as the shortest decimal that round-trips
  (`"0.3"`, not a binary fraction). The signed cap keeps the text the
  person signed; the figures the ledger writes are the shortest form.
