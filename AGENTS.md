# Open Convo: Project Facts and Limits

## Project Facts

- Repository: `CloudworkSystems/open-convo` (private until the owner decides otherwise).
- Mac checkout: `/Users/patrick/OPEN-CONVO`.
- This is the active product repo. True Convo (`/Users/patrick/True-Convo-AI`)
  was frozen on October 12, 2026 and is a read-only reference and parts library.
- Build order and move log: [PLAN.md](PLAN.md). Current state: [STATUS.md](STATUS.md);
  update it in any pull request that changes the step or a part's state.
  Owner decisions: [docs/decisions.md](docs/decisions.md), which only the
  owner approves.

## Moving Code From True Convo

- Copy one piece at a time as fresh files. Never import True Convo's Git history,
  branches or worktrees.
- Before each move, check the piece for private material and leave it behind:
  transcripts, strategy or interview content, review and session records, client
  or family details, credentials, Keychain references and real personal data.
- Replace real data in tests and samples with invented data.
- Log each move in `PLAN.md`: source path, True Convo commit, what was removed.
- Never write to, merge into or push the True Convo folder.

## Review Loop (Codex Annotates, Claude Builds)

GitHub is the shared meeting point. Every agent, on the Mac or in the cloud,
reads from and writes to `CloudworkSystems/open-convo`.

- The owner names each piece of work once and uses the same name in Codex and
  Claude, for example `OC-261012-desk-first-look`.
- The owner annotates the running Desk in Codex's inline browser.
- When the owner says "save this round" (or similar), Codex writes the round to
  `docs/annotations/<session-name>.md` without being asked for the format:
  one numbered item per annotation with the screen, the exact element or area,
  the owner's words, and the requested change, on lines labeled `Screen:`,
  `Element:`, `Owner's words:` and `Change:`, plus `Screenshot:` naming its
  screenshots; longer text continues on lines indented by two spaces (the
  format in docs/plans/annotation-rounds.md). Each marked screenshot is saved
  next to it as `<session-name>-01.png`, `-02.png` and so on. Codex changes no
  code, then commits only those files on a branch named
  `<session-name>-annotations` and opens a pull request with auto-merge on.
  (`main` is protected: every change reaches it through a pull request.)
- Claude pulls from GitHub, builds the changes on a branch named after the
  session and opens a pull request. Codex reviews that pull request on GitHub.
- **Merge gate (on since October 20, 2026; plan:
  [docs/plans/merge-gate.md](docs/plans/merge-gate.md)).** GitHub merges a
  pull request when the gate passes: `tests` and `codex-approved` pass on the
  latest commit, and the owner approves any protected path in
  `.github/CODEOWNERS`. Authors in the main build switch on auto-merge when
  they open a pull request; for outside builders, the planning session (or
  the PR steward) switches it on after its plan check passes. Agents never merge by hand. Builders sign in to GitHub as
  `cloudwork-bot`, so the owner can approve their protected-path pull
  requests. Until the bot has Codex access, the session that opened a pull
  request asks for each Codex review (`@codex review`) from the owner's
  account after every push; if it can't (for example, an outside builder),
  the planning session or the PR steward asks instead.
