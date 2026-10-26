import {
  ACTIONS, EmailActionsError, LIMITS, PILES, SCHEMA_VERSION, addressProblem, charLength,
  hasForbiddenControl, isPlainObject, own, quote,
} from './rules.mjs';

const MESSAGE_FIELDS = ['id', 'inbox', 'from', 'to', 'subject', 'date', 'snippet', 'headers', 'pile'];
const REQUIRED_MESSAGE_FIELDS = ['id', 'inbox', 'from', 'to', 'subject', 'date', 'snippet', 'headers'];
const PERSON_FIELDS = ['name', 'address'];
const REQUEST_FIELDS = ['action', 'target', 'pile'];
const TARGET_FIELDS = ['sender', 'domain', 'listId', 'messages'];
const REF_FIELDS = ['inbox', 'id'];

function refuse(where, problem) {
  throw new EmailActionsError(where ? `${where}: ${problem}` : problem);
}

function checkFields(where, value, allowed, required, label) {
  if (!isPlainObject(value)) refuse(where, `${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) refuse(where, `${label} has a field this version doesn't accept: ${quote(key)}.`);
  }
  for (const key of required) {
    if (!own(value, key)) refuse(where, `${label} is missing the required field "${key}".`);
  }
}

function checkText(where, field, value, { min = 0, max = Infinity } = {}) {
  if (typeof value !== 'string') refuse(where, `"${field}" must be text.`);
  const length = charLength(value);
  if (length < min) refuse(where, `"${field}" must have at least ${min} character${min === 1 ? '' : 's'}.`);
  if (length > max) refuse(where, `"${field}" is ${length} characters; the limit is ${max}.`);
  if (hasForbiddenControl(value)) refuse(where, `"${field}" holds a control character (only line feed and tab are allowed).`);
}

function checkPerson(where, field, value) {
  checkFields(where, value, PERSON_FIELDS, ['address'], `"${field}"`);
  if (own(value, 'name')) checkText(where, `${field}.name`, value.name);
  const problem = addressProblem(value.address);
  if (problem) refuse(where, `"${field}.address" ${problem}.`);
}

function checkHeaders(where, headers) {
  if (!isPlainObject(headers)) refuse(where, '"headers" must be an object.');
  for (const name of Object.keys(headers)) {
    if (name.trim() === '') refuse(where, 'a header has an empty name.');
    if (hasForbiddenControl(name)) refuse(where, 'a header name holds a control character.');
    const value = headers[name];
    const values = Array.isArray(value) ? value : [value];
    if (!Array.isArray(value) && typeof value !== 'string') refuse(where, `"headers.${name}" must be text or a list of texts.`);
    values.forEach((item, index) => {
      if (typeof item !== 'string') refuse(where, `"headers.${name}" item ${index + 1} must be text.`);
      checkText(where, `headers.${name}`, item);
    });
  }
}

// RFC 3339 date-time with an explicit offset. Date.UTC and the local clock
// are deliberately not used; ordering uses the parsed civil fields below.
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;
function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
function dayOfMonth(days) {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  return doy - Math.floor((153 * mp + 2) / 5) + 1;
}

export function parseDate(text) {
  if (typeof text !== 'string') return null;
  const match = DATE_TIME.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 60) return null;
  let offset = 0;
  if (!match[8]) {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offset = (match[9] === '-' ? -1 : 1) * (offsetHour * 3600 + offsetMinute * 60);
  }
  const leap = second === 60 ? 1 : 0;
  const seconds = daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - leap - offset;
  if (leap && (((seconds + 1) % 86400 + 86400) % 86400 !== 0 || dayOfMonth((seconds + 1) / 86400) !== 1)) return null;
  return { seconds, leap, fraction: (match[7] || '').replace(/0+$/, '') };
}

export function compareDates(a, b) {
  if (a.seconds !== b.seconds) return a.seconds < b.seconds ? -1 : 1;
  if (a.leap !== b.leap) return a.leap < b.leap ? -1 : 1;
  const length = Math.max(a.fraction.length, b.fraction.length);
  const left = a.fraction.padEnd(length, '0');
  const right = b.fraction.padEnd(length, '0');
  return left < right ? -1 : left > right ? 1 : 0;
}

function messageName(message, index) {
  const base = `Message ${index + 1}`;
  return isPlainObject(message) && typeof message.id === 'string' && message.id && charLength(message.id) <= LIMITS.idChars
    && !hasForbiddenControl(message.id) ? `${base} (id ${quote(message.id)})` : base;
}

