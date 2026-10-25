/**
 * Calendar dates and wall times. Arithmetic uses calendar dates, never 24-hour
 * steps, so a daylight-saving change cannot skip or repeat a day. Instants are
 * numbers. This module never reads the clock or the machine's time zone.
 */

const fail = message => { throw new Error(message); };
const pad = (value, width = 2) => String(value).padStart(width, '0');

const formatters = new Map();

function formatter(timeZone) {
  let known = formatters.get(timeZone);
  if (known) return known;
  try {
    known = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    // Force a check now; some engines throw lazily.
    known.format(new Date(0));
  } catch {
    fail('Unknown time zone.');
  }
  formatters.set(timeZone, known);
  return known;
}

export function assertTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 100) fail('Unknown time zone.');
  formatter(timeZone);
  return timeZone;
}

export function partsInZone(utcMs, timeZone) {
  const bag = {};
  for (const part of formatter(timeZone).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  if (bag.hour === '24') bag.hour = '00';
  return bag;
}

function offsetMs(utcMs, timeZone) {
  const parts = partsInZone(utcMs, timeZone);
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - utcMs;
}

export function validDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [year, month, day] = iso.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

export function assertDate(iso, label = 'Date') {
  if (!validDate(iso)) fail(`${label} must be YYYY-MM-DD.`);
  return iso;
}

export function validTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function validDateTime(value) {
  return typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d$/.test(value) && validDate(value.slice(0, 10));
}

export function formatDate(year, month, day) {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export function formatTime(hour, minute) {
  return `${pad(hour)}:${pad(minute)}`;
}

export function splitDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

export function weekdayIndex(iso) {
  const { year, month, day } = splitDate(iso);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export const WEEKDAYS = Object.freeze(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);

export function weekdayName(iso) {
  return WEEKDAYS[weekdayIndex(iso)];
}

export function addDays(iso, days) {
  const { year, month, day } = splitDate(iso);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return formatDate(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
}

export function daysBetween(start, end) {
  const a = splitDate(start);
  const b = splitDate(end);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000);
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** monthIndex is a zero-based count of months from year 0. anchorDay clamps to the month's last day. */
export function dateInMonth(monthIndex, anchorDay) {
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex % 12;
  const last = daysInMonth(year, month + 1);
  return formatDate(year, month + 1, Math.min(anchorDay, last));
}

export function monthIndex(iso) {
  const { year, month } = splitDate(iso);
  return year * 12 + (month - 1);
}

export function addMinutesWall(dateTime, minutes) {
  const date = dateTime.slice(0, 10);
  const [hour, minute] = dateTime.slice(11, 16).split(':').map(Number);
  let total = hour * 60 + minute + minutes;
  let dayDelta = Math.floor(total / 1440);
  total = ((total % 1440) + 1440) % 1440;
  return `${addDays(date, dayDelta)}T${formatTime(Math.floor(total / 60), total % 60)}`;
}

function offsetsNear(desired, timeZone) {
  const found = new Set();
  for (let hour = -16; hour <= 16; hour += 1) found.add(offsetMs(desired + hour * 3600000, timeZone));
  return found;
}

function wallMatches(instant, timeZone, year, month, day, hour, minute) {
  const parts = partsInZone(instant, timeZone);
  return +parts.year === year && +parts.month === month && +parts.day === day && +parts.hour === hour && +parts.minute === minute;
}

function forwardGap(desired, timeZone) {
  // A positive-offset zone's spring-forward can sit more than six hours away
  // from the naive UTC reading of the wall time. The candidate instants are
  // desired minus each offset the zone uses nearby; the gap is the forward
  // jump closest to those candidates.
  const offsets = [...offsetsNear(desired, timeZone)];
  if (offsets.length < 2) return 0;
  const instants = offsets.map(offset => desired - offset);
  const start = Math.min(...instants) - 3600000;
  const end = Math.max(...instants) + 3600000;
  const middle = (Math.min(...instants) + Math.max(...instants)) / 2;
  let previous = offsetMs(start, timeZone);
  let best = 0;
  let bestDistance = Infinity;
  for (let cursor = start + 15 * 60000; cursor <= end; cursor += 15 * 60000) {
    const offset = offsetMs(cursor, timeZone);
    if (offset > previous) {
      const distance = Math.abs(cursor - middle);
      if (distance < bestDistance) {
        best = offset - previous;
        bestDistance = distance;
      }
    }
    previous = offset;
  }
  return best;
}

/**
 * Convert a wall time to an instant. A time that happens twice (fall back)
 * uses the earlier instant. A time that does not exist (spring forward) moves
 * forward by the gap: 02:30 becomes 03:30 when the clock jumps an hour.
 */
export function wallToInstant(dateTime, timeZone) {
  assertTimeZone(timeZone);
  if (!validDateTime(dateTime)) fail('Time must be YYYY-MM-DDTHH:MM.');
  const year = +dateTime.slice(0, 4);
  const month = +dateTime.slice(5, 7);
  const day = +dateTime.slice(8, 10);
  const hour = +dateTime.slice(11, 13);
  const minute = +dateTime.slice(14, 16);
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  const matches = [];
  for (const offset of offsetsNear(desired, timeZone)) {
    const instant = desired - offset;
    if (offsetMs(instant, timeZone) !== offset) continue;
    if (wallMatches(instant, timeZone, year, month, day, hour, minute)) matches.push(instant);
  }
  if (matches.length) return Math.min(...matches);
  const gap = forwardGap(desired, timeZone);
  if (!gap) fail('That time does not exist in this time zone.');
  const shifted = addMinutesWall(dateTime, Math.round(gap / 60000));
  const shiftedDesired = Date.UTC(+shifted.slice(0, 4), +shifted.slice(5, 7) - 1, +shifted.slice(8, 10), +shifted.slice(11, 13), +shifted.slice(14, 16), 0);
  const shiftedMatches = [];
  for (const offset of offsetsNear(shiftedDesired, timeZone)) {
    const instant = shiftedDesired - offset;
    if (offsetMs(instant, timeZone) !== offset) continue;
    if (wallMatches(instant, timeZone, +shifted.slice(0, 4), +shifted.slice(5, 7), +shifted.slice(8, 10), +shifted.slice(11, 13), +shifted.slice(14, 16))) {
      shiftedMatches.push(instant);
    }
  }
  if (!shiftedMatches.length) fail('That time does not exist in this time zone.');
  return Math.min(...shiftedMatches);
}

export function civilDate(instant, timeZone) {
  if (!Number.isSafeInteger(instant)) fail('Now must be an instant.');
  const parts = partsInZone(instant, assertTimeZone(timeZone));
  return formatDate(+parts.year, +parts.month, +parts.day);
}

export function wallClock(instant, timeZone) {
  const parts = partsInZone(instant, assertTimeZone(timeZone));
  return `${formatDate(+parts.year, +parts.month, +parts.day)}T${formatTime(+parts.hour, +parts.minute)}`;
}

/** Monday-based week index (RFC 5545 WKST=MO). */
export function weekIndex(iso) {
  const { year, month, day } = splitDate(iso);
  const days = Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  // 1970-01-01 was a Thursday; the Monday of that week is three days earlier.
  return Math.floor((days + 3) / 7);
}

export function nthWeekday(year, month, weekday, which) {
  const number = which === 'last' ? -1 : which;
  const target = WEEKDAYS.indexOf(weekday);
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  let day = 1 + ((target - firstDow + 7) % 7);
  const last = daysInMonth(year, month);
  if (number === -1) {
    while (day + 7 <= last) day += 7;
    return formatDate(year, month, day);
  }
  day += (number - 1) * 7;
  if (day > last) return null;
  return formatDate(year, month, day);
}

export function startOfNextDay(date, timeZone) {
  return wallToInstant(`${addDays(date, 1)}T00:00`, timeZone);
}
