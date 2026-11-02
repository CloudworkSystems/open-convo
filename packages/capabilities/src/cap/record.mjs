// Signed spending caps. The signature is ECDSA P-256 with SHA-256 over the
// canonical JSON, DER-encoded (X9.62). That is the shape the Mac Secure
// Enclave produces for ecdsaSignatureMessageX962SHA256, so part 4 can use
// the same bytes. This file checks signatures; it does not hold a key.

import { createPublicKey, verify } from 'node:crypto';
import { canonicalJson, isPlainObject, own, sameText, sha256Hex } from './json.mjs';
import { convertMicros, isCurrency, moneyFromMicros, parseDecimal, parseMoney } from './money.mjs';
import { REASONS } from './reasons.mjs';
import { describeState } from './state.mjs';
import { DAY_MS, canonicalZone, instantText, rateAge } from './time.mjs';

const LEVELS = ['perRun', 'monthlyByCapability', 'monthlyAll'];
const CAP_FIELDS = ['revision', 'currency', 'timeZone', 'perRun', 'monthlyByCapability', 'monthlyAll', 'paused', 'conversion'];

export function signingBytes(record) {
  const doc = capDocument(record);
  return doc.ok ? doc.bytes : null;
}

/** The record is well formed and the signature matches. It does not check the protected state. */
export function signedCap(record, signature, publicKey) {
  const doc = capDocument(record);
  if (!doc.ok) return { ok: false, reason: REASONS.capDoesNotCheck };
  const sig = signatureBytes(signature);
  if (!sig.present) return { ok: false, reason: REASONS.capUnsigned };
  if (!sig.bytes || !signatureMatches(doc.bytes, sig.bytes, publicKey)) return { ok: false, reason: REASONS.capDoesNotCheck };
  return { ok: true, revision: doc.value.revision, hash: doc.hash, cap: doc.value };
}

export function verifyCap(record, signature, publicKey, protectedState) {
  const state = describeState(protectedState);
  if (state.broken) return zero(REASONS.protectedBroken);
  if (record == null) return zero(state.capRevision === 0 ? REASONS.setCapFirst : REASONS.capDoesNotCheck);
  const doc = capDocument(record);
  if (!doc.ok) return zero(REASONS.capDoesNotCheck);
  const sig = signatureBytes(signature);
  if (!sig.present) return zero(REASONS.capUnsigned);
  if (!sig.bytes || !signatureMatches(doc.bytes, sig.bytes, publicKey)) return zero(REASONS.capDoesNotCheck);
  if (state.capRevision === 0 || state.capHash === null) return zero(REASONS.setCapFirst);
  if (doc.value.revision !== state.capRevision || !sameText(doc.hash, state.capHash)) return zero(REASONS.capOlder);
  if (state.tighteningBroken) return zero(REASONS.tighteningBroken);
  return applyTightening(doc, state);
}

export function acceptCap(store, record, signature, publicKey) {
  const state = store.read();
  if (state.broken) return { ok: false, reason: REASONS.protectedBroken };
  const signed = signedCap(record, signature, publicKey);
  if (!signed.ok) return signed;
  if (signed.revision <= state.capRevision) return { ok: false, reason: REASONS.notNewer };
  const next = {
    capRevision: signed.revision,
    capHash: signed.hash,
    tightening: 'none',
    ledgerHead: state.ledgerHead,
    ledgerCount: state.ledgerCount,
  };
  if (!store.write(next, state.core)) return { ok: false, reason: REASONS.protectedBroken };
  return { ok: true, cap: verifyCap(record, signature, publicKey, store.read()) };
}

export function tighten(store, change, record, signature, publicKey) {
  const state = store.read();
  const cap = verifyCap(record, signature, publicKey, state);
  if (!cap.ok) return { ok: false, reason: cap.reason };
  const nextLevels = lower(cap, change);
  if (!nextLevels.ok) return nextLevels;
  const next = {
    ...state.core,
    tightening: {
      perRun: nextLevels.perRun,
      monthlyByCapability: nextLevels.monthlyByCapability,
      monthlyAll: nextLevels.monthlyAll,
      paused: nextLevels.paused,
    },
  };
  if (!store.write(next, state.core)) return { ok: false, reason: REASONS.protectedBroken };
  return { ok: true, cap: verifyCap(record, signature, publicKey, store.read()) };
}

