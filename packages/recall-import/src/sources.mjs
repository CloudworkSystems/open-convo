import { createHash } from 'node:crypto';

export const limits = Object.freeze({ cards: 20_000, cardBytes: 1024 * 1024, totalBytes: 512 * 1024 * 1024 });
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const hash = value => createHash('sha256').update(value).digest('hex');

export function validateSource(source) {
  if (!plain(source) || !ID.test(source.id || '')) fail(`Refusing source id "${source?.id ?? ''}". Use 1 to 64 lowercase letters, digits or hyphens, starting with a letter.`);
  if (typeof source.name !== 'string' || !source.name.trim()) fail(`Source "${source.id}" needs a name.`);
  if (typeof source.read !== 'function') fail(`Source "${source.id}" needs a read(files) function.`);
}

function validKey(key) {
  if (typeof key !== 'string' || !key || key.startsWith('/') || key.includes('\\') || CONTROL.test(key)) return false;
  const parts = key.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
}

function validateResult(source, result) {
  if (!plain(result) || !Array.isArray(result.items) || !Array.isArray(result.skipped) || !Array.isArray(result.warnings)) fail(`Source "${source.id}" returned an invalid result.`);
  if (result.items.length > limits.cards) fail(`Refusing ${result.items.length} cards. The limit is ${limits.cards}.`);
  const seen = new Set();
  for (const item of result.items) {
    if (!plain(item) || !validKey(item.key)) fail(`Refusing key "${item?.key ?? ''}" because it is not a safe relative path.`);
    if (seen.has(item.key)) fail(`Refusing duplicate key "${item.key}".`);
    seen.add(item.key);
    if (typeof item.title !== 'string' || item.title.length < 1 || item.title.length > 200) fail(`Item "${item.key}" needs a title of 1 to 200 characters.`);
    if (typeof item.body !== 'string') fail(`Item "${item.key}" needs a text body.`);
    if (item.url !== null && item.url !== undefined && typeof item.url !== 'string') fail(`Item "${item.key}" has an invalid url.`);
    if (item.created !== null && item.created !== undefined && typeof item.created !== 'string') fail(`Item "${item.key}" has an invalid created value.`);
    if (!Array.isArray(item.tags) || item.tags.length > 50 || item.tags.some(tag => typeof tag !== 'string' || tag.length > 100)) fail(`Item "${item.key}" has invalid tags.`);
    if (item.extra !== undefined && !plain(item.extra)) fail(`Item "${item.key}" has invalid extra fields.`);
  }
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
  // Copy only the small records, sharing immutable strings rather than cloning
  // every card's text. Readers get the same read-only input on both calls.
  const input = Object.freeze(files.map(file => Object.freeze({ path: file.path, text: file.text })));
  const first = validateResult(source, source.read(input));
  const firstDigest = resultDigest(first);
  const secondDigest = resultDigest(validateResult(source, source.read(input)));
  if (firstDigest !== secondDigest) fail(`Source "${source.id}" returned different results for the same files.`);
  return first;
}

function scalar(value) {
  const text = String(value);
  return /^[A-Za-z0-9 _./:@+-]+$/.test(text) && text.trim() === text ? text : JSON.stringify(text);
}

function frontLines(key, value, indent = '', keepText = false) {
  const emit = v => keepText && /^(?:[+-]?(?:\d|\.\d)|null$|true$|false$|yes$|no$|on$|off$|~$|\.inf$|\.nan$)/i.test(String(v)) ? JSON.stringify(String(v)) : scalar(v);
  if (Array.isArray(value)) return value.length ? [`${indent}${key}:`, ...value.map(v => `${indent}  - ${emit(v)}`)] : [`${indent}${key}: []`];
  if (plain(value)) {
    const lines = [`${indent}${key}:`];
    for (const [child, childValue] of Object.entries(value)) lines.push(...frontLines(child, childValue, `${indent}  `, keepText));
    return lines;
  }
  return [`${indent}${key}: ${emit(value)}`];
}

function slugParts(key) {
  const parts = key.replace(/\.md$/i, '').split('/').map(part => part.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'card');
  return parts;
}

function addSuffix(path, suffix) { return path.replace(/\.md$/, `-${suffix}.md`); }

