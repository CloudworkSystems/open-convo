import { createHash } from 'node:crypto';
import { normalizeTime, optionObject, checkHashKey } from './validation.mjs';

export const limits = Object.freeze({ cards: 20_000, cardBytes: 1024 * 1024, totalBytes: 512 * 1024 * 1024 });
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => { throw new Error(message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const dataMap = value => Object.assign(Object.create(null), value);
const ownValue = (record, key) => Object.hasOwn(record, key) ? record[key] : undefined;
class CardInputError extends Error {}
const cardError = message => { throw new CardInputError(message); };
const titleSegments = new Intl.Segmenter('und', { granularity: 'grapheme' });

export function validateSource(source) {
  if (!plain(source) || typeof source.id !== 'string' || source.id !== source.id.trim() || !ID.test(source.id)) fail(`Refusing source id "${source?.id ?? ''}". Use 1 to 64 lowercase letters, digits or hyphens, starting with a letter.`);
  if (typeof source.name !== 'string' || !source.name.trim()) fail(`Source "${source.id}" needs a name.`);
  if (source.emptyGuidance !== undefined && (typeof source.emptyGuidance !== 'string' || !source.emptyGuidance.trim())) fail(`Source "${source.id}" needs emptyGuidance to be nonempty text when supplied.`);
  if (typeof source.read !== 'function') fail(`Source "${source.id}" needs a read(files) function.`);
}

function validKey(key) {
  if (typeof key !== 'string' || !key || key.startsWith('/') || key.includes('\\') || CONTROL.test(key)) return false;
  const parts = key.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
}

function validateExtra(value, key, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) fail(`Item "${key}" has invalid extra fields; use plain data without circular references.`);
  ancestors.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) validateExtra(child, key, ancestors);
  ancestors.delete(value);
}

function validateResult(source, result, files = []) {
  if (!plain(result) || !Array.isArray(result.items) || !Array.isArray(result.skipped) || !Array.isArray(result.warnings)) fail(`Source "${source.id}" returned an invalid result.`);
  if (result.items.length > limits.cards) fail(`Refusing ${result.items.length} cards. The limit is ${limits.cards}.`);
  const seen = new Set();
  for (const item of result.items) {
    if (!plain(item) || !validKey(item.key)) fail(`Refusing key "${item?.key ?? ''}" because it is not a safe relative path.`);
    if (seen.has(item.key)) fail(`Refusing duplicate key "${item.key}".`);
    seen.add(item.key);
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200) fail(`Item "${item.key}" needs a title of 1 to 200 characters.`);
    if (typeof item.body !== 'string') fail(`Item "${item.key}" needs a text body.`);
    if (item.url !== null && typeof item.url !== 'string') fail(`Item "${item.key}" has an invalid url.`);
    if (item.created !== null && typeof item.created !== 'string') fail(`Item "${item.key}" has an invalid created value.`);
    if (!validKey(item.sourcePath)) fail(`Item "${item.key}" needs a sourcePath that is a relative file path.`);
    if (!Array.isArray(item.tags) || item.tags.length > 50) fail(`Item "${item.key}" has invalid tags.`);
    for (const tag of item.tags) if (typeof tag !== 'string' || !tag.trim() || tag.length > 100) fail(`Item "${item.key}" has invalid tags.`);
    if (item.extra !== undefined) {
      if (!plain(item.extra)) fail(`Item "${item.key}" has invalid extra fields.`);
      validateExtra(item.extra, item.key);
    }
  }
  for (const skipped of result.skipped) if (!plain(skipped) || !validKey(skipped.sourcePath) || typeof skipped.reason !== 'string' || !skipped.reason.trim()) fail(`Source "${source.id}" returned an invalid skipped entry; provide sourcePath and a text reason.`);
  const paths = [...files.map(file => file.path), ...result.items.map(item => item.sourcePath), ...result.skipped.map(entry => entry.sourcePath)];
  for (const warning of result.warnings) if (typeof warning !== 'string' || !warning.trim() || !paths.some(file => warning.includes(file))) fail(`Source "${source.id}" returned an invalid warning; provide text naming a file.`);
  return result;
}

