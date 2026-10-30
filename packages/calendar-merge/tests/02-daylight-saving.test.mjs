// Plan test 2: daylight saving in America/New_York and Europe/London.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, locals, merge, utcs } from './helpers.mjs';

const weekly = (zone, start) => cal(ev('UID:weekly@test.example', 'SUMMARY:Weekly meeting', `DTSTART;TZID=${zone}:${start}`, 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY'));

test('a weekly 9:00 New York meeting stays at 9:00 local across both changes', async () => {
  const fall = await merge({ work: weekly('America/New_York', '20261026T090000') }, { from: '2026-10-26', to: '2026-11-09' });
  assert.deepEqual(locals(fall), ['2026-10-26T09:00:00-04:00', '2026-11-02T09:00:00-05:00', '2026-11-09T09:00:00-05:00']);
  assert.deepEqual(utcs(fall), ['2026-10-26T13:00:00Z', '2026-11-02T14:00:00Z', '2026-11-09T14:00:00Z']);
  const spring = await merge({ work: weekly('America/New_York', '20260302T090000') }, { from: '2026-03-02', to: '2026-03-09' });
  assert.deepEqual(locals(spring), ['2026-03-02T09:00:00-05:00', '2026-03-09T09:00:00-04:00']);
  assert.deepEqual(utcs(spring), ['2026-03-02T14:00:00Z', '2026-03-09T13:00:00Z']);
});

test('a weekly 9:00 London meeting stays at 9:00 local across both changes', async () => {
  const q = { timeZone: 'Europe/London' };
  const fall = await merge({ work: weekly('Europe/London', '20261019T090000') }, { ...q, from: '2026-10-19', to: '2026-10-26' });
  assert.deepEqual(locals(fall), ['2026-10-19T09:00:00+01:00', '2026-10-26T09:00:00+00:00']);
  assert.deepEqual(utcs(fall), ['2026-10-19T08:00:00Z', '2026-10-26T09:00:00Z']);
  const spring = await merge({ work: weekly('Europe/London', '20260323T090000') }, { ...q, from: '2026-03-23', to: '2026-03-30' });
  assert.deepEqual(locals(spring), ['2026-03-23T09:00:00+00:00', '2026-03-30T09:00:00+01:00']);
  assert.deepEqual(utcs(spring), ['2026-03-23T09:00:00Z', '2026-03-30T08:00:00Z']);
});

test('a time the clocks skip lands after the gap (New York 2:30 -> 3:30, London 1:30 -> 2:30)', async () => {
  const ny = await merge({ a: cal(ev('UID:gap-ny@test.example', 'SUMMARY:Gap', 'DTSTART;TZID=America/New_York:20260308T023000', 'DURATION:PT30M')) }, { from: '2026-03-08', to: '2026-03-08' });
  assert.deepEqual(locals(ny), ['2026-03-08T03:30:00-04:00']);
  assert.deepEqual(utcs(ny), ['2026-03-08T07:30:00Z']);
  const london = await merge({ a: cal(ev('UID:gap-ldn@test.example', 'SUMMARY:Gap', 'DTSTART;TZID=Europe/London:20260329T013000', 'DURATION:PT30M')) }, { from: '2026-03-29', to: '2026-03-29', timeZone: 'Europe/London' });
  assert.deepEqual(locals(london), ['2026-03-29T02:30:00+01:00']);
  assert.deepEqual(utcs(london), ['2026-03-29T01:30:00Z']);
});

test('a time that happens twice is the first one', async () => {
  const ny = await merge({ a: cal(ev('UID:twice-ny@test.example', 'SUMMARY:Twice', 'DTSTART;TZID=America/New_York:20261101T013000', 'DURATION:PT15M')) }, { from: '2026-11-01', to: '2026-11-01' });
  assert.deepEqual(locals(ny), ['2026-11-01T01:30:00-04:00']);
  assert.deepEqual(utcs(ny), ['2026-11-01T05:30:00Z']);
  const london = await merge({ a: cal(ev('UID:twice-ldn@test.example', 'SUMMARY:Twice', 'DTSTART;TZID=Europe/London:20261025T013000', 'DURATION:PT15M')) }, { from: '2026-10-25', to: '2026-10-25', timeZone: 'Europe/London' });
  assert.deepEqual(locals(london), ['2026-10-25T01:30:00+01:00']);
  assert.deepEqual(utcs(london), ['2026-10-25T00:30:00Z']);
});

test('a UTC event shows the right local time on both sides of the change', async () => {
  const text = cal(
    ev('UID:utc-1@test.example', 'SUMMARY:Before', 'DTSTART:20261031T130000Z', 'DURATION:PT1H'),
    ev('UID:utc-2@test.example', 'SUMMARY:After', 'DTSTART:20261102T140000Z', 'DURATION:PT1H'),
    ev('UID:utc-3@test.example', 'SUMMARY:Before', 'DTSTART:20261024T080000Z', 'DURATION:PT1H'),
    ev('UID:utc-4@test.example', 'SUMMARY:After', 'DTSTART:20261026T090000Z', 'DURATION:PT1H'),
  );
  const ny = await merge({ a: text }, { from: '2026-10-31', to: '2026-11-02' });
  assert.deepEqual(locals(ny), ['2026-10-31T09:00:00-04:00', '2026-11-02T09:00:00-05:00']);
  const london = await merge({ a: text }, { from: '2026-10-24', to: '2026-10-26', timeZone: 'Europe/London' });
  assert.deepEqual(locals(london), ['2026-10-24T09:00:00+01:00', '2026-10-26T09:00:00+00:00']);
});

test('a New York calendar viewed from Tokyo and Auckland gives the right local times and days', async () => {
  const text = cal(
    ev('UID:ny-morning@test.example', 'SUMMARY:Morning call', 'DTSTART;TZID=America/New_York:20261102T090000', 'DURATION:PT1H'),
    ev('UID:ny-evening@test.example', 'SUMMARY:Evening call', 'DTSTART;TZID=America/New_York:20261102T210000', 'DURATION:PT1H'),
  );
  const tokyo = await merge({ a: text }, { from: '2026-11-02', to: '2026-11-03', timeZone: 'Asia/Tokyo' });
  assert.deepEqual(locals(tokyo), ['2026-11-02T23:00:00+09:00', '2026-11-03T11:00:00+09:00']);
  const tokyoDay = await merge({ a: text }, { from: '2026-11-03', to: '2026-11-03', timeZone: 'Asia/Tokyo' });
  assert.deepEqual(tokyoDay.occurrences.map((o) => o.title), ['Evening call']);
  const auckland = await merge({ a: text }, { from: '2026-11-03', to: '2026-11-03', timeZone: 'Pacific/Auckland' });
  assert.deepEqual(locals(auckland), ['2026-11-03T03:00:00+13:00', '2026-11-03T15:00:00+13:00']);
  assert.equal(auckland.occurrences[0].eventTimeZone, 'America/New_York');
});
