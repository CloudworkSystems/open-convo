// Calendar arithmetic and time zones. Dates are day numbers (days since
// 1970-01-01) and instants are milliseconds since 1970-01-01T00:00:00Z, both
// computed here without `Date`, so nothing reads the clock or the machine's
// time zone. Time zones go through Node's built-in Intl only.

import { WINDOWS_ZONES } from './windows-zones.mjs';

export const DAY_MS = 86_400_000;

const mod = (a, n) => ((a % n) + n) % n;

// Howard Hinnant's days_from_civil / civil_from_days.
export function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(days) {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

export const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInMonth = (y, m) => [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
// 0 = Sunday ... 6 = Saturday. 1970-01-01 was a Thursday.
export const weekdayOf = (day) => mod(day + 4, 7);

export function isValidDate(y, m, d) {
  return Number.isInteger(y) && y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function formatDate(day) {
  const { y, m, d } = civilFromDays(day);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

// "YYYY-MM-DD" to a day number, or null.
export function parseIsoDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return isValidDate(y, m, d) ? daysFromCivil(y, m, d) : null;
}

function formatClock(secOfDay) {
  return `${pad(Math.floor(secOfDay / 3600))}:${pad(Math.floor(secOfDay / 60) % 60)}:${pad(secOfDay % 60)}`;
}

export function formatUtc(ms) {
  const day = Math.floor(ms / DAY_MS);
  return `${formatDate(day)}T${formatClock(Math.floor(mod(ms, DAY_MS) / 1000))}Z`;
}

export function formatWall(day, sec) {
  return `${formatDate(day)}T${formatClock(sec)}`;
}

function formatOffset(offsetMs) {
  const sign = offsetMs < 0 ? '-' : '+';
  const total = Math.abs(offsetMs) / 1000;
  const hh = pad(Math.floor(total / 3600));
  const mm = pad(Math.floor(total / 60) % 60);
  const ss = total % 60;
  return ss ? `${sign}${hh}:${mm}:${pad(ss)}` : `${sign}${hh}:${mm}`;
}

// ---- Time zones through Intl --------------------------------------------

const formatters = new Map();

function formatterFor(zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

// The canonical IANA name for `name`, or null. Offset forms such as "+05:00"
// are not names and are refused.
export function canonicalZone(name) {
  if (typeof name !== 'string' || !/^[A-Za-z]/.test(name)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// A TZID as written in a file: an IANA name, or a Windows name from the CLDR
// table. Anything else is not guessed (null).
export function zoneFromTzid(tzid) {
  const windows = WINDOWS_ZONES.get(tzid);
  if (windows) return windows;
  return canonicalZone(tzid);
}

// The zone's offset at an instant, read through Intl.
function readOffset(zone, ms) {
  const fields = {};
  for (const part of formatterFor(zone).formatToParts(ms)) fields[part.type] = part.value;
  let year = Number(fields.year);
  if (fields.era && fields.era.startsWith('B')) year = 1 - year;
  const day = daysFromCivil(year, Number(fields.month), Number(fields.day));
  const sec = Number(fields.hour) * 3600 + Number(fields.minute) * 60 + Number(fields.second);
  return day * DAY_MS + sec * 1000 - Math.floor(ms / 1000) * 1000;
}

// Offsets are cached per zone and hour. An hour whose first and last second
// have the same offset holds no clock change (zones change at most once an
// hour), so its offset is stored; an hour with a change is always read
// exactly. The cache is cleared when it grows large.
const HOUR_MS = 3_600_000;
const MIXED = Symbol('mixed');
const offsetCache = new Map();
let cachedHours = 0;

export function offsetAt(zone, ms) {
  if (zone === 'UTC') return 0;
  let hours = offsetCache.get(zone);
  if (!hours) {
    hours = new Map();
    offsetCache.set(zone, hours);
  }
  const hour = Math.floor(ms / HOUR_MS);
  let offset = hours.get(hour);
  if (offset === undefined) {
    const first = readOffset(zone, hour * HOUR_MS);
    offset = first === readOffset(zone, hour * HOUR_MS + HOUR_MS - 1000) ? first : MIXED;
    if (cachedHours > 200_000) {
      offsetCache.clear();
      cachedHours = 0;
      offsetCache.set(zone, hours = new Map());
    }
    hours.set(hour, offset);
    cachedHours += 1;
  }
  return offset === MIXED ? readOffset(zone, ms) : offset;
}

// Wall clock of an instant in a zone, and the zone's offset there.
export function wallAt(zone, ms) {
  const offsetMs = offsetAt(zone, ms);
  const wallMs = Math.floor(ms / 1000) * 1000 + offsetMs;
  const day = Math.floor(wallMs / DAY_MS);
  return { day, sec: Math.floor(mod(wallMs, DAY_MS) / 1000), offsetMs };
}

// Local wall time to an instant, following RFC 5545: a time the clocks skip
// is read with the offset before the gap; a time that happens twice is the
// first one.
export function wallToInstant(zone, day, sec) {
  const wallMs = day * DAY_MS + sec * 1000;
  if (zone === 'UTC') return wallMs;
  const before = offsetAt(zone, wallMs - DAY_MS);
  const after = offsetAt(zone, wallMs + DAY_MS);
  const candidates = [];
  for (const offset of new Set([before, after, offsetAt(zone, wallMs)])) {
    const instant = wallMs - offset;
    if (offsetAt(zone, instant) === offset) candidates.push(instant);
  }
  if (candidates.length) return Math.min(...candidates);
  return wallMs - before;
}

export function formatLocal(zone, ms) {
  const { day, sec, offsetMs } = wallAt(zone, ms);
  return `${formatWall(day, sec)}${formatOffset(offsetMs)}`;
}
