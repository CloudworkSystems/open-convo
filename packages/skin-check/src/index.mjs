import { randomUUID } from 'node:crypto';

/**
 * Skin check engine. It records spots and the owner's own self-check answers
 * and never diagnoses: there is no score, no ranking and no reassuring state.
 * Standalone on purpose: stamp and merge rules match the household lists and
 * habit grid engines, rewritten here so this package imports nothing else.
 * It handles no image data; photos are opaque references only.
 */

export const SCHEMA_VERSION = 1;
export const REMINDER = 'Skin check keeps a record of your own observations. It is not a diagnosis. ' +
  'See a doctor or dermatologist about any spot that is new, changing, or worries you, whatever this app shows.';
export const ANSWERS = Object.freeze(['yes', 'no', 'notSure']);
export const SOURCES = Object.freeze(['phone', 'mac', 'import']);
export const LIGHTS = Object.freeze(['daylight', 'indoor', 'flash', 'unknown']);
export const QUESTIONS = Object.freeze([
  { id: 'asymmetry', urgent: false, text: 'Is one half different from the other?' },
  { id: 'border', urgent: false, text: 'Is the edge ragged, notched or blurred?' },
  { id: 'color', urgent: false, text: 'Does it have more than one color, or uneven color?' },
  { id: 'diameter', urgent: false, text: 'Is it bigger than a pencil eraser, about 6 mm?' },
  { id: 'evolving', urgent: false, text: 'Has it changed in size, shape, color or feeling since you last looked?' },
  { id: 'bleeding', urgent: true, text: 'Has it bled without being hurt?' },
  { id: 'sore', urgent: true, text: 'Is it a sore that hasn\'t healed in three weeks, or that heals and keeps coming back in the same place?' },
  { id: 'different', urgent: false, text: 'Does it look different from your other spots?' },
  { id: 'newSpot', urgent: false, text: 'Is this a spot you hadn\'t noticed before (new in the last few months)?' },
  { id: 'nonMole', urgent: false, text: 'Is it a rough or scaly patch, a firm or shiny bump, or a pimple-like spot that hasn\'t gone away?' },
  { id: 'worry', urgent: false, text: 'Is there anything else about this spot that worries you (itching, tenderness, a crust, anything)?' },
].map(question => Object.freeze(question)));
export const OUTCOMES = Object.freeze({
  bookSoon: 'Book an appointment soon',
  worthShowing: 'Worth showing a clinician',
  noWarningSign: 'No warning sign noted by you',
  notCheckedSinceVisit: 'Not checked since your clinician visit',
  notCheckedYet: 'Not checked yet',
});
export const REGIONS = Object.freeze({
  headFront: 'Front of head', headBack: 'Back of head', neck: 'Neck', chest: 'Chest', abdomen: 'Abdomen',
  upperBack: 'Upper back', lowerBack: 'Lower back', leftArm: 'Left arm', rightArm: 'Right arm',
  leftHand: 'Left hand', rightHand: 'Right hand', leftLeg: 'Left leg', rightLeg: 'Right leg',
  leftFoot: 'Left foot', rightFoot: 'Right foot', other: 'Other',
});
export const DEFAULT_REMINDER = 'monthly';
// Least to most cautious. Only these three come from answers.
const CAUTION = Object.freeze(['noWarningSign', 'worthShowing', 'bookSoon']);
const QUESTION_IDS = new Set(QUESTIONS.map(question => question.id));
const REGION_IDS = Object.keys(REGIONS);

const clone = value => structuredClone(value);
const own = (object, key) => Object.hasOwn(object, key);
const lex = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = message => { throw new Error(message); };
const string = (value, label) => typeof value === 'string' ? value : fail(`${label} must be text.`);
const identity = (value, label) => string(value, label).length ? value : fail(`${label} must not be empty.`);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const setOwn = (target, key, value) => Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
const byId = (a, b) => lex(a.id, b.id);
const onlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));

// ---- Dates, instants and time zones ----

function validDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [year, month, day] = iso.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}
const INSTANT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
function parseInstant(text) {
  const match = typeof text === 'string' ? INSTANT.exec(text) : null;
  if (!match) return null;
  const [, date, hour, minute, second = '0', fraction = '0', sign, offsetHours = '0', offsetMinutes = '0'] = match;
  if (!validDate(date) || +hour > 23 || +minute > 59 || +second > 59 || +offsetHours > 18 || +offsetMinutes > 59) return null;
  const [year, month, day] = date.split('-').map(Number);
  const offset = (sign === '-' ? -1 : 1) * (+offsetHours * 60 + +offsetMinutes);
  return Date.UTC(year, month - 1, day, +hour, +minute, +second, +fraction.padEnd(3, '0')) - offset * 60000;
}
function instant(text, label) {
  const ms = parseInstant(text);
  return ms === null ? fail(`${label} must be a date and time with its UTC offset, like 2026-10-24T09:15:00-04:00.`) : ms;
}
const formatters = new Map();
function zoneParts(ms, timeZone) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, format);
  }
  return Object.fromEntries(format.formatToParts(new Date(ms)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}
function validZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try { zoneParts(0, timeZone); return true; } catch { return false; }
}
const zone = timeZone => validZone(timeZone) ? timeZone : fail('Time zone must be an IANA name, like America/New_York.');
/** Civil date (YYYY-MM-DD) of an instant in a time zone. */
export function civilDate(ms, timeZone) {
  const parts = zoneParts(ms, timeZone);
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
}
function zoneOffset(ms, timeZone) {
  const parts = zoneParts(ms, timeZone);
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((local - Math.floor(ms / 1000) * 1000) / 60000);
}
function formatInstant(ms, timeZone) {
  const offset = zoneOffset(ms, timeZone);
  const local = new Date(ms + offset * 60000).toISOString().slice(0, 19);
  const size = Math.abs(offset);
  return `${local}${offset < 0 ? '-' : '+'}${String(Math.floor(size / 60)).padStart(2, '0')}:${String(size % 60).padStart(2, '0')}`;
}
/** First instant of a civil date in a time zone (minute precision). */
export function startOfDay(date, timeZone) {
  if (!validDate(date)) fail('Date must be YYYY-MM-DD.');
  const [year, month, day] = date.split('-').map(Number);
  const midnight = Date.UTC(year, month - 1, day);
  // UTC offsets lie between -12 and +14 hours, so the day starts in this window.
  let before = midnight - 15 * 3600000;
  let after = midnight + 13 * 3600000;
  while (after - before > 60000) {
    const middle = before + Math.floor((after - before) / 120000) * 60000;
    if (civilDate(middle, timeZone) >= date) after = middle; else before = middle;
  }
  return after;
}
export function addDays(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
/** Adds calendar months, clamping to the month's last day (Jan 31 + 1 month = Feb 28 or 29). */
export function addMonths(iso, months) {
  const [year, month, day] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, last))).toISOString().slice(0, 10);
}

// ---- Version stamps and registers (same rules as household lists) ----

export function compareStamps(a, b) {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  return lex(a.counter, b.counter) || lex(a.time, b.time) || lex(a.device, b.device);
}
const latest = (a, b) => compareStamps(a, b) >= 0 ? a : b;
function validStamp(stamp) {
  return object(stamp) && onlyKeys(stamp, ['counter', 'time', 'device']) && Number.isSafeInteger(stamp.counter) &&
    stamp.counter > 0 && Number.isSafeInteger(stamp.time) && typeof stamp.device === 'string' && stamp.device.length > 0;
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sameValue = (a, b) => a === b || stable(a) === stable(b);
function register(a, b) {
  if (!a) return clone(b);
  if (!b) return clone(a);
  const order = compareStamps(a.stamp, b.stamp);
  if (!order && !sameValue(a.value, b.value)) fail('Conflicting values share a version stamp. Use a unique device ID per writer.');
  return clone(order >= 0 ? a : b);
}
function records(a, b, purge = null) {
  const result = {};
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const value = register(own(a, key) ? a[key] : undefined, own(b, key) ? b[key] : undefined);
    if (compareStamps(value.stamp, purge) > 0) setOwn(result, key, value);
  }
  return result;
}

// ---- Validation ----

