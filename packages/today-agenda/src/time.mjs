// Civil dates and instants. Date.now, an argument-less Date and the local-time
// Date methods are never used. Wall times come from Intl with an explicit
// IANA zone and Latin digits, so the machine's zone and locale cannot change
// a result.

const formatters = new Map();

// Date.UTC maps years 0–99 onto 1900–1999. setUTCFullYear does not, so a
// date such as 0099-06-15 stays in year 99.
function utcMillis(year, monthIndex, day, hour = 0, minute = 0, second = 0, millis = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(hour, minute, second, millis);
  return date.getTime();
}

function formatter(timeZone) {
  let known = formatters.get(timeZone);
  if (!known) {
    known = new Intl.DateTimeFormat('en-US', {
      timeZone,
      numberingSystem: 'latn',
      hourCycle: 'h23',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      era: 'short',
    });
    formatters.set(timeZone, known);
  }
  return known;
}

export function isIanaTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length < 1 || timeZone.length > 200) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

function isCommonEra(era) {
  const token = String(era).toUpperCase();
  return token === 'AD' || token === 'CE' || token === 'A';
}

// 1 BC is astronomical year 0. The year number alone is the same as 0001 CE.
function civilYear(parts) {
  return isCommonEra(parts.era) ? parts.year : 1 - parts.year;
}

export function zonedParts(ms, timeZone) {
  const bag = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, era: '' };
  for (const part of formatter(timeZone).formatToParts(ms)) {
    if (part.type === 'era') bag.era = part.value;
    else if (Object.hasOwn(bag, part.type) && part.type !== 'era') bag[part.type] = Number(part.value);
  }
  // A few ICU builds report midnight as hour 24 on the day that just ended.
  if (bag.hour === 24) {
    bag.hour = 0;
    const next = new Date(utcMillis(civilYear(bag), bag.month - 1, bag.day) + 86_400_000);
    const fullYear = next.getUTCFullYear();
    if (fullYear >= 1) {
      bag.era = 'AD';
      bag.year = fullYear;
    } else {
      bag.era = 'BC';
      bag.year = 1 - fullYear;
    }
    bag.month = next.getUTCMonth() + 1;
    bag.day = next.getUTCDate();
  }
  // Intl drops the fraction of a second. The instant still has it, and a
  // zero whole second with a fraction is not a whole minute.
  const fraction = Math.trunc(ms) % 1000;
  bag.millis = fraction < 0 ? fraction + 1000 : fraction;
  return bag;
}

