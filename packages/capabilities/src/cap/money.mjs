// Decimal money as text, summed in whole micro-units (millionths) with
// BigInt. Nothing in this file turns an amount into a JavaScript number.

import { REASONS } from './reasons.mjs';
import { isPlainObject, own } from './json.mjs';

const AMOUNT = /^(0|[1-9]\d{0,8})(\.\d{1,6})?$/;
const RATE = /^(0|[1-9]\d{0,8})(\.\d{1,12})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const SCALE = 6;
const MICRO = 10n ** BigInt(SCALE);
// The largest amount the ledger format can store and read back: nine digits
// and six decimal places. A larger figure is not written, because the next
// read would treat the file as edited.
export const MAX_AMOUNT_MICROS = (10n ** 9n - 1n) * MICRO + (MICRO - 1n);
const RATE_SCALE = 12;
const RATE_MICRO = 10n ** BigInt(RATE_SCALE);
const MARGIN_MICRO = MICRO;

let currencies;

export function isCurrency(code) {
  if (!currencies) currencies = new Set(Intl.supportedValuesOf('currency'));
  return typeof code === 'string' && CURRENCY.test(code) && currencies.has(code);
}

/** @returns {bigint | null} */
export function parseDecimal(amount, { rate = false } = {}) {
  const pattern = rate ? RATE : AMOUNT;
  if (typeof amount !== 'string' || !pattern.test(amount)) return null;
  const [whole, frac = ''] = amount.split('.');
  const scale = rate ? RATE_SCALE : SCALE;
  const digits = frac.padEnd(scale, '0');
  return BigInt(whole) * (10n ** BigInt(scale)) + BigInt(digits);
}

export function formatMicros(micros) {
  const whole = micros / MICRO;
  let frac = (micros % MICRO).toString().padStart(SCALE, '0');
  frac = frac.replace(/0+$/, '');
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}

export function parseMoney(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== 2 || !own(value, 'amount') || !own(value, 'currency')) {
    return { ok: false, reason: REASONS.badAmount };
  }
  const micros = parseDecimal(value.amount);
  if (micros === null || !isCurrency(value.currency)) return { ok: false, reason: REASONS.badAmount };
  return { ok: true, amount: value.amount, currency: value.currency, micros };
}

export function moneyFromMicros(currency, micros) {
  return { amount: formatMicros(micros), currency };
}

/** The largest amount the ledger can store, when `micros` does not fit. */
export function clampAmountMicros(micros) {
  if (micros > MAX_AMOUNT_MICROS) return MAX_AMOUNT_MICROS;
  return micros;
}

/**
 * Convert a foreign amount into cap currency.
 * `rate` is cap-currency units for one unit of the foreign currency.
 * `margin` is a fraction added on top (0.02 means two percent).
 * The result is rounded up to the next micro-unit.
 */
export function convertMicros(amountMicros, rateText, marginText) {
  const rate = parseDecimal(rateText, { rate: true });
  const margin = parseDecimal(marginText);
  if (rate === null || rate <= 0n || margin === null) return null;
  const product = amountMicros * rate * (MARGIN_MICRO + margin);
  const divisor = RATE_MICRO * MARGIN_MICRO;
  return ceilDiv(product, divisor);
}

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}
