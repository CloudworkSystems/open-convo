// RRULE reading and expansion (RFC 5545 section 3.3.10), for FREQ of DAILY,
// WEEKLY, MONTHLY and YEARLY. Expansion works on dates (day numbers); the
// time of day is the series' own, so repeats follow local time.

import { civilFromDays, daysFromCivil, daysInMonth, isLeapYear, weekdayOf } from './time.mjs';

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export const MAX_COUNT = 1_000_000;
export const MAX_INTERVAL = 10_000_000;

// Thrown when expanding one series would take more work than it is allowed.
export class WorkLimit extends Error {}

const SUPPORTED_FREQ = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const UNSUPPORTED_FREQ = new Set(['HOURLY', 'MINUTELY', 'SECONDLY']);
const UNSUPPORTED_PARTS = new Set(['BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYWEEKNO', 'BYYEARDAY']);
const KNOWN_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'WKST', ...UNSUPPORTED_PARTS]);

// Most distinct values each BYxxx list can hold. Lists are deduplicated when
// read, so no list is longer than this whatever its written length: BYMONTHDAY
// +-1..31, BYMONTH 1..12, BYSETPOS +-1..366, BYDAY seven plain weekdays plus
// seven for each of +-1..53.
export const MAX_DISTINCT = Object.freeze({ BYMONTHDAY: 62, BYMONTH: 12, BYSETPOS: 732, BYDAY: 7 + 7 * 106 });

