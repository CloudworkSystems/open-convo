import { CHECKS, MISMATCH_FIELDS, problemKeys, rankRow } from './problems.mjs';
import { hiddenCharacter, isHttpsUrl, isRealDate } from './text.mjs';

export class ReportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReportError';
  }
}

const ROOT_KEYS = new Set(['schemaVersion', 'business', 'reportDate', 'findings']);
const BUSINESS_KEYS = new Set(['name', 'siteUrl']);
const FINDING_KEYS = new Set([
  'id', 'check', 'status', 'details', 'source', 'checkedOn', 'websiteSource', 'websiteCheckedOn',
]);
const SOURCE_KEYS = new Set(['label', 'url', 'locator']);
const STATUSES = new Set(['ok', 'problem', 'unknown']);
const TEXT_MAX = 500;
const COUNT_MAX = 1_000_000;

const DETAIL_FIELDS = Object.freeze({
  'listing-present': { subject: ['service'], result: ['present'] },
  'listing-details-match': { subject: ['service'], result: ['mismatches'] },
  'ai-mention': { subject: ['assistant', 'question'], result: ['result', 'wrongDetails'] },
  reviews: { subject: ['service'], result: ['count', 'last90Days', 'unanswered'] },
  'website-basics': { subject: [], result: ['hasWebsite', 'title', 'description', 'contact', 'worksOnPhone'] },
});

function fail(message) {
  throw new ReportError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function named(id, path) {
  return id === undefined ? path : `Finding "${id}" field ${path}`;
}

function requireObject(value, path) {
  if (!isPlainObject(value)) fail(`${path} must be an object.`);
}

function rejectUnknown(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const where = path ? `${path}.${key}` : key;
      fail(`The findings file has an unknown field "${where}".`);
    }
  }
}

function characterCount(value) {
  return [...value].length;
}

function requireText(value, path, id, { multiline = false } = {}) {
  const where = named(id, path);
  if (typeof value !== 'string') fail(`${where} must be text.`);
  if (hiddenCharacter(value, { multiline })) {
    if (id === undefined) fail(`${path} contains a character that cannot be shown.`);
    fail(`Finding "${id}" field ${path} contains a character that cannot be shown.`);
  }
  const count = characterCount(value);
  if (count < 1 || count > TEXT_MAX) fail(`${where} must be 1 to 500 characters.`);
  return value;
}

function requireUrl(value, path, id) {
  const where = named(id, path);
  if (typeof value !== 'string') fail(`${where} must be text.`);
  if (hiddenCharacter(value, { multiline: false })) {
    if (id === undefined) fail(`${path} contains a character that cannot be shown.`);
    fail(`Finding "${id}" field ${path} contains a character that cannot be shown.`);
  }
  const count = characterCount(value);
  if (count < 1 || count > TEXT_MAX) fail(`${where} must be 1 to 500 characters.`);
  if (!isHttpsUrl(value)) fail(`${where} is not an https:// address.`);
  return value;
}

function requireDate(value, path) {
  if (!isRealDate(value)) fail(`${path} "${typeof value === 'string' ? value : typeof value}" is not a real calendar date.`);
  return value;
}

function requireId(value) {
  if (typeof value !== 'string') {
    const shown = value === null ? 'null' : (typeof value === 'number' || typeof value === 'boolean' ? String(value) : typeof value);
    fail(`The id ${shown} must be a string.`);
  }
  if (value.length === 0) fail('The id "" is empty.');
  if (value.length > 64) fail(`The id "${value}" is ${value.length} characters; an id is 1 to 64 characters.`);
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    fail(`The id "${value}" may use only letters, digits, ".", "_" and "-".`);
  }
  return value;
}

function requireBoolean(value, path, id) {
  if (typeof value !== 'boolean') fail(`${named(id, path)} must be true or false.`);
  return value;
}

function requireCount(value, path, id) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > COUNT_MAX) {
    fail(`Finding "${id}" field ${path} must be a whole number from 0 to 1000000.`);
  }
  return value;
}

function requireSource(value, path, id, { website = false } = {}) {
  if (!isPlainObject(value)) fail(`${named(id, path)} must be an object.`);
  rejectUnknown(value, SOURCE_KEYS, path);
  if (!Object.hasOwn(value, 'label')) fail(`Finding "${id}" is missing ${path}.label.`);
  const source = { label: requireText(value.label, `${path}.label`, id) };
  if (Object.hasOwn(value, 'url')) source.url = requireUrl(value.url, `${path}.url`, id);
  if (Object.hasOwn(value, 'locator')) source.locator = requireText(value.locator, `${path}.locator`, id);
  if (!source.url && !source.locator) {
    const which = website ? 'websiteSource' : 'source';
    fail(`Finding "${id}" needs a ${which} url or a locator.`);
  }
  return source;
}

function trimSpaces(text) {
  return text.replace(/^[ ]+|[ ]+$/g, '');
}

