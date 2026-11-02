# Scheduled Tasks

Each file here is the full instructions for one of the project's scheduled
tasks. The task itself holds only a short pointer prompt that reads its file
from `main` at the start of every run, so a change to a task is a normal pull
request. Nobody pastes prompts into the task, and no copy drifts out of date
(owner decision, November 2, 2026).

| Task | Schedule | File |
| --- | --- | --- |
| Open Convo PR keeper | Hourly at :10 | [pr-keeper.md](pr-keeper.md) |
| Open Convo daily needs-you list (cloud) | 7:52 AM Eastern | [daily-list.md](daily-list.md) |
| Open Convo security sweep (weekly) | Mondays 6:37 AM Eastern | [security-sweep.md](security-sweep.md) |

## Rules

- This folder is in `.github/CODEOWNERS`, because a change here changes what
  a task may do. The owner approves every change on GitHub.
- A change takes effect on the task's next run after it merges.
- Write every file as if this repo were public: no secrets, keys, private
  records or personal details.
- The task's name and schedule live in the task, not here. Changing either
  means rebuilding the task from a Claude thread in the project, with the same
  pointer prompt, and pausing the old one (deleting a task also deletes the run
  threads it started). Update the table above in the same pull request.

## The Pointer Prompt

Each task's prompt is this, with `<file>` replaced by its file name:

```text
Your instructions are the file docs/scheduled-tasks/<file> on the main branch of CloudworkSystems/open-convo. Read it first with `git fetch -q origin main && git show origin/main:docs/scheduled-tasks/<file>`; if that fails, use `curl -sSf -H 'Accept: application/vnd.github.raw' 'https://api.github.com/repos/CloudworkSystems/open-convo/contents/docs/scheduled-tasks/<file>?ref=main'`. Then follow it exactly, as if it were this prompt. If neither works, do nothing else and reply only "<file>: couldn't read my instructions from main". Never use an older copy from anywhere else.
```
