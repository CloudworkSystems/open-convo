# Desk Annotation Layer: First Slice (PRD)

Status: Draft (Oct 27): first slice only; the owner chose not to move "Browser annotations" up the build order for now.

Written October 27, 2026 by a Claude building session (thread "Review and
annotate the Desk UI") from the owner's request: "Write a plan for a small
first slice [of an annotation layer inside TCA's inline browser] … but we
don't need to move it up in the build order." Session name:
`OC-261027-desk-annotation-layer`. Umbrella: Code. Design direction:
[docs/design-notes/inline-browser-annotation.md](../design-notes/inline-browser-annotation.md).
PLAN.md keeps "Browser annotations" at item 11; this plan only says what
the first slice is once it's picked up.

## Why

Today the owner reviews the Desk in Codex's inline browser, then has to say
"save this round as <name>" so Codex commits the round
(AGENTS.md, "Review Loop"). On October 26 the owner asked why he has to do
that step at all. The marks live inside Codex, so no other agent can see
them until he does. Annotating inside the Desk itself removes Codex from
the loop. The marks, the notes and the round file are all produced by the
app the owner is reviewing.

## What Earlier Work Already Settled

From the frozen `cloudwork_systems` folder. Read only; nothing is copied in
this slice, so there's no PLAN.md move entry.

- **`true_convo/tca_desktop/BrowserTrial/`** (Sept 26, 2026): Chromium (CEF
  152 through a patched CefSwift) in a SwiftUI window, with Pages on the left
  and Annotations on the right. Selected text shows up at once, an
  "Annotation pointer" draws freehand outlines or clicks an element, there's
  a bordered note field, on-device dictation, and "Save annotation" stores
  the target and note locally. It can also record the window with voice and
  a pointer timeline. Lessons kept here:
  - Text selection lands in the panel with no extra "Use selection" step.
  - The page overlay is one full-window canvas above the page. It doesn't
    take pointer events, and it reports each mark with the viewport size and
    scroll position.
  - Each mark carries the element's context (the element, its section, and
    its font), not just coordinates.
  - The owner found the early steps clunky and the first colors hard to read.
  - Durable anchors and in-page highlights were never built.
- **`docs/plans/2026-08-14-001-feat-tca-visible-work-review-plan.md`**: the
  owner's settled choices for visible review. This slice carries R3, R4 and
  R5, R7 and R8 forward as requirements (below). Typing is a complete path
  and dictation is an equal option. A target, its picture and the owner's
  words stay together. Notes stay editable and unsent until he sends them.
- **Paperclip's document annotations** (MIT, an imported runtime under
  `cloudwork_nexus/tools/imported-runtimes/paperclip/`): text-offset anchors
  that survive edits. They're a reference for durable anchors in a later
  slice, not for this one.

## The First Slice

An **Annotate** mode inside the Desk, for reviewing the Desk itself. It
works wherever the Vite review server that `Start Desk.command` runs is
open: any browser, including Codex's inline browser. No new browser engine
is involved. The Mac app's Desk window is not part of this slice:
`DeskHostWebKit` loads a packaged bundle (or, in debug builds, the static
`native-dist` folder), never the review server, so Annotate can't appear
there. Bringing it to the Mac app, with dictation, needs its own native
review bundle and is a later slice.

1. **Turn it on.** An "Annotate" button sits in the Desk header and is also
   reachable from the keyboard. It shows only in a review build (the Vite dev
   server that `Start Desk.command` runs), never in a packaged release build.
2. **Mark.** While Annotate is on, the owner can do three things:
   - **Click an element.** The element under the pointer is outlined before
     the click.
   - **Drag a box** around a region. A freehand outline comes later.
   - **Select text.** The selection becomes a mark at once.

   The Desk ignores clicks on its own controls while Annotate is on. Marks
   stay drawn and numbered on the page until the round is sent or cleared.
