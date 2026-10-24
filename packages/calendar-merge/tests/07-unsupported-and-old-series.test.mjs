// Plan test 7: unsupported rules, old series, and the safety limit.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, merge } from './helpers.mjs';
import { expandRuleDays, parseRRule } from '../src/rrule.mjs';
import { daysFromCivil, formatDate } from '../src/time.mjs';

const NOV = { from: '2026-11-01', to: '2026-11-30' };
const series = (rrule, extra = []) => cal(ev('UID:s@test.example', 'SUMMARY:Series', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT1H', `RRULE:${rrule}`, ...extra));

for (const [label, rrule] of [['FREQ=HOURLY', 'FREQ=HOURLY;COUNT=5'], ['BYWEEKNO', 'FREQ=YEARLY;BYWEEKNO=45'], ['COUNT=2000000', 'FREQ=DAILY;COUNT=2000000']]) {
  test(`${label} shows the first occurrence, marked, and adds a problem`, async () => {
    const result = await merge({ a: series(rrule) }, NOV);
    assert.equal(result.occurrences.length, 1);
    assert.equal(result.occurrences[0].start.local, '2026-11-02T09:00:00-05:00');
    assert.equal(result.occurrences[0].repeatNotSupported, true);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /^Source "a", line 4: repeat rule of "s@test\.example" not supported .*only its first occurrence is shown\.$/);
  });
}

test('RANGE=THISANDFUTURE shows the first occurrence, marked, and adds a problem', async () => {
  const text = cal(
    ev('UID:s@test.example', 'SUMMARY:Series', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY'),
    ev('UID:s@test.example', 'SUMMARY:Series (later)', 'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=America/New_York:20261116T090000', 'DTSTART;TZID=America/New_York:20261116T110000', 'DURATION:PT1H', 'SEQUENCE:1'),
  );
  const result = await merge({ a: text }, NOV);
  const first = result.occurrences.filter((o) => o.title === 'Series');
  assert.deepEqual(first.map((o) => [o.start.local, o.repeatNotSupported]), [['2026-11-02T09:00:00-05:00', true]]);
  assert.ok(result.problems.some((p) => p.includes('RANGE=THISANDFUTURE')));
});

test('a daily series with no end that began in 1990 shows every November 2026 day', async () => {
  const text = cal(ev('UID:old@test.example', 'SUMMARY:Old daily', 'DTSTART;TZID=America/New_York:19900101T080000', 'DURATION:PT15M', 'RRULE:FREQ=DAILY'));
  const result = await merge({ a: text }, NOV);
  assert.equal(result.occurrences.length, 30);
  assert.ok(result.occurrences.every((o) => o.start.local.slice(11, 16) === '08:00'));
});

test('a daily series from 2000 with COUNT=20000 shows every November 2026 day', async () => {
  const text = cal(ev('UID:count@test.example', 'SUMMARY:Counted', 'DTSTART;TZID=America/New_York:20000101T080000', 'DURATION:PT15M', 'RRULE:FREQ=DAILY;COUNT=20000'));
  const result = await merge({ a: text }, NOV);
  assert.equal(result.occurrences.length, 30);
  assert.deepEqual(result.problems, []);
});

test('a weekly series from 1990 with INTERVAL=3 lands on the right weeks', async () => {
  const text = cal(ev('UID:w3@test.example', 'SUMMARY:Every third week', 'DTSTART;TZID=America/New_York:19900101T080000', 'DURATION:PT15M', 'RRULE:FREQ=WEEKLY;INTERVAL=3'));
  const result = await merge({ a: text }, NOV);
  // 1990-01-01 plus multiples of 21 days.
  const expected = [];
  for (let day = daysFromCivil(1990, 1, 1); day <= daysFromCivil(2026, 11, 30); day += 21) if (day >= daysFromCivil(2026, 11, 1)) expected.push(formatDate(day));
  assert.deepEqual(expected, ['2026-11-09', '2026-11-30']);
  assert.deepEqual(result.occurrences.map((o) => o.start.local.slice(0, 10)), expected);
});

test('without COUNT, expansion takes no more steps than the range needs', () => {
  const { rule } = parseRRule('FREQ=DAILY');
  const stats = { steps: 0 };
  const window = { fromDay: daysFromCivil(2026, 11, 1), toDay: daysFromCivil(2026, 11, 30) };
  const days = expandRuleDays(rule, daysFromCivil(1990, 1, 1), window, undefined, stats);
  assert.equal(days.length, 30);
  assert.ok(stats.steps <= 31, `took ${stats.steps} steps`);
  const weekly = { steps: 0 };
  expandRuleDays(parseRRule('FREQ=WEEKLY;INTERVAL=3').rule, daysFromCivil(1990, 1, 1), window, undefined, weekly);
  assert.ok(weekly.steps <= 3, `took ${weekly.steps} steps`);
});

test('an RDATE list of 10,001 dates in the range shows 10,000 and adds a problem', async () => {
  const start = daysFromCivil(2026, 11, 1) * 86_400_000;
  const stamps = [];
  for (let i = 1; i <= 10_001; i += 1) {
    const ms = start + i * 60_000;
    const d = formatDate(Math.floor(ms / 86_400_000)).replaceAll('-', '');
    const minutes = Math.floor((ms % 86_400_000) / 60_000);
    stamps.push(`${d}T${String(Math.floor(minutes / 60)).padStart(2, '0')}${String(minutes % 60).padStart(2, '0')}00Z`);
  }
  const text = cal(ev('UID:many@test.example', 'SUMMARY:Many', 'DTSTART:20261101T000000Z', 'DURATION:PT1M', `RDATE:${stamps.join(',')}`));
  const result = await merge({ a: text }, { ...NOV, timeZone: 'UTC' });
  assert.equal(result.occurrences.length, 10_000);
  assert.equal(result.occurrences[0].start.utc, '2026-11-01T00:00:00Z');
  assert.deepEqual(result.problems, ['Source "a", line 4: "many@test.example" has more than 10000 occurrences in the range; only the first 10000 are shown.']);
});
