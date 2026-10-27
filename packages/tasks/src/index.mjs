/**
 * Tasks and reminders engine. In-memory, one JSON document per person.
 * The caller passes every instant. The engine never reads the clock, the
 * machine's time zone, the network, or the disk.
 *
 * Sync shape follows the household lists engine: permanent ids, version
 * stamps (counter, then time, then device), field-level merge, and purge
 * markers. Completions, skips, snoozes, reopens and drops are records in a
 * set. The next due date is computed from the winning repeat and the records
 * that still count; it is not a field two devices can race.
 */

import { randomUUID } from 'node:crypto';
import {
  addDays, assertTimeZone, civilDate, startOfNextDay, validDate, validDateTime, validTime,
  wallClock, wallToInstant,
} from './time.mjs';
import {
  canonicalRepeat, normalizeRepeat, occurrenceDates, onScheduleNext, shiftAfterDone,
} from './repeat.mjs';

export { occurrenceDates } from './repeat.mjs';
export { civilDate, wallClock, wallToInstant } from './time.mjs';

export const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const PERSON_KEYS = Object.freeze(['timeZone', 'dayStart']);
const TASK_KEYS = Object.freeze(['title', 'note', 'list', 'priority', 'state', 'due', 'repeat', 'reminders']);
const RECORD_KEYS = Object.freeze(['withdrawn', 'seen', 'reminderAt', 'due', 'replaces']);
const TASK_DEFAULTS = Object.freeze({
  title: '', note: '', list: null, priority: null, state: 'open', due: null, repeat: null, reminders: [],
});

const clone = value => structuredClone(value);
const own = (object, key) => Object.hasOwn(object, key);
const lex = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = message => { throw new Error(message); };
const string = (value, label) => typeof value === 'string' ? value : fail(`${label} must be text.`);
const identity = (value, label) => {
  const text = string(value, label);
  if (!text.length || text.length > 200) fail(`${label} must not be empty.`);
  return text;
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const setOwn = (target, key, value) => Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });

export function compareStamps(a, b) {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  return lex(a.counter, b.counter) || lex(a.time, b.time) || lex(a.device, b.device);
}
const latest = (a, b) => compareStamps(a, b) >= 0 ? a : b;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${key}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sameValue(a, b) {
  return a === b || (object(a) && object(b) && stable(a) === stable(b)) || (Array.isArray(a) && Array.isArray(b) && stable(a) === stable(b));
}
function canonicalStamp(stamp) {
  return stamp ? { counter: stamp.counter, time: stamp.time, device: stamp.device } : null;
}
function register(a, b) {
  if (!a) return clone(b);
  if (!b) return clone(a);
  const order = compareStamps(a.stamp, b.stamp);
  if (!order && !sameValue(a.value, b.value)) fail('Conflicting values share a version stamp. Use a unique device ID per writer.');
  return clone(order >= 0 ? a : b);
}
function fieldMap(entries) {
  const result = {};
  for (const [key, value] of entries) setOwn(result, key, value);
  return result;
}
function records(a, b, purge = null) {
  const result = {};
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const value = register(own(a, key) ? a[key] : undefined, own(b, key) ? b[key] : undefined);
    if (!purge || compareStamps(value.stamp, purge) > 0) setOwn(result, key, value);
  }
  return result;
}

function canonicalDue(due) {
  if (!due) return null;
  if (due.kind === 'date') return { kind: 'date', date: due.date };
  return { kind: 'dateTime', dateTime: due.dateTime, timeZone: due.timeZone };
}
function canonicalReminder(reminder) {
  if (reminder.kind === 'offset') return { id: reminder.id, kind: 'offset', days: reminder.days, hours: reminder.hours, minutes: reminder.minutes };
  return { id: reminder.id, kind: 'fixed', dateTime: reminder.dateTime, timeZone: reminder.timeZone, occurrence: reminder.occurrence ?? null };
}
function canonicalWall(wall) {
  return wall ? { dateTime: wall.dateTime, timeZone: wall.timeZone } : null;
}
function canonicalValue(key, value) {
  if (key === 'repeat') return canonicalRepeat(value);
  if (key === 'due' || key === 'reminderAt') return key === 'due' ? canonicalDue(value) : canonicalWall(value);
  if (key === 'reminders') return value.map(canonicalReminder);
  if (key === 'seen') return value.slice().sort();
  return clone(value);
}
function canonicalFields(fields, order) {
  const result = {};
  for (const key of order) if (own(fields, key)) setOwn(result, key, { value: canonicalValue(key, fields[key].value), stamp: canonicalStamp(fields[key].stamp) });
  return result;
}
function canonicalRecord(record) {
  return {
    id: record.id,
    type: record.type,
    occurrence: record.occurrence ?? null,
    instant: record.instant,
    actionDate: record.actionDate,
    actionZone: record.actionZone,
    stamp: canonicalStamp(record.stamp),
    fields: canonicalFields(record.fields, RECORD_KEYS),
  };
}
function canonicalTask(task) {
  const result = {
    id: task.id,
    life: { value: task.life.value, stamp: canonicalStamp(task.life.stamp) },
    purge: canonicalStamp(task.purge),
    fields: canonicalFields(task.fields, TASK_KEYS),
    records: task.records.map(canonicalRecord).sort((a, b) => lex(a.id, b.id)),
  };
  if (task.pendingLife) result.pendingLife = { value: task.pendingLife.value, stamp: canonicalStamp(task.pendingLife.stamp) };
  return result;
}
function canonical(person) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: person.id,
    fields: canonicalFields(person.fields, PERSON_KEYS),
    tasks: person.tasks.map(canonicalTask).sort((a, b) => lex(a.id, b.id)),
  };
}

function validStamp(stamp) {
  return object(stamp) && exactOwn(stamp, ['counter', 'time', 'device']) && Number.isSafeInteger(stamp.counter) && stamp.counter > 0 &&
    Number.isSafeInteger(stamp.time) && typeof stamp.device === 'string' && stamp.device.length > 0 && stamp.device.length <= 200;
}
function exactKeys(value, keys) {
  if (!object(value)) fail('Invalid task in task file.');
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('Unknown field in task file.');
  for (const key of keys) if (!own(value, key)) fail('Invalid task in task file.');
}
function checkLifeRegister(entry) {
  exactKeys(entry, ['value', 'stamp']);
  if (typeof entry.value !== 'boolean' || !validStamp(entry.stamp)) fail('Invalid task in task file.');
}
function checkRegister(entry) {
  if (!object(entry) || !validStamp(entry.stamp) || !exactOwn(entry, ['value', 'stamp'])) fail('Invalid field or version stamp in task file.');
}
function exactOwn(value, keys) {
  if (!object(value)) return false;
  const allowed = new Set(keys);
  const present = Object.keys(value);
  return present.length === keys.length && present.every(key => allowed.has(key));
}

