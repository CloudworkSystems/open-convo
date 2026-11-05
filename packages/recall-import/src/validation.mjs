export function optionObject(value, label, allowed) {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label}: expected an options object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}.${key}: unknown option; accepted options are ${allowed.join(', ')}.`);
}

export function normalizeTime(value, label = 'importedAt') {
  const message = `${label}: expected a real ISO 8601 timestamp YYYY-MM-DDTHH:mm:ss[.SSS]Z or an explicit ±HH:mm UTC offset (one to three fractional digits).`;
  if (typeof value !== 'string') throw new Error(message);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$(?![\s\S])/.exec(value);
  if (!match) throw new Error(message);
  const [, y, mo, d, h, mi, s, , zone] = match;
  const year = +y, month = +mo, day = +d;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || +h > 23 || +mi > 59 || +s > 59 || zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) throw new Error(message);
  // Explicit input only: this conversion never reads the current clock.
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(message);
  const normalized = new Date(milliseconds).toISOString();
  if (!/^\d{4}-/.test(normalized) || normalized.startsWith('0000-')) throw new Error(message);
  return normalized;
}

export function checkHashKey(hashKey) {
  if (hashKey === undefined) return;
  if (typeof hashKey !== 'function') throw new Error('hashKey: expected a deterministic function returning 64 hexadecimal characters.');
  const first = hashKey('validation-probe'), second = hashKey('validation-probe');
  if (typeof first !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/i.test(first) || first !== second) throw new Error('hashKey: expected a deterministic function returning 64 hexadecimal characters.');
}
