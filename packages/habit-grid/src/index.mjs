import { randomUUID } from 'node:crypto';

/**
 * Habit grid engine. Standalone on purpose: stamp, merge and purge rules match
 * the household lists engine, rewritten here so this package imports nothing
 * else. Colors are the Ember tokens from brand/tokens.css (October 2026).
 * Civil dates are YYYY-MM-DD in the UTC calendar, so a daylight-saving change
 * cannot skip or repeat a day.
 */

export const SCHEMA_VERSION = 1;
export const KINDS = Object.freeze(['done', 'count', 'amount']);
export const WEEKDAYS = Object.freeze(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
export const WEEK_STARTS = Object.freeze(['sunday', 'monday']);
export const SOURCES = Object.freeze(['manual', 'voice', 'automatic']);
export const SURFACES = Object.freeze(['mac', 'wall', 'phone']);
export const DAY_STATES = Object.freeze(['empty', 'partial', 'full', 'rest', 'open', 'done']);
export const WEEK_STATUSES = Object.freeze(['met', 'inProgress', 'unmet']);
export const RANGE_DAYS = Object.freeze({ mac: 183, wall: 183, phone: 92 });
export const EMBER = Object.freeze({
  background: '#15110f',
  text: '#f7f2ee',
  body: '#cec3bc',
  magenta: '#c8298b',
  coral: '#f37a4a',
  amber: '#f7b267',
});
const COLOR_NAMES = Object.freeze({ magenta: EMBER.magenta, coral: EMBER.coral, amber: EMBER.amber });
const GRAPHIC_CONTRAST = 3;
const TEXT_CONTRAST = 4.5;

const clone = value => structuredClone(value);
const own = (object, key) => Object.hasOwn(object, key);
const lex = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = message => { throw new Error(message); };
const string = (value, label) => typeof value === 'string' ? value : fail(`${label} must be text.`);
const identity = (value, label) => string(value, label).length ? value : fail(`${label} must not be empty.`);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const nonNegative = value => finite(value) && value >= 0;
const setOwn = (target, key, value) => Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
const byId = (a, b) => lex(a.id, b.id);

export function addDays(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
export function weekdayName(iso) {
  return WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}
function validDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [year, month, day] = iso.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}
function weekStartOf(iso, weekStartsOn) {
  const start = WEEKDAYS.indexOf(weekStartsOn);
  const day = WEEKDAYS.indexOf(weekdayName(iso));
  return addDays(iso, -((day - start + 7) % 7));
}
function round6(value) {
  if (!Number.isFinite(value)) return value;
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function compareStamps(a, b) {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  return lex(a.counter, b.counter) || lex(a.time, b.time) || lex(a.device, b.device);
}
const latest = (a, b) => compareStamps(a, b) >= 0 ? a : b;
function validStamp(stamp) {
  return object(stamp) && Number.isSafeInteger(stamp.counter) && stamp.counter > 0 &&
    Number.isSafeInteger(stamp.time) && typeof stamp.device === 'string' && stamp.device.length > 0;
}
function normalizeComparable(value) {
  if (!object(value)) return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : value;
  if (validStamp(value)) return value;
  if (value.type === 'days' && Array.isArray(value.days)) return { type: 'days', days: WEEKDAYS.filter(day => value.days.includes(day)) };
  if (value.type === 'daily') return { type: 'daily' };
  if (value.type === 'timesPerWeek') return { type: 'timesPerWeek', times: value.times };
  return value;
}
function stable(value) {
  const normalized = normalizeComparable(value);
  if (Array.isArray(normalized)) return `[${normalized.map(stable).join(',')}]`;
  if (validStamp(normalized)) return `stamp:${normalized.counter}:${normalized.time}:${normalized.device}`;
  if (object(normalized)) return `{${Object.keys(normalized).sort().map(key => `${key}:${stable(normalized[key])}`).join(',')}}`;
  return JSON.stringify(normalized);
}
function sameValue(a, b) {
  if (a === b) return true;
  if (validStamp(a) && validStamp(b)) return compareStamps(a, b) === 0;
  return stable(a) === stable(b);
}
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
function canonicalizeValue(key, value) {
  if (key === 'color' && typeof value === 'string' && value.startsWith('#')) return value.toLowerCase();
  if (key === 'schedule' && object(value)) return normalizeComparable(value);
  if ((key === 'value' || key === 'target' || key === 'usualAmount') && Object.is(value, -0)) return 0;
  return value;
}
function canonicalizeFields(fields) {
  const prepared = {};
  for (const key of Object.keys(fields).sort()) {
    const entry = fields[key];
    setOwn(prepared, key, { value: canonicalizeValue(key, clone(entry.value)), stamp: clone(entry.stamp) });
  }
  return records(prepared, {});
}
function canonicalRecord(record, withMembers) {
  const result = {
    id: record.id,
    life: clone(record.life),
    purge: clone(record.purge),
    fields: canonicalizeFields(record.fields),
  };
  if (withMembers) result.members = records(record.members ?? {}, {});
  return result;
}
function canonical(person) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: person.id,
    life: clone(person.life),
    purge: clone(person.purge),
    fields: canonicalizeFields(person.fields),
    trackers: person.trackers.map(record => canonicalRecord(record, false)).sort(byId),
    stacks: person.stacks.map(record => canonicalRecord(record, true)).sort(byId),
    checkIns: person.checkIns.map(record => canonicalRecord(record, false)).sort(byId),
    restDays: person.restDays.map(record => canonicalRecord(record, false)).sort(byId),
  };
}
const SHAPE_KEYS = ['kind', 'target', 'unit'];
const TRACKER_KEYS = ['name', 'color', 'kind', 'target', 'unit', 'usualAmount', 'schedule', 'startedOn'];
function trackerShapeValid(fields) {
  if (!object(fields) || !object(fields.kind) || !object(fields.target) || !object(fields.unit)) return false;
  const kind = fields.kind.value;
  const target = fields.target.value;
  const unit = fields.unit.value;
  if (!KINDS.includes(kind) || typeof unit !== 'string') return false;
  if (kind === 'amount') return positive(target) && unit.length > 0;
  if (kind === 'count') return target === null || positive(target);
  return target === null;
}
const RECORD_KEYS = Object.freeze({
  tracker: TRACKER_KEYS,
  stack: ['name'],
  checkIn: ['trackerId', 'date', 'value', 'source'],
  rest: ['date', 'trackerId'],
});
function fieldsPresent(fields, keys) {
  return keys.every(key => object(fields?.[key]) && validStamp(fields[key].stamp));
}
function tombstoneRecord(id, purge, withMembers) {
  const dead = { id, fields: {}, life: { value: false, stamp: clone(purge) }, purge: clone(purge) };
  if (withMembers) dead.members = {};
  return dead;
}
function mergeRecord(a, b, parentPurge, withMembers, recordKind) {
  if (!a) a = { id: b.id, fields: {}, life: b.life, purge: null, ...(withMembers ? { members: {} } : {}) };
  if (!b) b = { id: a.id, fields: {}, life: a.life, purge: null, ...(withMembers ? { members: {} } : {}) };
  const ownPurge = latest(a.purge, b.purge);
  const purge = latest(ownPurge, parentPurge);
  const life = register(a.life, b.life);
  if (compareStamps(life.stamp, purge) <= 0) return tombstoneRecord(a.id, purge, withMembers);
  const result = { id: a.id, fields: records(a.fields, b.fields, purge), life, purge: clone(purge) };
  if (withMembers) result.members = records(a.members ?? {}, b.members ?? {}, purge);
  const kept = Object.keys(result.fields).length > 0 || (withMembers && Object.keys(result.members).length > 0);
  if (purge && !kept) return tombstoneRecord(a.id, purge, withMembers);
  return result;
}
function mergeCollection(left, right, parentPurge, withMembers, recordKind) {
  const ids = [...new Set([...left, ...right].map(record => record.id))].sort();
  const a = new Map(left.map(record => [record.id, record]));
  const b = new Map(right.map(record => [record.id, record]));
  return ids.map(id => mergeRecord(a.get(id), b.get(id), parentPurge, withMembers, recordKind));
}

