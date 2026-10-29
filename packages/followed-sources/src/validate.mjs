// Checks the four input shapes. Each check throws an InputError whose
// message the command prints after "Refused <file>:".

export const SCHEMA_VERSION = 1;
export const SOURCE_KINDS = Object.freeze(['email', 'links', 'video']);

export class InputError extends Error {}

const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const fail = message => { throw new InputError(message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, label) => typeof value === 'string' ? value : fail(`${label} must be text`);
const id = (value, label) => text(value, label).trim() ? value : fail(`${label} must not be empty`);

export function isDate(value) {
  return typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value));
}

function envelope(value, key) {
  if (!isObject(value)) fail('must be a JSON object');
  if (value.schemaVersion !== SCHEMA_VERSION) fail(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (!Array.isArray(value[key])) fail(`${key} must be a list`);
  return value[key];
}

export function validateSources(value) {
  const seen = new Set();
  return envelope(value, 'sources').map((source, index) => {
    const at = `sources[${index}]`;
    if (!isObject(source)) fail(`${at} must be an object`);
    id(source.id, `${at}.id`);
    if (seen.has(source.id)) fail(`${at}.id ${JSON.stringify(source.id)} is listed twice`);
    seen.add(source.id);
    text(source.name, `${at}.name`);
    if (!SOURCE_KINDS.includes(source.kind)) fail(`${at}.kind must be one of ${SOURCE_KINDS.join(', ')}`);
    const topics = source.topics ?? [];
    if (!Array.isArray(topics) || topics.some(topic => typeof topic !== 'string')) fail(`${at}.topics must be a list of text`);
    return { id: source.id, name: source.name, kind: source.kind, topics: [...topics] };
  });
}

export function validateItems(value) {
  return envelope(value, 'items').map((item, index) => {
    const at = `items[${index}]`;
    if (!isObject(item)) fail(`${at} must be an object`);
    id(item.source, `${at}.source`);
    id(item.id, `${at}.id`);
    if (!isDate(item.date)) fail(`${at}.date must be an ISO 8601 date`);
    text(item.title, `${at}.title`);
    text(item.text, `${at}.text`);
    if (item.url !== undefined && item.url !== null) text(item.url, `${at}.url`);
    return { source: item.source, id: item.id, date: item.date, title: item.title, text: item.text, url: item.url ?? null };
  });
}

export function validateState(value) {
  if (value === undefined || value === null) return { checkpoints: {}, reported: [], failures: [] };
  if (!isObject(value)) fail('must be a JSON object');
  if (value.schemaVersion !== SCHEMA_VERSION) fail(`schemaVersion must be ${SCHEMA_VERSION}`);
  const checkpoints = value.checkpoints ?? {};
  if (!isObject(checkpoints)) fail('checkpoints must be an object');
  for (const [source, date] of Object.entries(checkpoints)) {
    if (!isDate(date)) fail(`checkpoints.${source} must be an ISO 8601 date`);
  }
  const reported = value.reported ?? [];
  if (!Array.isArray(reported)) fail('reported must be a list');
  reported.forEach((entry, index) => {
    if (!isObject(entry)) fail(`reported[${index}] must be an object`);
    id(entry.source, `reported[${index}].source`);
    id(entry.itemId, `reported[${index}].itemId`);
  });
  const failures = value.failures ?? [];
  if (!Array.isArray(failures)) fail('failures must be a list');
  failures.forEach((entry, index) => {
    const at = `failures[${index}]`;
    if (!isObject(entry)) fail(`${at} must be an object`);
    id(entry.source, `${at}.source`);
    id(entry.itemId, `${at}.itemId`);
    if (!Number.isInteger(entry.runs) || entry.runs < 1) fail(`${at}.runs must be a whole number of at least 1`);
    if (typeof entry.gaveUp !== 'boolean') fail(`${at}.gaveUp must be true or false`);
  });
  return {
    checkpoints: { ...checkpoints },
    reported: reported.map(({ source, itemId }) => ({ source, itemId })),
    failures: failures.map(({ source, itemId, runs, gaveUp }) => ({ source, itemId, runs, gaveUp })),
  };
}

export function validateKnown(value) {
  if (value === undefined || value === null) return [];
  return envelope(value, 'known').map((entry, index) => {
    if (!isObject(entry)) fail(`known[${index}] must be an object`);
    return { text: text(entry.text, `known[${index}].text`) };
  });
}
