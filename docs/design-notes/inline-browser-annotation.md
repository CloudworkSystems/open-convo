# Design Note: Inline Browser And Annotations

Rewritten October 13, 2026 by the planning session from True Convo's
`docs/2026-10-02-inline-browser-annotation-concept.md` (commit `c527e36`).
Status: product direction. It adds no first-beta requirement and authorizes no
build, sign-in, recording, outside service or spending.

## What The Owner Wants

True Convo shows a real web page inside the app, beside the conversation, so a
person can point at the thing they mean and explain a change right there. This
is the in-app version of the annotation round the owner runs today in Codex's
inline browser (see AGENTS.md, "Review Loop"). A Chromium-based, open-source
starting point is preferred for broad website compatibility. The browser
supports creating or editing content the person controls, as well as marking
existing pages. Marking a publisher's page gives True Convo no permission or
ability to change that publisher's live site.

- Selected text appears in the Annotations panel at once; no separate "Use
  selection" step.
- One click identifies an element, section, font or other page detail; dragging
  the annotation pointer draws a freehand outline around a region. The note
  area is easy to see.
- The person types or dictates the note, or records the page, pointer movement
  and spoken explanation together and plays the video back in the app. One
  microphone's narration is heard in both ears.
- The annotation and page context lead to a concrete proposed change for the
  person to review. True Convo never applies it silently. Applying an approved
  change to a page or document the person controls is a later capability.
- Public pages and a usable annotation flow come before Google sign-in,
  passkeys, saved history or persistent sign-in.

This describes the intended experience, not features present in the current
apps.

## The Existing Trial

A separate `BrowserTrial` candidate (Chromium in a Mac window) remains in the
`cloudwork_systems` archive under `true_convo/tca_desktop/BrowserTrial/`. Its
README describes public page navigation, local sample pages, text selection,
element or region targets, local notes, dictation controls, video recording and
in-app playback. In the owner's try, speech and video stayed in sync; an early
left-ear playback problem was corrected to centered narration. Those results
apply to that trial only. Nothing from it has been copied into this repo.

Not yet shown: a smooth annotation flow, a proposed-edit review flow, freehand
curved outlines, dictation with the owner's microphone, a fresh narrated capture
after the audio change, durable page targets, sign-in and passkeys, and
integration with the current apps. The owner found the early annotation steps
clunky and the first color treatment hard to read.

## When This Becomes A Feature

First, a small visible slice the owner can try in the Mac app: open a public
page, mark text or a region directly, dictate a note, and review a proposed
edit to a local page the person controls. Private page content and recordings
stay local unless the person approves a specific destination. Recording start
and stop are clearly shown. The browser bridge and navigation rules are checked
before public sites are allowed, and protected storage (step 2) comes before
sign-in or persistent history.

Still open: where it sits in the app, when, whether to reuse the trial's source
(brought over then, after a privacy check), and how approved edits apply.
Decide these against the current Desk and Mac app, not the old trial.