// A comma list of whole numbers, checked, deduplicated and sorted, or null.
function intList(text, min, max, allowNegative) {
  const seen = new Set();
  for (const piece of text.split(',')) {
    if (!/^[+-]?\d{1,3}$/.test(piece)) return null;
    const n = Number(piece);
    if (n === 0 || Math.abs(n) < min || Math.abs(n) > max || (n < 0 && !allowNegative)) return null;
    seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
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
    if (!/^\d+$/.test(parts.get('INTERVAL')) || Number(parts.get('INTERVAL')) < 1) return { unsupported: 'bad INTERVAL' };
    // Any positive INTERVAL is read. Past MAX_INTERVAL one step already
    // passes year 9999 at every FREQ, so larger values behave the same:
    // DTSTART and nothing after it.
    rule.interval = Math.min(Number(parts.get('INTERVAL')), MAX_INTERVAL);
  }
  if (parts.has('COUNT') && parts.has('UNTIL')) return { unsupported: 'both COUNT and UNTIL' };
  if (parts.has('COUNT')) {
    if (!/^\d{1,12}$/.test(parts.get('COUNT')) || Number(parts.get('COUNT')) < 1) return { unsupported: 'bad COUNT' };
    rule.count = Number(parts.get('COUNT'));
    if (rule.count > MAX_COUNT) return { unsupported: `COUNT above ${MAX_COUNT}` };
  }
  if (parts.has('UNTIL')) rule.until = parts.get('UNTIL');
  if (parts.has('BYDAY')) {
    const seen = new Map();
    for (const piece of parts.get('BYDAY').toUpperCase().split(',')) {
      const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(piece);
      if (!match) return { unsupported: `bad BYDAY "${piece}"` };
      const n = match[1] ? Number(match[1]) : 0;
      if (match[1] && (n === 0 || Math.abs(n) > 53)) return { unsupported: `bad BYDAY "${piece}"` };
      if (n && (freq === 'DAILY' || freq === 'WEEKLY')) return { unsupported: `numbered BYDAY with FREQ=${freq}` };
      const wd = WEEKDAYS.indexOf(match[2]);
      // "1MO", "+1MO" and "01MO" are the same entry: kept once.
      seen.set(`${n}:${wd}`, { n, wd });
    }
    rule.byday = [...seen.values()].sort((a, b) => (a.n - b.n) || (a.wd - b.wd));
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
  // Lookups built once per rule, never once per period.
  rule.sets = {
    bymonth: rule.bymonth ? new Set(rule.bymonth) : null,
    monthdayPos: rule.bymonthday ? new Set(rule.bymonthday.filter((n) => n > 0)) : null,
    monthdayNeg: rule.bymonthday ? new Set(rule.bymonthday.filter((n) => n < 0)) : null,
    weekdays: rule.byday ? [...new Set(rule.byday.map((b) => b.wd))].sort((a, b) => a - b) : null,
    weekdaySet: rule.byday ? new Set(rule.byday.map((b) => b.wd)) : null,
  };
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
// The helpers below add one to `meter.work` for every value they look at, so
// a period is charged for the work it really takes (see expandRuleDays).
function bydaySet(byday, firstDay, lastDay, meter) {
  const out = new Set();
  for (const { n, wd } of byday) {
    meter.work += 1;
    if (n) {
      const day = nthWeekday(firstDay, lastDay, n, wd);
      if (day !== null) out.add(day);
    } else {
      for (let day = firstDay + ((wd - weekdayOf(firstDay) + 7) % 7); day <= lastDay; day += 7) { out.add(day); meter.work += 1; }
    }
  }
  return out;
}

function monthdaySet(bymonthday, y, m, meter) {
  const out = new Set();
  const dim = daysInMonth(y, m);
  for (const n of bymonthday) {
    meter.work += 1;
    const d = n > 0 ? n : dim + 1 + n;
    if (d >= 1 && d <= dim) out.add(daysFromCivil(y, m, d));
  }
  return out;
}

// Whether `day` matches BYMONTHDAY, in constant time.
function matchesMonthday(rule, day) {
  const { y, m, d } = civilFromDays(day);
  return rule.sets.monthdayPos.has(d) || rule.sets.monthdayNeg.has(d - daysInMonth(y, m) - 1);
}

function monthCandidates(rule, y, m, start, meter) {
  const first = daysFromCivil(y, m, 1);
  const last = first + daysInMonth(y, m) - 1;
  if (rule.bymonthday || rule.byday) {
    let days = rule.bymonthday ? monthdaySet(rule.bymonthday, y, m, meter) : null;
    if (rule.byday) {
      const byday = bydaySet(rule.byday, first, last, meter);
      days = days ? new Set([...days].filter((d) => byday.has(d))) : byday;
    }
    return [...days];
  }
  meter.work += 1;
  return start.d <= daysInMonth(y, m) ? [daysFromCivil(y, m, start.d)] : [];
}

function periodCandidates(rule, ctx, k, meter) {
  const { start, startDay } = ctx;
  let days;
  if (rule.freq === 'DAILY') {
    meter.work += 1;
    days = [startDay + k * rule.interval];
  } else if (rule.freq === 'WEEKLY') {
    const weekStart = ctx.weekStart + 7 * rule.interval * k;
    const wanted = rule.byday ? rule.sets.weekdays : [weekdayOf(startDay)];
    const offset = weekdayOf(weekStart);
    days = wanted.map((wd) => weekStart + ((wd - offset + 7) % 7));
    meter.work += days.length;
  } else if (rule.freq === 'MONTHLY') {
    const index = start.y * 12 + (start.m - 1) + k * rule.interval;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    days = monthCandidates(rule, y, m, start, meter);
  } else {
    const y = start.y + k * rule.interval;
    if (rule.bymonth) {
      days = [];
      for (const m of rule.bymonth) days.push(...monthCandidates(rule, y, m, start, meter));
    } else if (rule.bymonthday || rule.byday) {
      const first = daysFromCivil(y, 1, 1);
      const last = daysFromCivil(y, 12, 31);
      if (rule.bymonthday) {
        days = [];
        for (let m = 1; m <= 12; m += 1) days.push(...monthdaySet(rule.bymonthday, y, m, meter));
        if (rule.byday) {
          const byday = bydaySet(rule.byday, first, last, meter);
          days = days.filter((d) => byday.has(d));
        }
      } else {
        days = [...bydaySet(rule.byday, first, last, meter)];
      }
    } else {
      meter.work += 1;
      days = start.m === 2 && start.d === 29 && !isLeapYear(y) ? [] : [daysFromCivil(y, start.m, start.d)];
    }
  }
  // BYxxx rule parts at a finer level than FREQ limit the set.
  // Each check is a constant-time lookup in a set built once per rule.
  days = days.filter((day) => {
    if (rule.sets.bymonth && !rule.sets.bymonth.has(civilFromDays(day).m)) return false;
    if (rule.freq === 'DAILY') {
      if (rule.byday && !rule.sets.weekdaySet.has(weekdayOf(day))) return false;
      if (rule.bymonthday && !matchesMonthday(rule, day)) return false;
    }
    return true;
  });
  days = [...new Set(days)].sort((a, b) => a - b);
  if (rule.bysetpos) {
    const picked = new Set();
    meter.work += rule.bysetpos.length;
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
// `stats.steps` counts the work done: each period visited costs one step for
// every candidate date and BYxxx value it looks at (at least one), so a rule
// with long lists pays for them. Past `maxSteps` it throws a WorkLimit,
// checked before the period's dates are used.
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
    const meter = { work: 0 };
    const candidates = periodCandidates(rule, ctx, k, meter);
    stats.steps += Math.max(1, meter.work);
    if (stats.steps > maxSteps) throw new WorkLimit(`more than ${maxSteps} repeat steps to reach the range`);
    for (const day of candidates) {
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
