// RFC 3339 instants. The clock, an argument-less date, and the local-time
// date methods are never used, so the machine's clock and time zone cannot
// change a result.

function utcMillis(year, monthIndex, day, hour, minute, second, millis) {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(hour, minute, second, millis);
  return date.getTime();
}

function validYearMonthDay(year, month, day) {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > 31) return false;
  const utc = new Date(utcMillis(year, month - 1, day, 0, 0, 0, 0));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/;

// Nanoseconds since the epoch, or null. Every accepted fraction digit is
// kept, so two instants in the same millisecond still order by which came
// first. A rolled date such as February 31 is refused.
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
  if (zone !== 'Z' && zone !== 'z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }
  const nanos = fraction.length === 0 ? 0 : Number(fraction.padEnd(9, '0').slice(0, 9));
  const wholeMs = utcMillis(year, month - 1, day, hour, minute, second, 0) - offsetMinutes * 60_000;
  return BigInt(wholeMs) * 1_000_000n + BigInt(nanos);
}
