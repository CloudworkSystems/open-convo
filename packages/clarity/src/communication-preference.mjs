import crypto from "node:crypto";

import { validateClarityCorrection } from "./clarity-correction.mjs";
import { validateWaitWhatRepair } from "./wait-what.mjs";

const ownerActions = Object.freeze(["undo", "tune"]);
const categories = new Set(["terminology", "explanation_structure"]);
const statuses = new Set(["active", "undone"]);
const approvalSignals = new Set(["remember_how_i_speak", "remember_preferred_term"]);
const UNDO_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_PREFERRED_TERM_LENGTH = 200;

function clone(value) {
  return structuredClone(value);
}

function requireText(value, label, maxLength = 4_000) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds the ${maxLength}-character proof limit`);
  }
  return normalized;
}

function preferenceSnapshot(record) {
  return {
    status: record.status,
    preference: clone(record.preference),
  };
}

function sourceTreatment(record) {
  if (record?.schema_version === "open-convo.clarity-correction.v1") {
    const source = validateClarityCorrection(record);
    if (source.status === "undone" || source.working_lesson.active !== true) {
      throw new Error("an inactive clarity lesson cannot become a saved preference");
    }
    return {
      action: "make_this_clear",
      category: "terminology",
      trigger: source.working_lesson.selected_language,
      statement: source.working_lesson.guidance,
      preferredWording: source.working_lesson.preferred_wording,
      scope: clone(source.working_lesson.scope),
      ownerId: source.access.owner_id,
      sourceId: source.id,
      sourceRef: source.provenance.source_refs[0],
    };
  }
  if (record?.schema_version === "open-convo.wait-what.v1") {
    const source = validateWaitWhatRepair(record);
    return {
      action: "wait_what",
      category: "explanation_structure",
      trigger: "whole_explanation",
      statement: source.repair.wording_treatment,
      preferredWording: null,
      scope: ["owner_private", "topic:technical_explanations"],
      ownerId: source.access.owner_id,
      sourceId: source.id,
      sourceRef: source.provenance.source_ref,
    };
  }
  throw new Error("Remember how I speak requires a proved clarity source");
}

export function rememberHowISpeak(sourceRecord, input = {}, {
  idFactory = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
} = {}) {
  if (input.signal !== "remember_how_i_speak") {
    throw new Error("Remember how I speak requires the owner's explicit button or command");
  }
  const source = sourceTreatment(sourceRecord);
  const ownerId = input.ownerId ?? source.ownerId;
  if (ownerId !== source.ownerId) throw new Error("saved preference owner must match the clarity source owner");
  const at = requireText(input.at ?? now(), "at", 100);
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new Error("at must be an ISO timestamp");
  const statement = input.statement
    ? requireText(input.statement, "statement")
    : source.statement;
  const preferredWording = input.preferredWording === undefined
    ? source.preferredWording
    : input.preferredWording === null
      ? null
      : requireText(input.preferredWording, "preferredWording");

  return createCommunicationPreference({
    source,
    ownerId,
    at,
    statement,
    preferredWording,
    signal: "remember_how_i_speak",
    noticeText: "Remembered for your future replies.",
    reason: input.reason ?? "The owner explicitly chose Remember how I speak.",
  }, { idFactory });
}

export function rememberPreferredTerm(input = {}, {
  idFactory = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
} = {}) {
  if (input.signal !== "remember_preferred_term") {
    throw new Error("Remember preferred term requires the owner's explicit button or command");
  }
  if (input.schema_version !== "open-convo.preferred-term.v1") {
    throw new Error("unsupported preferred-term request version");
  }
  if (input.surface !== "trueconvo_desktop" || input.source_role !== "assistant") {
    throw new Error("preferred terms must come from selected TCA reply text in desktop Session view");
  }
  const allowedKeys = new Set([
    "schema_version",
    "signal",
    "surface",
    "source_role",
    "selected_text",
    "preferred_wording",
    "session_id",
    "message_id",
    "ownerId",
    "at",
    "reason",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new Error("preferred-term capture accepts only the selected term, its replacement, and narrow source metadata");
    }
  }
  if (
    "surrounding_text" in input
    || "assistant_text" in input
    || "full_conversation" in input
    || "raw_audio" in input
    || "raw_transcript" in input
  ) {
      throw new Error("preferred-term capture accepts only the selected term and its replacement");
  }
  const selectedText = requireText(input.selected_text, "selected_text", MAX_PREFERRED_TERM_LENGTH);
  const preferredWording = requireText(input.preferred_wording, "preferred_wording", MAX_PREFERRED_TERM_LENGTH);
  if (selectedText === preferredWording) {
    throw new Error("preferred wording must differ from the selected TCA wording");
  }
  const sessionId = requireText(input.session_id, "session_id", 200);
  const messageId = requireText(input.message_id, "message_id", 200);
  const ownerId = requireText(input.ownerId, "ownerId", 200);
  const at = requireText(input.at ?? now(), "at", 100);
  if (!Number.isFinite(Date.parse(at))) throw new Error("at must be an ISO timestamp");
  const source = {
    action: "remember_preferred_term",
    category: "terminology",
    trigger: selectedText,
    statement: `When “${selectedText}” is relevant, use “${preferredWording}” as the owner's preferred term or spelling.`,
    preferredWording,
    scope: ["owner_private", "topic:terminology"],
    ownerId,
    sourceId: messageId,
    sourceRef: `trueconvo://session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}#preferred-term`,
  };
  return createCommunicationPreference({
    source,
    ownerId,
    at,
    statement: source.statement,
    preferredWording,
    signal: "remember_preferred_term",
    noticeText: "Remembered your preferred term or spelling for future replies.",
    reason: input.reason ?? "The owner explicitly saved a preferred term or spelling in Session view.",
  }, { idFactory });
}