// Hash typed values a small string chunk at a time. In particular, never build
// a JSON string containing all card bodies just to compare two reader results.
function resultDigest(result) {
  const digest = createHash('sha256');
  const ancestors = new Set();
  function visit(value) {
    if (typeof value === 'string') {
      digest.update(`string:${value.length}:`);
      for (let offset = 0; offset < value.length; offset += 4096) digest.update(value.slice(offset, offset + 4096), 'utf16le');
    } else if (value === null) digest.update('null;');
    else if (typeof value === 'object') {
      if (ancestors.has(value)) fail('Source result must not contain circular references.');
      ancestors.add(value);
      digest.update(Array.isArray(value) ? 'array{' : 'object{');
      for (const key of Object.keys(value)) { visit(key); visit(value[key]); }
      digest.update('}');
      ancestors.delete(value);
    } else if (['number', 'boolean', 'undefined'].includes(typeof value)) digest.update(`${typeof value}:${String(value)};`);
    else fail('Source result contains a value that is not plain data.');
  }
  visit(result);
  return digest.digest('hex');
}

export function checkSource(source, files) {
  validateSource(source);
  if (!Array.isArray(files)) fail('Files must be a list.');
  checkFiles(files);
  // Copy only the small records, sharing immutable strings rather than cloning
  // every card's text. Readers get the same read-only input on both calls.
  const input = Object.freeze(files.map(file => Object.freeze({ path: file.path, text: file.text })));
  const first = validateResult(source, source.read(input), input);
  const firstDigest = resultDigest(first);
  const secondDigest = resultDigest(validateResult(source, source.read(input), input));
  if (firstDigest !== secondDigest) fail(`Source "${source.id}" returned different results for the same files.`);
  return first;
}

function checkFiles(files) {
  if (!Array.isArray(files)) fail('Files must be a list.');
  let count = 0, total = 0;
  for (const file of files) {
    if (!plain(file) || !validKey(file.path)) fail('Each file needs a relative path and text.');
    if (/\.md$/i.test(file.path) && ++count > limits.cards) fail(`Refusing ${count} files. The card limit is ${limits.cards}.`);
  }
  for (const file of files) {
    if (typeof file.text !== 'string') fail(`File "${file.path}" needs text.`);
    total += Buffer.byteLength(file.text);
    if (total > limits.totalBytes) fail(`Refusing export larger than ${limits.totalBytes} bytes.`);
  }
}

function scalar(value, keepText = true) {
  const text = String(value);
  const typed = /^(?:[+-]?(?:\d|\.\d)|null$|true$|false$|yes$|no$|on$|off$|~$|\.inf$|\.nan$)/i.test(text);
  const syntax = /^[@:]|^-(?:\s|$)|:\s/.test(text);
  return !(keepText && typed) && !syntax && /^[A-Za-z0-9 _./:@+-]+$/.test(text) && text.trim() === text ? text : JSON.stringify(text);
}

// Atlas reads simple key/value lines, stripping only their outer quotes.
// Unlike the other metadata serializer, this must never insert JSON escapes.
function atlasScalar(text) {
  const encoded = scalar(text);
  return encoded.startsWith('"') ? `"${text}"` : encoded;
}

function frontLines(key, value, indent = '', keepText = true) {
  const emit = v => scalar(v, keepText);
  const label = scalar(key);
  function sequence(values, prefix) {
    return values.flatMap(child => {
      if (Array.isArray(child)) return child.length ? [`${prefix}-`, ...sequence(child, `${prefix}  `)] : [`${prefix}- []`];
      if (plain(child)) return Object.keys(child).length ? [`${prefix}-`, ...Object.entries(child).flatMap(([name, nested]) => frontLines(name, nested, `${prefix}  `, keepText))] : [`${prefix}- {}`];
      return [`${prefix}- ${emit(child)}`];
    });
  }
  if (Array.isArray(value)) return value.length ? [`${indent}${label}:`, ...sequence(value, `${indent}  `)] : [`${indent}${label}: []`];
  if (plain(value)) {
    if (!Object.keys(value).length) return [`${indent}${label}: {}`];
    const lines = [`${indent}${label}:`];
    for (const [child, childValue] of Object.entries(value)) lines.push(...frontLines(child, childValue, `${indent}  `, keepText));
    return lines;
  }
  return [`${indent}${label}: ${emit(value)}`];
}

