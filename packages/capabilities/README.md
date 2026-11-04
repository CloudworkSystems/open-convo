# Capabilities

The contract every True Convo capability record (`capability.json`) follows,
and a validator for it. This is part 1 of
[docs/plans/media-generation-capability.md](../../docs/plans/media-generation-capability.md).
It only checks records. It runs nothing, reads no keys, contacts no host and
spends nothing. Part 2, below, is the signed spending cap and the ledger.
Part 3, further down, is `make_media` for an upload or a local ComfyUI run.

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
| `inputs` | Optional. Named fields (`lower_case`), each with a `type` and its limit: `string` needs `max_length`; `integer` and `number` need `min` and `max`; `enum` needs `values`; `files` needs `max_items`, `max_bytes` and `types` (file types such as `image/png` or `application/pdf`). `boolean` needs none. Each may say `required` and `description`. |
| `outputs` | Optional. Named outputs with `type` `file`, `receipt`, `text` or `data`. A `file` names the app `folder` it lands in (for example `media`), never a path. |
| `routes` | Optional list of the ways it can run (below). |

### Routes

| Field | Rule |
|---|---|
| `id` | Required, unique in the record, hyphenated like `id`. |
| `kind` | Required: `upload`, `local`, `own_key` or `sign_in`. |
| `title` | Optional text. |
| `provider`, `model` | Required for every kind except `upload`. An upload names neither. |
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
`write` returns false when the stored value is no longer `expected`, or when
the file cannot be saved.
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

`{ seq, kind, capabilityId, routeId, amount, estimated, jobId, at, month, rate, prevHash, hash }`

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
entries or 2 MiB. A reservation is refused when the file would not also
have room for that run's closing line, and for a closing line for every
reservation already open. Settling or releasing an open run uses that
room, so it is not refused for size. A saved ledger stays readable. The
reason is that this month's record is full.

`reserve`, `settle`, `release`, `resetLedger` and `monthSpent` take one
in-process queue per folder and an exclusive lock file (`ledger.lock`), so
two processes cannot both fit a run into the same remaining budget. The
lock names the process and the thread that hold it, and stays open while
that work runs. A lock left by a process that has exited, or by a
background task in this app that has stopped, is removed and the run goes
ahead. On Linux the task's thread id is the signal, because a stopped
task shares the process id with the rest of the app. On macOS the open
lock file is the signal: it closes when that task stops. A lock that is
still held is not taken, and the run is refused. The protected-state
file uses the same rule.

| Call | What it does |
|---|---|
| `reserve({ ledgerDir, store, record, signature, publicKey, capabilityId, routeId, max, jobId, now, providerTotal? })` | Holds `max` against all three levels. Refuses a paused cap, a max of zero, a max over the per-run level, or a month that would go over. A conversion rate that is more than a day old, or dated after `now`, is not stored on the line. The returned `seq` is the number written on the saved line. |
| `settle({ ...same, jobId, now, actual?, estimated? })` | `estimated: true` keeps the reserved maximum and marks it estimated. An `actual` at or under the reservation, including zero, settles that figure. An `actual` over it writes `over-bill`, counts the full bill, and returns `routeOff: true`. |
| `release({ ...same, jobId, now })` | Drops an open reservation. The job id stays used while that run is still in the ledger. After the month is folded, the id can be used again. |
| `monthSpent({ ...same, now, capabilityId?, routeId?, providerTotal? })` | `{ reserved, spent, counted }` for that month. `counted` is what the cap uses. A `providerTotal` also needs `capabilityId` and `routeId`, the route that key belongs to. |
| `resetLedger({ ledgerDir, store, record, signature, publicKey })` | Empties the ledger only when the caller presents a new signed cap, one with a higher revision than the cap already stored. The stored cap is refused, on a healthy ledger and on a damaged one. An older signed cap is refused. The new cap clears a tightening. If that cap was saved but the ledger file could not be replaced, the same signed cap can finish the reset. Until then, paid runs stay stopped. |

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
the cap-currency maximum the card already showed, and it stores the signed
conversion on that line (`currency`, `rate`, `margin`, `asOf`), under the
hash. A bill in another currency is converted with that recorded rate,
including when paid routes are paused and including when the rate is more
than a day old, because the run already started. A newer signed rate does
not change a bill for a run that was already reserved. A rate older than a
day, or dated after `now`, is not stored, so a reservation in the cap's
currency still goes through. A new quote in the other currency is refused.
A foreign bill for a run reserved without a stored rate is refused, the
route is marked off, and the reservation stays open. A converted amount
above `999999999.999999` is recorded as that largest figure, the route is
switched off, and the ledger stays readable. If the bill cannot be
converted, the route is marked off and the reservation stays open. A pause
still refuses a new reservation. A missing, edited or unsigned cap stops a
new reservation. It does not stop the bill, including an over-bill, or the
release for a run that already started.

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
- A `ledger.lock` left by a process that has exited, or by a background
  task in this app that has stopped, is removed by the next paid run.
  Stopping one background task does not look like the whole app is still
  holding the lock. A lock that is still held is not taken. The
  protected-state lock works the same way.
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
- A file write that the disk stops accepting is not renamed into place.
  The previous file stays. Saving the protected state then reports that
  the change was not saved, instead of failing with an exception.