function createCommunicationPreference({
  source,
  ownerId,
  at,
  statement,
  preferredWording,
  signal,
  noticeText,
  reason,
}, { idFactory }) {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new Error("at must be an ISO timestamp");
  return validateCommunicationPreference({
    schema_version: "open-convo.communication-preference.v1",
    id: `communication-preference-${requireText(idFactory(), "preference id", 300)}`,
    kind: "communication_preference",
    status: "active",
    owner_visible: true,
    preference: {
      version: 1,
      active: true,
      category: source.category,
      trigger: source.trigger,
      statement,
      preferred_wording: preferredWording,
      durability: "core",
      scope: source.scope,
      retrieval: {
        mode: "active_owner_private",
        passive_promotion_allowed: false,
      },
    },
    approval: {
      signal,
      strength: "explicit_approved",
      direct_user_action: true,
    },
    owner_notice: {
      text: noticeText,
      available_actions: ["undo", "tune"],
      undo_available_until: new Date(atMs + UNDO_WINDOW_MS).toISOString(),
    },
    provenance: {
      source_action: source.action,
      source_record_id: source.sourceId,
      source_refs: [source.sourceRef],
      captured_at: at,
    },
    audit: {
      created_at: at,
      updated_at: at,
      actions: [{
        action: "remember",
        actor: ownerId,
        at,
        reason,
      }],
    },
    effects: {
      writes_owner_private_preference: true,
      writes_canonical_shared_memory: false,
      external_action: false,
      changes_source_message: false,
    },
    access: {
      owner_id: ownerId,
      visibility: "owner_private",
    },
  });
}

