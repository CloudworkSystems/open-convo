# Predicted Claude Code 2.1.283 streams (F1): invented, unconfirmed

These `.jsonl` files are PREDICTED, not recorded. They come from a read-only
reading of the installed 2.1.283 program file, which was never run
(`docs/reviews/2026-10-11-claude-f1-cli-reading.md`; its corrections at the
top override its body), plus field names a review checked in the same file's
bytes (result fields, init key order). They are unconfirmed until the first
approved live request, and the first live run may differ from them.

- Field names only. No code was copied from the program, and every value is
  invented: reply text, ids, session ids, paths, plugin, agent and capability
  names, costs and token counts. Key order is a guess; nothing should depend
  on it. Init follows its builder's order. The program has several result
  builders that order their keys differently, so a recorded result may not
  start with `type`. The tests find lines by their decoded `type`, and replay
  a result with `type` moved last to show the reader does not care.
- Every result line carries the fields each result builder in the file was
  seen to write: `stop_reason`, `total_cost_usd`, `usage`, `modelUsage` and
  `permission_denials`. Their values, and the inner shapes of `usage` and
  `modelUsage`, are invented (`modelUsage` is left empty). The local result
  in (e) also carries `fast_mode_state`, which its builder writes. Today's
  reader reads only `subtype` and `is_error` from a result.
- They assume section 11's argv and environment as Codex's F0 answer 10 fixed
  them, now enforced in code: the argv includes `--strict-mcp-config` (and
  never `--mcp-config`), and both the app's and the supervisor's environment
  passes set `PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`,
  `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`
  whatever the app's own environment holds. The traffic switch is why init
  shows `analytics_disabled` true. `product_feedback_disabled` true is only a
  predicted value: the F1 reading's correction 4 says it comes from a policy
  check, not the traffic switch, so this environment does not establish it.
  A real golden must be recorded under exactly that argv and environment, and
  nothing else.
- `plugins` cannot be pinned from the program file, so one invented built-in
  entry (`invented-builtin`, path `builtin`, source `invented-builtin@builtin`)
  stands in. The real names come from the first live run (question 7).
- (e) and (f) may be missing a line. The program probably also prints an
  `assistant` line before the result for a local answer and for an API error
  (medium confidence, from minified bytes). It is not in these files, which
  follow the shapes F1 was asked for. The tests replay (e) and (f) with an
  invented `assistant` line inserted and get the same end: the reader ignores
  `assistant` lines once init has passed.
- The model is `invented-pinned-model`. ParticipantFakeCLI prints these exact
  bytes for the scenario `{"stream": "<file name>"}` when its `--model` is
  `invented-pinned-model`, and echoes any other `--model` instead. It prints
  them only when its argv and environment, as exec'd, are exactly the ones
  above (its own copy, `PredictedInvocation`, written independently of the
  app's rule); otherwise it prints nothing and exits 70. The files and the
  fake are written independently; `StreamConformanceTests` checks that they
  stay byte-identical, and that the fake refuses another argv or
  environment. Change both by hand, never one alone.

| File | Shape | Today's StreamJSONReader |
| --- | --- | --- |
| `normal.jsonl` | (a) init, stream events with text deltas, assistant message, message stop, `rate_limit_event` with `overageStatus` "rejected" and `isUsingOverage` false, result | completed. The text is held until the rate-limit event, which moves it into the buffer; it is emitted 250 ms after that release or on the result, whichever is first (in the predicted order, on the result). Section 8's "250 ms after the first unemitted byte" could be read as emitting at the event itself; open |
| `no-overage-status.jsonl` | (b) as (a), but the rate-limit event has no `overageStatus` (the response header was absent) | failed paid-overflow at the result; the open risk in question 8. Section 11's rule (Codex F0 answer 8): a missing `overageStatus` means unverified, not off, so the text stays held and the run fails closed at the result. The reader does exactly that: the event without the field decides nothing and releases nothing |
| `overage-allowed.jsonl` | (c) as (a), with `overageStatus` "allowed" (extra usage on) | failed paid-overflow at the rate-limit event |
| `no-rate-limit.jsonl` | (d) as (a), with no rate-limit event | failed paid-overflow (result first) |
| `local-slash.jsonl` | (e) init, then a local success result: no model call, no rate-limit event (input whose first character is "/") | failed paid-overflow (result first); question 25. Section 16.2 does not require a leading slash; the collision is between a leading-slash acceptance input and the result-first rule |
| `refused-429.jsonl` | (f) init, rate-limit event with `status` "rejected" before any text, then an error result | failed process-error (the rate-limit event passes; the result is not a success) |

The reader outcomes are asserted, exactly, in `StreamConformanceTests.swift`.
They record what the reader does today, as evidence for Codex's rulings; they
are not a claim that this is the right behaviour.