function requireMismatches(value, id, path) {
  if (!Array.isArray(value)) fail(`Finding "${id}" field ${path} must be a list.`);
  const seen = new Set();
  return value.map((entry, index) => {
    const where = `${path}[${index}]`;
    if (!isPlainObject(entry)) fail(`Finding "${id}" field ${where} must be an object.`);
    rejectUnknown(entry, new Set(['field', 'listing', 'website']), where);
    if (!Object.hasOwn(entry, 'field')) fail(`Finding "${id}" is missing ${where}.field.`);
    if (typeof entry.field !== 'string' || !MISMATCH_FIELDS.includes(entry.field)) {
      fail(`Finding "${id}" has a mismatches field "${String(entry.field)}", which must be name, address, phone or hours.`);
    }
    if (seen.has(entry.field)) fail(`Finding "${id}" lists the mismatches field "${entry.field}" more than once.`);
    seen.add(entry.field);
    const listing = requireText(entry.listing, `${where}.listing`, id, { multiline: true });
    const website = requireText(entry.website, `${where}.website`, id, { multiline: true });
    if (trimSpaces(listing) === trimSpaces(website)) {
      fail(`Finding "${id}" field "${entry.field}" lists the same text on both sides.`);
    }
    return { field: entry.field, listing, website };
  });
}

function presentKeys(details, names) {
  return names.filter((name) => Object.hasOwn(details, name));
}

function requireDetails(check, status, details, id, path) {
  if (!isPlainObject(details)) fail(`Finding "${id}" field ${path} must be an object.`);
  const spec = DETAIL_FIELDS[check];
  rejectUnknown(details, new Set([...spec.subject, ...spec.result]), path);
  for (const name of spec.subject) {
    if (!Object.hasOwn(details, name)) fail(`Finding "${id}" is missing ${path}.${name}.`);
  }
  const resultNames = presentKeys(details, spec.result);
  if (status === 'unknown') {
    if (resultNames.length > 0) {
      fail(`Finding "${id}" has status "unknown" but includes ${path}.${resultNames[0]}.`);
    }
  } else if (check !== 'ai-mention' && check !== 'website-basics') {
    for (const name of spec.result) {
      if (!Object.hasOwn(details, name)) fail(`Finding "${id}" is missing ${path}.${name}.`);
    }
  }

  if (check === 'listing-present') {
    const service = requireText(details.service, `${path}.service`, id);
    if (status === 'unknown') return { service };
    return { service, present: requireBoolean(details.present, `${path}.present`, id) };
  }

  if (check === 'listing-details-match') {
    const service = requireText(details.service, `${path}.service`, id);
    if (status === 'unknown') return { service };
    return { service, mismatches: requireMismatches(details.mismatches, id, `${path}.mismatches`) };
  }

  if (check === 'ai-mention') {
    const assistant = requireText(details.assistant, `${path}.assistant`, id);
    const question = requireText(details.question, `${path}.question`, id);
    if (status === 'unknown') return { assistant, question };
    if (!Object.hasOwn(details, 'result')) fail(`Finding "${id}" is missing ${path}.result.`);
    if (!['mentioned', 'wrong-details', 'not-mentioned'].includes(details.result)) {
      fail(`Finding "${id}" field ${path}.result must be "mentioned", "wrong-details" or "not-mentioned".`);
    }
    const normalized = { assistant, question, result: details.result };
    const hasWrong = Object.hasOwn(details, 'wrongDetails');
    if (details.result === 'wrong-details') {
      if (!hasWrong) fail(`Finding "${id}" is missing ${path}.wrongDetails.`);
      normalized.wrongDetails = requireText(details.wrongDetails, `${path}.wrongDetails`, id, { multiline: true });
    } else if (hasWrong) {
      fail(`Finding "${id}" includes wrongDetails but result is not "wrong-details".`);
    }
    return normalized;
  }

  if (check === 'reviews') {
    const service = requireText(details.service, `${path}.service`, id);
    if (status === 'unknown') return { service };
    const count = requireCount(details.count, `${path}.count`, id);
    const last90Days = requireCount(details.last90Days, `${path}.last90Days`, id);
    const unanswered = requireCount(details.unanswered, `${path}.unanswered`, id);
    if (last90Days > count) fail(`Finding "${id}" has last90Days above count.`);
    if (unanswered > count) fail(`Finding "${id}" has unanswered above count.`);
    return { service, count, last90Days, unanswered };
  }

  if (status === 'unknown') return {};
  if (!Object.hasOwn(details, 'hasWebsite')) fail(`Finding "${id}" is missing ${path}.hasWebsite.`);
  const hasWebsite = requireBoolean(details.hasWebsite, `${path}.hasWebsite`, id);
  const extras = ['title', 'description', 'contact', 'worksOnPhone'];
  if (!hasWebsite) {
    for (const name of extras) {
      if (Object.hasOwn(details, name)) fail(`Finding "${id}" includes ${path}.${name} but hasWebsite is false.`);
    }
    return { hasWebsite };
  }
  for (const name of extras) {
    if (!Object.hasOwn(details, name)) fail(`Finding "${id}" is missing ${path}.${name}.`);
  }
  return {
    hasWebsite,
    title: requireBoolean(details.title, `${path}.title`, id),
    description: requireBoolean(details.description, `${path}.description`, id),
    contact: requireBoolean(details.contact, `${path}.contact`, id),
    worksOnPhone: requireBoolean(details.worksOnPhone, `${path}.worksOnPhone`, id),
  };
}

