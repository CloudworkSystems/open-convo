import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyCommunicationPreferenceAction,
  guidanceForCommunicationPreference,
  rememberHowISpeak,
  rememberPreferredTerm,
  selectRelevantCommunicationPreferences,
  validateCommunicationPreference,
} from "../src/communication-preference.mjs";
import { createCommunicationPreferenceProofStore } from "../src/communication-preference-store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const clarityFixture = JSON.parse(fs.readFileSync(path.join(HERE, "../fixtures/clarity-correction.example.json"), "utf8"));
const waitFixture = JSON.parse(fs.readFileSync(path.join(HERE, "../fixtures/wait-what.example.json"), "utf8"));
const rememberedAt = "2026-08-06T15:00:00.000Z";

function rememberClarity(overrides = {}) {
  return rememberHowISpeak(structuredClone(clarityFixture), {
    signal: "remember_how_i_speak",
    ownerId: "fixture-owner",
    at: rememberedAt,
    ...overrides,
  }, { idFactory: () => "fixture-clarity-preference" });
}

test("Remember how I speak creates one explicit owner-private durable preference", () => {
  const record = rememberClarity();
  const guidance = guidanceForCommunicationPreference(record);

  assert.equal(record.status, "active");
  assert.equal(record.preference.category, "terminology");
  assert.equal(record.preference.trigger, "dependency injection");
  assert.equal(record.preference.durability, "core");
  assert.deepEqual(record.owner_notice.available_actions, ["undo", "tune"]);
  assert.equal(record.effects.writes_owner_private_preference, true);
  assert.equal(record.effects.writes_canonical_shared_memory, false);
  assert.equal(guidance.durable, true);
  assert.equal(guidance.ownerPrivate, true);
  assert.equal(guidance.shared, false);
});

test("Remember how I speak requires the explicit signal and cannot broaden scope", () => {
  assert.throws(
    () => rememberHowISpeak(clarityFixture, { ownerId: "fixture-owner" }),
    /explicit button or command/,
  );
  const broadened = rememberClarity();
  broadened.preference.scope.push("shared");
  assert.throws(() => validateCommunicationPreference(broadened), /cannot broaden/);
  assert.throws(
    () => validateCommunicationPreference({ ...rememberClarity(), full_conversation: ["private"] }),
    /cannot contain raw conversation/,
  );
});

