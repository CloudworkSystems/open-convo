// Review threads on #130: RANGE on cancellation records and losing overrides,
// METHOD in the full-tie order, the series limit for changed occurrences,
// changed occurrences of a degraded series, and same-UID instances kept apart
// in title-and-time matching.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, merge, utcs } from './helpers.mjs';
import { LIMITS } from '../src/index.mjs';

const NOV = { from: '2026-11-01', to: '2026-11-30' };
const withMethod = (method, ...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', `METHOD:${method}`, ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const series = ev('UID:s@test.example', 'SUMMARY:Weekly', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY');
const days = (result) => result.occurrences.map((o) => o.start.local.slice(0, 10) + (o.repeatNotSupported ? '*' : ''));

test('E29: a winning cancellation record with RANGE=THISANDFUTURE shows the first occurrence and a problem', async () => {
  const record = withMethod('CANCEL', ev('UID:s@test.example', 'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=America/New_York:20261116T090000', 'SEQUENCE:1'));
  const result = await merge({ a: cal(series), b: record }, NOV);
  assert.deepEqual(days(result), ['2026-11-02*']);
  assert.deepEqual(result.problems, ['Source "b", line 4: repeat rule of "s@test.example" not supported (RANGE=THISANDFUTURE); only its first occurrence is shown.']);
});

test('E29: a stale RANGE override that loses to a newer cancellation changes only its own occurrence', async () => {
  const stale = ev('UID:s@test.example', 'SUMMARY:Moved', 'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=America/New_York:20261116T090000', 'DTSTART;TZID=America/New_York:20261116T100000', 'DURATION:PT1H', 'SEQUENCE:0');
  const record = cal(ev('UID:s@test.example', 'STATUS:CANCELLED', 'RECURRENCE-ID;TZID=America/New_York:20261116T090000', 'SEQUENCE:2'));
  const result = await merge({ a: cal(series, stale), b: record }, NOV);
  assert.deepEqual(days(result), ['2026-11-02', '2026-11-09', '2026-11-23', '2026-11-30']);
  assert.deepEqual(result.problems, []);
});

test('E31: METHOD takes part in the full-tie order: PUBLISH and CANCEL blocks give the same result in either order', async () => {
  const event = ev('UID:t@test.example', 'SUMMARY:T', 'DTSTART:20261103T150000Z');
  const publishFirst = `${withMethod('PUBLISH', event)}\r\n${withMethod('CANCEL', event)}\r\n`;
  const cancelFirst = `${withMethod('CANCEL', event)}\r\n${withMethod('PUBLISH', event)}\r\n`;
  const a = await merge({ a: publishFirst }, { ...NOV, includeCancelled: true });
  const b = await merge({ a: cancelFirst }, { ...NOV, includeCancelled: true });
  assert.deepEqual(a.occurrences, b.occurrences);
  assert.equal(a.occurrences.length, 1);
});

test('the series limit counts changed occurrences too', async () => {
  const changes = [];
  for (let i = 0; i <= LIMITS.seriesOccurrences; i += 1) {
    const stamp = `202611${String(1 + Math.floor(i / 1440)).padStart(2, '0')}T${String(Math.floor(i / 60) % 24).padStart(2, '0')}${String(i % 60).padStart(2, '0')}00Z`;
    changes.push(ev('UID:c@test.example', `RECURRENCE-ID:${stamp}`, `DTSTART:${stamp}`, 'SUMMARY:C'));
  }
  const result = await merge({ a: cal(...changes) }, { ...NOV, timeZone: 'UTC' });
  assert.equal(result.occurrences.length, LIMITS.seriesOccurrences);
  assert.equal(result.occurrences.at(-1).start.utc, '2026-11-07T22:39:00Z');
  assert.deepEqual(result.problems, [`Source "a", line 4: "c@test.example" has more than ${LIMITS.seriesOccurrences} occurrences in the range; only the first ${LIMITS.seriesOccurrences} are shown.`]);
});

