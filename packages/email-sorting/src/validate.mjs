// Input checks for the messages file and the settings file. A refusal
// throws EmailSortError with one plain message and sorts nothing. Messages
// name fields and positions, never the text of an unknown field.

import {
  CATEGORIES, DEFAULTS, EmailSortError, LIMITS, SCHEMA_VERSION, addressProblem, charLength,
  hasForbiddenControl, isPlainObject, lower, own, quote,
} from './rules.mjs';

const MESSAGE_FIELDS = ['id', 'inbox', 'from', 'to', 'subject', 'date', 'snippet', 'headers'];
const PERSON_FIELDS = ['name', 'address'];
const SETTINGS_FIELDS = ['schemaVersion', 'myAddresses', 'workDomains', 'senderRules', 'confidenceFloor', 'timeoutMs'];
const RULE_FIELDS = ['match', 'category'];

// ---------------------------------------------------------------- files

export function parseJsonFile(content, label) {
  const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length;
  if (bytes > LIMITS.fileBytes) {
    throw new EmailSortError(`The ${label} file is ${bytes} bytes; the limit is ${LIMITS.fileBytes} bytes (5 MB).`);
  }
  const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new EmailSortError(`The ${label} file isn't valid JSON.`);
  }
}

export function parseMessagesFile(content) {
  const input = parseJsonFile(content, 'messages');
  validateInput(input);
  return input;
}

export function parseSettingsFile(content) {
  return validateSettings(parseJsonFile(content, 'settings'));
}

// ---------------------------------------------------------------- dates

// RFC 3339 date-time with a required offset or Z. "T" and "Z" may be lower
// case (RFC 3339 section 5.6 note); a leap second (:60) is accepted.
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// Days since 1970-01-01 in the proleptic Gregorian calendar, computed by
// hand so no Date object (and no clock or local time zone) is involved.
function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// Returns { seconds, fraction } for ordering, or null when the text isn't a
// valid RFC 3339 date-time with an offset.
export function parseDate(text) {
  if (typeof text !== 'string') return null;
  const m = DATE_TIME.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  let offset = 0;
  if (!m[8]) {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (oh > 23 || om > 59) return null;
    offset = (m[9] === '-' ? -1 : 1) * (oh * 3600 + om * 60);
  }
  const seconds = daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - offset;
  const fraction = (m[7] || '').replace(/0+$/, '');
  return { seconds, fraction };
}

export function compareDates(a, b) {
  if (a.seconds !== b.seconds) return a.seconds < b.seconds ? -1 : 1;
  const len = Math.max(a.fraction.length, b.fraction.length);
  const fa = a.fraction.padEnd(len, '0');
  const fb = b.fraction.padEnd(len, '0');
  return fa < fb ? -1 : fa > fb ? 1 : 0;
}

// ---------------------------------------------------------------- messages

function refuse(where, problem) {
  throw new EmailSortError(`${where}: ${problem}`);
}

function checkText(where, field, value, { min = 0, max = Infinity } = {}) {
  if (typeof value !== 'string') refuse(where, `"${field}" must be text.`);
  const length = charLength(value);
  if (length < min) refuse(where, `"${field}" must have at least ${min} character${min === 1 ? '' : 's'}.`);
  if (length > max) refuse(where, `"${field}" is ${length} characters; the limit is ${max}.`);
  if (hasForbiddenControl(value)) refuse(where, `"${field}" holds a control character (only line feed and tab are allowed).`);
}

function checkFields(where, value, allowed, required, label) {
  if (!isPlainObject(value)) refuse(where, `${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      // Name the field, never its contents.
      refuse(where, `${label} has a field this version doesn't accept: ${quote(key)}.`);
    }
  }
  for (const key of required) {
    if (!own(value, key)) refuse(where, `${label} is missing the required field "${key}".`);
  }
}

