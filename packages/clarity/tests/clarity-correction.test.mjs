import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyClarityLessonAction,
  guidanceForFutureReply,
  validateClarityCorrection,
} from "../src/clarity-correction.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, "fixtures/clarity-correction.example.json"), "utf8"),
);
const at = "2026-08-06T12:05:00.000Z";

test("desktop clarity fixture explains and rewrites without acting or writing permanent memory", () => {
  validateClarityCorrection(fixture);
  assert.equal(fixture.surface, "trueconvo_desktop");
  assert.equal(fixture.selection.source_role, "assistant");
  assert.equal(fixture.immediate_result.requires_memory_review, false);
  assert.equal(fixture.immediate_result.replaces_original, false);
  assert.deepEqual(fixture.owner_notice.available_actions, ["undo", "tune", "keep"]);
  assert.equal(fixture.effects.writes_canonical_memory, false);
  assert.equal(fixture.effects.changes_source_message, false);
});

test("clarity proof rejects phone, user-authored, mismatched, or raw transcript input", () => {
  assert.throws(
    () => validateClarityCorrection({ ...structuredClone(fixture), surface: "trueconvo_ios" }),
    /desktop only/,
  );

  const userAuthored = structuredClone(fixture);
  userAuthored.selection.source_role = "user";
  assert.throws(() => validateClarityCorrection(userAuthored), /assistant-authored/);

  const mismatched = structuredClone(fixture);
  mismatched.selection.selected_text = "unrelated phrase";
  assert.throws(() => validateClarityCorrection(mismatched), /must appear/);

  const rawTranscript = { ...structuredClone(fixture), raw_transcript: "private source text" };
  assert.throws(() => validateClarityCorrection(rawTranscript), /raw audio or transcript/);
});

test("active Wong lesson produces narrow non-canonical guidance for a later reply", () => {
  const guidance = guidanceForFutureReply(fixture);
  assert.equal(guidance.preferredWording, "give this part the tool it needs");
  assert.equal(guidance.difficultyReason, "stacked_jargon");
  assert.deepEqual(guidance.scope, ["owner_private", "topic:software"]);
  assert.equal(guidance.canonical, false);
});

test("Tune versions the working lesson and preserves its owner-private boundary", () => {
  const tuned = applyClarityLessonAction(fixture, "tune", {
    actor: "fixture-owner",
    at,
    reason: "This phrasing is easier to follow.",
    preferredWording: "pass the needed tool into this part",
    guidance: "Explain the ordinary idea first, then name the technical term only if it helps the decision.",
  });
  const action = tuned.audit.actions.at(-1);
  assert.equal(tuned.status, "working");
  assert.equal(tuned.working_lesson.version, 2);
  assert.equal(tuned.working_lesson.preferred_wording, "pass the needed tool into this part");
  assert.equal(tuned.access.visibility, "owner_private");
  assert.equal(tuned.effects.writes_canonical_memory, false);
  assert.equal(action.action, "tune");
  assert.equal(action.before.working_lesson.version, 1);
  assert.equal(action.after.working_lesson.version, 2);
});

test("Undo suppresses and clears the future wording lesson without erasing the explanation", () => {
  const undone = applyClarityLessonAction(fixture, "undo", {
    actor: "fixture-owner",
    at,
    reason: "Do not use this as a future preference.",
  });
  assert.equal(undone.status, "undone");
  assert.equal(undone.working_lesson.active, false);
  assert.equal(undone.working_lesson.preferred_wording, null);
  assert.equal(undone.working_lesson.retrieval.mode, "suppressed");
  assert.equal(undone.immediate_result.explanation, fixture.immediate_result.explanation);
  assert.equal(guidanceForFutureReply(undone), null);
  assert.throws(() => applyClarityLessonAction(undone, "keep"), /cannot be changed/);
});

test("Keep requests review without promoting or widening the lesson", () => {
  const kept = applyClarityLessonAction(fixture, "keep", {
    actor: "fixture-owner",
    at,
    reason: "This should continue to guide software explanations.",
  });
  assert.equal(kept.status, "approved_for_review");
  assert.deepEqual(kept.working_lesson.scope, ["owner_private", "topic:software"]);
  assert.equal(kept.working_lesson.retrieval.mode, "provisional");
  assert.equal(kept.effects.writes_canonical_memory, false);
  assert.match(kept.owner_notice.text, /promotion review/);
});
