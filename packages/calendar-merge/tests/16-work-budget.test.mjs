// Review P2-1, P2-A and P2-C: a hostile or huge calendar can't stall a call,
// and can only use up its own source's share of the work. These tests count
// problems and occurrences rather than time, so slow machines don't flake.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, merge, reorderEvents } from './helpers.mjs';
import { setLimitsForTests } from '../src/engine.mjs';
import { LIMITS } from '../src/index.mjs';
import { formatDate } from '../src/time.mjs';

const NOV = { from: '2026-11-01', to: '2026-11-07' };

// 164 bytes: a COUNT rule from year 1 that never produces a date.
const hostile = (uid) => ev(`UID:${uid}`, 'SUMMARY:Never', 'DTSTART:00010101T090000Z', 'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30;COUNT=5');

test('a hostile COUNT rule stops at the series budget and reports a problem', async () => {
  const result = await merge({ a: cal(hostile('h1@test.example')) }, NOV);
  assert.deepEqual(result.occurrences, []);
  assert.deepEqual(result.problems, [`Source "a", line 4: "h1@test.example" needs too much work to expand (more than ${LIMITS.seriesSteps} repeat steps to reach the range); only its first occurrence is shown.`]);
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
    assert.equal(result.problems.filter((p) => p.includes(`more than ${LIMITS.seriesSteps} repeat steps`)).length, fit);
    assert.equal(result.problems.filter((p) => p.includes(`this calendar's share of the work (${share} repeat steps) is used up`)).length, 20 - fit);
    assert.ok(!result.problems.some((p) => p.includes('more than 0')));
  }
});

test('time zone work for DTSTART and DTEND counts against the source\'s share; the other sources are untouched', async () => {
  // Small limits so a small input reaches them: 2 sources, 20 dates each.
  const restore = setLimitsForTests({ callValues: 40 });
  try {
    const busy = cal(...Array.from({ length: 15 }, (_, i) => ev(`UID:z${String(i).padStart(2, '0')}@test.example`, 'SUMMARY:Z',
      `DTSTART;TZID=Europe/Paris:2026110${1 + (i % 7)}T090000`, `DTEND;TZID=Europe/Paris:2026110${1 + (i % 7)}T100000`)));
    const calm = cal(ev('UID:ok@test.example', 'SUMMARY:Fine', 'DTSTART;TZID=America/New_York:20261103T090000', 'DURATION:PT1H'));
    const result = await merge({ busy, calm }, NOV);
    assert.equal(result.occurrences.filter((o) => o.title === 'Z').length, 10);
    assert.equal(result.occurrences.filter((o) => o.title === 'Fine').length, 1);
    assert.deepEqual(result.problems, ['Source "busy", line 64: 5 events skipped, the first here: this calendar\'s share of time zone work (20 dates) is used up.']);
  } finally {
    restore();
  }
});

