# Step 2: The Owner's Trial

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
