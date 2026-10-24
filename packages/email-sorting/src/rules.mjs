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
// are skipped within a fixed bound, then every remaining run of them (CR,
// LF, tab, U+2028, U+2029 and the rest of Unicode Cc) becomes one space.
// The result is trimmed and cut to `max` characters, the last being "…"
// when bounded suffix inspection finds real text that was cut or leaves any
// input uninspected. Every scan is bounded by a multiple of `max`, regardless
// of input length. Only a flattened empty value returns ""; callers decide
// whether a literal ellipsis has special meaning in their context.
export function oneLine(text, max) {
  const source = String(text);
  const whiteOrControl = /[\s\u0000-\u001F\u007F-\u009F]/u;

  // A separate leading allowance keeps padding from consuming the body bound.
  // If it is exhausted, treating the value as empty keeps work bounded.
  const leadingLimit = Math.min(source.length, max * 8);
  let start = 0;
  while (start < leadingLimit && whiteOrControl.test(source[start])) start += 1;
  if (start === leadingLimit && start < source.length) return '';

  // Take at most five output lengths without slicing or walking the rest.
  let bounded = '';
  let end = start;
  for (let count = 0; end < source.length && count < max * 5; count += 1) {
    const codePoint = source.codePointAt(end);
    const character = String.fromCodePoint(codePoint);
    bounded += character;
    end += character.length;
  }

  // Inspect a fixed number of code units after a cut. Real text in that window
  // means content was cut; so does input beyond the window, because it was not
  // inspected and therefore cannot safely be treated as padding.
  const suffixWasTruncated = (from) => {
    const inspectionEnd = Math.min(source.length, from + max * 8);
    for (let index = from; index < inspectionEnd; index += 1) {
      if (!whiteOrControl.test(source[index])) return true;
    }
    return inspectionEnd < source.length;
  };
  let truncatedPastBound = suffixWasTruncated(end);

  // Preserve the established boundary result when useful text straddled the
  // former five-length input window; the inspection remains fixed-size.
  if (!truncatedPastBound && start > 0 && start < max * 5 && source.length > max * 5) {
    truncatedPastBound = suffixWasTruncated(max * 5);
  }

  const flat = bounded.replace(/[\s\u0000-\u001F\u007F-\u009F]+/g, ' ').trim();
  if (flat === '') return '';
  if (!truncatedPastBound && cutChars(flat, max) === flat) return flat;
  return `${cutChars(flat, max - 1).trimEnd()}…`;
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