function utf8Prefix(text, maxBytes) {
  let prefix = '', bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    prefix += character;
    bytes += size;
  }
  return prefix;
}

function fitComponent(stem, suffix = '') {
  if (Buffer.byteLength(stem + suffix) <= 255) return stem + suffix;
  const tail = `-${hash(stem).slice(0, 16)}${suffix}`;
  return utf8Prefix(stem, 255 - Buffer.byteLength(tail)) + tail;
}

function slugParts(key) {
  const parts = key.replace(/\.md$/i, '').split('/').map(part => part.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'card');
  return parts.map((part, index) => fitComponent(part, index === parts.length - 1 ? '.md' : ''));
}

function addSuffix(notePath, suffix) {
  const slash = notePath.lastIndexOf('/');
  const stem = notePath.slice(slash + 1, -3), tail = `-${suffix}.md`;
  return notePath.slice(0, slash + 1) + utf8Prefix(stem, 255 - Buffer.byteLength(tail)) + tail;
}

export function toNotes(items, options = {}) {
  optionObject(options, 'toNotes', ['source', 'importedAt', 'manifest', 'hashKey']);
  let { source, importedAt, manifest = Object.create(null), hashKey = hash } = options;
  validateSource(source);
  importedAt = normalizeTime(importedAt);
  checkHashKey(hashKey);
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) fail('manifest: expected an object mapping source keys to saved note records.');
  manifest = dataMap(manifest);
  for (const [key, entry] of Object.entries(manifest)) {
    if (!validKey(key) || !plain(entry) || typeof entry.path !== 'string' || !entry.path.startsWith(`sources/${source.id}/`) || !validKey(entry.path) || !entry.path.endsWith('.md') || entry.path.split('/').some(part => Buffer.byteLength(part) > 255)) fail(`manifest: expected safe keys and .md paths under sources/${source.id}/; invalid record for "${key}".`);
  }
  validateResult(source, { items, skipped: [], warnings: [] });
  const base = `sources/${source.id}/`;
  const candidates = items.map(item => {
    const kept = ownValue(manifest, item.key)?.path;
    const path = kept || `${base}${slugParts(item.key).join('/')}`;
    if (!path.startsWith(base) || !validKey(path) || !path.endsWith('.md')) fail(`Refusing path for key "${item.key}" because it leaves ${base}.`);
    if (path.split('/').some(component => Buffer.byteLength(component) > 255)) fail(`Refusing path for key "${item.key}" because a file or folder name exceeds 255 bytes.`);
    return { item, path };
  });
  const groups = new Map();
  for (const entry of candidates) {
    const folded = entry.path.toLowerCase();
    const reserved = entry.path.split('/').at(-1).toLowerCase() === 'index.md';
    if (!groups.has(folded)) groups.set(folded, []);
    groups.get(folded).push(entry);
    if (reserved) entry.needsSuffix = true;
  }
  const warnings = [];
  for (const group of groups.values()) if (group.length > 1) for (const entry of group) entry.needsSuffix = true;
  const used = new Set(Object.values(manifest).map(v => v.path?.toLowerCase()).filter(Boolean));
  for (const entry of candidates) {
    if (!ownValue(manifest, entry.item.key)?.path && used.has(entry.path.toLowerCase())) entry.needsSuffix = true;
    if (entry.needsSuffix && !ownValue(manifest, entry.item.key)?.path) {
      const digest = hashKey(entry.item.key);
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/i.test(digest)) fail('hashKey: expected 64 hexadecimal characters for every source key.');
      let found;
      for (const length of [8, 16, 64]) {
        const next = addSuffix(entry.path, digest.slice(0, length));
        if (!used.has(next.toLowerCase())) { found = next; break; }
      }
      if (!found) fail(`Could not make a unique path for key "${entry.item.key}".`);
      entry.path = found;
      warnings.push(`Card "${entry.item.key}" uses "${entry.path}" because its first path was reserved or collided.`);
    }
    const folded = entry.path.toLowerCase();
    if (used.has(folded) && ownValue(manifest, entry.item.key)?.path?.toLowerCase() !== folded) fail(`Refusing repeated output path "${entry.path}".`);
    used.add(folded);
  }
  const notes = candidates.map(({ item, path }) => {
    const title = item.title.replace(/[\t\r\n\u2028\u2029]/g, ' ');
    if (title !== item.title) warnings.push(`${item.sourcePath}: tabs or line breaks in the title were replaced with a space in the saved title and description so Atlas can read them.`);
    const lines = ['---', `kind: source`, `title: ${atlasScalar(title)}`, `description: ${atlasScalar(title)}`, ...frontLines('source', source.name), 'label: from a source', 'status: unchecked', ...frontLines('imported', importedAt, '', false)];
    if (item.url) lines.push(...frontLines('url', item.url));
    if (item.tags.length) lines.push(...frontLines('tags', item.tags));
    if (item.created) lines.push(...frontLines('created', item.created));
    if (item.extra && Object.keys(item.extra).length) lines.push(...frontLines(source.id, item.extra, '', true));
    lines.push('---', '', item.body);
    return { key: item.key, path, text: lines.slice(0, -1).join('\n') + '\n' + item.body };
  });
  return { notes, warnings };
}

