import { createHash } from "node:crypto";

const ASK_VALUES = ["question", "task", "thinking", "unclear"];
const FROM_VALUES = ["person", "agent", "system"];
const ACTION_KINDS = ["send", "publish", "spend", "delete", "account", "setting", "share-private"];
const APPROVAL_SOURCES = ["person", "agent", "memory"];
const APPROVAL_METHODS = ["typed", "clicked"];
const TRUST_VALUES = ["local", "outside"];
const INPUT_RECORD_FIELDS = ["message", "space", "offerAccepted", "recipient", "approvals", "usedApprovals", "memory"];
const FACT_RECORD_FIELDS = [...INPUT_RECORD_FIELDS, "usedAcceptances"];
const MAX_TEXT_BYTES = 16 * 1024;

function fail(field, message) {
  throw new TypeError(`${field}: ${message}`);
}

function object(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(field, "must be an object");
  return value;
}

function exactFields(value, field, required, optional = []) {
  object(value, field);
  for (const name of required) {
    if (!Object.hasOwn(value, name)) fail(`${field}.${name}`, "is required");
  }
  const allowed = new Set([...required, ...optional]);
  for (const name of Object.keys(value)) {
    if (!allowed.has(name)) fail(`${field}.${name}`, "is unknown");
  }
}

function string(value, field, { nonempty = true, maxBytes } = {}) {
  if (typeof value !== "string") fail(field, "must be a string");
  if (nonempty && value.length === 0) fail(field, "must not be empty");
  if (maxBytes !== undefined && Buffer.byteLength(value, "utf8") > maxBytes) fail(field, `must be at most ${maxBytes} UTF-8 bytes`);
}

function boolean(value, field) {
  if (typeof value !== "boolean") fail(field, "must be a boolean");
}

function list(value, field) {
  if (!Array.isArray(value)) fail(field, "must be a list");
}

function enumValue(value, field, values) {
  if (!values.includes(value)) fail(field, `must be one of ${values.join(", ")}`);
}

function plainJson(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(field, "must be a plain JSON object");
  const visit = (item, path) => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (Array.isArray(item)) return item.forEach((entry, index) => visit(entry, `${path}[${index}]`));
    if (typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.keys(item).forEach((key) => visit(item[key], `${path}.${key}`));
    }
    fail(path, "must contain only JSON values");
  };
  visit(value, field);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function actionDigest(action) {
  exactFields(action, "action", ["kind", "payload"]);
  enumValue(action.kind, "action.kind", ACTION_KINDS);
  plainJson(action.payload, "action.payload");
  return createHash("sha256").update(canonical({ kind: action.kind, payload: action.payload })).digest("hex");
}

function validateAction(action, index) {
  const field = `input.facts.outsideActions[${index}]`;
  exactFields(action, field, ["id", "kind", "description", "payload"]);
  string(action.id, `${field}.id`);
  enumValue(action.kind, `${field}.kind`, ACTION_KINDS);
  string(action.description, `${field}.description`);
  plainJson(action.payload, `${field}.payload`);
}

function validateApproval(approval, index) {
  const field = `record.approvals[${index}]`;
  exactFields(approval, field, ["approvalId", "actionId", "payloadDigest", "by", "how", "at"]);
  string(approval.approvalId, `${field}.approvalId`);
  string(approval.actionId, `${field}.actionId`);
  string(approval.payloadDigest, `${field}.payloadDigest`);
  enumValue(approval.by, `${field}.by`, APPROVAL_SOURCES);
  enumValue(approval.how, `${field}.how`, APPROVAL_METHODS);
  string(approval.at, `${field}.at`);
}

const GRANT_FIELDS = ["space", "jobId", "file", "label", "text", "why", "recipient", "freshAsOf", "allowedUse"];

