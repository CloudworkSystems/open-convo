// Fixed lists, limits and small text helpers shared by the engine, the
// classifiers and the command. Nothing here reads the clock, the locale or
// the machine's time zone.

export const SCHEMA_VERSION = 1;

export const CATEGORIES = Object.freeze(['people', 'work', 'alerts', 'receipts', 'newsletters', 'other']);

export const PILE_NAMES = Object.freeze({
  people: 'People',
  work: 'Work',
  alerts: 'Alerts',
  receipts: 'Receipts',
  newsletters: 'Newsletters',
  other: 'Other',
});

export const CATEGORY_DESCRIPTIONS = Object.freeze({
  people: 'Written by a person to the owner, outside work',
  work: "Anything about the owner's work, from a person or a work system",
  alerts: 'Automatic notices: security codes, shipping updates, account and service notices, reminders',
  receipts: 'Orders, payments, invoices, bookings and their confirmations',
  newsletters: 'Mail sent to a list: newsletters, digests, offers',
  other: "The engine isn't sure, or couldn't ask the model",
});

// The only values `decidedBy` takes (the plan's Output section).
export const DECIDED_BY = Object.freeze(['rule', 'model', 'not-sure', 'fallback']);

export const LIMITS = Object.freeze({
  fileBytes: 5 * 1024 * 1024,
  messages: 10_000,
  idChars: 128,
  inboxChars: 40,
  subjectChars: 1_000,
  snippetChars: 2_000,
  questionSnippetChars: 1_000,
  reasonChars: 160,
  reasonValueChars: 80,
  headerIdChars: 200,
});

export const DEFAULTS = Object.freeze({ confidenceFloor: 0.6, timeoutMs: 30_000 });

export class EmailSortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmailSortError';
  }
}

// Character-code order (UTF-16 code units), never locale order.
export function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Length and cuts count Unicode code points, so an emoji is one character
// and a cut never splits one.
export function charLength(text) {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export function cutChars(text, max) {
  if (text.length <= max) return text;
  let out = '';
  let count = 0;
  for (const ch of text) {
    if (count === max) break;
    out += ch;
    count += 1;
  }
  return out;
}

// Control characters are Unicode category Cc: C0 (U+0000 to U+001F), DEL
// and C1 (U+0080 to U+009F). Line feed and tab are allowed in mail text.
const CONTROL_EXCEPT_LF_TAB = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;
export function hasForbiddenControl(text) {
  return CONTROL_EXCEPT_LF_TAB.test(text);
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// The one way any text enters a reason (rule matches, header facts,
// domains, the model's reason): leading white space and control characters
// are skipped in one linear pass to the first real character, then every
// remaining run of them (CR, LF, tab, U+2028, U+2029 and the rest of Unicode
// Cc) becomes one space while the text is read, so a run counts as one
// character towards the cut. The result is cut to `max` characters, the last
// being "…" when real text is cut or input is left uninspected. Reading stops
// after `max + 1` output characters, and each separator run is inspected for
// at most eight times `max` code units: a longer run, and anything after it,
// counts as uninspected. An empty flattened value returns "".
export function oneLine(text, max) {
  const source = String(text);
  const whiteOrControl = /[\s\u0000-\u001F\u007F-\u009F]/u;
  const runLimit = max * 8;

  // Skip all leading separators in one linear pass so padding does not use
  // up the output.
  let index = 0;
  while (index < source.length && whiteOrControl.test(source[index])) index += 1;

  let out = '';
  let count = 0;
  let truncated = false;
  while (index < source.length) {
    const character = String.fromCodePoint(source.codePointAt(index));
    if (whiteOrControl.test(character)) {
      // Collapse this run to one space, inspecting at most `runLimit` units.
      const runEnd = Math.min(source.length, index + runLimit);
      while (index < runEnd && whiteOrControl.test(source[index])) index += 1;
      if (index === source.length) break; // trailing separators only
      if (whiteOrControl.test(source[index])) { truncated = true; break; } // run not fully inspected
      if (count === max) { truncated = true; break; }
      out += ' ';
      count += 1;
      continue;
    }
    if (count === max) { truncated = true; break; }
    out += character;
    count += 1;
    index += character.length;
  }

  if (out === '') return '';
  if (!truncated) return out;
  return `${cutChars(out, max - 1).trimEnd()}…`;
}

export function quote(text) {
  return JSON.stringify(cutChars(String(text), 80));
}

// An address has exactly one "@" with something on both sides
// (RFC 5322 addr-spec: local-part "@" domain).
export function addressProblem(address) {
  if (typeof address !== 'string') return 'must be text';
  const at = address.split('@').length - 1;
  if (at !== 1) return 'must hold exactly one "@"';
  const [local, domain] = address.split('@');
  if (local.trim() === '' || domain.trim() === '') return 'needs text before and after the "@"';
  if (hasForbiddenControl(address)) return 'holds a control character';
  return null;
}

export function lower(text) {
  // toLowerCase is locale-independent; toLocaleLowerCase is not used.
  return text.toLowerCase();
}

export function domainOf(address) {
  return lower(address.slice(address.indexOf('@') + 1).trim());
}
