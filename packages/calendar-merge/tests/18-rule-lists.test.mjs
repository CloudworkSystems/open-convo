// Review P1 on PR #130: BYxxx lists are deduplicated and capped when read,
// their lookups are built once per rule, and each repeat period is charged
// for the work it really takes. These tests count work (steps and checks),
// never time, so slow machines don't flake.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, merge } from './helpers.mjs';
import { titleTimeChecksForTests } from '../src/engine.mjs';
import { LIMITS } from '../src/index.mjs';
import { MAX_DISTINCT, WorkLimit, expandRuleDays, parseRRule } from '../src/rrule.mjs';
import { daysFromCivil } from '../src/time.mjs';

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
// About 200 KB: "1" written 100,000 times.
const DUPLICATE_ONES = Array(100_000).fill('1').join(',');

test('a 200 KB list of one repeated BYMONTHDAY reads as BYMONTHDAY=1', async () => {
  assert.ok(DUPLICATE_ONES.length >= 199_999);
  assert.deepEqual(parseRRule(`FREQ=DAILY;BYMONTHDAY=${DUPLICATE_ONES}`).rule.bymonthday, [1]);
  const query = { from: '2026-01-01', to: '2027-02-04' }; // 400 dates
  const series = (rrule) => cal(ev('UID:first@test.example', 'SUMMARY:First of the month', 'DTSTART;TZID=America/New_York:20250101T090000', 'DURATION:PT1H', `RRULE:${rrule}`));
  const hostile = await merge({ a: series(`FREQ=DAILY;BYMONTHDAY=${DUPLICATE_ONES}`) }, query);
  const plain = await merge({ a: series('FREQ=DAILY;BYMONTHDAY=1') }, query);
  assert.deepEqual(hostile, plain);
  assert.equal(plain.occurrences.length, 14);
  assert.deepEqual(plain.problems, []);
});

test('the duplicate list costs exactly the work of BYMONTHDAY=1', () => {
  const start = daysFromCivil(2025, 1, 1);
  const window = { fromDay: daysFromCivil(2026, 1, 1), toDay: daysFromCivil(2027, 2, 4) };
  const hostile = { steps: 0 };
  const plain = { steps: 0 };
  const a = expandRuleDays(parseRRule(`FREQ=DAILY;BYMONTHDAY=${DUPLICATE_ONES}`).rule, start, window, undefined, hostile);
  const b = expandRuleDays(parseRRule('FREQ=DAILY;BYMONTHDAY=1').rule, start, window, undefined, plain);
  assert.deepEqual(a, b);
  assert.equal(hostile.steps, plain.steps);
  assert.ok(plain.steps <= 401, `took ${plain.steps} steps`); // one per day
});

test('every BY list holds at most its natural number of distinct values', () => {
  const repeat = (values) => Array(50).fill(values.join(',')).join(',');
  const monthdays = [...range(1, 31), ...range(1, 31).map((n) => -n)];
  const setpos = [...range(1, 366), ...range(1, 366).map((n) => -n)];
  const numbered = [...range(1, 53), ...range(1, 53).map((n) => -n)];
  const bydays = [...WEEKDAYS, ...numbered.flatMap((n) => WEEKDAYS.map((wd) => `${n}${wd}`))];
  // "+1MO" and "01MO" are the same entry as "1MO".
  const spelledAgain = [...range(1, 9).map((n) => `+${n}MO`), ...range(1, 9).map((n) => `0${n}TU`)];
  const { rule } = parseRRule(`FREQ=YEARLY;BYMONTHDAY=${repeat(monthdays)};BYMONTH=${repeat(range(1, 12))};BYDAY=${repeat([...bydays, ...spelledAgain])};BYSETPOS=${repeat(setpos)}`);
  assert.equal(rule.bymonthday.length, MAX_DISTINCT.BYMONTHDAY);
  assert.equal(rule.bymonth.length, MAX_DISTINCT.BYMONTH);
  assert.equal(rule.byday.length, MAX_DISTINCT.BYDAY);
  assert.equal(rule.bysetpos.length, MAX_DISTINCT.BYSETPOS);
  assert.deepEqual(MAX_DISTINCT, { BYMONTHDAY: 62, BYMONTH: 12, BYSETPOS: 732, BYDAY: 749 });
});

