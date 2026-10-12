import assert from "node:assert/strict";
import test from "node:test";

import {
  rememberPreferredTerm,
  selectRelevantCommunicationPreferences,
} from "../src/communication-preference.mjs";
import {
  buildPreferenceAwareModelRequest,
  replyWithCommunicationPreferences,
  validatePreferenceAwareReplyRequest,
} from "../src/preference-aware-reply.mjs";

const request = {
  schema_version: "open-convo.preference-aware-reply.v1",
  surface: "trueconvo_desktop",
  prompt: "What does a portable capability broker do?",
};

function matches() {
  const preference = rememberPreferredTerm({
    schema_version: "open-convo.preferred-term.v1",
    signal: "remember_preferred_term",
    surface: "trueconvo_desktop",
    source_role: "assistant",
    selected_text: "portable capability broker",
    preferred_wording: "capability doorway",
    session_id: "fixture-session",
    message_id: "fixture-message",
    ownerId: "fixture-owner",
    at: "2026-08-06T18:00:00.000Z",
  }, { idFactory: () => "fixture-preference" });
  return selectRelevantCommunicationPreferences([preference], { prompt: request.prompt });
}

test("preference-aware Session reply sends only a narrow matched preference to the local model", async () => {
  let observed;
  const result = await replyWithCommunicationPreferences(request, {
    preferenceMatches: matches(),
    evaluatedCount: 1,
    modelComplete: async (modelRequest) => {
      observed = modelRequest;
      return {
        capability_id: "model.complete",
        adapter: { adapter_id: "fixture-local" },
        state: "verified",
        result: {
          model: "ollama/fixture",
          content: "A capability doorway picks the available tool for the job.",
          local_only: true,
        },
      };
    },
  });

  assert.match(observed.input.messages[0].content, /capability doorway/);
  assert.doesNotMatch(observed.input.messages[0].content, /audit|provenance|undo_available_until/);
  assert.equal(result.preference_receipt.visible, true);
  assert.equal(result.preference_receipt.applied_count, 1);
  assert.equal(result.preference_receipt.applied[0].match_reason, "exact_term_match");
  assert.equal(result.preference_receipt.applied[0].preferred_wording, "capability doorway");
  assert.equal(result.boundaries.browser_supplied_memory, false);
  assert.equal(result.boundaries.cross_device_sync, false);
});

test("preference-aware Session reply exposes an honest empty receipt when nothing matched", () => {
  const modelRequest = buildPreferenceAwareModelRequest({
    ...request,
    prompt: "What should I do this afternoon?",
  }, []);
  assert.match(modelRequest.input.messages[0].content, /Matched owner preferences: \[\]/);
});

test("browser requests cannot supply preferences, conversation history, or nonlocal model results", async () => {
  assert.throws(
    () => validatePreferenceAwareReplyRequest({ ...request, preferences: [{ forged: true }] }),
    /cannot supply memory records/i,
  );
  assert.throws(
    () => validatePreferenceAwareReplyRequest({ ...request, full_conversation: ["private"] }),
    /cannot supply memory records/i,
  );
  await assert.rejects(
    replyWithCommunicationPreferences(request, {
      preferenceMatches: matches(),
      evaluatedCount: 1,
      modelComplete: async () => ({
        capability_id: "model.complete",
        adapter: { adapter_id: "bad-route" },
        state: "verified",
        result: { model: "cloud/model", content: "No.", local_only: false },
      }),
    }),
    /confirmed local-only/i,
  );
});
