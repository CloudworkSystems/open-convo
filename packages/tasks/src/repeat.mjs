/**
 * Repeat rules. On-schedule dates follow the pattern from the start date.
 * After-done dates are counted by the engine from a completion's action date;
 * this module only knows the pattern itself.
 *
 * Weekday intervals use Monday as the week start, RFC 5545's default.
 * A numbered weekday that a month does not have (the fifth Monday) is skipped.
 */

import {
  WEEKDAYS, addDays, dateInMonth, daysBetween, daysInMonth, monthIndex, nthWeekday,
  splitDate, validDate, weekIndex, weekdayName,
} from './time.mjs';

const fail = message => { throw new Error(message); };
const PLAIN = new Set(['days', 'weeks', 'months', 'years']);
const PATTERNED = new Set(['weekdays', 'monthDay', 'monthWeekday']);
export const REPEAT_KINDS = Object.freeze([...PLAIN, ...PATTERNED]);
export const REPEAT_MODES = Object.freeze(['onSchedule', 'afterDone']);

function dayOf(iso) {
  return splitDate(iso).day;
}

export function canonicalRepeat(rule) {
  if (rule == null) return null;
  return {
    kind: rule.kind,
    every: rule.every,
    mode: rule.mode,
    start: rule.start,
    weekdays: rule.weekdays ? rule.weekdays.slice() : null,
    monthDay: rule.monthDay ?? null,
    weekday: rule.weekday ?? null,
    which: rule.which ?? null,
    endAfter: rule.endAfter ?? null,
    endOn: rule.endOn ?? null,
  };
}

function sortWeekdays(days) {
  const unique = [];
  for (const day of WEEKDAYS) if (days.includes(day) && !unique.includes(day)) unique.push(day);
  return unique;
}

export function matchesPattern(date, rule) {
  if (!validDate(date) || date < rule.start) return false;
  if (rule.kind === 'days') {
    const diff = daysBetween(rule.start, date);
    return diff >= 0 && diff % rule.every === 0;
  }
  if (rule.kind === 'weeks') {
    const diff = daysBetween(rule.start, date);
    return diff >= 0 && diff % (rule.every * 7) === 0;
  }
  if (rule.kind === 'weekdays') {
    if (!rule.weekdays.includes(weekdayName(date))) return false;
    const weeks = weekIndex(date) - weekIndex(rule.start);
    return weeks >= 0 && weeks % rule.every === 0;
  }
  if (rule.kind === 'months' || rule.kind === 'monthDay') {
    const anchor = rule.kind === 'monthDay' ? rule.monthDay : dayOf(rule.start);
    const diff = monthIndex(date) - monthIndex(rule.start);
    if (diff < 0 || diff % rule.every !== 0) return false;
    const { year, month, day } = splitDate(date);
    return day === Math.min(anchor, daysInMonth(year, month));
  }
  if (rule.kind === 'monthWeekday') {
    const diff = monthIndex(date) - monthIndex(rule.start);
    if (diff < 0 || diff % rule.every !== 0) return false;
    const { year, month } = splitDate(date);
    return nthWeekday(year, month, rule.weekday, rule.which) === date;
  }
  if (rule.kind === 'years') {
    const start = splitDate(rule.start);
    const current = splitDate(date);
    const diff = current.year - start.year;
    if (diff < 0 || diff % rule.every !== 0) return false;
    const anchorMonth = start.month;
    const anchorDay = start.day;
    return current.month === anchorMonth && current.day === Math.min(anchorDay, daysInMonth(current.year, anchorMonth));
  }
  return false;
}

