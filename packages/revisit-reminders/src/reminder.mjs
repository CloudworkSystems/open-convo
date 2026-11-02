// Reminder checks and the changes that return a new list. Nothing here
// reads the clock, the disk, or the network, and nothing writes the list
// it was given.

import { addDays, compareText, isRealDate } from './dates.mjs';
import {
  ID_MAX, ITEM_ID_MAX, ITEM_KINDS, MAX_SPAN, NOTE_MAX, TITLE_MAX, fail,
} from './errors.mjs';

const ID_TEXT = /^[A-Za-z0-9_-]{1,64}$/;
const REMINDER_KEYS = new Set([
  'id', 'itemId', 'itemKind', 'title', 'when', 'note', 'createdOn', 'snoozedUntil', 'doneOn',
]);
const PATCH_KEYS = new Set(['title', 'note', 'when']);
const KINDS = new Set(ITEM_KINDS);

function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWhole(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0);
}

function hasBadControl(text, { note }) {
  for (const char of text) {
    const point = char.codePointAt(0);
    if (point === 0x2028 || point === 0x2029) return true;
    const control = point <= 0x1f || (point >= 0x7f && point <= 0x9f);
    if (!control) continue;
    if (note && (point === 0x09 || point === 0x0a)) continue;
    return true;
  }
  return false;
}

function requireKey(input, key, reminder) {
  if (!Object.hasOwn(input, key)) fail(key, `${key} is missing`, reminder);
}

function readId(value, reminder) {
  if (!Object.hasOwn(value, 'id')) fail('id', 'id is missing', reminder);
  if (typeof value.id !== 'string' || !ID_TEXT.test(value.id)) {
    fail('id', `id must be 1 to ${ID_MAX} letters, digits, hyphens or underscores`, reminder);
  }
  return value.id;
}

function callerId(id) {
  if (typeof id !== 'string' || !ID_TEXT.test(id)) {
    fail('id', `id must be 1 to ${ID_MAX} letters, digits, hyphens or underscores`);
  }
  return id;
}

function readItemId(value, reminder) {
  if (typeof value !== 'string') fail('itemId', 'itemId must be text', reminder);
  if (value.length < 1 || value.length > ITEM_ID_MAX) {
    fail('itemId', `itemId must be 1 to ${ITEM_ID_MAX} characters`, reminder);
  }
  if (hasBadControl(value, { note: false })) fail('itemId', 'itemId must be one line', reminder);
  return value;
}

function readKind(value, reminder) {
  if (typeof value !== 'string' || !KINDS.has(value)) {
    fail('itemKind', 'itemKind must be session, note, link or other', reminder);
  }
  return value;
}

export function assertItem(itemKind, itemId, place) {
  return { itemKind: readKind(itemKind, place), itemId: readItemId(itemId, place) };
}

function readTitle(value, reminder) {
  if (typeof value !== 'string') fail('title', 'title must be text', reminder);
  if (value.length < 1 || value.length > TITLE_MAX) {
    fail('title', `title must be 1 to ${TITLE_MAX} characters`, reminder);
  }
  if (hasBadControl(value, { note: false })) fail('title', 'title must be one line', reminder);
  return value;
}

function readNote(value, reminder) {
  if (typeof value !== 'string') fail('note', 'note must be text', reminder);
  if (value.length < 1 || value.length > NOTE_MAX) {
    fail('note', `note must be 1 to ${NOTE_MAX} characters`, reminder);
  }
  if (hasBadControl(value, { note: true })) fail('note', 'note holds a control character', reminder);
  return value;
}

function readDate(value, field, reminder) {
  if (!isRealDate(value)) fail(field, `${field} must be a real calendar day in YYYY-MM-DD form`, reminder);
  return value;
}

