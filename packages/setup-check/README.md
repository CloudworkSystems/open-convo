# Setup check

A small library that turns a description of a Mac into a checklist and a recommendation. It decides. It does not look at the computer it is running on, install anything, download anything, or talk to the network.

The Desk's first-run screens can call it later. This package is only the rules.

Node 22 or later. No dependencies.

```sh
cd packages/setup-check
npm test
```

## Command

From the repo root:

```sh
node packages/setup-check/src/check.mjs --facts path/to/facts.json
node packages/setup-check/src/check.mjs --facts path/to/facts.json --json
```

Without `--json` it prints the summary, then each check, then the numbered steps. `--json` prints the result object. A refusal prints one plain message and no result. The command's exit code is 1 for a refusal and 0 for a result.

`checkSetup(facts, catalog?)` is the same decision as a function. It returns the object, prints nothing, and never calls `process.exit`. `catalog` defaults to this package's `catalog.json`.

## Facts file

`schemaVersion` 1. At most 64 KB (the command measures the file; the function measures the compact JSON). Invented example of a new Mac:

```json
{
  "schemaVersion": 1,
  "os": { "name": "macOS", "version": "15.0" },
  "chip": "apple-silicon",
  "memoryGB": 16,
  "freeDiskGB": 100,
  "ollama": { "installed": false, "running": false, "models": [] },
  "cloud": { "approved": [] }
}
```

- `os.name` is `macOS`. `os.version` is `major.minor` or `major.minor.patch`, with no leading zeros (`15.0`, `13.0.1`).
- `chip` is `apple-silicon` or `intel`.
- `memoryGB` is a number from 1 to 1,024. `freeDiskGB` is a number from 0 to 100,000.
- `ollama.installed` and `ollama.running` are booleans. `running: true` requires `installed: true`. `models` is up to 200 `{ name, sizeGB }` entries. Each name appears once. `sizeGB` is greater than 0 and at most 100,000. `version` is optional text, with no length cap of its own, and is not used in the decision. Empty text is out of range.
- `cloud.choice` is optional `{ model, host }`. `cloud.approved` is up to 20 `{ model, host }` pairs. Each pair appears once.
- `preferences` is optional. `preferences.mode` is `local` (the default), `cloud`, or `either`.

Unknown fields, missing required fields, repeated names, and values outside these ranges are refused. The message names the field. The first problem wins, in this order: the value must be a plain object, then the 64 KB limit, then `schemaVersion`, then unknown fields, then required fields from `os` through `preferences`.

Gigabytes are compared in thousandths, so a catalog size such as 5.2 does not drift.

## Catalog

`catalog.json` lists the local models the guide may recommend, best first. The file's order is the preference order. The owner can change the numbers later without changing code. Tests read the file rather than copying its numbers into code. `note` is kept for the owner and does not change the result.

