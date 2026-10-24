// RRULE reading and expansion (RFC 5545 section 3.3.10), for FREQ of DAILY,
// WEEKLY, MONTHLY and YEARLY. Expansion works on dates (day numbers); the
// time of day is the series' own, so repeats follow local time.

import { civilFromDays, daysFromCivil, daysInMonth, isLeapYear, weekdayOf } from './time.mjs';

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export const MAX_COUNT = 1_000_000;

// Thrown when expanding one series would take more work than it is allowed.
export class WorkLimit extends Error {}

const SUPPORTED_FREQ = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const UNSUPPORTED_FREQ = new Set(['HOURLY', 'MINUTELY', 'SECONDLY']);
const UNSUPPORTED_PARTS = new Set(['BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYWEEKNO', 'BYYEARDAY']);
const KNOWN_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'WKST', ...UNSUPPORTED_PARTS]);

function intList(text, min, max, allowNegative) {
  const out = [];
  for (const piece of text.split(',')) {
    if (!/^[+-]?\d{1,3}$/.test(piece)) return null;
    const n = Number(piece);
    if (n === 0 || Math.abs(n) < min || Math.abs(n) > max || (n < 0 && !allowNegative)) return null;
    out.push(n);
  }
  return out;
}

// { rule } or { unsupported: 'reason' }. A rule the standard doesn't allow is
// also reported as not supported, so the series still shows its first
// occurrence instead of disappearing.
export function parseRRule(text) {
  const parts = new Map();
  for (const piece of text.trim().split(';')) {
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq < 1) return { unsupported: `unreadable rule part "${piece}"` };
    const name = piece.slice(0, eq).toUpperCase();
    if (parts.has(name)) return { unsupported: `${name} given twice` };
    parts.set(name, piece.slice(eq + 1));
  }
  const freq = (parts.get('FREQ') || '').toUpperCase();
  if (UNSUPPORTED_FREQ.has(freq)) return { unsupported: `FREQ=${freq}` };
  if (!SUPPORTED_FREQ.has(freq)) return { unsupported: freq ? `unknown FREQ=${freq}` : 'no FREQ' };
  for (const name of parts.keys()) {
    if (UNSUPPORTED_PARTS.has(name)) return { unsupported: name };
    if (!KNOWN_PARTS.has(name)) return { unsupported: `unknown rule part ${name}` };
  }
  const rule = { freq, interval: 1, count: null, until: null, byday: null, bymonthday: null, bymonth: null, bysetpos: null, wkst: 1 };
  if (parts.has('INTERVAL')) {
    if (!/^\d{1,6}$/.test(parts.get('INTERVAL')) || Number(parts.get('INTERVAL')) < 1) return { unsupported: 'bad INTERVAL' };
    rule.interval = Number(parts.get('INTERVAL'));
  }
  if (parts.has('COUNT') && parts.has('UNTIL')) return { unsupported: 'both COUNT and UNTIL' };
  if (parts.has('COUNT')) {
    if (!/^\d{1,12}$/.test(parts.get('COUNT')) || Number(parts.get('COUNT')) < 1) return { unsupported: 'bad COUNT' };
    rule.count = Number(parts.get('COUNT'));
    if (rule.count > MAX_COUNT) return { unsupported: `COUNT above ${MAX_COUNT}` };
  }
  if (parts.has('UNTIL')) rule.until = parts.get('UNTIL');
  if (parts.has('BYDAY')) {
    rule.byday = [];
    for (const piece of parts.get('BYDAY').toUpperCase().split(',')) {
      const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(piece);
      if (!match) return { unsupported: `bad BYDAY "${piece}"` };
      const n = match[1] ? Number(match[1]) : 0;
      if (match[1] && (n === 0 || Math.abs(n) > 53)) return { unsupported: `bad BYDAY "${piece}"` };
      if (n && (freq === 'DAILY' || freq === 'WEEKLY')) return { unsupported: `numbered BYDAY with FREQ=${freq}` };
      rule.byday.push({ n, wd: WEEKDAYS.indexOf(match[2]) });
    }
  }
  if (parts.has('BYMONTHDAY')) {
    if (freq === 'WEEKLY') return { unsupported: 'BYMONTHDAY with FREQ=WEEKLY' };
    rule.bymonthday = intList(parts.get('BYMONTHDAY'), 1, 31, true);
    if (!rule.bymonthday) return { unsupported: 'bad BYMONTHDAY' };
  }
  if (parts.has('BYMONTH')) {
    rule.bymonth = intList(parts.get('BYMONTH'), 1, 12, false);
    if (!rule.bymonth) return { unsupported: 'bad BYMONTH' };
  }
  if (parts.has('BYSETPOS')) {
    rule.bysetpos = intList(parts.get('BYSETPOS'), 1, 366, true);
    if (!rule.bysetpos) return { unsupported: 'bad BYSETPOS' };
    if (!rule.byday && !rule.bymonthday && !rule.bymonth) return { unsupported: 'BYSETPOS without another BY rule' };
  }
  if (parts.has('WKST')) {
    const wkst = WEEKDAYS.indexOf(parts.get('WKST').toUpperCase());
    if (wkst < 0) return { unsupported: 'bad WKST' };
    rule.wkst = wkst;
  }
  return { rule };
}

