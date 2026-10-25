export const SCHEMA_VERSION = 1;
export const PILES = Object.freeze(['people', 'work', 'alerts', 'receipts', 'newsletters', 'other']);
export const PILE_NAMES = Object.freeze({
  people: 'People', work: 'Work', alerts: 'Alerts', receipts: 'Receipts', newsletters: 'Newsletters', other: 'Other',
});
export const ACTIONS = Object.freeze(['unsubscribe', 'spam', 'delete']);
export const COMMON_MAIL_DOMAINS = Object.freeze([
  'aol.com', 'gmail.com', 'hotmail.com', 'icloud.com', 'live.com', 'outlook.com', 'proton.me', 'protonmail.com', 'yahoo.com',
]);
export const LIMITS = Object.freeze({
  fileBytes: 5 * 1024 * 1024,
  messages: 10_000,
  requests: 200,
  messageTargets: 1_000,
  idChars: 128,
  inboxChars: 40,
  subjectChars: 1_000,
  snippetChars: 2_000,
  headerIdChars: 200,
  urlChars: 2_000,
});

export class EmailActionsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmailActionsError';
  }
}

export function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function lower(text) {
  return text.toLowerCase();
}

export function charLength(text) {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

const CONTROL_EXCEPT_LF_TAB = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;
export function hasForbiddenControl(text) {
  return CONTROL_EXCEPT_LF_TAB.test(text);
}

export function quote(text) {
  return JSON.stringify([...String(text)].slice(0, 80).join(''));
}

export function addressProblem(address) {
  if (typeof address !== 'string') return 'must be text';
  if (address.split('@').length !== 2) return 'must hold exactly one "@"';
  const [local, domain] = address.split('@');
  if (local.trim() === '' || domain.trim() === '') return 'needs text before and after the "@"';
  if (hasForbiddenControl(address)) return 'holds a control character';
  return null;
}

export function addressKey(address) {
  return lower(address.trim());
}

export function domainOf(address) {
  return addressKey(address).slice(addressKey(address).indexOf('@') + 1);
}

export function oneLine(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, character => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