test("Remember how I speak can save the shown explanation style after Wait—what?", () => {
  const record = rememberHowISpeak(structuredClone(waitFixture), {
    signal: "remember_how_i_speak",
    ownerId: "fixture-owner",
    at: rememberedAt,
  }, { idFactory: () => "fixture-wait-preference" });

  assert.equal(record.preference.category, "explanation_structure");
  assert.equal(record.preference.trigger, "whole_explanation");
  assert.match(record.preference.statement, /main point/);
  assert.equal(record.preference.preferred_wording, null);
  assert.doesNotMatch(JSON.stringify(record), /We'll place the capability/);
});

test("selected TCA wording can become an exact preferred term or spelling without storing its paragraph", () => {
  const record = rememberPreferredTerm({
    schema_version: "open-convo.preferred-term.v1",
    signal: "remember_preferred_term",
    surface: "trueconvo_desktop",
    source_role: "assistant",
    selected_text: "portable capability broker",
    preferred_wording: "capability doorway",
    session_id: "fixture-session",
    message_id: "fixture-message",
    ownerId: "fixture-owner",
    at: rememberedAt,
  }, { idFactory: () => "fixture-preferred-term" });

  assert.equal(record.preference.category, "terminology");
  assert.equal(record.preference.trigger, "portable capability broker");
  assert.equal(record.preference.preferred_wording, "capability doorway");
  assert.equal(record.approval.signal, "remember_preferred_term");
  assert.equal(record.provenance.source_action, "remember_preferred_term");
  assert.doesNotMatch(JSON.stringify(record), /surrounding_text|assistant_text|full_conversation/);

  assert.throws(
    () => rememberPreferredTerm({
      schema_version: "open-convo.preferred-term.v1",
      signal: "remember_preferred_term",
      surface: "trueconvo_desktop",
      source_role: "assistant",
      selected_text: "TCA",
      preferred_wording: "TCA",
      session_id: "fixture-session",
      message_id: "fixture-message",
      ownerId: "fixture-owner",
    }),
    /must differ/i,
  );
  assert.throws(
    () => rememberPreferredTerm({
      schema_version: "open-convo.preferred-term.v1",
      signal: "remember_preferred_term",
      surface: "trueconvo_desktop",
      source_role: "assistant",
      selected_text: "TCA",
      preferred_wording: "TrueConvo",
      surrounding_text: "TCA should keep the relationship.",
      session_id: "fixture-session",
      message_id: "fixture-message",
      ownerId: "fixture-owner",
    }),
    /accepts only the selected term/i,
  );
});

test("preference retrieval uses exact terms or a server-derived topic and leaves unrelated prompts alone", () => {
  const terminology = rememberPreferredTerm({
    schema_version: "open-convo.preferred-term.v1",
    signal: "remember_preferred_term",
    surface: "trueconvo_desktop",
    source_role: "assistant",
    selected_text: "portable capability broker",
    preferred_wording: "capability doorway",
    session_id: "fixture-session",
    message_id: "fixture-message",
    ownerId: "fixture-owner",
    at: rememberedAt,
  }, { idFactory: () => "fixture-preferred-term" });
  const structure = rememberHowISpeak(structuredClone(waitFixture), {
    signal: "remember_how_i_speak",
    ownerId: "fixture-owner",
    at: rememberedAt,
  }, { idFactory: () => "fixture-explanation-structure" });

  const exact = selectRelevantCommunicationPreferences([terminology, structure], {
    prompt: "What does the portable capability broker do?",
  });
  assert.deepEqual(exact.map((match) => match.matchReason), ["exact_term_match"]);
  assert.equal(exact[0].preferredWording, "capability doorway");

  const scoped = selectRelevantCommunicationPreferences([terminology, structure], {
    prompt: "Can you explain that again?",
    topicScopes: ["topic:technical_explanations"],
  });
  assert.deepEqual(scoped.map((match) => match.matchReason), ["server_topic_scope_match"]);

  assert.deepEqual(selectRelevantCommunicationPreferences([terminology, structure], {
    prompt: "What should I do this afternoon?",
  }), []);
  assert.deepEqual(selectRelevantCommunicationPreferences([terminology], {
    prompt: "What does portable capability brokerage mean?",
  }), []);
});

test("Tune versions the preference without widening it; later Tune is recorded as a correction", () => {
  const tuned = applyCommunicationPreferenceAction(rememberClarity(), "tune", {
    actor: "fixture-owner",
    at: "2026-08-06T15:05:00.000Z",
    statement: "Explain the ordinary idea first. Use the technical name only if it helps.",
    preferredWording: "give this part the tool it needs",
  });
  assert.equal(tuned.preference.version, 2);
  assert.deepEqual(tuned.preference.scope, clarityFixture.working_lesson.scope);
  assert.equal(tuned.audit.actions.at(-1).change_kind, "within_undo_window");

  const correctedLater = applyCommunicationPreferenceAction(rememberClarity(), "tune", {
    actor: "fixture-owner",
    at: "2026-08-07T16:00:00.000Z",
    statement: "Say the ordinary idea first, every time.",
    preferredWording: "give this part the tool it needs",
  });
  assert.equal(correctedLater.audit.actions.at(-1).change_kind, "correction");
});

test("Undo works for 24 hours and immediately suppresses future use", () => {
  const undone = applyCommunicationPreferenceAction(rememberClarity(), "undo", {
    actor: "fixture-owner",
    at: "2026-08-07T14:59:59.000Z",
    reason: "Do not keep this preference.",
  });
  assert.equal(undone.status, "undone");
  assert.equal(undone.preference.active, false);
  assert.equal(undone.preference.retrieval.mode, "suppressed");
  assert.equal(guidanceForCommunicationPreference(undone), null);

  assert.throws(
    () => applyCommunicationPreferenceAction(rememberClarity(), "undo", {
      at: "2026-08-07T15:00:00.001Z",
    }),
    /Undo expired/,
  );
});

test("proof store persists the narrow preference across reopen, then saves Tune and Undo", (t) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "open-convo-preference-proof-"));
  t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
  const filePath = path.join(tempDirectory, "preferences.json");
  const original = rememberClarity();
  const firstStore = createCommunicationPreferenceProofStore({ filePath, proofOnly: true });
  const created = firstStore.create(original);

  assert.equal(created.persistent, true);
  assert.equal(created.production_ready, false);
  const reopened = createCommunicationPreferenceProofStore({ filePath, proofOnly: true });
  assert.equal(reopened.read(original.id).preference.version, 1);
  assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), /We'll add dependency injection/);

  const tuned = applyCommunicationPreferenceAction(original, "tune", {
    at: "2026-08-06T15:10:00.000Z",
    statement: "Use ordinary wording first. Define the technical term only if it is needed.",
    preferredWording: "give this part the tool it needs",
  });
  reopened.replace(tuned, { expectedVersion: 1 });
  assert.equal(reopened.read(original.id).preference.version, 2);
  assert.throws(() => reopened.replace(tuned, { expectedVersion: 1 }), /changed since it was read/);

  const undone = applyCommunicationPreferenceAction(tuned, "undo", {
    at: "2026-08-06T15:15:00.000Z",
  });
  reopened.replace(undone, { expectedVersion: 2 });
  assert.equal(createCommunicationPreferenceProofStore({ filePath, proofOnly: true }).read(original.id).status, "undone");
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("file store cannot be used without its explicit proof-only boundary", () => {
  assert.throws(
    () => createCommunicationPreferenceProofStore({ filePath: "/tmp/not-created.json" }),
    /proof-only/,
  );
});