test('old one-off history costs no time zone work: the reviewer\'s q1 case, in both orders and with more sources', async () => {
  const history = [];
  for (let i = 0; i < 5_200; i += 1) {
    const day = formatDate(17_532 + (i % 2_900)).replaceAll('-', ''); // 2018-01-01 onward
    history.push(ev(`UID:h${i}@work.example`, 'SUMMARY:Old meeting', `DTSTART;TZID=America/New_York:${day}T100000`, `DTEND;TZID=America/New_York:${day}T110000`, 'DTSTAMP:20250101T000000Z'));
  }
  const inRange = [
    ev('UID:review@work.example', 'SUMMARY:Quarterly review', 'DTSTART;TZID=America/New_York:20261103T140000', 'DTEND;TZID=America/New_York:20261103T150000'),
    ev('UID:standup@work.example', 'SUMMARY:Standup', 'DTSTART;TZID=America/New_York:20260105T090000', 'DURATION:PT15M', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20271231T090000'),
  ];
  const seen = new Set();
  for (const ics of [cal(...history, ...inRange), cal(...inRange, ...history)]) {
    for (const extra of [0, 4, 19]) {
      const sources = [{ id: 'work', name: 'work', ics }];
      for (let i = 0; i < extra; i += 1) sources.push({ id: `s${i}`, name: `s${i}`, ics: cal() });
      const result = await merge(sources, NOV);
      assert.deepEqual(result.occurrences.map((o) => [o.title, o.start.local, o.repeatNotSupported]), [
        ['Standup', '2026-11-02T09:00:00-05:00', false],
        ['Quarterly review', '2026-11-03T14:00:00-05:00', false],
        ['Standup', '2026-11-05T09:00:00-05:00', false],
      ]);
      assert.deepEqual(result.problems, []);
      seen.add(JSON.stringify(result.occurrences.map(({ sources: _, ...o }) => o)));
    }
  }
  assert.equal(seen.size, 1);
});

test('occurrences are capped per source share, deterministically, with a problem', async () => {
  const restore = setLimitsForTests({ callOccurrences: 50 });
  try {
    const daily = cal(...Array.from({ length: 10 }, (_, i) => ev(`UID:d${i}@test.example`, 'SUMMARY:Daily', `DTSTART:20261101T${String(10 + i)}0000Z`, 'RRULE:FREQ=DAILY')));
    const other = cal(ev('UID:o@test.example', 'SUMMARY:Other', 'DTSTART:20261101T080000Z', 'RRULE:FREQ=DAILY'));
    const result = await merge({ daily, other }, NOV);
    assert.equal(result.occurrences.filter((o) => o.title === 'Daily').length, 25);
    assert.equal(result.occurrences.filter((o) => o.title === 'Other').length, 7);
    // d0, d1 and d2 fit (7 + 7 + 7 = 21), d3 gets 4 of 7, d4 to d9 none.
    assert.deepEqual(result.problems, ['Source "daily", line 22: 45 occurrences of 7 events not shown, the first "d3@test.example": this calendar\'s share of occurrences (25) is used up.']);
    const again = await merge({ daily: reorderEvents(daily, (ix) => [...ix].reverse()), other }, NOV);
    assert.deepEqual(again.occurrences, result.occurrences);
  } finally {
    restore();
  }
});

test('a costly copy is paid for only by its own source: a hostile source can\'t drain another (review r4)', async () => {
  // With 2 sources, each has 1,000,000 repeat steps. "hostile" fills its
  // share, then holds newer, costly copies of 11 UIDs it shares with
  // "victim". Those copies are charged to "hostile" only, so the victim's
  // private Gym series is untouched and no problem names the victim.
  const shared = (k, extra) => ev(`UID:a${String(k).padStart(2, '0')}@corp.example`, 'SUMMARY:Shared', ...extra);
  const gym = ev('UID:z-private@corp.example', 'SUMMARY:Gym', 'DTSTART:20261102T070000Z', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY');
  const victim = cal(...Array.from({ length: 11 }, (_, k) => shared(k, ['DTSTART:20261102T090000Z', 'DURATION:PT30M', 'RRULE:FREQ=WEEKLY'])), gym);
  const hostile = cal(
    ...Array.from({ length: 10 }, (_, k) => ev(`UID:0fill${k}@hostile.example`, 'DTSTART:17000101T000000Z', 'RRULE:FREQ=DAILY;COUNT=500000')),
    ...Array.from({ length: 11 }, (_, k) => shared(k, ['DTSTART:17000101T000000Z', 'RRULE:FREQ=DAILY;COUNT=500000', 'SEQUENCE:5'])),
  );
  const range = { from: '2026-11-01', to: '2027-12-01', timeZone: 'UTC' };
  const alone = await merge({ victim, other: cal() }, range);
  const attacked = await merge({ victim, hostile }, range);
  const gyms = (r) => r.occurrences.filter((o) => o.title === 'Gym').map((o) => [o.start.utc, o.repeatNotSupported]);
  assert.equal(gyms(alone).length, 57);
  assert.deepEqual(gyms(attacked), gyms(alone));
  assert.ok(!attacked.problems.some((p) => p.startsWith('Source "victim"')));
  assert.ok(attacked.problems.every((p) => p.startsWith('Source "hostile"')));
});

test('changed occurrences are charged to their own source: a hostile source\'s overrides can\'t drop another\'s appointment (review r3)', async () => {
  const restore = setLimitsForTests({ callOccurrences: 200 });
  try {
    // 2 sources, 100 occurrences each. "hostile" holds 150 changed copies of
    // a weekly series that "victim" owns.
    const minute = (i) => `202611${String(1 + Math.floor(i / 1440)).padStart(2, '0')}T${String(Math.floor(i / 60) % 24).padStart(2, '0')}${String(i % 60).padStart(2, '0')}00Z`;
    const victim = cal(ev('UID:a0@corp.example', 'SUMMARY:Shared', 'DTSTART:20261102T090000Z', 'DURATION:PT30M', 'RRULE:FREQ=WEEKLY;COUNT=3'),
      ev('UID:z-private@corp.example', 'SUMMARY:Doctor', 'DTSTART:20261110T150000Z', 'DURATION:PT1H'));
    const hostile = cal(...Array.from({ length: 150 }, (_, i) => ev('UID:a0@corp.example', `RECURRENCE-ID:${minute(i)}`, `DTSTART:${minute(i)}`, 'SEQUENCE:9')));
    const result = await merge({ victim, hostile }, { from: '2026-11-01', to: '2026-11-30', timeZone: 'UTC' });
    assert.ok(result.occurrences.some((o) => o.title === 'Doctor'));
    assert.equal(result.occurrences.filter((o) => o.isChanged).length, 100);
    assert.deepEqual(result.problems, ['Source "hostile", line 604: 50 occurrences of 1 event not shown, the first "a0@corp.example": this calendar\'s share of occurrences (100) is used up.']);
  } finally {
    restore();
  }
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