export function convertQuote({ quote, record, signature, publicKey, protectedState, now, rate }) {
  // `rate` is never read. A caller or a model cannot pass a friendlier rate
  // than the one the person signed.
  void rate;
  const cap = verifyCap(record, signature, publicKey, protectedState);
  if (!cap.ok) return { ok: false, reason: cap.reason, rateIgnored: rate !== undefined };
  if (cap.paused) return { ok: false, reason: REASONS.paused, rateIgnored: rate !== undefined };
  const money = parseMoney(quote);
  if (!money.ok) return { ok: false, reason: REASONS.badAmount, rateIgnored: rate !== undefined };
  if (!instantText(now)) return { ok: false, reason: REASONS.badNow, rateIgnored: rate !== undefined };
  const shownQuote = moneyFromMicros(money.currency, money.micros);
  if (money.currency === cap.currency) {
    return {
      ok: true,
      quote: shownQuote,
      capAmount: moneyFromMicros(cap.currency, money.micros),
      rateIgnored: rate !== undefined,
    };
  }
  const conversion = cap.conversion;
  if (!conversion || conversion.currency !== money.currency) {
    return { ok: false, reason: REASONS.currencyOff, rateIgnored: rate !== undefined };
  }
  const age = rateAge(conversion.asOf, now);
  if (age === null || age < 0n) return { ok: false, reason: REASONS.rateBad, rateIgnored: rate !== undefined };
  if (age > DAY_MS) return { ok: false, reason: REASONS.rateStale, rateIgnored: rate !== undefined };
  const micros = convertMicros(money.micros, conversion.rate, conversion.margin);
  if (micros === null) return { ok: false, reason: REASONS.rateBad, rateIgnored: rate !== undefined };
  return {
    ok: true,
    quote: shownQuote,
    capAmount: moneyFromMicros(cap.currency, micros),
    rate: conversion.rate,
    margin: conversion.margin,
    asOf: conversion.asOf,
    rateIgnored: rate !== undefined,
  };
}

function capDocument(record) {
  if (!isPlainObject(record)) return { ok: false, reason: REASONS.capDoesNotCheck };
  const keys = Object.keys(record);
  if (keys.length !== CAP_FIELDS.length || CAP_FIELDS.some((key) => !own(record, key))) {
    return { ok: false, reason: REASONS.capDoesNotCheck };
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) return { ok: false, reason: REASONS.capDoesNotCheck };
  if (!isCurrency(record.currency)) return { ok: false, reason: REASONS.capDoesNotCheck };
  const timeZone = canonicalZone(record.timeZone);
  if (!timeZone) return { ok: false, reason: REASONS.capDoesNotCheck };
  if (typeof record.paused !== 'boolean') return { ok: false, reason: REASONS.capDoesNotCheck };
  const levels = {};
  for (const level of LEVELS) {
    const money = parseMoney(record[level]);
    if (!money.ok || money.currency !== record.currency) return { ok: false, reason: REASONS.capDoesNotCheck };
    levels[level] = { amount: money.amount, currency: money.currency };
  }
  let conversion = null;
  if (record.conversion !== null) {
    const parsed = conversionDocument(record.conversion, record.currency);
    if (!parsed.ok) return parsed;
    conversion = parsed.value;
  }
  const value = {
    revision: record.revision,
    currency: record.currency,
    timeZone,
    perRun: levels.perRun,
    monthlyByCapability: levels.monthlyByCapability,
    monthlyAll: levels.monthlyAll,
    paused: record.paused,
    conversion,
  };
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  if (bytes.length > 8192) return { ok: false, reason: REASONS.capDoesNotCheck };
  return { ok: true, value, bytes, hash: sha256Hex(bytes) };
}

function conversionDocument(value, capCurrency) {
  if (!isPlainObject(value)) return { ok: false, reason: REASONS.capDoesNotCheck };
  const fields = ['currency', 'rate', 'margin', 'asOf'];
  if (Object.keys(value).length !== fields.length || fields.some((key) => !own(value, key))) {
    return { ok: false, reason: REASONS.capDoesNotCheck };
  }
  if (!isCurrency(value.currency) || value.currency === capCurrency) return { ok: false, reason: REASONS.capDoesNotCheck };
  const rate = parseDecimal(value.rate, { rate: true });
  const margin = parseDecimal(value.margin);
  if (rate === null || rate <= 0n || margin === null) return { ok: false, reason: REASONS.capDoesNotCheck };
  const asOf = instantText(value.asOf);
  if (!asOf) return { ok: false, reason: REASONS.capDoesNotCheck };
  return { ok: true, value: { currency: value.currency, rate: value.rate, margin: value.margin, asOf } };
}

