// Plan test 10: the date range.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, merge, titles } from './helpers.mjs';
import { formatAgenda } from '../src/index.mjs';

const text = cal(
  ev('UID:overnight@test.example', 'SUMMARY:Overnight shift', 'DTSTART;TZID=America/New_York:20261101T220000', 'DTEND;TZID=America/New_York:20261102T060000'),
  ev('UID:ends-at-start@test.example', 'SUMMARY:Ends at midnight', 'DTSTART;TZID=America/New_York:20261101T230000', 'DTEND;TZID=America/New_York:20261102T000000'),
  ev('UID:inside@test.example', 'SUMMARY:Breakfast', 'DTSTART;TZID=America/New_York:20261102T080000', 'DURATION:PT1H'),
);

test('an event that starts before from and ends inside shows; one that ends exactly at the start does not', async () => {
  const result = await merge({ a: text }, { from: '2026-11-02', to: '2026-11-02' });
  assert.deepEqual(titles(result), ['Overnight shift', 'Breakfast']);
  assert.match(formatAgenda(result), /Monday 2026-11-02\n {2}2026-11-01 22:00-2026-11-02 06:00 Overnight shift/);
});

test('a one-day range', async () => {
  const result = await merge({ a: text }, { from: '2026-11-01', to: '2026-11-01' });
  assert.deepEqual(titles(result), ['Overnight shift', 'Ends at midnight']);
  assert.equal(result.query.from.local, '2026-11-01T00:00:00-04:00');
  assert.equal(result.query.to.local, '2026-11-02T00:00:00-05:00');
});

test('400 included dates work and 401 are refused', async () => {
  const ok = await merge({ a: text }, { from: '2026-01-01', to: '2027-02-04' });
  assert.equal(ok.query.to.local.slice(0, 10), '2027-02-05');
  await assert.rejects(merge({ a: text }, { from: '2026-01-01', to: '2027-02-05' }), { message: 'The range covers 401 dates; at most 400 are allowed.' });
});

test('to before from, a bad date and a bad timeZone are refused with a plain message', async () => {
  await assert.rejects(merge({ a: text }, { from: '2026-11-02', to: '2026-11-01' }), { message: '"to" is before "from".' });
  await assert.rejects(merge({ a: text }, { from: '2026-02-30', to: '2026-03-01' }), { message: '"from" must be a date written YYYY-MM-DD.' });
  await assert.rejects(merge({ a: text }, { from: '2026-11-01', to: '2026-11-02', timeZone: 'Atlantis/Lost_City' }), /"Atlantis\/Lost_City" is not a time zone name/);
  await assert.rejects(merge({ a: text }, { from: '2026-11-01', to: '2026-11-02', includeCancelled: 'yes' }), { message: '"includeCancelled" must be true or false.' });
});
