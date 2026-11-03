/**
 * Turn a checklist pasted from Notes into items a household list can store.
 * This file reads no files, no clock, and no network. The caller passes time.
 */

import { HouseholdLists } from '../../household-lists/src/index.mjs';

export const LIMITS = Object.freeze({
  bytes: 1_048_576,
  items: 2_000,
  sections: 100,
  itemCharacters: 500,
});

export const IMPORT_DEVICE_ID = 'notes-import';
export const IMPORT_TIME = 0;

export const EMPTY_NOTE = 'This note has no checklist items. Copy the note in Notes, then paste it as plain text.';

export const LONG_LINE = 'This line has more than 500 characters, so it was left out.';
export const EMPTY_ITEM = 'This line has no item text, so it was left out.';
export const NOT_AN_ITEM = 'This line is not a checklist item.';

export class NotesImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotesImportError';
  }
}

const fail = message => {
  throw new NotesImportError(message);
};

export function controlCharacterMessage(line) {
  return `Line ${line} has a control character, so nothing was written. Remove it and run again.`;
}

export function tooBigMessage() {
  return 'This note is larger than 1,048,576 bytes, so nothing was written. Shorten it and run again.';
}

export function tooManyItemsMessage() {
  return 'This note has more than 2,000 checklist items, so nothing was written. Split it into smaller notes and run again.';
}

export function tooManySectionsMessage() {
  return 'This note has more than 100 sections, so nothing was written. Split it into smaller notes and run again.';
}

export function repeatedMessage(text) {
  return `Repeated item "${text}". Kept as its own row.`;
}

/** The clock the command passes in. It returns a fixed time and reads nothing. */
export function fixedNow() {
  return IMPORT_TIME;
}

const MARKS = [
  { mark: '- [x]', checked: true },
  { mark: '- [X]', checked: true },
  { mark: '* [x]', checked: true },
  { mark: '* [X]', checked: true },
  { mark: '[x]', checked: true },
  { mark: '[X]', checked: true },
  { mark: '- [ ]', checked: false },
  { mark: '* [ ]', checked: false },
  { mark: '[ ]', checked: false },
  { mark: '☑', checked: true },
  { mark: '☒', checked: true },
  { mark: '✓', checked: true },
  { mark: '✔', checked: true },
  { mark: '●', checked: true },
  { mark: '☐', checked: false },
  { mark: '○', checked: false },
  { mark: '◦', checked: false },
  { mark: '•', checked: false },
].sort((a, b) => b.mark.length - a.mark.length);

// A bare hyphen, star, or en dash needs a space, so "-5" stays a plain line.
const BARE = /^([-*]|\u2013)[ \t]+(.*)$/u;
const NUMBERED = /^(\d{1,6})[.)][ \t]+(.*)$/u;
const NUMBERED_EMPTY = /^(\d{1,6})[.)][ \t]*$/u;

function characters(text) {
  return [...text].length;
}

function hasControl(text) {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === 0x09) continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  let number = 1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char !== '\n' && char !== '\r') continue;
    lines.push({ line: number, text: text.slice(start, i) });
    if (char === '\r' && text[i + 1] === '\n') i += 1;
    start = i + 1;
    number += 1;
  }
  if (start < text.length) lines.push({ line: number, text: text.slice(start) });
  return lines;
}

function classify(raw) {
  const body = raw.trim();
  if (!body) return { kind: 'blank' };
  for (const entry of MARKS) {
    if (body.startsWith(entry.mark)) {
      return { kind: 'item', checked: entry.checked, text: body.slice(entry.mark.length).trim() };
    }
  }
  const numbered = body.match(NUMBERED);
  if (numbered) return { kind: 'item', checked: false, text: numbered[2].trim() };
  if (NUMBERED_EMPTY.test(body)) return { kind: 'item', checked: false, text: '' };
  const bare = body.match(BARE);
  if (bare) return { kind: 'item', checked: false, text: bare[2].trim() };
  return { kind: 'plain', text: body };
}

function optionTitle(options) {
  if (options.title === undefined || options.title === null) return null;
  if (typeof options.title !== 'string') fail('The title must be text.');
  const title = options.title.trim();
  if (!title) return null;
  if (hasControl(title)) fail('The title has a control character, so nothing was written. Remove it and run again.');
  if (characters(title) > LIMITS.itemCharacters) {
    fail('The title is longer than 500 characters, so nothing was written. Shorten it and run again.');
  }
  return title;
}

function skip(skipped, line, text, reason) {
  skipped.push({ line, text, reason });
}

/**
 * Read one pasted checklist.
 * Returns `{ list, items, sections, skipped, warnings }`.
 * `list.title` is the list name. `list.titleFrom` is `note`, `option`, or `fallback`.
 */
