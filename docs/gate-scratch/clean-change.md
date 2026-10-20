# Clean Practice Change

Invented practice file for the merge-gate scratch tests. It touches no
protected path, so once `tests` passes and Codex gives a clean result for the
latest commit, GitHub should merge it into `gate-scratch` by itself
(auto-merge).

What this pull request covers: the ordinary clean-change path, and (because
Codex's first round left a finding) an open finding blocking the merge until
a clean round. It does not cover test 6 in `docs/plans/merge-gate.md`
(a new commit cancels the owner's approval of a protected-path change); that
one needs the owner's own approval and is run on the protected-path practice
pull request instead.
