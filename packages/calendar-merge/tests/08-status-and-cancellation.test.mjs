// Plan test 8: status, cancelled events and cancellation records.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, merge, sourceIds } from './helpers.mjs';

const NOV = { from: '2026-11-01', to: '2026-11-30' };
const days = (result) => result.occurrences.map((o) => o.start.local.slice(0, 10));

test('no STATUS is confirmed and matches STATUS:CONFIRMED', async () => {
  const a = cal(ev('UID:a1@test.example', 'SUMMARY:Haircut', 'DTSTART;TZID=America/New_York:20261103T120000', 'DURATION:PT30M'));
  const b = cal(ev('UID:b1@test.example', 'SUMMARY:Haircut', 'DTSTART;TZID=America/New_York:20261103T120000', 'DURATION:PT30M', 'STATUS:CONFIRMED'));
  const byTitle = await merge({ a, b }, NOV);
  assert.equal(byTitle.occurrences.length, 1);
  assert.equal(byTitle.occurrences[0].status, 'confirmed');
  assert.equal(byTitle.occurrences[0].matchedBy, 'title-and-time');
  assert.deepEqual(sourceIds(byTitle.occurrences[0]), ['a', 'b']);
  const sameUid = await merge({ a, b: b.replace('b1@', 'a1@') }, NOV);
  assert.equal(sameUid.occurrences.length, 1);
  assert.equal(sameUid.occurrences[0].matchedBy, 'uid');
  assert.deepEqual(sourceIds(sameUid.occurrences[0]), ['a', 'b']);
});

const series = ['UID:yoga@test.example', 'SUMMARY:Yoga', 'DTSTART;TZID=America/New_York:20261102T070000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SEQUENCE:2'];
const changed = ['UID:yoga@test.example', 'RECURRENCE-ID;TZID=America/New_York:20261109T070000', 'SUMMARY:Yoga (outdoor)', 'DTSTART;TZID=America/New_York:20261110T070000', 'DURATION:PT1H', 'SEQUENCE:2'];

test('a cancelled single event, a cancelled series with its changed occurrences, and a METHOD:CANCEL file', async () => {
  const single = cal(ev('UID:one@test.example', 'SUMMARY:Plumber', 'DTSTART;TZID=America/New_York:20261104T090000', 'DURATION:PT1H', 'STATUS:CANCELLED'));
  assert.equal((await merge({ a: single }, NOV)).occurrences.length, 0);
  assert.equal((await merge({ a: single }, { ...NOV, includeCancelled: true })).occurrences[0].status, 'cancelled');

  const cancelledSeries = cal(ev(...series, 'STATUS:CANCELLED'), ev(...changed));
  assert.equal((await merge({ a: cancelledSeries }, NOV)).occurrences.length, 0);
  const shown = await merge({ a: cancelledSeries }, { ...NOV, includeCancelled: true });
  assert.deepEqual(shown.occurrences.map((o) => [o.title, o.status]), [['Yoga', 'cancelled'], ['Yoga (outdoor)', 'cancelled'], ['Yoga', 'cancelled'], ['Yoga', 'cancelled']]);

  const cancelFile = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:CANCEL', ...ev('UID:party@test.example', 'SUMMARY:Party', 'DTSTART;TZID=America/New_York:20261107T180000', 'DURATION:PT3H', 'SEQUENCE:1'), 'END:VCALENDAR'].join('\r\n');
  assert.equal((await merge({ a: cancelFile }, NOV)).occurrences.length, 0);
  assert.equal((await merge({ a: cancelFile }, { ...NOV, includeCancelled: true })).occurrences[0].status, 'cancelled');
});

const live = cal(ev(...series), ev(...changed));
const cancelCal = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:CANCEL', ...events.flat(), 'END:VCALENDAR', ''].join('\r\n');

test('a cancellation record with UID and RECURRENCE-ID (another zone) cancels just that occurrence', async () => {
  // 07:00 in New York on November 16 is 12:00 in London.
  const record = cancelCal(ev('UID:yoga@test.example', 'RECURRENCE-ID;TZID=Europe/London:20261116T120000', 'SEQUENCE:3'));
  const result = await merge({ home: live, cancels: record }, NOV);
  assert.deepEqual(days(result), ['2026-11-02', '2026-11-10', '2026-11-23']);
  const shown = await merge({ home: live, cancels: record }, { ...NOV, includeCancelled: true });
  const gone = shown.occurrences.find((o) => o.status === 'cancelled');
  assert.equal(gone.title, 'Yoga');
  assert.equal(gone.start.local, '2026-11-16T07:00:00-05:00');
  assert.deepEqual(sourceIds(gone), ['home', 'cancels']);
  assert.deepEqual(result.problems, []);
});

test('a cancellation record with only a UID cancels the whole series', async () => {
  const record = cancelCal(ev('UID:yoga@test.example', 'SEQUENCE:3'));
  const result = await merge({ home: live, cancels: record }, NOV);
  assert.deepEqual(result.occurrences, []);
  assert.deepEqual(result.problems, []);
  const shown = await merge({ home: live, cancels: record }, { ...NOV, includeCancelled: true });
  assert.equal(shown.occurrences.length, 4);
  assert.ok(shown.occurrences.every((o) => o.status === 'cancelled'));
});

test('a cancellation record with a lower SEQUENCE cancels nothing', async () => {
  const records = cancelCal(ev('UID:yoga@test.example', 'SEQUENCE:1'), ev('UID:yoga@test.example', 'RECURRENCE-ID;TZID=America/New_York:20261116T070000', 'SEQUENCE:1'));
  const result = await merge({ home: live, cancels: records }, NOV);
  assert.deepEqual(days(result), ['2026-11-02', '2026-11-10', '2026-11-16', '2026-11-23']);
  assert.deepEqual(result.problems, []);
});

test('a record that matches nothing adds a problem, shows nothing, and no record is called broken', async () => {
  const records = cancelCal(ev('UID:nobody@test.example', 'SEQUENCE:1'), ev('UID:yoga@test.example', 'RECURRENCE-ID;TZID=America/New_York:20261116T070000', 'SEQUENCE:3'));
  const result = await merge({ home: live, cancels: records }, { ...NOV, includeCancelled: true });
  assert.ok(result.occurrences.every((o) => o.uid === 'yoga@test.example'));
  assert.deepEqual(result.problems, ['Source "cancels", line 4: cancellation for "nobody@test.example" matches no event in any source.']);
  assert.ok(!result.problems.some((p) => p.includes('no DTSTART')));
  const statusOnly = cal(ev('UID:yoga@test.example', 'STATUS:CANCELLED', 'SEQUENCE:3'));
  const viaStatus = await merge({ home: live, cancels: statusOnly }, NOV);
  assert.deepEqual(viaStatus.occurrences, []);
  assert.deepEqual(viaStatus.problems, []);
});
