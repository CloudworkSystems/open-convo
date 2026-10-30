# Mac App: Folder Rules

These add to the repo's top [AGENTS.md](../../AGENTS.md); they never replace
or loosen it. What the app is and how to build it: [README.md](README.md).

- Build and test with `swift build -j 2` and `swift test -j 2`. On the
  owner's Mac, builds and full test runs go one at a time (top AGENTS.md,
  Limits).
- Many paths here are owner-protected in `.github/CODEOWNERS`: keys,
  encryption, recovery and protected storage, the paid-AI participant path,
  paid cloud calls, and the wiring in `main.swift` and `Package.swift`. A pull
  request that touches one waits for the owner's approval on GitHub, so keep
  changes to those files small and separate when you can.
- Don't connect the participant path to a real model, or add a Mac
  permission, entitlement, outside host or key name, unless a merged plan
  allows it. These trip the risk hold ([docs/plans/risk-review.md](../../docs/plans/risk-review.md)).
- Signing, notarizing, installing and publishing updates need the owner's
  approval each time.
- Tests use invented data only. The Desk's shared fixtures live in
  `apps/desk/tests/fixtures/`, so a change there runs these tests too.
