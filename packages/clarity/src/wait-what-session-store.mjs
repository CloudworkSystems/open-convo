import crypto from "node:crypto";

import { validateWaitWhatRepair } from "./wait-what.mjs";

const DEFAULT_TTL_MS = 60 * 60 * 1_000;

export function createWaitWhatSessionStore({
  clock = () => Date.now(),
  idFactory = () => crypto.randomUUID(),
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  if (typeof clock !== "function") throw new Error("Wait—what? session store clock must be a function");
  if (typeof idFactory !== "function") throw new Error("Wait—what? session store idFactory must be a function");
  if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new Error("Wait—what? session store ttlMs must be positive");
  const entries = new Map();

  return Object.freeze({
    create(record, scope) {
      const normalizedScope = validateScope(scope);
      const normalizedRecord = validateStoredRecord(record, normalizedScope);
      const repairRef = `wait-session-${requireText(idFactory(), "Wait—what? repair id")}`;
      const expiresAt = now(clock) + ttlMs;
      entries.set(repairRef, {
        ownerId: normalizedScope.ownerId,
        sessionId: normalizedScope.sessionId,
        record: structuredClone(normalizedRecord),
        expiresAt,
      });
      return metadata(repairRef, expiresAt);
    },

    read(repairRef, scope) {
      const entry = resolve(entries, repairRef, validateScope(scope), clock);
      entry.expiresAt = now(clock) + ttlMs;
      return structuredClone(entry.record);
    },

    replace(repairRef, record, scope) {
      const normalizedScope = validateScope(scope);
      const entry = resolve(entries, repairRef, normalizedScope, clock);
      const normalizedRecord = validateStoredRecord(record, normalizedScope);
      if (normalizedRecord.id !== entry.record.id) throw new Error("temporary Wait—what? repair identity cannot change");
      if (normalizedRecord.request.attempt !== entry.record.request.attempt + 1) {
        throw new Error("temporary Wait—what? replacement must advance exactly one attempt");
      }
      entry.record = structuredClone(normalizedRecord);
      entry.expiresAt = now(clock) + ttlMs;
      return metadata(requireRepairRef(repairRef), entry.expiresAt);
    },
  });
}

function validateStoredRecord(record, scope) {
  const validated = validateWaitWhatRepair(record);
  if (validated.access.owner_id !== scope.ownerId || validated.provenance.session_id !== scope.sessionId) {
    throw new Error("temporary Wait—what? repair scope does not match its record");
  }
  return validated;
}

function validateScope(scope) {
  if (!scope || typeof scope !== "object") throw new Error("temporary Wait—what? repair scope is required");
  return {
    ownerId: requireText(scope.ownerId, "ownerId"),
    sessionId: requireText(scope.sessionId, "sessionId"),
  };
}

function resolve(entries, repairRefValue, scope, clock) {
  const repairRef = requireRepairRef(repairRefValue);
  const entry = entries.get(repairRef);
  if (!entry) throw notFound();
  if (entry.expiresAt <= now(clock)) {
    entries.delete(repairRef);
    throw notFound("temporary Wait—what? repair expired");
  }
  if (entry.ownerId !== scope.ownerId || entry.sessionId !== scope.sessionId) throw notFound();
  return entry;
}

function requireRepairRef(value) {
  const repairRef = requireText(value, "repair_ref");
  if (!repairRef.startsWith("wait-session-")) throw notFound();
  return repairRef;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function now(clock) {
  const value = clock();
  if (!Number.isFinite(value)) throw new Error("Wait—what? session store clock must return milliseconds");
  return value;
}

function metadata(repairRef, expiresAt) {
  return {
    repair_ref: repairRef,
    storage: "server_memory",
    persistent: false,
    expires_at: new Date(expiresAt).toISOString(),
  };
}

function notFound(message = "temporary Wait—what? repair not found") {
  const error = new Error(message);
  error.code = "WAIT_WHAT_REPAIR_NOT_FOUND";
  error.statusCode = 404;
  return error;
}