function checkPerson(where, field, value) {
  checkFields(where, value, PERSON_FIELDS, ['address'], `"${field}"`);
  if (own(value, 'name')) checkText(where, `${field}.name`, value.name);
  if (typeof value.address !== 'string') refuse(where, `"${field}.address" must be text.`);
  const problem = addressProblem(value.address);
  if (problem) refuse(where, `"${field}.address" ${problem}.`);
}

function checkHeaders(where, headers) {
  if (!isPlainObject(headers)) refuse(where, '"headers" must be an object.');
  for (const name of Object.keys(headers)) {
    const field = `headers.${cutName(name)}`;
    if (name.trim() === '') refuse(where, 'a header has an empty name.');
    if (hasForbiddenControl(name)) refuse(where, `a header name holds a control character.`);
    const value = headers[name];
    if (typeof value === 'string') {
      checkText(where, field, value);
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item !== 'string') refuse(where, `"${field}" item ${i + 1} must be text.`);
        checkText(where, field, item);
      });
    } else {
      refuse(where, `"${field}" must be text or a list of texts.`);
    }
  }
}

function cutName(name) {
  return name.length > 60 ? `${name.slice(0, 60)}...` : name;
}

function describeMessage(index, message) {
  const base = `Message ${index + 1}`;
  if (isPlainObject(message) && typeof message.id === 'string' && message.id.length > 0
    && charLength(message.id) <= LIMITS.idChars && !hasForbiddenControl(message.id)) {
    return `${base} (id ${quote(message.id)})`;
  }
  return base;
}