function readWhen(value, reminder) {
  if (!isPlain(value)) fail('when', 'when must be an object', reminder);
  const hasOn = Object.hasOwn(value, 'on');
  const hasSpan = Object.hasOwn(value, 'afterDays') || Object.hasOwn(value, 'from');
  if (hasOn && hasSpan) fail('when', 'when must be a day or a number of days, not both', reminder);
  if (!hasOn && !hasSpan) fail('when', 'when must be a day or a number of days', reminder);
  if (hasOn) {
    for (const key of Object.keys(value)) {
      if (key !== 'on') fail(`when.${key}`, `when.${key} is not a when field`, reminder);
    }
    readDate(value.on, 'when.on', reminder);
    return { on: value.on };
  }
  for (const key of Object.keys(value)) {
    if (key !== 'afterDays' && key !== 'from') fail(`when.${key}`, `when.${key} is not a when field`, reminder);
  }
  if (!Object.hasOwn(value, 'afterDays')) fail('when.afterDays', 'when.afterDays is missing', reminder);
  if (!Object.hasOwn(value, 'from')) fail('when.from', 'when.from is missing', reminder);
  if (!isWhole(value.afterDays) || value.afterDays < 1 || value.afterDays > MAX_SPAN) {
    fail('when.afterDays', `when.afterDays must be a whole number from 1 to ${MAX_SPAN}`, reminder);
  }
  readDate(value.from, 'when.from', reminder);
  if (!addDays(value.from, value.afterDays)) {
    fail('when.afterDays', 'when.afterDays lands outside year 0001 to 9999', reminder);
  }
  return { afterDays: value.afterDays, from: value.from };
}

function shape(fields) {
  const reminder = {
    id: fields.id,
    itemId: fields.itemId,
    itemKind: fields.itemKind,
    title: fields.title,
    when: fields.when.on !== undefined
      ? { on: fields.when.on }
      : { afterDays: fields.when.afterDays, from: fields.when.from },
  };
  if (fields.note !== undefined) reminder.note = fields.note;
  reminder.createdOn = fields.createdOn;
  if (fields.snoozedUntil !== undefined) reminder.snoozedUntil = fields.snoozedUntil;
  if (fields.doneOn !== undefined) reminder.doneOn = fields.doneOn;
  return reminder;
}

export function validateReminder(input, index) {
  const place = String(index);
  if (!isPlain(input)) fail('reminder', 'reminder must be an object', place);
  const id = readId(input, place);
  const reminder = `"${id}"`;
  for (const key of Object.keys(input)) {
    if (!REMINDER_KEYS.has(key)) fail(key, `${key} is not a reminder field`, reminder);
  }
  requireKey(input, 'itemId', reminder);
  requireKey(input, 'itemKind', reminder);
  requireKey(input, 'title', reminder);
  requireKey(input, 'when', reminder);
  requireKey(input, 'createdOn', reminder);
  const fields = {
    id,
    itemId: readItemId(input.itemId, reminder),
    itemKind: readKind(input.itemKind, reminder),
    title: readTitle(input.title, reminder),
    when: readWhen(input.when, reminder),
    createdOn: readDate(input.createdOn, 'createdOn', reminder),
  };
  if (Object.hasOwn(input, 'note')) fields.note = readNote(input.note, reminder);
  if (Object.hasOwn(input, 'snoozedUntil')) {
    fields.snoozedUntil = readDate(input.snoozedUntil, 'snoozedUntil', reminder);
  }
  if (Object.hasOwn(input, 'doneOn')) fields.doneOn = readDate(input.doneOn, 'doneOn', reminder);
  return shape(fields);
}

export function readList(reminders) {
  if (!Array.isArray(reminders)) fail('reminders', 'reminders must be a list');
  const seen = new Set();
  const list = [];
  for (let index = 0; index < reminders.length; index += 1) {
    const reminder = validateReminder(reminders[index], index + 1);
    if (seen.has(reminder.id)) fail('id', 'id is repeated', `"${reminder.id}"`);
    seen.add(reminder.id);
    list.push(reminder);
  }
  return list;
}

export function dueOn(reminder) {
  const base = reminder.when.on !== undefined
    ? reminder.when.on
    : addDays(reminder.when.from, reminder.when.afterDays);
  if (reminder.snoozedUntil !== undefined && reminder.snoozedUntil > base) return reminder.snoozedUntil;
  return base;
}