function checkPlace(place) {
  if (!object(place) || !onlyKeys(place, ['region', 'note']) || !REGION_IDS.includes(place.region) || typeof place.note !== 'string') return false;
  return place.region === 'other' ? place.note.trim().length > 0 : place.note === '';
}
const validReminder = value => value === 'monthly' || value === 'off' || (Number.isInteger(value) && value >= 1 && value <= 12);
const SPOT_FIELDS = {
  place: checkPlace,
  label: value => typeof value === 'string',
  createdAt: value => parseInstant(value) !== null,
  archived: value => typeof value === 'boolean',
  reminder: validReminder,
};
const PERSON_FIELDS = { timeZone: validZone };
function validateFields(fields, types, what) {
  if (!object(fields)) fail(`Invalid ${what} fields in skin check file.`);
  for (const [key, entry] of Object.entries(fields)) {
    if (!own(types, key) || !object(entry) || !onlyKeys(entry, ['value', 'stamp']) || !validStamp(entry.stamp) || !types[key](entry.value)) {
      fail(`Invalid ${what} field "${key}" in skin check file.`);
    }
  }
}
function checkAnswers(answers) {
  if (!object(answers)) fail('Answers must be an object of question IDs.');
  for (const [key, value] of Object.entries(answers)) {
    if (!QUESTION_IDS.has(key)) fail(`Unknown question "${key}".`);
    if (!ANSWERS.includes(value)) fail(`Answer to "${key}" must be yes, no or notSure.`);
  }
  return answers;
}
function checkPhoto(photo) {
  if (photo === null) return null;
  if (!object(photo) || !onlyKeys(photo, ['ref', 'distanceGuide', 'scaleMarker', 'light'])) fail('A photo reference holds only ref, distanceGuide, scaleMarker and light.');
  const ref = identity(photo.ref, 'Photo reference');
  // An opaque ID, never image data.
  if (ref.length > 200 || /^data:/i.test(ref) || /[\s<>]/.test(ref)) fail('Photo reference must be a short opaque ID, never image data.');
  if (typeof photo.distanceGuide !== 'boolean' || typeof photo.scaleMarker !== 'boolean' || !LIGHTS.includes(photo.light)) fail('Photo capture details are invalid.');
  return photo;
}
const CHECK_IN_KEYS = ['id', 'spotId', 'capturedAt', 'answers', 'worryNote', 'photo', 'source', 'stamp'];
function validateCheckIn(record) {
  if (!object(record) || !onlyKeys(record, CHECK_IN_KEYS) || CHECK_IN_KEYS.some(key => !own(record, key))) fail('Invalid check-in in skin check file.');
  identity(record.id, 'Check-in ID'); identity(record.spotId, 'Spot ID'); instant(record.capturedAt, 'Capture time');
  checkAnswers(record.answers); string(record.worryNote, 'Worry note'); checkPhoto(record.photo);
  if (!SOURCES.includes(record.source) || !validStamp(record.stamp)) fail('Invalid check-in in skin check file.');
}
const VISIT_KEYS = ['id', 'spotId', 'at', 'dateOnly', 'note', 'stamp'];
function validateVisit(record) {
  if (!object(record) || !onlyKeys(record, VISIT_KEYS) || VISIT_KEYS.some(key => !own(record, key))) fail('Invalid clinician visit in skin check file.');
  identity(record.id, 'Visit ID'); identity(record.spotId, 'Spot ID'); instant(record.at, 'Visit time'); string(record.note, 'Visit note');
  if (typeof record.dateOnly !== 'boolean' || !validStamp(record.stamp)) fail('Invalid clinician visit in skin check file.');
}
// IDs of the records deleted with a spot when Trash was emptied, kept per record type.
const PURGED_KINDS = ['checkIns', 'visits'];
const noPurged = () => ({ checkIns: [], visits: [] });
const unionPurged = (...lists) => Object.fromEntries(PURGED_KINDS.map(kind => [kind, [...new Set(lists.flatMap(list => list[kind]))].sort()]));
function validateSpot(spot) {
  if (!object(spot) || !onlyKeys(spot, ['id', 'life', 'purge', 'fields', 'purged'])) fail('Invalid spot in skin check file.');
  identity(spot.id, 'Spot ID');
  if (!object(spot.life) || !onlyKeys(spot.life, ['value', 'stamp']) || typeof spot.life.value !== 'boolean' || !validStamp(spot.life.stamp) ||
    (spot.purge !== null && !validStamp(spot.purge)) || !object(spot.purged) || !onlyKeys(spot.purged, PURGED_KINDS) ||
    PURGED_KINDS.some(kind => !Array.isArray(spot.purged[kind]) || !spot.purged[kind].every(id => typeof id === 'string' && id.length > 0))) {
    fail('Invalid spot in skin check file.');
  }
  if (spot.purge === null && PURGED_KINDS.some(kind => spot.purged[kind].length)) fail('Invalid spot in skin check file.');
  validateFields(spot.fields, SPOT_FIELDS, 'spot');
}
function validate(person) {
  if (!object(person) || person.schemaVersion !== SCHEMA_VERSION) fail(`Unsupported schemaVersion; expected ${SCHEMA_VERSION}.`);
  if (!onlyKeys(person, ['schemaVersion', 'id', 'fields', 'spots', 'checkIns', 'visits'])) fail('Unknown data in skin check file.');
  identity(person.id, 'Person ID');
  validateFields(person.fields, PERSON_FIELDS, 'person');
  if (!Array.isArray(person.spots) || !Array.isArray(person.checkIns) || !Array.isArray(person.visits)) fail('Invalid skin check file.');
  const spots = new Set();
  for (const spot of person.spots) {
    validateSpot(spot);
    if (spots.has(spot.id)) fail('Duplicate spot ID in skin check file.');
    spots.add(spot.id);
  }
  for (const [list, check, what] of [[person.checkIns, validateCheckIn, 'check-in'], [person.visits, validateVisit, 'visit']]) {
    const ids = new Set();
    for (const record of list) {
      check(record);
      if (ids.has(record.id)) fail(`Duplicate ${what} ID in skin check file.`);
      if (!spots.has(record.spotId)) fail(`A ${what} refers to a spot that is not in the file.`);
      ids.add(record.id);
    }
  }
  return person;
}

// ---- Merge ----

