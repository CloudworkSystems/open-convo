// Plan test 6: EXDATE, RDATE and changed occurrences.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, merge, titles } from './helpers.mjs';

const days = (result) => result.occurrences.map((o) => o.start.local.slice(0, 10));

test('EXDATE as one line, several lines and a comma list removes exactly those occurrences', async () => {
  const text = cal(ev(
    'UID:daily@test.example', 'SUMMARY:Walk the dog', 'DTSTART;TZID=America/New_York:20261101T090000', 'DURATION:PT30M',
    'RRULE:FREQ=DAILY;COUNT=10',
    'EXDATE;TZID=America/New_York:20261102T090000',
    'EXDATE;TZID=America/New_York:20261104T090000',
    'EXDATE;TZID=America/New_York:20261105T090000',
    'EXDATE;TZID=America/New_York:20261107T090000,20261108T090000',
    'EXDATE:20261109T140000Z',
  ));
  const result = await merge({ a: text }, { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(days(result), ['2026-11-01', '2026-11-03', '2026-11-06', '2026-11-10']);
});

test('RDATE adds an occurrence', async () => {
  const text = cal(ev('UID:club@test.example', 'SUMMARY:Book club', 'DTSTART;TZID=America/New_York:20261102T190000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=2', 'RDATE;TZID=America/New_York:20261105T190000'));
  const result = await merge({ a: text }, { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(days(result), ['2026-11-02', '2026-11-05', '2026-11-09']);
  assert.equal(result.occurrences[1].start.local, '2026-11-05T19:00:00-05:00');
});

const weekly = [
  'UID:weekly@test.example', 'SUMMARY:Planning', 'DTSTART;TZID=America/New_York:20261102T100000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY', 'DTSTAMP:20261001T000000Z',
];

test('a changed occurrence moves one meeting to another time and title', async () => {
  const text = cal(ev(...weekly), ev(
    'UID:weekly@test.example', 'RECURRENCE-ID;TZID=America/New_York:20261109T100000', 'SUMMARY:Planning (moved)',
    'DTSTART;TZID=America/New_York:20261110T140000', 'DURATION:PT1H', 'SEQUENCE:1',
  ));
  const result = await merge({ a: text }, { from: '2026-11-08', to: '2026-11-14' });
  assert.equal(result.occurrences.length, 1);
  const [moved] = result.occurrences;
  assert.equal(moved.title, 'Planning (moved)');
  assert.equal(moved.start.local, '2026-11-10T14:00:00-05:00');
  assert.equal(moved.isChanged, true);
  assert.equal(moved.key, 'weekly@test.example/2026-11-09T15:00:00Z');
});

test('one moved into the range shows; one moved out of it does not', async () => {
  const text = cal(
    ev(...weekly),
    ev('UID:weekly@test.example', 'RECURRENCE-ID;TZID=America/New_York:20261207T100000', 'SUMMARY:Planning (early)', 'DTSTART;TZID=America/New_York:20261111T100000', 'DURATION:PT1H', 'SEQUENCE:1'),
    ev('UID:weekly@test.example', 'RECURRENCE-ID;TZID=America/New_York:20261109T100000', 'SUMMARY:Planning (late)', 'DTSTART;TZID=America/New_York:20261201T100000', 'DURATION:PT1H', 'SEQUENCE:1'),
  );
  const result = await merge({ a: text }, { from: '2026-11-08', to: '2026-11-14' });
  assert.deepEqual(titles(result), ['Planning (early)']);
  const december = await merge({ a: text }, { from: '2026-11-30', to: '2026-12-06' });
  assert.deepEqual(titles(december), ['Planning', 'Planning (late)']);
});

test('a cancelled occurrence is gone, and shown as cancelled with includeCancelled', async () => {
  const text = cal(ev(...weekly), ev('UID:weekly@test.example', 'RECURRENCE-ID;TZID=America/New_York:20261109T100000', 'SUMMARY:Planning', 'DTSTART;TZID=America/New_York:20261109T100000', 'DURATION:PT1H', 'STATUS:CANCELLED', 'SEQUENCE:1'));
  const result = await merge({ a: text }, { from: '2026-11-01', to: '2026-11-16' });
  assert.deepEqual(days(result), ['2026-11-02', '2026-11-16']);
  const shown = await merge({ a: text }, { from: '2026-11-01', to: '2026-11-16', includeCancelled: true });
  assert.deepEqual(shown.occurrences.map((o) => [o.start.local.slice(0, 10), o.status]), [['2026-11-02', 'confirmed'], ['2026-11-09', 'cancelled'], ['2026-11-16', 'confirmed']]);
});