export function firstStrictlyAfter(rule, occurrenceDate) {
  if (occurrenceDate < rule.start) return rule.start;
  if (rule.kind === 'days' || rule.kind === 'weeks') {
    const step = rule.kind === 'weeks' ? rule.every * 7 : rule.every;
    const diff = daysBetween(rule.start, occurrenceDate);
    const steps = Math.floor(diff / step) + 1;
    return addDays(rule.start, steps * step);
  }
  if (rule.kind === 'weekdays') {
    let cursor = addDays(occurrenceDate, 1);
    if (cursor < rule.start) cursor = rule.start;
    const limit = rule.every * 7 + 7;
    for (let i = 0; i < limit; i += 1) {
      if (matchesPattern(cursor, rule)) return cursor;
      cursor = addDays(cursor, 1);
    }
    return null;
  }
  if (rule.kind === 'months' || rule.kind === 'monthDay') {
    const anchor = rule.kind === 'monthDay' ? rule.monthDay : dayOf(rule.start);
    const base = monthIndex(rule.start);
    const diff = monthIndex(occurrenceDate) - base;
    let k = Math.max(0, Math.floor(diff / rule.every));
    for (let i = 0; i < 6; i += 1) {
      const date = dateInMonth(base + (k + i) * rule.every, anchor);
      if (date > occurrenceDate && date >= rule.start) return date;
    }
    return null;
  }
  if (rule.kind === 'monthWeekday') {
    const base = monthIndex(rule.start);
    const diff = Math.max(0, monthIndex(occurrenceDate) - base);
    let k = Math.floor(diff / rule.every);
    for (let i = 0; i < 2400; i += 1) {
      const month = base + (k + i) * rule.every;
      const year = Math.floor(month / 12);
      const monthNumber = month % 12 + 1;
      const date = nthWeekday(year, monthNumber, rule.weekday, rule.which);
      if (date && date >= rule.start && date > occurrenceDate) return date;
    }
    return null;
  }
  if (rule.kind === 'years') {
    const start = splitDate(rule.start);
    const diff = splitDate(occurrenceDate).year - start.year;
    let k = Math.max(0, Math.floor(diff / rule.every));
    for (let i = 0; i < 6; i += 1) {
      const year = start.year + (k + i) * rule.every;
      const date = dateInMonth(year * 12 + (start.month - 1), start.day);
      if (date > occurrenceDate && date >= rule.start) return date;
    }
    return null;
  }
  return null;
}

/**
 * Next on-schedule date after an occurrence. A result earlier than the rule's
 * start becomes the start, and a result past endOn is no date.
 */
export function onScheduleNext(rule, occurrenceDate) {
  const next = firstStrictlyAfter(rule, occurrenceDate);
  if (!next) return null;
  const clamped = next < rule.start ? rule.start : next;
  if (clamped <= occurrenceDate) return null;
  if (rule.endOn && clamped > rule.endOn) return null;
  return clamped;
}

/**
 * First date of a new rule on or after an anchor, used when the rule is edited.
 * The anchor's own week or month is the start of the interval, so a later
 * chosen weekday in that same week still counts. Plain kinds keep the anchor.
 */
export function firstOnOrAfter(partial, anchor) {
  const probe = canonicalRepeat({ ...partial, start: anchor });
  if (matchesPattern(anchor, probe)) return anchor;
  let cursor = anchor;
  for (let i = 0; i < 4000; i += 1) {
    cursor = addDays(cursor, 1);
    if (matchesPattern(cursor, probe)) return cursor;
  }
  fail('The start date is not one of the chosen days.');
}

function readEvery(kind, every) {
  const limit = kind === 'days' ? 365 : 99;
  if (!Number.isSafeInteger(every) || every < 1 || every > limit) {
    fail(kind === 'days' ? 'Repeat every must be from 1 to 365.' : 'Repeat every must be from 1 to 99.');
  }
  return every;
}

function readEnds(input) {
  let endAfter = null;
  let endOn = null;
  if (input.endAfter != null) {
    if (!Number.isSafeInteger(input.endAfter) || input.endAfter < 1 || input.endAfter > 999) fail('Repeat end after must be from 1 to 999.');
    endAfter = input.endAfter;
  }
  if (input.endOn != null) {
    if (!validDate(input.endOn)) fail('Repeat end on must be YYYY-MM-DD.');
    endOn = input.endOn;
  }
  return { endAfter, endOn };
}