function canonical(person) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: person.id,
    fields: records(person.fields, {}),
    spots: person.spots.map(spot => ({
      id: spot.id, life: clone(spot.life), purge: clone(spot.purge),
      fields: records(spot.fields, {}), purged: unionPurged(spot.purged),
    })).sort(byId),
    checkIns: person.checkIns.map(record => clone(record)).sort(byId),
    visits: person.visits.map(record => clone(record)).sort(byId),
  };
}
function mergeSpot(a, b) {
  if (!a || !b) return clone(a ?? b);
  const purge = latest(a.purge, b.purge);
  let life = register(a.life, b.life);
  if (purge && compareStamps(life.stamp, purge) <= 0) life = { value: false, stamp: clone(purge) };
  return { id: a.id, life, purge: clone(purge), fields: records(a.fields, b.fields, purge), purged: unionPurged(a.purged, b.purged) };
}
// Check-ins and visits never change after they are made: merged as a set by ID.
function mergeSet(left, right, what) {
  const result = new Map(left.map(record => [record.id, record]));
  for (const record of right) {
    const other = result.get(record.id);
    if (other && stable(other) !== stable(record)) fail(`Two different ${what} share the ID "${record.id}".`);
    result.set(record.id, record);
  }
  return [...result.values()].map(record => clone(record));
}
/** Pure, commutative merge of two copies of one person's file. No input is mutated. */
export function mergePeople(left, right) {
  validate(left); validate(right);
  if (left.id !== right.id) fail('Cannot merge files for different people.');
  const a = new Map(left.spots.map(spot => [spot.id, spot]));
  const b = new Map(right.spots.map(spot => [spot.id, spot]));
  const spots = [...new Set([...a.keys(), ...b.keys()])].sort().map(id => mergeSpot(a.get(id), b.get(id)));
  // A record is dropped only when its own spot lists its ID under its own type.
  const purged = kind => new Set(spots.flatMap(spot => spot.purged[kind].map(id => JSON.stringify([spot.id, id]))));
  const [goneCheckIns, goneVisits] = [purged('checkIns'), purged('visits')];
  return canonical(validate({
    schemaVersion: SCHEMA_VERSION,
    id: left.id,
    fields: records(left.fields, right.fields),
    spots,
    // Deleted records leave before the set merge, so an old copy can't clash with a new record that reuses its ID.
    checkIns: mergeSet(...[left.checkIns, right.checkIns].map(list => list.filter(record => !goneCheckIns.has(JSON.stringify([record.spotId, record.id])))), 'check-ins'),
    visits: mergeSet(...[left.visits, right.visits].map(list => list.filter(record => !goneVisits.has(JSON.stringify([record.spotId, record.id])))), 'clinician visits'),
  }));
}
export function serializePerson(person) { return JSON.stringify(canonical(validate(person))); }
export function deserializePerson(json) {
  let value;
  try { value = JSON.parse(json); } catch { fail('Invalid skin check JSON.'); }
  return canonical(validate(value));
}

// ---- Outcomes ----

const ANSWER_WORDS = { yes: 'Yes', no: 'No', notSure: 'Not sure' };
function reasonText(question, given) {
  if (given === null) return `No answer to "${question.text}" (counted as not sure)`;
  return given === 'yes' ? `You answered yes to "${question.text}"` : `You answered not sure to "${question.text}"`;
}
const moreCautious = (a, b) => CAUTION.indexOf(a) >= CAUTION.indexOf(b) ? a : b;
/**
 * Applies the plan's rules to one set of answers. Any urgent "yes" means book
 * soon; any other "yes" or "not sure" (a missing answer counts as not sure)
 * means worth showing a clinician; only all "no" gives no warning sign noted.
 */
export function evaluateAnswers(answers = {}) {
  checkAnswers(answers);
  let outcome = 'noWarningSign';
  const reasons = [];
  for (const question of QUESTIONS) {
    const given = own(answers, question.id) ? answers[question.id] : null;
    if (given === 'no') continue;
    const level = question.urgent && given === 'yes' ? 'bookSoon' : 'worthShowing';
    reasons.push({ question: question.id, answer: given, outcome: level, text: reasonText(question, given) });
    outcome = moreCautious(level, outcome);
  }
  reasons.sort((x, y) => CAUTION.indexOf(y.outcome) - CAUTION.indexOf(x.outcome));
  return { outcome, label: OUTCOMES[outcome], reasons, reminder: REMINDER };
}
const compareCheckIns = (a, b) => instant(a.capturedAt, 'Capture time') - instant(b.capturedAt, 'Capture time') || lex(a.id, b.id);
const compareVisits = (a, b) => instant(a.at, 'Visit time') - instant(b.at, 'Visit time') || lex(a.id, b.id);
const visitView = visit => ({ id: visit.id, at: visit.at, date: visit.at.slice(0, 10), dateOnly: visit.dateOnly, note: visit.note });