function decodeValue(text) {
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return text;
  let decoded = '';
  const escapes = new Map([['0', '\0'], ['a', '\x07'], ['b', '\b'], ['t', '\t'], ['n', '\n'], ['v', '\v'], ['f', '\f'], ['r', '\r'], ['e', '\x1b'], [' ', ' '], ['"', '"'], ['/', '/'], ['\\', '\\'], ['N', '\u0085'], ['_', '\u00a0'], ['L', '\u2028'], ['P', '\u2029']]);
  for (let i = 1; i < text.length; i++) {
    const character = text[i];
    if (character === quote) {
      if (quote === "'" && text[i + 1] === "'") { decoded += "'"; i++; continue; }
      return i === text.length - 1 ? decoded : null;
    }
    if (quote === '"' && character === '\\') {
      const escape = text[++i];
      if (escapes.has(escape)) decoded += escapes.get(escape);
      else if (['x', 'u', 'U'].includes(escape)) {
        const length = escape === 'x' ? 2 : escape === 'u' ? 4 : 8;
        const hex = text.slice(i + 1, i + 1 + length);
        if (hex.length !== length || !/^[0-9a-f]+$/i.test(hex)) return null;
        const point = Number.parseInt(hex, 16);
        if (point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) return null;
        decoded += String.fromCodePoint(point);
        i += length;
      } else return null;
    } else decoded += character;
  }
  return null;
}

function addTag(tags, raw, sourcePath) {
  const tag = decodeValue(raw.trim());
  if (tag === null) return false;
  if (raw.trim() && !tag.trim()) cardError(`Item "${sourcePath}" has invalid tags: tags must contain text.`);
  if (tag) {
    if (tags.length === 50) cardError(`Item "${sourcePath}" has invalid tags: the limit is 50 tags.`);
    if (tag.length > 100) cardError(`Item "${sourcePath}" has invalid tags: each tag must be at most 100 UTF-16 units.`);
    tags.push(tag);
  }
  return true;
}

