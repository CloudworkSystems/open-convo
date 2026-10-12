import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelCompleteRequest,
  explainClarity,
  parseModelExplanation,
  validateClarityExplainRequest,
} from "../src/clarity-explanation.mjs";

const request = {
  schema_version: "open-convo.clarity-explain.v1",
  surface: "trueconvo_desktop",
  source_role: "assistant",
  selected_text: "portable capability broker",
  surrounding_text: "The missing layer is a portable capability broker that lets TrueConvo change model providers.",
  session_id: "session-local-proof",
  message_id: "assistant-message-001",
};

test("clarity.explain sends only the selected assistant context through local model.complete", async () => {
  let captured;
  const result = await explainClarity(request, {
    ownerId: "proof-owner",
    now: () => "2026-08-06T12:30:00.000Z",
    idFactory: () => "proof-id",
    modelComplete: async (input) => {
      captured = input;
      return {
        capability_id: "model.complete",
        contract_version: "0.1",
        state: "returned_unverified",
        adapter: { adapter_id: "fake-local-model", execution_id: "fake-1" },
        result: {
          content: JSON.stringify({
            explanation: "It is one doorway that chooses which available tool should handle a request.",
            rewrite: "TrueConvo needs one doorway that can choose a model without tying the product to that model.",
          }),
          model: "ollama/fake-local",
          local_only: true,
        },
      };
    },
  });

  assert.equal(captured.capability_id, "model.complete");
  assert.equal(captured.purpose, "open-convo.clarity-explain.v1");
  assert.equal(captured.constraints.data_boundary, "local_private");
  assert.equal(captured.constraints.external_allowed, false);
  assert.equal(captured.input.messages.length, 2);
  assert.doesNotMatch(JSON.stringify(captured), /proof-owner|raw_audio|raw_transcript/);
  assert.equal(result.record.id, "clarity-correction-proof-id");
  assert.equal(result.record.working_lesson.durability, "working");
  assert.equal(result.record.effects.writes_canonical_memory, false);
  assert.equal(result.record.effects.changes_source_message, false);
  assert.equal(result.record.access.visibility, "owner_private");
  assert.equal(result.route.local_only, true);
  assert.equal(result.boundaries.sent_full_conversation, false);
});

test("clarity.explain rejects phone, user-authored, mismatched, and transcript requests", () => {
  assert.throws(() => validateClarityExplainRequest({ ...request, surface: "trueconvo_ios" }), /desktop only/);
  assert.throws(() => validateClarityExplainRequest({ ...request, source_role: "user" }), /assistant-authored/);
  assert.throws(() => validateClarityExplainRequest({ ...request, selected_text: "not present" }), /must appear/);
  assert.throws(() => validateClarityExplainRequest({ ...request, raw_transcript: "private" }), /raw audio or transcript/);
});

test("model.complete request keeps provider choice out of the product contract", () => {
  const modelRequest = buildModelCompleteRequest(request);
  assert.equal(modelRequest.capability_id, "model.complete");
  assert.equal("model" in modelRequest, false);
  assert.equal("provider" in modelRequest, false);
  assert.deepEqual(Object.keys(JSON.parse(modelRequest.input.messages[1].content)).sort(), [
    "selected_text",
    "surrounding_text",
  ]);
});

test("model explanation parser accepts a fenced object but rejects extra authority fields", () => {
  assert.deepEqual(
    parseModelExplanation("```json\n{\"explanation\":\"Plain meaning.\",\"rewrite\":\"Clear version.\"}\n```"),
    { explanation: "Plain meaning.", rewrite: "Clear version." },
  );
  assert.throws(
    () => parseModelExplanation(JSON.stringify({ explanation: "Plain.", rewrite: "Clear.", remember: true })),
    /only explanation and rewrite/,
  );
});

test("clarity.explain refuses a model return that is not confirmed local-only", async () => {
  await assert.rejects(
    () => explainClarity(request, {
      modelComplete: async () => ({
        capability_id: "model.complete",
        state: "returned_unverified",
        adapter: { adapter_id: "cloud" },
        result: { content: "{}", model: "cloud/model", local_only: false },
      }),
    }),
    /local-only/,
  );
});