function validateGrant(grant, index) {
  const field = `record.memory[${index}]`;
  exactFields(grant, field, GRANT_FIELDS, ["sharedByPerson"]);
  for (const name of GRANT_FIELDS) string(grant[name], `${field}.${name}`, { nonempty: name !== "text" });
  if (Object.hasOwn(grant, "sharedByPerson")) boolean(grant.sharedByPerson, `${field}.sharedByPerson`);
}

function validate(input, record) {
  exactFields(input, "input", ["facts"], ["limits"]);
  for (const field of INPUT_RECORD_FIELDS) {
    if (Object.hasOwn(input, field)) fail(`input.${field}`, "belongs only in record");
  }
  exactFields(input.facts, "input.facts", ["asks", "steps", "outsideActions"]);
  for (const field of FACT_RECORD_FIELDS) {
    if (Object.hasOwn(input.facts, field)) fail(`input.facts.${field}`, "belongs only in record");
  }
  enumValue(input.facts.asks, "input.facts.asks", ASK_VALUES);
  if (!Number.isInteger(input.facts.steps) || input.facts.steps < 1 || input.facts.steps > 1000) {
    fail("input.facts.steps", "must be a whole number from 1 to 1000");
  }
  list(input.facts.outsideActions, "input.facts.outsideActions");
  input.facts.outsideActions.forEach(validateAction);
  const actionIds = input.facts.outsideActions.map(({ id }) => id);
  if (new Set(actionIds).size !== actionIds.length) fail("input.facts.outsideActions.id", "must not repeat");
  if (input.limits !== undefined) {
    exactFields(input.limits, "input.limits", [], ["quickSteps"]);
    if (Object.hasOwn(input.limits, "quickSteps") && (!Number.isInteger(input.limits.quickSteps) || input.limits.quickSteps < 1 || input.limits.quickSteps > 1000)) {
      fail("input.limits.quickSteps", "must be a whole number from 1 to 1000");
    }
  }

  exactFields(record, "record", ["message", "space", "jobId", "recipient", "recipientTrust", "offerMade", "offerAccepted", "approvals", "usedApprovals", "usedAcceptances", "memory"], ["offeredRequest", "acceptanceId"]);
  exactFields(record.message, "record.message", ["text", "from"]);
  string(record.message.text, "record.message.text", { nonempty: false, maxBytes: MAX_TEXT_BYTES });
  enumValue(record.message.from, "record.message.from", FROM_VALUES);
  for (const name of ["space", "jobId", "recipient"]) string(record[name], `record.${name}`);
  enumValue(record.recipientTrust, "record.recipientTrust", TRUST_VALUES);
  boolean(record.offerMade, "record.offerMade");
  boolean(record.offerAccepted, "record.offerAccepted");
  if (record.offerAccepted) {
    if (!Object.hasOwn(record, "offeredRequest")) fail("record.offeredRequest", "is required when offerAccepted is true");
    if (!Object.hasOwn(record, "acceptanceId")) fail("record.acceptanceId", "is required when offerAccepted is true");
  }
  if (Object.hasOwn(record, "offeredRequest")) string(record.offeredRequest, "record.offeredRequest", { nonempty: false, maxBytes: MAX_TEXT_BYTES });
  if (Object.hasOwn(record, "acceptanceId")) string(record.acceptanceId, "record.acceptanceId");
  for (const name of ["approvals", "usedApprovals", "usedAcceptances", "memory"]) list(record[name], `record.${name}`);
  record.approvals.forEach(validateApproval);
  record.usedApprovals.forEach((id, index) => string(id, `record.usedApprovals[${index}]`));
  record.usedAcceptances.forEach((id, index) => string(id, `record.usedAcceptances[${index}]`));
  record.memory.forEach(validateGrant);
  const approvalIds = record.approvals.map(({ approvalId }) => approvalId);
  if (new Set(approvalIds).size !== approvalIds.length) fail("record.approvals.approvalId", "must not repeat");
}

function sorted(items, key) {
  return [...items].sort((a, b) => canonical(key(a)).localeCompare(canonical(key(b))));
}

