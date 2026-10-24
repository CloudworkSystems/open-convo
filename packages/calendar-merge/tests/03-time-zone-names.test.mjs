// Plan test 3: time zone names.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, fixture, locals, merge } from './helpers.mjs';

test('an IANA TZID is used as it is', async () => {
  const result = await merge({ a: cal(ev('UID:berlin@test.example', 'SUMMARY:Berlin call', 'DTSTART;TZID=Europe/Berlin:20261103T100000', 'DURATION:PT1H')) }, { from: '2026-11-03', to: '2026-11-03' });
  assert.equal(result.occurrences[0].start.utc, '2026-11-03T09:00:00Z');
  assert.equal(result.occurrences[0].start.local, '2026-11-03T04:00:00-05:00');
  assert.equal(result.occurrences[0].eventTimeZone, 'Europe/Berlin');
});

test('Windows zone names with VTIMEZONE blocks, as Outlook writes them', async () => {
  const result = await merge({ work: fixture('work.ics') }, { from: '2026-11-02', to: '2026-11-05' });
  const standup = result.occurrences.find((o) => o.title === 'Team stand-up');
  assert.equal(standup.start.local, '2026-11-02T09:00:00-05:00');
  assert.equal(standup.eventTimeZone, 'America/New_York');
  const review = result.occurrences.find((o) => o.title.startsWith('Quarterly review'));
  assert.equal(review.start.utc, '2026-11-05T22:00:00Z');
  assert.equal(review.eventTimeZone, 'America/Los_Angeles');
  const quoted = await merge({ a: cal(ev('UID:quoted@test.example', 'SUMMARY:Quoted', 'DTSTART;TZID="W. Europe Standard Time":20261103T100000', 'DURATION:PT1H')) }, { from: '2026-11-03', to: '2026-11-03' });
  assert.equal(quoted.occurrences[0].eventTimeZone, 'Europe/Berlin');
  assert.equal(quoted.occurrences[0].start.utc, '2026-11-03T09:00:00Z');
});

test('an unknown TZID is not guessed: the event is skipped and listed', async () => {
  const text = cal(
    ev('UID:mars@test.example', 'SUMMARY:Rover check', 'DTSTART;TZID=Mars/Olympus_Mons:20261103T100000', 'DURATION:PT1H'),
    ev('UID:fine@test.example', 'SUMMARY:Fine', 'DTSTART:20261103T150000Z', 'DURATION:PT1H'),
  );
  const result = await merge({ lab: text }, { from: '2026-11-03', to: '2026-11-03' });
  assert.deepEqual(result.occurrences.map((o) => o.title), ['Fine']);
  assert.deepEqual(result.problems, ['Source "lab", line 4: event "mars@test.example" skipped: unknown time zone "Mars/Olympus_Mons".']);
});

test('a UTC time and a floating time', async () => {
  const text = cal(
    ev('UID:utc@test.example', 'SUMMARY:UTC', 'DTSTART:20261103T150000Z', 'DURATION:PT1H'),
    ev('UID:floating@test.example', 'SUMMARY:Floating', 'DTSTART:20261103T090000', 'DURATION:PT1H'),
  );
  const ny = await merge({ a: text }, { from: '2026-11-03', to: '2026-11-03' });
  const utc = ny.occurrences.find((o) => o.title === 'UTC');
  assert.equal(utc.start.local, '2026-11-03T10:00:00-05:00');
  assert.equal(utc.floating, false);
  const floating = ny.occurrences.find((o) => o.title === 'Floating');
  assert.equal(floating.start.local, '2026-11-03T09:00:00-05:00');
  assert.equal(floating.floating, true);
  assert.equal(floating.eventTimeZone, null);
  const tokyo = await merge({ a: text }, { from: '2026-11-03', to: '2026-11-03', timeZone: 'Asia/Tokyo' });
  assert.equal(tokyo.occurrences.find((o) => o.title === 'Floating').start.local, '2026-11-03T09:00:00+09:00');
  assert.equal(tokyo.occurrences.find((o) => o.title === 'Floating').key, ny.occurrences.find((o) => o.title === 'Floating').key);
  // 15:00Z is already 00:00 on November 4 in Tokyo.
  assert.deepEqual(locals(tokyo), ['2026-11-03T09:00:00+09:00']);
});
