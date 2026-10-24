# Visibility report

A small library and command that turns one findings file into a plain-English
visibility report. It ranks problems with fixed rules and writes Markdown and
JSON. It does not gather findings, call the network, or use AI.

macOS and Linux only. On Windows the command stops with an error. An output
path that contains a backslash, a colon, or a trailing dot is refused.

Invented businesses only. This package adds no license of its own.

## Run

From the repo root:

```sh
node packages/visibility-report/src/report.mjs \
  --findings packages/visibility-report/fixtures/hearthwick-cycles.findings.json
```

`--json <file>` writes the JSON report and `--md <file>` writes the Markdown.
With neither, the command prints the Markdown. The sample shop is fictional:
Hearthwick Cycle Works, `555` phone numbers, and `.example` web addresses.

## Tests

```sh
cd packages/visibility-report
npm test
```

Tests use Node's built-in test runner (Node 22). `markdown-it` (MIT) is a dev
dependency used only to render Markdown in tests. The tests stub Node's
network and process entry points and then assert nothing called them.