function spotState(person, spot) {
  if (spot.life.value) return 'active';
  if (spot.purge && compareStamps(spot.life.stamp, spot.purge) === 0) {
    // A check-in or visit the emptying device never saw brings the spot back.
    const returned = person.checkIns.some(record => record.spotId === spot.id) || person.visits.some(record => record.spotId === spot.id);
    return returned ? 'active' : 'gone';
  }
  return 'trash';
}
function spotView(person, spot) {
  const value = key => spot.fields[key]?.value;
  const place = value('place') ?? { region: 'other', note: '' };
  return {
    id: spot.id,
    region: place.region,
    regionName: REGIONS[place.region],
    note: place.note,
    label: value('label') ?? '',
    createdAt: value('createdAt') ?? null,
    archived: value('archived') ?? false,
    reminder: value('reminder') ?? DEFAULT_REMINDER,
    inTrash: spotState(person, spot) === 'trash',
    returned: spot.purge !== null && !spot.fields.place,
  };
}
function spotOutcomeOf(person, spotId) {
  const checkIns = person.checkIns.filter(record => record.spotId === spotId).sort(compareCheckIns);
  const visit = person.visits.filter(record => record.spotId === spotId).sort(compareVisits).at(-1) ?? null;
  const since = visit ? instant(visit.at, 'Visit time') : -Infinity;
  // Same instant as the visit or later counts as after it, so a tie stays visible.
  const counted = checkIns.filter(record => instant(record.capturedAt, 'Capture time') >= since);
  const base = { visit: visit && visitView(visit), reminder: REMINDER };
  if (visit && !counted.length) {
    return { ...base, outcome: 'notCheckedSinceVisit', label: OUTCOMES.notCheckedSinceVisit, reasons: [],
      prompt: `Seen by a clinician on ${visit.at.slice(0, 10)}. Check this spot again to keep its record going.` };
  }
  if (!counted.length) {
    return { ...base, outcome: 'notCheckedYet', label: OUTCOMES.notCheckedYet, reasons: [], prompt: 'Add a check-in for this spot.' };
  }
  let outcome = 'noWarningSign';
  const reasons = [];
  for (const record of counted) {
    const result = evaluateAnswers(record.answers);
    outcome = moreCautious(result.outcome, outcome);
    for (const reason of result.reasons) reasons.push({ ...reason, checkInId: record.id, capturedAt: record.capturedAt, date: record.capturedAt.slice(0, 10) });
  }
  reasons.sort((x, y) => CAUTION.indexOf(y.outcome) - CAUTION.indexOf(x.outcome));
  return { ...base, outcome, label: OUTCOMES[outcome], reasons };
}

// ---- Visit summary ----

