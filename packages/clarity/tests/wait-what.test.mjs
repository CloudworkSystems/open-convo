import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  repeatWaitWhatRepair,
  summarizeWaitWhatRepair,
  validateWaitWhatRepair,
} from "../src/wait-what.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, "../fixtures/wait-what.example.json"), "utf8"));

test("Wait—what? works on all three TrueConvo surfaces without selection or memory", () => {
  for (const surface of ["trueconvo_ios", "trueconvo_widget", "trueconvo_desktop"]) {
    const record = { ...structuredClone(fixture), surface };
    validateWaitWhatRepair(record);
    assert.equal(record.target.latest_assistant_message, true);
    assert.equal(record.memory.working_lesson_created, false);
    assert.equal(record.memory.durable_preference_written, false);
    assert.equal(record.effects.command_approved, false);
    assert.equal("selection" in record, false);
  }
});

test("Wait—what? rejects user text, older messages, selections, transcripts, or memory writes", () => {
  const userText = structuredClone(fixture);
  userText.target.source_role = "user";
  assert.throws(() => validateWaitWhatRepair(userText), /assistant-authored/);

  const olderMessage = structuredClone(fixture);
  olderMessage.target.latest_assistant_message = false;
  assert.throws(() => validateWaitWhatRepair(olderMessage), /latest assistant message/);

  assert.throws(
    () => validateWaitWhatRepair({ ...structuredClone(fixture), selection: { selected_text: "adapter" } }),
    /cannot carry a selection/,
  );
  assert.throws(
    () => validateWaitWhatRepair({ ...structuredClone(fixture), raw_transcript: "private words" }),
    /raw audio, transcript, or full conversation/,
  );
  const memoryWrite = structuredClone(fixture);
  memoryWrite.memory.durable_preference_written = true;
  assert.throws(() => validateWaitWhatRepair(memoryWrite), /cannot create or promote memory/);
});

test("a repeated Wait—what? steps back farther, changes the wording, and adds an example", () => {
  const repeated = repeatWaitWhatRepair(fixture, {
    actor: "fixture-owner",
    at: "2026-08-06T14:01:00.000Z",
    mainPoint: "TrueConvo should not be trapped by one tool.",
    missingPremise: "The tool doing a job today may not be the best tool tomorrow.",
    repitch: "TrueConvo asks for the result it needs. Another small part chooses which tool can deliver that result today.",
    concreteExample: "It is like asking for a ride without promising that every ride must use the same car forever.",
  });
  const summary = summarizeWaitWhatRepair(repeated);

  assert.equal(summary.attempt, 2);
  assert.equal(summary.strategy, "step_back_with_example");
  assert.match(summary.concreteExample, /same car/);
  assert.notEqual(summary.repitch, fixture.repair.repitch);
  assert.equal(summary.durablePreferenceWritten, false);
  assert.equal(repeated.audit.actions.at(-1).action, "repeat");
});

test("a repeated Wait—what? cannot merely return the same answer or omit the example", () => {
  const base = {
    mainPoint: "The main point.",
    missingPremise: "The missing setup.",
    repitch: fixture.repair.repitch,
    concreteExample: "A concrete example.",
  };
  assert.throws(() => repeatWaitWhatRepair(fixture, base), /must not return the same explanation/);
  assert.throws(
    () => repeatWaitWhatRepair(fixture, { ...base, repitch: "A different explanation.", concreteExample: "" }),
    /concreteExample must be a non-empty string/,
  );
});