function flowTags(value, sourcePath) {
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) return null;
    value = value.slice(1, -1);
  }
  const tags = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (/\s/.test(value[cursor] || '') && cursor < value.length) cursor++;
    const start = cursor, quote = value[cursor];
    if (quote === '"' || quote === "'") {
      cursor++;
      let closed = false;
      while (cursor < value.length) {
        if (quote === '"' && value[cursor] === '\\') { cursor += 2; continue; }
        if (value[cursor] === quote) {
          if (quote === "'" && value[cursor + 1] === "'") { cursor += 2; continue; }
          cursor++; closed = true; break;
        }
        cursor++;
      }
      if (!closed) return null;
      while (/\s/.test(value[cursor] || '') && cursor < value.length) cursor++;
      if (cursor < value.length && value[cursor] !== ',') return null;
    } else {
      if (value[cursor] === '[' || value[cursor] === '{') return null;
      while (cursor < value.length && value[cursor] !== ',') cursor++;
    }
    if (!addTag(tags, value.slice(start, cursor), sourcePath)) return null;
    cursor++;
  }
  return tags;
}

function parseFrontMatter(text, sourcePath) {
  const opening = /^\uFEFF?---\r?\n/.exec(text);
  if (!opening) return { fields: dataMap(), body: text, warning: null };
  const delimiters = /^---(?:\r?\n|$)/gm;
  delimiters.lastIndex = opening[0].length;
  const closing = delimiters.exec(text);
  if (!closing) return { fields: dataMap(), body: text, warning: `${sourcePath}: front matter could not be read and was kept in the card.` };
  const raw = text.slice(opening[0].length, closing.index).replace(/\r?\n$/, '');
  const fields = dataMap();
  const unreadable = () => ({ fields: dataMap(), body: text, warning: `${sourcePath}: front matter could not be read and was kept in the card.` });
  const lines = raw ? raw.split(/\r?\n/) : [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) return { fields: dataMap(), body: text, warning: `${sourcePath}: front matter could not be read and was kept in the card.` };
    const [, key, value] = match;
    if (key === 'tags') {
      if (value) {
        const tags = flowTags(value, sourcePath);
        if (tags === null) return unreadable();
        fields[key] = tags;
      } else {
        const tags = [];
        while (index + 1 < lines.length) {
          const block = /^[ \t]*-[ \t]+(.*)$/.exec(lines[index + 1]);
          if (!block) break;
          if (!addTag(tags, block[1], sourcePath)) return unreadable();
          index++;
        }
        fields[key] = tags;
      }
    } else {
      const decoded = decodeValue(value);
      if (decoded === null) return unreadable();
      fields[key] = decoded;
    }
  }
  return { fields, body: text.slice(closing.index + closing[0].length), warning: null };
}

function escapedAt(text, offset) {
  let slashes = 0;
  while (offset > 0 && text[--offset] === '\\') slashes++;
  return slashes % 2 === 1;
}

