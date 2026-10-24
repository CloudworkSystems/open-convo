# Skin Check: iPhone Source And Desk Health View (PRD)

Status: Draft (Oct 24): proposed from the owner's request in the "261024 OC STEERING" project; waiting on the owner's approval and the Owner Questions below.

Written October 24, 2026 by a Claude building session (thread "Build skin
cancer risk iOS submodule") from the owner's request: "a tiny submodule, a
skin cancer risk detection app for iOS, that will (UI wise) only show as
essentially a source linked to a desktop counterpart health module/submodule
for True Convo." Session name: `OC-261024-skin-check`. Umbrella: Personal.
New module: **Health**, with **Skin check** as its first submodule.

## Why

Watching moles and spots for change is the self-check dermatologists ask
people to do, and the phone camera is the natural tool for it. What people
lack is a calm record: the same spot photographed the same way over months,
answers to the standard warning-sign questions, and a summary to bring to an
appointment. The phone only needs to capture; looking back, comparing and
preparing for a visit happen on the Mac, where True Convo's Desk lives.

## What This Is Not

This module **screens and records; it never diagnoses.** That is a product
rule, not just a disclaimer:

- No output says or implies a spot is safe, benign, "low risk" or "nothing to
  worry about." False reassurance is the main harm a skin app can do, so the
  engine has no reassuring state at all. The only outputs are "worth showing
  a clinician" (with the reason) and "no warning sign noted by you," which
  always carries the reminder below.
- Every screen and every export carries the same plain line: "Skin check
  keeps a record of your own observations. It is not a diagnosis. See a
  doctor or dermatologist about any spot that is new, changing, or worries
  you, whatever this app shows."
- Urgent signs (a spot that bleeds without injury, a sore that doesn't heal)
  always say "book an appointment soon" and never wait for a review cycle.
- No AI image classifier in this plan. Owner Question 1 explains why and what
  it would take later. Without a classifier, the app makes no claim about
  what a spot is, which keeps it a record-keeping tool rather than a medical
  device.

## Plan Of Record

1. **Slice 1, now (beside the main build):** the skin check engine on its
   own in `packages/skin-check/`, tested on invented data. No app code, no
   storage code, no photos, no network, no AI. This is the part that can be
   built and proven today.
2. **Slice 2, with the iPhone capture app (PLAN.md: right after step 5):**
   the iPhone side. On the phone it appears only as one source, "Skin check,
   linked to your Mac," inside the capture app: tap it, pick the spot on a
   body outline, take a guided photo, answer the five questions, done. No
   timeline, history or results on the phone. Photos and answers move to the
   Mac the same way other captured sources do until step 9: AirDrop
   (local only) or the owner-approved iCloud Drive folder (foundations
   principle 6; health photos are named as their own item in that approval).
   The phone deletes its copy once the Mac confirms receipt, unless the owner
   chooses to keep it. Step 9's encrypted transfer replaces both later.
3. **Slice 3, Desk Health view (after slice 2, needs step 2's protected
   storage and step 5's spaces):** a Health module under Personal with Skin
   check as its first submodule. Body outline with the owner's spots,
   side-by-side photos of one spot over time, the self-check answers, what
   needs a clinician's look, and a one-page visit summary to print or share.
   Photos are stored sealed like kept recordings (step 2 PR 4c), in the
   Personal space only, and never go to any AI model, local or cloud, unless
   the owner later approves a specific use.

PLAN.md keeps the iPhone app after step 5 and the full iOS app at step 12.
Moving slice 2 earlier is an owner decision (Owner Question 2).

## Slice 1: What The Engine Does

A small library in `packages/skin-check/`:

- **Spots.** Each spot has a permanent ID, a body region from a fixed list
  (front and back of head, neck, chest, abdomen, upper back, lower back, each
  arm, hand, leg and foot, and "other" with a note), an optional short label
  ("left shoulder mole"), and a created date. Spots can be renamed, moved to
  another region, archived (removed by a doctor, for example) and removed
  (reversible until Trash is emptied).
- **Check-ins.** Each check-in is its own record with a permanent ID, a spot
  ID, a date, an optional photo reference (an opaque ID and capture details:
  distance guide used, scale marker present, light; never image bytes), the
  answers to the self-check questions, and where it came from (`phone`,
  `mac`; `import` reserved).
- **The self-check questions** follow the ABCDE warning signs every
  dermatology body publishes, asked in plain words, each answered "yes",
  "no" or "not sure":
  1. Is one half different from the other? (Asymmetry)
  2. Is the edge ragged, notched or blurred? (Border)
  3. Does it have more than one color, or uneven color? (Color)
  4. Is it bigger than a pencil eraser, about 6 mm? (Diameter)
  5. Has it changed in size, shape, color or feeling since you last looked?
     (Evolving)
  Plus two urgent questions: "Has it bled without being hurt?" and "Is it a
  sore that hasn't healed in three weeks?" and one comparison question:
  "Does it look different from your other spots?" (the "ugly duckling" sign).
- **What needs a clinician's look.** Plain rules, no scores:
  - Any urgent answer "yes": **book an appointment soon**, with the reason.
  - "Evolving" answered "yes", or "different from your other spots" answered
    "yes": **worth showing a clinician**, with the reason.
  - Two or more of A to D answered "yes" or "not sure": **worth showing a
    clinician**, with the reasons.
  - A new spot first recorded after the owner's chosen age threshold (default
    off; the owner sets it): **worth showing a clinician**.
  - Otherwise: **no warning sign noted by you**, always with the standard
    reminder. Never "low risk", "safe", "normal" or "benign".
  The engine returns these as data with the reason text; it never ranks
  spots against each other or produces a number.
- **Change over time.** For each spot, the engine lists its check-ins in
  order and pairs the latest photo with the earliest and the previous one, so
  a surface can show them side by side. It notes when the owner answered
  "evolving: yes" and when that answer changed.
- **Reminders as data.** A suggested next check per spot (default every
  month, the owner can set one to twelve weeks or off). The engine only
  computes dates; it sends nothing.
- **Visit summary.** A self-contained HTML page (and the same content as
  plain text) listing the spots worth showing a clinician first, then the
  rest, each with its region, label, dates checked, the owner's answers and
  photo references, and the standard reminder at the top. Photos are
  referenced, not embedded, so the engine never handles image data.

## Built For Sync Later

The same rules as the household lists and habit grid engines: permanent IDs,
version stamps with a device-ID tie-breaker, field-level merge, permanent
deletion markers, and check-ins merged as a set of records by ID, so the
phone and Mac can merge cleanly later. No network code in this slice.

## Data Format

One JSON file per person, with a `schemaVersion`, documented in the package
README. The file holds no image data.

## Tests (Must Pass, Run By One Command)

`npm test` in `packages/skin-check`, Node's built-in test runner, invented
people and spots only. At least:

1. Spots: create, rename, move region, archive, remove, Trash and restore.
2. Check-ins record answers and photo references, and refuse a check-in for
   an unknown or removed spot with a plain message.
3. Each rule above produces the right outcome and reason, including "not
   sure" counting toward A to D, urgent answers always winning, and the age
   threshold being off by default.
4. No output text contains reassuring or grading words: a test scans every
   string the engine produces (outcomes, reasons, summary) for words such as
   "safe", "benign", "normal", "low risk", "healthy", "clear", "fine",
   "score" and "diagnosis" used as a result, and checks the standard
   reminder appears on the summary and on every "no warning sign" outcome.
5. Change over time pairs latest with earliest and previous correctly,
   including a spot with one check-in and check-ins on the same day.
6. Reminder dates across month ends, a leap day and a daylight-saving change.
7. The visit summary lists clinician-worthy spots first, escapes all owner
   text, and contains no image data or external links.
8. Merge: the same cases as the household lists engine (different spots,
   same field, delete vs edit, equal timestamps, clock skew, offline copy
   after Trash is emptied), A into B equals B into A, and the same check-in
   arriving twice counts once.
9. Saving and loading round-trips exactly; an unknown `schemaVersion` is
   refused with a plain message.

## Out Of Scope For Slice 1

The iPhone app, the Desk view, camera code, image handling or storage, any
AI or image model, notifications, network or iCloud, Mac app or Desk code,
storage or encryption code, real personal data or real skin photos.

## Rules For The Builder

- Builder: a Claude building session (this thread), working as
  `cloudwork-bot` on the branch `OC-261024-skin-check`, pull request into
  `main` with auto-merge off and the label `agent: claude`. Never push to
  `main`.
- Files only under `packages/skin-check/` plus the STATUS.md line for this
  module. Import nothing from `apps/` or another package.
- Written like the other packages: `.mjs`, Node 22 or later, `"type":
  "module"`, `"private": true`, tests with `node --test`. No new
  dependencies, no license file or `license` field.
- No commands on the owner's Mac; no keys, accounts or private files;
  invented data only.
- Edge cases this plan doesn't name: choose the cautious reading (when in
  doubt, "worth showing a clinician"), write it in the README's "Edge cases"
  section with a test.

## Review And Finish Line

Gemini Code Assist reviews (until it posts on the repo, a fresh Claude
session that didn't build it stands in); Codex also reviews on each push and
gates the merge through `codex-approved`. The builder fixes every P1 and P2
or explains why one doesn't apply. The coordinator switches on auto-merge
once the independent review of the latest commit is clean, and the merge
gate merges it.

Slice 1 is done when the tests pass with one command, the reviews of the
latest commit have no open P1 or P2, and the coordinator's plan check finds
nothing missing. Slices 2 and 3 each get their own plan revision before
building, naming the phone and Desk files they may touch.

## Owner Questions

Builders use the recommended answer unless the owner changes it before the
code pull request merges.

1. **An AI image classifier.** Recommendation: **none for now**; build the
   record and self-check only. Reasons:
   - The large public skin-lesion datasets are mostly dermatoscope images,
     not phone photos, and the best known one (HAM10000, part of the ISIC
     archive) is licensed CC BY-NC 4.0, non-commercial only. Other ISIC
     collections mix CC-0, CC-BY and CC BY-NC, so any training set would
     need a per-image license check before it could ship in a product with
     a subscription.
   - A model that says what a spot is makes the app a medical device in the
     US and EU. Consumer apps that do this (SkinVision in Europe, for
     example) went through device certification, and accuracy on ordinary
     phone photos is a known weakness.
   - Apple's App Store rules give extra scrutiny to apps that make medical
     claims from the camera.
   If the owner wants one later, the cautious path is a personal, on-device
   Core ML model used only by the owner, never distributed, outputting
   "worth a clinician's look" only, and planned separately.
2. **When the phone part is built.** Recommendation: keep PLAN.md's order:
   slice 1 now beside the main build, slice 2 with the iPhone capture app
   right after step 5. Building the phone app earlier would start iOS work
   before the Mac's protected storage trial and spaces exist, and the photos
   would have nowhere sealed to land.
3. **Health photos through iCloud Drive.** Recommendation: AirDrop only for
   health photos until step 9's encrypted transfer, even if the owner
   approves iCloud Drive for links and clips. Skin photos are among the most
   sensitive things the phone will capture.
