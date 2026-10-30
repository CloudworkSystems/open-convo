# Checks And Workflows: Folder Rules

These add to the repo's top [AGENTS.md](../AGENTS.md); they never replace or
loosen it. This folder is the merge gate itself (plan:
[docs/plans/merge-gate.md](../docs/plans/merge-gate.md)).

- Every file here is owner-protected (`CODEOWNERS`), so each change waits for
  the owner's approval on GitHub.
- Run `node --test .github/scripts/tests/*.test.mjs` before pushing. A change
  here runs every test job in CI.
- Never weaken, skip or loosen a check to get a pull request green. If a
  check is wrong, fix it in its own pull request and say why.
- A new workflow, action, permission, secret name or outside host trips the
  risk hold ([docs/plans/risk-review.md](../docs/plans/risk-review.md)). Pin
  actions to a version.
- `pages.yml` publishes the public website. See [site/AGENTS.md](../site/AGENTS.md).
