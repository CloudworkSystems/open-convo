// Calendar days from 0001-01-01 through 9999-12-31. Addition walks the
// calendar, so a month end or a leap day cannot drift. JavaScript's Date
// maps years 0 to 99 onto 1900 to 1999, so this file does not use Date.
// It never reads the clock.

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

function daysFromCivil(year, month, day) {
  let y = month <= 2 ? year - 1 : year;
  const era = Math.trunc((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.trunc((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  const shifted = z + 719468;
  const era = Math.trunc((shifted >= 0 ? shifted : shifted - 146096) / 146097);
  const doe = shifted - era * 146097;
  const yoe = Math.trunc((doe - Math.trunc(doe / 1460) + Math.trunc(doe / 36524) - Math.trunc(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.trunc(yoe / 4) - Math.trunc(yoe / 100));
  const mp = Math.trunc((5 * doy + 2) / 153);
  const day = doy - Math.trunc((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: y + (month <= 2 ? 1 : 0), month, day };
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function format(parts) {
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

export function isRealDate(value) {
  if (typeof value !== 'string' || !DATE_TEXT.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const back = civilFromDays(daysFromCivil(year, month, day));
  return back.year === year && back.month === month && back.day === day;
}

export function addDays(iso, days) {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const next = civilFromDays(daysFromCivil(year, month, day) + days);
  if (next.year < 1 || next.year > 9999) return null;
  return format(next);
}

export function daysBetween(start, end) {
  const from = daysFromCivil(Number(start.slice(0, 4)), Number(start.slice(5, 7)), Number(start.slice(8, 10)));
  const to = daysFromCivil(Number(end.slice(0, 4)), Number(end.slice(5, 7)), Number(end.slice(8, 10)));
  return to - from;
}

export function compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