export function toNotes(items, { source, importedAt, manifest = {}, hashKey = hash } = {}) {
  validateSource(source);
  if (typeof importedAt !== 'string' || !importedAt) fail('importedAt must be supplied.');
  validateResult(source, { items, skipped: [], warnings: [] });
  const base = `sources/${source.id}/`;
  const candidates = items.map(item => {
    const kept = manifest[item.key]?.path;
    const path = kept || `${base}${slugParts(item.key).join('/')}.md`;
    if (!path.startsWith(base) || !validKey(path) || !path.endsWith('.md')) fail(`Refusing path for key "${item.key}" because it leaves ${base}.`);
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
    if (!manifest[entry.item.key]?.path && used.has(entry.path.toLowerCase())) entry.needsSuffix = true;
    if (entry.needsSuffix && !manifest[entry.item.key]?.path) {
      const digest = hashKey(entry.item.key);
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
    if (used.has(folded) && manifest[entry.item.key]?.path?.toLowerCase() !== folded) fail(`Refusing repeated output path "${entry.path}".`);
    used.add(folded);
  }
  const notes = candidates.map(({ item, path }) => {
    const lines = ['---', `kind: source`, ...frontLines('title', item.title), ...frontLines('description', item.title), ...frontLines('source', source.name), 'label: from a source', 'status: unchecked', ...frontLines('imported', importedAt)];
    if (item.url) lines.push(...frontLines('url', item.url));
    if (item.tags.length) lines.push(...frontLines('tags', item.tags));
    if (item.created) lines.push(...frontLines('created', item.created));
    if (item.extra && Object.keys(item.extra).length) lines.push(...frontLines(source.id, item.extra, '', true));
    lines.push('---', '', item.body);
    return { key: item.key, path, text: lines.slice(0, -1).join('\n') + '\n' + item.body };
  });
  return { notes, warnings };
}

function parseFrontMatter(text, sourcePath) {
  if (!text.startsWith('---\n')) return { fields: {}, body: text, warning: null };
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return { fields: {}, body: text, warning: `${sourcePath}: front matter could not be read and was kept in the card.` };
  const raw = text.slice(4, end);
  const fields = {};
  for (const line of raw.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) return { fields: {}, body: text, warning: `${sourcePath}: front matter could not be read and was kept in the card.` };
    const [, key, value] = match;
    fields[key] = key === 'tags' ? value.replace(/^\[|\]$/g, '').split(',').map(v => v.trim()).filter(Boolean) : value.replace(/^(["'])(.*)\1$/, '$2');
  }
  return { fields, body: text.slice(end + 5), warning: null };
}

export function recallSource() {
  return { id: 'recall', name: 'Recall', read(files) {
    const items = [], skipped = [], warnings = [];
    let total = 0;
    const count = files.filter(file => /\.md$/i.test(file.path)).length;
    if (count > limits.cards) fail(`Refusing ${count} files. The card limit is ${limits.cards}.`);
    for (const file of files) {
      const bytes = Buffer.byteLength(file.text);
      total += bytes;
      if (total > limits.totalBytes) fail(`Refusing export larger than ${limits.totalBytes} bytes.`);
      if (!file.path.toLowerCase().endsWith('.md')) { skipped.push({ sourcePath: file.path, reason: 'not a Markdown card' }); continue; }
      if (bytes > limits.cardBytes) { skipped.push({ sourcePath: file.path, reason: `card is ${bytes} bytes; limit is ${limits.cardBytes}` }); continue; }
      const parsed = parseFrontMatter(file.text, file.path);
      if (parsed.warning) warnings.push(parsed.warning);
      const fields = parsed.fields;
      const heading = /^# (.+)$/m.exec(parsed.body)?.[1];
      const title = fields.title || heading || file.path.split('/').at(-1).replace(/\.md$/i, '');
      const extra = Object.fromEntries(Object.entries(fields).filter(([key]) => !['title', 'url', 'source', 'tags', 'created', 'date'].includes(key)));
      let body = parsed.body;
      if (/!\[[^\]]*\]\(https?:\/\//i.test(body)) body = `${body.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]*)\)/gi, '[$1]($2)').replace(/\n?$/, '\n')}\nImages in this card were not imported. Their links may stop working.\n`;
      items.push({ key: file.path, title, body, url: fields.url || fields.source || null, tags: fields.tags || [], created: fields.created || fields.date || null, sourcePath: file.path, extra });
    }
    return { items, skipped, warnings };
  }};
}

export const sources = [recallSource()];
