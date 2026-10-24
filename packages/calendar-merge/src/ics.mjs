// Reads `.ics` text (RFC 5545) into raw events. Only VEVENT components are
// kept, and from them only the properties the engine uses.

import { daysFromCivil, isValidDate } from './time.mjs';

const KEPT = new Set([
  'UID', 'SUMMARY', 'LOCATION', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'RDATE',
  'EXDATE', 'RECURRENCE-ID', 'STATUS', 'SEQUENCE', 'DTSTAMP', 'LAST-MODIFIED',
]);

export class Refusal extends Error {}

// Content lines, unfolded, each with the line number it starts on.
function contentLines(text) {
  const unmarked = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // byte order mark
  const physical = unmarked.split(/\r\n|\r|\n/);
  const lines = [];
  for (let i = 0; i < physical.length; i += 1) {
    const raw = physical[i];
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) {
      lines[lines.length - 1].text += raw.slice(1);
    } else if (raw.length) {
      lines.push({ text: raw, line: i + 1 });
    }
  }
  return lines;
}

// NAME;PARAM=a,"b";P2=c:value  ->  { name, params, value }, or null.
export function parseContentLine(text) {
  let i = 0;
  while (i < text.length && text[i] !== ';' && text[i] !== ':') i += 1;
  const name = text.slice(0, i).toUpperCase();
  if (!name || i >= text.length) return null;
  const params = {};
  while (text[i] === ';') {
    i += 1;
    const eq = text.indexOf('=', i);
    if (eq < 0) return null;
    const paramName = text.slice(i, eq).toUpperCase();
    i = eq + 1;
    const values = [];
    for (;;) {
      if (text[i] === '"') {
        const close = text.indexOf('"', i + 1);
        if (close < 0) return null;
        values.push(text.slice(i + 1, close));
        i = close + 1;
      } else {
        let j = i;
        while (j < text.length && text[j] !== ',' && text[j] !== ';' && text[j] !== ':') j += 1;
        values.push(text.slice(i, j));
        i = j;
      }
      if (text[i] === ',') { i += 1; continue; }
      break;
    }
    params[paramName] = values;
  }
  if (text[i] !== ':') return null;
  return { name, params, value: text.slice(i + 1) };
}

export function unescapeText(value) {
  return value.replace(/\\([\\;,nN])/g, (_, ch) => (ch === 'n' || ch === 'N' ? '\n' : ch));
}

// A DATE or DATE-TIME value as written: { kind: 'date', day } or
// { kind: 'time', day, sec, utc, tzid }. null when it doesn't parse.
export function parseDateValue(value, params = {}) {
  const type = (params.VALUE?.[0] || '').toUpperCase();
  const text = value.trim();
  const tzid = params.TZID?.[0] ?? null;
  let match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match) {
    if (type && type !== 'DATE') return null;
    const [y, m, d] = match.slice(1).map(Number);
    return isValidDate(y, m, d) ? { kind: 'date', day: daysFromCivil(y, m, d) } : null;
  }
  match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(text);
  if (!match || type === 'DATE') return null;
  const [y, m, d, hh, mm, second] = match.slice(1, 7).map(Number);
  if (!isValidDate(y, m, d) || hh > 23 || mm > 59 || second > 60) return null;
  const ss = Math.min(second, 59); // RFC 5545 3.3.12: a leap second (60) is read as 59
  const utc = match[7] === 'Z';
  return { kind: 'time', day: daysFromCivil(y, m, d), sec: hh * 3600 + mm * 60 + ss, utc, tzid: utc ? null : tzid };
}

// [+-]P(nW | nDTnHnMnS)  ->  { sign, weeks, days, hours, minutes, seconds } or null.
export function parseDuration(value) {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim().toUpperCase());
  if (!match || value.trim().toUpperCase().endsWith('T') || /^[+-]?P$/.test(value.trim().toUpperCase())) return null;
  const [weeks, days, hours, minutes, seconds] = match.slice(2).map((n) => Number(n || 0));
  return { sign: match[1] === '-' ? -1 : 1, weeks, days, hours, minutes, seconds };
}

// Splits a source's text into raw VEVENTs. Throws a Refusal for a file with no
// BEGIN:VCALENDAR.
export function readIcs(text) {
  const lines = contentLines(text);
  const events = [];
  const tzids = [];
  const stack = [];
  let sawCalendar = false;
  let calendar = null;
  let current = null;
  for (const { text: lineText, line } of lines) {
    const prop = parseContentLine(lineText);
    if (!prop) continue; // not a NAME:value line: ignored
    if (prop.name === 'BEGIN') {
      const kind = prop.value.trim().toUpperCase();
      if (kind === 'VCALENDAR' && stack.length === 0) { sawCalendar = true; calendar = { method: null }; }
      if (kind === 'VEVENT' && stack.length === 1 && stack[0] === 'VCALENDAR') {
        current = { line, calendar, props: new Map() };
      }
      stack.push(kind);
      continue;
    }
    if (prop.name === 'END') {
      const kind = prop.value.trim().toUpperCase();
      const at = stack.lastIndexOf(kind);
      if (at >= 0) stack.length = at; // tolerate a missing END inside
      if (kind === 'VEVENT' && current && stack.length === 1) {
        events.push(current);
        current = null;
      }
      continue;
    }
    const top = stack[stack.length - 1];
    if (top === 'VCALENDAR' && stack.length === 1 && prop.name === 'METHOD') {
      calendar.method = prop.value.trim().toUpperCase();
    } else if (top === 'VTIMEZONE' && prop.name === 'TZID') {
      tzids.push(prop.value);
    } else if (top === 'VEVENT' && current && stack.length === 2 && KEPT.has(prop.name)) {
      if (!current.props.has(prop.name)) current.props.set(prop.name, []);
      current.props.get(prop.name).push({ ...prop, line });
    }
  }
  if (!sawCalendar) throw new Refusal('has no BEGIN:VCALENDAR');
  // METHOD belongs to the whole calendar, wherever it is written.
  return { events: events.map(({ calendar: cal, ...event }) => ({ ...event, method: cal.method })), tzids };
}