/** Pure, commutative merge of two copies of the same person file. Neither input changes. */
export function mergePeople(left, right) {
  validate(left); validate(right);
  if (left.id !== right.id) fail('Cannot merge different person IDs.');
  const purge = latest(left.purge, right.purge);
  const life = register(left.life, right.life);
  const result = {
    schemaVersion: SCHEMA_VERSION,
    id: left.id,
    life: compareStamps(life.stamp, purge) <= 0 ? { value: false, stamp: clone(purge) } : life,
    purge: clone(purge),
    fields: records(left.fields, right.fields, purge),
    trackers: mergeCollection(left.trackers, right.trackers, purge, false, 'tracker'),
    stacks: mergeCollection(left.stacks, right.stacks, purge, true, 'stack'),
    checkIns: mergeCollection(left.checkIns, right.checkIns, purge, false, 'checkIn'),
    restDays: mergeCollection(left.restDays, right.restDays, purge, false, 'rest'),
  };
  if (!result.life.value && result.purge && compareStamps(result.life.stamp, result.purge) === 0) {
    result.trackers = [];
    result.stacks = [];
    result.checkIns = [];
    result.restDays = [];
  }
  return canonical(result);
}

function validSchedule(value) {
  if (!object(value) || typeof value.type !== 'string') return false;
  if (value.type === 'daily') return Object.keys(value).length === 1;
  if (value.type === 'timesPerWeek') return Object.keys(value).length === 2 && Number.isSafeInteger(value.times) && value.times >= 1 && value.times <= 7;
  if (value.type === 'days') {
    if (Object.keys(value).length !== 2 || !Array.isArray(value.days) || value.days.length < 1 || value.days.length > 7) return false;
    const seen = new Set();
    for (const day of value.days) {
      if (!WEEKDAYS.includes(day) || seen.has(day)) return false;
      seen.add(day);
    }
    return true;
  }
  return false;
}
function validColor(value) {
  return value === 'magenta' || value === 'coral' || value === 'amber' || (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value));
}
const personFieldTypes = {
  name: value => typeof value === 'string',
  weekStartsOn: value => WEEK_STARTS.includes(value),
};
const trackerFieldTypes = {
  name: value => typeof value === 'string',
  color: validColor,
  kind: value => KINDS.includes(value),
  target: value => value === null || positive(value),
  unit: value => typeof value === 'string',
  usualAmount: value => value === null || positive(value),
  schedule: validSchedule,
  startedOn: validDate,
};
const stackFieldTypes = { name: value => typeof value === 'string' };
const checkInFieldTypes = {
  trackerId: value => typeof value === 'string' && value.length > 0,
  date: validDate,
  value: nonNegative,
  source: value => SOURCES.includes(value),
};
const restFieldTypes = {
  date: validDate,
  trackerId: value => typeof value === 'string',
};
function validateFields(fields, types) {
  if (!object(fields)) fail('Invalid fields in person file.');
  for (const [key, entry] of Object.entries(fields)) {
    if (!own(types, key) || !object(entry) || !validStamp(entry.stamp)) fail('Invalid field or version stamp in person file.');
    if (!types[key](entry.value)) fail('Invalid field value in person file.');
  }
}
function contentBearing(record, withMembers) {
  if (record.life.value) return true;
  if (object(record.fields) && Object.keys(record.fields).length > 0) return true;
  return withMembers && object(record.members) && Object.keys(record.members).length > 0;
}
function survivingFragment(record, types, withMembers) {
  if (!validStamp(record.purge)) return false;
  const keys = Object.keys(types);
  if (keys.every(key => own(record.fields, key))) return false;
  const entries = [...Object.values(record.fields), ...(withMembers ? Object.values(record.members ?? {}) : [])];
  if (entries.length === 0) return false;
  return entries.every(entry => compareStamps(entry.stamp, record.purge) > 0);
}
function validateRecord(record, types, withMembers, checkShape = false) {
  if (!object(record) || typeof record.id !== 'string' || !record.id || !object(record.life) || typeof record.life.value !== 'boolean' || !validStamp(record.life.stamp) || (record.purge !== null && !validStamp(record.purge))) fail('Invalid record in person file.');
  validateFields(record.fields, types);
  if (contentBearing(record, withMembers)) {
    const complete = Object.keys(types).every(key => own(record.fields, key));
    if (!complete && !survivingFragment(record, types, withMembers)) fail('Incomplete record in person file.');
    if (checkShape && SHAPE_KEYS.every(key => own(record.fields, key)) && !trackerShapeValid(record.fields)) fail('Invalid tracker shape in person file.');
  }
  if (withMembers) {
    if (!object(record.members)) fail('Invalid stack members in person file.');
    for (const [key, entry] of Object.entries(record.members)) {
      if (!key || !object(entry) || typeof entry.value !== 'boolean' || !validStamp(entry.stamp)) fail('Invalid stack member in person file.');
    }
  } else if (own(record, 'members')) fail('Invalid record in person file.');
}
function uniqueIds(records, label) {
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record.id)) fail(`Duplicate ${label} ID in person file.`);
    ids.add(record.id);
  }
}
function validate(person) {
  if (!object(person) || person.schemaVersion !== SCHEMA_VERSION) fail(`Unsupported schemaVersion; expected ${SCHEMA_VERSION}.`);
  if (typeof person.id !== 'string' || !person.id || !object(person.life) || typeof person.life.value !== 'boolean' || !validStamp(person.life.stamp) || (person.purge !== null && !validStamp(person.purge))) fail('Invalid record in person file.');
  validateFields(person.fields, personFieldTypes);
  for (const [key, label, types, withMembers, checkShape] of [
    ['trackers', 'tracker', trackerFieldTypes, false, true],
    ['stacks', 'stack', stackFieldTypes, true, false],
    ['checkIns', 'check-in', checkInFieldTypes, false, false],
    ['restDays', 'rest day', restFieldTypes, false, false],
  ]) {
    if (!Array.isArray(person[key])) fail(`Invalid ${label} records in person file.`);
    for (const record of person[key]) validateRecord(record, types, withMembers, checkShape);
    uniqueIds(person[key], label);
  }
  return person;
}
export function serializePerson(person) { return JSON.stringify(validate(person)); }
export function deserializePerson(json) {
  if (typeof json !== 'string') fail('Invalid person JSON.');
  let value;
  try { value = JSON.parse(json); } catch { fail('Invalid person JSON.'); }
  return clone(validate(value));
}