export function validateMessages(input) {
  if (!isPlainObject(input)) refuse('', 'The messages file must be a JSON object.');
  for (const key of Object.keys(input)) if (!['schemaVersion', 'messages'].includes(key)) refuse('', `The messages file has a field this version doesn't accept: ${quote(key)}.`);
  if (input.schemaVersion !== SCHEMA_VERSION) refuse('', `The messages file must have "schemaVersion": ${SCHEMA_VERSION}.`);
  if (!Array.isArray(input.messages)) refuse('', 'The messages file must have a "messages" list.');
  if (input.messages.length > LIMITS.messages) refuse('', `The messages file has ${input.messages.length} messages; the limit is ${LIMITS.messages}.`);
  const seen = new Set();
  input.messages.forEach((message, index) => {
    const where = messageName(message, index);
    checkFields(where, message, MESSAGE_FIELDS, REQUIRED_MESSAGE_FIELDS, 'the message');
    checkText(where, 'id', message.id, { min: 1, max: LIMITS.idChars });
    checkText(where, 'inbox', message.inbox, { min: 1, max: LIMITS.inboxChars });
    checkPerson(where, 'from', message.from);
    if (!Array.isArray(message.to)) refuse(where, '"to" must be a list.');
    message.to.forEach((person, personIndex) => checkPerson(where, `to[${personIndex}]`, person));
    checkText(where, 'subject', message.subject, { max: LIMITS.subjectChars });
    if (!parseDate(message.date)) refuse(where, '"date" must be an RFC 3339 date-time with an offset or Z, such as 2026-10-14T09:12:00-04:00.');
    checkText(where, 'snippet', message.snippet, { max: LIMITS.snippetChars });
    checkHeaders(where, message.headers);
    if (own(message, 'pile') && !PILES.includes(message.pile)) refuse(where, `"pile" must be one of: ${PILES.join(', ')}.`);
    const ref = JSON.stringify([message.inbox, message.id]);
    if (seen.has(ref)) refuse(where, `the id ${quote(message.id)} appears more than once in inbox ${quote(message.inbox)}.`);
    seen.add(ref);
  });
  return input;
}

export function validateRequests(input, messageRefs) {
  if (!isPlainObject(input)) refuse('', 'The requests file must be a JSON object.');
  for (const key of Object.keys(input)) if (!['schemaVersion', 'requests'].includes(key)) refuse('', `The requests file has a field this version doesn't accept: ${quote(key)}.`);
  if (input.schemaVersion !== SCHEMA_VERSION) refuse('', `The requests file must have "schemaVersion": ${SCHEMA_VERSION}.`);
  if (!Array.isArray(input.requests)) refuse('', 'The requests file must have a "requests" list.');
  if (input.requests.length < 1 || input.requests.length > LIMITS.requests) refuse('', `The requests file must have 1 to ${LIMITS.requests} requests.`);
  input.requests.forEach((request, index) => {
    const where = `Request ${index + 1}`;
    checkFields(where, request, REQUEST_FIELDS, ['action', 'target'], 'the request');
    if (!ACTIONS.includes(request.action)) refuse(where, `"action" must be one of: ${ACTIONS.join(', ')}.`);
    checkFields(where, request.target, TARGET_FIELDS, [], '"target"');
    const kinds = TARGET_FIELDS.filter(kind => own(request.target, kind));
    if (kinds.length !== 1) refuse(where, '"target" must have exactly one of sender, domain, listId or messages.');
    const kind = kinds[0];
    if (own(request, 'pile')) {
      if (!PILES.includes(request.pile)) refuse(where, `"pile" must be one of: ${PILES.join(', ')}.`);
      if (kind === 'messages') refuse(where, '"pile" cannot narrow a messages target.');
    }
    if (kind === 'sender') {
      const problem = addressProblem(request.target.sender);
      if (problem) refuse(where, `"target.sender" ${problem}.`);
    } else if (kind === 'domain') {
      const domain = request.target.domain;
      if (typeof domain !== 'string' || !domain.startsWith('@') || domain.length === 1 || domain.slice(1).includes('@') || hasForbiddenControl(domain)) {
        refuse(where, '"target.domain" must be text in the form "@domain".');
      }
    } else if (kind === 'listId') {
      checkText(where, 'target.listId', request.target.listId, { min: 1 });
      if (request.target.listId.replace(/^[\s<>]+|[\s<>]+$/g, '') === '') refuse(where, '"target.listId" must name a List-Id.');
    } else {
      if (!Array.isArray(request.target.messages) || request.target.messages.length < 1 || request.target.messages.length > LIMITS.messageTargets) {
        refuse(where, `"target.messages" must have 1 to ${LIMITS.messageTargets} entries.`);
      }
      const targets = new Set();
      request.target.messages.forEach((ref, refIndex) => {
        checkFields(where, ref, REF_FIELDS, REF_FIELDS, `"target.messages" entry ${refIndex + 1}`);
        checkText(where, `target.messages[${refIndex}].inbox`, ref.inbox, { min: 1, max: LIMITS.inboxChars });
        checkText(where, `target.messages[${refIndex}].id`, ref.id, { min: 1, max: LIMITS.idChars });
        const key = JSON.stringify([ref.inbox, ref.id]);
        if (targets.has(key)) refuse(where, `"target.messages" entry ${refIndex + 1} repeats a message.`);
        if (!messageRefs.has(key)) refuse(where, `"target.messages" entry ${refIndex + 1} names a message that isn't in the input.`);
        targets.add(key);
      });
    }
  });
  return input;
}

export function parseJsonFile(content, label) {
  const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length;
  if (bytes > LIMITS.fileBytes) throw new EmailActionsError(`The ${label} file is ${bytes} bytes; the limit is ${LIMITS.fileBytes} bytes (5 MB).`);
  try {
    return JSON.parse(typeof content === 'string' ? content : Buffer.from(content).toString('utf8'));
  } catch {
    throw new EmailActionsError(`The ${label} file isn't valid JSON.`);
  }
}
