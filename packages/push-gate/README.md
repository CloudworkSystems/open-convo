# Push Gate

The one paced door from the Studio to GitHub. Agents hand finished work to
the gate as a request. The gate checks it, paces it, writes to GitHub as
Cloudwork Agents with a token made for that one request, and writes back a
plain result. The plan is the contract:
[docs/plans/push-gate.md](../../docs/plans/push-gate.md).

Node 22, no dependencies. Both this folder and `scripts/push-gate/` are in
`.github/CODEOWNERS`: the limits live here, so every change needs the
owner's approval.

**Nothing runs by itself yet.** Until the key move (app switch, Build Order
step 4), every run is a command the owner approves in the OPEN-CONVO
session. The background job file in `scripts/push-gate/` is written but not
installed. Setup is in [scripts/push-gate/SETUP.md](../../scripts/push-gate/SETUP.md).

## Commands

Run from a fresh worktree of `main`:

```
node packages/push-gate/bin/push-gate.mjs token -- <command>
node packages/push-gate/bin/push-gate.mjs run-once
node packages/push-gate/bin/push-gate.mjs status
node packages/push-gate/bin/push-gate.mjs allow <request>
```

- `token -- <command>` runs one command with a one-hour Cloudwork Agents
  token and revokes the token when the command ends. `gh` finds it in its
  environment and `git` gets it through a sign-in helper that exists only
  for that command. It prints the hand-over line: "Cloudwork Agents token:
  App ID 5665711, installation 179798275, CloudworkSystems/open-convo,
  expires <time>". Add `--permissions contents:write,pull_requests:write`
  before `--` to ask for less than the default (contents, pull requests and
  issues).
- `run-once` handles every waiting request once. `run-once --restart` is the
  owner's restart after a stop (see "Pace limits").
- `status` lists each request's result. It needs no key and changes nothing.
- `allow <request>` lets one request through quiet hours.

Folders: `PUSH_GATE_HOME` (default `~/.push-gate`) holds the gate's own
files and its git checkout. `PUSH_GATE_SHARED` (default `<home>/shared`)
holds `requests/`, where agents drop requests, and `results/`, which only
the gate writes.

## Requests

A request is a JSON file in `requests/`. Its file name, without `.json`, is
the request's name (letters, numbers, `.`, `_` and `-`). Write it under
another name and rename it into place, so the gate never reads half a file.

Push a commit, and optionally open a pull request:

```json
{
  "kind": "push",
  "agent": "claude",
  "thread": "invented task name",
  "branch": "claude/invented-branch",
  "commit": "<the full 40-character commit id>",
  "bundle": "invented-branch.bundle",
  "review": { "reviewer": "codex", "commit": "<the same commit id>", "result": "clean" },
  "pullRequest": { "title": "Invented title", "body": "What changed.\n\nClaude, invented task name" }
}
```

Make the bundle with `git bundle create <file> origin/main..<branch>` and
put it beside the request. A bundle carries commits only, never settings or
hooks.

Comment on an open pull request, or on issue #52:

```json
{ "kind": "comment", "agent": "claude", "thread": "invented task name", "target": { "pull": 123 }, "body": "Text.\n\nClaude, invented task name" }
```

Use `"target": { "issue": 52 }` for issue #52. Reply on a review thread of
an open pull request:

```json
{ "kind": "reply", "agent": "claude", "thread": "invented task name", "pull": 123, "inReplyTo": 456, "body": "Text.\n\nClaude, invented task name" }
```

`agent` is `claude`, `codex` or `grokbot`. Merging, auto-merge, approving,
closing, editing issue bodies and other labels are not handled here; they
come with the routine moves, each with its own yes.

## Checks

A request that fails a check is refused with one sentence naming the request
and what to change, and is never retried as it is.

- **Branch:** never `main`; no spaces, no `..`, no leading `-`.
- **Push:** the bundle holds exactly the named commit; the commit builds on
  the current `main`; the branch only moves forward (no force push, ever);
  the bundle is under 50 MB; nothing under `.github/workflows/` changes.
- **Text** (titles, descriptions, comments, replies): the last line names
  the agent and its thread or task; no `owner-accepts-findings`; no `@`
  mention of anyone but `@codex` and `@cursor`; nothing that looks like a
  GitHub token, a private key or a 1Password sign-in; under 60,000
  characters.
- **Local review** (push requests): a record by a different agent than the
  builder, for the same commit, with the result `clean` or `findings
  answered`. The gate writes it into the pull request's description, above
  the sign-off line. It shows the process was followed. It doesn't prove who
  reviewed, since every agent runs as the same macOS user.
- **Pull requests** open as normal (not draft), with the label
  `agent: <builder>`, auto-merge off.

## Pace limits

- One push per pull request every 10 minutes. A newer push request for a
  branch replaces an older one still waiting.
- Quiet hours, 11 PM to 6 AM New York time, following daylight saving:
  requests wait until 6 AM unless the owner runs `allow`.
- About 60 writes an hour for all agents together. Over that, requests wait.
- A rate-limit answer from GitHub (429, or "secondary rate limit") stops
  every write for the wait GitHub names or an hour, whichever is longer.
  One note goes on issue #52 once writes resume. A 403 during a push that
  git passes on with no reason can't be told from a rate limit, so it is
  treated as one.
- A sign-in failure (401) stops every write until the owner restarts the
  gate with `run-once --restart`.
- Any other refusal from GitHub (403, 404, 422) refuses that one request
  with GitHub's reason. Three in an hour stop every write until restart.
- The write log (`<home>/work/write-log.jsonl`) has one line per write:
  time, kind, branch or pull request, result. It is kept 30 days and never
  holds a token or the text of a comment.

## Results

Each request gets `results/<name>.json` with a `state` and one `sentence`:

- `waiting`: why, and `until` when a time is known.
- `done`: the commit, and the pull request's number and link.
- `refused`: what is wrong and what to change.

## When it goes wrong

1. **No connection:** requests wait with "Waiting: GitHub can't be reached",
   and the gate tries again each run.
2. **Interrupted:** each request moves from waiting to working to done or
   refused, saved to disk before each step. A request left in working is
   checked against GitHub first (is the branch already at that commit, does
   the pull request or comment already exist), so nothing is pushed or
   posted twice.
3. **Nothing waiting:** a run does nothing and writes nothing, and `status`
   says "Nothing waiting."
4. **Key can't be opened:** every request waits with "Waiting: the push gate
   can't open its key. The owner needs to check 1Password."
5. **Every refusal** is one sentence naming the request and what to change.

## How it is built

- `src/app-token.mjs`: the token helper. A signed request as the app, a
  check that the installation reaches this one repo and nothing else, a
  token limited to this repo and the request's permissions, the hand-over
  line, and the revoke.
- `src/checks.mjs`, `src/pace.mjs`: the checks and limits, as plain
  functions.
- `src/git.mjs`: the gate's own bare checkout, with hooks off and no git
  settings read from the user or the system.
- `src/store.mjs`: the request, result, state and log files.
- `src/gate.mjs`, `src/cli.mjs`: the run and the command line.
- The Mac-only part, reading the app's key through the 1Password service
  account, is `scripts/push-gate/mac-seam.mjs`. The package asks it for the
  key through one function, `readAppKey()`, and tests pass a fake.

## Tests

```
npm test
```

Invented data only: a fake GitHub on `127.0.0.1` (API and git over HTTP), a
throwaway key made in the test, and temporary git repos. The plan's 14
tests are named "plan test N" in `tests/`.
