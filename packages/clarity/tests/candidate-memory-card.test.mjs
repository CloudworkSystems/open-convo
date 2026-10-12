import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyCandidateMemoryAction,
  validateCandidateMemoryCard,
} from "../src/candidate-memory-card.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, "fixtures/candidate-memory-card.example.json"), "utf8"),
);
const at = "2026-07-11T16:30:00.000Z";

test("candidate fixture is owner-visible and non-canonical", () => {
  validateCandidateMemoryCard(fixture);
  assert.deepEqual(fixture.owner_controls.available_actions, ["keep", "correct", "forget", "park"]);
  assert.equal(fixture.effects.writes_canonical_memory, false);
  assert.equal(fixture.effects.agent_connected, false);
});

test("Keep requests promotion without writing canonical memory", () => {
  const next = applyCandidateMemoryAction(fixture, "keep", { actor: "owner", at, reason: "Correct." });
  assert.equal(next.status, "approved_for_promotion");
  assert.equal(next.effects.writes_canonical_memory, false);
  assert.equal(next.audit.actions.at(-1).action, "keep");
});

test("Correct versions the candidate and records before and after", () => {
  const next = applyCandidateMemoryAction(fixture, "correct", {
    actor: "owner",
    at,
    reason: "Clarify TCA ownership.",
    text: "TCA owns promotion; imported runtimes provide evidence only.",
    durability: "core",
  });
  const action = next.audit.actions.at(-1);
  assert.equal(next.status, "candidate");
  assert.equal(next.memory.version, 2);
  assert.equal(next.memory.durability, "core");
  assert.equal(action.before.memory.version, 1);
  assert.equal(action.after.memory.version, 2);
});

test("Forget tombstones content and suppresses retrieval", () => {
  const next = applyCandidateMemoryAction(fixture, "forget", {
    actor: "owner",
    at,
    reason: "Reject this candidate.",
  });
  assert.equal(next.status, "forgotten");
  assert.equal(next.memory.text, null);
  assert.equal(next.retrieval.mode, "suppressed");
  assert.throws(() => applyCandidateMemoryAction(next, "keep"), /cannot be changed/);
});

test("Park suppresses retrieval and disables passive promotion", () => {
  const parked = applyCandidateMemoryAction(fixture, "park", {
    actor: "owner",
    at,
    reason: "Not now.",
  });
  assert.equal(parked.status, "parked");
  assert.equal(parked.retrieval.mode, "suppressed");
  assert.equal(parked.retrieval.passive_promotion_allowed, false);

  const kept = applyCandidateMemoryAction(parked, "keep", {
    actor: "owner",
    at: "2026-07-11T16:31:00.000Z",
    reason: "Ready now.",
  });
  assert.equal(kept.status, "approved_for_promotion");
});