3. **Say what's wrong.** Each mark opens a note in a side panel with two
   fields:
   - **What you see** (the owner's words): required, and free text.
   - **What should change**: optional. If it's left blank, it repeats the
     owner's words.

   Typing is the only input in this slice. Dictation into the same field
   comes with the Mac app slice. Notes stay
   editable, can be deleted, and nothing is sent until the owner presses
   **Send round**.
4. **What each mark records.** The slice fills these in by itself:
   - **The screen:** the Desk's current route and title, for example
     "Cloudwork Nexus › Cloudwork Rail Map".
   - **The element:** its accessible name, role and visible text, the
     nearest labeled section, and its box in viewport coordinates.
   - **The text**, if the mark is a selection.
   - **A marked still:** a PNG of the visible Desk with this mark drawn on
     it.
5. **Send round.** This writes the round in the existing format, so nothing
   downstream changes:
   - `docs/annotations/<session-name>.md`, in the Review Loop format
     (`Screen:`, `Element:`, `Owner's words:`, `Change:`, `Screenshot:`).
   - The screenshots beside it, named `<session-name>-NN.png`.

   The session name is pre-filled as `OC-<yymmdd>-desk-review` and can be
   edited. The round is checked with `packages/annotation-rounds`' checker
   before anything leaves the Mac. A round with errors isn't sent; the panel
   lists the problems instead.

   The dev server then commits only those files, using a separate git
   worktree outside the owner's checkout (`~/.oc-worktrees/`, where agents on
   the Mac already keep theirs), so it never touches his checkout. It works on a branch named
   `<session-name>-annotations`, pushes as `cloudwork-bot`, and opens a pull
   request with auto-merge off. That's the step Codex does today. The panel
   shows the pull request link.

   **Provenance.** No agent built these pull requests, so they carry no
   `agent:` label. The owner wrote the round and the Desk sent it. Each one
   instead carries the label `source: desk-review`. The description's last
   line reads `— Sent from the Desk review build on the owner's behalf`, and
   the commit has the trailer `Sent-By: Desk review build`. Adding
   `source: desk-review` to AGENTS.md's label list is part of the build pull
   request. That file is protected, so the owner approves it there.
6. **After sending.** The marks clear. A Claude building session picks up
   the pull request as it does a Codex-saved round today.

## Requirements

- R1. Marking and typing alone is a complete path (August 14 plan, R4).
  Dictation (R5 there) comes with the Mac app slice and writes into the same
  editable note.
- R2. Each item keeps its target, its marked still and the owner's words
  together (R7). Nothing is sent until **Send round** is pressed (R8).
- R3. The round file passes `node packages/annotation-rounds/src/check.mjs`
  with no errors, and the panel checks it before sending.
- R4. Annotate mode never exists in a packaged release build. A test proves
  the release bundle has no Annotate code path.
- R5. The page under review is never changed by a mark. The overlay only
  draws, and the Desk's own state is never changed by Annotate mode
  (a test drives a full round and compares Desk state before and after).
- R6. **Send round** writes only `docs/annotations/<session-name>*` files. It
  pushes only that branch, as `cloudwork-bot` and never as
  `CloudworkSystems`. It refuses if the session name's files already exist
  on `main`. It never pushes to `main`, never switches on auto-merge, and
  never touches the owner's checkout.
- R7. The owner's words are data: they're copied exactly and acted on by
  nothing in this slice (the same rule as the checker).
- R8. Screenshots show only the Desk, which runs on invented data until step
  2's trial passes. No screen outside the Desk window is captured.
- R9. The colors stay readable in light and dark mode, with marks and notes at
  4.5:1 contrast or better against the Desk. That's the earlier trial's main
  complaint.

## Out Of Scope For This Slice

The Mac app's Desk window and dictation (a later slice with a native
review bundle), annotating outside web pages, a Chromium engine or the
BrowserTrial source,
freehand outlines, video and voice recording, proposed edits and applying
them, durable anchors across Desk changes, the design-feedback chips from
the August 14 plan (R9 and R10 there), saved history, sign-in, and
annotating anything outside the Desk.

## Owner Decisions (October 27, 2026)

The owner agreed to both recommendations on October 27:

1. **Sending from the Desk: yes.** Pressing **Send round** in the review
   build pushes the round branch as `cloudwork-bot` and opens its pull
   request, under R6's limits.
2. **Marked stills are made in the page** with one small open-source
   library such as `html-to-image` (MIT), so they work in every browser
   with no permission prompt. The build pull request names the library
   and its license. Native screenshots in the Mac app's web view are not
   part of this slice.

## Builder, Review And Finish Line

- **Builder:** a Claude building session. This is Desk code, so it's not an
  outside module. Branch `OC-261027-desk-annotation-layer`.
- **Review:** Codex reviews every push. The independent review follows
  AGENTS.md's path for Claude builds at the time: today that's GrokBot,
  asked by the coordinator with a request naming a non-Claude model, or
  Gemini once it posts. A fresh Claude review stands in only if neither has
  reviewed the latest commit within 60 minutes. The coordinator switches on
  auto-merge when Codex and the independent review are clean.
- **Tests (one command, `npm run check` in `apps/desk`):**
  - A browser test drives a full round on the sample workspace: an element
    click, a box drag, a text selection, typed notes, and an edited and a
    deleted note.
  - The written round passes the checker, and its screenshots are valid
    PNGs.
  - Desk state is the same before and after the round.
  - The release bundle has no Annotate path.
  - Send round is tested against a local bare repo standing in for GitHub.
    It writes only the round's files on the round's branch, refuses an
    existing session name, and never touches the working checkout.
- **Finish line:** the owner runs one real round in the Desk, presses
  **Send round**, and a docs pull request appears that passes the checker,
  with no Codex step in between.