const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[char]);
const GROUPS = Object.freeze([
  { key: 'bookSoon', title: OUTCOMES.bookSoon, outcomes: ['bookSoon'] },
  { key: 'worthShowing', title: OUTCOMES.worthShowing, outcomes: ['worthShowing'] },
  { key: 'notCheckedSinceVisit', title: OUTCOMES.notCheckedSinceVisit, outcomes: ['notCheckedSinceVisit'] },
  { key: 'rest', title: 'Other spots', outcomes: ['noWarningSign', 'notCheckedYet'] },
]);
const answerWord = answer => answer ? ANSWER_WORDS[answer] : 'No answer (counted as not sure)';
const yesNo = value => value ? 'yes' : 'no';
function spotTitle(spot) {
  const place = spot.region === 'other' && spot.note ? `${spot.regionName}: ${spot.note}` : spot.regionName;
  return spot.label ? `${spot.label} (${place})` : `Unnamed spot (${place})`;
}
function historyOf(person, spotId) {
  const entries = [
    ...person.visits.filter(record => record.spotId === spotId).map(record => ({ kind: 'visit', ms: instant(record.at, 'Visit time'), rank: 0, record })),
    ...person.checkIns.filter(record => record.spotId === spotId).map(record => ({ kind: 'checkIn', ms: instant(record.capturedAt, 'Capture time'), rank: 1, record })),
  ];
  return entries.sort((a, b) => a.ms - b.ms || a.rank - b.rank || lex(a.record.id, b.record.id));
}
function buildSummary(person, { date, includeArchived }) {
  const spots = person.spots.filter(spot => spotState(person, spot) === 'active').map(spot => spotView(person, spot))
    .filter(spot => includeArchived || !spot.archived)
    .sort((a, b) => REGION_IDS.indexOf(a.region) - REGION_IDS.indexOf(b.region) || lex(a.label, b.label) || lex(a.id, b.id));
  const groups = GROUPS.map(group => ({
    ...group,
    spots: spots.map(spot => ({ spot, outcome: spotOutcomeOf(person, spot.id), history: historyOf(person, spot.id) }))
      .filter(entry => group.outcomes.includes(entry.outcome.outcome)),
  })).filter(group => group.spots.length);
  const html = [];
  const text = [];
  html.push('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Skin check: visit summary</title>',
    '<style>body{font:16px/1.5 system-ui,sans-serif;margin:2rem;max-width:48rem;color:#1d1b1a;background:#fff}',
    'h2{margin-top:2rem;border-bottom:1px solid #bbb}.reminder{padding:.75rem 1rem;border:2px solid #9b2c1f;border-radius:6px}',
    '.spot{margin:1.25rem 0}.outcome{font-weight:700}li{margin:.15rem 0}</style></head><body>',
    '<h1>Skin check: visit summary</h1>', `<p class="reminder">${escapeHtml(REMINDER)}</p>`,
    `<p>Prepared ${escapeHtml(date)}. ${spots.length} ${spots.length === 1 ? 'spot' : 'spots'}.</p>`);
  text.push('Skin check: visit summary', '', REMINDER, '', `Prepared ${date}. ${spots.length} ${spots.length === 1 ? 'spot' : 'spots'}.`);
  for (const group of groups) {
    html.push(`<h2>${escapeHtml(group.title)}</h2>`);
    text.push('', group.title.toUpperCase());
    for (const { spot, outcome, history } of group.spots) {
      html.push('<section class="spot">', `<h3>${escapeHtml(spotTitle(spot))}</h3>`, `<p class="outcome">${escapeHtml(outcome.label)}</p>`);
      text.push('', spotTitle(spot), `  ${outcome.label}`);
      if (outcome.reasons.length) {
        html.push('<ul>', ...outcome.reasons.map(reason => `<li>${escapeHtml(`${reason.date}: ${reason.text}`)}</li>`), '</ul>');
        for (const reason of outcome.reasons) text.push(`  - ${reason.date}: ${reason.text}`);
      }
      if (outcome.prompt) { html.push(`<p>${escapeHtml(outcome.prompt)}</p>`); text.push(`  ${outcome.prompt}`); }
      if (outcome.outcome === 'noWarningSign') { html.push(`<p>${escapeHtml(REMINDER)}</p>`); text.push(`  ${REMINDER}`); }
      const checked = history.filter(entry => entry.kind === 'checkIn').map(entry => entry.record.capturedAt.slice(0, 10));
      const facts = [`Region: ${spot.regionName}${spot.note ? ` (${spot.note})` : ''}`, `Dates checked: ${checked.length ? checked.join(', ') : 'none yet'}`];
      if (spot.archived) facts.push('Archived');
      html.push(...facts.map(fact => `<p>${escapeHtml(fact)}</p>`));
      text.push(...facts.map(fact => `  ${fact}`));
      for (const entry of history) {
        const record = entry.record;
        if (entry.kind === 'visit') {
          const line = `Seen by a clinician on ${record.at.slice(0, 10)}${record.note ? `: ${record.note}` : ''}`;
          html.push(`<p><strong>${escapeHtml(line)}</strong></p>`);
          text.push(`  ${line}`);
          continue;
        }
        html.push(`<h4>${escapeHtml(`Check-in ${record.capturedAt.slice(0, 10)} (from ${record.source})`)}</h4><ul>`);
        text.push(`  Check-in ${record.capturedAt.slice(0, 10)} (from ${record.source})`);
        for (const question of QUESTIONS) {
          const line = `${question.text} ${answerWord(record.answers[question.id])}`;
          html.push(`<li>${escapeHtml(line)}</li>`);
          text.push(`    - ${line}`);
        }
        html.push('</ul>');
        if (record.worryNote) { html.push(`<p>${escapeHtml(`Your note: ${record.worryNote}`)}</p>`); text.push(`    Your note: ${record.worryNote}`); }
        if (record.photo) {
          const photo = record.photo;
          const line = `Photo reference: ${photo.ref} (distance guide used: ${yesNo(photo.distanceGuide)}; scale marker: ${yesNo(photo.scaleMarker)}; light: ${photo.light})`;
          html.push(`<p>${escapeHtml(line)}</p>`);
          text.push(`    ${line}`);
        }
      }
      html.push('</section>');
    }
  }
  html.push('</body></html>');
  return { html: html.join(''), text: `${text.join('\n')}\n`, groups: groups.map(group => ({ key: group.key, title: group.title, spotIds: group.spots.map(entry => entry.spot.id) })) };
}

// ---- Engine ----

function allStamps(person) {
  const stamps = Object.values(person.fields).map(entry => entry.stamp);
  for (const spot of person.spots) stamps.push(spot.life.stamp, spot.purge, ...Object.values(spot.fields).map(entry => entry.stamp));
  for (const record of [...person.checkIns, ...person.visits]) stamps.push(record.stamp);
  return stamps.filter(Boolean);
}

export class SkinCheck {
  #person;
  #device;
  #now;
  #counter = 0;

  /**
   * new SkinCheck({ deviceId, now, person }) loads an existing file snapshot;
   * without `person` it starts a new file with `personId` and `timeZone`.
   */
  constructor({ deviceId, now = Date.now, person = null, personId = randomUUID(), timeZone = 'UTC' } = {}) {
    this.#device = identity(deviceId, 'Device ID');
    if (typeof now !== 'function') fail('now must be a function returning milliseconds.');
    this.#now = now;
    if (person) {
      this.#person = canonical(validate(clone(person)));
      this.#advance(this.#person);
    } else {
      this.#person = { schemaVersion: SCHEMA_VERSION, id: identity(personId, 'Person ID'), fields: {}, spots: [], checkIns: [], visits: [] };
      this.#person.fields.timeZone = { value: zone(timeZone), stamp: this.#stamp() };
    }
  }

