# Step 2: The Owner's Trial

Status: In progress (Oct 31): first trial run done. The Desk passed; Archive
History was blocked by a bug. Waiting on fixes F1 to F3, then a short re-check.

The last part of step 2 (PR 5). The scripted proof checks the stores in a
test folder; this trial checks the real True Convo Test app on your Mac.
Use **invented words only** until every box below is ticked.

## Before You Start

- Install the newest True Convo Test build (copy it to `~/Applications`).
- Open the Desk. If it asks, make a recovery key, write it down, and type
  back the two groups it asks for.
- Write an invented line in a Desk draft (for example "blue kettle test").
- Dictate an invented sentence into any app (for example "green door test").

## The Trial

Do each one, then reopen True Convo Test and check that the Desk draft and
the dictation (in Archive History) are both still there.

1. **Quit:** True Convo Test menu, Quit.
2. **Force quit:** Option-Command-Escape, pick True Convo Test, Force Quit.
3. **Sleep:** Apple menu, Sleep. Wake the Mac. The Desk should be locked;
   unlock it.
4. **Lock:** Control-Command-Q. Log back in. The Desk should be locked;
   unlock it.
5. **Restart:** Apple menu, Restart. Open True Convo Test again.

Also check once, in Finder, that `~/.tca-dictate-test/transcripts` shows
files that open as one line saying they are encrypted by True Convo.

## When Something Is Wrong

Write down which step and what you saw (a message, a missing draft, a
missing dictation). Don't delete anything; send it to the building session.

## When Every Step Passes

Step 2 is done. The next building pull request removes the Desk's "invented
data only" label, and then the real app can hold real private material.
After that, step 3 (one real conversation with a local model) starts.

## First Trial Run (October 31, 2026)

Build: True Convo Test from commit 544432b, installed in `~/Applications`,
on a Mac Studio (no Touch ID). Invented words only: the Desk draft "blue
kettle test" and the dictation "green door test".

| Check | Desk draft | Dictation |
| --- | --- | --- |
| 1. Quit | Passed | Files sealed on disk |
| 2. Force quit | Passed | Files sealed on disk |
| 3. Sleep (Desk showed Locked; unlocked with the Mac password) | Passed | Files sealed on disk |
| 4. Lock (Desk showed Locked; unlocked) | Passed | Files sealed on disk |
| 5. Restart | Passed | Files sealed on disk, including one made after the restart |
| Archive History view | | **Blocked** (F2, F3) |

Every transcript file written on October 31 opens as one line saying it is
encrypted by True Convo. The owner could not open Archive History to see the
dictations in the app.

Owner's decision (October 31, D1): record this run as "Desk passed, Archive
History blocked". Step 2 stays open until F1 to F3 are fixed; then the owner
repeats only the Archive History look on a fresh build.

### Findings

- **F1. The recovery key check shows no boxes.** "Check Your Recovery Key"
  asks for two groups, but its two text fields are not drawn (a blank strip
  in dark mode, no outline, no cursor). Typing never reaches them, so the key
  can't be confirmed and the banner keeps saying it wasn't confirmed. The
  owner asks for a proper code-entry screen: visible boxes, progress through
  the code, and a clear rule about spaces. (`DeskRecoveryKeyPrompt.askBack`.)
- **F2. The Keychain prompt takes no typing when it comes from the menu bar
  icon.** Clicking the icon brings up macOS's Keychain password prompt (with
  a Deny button). Its password field accepts no keys and Return does nothing,
  so only Deny works. The same prompt at launch does take typing. Each new
  ad-hoc build likely counts as a new app to the Keychain, which is why it
  asks at all.
- **F3. Quit and Archive History are unreachable.** The app has no menu at
  the top of the screen (it lives in the menu bar), so with F2 its only menu
  can't be used. Quitting needed `osascript -e 'tell application "True Convo
  Test" to quit'`, and force quit needed `killall -KILL "True Convo Test"`,
  because the Option-Command-Escape list doesn't show menu-bar apps. The
  steps above should say so.
- **F4. Too many copies.** Launchpad shows a wall of identical True Convo,
  True Convo Test and True Convo Studio icons (old builds and backups), so
  the owner can't tell which one to open. Clean-up waits for the owner's yes
  on each copy.
- **F5. The Desk doesn't come to the front.** After launch or unlock the
  Desk window can stay hidden behind other windows (a full-size Codex window
  here); the owner had to press Command-D and the expand button.
- **F6. Old dictations are still plain text.** Fourteen invented test
  transcripts from October 13 to 15, written before sealing landed, are
  unsealed. Decide whether old files get sealed or removed before real use.