const fieldValues = fields => Object.fromEntries(Object.entries(fields).map(([key, entry]) => [key, clone(entry.value)]));
function present(record) { return object(record) && object(record.fields) && Object.keys(record.fields).length > 0; }
function visible(records, trash, keys) {
  return records.filter(record => record.life.value !== trash && present(record) && keys.every(key => own(record.fields, key))).slice().sort(byId);
}
export function viewPerson(person, { trash = false } = {}) {
  validate(person);
  const fields = fieldValues(person.fields);
  return {
    id: person.id,
    name: fields.name ?? '',
    weekStartsOn: fields.weekStartsOn ?? 'sunday',
    deleted: !person.life.value,
    trackers: visible(person.trackers, trash, RECORD_KEYS.tracker).map(record => ({ id: record.id, ...fieldValues(record.fields) })),
    stacks: visible(person.stacks, trash, RECORD_KEYS.stack).map(record => ({
      id: record.id,
      ...fieldValues(record.fields),
      members: Object.entries(record.members ?? {}).filter(([, entry]) => entry.value).map(([id]) => id).sort(),
    })),
    checkIns: visible(person.checkIns, trash, RECORD_KEYS.checkIn).map(record => ({ id: record.id, ...fieldValues(record.fields) })).sort((a, b) => lex(a.date, b.date) || lex(a.id, b.id)),
    restDays: visible(person.restDays, trash, RECORD_KEYS.rest).map(record => ({ id: record.id, ...fieldValues(record.fields) })).sort((a, b) => lex(a.date, b.date) || lex(a.id, b.id)),
  };
}

function assertSchedule(schedule) {
  if (!validSchedule(schedule)) fail('Invalid schedule.');
  return canonicalizeValue('schedule', schedule);
}
function assertTrackerShape(fields) {
  identity(fields.name, 'Tracker name');
  if (!KINDS.includes(fields.kind)) fail('Invalid tracker kind.');
  if (!validColor(fields.color)) fail('Invalid tracker color.');
  const schedule = assertSchedule(fields.schedule);
  if (!validDate(fields.startedOn)) fail('Invalid start date.');
  if (!(fields.usualAmount === null || positive(fields.usualAmount))) fail('Invalid usual amount.');
  if (typeof fields.unit !== 'string') fail('Invalid unit.');
  if (fields.kind === 'amount') {
    if (!positive(fields.target)) fail('Amount trackers need a target above zero.');
    if (!fields.unit.length) fail('Amount trackers need a unit.');
  } else if (fields.kind === 'count') {
    if (!(fields.target === null || positive(fields.target))) fail('Count target must be empty or above zero.');
  } else if (fields.target !== null) fail('Done trackers do not use a target.');
  return { ...fields, schedule, color: canonicalizeValue('color', fields.color) };
}
function shadeOf(value, target, highest) {
  if (!(value > 0)) return { state: 'empty', shade: 0 };
  if (!(target > 0)) {
    const peak = highest > 0 ? highest : value;
    const fraction = value / peak;
    let shade = 1;
    if (fraction > 0.25) shade = 2;
    if (fraction > 0.5) shade = 3;
    if (fraction > 0.75) shade = 4;
    return { state: 'done', shade };
  }
  if (value >= target) return { state: 'full', shade: 4 };
  const fraction = value / target;
  let shade = 1;
  if (fraction > 0.25) shade = 2;
  if (fraction > 0.5) shade = 3;
  return { state: 'partial', shade };
}
function valuesFor(person, trackerId) {
  const values = new Map();
  for (const checkIn of person.checkIns) {
    if (!checkIn.life.value || !fieldsPresent(checkIn.fields, RECORD_KEYS.checkIn) || checkIn.fields.trackerId.value !== trackerId) continue;
    const date = checkIn.fields.date?.value;
    const amount = checkIn.fields.value?.value;
    if (!validDate(date) || !nonNegative(amount)) continue;
    values.set(date, round6((values.get(date) ?? 0) + amount));
  }
  return values;
}
function restsFor(person, trackerId) {
  const dates = new Set();
  for (const rest of person.restDays) {
    if (!rest.life.value || !fieldsPresent(rest.fields, RECORD_KEYS.rest)) continue;
    const target = rest.fields.trackerId?.value;
    const date = rest.fields.date?.value;
    if (!validDate(date)) continue;
    if (target && target !== trackerId) continue;
    dates.add(date);
  }
  return dates;
}
function readTracker(person, trackerId) {
  const tracker = person.trackers.find(record => record.id === trackerId);
  if (!tracker || !tracker.life.value || !fieldsPresent(tracker.fields, RECORD_KEYS.tracker)) fail('Tracker not found.');
  const fields = fieldValues(tracker.fields);
  if (!KINDS.includes(fields.kind)) fail('Tracker is missing a kind.');
  if (!validSchedule(fields.schedule)) fail('Tracker is missing a schedule.');
  if (!validDate(fields.startedOn)) fail('Tracker is missing a start date.');
  return {
    id: tracker.id,
    name: fields.name ?? '',
    color: fields.color ?? 'coral',
    kind: fields.kind,
    target: fields.kind === 'done' ? 1 : (positive(fields.target) ? fields.target : null),
    storedTarget: fields.target ?? null,
    unit: fields.unit ?? '',
    usualAmount: positive(fields.usualAmount) ? fields.usualAmount : null,
    schedule: fields.schedule,
    startedOn: fields.startedOn,
  };
}
function resolveRange(options, today) {
  if (!validDate(today)) fail('Invalid today date.');
  const hasStart = own(options, 'start');
  const hasEnd = own(options, 'end');
  if (hasStart !== hasEnd) fail('Provide both the start and end dates.');
  if (hasStart) {
    if (!validDate(options.start) || !validDate(options.end) || options.start > options.end) fail('Invalid date range.');
    return { start: options.start, end: options.end };
  }
  const surface = options.surface ?? 'mac';
  if (!SURFACES.includes(surface)) fail('Unknown surface.');
  const days = RANGE_DAYS[surface];
  return { start: addDays(today, -(days - 1)), end: today };
}
function classifyDay({ date, today, tracker, value, highest, ownerRest }) {
  const { schedule, startedOn } = tracker;
  const target = tracker.kind === 'count' && !(tracker.storedTarget > 0) ? null : tracker.target;
  const beforeStart = date < startedOn;
  const chosenOff = schedule.type === 'days' && !schedule.days.includes(weekdayName(date));
  if (ownerRest || (!beforeStart && chosenOff)) return { state: 'rest', shade: 0, due: false, value };
  if (beforeStart) return { state: 'open', shade: 0, due: false, value };
  if (schedule.type === 'timesPerWeek') {
    if (value > 0) {
      const shaded = shadeOf(value, target, highest);
      return { state: 'done', shade: shaded.shade, due: false, value };
    }
    return { state: 'open', shade: 0, due: false, value };
  }
  if (value > 0) {
    const shaded = shadeOf(value, target, highest);
    return { ...shaded, due: true, value };
  }
  if (date >= today) return { state: 'open', shade: 0, due: true, value };
  return { state: 'empty', shade: 0, due: true, value };
}
function peakInRange(tracker, values, rests, start, end) {
  if (tracker.kind === 'count' && positive(tracker.storedTarget)) return 0;
  if (tracker.kind !== 'count') return 0;
  let highest = 0;
  for (let date = start; date <= end; date = addDays(date, 1)) {
    if (date < tracker.startedOn || rests.has(date)) continue;
    if (tracker.schedule.type === 'days' && !tracker.schedule.days.includes(weekdayName(date))) continue;
    const value = values.get(date) ?? 0;
    if (value > highest) highest = value;
  }
  return highest;
}
function weekDone(tracker, values, rests, week) {
  let done = 0;
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(week, offset);
    if (date < tracker.startedOn || rests.has(date)) continue;
    if ((values.get(date) ?? 0) > 0) done += 1;
  }
  return done;
}
function weekStreak(tracker, values, rests, today, weekStartsOn) {
  let current = 0;
  let longest = 0;
  const last = weekStartOf(today, weekStartsOn);
  for (let week = weekStartOf(tracker.startedOn, weekStartsOn); week <= last; week = addDays(week, 7)) {
    const met = weekDone(tracker, values, rests, week) >= tracker.schedule.times;
    const finished = addDays(week, 6) < today;
    if (met) {
      current += 1;
      if (current > longest) longest = current;
    } else if (finished) current = 0;
  }
  return { current, longest, unit: 'week' };
}
function dayStreak(tracker, values, rests, today) {
  let current = 0;
  let longest = 0;
  if (tracker.startedOn > today) return { current, longest, unit: 'day' };
  for (let date = tracker.startedOn; date <= today; date = addDays(date, 1)) {
    const square = classifyDay({
      date, today, tracker, value: values.get(date) ?? 0, highest: 0, ownerRest: rests.has(date),
    });
    if (!square.due) continue;
    if (date === today && square.state !== 'full' && square.state !== 'done') continue;
    if (square.state === 'full' || square.state === 'done') {
      current += 1;
      if (current > longest) longest = current;
    } else current = 0;
  }
  return { current, longest, unit: 'day' };
}
function layout(tracker, person, options) {
  const today = options.today;
  const weekStartsOn = person.fields.weekStartsOn?.value === 'monday' ? 'monday' : 'sunday';
  const { start, end } = resolveRange(options, today);
  const values = valuesFor(person, tracker.id);
  const rests = restsFor(person, tracker.id);
  const highest = peakInRange(tracker, values, rests, start, end);
  const rows = WEEKDAYS.slice(WEEKDAYS.indexOf(weekStartsOn)).concat(WEEKDAYS.slice(0, WEEKDAYS.indexOf(weekStartsOn)));
  const columns = [];
  const squares = [];
  const weekly = tracker.schedule.type === 'timesPerWeek';
  for (let week = weekStartOf(start, weekStartsOn); week <= end; week = addDays(week, 7)) {
    const weekEnd = addDays(week, 6);
    const columnSquares = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const date = addDays(week, offset);
      const classified = classifyDay({
        date, today, tracker, value: values.get(date) ?? 0, highest, ownerRest: rests.has(date),
      });
      const square = { date, weekday: weekdayName(date), ...classified, inRange: date >= start && date <= end };
      columnSquares.push(square);
      squares.push(square);
    }
    const doneDays = weekly ? weekDone(tracker, values, rests, week) : null;
    const times = weekly ? tracker.schedule.times : null;
    let met = null;
    let status = null;
    if (weekly && week <= today) {
      met = doneDays >= times;
      status = weekEnd < today ? (met ? 'met' : 'unmet') : 'inProgress';
    }
    columns.push({ weekStart: week, weekEnd, doneDays, times, met, status, squares: columnSquares });
  }
  squares.sort((a, b) => lex(a.date, b.date));
  const fullLevel = !weekly && !(tracker.kind === 'count' && !(tracker.storedTarget > 0));
  const streaks = weekly ? weekStreak(tracker, values, rests, today, weekStartsOn) : dayStreak(tracker, values, rests, today);
  return {
    personId: person.id,
    id: tracker.id,
    name: tracker.name,
    color: tracker.color,
    kind: tracker.kind,
    unit: tracker.unit,
    target: tracker.kind === 'done' ? null : tracker.storedTarget,
    schedule: clone(tracker.schedule),
    weekStartsOn,
    fullLevel,
    start,
    end,
    today,
    rows,
    columns,
    squares,
    streaks,
  };
}

