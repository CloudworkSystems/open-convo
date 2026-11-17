// Pace limits (docs/plans/push-gate.md, "Pace Limits"): quiet hours in New
// York time, the hourly cap on writes, and the gap between pushes to one
// pull request. Pure functions of the clock and the write log.

import { HOUR, LIMITS } from './constants.mjs';

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: LIMITS.timeZone,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** The New York wall-clock time at `ms`, daylight saving included. */
export function newYorkParts(ms) {
  const parts = {};
  for (const { type, value } of partsFormat.formatToParts(new Date(ms))) parts[type] = Number(value);
  return parts;
}

// How far New York's wall clock is from UTC at `ms`.
function offsetAt(ms) {
  const p = newYorkParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * Null outside quiet hours. Inside them (11 PM to 6 AM New York time), the
 * time in milliseconds of the next 6 AM there.
 */
export function quietUntil(ms) {
  const p = newYorkParts(ms);
  const late = p.hour >= LIMITS.quietStartHour;
  if (!late && p.hour >= LIMITS.quietEndHour) return null;
  // 6 AM on New York's calendar day: tomorrow's when it is still before midnight.
  const wall = Date.UTC(p.year, p.month - 1, p.day + (late ? 1 : 0), LIMITS.quietEndHour);
  // The offset at 6 AM can differ from now's on the two nights the clocks change.
  let at = wall - offsetAt(ms);
  at = wall - offsetAt(at);
  return at;
}

/**
 * Null when `needed` more writes fit under the hourly cap. Otherwise the
 * time at which enough of the last hour's writes will be an hour old.
 */
export function capUntil(writeTimes, ms, needed = 1) {
  const recent = writeTimes.filter((t) => t > ms - HOUR && t <= ms).sort((a, b) => a - b);
  const over = recent.length + needed - LIMITS.writesPerHour;
  if (over <= 0) return null;
  return recent[Math.min(over, recent.length) - 1] + HOUR;
}

/** Null when the branch may be pushed now, else when its 10 minutes are up. */
export function pushGapUntil(lastPushMs, ms) {
  if (!Number.isFinite(lastPushMs)) return null;
  const until = lastPushMs + LIMITS.pushGapMs;
  return until > ms ? until : null;
}

/** A time the owner can read: New York time, with the date. */
export function sayTime(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: LIMITS.timeZone,
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms));
}
