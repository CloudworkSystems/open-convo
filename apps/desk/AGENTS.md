# Desk: Folder Rules

These add to the repo's top [AGENTS.md](../../AGENTS.md); they never replace
or loosen it. What the Desk is and its commands: [README.md](README.md).

- Run `npm test` (and `npm run check` before a pull request) from
  `apps/desk`. Browser tests need Playwright's Chromium.
- The Desk uses invented data only. Real private history waits for protected
  native storage.
- The owner sees the Desk through `Start Desk.command`, which pulls `main`
  and refreshes when files change. So a merged change shows up for him at once.
- Building from an annotation round: work from
  `docs/annotations/<session-name>.md` on a branch named after the session,
  one change per numbered item, and say in the pull request which items it
  covers.
- `tests/fixtures/` is shared with the Mac app's tests. A change there runs
  the Mac tests too.