// Keep offsets into the original Markdown. Mark block regions first, then
// scan inline constructs in order so opaque HTML cannot open a code span.
// Value 2 marks an actual HTML img tag: preserve it, but add the expiry notice.
// Fences use their opening character and length; inline spans need a matching
// backtick run of exactly the same length (and may cross line endings).
function markdownCodeMask(text) {
  const mask = new Uint8Array(text.length);
  let fence = null, html = null, paragraph = false;
  const blockTags = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
  const blockTag = new RegExp(`^ {0,3}</?(?:${blockTags})(?=[ \t/>]|$)`, 'i');
  // CommonMark tag grammar, including quoted attributes whose contents are opaque.
  const tag = /<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t\r\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\r\n]*=[ \t\r\n]*(?:"[^"]*"|'[^']*'|[^ \t\r\n"'=<>`]+))?)*[ \t\r\n]*\/?>/;
  const tagAtStart = new RegExp('^ {0,3}' + tag.source + '[ \t]*$');
  function markTags(start, end) {
    const region = text.slice(start, end);
    for (const match of region.matchAll(new RegExp(tag.source, 'g'))) {
      const at = start + match.index;
      if (/^<img(?:[\s/>]|$)/i.test(match[0])) mask[at] = 2;
    }
  }
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    let line = match[0].replace(/\r?\n$/, '');
    if (match.index === 0 && line.startsWith('\uFEFF')) line = line.slice(1);
    const blank = /^[ \t]*$/.test(line);
    if (html && html.blank && blank) html = null;
    if (!fence && !html) {
      // End conditions are plain string searches, exactly as CommonMark names them, so a protected
      // region never ends earlier than the spec says. CommonMark ends a comment block only at "-->".
      if (/^ {0,3}<(?:pre|script|style|textarea)(?=[ \t>]|$)/i.test(line)) html = { end: ['</pre>', '</script>', '</style>', '</textarea>'], fold: true };
      else if (/^ {0,3}<!--/.test(line)) html = { end: ['-->'] };
      else if (/^ {0,3}<\?/.test(line)) html = { end: ['?>'] };
      else if (/^ {0,3}<![A-Z]/.test(line)) html = { end: ['>'] };
      else if (/^ {0,3}<!\[CDATA\[/.test(line)) html = { end: [']]>'] };
      else if (blockTag.test(line)) html = { blank: true, tags: true };
      else if (!paragraph && tagAtStart.test(line)) html = { blank: true, tags: true };
    }
    if (html) {
      mask.fill(1, match.index, match.index + match[0].length);
      if (html.tags) markTags(match.index, match.index + match[0].length);
      if (html.end && html.end.some(marker => (html.fold ? line.toLowerCase() : line).includes(marker))) html = null;
      paragraph = false;
      continue;
    }
    if (fence) {
      mask.fill(1, match.index, match.index + match[0].length);
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && (open[1][0] !== '`' || !open[2].includes('`'))) {
      fence = open[1];
      mask.fill(1, match.index, match.index + match[0].length);
    } else if (/^(?: {4}| {0,3}\t)/.test(line)) mask.fill(1, match.index, match.index + match[0].length);
    paragraph = !blank && !open && !mask[match.index];
  }
  for (let i = 0; i < text.length;) {
    if (!mask[i] && text[i] === '<' && !escapedAt(text, i)) {
      const rest = text.slice(i);
      let end = -1;
      // An inline comment ends at "-->". If there is none, an HTML-style "--!>" end is accepted so
      // the text stays protected; this only ever adds protection, never shortens it.
      for (const [start, ...closes] of [['<!--', '-->', '--!>'], ['<?', '?>'], ['<![CDATA[', ']]>']]) {
        if (!rest.startsWith(start)) continue;
        for (const close of closes) { const found = text.indexOf(close, i + start.length); if (found >= 0) { end = found + close.length; break; } }
        break;
      }
      if (end < 0) {
        const declaration = /^<![A-Z][^>]*>/.exec(rest);
        const raw = new RegExp('^' + tag.source).exec(rest);
        const autolink = /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)>/.exec(rest);
        const matched = declaration || raw || autolink;
        if (matched) end = i + matched[0].length;
      }
      if (end >= 0) {
        mask.fill(1, i, end);
        if (/^<img(?:[\s/>]|$)/i.test(rest)) mask[i] = 2;
        i = end; continue;
      }
    }

    if (mask[i] || text[i] !== '`' || escapedAt(text, i)) { i++; continue; }
    let end = i + 1;
    while (text[end] === '`') end++;
    let cursor = end, closed = false;
    while (cursor < text.length) {
      if (mask[cursor]) break;
      if (text[cursor] !== '`') { cursor++; continue; }
      let next = cursor + 1;
      while (text[next] === '`') next++;
      if (next - cursor === end - i) {
        mask.fill(1, i, next);
        i = next;
        closed = true;
        break;
      }
      cursor = next;
    }
    if (!closed) i = end;
  }
  return mask;
}