function dueCalendar(due) {
  if (!due) return null;
  return due.kind === 'date' ? due.date : due.dateTime.slice(0, 10);
}
function scheduledDue(template, date) {
  if (!template || !date) return null;
  if (template.kind === 'date') return { kind: 'date', date };
  return { kind: 'dateTime', dateTime: `${date}T${template.dateTime.slice(11, 16)}`, timeZone: template.timeZone };
}
function occurrenceName(template, date) {
  if (!date) return null;
  const due = scheduledDue(template, date);
  if (!due || due.kind === 'date') return date;
  return `${due.dateTime}[${due.timeZone}]`;
}
function occurrenceDateOf(name) {
  if (!name) return null;
  return validDate(name.slice(0, 10)) ? name.slice(0, 10) : null;
}
function compareOccurrence(a, b) {
  const left = occurrenceDateOf(a);
  const right = occurrenceDateOf(b);
  const leftTime = a && a.includes('T') ? a.slice(11, 16) : '';
  const rightTime = b && b.includes('T') ? b.slice(11, 16) : '';
  const leftZone = a && a.includes('[') ? a.slice(a.indexOf('[') + 1, -1) : '';
  const rightZone = b && b.includes('[') ? b.slice(b.indexOf('[') + 1, -1) : '';
  return lex(left ?? '', right ?? '') || lex(leftTime, rightTime) || lex(leftZone, rightZone);
}
function publicDue(due) {
  if (!due) return null;
  if (due.kind === 'date') return { kind: 'date', date: due.date };
  const instant = wallToInstant(due.dateTime, due.timeZone);
  return { kind: 'dateTime', dateTime: due.dateTime, timeZone: due.timeZone, instant, resolved: wallClock(instant, due.timeZone) };
}
function publicRepeat(rule) {
  if (!rule) return null;
  return {
    kind: rule.kind,
    every: rule.every,
    mode: rule.mode,
    weekdays: rule.weekdays ? rule.weekdays.slice() : null,
    monthDay: rule.monthDay ?? null,
    weekday: rule.weekday ?? null,
    which: rule.which ?? null,
    endAfter: rule.endAfter ?? null,
    endOn: rule.endOn ?? null,
  };
}
function viewDate(due, timeZone) {
  if (!due) return null;
  if (due.kind === 'date') return due.date;
  return civilDate(wallToInstant(due.dateTime, due.timeZone), timeZone);
}

function normalizeDue(input) {
  if (input == null) return null;
  if (typeof input === 'string') {
    if (!validDate(input)) fail('Due date must be YYYY-MM-DD.');
    return { kind: 'date', date: input };
  }
  if (!object(input)) fail('Due must be a date or a time.');
  if (own(input, 'date') && !own(input, 'dateTime')) {
    if (!validDate(input.date)) fail('Due date must be YYYY-MM-DD.');
    return { kind: 'date', date: input.date };
  }
  if (input.kind === 'date') {
    if (!validDate(input.date)) fail('Due date must be YYYY-MM-DD.');
    return { kind: 'date', date: input.date };
  }
  if (!validDateTime(input.dateTime)) fail('Due time must be YYYY-MM-DDTHH:MM.');
  return { kind: 'dateTime', dateTime: input.dateTime, timeZone: assertTimeZone(input.timeZone) };
}
function reminderContentKey(reminder) {
  if (reminder.kind === 'offset') return `offset:${reminder.days}:${reminder.hours}:${reminder.minutes}`;
  return `fixed:${reminder.dateTime}:${reminder.timeZone}:${reminder.occurrence ?? ''}`;
}
function assignReminderIds(reminders, previous) {
  const pools = new Map();
  for (const reminder of previous) {
    const key = reminderContentKey(reminder);
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push(reminder.id);
  }
  const used = new Set();
  return reminders.map(reminder => {
    let id = reminder.id ?? null;
    if (id && used.has(id)) id = null;
    if (!id) {
      const pool = pools.get(reminderContentKey(reminder)) ?? [];
      id = pool.find(candidate => !used.has(candidate)) ?? randomUUID();
    }
    used.add(id);
    const body = { ...reminder };
    delete body.id;
    return { ...body, id };
  });
}
function normalizeReminder(input, fallbackOccurrence) {
  if (!object(input)) fail('Reminder must be an object.');
  const id = own(input, 'id') && input.id != null ? identity(input.id, 'Reminder ID') : null;
  const offsetLike = input.kind === 'offset' || own(input, 'days') || own(input, 'hours') || own(input, 'minutes');
  if (offsetLike) {
    if (input.kind && input.kind !== 'offset') fail('Unknown reminder.');
    const days = input.days ?? 0;
    const hours = input.hours ?? 0;
    const minutes = input.minutes ?? 0;
    if (![days, hours, minutes].every(Number.isSafeInteger)) fail('Reminder offset must be a whole number.');
    if (days < 0 || days > 365 || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) fail('Reminder offset is out of range.');
    return id ? { id, kind: 'offset', days, hours, minutes } : { kind: 'offset', days, hours, minutes };
  }
  const dateTime = input.dateTime ?? input.at;
  if (!validDateTime(dateTime)) fail('Reminder time must be YYYY-MM-DDTHH:MM.');
  const occurrence = own(input, 'occurrence') ? input.occurrence : fallbackOccurrence;
  if (occurrence != null && (typeof occurrence !== 'string' || occurrence.length > 200)) fail('Reminder occurrence must be text.');
  const fixed = { kind: 'fixed', dateTime, timeZone: assertTimeZone(input.timeZone), occurrence: occurrence ?? null };
  return id ? { id, ...fixed } : fixed;
}
function normalizeReminders(input, fallbackOccurrence, previous = []) {
  if (input == null) return [];
  if (!Array.isArray(input)) fail('Reminders must be a list.');
  if (input.length > 5) fail('A task can have at most 5 reminders.');
  return assignReminderIds(input.map(reminder => normalizeReminder(reminder, fallbackOccurrence)), previous);
}
function normalizeTitle(title) {
  const text = string(title, 'Title');
  if (text.length < 1 || text.length > 500) fail('Title must be 1 to 500 characters.');
  return text;
}
function normalizeNote(note) {
  if (note == null) return '';
  const text = string(note, 'Note');
  if (text.length > 5000) fail('Note must be at most 5000 characters.');
  return text;
}
function normalizeList(list) {
  if (list == null || list === '') return null;
  const text = string(list, 'List name');
  if (text.length > 200) fail('List name must be at most 200 characters.');
  return text;
}
function normalizePriority(priority) {
  if (priority == null || priority === 'none') return null;
  if (priority !== 'high') fail('Priority must be high or none.');
  return 'high';
}
function normalizeDayStart(value) {
  if (!validTime(value)) fail('Day start must be a time like 09:00.');
  return value;
}

