/** Dates, URL checks, and plain-text escaping for the report. */

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;
const PLACEHOLDER = /\{(service|assistant|question|count|last90Days|unanswered|wrongDetails|listing|website|source|checkedOn|websiteCheckedOn)\}/g;

const DESTINATION = {
  '<': '%3C',
  '>': '%3E',
  ' ': '%20',
  '(': '%28',
  ')': '%29',
  '\\': '%5C',
};

export function isRealDate(text) {
  if (typeof text !== 'string' || !DATE_TEXT.test(text)) return false;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.toISOString().slice(0, 10) === text;
}

export function daysBefore(later, earlier) {
  const end = Date.parse(`${later}T00:00:00Z`);
  const start = Date.parse(`${earlier}T00:00:00Z`);
  return Math.round((end - start) / 86400000);
}

export function hiddenCharacter(text, { multiline = false } = {}) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code <= 0x1f) {
      if (multiline && code === 0x0a) continue;
      return true;
    }
    if (code >= 0x7f && code <= 0x9f) return true;
    if (code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/** A complete https address: the URL parser accepts it and it has a host. */
export function isHttpsUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function fill(template, vars) {
  return template.replace(PLACEHOLDER, (_, key) => (vars[key] === undefined || vars[key] === null ? '' : String(vars[key])));
}

export function encodeDestination(url) {
  let encoded = '';
  for (const ch of url) encoded += DESTINATION[ch] ?? ch;
  return encoded.replaceAll('&', '&amp;');
}

function isAutoLinkWord(word) {
  if (word.includes('://')) return true;
  if (/^www\./i.test(word)) return true;
  if (word.startsWith('mailto:') || word.startsWith('xmpp:')) return true;
  return word.includes('@');
}

function codeSpan(word) {
  const runs = word.match(/`+/g);
  const longest = runs ? runs.reduce((max, run) => Math.max(max, run.length), 0) : 0;
  const fence = '`'.repeat(longest + 1);
  const pad = word.startsWith('`') || word.endsWith('`');
  const body = pad ? ` ${word} ` : word;
  return `${fence}${body}${fence}`;
}

function escapeInline(text) {
  return text.replace(/[\\&<>`*_\[\]()!#]/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    return `\\${ch}`;
  });
}

function escapeLine(line) {
  const escaped = line.split(/([ ])/).map((part) => {
    if (part === '' || part === ' ') return part;
    if (isAutoLinkWord(part)) return codeSpan(part);
    return escapeInline(part);
  }).join('');
  return escaped
    .replace(/^(\s{0,3})([-+])(?=\s|$)/, '$1\\$2')
    .replace(/^(\s{0,3})(\d+)\. (?=\S)/, '$1$2\\. ');
}

/**
 * Escape finding text for Markdown. Autolink-shaped words become code
 * spans. A line feed in a multi-line field stays inside the same entry.
 */
export function escapeField(text, { multiline = false } = {}) {
  const lines = String(text).split('\n').map((line) => escapeLine(line));
  if (!multiline || lines.length === 1) return lines.join('\n');
  return lines.map((line, index) => (index === 0 ? line : `    ${line}`)).join('  \n');
}

export function formatSource(source) {
  const label = escapeField(source.label);
  if (source.url) return `${label} ([link](<${encodeDestination(source.url)}>))`;
  return `${label} ("${escapeField(source.locator)}")`;
}