export function validateInput(input) {
  if (!isPlainObject(input)) throw new EmailSortError('The messages file must be a JSON object.');
  for (const key of Object.keys(input)) {
    if (key !== 'schemaVersion' && key !== 'messages') {
      throw new EmailSortError(`The messages file has a field this version doesn't accept: ${quote(key)}.`);
    }
  }
  if (input.schemaVersion !== SCHEMA_VERSION) {
    throw new EmailSortError(`The messages file must have "schemaVersion": ${SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(input.messages)) throw new EmailSortError('The messages file must have a "messages" list.');
  if (input.messages.length > LIMITS.messages) {
    throw new EmailSortError(`The messages file has ${input.messages.length} messages; the limit is ${LIMITS.messages}.`);
  }
  const seen = new Set();
  input.messages.forEach((message, index) => {
    const where = describeMessage(index, message);
    checkFields(where, message, MESSAGE_FIELDS, MESSAGE_FIELDS, 'the message');
    checkText(where, 'id', message.id, { min: 1, max: LIMITS.idChars });
    checkText(where, 'inbox', message.inbox, { min: 1, max: LIMITS.inboxChars });
    checkPerson(where, 'from', message.from);
    if (!Array.isArray(message.to)) refuse(where, '"to" must be a list.');
    message.to.forEach((person, i) => checkPerson(where, `to[${i}]`, person));
    checkText(where, 'subject', message.subject, { max: LIMITS.subjectChars });
    if (!parseDate(message.date)) {
      refuse(where, '"date" must be an RFC 3339 date-time with an offset or Z, such as 2026-10-14T09:12:00-04:00.');
    }
    checkText(where, 'snippet', message.snippet, { max: LIMITS.snippetChars });
    checkHeaders(where, message.headers);
    const key = JSON.stringify([message.inbox, message.id]);
    if (seen.has(key)) refuse(where, `the id ${quote(message.id)} appears more than once in inbox ${quote(message.inbox)}.`);
    seen.add(key);
  });
  return input;
}

// ---------------------------------------------------------------- settings

function settingsRefuse(problem) {
  throw new EmailSortError(`Settings: ${problem}`);
}

function checkStringList(value, field, check) {
  if (!Array.isArray(value)) settingsRefuse(`"${field}" must be a list.`);
  return value.map((item, i) => {
    if (typeof item !== 'string') settingsRefuse(`"${field}" item ${i + 1} must be text.`);
    if (hasForbiddenControl(item)) settingsRefuse(`"${field}" item ${i + 1} holds a control character.`);
    const problem = check(item);
    if (problem) settingsRefuse(`"${field}" item ${i + 1} ${problem}.`);
    return item;
  });
}

function domainProblem(domain) {
  const text = domain.trim();
  if (text === '') return 'must not be empty';
  if (text.includes('@')) return 'must be a domain without "@"';
  return null;
}

export function ruleMatchProblem(match) {
  if (typeof match !== 'string') return 'must be text';
  if (hasForbiddenControl(match)) return 'holds a control character';
  if (match.startsWith('@')) return domainProblem(match.slice(1));
  return addressProblem(match);
}

// Returns a complete, frozen settings object with defaults filled in.
export function validateSettings(settings) {
  if (settings === undefined || settings === null) settings = { schemaVersion: SCHEMA_VERSION };
  if (!isPlainObject(settings)) settingsRefuse('the settings file must be a JSON object.');
  for (const key of Object.keys(settings)) {
    if (!SETTINGS_FIELDS.includes(key)) settingsRefuse(`a field this version doesn't accept: ${quote(key)}.`);
  }
  if (settings.schemaVersion !== SCHEMA_VERSION) settingsRefuse(`must have "schemaVersion": ${SCHEMA_VERSION}.`);

  const myAddresses = own(settings, 'myAddresses')
    ? checkStringList(settings.myAddresses, 'myAddresses', addressProblem) : [];
  const workDomains = own(settings, 'workDomains')
    ? checkStringList(settings.workDomains, 'workDomains', domainProblem) : [];

  const senderRules = [];
  if (own(settings, 'senderRules')) {
    if (!Array.isArray(settings.senderRules)) settingsRefuse('"senderRules" must be a list.');
    settings.senderRules.forEach((rule, i) => {
      const where = `sender rule ${i + 1}`;
      if (!isPlainObject(rule)) settingsRefuse(`${where} must be an object with "match" and "category".`);
      for (const key of Object.keys(rule)) {
        if (!RULE_FIELDS.includes(key)) settingsRefuse(`${where} has a field this version doesn't accept: ${quote(key)}.`);
      }
      if (!own(rule, 'match')) settingsRefuse(`${where} is missing "match".`);
      if (!own(rule, 'category')) settingsRefuse(`${where} is missing "category".`);
      if (typeof rule.category !== 'string' || !CATEGORIES.includes(rule.category)) {
        const named = typeof rule.category === 'string' ? JSON.stringify(rule.category) : String(JSON.stringify(rule.category));
        settingsRefuse(`${where} names the pile ${named}, which isn't one of ${CATEGORIES.join(', ')}.`);
      }
      const problem = ruleMatchProblem(rule.match);
      if (problem) settingsRefuse(`${where}'s "match" ${problem}.`);
      senderRules.push(Object.freeze({ match: rule.match, category: rule.category }));
    });
  }

  let confidenceFloor = DEFAULTS.confidenceFloor;
  if (own(settings, 'confidenceFloor')) {
    const v = settings.confidenceFloor;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.5 || v > 0.95) {
      settingsRefuse('"confidenceFloor" must be a number from 0.5 to 0.95.');
    }
    confidenceFloor = v;
  }
  let timeoutMs = DEFAULTS.timeoutMs;
  if (own(settings, 'timeoutMs')) {
    const v = settings.timeoutMs;
    if (!Number.isInteger(v) || v < 1000 || v > 120_000) {
      settingsRefuse('"timeoutMs" must be a whole number from 1000 to 120000.');
    }
    timeoutMs = v;
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    myAddresses: Object.freeze(myAddresses.map(a => lower(a.trim()))),
    workDomains: Object.freeze(workDomains.map(d => lower(d.trim()))),
    senderRules: Object.freeze(senderRules),
    confidenceFloor,
    timeoutMs,
  });
}
