import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateCommunicationPreference } from "./communication-preference.mjs";

const STORE_SCHEMA = "open-convo.communication-preference-proof-store.v1";

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function createCommunicationPreferenceProofStore({ filePath, proofOnly } = {}) {
  if (proofOnly !== true) {
    throw new Error("communication preference file store is proof-only and must be enabled explicitly");
  }
  const resolvedPath = path.resolve(requireText(filePath, "filePath"));

  return Object.freeze({
    create(record) {
      const validated = validateCommunicationPreference(record);
      const document = readDocument(resolvedPath);
      if (document.preferences[validated.id]) throw new Error("communication preference already exists");
      document.preferences[validated.id] = structuredClone(validated);
      writeDocument(resolvedPath, document);
      return metadata(validated);
    },

    read(preferenceId) {
      const id = requireText(preferenceId, "preferenceId");
      const record = readDocument(resolvedPath).preferences[id];
      if (!record) throw notFound();
      return structuredClone(validateCommunicationPreference(record));
    },

    replace(record, { expectedVersion } = {}) {
      const validated = validateCommunicationPreference(record);
      const document = readDocument(resolvedPath);
      const current = document.preferences[validated.id];
      if (!current) throw notFound();
      validateCommunicationPreference(current);
      if (!Number.isInteger(expectedVersion) || current.preference.version !== expectedVersion) {
        throw new Error("saved preference changed since it was read");
      }
      if (validated.preference.version !== current.preference.version + 1) {
        throw new Error("saved preference replacement must advance exactly one version");
      }
      document.preferences[validated.id] = structuredClone(validated);
      writeDocument(resolvedPath, document);
      return metadata(validated);
    },
  });
}

function readDocument(filePath) {
  if (!fs.existsSync(filePath)) return { schema_version: STORE_SCHEMA, preferences: {} };
  let document;
  try {
    document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("communication preference proof store is not valid JSON");
  }
  if (document?.schema_version !== STORE_SCHEMA || !document.preferences || typeof document.preferences !== "object") {
    throw new Error("communication preference proof store has an invalid schema");
  }
  for (const record of Object.values(document.preferences)) validateCommunicationPreference(record);
  return document;
}

function writeDocument(filePath, document) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw error;
  }
}

function metadata(record) {
  return {
    preference_id: record.id,
    version: record.preference.version,
    storage: "caller_chosen_proof_file",
    persistent: true,
    production_ready: false,
  };
}

function notFound() {
  const error = new Error("communication preference not found in this proof store");
  error.code = "COMMUNICATION_PREFERENCE_NOT_FOUND";
  return error;
}
