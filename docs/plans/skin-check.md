# Skin Check: iPhone Source And Desk Health View (PRD)

Status: Built, slice 1 (Oct 24): the owner approved the plan on #133 and chose no image classifier; slice 1, the engine in `packages/skin-check/`, is built. Slices 2 and 3 wait on their own plan revisions.

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
  engine has no reassuring state at all. A check-in's only outcomes are
  "book an appointment soon" (with the reason), "worth showing a clinician"
  (with the reason) and "no warning sign noted by you," which always
  carries the reminder below. A spot can also be "not checked since your
  clinician visit" (see "A spot's outcome over time").
- Every screen and every export carries the same plain line: "Skin check
  keeps a record of your own observations. It is not a diagnosis. See a
  doctor or dermatologist about any spot that is new, changing, or worries
  you, whatever this app shows."
- Urgent signs (a spot that bleeds without injury, a sore that doesn't heal)
  always say "book an appointment soon" and never wait for a review cycle.
- No AI image classifier in this plan. Owner Question 1 explains why and what
  it would take later. Without a classifier, the app makes no claim about
  what a spot is. That alone does not settle whether it is medical-device
  software: EU and US rules look at the intended purpose, and turning
  symptom answers into "see a clinician" advice may count. So slice 1 is an
  engine tested on invented data, and **nothing from this module ships to
  anyone but the owner** (no public Open Convo release, no App Store, no
  TestFlight for others) until a regulatory assessment of its intended
  purpose has been done and the owner has decided on it. That assessment is
  an owner decision before slice 2 is planned (Owner Question 4).

## Plan Of Record

1. **Slice 1, now:** the skin check engine on its
   own in `packages/skin-check/`, tested on invented data. No app code, no
   storage code, no photos, no network, no AI. This is the part that can be
   built and proven today.
2. **Slice 2, with the iPhone app on the parallel sync line (PLAN.md, "A
   parallel line"; built by the building lanes):**
   the iPhone side. On the phone it appears only as one source, "Skin check,
   linked to your Mac," inside the capture app: tap it, pick the spot on a
   body outline, take a guided photo, answer every self-check question
   below (the five ABCDE questions, the two urgent ones, the comparison
   question, the new-spot question, the non-mole question and the open
   question), done. "Done"
   stays unavailable until each question has an answer, and "not sure"
   counts as one. If an urgent question is answered "yes", the phone shows
   "book an appointment soon" with the reason right away, before the record
   moves to the Mac. Otherwise the phone shows no timeline, history or
   results. Photos and answers move to the Mac through the sync core and
   CloudKit ([sync-core.md](sync-core.md)) once that is wired into both
   apps: already-encrypted data in the owner's private iCloud database,
   unlocked with the recovery key, after the one-time host approval
   (foundations principle 6), with health photos named as their own item in
   that approval. Before sync is wired, AirDrop (local only) is the only
   way health photos move; never the iCloud Drive folder that the capture
   app uses for links and clips. The phone deletes its copy once the Mac
   confirms receipt, unless the owner chooses to keep it.
3. **Slice 3, Desk Health view (after slice 2, needs step 2's protected
   storage and step 5's spaces):** a Health module under Personal with Skin
   check as its first submodule. Body outline with the owner's spots,
   side-by-side photos of one spot over time, the self-check answers, what
   needs a clinician's look, and a one-page visit summary to print or share.
   Photos are stored sealed like kept recordings (step 2 PR 4c), in the
   Personal space only, and never go to any AI model, local or cloud, unless
   the owner later approves a specific use.

Since October 22, PLAN.md builds the iPhone app and sync on a parallel
line that no longer waits for step 5. Slice 2 joins that iPhone app when
the building lanes reach it, and only after the regulatory assessment in
Owner Question 4 (Owner Question 2).

## Slice 1: What The Engine Does

A small library in `packages/skin-check/`:

- **Spots.** Each spot has a permanent ID, a body region from a fixed list
  (front and back of head, neck, chest, abdomen, upper back, lower back, each
  arm, hand, leg and foot, and "other" with a note), an optional short label
  ("left shoulder mole"), and a created date. Spots can be renamed, moved to
  another region, archived (removed by a doctor, for example) and removed
  (reversible until Trash is emptied).
- **Check-ins.** Each check-in is its own record with a permanent ID, a spot
  ID, a capture time (date and time with its UTC offset, from the device
  that made it), an optional photo reference (an opaque ID and capture details:
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
  sore that hasn't healed in three weeks, or that heals and keeps coming
  back in the same place?"; one comparison question: "Does it look
  different from your other spots?" (the "ugly duckling" sign); one
  new-spot question: "Is this a spot you hadn't noticed before (new in the
  last few months)?"; one non-mole question: "Is it a rough or scaly
  patch, a firm or shiny bump, or a pimple-like spot that hasn't gone
  away?" (other skin cancers often look like these rather than a mole);
  and one open question: "Is there anything else about this spot that
  worries you (itching, tenderness, a crust, anything)?" The open question
  catches signs the list doesn't name. The new-spot question is asked on
  the spot's first
  check-in and can be answered again later. It records whether the spot is
  new on the skin, which the spot's created date in the app cannot tell.
- **What needs a clinician's look.** Plain rules, no scores:
  - Any urgent answer "yes": **book an appointment soon**, with the reason.
  - Any other answer of "yes" or "not sure" to any question (A to E, the
    comparison question, the new-spot question, the non-mole question, the
    open question, or "not
    sure" on an urgent
    question): **worth showing a clinician**, with the reasons. Dermatology
    guidance says to see a dermatologist for any one of these signs, so one
    is enough, and doubt counts as a sign. A missing answer counts as "not
    sure".
  - Only when every question is answered "no": **no warning sign noted by
    you**, always with the standard
    reminder. Never "low risk", "safe", "normal" or "benign".
  The engine returns these as data with the reason text; it never ranks
  spots against each other or produces a number.
- **A spot's outcome over time.** Each check-in gets its own outcome. The
  spot's outcome (used for grouping and in the visit summary) is the most
  cautious outcome of any check-in since the owner last recorded "seen by a
  clinician" for that spot, with every reason kept and dated. A later
  all-"no" check-in never hides an earlier urgent or clinician-worthy
  answer. Recording "seen by a clinician" (an entry on the spot with the
  visit's time and UTC offset, a permanent ID and an optional note; when
  only the date is known, the start of that day in the owner's time zone,
  so every check-in from that day stays in the outcome) is
  the only thing that starts the spot's outcome afresh. A check-in counts
  as after the visit when its capture instant is the same as or later than
  the visit's, so a tie keeps the observation visible; the earlier check-ins stay in its history. Until the next
  check-in after that entry, the spot's outcome is **not checked since your
  clinician visit**, with the visit date and a prompt to check it again;
  never "no warning sign noted by you".
- **Order of check-ins.** Check-ins are ordered by capture time (compared
  as instants, so offsets don't matter), then by check-in ID as the
  tie-breaker. "Latest", "previous" and "earliest" always mean this order,
  on every device and after any merge.
- **Change over time.** For each spot, the engine lists its check-ins in
  order and pairs the latest photo with the earliest and the previous one, so
  a surface can show them side by side. It notes when the owner answered
  "evolving: yes" and when that answer changed.
- **Reminders as data.** A suggested next check per spot (default every
  month, the owner can set one to twelve weeks or off). The engine only
  computes dates; it sends nothing.
- **Visit summary.** A self-contained HTML page (and the same content as
  plain text) listing spots marked "book an appointment soon" first, then
  those worth showing a clinician, then those not checked since a
  clinician visit, then the rest, each with its outcome and
  reasons (in the same words as the rules above), region, label, dates
  checked, the owner's answers and photo references, and the standard
  reminder at the top. Photos are
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
3. Each rule above produces the right outcome and reason. For each
   question in turn, a single "yes" or "not sure" with every other answer
   "no" is worth a clinician's look (urgent "yes" is book soon); a missing
   answer counts as "not sure"; urgent answers always win (including a
   sore that heals and comes back); and only all "no" gives "no warning
   sign noted by you".
4. No output text contains reassuring or grading words: a test scans every
   string the engine produces (outcomes, reasons, summary) for words such as
   "safe", "benign", "normal", "low risk", "healthy", "clear", "fine",
   "score" and "diagnosis" used as a result, and checks the standard
   reminder appears on the summary and on every "no warning sign" outcome.
5. Change over time pairs latest with earliest and previous correctly,
   including a spot with one check-in, two check-ins on the same day,
   two with the same instant in different UTC offsets, and two with the
   same capture time (ordered by ID), before and after a merge.
6. Reminder dates across month ends, a leap day and a daylight-saving change.
7. The visit summary lists urgent spots first, then clinician-worthy
   ones, shows each spot's outcome and reasons (an urgent spot keeps the
   "book an appointment soon" wording), escapes all owner text, and
   contains no image data or external links. An urgent check-in followed
   by an all-"no" one keeps the spot in the urgent group with the earlier
   reason and its date, until "seen by a clinician" is recorded; right
   after that entry the spot shows "not checked since your clinician
   visit", never "no warning sign". Check-ins just before, at the same
   instant as, and just after a same-day visit land on the right side of
   it, before and after a merge; with a date-only visit, an urgent
   check-in later that day still counts.
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

This is not an outside-builder module: AGENTS.md "Outside Builders" covers
modules built by Codex or GrokBot. Skin check is built by a Claude building
session under the normal Review Loop (as AGENTS.md's "Who Does What" table
gives Claude building sessions), so it takes none of the outside-builder
places. If the owner would rather hand it to Codex or GrokBot, this section
is rewritten with that builder's rules before the code starts.

- Builder: a Claude building session (this thread), working as
  `cloudwork-bot` on the branch `OC-261024-skin-check`, pull request into
  `main` with auto-merge off and the label `agent: claude`. Never push to
  `main`.
- Files only under `packages/skin-check/`, the STATUS.md line for this
  module, and this plan's status line (`In progress` when the code pull
  request opens, `Built` in the pull request that finishes slice 1). Import nothing from `apps/` or another package.
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

1. **An AI image classifier.** Answered October 24: **none for now** (the
   owner chose the recommendation). Build the record and self-check only.
   Reasons:
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
2. **When the phone part is built.** Recommendation: slice 1 now; slice 2
   as part of the iPhone app on the parallel sync line, once that app
   exists, the sync core is wired in, and Owner Question 4 is settled.
   Slice 3 still needs step 2's protected storage and step 5's spaces, so
   photos have somewhere sealed to land on the Mac.
3. **Health photos through iCloud Drive.** Recommendation: AirDrop only for
   health photos until the sync core's encrypted CloudKit sync is wired in,
   even if the owner
   approves iCloud Drive for links and clips. Skin photos are among the most
   sensitive things the phone will capture.
4. **Regulatory assessment before anything ships.** Recommendation: keep
   the module for the owner's own use until someone qualified assesses
   whether its intended purpose makes it medical-device software (EU MDR
   and MDCG 2019-11; FDA's device software functions guidance), and the
   owner decides whether to narrow the purpose, seek clearance, or keep it
   personal. Slice 1 is library code tested on invented data and offered
   to no one as a product, so it can be built first.
