// Review P2-1: a hostile or huge calendar can't stall a call. Each case
// finishes within the work budget and reports a problem instead.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, merge } from './helpers.mjs';
import { LIMITS } from '../src/index.mjs';
import { formatDate } from '../src/time.mjs';

const NOV = { from: '2026-11-01', to: '2026-11-07' };
const elapsed = async (fn) => {
  const start = process.hrtime.bigint();
  const result = await fn();
  return { result, ms: Number(process.hrtime.bigint() - start) / 1e6 };
};

// 164 bytes: a COUNT rule from year 1 that never produces a date.
const hostile = (uid) => ev(`UID:${uid}`, 'SUMMARY:Never', 'DTSTART:00010101T090000Z', 'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30;COUNT=5');

test('a hostile COUNT rule stops at the series budget and reports a problem', async () => {
  const { result, ms } = await elapsed(() => merge({ a: cal(hostile('h1@test.example')) }, NOV));
  assert.deepEqual(result.occurrences, []);
  assert.deepEqual(result.problems, [`Source "a", line 4: "h1@test.example" needs too much work to expand (more than ${LIMITS.seriesSteps} repeat periods to reach the range); only its first occurrence is shown.`]);
  assert.ok(ms < 5000, `took ${ms} ms`);
});

test('many hostile rules share the call budget, and later series fall back at once', async () => {
  const count = Math.ceil(LIMITS.callSteps / LIMITS.seriesSteps) + 5;
  const text = cal(...Array.from({ length: count }, (_, i) => hostile(`h${String(i).padStart(2, '0')}@test.example`)));
  const { result, ms } = await elapsed(() => merge({ a: text }, NOV));
  assert.equal(result.problems.length, count);
  assert.ok(result.problems.every((p) => p.includes('needs too much work to expand')));
  assert.ok(ms < 10000, `took ${ms} ms`);
});

test('RDATE and EXDATE values outside the range are skipped before any time zone work', async () => {
  // 40,000 dates in 2000-2020 with a TZID, plus one inside the range.
  const values = [];
  for (let i = 0; i < 40_000; i += 1) values.push(`${formatDate(10_957 + (i % 7_300)).replaceAll('-', '')}T${String(i % 24).padStart(2, '0')}0000`);
  const text = cal(ev('UID:old-list@test.example', 'SUMMARY:Old list', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT1H',
    `RDATE;TZID=America/New_York:${values.join(',')}`, `EXDATE;TZID=America/New_York:${values.slice(0, 5_000).join(',')}`,
    'RDATE;TZID=America/New_York:20261104T090000'));
  const { result, ms } = await elapsed(() => merge({ a: text }, NOV));
  assert.deepEqual(result.occurrences.map((o) => o.start.local), ['2026-11-02T09:00:00-05:00', '2026-11-04T09:00:00-05:00']);
  assert.deepEqual(result.problems, []);
  assert.ok(ms < 5000, `took ${ms} ms`);
});

test('a big out-of-range RDATE list over the series limit shows the first occurrence and reports a problem', async () => {
  const values = [];
  for (let i = 0; i <= LIMITS.seriesValues; i += 1) values.push(`${formatDate(10_957 + (i % 7_300)).replaceAll('-', '')}T090000`);
  const text = cal(ev('UID:huge-list@test.example', 'SUMMARY:Huge list', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT1H', `RDATE;TZID=America/New_York:${values.join(',')}`));
  const { result, ms } = await elapsed(() => merge({ a: text }, NOV));
  assert.deepEqual(result.occurrences.map((o) => [o.start.local, o.repeatNotSupported]), [['2026-11-02T09:00:00-05:00', true]]);
  assert.deepEqual(result.problems, [`Source "a", line 4: "huge-list@test.example" needs too much work to expand (more than ${LIMITS.seriesValues} RDATE and EXDATE values); only its first occurrence is shown.`]);
  assert.ok(ms < 5000, `took ${ms} ms`);
});