/**
 * Build a stored repeat. exactStart refuses a patterned rule whose anchor is
 * not one of its dates. A rule edit passes exactStart false and lands on the
 * first matching date on or after the anchor.
 */
export function normalizeRepeat(input, anchor, { exactStart }) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) fail('Repeat must be an object.');
  const kind = input.kind;
  if (!REPEAT_KINDS.includes(kind)) fail('Unknown repeat kind.');
  const mode = input.mode;
  if (!REPEAT_MODES.includes(mode)) fail('Repeat mode must be onSchedule or afterDone.');
  if (mode === 'afterDone' && !PLAIN.has(kind)) fail('After done only works for a daily, weekly, monthly or yearly repeat.');
  const every = readEvery(kind, input.every);
  const ends = readEnds(input);
  let weekdays = null;
  let monthDay = null;
  let weekday = null;
  let which = null;
  if (kind === 'weekdays') {
    if (!Array.isArray(input.weekdays) || input.weekdays.length === 0) fail('Choose at least one weekday.');
    if (input.weekdays.some(day => !WEEKDAYS.includes(day))) fail('Unknown weekday.');
    weekdays = sortWeekdays(input.weekdays);
    if (weekdays.length === 0) fail('Choose at least one weekday.');
  }
  if (kind === 'monthDay') {
    if (!Number.isSafeInteger(input.monthDay) || input.monthDay < 1 || input.monthDay > 31) fail('Month day must be from 1 to 31.');
    monthDay = input.monthDay;
  }
  if (kind === 'monthWeekday') {
    if (!WEEKDAYS.includes(input.weekday)) fail('Unknown weekday.');
    weekday = input.weekday;
    const raw = input.which === 'last' ? -1 : input.which;
    if (!Number.isSafeInteger(raw) || ![-1, 1, 2, 3, 4, 5].includes(raw)) fail('Weekday number must be 1 to 5 or last.');
    which = raw;
  }
  if (!validDate(anchor)) fail('A repeating task needs a due date.');
  const partial = { kind, every, mode, weekdays, monthDay, weekday, which, endAfter: ends.endAfter, endOn: ends.endOn };
  const start = exactStart ? anchor : firstOnOrAfter(partial, anchor);
  const rule = canonicalRepeat({ ...partial, start });
  if (exactStart && !matchesPattern(start, rule)) fail('The start date is not one of the chosen days.');
  if (!matchesPattern(rule.start, rule)) fail('The start date is not one of the chosen days.');
  if (rule.endOn && rule.endOn < rule.start) fail('The end date is before the start.');
  return rule;
}

/** The first dates of a rule, capped by endAfter and endOn. */
export function occurrenceDates(rule, count) {
  const stored = canonicalRepeat(rule);
  if (!stored || !REPEAT_KINDS.includes(stored.kind) || !validDate(stored.start)) fail('Repeat must be an object.');
  if (!Number.isSafeInteger(count) || count < 1 || count > 800) fail('Date count must be from 1 to 800.');
  const dates = [];
  let date = stored.start;
  let guard = 0;
  while (date && dates.length < count && guard < 5000) {
    guard += 1;
    if (stored.endOn && date > stored.endOn) break;
    if (stored.endAfter != null && dates.length >= stored.endAfter) break;
    dates.push(date);
    const next = onScheduleNext(stored, date);
    if (!next || next <= date) break;
    date = next;
  }
  return dates;
}

export function shiftAfterDone(actionDate, rule) {
  if (rule.kind === 'days') return addDays(actionDate, rule.every);
  if (rule.kind === 'weeks') return addDays(actionDate, rule.every * 7);
  if (rule.kind === 'months') return dateInMonth(monthIndex(actionDate) + rule.every, dayOf(actionDate));
  if (rule.kind === 'years') {
    const { year, month, day } = splitDate(actionDate);
    return dateInMonth((year + rule.every) * 12 + (month - 1), day);
  }
  fail('After done only works for a daily, weekly, monthly or yearly repeat.');
}
