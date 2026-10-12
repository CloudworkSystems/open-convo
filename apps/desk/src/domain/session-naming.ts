/** The recovered creation-date convention; it does not rename existing records. */
export const SESSION_CREATION_TIME_ZONE = 'America/New_York';

export function sessionDatePrefix(createdAt: string): string {
  const instant = new Date(createdAt);
  if (!Number.isFinite(instant.getTime())) throw new RangeError('Session creation time is invalid.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: SESSION_CREATION_TIME_ZONE,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant).map(({ type, value }) => [type, value]));
  return `${parts.year.slice(-2)}${parts.month}${parts.day}`;
}

/** User-supplied aliases remain free text; only new default names use this. */
export function defaultSessionTitle(createdAt: string): string {
  return `${sessionDatePrefix(createdAt)} New conversation`;
}