test('a period is charged for the BY values and dates it looks at', () => {
  const start = daysFromCivil(2026, 1, 1);
  const window = { fromDay: start, toDay: daysFromCivil(2026, 12, 31) };
  const plain = { steps: 0 };
  expandRuleDays(parseRRule('FREQ=MONTHLY').rule, start, window, undefined, plain);
  assert.equal(plain.steps, 12); // one per month
  const allDays = [...range(1, 31), ...range(1, 31).map((n) => -n)].join(',');
  const listed = { steps: 0 };
  expandRuleDays(parseRRule(`FREQ=MONTHLY;BYMONTHDAY=${allDays}`).rule, start, window, undefined, listed);
  assert.equal(listed.steps, 12 * 62); // 62 values in each of 12 months
  // The same 12 months fit an allowance of 12 plain periods, but not with
  // the 62-value list.
  assert.doesNotThrow(() => expandRuleDays(parseRRule('FREQ=MONTHLY').rule, start, window, undefined, { steps: 0 }, 12));
  assert.throws(() => expandRuleDays(parseRRule(`FREQ=MONTHLY;BYMONTHDAY=${allDays}`).rule, start, window, undefined, { steps: 0 }, 12 * 62 - 1), WorkLimit);
});

test('a COUNT rule with long lists runs into the series budget instead of stalling', async () => {
  // Year 1 to 9999 is under 10,000 yearly periods, under the series budget
  // when each costs one step. Each period here looks at about 800 values and
  // never makes a date, so its real cost reaches the budget first.
  const bydays = [...WEEKDAYS, ...range(1, 53).flatMap((n) => WEEKDAYS.flatMap((wd) => [`${n}${wd}`, `-${n}${wd}`]))].join(',');
  const result = await merge({ a: cal(ev('UID:lists@test.example', 'SUMMARY:Never', 'DTSTART:00010101T090000Z', `RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30,31;BYDAY=${bydays};COUNT=5`)) }, { from: '2026-11-01', to: '2026-11-07' });
  assert.deepEqual(result.occurrences, []);
  assert.deepEqual(result.problems, [`Source "a", line 4: "lists@test.example" needs too much work to expand (more than ${LIMITS.seriesSteps} repeat steps to reach the range); only its first occurrence is shown.`]);
});

test('many look-alikes from one source are matched with linear work', async () => {
  const count = 3000;
  const events = Array.from({ length: count }, (_, i) => ev(`UID:same-${String(i).padStart(4, '0')}@test.example`, 'SUMMARY:Same', 'DTSTART:20261102T140000Z', 'DURATION:PT1H'));
  const before = titleTimeChecksForTests();
  const result = await merge({ a: cal(...events) }, { from: '2026-11-02', to: '2026-11-02' });
  const checks = titleTimeChecksForTests() - before;
  assert.equal(result.occurrences.length, count); // one source: never merged
  assert.ok(checks <= count, `${checks} group checks for ${count} occurrences`);
});

test('look-alikes from several sources still pair up as before', async () => {
  const one = (uid) => ev(`UID:${uid}`, 'SUMMARY:Lunch', 'DTSTART:20261102T170000Z', 'DURATION:PT1H');
  const result = await merge({ a: cal(one('c@test.example'), one('d@test.example')), b: cal(one('c@test.example'), one('b@test.example')), c: cal(one('a@test.example')) }, { from: '2026-11-02', to: '2026-11-02' });
  // In order c (a, b), d (a), b (b), a (c): c opens a group, d overlaps it and
  // opens a second, b joins d's (the first it doesn't overlap), a joins c's.
  assert.deepEqual(result.occurrences.map((o) => [o.key, o.sources.map((s) => s.id).join(',')]), [
    ['a@test.example/2026-11-02T17:00:00Z + c@test.example/2026-11-02T17:00:00Z', 'a,b,c'],
    ['b@test.example/2026-11-02T17:00:00Z + d@test.example/2026-11-02T17:00:00Z', 'a,b'],
  ]);
});
