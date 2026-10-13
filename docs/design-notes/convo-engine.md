# Design Note: Convo Engine

Written October 13, 2026 by the planning session, from a conversation with the
owner. Status: module plan; building starts after the Top Five (it needs step 3's
local model).

## What It Is

Convo Engine is True Convo's voice module: how a person talks to True Convo,
how True Convo learns the way they speak, and how it speaks back. Making
finished content (posts, scripts, clips) is a **separate content module** that
uses Convo Engine; neither owns the other. Keeping them separate lets each be
open core or subscription on its own.

The owner's reference projects:

| Project | What it does | Built with | License |
| --- | --- | --- | --- |
| [FluidVoice](https://github.com/altic-dev/FluidVoice) | Mac dictation at the cursor, Write Mode (rewrite text in any field), Command Mode (voice commands), choice of local speech models | Swift, macOS | GPL-3.0 (Apache 2.0 before 2026-02-23) |
| [Voicebox](https://github.com/jamiepine/voicebox) | Local voice studio: cloning, 8 speech engines, multi-track stories, Whisper transcription, local cleanup model, REST API and MCP server | Tauri + Python | MIT |
| [VoiceStudio](https://github.com/debpalash/VoiceStudio) | Local voice studio: cloning, voice design, video dubbing, audiobooks, 646 languages, batch jobs, local API and MCP | Electron + Python | AGPL-3.0 |

## Structure (Owner Decision, October 13)

1. **Own voice core, in Open Convo.** Dictation at the cursor (the Mac app,
   already built), voice corrections ("when I said this, I meant that"), a
   "your voice" profile learned from corrections and edits, and Write Mode and
   Command Mode built our own way.
2. **Voice studio through adapters.** True Convo connects to Voicebox or
   VoiceStudio running locally, through their APIs, for cloning, speech,
   dubbing and stories. Same adapter-first approach as AI models and the music
   agent.
3. **Content module, separate,** using both.

## License Rule

Open Convo's license is undecided and the owner wants others to be able to
relabel the core. So:

- Voicebox (MIT) code may be borrowed with credit.
- FluidVoice (GPL-3.0) and VoiceStudio (AGPL-3.0) code is **not copied** into
  Open Convo; they are used as separate programs through their APIs, and their
  ideas and the open speech models they use may be adopted. FluidVoice code from
  before 2026-02-23 is Apache 2.0 and may be borrowed with credit.
- Every model's own license is checked before bundling. Have the final setup
  reviewed before the repo goes public; this note is not legal advice.

## Build Order (Owner Decision, October 13)

1. **Ramble in, polished piece out.** Dictate loosely, pick Post, Email or Short
   script, get a draft in the owner's voice from the local model; edits teach the
   "your voice" profile. Builds on dictation, saved word fixes and the clarity
   library's wording lessons. Lowest risk; creates the voice profile the next two
   reuse.
2. **Write Mode.** Highlight text in any app, press a key, say "friendlier" or
   "shorter"; preview, replace in place, Undo. Reuses the Mac app's existing
   select-and-replace. Stepping stone to Command Mode.
3. **Voicebox adapter.** True Convo reads replies aloud and later narrates
   content. Voice cloning only of the owner's own voice or with the speaker's
   recorded consent.

## Rules

- Local first: speech recognition and the rewrite model run on the Mac by
  default; any cloud route follows the one-time approval rule.
- Recordings stay off by default (step 1) and protected (step 2).
- Nothing is replaced in another app without a preview and Undo.

## Sources (Checked October 13, 2026)

- https://github.com/altic-dev/FluidVoice
- https://github.com/jamiepine/voicebox
- https://github.com/debpalash/VoiceStudio
