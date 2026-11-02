// Canonical JSON for signatures and the ledger chain. Objects are plain,
// keys are sorted, and the only numbers allowed are safe integers (revisions
// and ledger sequence numbers). Money never goes through this as a number.

import { createHash, timingSafeEqual } from 'node:crypto';

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function canonicalJson(value) {
  return JSON.stringify(order(value));
}

function order(value) {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('canonical JSON only allows safe integers');
    return value;
  }
  if (Array.isArray(value)) return value.map(order);
  if (!isPlainObject(value)) throw new TypeError('canonical JSON only allows plain values');
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = order(value[key]);
  return out;
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sameText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