function applyTightening(doc, state) {
  const signed = viewFrom(doc.value, doc.value.paused, doc.value);
  if (state.tightening === 'none') return signed;
  if (state.tighteningBroken || state.tightening == null) return zero(REASONS.tighteningBroken);
  const tightening = state.tightening;
  const levels = {};
  for (const level of LEVELS) {
    const money = parseMoney(tightening[level]);
    const ceiling = parseDecimal(doc.value[level].amount);
    if (!money.ok || money.currency !== doc.value.currency || ceiling === null || money.micros > ceiling) {
      return zero(REASONS.tighteningBroken);
    }
    levels[level] = moneyFromMicros(doc.value.currency, money.micros);
  }
  if (doc.value.paused && tightening.paused !== true) return zero(REASONS.tighteningBroken);
  if (typeof tightening.paused !== 'boolean') return zero(REASONS.tighteningBroken);
  return viewFrom(doc.value, doc.value.paused || tightening.paused, levels);
}

function viewFrom(value, paused, levels) {
  const currency = value.currency;
  return {
    ok: true,
    zero: false,
    paused,
    reason: null,
    revision: value.revision,
    currency,
    timeZone: value.timeZone,
    perRun: moneyFromMicros(currency, parseDecimal(levels.perRun.amount)),
    monthlyByCapability: moneyFromMicros(currency, parseDecimal(levels.monthlyByCapability.amount)),
    monthlyAll: moneyFromMicros(currency, parseDecimal(levels.monthlyAll.amount)),
    conversion: value.conversion,
  };
}

function lower(cap, change) {
  if (!isPlainObject(change)) return { ok: false, reason: REASONS.badChange };
  const allowed = new Set(['perRun', 'monthlyByCapability', 'monthlyAll', 'paused']);
  for (const key of Object.keys(change)) {
    if (!allowed.has(key)) return { ok: false, reason: REASONS.badChange };
  }
  const next = {
    perRun: cap.perRun,
    monthlyByCapability: cap.monthlyByCapability,
    monthlyAll: cap.monthlyAll,
    paused: cap.paused,
  };
  let changed = false;
  for (const level of LEVELS) {
    if (!own(change, level)) continue;
    const money = parseMoney(change[level]);
    if (!money.ok) return { ok: false, reason: REASONS.badAmount };
    if (money.currency !== cap.currency) return { ok: false, reason: REASONS.currencyOff };
    const current = parseDecimal(cap[level].amount);
    if (money.micros > current) return { ok: false, reason: REASONS.tightenRaise };
    if (money.micros < current) changed = true;
    next[level] = moneyFromMicros(cap.currency, money.micros);
  }
  if (own(change, 'paused')) {
    if (change.paused !== true) return { ok: false, reason: REASONS.tightenUnpause };
    if (!cap.paused) {
      changed = true;
      next.paused = true;
    }
  }
  if (!changed) return { ok: false, reason: REASONS.tightenNoChange };
  return { ok: true, ...next };
}

function zero(reason) {
  const amount = { amount: '0', currency: null };
  return {
    ok: false,
    zero: true,
    paused: false,
    reason,
    revision: null,
    currency: null,
    timeZone: null,
    perRun: { ...amount },
    monthlyByCapability: { ...amount },
    monthlyAll: { ...amount },
    conversion: null,
  };
}

function signatureBytes(signature) {
  if (signature == null || signature === '') return { present: false };
  if (Buffer.isBuffer(signature) || signature instanceof Uint8Array) {
    const bytes = Buffer.from(signature);
    return bytes.length === 0 ? { present: false } : { present: true, bytes };
  }
  if (typeof signature === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(signature) && signature.length <= 400) {
    const bytes = Buffer.from(signature, 'base64');
    return bytes.length === 0 ? { present: false } : { present: true, bytes };
  }
  return { present: true, bytes: null };
}

function signatureMatches(bytes, signature, publicKey) {
  try {
    const key = typeof publicKey === 'string' || Buffer.isBuffer(publicKey) ? createPublicKey(publicKey) : publicKey;
    if (key?.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
    if (signature.length > 200) return false;
    return verify('sha256', bytes, { key, dsaEncoding: 'der' }, signature);
  } catch {
    return false;
  }
}
