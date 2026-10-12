# Handoff: Port Session to the Building Session

Written October 12, 2026 by the Claude session that froze True Convo, set up
this repo and ported its pieces. That session has stopped at the owner's
request. One Claude session builds from here, to avoid two sessions editing the
same code. Read this once; nothing here changes the plan's order.

## Building the True Convo Test App

Desk builds never go into the owner's real app until step 2 lands. To let the
owner try dictation, the HUD and the Desk together, build the separate test app:

```sh
cd apps/mac
TRUE_CONVO_WITH_DESK=1 scripts/package_app.sh --test-identity
```

- It makes `apps/mac/dist/True Convo Test.app` (bundle ID
  `com.trueconvo.voice-cursor.test`) with its own settings, Keychain items and
  storage. It never installs, opens or signs with a Developer ID.
- It refuses to build if the checkout has any uncommitted or untracked file.
  When another session has work in progress in the owner's folder, build from a
  temporary worktree of `main` instead (copy `apps/desk/node_modules` into it
  with `cp -cR`), then copy the app into the owner's `apps/mac/dist` and remove
  the worktree. Never commit, stash or delete another session's files to get a
  clean folder.
- Last built from `b7d5a5d` on October 12. It predates PR #5 (Desk side of
  dictation); rebuild before the owner's next try.

## Running Commands on the Owner's Mac

- The folder-sharing shell is a Linux sandbox: no Swift, no Keychain, no git
  credentials, and Linux `node_modules` that break on macOS. Swift builds,
  packaging and `git push` from the owner's folder run on the Mac itself.
- Long builds and tests (`swift test` takes about 4 minutes) should run in the
  background with a log, then be polled.

## Private Material in Git History

- Commits `01c2473` and earlier contain the owner's name, surname and personal
  memory-steward name in Mac app comments, AI instructions and tests. They were
  replaced in `0d581f4`, but history keeps them. Before the repo goes public,
  start its public history fresh or scrub it (already listed in `PLAN.md`).
- When scanning for private material, never cut the output short with a line
  limit. That is how the first scan missed these.

## Still in True Convo, Not Yet Ported

- Codex's live-conversation candidate, branch
  `codex/live-conversation-main-resolution` (11 Desk files beyond True Convo
  `c527e36`), is unreviewed. Port it with step 3 after review.
- `tools/` (capability adapter, action guard, agent bridge; paid bridges and
  evaluation tools) stay until the owner chooses.
- True Convo's local `main` is 11 commits ahead of and 77 behind its GitHub
  `main`. That divergence is frozen as-is. Port from GitHub `origin/main`, not
  the Mac's local `main`.

## Pending Review

The Codex review brief for the three ports
(`docs/reviews/2026-10-12-codex-review-brief-desk-port.md`) has not been run.
No `docs/reviews/2026-10-12-codex-review-desk-port.md` exists yet.