export function buildGrid(person, trackerId, options = {}) {
  validate(person);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  return layout(readTracker(person, trackerId), person, { ...options, today });
}
function liveStack(person, stackId) {
  const stack = person.stacks.find(record => record.id === stackId);
  if (!stack || !stack.life.value || !fieldsPresent(stack.fields, RECORD_KEYS.stack)) fail('Stack not found.');
  return stack;
}
function stackMembers(person, stack) {
  return Object.entries(stack.members ?? {})
    .filter(([, entry]) => entry.value)
    .map(([id]) => id)
    .sort()
    .flatMap(id => {
      const tracker = person.trackers.find(record => record.id === id);
      return tracker && tracker.life.value && fieldsPresent(tracker.fields, RECORD_KEYS.tracker) ? [readTracker(person, id)] : [];
    });
}
function combineDays(memberDays) {
  if (memberDays.length === 0) return { state: 'open', shade: 0, due: false, value: 0 };
  if (memberDays.every(day => day.state === 'rest')) return { state: 'rest', shade: 0, due: false, value: 0 };
  const active = memberDays.filter(day => day.state !== 'rest');
  const judged = active.filter(day => day.state !== 'open');
  if (judged.length === 0) return { state: 'open', shade: 0, due: false, value: 0 };
  const met = judged.filter(day => day.state === 'full' || day.state === 'done');
  const due = judged.some(day => day.due);
  if (met.length === judged.length) return { state: 'full', shade: 4, due, value: met.length };
  const progressed = judged.some(day => day.state === 'partial' || day.state === 'full' || day.state === 'done');
  if (!progressed) return { state: judged.some(day => day.state === 'empty') ? 'empty' : 'open', shade: 0, due, value: 0 };
  const fraction = met.length / judged.length;
  let shade = 1;
  if (fraction > 0.25) shade = 2;
  if (fraction > 0.5) shade = 3;
  return { state: 'partial', shade, due, value: met.length };
}
export function buildStackGrid(person, stackId, options = {}) {
  validate(person);
  const stack = liveStack(person, stackId);
  const members = stackMembers(person, stack);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const weekStartsOn = person.fields.weekStartsOn?.value === 'monday' ? 'monday' : 'sunday';
  const { start, end } = resolveRange(options, today);
  const prepared = members.map(tracker => ({
    tracker,
    values: valuesFor(person, tracker.id),
    rests: restsFor(person, tracker.id),
    highest: null,
  }));
  for (const entry of prepared) entry.highest = peakInRange(entry.tracker, entry.values, entry.rests, start, end);
  const dayAt = (entry, date) => classifyDay({
    date, today, tracker: entry.tracker, value: entry.values.get(date) ?? 0, highest: entry.highest, ownerRest: entry.rests.has(date),
  });
  const rows = WEEKDAYS.slice(WEEKDAYS.indexOf(weekStartsOn)).concat(WEEKDAYS.slice(0, WEEKDAYS.indexOf(weekStartsOn)));
  const columns = [];
  const squares = [];
  const weekly = members.length > 0 && members.every(tracker => tracker.schedule.type === 'timesPerWeek');
  for (let week = weekStartOf(start, weekStartsOn); week <= end; week = addDays(week, 7)) {
    const columnSquares = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const date = addDays(week, offset);
      const combined = combineDays(prepared.map(entry => dayAt(entry, date)));
      const square = { date, weekday: weekdayName(date), ...combined, inRange: date >= start && date <= end };
      columnSquares.push(square);
      squares.push(square);
    }
    let doneDays = null; let times = null; let met = null; let status = null;
    if (weekly) {
      const active = prepared.filter(entry => entry.tracker.startedOn <= addDays(week, 6));
      doneDays = active.filter(entry => weekDone(entry.tracker, entry.values, entry.rests, week) >= entry.tracker.schedule.times).length;
      times = active.length;
      if (times > 0 && week <= today) {
        met = doneDays >= times;
        status = addDays(week, 6) < today ? (met ? 'met' : 'unmet') : 'inProgress';
      }
    }
    columns.push({ weekStart: week, weekEnd: addDays(week, 6), doneDays, times, met, status, squares: columnSquares });
  }
  squares.sort((a, b) => lex(a.date, b.date));
  const earliest = members.reduce((soonest, tracker) => soonest && soonest < tracker.startedOn ? soonest : tracker.startedOn, null);
  let streaks = { current: 0, longest: 0, unit: weekly ? 'week' : 'day' };
  if (earliest && earliest <= today) {
    if (weekly) {
      const last = weekStartOf(today, weekStartsOn);
      for (let week = weekStartOf(earliest, weekStartsOn); week <= last; week = addDays(week, 7)) {
        const active = prepared.filter(entry => entry.tracker.startedOn <= addDays(week, 6));
        if (active.length === 0) continue;
        const met = active.every(entry => weekDone(entry.tracker, entry.values, entry.rests, week) >= entry.tracker.schedule.times);
        const finished = addDays(week, 6) < today;
        if (met) {
          streaks.current += 1;
          if (streaks.current > streaks.longest) streaks.longest = streaks.current;
        } else if (finished) streaks.current = 0;
      }
    } else {
      for (let date = earliest; date <= today; date = addDays(date, 1)) {
        const square = combineDays(prepared.map(entry => dayAt(entry, date)));
        if (!square.due) continue;
        if (date === today && square.state !== 'full' && square.state !== 'done') continue;
        if (square.state === 'full' || square.state === 'done') {
          streaks.current += 1;
          if (streaks.current > streaks.longest) streaks.longest = streaks.current;
        } else streaks.current = 0;
      }
    }
  }
  return {
    personId: person.id,
    id: stack.id,
    name: stack.fields.name?.value ?? '',
    color: members[0]?.color ?? 'coral',
    kind: 'stack',
    unit: '',
    target: null,
    schedule: null,
    weekStartsOn,
    fullLevel: true,
    start,
    end,
    today,
    rows,
    columns,
    squares,
    streaks,
    members: members.map(tracker => tracker.id),
  };
}

