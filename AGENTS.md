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

## Limits

- Write every file as if this repo were public: no secrets, keys, private records,
  raw chats or personal details. Secrets belong in Keychain, never in files or logs.
- Keep build output, downloads, model files and private data out of Git.
- No public release, deployment, publication, spending, account or credential
  change, or service that outlives the session without the owner's approval.
- Preserve other agents' edits and unsaved work. No force-push, history
  rewriting or deletion of the owner's work.
- License choice is the owner's decision and is still open. Do not add one.
