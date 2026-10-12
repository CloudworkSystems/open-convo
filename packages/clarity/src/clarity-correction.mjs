const actions = Object.freeze(["undo", "tune", "keep"]);
const statuses = new Set(["working", "approved_for_review", "undone"]);
const difficultyReasons = new Set(["unfamiliar_term", "stacked_jargon", "lost_point"]);
const technicalTermPolicies = new Set(["avoid_unless_needed", "define_if_needed"]);

function clone(value) {
  return structuredClone(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must contain at least one value`);
  }
  for (const entry of value) requireString(entry, `${label} entry`);
}

function lessonSnapshot(record) {
  return {
    status: record.status,
    working_lesson: clone(record.working_lesson),
  };
}

export function validateClarityCorrection(record) {
  if (!record || typeof record !== "object") throw new Error("clarity correction must be an object");
  if (record.schema_version !== "open-convo.clarity-correction.v1") {
    throw new Error("unsupported clarity correction schema version");
  }
  if (record.kind !== "clarity_correction") throw new Error("invalid clarity correction kind");
  if (!statuses.has(record.status)) throw new Error("invalid clarity correction status");
  if (record.surface !== "trueconvo_desktop") throw new Error("clarity proof is desktop only");
  if (record.owner_visible !== true) throw new Error("clarity correction must be owner visible");
  requireString(record.id, "id");

  if (!record.selection || record.selection.source_role !== "assistant") {
    throw new Error("Make this clear requires assistant-authored text");
  }
  requireString(record.selection.selected_text, "selection.selected_text");
  requireString(record.selection.surrounding_text, "selection.surrounding_text");
  if (!record.selection.surrounding_text.includes(record.selection.selected_text)) {
    throw new Error("selected text must appear in the surrounding text");
  }

  requireString(record.immediate_result?.explanation, "immediate_result.explanation");
  requireString(record.immediate_result?.rewrite, "immediate_result.rewrite");
  if (record.immediate_result.requires_memory_review !== false) {
    throw new Error("the immediate explanation cannot wait for memory review");
  }
  if (record.immediate_result.replaces_original !== false) {
    throw new Error("the clarity proof cannot replace the original message automatically");
  }

  const lesson = record.working_lesson;
  if (!lesson || !Number.isInteger(lesson.version) || lesson.version < 1) {
    throw new Error("working lesson version must be a positive integer");
  }
  if (lesson.destination !== "private_communication_profile") {
    throw new Error("clarity lessons must start in the private communication profile");
  }
  requireString(lesson.selected_language, "working_lesson.selected_language");
  requireString(lesson.plain_meaning, "working_lesson.plain_meaning");
  if (!difficultyReasons.has(lesson.difficulty_reason)) throw new Error("invalid difficulty reason");
  if (!technicalTermPolicies.has(lesson.technical_term_policy)) {
    throw new Error("invalid technical term policy");
  }
  if (lesson.durability !== "working") throw new Error("clarity lesson must begin as working memory");
  requireStringArray(lesson.scope, "working_lesson.scope");
  if (!lesson.scope.includes("owner_private")) throw new Error("clarity lesson must remain owner private");

  if (record.status === "undone") {
    if (lesson.active !== false || lesson.preferred_wording !== null || lesson.guidance !== null) {
      throw new Error("undone lessons must be inactive and cleared");
    }
    if (lesson.retrieval?.mode !== "suppressed") throw new Error("undone lesson retrieval must be suppressed");
  } else {
    if (lesson.active !== true) throw new Error("working lesson must be active");
    requireString(lesson.preferred_wording, "working_lesson.preferred_wording");
    requireString(lesson.guidance, "working_lesson.guidance");
    if (lesson.retrieval?.mode !== "provisional") {
      throw new Error("active clarity lesson retrieval must remain provisional");
    }
  }
  if (lesson.retrieval?.passive_promotion_allowed !== false) {
    throw new Error("clarity lesson cannot promote itself");
  }

  if (JSON.stringify(record.owner_notice?.available_actions) !== JSON.stringify(actions)) {
    throw new Error("owner notice must offer Undo, Tune, Keep in that order");
  }
  requireString(record.owner_notice?.text, "owner_notice.text");

  requireStringArray(record.provenance?.source_refs, "provenance.source_refs");
  for (const key of ["provider", "agent_id", "project_id", "session_id", "captured_at"]) {
    requireString(record.provenance[key], `provenance.${key}`);
  }
  if (!Array.isArray(record.audit?.actions) || record.audit.actions.length === 0) {
    throw new Error("clarity correction audit history is required");
  }
  if (
    record.effects?.writes_canonical_memory !== false ||
    record.effects?.external_action !== false ||
    record.effects?.agent_connected !== false ||
    record.effects?.changes_source_message !== false
  ) {
    throw new Error("clarity proof cannot write canon, act externally, connect an agent, or change source text");
  }
  if (record.access?.visibility !== "owner_private") throw new Error("clarity proof must stay owner private");
  if ("raw_audio" in record || "raw_transcript" in record) {
    throw new Error("clarity proof cannot contain raw audio or transcript data");
  }
  return record;
}

export function applyClarityLessonAction(record, action, input = {}) {
  validateClarityCorrection(record);
  if (!actions.includes(action)) throw new Error(`unsupported clarity action: ${action}`);
  if (record.status === "undone") throw new Error("an undone clarity lesson cannot be changed");

  const next = clone(record);
  const actor = input.actor ?? record.access.owner_id;
  const at = input.at ?? new Date().toISOString();
  const reason = input.reason ?? "";
  const before = lessonSnapshot(record);

  if (action === "undo") {
    next.status = "undone";
    next.working_lesson = {
      ...next.working_lesson,
      version: next.working_lesson.version + 1,
      active: false,
      preferred_wording: null,
      guidance: null,
      retrieval: { mode: "suppressed", passive_promotion_allowed: false },
    };
    next.owner_notice.text = "Working wording lesson undone.";
  }

  if (action === "tune") {
    requireString(input.preferredWording, "preferred wording");
    next.status = "working";
    next.working_lesson = {
      ...next.working_lesson,
      version: next.working_lesson.version + 1,
      preferred_wording: input.preferredWording.trim(),
      guidance: input.guidance?.trim() || next.working_lesson.guidance,
      difficulty_reason: input.difficultyReason ?? next.working_lesson.difficulty_reason,
      technical_term_policy: input.technicalTermPolicy ?? next.working_lesson.technical_term_policy,
      scope: input.scope ?? next.working_lesson.scope,
    };
    next.owner_notice.text = "Working wording lesson tuned.";
  }

  if (action === "keep") {
    next.status = "approved_for_review";
    next.owner_notice.text = "Working wording lesson prepared for promotion review.";
  }

  next.audit.updated_at = at;
  next.audit.actions.push({
    action,
    actor,
    at,
    reason,
    before,
    after: lessonSnapshot(next),
  });
  return validateClarityCorrection(next);
}

export function guidanceForFutureReply(record) {
  validateClarityCorrection(record);
  if (!record.working_lesson.active || record.status === "undone") return null;
  return {
    source: "owner_triggered_working_lesson",
    selectedLanguage: record.working_lesson.selected_language,
    preferredWording: record.working_lesson.preferred_wording,
    technicalTermPolicy: record.working_lesson.technical_term_policy,
    difficultyReason: record.working_lesson.difficulty_reason,
    guidance: record.working_lesson.guidance,
    scope: clone(record.working_lesson.scope),
    canonical: false,
  };
}

export function summarizeClarityCorrection(record) {
  validateClarityCorrection(record);
  return {
    id: record.id,
    status: record.status,
    selectedText: record.selection.selected_text,
    explanation: record.immediate_result.explanation,
    rewrite: record.immediate_result.rewrite,
    lessonVersion: record.working_lesson.version,
    lessonActive: record.working_lesson.active,
    preferredWording: record.working_lesson.preferred_wording,
    retrieval: record.working_lesson.retrieval.mode,
    canonicalWrite: record.effects.writes_canonical_memory,
    sourceMessageChanged: record.effects.changes_source_message,
    lastAction: record.audit.actions.at(-1).action,
  };
}