function bracketEnd(text, start, code = null) {
  if (text[start] !== '[') return -1;
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (code?.[i]) continue;
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '[') depth++;
    if (text[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

function destinationAt(text, start) {
  let i = start;
  if (text[i] === '<') {
    const begin = ++i;
    while (i < text.length && text[i] !== '>') {
      if (text[i] === '\n' || text[i] === '\r' || text[i] === '<') return null;
      if (text[i] === '\\') i++;
      i++;
    }
    return text[i] === '>' ? { url: text.slice(begin, i), end: i + 1 } : null;
  }
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (/[\u0000-\u0020\u007f]/.test(text[i])) break;
    if (text[i] === '(') depth++;
    if (text[i] === ')') { if (!depth) break; depth--; }
  }
  return i > start && !depth ? { url: text.slice(start, i), end: i } : null;
}

const referenceLabel = value => value.replace(/\\([\[\]\\])/g, '$1').trim().replace(/\s+/g, ' ').toLowerCase();
function decodedDestination(url) {
  return url.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1').replace(/&#(x[0-9a-f]+|[0-9]+);|&(colon|sol|amp);/gi, (whole, point, name) => {
    if (name) return ({ colon: ':', sol: '/', amp: '&' })[name.toLowerCase()];
    const value = point[0].toLowerCase() === 'x' ? parseInt(point.slice(1), 16) : parseInt(point, 10);
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
  });
}
const remoteImage = url => /^(?:https?:)?\/\//i.test(decodedDestination(url));

function linkSpace(text, start) {
  let end = start;
  while (end < text.length && /[ \t\r\n]/.test(text[end])) end++;
  return /(?:\r?\n)[ \t]*(?:\r?\n)/.test(text.slice(start, end)) ? -1 : end;
}

function titleEnd(text, start) {
  const opener = text[start], closer = opener === '(' ? ')' : opener;
  if (!['"', "'", '('].includes(opener)) return -1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === closer) return i + 1;
    if (opener === '(' && text[i] === '(') return -1;
    if (text[i] === '\n' && /^[ \t]*\r?\n/.test(text.slice(i + 1))) return -1;
  }
  return -1;
}

function plainImageLinks(text, code) {
  const references = new Map();
  // Definitions are collected before uses, so their order in the card does not matter.
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const indentation = /^(?:\uFEFF)? {0,3}(?=\[)/.exec(line[0]);
    if (!indentation) continue;
    const start = line.index + indentation[0].length;
    if (code[start]) continue;
    const end = bracketEnd(text, start);
    if (end < 0 || text[end + 1] !== ':') continue;
    const cursor = linkSpace(text, end + 2);
    if (cursor < 0 || (code[cursor] && text[cursor] !== '<')) continue;
    const destination = destinationAt(text, cursor);
    const label = referenceLabel(text.slice(start + 1, end));
    if (label && !references.has(label)) references.set(label, destination ? destination.url : null);
  }
  const chunks = [];
  let previous = 0, converted = false, uncertain = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '<' && (!code[i] || code[i] === 2) && !escapedAt(text, i) && /^<img(?:[\s/>]|$)/i.test(text.slice(i))) {
      // HTML attribute grammars and srcset may carry multiple destinations.
      // Preserve the tag and warn rather than guessing which bytes to rewrite.
      uncertain = true;
    }
    if (text[i] !== '!' || text[i + 1] !== '[' || code[i] || escapedAt(text, i)) continue;
    const close = bracketEnd(text, i + 1, code);
    if (close < 0) { uncertain = true; continue; }
    const label = referenceLabel(text.slice(i + 2, close));
    let end = close + 1, remote = false;
    if (text[end] === '(') {
      let cursor = linkSpace(text, end + 1);
      if (cursor < 0) { uncertain = true; continue; }
      const destination = destinationAt(text, cursor);
      if (!destination) { uncertain = true; continue; }
      cursor = linkSpace(text, destination.end);
      if (cursor < 0) { uncertain = true; continue; }
      if (['"', "'", '('].includes(text[cursor])) {
        if (cursor === destination.end) { uncertain = true; continue; }
        const afterTitle = titleEnd(text, cursor);
        if (afterTitle < 0) { uncertain = true; continue; }
        cursor = linkSpace(text, afterTitle);
      }
      if (cursor < 0 || text[cursor] !== ')') { uncertain = true; continue; }
      remote = remoteImage(destination.url);
      end = cursor + 1;
    } else if (text[end] === '[') {
      const referenceEnd = bracketEnd(text, end);
      if (referenceEnd < 0) { uncertain = true; continue; }
      const target = references.get(referenceLabel(text.slice(end + 1, referenceEnd)) || label);
      if (target === null) uncertain = true;
      remote = remoteImage(target || '');
      end = referenceEnd + 1;
    } else {
      const target = references.get(label);
      if (target === null) uncertain = true;
      remote = remoteImage(target || '');
    }
    if (!remote) continue;
    chunks.push(text.slice(previous, i), text.slice(i + 1, end));
    previous = end;
    i = end - 1;
    converted = true;
  }
  chunks.push(text.slice(previous));
  return { body: chunks.join(''), converted, uncertain };
}