function hasTitle(task) {
  return Boolean(task.fields.title);
}
function holdingPurgedFields(task) {
  return Boolean(task.purge) && compareStamps(task.life.stamp, task.purge) <= 0;
}
function fieldsComplete(task) {
  return TASK_KEYS.every(key => own(task.fields, key));
}
/** A purge marker may keep a newer title for a later merge. It is not a task you can open. */
function usableTask(task) {
  if (!hasTitle(task)) return false;
  if (holdingPurgedFields(task) && !fieldsComplete(task)) return false;
  return true;
}
function setAsideIds(task) {
  const aside = new Set();
  for (const record of task.records) {
    if (record.type !== 'reopen' || record.fields.withdrawn.value) continue;
    for (const id of record.fields.seen.value) aside.add(id);
  }
  return aside;
}
function countingRecords(task) {
  const aside = setAsideIds(task);
  return task.records.filter(record =>
    (record.type === 'completion' || record.type === 'skip') &&
    !record.fields.withdrawn.value &&
    !aside.has(record.id));
}
function pickLatest(list) {
  return list.slice().sort((a, b) =>
    compareOccurrence(a.occurrence, b.occurrence) || lex(a.actionDate, b.actionDate) || (a.instant - b.instant) || lex(a.id, b.id),
  ).at(-1) ?? null;
}
function nextAfterDone(latest, rule, names, template) {
  let date = shiftAfterDone(latest.actionDate, rule);
  if (date < rule.start) date = rule.start;
  let guard = 0;
  while (date && names.has(occurrenceName(template, date)) && guard < 1000) {
    guard += 1;
    const stepped = shiftAfterDone(date, rule);
    if (!stepped || stepped <= date) return null;
    date = stepped < rule.start ? rule.start : stepped;
  }
  if (!date || (rule.endOn && date > rule.endOn)) return null;
  return date;
}
function currentDate(task) {
  const rule = task.fields.repeat?.value ?? null;
  const template = task.fields.due?.value ?? null;
  if (!rule) return dueCalendar(template);
  const counting = countingRecords(task);
  const names = new Set(counting.map(record => record.occurrence));
  if (rule.endAfter != null && names.size >= rule.endAfter) return null;
  if (!counting.length) return rule.endOn && rule.start > rule.endOn ? null : rule.start;
  const latest = pickLatest(counting);
  const date = rule.mode === 'afterDone'
    ? nextAfterDone(latest, rule, names, template)
    : onScheduleNext(rule, occurrenceDateOf(latest.occurrence));
  if (!date || (rule.endOn && date > rule.endOn)) return null;
  return date;
}
function statusOf(task) {
  if (!task.life.value || task.pendingLife || !hasTitle(task)) return 'deleted';
  if (task.fields.state.value === 'dropped') return 'dropped';
  if (!task.fields.repeat.value) return task.fields.state.value === 'done' ? 'done' : 'open';
  return currentDate(task) ? 'open' : 'done';
}
function winningSnooze(task, occurrence) {
  let best = null;
  for (const record of task.records) {
    if (record.type !== 'snooze' || record.fields.withdrawn.value) continue;
    if ((record.occurrence ?? null) !== (occurrence ?? null)) continue;
    if (!best || compareStamps(record.stamp, best.stamp) > 0 || (compareStamps(record.stamp, best.stamp) === 0 && lex(record.id, best.id) > 0)) best = record;
  }
  return best;
}
function effectiveDue(task, date) {
  const template = task.fields.due.value;
  const name = occurrenceName(template, date);
  const snooze = winningSnooze(task, name);
  if (snooze?.fields.due.value) return canonicalDue(snooze.fields.due.value);
  return scheduledDue(template, date);
}
function isOverdue(due, now, timeZone) {
  if (!due) return false;
  if (due.kind === 'date') return civilDate(now, timeZone) > due.date;
  return now >= wallToInstant(due.dateTime, due.timeZone);
}
function offsetInstant(due, offset, dayStart, ownerZone) {
  const wall = due.kind === 'date'
    ? { dateTime: `${due.date}T${dayStart}`, timeZone: ownerZone }
    : { dateTime: due.dateTime, timeZone: due.timeZone };
  const shifted = offset.days ? `${addDays(wall.dateTime.slice(0, 10), -offset.days)}T${wall.dateTime.slice(11, 16)}` : wall.dateTime;
  return wallToInstant(shifted, wall.timeZone) - (offset.hours * 60 + offset.minutes) * 60000;
}
function reminderMoments(task, ownerZone, dayStart) {
  if (statusOf(task) !== 'open') return [];
  const date = currentDate(task);
  const due = effectiveDue(task, date);
  const occurrence = occurrenceName(task.fields.due.value, date);
  const moments = [];
  task.fields.reminders.value.forEach((reminder, index) => {
    if (reminder.kind === 'offset') {
      if (!due) return;
      const instant = offsetInstant(due, reminder, dayStart, ownerZone);
      moments.push({ id: reminder.id, index, reminder, occurrence, instant, baseInstant: instant });
      return;
    }
    // A named fixed reminder belongs to one occurrence, including a one-off
    // task. Rescheduling the due date leaves the old name behind, so it lapses
    // until an edit moves it.
    if (reminder.occurrence != null && reminder.occurrence !== occurrence) return;
    const instant = wallToInstant(reminder.dateTime, reminder.timeZone);
    moments.push({ id: reminder.id, index, reminder, occurrence, instant, baseInstant: instant });
  });
  // One winner per reminder that was moved. A later snooze of a different
  // reminder keeps the earlier replacement. Two concurrent snoozes of the same
  // reminder keep only the higher stamp, so the loser cannot shift a second one.
  for (const snooze of snoozesToApply(task, occurrence)) applyWinningSnooze(moments, snooze, occurrence);
  return moments;
}
function snoozesToApply(task, occurrence) {
  const best = new Map();
  for (const record of task.records) {
    if (record.type !== 'snooze' || record.fields.withdrawn.value) continue;
    if ((record.occurrence ?? null) !== (occurrence ?? null) || !record.fields.reminderAt.value) continue;
    const key = record.fields.replaces?.value == null ? 'new' : `reminder:${record.fields.replaces.value}`;
    const current = best.get(key);
    if (!current || compareStamps(record.stamp, current.stamp) > 0 || (compareStamps(record.stamp, current.stamp) === 0 && lex(record.id, current.id) > 0)) {
      best.set(key, record);
    }
  }
  return [...best.values()].sort((a, b) => compareStamps(a.stamp, b.stamp) || lex(a.id, b.id));
}
function applyWinningSnooze(moments, snooze, occurrence) {
  const instant = wallToInstant(snooze.fields.reminderAt.value.dateTime, snooze.fields.reminderAt.value.timeZone);
  const replaces = snooze.fields.replaces?.value ?? null;
  if (replaces != null) {
    // The id, not the list position: a concurrent removal must not move the
    // reminder that shifted into the old index. A missing id is a removed
    // reminder, so the snooze does not fire.
    const index = moments.findIndex(moment => moment.id === replaces);
    if (index >= 0) moments[index] = { ...moments[index], instant, snoozed: true };
    return;
  }
  // Nothing was targeted. This is its own reminder. Searching the list again
  // would move a reminder another replica added after the snooze.
  moments.push({ index: -1, reminder: { kind: 'snooze' }, occurrence, instant, baseInstant: instant, snoozed: true });
}
function replacedReminder(task, occurrence, now, zone, dayStart) {
  const moments = reminderMoments(task, zone, dayStart).filter(moment => moment.instant >= now && moment.index >= 0)
    .sort((a, b) => a.instant - b.instant || a.index - b.index);
  // Id, not the instant: two reminders can share a time and must stay distinct.
  return moments.length ? moments[0].id : null;
}

function blankRecord(id, type, occurrence, instant, actionDate, actionZone, stamp, fields) {
  const base = stamp;
  return {
    id, type, occurrence: occurrence ?? null, instant, actionDate, actionZone, stamp: clone(base),
    fields: fieldMap(RECORD_KEYS.map(key => [key, { value: canonicalValue(key, fields[key]), stamp: clone(base) }])),
  };
}

