# Setup Check Engine (PRD)

Status: Draft (Oct 29): plan only; waiting on the owner's yes.

Written October 29, 2026 by a Claude session (project "261024 OC Steering",
thread "Draft next plans for outside builders"). Session name:
`OC-261029-setup-check`. Umbrella: Personal. First slice of the
**first-run guide** (PLAN.md, "After the Top Five": "checks the computer,
sets up a local model or a cloud model. Needed before anyone else
installs"). Built by an outside builder under AGENTS.md "Outside Builders":
**GrokBot team A** builds, through Cursor and signed in as `cloudwork-bot`;
**Codex** reviews; the coordinator checks the result against this plan. It
takes one of the outside-builder places.

## Why

Nobody but the owner can install True Convo today, because nothing tells a
new person whether their Mac can run a local model, which one fits, or what
to do next. The answers are rules, not judgement: a Mac with 8 GB of memory
can't run an 8-billion-parameter model well; a model needs room on disk;
Ollama has to be installed and running before a local chat can start. Those
rules belong in one small, tested library that the app's first-run screens
can call, so every screen and every later device gives the same answer.

## Plan Of Record

1. **Now (this slice):** a deciding library on its own. A description of
   the computer in, a checklist and a recommendation out. It runs no
   commands, reads no system files, installs nothing and calls no network.
2. **Next (building lanes):** a small Mac adapter that gathers the facts
   (memory, free disk, macOS version, whether Ollama answers on its local
   port, which models it has), and the first-run screens in the Desk that
   show the checklist and walk through each step with the owner's approval
   where one is needed (foundations principle 6 for any cloud model).
3. **Later:** the same rules for the iPhone, Windows and Linux, each with
   its own facts adapter.

## What It Does

A small library and command in `packages/setup-check/`:

```
node packages/setup-check/src/check.mjs --facts <facts.json> [--json]
```

and the same as a function, `checkSetup(facts, catalog?)`, exported from
`src/index.mjs`. It returns the result synchronously, prints nothing, never
reads the clock and never calls `process.exit`. `catalog` defaults to the
package's own `catalog.json`.

### The Facts File

`schemaVersion: 1`, at most 64 KB, with:

- `os`: `{ name: "macOS", version }`, `version` as `major.minor[.patch]`.
- `chip`: `apple-silicon` or `intel`.
- `memoryGB`: a number, 1 to 1,024.
- `freeDiskGB`: a number, 0 to 100,000, for the volume that holds the
  app's data.
- `ollama`: `{ installed, running, version?, models }`. `installed` and
  `running` are booleans; `running` true needs `installed` true. `models`
  is up to 200 `{ name, sizeGB }` entries, names as Ollama gives them
  (`qwen3:8b`), each name once.
- `cloud`: `{ approvedHosts }`, up to 20 host names the owner has already
  approved for cloud models (an empty list is normal on a new Mac).
- `preferences` (optional): `{ mode }`, `local` (the default), `cloud` or
  `either`.

Unknown fields, missing required fields, repeated model names and values
out of range are refused with a plain message naming the field. A refusal
produces no result.

### The Model Catalog

`catalog.json` in the package lists the local models the guide may
recommend, best first: `{ schemaVersion: 1, models: [{ name, sizeGB,
minMemoryGB, note }] }`. It starts with three entries: `qwen3:8b` (the
Desk's default local model, `apps/desk/src/domain/local-participant.ts`)
and two smaller fallbacks from the same family. The builder takes each
model's download size from its page on ollama.com, writes the source and the
date in the README, and sets `minMemoryGB` to the smallest memory the README
can justify (for `qwen3:8b`, at least 16). The catalog is data: the owner can
change it later without changing code, and the tests read it rather than
repeating its numbers.

## Building The Result

1. **Check the input** as above, and check the catalog the same way.
2. **The checks**, in this fixed order, each `{ id, state, message, fix? }`
   where `state` is `pass`, `warn` or `stop`:
   - `os`: macOS 13 or later passes (the Mac app's minimum,
     `apps/mac/Package.swift`); earlier stops.
   - `chip`: Apple silicon passes; Intel warns that local models will be
     slow and suggests a cloud model.
   - `memory`: passes when at least one catalog model fits (`memoryGB >=
     minMemoryGB`); otherwise warns that only a cloud model will work.
   - `disk`: passes with room for the recommended model plus 5 GB; warns
     when only the model fits; stops when it doesn't fit and no fitting
     model is already installed.
   - `ollama`: passes when installed and running; warns "installed but not
     running" with the fix "Open the Ollama app"; when not installed, the fix
     names ollama.com/download. Skipped (state `pass`, message says why)
     when `preferences.mode` is `cloud`.
   - `model`: passes when a fitting catalog model is already installed;
     otherwise warns with the download step for the recommended model.
   - `cloud`: only when the local route can't work or `mode` isn't `local`:
     passes when a cloud host is already approved; otherwise warns that a
     cloud model needs the owner's one-time approval of its host first.
3. **The recommendation:** `{ route, model?, reason }`. `route` is `local`
   when the local checks have no `stop` and a catalog model fits, else
   `cloud` when `mode` allows it, else `none`. The local model is the first
   catalog entry that fits memory and is installed; failing that, the first
   that fits memory and disk. The reason is one plain sentence built only from
   the checks.
4. **Next steps:** the `fix` of every `warn` and `stop` check, in check
   order, numbered. Command text in a step (for example
   `ollama pull qwen3:8b`) is shown for the person to run; the engine never
   runs it.
5. **The summary:** one to three short sentences from a fixed template, for
   example: "This Mac can run a local model. Install Ollama, then download
   qwen3:8b." Sizes in the summary come from the catalog. No sentence
   promises speed or quality beyond what the checks say.

**Same input, same result.** The same files give byte-identical JSON, and
shuffling `models` or `approvedHosts` gives the same result. Nothing depends
on the clock, the machine running the engine, its locale or random values.

## Output

`{ schemaVersion: 1, ready, summary, checks, recommendation, nextSteps }`.
`ready` is true only when the recommended route needs no further step. The
command's plain summary prints the summary, then each check as
`✓`, `!` or `✗` with its message, then the numbered steps. Text from the
input is printed on one line, with line breaks and tabs written as `\n` and
`\t`, and bidirectional control characters escaped.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/setup-check`, Node's built-in test runner, invented
machines only. At least:

1. A new 16 GB Apple-silicon Mac with no Ollama gives a result whose JSON
   matches a saved expected file exactly.
2. Each check's pass, warn and stop cases above, including macOS 12 (stop),
   an Intel Mac (warn), 8 GB with only the smallest catalog model fitting,
   4 GB with none fitting, and disk with room for the model but not the
   extra 5 GB.
3. Recommendation: an installed fitting model beats a better one not yet
   downloaded; a model installed but too big for memory is not recommended;
   `mode: cloud` skips the Ollama checks; no route gives `none` with steps.
4. A test catalog with different entries changes the recommendation without
   code changes.
5. Input checks: each refusal above names the field; `running: true` with
   `installed: false` is refused; a repeated model name is refused.
6. Hostile but valid text in model and host names (quotes, `<script>`,
   right-to-left text, bidirectional controls) is returned unchanged in the
   JSON and safe on one line in the summary.
7. Determinism and no clock: shuffled lists give byte-identical JSON; the
   engine runs with `Date.now` and an argument-less `Date` stubbed to throw.
8. Nothing run, nothing fetched, nothing written: the test setup makes
   Node's network and `child_process` built-ins throw if called, and the
   library writes no files.

## Out Of Scope For This Slice

Gathering the facts from the real computer, running or installing anything,
downloading models, talking to Ollama, approving cloud hosts, any app or Desk
screen, any AI, storage or encryption code, network, and real personal data.

## Rules For The Builder (GrokBot Team A)

These are rules the builder must follow; the setup does not enforce them, so
breaking one is a stop-and-report event.

- Start when the coordinator's build issue names this plan. Work only in a
  checkout of this repo, through Cursor, on the branch
  `OC-261029-setup-check`, signed in as `cloudwork-bot`. Open a pull request
  into `main` with auto-merge off and the label `agent: grokbot`. Never push
  to `main` directly, and never switch on auto-merge.
- Mark the work as AGENTS.md "Accounts And Provenance" says: `Cursor Agent`
  as commit author, and `— GrokBot team A` as the last line of the pull
  request description and every comment.
- Run **no commands on the owner's Mac** for this job.
- Touch no keys, tokens, passwords, accounts, Keychain, iCloud or private
  files. Invented data only.
- Change files only under `packages/setup-check/`. Nothing else, not even
  `STATUS.md`. Import nothing from `apps/` or another package.
- JavaScript modules (`.mjs`), Node 22 or later, `"type": "module"`,
  `"private": true`, tests with `node --test`.
- No network calls, no AI, no paid services, no `child_process`, in the code
  or the tests. Reading ollama.com by hand to fill the catalog is fine.
- No new dependencies. Add no license file and no `license` field.
- Keep the slice small: the engine, the catalog, the command, the tests and
  a short README with the facts file, the catalog and its sources, and the
  output. Finishable in one to two days.
- The pull request says what was built, how to run the tests, what was not
  done, and anything unsure.
- Supported setups are macOS and the Linux CI runners on Node 22 (AGENTS.md
  "Review Guidelines"); don't add Windows-specific code.
- Edge cases this plan doesn't name: write each choice in the README's "Edge
  cases" section with a test.

## Review And Finish Line

Codex reviews it as code until it gives a 👍 (GrokBot builds, Codex
reviews). GrokBot fixes every P1 and P2 or explains in the pull request why
one doesn't apply. The coordinator checks it against this plan, posts the
check as a comment, gives the owner a short try-it note, and switches on
auto-merge once the plan check passes. Done when the tests pass with one
command, Codex has no open P1 or P2 on the latest commit (or the Codex triage
judge passes it, [codex-triage.md](codex-triage.md)), and the plan check
finds nothing missing.
