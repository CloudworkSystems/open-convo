# Open Convo Clarity

The clarity and correction logic at the core of Open Convo:

- **Wait—what?** re-pitches the latest assistant message in plainer words, without remembering anything.
- **Clarity corrections** turn a selected confusing phrase into a plain explanation, a rewrite and an optional wording lesson.
- **Communication preferences** apply saved wording lessons to later replies, scoped to the owner.
- **Candidate memory cards** keep proposed memories as candidates until the owner promotes them.

Plain Node.js ES modules with no dependencies. Requires Node 22 or later.

```sh
npm test            # 47 tests
npm run proof       # end-to-end proof summary
```

Moved from the archived `cloudwork_systems/true_convo/open-convo` on October 12, 2026.
Some proof output still names design docs that were not moved; see the move log in `PLAN.md`.
