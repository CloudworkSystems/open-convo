# Open Convo: Project Facts and Limits

## Project Facts

- Repository: `CloudworkSystems/open-convo`.
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
  they open a pull request; for outside builders, the coordinator switches it
  on after its plan check passes. Agents never merge by hand. Every agent
  signs in to GitHub as `cloudwork-bot` (three app exceptions are listed in
  Accounts And Provenance), so the owner can approve their protected-path
  pull requests. Codex reviews every pull request on
  each push by itself (its open-convo setting covers all pull requests), so
  no agent asks for Codex reviews.
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
  - The owner does that by posting a comment containing only this line,
    `owner-accepts-findings <full head sha>`, on the pull request himself,
    after reading what's left. Any other text in the comment makes it not
    count. It satisfies only `codex-approved` for that exact commit, and
    never counts on a pull request opened under the owner's account. Agents
    never post it or ask another agent to post it. They may show the owner
    the exact line for the current commit, next to the findings it would
    accept (owner decision, October 23).
  - *Codex-built work* gets Gemini's review as its independent review,
    followed by the coordinator's plan check ("Gemini reviews" below). Until
    Gemini posts reviews on the repo, a fresh Claude review (by an agent that
    didn't build the pull request) stands in. Letting the `codex-approved`
    check accept that independent review in place of Codex's is planned and
    needs the owner's approval before it's built. Until then, Codex's review
    still gates the merge and the independent reviewer also posts a review,
    so no agent's review is the only one on its own work.
    Because neither the independent review nor the plan check gates the merge
    yet, only the coordinator switches on auto-merge for a Codex-built pull
    request, and only when the independent review of the latest commit has no
    open P1 or P2 (each fixed, or explained in the pull request as not
    applying; P3s don't block) and, for an outside module, the coordinator's
    plan check has passed; until then it stays off.
    The independent review counts only for the commit it reviewed: whoever
    pushes a commit that changes the pull request's content switches
    auto-merge off until the new head is reviewed. An update from `main` that
    leaves the pull request's own changes the same needs no new review. Any
    session that finds an open P1 or P2 in that review may switch auto-merge
    off, with a comment saying why.
  - A green "Ready to merge" button means no conflicts, not approval. Pull
    requests waiting on the owner's approval go on the "Needs the owner" list
    (issue #52, which the `owner-queue` workflow rewrites every hour), and the
    8 AM message sends him that list. Claude messages him in chat only for
    urgent or blocked items (owner decision, October 21).
- **Gemini reviews (owner decision, October 23, 2026).** Gemini Code Assist
  (a GitHub app, installed October 23) is the impartial reviewer: no agent
  is the independent review of its own work.
  - GrokBot (Cursor) builds: Codex reviews, then the coordinator's plan check.
  - Codex builds: Gemini reviews, then the coordinator's plan check. Codex
    never counts as the independent review of its own work.
  - Claude builds: Gemini reviews. Codex also reviews every pull request by
    itself, as above.
  - Gemini is advisory for now. Its critical and high findings count as P1,
    its medium findings as P2. They are fixed or answered in the pull
    request before auto-merge goes on, but no required check reads Gemini
    yet. Making it a required check is a later code change and the owner's
    call.
  - Until Gemini actually posts reviews on the repo, a fresh Claude review
    (by an agent that didn't build the pull request) stands in as the
    independent review.
  - Agents ask Gemini for a re-review (`/gemini review`) only from
    `cloudwork-bot`.
  - Still open for the owner: whether Argon (his Gemini preview model) is
    reached later through the Gemini CLI or an API key, kept as a repository
    secret and never in files.
- *Proposed October 15, pending the owner's approval at merge:* every review,
  by any agent or the owner, asks two questions of each change. Does it break
  a rule of this system? Does it fix a problem the owner actually has?
- `Start Desk.command` pulls the latest `main` before starting, and the running
  Desk refreshes itself when files change, so the inline browser shows the latest
  version. A normal browser is only for a second look.

## Outside Builders (Owner Decision, October 15, 2026)

Codex or GrokBot may build a module only when the module stands on its own
(touches no app, storage or memory code) and has a merged plan in
`docs/plans/` that lists the builder's rules. Up to five outside modules at
a time (owner decision, October 23, 2026; three before that), each with its own builder or
builder team; a module waiting only on review fixes doesn't count.
The builder works on a branch named after the session and opens a pull
request; it never pushes to `main` (GitHub also blocks direct pushes, force
pushes and deletion of `main`, for every account, since October 15, 2026). A different agent reviews it under the
code path below (no agent reviews its own work), the coordinator checks it
against the plan and then switches on auto-merge (outside builders don't
switch it on themselves, and the owner doesn't click Merge; owner decision,
October 23), and the gate merges it. The Limits below apply to outside
builders in full; where a builder can reach the owner's Mac, the plan says
which commands, if any, it may run there.

Who reviews an outside builder's pull request: Codex reviews GrokBot's
work, and Gemini reviews Codex's work (Review Loop, "Gemini reviews").

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
  from the coordinator, which switches on auto-merge once the check passes.
  Every other pull request follows the Review Loop above as before.
- The PR steward, a Claude scheduled task (8:41 AM and 5:41 PM Eastern),
  reviews Codex-built pull requests and flags stuck ones in its own comment
  on issue #52. It never merges, approves, switches on auto-merge, changes
  code or asks for Codex reviews, and it no longer runs planning checks:
  where an older plan gives a planning check or auto-merge to "the planning
  session or the PR steward", the coordinator does it.
- Codex reviews each new commit by itself. When its review of a pull
  request's latest commit hangs (still "running" after 30 minutes, or not
  started an hour after the push), the PR keeper restarts it once by pushing
  an empty commit, "Restart Codex review (no changes)", as the bot. An empty
  commit leaves the pull request's changes the same, so it needs no new
  Claude review. A restart commit is never restarted itself: when the latest
  commit is already a restart, the keeper leaves it, and if Codex is still
  silent an hour later, the 8 AM list shows it as "Codex silent". Nobody
  asks from the owner's account.

## Accounts And Provenance (Owner Decision, October 23, 2026)

- `CloudworkSystems` is the owner's account, and only the owner uses it, in
  his browser. No agent, scheduled task or app connection may act as it. On
  the Mac, agents run every GitHub command with the bot's key, and git pushes
  from the OPEN-CONVO folder go out as the bot. An approval, an
  `owner-accepts-findings` note or a dismissed Codex review from that account
  therefore means the owner did it.
- Every agent that writes to GitHub signs in as `cloudwork-bot`: Claude in
  the cloud and on the Mac, local Codex on the Mac, GrokBot's builders and the
  Claude scheduled tasks. Three apps keep their own identities: Codex's GitHub
  app (`chatgpt-codex-connector[bot]`), which posts its reviews and its cloud
  builds; Gemini Code Assist (`gemini-code-assist[bot]`), which posts its
  reviews; and the repo's GitHub Actions workflows (such as `owner-queue`),
  which post as `github-actions[bot]`. Codex doesn't
  answer `cloudwork-bot`'s requests yet, so asking Codex to fix its own pull
  request waits for the owner until the bot has its own Codex access.
- An agent that finds itself signed in as `CloudworkSystems` stops and tells
  the owner instead of acting.
- Agents share one account, so each marks its own work:
  - Each pull request carries a label naming its builder: `agent: claude`,
    `agent: grokbot` or `agent: codex`. The coordinator adds it when a
    builder can't.
  - The last line of every comment, review and pull request description names
    the agent and its thread or task, for example
    `— Claude, 261012 OC Coordinator` or `— GrokBot team A`.
  - Commits keep their tools' own marks: Claude's `Claude-Session` link,
    `Cursor Agent` as GrokBot's author and Codex's `codex/` branches.

## Who Does What

| Who | Account | Its one job |
|---|---|---|
| The owner | `CloudworkSystems` | Decisions, approvals on protected paths, the 8 AM list |
| Claude coordinator (thread "261012 OC Coordinator") | `cloudwork-bot` | The planning session in plans and earlier decisions: checks outside builders' pull requests against their plans, switches on auto-merge when a check passes (for Codex-built work, also only after the independent review is clean), answers builders' plan questions, keeps this table current |
| Claude building sessions | `cloudwork-bot` | Build on a named branch; open the pull request with auto-merge on |
| GrokBot teams (Cursor) | `cloudwork-bot` | Each builds one module from its plan and fixes findings on its own pull request |
| Codex | its own app | Reviews every pull request; builds Codex modules |
| Gemini Code Assist | its own app | Impartial reviewer of Codex-built and Claude-built pull requests (advisory for now) |
| PR steward (scheduled, 8:41 AM and 5:41 PM) | `cloudwork-bot` | Reviews Codex-built pull requests; flags stuck ones on issue #52 |
| PR keeper (scheduled, hourly) | `cloudwork-bot` | Keeps pull requests moving: updates auto-merge pull requests that fall behind `main`, and restarts a hung Codex review once per commit |
| Daily list (scheduled, 7:52 AM) | `cloudwork-bot`, reading only | Sends the owner issue #52's list, plus pull requests Codex has gone silent on |
| Nightly Test build (scheduled, 2–6 AM) | none | Rebuilds True Convo Test from `main` on the owner's Mac |
| Recycling pass (scheduled, Sundays) | `cloudwork-bot` | One pull request proposing fixes for stale docs |
| `owner-queue` workflow | GitHub Actions | Rewrites issue #52, "Needs the owner", every hour |

Work that belongs to another row is forwarded there once, and the owner is
told where it went. A Claude thread opened for a single pull request closes
when that pull request is done and doesn't need a row. A new standing thread
or task gets a row here first.

## Limits

- Write every file as if this repo were public: no secrets, keys, private records,
  raw chats or personal details. Secrets belong in Keychain, never in files or logs.
- Keep build output, downloads, model files and private data out of Git.
- No public release, deployment, publication, spending, account or credential
  change, or service that outlives the session without the owner's approval.
- Preserve other agents' edits and unsaved work. No force-push, history
  rewriting or deletion of the owner's work.
- License choice is the owner's decision and is still open. Do not add one.
- Mac app builds and full Mac test runs on the owner's Mac go one at a time.
  No stress or load testing on the owner's Mac without his OK. Agents
  (GrokBot, Codex, cloud Claude) run on their own servers, so there is no
  cap on how many agents or sessions work at once.
