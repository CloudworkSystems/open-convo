// Plan test 4: all-day events.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, merge } from './helpers.mjs';

const text = cal(
  ev('UID:one-day@test.example', 'SUMMARY:Thanksgiving', 'DTSTART;VALUE=DATE:20261126', 'DTEND;VALUE=DATE:20261127'),
  ev('UID:trip@test.example', 'SUMMARY:Lake trip', 'DTSTART;VALUE=DATE:20261124', 'DTEND;VALUE=DATE:20261128'),
  ev('UID:no-end@test.example', 'SUMMARY:Library books due', 'DTSTART;VALUE=DATE:20261125'),
  ev('UID:birthday@test.example', 'SUMMARY:Wren Calloway birthday', 'DTSTART;VALUE=DATE:19900612', 'RRULE:FREQ=YEARLY'),
  ev('UID:clock-change@test.example', 'SUMMARY:Clocks change', 'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261102'),
);
const find = (result, title) => result.occurrences.find((o) => o.title === title);

test('one day, several days with the exclusive end, and no end', async () => {
  const result = await merge({ a: text }, { from: '2026-11-24', to: '2026-11-30' });
  assert.deepEqual([find(result, 'Thanksgiving').start, find(result, 'Thanksgiving').end], ['2026-11-26', '2026-11-27']);
  assert.deepEqual([find(result, 'Lake trip').start, find(result, 'Lake trip').end], ['2026-11-24', '2026-11-28']);
  assert.deepEqual([find(result, 'Library books due').start, find(result, 'Library books due').end], ['2026-11-25', '2026-11-26']);
  assert.equal(find(result, 'Thanksgiving').allDay, true);
  const lastDay = await merge({ a: text }, { from: '2026-11-27', to: '2026-11-27' });
  assert.ok(find(lastDay, 'Lake trip'));
  const dayAfter = await merge({ a: text }, { from: '2026-11-28', to: '2026-11-28' });
  assert.equal(find(dayAfter, 'Lake trip'), undefined);
  assert.equal(find(dayAfter, 'Thanksgiving'), undefined);
});

test('a repeating birthday', async () => {
  const result = await merge({ a: text }, { from: '2026-06-01', to: '2026-06-30' });
  assert.deepEqual(result.occurrences.map((o) => [o.title, o.start, o.end, o.isRepeat]), [['Wren Calloway birthday', '2026-06-12', '2026-06-13', true]]);
});

test('all-day events show on the same dates in Los Angeles and Tokyo, with the same keys', async () => {
  const la = await merge({ a: text }, { from: '2026-11-20', to: '2026-11-30', timeZone: 'America/Los_Angeles' });
  const tokyo = await merge({ a: text }, { from: '2026-11-20', to: '2026-11-30', timeZone: 'Asia/Tokyo' });
  const pick = (r) => r.occurrences.map((o) => [o.key, o.title, o.start, o.end]);
  assert.deepEqual(pick(la), pick(tokyo));
  assert.equal(find(la, 'Thanksgiving').key, 'one-day@test.example/2026-11-26');
});

test('an all-day event never moves with daylight saving', async () => {
  for (const timeZone of ['America/New_York', 'Europe/London', 'Pacific/Auckland']) {
    const day = await merge({ a: text }, { from: '2026-11-01', to: '2026-11-01', timeZone });
    assert.deepEqual([find(day, 'Clocks change').start, find(day, 'Clocks change').end], ['2026-11-01', '2026-11-02']);
    const before = await merge({ a: text }, { from: '2026-10-31', to: '2026-10-31', timeZone });
    const after = await merge({ a: text }, { from: '2026-11-02', to: '2026-11-02', timeZone });
    assert.equal(find(before, 'Clocks change'), undefined);
    assert.equal(find(after, 'Clocks change'), undefined);
  }
});
