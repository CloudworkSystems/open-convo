# Open Convo for Mac

The desktop app. Today it is the dictation app with its heads-up display:
talk at the cursor in any Mac app, fix a word once and it remembers. It also
carries the native side of the Desk: a window that hosts the Desk from
`apps/desk`, and the process that runs one AI participant for a conversation.

## Parts

- `VoiceCursorCore`, `VoiceCursorMac`: dictation at the cursor and the HUD.
  Recordings are off by default; a fresh install keeps none unless the user
  turns retention on.
- `CorrectionMemory`: remembered corrections ("remember this fix").
- `DeskHost`, `DeskHostWebKit`, `DeskWindowKit`: the Desk inside the app, with
  invented data only so far.
- `ParticipantProcess`, `ParticipantSupervisor`: runs one subscription-backed
  AI participant per conversation run. Not connected to a real model yet.

## Build and Test (on a Mac)

```sh
swift build -j 2
swift test -j 2
```

Packaging (`scripts/package_app.sh`) builds the Desk from `../desk` into the
app. Signing, notarizing, installing and publishing updates need the owner's
approval each time.

## Moved From True Convo

Ported from the frozen True Convo repo on October 12, 2026. Its build history,
release notes (which name the owner's signing certificate) and license file
stayed behind. The app is still named True Convo with bundle ID
`com.trueconvo.voice-cursor`; renaming is an open decision in `PLAN.md`.
