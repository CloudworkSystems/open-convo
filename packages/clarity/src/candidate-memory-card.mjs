const actions = Object.freeze(["keep", "correct", "forget", "park"]);
const statuses = new Set(["candidate", "parked", "approved_for_promotion", "forgotten"]);

function clone(value) {
  return structuredClone(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
}

export function validateCandidateMemoryCard(card) {
  if (!card || typeof card !== "object") throw new Error("card must be an object");
  if (card.schema_version !== "open-convo.candidate-memory-card.v1") {
    throw new Error("unsupported candidate memory schema version");
  }
  if (card.kind !== "candidate_memory_card") throw new Error("invalid card kind");
  if (card.owner_visible !== true) throw new Error("candidate memory must be owner visible");
  if (!statuses.has(card.status)) throw new Error("invalid candidate memory status");
  requireString(card.id, "id");
  if (!card.memory || !Number.isInteger(card.memory.version) || card.memory.version < 1) {
    throw new Error("memory version must be a positive integer");
  }
  if (card.status === "forgotten") {
    if (card.memory.text !== null) throw new Error("forgotten memory must be a tombstone");
  } else {
    requireString(card.memory.text, "memory.text");
  }
  if (!Array.isArray(card.memory.scope) || card.memory.scope.length === 0) {
    throw new Error("memory scope is required");
  }
  if (!card.provenance || !Array.isArray(card.provenance.source_refs) || card.provenance.source_refs.length === 0) {
    throw new Error("at least one source reference is required");
  }
  for (const key of ["provider", "agent_id", "project_id", "session_id", "captured_at"]) {
    requireString(card.provenance[key], `provenance.${key}`);
  }
  if (!card.confidence || typeof card.confidence.score !== "number" || card.confidence.score < 0 || card.confidence.score > 1) {
    throw new Error("confidence score must be between 0 and 1");
  }
  if (JSON.stringify(card.owner_controls?.available_actions) !== JSON.stringify(actions)) {
    throw new Error("owner controls must be Keep, Correct, Forget, Park in that order");
  }
  if (!Array.isArray(card.audit?.actions) || card.audit.actions.length === 0) {
    throw new Error("audit history is required");
  }
  if (card.effects?.writes_canonical_memory !== false || card.effects?.external_action !== false || card.effects?.agent_connected !== false) {
    throw new Error("candidate card proof cannot write canon, act externally, or connect an agent");
  }
  if (card.access?.visibility !== "owner_private") throw new Error("fixture must stay owner private");
  return card;
}

function receipt(action, actor, at, reason, before = null, after = null) {
  return { action, actor, at, reason, before, after };
}

export function applyCandidateMemoryAction(card, action, input = {}) {
  validateCandidateMemoryCard(card);
  if (!actions.includes(action)) throw new Error(`unsupported owner action: ${action}`);
  if (card.status === "forgotten") throw new Error("forgotten memory cannot be changed");

  const next = clone(card);
  const actor = input.actor ?? card.access.owner_id;
  const at = input.at ?? new Date().toISOString();
  const reason = input.reason ?? "";
  const before = {
    status: card.status,
    memory: clone(card.memory),
    retrieval: clone(card.retrieval),
  };

  if (action === "keep") {
    next.status = "approved_for_promotion";
    next.retrieval = { mode: "provisional", passive_promotion_allowed: false };
  }

  if (action === "park") {
    next.status = "parked";
    next.retrieval = { mode: "suppressed", passive_promotion_allowed: false };
  }

  if (action === "forget") {
    next.status = "forgotten";
    next.memory = { ...next.memory, version: next.memory.version + 1, text: null };
    next.retrieval = { mode: "suppressed", passive_promotion_allowed: false };
  }

  if (action === "correct") {
    requireString(input.text, "corrected text");
    next.status = "candidate";
    next.memory = {
      ...next.memory,
      version: next.memory.version + 1,
      text: input.text.trim(),
      durability: input.durability ?? next.memory.durability,
      scope: input.scope ?? next.memory.scope,
    };
    next.retrieval = { mode: "provisional", passive_promotion_allowed: false };
  }

  const after = {
    status: next.status,
    memory: clone(next.memory),
    retrieval: clone(next.retrieval),
  };
  next.audit.updated_at = at;
  next.audit.actions.push(receipt(action, actor, at, reason, before, after));
  return validateCandidateMemoryCard(next);
}

export function summarizeCandidateMemoryCard(card) {
  validateCandidateMemoryCard(card);
  return {
    id: card.id,
    status: card.status,
    version: card.memory.version,
    text: card.memory.text,
    retrieval: card.retrieval.mode,
    canonicalWrite: card.effects.writes_canonical_memory,
    lastAction: card.audit.actions.at(-1).action,
  };
}
