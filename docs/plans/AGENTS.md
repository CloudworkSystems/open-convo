# Plans: Folder Rules

These add to the repo's top [AGENTS.md](../../AGENTS.md); they never replace
or loosen it. PLAN.md stays the authority on build order.

- Every plan has a status line right under its title:
  `Status: <word> (<date>): <short note>`.
  The words are **Draft** (proposed, not approved), **Approved** (merged,
  not started), **In progress**, **Built** (finished; kept for reference)
  and **Superseded by <file>**.
- Treat Built and Superseded plans as history, not instructions. For
  current state, read [STATUS.md](../../STATUS.md).
- Each new plan names its builder, its reviewer and its finish line (the
  proof that it's done). Plans written before October 23, 2026 don't have
  to be brought up to this; when one is next revised, add what it lacks.
- Don't rewrite an Approved plan's requirements in place: add a dated
  revision section, or write a new plan and mark the old one Superseded.
- Update the status line in the same pull request that changes the plan's
  state (for example, the pull request that finishes the last part).