export function validateCommunicationPreference(record) {
  if (!record || typeof record !== "object") throw new Error("communication preference must be an object");
  if (record.schema_version !== "open-convo.communication-preference.v1") {
    throw new Error("unsupported communication preference schema version");
  }
  if (record.kind !== "communication_preference" || !statuses.has(record.status)) {
    throw new Error("invalid communication preference identity or status");
  }
  if (record.owner_visible !== true) throw new Error("communication preference must be owner visible");
  requireText(record.id, "id", 300);

  const preference = record.preference;
  if (!preference || !Number.isInteger(preference.version) || preference.version < 1) {
    throw new Error("communication preference version must be a positive integer");
  }
  if (!categories.has(preference.category)) throw new Error("invalid communication preference category");
  requireText(preference.trigger, "preference.trigger", 1_000);
  requireText(preference.statement, "preference.statement");
  if (preference.category === "terminology") {
    requireText(preference.preferred_wording, "preference.preferred_wording");
  } else if (preference.preferred_wording !== null) {
    throw new Error("explanation-structure preferences do not store a content-specific rewrite");
  }
  if (preference.durability !== "core") throw new Error("explicit communication preference must be durable");
  if (!Array.isArray(preference.scope) || !preference.scope.includes("owner_private")) {
    throw new Error("communication preference must remain owner private");
  }
  if (preference.scope.some((scope) => scope !== "owner_private" && !scope.startsWith("topic:"))) {
    throw new Error("communication preference cannot broaden into shared, client, or system scope");
  }

  if (record.status === "undone") {
    if (preference.active !== false || preference.retrieval?.mode !== "suppressed") {
      throw new Error("undone communication preference must be inactive and suppressed");
    }
  } else if (preference.active !== true || preference.retrieval?.mode !== "active_owner_private") {
    throw new Error("active communication preference must be available only to the owner");
  }
  if (preference.retrieval?.passive_promotion_allowed !== false) {
    throw new Error("communication preference cannot promote itself to broader scope");
  }

  if (
    !approvalSignals.has(record.approval?.signal)
    || record.approval?.strength !== "explicit_approved"
    || record.approval?.direct_user_action !== true
  ) {
    throw new Error("lasting communication preference requires explicit owner approval");
  }
  if (JSON.stringify(record.owner_notice?.available_actions) !== JSON.stringify(ownerActions)) {
    throw new Error("saved preference must offer Undo and Tune");
  }
  requireText(record.owner_notice?.text, "owner_notice.text", 500);
  if (!Number.isFinite(Date.parse(record.owner_notice?.undo_available_until))) {
    throw new Error("saved preference needs a valid one-click Undo deadline");
  }

  if (!Array.isArray(record.provenance?.source_refs) || record.provenance.source_refs.length !== 1) {
    throw new Error("saved preference keeps one narrow source reference");
  }
  requireText(record.provenance.source_refs[0], "provenance.source_ref", 1_000);
  requireText(record.provenance.source_action, "provenance.source_action", 100);
  requireText(record.provenance.source_record_id, "provenance.source_record_id", 300);
  requireText(record.provenance.captured_at, "provenance.captured_at", 100);
  if (!Array.isArray(record.audit?.actions) || record.audit.actions.length === 0) {
    throw new Error("saved preference audit history is required");
  }
  if (
    record.effects?.writes_owner_private_preference !== true
    || record.effects?.writes_canonical_shared_memory !== false
    || record.effects?.external_action !== false
    || record.effects?.changes_source_message !== false
  ) {
    throw new Error("saved preference effects exceed the owner-private proof boundary");
  }
  if (record.access?.visibility !== "owner_private") {
    throw new Error("saved preference must remain owner private");
  }
  requireText(record.access?.owner_id, "access.owner_id", 300);
  if (
    "raw_audio" in record
    || "raw_transcript" in record
    || "full_conversation" in record
    || "surrounding_text" in record
    || "assistant_text" in record
  ) {
    throw new Error("saved preference cannot contain raw conversation or audio content");
  }
  return record;
}

