# Short Package, The Content Module's First Slice (PRD)

Status: Draft (Nov 6, 2026): written on the owner's yes to drafting it; waiting on Codex's review and the owner's yes to merge.

Written November 6, 2026 by a Claude session (project "Claude", thread
"261106 CONTENT MODULE VIDEO REVIEW"). Session name:
`OC-261106-short-package`. Umbrella: Creators. The owner sent a podcast
episode about a one-person Shorts "content team" built with Claude and
asked whether something like it could be the foundation for a content
module (November 6). The review in that thread found that the parts worth
building first are the ones that write and package, and that the part where
an AI drives a video editor should wait. The owner said yes to drafting this
plan the same day.

**Builder:** the package stands on its own, so it can go to an outside
builder under AGENTS.md "Outside Builders" or to a Claude building session
(`agent: claude`); the coordinator picks when the plan merges.
**Reviewers:** Codex on every push, plus the usual independent review
(GrokBot, or a fresh Claude review that didn't build it), and the
coordinator's plan check for an outside builder.
**Finish line:** the package merges with `tests` passing, the command builds
the invented sample creator's package end to end (below), and the owner
trial passes on the owner's Mac.

## Why

The owner makes content alongside a full-time clinical job, so the time
that matters is the time between "I have something worth saying" and "a
short is ready to record and post". The episode's own lesson is the design
rule here: cutting long videos into shorts failed twice for its guest, and
what worked was a script written for the short, recorded fresh, then
packaged with captions and post text for each platform.

None of that needs a paid tool, and the package itself contacts no
service. A model the person already has writes the words; plain code checks
them, lays them out and writes standard files that every editing app opens.
Whatever the person gives that model goes wherever that model runs: a cloud
model such as Claude receives the source text, and a local model keeps it on
the machine. The plan says so wherever it matters (the skill and the owner
trial below). That keeps this slice
inside the October 22 rule for joining the core (PLAN.md "What joins the
core"): it runs on the person's own model at almost no cost.

## What It Does

Three pieces, in `packages/short-package/` and `docs/skills/short-script/`.
Plain JavaScript, Node 22, no dependencies. The library reads no clock, no
files and no network; the command does the file work and supplies the
time. Nothing is fetched, uploaded, posted or published.

### 1. The Style Card

A small file the person owns and can read: `style-card.json`.

- Fields: `version`; `aspect` (`9:16` to start); `maxSeconds`;
  `hookSeconds`; `wordsPerSecond` (the person's speaking pace, default
  2.5); `captions` (`position`, `maxWordsPerLine`, `maxLines`, `style`, a
  free-text note such as "yellow, centered"); `layout` (a free-text note
  such as "talking head below, screen above"); `brollRule` (free text);
  `platforms` (a list of `{ name, maxChars, hashtags, notes }`, names
  unique, compared ignoring letter case); `bannedPhrases`; `signOff`.
- `validateStyleCard(card)` returns `{ ok, errors }` the same way
  `validateCapability` does (every problem at once, a path for each, no
  I/O). Unknown fields are refused, so nothing like an "always post" switch
  can be slipped in. A platform named twice is refused ("LinkedIn is on the
  card twice; keep one."), so each platform has one limit. Script copy is
  matched to the card's platforms by name, ignoring letter case.
- Platform limits are the person's own numbers, written on the card with
  the date they checked them. The package never hard-codes a platform's
  limit, because those change.
- The card is written by the person. The skill (below) may draft one from
  the person's own description of shorts they like; the person saves it.
  Learning a style by watching video files is not in this slice.

### 2. The Script Skill

`docs/skills/short-script/SKILL.md` and its `capability.json` (status
`draft`), in the format `packages/capabilities` already checks.

- Input: one source the person gives it (an episode outline, a build-log
  entry, notes they paste) and their style card.
- Output: one script as JSON in the shape `validateScript` checks:
  `{ title, hook, beats: [{ say, onScreen, broll }], close, platformCopy:
  [{ platform, text }] }`. `say` is what the person speaks. `onScreen` and
  `broll` are short notes, never file paths or links.
- The skill writes a script made for a short, not a cut-down of the
  source, and keeps the hook within `hookSeconds` at the card's pace.
- The skill runs on whatever model the person chose, and that model reads
  the source. The skill's `capability.json` and `SKILL.md` say in plain
  words that a cloud model's provider receives the source text and a local
  model keeps it on the machine, so the person can pick a local model for a
  private source. The skill never runs
  anything, posts anything or calls any service; `actions_needing_approval`
  lists "publish or post anything" and "spend money".
- `validateScript(script, card)` works out the timing in code, never from
  the model's own count: words divided by `wordsPerSecond`. It refuses a
  script whose hook or total runs over the card's limits, a platform copy
  over that platform's `maxChars`, a platform the card doesn't list, a
  platform the card lists with no copy, a platform with more than one copy,
  or any banned phrase, and names each problem in plain words. So a script
  that passes has exactly one draft for each platform on the card.

### 3. The Short Package

`buildPackage(script, card, { createdAt, sourceSha256, model })` returns a
list of `{ name, text }` files, `model` being optional. It runs
`validateScript` first and refuses a script that fails. The command writes
the files to one new folder exactly as returned, never adding to them.

| File | What it holds |
|---|---|
| `script.md` | The script laid out to read from, one beat per paragraph, with the estimated time of each beat |
| `captions.draft.srt` | Captions split by the card's `maxWordsPerLine` and `maxLines`, timed from the word count. The name says draft, because the times are estimates until the person records |
| `shot-list.md` | Each beat with its on-screen and B-roll notes, for the person (or their editor) to match clips by hand |
| `posts.md` | The drafted text for each platform on the card, each marked "draft, not posted" |
| `receipt.json` | `createdAt`, the style card's `version`, `sourceSha256`, the `model` option when the person gives one, and the SHA-256 of every other file. No source text |

- The command: `node packages/short-package/src/cli.mjs build --script
  <file> --card <file> --source <file> --out <folder> [--model <name>]`.
  It hashes the source but never copies it into the package.
- It refuses an `--out` folder that already exists, writes to a temporary
  folder beside it and renames when every file is written, so a stopped run
  leaves no half package. The temporary folder has a random part in its name
  and holds a marker file naming the `--out` it was made for. The command
  only ever removes a temporary folder that carries its marker for that same
  `--out`; any other leftover is left alone and named.
- `node packages/short-package/src/cli.mjs check <folder>` recomputes the
  hashes in `receipt.json` and says which of the other files changed since
  the package was built, or are missing or new. It can't tell whether
  `receipt.json` itself was edited, and says so in its output ("This checks
  the other files against the receipt. It can't check the receipt itself.").
  This is a check for accidental changes, not proof against tampering, the
  same limit the creator proof kit states for its ledger.
- A sample run uses an invented creator, an invented source and an invented
  card in `packages/short-package/samples/`. No real transcript, session
  record, post or personal detail goes in the repo.

## When It Goes Wrong

This slice adds a command, not a screen, so the answers are about what the
command prints.

1. **No connection.** Doesn't apply: nothing in the package uses the
   network. The skill needs whatever model the person chose; if that model
   isn't there, the package is never asked to build.
2. **Interrupted.** A stopped build leaves only its marked temporary
   folder, which the next build of the same `--out` removes before it
   starts, and says so. A leftover without that marker is never removed:
   the command names it and asks the person to move it. The finished folder
   appears only when it is complete.
3. **Empty or first run.** With no style card, the command says "No style
   card yet. Copy samples/style-card.json, change it to fit your shorts, and
   pass it with --card." and stops.
4. **Denied or stuck.** If the folder can't be written, the command says
   which folder and stops without leaving partial files.
5. **The error message.** Every refusal names the problem in plain words,
   for example "The hook runs about 6 seconds; your card allows 3." or "The
   LinkedIn draft is 3,412 characters; your card allows 3,000."

## Owner Trial

On the owner's Mac, in True Convo Test or a plain terminal:

1. The sample run builds the invented creator's package, and `check` says
   every file matches.
2. The owner copies the sample card and changes it to his own shorts.
3. With a model he picks, the skill writes one script from one of his own
   sources, for example an episode outline from his session-archive video
   series. The skill's own words tell him, before he gives it the source,
   that a cloud model such as Claude receives the source text and a local
   model keeps it on his Mac.
4. `validateScript` passes it, or names a problem he agrees with.
5. The package builds; `script.md` reads well enough to record from; the
   draft captions import into the editing app he uses; the post drafts fit
   his card.
6. He edits one file other than the receipt and `check` names it; `check`
   also prints that it can't check the receipt itself.
7. The package sent nothing anywhere, and nothing was posted (he checks his
   accounts). The only thing that left his Mac is what he gave the model,
   and only if he chose a cloud model.
8. Each "When it goes wrong" answer above: a stopped build, a leftover
   folder without the marker, a missing card, an unwritable folder and an
   over-long hook each print what this plan says.

## Not In This Plan

- Driving Adobe Premiere, DaVinci Resolve or any other editor. The bridges
  for both are community projects. The Premiere one needs an Adobe developer
  setting switched on, and Resolve's own automation now needs its paid
  Studio edition. A later plan can add an editor as an optional route in
  the portable capability layer, held by the risk review and needing a yes
  before each run.
- Picking B-roll from footage, rendering video, making thumbnails, and
  re-timing captions from a recording (that needs speech-to-text, a new
  dependency).
- Ideas ranked by search data. The tool in the episode is paid, so it is a
  subscription route behind the spending cap in
  [media-generation-capability.md](media-generation-capability.md), which
  starts at $0.
- Posting anywhere, or a scheduled job. A weekly "draft one carousel" job
  fits the durable agents work later, and it drafts only.
- Learning a style by watching video files.

## Later Slices (For Ordering Only)

1. Re-time `captions.srt` from a transcript of the recorded take.
2. An edit list (FCPXML) built from clips and in and out times the person
   names, which Premiere and Resolve both import.
3. Record each finished short in the creator proof kit's ledger
   ([creator-proof-kit.md](creator-proof-kit.md)).
4. The weekly drafting job.
5. The optional editor route described above.

Each needs its own plan, and the owner's yes, before it is built.

Credit: idea from a podcast episode the owner sent on November 6, 2026
(guest Saj Adib, "Marketing Against the Grain"); text written fresh.
