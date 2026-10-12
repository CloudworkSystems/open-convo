# Open Convo Desk

One goal-led workspace for conversations, next steps and work. It grows into
the Open Convo desktop app.

## Current State

- **Browser preview:** invented sample data, simulated replies and unencrypted
  browser storage. Use invented data only.
- **Navigator:** domains, folders, pins, rename and session details on sample data.
- **Conversation:** sample conversations, drafts and composer annotations.
- **Storage:** browser saves use IndexedDB transactions. Protected native storage
  is planned and required before any real private history is used.
- **History reader:** reads a chosen saved-session file read-only, in the local
  Mac context only. Nothing is uploaded or sent to a model.
- **Roadmap board:** the Open Convo roadmap in `src/content/recovery-roadmap.json`,
  with evidence links to this repo's own files.
- **Native bridge:** the host and participant wire code for the Mac app, tested
  against invented fixtures. The Mac app itself has not moved yet.

## Commands

From `apps/desk`:

```sh
npm ci
npm run dev           # local dev server on 127.0.0.1:4173
npm run build
npm test              # unit tests
npm run test:browser  # browser tests (needs Playwright's Chromium)
npm run check         # everything
```

## Moved From True Convo

Ported from the frozen True Convo repo on October 12, 2026. True Convo's
publishing scripts, Mac preview launcher, review records and hosting settings
stayed behind. See the move log in the root `PLAN.md`.