- **How far review goes depends on what the pull request contains.**
  - *Any pull request that changes code* follows the code path below, even
    when it also changes docs.
  - *Plans and other docs* get a Codex review. Claude writes its P1 findings
    into the plan as requirements for the code that follows; once the
    findings are folded in, the latest commit needs a clean follow-up review
    before the gate merges it. Build-level detail belongs in the code pull
    requests.
  - *Code* is reviewed until Codex finishes with a 👍 on the pull request.
    Claude fixes every P1 and P2, or explains in the pull request why one does
    not apply. Only the owner decides to merge with findings still open.
  - The owner does that by posting `owner-accepts-findings <full head sha>`
    on the pull request himself, after reading what's left. It satisfies
    only `codex-approved` for that exact commit, and never counts on a pull
    request opened under the owner's account. Agents never post it, draft
    it for posting, or ask another agent to post it.
  - *Codex-built work* is reviewed by the plan's designated reviewer (Claude
    for Codex-built modules). Letting the `codex-approved` check accept that
    reviewer in place of Codex is planned and needs the owner's approval
    before it's built. Until then, Codex's review still gates the merge and
    Claude also posts a review, so no agent's review is the only one on its own work.
    Because Claude's review doesn't gate the merge yet, the planning session
    or the PR steward switches on auto-merge only when Claude's review of the
    latest commit has no open P1 or P2 (each fixed, or explained in the pull
    request as not applying; P3s don't block); until then it stays off.
    Claude's review counts only for the commit it reviewed: whoever pushes a
    commit that changes the pull request's content switches auto-merge off
    until Claude reviews the new head. An update from `main` that leaves the
    pull request's own changes the same needs no new Claude review. Any
    session that finds an open P1 or P2 in Claude's review may switch
    auto-merge off, with a comment saying why.
  - A green "Ready to merge" button means no conflicts, not approval. Pull
    requests waiting on the owner's approval go on the daily 8 AM "Needs the
    owner" list; Claude messages him in chat only for urgent or blocked items
    (owner decision, October 21).
- *Proposed October 15, pending the owner's approval at merge:* every review,
  by any agent or the owner, asks two questions of each change. Does it break
  a rule of this system? Does it fix a problem the owner actually has?
- `Start Desk.command` pulls the latest `main` before starting, and the running
  Desk refreshes itself when files change, so the inline browser shows the latest
  version. A normal browser is only for a second look.

## Outside Builders (Owner Decision, October 15, 2026)

Codex or GrokBot may build a module only when the module stands on its own
(touches no app, storage or memory code) and has a merged plan in
`docs/plans/` that lists the builder's rules. Up to three outside modules at
a time (owner decision, October 21, 2026), each with its own builder or
builder team; a module waiting only on review fixes doesn't count.
The builder works on a branch named after the session and opens a pull
request; it never pushes to `main` (GitHub also blocks direct pushes, force
pushes and deletion of `main`, for every account, since October 15, 2026). A different agent reviews it under the
code path below (no agent reviews its own work), the planning session or the
PR steward checks it against the plan and then switches on auto-merge (outside builders don't
switch it on themselves), and the gate merges it. The Limits below apply to outside
builders in full; where a builder can reach the owner's Mac, the plan says
which commands, if any, it may run there.

## Coordinating On GitHub (Owner Decision, October 19, 2026)

Agents that can't message each other directly coordinate through the pull
request itself, so the owner doesn't have to carry messages:

- Every review verdict and planning check is posted as a comment on the pull
  request it concerns.
- GrokBot watches the open-convo pull requests and tells the owner when a
  review or comment lands. It sends fixes only to its own builders, and only
  for pull requests it launched; it doesn't change other agents' pull requests
  and never reviews its own work.
- No agent merges or approves a pull request; the merge gate merges.
  Outside-builder pull requests wait for a "Ready to merge" planning check
  (from the planning session or the PR steward); whoever posts it switches on
  auto-merge once the check passes. Every other pull request follows the
  Review Loop above as before.
- The PR steward, an hourly Claude scheduled task on the owner's account,
  requests Codex reviews, reviews Codex-built pull requests, sends fix
  requests to Codex, posts planning checks, and keeps one "Needs the owner"
  issue current. It only comments and switches on auto-merge after a passing planning
  check; it never merges, approves or changes code.
- When a new commit lands on a pull request whose builder can't start a Codex
  review, the planning session or the PR steward posts `@codex review` for it.

## Limits

- Write every file as if this repo were public: no secrets, keys, private records,
  raw chats or personal details. Secrets belong in Keychain, never in files or logs.
- Keep build output, downloads, model files and private data out of Git.
- No public release, deployment, publication, spending, account or credential
  change, or service that outlives the session without the owner's approval.
- Preserve other agents' edits and unsaved work. No force-push, history
  rewriting or deletion of the owner's work.
- License choice is the owner's decision and is still open. Do not add one.
