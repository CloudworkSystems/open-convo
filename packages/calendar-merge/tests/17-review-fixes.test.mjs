// Review threads on #130: RANGE on cancellation records and losing overrides,
// METHOD in the full-tie order, the series limit for changed occurrences, and
// changed occurrences of a degraded series.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, merge } from './helpers.mjs';
import { LIMITS } from '../src/index.mjs';

const NOV = { from: '2026-11-01', to: '2026-11-30' };
const withMethod = (method, ...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', `METHOD:${method}`, ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const series = ev('UID:s@test.example', 'SUMMARY:Weekly', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY');
const days = (result) => result.occurrences.map((o) => o.start.local.slice(0, 10) + (o.repeatNotSupported ? '*' : ''));

test('E29: a winning cancellation record with RANGE=THISANDFUTURE shows the first occurrence and a problem', async () => {
  const record = withMethod('CANCEL', ev('UID:s@test.example', 'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=America/New_York:20261116T090000', 'SEQUENCE:1'));
  const result = await merge({ a: cal(series), b: record }, NOV);
  assert.deepEqual(days(result), ['2026-11-02*']);
  assert.deepEqual(result.problems, ['Source "a", line 4: repeat rule of "s@test.example" not supported (RANGE=THISANDFUTURE); only its first occurrence is shown.']);
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
  const moved = cal(ev('UID:m@test.example', 'SUMMARY:Dinner', 'DTSTART;TZID=Mars/Olympus:20261215T190000', 'SEQUENCE:2'));
  const old = cal(ev('UID:m@test.example', 'SUMMARY:Dinner', 'DTSTART;TZID=America/New_York:20261105T190000', 'SEQUENCE:1'));
  const result = await merge({ old, moved }, NOV);
  // The newer copy moved the dinner to December: nothing shows in November,
  // and its unknown time zone isn't read, so no problem is listed.
  assert.deepEqual(result.occurrences, []);
  assert.deepEqual(result.problems, []);
});