export function validYearMonthDay(year, month, day) {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > 31) return false;
  const utc = new Date(utcMillis(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

export function parseCivilDate(value) {
  if (typeof value !== 'string' || !/^(\d{4})-(\d{2})-(\d{2})$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (!validYearMonthDay(year, month, day)) return null;
  return { year, month, day, text: value };
}

export function addCivilDays(iso, days) {
  const date = parseCivilDate(iso);
  if (!date) return null;
  const utc = new Date(utcMillis(date.year, date.month - 1, date.day + days));
  const year = utc.getUTCFullYear();
  const month = utc.getUTCMonth() + 1;
  const day = utc.getUTCDate();
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

// Milliseconds since the epoch, or null. Extra fraction digits past
// milliseconds are dropped. The calendar fields are checked, so a rolled
// date such as February 31 is refused.
export function parseInstant(value) {
  if (typeof value !== 'string') return null;
  const match = INSTANT.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? '';
  const zone = match[8];
  if (!validYearMonthDay(year, month, day)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }
  const millis = fraction.length === 0 ? 0 : Number(fraction.slice(0, 3).padEnd(3, '0'));
  return utcMillis(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000;
}

export function formatInstant(ms) {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const second = date.getUTCSeconds();
  const millis = date.getUTCMilliseconds();
  const base = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
  if (millis === 0) return `${base}Z`;
  return `${base}.${String(millis).padStart(3, '0')}Z`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

export function formatCivil(parts) {
  return `${String(parts.year).padStart(4, '0')}-${pad(parts.month)}-${pad(parts.day)}`;
}

// A whole minute is HH:MM. Anything else keeps :SS, including an instant
// whose whole second is 0 but whose fraction is not, such as 09:00:00.500.
export function formatWall(parts) {
  const clock = `${pad(parts.hour)}:${pad(parts.minute)}`;
  if (!parts.second && !parts.millis) return clock;
  return `${clock}:${pad(parts.second)}`;
}

export function formatLocal(parts) {
  return `${formatCivil(parts)}T${formatWall(parts)}`;
}

export function civilDate(ms, timeZone) {
  const parts = zonedParts(ms, timeZone);
  // Agenda dates are 0001–9999 CE. A BCE wall date must not compare equal to one.
  if (!isCommonEra(parts.era)) return '';
  return formatCivil(parts);
}

export function wallClock(ms, timeZone) {
  return formatWall(zonedParts(ms, timeZone));
}

export function localDateTime(ms, timeZone) {
  return formatLocal(zonedParts(ms, timeZone));
}

function matches(ms, year, month, day, hour, minute, second, timeZone) {
  const parts = zonedParts(ms, timeZone);
  // Year 1 BC is also written "1". Only a common-era wall clock can match 0001 CE.
  if (!isCommonEra(parts.era)) return false;
  return parts.year === year && parts.month === month && parts.day === day
    && parts.hour === hour && parts.minute === minute && parts.second === second;
}

function offsetMs(instant, timeZone) {
  const parts = zonedParts(instant, timeZone);
  const asUtc = utcMillis(civilYear(parts), parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - instant;
}

// A fall-back clock time happens twice, one offset apart. The gap can be
// more than two hours (Antarctica/Casey rolled back three). Sample the
// offsets in force over the previous day and keep the earliest match.
function preferEarlier(instant, year, month, day, hour, minute, second, timeZone) {
  const target = utcMillis(year, month - 1, day, hour, minute, second);
  const offsets = new Set();
  for (let hours = 0; hours <= 26; hours += 1) {
    offsets.add(offsetMs(instant - hours * 3_600_000, timeZone));
  }
  let best = null;
  for (const offset of offsets) {
    const candidate = target - offset;
    if (!matches(candidate, year, month, day, hour, minute, second, timeZone)) continue;
    if (best === null || candidate < best) best = candidate;
  }
  return best === null ? instant : best;
}

function tryExact(year, month, day, hour, minute, second, timeZone) {
  const target = utcMillis(year, month - 1, day, hour, minute, second);
  let instant = target;
  let previous = null;
  for (let i = 0; i < 4; i += 1) {
    const next = target - offsetMs(instant, timeZone);
    // A spring-forward gap makes the offset guess oscillate. Give up and let
    // the caller apply the offset from before the gap.
    if (next === previous) return null;
    previous = instant;
    instant = next;
    if (matches(instant, year, month, day, hour, minute, second, timeZone)) {
      return preferEarlier(instant, year, month, day, hour, minute, second, timeZone);
    }
  }
  if (matches(instant, year, month, day, hour, minute, second, timeZone)) {
    return preferEarlier(instant, year, month, day, hour, minute, second, timeZone);
  }
  return null;
}

function shiftMinutes(year, month, day, hour, minute, delta) {
  const utc = new Date(utcMillis(year, month - 1, day, hour, minute + delta));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
    hour: utc.getUTCHours(),
    minute: utc.getUTCMinutes(),
  };
}

// Place a local clock time in a zone. A time that does not exist is read
// with the offset in effect before the gap, so 02:30 on a spring-forward
// morning lands an hour later on the clock (03:30 in America/New_York).
// A time that happens twice is the earlier one.
export function zonedLocalToUtc(year, month, day, hour, minute, second, timeZone) {
  const exact = tryExact(year, month, day, hour, minute, second, timeZone);
  if (exact !== null) return exact;
  for (let back = 1; back <= 360; back += 1) {
    const prev = shiftMinutes(year, month, day, hour, minute, -back);
    if (!validYearMonthDay(prev.year, prev.month, prev.day)) continue;
    const found = tryExact(prev.year, prev.month, prev.day, prev.hour, prev.minute, second, timeZone);
    if (found === null) continue;
    const prevAsUtc = utcMillis(prev.year, prev.month - 1, prev.day, prev.hour, prev.minute, second);
    const offset = prevAsUtc - found;
    return utcMillis(year, month - 1, day, hour, minute, second) - offset;
  }
  return null;
}

export function startOfCivilDay(iso, timeZone) {
  const date = parseCivilDate(iso);
  if (!date) return null;
  return zonedLocalToUtc(date.year, date.month, date.day, 0, 0, 0, timeZone);
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseClock(value) {
  if (typeof value !== 'string') return null;
  const match = CLOCK.exec(value);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]), text: value };
}

export function clockOnDate(iso, clock, timeZone) {
  const date = parseCivilDate(iso);
  const time = parseClock(clock);
  if (!date || !time) return null;
  return zonedLocalToUtc(date.year, date.month, date.day, time.hour, time.minute, 0, timeZone);
}
