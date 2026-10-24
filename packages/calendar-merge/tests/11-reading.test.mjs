// Plan test 11: reading .ics text.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, merge, sourceIds, titles } from './helpers.mjs';
import { formatAgenda, mergeCalendars } from '../src/index.mjs';

const NOV = { from: '2026-11-01', to: '2026-11-30' };

test('folded lines (space and tab), LF-only files, escaped text and quoted parameters', async () => {
  const text = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:fold@test.example',
    'SUMMARY:A very long ti', ' tle folded with a space and', '\t a tab',
    'LOCATION:Hall 2\\, Annex\; back door\\\\side\\nsecond line',
    'DTSTART;TZID="America/New_York":20261103T100000', 'DURATION:PT1H',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\n');
  const result = await merge({ a: text }, NOV);
  assert.equal(result.occurrences[0].title, 'A very long title folded with a space and a tab');
  assert.equal(result.occurrences[0].location, 'Hall 2, Annex; back door\\side\nsecond line');
  assert.equal(result.occurrences[0].start.local, '2026-11-03T10:00:00-05:00');
});

test('DURATION instead of DTEND, and lower-case property names', async () => {
  const text = cal(['begin:vevent', 'uid:lower@test.example', 'summary:Lower case', 'dtstart;tzid=America/New_York:20261103T100000', 'duration:PT1H30M', 'end:vevent']);
  const result = await merge({ a: text }, NOV);
  assert.equal(result.occurrences[0].title, 'Lower case');
  assert.equal(result.occurrences[0].end.local, '2026-11-03T11:30:00-05:00');
});

test('an event with no SUMMARY has an empty title, shows as (No title), and matches another untitled event', async () => {
  const a = cal(ev('UID:untitled-a@test.example', 'DTSTART;TZID=America/New_York:20261103T100000', 'DURATION:PT1H'));
  const b = cal(ev('UID:untitled-b@test.example', 'DTSTART;TZID=America/New_York:20261103T100000', 'DURATION:PT1H'));
  const result = await merge({ a, b }, NOV);
  assert.equal(result.occurrences.length, 1);
  assert.equal(result.occurrences[0].title, '');
  assert.equal(result.occurrences[0].matchedBy, 'title-and-time');
  assert.deepEqual(sourceIds(result.occurrences[0]), ['a', 'b']);
  assert.match(formatAgenda(result), /10:00-11:00 +\(No title\) {2}\[a, b\]/);
});

test('a timed event with no DTEND or DURATION ends at its start', async () => {
  const atStart = cal(ev('UID:point@test.example', 'SUMMARY:Reminder', 'DTSTART;TZID=America/New_York:20261103T000000'));
  const shown = await merge({ a: atStart }, { from: '2026-11-03', to: '2026-11-03' });
  assert.equal(shown.occurrences[0].start.utc, shown.occurrences[0].end.utc);
  const atEnd = await merge({ a: atStart }, { from: '2026-11-02', to: '2026-11-02' });
  assert.deepEqual(atEnd.occurrences, []);
});

test('broken events are skipped and listed with their line numbers; the rest of the file still shows', async () => {
  const text = cal(
    ev('UID:no-start@test.example', 'SUMMARY:No start'),
    ev('UID:backwards@test.example', 'SUMMARY:Backwards', 'DTSTART:20261103T100000Z', 'DTEND:20261103T090000Z'),
    ev('UID:bad-date@test.example', 'SUMMARY:Bad date', 'DTSTART:20261303T100000Z'),
    ev('UID:good@test.example', 'SUMMARY:Good', 'DTSTART:20261103T150000Z', 'DURATION:PT1H'),
  );
  const result = await merge({ a: text }, NOV);
  assert.deepEqual(titles(result), ['Good']);
  assert.deepEqual(result.problems, [
    'Source "a", line 4: event "no-start@test.example" skipped: no DTSTART.',
    'Source "a", line 8: event "backwards@test.example" skipped: it ends before it starts.',
    'Source "a", line 14: event "bad-date@test.example" skipped: DTSTART is not a readable date.',
  ]);
});

test('refusals: no BEGIN:VCALENDAR, a source over 5 MB, more than 20 sources, a repeated id', async () => {
  const good = cal(ev('UID:g@test.example', 'SUMMARY:G', 'DTSTART:20261103T150000Z'));
  const query = { ...NOV, timeZone: 'America/New_York' };
  await assert.rejects(mergeCalendars([{ id: 'loose', name: 'Loose', ics: 'BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\n' }], query), { message: 'Calendar "loose" has no BEGIN:VCALENDAR.' });
  const big = good.replace('END:VCALENDAR', `X-PAD:${'x'.repeat(5 * 1024 * 1024)}\r\nEND:VCALENDAR`);
  await assert.rejects(mergeCalendars([{ id: 'big', name: 'Big', ics: big }], query), { message: 'Calendar "big" is over 5 MB.' });
  const multiByte = good.replace('END:VCALENDAR', `X-PAD:${'é'.repeat(2.6 * 1024 * 1024)}\r\nEND:VCALENDAR`);
  await assert.rejects(mergeCalendars([{ id: 'wide', name: 'Wide', ics: multiByte }], query), { message: 'Calendar "wide" is over 5 MB.' });
  const many = Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, ics: good }));
  await assert.rejects(mergeCalendars(many, query), { message: 'Too many calendars: 21 given, at most 20.' });
  assert.equal((await mergeCalendars(many.slice(0, 20), query)).occurrences.length, 1);
  await assert.rejects(mergeCalendars([{ id: 'x', name: 'X', ics: good }, { id: 'x', name: 'Y', ics: good }], query), { message: 'Calendar id "x" is used twice; each id must be unique.' });
  await assert.rejects(mergeCalendars([{ id: '', name: 'X', ics: good }], query), /needs an id of 1 to 40 characters/);
  await assert.rejects(mergeCalendars([{ id: 'x'.repeat(41), name: 'X', ics: good }], query), /needs an id of 1 to 40 characters/);
});