function ignored(approval, reason) {
  return { ...approval, reason };
}

export function routeMessage(input, record) {
  validate(input, record);
  const actions = sorted(input.facts.outsideActions, ({ id }) => id);
  const approvals = sorted(record.approvals, ({ approvalId }) => approvalId);
  const usedApprovals = new Set(record.usedApprovals);
  const approvedActions = [];
  const ignoredApprovals = [];
  const claimedActions = new Set();

  for (const approval of approvals) {
    const action = actions.find(({ id }) => id === approval.actionId);
    let reason = null;
    if (approval.by !== "person") reason = `approval by ${approval.by} never counts`;
    else if (usedApprovals.has(approval.approvalId)) reason = "approval was already used";
    else if (!action) reason = "action is not present";
    else if (approval.payloadDigest !== actionDigest({ kind: action.kind, payload: action.payload })) reason = "action kind or payload changed";
    else if (claimedActions.has(action.id)) reason = "action already has a counting approval";
    if (reason) ignoredApprovals.push(ignored(approval, reason));
    else {
      claimedActions.add(action.id);
      approvedActions.push({ ...action, approvalId: approval.approvalId });
    }
  }

  const waitFor = actions.filter(({ id }) => !claimedActions.has(id)).map((action) => ({ ...action, choices: ["Yes", "Not now"] }));
  const quickSteps = input.limits?.quickSteps ?? 3;
  const acceptanceUsed = record.offerAccepted && record.usedAcceptances.includes(record.acceptanceId);
  const accepted = record.offerAccepted && !acceptanceUsed;
  let main;
  if (record.message.from !== "person") main = "answer";
  else if ((input.facts.asks === "thinking" || input.facts.asks === "unclear") && !accepted) main = "talk-it-through";
  else if ((input.facts.asks === "question" || input.facts.asks === "task") && input.facts.steps <= quickSteps && !accepted) main = "answer";
  else main = "hand-off";

  const offer = main === "talk-it-through" && input.facts.steps > quickSteps && !record.offerMade;
  const droppedGrants = [];
  const memoryPackage = [];
  for (const grant of sorted(record.memory, (item) => item)) {
    let reason = null;
    if (grant.jobId !== record.jobId) reason = "grant is for another job";
    else if (grant.recipient !== record.recipient) reason = "grant is for another recipient";
    else if (grant.space !== record.space && grant.sharedByPerson !== true) reason = "cross-space grant was not shared by the person";
    else if (record.recipientTrust === "outside" && grant.sharedByPerson !== true) reason = "outside recipient grant was not shared by the person";
    if (reason) droppedGrants.push({ ...grant, reason });
    else memoryPackage.push(grant);
  }

  const personsWords = accepted ? `${record.offeredRequest}\n\n${record.message.text}` : record.message.text;
  const brief = main === "hand-off" ? {
    personsWords,
    goal: "",
    finishLine: "",
    known: [],
    guessed: [],
    ruledOut: [],
    limits: [
      ...waitFor,
      ...(record.space ? [{ kind: "space", description: "nothing outside the space except the files in this package" }] : [])
    ],
    memoryPackage
  } : null;
  const routes = waitFor.length ? ["wait-for-yes", main] : [main];

  return {
    routes,
    main,
    waitFor,
    approvedActions,
    ignoredApprovals,
    droppedGrants,
    offer,
    brief,
    memoryCandidates: [],
    counts: {
      outsideActions: actions.length,
      countingApprovals: approvedActions.length,
      ignoredApprovals: ignoredApprovals.length,
      memoryGrants: record.memory.length,
      droppedGrants: droppedGrants.length
    }
  };
}

export function oneLineSummary(result) {
  const waiting = result.waitFor.map(({ id }) => id).join(", ") || "none";
  return `Main: ${result.main}; routes: ${result.routes.join(", ")}; waiting for: ${waiting}`.replace(/[\r\n\u2028\u2029]/gu, " ");
}
