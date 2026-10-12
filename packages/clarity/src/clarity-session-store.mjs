import crypto from "node:crypto";

import { validateClarityCorrection } from "./clarity-correction.mjs";

const DEFAULT_TTL_MS = 60 * 60 * 1_000;

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function createClaritySessionStore({
  clock = () => Date.now(),
  idFactory = () => crypto.randomUUID(),
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  if (typeof clock !== "function") throw new Error("clarity session store clock must be a function");
  if (typeof idFactory !== "function") throw new Error("clarity session store idFactory must be a function");
  if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new Error("clarity session store ttlMs must be positive");

  const entries = new Map();

  return Object.freeze({
    create(record, scope) {
      const normalizedScope = validateScope(scope);
      const normalizedRecord = validateStoredRecord(record, normalizedScope);
      const lessonRef = `clarity-session-${requireText(idFactory(), "clarity lesson id")}`;
      const expiresAt = now(clock) + ttlMs;
      entries.set(lessonRef, {
        ownerId: normalizedScope.ownerId,
        sessionId: normalizedScope.sessionId,
        record: structuredClone(normalizedRecord),
        expiresAt,
      });
      return metadata(lessonRef, expiresAt);
    },

    read(lessonRef, scope) {
      const entry = resolve(entries, lessonRef, validateScope(scope), clock);
      entry.expiresAt = now(clock) + ttlMs;
      return structuredClone(entry.record);
    },

    replace(lessonRef, record, scope) {
      const normalizedScope = validateScope(scope);
      const entry = resolve(entries, lessonRef, normalizedScope, clock);
      const normalizedRecord = validateStoredRecord(record, normalizedScope);
      if (normalizedRecord.id !== entry.record.id) {
        throw new Error("temporary clarity lesson identity cannot change");
      }
      entry.record = structuredClone(normalizedRecord);
      entry.expiresAt = now(clock) + ttlMs;
      return metadata(requireLessonRef(lessonRef), entry.expiresAt);
    },

    discard(lessonRef, scope) {
      resolve(entries, lessonRef, validateScope(scope), clock);
      entries.delete(requireLessonRef(lessonRef));
    },
  });
}

function validateStoredRecord(record, scope) {
  const validated = validateClarityCorrection(record);
  if (validated.access.owner_id !== scope.ownerId || validated.provenance.session_id !== scope.sessionId) {
    throw new Error("temporary clarity lesson scope does not match its record");
  }
  return validated;
}

function validateScope(scope) {
  if (!scope || typeof scope !== "object") throw new Error("temporary clarity lesson scope is required");
  return {
    ownerId: requireText(scope.ownerId, "ownerId"),
    sessionId: requireText(scope.sessionId, "sessionId"),
  };
}

function requireLessonRef(value) {
  const lessonRef = requireText(value, "lesson_ref");
  if (!lessonRef.startsWith("clarity-session-")) throw notFound();
  return lessonRef;
}

function resolve(entries, lessonRefValue, scope, clock) {
  const lessonRef = requireLessonRef(lessonRefValue);
  const entry = entries.get(lessonRef);
  if (!entry) throw notFound();
  if (entry.expiresAt <= now(clock)) {
    entries.delete(lessonRef);
    throw notFound("temporary clarity lesson expired");
  }
  if (entry.ownerId !== scope.ownerId || entry.sessionId !== scope.sessionId) throw notFound();
  return entry;
}

function now(clock) {
  const value = clock();
  if (!Number.isFinite(value)) throw new Error("clarity session store clock must return milliseconds");
  return value;
}

function metadata(lessonRef, expiresAt) {
  return {
    lesson_ref: lessonRef,
    storage: "server_memory",
    persistent: false,
    expires_at: new Date(expiresAt).toISOString(),
  };
}

function notFound(message = "temporary clarity lesson not found for this owner and session") {
  const error = new Error(message);
  error.code = "CLARITY_SESSION_LESSON_NOT_FOUND";
  error.statusCode = 404;
  return error;
}