function requireFinding(value, index, reportDate, seen) {
  const path = `findings[${index}]`;
  if (!isPlainObject(value)) fail(`${path} must be an object.`);
  rejectUnknown(value, FINDING_KEYS, path);
  const id = requireId(value.id);
  if (seen.has(id)) fail(`The id "${id}" is repeated.`);
  seen.add(id);
  if (!Object.hasOwn(value, 'check') || typeof value.check !== 'string' || !CHECKS.includes(value.check)) {
    fail(`Finding "${id}" has an unknown check kind "${String(value.check)}".`);
  }
  if (!STATUSES.has(value.status)) {
    fail(`Finding "${id}" has status "${String(value.status)}", which must be "ok", "problem" or "unknown".`);
  }
  if (!Object.hasOwn(value, 'source')) fail(`Finding "${id}" is missing source.`);
  if (!Object.hasOwn(value, 'checkedOn')) fail(`Finding "${id}" is missing checkedOn.`);
  if (!Object.hasOwn(value, 'details')) fail(`Finding "${id}" is missing details.`);

  const listing = value.check === 'listing-details-match';
  if (!listing && (Object.hasOwn(value, 'websiteSource') || Object.hasOwn(value, 'websiteCheckedOn'))) {
    const which = Object.hasOwn(value, 'websiteSource') ? 'websiteSource' : 'websiteCheckedOn';
    fail(`Finding "${id}" includes ${which}, which only a listing-details-match finding may have.`);
  }
  if (listing && !Object.hasOwn(value, 'websiteSource')) fail(`Finding "${id}" is missing websiteSource.`);
  if (listing && !Object.hasOwn(value, 'websiteCheckedOn')) fail(`Finding "${id}" is missing websiteCheckedOn.`);

  const source = requireSource(value.source, `${path}.source`, id);
  const checkedOn = requireDate(value.checkedOn, `${path}.checkedOn`);
  if (checkedOn > reportDate) {
    fail(`Finding "${id}" field ${path}.checkedOn "${checkedOn}" is after reportDate "${reportDate}".`);
  }

  let websiteSource;
  let websiteCheckedOn;
  if (listing) {
    websiteSource = requireSource(value.websiteSource, `${path}.websiteSource`, id, { website: true });
    websiteCheckedOn = requireDate(value.websiteCheckedOn, `${path}.websiteCheckedOn`);
    if (websiteCheckedOn > reportDate) {
      fail(`Finding "${id}" field ${path}.websiteCheckedOn "${websiteCheckedOn}" is after reportDate "${reportDate}".`);
    }
  }

  const details = requireDetails(value.check, value.status, value.details, id, `${path}.details`);
  const keys = value.status === 'unknown' ? [] : problemKeys(value.check, details);
  if (value.status === 'problem' && keys.length === 0) {
    fail(`Finding "${id}" is marked "problem" but the details record no problem.`);
  }
  if (value.status === 'ok' && keys.length > 0) {
    fail(`Finding "${id}" is marked "ok" but the details record a problem.`);
  }

  const finding = {
    id,
    check: value.check,
    status: value.status,
    details,
    source,
    checkedOn,
    problems: keys.map((key) => rankRow(key)),
  };
  if (websiteSource) {
    finding.websiteSource = websiteSource;
    finding.websiteCheckedOn = websiteCheckedOn;
  }
  return finding;
}

export function validateFindings(value) {
  if (!isPlainObject(value)) fail('The findings file must be an object.');
  rejectUnknown(value, ROOT_KEYS, '');
  if (!Object.hasOwn(value, 'schemaVersion')) fail('The findings file is missing schemaVersion.');
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1.');
  if (!Object.hasOwn(value, 'business')) fail('The findings file is missing business.');
  requireObject(value.business, 'business');
  rejectUnknown(value.business, BUSINESS_KEYS, 'business');
  if (!Object.hasOwn(value.business, 'name')) fail('The findings file is missing business.name.');
  const business = { name: requireText(value.business.name, 'business.name') };
  if (Object.hasOwn(value.business, 'siteUrl')) {
    business.siteUrl = requireUrl(value.business.siteUrl, 'business.siteUrl');
  }
  if (!Object.hasOwn(value, 'reportDate')) fail('The findings file is missing reportDate.');
  const reportDate = requireDate(value.reportDate, 'reportDate');
  if (!Object.hasOwn(value, 'findings')) fail('The findings file is missing findings.');
  if (!Array.isArray(value.findings)) fail('findings must be a list.');
  const seen = new Set();
  const findings = value.findings.map((finding, index) => requireFinding(finding, index, reportDate, seen));
  return { schemaVersion: 1, business, reportDate, findings };
}
