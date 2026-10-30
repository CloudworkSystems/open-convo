# Agent Process: Full Text

This file holds the full text of the agent process rules that the repo's
top [AGENTS.md](../AGENTS.md) summarizes. It was moved here unchanged on
October 30, 2026, so that every agent doesn't read 546 lines at the start of
each session (owner decision, October 30, thread "Write one shared agent
instruction framework"). The rules are binding, and they are protected like
AGENTS.md (`.github/CODEOWNERS`). Where the summary in AGENTS.md and this
file differ, this file governs. Section names match AGENTS.md, so older plans
that cite `AGENTS.md "<section>"` find the full rule here.

Read the section you need before you act on it: builders before opening or
fixing a pull request, the coordinator and PR keeper before switching on
auto-merge or relaying, reviewers before an independent review. Where a
section here says "above" or "below" about Review Guidelines, Who Does What
or Limits, those sections stayed in AGENTS.md.

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
  `<session-name>-annotations` and opens a pull request with auto-merge off,
  like other Codex-built pull requests. The coordinator switches it on once
  the round's files match the round (docs only, so that is its whole check);
  an owner-only path still needs the owner's approval.
  (`main` is protected: every change reaches it through a pull request.)
- Claude pulls from GitHub, builds the changes on a branch named after the
  session and opens a pull request. Codex reviews that pull request on GitHub.
- **Merge gate (on since October 20, 2026; plan:
  [docs/plans/merge-gate.md](plans/merge-gate.md)).** GitHub merges a
  pull request when the gate passes: `tests` and `codex-approved` pass on the
  latest commit, and the owner approves any protected path in
  `.github/CODEOWNERS`. Claude-built and Codex-built pull requests open with
  auto-merge off. The coordinator switches it on once the independent review
  ("Independent reviews" below) and any plan check are clean on the latest
  commit; for GrokBot, after its plan check passes. The PR keeper does it
  when nobody has ("Keeping Finished Work Moving" below). Agents never merge
  by hand, apart from that section's one exception. Every agent
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
  - **Plans merge on the owner's yes (owner decision, October 27, 2026).**
    `docs/plans/` is no longer a protected path, so the owner approves a plan
    by saying yes in a Claude thread instead of on GitHub. Before auto-merge
    goes on, the pull request's description quotes his yes with its date and
    the thread's name. His yes covers the plan as he saw it: a later commit
    that changes a requirement, a builder's rules, a limit or a finish line
    needs a new yes, while folding in review findings he has already seen
    doesn't. Auto-merge goes on only after that and the plan review above,
    and only from the coordinator or the thread that asked him. A plan pull
    request that also changes a protected path (for example this file, the
    folder's `AGENTS.md`, `PLAN.md` or `docs/decisions.md`) still needs his
    approval on GitHub.
  - *Code* is reviewed until Codex finishes with a 👍 on the pull request.
    Claude fixes every P1 and P2, or explains in the pull request why one does
    not apply, or after three Codex rounds leaves a P2 for the triage judge
    (Review Guidelines). Only the owner decides to merge with findings still open.
  - The owner does that by posting a comment containing only this line,
    `owner-accepts-findings <full head sha>`, on the pull request himself,
    after reading what's left. Any other text in the comment makes it not
    count. It satisfies only `codex-approved` for that exact commit, and
    never counts on a pull request opened under the owner's account. Agents
    never post it or ask another agent to post it. They may show the owner
    the exact line for the current commit, next to the findings it would
    accept (owner decision, October 23).
  - *Codex-built work* gets an independent review (GrokBot or Gemini, with a
    fresh Claude review as the fallback; "Independent reviews" below),
    followed by the coordinator's plan check. Letting the `codex-approved`
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
- **Independent reviews (owner decisions, October 23 and 26, 2026; called
  "Gemini reviews" in older plans).** No agent is the independent review of
  its own work, and the reviewer should run a different model from the
  builder where one is available.
  - GrokBot (Cursor) builds: Codex reviews, then the coordinator's plan
    check. GrokBot never reviews GrokBot's work.
  - Codex builds: GrokBot or Gemini reviews, then the coordinator's plan
    check. Codex never counts as the independent review of its own work.
  - Claude builds: GrokBot or Gemini reviews. Codex also reviews every pull
    request by itself, as above.
  - The first review of the latest commit from GrokBot or Gemini counts.
    The coordinator asks GrokBot with one `@cursor` comment from
    `cloudwork-bot` per commit, naming the pull request, this section and
    the Review Guidelines, and saying: post one review comment, push
    nothing, change nothing. On a Claude-built pull request the request
    names a non-Claude model. GrokBot's review ends with the line
    `— GrokBot review`, so it can be told apart from GrokBot's builds, which
    post from the same account. A GrokBot review that pushes a commit doesn't
    count: the coordinator switches auto-merge off at once, reverts that
    commit on the branch (or asks the pull request's builder to), and the
    reverted head needs a new independent review.
  - If neither GrokBot nor Gemini has reviewed the latest commit 60 minutes
    after it was pushed (or after the `@cursor` request, if later), the
    coordinator asks for a fresh Claude review (by an agent that didn't build
    the pull request), which stands in.
    Gemini Code Assist can't be installed on this repo: Google stopped
    serving its GitHub app, and the old Gemini CLI's Google sign-in, for
    individual and Google AI Pro and Ultra accounts on June 18, 2026
    ([Google's notice](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals)).
    A GitHub workflow can't do an interactive sign-in, so a Gemini review
    here would call Gemini with a pay-per-use API key kept as a repository
    secret. That workflow needs its own plan and the owner's approval,
    since it spends money. Until it is merged, GrokBot and then fresh Claude
    are the ones that run. Gemini is marked "not set up" (Agent Setup And
    Silence below), so nobody asks it or waits for it until that changes.
  - The independent review is advisory for now. Gemini's critical and high
    findings, and GrokBot's and Claude's P1s, count as P1; Gemini's medium
    findings and the others' P2s count as P2. They are fixed or answered in
    the pull request before auto-merge goes on, but no required check reads
    the independent review yet. Making it a required check is a later code
    change and the owner's call.
  - **Privacy and security checklist (owner decision, October 26, 2026;
    [docs/plans/risk-review.md](plans/risk-review.md) and
    [docs/plans/security.md](plans/security.md) section 2).** Every
    independent review, and the coordinator's plan check on GrokBot work,
    ends with one block answering these, each "no" or "yes" with the file
    and line: (1) data leaving the device, and which plan allows it;
    (2) secrets in code, logs, test output or files; (3) real personal data
    in any added or changed file (contact details the owner chose to
    publish are listed, not a finding); (4) private data written outside
    the protected store or where backups or sync pick it up; (5) a new Mac
    permission or wider agent powers; (6) outside input, and whether it is
    validated and kept from becoming instructions or commands; (7) who may
    read or change what, checked per item; (8) new code from elsewhere:
    needed, pinned, trusted; (9) failure output leaking traces, keys or
    personal data; (10) money spent, with a cap, a stop and consent.
    A "yes" on 2 or 3 is always a P1; any other "yes" no plan allows is a
    P1; a "yes" on 6 or 7 the tests don't cover, or on 10 without a cap, is
    a P1. Docs-only pull requests get the block too, from an agent that
    didn't write them (checklist only, not a full review). The coordinator
    doesn't switch on auto-merge, or pass a GrokBot plan check, until the
    block is posted for the latest commit.
  - **`risk-escalate`.** A reviewer who thinks the owner should see a risk
    even when a plan allows it ends the block with
    `risk-escalate: <one-line reason>`. The coordinator then keeps
    auto-merge off and adds the label `needs-owner: risk-escalate`, which
    lists the pull request on issue #52, until the owner approves the head
    commit after that comment; then the coordinator removes the label (the
    workflow never touches it). On a pull request opened from the owner's
    account, the work is reopened from `cloudwork-bot`, carrying the
    escalation over.
  - Each GrokBot review spends Cursor usage; the coordinator asks for one
    per commit, never more.
  - Older plans (for example `email-actions-preview.md` and
    `email-sorting-engine.md`) name Gemini, or a fresh Claude review standing
    in for it, as the independent review. A GrokBot review satisfies those
    steps the same way, under the same rules as above; this section is the
    rule they point to, so they don't need their own revisions.
  - Gemini, Argon (the owner's Gemini preview model) included, runs on the
    owner's API key for now. Where a person can sign in, Google's Antigravity
    CLI also accepts his subscription sign-in, which is to be tried next and
    then used there; where nobody can, such as a GitHub workflow, it stays a
    key. A key lives in a repository secret, Keychain or exe.dev
    Integrations, never in files.
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
work, and GrokBot or Gemini reviews Codex's work (Review Loop, "Independent
reviews").

## Coordinating On GitHub (Owner Decision, October 19, 2026)

Agents that can't message each other directly coordinate through the pull
request itself, so the owner doesn't have to carry messages:

- Every review verdict and planning check is posted as a comment on the pull
  request it concerns.
- GrokBot watches the open-convo pull requests and tells the owner when a
  review or comment lands. It sends fixes only to its own builders, and only
  for pull requests it launched; it doesn't change other agents' pull requests
  and never reviews its own work. It reviews another agent's pull request
  only when the coordinator asks ("Independent reviews" above).
- No agent merges or approves a pull request; the merge gate merges (one
  exception: "Keeping Finished Work Moving" below).
  Outside-builder pull requests wait for a "Ready to merge" planning check
  from the coordinator, which switches on auto-merge once the check passes.
  Every other pull request follows the Review Loop above as before.
- The PR steward, a Claude scheduled task (8:41 AM and 5:41 PM Eastern),
  reviews Codex-built pull requests and flags stuck ones in its own comment
  on issue #52. It never merges, approves, switches on auto-merge, changes
  code or asks for Codex reviews, and it no longer runs planning checks:
  where an older plan gives a planning check or auto-merge to "the planning
  session or the PR steward", the coordinator does it.
- Codex reviews each new commit by itself, usually within five minutes.
  When its review of a pull request's latest commit hangs (still "running"
  after 20 minutes, not started 20 minutes after the push, or shown as
  "Failed"), the PR keeper restarts it once at its next hourly run by
  posting an `@codex review` comment on the pull request as the bot. That
  is one comment per commit: when one already follows the latest commit, the
  keeper leaves it, and if Codex is still silent an hour later, the 8 AM
  list shows it as "Codex silent". Nobody asks from the owner's account.
  The keeper no longer pushes empty "Restart Codex review" commits: Codex
  stopped answering them by October 27 (#147, #178, #179), and after a
  failed review it skipped even real commits until someone asked, while the
  bot's `@codex review` on #179 started a review within two minutes on
  October 30. A comment also leaves the head, the checks and the owner's
  approval as they were.
- Every update from `main` is a new commit that Codex reviews again, so the
  PR keeper updates a pull request that has fallen behind `main` only when
  auto-merge is on and its latest commit already passes `tests` and
  `codex-approved`. Each pull request then gets one update, right before it
  merges, instead of one every hour (owner decision, October 25, 2026).
  On a pull request that touches a protected path, that update comes before
  the owner is asked to approve, since an update dismisses his approval. If
  one does dismiss it, the `owner-queue` workflow lists the pull request on
  issue #52 again.
- The PR keeper also relays review findings so work keeps moving while the
  owner and his Mac are away. When Codex has left findings on the latest
  commit of a GrokBot pull request and no fix has followed 20 minutes later,
  at its next hourly run it asks the builder to fix them in one `@cursor` comment per
  commit, naming the findings and the plan. After three Codex rounds it
  relays only P0 and P1 findings and findings the judge called real, or
  every finding when no judge verdict has arrived two hours after Codex's
  review. For
  Claude-built and Codex-built pull requests it only lists unanswered
  findings in its report. The keeper runs in the cloud as `cloudwork-bot`,
  not on the Mac (owner decision, October 25, 2026).

## Keeping Finished Work Moving (Owner Decision, October 29, 2026)

On October 29, eight pull requests had `tests` and `codex-approved`
passing on their latest commit and had sat for one to three days, because
the step after Codex (the independent review, the plan check, switching on
auto-merge) waited for someone to remember it. Plan pull requests also took
six Codex rounds of build-level P1s, and the owner had to click Merge when
GitHub wouldn't set auto-merge. The owner chose these rules in the thread
"Speed up Open Convo delivery". Where they differ from the sections above,
they win.

- **The keeper supplies the missing step.** At each hourly run, for every
  open pull request whose latest commit passes `tests` and `codex-approved`
  while auto-merge is off, the PR keeper supplies what that commit still
  lacks, once per commit:
  - No independent review: it asks GrokBot (the `@cursor` request in
    "Independent reviews"). If GrokBot hasn't answered 60 minutes later, the
    keeper does the fresh Claude review itself (at most one per run) and
    posts it on the pull request, unless the keeper pushed any commit the
    review would cover ("Claude-built findings at night" below). Then it
    lists the pull request on issue #52 for a fresh Claude review from a
    separate agent, which the coordinator asks for.
  - An outside module with no plan check: the keeper does the coordinator's
    plan check and posts it.
  - A plan pull request without the owner's quoted yes: the keeper lists it
    on issue #52 as waiting on the owner, and does nothing else.
- **The keeper switches auto-merge on** under the same conditions as the
  coordinator: Codex clean, an independent review of the latest commit with
  no open P1 or P2, any plan check passed, and for a plan the owner's quoted
  yes. The coordinator may still do it first.
- **The one hand merge.** When GitHub refuses to switch on auto-merge because
  the pull request is already mergeable, the coordinator or the keeper merges
  it as `cloudwork-bot`, under the same conditions, with a plain merge
  through GitHub's merge API (never an admin bypass). The branch rules still
  require `tests`, `codex-approved` and the owner's approval on protected
  paths, so this merge passes the same gate auto-merge would have. Nothing
  else is merged by hand.
- **Plans stop after two Codex rounds.** From the third Codex round on a plan
  or docs pull request, the builder copies each new P1 into the plan's
  requirements for the code pull requests, in one line linking its thread,
  and replies "carried to the build" on the thread in the same push. That
  counts as answered (Review Guidelines), so Codex's next round on the new
  head should come back clean; if it raises the carried P1 again, the owner's
  accept line is the way through. Carrying needs no new yes from the owner. A P1 showing that
  the plan's goal or limits are wrong is still fixed in the plan itself.
- **Dependabot updates.** A Dependabot patch or minor update that touches no
  protected path needs no independent review, since no agent wrote it. Once
  `tests` and `codex-approved` pass, the keeper switches auto-merge on.
  Major-version updates, and any that touch a protected path such as
  `.github/`, go on the owner's list on issue #52.
- **Claude-built findings at night.** When Codex findings on the latest
  commit of a Claude-built pull request have had no push and no reply from
  its builder for 2 hours, the keeper fixes them on that pull request's
  branch (one pull request per run) under the code path. Its fix then needs
  an independent review by another agent, never by the keeper itself.
- **A hung Codex review doesn't block the owner's override.** The
  `owner-accepts-findings` line counts once Codex's summary has shown the
  pull request's exact head as running for 30 minutes or more, as well as
  after Codex finishes reviewing it. If Codex later posts a P0 or P1 on a
  commit that has already merged, the keeper opens an issue for it.
- **Ask for a re-approval only when it was dismissed.** A clean update from
  `main` keeps the owner's approval; GitHub dismisses it only when a commit
  changes the pull request's own diff. Before asking him to approve again,
  check that his latest review shows as dismissed. Don't update a pull
  request from `main` after he has posted an accept line unless it has
  conflicts, since a new head needs a new line.

## Agent Setup And Silence (Owner Decision, October 26, 2026)

No pull request or task waits on an agent that isn't set up or has stopped
answering. Gemini was named as a reviewer for days without ever posting, and
nothing said so. The same rule for True Convo's own agents is in
[docs/design-notes/agent-profiles-and-adapters.md](design-notes/agent-profiles-and-adapters.md)
("Knowing When an Agent Isn't Working").

- **Every reviewer and builder has a setup status here.** An agent is marked
  "set up" only after it has actually done its job on this repo (posted a
  review, pushed a build). While one is "not set up", its stand-in is used
  from the start and nobody waits for it. Any agent that sees the status is
  wrong updates this table in a pull request.

  | Agent | Job here | Status |
  |---|---|---|
  | Codex review (GitHub app) | Reviews every pull request | Set up |
  | Gemini review | Independent review | **Not set up**: Google ended the Gemini Code Assist GitHub app for individual accounts on June 18, 2026, and the replacement workflow isn't built yet; GrokBot, then a fresh Claude review, run instead |
  | Claude (cloud and Mac) | Builds, coordinates, independent reviews | Set up |
  | Codex builds (cloud and local CLI) | Builds Codex modules | Set up |
  | GrokBot teams (Cursor) | Build GrokBot modules | Set up |
  | Claude coordinator and PR keeper | Switch on auto-merge; run the hourly checks | Set up |
  | GrokBot review (Cursor) | Independent review, on request | Set up once its first `— GrokBot review` is posted. A deliberate exception to the rule above: it is still asked, and waited for up to 60 minutes, so it can earn "set up"; the fresh Claude fallback covers the wait |

- **Every expected step has a deadline.** The PR keeper checks these at each
  hourly run and reports a miss as "<agent> silent on #N" (or on the build
  issue):
  - Codex review: the keeper first restarts a hung review once
    ("Coordinating On GitHub"); Codex is reported silent only when the
    restart has gone 20 minutes without a review.
  - GrokBot or Gemini independent review: 60 minutes after the push or the
    `@cursor` request, as in "Independent reviews" above (the coordinator's
    fresh Claude fallback still applies first).
  - Any independent review, fallback included: 2 hours after Codex is clean
    on the latest commit of a pull request that still has auto-merge off and
    no independent review of that commit.
  - A builder's first sign of work (a branch, commit or draft pull request):
    4 hours after the build issue names it. After that, a builder with no
    new commit for 24 hours and no pull request ready for review is silent.
  - The coordinator: 2 hours after a pull request has Codex clean, a clean
    independent review of its latest commit and any plan check passed, with
    auto-merge still off.
  - The PR keeper itself: its "Not working" comment says when it last
    checked; the daily list reports "PR keeper silent" when that is more
    than 2 hours old or the comment is missing.
  - A builder's fix after findings: 4 hours after the latest review with
    open findings on the latest commit (Codex, Gemini or the independent
    review), or after the keeper's relay for GrokBot, whichever is later,
    with no push and no reply from the builder on those findings. Once a
    builder is silent, the keeper doesn't relay to it again until it
    pushes.
- **Not set up is said once.** An agent marked "not set up", or one that has
  never posted on any pull request, is reported once as "<agent> not set up",
  not on every pull request.
- **The owner hears it from one place.** The keeper keeps one comment of its
  own on issue #52, "Not working", rewritten each run with every silent or
  not-set-up agent (empty when all are working), so the 8 AM list carries it.
- **Reporting only.** These checks never restart, reassign, switch reviewers
  or change settings, apart from the existing one Codex restart per commit.
  A working agent is not thereby trusted.

## Accounts And Provenance (Owner Decision, October 23, 2026)

- `CloudworkSystems` is the owner's account, and only the owner uses it, in
  his browser. No agent, scheduled task or app connection may act as it. On
  the Mac, agents run every GitHub command with the bot's key, and git pushes
  from the OPEN-CONVO folder go out as the bot. An approval, an
  `owner-accepts-findings` note or a dismissed Codex review from that account
  therefore means the owner did it.
- Every agent that writes to GitHub signs in as `cloudwork-bot`: Claude in
  the cloud and on the Mac, local Codex on the Mac, GrokBot's builders and the
  Claude scheduled tasks. Two apps keep their own identities: Codex's GitHub
  app (`chatgpt-codex-connector[bot]`), which posts its reviews and its cloud
  builds; and the repo's GitHub Actions workflows (such as `owner-queue`,
  and a Gemini review workflow once one is built), which post as
  `github-actions[bot]`. Codex doesn't
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

