# Open Convo: Project Facts and Limits

## Project Facts

- Repository: `CloudworkSystems/open-convo` (private until the owner decides otherwise).
- Mac checkout: `/Users/patrick/OPEN-CONVO`.
- This is the active product repo. True Convo (`/Users/patrick/True-Convo-AI`)
  was frozen on October 12, 2026 and is a read-only reference and parts library.
- Build order and move log: [PLAN.md](PLAN.md).

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
  the owner's words, and the requested change. Each marked screenshot is saved
  next to it as `<session-name>-01.png`, `-02.png` and so on. Codex changes no
  code, then commits only those files and pushes them to `main`.
- Claude pulls from GitHub, builds the changes on a branch named after the
  session and opens a pull request. Codex may review that pull request on
  GitHub. The owner merges it with GitHub's button.
- **How far review goes depends on what the pull request contains.**
  - *Any pull request that changes code* follows the code path below, even
    when it also changes docs.
  - *Plans and other docs* get one Codex review round. Claude writes its P1
    findings into the plan as requirements for the code that follows, and the
    owner merges. Later rounds on a plan are optional, not a merge condition;
    build-level detail belongs in the code pull requests.
  - *Code* is reviewed until Codex finishes with a 👍 on the pull request.
    Claude fixes every P1 and P2, or explains in the pull request why one does
    not apply. Only the owner decides to merge with findings still open.
  - A green "Ready to merge" button means no conflicts, not approval. Claude
    tells the owner in chat when a pull request is ready to merge.
- `Start Desk.command` pulls the latest `main` before starting, and the running
  Desk refreshes itself when files change, so the inline browser shows the latest
  version. A normal browser is only for a second look.

## Limits

- Write every file as if this repo were public: no secrets, keys, private records,
  raw chats or personal details. Secrets belong in Keychain, never in files or logs.
- Keep build output, downloads, model files and private data out of Git.
- No public release, deployment, publication, spending, account or credential
  change, or service that outlives the session without the owner's approval.
- Preserve other agents' edits and unsaved work. No force-push, history
  rewriting or deletion of the owner's work.
- License choice is the owner's decision and is still open. Do not add one.
