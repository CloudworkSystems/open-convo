import { createHash } from 'node:crypto';

import { fail } from './errors.mjs';

// Sorted keys, no spaces. Arrays keep their order. This is the only form
// the entry hash is taken over, so two machines hash the same entry alike.
export function canonicalJson(value) {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return JSON.stringify(value);
  if (kind === 'number') {
    if (!Number.isFinite(value)) fail('A ledger value is not a finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (kind !== 'object') fail('A ledger value cannot be stored.');
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function hashEntry(entry) {
  const body = {};
  for (const key of Object.keys(entry)) {
    if (key === 'entryHash') continue;
    body[key] = entry[key];
  }
  return sha256Hex(canonicalJson(body));
}