function locate(list, id) {
  const name = callerId(id);
  const index = list.findIndex(reminder => reminder.id === name);
  if (index < 0) fail('id', 'id is not in the list', `"${name}"`);
  return index;
}

function sameItemWarnings(list, next) {
  const due = dueOn(next);
  const warnings = [];
  for (const existing of list) {
    if (existing.doneOn !== undefined) continue;
    if (existing.itemKind !== next.itemKind || existing.itemId !== next.itemId) continue;
    if (dueOn(existing) !== due) continue;
    warnings.push({
      field: 'itemId',
      id: next.id,
      existingId: existing.id,
      message: `field itemId: another open reminder (${existing.id}) already points at this ${next.itemKind} on ${due}`,
    });
  }
  return warnings;
}

export function addReminder(reminders, reminder) {
  const list = readList(reminders);
  const next = validateReminder(reminder, list.length + 1);
  if (list.some(existing => existing.id === next.id)) fail('id', 'id is repeated', `"${next.id}"`);
  const warnings = sameItemWarnings(list, next);
  list.push(next);
  return { reminders: list, warnings };
}

export function editReminder(reminders, id, patch) {
  const list = readList(reminders);
  const index = locate(list, id);
  const name = `"${list[index].id}"`;
  if (!isPlain(patch)) fail('title', 'changes must be an object with title, note or when', name);
  const keys = Object.keys(patch);
  if (keys.length === 0) fail('title', 'nothing to change (title, note or when)', name);
  for (const key of keys) {
    if (!PATCH_KEYS.has(key)) fail(key, `${key} cannot be changed`, name);
  }
  const fields = { ...list[index], when: list[index].when };
  if (Object.hasOwn(patch, 'title')) fields.title = readTitle(patch.title, name);
  if (Object.hasOwn(patch, 'note')) {
    if (patch.note === null || patch.note === '') delete fields.note;
    else fields.note = readNote(patch.note, name);
  }
  if (Object.hasOwn(patch, 'when')) fields.when = readWhen(patch.when, name);
  list[index] = shape(fields);
  return { reminders: list, warnings: [] };
}

function readSnooze(change, today, name) {
  if (!isPlain(change)) fail('snoozedUntil', 'snooze must be a date or a number of days', name);
  const hasUntil = Object.hasOwn(change, 'until');
  const hasDays = Object.hasOwn(change, 'days');
  for (const key of Object.keys(change)) {
    if (key !== 'until' && key !== 'days') fail(key, `${key} is not a snooze field`, name);
  }
  if (hasUntil === hasDays) fail('snoozedUntil', 'set until or days, not both and not neither', name);
  if (hasUntil) return readDate(change.until, 'snoozedUntil', name);
  if (!isWhole(change.days) || change.days < 1 || change.days > MAX_SPAN) {
    fail('days', `days must be a whole number from 1 to ${MAX_SPAN}`, name);
  }
  const until = addDays(today, change.days);
  if (!until) fail('days', 'days lands outside year 0001 to 9999', name);
  return until;
}

export function snoozeReminder(reminders, id, change, today) {
  readDate(today, 'today');
  const list = readList(reminders);
  const index = locate(list, id);
  const name = `"${list[index].id}"`;
  if (list[index].doneOn !== undefined) fail('doneOn', 'doneOn is set, so the reminder is not open', name);
  const until = readSnooze(change, today, name);
  if (until <= today) fail('snoozedUntil', 'snoozedUntil must be after today', name);
  list[index] = shape({ ...list[index], snoozedUntil: until });
  return { reminders: list, warnings: [] };
}

export function markDone(reminders, id, today) {
  readDate(today, 'today');
  const list = readList(reminders);
  const index = locate(list, id);
  const name = `"${list[index].id}"`;
  if (list[index].doneOn !== undefined) fail('doneOn', 'doneOn is already set', name);
  list[index] = shape({ ...list[index], doneOn: today });
  return { reminders: list, warnings: [] };
}

export function removeReminder(reminders, id) {
  const list = readList(reminders);
  const index = locate(list, id);
  list.splice(index, 1);
  return { reminders: list, warnings: [] };
}

export function byId(a, b) {
  return compareText(a.id, b.id);
}
