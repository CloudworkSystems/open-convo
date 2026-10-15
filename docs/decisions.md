# Owner Decisions

The owner's decisions, newest first. Only the owner approves changes to this
file (`.github/CODEOWNERS`), so agents can't add or change a decision on
their own. A pull request that records a decision updates this file and waits
for the owner. Where the build is now lives in [STATUS.md](../STATUS.md); the
full plan and history are in [PLAN.md](../PLAN.md).

- **Oct 15:** Every review asks two questions of each change: does it break a
  rule of this system, and does it fix a problem the owner actually has
  (AGENTS.md Review Loop; approved by merging #43).
- **Oct 15:** Build the merge gate (one shared write-only bot account for
  the builders, enforced checks, auto-merge). `main` is protected from now on.
  Owner decisions move to this file, which only the owner approves.
  No interim "agents merge docs after Codex's 👍"; wait for the gate.
- **Oct 15:** Outside builders may build standalone modules (AGENTS.md).
  First: Site Engine's standalone slice, GrokBot builds and Codex reviews.
- **Oct 15:** Start step 3 now; the owner runs the step 2 trial when he's home.
- **Oct 14:** Ember is the Desk's look. Business material stays out of this repo.
- **Oct 14:** Dictation protection: words first, app-only reading, one recovery
  key for everything. Accepted the known limit noted on #30.
- **Oct 13:** Step 3 runs on a local model first; the model-based dispatcher
  waits for step 6.
- **Oct 13:** The "Wait—what?" explainer runs on a local model.
- **Oct 13:** Memory lives in separate spaces (Personal, one per business,
  later Family).
- **Oct 13:** Try each step in True Convo Test before the real app.