test('E30: a degraded series shows only its first occurrence: its changed copies are left out', async () => {
  const hourly = ev('UID:h@test.example', 'SUMMARY:Hourly', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT10M', 'RRULE:FREQ=HOURLY');
  const changed = ev('UID:h@test.example', 'SUMMARY:Hourly (moved)', 'RECURRENCE-ID;TZID=America/New_York:20261102T110000', 'DTSTART;TZID=America/New_York:20261103T110000', 'DURATION:PT10M');
  const result = await merge({ a: cal(hourly, changed) }, NOV);
  assert.deepEqual(result.occurrences.map((o) => [o.title, o.repeatNotSupported]), [['Hourly', true]]);
  assert.equal(result.problems.length, 1);
});

test('E28: a one-off outside the range is set aside unread, but a newer copy of it still wins', async () => {
  const moved = cal(ev('UID:m@test.example', 'SUMMARY:Dinner', 'DTSTART;TZID=America/New_York:20261215T190000', 'SEQUENCE:2'));
  const old = cal(ev('UID:m@test.example', 'SUMMARY:Dinner', 'DTSTART;TZID=America/New_York:20261105T190000', 'SEQUENCE:1'));
  // The newer copy moved the dinner to December: nothing shows in November.
  const result = await merge({ old, moved }, NOV);
  assert.deepEqual(result.occurrences, []);
  assert.deepEqual(result.problems, []);
});

test('E28: a set-aside copy that shares its UID is read in full, so a broken newer copy is judged the same whatever the range', async () => {
  const broken = cal(ev('UID:m@test.example', 'SUMMARY:Dinner', 'DTSTART;TZID=Mars/Olympus:20261215T190000', 'SEQUENCE:2'));
  const old = cal(ev('UID:m@test.example', 'SUMMARY:Dinner', 'DTSTART;TZID=America/New_York:20261105T190000', 'SEQUENCE:1'));
  for (const to of ['2026-11-30', '2026-12-31']) {
    const result = await merge({ old, broken }, { from: '2026-11-01', to });
    assert.deepEqual(result.occurrences.map((o) => o.start.local), ['2026-11-05T19:00:00-05:00'], to);
    assert.deepEqual(result.problems, ['Source "broken", line 4: event "m@test.example" skipped: unknown time zone "Mars/Olympus".'], to);
  }
  // A one-off alone outside the range stays unread: no problem.
  const alone = await merge({ broken }, NOV);
  assert.deepEqual(alone.problems, []);
});

test('a degraded series whose first occurrence is cancelled by an override with DTSTART and STATUS:CANCELLED shows it cancelled (review r6)', async () => {
  const hourly = ev('UID:h@test.example', 'SUMMARY:Hourly', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT10M', 'RRULE:FREQ=HOURLY');
  const cancel = ev('UID:h@test.example', 'SUMMARY:Hourly', 'RECURRENCE-ID;TZID=America/New_York:20261102T090000', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT10M', 'STATUS:CANCELLED', 'SEQUENCE:1');
  const shown = await merge({ a: cal(hourly, cancel) }, { ...NOV, includeCancelled: true });
  assert.deepEqual(shown.occurrences.map((o) => [o.title, o.status, o.repeatNotSupported]), [['Hourly', 'cancelled', true]]);
  const hidden = await merge({ a: cal(hourly, cancel) }, NOV);
  assert.deepEqual(hidden.occurrences, []);
});

test('the series limit is applied after cancellations that won\'t be shown are removed (review r6)', async () => {
  const changes = [];
  for (let i = 0; i <= LIMITS.seriesOccurrences; i += 1) {
    const stamp = `202611${String(1 + Math.floor(i / 1440)).padStart(2, '0')}T${String(Math.floor(i / 60) % 24).padStart(2, '0')}${String(i % 60).padStart(2, '0')}00Z`;
    changes.push(ev('UID:c@test.example', `RECURRENCE-ID:${stamp}`, `DTSTART:${stamp}`, i < LIMITS.seriesOccurrences ? 'STATUS:CANCELLED' : 'SUMMARY:Live'));
  }
  const result = await merge({ a: cal(...changes) }, { ...NOV, timeZone: 'UTC' });
  assert.deepEqual(result.occurrences.map((o) => o.title), ['Live']);
  assert.deepEqual(result.problems, []);
});

test('a PERIOD RDATE counts its days in the zone of its own start, not the event\'s (review r7)', async () => {
  const MAR = { from: '2026-03-01', to: '2026-03-31', timeZone: 'UTC' };
  for (const rdate of ['RDATE;VALUE=PERIOD:20260307T170000Z/P1D', 'RDATE;VALUE=PERIOD;TZID=Europe/London:20260307T170000/P1D']) {
    // New York moves its clocks on 2026-03-08; London and UTC don't.
    const event = ev('UID:p@test.example', 'SUMMARY:Stay', 'DTSTART;TZID=America/New_York:20260301T090000', 'DURATION:PT1H', rdate);
    const result = await merge({ a: cal(event) }, MAR);
    const stay = result.occurrences.find((o) => o.start.utc === '2026-03-07T17:00:00Z');
    assert.ok(stay, rdate);
    assert.equal(stay.end.utc, '2026-03-08T17:00:00Z', rdate);
  }
});

test('equal RECURRENCE-IDs written differently give byte-identical output in either order (review r7)', async () => {
  const UTC = { ...NOV, timeZone: 'UTC' };
  const weekly = ev('UID:r@test.example', 'SUMMARY:Weekly', 'DTSTART:20261102T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=3');
  const floating = ev('UID:r@test.example', 'SUMMARY:Moved', 'RECURRENCE-ID:20261102T090000', 'DTSTART:20261102T100000Z', 'DURATION:PT1H', 'SEQUENCE:1');
  const utc = ev('UID:r@test.example', 'SUMMARY:Moved again', 'RECURRENCE-ID:20261102T090000Z', 'DTSTART:20261102T110000Z', 'DURATION:PT1H', 'SEQUENCE:2');
  const one = await merge({ a: cal(weekly, floating, utc) }, UTC);
  const two = await merge({ a: cal(weekly, utc, floating) }, UTC);
  const three = await merge({ a: cal(utc), b: cal(weekly, floating) }, UTC);
  const four = await merge({ a: cal(floating), b: cal(weekly, utc) }, UTC);
  assert.equal(JSON.stringify(one.occurrences), JSON.stringify(two.occurrences));
  assert.equal(JSON.stringify(three.occurrences.map((o) => [o.key, o.title])), JSON.stringify(four.occurrences.map((o) => [o.key, o.title])));
  assert.deepEqual(one.occurrences.map((o) => [o.key, o.title]), [
    ['r@test.example/2026-11-02T09:00:00Z', 'Moved again'],
    ['r@test.example/2026-11-09T09:00:00Z', 'Weekly'],
    ['r@test.example/2026-11-16T09:00:00Z', 'Weekly'],
  ]);
});

test('RDATEs for the same start written differently give byte-identical output in either order (review r7)', async () => {
  const UTC = { ...NOV, timeZone: 'UTC' };
  const make = (...rdates) => cal(ev('UID:d@test.example', 'SUMMARY:Extra', 'DTSTART:20261102T090000', 'DURATION:PT1H', ...rdates));
  const rdates = ['RDATE:20261105T090000', 'RDATE:20261105T090000Z', 'RDATE;VALUE=PERIOD:20261105T090000Z/PT3H'];
  const first = await merge({ a: make(...rdates) }, UTC);
  const second = await merge({ a: make(...[...rdates].reverse()) }, UTC);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.occurrences.length, 2);
});

test('DTSTART is always the first occurrence, even when UNTIL is before it (review r8)', async () => {
  const timed = ev('UID:u@test.example', 'SUMMARY:Late', 'DTSTART:20261105T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;UNTIL=20261101T090000Z');
  const allDay = ev('UID:v@test.example', 'SUMMARY:Late day', 'DTSTART;VALUE=DATE:20261105', 'RRULE:FREQ=DAILY;UNTIL=20261101');
  const result = await merge({ a: cal(timed, allDay) }, { ...NOV, timeZone: 'UTC' });
  assert.deepEqual(result.occurrences.map((o) => [o.title, o.allDay ? o.start : o.start.utc]), [['Late day', '2026-11-05'], ['Late', '2026-11-05T09:00:00Z']]);
  assert.deepEqual(result.problems, []);
});

test('DTSTART counts as the first occurrence when BYDAY excludes it, and with a bad COUNT (review r8)', async () => {
  const UTC = { ...NOV, timeZone: 'UTC' };
  // 2026-11-05 is a Thursday: COUNT=2 is DTSTART plus the next Monday.
  const byday = ev('UID:w@test.example', 'SUMMARY:Mondays', 'DTSTART:20261105T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=2');
  const shown = await merge({ a: cal(byday) }, UTC);
  assert.deepEqual(shown.occurrences.map((o) => o.start.utc), ['2026-11-05T09:00:00Z', '2026-11-09T09:00:00Z']);
  const zero = ev('UID:z@test.example', 'SUMMARY:Zero', 'DTSTART:20261105T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=0');
  const degraded = await merge({ a: cal(zero) }, UTC);
  assert.deepEqual(degraded.occurrences.map((o) => [o.start.utc, o.repeatNotSupported]), [['2026-11-05T09:00:00Z', true]]);
  assert.equal(degraded.problems.length, 1);
});

test('a cancellation with a RECURRENCE-ID for a UID that only has a one-off is listed unless it names that one-off\'s start (review r8)', async () => {
  const UTC = { ...NOV, timeZone: 'UTC', includeCancelled: true };
  const oneOff = cal(ev('UID:o@test.example', 'SUMMARY:Once', 'DTSTART:20261101T090000Z', 'DURATION:PT1H'));
  const other = cal(ev('UID:o@test.example', 'STATUS:CANCELLED', 'RECURRENCE-ID:20261102T090000Z', 'SEQUENCE:1'));
  const missed = await merge({ a: oneOff, b: other }, UTC);
  assert.deepEqual(missed.occurrences.map((o) => [o.title, o.status]), [['Once', 'confirmed']]);
  assert.deepEqual(missed.problems, ['Source "b", line 4: cancellation for "o@test.example" at 2026-11-02T09:00:00Z matches no occurrence: "o@test.example" does not repeat.']);
  const same = cal(ev('UID:o@test.example', 'STATUS:CANCELLED', 'RECURRENCE-ID:20261101T090000Z', 'SEQUENCE:1'));
  const hit = await merge({ a: oneOff, b: same }, UTC);
  assert.deepEqual(hit.occurrences.map((o) => [o.title, o.status]), [['Once', 'cancelled']]);
  assert.deepEqual(hit.problems, []);
});

test('a RANGE=THISANDFUTURE change from another source is named in its problem, not the series (review r8)', async () => {
  const moved = ev('UID:s@test.example', 'SUMMARY:Moved', 'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=America/New_York:20261116T090000', 'DTSTART;TZID=America/New_York:20261116T100000', 'DURATION:PT1H', 'SEQUENCE:1');
  const result = await merge({ a: cal(series), b: cal(ev('UID:other@test.example', 'SUMMARY:Other', 'DTSTART:20261103T150000Z'), moved) }, NOV);
  assert.deepEqual(days(result), ['2026-11-02*', '2026-11-03']);
  assert.deepEqual(result.problems, [`Source "b", line ${4 + ev('UID:other@test.example', 'SUMMARY:Other', 'DTSTART:20261103T150000Z').length}: repeat rule of "s@test.example" not supported (RANGE=THISANDFUTURE); only its first occurrence is shown.`]);
});

test('no extreme value makes the call fail: each bad event is skipped and listed (review r9)', async () => {
  const S = 'DTSTART:20261102T090000Z';
  const cases = [
    [S, 'DURATION:P100000000D'], [S, 'DURATION:PT99999999999999999999H'], [S, 'DURATION:P99999999999W'],
    [S, `DURATION:P${'9'.repeat(400)}D`], ['DTSTART;VALUE=DATE:20261102', 'DURATION:P100000000D'],
    ['DTSTART:99991231T235959Z', 'DURATION:P3660000D', 'RRULE:FREQ=DAILY'], ['DTSTART;VALUE=DATE:99991231', 'RRULE:FREQ=YEARLY'],
    ['DTSTART;TZID=America/New_York:00010101T000000', 'RRULE:FREQ=WEEKLY'], [S, 'DTEND;TZID=Asia/Tokyo:99991231T235959'],
    [S, 'RRULE:FREQ=DAILY;UNTIL=99991231T235959Z'], [S, 'RRULE:FREQ=DAILY;UNTIL=00010101'],
    [S, 'RRULE:FREQ=YEARLY;INTERVAL=99999999999999999999'], [S, 'RRULE:FREQ=WEEKLY;INTERVAL=99999999999999999999999'],
    [S, 'RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-99999999999999999999'], [S, 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-9999999999999'],
    [S, 'RRULE:FREQ=MONTHLY;BYDAY=99999999999MO'], [S, 'RRULE:FREQ=DAILY;COUNT=99999999999999999999'],
    [S, 'RDATE;VALUE=PERIOD:20261103T090000Z/P100000000D'], [S, `RDATE;VALUE=PERIOD:20261103T090000Z/PT${'9'.repeat(30)}S`],
    [S, 'RDATE;VALUE=PERIOD;TZID=Pacific/Kiritimati:99991231T235959/P3660000D'], [S, 'RDATE:99991231T235959Z,00010101T000000Z'],
    ['RECURRENCE-ID:99991231T235959Z', 'DTSTART:99991231T235959Z', 'DURATION:P1D'],
  ];
  const ranges = [{ from: '2026-11-01', to: '2026-11-30' }, { from: '9999-12-01', to: '9999-12-31', timeZone: 'Pacific/Kiritimati' }, { from: '0001-01-01', to: '0001-01-31' }];
  for (const props of cases) {
    for (const range of ranges) {
      const result = await merge({ a: cal(ev('UID:x@test.example', 'SUMMARY:X', ...props)) }, range);
      assert.ok(Array.isArray(result.occurrences), props.join(' '));
    }
  }
  const huge = await merge({ a: cal(ev('UID:x@test.example', 'DTSTART:20261102T090000Z', 'DURATION:P100000000D')) }, NOV);
  assert.deepEqual(huge.problems, ['Source "a", line 4: event "x@test.example" skipped: DURATION is not readable or is longer than 10,000 years.']);
});

test('a floating DTEND is read in the query\'s zone, even when DTSTART has a TZID (review r9)', async () => {
  const event = ev('UID:f@test.example', 'SUMMARY:Mixed', 'DTSTART;TZID=America/New_York:20261102T090000', 'DTEND:20261102T120000');
  const result = await merge({ a: cal(event) }, { ...NOV, timeZone: 'America/Los_Angeles' });
  assert.deepEqual(result.occurrences.map((o) => [o.start.utc, o.end.utc]), [['2026-11-02T14:00:00Z', '2026-11-02T20:00:00Z']]);
});

test('a UID is unescaped like other text before copies are matched (review r9)', async () => {
  const escaped = cal(ev('UID:team\\,one@test.example', 'SUMMARY:Old', 'DTSTART:20261103T150000Z'));
  const plain = cal(ev('UID:team,one@test.example', 'SUMMARY:New', 'DTSTART:20261103T150000Z', 'SEQUENCE:1'));
  const result = await merge({ a: escaped, b: plain }, NOV);
  assert.deepEqual(result.occurrences.map((o) => [o.uid, o.title, o.matchedBy]), [['team,one@test.example', 'New', 'uid']]);
});

test('a UID is not trimmed: "a" and " a " are different events (review r10)', async () => {
  const UTC = { ...NOV, timeZone: 'UTC' };
  const result = await merge({ a: cal(ev('UID:a', 'SUMMARY:One', 'DTSTART:20261103T150000Z')), b: cal(ev('UID: a ', 'SUMMARY:Two', 'DTSTART:20261103T150000Z')) }, UTC);
  assert.deepEqual(result.occurrences.map((o) => [o.uid, o.title]), [['a', 'One'], [' a ', 'Two']]);
});

test('a floating PERIOD end is read on the clock of the period\'s start (review r10)', async () => {
  const event = ev('UID:p@test.example', 'SUMMARY:Extra', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT1H', 'RDATE;VALUE=PERIOD:20261101T090000Z/20261101T100000');
  const result = await merge({ a: cal(event) }, NOV);
  assert.deepEqual(result.occurrences.map((o) => [o.start.utc, o.end.utc]), [['2026-11-01T09:00:00Z', '2026-11-01T10:00:00Z'], ['2026-11-02T14:00:00Z', '2026-11-02T15:00:00Z']]);
  assert.deepEqual(result.problems, []);
});

test('any positive INTERVAL is read; a huge one gives DTSTART and nothing after it (review r10)', async () => {
  const UTC = { ...NOV, timeZone: 'UTC' };
  const seven = await merge({ a: cal(ev('UID:i@test.example', 'SUMMARY:I', 'DTSTART:20261102T090000Z', 'RRULE:FREQ=DAILY;INTERVAL=0000007')) }, UTC);
  assert.deepEqual(utcs(seven), ['2026-11-02T09:00:00Z', '2026-11-09T09:00:00Z', '2026-11-16T09:00:00Z', '2026-11-23T09:00:00Z', '2026-11-30T09:00:00Z']);
  for (const freq of ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']) {
    for (const interval of ['1000000', '99999999999999', '9'.repeat(400)]) {
      const result = await merge({ a: cal(ev('UID:i@test.example', 'SUMMARY:I', 'DTSTART:20261102T090000Z', `RRULE:FREQ=${freq};INTERVAL=${interval}`)) }, UTC);
      assert.deepEqual(utcs(result), ['2026-11-02T09:00:00Z'], `${freq} ${interval.length}`);
      assert.deepEqual(result.problems, [], `${freq} ${interval.length}`);
    }
  }
});

test('E32: changed occurrences of one UID moved to the same time are never merged by title and time', async () => {
  // The reviewer's case: no series anywhere (E22), the 2026-11-01 instance
  // changed in source "a" and the 2026-11-02 instance in source "b", both
  // moved to the same time with the same title. They are two instances.
  const moved = (rid) => ev('UID:u@test.example', `RECURRENCE-ID:${rid}`, 'SUMMARY:Review', 'DTSTART:20261105T150000Z', 'DURATION:PT1H');
  const a = cal(moved('20261101T150000Z'));
  const b = cal(moved('20261102T150000Z'));
  const row = (o) => [o.key, o.sources.map((s) => s.id).join(','), o.matchedBy, o.isChanged];
  for (const sources of [{ a, b }, { b, a }]) {
    const result = await merge(sources, NOV);
    assert.deepEqual(result.occurrences.map(row), [
      ['u@test.example/2026-11-01T15:00:00Z', 'a', null, true],
      ['u@test.example/2026-11-02T15:00:00Z', 'b', null, true],
    ]);
    assert.deepEqual(result.problems, []);
  }
  // A look-alike with another UID still merges, with the first instance
  // whose sources it doesn't overlap; the two instances stay apart.
  const c = cal(ev('UID:other@test.example', 'SUMMARY:review', 'DTSTART:20261105T150000Z', 'DURATION:PT1H'));
  for (const [sources, expected] of [
    [{ a, b, c }, [['other@test.example/2026-11-05T15:00:00Z + u@test.example/2026-11-01T15:00:00Z', 'a,c', 'title-and-time', true], ['u@test.example/2026-11-02T15:00:00Z', 'b', null, true]]],
    [{ b, a, c }, [['other@test.example/2026-11-05T15:00:00Z + u@test.example/2026-11-02T15:00:00Z', 'b,c', 'title-and-time', true], ['u@test.example/2026-11-01T15:00:00Z', 'a', null, true]]],
  ]) {
    const result = await merge(sources, NOV);
    assert.deepEqual(result.occurrences.map(row), expected);
  }
});

// Review r9. Output compared across source orders lists each occurrence's
// sources by id, since `sources` follows the order the calendars are given.
const bySourceId = (result) => JSON.stringify({
  ...result,
  occurrences: result.occurrences.map((o) => ({ ...o, sources: [...o.sources].sort((x, y) => (x.id < y.id ? -1 : 1)) })),
});

test('a floating RECURRENCE-ID is read on the series\' clock even when the moved copy is in another zone (review r9)', async () => {
  const weekly = ev('UID:f@test.example', 'SUMMARY:Weekly', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=3');
  const movedTo = (start) => ev('UID:f@test.example', 'SUMMARY:Moved', 'RECURRENCE-ID:20261109T090000', start, 'DURATION:PT1H', 'SEQUENCE:1');
  const row = (o) => [o.key, o.title, o.start.utc, o.sources.map((s) => s.id).sort().join(','), o.matchedBy, o.isChanged];
  for (const start of ['DTSTART:20261109T200000Z', 'DTSTART;TZID=Europe/London:20261109T200000', 'DTSTART:20261109T150000']) {
    for (const timeZone of ['America/New_York', 'Europe/London']) {
      const query = { ...NOV, timeZone };
      const moved = movedTo(start);
      const runs = [
        await merge({ a: cal(weekly, moved) }, query),
        await merge({ a: cal(moved, weekly) }, query),
        await merge({ a: cal(weekly), b: cal(moved) }, query),
        await merge({ b: cal(moved), a: cal(weekly) }, query),
      ];
      assert.equal(JSON.stringify(runs[0]), JSON.stringify(runs[1]), `${start} ${timeZone}`);
      assert.equal(bySourceId(runs[2]), bySourceId(runs[3]), `${start} ${timeZone}`);
      const movedUtc = start.endsWith('T150000') ? (timeZone === 'Europe/London' ? '2026-11-09T15:00:00Z' : '2026-11-09T20:00:00Z') : '2026-11-09T20:00:00Z';
      assert.deepEqual(runs[2].occurrences.map(row), [
        ['f@test.example/2026-11-02T14:00:00Z', 'Weekly', '2026-11-02T14:00:00Z', 'a', null, false],
        ['f@test.example/2026-11-09T14:00:00Z', 'Moved', movedUtc, 'a,b', 'uid', true],
        ['f@test.example/2026-11-16T14:00:00Z', 'Weekly', '2026-11-16T14:00:00Z', 'a', null, false],
      ], `${start} ${timeZone}`);
      assert.deepEqual(runs[2].problems, []);
    }
  }
});

test('a floating RECURRENCE-ID on a cancellation record is read on the series\' clock, not the query\'s (review r9 sweep)', async () => {
  const weekly = ev('UID:f@test.example', 'SUMMARY:Weekly', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=3');
  const record = withMethod('CANCEL', ev('UID:f@test.example', 'RECURRENCE-ID:20261109T090000', 'SEQUENCE:1'));
  const query = { ...NOV, timeZone: 'Europe/London' };
  const one = await merge({ a: cal(weekly), b: record }, query);
  const two = await merge({ b: record, a: cal(weekly) }, query);
  assert.equal(bySourceId(one), bySourceId(two));
  assert.deepEqual(utcs(one), ['2026-11-02T14:00:00Z', '2026-11-16T14:00:00Z']);
  const shown = await merge({ a: cal(weekly), b: record }, { ...query, includeCancelled: true });
  assert.deepEqual(shown.occurrences.map((o) => [o.key, o.status, o.sources.map((s) => s.id).join(',')]), [
    ['f@test.example/2026-11-02T14:00:00Z', 'confirmed', 'a'],
    ['f@test.example/2026-11-09T14:00:00Z', 'cancelled', 'a,b'],
    ['f@test.example/2026-11-16T14:00:00Z', 'confirmed', 'a'],
  ]);
});

test('a changed occurrence with a floating RECURRENCE-ID and no series reads it in its own zone (review r9, E22)', async () => {
  const orphan = cal(ev('UID:o9@test.example', 'SUMMARY:Invited once', 'RECURRENCE-ID:20261109T090000', 'DTSTART;TZID=Europe/London:20261109T200000', 'DURATION:PT1H'));
  for (const timeZone of ['America/New_York', 'Europe/London']) {
    const result = await merge({ a: orphan }, { ...NOV, timeZone });
    assert.deepEqual(result.occurrences.map((o) => [o.key, o.start.utc, o.isChanged, o.isRepeat]), [
      ['o9@test.example/2026-11-09T09:00:00', '2026-11-09T20:00:00Z', true, true],
    ]);
    assert.deepEqual(result.problems, []);
  }
});

test('a cancellation that loses to a newer series still lists its source on the occurrence (review r9, E23)', async () => {
  const weekly = ev('UID:l@test.example', 'SUMMARY:Weekly', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SEQUENCE:2');
  const stale = ev('UID:l@test.example', 'RECURRENCE-ID;TZID=America/New_York:20261109T090000', 'STATUS:CANCELLED', 'SEQUENCE:1');
  const staleFloating = ev('UID:l@test.example', 'RECURRENCE-ID:20261109T090000', 'STATUS:CANCELLED', 'SEQUENCE:1');
  const row = (o) => [o.key, o.status, o.sources.map((s) => s.id).sort().join(','), o.matchedBy];
  for (const record of [stale, staleFloating]) {
    for (const timeZone of ['America/New_York', 'Europe/London']) {
      const query = { ...NOV, timeZone };
      const one = await merge({ a: cal(weekly), b: cal(record) }, query);
      const two = await merge({ b: cal(record), a: cal(weekly) }, query);
      assert.equal(bySourceId(one), bySourceId(two));
      assert.deepEqual(one.occurrences.map(row), [
        ['l@test.example/2026-11-02T14:00:00Z', 'confirmed', 'a', null],
        ['l@test.example/2026-11-09T14:00:00Z', 'confirmed', 'a,b', 'uid'],
        ['l@test.example/2026-11-16T14:00:00Z', 'confirmed', 'a', null],
      ]);
      assert.deepEqual(one.problems, []);
      // In one source, the order of the events never changes the output.
      const same = await merge({ a: cal(weekly, record) }, query);
      assert.equal(JSON.stringify(same), JSON.stringify(await merge({ a: cal(record, weekly) }, query)));
      assert.deepEqual(same.occurrences.map(row)[1], ['l@test.example/2026-11-09T14:00:00Z', 'confirmed', 'a', null]);
    }
  }
});

// Round on 700e52a: title-and-time ranking uses the copy that won each
// occurrence, and same-source UID collapses are reported as UID matches.
const at = (stamp) => `DTSTART;TZID=America/New_York:${stamp}`;

test('a title-and-time tie goes to the earlier source of the winning copy, not of a losing copy (review 700e52a)', async () => {
  const aOld = cal(ev('UID:a@test.example', 'SUMMARY:Sync', at('20261110T100000'), 'DURATION:PT1H', 'LOCATION:Room A old', 'SEQUENCE:0'));
  const bWin = cal(ev('UID:b@test.example', 'SUMMARY:Sync', at('20261110T100000'), 'DURATION:PT1H', 'LOCATION:Room B', 'SEQUENCE:1'));
  const aWin = cal(ev('UID:a@test.example', 'SUMMARY:Sync', at('20261110T100000'), 'DURATION:PT1H', 'LOCATION:Room A', 'SEQUENCE:1'));
  const result = await merge({ s0: aOld, s1: bWin, s2: aWin }, NOV);
  assert.deepEqual(result.occurrences.map((o) => [o.uid, o.location, o.matchedBy, o.sources.map((s) => s.id).join(',')]), [
    ['b@test.example', 'Room B', 'title-and-time', 's0,s1,s2'],
  ]);
});

test('cancelled title-and-time look-alikes are ranked by the winning cancellation record (review 700e52a)', async () => {
  const x = cal(ev('UID:x@test.example', 'SUMMARY:Talk', at('20261110T100000'), 'DURATION:PT1H', 'LOCATION:Hall X', 'SEQUENCE:0'));
  const xRecord = cal(ev('UID:x@test.example', 'STATUS:CANCELLED', 'SEQUENCE:10'));
  const y = cal(ev('UID:y@test.example', 'SUMMARY:Talk', at('20261110T100000'), 'DURATION:PT1H', 'LOCATION:Hall Y', 'SEQUENCE:5'));
  const yRecord = cal(ev('UID:y@test.example', 'STATUS:CANCELLED', 'SEQUENCE:6'));
  const result = await merge({ a: x, b: xRecord, c: y, d: yRecord }, { ...NOV, includeCancelled: true });
  assert.deepEqual(result.occurrences.map((o) => [o.uid, o.location, o.status, o.matchedBy]), [
    ['x@test.example', 'Hall X', 'cancelled', 'title-and-time'],
  ]);
});

test('two copies of one UID in one source are reported as a UID match (review 700e52a, E16)', async () => {
  const one = ev('UID:d@test.example', 'SUMMARY:Dup', at('20261110T100000'), 'DURATION:PT1H', 'SEQUENCE:1');
  const two = ev('UID:d@test.example', 'SUMMARY:Dup (old)', at('20261110T100000'), 'DURATION:PT1H', 'SEQUENCE:0');
  const result = await merge({ a: cal(one, two) }, NOV);
  assert.deepEqual(result.occurrences.map((o) => [o.title, o.matchedBy]), [['Dup', 'uid']]);
  const moved = ev('UID:d@test.example', 'SUMMARY:Moved', 'RECURRENCE-ID;TZID=America/New_York:20261110T100000', at('20261110T120000'), 'DURATION:PT1H', 'SEQUENCE:2');
  const movedOld = ev('UID:d@test.example', 'SUMMARY:Moved (old)', 'RECURRENCE-ID;TZID=America/New_York:20261110T100000', at('20261110T130000'), 'DURATION:PT1H', 'SEQUENCE:1');
  const series = ev('UID:d@test.example', 'SUMMARY:Daily', at('20261109T100000'), 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=2');
  const changed = await merge({ a: cal(series, moved, movedOld) }, NOV);
  assert.deepEqual(changed.occurrences.map((o) => [o.title, o.matchedBy]), [['Daily', null], ['Moved', 'uid']]);
});