function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(raw)) return null;
  return raw;
}
function channel(hex, offset) {
  const byte = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return byte <= 0.04045 ? byte / 12.92 : ((byte + 0.055) / 1.055) ** 2.4;
}
export function relativeLuminance(hex) {
  const color = normalizeHex(hex) ?? fail('Invalid color.');
  return 0.2126 * channel(color, 1) + 0.7152 * channel(color, 3) + 0.0722 * channel(color, 5);
}
export function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}
function mix(left, right, amount) {
  const blend = index => Math.round(Number.parseInt(left.slice(index, index + 2), 16) + (Number.parseInt(right.slice(index, index + 2), 16) - Number.parseInt(left.slice(index, index + 2), 16)) * amount);
  return `#${[1, 3, 5].map(index => blend(index).toString(16).padStart(2, '0')).join('')}`;
}
function ensureContrast(color, against, minimum) {
  let current = normalizeHex(color) ?? EMBER.coral;
  for (let step = 0; step < 24 && contrastRatio(current, against) < minimum; step += 1) current = mix(current, '#ffffff', 0.18);
  return contrastRatio(current, against) >= minimum ? current : EMBER.text;
}
function markOn(fill) {
  const dark = contrastRatio(EMBER.background, fill);
  const light = contrastRatio('#ffffff', fill);
  if (dark >= GRAPHIC_CONTRAST && dark >= light) return EMBER.background;
  return '#ffffff';
}
function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}
const SHAPE = Object.freeze({
  empty: 'outline', open: 'dashed', partial: 'bars', full: 'check', done: 'diamond', rest: 'rest',
});
function cellShapes(square, ink, mark, outline, text) {
  const shape = SHAPE[square.state] ?? 'outline';
  const parts = [`<title>${escapeXml(`${square.date} ${square.state} shade ${square.shade}`)}</title>`];
  if (square.state === 'full') {
    parts.push(`<rect width="14" height="14" rx="3" fill="${ink}" data-against="${EMBER.background}" data-role="graphic"/>`);
    parts.push(`<path d="M3.2 7.2 L6 10.1 L10.8 4.2" fill="none" stroke="${mark}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" data-against="${ink}" data-role="graphic"/>`);
  } else if (square.state === 'done') {
    const shade = Math.max(1, Math.min(4, square.shade || 1));
    const radius = [3, 4, 5, 6][shade - 1];
    parts.push(`<polygon points="7,1 13,7 7,13 1,7" fill="none" stroke="${outline}" stroke-width="1.4" data-against="${EMBER.background}" data-role="graphic"/>`);
    parts.push(`<polygon points="7,${7 - radius} ${7 + radius},7 7,${7 + radius} ${7 - radius},7" fill="${ink}" data-against="${EMBER.background}" data-role="graphic"/>`);
  } else if (square.state === 'rest') {
    parts.push(`<circle cx="7" cy="7" r="4.5" fill="none" stroke="${text}" stroke-width="1.6" data-against="${EMBER.background}" data-role="graphic"/>`);
    parts.push(`<line x1="3.2" y1="7" x2="10.8" y2="7" stroke="${text}" stroke-width="1.6" stroke-linecap="round" data-against="${EMBER.background}" data-role="graphic"/>`);
  } else if (square.state === 'partial') {
    parts.push(`<rect width="14" height="14" rx="3" fill="none" stroke="${outline}" stroke-width="1.4" data-against="${EMBER.background}" data-role="graphic"/>`);
    const bars = Math.max(1, Math.min(3, square.shade));
    for (let index = 0; index < bars; index += 1) {
      const y = 11 - index * 3;
      parts.push(`<rect x="2" y="${y}" width="10" height="2" rx="1" fill="${ink}" data-against="${EMBER.background}" data-role="graphic"/>`);
    }
  } else if (square.state === 'open') {
    parts.push(`<rect x="1" y="1" width="12" height="12" rx="3" fill="none" stroke="${text}" stroke-width="1.4" stroke-dasharray="2 2" data-against="${EMBER.background}" data-role="graphic"/>`);
  } else {
    parts.push(`<rect x="1" y="1" width="12" height="12" rx="3" fill="none" stroke="${outline}" stroke-width="1.4" data-against="${EMBER.background}" data-role="graphic"/>`);
  }
  return { shape, body: parts.join('') };
}
export function renderSvg(grid) {
  if (!object(grid) || !Array.isArray(grid.columns) || !Array.isArray(grid.rows)) fail('Invalid grid.');
  const background = EMBER.background;
  const text = EMBER.text;
  const outline = EMBER.body;
  const requested = COLOR_NAMES[grid.color] ?? normalizeHex(grid.color) ?? EMBER.coral;
  const ink = ensureContrast(requested, background, GRAPHIC_CONTRAST);
  const mark = markOn(ink);
  const cell = 14;
  const gap = 4;
  const left = 22;
  const top = 20;
  const width = left + Math.max(grid.columns.length, 1) * (cell + gap) + 8;
  const height = top + grid.rows.length * (cell + gap) + 8;
  const initials = { sunday: 'S', monday: 'M', tuesday: 'T', wednesday: 'W', thursday: 'T', friday: 'F', saturday: 'S' };
  const chunks = [];
  chunks.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="habit-title habit-desc">`);
  chunks.push(`<title id="habit-title">${escapeXml(grid.name || 'Habit grid')}</title>`);
  chunks.push(`<desc id="habit-desc">${escapeXml(`Days from ${grid.start} to ${grid.end}. Week starts on ${grid.weekStartsOn}. Full days show a check mark. Rest days show a circle and a bar. Done days show a diamond that grows with the shade. Partial days show bars. Open days are dashed. Empty days are an outline.`)}</desc>`);
  chunks.push(`<rect width="${width}" height="${height}" fill="${background}" data-role="background"/>`);
  grid.rows.forEach((weekday, index) => {
    const y = top + index * (cell + gap) + 11;
    chunks.push(`<text x="4" y="${y}" fill="${text}" font-family="Atkinson Hyperlegible Next, sans-serif" font-size="10" data-against="${background}" data-role="text">${initials[weekday] ?? ''}</text>`);
  });
  grid.columns.forEach((column, columnIndex) => {
    column.squares.forEach((square, rowIndex) => {
      const x = left + columnIndex * (cell + gap);
      const y = top + rowIndex * (cell + gap);
      const drawn = cellShapes(square, ink, mark, outline, text);
      chunks.push(`<g data-date="${square.date}" data-state="${square.state}" data-shade="${square.shade}" data-shape="${drawn.shape}" transform="translate(${x} ${y})">${drawn.body}</g>`);
    });
  });
  chunks.push('</svg>');
  return chunks.join('');
}

function findRecord(records, id, label) {
  return records.find(record => record.id === id) ?? fail(`${label} not found.`);
}
function editable(records, id, label) {
  const record = findRecord(records, id, label);
  if (record.purge && !present(record)) fail(`${label} was emptied from Trash.`);
  return record;
}
function active(records, id, label, keys) {
  const record = editable(records, id, label);
  if (!record.life.value) fail(`${label} is in Trash.`);
  if (!fieldsPresent(record.fields, keys)) fail(`${label} not found.`);
  return record;
}
function stampedFields(entries, stamp) {
  const fields = {};
  for (const [key, value] of entries) setOwn(fields, key, { value: clone(canonicalizeValue(key, value)), stamp: clone(stamp) });
  return fields;
}
function collectStamps(person) {
  const stamps = [person.life?.stamp, person.purge];
  for (const entry of Object.values(person.fields ?? {})) stamps.push(entry.stamp);
  for (const collection of [person.trackers, person.stacks, person.checkIns, person.restDays]) {
    for (const record of collection ?? []) {
      stamps.push(record.life?.stamp, record.purge);
      for (const entry of Object.values(record.fields ?? {})) stamps.push(entry.stamp);
      for (const entry of Object.values(record.members ?? {})) stamps.push(entry.stamp);
    }
  }
  return stamps.filter(Boolean);
}

/** One writer per unique device ID. State is held only in memory. */
export class HabitGrid {
  #people = new Map();
  #counter = 0;
  constructor({ deviceId, now = Date.now } = {}) {
    this.deviceId = identity(deviceId, 'Device ID');
    if (typeof now !== 'function') fail('Invalid clock.');
    this.now = now;
  }
  #today() {
    const time = this.now();
    if (!Number.isSafeInteger(time)) fail('Invalid clock.');
    return new Date(time).toISOString().slice(0, 10);
  }
  #observe(person) {
    for (const stamp of collectStamps(person)) this.#counter = Math.max(this.#counter, stamp.counter);
  }
  #stamp() {
    const time = this.now();
    if (!Number.isSafeInteger(time) || this.#counter >= Number.MAX_SAFE_INTEGER) fail('Invalid clock or exhausted logical counter.');
    return { counter: ++this.#counter, time, device: this.deviceId };
  }
  #get(id) { return this.#people.get(id) ?? fail('Person not found.'); }
  #change(id, operation) {
    const draft = clone(this.#get(id));
    const stamp = this.#stamp();
    let next;
    try {
      operation(draft, stamp);
      next = canonical(draft);
    } catch (error) {
      this.#counter -= 1;
      throw error;
    }
    this.#people.set(id, next);
    return clone(next);
  }
  createPerson(name, { id = randomUUID(), weekStartsOn = 'sunday' } = {}) {
    identity(name, 'Person name');
    identity(id, 'Person ID');
    if (!WEEK_STARTS.includes(weekStartsOn)) fail('Unknown week start.');
    if (this.#people.has(id)) fail('Person ID already exists.');
    const stamp = this.#stamp();
    this.#people.set(id, canonical({
      schemaVersion: SCHEMA_VERSION,
      id,
      life: { value: true, stamp },
      purge: null,
      fields: stampedFields([['name', name], ['weekStartsOn', weekStartsOn]], stamp),
      trackers: [],
      stacks: [],
      checkIns: [],
      restDays: [],
    }));
    return id;
  }
  personIds({ trash = false } = {}) {
    return [...this.#people.values()].filter(person => person.life.value !== trash && Object.keys(person.fields).length).map(person => person.id).sort();
  }
  getPerson(id) { return clone(this.#get(id)); }
  view(id, options) { return viewPerson(this.#get(id), options); }
  renamePerson(id, name) {
    identity(name, 'Person name');
    return this.#change(id, (person, stamp) => {
      person.fields.name = { value: name, stamp };
      person.life = { value: true, stamp };
    });
  }
  setWeekStartsOn(id, weekStartsOn) {
    if (!WEEK_STARTS.includes(weekStartsOn)) fail('Unknown week start.');
    return this.#change(id, (person, stamp) => {
      person.fields.weekStartsOn = { value: weekStartsOn, stamp };
      person.life = { value: true, stamp };
    });
  }
  deletePerson(id) { return this.#change(id, (person, stamp) => { person.life = { value: false, stamp }; }); }
  restorePerson(id) {
    if (!Object.keys(this.#get(id).fields).length) fail('Person was emptied from Trash.');
    return this.#change(id, (person, stamp) => { person.life = { value: true, stamp }; });
  }
  addTracker(personId, input, { trackerId = randomUUID() } = {}) {
    if (!object(input)) fail('Tracker fields must be an object.');
    identity(trackerId, 'Tracker ID');
    const today = this.#today();
    const fields = assertTrackerShape({
      color: 'coral', target: null, unit: '', usualAmount: null, schedule: { type: 'daily' }, startedOn: today, ...input,
    });
    this.#change(personId, (person, stamp) => {
      const index = person.trackers.findIndex(record => record.id === trackerId);
      if (index >= 0 && fieldsPresent(person.trackers[index].fields, RECORD_KEYS.tracker)) fail('Tracker ID already exists.');
      const purge = index >= 0 ? person.trackers[index].purge : null;
      if (index >= 0) person.trackers.splice(index, 1);
      person.trackers.push({
        id: trackerId,
        life: { value: true, stamp },
        purge,
        fields: stampedFields([
          ['name', fields.name], ['color', fields.color], ['kind', fields.kind], ['target', fields.target],
          ['unit', fields.unit], ['usualAmount', fields.usualAmount], ['schedule', fields.schedule], ['startedOn', fields.startedOn],
        ], stamp),
      });
      person.life = { value: true, stamp };
    });
    return trackerId;
  }
  editTracker(personId, trackerId, input) {
    if (!object(input) || Object.keys(input).length === 0) fail('Tracker changes are empty.');
    const current = fieldValues(editable(this.#get(personId).trackers, trackerId, 'Tracker').fields);
    const next = assertTrackerShape({ ...current, ...input });
    return this.#change(personId, (person, stamp) => {
      const tracker = editable(person.trackers, trackerId, 'Tracker');
      const shapeTouched = SHAPE_KEYS.some(key => own(input, key));
      for (const key of ['name', 'color', 'kind', 'target', 'unit', 'usualAmount', 'schedule', 'startedOn']) {
        if (own(input, key) || (shapeTouched && SHAPE_KEYS.includes(key))) tracker.fields[key] = { value: next[key], stamp: clone(stamp) };
      }
      tracker.life = { value: true, stamp };
      person.life = { value: true, stamp };
    });
  }
  deleteTracker(personId, trackerId) {
    return this.#change(personId, (person, stamp) => {
      const tracker = editable(person.trackers, trackerId, 'Tracker');
      tracker.life = { value: false, stamp };
      person.life = { value: true, stamp };
    });
  }
  restoreTracker(personId, trackerId) {
    return this.#change(personId, (person, stamp) => {
      const tracker = editable(person.trackers, trackerId, 'Tracker');
      tracker.life = { value: true, stamp };
      person.life = { value: true, stamp };
    });
  }
  addStack(personId, input, { stackId = randomUUID() } = {}) {
    if (!object(input)) fail('Stack fields must be an object.');
    identity(input.name, 'Stack name');
    identity(stackId, 'Stack ID');
    const members = Array.isArray(input.members) ? input.members : [];
    for (const member of members) identity(member, 'Stack member');
    this.#change(personId, (person, stamp) => {
      const index = person.stacks.findIndex(record => record.id === stackId);
      if (index >= 0 && fieldsPresent(person.stacks[index].fields, RECORD_KEYS.stack)) fail('Stack ID already exists.');
      const purge = index >= 0 ? person.stacks[index].purge : null;
      if (index >= 0) person.stacks.splice(index, 1);
      const memberMap = {};
      for (const member of [...new Set(members)].sort()) {
        if (!person.trackers.some(record => record.id === member && record.life.value && fieldsPresent(record.fields, RECORD_KEYS.tracker))) fail('Tracker not found.');
        setOwn(memberMap, member, { value: true, stamp: clone(stamp) });
      }
      person.stacks.push({ id: stackId, life: { value: true, stamp }, purge, fields: stampedFields([['name', input.name]], stamp), members: memberMap });
      person.life = { value: true, stamp };
    });
    return stackId;
  }
  renameStack(personId, stackId, name) {
    identity(name, 'Stack name');
    return this.#change(personId, (person, stamp) => {
      const stack = editable(person.stacks, stackId, 'Stack');
      stack.fields.name = { value: name, stamp };
      stack.life = { value: true, stamp };
      person.life = { value: true, stamp };
    });
  }
  setStackMember(personId, stackId, trackerId, included) {
    identity(trackerId, 'Stack member');
    if (typeof included !== 'boolean') fail('Stack membership must be a boolean.');
    return this.#change(personId, (person, stamp) => {
      const stack = editable(person.stacks, stackId, 'Stack');
      if (included && !person.trackers.some(record => record.id === trackerId && record.life.value && fieldsPresent(record.fields, RECORD_KEYS.tracker))) fail('Tracker not found.');
      setOwn(stack.members, trackerId, { value: included, stamp });
      stack.life = { value: true, stamp };
      person.life = { value: true, stamp };
    });
  }
  deleteStack(personId, stackId) {
    return this.#change(personId, (person, stamp) => {
      const stack = editable(person.stacks, stackId, 'Stack');
      stack.life = { value: false, stamp };
      person.life = { value: true, stamp };
    });
  }
  restoreStack(personId, stackId) {
    return this.#change(personId, (person, stamp) => {
      const stack = editable(person.stacks, stackId, 'Stack');
      stack.life = { value: true, stamp };
      person.life = { value: true, stamp };
    });
  }
  logCheckIn(personId, trackerId, { date, value, source = 'manual', checkInId = randomUUID() } = {}) {
    identity(checkInId, 'Check-in ID');
    if (source !== 'manual') fail('Only manual check-ins can be written in this version.');
    const tracker = active(this.#get(personId).trackers, trackerId, 'Tracker', RECORD_KEYS.tracker);
    const day = date ?? this.#today();
    if (!validDate(day)) fail('Invalid date.');
    let amount = value;
    if (amount === undefined) {
      if (tracker.fields.kind.value !== 'done') fail('Count and amount check-ins need a value.');
      amount = 1;
    }
    if (!nonNegative(amount)) fail('Check-in value must be zero or greater.');
    this.#change(personId, (person, stamp) => {
      const index = person.checkIns.findIndex(record => record.id === checkInId);
      if (index >= 0 && fieldsPresent(person.checkIns[index].fields, RECORD_KEYS.checkIn)) fail('Check-in ID already exists.');
      const purge = index >= 0 ? person.checkIns[index].purge : null;
      if (index >= 0) person.checkIns.splice(index, 1);
      person.checkIns.push({
        id: checkInId,
        life: { value: true, stamp },
        purge,
        fields: stampedFields([['trackerId', trackerId], ['date', day], ['value', amount], ['source', 'manual']], stamp),
      });
      person.life = { value: true, stamp };
    });
    return checkInId;
  }
  editCheckIn(personId, checkInId, input = {}) {
    if (!object(input)) fail('Check-in changes must be an object.');
    if (own(input, 'source') && input.source !== 'manual') fail('Only manual check-ins can be written in this version.');
    if (own(input, 'date') && !validDate(input.date)) fail('Invalid date.');
    if (own(input, 'value') && !nonNegative(input.value)) fail('Check-in value must be zero or greater.');
    if (own(input, 'trackerId')) identity(input.trackerId, 'Tracker ID');
    return this.#change(personId, (person, stamp) => {
      const checkIn = editable(person.checkIns, checkInId, 'Check-in');
      if (own(input, 'trackerId')) active(person.trackers, input.trackerId, 'Tracker', RECORD_KEYS.tracker);
      for (const key of ['trackerId', 'date', 'value', 'source']) {
        if (own(input, key)) checkIn.fields[key] = { value: input[key], stamp: clone(stamp) };
      }
      checkIn.life = { value: true, stamp };
      person.life = { value: true, stamp };
    });
  }
  deleteCheckIn(personId, checkInId) {
    return this.#change(personId, (person, stamp) => {
      const checkIn = editable(person.checkIns, checkInId, 'Check-in');
      checkIn.life = { value: false, stamp };
      person.life = { value: true, stamp };
    });
  }
  restoreCheckIn(personId, checkInId) {
    return this.#change(personId, (person, stamp) => {
      const checkIn = editable(person.checkIns, checkInId, 'Check-in');
      checkIn.life = { value: true, stamp };
      person.life = { value: true, stamp };
    });
  }
  markRest(personId, date, { trackerId = '', restId = randomUUID() } = {}) {
    if (!validDate(date)) fail('Invalid date.');
    if (trackerId) identity(trackerId, 'Tracker ID');
    identity(restId, 'Rest day ID');
    const person = this.#get(personId);
    if (trackerId) active(person.trackers, trackerId, 'Tracker', RECORD_KEYS.tracker);
    const existing = person.restDays.find(rest => rest.life.value && fieldsPresent(rest.fields, RECORD_KEYS.rest) && rest.fields.date.value === date && rest.fields.trackerId.value === trackerId);
    if (existing) return existing.id;
    this.#change(personId, (draft, stamp) => {
      const index = draft.restDays.findIndex(record => record.id === restId);
      if (index >= 0 && fieldsPresent(draft.restDays[index].fields, RECORD_KEYS.rest)) fail('Rest day ID already exists.');
      const purge = index >= 0 ? draft.restDays[index].purge : null;
      if (index >= 0) draft.restDays.splice(index, 1);
      draft.restDays.push({
        id: restId,
        life: { value: true, stamp },
        purge,
        fields: stampedFields([['date', date], ['trackerId', trackerId]], stamp),
      });
      draft.life = { value: true, stamp };
    });
    return restId;
  }
  deleteRest(personId, restId) {
    return this.#change(personId, (person, stamp) => {
      const rest = editable(person.restDays, restId, 'Rest day');
      rest.life = { value: false, stamp };
      person.life = { value: true, stamp };
    });
  }
  restoreRest(personId, restId) {
    return this.#change(personId, (person, stamp) => {
      const rest = editable(person.restDays, restId, 'Rest day');
      rest.life = { value: true, stamp };
      person.life = { value: true, stamp };
    });
  }
  checkStack(personId, stackId, { date } = {}) {
    const day = date ?? this.#today();
    if (!validDate(day)) fail('Invalid date.');
    const person = this.#get(personId);
    const stack = active(person.stacks, stackId, 'Stack', RECORD_KEYS.stack);
    const memberIds = Object.entries(stack.members ?? {}).filter(([, entry]) => entry.value).map(([id]) => id).sort();
    const plan = [];
    const needsValue = [];
    for (const trackerId of memberIds) {
      const tracker = person.trackers.find(record => record.id === trackerId);
      if (!tracker || !tracker.life.value || !fieldsPresent(tracker.fields, RECORD_KEYS.tracker)) continue;
      const kind = tracker.fields.kind.value;
      if (kind === 'done') plan.push({ trackerId, kind, value: 1, name: tracker.fields.name.value });
      else if (positive(tracker.fields.usualAmount?.value)) plan.push({ trackerId, kind, value: tracker.fields.usualAmount.value, name: tracker.fields.name.value });
      else needsValue.push({ trackerId, name: tracker.fields.name.value, kind });
    }
    const written = [];
    if (plan.length) {
      this.#change(personId, (draft, stamp) => {
        for (const item of plan) {
          const checkInId = randomUUID();
          draft.checkIns.push({
            id: checkInId,
            life: { value: true, stamp },
            purge: null,
            fields: stampedFields([['trackerId', item.trackerId], ['date', day], ['value', item.value], ['source', 'manual']], stamp),
          });
          written.push({ trackerId: item.trackerId, checkInId, value: item.value, kind: item.kind });
        }
        draft.life = { value: true, stamp };
      });
    }
    return { date: day, written, needsValue };
  }
  emptyTrash(id) {
    return this.#change(id, (person, stamp) => {
      if (!person.life.value) {
        person.fields = {};
        person.trackers = [];
        person.stacks = [];
        person.checkIns = [];
        person.restDays = [];
        person.purge = stamp;
        person.life = { value: false, stamp };
      } else {
        for (const collection of [person.trackers, person.stacks, person.checkIns, person.restDays]) {
          for (const record of collection) if (!record.life.value) {
            record.fields = {};
            if (record.members) record.members = {};
            record.purge = stamp;
            record.life = { value: false, stamp };
          }
        }
      }
    });
  }
  grid(personId, trackerId, options = {}) {
    return buildGrid(this.#get(personId), trackerId, { today: this.#today(), ...options });
  }
  stackGrid(personId, stackId, options = {}) {
    return buildStackGrid(this.#get(personId), stackId, { today: this.#today(), ...options });
  }
  svg(personId, trackerId, options = {}) { return renderSvg(this.grid(personId, trackerId, options)); }
  stackSvg(personId, stackId, options = {}) { return renderSvg(this.stackGrid(personId, stackId, options)); }
  importPerson(person) {
    validate(person);
    const existing = this.#people.get(person.id);
    const merged = existing ? mergePeople(existing, person) : canonical(person);
    this.#observe(merged);
    this.#people.set(person.id, merged);
    return this.getPerson(person.id);
  }
  load(json) { return this.importPerson(deserializePerson(json)); }
  save(id) { return serializePerson(this.#get(id)); }
}
