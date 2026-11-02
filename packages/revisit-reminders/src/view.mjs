// The list view. Buckets for due, coming up, missing and done are new
// lists. The reminders passed in are not changed.

import { addDays, compareText, daysBetween, isRealDate } from './dates.mjs';
import { DEFAULT_DAYS, MAX_SPAN, fail } from './errors.mjs';
import { assertItem, dueOn, readList } from './reminder.mjs';

const OPTION_KEYS = new Set(['today', 'days', 'knownItems']);

function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWhole(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0);
}

function readWindow(days, today) {
  if (!isWhole(days) || days < 0 || days > MAX_SPAN) {
    fail('days', `days must be a whole number from 0 to ${MAX_SPAN}`);
  }
  const end = addDays(today, days);
  if (!end) fail('days', 'days lands outside year 0001 to 9999');
  return { days, end };
}

function readKnown(knownItems) {
  if (!Array.isArray(knownItems)) fail('knownItems', 'knownItems must be a list');
  const known = new Set();
  for (let index = 0; index < knownItems.length; index += 1) {
    const place = `knownItems ${index + 1}`;
    const entry = knownItems[index];
    if (!isPlain(entry)) fail('knownItems', 'knownItems must be objects', place);
    for (const key of Object.keys(entry)) {
      if (key !== 'itemKind' && key !== 'itemId') fail(key, `${key} is not a known item field`, place);
    }
    if (!Object.hasOwn(entry, 'itemKind')) fail('itemKind', 'itemKind is missing', place);
    if (!Object.hasOwn(entry, 'itemId')) fail('itemId', 'itemId is missing', place);
    const checked = assertItem(entry.itemKind, entry.itemId, place);
    known.add(`${checked.itemKind}\0${checked.itemId}`);
  }
  return known;
}

function viewRow(reminder, today) {
  const row = {
    id: reminder.id,
    itemId: reminder.itemId,
    itemKind: reminder.itemKind,
    title: reminder.title,
    when: reminder.when.on !== undefined
      ? { on: reminder.when.on }
      : { afterDays: reminder.when.afterDays, from: reminder.when.from },
  };
  if (reminder.note !== undefined) row.note = reminder.note;
  row.createdOn = reminder.createdOn;
  if (reminder.snoozedUntil !== undefined) row.snoozedUntil = reminder.snoozedUntil;
  if (reminder.doneOn !== undefined) row.doneOn = reminder.doneOn;
  row.dueOn = dueOn(reminder);
  if (reminder.doneOn === undefined && row.dueOn < today) row.daysOverdue = daysBetween(row.dueOn, today);
  return row;
}

function byDueTitleId(a, b) {
  return compareText(a.dueOn, b.dueOn) || compareText(a.title, b.title) || compareText(a.id, b.id);
}

export function listView(reminders, options = {}) {
  if (!isPlain(options)) fail('today', 'options must be an object');
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) fail(key, `${key} is not a list option`);
  }
  if (!Object.hasOwn(options, 'today')) fail('today', 'today is missing');
  if (!isRealDate(options.today)) fail('today', 'today must be a real calendar day in YYYY-MM-DD form');
  const today = options.today;
  const { end } = readWindow(Object.hasOwn(options, 'days') ? options.days : DEFAULT_DAYS, today);
  const known = Object.hasOwn(options, 'knownItems') ? readKnown(options.knownItems) : null;
  const list = readList(reminders);
  const overdue = [];
  const dueToday = [];
  const comingUp = [];
  const missingItem = [];
  const done = [];
  for (const reminder of list) {
    if (reminder.doneOn !== undefined) {
      done.push(viewRow(reminder, today));
      continue;
    }
    const row = viewRow(reminder, today);
    if (row.dueOn < today) overdue.push(row);
    else if (row.dueOn === today) dueToday.push(row);
    else if (row.dueOn <= end) comingUp.push(row);
    if (known && !known.has(`${reminder.itemKind}\0${reminder.itemId}`)) missingItem.push(viewRow(reminder, today));
  }
  overdue.sort(byDueTitleId);
  dueToday.sort(byDueTitleId);
  comingUp.sort(byDueTitleId);
  missingItem.sort(byDueTitleId);
  done.sort(byDueTitleId);
  return {
    overdue,
    dueToday,
    comingUp,
    missingItem,
    done,
    counts: {
      overdue: overdue.length,
      dueToday: dueToday.length,
      comingUp: comingUp.length,
      missingItem: missingItem.length,
      done: done.length,
    },
  };
}
