// The caller passes the time. This file never reads the clock.

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** @returns {number | null} milliseconds since the epoch, or null */
export function instantMs(value) {
  if (typeof value !== 'string' || value.length > 40 || !INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

/**
 * Remaining time from progress so far. `progress` is a fraction from 0 to 1.
 * Zero, or anything that is not a real fraction, has no estimate.
 * @returns {number | null}
 */
export function remainingMs(elapsedMs, progress) {
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  if (typeof progress !== 'number' || !Number.isFinite(progress) || progress <= 0 || progress > 1) return null;
  return Math.round((elapsedMs * (1 - progress)) / progress);
}
