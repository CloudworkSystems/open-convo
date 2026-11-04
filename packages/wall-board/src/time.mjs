// Instants and civil dates. The current time, and the machine's zone, are
// never read. Wall times come from Intl with an explicit
// IANA zone and Latin digits, so the machine's zone and locale cannot change
// a result. Event clocks on the page are formatted from the agenda's own
// local text, not by working the instant out again.

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const WALL = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

const WEEKDAYS = Object.freeze([
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]);
const MONTHS = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);
const SHORT_MONTHS = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

function pad(value) {
  return String(value).padStart(2, '0');
}

// Date.UTC maps years 0–99 onto 1900–1999. setUTCFullYear does not.
function utcMillis(year, monthIndex, day, hour = 0, minute = 0, second = 0, millis = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(hour, minute, second, millis);
  return date.getTime();
}

function validYearMonthDay(year, month, day) {
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

function isCommonEra(era) {
  const token = String(era).toUpperCase();
  return token === 'AD' || token === 'CE' || token === 'A';
}

function zonedParts(ms, timeZone) {
  const format = new Intl.DateTimeFormat('en-US', {
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
  const bag = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, era: '' };
  for (const part of format.formatToParts(ms)) {
    if (part.type === 'era') bag.era = part.value;
    else if (Object.hasOwn(bag, part.type) && part.type !== 'era') bag[part.type] = Number(part.value);
  }
  if (bag.hour === 24) {
    bag.hour = 0;
    const next = new Date(utcMillis(bag.year, bag.month - 1, bag.day) + 86_400_000);
    bag.year = next.getUTCFullYear();
    bag.month = next.getUTCMonth() + 1;
    bag.day = next.getUTCDate();
    bag.era = 'AD';
  }
  const fraction = Math.trunc(ms) % 1000;
  bag.millis = fraction < 0 ? fraction + 1000 : fraction;
  return bag;
}

export function isIanaTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length < 1 || timeZone.length > 200) return false;
  try {
    zonedParts(0, timeZone);
    return true;
  } catch {
    return false;
  }
}

export function civilDate(ms, timeZone) {
  const parts = zonedParts(ms, timeZone);
  if (!isCommonEra(parts.era)) return '';
  return `${String(parts.year).padStart(4, '0')}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function writtenDate(iso) {
  const date = parseCivilDate(iso);
  if (!date) return '';
  const utc = new Date(utcMillis(date.year, date.month - 1, date.day));
  const weekday = WEEKDAYS[utc.getUTCDay()];
  return `${weekday}, ${MONTHS[date.month - 1]} ${date.day}`;
}

function clock12(hour, minute, second, millis, withSeconds) {
  const suffix = hour >= 12 ? 'PM' : 'AM';
  let h = hour % 12;
  if (h === 0) h = 12;
  let body = `${h}:${pad(minute)}`;
  if (withSeconds) body += `:${pad(second)}`;
  if (millis) body += `.${String(millis).padStart(3, '0')}`;
  return `${body} ${suffix}`;
}

export function formatUpdated(ms, timeZone) {
  const parts = zonedParts(ms, timeZone);
  const withSeconds = parts.second !== 0 || parts.millis !== 0;
  return clock12(parts.hour, parts.minute, parts.second, parts.millis, withSeconds);
}

export function parseLocal(value) {
  if (typeof value !== 'string') return null;
  const match = LOCAL.exec(value);
  if (!match) return null;
  const date = parseCivilDate(match[1]);
  if (!date) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = match[4] === undefined ? null : Number(match[4]);
  if (hour > 23 || minute > 59 || (second !== null && second > 59)) return null;
  return { date: date.text, hour, minute, second };
}

export function parseWall(value) {
  if (typeof value !== 'string') return null;
  const match = WALL.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? null : Number(match[3]);
  if (hour > 23 || minute > 59 || (second !== null && second > 59)) return null;
  return { hour, minute, second };
}

function shortDate(iso) {
  const date = parseCivilDate(iso);
  if (!date) return iso;
  return `${SHORT_MONTHS[date.month - 1]} ${date.day}`;
}

function localClock(parts, boardDate) {
  const withSeconds = parts.second !== null;
  const clock = clock12(parts.hour, parts.minute, parts.second ?? 0, 0, withSeconds);
  if (parts.date === boardDate) return clock;
  return `${shortDate(parts.date)}, ${clock}`;
}

export function eventWhen(event, boardDate) {
  if (event.allDay) return 'All day';
  const start = parseLocal(event.start);
  const end = parseLocal(event.end);
  if (!start || !end) return '';
  if (event.noLength) return localClock(start, boardDate);
  return `${localClock(start, boardDate)} – ${localClock(end, boardDate)}`;
}

export function taskClock(wall) {
  if (wall === null || wall === undefined) return null;
  const parts = parseWall(wall);
  if (!parts) return null;
  return clock12(parts.hour, parts.minute, parts.second ?? 0, 0, parts.second !== null);
}