function mergeRecord(a, b) {
  if (!a) return clone(b);
  if (!b) return clone(a);
  if (a.type !== b.type || (a.occurrence ?? null) !== (b.occurrence ?? null) || a.instant !== b.instant || a.actionDate !== b.actionDate || a.actionZone !== b.actionZone || compareStamps(a.stamp, b.stamp) !== 0) {
    fail('Conflicting records share an ID.');
  }
  return canonicalRecord({ ...a, fields: records(a.fields, b.fields) });
}
function fillTaskFields(fields, purge) {
  const filled = {};
  for (const key of TASK_KEYS) {
    if (own(fields, key)) setOwn(filled, key, fields[key]);
    else setOwn(filled, key, { value: canonicalValue(key, TASK_DEFAULTS[key]), stamp: clone(purge) });
  }
  return filled;
}
function repeatWithoutDue(fields) {
  return Boolean(fields.repeat?.value) && !fields.due?.value;
}
function mergeTask(a, b) {
  if (!a) return clone(b);
  if (!b) return clone(a);
  const purge = latest(a.purge, b.purge);
  const life = register(a.pendingLife ?? a.life, b.pendingLife ?? b.life);
  const fields = records(a.fields, b.fields, purge);
  const ids = [...new Set([...a.records.map(record => record.id), ...b.records.map(record => record.id)])].sort();
  const left = new Map(a.records.map(record => [record.id, record]));
  const right = new Map(b.records.map(record => [record.id, record]));
  const mergedRecords = ids.map(id => mergeRecord(left.get(id), right.get(id))).filter(record => !purge || compareStamps(record.stamp, purge) > 0);
  // A life event that is not newer than the cutoff does not restore the task,
  // but field registers newer than the cutoff still have to survive. Dropping
  // them here makes a later restore depend on merge order.
  if (purge && compareStamps(life.stamp, purge) <= 0) {
    return { id: a.id, life: { value: false, stamp: clone(purge) }, purge: clone(purge), fields, records: mergedRecords };
  }
  // A repeat can outlive its due date: undo restamps the rule and leaves the
  // due stamp behind, then a purge falls between them. That marker is not a
  // task until a due date newer than the cutoff arrives.
  if (!fields.title || (purge && repeatWithoutDue(fields))) {
    return {
      id: a.id,
      life: { value: false, stamp: clone(purge ?? life.stamp) },
      purge: clone(purge),
      fields,
      records: mergedRecords,
      ...(purge ? { pendingLife: life } : {}),
    };
  }
  return { id: a.id, life, purge: clone(purge), fields: purge ? fillTaskFields(fields, purge) : fields, records: mergedRecords };
}

/** Pure merge. Neither input changes. Commutative, associative and idempotent on valid files. */
export function mergePeople(left, right) {
  validate(left);
  validate(right);
  if (left.id !== right.id) fail('Cannot merge different person IDs.');
  const ids = [...new Set([...left.tasks.map(task => task.id), ...right.tasks.map(task => task.id)])].sort();
  const a = new Map(left.tasks.map(task => [task.id, task]));
  const b = new Map(right.tasks.map(task => [task.id, task]));
  return canonical(validate({
    schemaVersion: SCHEMA_VERSION,
    id: left.id,
    fields: records(left.fields, right.fields),
    tasks: ids.map(id => mergeTask(a.get(id), b.get(id))),
  }));
}

function checkDue(due, label) {
  if (due == null) return;
  if (!object(due)) fail('Invalid task in task file.');
  if (due.kind === 'date') {
    exactKeys(due, ['kind', 'date']);
    if (!validDate(due.date)) fail('Invalid task in task file.');
    return;
  }
  if (due.kind === 'dateTime') {
    exactKeys(due, ['kind', 'dateTime', 'timeZone']);
    if (!validDateTime(due.dateTime)) fail('Invalid task in task file.');
    assertTimeZone(due.timeZone);
    return;
  }
  fail(`Invalid ${label} in task file.`);
}
function checkRepeat(rule) {
  if (rule == null) return;
  exactKeys(rule, ['kind', 'every', 'mode', 'start', 'weekdays', 'monthDay', 'weekday', 'which', 'endAfter', 'endOn']);
  // Re-run the builder so a stored rule that breaks its own pattern is refused.
  normalizeRepeat(rule, rule.start, { exactStart: true });
  if (stable(canonicalRepeat(rule)) !== stable(normalizeRepeat(rule, rule.start, { exactStart: true }))) fail('Invalid repeat in task file.');
}
function checkReminders(reminders) {
  if (!Array.isArray(reminders) || reminders.length > 5) fail('Invalid reminders in task file.');
  const seen = new Set();
  for (const reminder of reminders) {
    if (!object(reminder)) fail('Invalid reminders in task file.');
    if (typeof reminder.id !== 'string' || !reminder.id || reminder.id.length > 200 || seen.has(reminder.id)) fail('Invalid reminders in task file.');
    seen.add(reminder.id);
    if (reminder.kind === 'offset') {
      exactKeys(reminder, ['id', 'kind', 'days', 'hours', 'minutes']);
      normalizeReminder(reminder, null);
    } else if (reminder.kind === 'fixed') {
      exactKeys(reminder, ['id', 'kind', 'dateTime', 'timeZone', 'occurrence']);
      normalizeReminder(reminder, null);
    } else fail('Invalid reminders in task file.');
  }
}
function checkTask(task) {
  if (!object(task) || typeof task.id !== 'string' || !task.id || task.id.length > 200) fail('Invalid task in task file.');
  const keys = ['id', 'life', 'purge', 'fields', 'records'];
  if (own(task, 'pendingLife')) keys.push('pendingLife');
  exactKeys(task, keys);
  checkLifeRegister(task.life);
  if (task.purge !== null && !validStamp(task.purge)) fail('Invalid task in task file.');
  if (own(task, 'pendingLife')) {
    if (!task.purge) fail('Invalid task in task file.');
    checkLifeRegister(task.pendingLife);
  }
  if (!object(task.fields) || !Array.isArray(task.records)) fail('Invalid task in task file.');
  const present = Object.keys(task.fields);
  for (const key of present) if (!TASK_KEYS.includes(key)) fail('Unknown field in task file.');
  // A live task carries every field. A purged marker may keep only the registers
  // newer than its cutoff, so a later full copy can still merge in any order.
  const live = task.life.value && !task.pendingLife;
  if (live) exactKeys(task.fields, TASK_KEYS);
  else if (!present.length && task.life.value) fail('Invalid task in task file.');
  if (present.length) {
    for (const key of present) checkRegister(task.fields[key]);
    const value = key => task.fields[key]?.value;
    if (own(task.fields, 'title')) normalizeTitle(value('title'));
    if (own(task.fields, 'note')) normalizeNote(value('note'));
    if (own(task.fields, 'list')) normalizeList(value('list'));
    if (own(task.fields, 'priority')) normalizePriority(value('priority'));
    if (own(task.fields, 'state') && !['open', 'done', 'dropped'].includes(value('state'))) fail('Invalid task in task file.');
    if (own(task.fields, 'due')) checkDue(value('due'), 'due');
    if (own(task.fields, 'repeat')) checkRepeat(value('repeat'));
    if (live && value('repeat') && !value('due')) fail('A repeating task needs a due date.');
    if (own(task.fields, 'reminders')) checkReminders(value('reminders'));
  }
  const seen = new Set();
  for (const record of task.records) {
    exactKeys(record, ['id', 'type', 'occurrence', 'instant', 'actionDate', 'actionZone', 'stamp', 'fields']);
    if (typeof record.id !== 'string' || !record.id || seen.has(record.id)) fail('Duplicate record ID in task file.');
    seen.add(record.id);
    if (!['completion', 'skip', 'snooze', 'reopen', 'drop'].includes(record.type)) fail('Invalid record in task file.');
    if (record.occurrence !== null && typeof record.occurrence !== 'string') fail('Invalid record in task file.');
    if (!Number.isSafeInteger(record.instant) || !validDate(record.actionDate) || typeof record.actionZone !== 'string') fail('Invalid record in task file.');
    assertTimeZone(record.actionZone);
    if (!validStamp(record.stamp)) fail('Invalid record in task file.');
    exactKeys(record.fields, RECORD_KEYS);
    for (const key of RECORD_KEYS) checkRegister(record.fields[key]);
    if (typeof record.fields.withdrawn.value !== 'boolean') fail('Invalid record in task file.');
    if (!Array.isArray(record.fields.seen.value) || record.fields.seen.value.some(id => typeof id !== 'string')) fail('Invalid record in task file.');
    checkDue(record.fields.due.value, 'due');
    if (record.fields.replaces.value !== null && (typeof record.fields.replaces.value !== 'string' || !record.fields.replaces.value || record.fields.replaces.value.length > 200)) fail('Invalid record in task file.');
    if (record.fields.reminderAt.value != null) {
      const at = record.fields.reminderAt.value;
      exactKeys(at, ['dateTime', 'timeZone']);
      if (!validDateTime(at.dateTime)) fail('Invalid record in task file.');
      assertTimeZone(at.timeZone);
    }
  }
}
function validate(person) {
  if (!object(person) || person.schemaVersion !== SCHEMA_VERSION) fail(`Unsupported schemaVersion; expected ${SCHEMA_VERSION}.`);
  exactKeys(person, ['schemaVersion', 'id', 'fields', 'tasks']);
  identity(person.id, 'Person ID');
  if (!object(person.fields) || !Array.isArray(person.tasks)) fail('Invalid task in task file.');
  exactKeys(person.fields, PERSON_KEYS);
  for (const key of PERSON_KEYS) checkRegister(person.fields[key]);
  assertTimeZone(person.fields.timeZone.value);
  normalizeDayStart(person.fields.dayStart.value);
  const ids = new Set();
  for (const task of person.tasks) {
    checkTask(task);
    if (ids.has(task.id)) fail('Duplicate task ID in task file.');
    ids.add(task.id);
  }
  return person;
}
export function serializePerson(person) {
  return JSON.stringify(canonical(validate(person)));
}
export function deserializePerson(json) {
  if (typeof json !== 'string') fail('Invalid task JSON.');
  let value;
  try { value = JSON.parse(json); } catch { fail('Invalid task JSON.'); }
  return canonical(validate(value));
}