// ---- Candidate dates in one period --------------------------------------

function nthWeekday(firstDay, lastDay, n, wd) {
  if (n > 0) {
    const first = firstDay + ((wd - weekdayOf(firstDay) + 7) % 7);
    const day = first + (n - 1) * 7;
    return day <= lastDay ? day : null;
  }
  const last = lastDay - ((weekdayOf(lastDay) - wd + 7) % 7);
  const day = last + (n + 1) * 7;
  return day >= firstDay ? day : null;
}

// BYDAY within [firstDay, lastDay]: numbered entries pick the nth, plain
// entries every such weekday.
function bydaySet(byday, firstDay, lastDay) {
  const out = new Set();
  for (const { n, wd } of byday) {
    if (n) {
      const day = nthWeekday(firstDay, lastDay, n, wd);
      if (day !== null) out.add(day);
    } else {
      for (let day = firstDay + ((wd - weekdayOf(firstDay) + 7) % 7); day <= lastDay; day += 7) out.add(day);
    }
  }
  return out;
}

function monthdaySet(bymonthday, y, m) {
  const out = new Set();
  const dim = daysInMonth(y, m);
  for (const n of bymonthday) {
    const d = n > 0 ? n : dim + 1 + n;
    if (d >= 1 && d <= dim) out.add(daysFromCivil(y, m, d));
  }
  return out;
}

function monthCandidates(rule, y, m, start) {
  const first = daysFromCivil(y, m, 1);
  const last = first + daysInMonth(y, m) - 1;
  if (rule.bymonthday || rule.byday) {
    let days = rule.bymonthday ? monthdaySet(rule.bymonthday, y, m) : null;
    if (rule.byday) {
      const byday = bydaySet(rule.byday, first, last);
      days = days ? new Set([...days].filter((d) => byday.has(d))) : byday;
    }
    return [...days];
  }
  return start.d <= daysInMonth(y, m) ? [daysFromCivil(y, m, start.d)] : [];
}

function periodCandidates(rule, ctx, k) {
  const { start, startDay } = ctx;
  let days;
  if (rule.freq === 'DAILY') {
    days = [startDay + k * rule.interval];
  } else if (rule.freq === 'WEEKLY') {
    const weekStart = ctx.weekStart + 7 * rule.interval * k;
    const wanted = rule.byday ? new Set(rule.byday.map((b) => b.wd)) : new Set([weekdayOf(startDay)]);
    days = [];
    for (let day = weekStart; day < weekStart + 7; day += 1) if (wanted.has(weekdayOf(day))) days.push(day);
  } else if (rule.freq === 'MONTHLY') {
    const index = start.y * 12 + (start.m - 1) + k * rule.interval;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    days = monthCandidates(rule, y, m, start);
  } else {
    const y = start.y + k * rule.interval;
    if (rule.bymonth) {
      days = [];
      for (const m of rule.bymonth) days.push(...monthCandidates(rule, y, m, start));
    } else if (rule.bymonthday || rule.byday) {
      const first = daysFromCivil(y, 1, 1);
      const last = daysFromCivil(y, 12, 31);
      if (rule.bymonthday) {
        days = [];
        for (let m = 1; m <= 12; m += 1) days.push(...monthdaySet(rule.bymonthday, y, m));
        if (rule.byday) {
          const byday = bydaySet(rule.byday, first, last);
          days = days.filter((d) => byday.has(d));
        }
      } else {
        days = [...bydaySet(rule.byday, first, last)];
      }
    } else {
      days = start.m === 2 && start.d === 29 && !isLeapYear(y) ? [] : [daysFromCivil(y, start.m, start.d)];
    }
  }
  // BYxxx rule parts at a finer level than FREQ limit the set.
  days = days.filter((day) => {
    const { m } = civilFromDays(day);
    if (rule.bymonth && !rule.bymonth.includes(m)) return false;
    if (rule.freq === 'DAILY' || rule.freq === 'WEEKLY') {
      if (rule.freq === 'DAILY' && rule.byday && !rule.byday.some((b) => b.wd === weekdayOf(day))) return false;
      if (rule.freq === 'DAILY' && rule.bymonthday) {
        const { y, m: mm } = civilFromDays(day);
        if (!monthdaySet(rule.bymonthday, y, mm).has(day)) return false;
      }
    }
    return true;
  });
  days = [...new Set(days)].sort((a, b) => a - b);
  if (rule.bysetpos) {
    const picked = new Set();
    for (const pos of rule.bysetpos) {
      const day = pos > 0 ? days[pos - 1] : days[days.length + pos];
      if (day !== undefined) picked.add(day);
    }
    days = [...picked].sort((a, b) => a - b);
  }
  return days;
}