export function parseChecklist(text, options = {}) {
  if (typeof text !== 'string') fail('The note must be text.');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) fail('Options must be an object.');
  if (Buffer.byteLength(text, 'utf8') > LIMITS.bytes) fail(tooBigMessage());

  const chosenTitle = optionTitle(options);
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const content = [];
  for (const entry of splitLines(source)) {
    if (hasControl(entry.text)) fail(controlCharacterMessage(entry.line));
    if (entry.text.trim() === '') continue;
    content.push(entry);
  }

  const items = [];
  const sections = [];
  const skipped = [];
  const warnings = [];
  const seen = new Set();
  let start = 0;
  let title = '';
  let titleFrom = 'fallback';

  if (content.length > 0 && classify(content[0].text).kind === 'plain') {
    const candidate = classify(content[0].text).text;
    start = 1;
    if (characters(candidate) > LIMITS.itemCharacters) skip(skipped, content[0].line, candidate, LONG_LINE);
    else {
      title = candidate;
      titleFrom = 'note';
    }
  }
  if (chosenTitle) {
    title = chosenTitle;
    titleFrom = 'option';
  }
  if (!title) {
    title = 'Checklist';
    titleFrom = 'fallback';
  }

  let section = '';
  for (let index = start; index < content.length; index += 1) {
    const entry = content[index];
    const found = classify(entry.text);
    if (found.kind === 'item') {
      if (!found.text) {
        skip(skipped, entry.line, entry.text.trim(), EMPTY_ITEM);
        continue;
      }
      if (characters(found.text) > LIMITS.itemCharacters) {
        skip(skipped, entry.line, found.text, LONG_LINE);
        continue;
      }
      if (items.length >= LIMITS.items) fail(tooManyItemsMessage());
      if (seen.has(found.text)) {
        warnings.push({ line: entry.line, text: found.text, message: repeatedMessage(found.text) });
      }
      seen.add(found.text);
      items.push({ text: found.text, checked: found.checked, section, line: entry.line });
      continue;
    }

    const next = content[index + 1];
    const nextIsItem = next ? classify(next.text).kind === 'item' : false;
    if (!nextIsItem) {
      const reason = characters(found.text) > LIMITS.itemCharacters ? LONG_LINE : NOT_AN_ITEM;
      skip(skipped, entry.line, found.text, reason);
      continue;
    }
    if (characters(found.text) > LIMITS.itemCharacters) {
      skip(skipped, entry.line, found.text, LONG_LINE);
      continue;
    }
    if (sections.length >= LIMITS.sections) fail(tooManySectionsMessage());
    sections.push({ name: found.text, line: entry.line });
    section = found.text;
  }

  return {
    list: { title, titleFrom },
    items,
    sections,
    skipped,
    warnings,
  };
}

/** Build the JSON string the household lists engine would save. */
export function toListFile(parsed, { deviceId, now } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.list || typeof parsed.list.title !== 'string' || !Array.isArray(parsed.items)) {
    fail('There is no checklist to save.');
  }
  if (typeof deviceId !== 'string' || deviceId.trim() === '') fail('A device id is required.');
  if (typeof now !== 'function') fail('A clock function is required.');

  const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const engine = new HouseholdLists({ deviceId, now });
  const id = engine.createList(parsed.list.title);
  if (sections.length > 0) engine.setSectionsEnabled(id, true);
  for (const item of parsed.items) {
    if (!item || typeof item.text !== 'string') fail('There is no checklist to save.');
    const fields = { text: item.text };
    if (sections.length > 0) fields.section = typeof item.section === 'string' ? item.section : '';
    const itemId = engine.addItem(id, fields);
    if (item.checked === true) engine.setChecked(id, itemId, true);
  }
  return engine.save(id);
}

/** The preview the command prints. Checked rows are marked `[x]`. */
export function formatReport(parsed) {
  const lines = [`Title: ${parsed.list.title}`];
  let current = null;
  for (const item of parsed.items) {
    if (item.section !== current) {
      lines.push('');
      if (item.section) lines.push(item.section);
      current = item.section;
    }
    lines.push(`${item.checked ? '[x]' : '[ ]'} ${item.text}`);
  }
  if (parsed.skipped.length > 0) {
    lines.push('', 'Skipped');
    for (const skipLine of parsed.skipped) {
      lines.push(`Line ${skipLine.line}: ${skipLine.reason} ${skipLine.text}`);
    }
  }
  if (parsed.warnings.length > 0) {
    lines.push('', 'Warnings');
    for (const warning of parsed.warnings) lines.push(`Line ${warning.line}: ${warning.message}`);
  }
  lines.push('');
  return `${lines.join('\n')}`;
}
