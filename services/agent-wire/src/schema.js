import { fail } from './errors.js';

export const bytes = (s) => new TextEncoder().encode(s).byteLength;
const string = (maxLength = 256) => ({ type: 'string', minLength: 1, maxLength });
const label = { ...string(32), pattern: '^[a-z][a-z0-9_-]{0,31}$' };
const id = { ...string(128), pattern: '^[A-Za-z0-9_-]+$' };
const time = { type: 'string', format: 'date-time' };
const array = (items, maxItems = 1000) => ({ type: 'array', items, maxItems, uniqueItems: true });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const agentSchema = object({
  identity: { ...string(256), pattern: '^(user|service):[^\\s]+$' },
  agent: label, mayWriteTo: array(label), role: { type: 'string', enum: ['agent', 'assistant'] },
  on: { type: 'boolean' }, removed: { type: 'boolean' },
}, ['identity', 'agent', 'mayWriteTo', 'role', 'on']);
const noteSchema = object({
  id, from: label, to: label, subject: string(120), body: string(8192), createdAt: time, inReplyTo: id,
}, ['id', 'from', 'to', 'subject', 'body', 'createdAt']);

export function schemas(config) {
  const body = { ...string(config.BODY_BYTES), maxBytes: config.BODY_BYTES };
  const subject = string(config.SUBJECT_CHARS);
  return {
    leave_note: object({ to: label, subject, body, inReplyTo: id, from: string() }, ['to', 'subject', 'body']),
    read_notes: object({ since: time }),
    list_notes: object({ from: label, to: label, since: time }),
    answer_note: object({ id, body }, ['id', 'body']),
    clear_notes: object({ ids: array(id) }, ['ids']),
    add_agent: object({ identity: agentSchema.properties.identity, agent: label, mayWriteTo: array(label), role: agentSchema.properties.role }, ['identity', 'agent', 'mayWriteTo', 'role']),
    switch_agent: object({ agent: label, on: { type: 'boolean' } }, ['agent', 'on']),
    remove_agent: object({ agent: label }, ['agent']),
    list_agents: object({}), list_drafts: object({}),
    draft_reply: object({ id, body }, ['id', 'body']),
    send_draft: object({ draftId: id }, ['draftId']),
    export_notes: object({ after: id }),
    begin_import: object({ agents: array(agentSchema) }, ['agents']),
    import_note: object({ note: { ...noteSchema, properties: { ...noteSchema.properties, subject, body } } }, ['note']),
    finish_import: object({ count: { type: 'integer', minimum: 0, maximum: config.NOTE_CAP } }, ['count']),
  };
}

export function valid(schema, value) {
  if (schema.type === 'object') {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      schema.required.every((key) => Object.hasOwn(value, key)) &&
      Object.entries(value).every(([key, v]) => Object.hasOwn(schema.properties, key) && valid(schema.properties[key], v));
  }
  if (schema.type === 'array') return Array.isArray(value) && value.length <= schema.maxItems &&
    (!schema.uniqueItems || new Set(value.map((v) => JSON.stringify(v))).size === value.length) && value.every((v) => valid(schema.items, v));
  if (schema.type === 'string') return typeof value === 'string' &&
    (!schema.minLength || [...value].length >= schema.minLength) && (!schema.maxLength || [...value].length <= schema.maxLength) &&
    (!schema.maxBytes || bytes(value) <= schema.maxBytes) && (!schema.pattern || new RegExp(schema.pattern).test(value)) &&
    (!schema.format || /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
  return false;
}

export function check(schema, value) {
  if (!valid(schema, value) || (schema.enum && !schema.enum.includes(value))) fail('Check the tool arguments and try again.');
  // Enum checks also apply inside objects and arrays.
  function enums(s, v) {
    if (s.enum && !s.enum.includes(v)) fail('Check the tool arguments and try again.');
    if (s.type === 'object') for (const [key, item] of Object.entries(v)) enums(s.properties[key], item);
    if (s.type === 'array') for (const item of v) enums(s.items, item);
  }
  enums(schema, value);
}

export function plainText(value) {
  if (/<\/?[a-z][^>]*>/i.test(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail('Use plain text without HTML or control characters.');
  }
}