- A reset that saves the new signed cap but cannot replace the ledger can
  be finished with that same cap. Paid runs stay stopped until the retry
  clears the file. Once the ledger is empty, that cap is refused again.
- A symlink in place of `entries.jsonl` is treated as a changed ledger.
- The show command's directory listing is unchanged after it runs.
- The first reservation of a later month folds completed history first. The `seq` it returns is the number on the saved line, after that fold, not the number the file would have used if the old lines had stayed.
- A closed month is kept as checkpoint totals, not every settled line.
  Which of those amounts were estimates is not kept. An open run from a
  closed month is kept until it settles or is released. A job id from a
  folded month can be used again.
- A reservation leaves room for its closing line, sized for the longest
  sequence number the record can hold. Filling the ledger with an open run
  still lets that run settle, including an over-bill, or be released, even
  after later runs make the sequence number longer. A further reservation
  is refused.
- A foreign bill is converted with the rate stored on its reservation.
  Advancing the clock past a day, or signing a new rate, does not change
  that bill. A reservation in the cap's currency still goes through when
  that rate is already more than a day old; the rate is not stored, and a
  foreign bill for that run is refused with the route marked off. A new
  quote still refuses a rate older than a day. A converted bill above the largest
  amount the ledger can store (`999999999.999999`) is recorded as that
  amount, the route is switched off, and later reads still check out.
- A bill or a release for a run that already started is recorded even when
  the cap record is missing, edited or unsigned. A new reservation still
  needs a cap that checks out.
- Amounts are stored and printed as the shortest decimal that round-trips
  (`"0.3"`, not a binary fraction). The signed cap keeps the text the
  person signed; the figures the ledger writes are the shortest form.

## Part 3: make_media, upload and local

The runner for `make_media`. It checks the capability record with part 1
first. Upload and local are free, so this part does not reserve or settle
on the cap. `own_key` and `sign_in` come back as "not available yet" and
are never run. A paid run waits for parts 4 and 5.

The caller passes the time as `now()`, a function that returns an ISO time.
The library does not read the clock. The command is the caller, so when
`--now` is left off it uses the machine clock.

### Route list

`listRoutes(record, setUp)` returns `{ offered, setup, unavailable }`.
`setUp` is the route ids the person has ready (an array or a `Set`).
Upload is always offered. A local route is offered when its id is in
`setUp`, and otherwise it is a set-up choice. Free routes come first.
Paid routes are only in `unavailable`, even if their id was passed in
`setUp`.

### Upload

Choosing upload or local checks that every file type on the record is one
this runner can read: `image/png`, `image/jpeg`, `image/gif`, `image/webp`,
`image/heic`, `image/avif`, `video/mp4`, `video/quicktime`, `video/webm` or
`video/x-matroska`. Another type, such as `application/pdf`, can still be
in a record that is not run here. The file is then checked against the
record's `files` inputs: the bytes have to
match a type that input allows, and the size has to fit that same input.
The type comes from the bytes, not the name. A symlink is not followed.
The copy gets a new name in the media folder, and the receipt is
`<file>.receipt.json` beside it. The receipt is readable and writable
only by the account that saved it.

`madeHow` is `filmed-or-drawn-by-me`, `made-with-ai` or `not-sure`. The
receipt's `ai_label` is `made by AI`, `not sure`, or left off. It is left
off only for "filmed or drawn by me" when the bytes do not contain the IPTC
markers `trainedAlgorithmicMedia` or `compositeWithTrainedAlgorithmicMedia`
(UTF-8, UTF-16LE or UTF-16BE). "Not sure" stays "not sure" even when a marker is there.
Site Engine treats "not sure" as AI.

### Local

