# Coordinator Playbook

[docs/agent-process.md](agent-process.md) and [AGENTS.md](../AGENTS.md) win
wherever this file differs from them. This is not a rule file; it is the
practical "how to actually run the loop" companion to them, written from the
coordinator thread's working experience. When a step here is already a rule
there, this file links to the section instead of repeating it.

Who reads it: the Claude coordinator, the PR keeper, Claude building
sessions, Codex and GrokBot when they need to know how the coordinator will
hand them work.

## Before Starting Any Build

Check for an existing issue or pull request first. Search open and closed
issues and pull requests for the module name and the session name. Two
coordinators (or a coordinator and a building thread) starting the same work
wastes a builder and produces two pull requests to reconcile. If one exists,
pick it up there instead of starting fresh.

## Handing Work To A Builder

- **Give the latest requirements, not just the merged plan.** The build
  issue, and P1s carried to the build ("Plans stop after two Codex rounds"
  in [agent-process.md](agent-process.md), "Keeping Finished Work Moving"),
  often add to the plan after it merged. Paste or link those into the
  builder's prompt alongside the plan.
- **Authorize a whole class of change at once.** If the builder may need to
  touch, say, every fixture of one kind, say so once in the prompt. Approving
  one file at a time costs a round each time.
- **Fix a whole class of bug at once.** When a finding points at one line,
  look for every place with the same mistake and fix them together. A
  one-line fix invites the next review round to find the twin.

## Running The Local Codex CLI

Codex builds that open as `cloudwork-bot` go through the local Codex CLI the
coordinator runs ([agent-process.md](agent-process.md), "Accounts And
Provenance"). The coordinator does the git work; Codex only edits files.

1. Make a fresh worktree from `origin/main` on a branch named after the
   session. Never switch the main checkout's branch.
2. Run Codex non-interactively in that worktree:

   ```sh
   codex exec -C <worktree> -s workspace-write -m <model> "$(cat <prompt-file>)" < /dev/null
   ```

   - **Write the prompt to a file first,** outside the worktree, and pass it
     with `"$(cat <prompt-file>)"` as above. Never paste the prompt straight
     into the command: the shell would run any backticks or `$(...)` in it
     and expand `$` variables before Codex sees them, so text copied from an
     issue could run commands on the Mac. Reading the file this way passes
     its contents exactly as written.
   - **Always pass `-m`.** The model in the local Codex config can be one the
     account rejects, and the run then fails before doing anything. Name a
     model the account accepts.
   - **Always add `< /dev/null`.** Without it, `codex exec` waits for more
     input on standard input and hangs.
3. Read what Codex wrote, run the tests yourself, then commit, push and open
   the pull request as `cloudwork-bot` with the label `agent: codex` and
   auto-merge off. For the bot's sign-in, use the bot account's token, as
   agent-process.md "Accounts And Provenance" describes.
4. If Codex wrote `QUESTIONS.md`, read it, answer in the next prompt (or ask
   the owner), and leave that file out of the commit.

### What Every Codex Prompt Says

- Don't touch git: no commits, branches, pushes or resets. The coordinator
  does that.
- Run the tests once at the end, not in a loop.
- Don't change an existing test's expectations. If one seems wrong, stop and
  write the question to `QUESTIONS.md` at the worktree root instead.
- List every test expectation you changed or added, with the reason, in the
  final message.
- The builder's rules from the plan, the latest requirements from the issue
  (above) and any class of change authorized in advance.

## Asking For Reviews

- **GrokBot:** nudge it with one `@cursor` comment from the bot per commit,
  as "Independent reviews" in [agent-process.md](agent-process.md) says.
  Never from the owner's account.
- **Standing in for Gemini:** Gemini isn't set up ("Agent Setup And
  Silence"). When the fresh Claude review stands in, run it as a separate
  reviewer that didn't build the pull request, and calibrate findings to the
  P0 to P3 definitions in AGENTS.md "Review Guidelines": P1 only for wrong
  results, crashes, data loss, security or privacy holes, money spent without
  consent or a broken promise; P2 for a realistic bug on a supported path;
  everything else P3 or no comment. Don't inflate a hardening idea to P2.
  End with the privacy and security checklist block.

## When P2s Need The Owner

When a P2 is still open and only the owner's accept line would let the pull
request merge, ask him case by case, one P2 per
question, directly in the chat thread, with your recommendation and the
trade-off in plain words. Don't leave it buried on the pull request.

Only after Codex has reviewed that exact head commit (or the hung-review case
in "Keeping Finished Work Moving") show him the exact
`owner-accepts-findings <full head sha>` line for that commit. He posts it
himself; agents never post it ("Review Loop" in
[agent-process.md](agent-process.md)). A new push makes the shown line
stale, so show a fresh one.

## Status Updates To The Owner

- Lead with what needs him, then what moved.
- Give one line per GrokBot team, even when a team has nothing new ("team B:
  no change, waiting on Codex round 2"), so a silent team stands out.
- Plain language, pull request numbers, no jargon.

## Always Schedule The Next Check

Every time the coordinator finishes a pass, it schedules its next check
before stopping: when a review is due, when a builder's deadline from "Agent
Setup And Silence" runs out, or simply the next hourly look. Nothing in this
loop moves unless someone comes back to it, and memory is not a schedule.
