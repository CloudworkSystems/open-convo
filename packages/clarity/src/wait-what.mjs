const surfaces = new Set(["trueconvo_ios", "trueconvo_widget", "trueconvo_desktop"]);
const ownerActions = Object.freeze(["repeat", "remember_how_i_speak"]);

function clone(value) {
  return structuredClone(value);
}

function requireText(value, label, maxLength = 12_000) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds the ${maxLength}-character proof limit`);
  }
  return normalized;
}

function repairSnapshot(record) {
  return {
    attempt: record.request.attempt,
    repair: clone(record.repair),
  };
}

export function validateWaitWhatRepair(record) {
  if (!record || typeof record !== "object") throw new Error("Wait—what? repair must be an object");
  if (record.schema_version !== "open-convo.wait-what.v1") {
    throw new Error("unsupported Wait—what? schema version");
  }
  if (record.kind !== "wait_what_repair" || record.status !== "repaired") {
    throw new Error("invalid Wait—what? repair identity or status");
  }
  if (!surfaces.has(record.surface)) throw new Error("Wait—what? requires a TrueConvo surface");
  if (record.owner_visible !== true) throw new Error("Wait—what? repair must be owner visible");
  requireText(record.id, "id", 300);

  if (record.target?.source_role !== "assistant") {
    throw new Error("Wait—what? repairs assistant-authored text only");
  }
  if (record.target?.latest_assistant_message !== true) {
    throw new Error("Wait—what? must target the latest assistant message");
  }
  requireText(record.target?.message_id, "target.message_id", 300);
  requireText(record.target?.assistant_text, "target.assistant_text");

  if (record.request?.phrase !== "Wait—what?") throw new Error("invalid Wait—what? request phrase");
  if (!Number.isInteger(record.request?.attempt) || record.request.attempt < 1) {
    throw new Error("Wait—what? attempt must be a positive integer");
  }

  const repair = record.repair;
  if (!repair || repair.version !== record.request.attempt) {
    throw new Error("Wait—what? repair version must match its attempt");
  }
  requireText(repair.main_point, "repair.main_point", 2_000);
  requireText(repair.missing_premise, "repair.missing_premise", 2_000);
  requireText(repair.repitch, "repair.repitch", 4_000);
  requireText(repair.wording_treatment, "repair.wording_treatment", 2_000);
  if (record.request.attempt === 1) {
    if (repair.strategy !== "main_point_with_missing_premise") {
      throw new Error("first Wait—what? repair must lead with the main point and missing premise");
    }
    if (repair.concrete_example !== null) {
      throw new Error("first Wait—what? repair leaves the example for a repeated request");
    }
  } else {
    if (repair.strategy !== "step_back_with_example") {
      throw new Error("repeated Wait—what? repair must step back with an example");
    }
    requireText(repair.concrete_example, "repair.concrete_example", 2_000);
  }

  if (JSON.stringify(record.owner_notice?.available_actions) !== JSON.stringify(ownerActions)) {
    throw new Error("Wait—what? notice must offer Repeat and Remember how I speak");
  }
  requireText(record.owner_notice?.text, "owner_notice.text", 500);

  if (
    record.memory?.working_lesson_created !== false
    || record.memory?.durable_preference_written !== false
    || record.memory?.passive_promotion_allowed !== false
  ) {
    throw new Error("Wait—what? cannot create or promote memory by itself");
  }
  if (
    record.effects?.external_action !== false
    || record.effects?.command_approved !== false
    || record.effects?.changes_source_message !== false
  ) {
    throw new Error("Wait—what? cannot act, approve a command, or change the source message");
  }
  if (record.access?.visibility !== "owner_private") {
    throw new Error("Wait—what? proof must remain owner private");
  }
  requireText(record.access?.owner_id, "access.owner_id", 300);
  requireText(record.provenance?.source_ref, "provenance.source_ref", 1_000);
  requireText(record.provenance?.captured_at, "provenance.captured_at", 100);
  if (!Array.isArray(record.audit?.actions) || record.audit.actions.length === 0) {
    throw new Error("Wait—what? audit history is required");
  }
  if (
    "selection" in record
    || "raw_audio" in record
    || "raw_transcript" in record
    || "full_conversation" in record
  ) {
    throw new Error("Wait—what? cannot carry a selection, raw audio, transcript, or full conversation");
  }
  return record;
}

export function repeatWaitWhatRepair(record, input = {}) {
  validateWaitWhatRepair(record);
  const next = clone(record);
  const at = input.at ?? new Date().toISOString();
  const before = repairSnapshot(record);
  const repitch = requireText(input.repitch, "repitch", 4_000);
  if (repitch === record.repair.repitch) {
    throw new Error("repeated Wait—what? must not return the same explanation");
  }

  next.request.attempt += 1;
  next.repair = {
    version: next.request.attempt,
    strategy: "step_back_with_example",
    main_point: requireText(input.mainPoint, "mainPoint", 2_000),
    missing_premise: requireText(input.missingPremise, "missingPremise", 2_000),
    repitch,
    concrete_example: requireText(input.concreteExample, "concreteExample", 2_000),
    wording_treatment: input.wordingTreatment
      ? requireText(input.wordingTreatment, "wordingTreatment", 2_000)
      : record.repair.wording_treatment,
  };
  next.owner_notice.text = "Stepped back farther and added a concrete example. Nothing was remembered yet.";
  next.audit.updated_at = at;
  next.audit.actions.push({
    action: "repeat",
    actor: input.actor ?? record.access.owner_id,
    at,
    reason: input.reason ?? "The first re-pitch did not land.",
    before,
    after: repairSnapshot(next),
  });
  return validateWaitWhatRepair(next);
}

export function summarizeWaitWhatRepair(record) {
  validateWaitWhatRepair(record);
  return {
    id: record.id,
    surface: record.surface,
    attempt: record.request.attempt,
    strategy: record.repair.strategy,
    mainPoint: record.repair.main_point,
    repitch: record.repair.repitch,
    concreteExample: record.repair.concrete_example,
    workingLessonCreated: record.memory.working_lesson_created,
    durablePreferenceWritten: record.memory.durable_preference_written,
    commandApproved: record.effects.command_approved,
  };
}