function readMarkdown(text) {
  const code = markdownCodeMask(text);
  let heading;
  for (const match of text.matchAll(/^(?:\uFEFF)? {0,3}# ([^\r\n]+)\r?$/gm)) if (!code[match.index]) { heading = match[1]; break; }
  let { body, converted, uncertain } = plainImageLinks(text, code);
  if (converted || uncertain) {
    const eol = /\r?\n(?=[^\n]*$)/.exec(body)?.[0] || '\n';
    body += `${body.endsWith('\n') ? '' : eol}${eol}Images in this card were not imported. Their links may stop working.${eol}`;
  }
  return { heading, body };
}

export function recallSource() {
  return { id: 'recall', name: 'Recall', emptyGuidance: "This folder has no Recall cards. In Recall's web app, open Settings, choose Export, unzip the download, then run this again on that folder.", read(files) {
    const items = [], skipped = [], warnings = [];
    checkFiles(files);
    for (const file of files) {
      const bytes = Buffer.byteLength(file.text);
      if (!file.path.toLowerCase().endsWith('.md')) { skipped.push({ sourcePath: file.path, reason: 'not a Markdown card' }); continue; }
      if (bytes > limits.cardBytes) { skipped.push({ sourcePath: file.path, reason: `card is ${bytes} bytes; limit is ${limits.cardBytes}` }); continue; }
      try {
      const parsed = parseFrontMatter(file.text, file.path);
      if (parsed.warning) warnings.push(parsed.warning);
      const fields = parsed.fields;
      const { heading, body } = readMarkdown(parsed.body);
      let title;
      if (Object.hasOwn(fields, 'title')) {
        title = fields.title;
        if (!title.trim() || title.length > 200) cardError(`Card "${file.path}" has an explicit title outside the limit of 1 to 200 UTF-16 units. Shorten or fill in its title and import again.`);
      } else {
        const derived = heading || file.path.split('/').at(-1).replace(/\.md$/i, '');
        title = derived;
        if (derived.length > 200) {
          title = '';
          for (const { segment } of titleSegments.segment(derived)) {
            if (title.length + segment.length > 200) break;
            title += segment;
          }
          warnings.push(`${file.path}: the ${heading ? 'heading' : 'filename'} title was shortened to at most 200 UTF-16 units without splitting a character. The body was kept as written.`);
        }
        if (!title.trim()) {
          title = 'Untitled card';
          warnings.push(`${file.path}: the derived title had no usable text; the saved title is "Untitled card". The body was kept as written.`);
        }
      }
      const extra = dataMap();
      for (const [key, value] of Object.entries(fields)) if (!['title', 'url', 'source', 'tags', 'created', 'date'].includes(key)) extra[key] = value;
      items.push({ key: file.path, title, body, url: fields.url || fields.source || null, tags: fields.tags || [], created: fields.created || fields.date || null, sourcePath: file.path, extra });
      } catch (error) {
        if (!(error instanceof CardInputError)) throw error;
        skipped.push({ sourcePath: file.path, reason: error.message });
      }
    }
    return { items, skipped, warnings };
  }};
}

export const sources = [recallSource()];
