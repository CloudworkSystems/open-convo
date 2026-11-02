// The saved list is JSON with version 1. One bad field refuses the whole
// text. Writing sorts by id and uses one key order, so the same reminders
// always produce the same text.

import { fail } from './errors.mjs';
import { byId, readList } from './reminder.mjs';

function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseSaved(text) {
  if (typeof text !== 'string') fail('file', 'saved text must be text');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('file', 'saved text is not JSON');
  }
  if (!isPlain(value)) fail('version', 'saved text must be an object');
  for (const key of Object.keys(value)) {
    if (key !== 'version' && key !== 'reminders') fail(key, `${key} is not a saved field`);
  }
  if (!Object.hasOwn(value, 'version')) fail('version', 'version is missing');
  if (value.version !== 1) fail('version', 'version must be 1');
  if (!Object.hasOwn(value, 'reminders')) fail('reminders', 'reminders is missing');
  const list = readList(value.reminders);
  list.sort(byId);
  return list;
}

export function formatSaved(reminders) {
  const list = readList(reminders);
  list.sort(byId);
  return `${JSON.stringify({ version: 1, reminders: list }, null, 2)}\n`;
}