export function applyCommunicationPreferenceAction(record, action, input = {}) {
  validateCommunicationPreference(record);
  if (!ownerActions.includes(action)) throw new Error(`unsupported saved preference action: ${action}`);
  if (record.status === "undone") throw new Error("an undone communication preference cannot be changed");
  const next = clone(record);
  const at = requireText(input.at ?? new Date().toISOString(), "at", 100);
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new Error("at must be an ISO timestamp");
  const before = preferenceSnapshot(record);

  if (action === "undo") {
    if (atMs > Date.parse(record.owner_notice.undo_available_until)) {
      throw new Error("one-click Undo expired; make a correction or supersession instead");
    }
    next.status = "undone";
    next.preference = {
      ...next.preference,
      version: next.preference.version + 1,
      active: false,
      retrieval: { mode: "suppressed", passive_promotion_allowed: false },
    };
    next.owner_notice.text = "Saved communication preference undone.";
  }

  if (action === "tune") {
    next.preference = {
      ...next.preference,
      version: next.preference.version + 1,
      statement: requireText(input.statement, "statement"),
      preferred_wording: input.preferredWording === undefined
        ? next.preference.preferred_wording
        : input.preferredWording === null
          ? null
          : requireText(input.preferredWording, "preferredWording"),
    };
    next.owner_notice.text = "Saved communication preference tuned.";
  }

  next.audit.updated_at = at;
  next.audit.actions.push({
    action,
    change_kind: atMs <= Date.parse(record.owner_notice.undo_available_until)
      ? "within_undo_window"
      : "correction",
    actor: input.actor ?? record.access.owner_id,
    at,
    reason: input.reason ?? "",
    before,
    after: preferenceSnapshot(next),
  });
  return validateCommunicationPreference(next);
}

export function guidanceForCommunicationPreference(record) {
  validateCommunicationPreference(record);
  if (record.status !== "active" || record.preference.active !== true) return null;
  return {
    preferenceId: record.id,
    version: record.preference.version,
    source: "explicit_owner_communication_preference",
    category: record.preference.category,
    trigger: record.preference.trigger,
    statement: record.preference.statement,
    preferredWording: record.preference.preferred_wording,
    scope: clone(record.preference.scope),
    durable: true,
    ownerPrivate: true,
    shared: false,
  };
}

export function selectRelevantCommunicationPreferences(records, {
  prompt,
  topicScopes = [],
  limit = 8,
} = {}) {
  if (!Array.isArray(records)) throw new Error("communication preference retrieval requires an array");
  const normalizedPrompt = requireText(prompt, "prompt", 2_000);
  if (!Array.isArray(topicScopes)) throw new Error("topicScopes must be an array");
  const topics = new Set(topicScopes.map((value) => requireText(value, "topic scope", 200)));
  for (const topic of topics) {
    if (!topic.startsWith("topic:")) throw new Error("only server-derived topic scopes may guide preference retrieval");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("preference retrieval limit must be between 1 and 20");

  const matches = [];
  const seen = new Set();
  for (const candidate of records) {
    const record = validateCommunicationPreference(candidate);
    const guidance = guidanceForCommunicationPreference(record);
    if (!guidance) continue;
    const identity = `${guidance.category}:${guidance.trigger.toLocaleLowerCase()}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    let matchReason = null;
    if (guidance.category === "terminology" && containsExactPhrase(normalizedPrompt, guidance.trigger)) {
      matchReason = "exact_term_match";
    }
    if (guidance.category === "explanation_structure") {
      const scopedTopics = guidance.scope.filter((value) => value.startsWith("topic:"));
      if (scopedTopics.some((value) => topics.has(value))) matchReason = "server_topic_scope_match";
    }
    if (!matchReason) continue;
    matches.push({ ...guidance, matchReason });
    if (matches.length >= limit) break;
  }
  return matches;
}

function containsExactPhrase(text, phrase) {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  const normalizedPhrase = phrase.replace(/\s+/g, " ").trim();
  const body = normalizedPhrase.split(" ").map(escapeRegExp).join("\\s+");
  const left = /^[\p{L}\p{N}]/u.test(normalizedPhrase) ? "(?:^|[^\\p{L}\\p{N}])" : "";
  const right = /[\p{L}\p{N}]$/u.test(normalizedPhrase) ? "(?=$|[^\\p{L}\\p{N}])" : "";
  return new RegExp(`${left}${body}${right}`, "iu").test(normalizedText);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function summarizeCommunicationPreference(record) {
  validateCommunicationPreference(record);
  return {
    id: record.id,
    status: record.status,
    version: record.preference.version,
    category: record.preference.category,
    statement: record.preference.statement,
    preferredWording: record.preference.preferred_wording,
    retrieval: record.preference.retrieval.mode,
    writesOwnerPrivatePreference: record.effects.writes_owner_private_preference,
    writesSharedMemory: record.effects.writes_canonical_shared_memory,
    lastAction: record.audit.actions.at(-1).action,
  };
}
