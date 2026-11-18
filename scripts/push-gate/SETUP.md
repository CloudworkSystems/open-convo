# Push Gate: Setup Notes

The Mac-only part of the push gate
([docs/plans/push-gate.md](../../docs/plans/push-gate.md)). The gate itself
is [packages/push-gate/](../../packages/push-gate/README.md).

| File | What it is |
| --- | --- |
| `mac-seam.mjs` | Reads the app's key through the 1Password service account. The only code that touches Keychain or 1Password. |
| `settings.example.json` | The shape of the settings file. Names only; no secret goes in it. |
| `com.cloudworksystems.push-gate.plist` | The background job, one run a minute. **Not installed.** |
| `com.cloudworksystems.push-gate-update.plist`, `update-own-copy.sh` | The daily 6 AM update of the gate's own copy of `main`. **Not installed.** |

Nothing here is installed or switched on by a merge. Creating the gate's
macOS user, its vault and service account, moving the key and loading the
background job are the owner's setup at Build Order step 4 of the app
switch ([github-app-switch.md](../../docs/plans/github-app-switch.md)).

## Now: Attended Runs (Until Step 4)

Every run is a command the owner approves in the OPEN-CONVO session, from a
fresh worktree of `main`.

1. **Settings file, once.** Copy `settings.example.json` to
   `~/.config/push-gate/settings.json` and fill in three names: the
   1Password vault, the id of the item that holds the app's private key, and
   the Keychain item's service name that holds the service account's
   sign-in. These are the same three names the hand-built token commands
   used. The file holds names only. `PUSH_GATE_SETTINGS` points at another
   path if needed.
2. **A token for one command:**
   `node packages/push-gate/bin/push-gate.mjs token -- git push origin <branch>`
   or `... token -- gh pr create ...`. This replaces the hand-built commands
   used for #313, #314 and #319.
3. **A run:** `node packages/push-gate/bin/push-gate.mjs run-once`. With the
   default folders, requests go in `~/.push-gate/shared/requests/` and
   results appear in `~/.push-gate/shared/results/`.

Before step 4 the agents and the gate are the same macOS user, so an agent
could write to the gate's folders or read the key. That is why every run
stays a command the owner approves until then.

## Step 4: Handing Requests To The Gate's User (The Shared Folder)

Chosen design for "To Check While Building": one shared folder with group
permissions, writable by agents for requests and only by the gate for
results.

- Two macOS users: the agents' user (today's) and the gate's own user. One
  group, for example `pushgate-agents`, with both users in it.
- `/Users/Shared/push-gate/` is owned by the gate's user, group
  `pushgate-agents`, mode `0750`.
- `/Users/Shared/push-gate/requests/` is owned by the gate's user, group
  `pushgate-agents`, mode `1770`. Agents can add files. The sticky bit
  means an agent can't remove or rename a file it doesn't own, and the
  gate, as the folder's owner, can remove any file once it has taken it.
  Agents write request files and bundles readable by the group (`0640`).
- `/Users/Shared/push-gate/results/` is owned by the gate's user, group
  `pushgate-agents`, mode `0750`. Agents can read results and can't write
  them. `push-gate status` only reads this folder, so any agent session can
  run it with `PUSH_GATE_SHARED=/Users/Shared/push-gate`.
- The gate's own folder (`PUSH_GATE_HOME`, in the gate user's home, mode
  `0700`) holds its working copies, state, write log and git checkout.
  Agents can't read or write it.
- The gate copies a request and its bundle into its own folder before it
  checks them, and reads only plain files (never links), so a file changed
  after the copy changes nothing.
- The gate runs its code from its own copy of `main`, in the gate user's
  home, updated daily at 6 AM by the update job. Both gate folders are
  owner-protected, so only code the owner approved runs.

## Step 4: The Gate's Sign-In

A background job can't open the Keychain of a macOS user who isn't signed
in. The settings file's `signIn` picks one of the plan's two places:

- `"signIn": { "file": "<path>" }`: a file only the gate's user can read
  (mode `0600`), protected by FileVault. Recommended. The gate refuses the
  file if it belongs to another user, is a link, or anyone else can read it.
- `"signIn": { "keychainService": "<name>" }`: the gate user's Keychain,
  which needs that user kept logged in, and the jobs installed for that
  login session instead of as system jobs (see the next section).

## Step 4: The Background Jobs (Owner Installs)

The jobs are system jobs that run as the gate's user, so they keep running
when nobody is logged in and start again after a restart. (A job in a
user's own `~/Library/LaunchAgents/` only runs while that user is logged
in, which is not unattended.)

In both `.plist` files, replace `GATE_HOME` with the gate user's home
folder and `GATE_USER` with that user's short name, and check the path to
`node`. Then, as an administrator, copy them to `/Library/LaunchDaemons/`
(owned by `root`, mode `0644`) and load them with `sudo launchctl`. The
`UserName` key in each file makes the job run as the gate's user, never as
root. The exact commands are part of step 4's own steps, given then.

A system job has no login session, so it can't open the gate user's
Keychain. With these jobs, use the sign-in file ("The Gate's Sign-In"
above). The Keychain choice only works if the jobs are instead installed in
the gate user's `~/Library/LaunchAgents/` and that user stays logged in.

- The gate job runs `push-gate run-once --quiet` every 60 seconds. With
  nothing waiting it does nothing, prints nothing and writes nothing, so
  `run.log` only grows when there is work.
- The update job runs `update-own-copy.sh` at 6 AM by the Mac's clock (the
  Studio is on New York time), forward only, with hooks off.

## After A Stop

A sign-in failure (401), three refusals from GitHub in an hour, or an
installation that reaches more than this repo stop every write. `push-gate
status` says why. When the cause is fixed, the owner runs
`push-gate run-once --restart`.

## The Local Review Record

A push request carries `"review": { "reviewer", "commit", "result" }` from
a different agent than the builder. Checked while building (November 15,
2026, Codex CLI 0.144.3): the Codex CLI reviews without a chat window with

```
codex review --commit <sha>
codex review --base main
```

(`codex exec review` is the same review under `exec`). The reviewing agent
turns its outcome into the record's `result`: `clean`, or `findings
answered` once the builder has fixed or answered each finding.

## Also Checked While Building

Cursor's own GitHub sign-in: on November 15, 2026 the agents' macOS user on
the Studio had no Cursor app, no Cursor command line, no Cursor settings
folder and no Keychain item from Cursor, so there is no local Cursor
sign-in as `cloudwork-bot` to remove. Whether Cursor's cloud side holds a
GitHub connection can only be seen in Cursor's own dashboard, by the owner.