The server URL has to be `http://127.0.0.1` or `http://[::1]`, with a port
and no path, user or name. `localhost`, any other address, and `https` are
refused before a connection. Every request is made with redirects off. A
3xx stops the run before anything else is sent or fetched.

The workflow file is `{ "kind": "image" or "video", "prompt": { ... } }`.
`prompt` is the ComfyUI graph. `kind` has to match the request. Exactly one
input is the whole text `{{prompt}}`. When the request sets `seconds`,
`width`, `height` or one reference file, that placeholder has to appear
exactly once too, and a placeholder with no value is refused. The value is
written into the parsed object (a number, or the file name) and then the
object is serialised. The prompt is never spliced into the JSON text.

Before anything is sent, every node's `class_type` has to be in
`src/media/nodes.mjs`: ComfyUI's built-in loaders, text encoders, samplers,
decoders, image and video save and load, and the local Wan, LTX, Hunyuan,
Mochi and Cosmos builders. An API node, a Partner node, a custom node, and
a built-in that is not in that list (such as the webcam) are refused.
The runner then asks ComfyUI which module provides each of those names.
A name on the list is still refused when ComfyUI says it comes from a
custom node or an API node, when it is marked as an API node, or when
ComfyUI does not say. The prompt and any reference are not sent.

A reference picture is checked only against the `reference_files` input,
then uploaded to that same ComfyUI (`/upload/image`),
and the name it returns is what goes in `{{reference_file}}`. When that
input is required, leaving it out is refused before anything is sent.
Another files input does not widen what a reference may be. The graph is
then posted to `/prompt`. Progress comes from ComfyUI's progress socket on
that same address. The estimate is the remaining time from progress so far
and the elapsed time. If the socket is not there, or it accepts and then
never finishes the upgrade, the run still finishes and the estimate stays
unknown. A redirect or a cancel on that socket still stops the run. Nothing is retried. A server that is not
running says `ComfyUI isn't running on this Mac` and how to open it.

Cancel uses that run's prompt id. A waiting job is removed from the queue
by that id. An interrupt is sent only when that id is the one running, and
the body names the id. Another job that is running is left alone. A queue
that cannot be read does not get an interrupt. The run is marked stopped
and no file is written.

The output is fetched from `/view` into the media folder under a new name.
It has to match the kind that was asked for: a clip is a video file, and a
still is an image. A preview still next to a clip is not returned as the
clip. The receipt says `made by AI`, `leaves_machine` `nothing`, and cost `free`.

### Receipt

| Field | What it is |
|---|---|
| `route` | The route id |
| `provider`, `model` | From the route. Both null for an upload |
| `prompt` | The prompt text, or null for an upload |
| `leaves_machine` | `nothing` |
| `cost` | `free` |
| `time` | An ISO time from `now()` |
| `ai_label` | `made by AI`, `not sure`, or absent when it counts as not AI |
| `file` | The new file name, not a path |

### Command

From the repo root:

```sh
node packages/capabilities/src/media/make.mjs --record <capability.json> --route upload --file <path> --made-how <answer> --media <dir>
node packages/capabilities/src/media/make.mjs --record <capability.json> --route local --server http://127.0.0.1:<port> --workflow <file.json> --prompt <text> --media <dir>
```

`--route upload` or `--route local` picks the one route of that kind.
`--kind`, `--seconds`, `--width`, `--height`, `--reference-file` and
`--now` are optional. Without `--kind`, a local run uses the workflow's
kind. The media folder has to exist already. The command prints the file
path and the receipt path.

### Edge cases

Each of these is covered in `tests/media.test.mjs`.

- Upload is offered even when nothing is set up. A local route that is not
  set up is a set-up choice, not a run. A paid route stays unavailable
  even if its id is listed as ready. Free routes stay first when the record
  lists a paid route above them.
- A file type the runner cannot read, such as `image/bmp`, `image/tiff` or
  `application/pdf`, is refused when upload or local is chosen, before any
  file is copied and before a connection. The shared record check still
  allows that type. The upload type is sniffed from the bytes. A `.png` name full of text is
  refused. A file one byte over the record's limit is refused and not
  copied. A file the record allows, but that is over 64 MiB, is refused
  before it is read. A file under that limit is read in small pieces, not
  held all at once. The source file is left where it was. The saved name is new.