Sizes were read on November 1, 2026 from the Ollama library tags (the same figures are on each model's page):

| Model | Download | Minimum memory | Source |
| --- | --- | --- | --- |
| `qwen3:8b` | 5.2 GB | 16 GB | <https://ollama.com/library/qwen3:8b> |
| `qwen3:4b` | 2.5 GB | 12 GB | <https://ollama.com/library/qwen3:4b> |
| `qwen3:1.7b` | 1.4 GB | 8 GB | <https://ollama.com/library/qwen3:1.7b> |

`qwen3:8b` is the Desk's default local model. An 8 GB Mac cannot run an 8-billion-parameter model well, so 16 GB is the minimum. The 4B tag is 2.5 GB of weights with a 256K context window; 12 GB is the smallest Mac this guide will call enough for macOS, those weights, and a useful context. The 1.7B tag is 1.4 GB; 8 GB leaves a thin margin after macOS, and 4 GB does not. That is why an 8 GB Mac fits only `qwen3:1.7b`, and a 4 GB Mac fits none of the three.

## Output

```json
{
  "schemaVersion": 1,
  "ready": false,
  "summary": "This Mac can run a local model. Install Ollama, then download qwen3:8b (5.2 GB).",
  "checks": [],
  "recommendation": { "route": "local", "model": "qwen3:8b", "reason": "A catalog model fits and no check stops a local model." },
  "nextSteps": []
}
```

`ready` is true only when `nextSteps` is empty. `route` is `local`, `cloud`, or `none`. A cloud recommendation adds `host` when a choice is set.

Checks, in this order: `os`, `chip`, `memory`, `disk`, `ollama`, `model`, and `cloud` only when the mode is `cloud` or the mode is `either` and a local model cannot run. Each check is `pass`, `info`, `warn`, or `stop`. `warn` and `stop` include `fix`. `info` and `pass` do not. The plain report marks them `✓`, `i`, `!`, and `✗`.

`nextSteps` is the fix for each warning or stop that applies to the recommended route, in check order, each distinct fix once. The command numbers them. A local route uses every check except `cloud`. A cloud route uses only `os` and `cloud`. A `none` route uses the macOS update when macOS is too old, or else the memory or disk block plus "or switch to a cloud model in settings". Ollama and download steps are left out of `none`, because they cannot help until that block is cleared.

Sizes named in the summary come from the catalog. The summary does not promise speed or quality. Strings are plain text; a screen that shows them should render them as text, not as HTML.

Steps are text for the person. The engine does not run them and does not shell-quote names. A download step looks like `ollama pull qwen3:8b`.

## Edge cases

- A missing `preferences`, or a `preferences` object with no `mode`, means `local`. `ollama.version` may be omitted. Neither changes the result.
- Key order in the facts does not change the result. Shuffling `ollama.models` or `cloud.approved` does not either. Shuffling the catalog does: the earlier entry wins.
- Names and hosts are compared exactly. They are not trimmed or case-folded. `qwen3:8b ` does not match `qwen3:8b`.
- An installed model that is not in the catalog is ignored. An installed catalog model that needs more memory than the Mac has is ignored. The installed `sizeGB` is checked and then ignored; disk rules use the catalog size.
- Exactly enough disk for the download, with less than 5 GB spare, warns and the route stays `local`. Exactly the model size plus 5 GB passes. With a fitting model already installed, less than 5 GB free warns "disk almost full" and never stops; exactly 5 GB free passes.
- The free-up amount uses the smallest memory-fitting catalog model, not the best one, and rounds up to a whole gigabyte. An exact whole number stays on that number.
- The cloud check is omitted when this route would not use a cloud model. On mode `cloud`, Ollama is a passing check whose message says it was skipped. On mode `either`, Ollama is still checked, and its warning is not a step when the route falls back to cloud.
- Mode `local` never recommends a cloud model, even when a cloud choice is already approved. Mode `either` does. Local warnings do not block that cloud route. Mode `cloud` never recommends a local model.
- On `none`, an old macOS is the only step, even if memory is also too small. The switch-to-cloud step is added only when memory or disk is the block and macOS already passes.
- When macOS is older than 13 and the mode is `either`, the route is `cloud`, because a local model cannot be set up. The reason names the macOS block. It does not claim the mode was `cloud`.
- macOS 13.0 and any later major pass. A version whose major is under 13 stops, including `0.1`. A version that is not `major.minor` or `major.minor.patch` is refused. `memoryGB` of 1 and 1,024, and `freeDiskGB` of 0 and 100,000, are accepted.
- An empty catalog is valid and means no local model fits.
- A facts value over 64 KB is refused before other field checks. A file of exactly 64 KB is still parsed. The command does not include the system error when a file cannot be read.
- `__proto__` in JSON is an unknown field and does not change the object's prototype.
- The summary is stored as one line: line breaks become `\n`, tabs become `\t`, and bidirectional controls (`U+061C`, `U+200E`, `U+200F`, `U+202A`–`U+202E`, `U+2066`–`U+2069`) become `\uXXXX`. The recommendation and the check text keep the original characters. Right-to-left letters and quotes stay as themselves. The plain report escapes every line the same way.