// First day a period can contain, used to stop expanding.
function periodFirstDay(rule, ctx, k) {
  if (rule.freq === 'DAILY') return ctx.startDay + k * rule.interval;
  if (rule.freq === 'WEEKLY') return ctx.weekStart + 7 * rule.interval * k;
  if (rule.freq === 'MONTHLY') {
    const index = ctx.start.y * 12 + (ctx.start.m - 1) + k * rule.interval;
    return daysFromCivil(Math.floor(index / 12), (index % 12) + 1, 1);
  }
  return daysFromCivil(ctx.start.y + k * rule.interval, 1, 1);
}

// The first period that can reach `fromDay`, so a series that began long ago
// is not stepped through from its start.
function firstUsefulPeriod(rule, ctx, fromDay) {
  if (fromDay <= ctx.startDay) return 0;
  let k;
  if (rule.freq === 'DAILY') k = Math.floor((fromDay - ctx.startDay) / rule.interval);
  else if (rule.freq === 'WEEKLY') k = Math.floor((fromDay - ctx.weekStart) / (7 * rule.interval));
  else if (rule.freq === 'MONTHLY') {
    const from = civilFromDays(fromDay);
    k = Math.floor((from.y * 12 + from.m - (ctx.start.y * 12 + ctx.start.m)) / rule.interval);
  } else {
    k = Math.floor((civilFromDays(fromDay).y - ctx.start.y) / rule.interval);
  }
  return Math.max(0, k);
}

// Dates of a series' RRULE instances, in order, DTSTART first (it always
// counts as the first occurrence). `window` is { fromDay, toDay } in the
// series' own dates; only dates from fromDay on are returned. Without COUNT,
// expansion starts at the first period that can reach fromDay; with COUNT it
// counts from DTSTART. It stops after toDay,
// at the count, or at the first date `pastUntil(day)` says is after UNTIL.
// `stats.steps` counts the periods visited; past `maxSteps` it throws a
// WorkLimit.
export function expandRuleDays(rule, startDay, window, pastUntil = () => false, stats = { steps: 0 }, maxSteps = Infinity) {
  const start = civilFromDays(startDay);
  const ctx = { start, startDay, weekStart: startDay - ((weekdayOf(startDay) - rule.wkst + 7) % 7) };
  const out = [];
  let k = rule.count === null ? firstUsefulPeriod(rule, ctx, window.fromDay) : 0;
  let produced = 0;
  if (k === 0) {
    // DTSTART is always the first instance, matching the rule or not, and
    // even when UNTIL is before it: UNTIL bounds only the dates the rule
    // makes (RFC 5545 3.8.5.3).
    if (startDay >= window.fromDay) out.push(startDay);
    if (pastUntil(startDay)) return out;
    produced = 1;
  }
  for (;; k += 1) {
    if (rule.count !== null && produced >= rule.count) break;
    if (periodFirstDay(rule, ctx, k) > window.toDay) break;
    stats.steps += 1;
    if (stats.steps > maxSteps) throw new WorkLimit(`more than ${maxSteps} repeat periods to reach the range`);
    for (const day of periodCandidates(rule, ctx, k)) {
      if (day <= startDay) continue;
      if (day > window.toDay) return out;
      if (pastUntil(day)) return out;
      if (day >= window.fromDay) out.push(day);
      produced += 1;
      if (rule.count !== null && produced >= rule.count) return out;
    }
  }
  return out;
}
