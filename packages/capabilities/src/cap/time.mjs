// Instants come from the caller. This file never reads the clock.
// `new Date` is only called with an argument. Milliseconds are a BigInt so
// the 24-hour rate check does not depend on floating point. `Date` itself
// needs a Number, and that Number is a timestamp, never an amount of money.

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/;

export const DAY_MS = 24n * 60n * 60n * 1000n;

/** @returns {bigint | null} milliseconds since the Unix epoch */
export function parseInstant(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const match = INSTANT.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] || '0';
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const millis = Number(fraction.padEnd(3, '0'));
  let offset = 0;
  if (match[8] !== 'Z') {
    const minutes = Number(match[9]) * 60 + Number(match[10]);
    if (minutes > 14 * 60) return null;
    offset = minutes * 60 * 1000;
    if (match[8].startsWith('-')) offset = -offset;
  }
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, millis) - offset;
  return BigInt(utc);
}

export function instantText(value) {
  const ms = parseInstant(value);
  if (ms === null) return null;
  return new Date(Number(ms)).toISOString();
}

export function canonicalZone(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 200) return null;
  if (!/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(name)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Milliseconds from `asOf` to `now`. Negative when the rate is dated in the future. */
export function rateAge(asOf, now) {
  const earlier = parseInstant(asOf);
  const later = parseInstant(now);
  if (earlier === null || later === null) return null;
  return later - earlier;
}

/** `YYYY-MM` in the person's zone, or null. */
export function calendarMonth(value, timeZone) {
  const ms = parseInstant(value);
  const zone = canonicalZone(timeZone);
  if (ms === null || !zone) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(Number(ms)));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) return null;
  return `${year}-${month}`;
}