  #stamp() {
    const time = this.#now();
    if (!Number.isSafeInteger(time)) fail('now() must return integer milliseconds.');
    this.#counter += 1;
    return { counter: this.#counter, time, device: this.#device };
  }
  #advance(person) {
    for (const stamp of allStamps(person)) this.#counter = Math.max(this.#counter, stamp.counter);
  }
  get timeZone() { return this.#person.fields.timeZone?.value ?? 'UTC'; }
  get personId() { return this.#person.id; }
  #find(spotId) {
    const spot = this.#person.spots.find(entry => entry.id === spotId);
    if (!spot || spotState(this.#person, spot) === 'gone') fail('No spot with that ID.');
    return spot;
  }
  #active(spotId, action) {
    const spot = this.#find(spotId);
    if (spotState(this.#person, spot) === 'trash') fail(`That spot is in Trash. Restore it before ${action}.`);
    return spot;
  }
  // A permanently deleted record's ID can't be reused: the deletion marker would drop the new record on merge.
  #purged(kind, id) { return this.#person.spots.some(spot => spot.purged[kind].includes(id)); }
  #set(spot, key, value, stamp = this.#stamp()) { setOwn(spot.fields, key, { value: clone(value), stamp }); }

  setTimeZone(timeZone) { this.#person.fields.timeZone = { value: zone(timeZone), stamp: this.#stamp() }; }

  addSpot({ region, note = '', label = '', createdAt } = {}, { id = randomUUID() } = {}) {
    identity(id, 'Spot ID');
    if (this.#person.spots.some(spot => spot.id === id)) fail('A spot with that ID already exists.');
    const place = { region, note: string(note, 'Region note') };
    if (!checkPlace(place)) fail(region === 'other' ? 'A spot in "other" needs a short note saying where it is.' : 'Unknown body region; regions other than "other" take no note.');
    string(label, 'Label');
    const created = createdAt ?? new Date(this.#now()).toISOString();
    instant(created, 'Created time');
    const stamp = this.#stamp();
    const spot = { id, life: { value: true, stamp }, purge: null, fields: {}, purged: noPurged() };
    for (const [key, value] of [['place', place], ['label', label], ['createdAt', created], ['archived', false], ['reminder', DEFAULT_REMINDER]]) this.#set(spot, key, value, stamp);
    this.#person.spots.push(spot);
    this.#person.spots.sort(byId);
    return id;
  }
  renameSpot(spotId, label) { this.#set(this.#active(spotId, 'renaming it'), 'label', string(label, 'Label')); }
  moveSpot(spotId, region, note = '') {
    const place = { region, note: string(note, 'Region note') };
    if (!checkPlace(place)) fail(region === 'other' ? 'A spot in "other" needs a short note saying where it is.' : 'Unknown body region; regions other than "other" take no note.');
    this.#set(this.#active(spotId, 'moving it'), 'place', place);
  }
  archiveSpot(spotId, archived = true) {
    if (typeof archived !== 'boolean') fail('Archived must be true or false.');
    this.#set(this.#active(spotId, 'archiving it'), 'archived', archived);
  }
  setReminder(spotId, setting) {
    if (!validReminder(setting)) fail('Reminder must be "monthly", "off" or a whole number of weeks from 1 to 12.');
    this.#set(this.#active(spotId, 'changing its reminder'), 'reminder', setting);
  }
  removeSpot(spotId) {
    const spot = this.#active(spotId, 'removing it');
    spot.life = { value: false, stamp: this.#stamp() };
  }
  restoreSpot(spotId) {
    const spot = this.#find(spotId);
    if (spotState(this.#person, spot) !== 'trash') fail('That spot is not in Trash.');
    spot.life = { value: true, stamp: this.#stamp() };
  }
  /** Permanently deletes spots in Trash with their check-ins and visits. */
  emptyTrash() {
    const doomed = this.#person.spots.filter(spot => spotState(this.#person, spot) === 'trash');
    if (!doomed.length) return 0;
    const stamp = this.#stamp();
    for (const spot of doomed) {
      const ids = list => list.filter(record => record.spotId === spot.id).map(record => record.id);
      spot.life = { value: false, stamp: clone(stamp) };
      spot.purge = clone(stamp);
      spot.fields = {};
      spot.purged = unionPurged(spot.purged, { checkIns: ids(this.#person.checkIns), visits: ids(this.#person.visits) });
      this.#person.checkIns = this.#person.checkIns.filter(record => record.spotId !== spot.id);
      this.#person.visits = this.#person.visits.filter(record => record.spotId !== spot.id);
    }
    return doomed.length;
  }

  addCheckIn({ spotId, capturedAt, answers = {}, worryNote = '', photo = null, source = 'mac' } = {}, { id = randomUUID() } = {}) {
    identity(id, 'Check-in ID');
    if (typeof spotId !== 'string' || !this.#person.spots.some(spot => spot.id === spotId && spotState(this.#person, spot) !== 'gone')) {
      fail('Cannot add a check-in: there is no spot with that ID.');
    }
    this.#active(spotId, 'adding a check-in');
    if (this.#person.checkIns.some(record => record.id === id) || this.#purged('checkIns', id)) fail('A check-in with that ID already exists or was permanently deleted.');
    instant(capturedAt, 'Capture time');
    if (!SOURCES.includes(source)) fail('Source must be phone, mac or import.');
    const record = {
      id, spotId, capturedAt, answers: clone(checkAnswers(answers)), worryNote: string(worryNote, 'Worry note'),
      photo: clone(checkPhoto(photo)), source, stamp: this.#stamp(),
    };
    this.#person.checkIns.push(record);
    this.#person.checkIns.sort(byId);
    return id;
  }
  /**
   * Records "seen by a clinician". Pass `at` (date and time with UTC offset)
   * or, when only the day is known, `date` (YYYY-MM-DD): that counts from the
   * start of the day in the owner's time zone.
   */
  recordClinicianVisit(spotId, { at, date, note = '' } = {}, { id = randomUUID() } = {}) {
    identity(id, 'Visit ID');
    this.#active(spotId, 'recording a clinician visit');
    if (this.#person.visits.some(record => record.id === id) || this.#purged('visits', id)) fail('A clinician visit with that ID already exists or was permanently deleted.');
    if ((at === undefined) === (date === undefined)) fail('Give either the visit time (at) or, when only the day is known, its date.');
    let when = at;
    if (date !== undefined) {
      if (!validDate(date)) fail('Visit date must be YYYY-MM-DD.');
      when = formatInstant(startOfDay(date, this.timeZone), this.timeZone);
    }
    instant(when, 'Visit time');
    this.#person.visits.push({ id, spotId, at: when, dateOnly: date !== undefined, note: string(note, 'Visit note'), stamp: this.#stamp() });
    this.#person.visits.sort(byId);
    return id;
  }

  spots({ trash = false } = {}) {
    const want = trash ? 'trash' : 'active';
    return this.#person.spots.filter(spot => spotState(this.#person, spot) === want).map(spot => spotView(this.#person, spot))
      .sort((a, b) => REGION_IDS.indexOf(a.region) - REGION_IDS.indexOf(b.region) || lex(a.label, b.label) || lex(a.id, b.id));
  }
  spot(spotId) { return spotView(this.#person, this.#find(spotId)); }
  checkInOutcome(checkInId) {
    const record = this.#person.checkIns.find(entry => entry.id === checkInId) ?? fail('No check-in with that ID.');
    return evaluateAnswers(record.answers);
  }
  spotOutcome(spotId) { this.#find(spotId); return spotOutcomeOf(this.#person, spotId); }

  /** Check-ins in order, the photo pairs to show side by side, and the evolving answers. */
  timeline(spotId) {
    this.#find(spotId);
    const checkIns = this.#person.checkIns.filter(record => record.spotId === spotId).sort(compareCheckIns)
      .map(record => ({ ...clone(record), outcome: evaluateAnswers(record.answers) }));
    const photos = checkIns.filter(record => record.photo);
    const pair = (from, to) => from && to && from.id !== to.id ? { from: from.id, to: to.id } : null;
    let previousAnswer;
    const evolving = checkIns.map((record, index) => {
      const answer = record.answers.evolving ?? null;
      const entry = { checkInId: record.id, capturedAt: record.capturedAt, answer, changed: index > 0 && answer !== previousAnswer };
      previousAnswer = answer;
      return entry;
    });
    return {
      checkIns,
      earliest: checkIns[0]?.id ?? null,
      previous: checkIns.at(-2)?.id ?? null,
      latest: checkIns.at(-1)?.id ?? null,
      photoPairs: { latestWithEarliest: pair(photos[0], photos.at(-1)), latestWithPrevious: pair(photos.at(-2), photos.at(-1)) },
      evolving,
    };
  }

  /** Suggested next check: from the last check-in's date in the owner's time zone, or the spot's created date. */
  nextCheck(spotId) {
    const view = spotView(this.#person, this.#find(spotId));
    const last = this.#person.checkIns.filter(record => record.spotId === spotId).sort(compareCheckIns).at(-1);
    const from = last ? instant(last.capturedAt, 'Capture time') : instant(view.createdAt ?? new Date(this.#now()).toISOString(), 'Created time');
    const anchor = civilDate(from, this.timeZone);
    if (view.reminder === 'off') return { setting: 'off', anchor, due: null };
    const due = view.reminder === 'monthly' ? addMonths(anchor, 1) : addDays(anchor, view.reminder * 7);
    return { setting: view.reminder, anchor, due };
  }

  /** One-page summary for a clinician visit, as self-contained HTML and plain text. */
  visitSummary({ date = civilDate(this.#now(), this.timeZone), includeArchived = false } = {}) {
    if (!validDate(date)) fail('Summary date must be YYYY-MM-DD.');
    return buildSummary(this.#person, { date, includeArchived });
  }

  getPerson() { return canonical(this.#person); }
  save() { return serializePerson(this.#person); }
  load(json) { this.importPerson(deserializePerson(json)); }
  importPerson(snapshot) {
    validate(snapshot);
    if (snapshot.id !== this.#person.id) fail('That file belongs to a different person.');
    this.#person = mergePeople(this.#person, snapshot);
    this.#advance(this.#person);
  }
}
