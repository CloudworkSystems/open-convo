import { readFileSync } from "node:fs";
import path from "node:path";

import { normalizeHex } from "./contrast.mjs";
import { SiteEngineError } from "./errors.mjs";

const schema = JSON.parse(
  readFileSync(new URL("../schema/facts.schema.json", import.meta.url), "utf8"),
);

assertSchemaIsClosed(schema, "facts");

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function assertSchemaIsClosed(node, at) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node.oneOf)) {
    node.oneOf.forEach((branch, index) => assertSchemaIsClosed(branch, `${at}.oneOf.${index}`));
    return;
  }
  if (node.type === "object" || node.properties) {
    if (node.additionalProperties !== false) {
      throw new SiteEngineError(`Facts schema must reject unknown fields (${at}).`);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      assertSchemaIsClosed(child, `${at}.${key}`);
    }
  }
  if (node.items) assertSchemaIsClosed(node.items, `${at}.items`);
}

function joinPath(prefix, key) {
  return prefix ? `${prefix}.${key}` : key;
}

function typeOk(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return false;
  }
}

function typeWord(type) {
  if (type === "integer") return "a whole number";
  if (type === "array") return "a list";
  if (type === "object") return "an object";
  if (type === "string") return "text";
  return type;
}

function oneOfMessage(fieldPath) {
  if (fieldPath === "hours") {
    return 'hours must be "By appointment" or a list of days with opening and closing times';
  }
  if (fieldPath === "location") {
    return 'location must be "Online only" or a street address';
  }
  return `${fieldPath || "value"} does not match the facts schema`;
}

function checkKind(kind, value, fieldPath) {
  if (kind === "text" || kind === "alt-text") {
    if (value.trim() === "") {
      return kind === "alt-text" ? "Image is missing alt text" : `${fieldPath} is empty`;
    }
    return null;
  }
  if (kind === "https-url") return checkHttpsUrl(value, fieldPath);
  if (kind === "email") return checkEmail(value, fieldPath);
  if (kind === "phone") return checkPhone(value, fieldPath);
  if (kind === "hex-color") {
    return normalizeHex(value) ? null : `${fieldPath} must be a hex color such as #f37a4a`;
  }
  if (kind === "image-path") return checkImageLexicalPath(value);
  return `${fieldPath} has an unknown facts-schema check`;
}

export function checkHttpsUrl(value, fieldPath) {
  const problem = `${fieldPath} must be a complete https:// address`;
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) return problem;
  if (value !== value.trim()) return problem;
  if (CONTROL_CHARS.test(value) || /[\u0009\u000A\u000D\u007F]/.test(value)) return problem;
  if (value.includes("\\") || value.startsWith("//")) return problem;
  if (!/^https:\/\//i.test(value)) return problem;
  let url;
  try {
    url = new URL(value);
  } catch {
    return problem;
  }
  if (url.protocol !== "https:") return problem;
  if (url.username || url.password) return problem;
  if (!url.hostname) return problem;
  return null;
}

function checkEmail(value, fieldPath) {
  if (value.length > 254 || !EMAIL.test(value) || value.includes("..")) {
    return `${fieldPath} must be an email address`;
  }
  return null;
}

function checkPhone(value, fieldPath) {
  const problem = `${fieldPath} must be a phone number`;
  if (!/^\+?[0-9][0-9\s().-]{5,31}$/.test(value)) return problem;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return problem;
  return null;
}

export function checkImageLexicalPath(file) {
  const problem = `Image path is not allowed: ${echoPath(file)}`;
  if (typeof file !== "string" || file.length === 0 || file.length > 240) return problem;
  if (file.includes("\0") || file.includes("\\") || /[\r\n]/.test(file)) return problem;
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file) || /^[A-Za-z]:/.test(file)) {
    return problem;
  }
  const segments = file.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return problem;
  }
  return null;
}

function echoPath(file) {
  return String(file).replace(/[\u0000-\u001F\u007F]/g, "?").slice(0, 200);
}

function validateNode(value, node, fieldPath, errors) {
  if (Array.isArray(node.oneOf)) {
    const attempts = node.oneOf.map((branch) => {
      const branchErrors = [];
      validateNode(value, branch, fieldPath, branchErrors);
      return { branch, branchErrors };
    });
    const matches = attempts.filter((attempt) => attempt.branchErrors.length === 0);
    if (matches.length === 1) return;
    const sameType = attempts.filter(
      (attempt) => attempt.branch.type && typeOk(value, attempt.branch.type),
    );
    if (sameType.length === 1) {
      errors.push(...sameType[0].branchErrors);
      return;
    }
    errors.push(oneOfMessage(fieldPath));
    return;
  }

  if (Object.hasOwn(node, "const") && !Object.is(value, node.const)) {
    errors.push(`${fieldPath || "value"} must be ${JSON.stringify(node.const)}`);
    return;
  }

  if (node.type && !typeOk(value, node.type)) {
    errors.push(`${fieldPath || "value"} must be ${typeWord(node.type)}`);
    return;
  }

  if (node.type === "object") {
    const props = node.properties ?? {};
    const keys = Object.keys(value);
    if (node.additionalProperties === false) {
      for (const key of keys) {
        if (!Object.hasOwn(props, key)) errors.push(`Unknown field: ${joinPath(fieldPath, key)}`);
      }
    }
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`Missing required field: ${joinPath(fieldPath, key)}`);
    }
    for (const key of keys) {
      if (Object.hasOwn(props, key)) {
        validateNode(value[key], props[key], joinPath(fieldPath, key), errors);
      }
    }
    return;
  }

  if (node.type === "array") {
    if (node.minItems !== undefined && value.length < node.minItems) {
      errors.push(`${fieldPath || "value"} is missing an entry`);
    }
    if (node.maxItems !== undefined && value.length > node.maxItems) {
      errors.push(`${fieldPath || "value"} has too many entries`);
    }
    if (node.items) {
      value.forEach((item, index) => {
        validateNode(item, node.items, joinPath(fieldPath, String(index)), errors);
      });
    }
    return;
  }

  if (node.type === "string") {
    if (CONTROL_CHARS.test(value)) {
      errors.push(`${fieldPath || "value"} contains a character that cannot be published`);
    }
    if (node.minLength !== undefined && value.length < node.minLength) {
      errors.push(
        node["x-kind"] === "alt-text" ? "Image is missing alt text" : `${fieldPath || "value"} is empty`,
      );
    }
    if (node.maxLength !== undefined && value.length > node.maxLength) {
      errors.push(`${fieldPath || "value"} is too long`);
    }
    if (node["x-kind"]) {
      const problem = checkKind(node["x-kind"], value, fieldPath || "value");
      if (problem) errors.push(problem);
    }
    return;
  }
}

export function validateFacts(value) {
  const errors = [];
  validateNode(value, schema, "", errors);
  if (errors.length > 0) throw new SiteEngineError(errors.join("\n"));
  return value;
}

export { schema };