function requireInstant(now) {
  if (!Number.isSafeInteger(now)) fail('Now must be an instant.');
  return now;
}
function stampedFields(values, stamp, order) {
  return fieldMap(order.map(key => [key, { value: canonicalValue(key, values[key]), stamp: clone(stamp) }]));
}

/** One writer per device id. Undo history stays in memory and is not part of the file. */
export class Tasks {
  #person;
  #history = [];
  #counter = 0;
  #pristine = true;
  constructor({ deviceId, now, undoLimit = 20, id = randomUUID(), timeZone, dayStart = '09:00' } = {}) {
    this.deviceId = identity(deviceId, 'Device ID');
    if (typeof now !== 'function') fail('A clock function is required.');
    if (!Number.isSafeInteger(undoLimit) || undoLimit < 0) fail('Invalid clock or undo limit.');
    this.now = now;
    this.undoLimit = undoLimit;
    this.id = identity(id, 'Person ID');
    const zone = assertTimeZone(timeZone);
    const start = normalizeDayStart(dayStart);
    const stamp = this.#stamp();
    this.#person = canonical({
      schemaVersion: SCHEMA_VERSION,
      id: this.id,
      fields: stampedFields({ timeZone: zone, dayStart: start }, stamp, PERSON_KEYS),
      tasks: [],
    });
  }
  #stamp() {
    const time = this.now();
    if (!Number.isSafeInteger(time) || this.#counter >= Number.MAX_SAFE_INTEGER) fail('Invalid clock or exhausted logical counter.');
    return { counter: ++this.#counter, time, device: this.deviceId };
  }
  #observe(person) {
    const stamps = [];
    for (const entry of Object.values(person.fields)) stamps.push(entry.stamp);
    for (const task of person.tasks) {
      stamps.push(task.life.stamp, task.purge, task.pendingLife?.stamp);
      for (const entry of Object.values(task.fields)) stamps.push(entry.stamp);
      for (const record of task.records) {
        stamps.push(record.stamp);
        for (const entry of Object.values(record.fields)) stamps.push(entry.stamp);
      }
    }
    for (const stamp of stamps) if (stamp) this.#counter = Math.max(this.#counter, stamp.counter);
  }
  #change(operation) {
    const before = this.#person;
    const draft = clone(before);
    const stamp = this.#stamp();
    operation(draft, stamp);
    const next = canonical(validate(draft));
    const history = this.#history;
    history.push({ before: clone(before), after: clone(next) });
    if (history.length > this.undoLimit) history.shift();
    this.#person = next;
    this.#pristine = false;
    return this.getPerson();
  }
  getPerson() { return clone(this.#person); }
  #locate(id) {
    identity(id, 'Task ID');
    return this.#person.tasks.find(task => task.id === id) ?? null;
  }
  #any(id) {
    const task = this.#locate(id);
    if (!task) fail('Task not found.');
    if (!usableTask(task)) fail('Task was emptied from Trash.');
    return task;
  }
  setTimeZone(timeZone) {
    const zone = assertTimeZone(timeZone);
    return this.#change((person, stamp) => { person.fields.timeZone = { value: zone, stamp }; });
  }
  setDayStart(dayStart) {
    const start = normalizeDayStart(dayStart);
    return this.#change((person, stamp) => { person.fields.dayStart = { value: start, stamp }; });
  }
  addTask(input, { taskId = randomUUID() } = {}) {
    if (!object(input)) fail('Task must be an object.');
    identity(taskId, 'Task ID');
    const existing = this.#locate(taskId);
    // An emptied id stays retired. A new cutoff only fences stamps this device
    // has seen, so an offline replica with a higher counter could still attach
    // the old task's completion to a replacement.
    if (existing) fail(usableTask(existing) ? 'Task ID already exists.' : 'Task ID was emptied from Trash.');
    const title = normalizeTitle(input.title);
    const note = normalizeNote(input.note);
    const list = normalizeList(input.list);
    const priority = normalizePriority(input.priority);
    const due = normalizeDue(input.due);
    if (input.repeat && !due) fail('A repeating task needs a due date.');
    const repeat = input.repeat ? normalizeRepeat(input.repeat, dueCalendar(due), { exactStart: true }) : null;
    const occurrence = occurrenceName(due, dueCalendar(due));
    const reminders = normalizeReminders(input.reminders, occurrence);
    this.#change((person, stamp) => {
      person.tasks.push({
        id: taskId,
        life: { value: true, stamp: clone(stamp) },
        purge: null,
        fields: stampedFields({ title, note, list, priority, state: 'open', due, repeat, reminders }, stamp, TASK_KEYS),
        records: [],
      });
    });
    return taskId;
  }
  editTask(id, patch) {
    if (!object(patch)) fail('Task changes must be an object.');
    const allowed = new Set(['title', 'note', 'list', 'priority', 'due', 'repeat', 'reminders']);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) fail('Unknown task field.');
    if (!Object.keys(patch).length) fail('Nothing to change.');
    return this.#change((person, stamp) => {
      const task = person.tasks.find(item => item.id === id) ?? fail('Task not found.');
      if (!usableTask(task)) fail('Task was emptied from Trash.');
      const before = clone(task);
      if (!task.life.value || task.pendingLife) {
        task.life = { value: true, stamp: clone(stamp) };
        delete task.pendingLife;
      }
      if (own(patch, 'title')) task.fields.title = { value: normalizeTitle(patch.title), stamp: clone(stamp) };
      if (own(patch, 'note')) task.fields.note = { value: normalizeNote(patch.note), stamp: clone(stamp) };
      if (own(patch, 'list')) task.fields.list = { value: normalizeList(patch.list), stamp: clone(stamp) };
      if (own(patch, 'priority')) task.fields.priority = { value: normalizePriority(patch.priority), stamp: clone(stamp) };
      if (own(patch, 'due')) task.fields.due = { value: normalizeDue(patch.due), stamp: clone(stamp) };
      if (own(patch, 'repeat') && patch.repeat == null) {
        // A new due date in the same edit is the date the caller asked for.
        // Without one, the one-off keeps the occurrence that was open.
        if (!own(patch, 'due')) {
          const date = currentDate(before) ?? dueCalendar(task.fields.due.value);
          if (date && task.fields.due.value) task.fields.due = { value: scheduledDue(task.fields.due.value, date), stamp: clone(stamp) };
        }
        task.fields.repeat = { value: null, stamp: clone(stamp) };
        task.fields.state = { value: 'open', stamp: clone(stamp) };
      } else if (own(patch, 'repeat')) {
        const anchor = own(patch, 'due') ? dueCalendar(task.fields.due.value) : (currentDate(before) ?? before.fields.repeat.value?.start ?? dueCalendar(task.fields.due.value));
        if (!anchor || !task.fields.due.value) fail('A repeating task needs a due date.');
        // A new repeat must land on the due date. Editing a rule re-anchors
        // to the first matching date on or after the current due date.
        const rule = normalizeRepeat(patch.repeat, anchor, { exactStart: own(patch, 'due') || !before.fields.repeat.value });
        task.fields.repeat = { value: rule, stamp: clone(stamp) };
        task.fields.due = { value: scheduledDue(task.fields.due.value, rule.start), stamp: clone(stamp) };
        if (task.fields.state.value === 'done') task.fields.state = { value: 'open', stamp: clone(stamp) };
      } else if (own(patch, 'due') && task.fields.repeat.value) {
        if (!task.fields.due.value) fail('A repeating task needs a due date.');
        const previousDate = dueCalendar(before.fields.due.value);
        const nextDate = dueCalendar(task.fields.due.value);
        if (previousDate !== nextDate) {
          const rule = normalizeRepeat(task.fields.repeat.value, nextDate, { exactStart: true });
          task.fields.repeat = { value: rule, stamp: clone(stamp) };
        }
      }
      if (own(patch, 'reminders')) {
        const occurrence = occurrenceName(task.fields.due.value, currentDate(task));
        task.fields.reminders = { value: normalizeReminders(patch.reminders, occurrence, before.fields.reminders.value), stamp: clone(stamp) };
      }
      if (task.fields.repeat.value && !task.fields.due.value) fail('A repeating task needs a due date.');
    });
  }
  #record(task, type, now, stamp, recordId, extra) {
    const instant = requireInstant(now);
    const zone = this.#person.fields.timeZone.value;
    const date = currentDate(task);
    const occurrence = extra.occurrence === undefined ? occurrenceName(task.fields.due.value, date) : extra.occurrence;
    const id = recordId ?? randomUUID();
    if (task.records.some(record => record.id === id)) fail('Record ID already exists.');
    task.records.push(blankRecord(id, type, occurrence, instant, civilDate(instant, zone), zone, stamp, {
      withdrawn: false,
      seen: extra.seen ?? [],
      reminderAt: extra.reminderAt ?? null,
      due: extra.due ?? null,
      replaces: extra.replaces ?? null,
    }));
    return id;
  }
  complete(id, now, { recordId } = {}) {
    return this.#change((person, stamp) => {
      const task = this.#requireOpen(person, id);
      if (!task.fields.repeat.value) task.fields.state = { value: 'done', stamp: clone(stamp) };
      this.#record(task, 'completion', now, stamp, recordId, {});
      task.life = { value: true, stamp: clone(stamp) };
    });
  }
  skip(id, now, { recordId } = {}) {
    return this.#change((person, stamp) => {
      const task = this.#requireOpen(person, id);
      if (!task.fields.repeat.value) fail('Only a repeating task can be skipped.');
      this.#record(task, 'skip', now, stamp, recordId, {});
      task.life = { value: true, stamp: clone(stamp) };
    });
  }
  reopen(id, { occurrence, recordId, now = this.now() } = {}) {
    return this.#change((person, stamp) => {
      const task = person.tasks.find(item => item.id === id) ?? fail('Task not found.');
      if (!usableTask(task)) fail('Task was emptied from Trash.');
      if (!task.life.value || task.pendingLife) fail('Task is in Trash.');
      if (!task.fields.repeat.value) {
        if (task.fields.state.value === 'open') fail('Task is open.');
        task.fields.state = { value: 'open', stamp: clone(stamp) };
        task.life = { value: true, stamp: clone(stamp) };
        return;
      }
      const counting = countingRecords(task);
      const target = occurrence ?? pickLatest(counting)?.occurrence;
      if (!target || !counting.some(record => record.occurrence === target)) fail(counting.length ? 'That occurrence is open.' : 'Nothing to reopen.');
      const seen = task.records.filter(record => (record.type === 'completion' || record.type === 'skip') && record.occurrence === target).map(record => record.id);
      this.#record(task, 'reopen', now, stamp, recordId, { occurrence: target, seen });
      task.life = { value: true, stamp: clone(stamp) };
    });
  }
  drop(id, now = this.now(), { recordId } = {}) {
    return this.#change((person, stamp) => {
      const task = person.tasks.find(item => item.id === id) ?? fail('Task not found.');
      if (!usableTask(task)) fail('Task was emptied from Trash.');
      if (!task.life.value || task.pendingLife) fail('Task is in Trash.');
      if (task.fields.state.value === 'dropped') fail('This task is dropped.');
      task.fields.state = { value: 'dropped', stamp: clone(stamp) };
      this.#record(task, 'drop', now, stamp, recordId, { occurrence: null });
      task.life = { value: true, stamp: clone(stamp) };
    });
  }
  snooze(id, request, now, { recordId } = {}) {
    if (!object(request)) fail('Snooze needs a preset or a time.');
    return this.#change((person, stamp) => {
      const task = this.#requireOpen(person, id);
      const instant = requireInstant(now);
      const zone = person.fields.timeZone.value;
      const at = request.at ? normalizeWall(request.at) : presetWall(task, request.preset, instant, zone, person.fields.dayStart.value);
      const due = request.moveDue ? normalizeDue(request.due ?? { dateTime: at.dateTime, timeZone: at.timeZone }) : null;
      const replaces = replacedReminder(task, occurrenceName(task.fields.due.value, currentDate(task)), instant, zone, person.fields.dayStart.value);
      this.#record(task, 'snooze', instant, stamp, recordId, { reminderAt: at, due, replaces });
      task.life = { value: true, stamp: clone(stamp) };
    });
  }
  deleteTask(id) {
    return this.#change((person, stamp) => {
      const task = person.tasks.find(item => item.id === id) ?? fail('Task not found.');
      if (!usableTask(task)) fail('Task was emptied from Trash.');
      if (!task.life.value && !task.pendingLife) fail('Task is in Trash.');
      task.life = { value: false, stamp: clone(stamp) };
      delete task.pendingLife;
    });
  }
  restoreTask(id) {
    return this.#change((person, stamp) => {
      const task = person.tasks.find(item => item.id === id) ?? fail('Task not found.');
      if (!usableTask(task)) fail('Task was emptied from Trash.');
      if (task.life.value && !task.pendingLife) fail('Task is not in Trash.');
      task.life = { value: true, stamp: clone(stamp) };
      delete task.pendingLife;
    });
  }
  emptyTrash() {
    const result = this.#change((person, stamp) => {
      for (const task of person.tasks) {
        if (!task.life.value && !task.pendingLife && hasTitle(task) && !holdingPurgedFields(task)) {
          task.fields = {};
          task.records = [];
          task.purge = clone(stamp);
          task.life = { value: false, stamp: clone(stamp) };
          delete task.pendingLife;
        }
      }
    });
    this.#history = [];
    return result;
  }
  undo() {
    const current = this.#person;
    const history = this.#history;
    if (!history.length) return false;
    const { before, after } = history.at(-1);
    const stamp = this.#stamp();
    const restored = clone(current);
    const compensate = (previous, written, currentEntry, fallback) => {
      if (!previous) return { value: clone(fallback), stamp: clone(stamp) };
      if (sameValue(previous.value, written.value)) {
        return clone(compareStamps(currentEntry.stamp, written.stamp) === 0 ? previous : currentEntry);
      }
      return { value: clone(previous.value), stamp: clone(stamp) };
    };
    const undoFields = (target, previous, written, defaults, order) => {
      for (const key of order) {
        if (!own(written, key)) continue;
        const entry = written[key];
        const old = own(previous, key) ? previous[key] : undefined;
        if (old && compareStamps(old.stamp, entry.stamp) === 0) continue;
        if (!own(target, key)) continue;
        setOwn(target, key, compensate(old, entry, target[key], own(defaults, key) ? defaults[key] : null));
      }
    };
    undoFields(restored.fields, before.fields, after.fields, { timeZone: restored.fields.timeZone.value, dayStart: '09:00' }, PERSON_KEYS);
    const beforeTasks = new Map(before.tasks.map(task => [task.id, task]));
    const currentTasks = new Map(restored.tasks.map(task => [task.id, task]));
    for (const written of after.tasks) {
      const previous = beforeTasks.get(written.id);
      const target = currentTasks.get(written.id);
      if (!target) continue;
      const previousContent = previous && hasTitle(previous);
      if (!previousContent && hasTitle(written)) {
        target.fields = {};
        target.records = [];
        target.life = { value: false, stamp: clone(stamp) };
        target.purge = clone(stamp);
        delete target.pendingLife;
        continue;
      }
      if (previous && compareStamps(previous.life.stamp, written.life.stamp)) target.life = compensate(previous.life, written.life, target.life, false);
      if (hasTitle(target) && hasTitle(written)) undoFields(target.fields, previous?.fields ?? {}, written.fields, TASK_DEFAULTS, TASK_KEYS);
      const previousRecords = new Map((previous?.records ?? []).map(record => [record.id, record]));
      const liveRecords = new Map(target.records.map(record => [record.id, record]));
      for (const record of written.records) {
        const old = previousRecords.get(record.id);
        const live = liveRecords.get(record.id);
        if (!live) continue;
        if (!old) {
          const writtenWithdrawn = record.fields.withdrawn;
          if (compareStamps(live.fields.withdrawn.stamp, writtenWithdrawn.stamp) === 0) {
            live.fields.withdrawn = { value: true, stamp: clone(stamp) };
          }
          continue;
        }
        undoFields(live.fields, old.fields, record.fields, { withdrawn: false, seen: [], reminderAt: null, due: null, replaces: null }, RECORD_KEYS);
      }
    }
    history.pop();
    this.#person = canonical(validate(restored));
    return true;
  }
  #requireOpen(person, id) {
    const task = person.tasks.find(item => item.id === id) ?? fail('Task not found.');
    if (!usableTask(task)) fail('Task was emptied from Trash.');
    if (!task.life.value || task.pendingLife) fail('Task is in Trash.');
    if (task.fields.state.value === 'dropped') fail('This task is dropped.');
    if (statusOf(task) === 'done') fail('This task is done.');
    return task;
  }
  #present(task, timeZone, now) {
    const date = currentDate(task);
    const due = effectiveDue(task, date);
    return {
      id: task.id,
      title: task.fields.title.value,
      note: task.fields.note.value,
      list: task.fields.list.value,
      priority: task.fields.priority.value,
      status: statusOf(task),
      occurrence: occurrenceName(task.fields.due.value, date),
      due: publicDue(due),
      overdue: now == null ? false : isOverdue(due, now, timeZone),
      repeatsAfterDone: task.fields.repeat.value?.mode === 'afterDone',
      repeat: publicRepeat(task.fields.repeat.value),
    };
  }
  task(id) {
    const task = this.#any(id);
    const row = this.#present(task, this.#person.fields.timeZone.value, null);
    row.deleted = !task.life.value || Boolean(task.pendingLife);
    row.reminders = task.fields.reminders.value.map(canonicalReminder);
    return row;
  }
  tasks({ trash = false } = {}) {
    return this.#person.tasks.filter(task => hasTitle(task) && !task.pendingLife && !holdingPurgedFields(task) && task.life.value === !trash).map(task => task.id).sort();
  }
  today(now, timeZone) {
    const instant = requireInstant(now);
    const zone = assertTimeZone(timeZone);
    const day = civilDate(instant, zone);
    const dayStart = this.#person.fields.dayStart.value;
    const rows = [];
    for (const task of this.#person.tasks) {
      if (statusOf(task) !== 'open') continue;
      const row = this.#present(task, zone, instant);
      const onDay = row.due?.kind === 'date' ? row.due.date === day : row.due ? civilDate(row.due.instant, zone) === day : false;
      const reminded = reminderMoments(task, zone, dayStart).some(moment =>
        moment.instant <= instant && civilDate(moment.instant, zone) === day);
      if (!row.overdue && !onDay && !reminded) continue;
      rows.push(row);
    }
    rows.sort((a, b) => compareRows(a, b, zone, true));
    return rows;
  }
  overdue(now, timeZone) {
    const instant = requireInstant(now);
    const zone = assertTimeZone(timeZone);
    const rows = [];
    for (const task of this.#person.tasks) {
      if (statusOf(task) !== 'open') continue;
      const row = this.#present(task, zone, instant);
      if (row.overdue) rows.push(row);
    }
    rows.sort((a, b) => compareRows(a, b, zone, true));
    return rows;
  }
  upcoming(now, days, timeZone) {
    const instant = requireInstant(now);
    const zone = assertTimeZone(timeZone);
    if (!Number.isSafeInteger(days) || days < 1 || days > 60) fail('Upcoming days must be from 1 to 60.');
    const windowStart = civilDate(instant, zone);
    const windowEnd = addDays(windowStart, days - 1);
    const grouped = new Map();
    for (const task of this.#person.tasks) {
      if (statusOf(task) !== 'open') continue;
      for (const date of projectDates(task, windowStart, windowEnd, zone)) {
        const current = currentDate(task);
        const due = date === current ? effectiveDue(task, date) : scheduledDue(task.fields.due.value, date);
        const group = viewDate(due, zone);
        if (!group || group < windowStart || group > windowEnd) continue;
        const row = this.#present(task, zone, instant);
        row.occurrence = occurrenceName(task.fields.due.value, date);
        row.due = publicDue(due);
        row.overdue = isOverdue(due, instant, zone);
        row.repeatsAfterDone = task.fields.repeat.value?.mode === 'afterDone';
        if (!grouped.has(group)) grouped.set(group, []);
        grouped.get(group).push(row);
      }
    }
    return [...grouped.keys()].sort().map(date => ({
      date,
      tasks: grouped.get(date).sort((a, b) => compareRows(a, b, zone, false)),
    }));
  }
  remindersDue(from, to, timeZone) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) fail('Reminder range needs two instants.');
    if (to < from) fail('Reminder range needs two instants.');
    if (to - from > 31 * DAY_MS) fail('Reminder range must be at most 31 days.');
    const zone = assertTimeZone(timeZone);
    const dayStart = this.#person.fields.dayStart.value;
    const rows = [];
    for (const task of this.#person.tasks) {
      for (const moment of reminderMoments(task, zone, dayStart)) {
        if (moment.instant < from || moment.instant >= to) continue;
        const at = wallClock(moment.instant, zone);
        rows.push({
          taskId: task.id,
          title: task.fields.title.value,
          occurrence: moment.occurrence,
          at,
          timeZone: zone,
          instant: moment.instant,
          reminder: moment.reminder.kind === 'snooze' ? { kind: 'snooze' } : canonicalReminder(moment.reminder),
        });
      }
    }
    rows.sort((a, b) => a.instant - b.instant || lex(a.taskId, b.taskId) || lex(stable(a.reminder), stable(b.reminder)));
    return rows;
  }
  history(id) {
    const task = this.#any(id);
    const aside = setAsideIds(task);
    return task.records.map(record => {
      const setAside = (record.type === 'completion' || record.type === 'skip') && aside.has(record.id);
      const row = {
        id: record.id,
        type: record.type,
        occurrence: record.occurrence,
        instant: record.instant,
        actionDate: record.actionDate,
        actionZone: record.actionZone,
        undone: record.fields.withdrawn.value || setAside,
      };
      if (record.type === 'snooze') {
        row.reminderAt = canonicalWall(record.fields.reminderAt.value);
        row.due = canonicalDue(record.fields.due.value);
      }
      if (record.type === 'reopen') row.seen = record.fields.seen.value.slice().sort();
      return row;
    }).sort((a, b) => b.instant - a.instant || lex(b.id, a.id));
  }
  importPerson(person) {
    const incoming = canonical(validate(person));
    if (incoming.id !== this.id) fail('Cannot load a different person.');
    this.#observe(incoming);
    this.#person = this.#pristine ? incoming : mergePeople(this.#person, incoming);
    this.#observe(this.#person);
    this.#pristine = false;
    this.#history = [];
    return this.getPerson();
  }
  load(json) { return this.importPerson(deserializePerson(json)); }
  save() { return serializePerson(this.#person); }
}

function normalizeWall(input) {
  if (!object(input) || !validDateTime(input.dateTime)) fail('Snooze time must be YYYY-MM-DDTHH:MM.');
  return { dateTime: input.dateTime, timeZone: assertTimeZone(input.timeZone) };
}
function nextReminderClock(task, zone, dayStart, now) {
  const moments = reminderMoments(task, zone, dayStart);
  const upcoming = moments.filter(moment => moment.instant >= now);
  const pool = (upcoming.length ? upcoming : moments).slice().sort((a, b) => a.instant - b.instant || a.index - b.index);
  if (pool.length) return wallClock(pool[0].instant, zone).slice(11, 16);
  const due = effectiveDue(task, currentDate(task));
  if (due?.kind === 'dateTime') return due.dateTime.slice(11, 16);
  return dayStart;
}
function presetWall(task, preset, now, zone, dayStart) {
  const clock = nextReminderClock(task, zone, dayStart, now);
  const today = civilDate(now, zone);
  if (preset === 'laterToday') return { dateTime: wallClock(now + 3 * 60 * 60 * 1000, zone), timeZone: zone };
  if (preset === 'tomorrow') return { dateTime: `${addDays(today, 1)}T${clock}`, timeZone: zone };
  if (preset === 'nextMonday') {
    const index = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(
      ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(`${today}T00:00:00Z`).getUTCDay()],
    );
    let delta = (1 - index + 7) % 7;
    if (delta === 0) delta = 7;
    return { dateTime: `${addDays(today, delta)}T${clock}`, timeZone: zone };
  }
  fail('Unknown snooze preset.');
}
function projectDates(task, windowStart, windowEnd, timeZone) {
  const rule = task.fields.repeat.value;
  const current = currentDate(task);
  if (!rule) {
    const due = effectiveDue(task, current);
    const group = viewDate(due, timeZone);
    return group ? [current].filter(Boolean) : [];
  }
  if (rule.mode === 'afterDone') return current ? [current] : [];
  const closed = new Set(countingRecords(task).map(record => record.occurrence)).size;
  let left = rule.endAfter == null ? Number.POSITIVE_INFINITY : rule.endAfter - closed;
  const dates = [];
  let date = current;
  let guard = 0;
  while (date && left > 0 && guard < 5000) {
    guard += 1;
    if (rule.endOn && date > rule.endOn) break;
    const due = date === current ? effectiveDue(task, date) : scheduledDue(task.fields.due.value, date);
    const group = viewDate(due, timeZone) ?? date;
    if (group > windowEnd && date > windowEnd) break;
    dates.push(date);
    left -= 1;
    const next = onScheduleNext(rule, date);
    if (!next || next <= date) break;
    date = next;
  }
  return dates;
}
function sortKey(row, timeZone) {
  if (!row.due) return { date: '9999-12-31', timed: false, time: '', instant: Number.MAX_SAFE_INTEGER };
  if (row.due.kind === 'date') {
    return { date: row.due.date, timed: false, time: '', instant: startOfNextDay(row.due.date, timeZone) };
  }
  const local = wallClock(row.due.instant, timeZone);
  return { date: local.slice(0, 10), timed: true, time: local.slice(11, 16), instant: row.due.instant };
}
function compareRows(a, b, timeZone, overdueFirst) {
  if (overdueFirst && a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  const left = sortKey(a, timeZone);
  const right = sortKey(b, timeZone);
  if (overdueFirst && a.overdue && b.overdue) return left.instant - right.instant || priorityOf(a, b) || lex(a.title, b.title) || lex(a.id, b.id) || lex(a.occurrence ?? '', b.occurrence ?? '');
  return lex(left.date, right.date) || lex(left.timed ? 0 : 1, right.timed ? 0 : 1) || lex(left.time, right.time) || priorityOf(a, b) || lex(a.title, b.title) || lex(a.id, b.id) || lex(a.occurrence ?? '', b.occurrence ?? '');
}
function priorityOf(a, b) {
  return lex(a.priority === 'high' ? 0 : 1, b.priority === 'high' ? 0 : 1);
}
