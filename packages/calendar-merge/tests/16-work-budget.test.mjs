// Review P2-1, P2-A and P2-C: a hostile or huge calendar can't stall a call,
// and can only use up its own source's share of the work. These tests count
// problems and occurrences rather than time, so slow machines don't flake.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, merge } from './helpers.mjs';
import { LIMITS } from '../src/index.mjs';
import { formatDate } from '../src/time.mjs';

const NOV = { from: '2026-11-01', to: '2026-11-07' };

// 164 bytes: a COUNT rule from year 1 that never produces a date.
const hostile = (uid) => ev(`UID:${uid}`, 'SUMMARY:Never', 'DTSTART:00010101T090000Z', 'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30;COUNT=5');

test('a hostile COUNT rule stops at the series budget and reports a problem', async () => {
  const result = await merge({ a: cal(hostile('h1@test.example')) }, NOV);
  assert.deepEqual(result.occurrences, []);
  assert.deepEqual(result.problems, [`Source "a", line 4: "h1@test.example" needs too much work to expand (more than ${LIMITS.seriesSteps} repeat periods to reach the range); only its first occurrence is shown.`]);
});

test('a hostile source uses up only its own share: the reviewer\'s cross-source case', async () => {
  // 20 hostile COUNT events (about 3.3 KB) in "invite"; the owner's weekly
  // Mon/Thu stand-up, begun January 5, 2026, in "work".
  const invite = cal(...Array.from({ length: 20 }, (_, i) => hostile(`a${String(i).padStart(2, '0')}@invite.example`)));
  const work = cal(ev('UID:weekly-standup@work.example', 'SUMMARY:Standup', 'DTSTART;TZID=America/New_York:20260105T090000', 'DURATION:PT30M', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TH'));
  for (const sources of [{ work, invite }, { invite, work }]) {
    const result = await merge(sources, { from: '2026-11-01', to: '2026-11-30' });
    const standups = result.occurrences.filter((o) => o.title === 'Standup');
    assert.deepEqual(standups.map((o) => o.start.local.slice(0, 10)), ['2026-11-02', '2026-11-05', '2026-11-09', '2026-11-12', '2026-11-16', '2026-11-19', '2026-11-23', '2026-11-26', '2026-11-30']);
    assert.ok(standups.every((o) => !o.repeatNotSupported));
    assert.equal(result.problems.length, 20);
    assert.ok(result.problems.every((p) => p.startsWith('Source "invite"')));
    const share = Math.floor(LIMITS.callSteps / 2);
    // Nine hostile series fit in the share (each stops one period past
    // 100,000); the rest find it used up, and the message says so, never
    // "more than 0".
    const fit = Math.floor(share / (LIMITS.seriesSteps + 1));
    assert.equal(result.problems.filter((p) => p.includes(`more than ${LIMITS.seriesSteps} repeat periods`)).length, fit);
    assert.equal(result.problems.filter((p) => p.includes(`this calendar's share of the work (${share} repeat periods) is used up`)).length, 20 - fit);
    assert.ok(!result.problems.some((p) => p.includes('more than 0')));
  }
});

test('time zone work for DTSTART and DTEND counts against the source\'s share; the other sources are untouched', async () => {
  // With 20 sources each gets callValues / 20 dates; each event here needs two.
  const share = Math.floor(LIMITS.callValues / 20);
  const count = share / 2 + 1;
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const day = formatDate(20_000 + (i % 700)).replaceAll('-', ''); // 2024-10-04 to 2026-09-03
    lines.push(ev(`UID:z${i}@test.example`, 'SUMMARY:Z', `DTSTART;TZID=Europe/Paris:${day}T090000`, `DTEND;TZID=Europe/Paris:${day}T100000`));
  }
  const sources = { busy: cal(...lines) };
  for (let i = 1; i < 20; i += 1) sources[`s${i}`] = cal(ev(`UID:ok${i}@test.example`, 'SUMMARY:Fine', 'DTSTART;TZID=America/New_York:20261103T090000', 'DURATION:PT1H'));
  const result = await merge(sources, NOV);
  assert.deepEqual(result.occurrences.map((o) => [o.title, o.sources.length]), [['Fine', 19]]);
  const [problem] = result.problems;
  assert.equal(result.problems.length, 1);
  assert.match(problem, new RegExp(`^Source "busy", line \\d+: 1 event skipped: this calendar's share of time zone work \\(${share} dates\\) is used up\\.$`));
});

test('DTSTAMP and LAST-MODIFIED are read as UTC: a TZID on them is ignored', async () => {
  const copy = (title, stamp) => cal(ev('UID:stamp@test.example', `SUMMARY:${title}`, 'DTSTART:20261103T150000Z', stamp));
  // Read with its TZID this would be 2026-09-30T10:00Z and lose; read as UTC
  // it is 2026-10-01T00:00Z and wins.
  const result = await merge({ a: copy('With TZID', 'DTSTAMP;TZID=Pacific/Kiritimati:20261001T000000'), b: copy('UTC', 'DTSTAMP:20260930T120000Z') }, NOV);
  assert.deepEqual(result.occurrences.map((o) => o.title), ['With TZID']);
});

test('RDATE and EXDATE values outside the range are skipped before any time zone work', async () => {
  // 40,000 dates in 2000-2020 with a TZID (over the 20-source value share of
  // 10,000 if they were read), plus one inside the range.
  const values = [];
  for (let i = 0; i < 40_000; i += 1) values.push(`${formatDate(10_957 + (i % 7_300)).replaceAll('-', '')}T${String(i % 24).padStart(2, '0')}0000`);
  const text = cal(ev('UID:old-list@test.example', 'SUMMARY:Old list', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT1H',
    `RDATE;TZID=America/New_York:${values.join(',')}`, `EXDATE;TZID=America/New_York:${values.slice(0, 5_000).join(',')}`,
    'RDATE;TZID=America/New_York:20261104T090000'));
  const result = await merge({ a: text }, NOV);
  assert.deepEqual(result.occurrences.map((o) => o.start.local), ['2026-11-02T09:00:00-05:00', '2026-11-04T09:00:00-05:00']);
  assert.deepEqual(result.problems, []);
});

test('a big out-of-range RDATE list over the series limit shows the first occurrence and reports a problem', async () => {
  const values = [];
  for (let i = 0; i <= LIMITS.seriesValues; i += 1) values.push(`${formatDate(10_957 + (i % 7_300)).replaceAll('-', '')}T090000`);
  const text = cal(ev('UID:huge-list@test.example', 'SUMMARY:Huge list', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT1H', `RDATE;TZID=America/New_York:${values.join(',')}`));
  const result = await merge({ a: text }, NOV);
  assert.deepEqual(result.occurrences.map((o) => [o.start.local, o.repeatNotSupported]), [['2026-11-02T09:00:00-05:00', true]]);
  assert.deepEqual(result.problems, [`Source "a", line 4: "huge-list@test.example" needs too much work to expand (more than ${LIMITS.seriesValues} RDATE and EXDATE values); only its first occurrence is shown.`]);
});

test('an RDATE period measured in hours that starts before the range still shows (P2-B)', async () => {
  for (const period of ['20261031T090000Z/PT144H', '20261030T090000Z/PT168H', '20261030T090000Z/P7D', '20261101T090000Z/PT120H']) {
    const text = cal(ev('UID:p@test.example', 'SUMMARY:Period', 'DTSTART:20261001T090000Z', 'DURATION:PT1H', `RDATE;VALUE=PERIOD:${period}`));
    const result = await merge({ a: text }, { from: '2026-11-05', to: '2026-11-07' });
    assert.deepEqual(result.occurrences.map((o) => o.end.utc), ['2026-11-06T09:00:00Z'], period);
    assert.deepEqual(result.problems, []);
  }
});
