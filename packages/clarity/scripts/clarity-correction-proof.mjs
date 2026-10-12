#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyClarityLessonAction,
  guidanceForFutureReply,
  summarizeClarityCorrection,
  validateClarityCorrection,
} from "../src/clarity-correction.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, "fixtures/clarity-correction.example.json"), "utf8"),
);

validateClarityCorrection(fixture);

const at = "2026-08-06T12:05:00.000Z";
const tuned = applyClarityLessonAction(fixture, "tune", {
  actor: "fixture-owner",
  at,
  reason: "Use the version that was easiest to follow.",
  preferredWording: "pass the needed tool into this part",
  guidance: "Explain the ordinary idea first. Name the technical term afterward only when it helps the user decide.",
});
const undone = applyClarityLessonAction(fixture, "undo", {
  actor: "fixture-owner",
  at,
  reason: "Do not use this as a future preference.",
});
const kept = applyClarityLessonAction(fixture, "keep", {
  actor: "fixture-owner",
  at,
  reason: "Prepare this working lesson for review.",
});

console.log("TrueConvo Desktop clarity correction proof");
console.log("");
console.log("Selected agent text:");
console.log(fixture.selection.selected_text);
console.log("");
console.log("Plain explanation:");
console.log(fixture.immediate_result.explanation);
console.log("");
console.log("Clear rewrite:");
console.log(fixture.immediate_result.rewrite);
console.log("");
console.log("Owner notice:");
console.log(`${fixture.owner_notice.text} [Undo] [Tune] [Keep]`);
console.log("");
console.log(JSON.stringify({
  ok: true,
  fixture: true,
  immediate: summarizeClarityCorrection(fixture),
  futureGuidance: guidanceForFutureReply(fixture),
  tuned: summarizeClarityCorrection(tuned),
  undone: summarizeClarityCorrection(undone),
  guidanceAfterUndo: guidanceForFutureReply(undone),
  kept: summarizeClarityCorrection(kept),
  boundaries: {
    desktopOnly: fixture.surface === "trueconvo_desktop",
    assistantTextOnly: fixture.selection.source_role === "assistant",
    canonicalMemoryWrite: fixture.effects.writes_canonical_memory,
    externalAction: fixture.effects.external_action,
    agentConnected: fixture.effects.agent_connected,
    sourceMessageChanged: fixture.effects.changes_source_message,
  },
}, null, 2));
