import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyClarityLessonAction } from "../src/clarity-correction.mjs";
import {
  buildClarityFollowUpModelRequest,
  replyWithClarityLesson,
} from "../src/clarity-follow-up.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, "../fixtures/clarity-correction.example.json"), "utf8"));

function localReturn(content) {
  return {
    capability_id: "model.complete",
    contract_version: "0.1",
    state: "returned_unverified",
    adapter: { adapter_id: "fake-local-model", execution_id: "follow-up-proof" },
    result: { content, model: "ollama/fake-local", local_only: true },
  };
}

test("active Wong lesson changes the next model request and remains temporary", async () => {
  let observed;
  const result = await replyWithClarityLesson({
    schema_version: "open-convo.clarity-follow-up.v1",
    surface: "trueconvo_desktop",
    prompt: "How will this part get the tool it needs?",
    record: structuredClone(fixture),
  }, {
    modelComplete: async (request) => {
      observed = request;
      return localReturn("We give this part the tool it needs when it starts.");
    },
  });

  assert.match(observed.input.messages[0].content, /"temporary_lesson_active":true/);
  assert.match(observed.input.messages[0].content, /give this part the tool it needs/);
  assert.equal(result.lesson.applied, true);
  assert.equal(result.boundaries.persisted_working_lesson, false);
  assert.equal(result.boundaries.writes_canonical_memory, false);
});

test("Undo removes the Wong guidance from a later model request", async () => {
  const undone = applyClarityLessonAction(structuredClone(fixture), "undo", {
    actor: "fixture-owner",
    at: "2026-08-06T13:00:00.000Z",
  });
  const request = buildClarityFollowUpModelRequest({
    schema_version: "open-convo.clarity-follow-up.v1",
    surface: "trueconvo_desktop",
    prompt: "How does the runtime adapter receive its dependencies?",
    record: undone,
  });

  assert.match(request.input.messages[0].content, /"temporary_lesson_active":false/);
  assert.doesNotMatch(request.input.messages[0].content, /preferred_wording/);
  assert.doesNotMatch(request.input.messages[0].content, /give this part the tool it needs/);
});

test("undone lesson is reported as suppressed and not applied", async () => {
  const undone = applyClarityLessonAction(structuredClone(fixture), "undo");
  const result = await replyWithClarityLesson({
    schema_version: "open-convo.clarity-follow-up.v1",
    surface: "trueconvo_desktop",
    prompt: "What pattern is being used?",
    record: undone,
  }, { modelComplete: async () => localReturn("The code uses dependency injection.") });

  assert.equal(result.lesson.applied, false);
  assert.equal(result.lesson.retrieval, "suppressed");
  assert.equal(result.lesson.canonical, false);
});

test("clarity follow-up rejects phone, full conversation, and nonlocal model returns", async () => {
  const base = {
    schema_version: "open-convo.clarity-follow-up.v1",
    surface: "trueconvo_desktop",
    prompt: "Explain the pattern.",
    record: structuredClone(fixture),
  };
  assert.throws(() => buildClarityFollowUpModelRequest({ ...base, surface: "trueconvo_ios" }), /desktop only/);
  assert.throws(() => buildClarityFollowUpModelRequest({ ...base, full_conversation: [] }), /full-conversation/);
  await assert.rejects(
    () => replyWithClarityLesson(base, {
      modelComplete: async () => ({ ...localReturn("Cloud answer"), result: { content: "Cloud answer", model: "cloud", local_only: false } }),
    }),
    /confirmed local-only/,
  );
});