- An `ftyp` file is not treated as MP4 until its brand says so. QuickTime
  (`qt`) is `video/quicktime`. HEIC and AVIF stay images. An MP4 brand is
  `video/mp4`. A Matroska file shares WebM's opening bytes. It is WebM only
  when its DocType is `webm`. A DocType of `matroska` is its own video type.
- The local prompt has to be the record's string input. An enum or other
  prompt field is refused, and a prompt longer than that string's limit is
  refused before anything is sent. An upload route that names a provider
  or a model is refused the same way. An upload receipt leaves both empty.
  The receipt file is private to the account that saved it.
- "Filmed or drawn by me" with no marker has no `ai_label`. The same answer
  on `trainedAlgorithmicMedia` or `compositeWithTrainedAlgorithmicMedia`,
  including UTF-16 little-endian and big-endian, is `made by AI`. "Not sure" stays `not sure` even with
  a marker. "Made with AI" is `made by AI` with no marker.
- A symlink source or a symlink media folder is refused.
- A record with no `files` input cannot accept an upload, because there is
  no limit to check.
- `localhost`, `127.0.0.2`, an IPv4-mapped address, a name, a user in the
  URL, a path, and `https` are refused before a connection. `::1` is
  accepted. A redirect on the prompt, on the reference upload, on the
  progress socket, or on the file fetch stops the run, and the address in
  `Location` is not contacted. A redirect to a machine that is not this one
  stops the same way.
- A workflow kind that is not the request's kind is refused. `{{prompt}}`
  has to be the whole of exactly one field. The same token inside a longer
  sentence does not count. Two prompt fields are refused. A placeholder
  with no value is refused, and a value with no placeholder is refused
  rather than keeping the template's number. The person's prompt is placed
  as a JSON value, so quotes, script tags, line breaks and right-to-left
  marks stay inside that one field. A prompt whose text is `{{prompt}}` is
  stored as that text and is not expanded again.
- A node id of `__proto__` is refused. Seconds, width and height have to be
  whole numbers inside the record's limits. When the record marks one of
  those as required, leaving it out is refused before anything is sent.
- Cancelling before the run has contacted the server sends nothing. Cancelling
  while that first connection is still opening stops the run and does not
  send the prompt. Cancelling after the job has been sent, while the answer
  that names it is still on its way, waits for that answer (bounded by the
  request timeout) and then stops that job. If that answer times out or the
  connection drops after the job was sent, and the run was cancelled, that
  job is found by the client id sent with it and then stopped. That is the
  id the server assigned, even when the server did not use the id we sent.
  Cancelling
  a waiting job deletes that prompt id and does not interrupt a different
  running job. If that job starts running before the delete arrives, the
  queue is read again. If it is not listed yet, it is read once more, and
  that id is interrupted only when it is the one
  running. Cancelling the running job sends an interrupt that names
  that id, and a different waiting job stays queued. If the queue cannot be
  read, no interrupt is sent. The run is still marked stopped.
- A job ComfyUI has already finished does not emit progress. While it is
  running, progress is a fraction `value / max` from the progress socket,
  and the remaining time is `elapsed * (1 - progress) / progress`. A
  progress callback that throws does not stop the run. If the socket never
  opens, or it accepts and then never finishes the upgrade, the file still
  comes back. Cancelling during that wait still stops the run before the
  prompt is sent.
- ComfyUI answering with an error, or not answering, does not submit the
  prompt again. An output name that is not a plain file name is not
  fetched. A file over the output limit (64 MiB, or a lower limit the
  caller passes) is not saved. A reference upload that returns a path is
  not used, and the prompt is not sent.
- A video workflow saves a video extension, including MKV when that is the
  file ComfyUI made. The receipt still says made by AI.
  When ComfyUI returns both a preview still and a clip, the clip is the one
  saved for a video and the still is the one saved for an image. A video
  request that comes back with only a still is refused and nothing is fetched.
  The bytes of the file are checked too: a download that is not actually an
  image or a clip of the kind asked for is not saved. A file ComfyUI marks
  as an input, such as the picture that was uploaded, is not saved as the
  result. A run that finishes with only that file is refused and nothing
  is fetched. A temporary file is saved only when there is no generated one.
- A reference picture is accepted only when `reference_files` allows its
  type and size. A files input with another name does not. With no
  `reference_files` input, a reference is refused before any connection.
  When `reference_files` is required, leaving it out is refused before any
  connection. An optional one can still be left out.
- A request whose cancel already happened does not open a connection.
- The library files other than the command do not call `Date.now()` or
  `new Date()` without an argument. A `now()` that does not return an ISO
  time is refused before a connection.
