# Packages: Folder Rules

These add to the repo's top [AGENTS.md](../AGENTS.md); they never replace or
loosen it.

- Each folder here is a standalone library with its own tests. Run them with
  `npm test` inside that folder; its README says what else it needs.
- No package imports code from `apps/`, or reads or writes the app's
  storage, memory, Keychain or real personal data. Tests and samples use
  invented data only.
- Before changing a package, read its plan or README:
  - `site-engine`, `household-lists` and any later outside-builder module:
    its plan in [docs/plans/](../docs/plans/) is the contract. Change only
    the files that plan allows, and add no dependency or network access it
    doesn't name.
  - `clarity`: core library brought over from True Convo; changes follow the
    normal Review Loop.
- A new package needs a merged plan first.
