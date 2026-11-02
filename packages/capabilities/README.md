# Capabilities

The contract every True Convo capability record (`capability.json`) follows,
and a validator for it. This is part 1 of
[docs/plans/media-generation-capability.md](../../docs/plans/media-generation-capability.md).
It only checks records. It runs nothing, reads no keys, contacts no host and
spends nothing. The cap and ledger (part 2) and `make_media` (part 3) come
later in this package.

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
| `hosts` | Required list of bare lower-case host names (`api.example.com`: no scheme, port, path, wildcard or IP address), each once. Empty for `upload` and `local`; at least one for `own_key` and `sign_in`. |
| `leaves_machine` | Required plain words on exactly what is sent. Exactly `nothing` for `upload` and `local`; never `nothing` for the others. |
| `cost` | `"free"` for `upload` and `local`. For the others: `unit` (`per_run`, `per_second`, `per_image` or `per_credit`), `price`, `source` (an https link), `checked` (date) and `max_per_run`, plus an optional `note`. |
| `needs` | Optional, and never on `upload`: `memory_gb`, `disk_gb`, `server` (such as ComfyUI) and `downloads` (each `what`, `size_gb` and an https `from`). |
| `terms` | `sign_in` only, and required there: an https `url` to the provider's terms that allow this use, and the date `checked`. No link, no route. |
| `license` | `local` only, and required there: `name`, `checked` (date), `allows_intended_use` (true or false), optional https `url` and `note`. |

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
([docs/plans/risk-review.md](../../docs/plans/risk-review.md)). This package
lists them; it never contacts them.

## Tests

The tests check every `docs/skills/*/capability.json` (today,
`first-principles-decision`) and an invented media record in
`tests/fixtures/make-media.json` with an upload, a local and an own-key
route. All names, hosts (`example.com`) and prices there are invented.
