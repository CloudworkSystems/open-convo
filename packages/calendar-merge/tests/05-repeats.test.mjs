// Plan test 5: repeat rules. Several cases are RFC 5545's own examples.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, merge } from './helpers.mjs';

const series = (dtstart, rrule, extra = []) => cal(ev('UID:series@test.example', 'SUMMARY:Series', dtstart, 'DURATION:PT1H', `RRULE:${rrule}`, ...extra));
const dates = (result) => result.occurrences.map((o) => (o.allDay ? o.start : o.start.local.slice(0, 10)));

test('daily with COUNT (RFC 5545 example)', async () => {
  const result = await merge({ a: series('DTSTART;TZID=America/New_York:19970902T090000', 'FREQ=DAILY;COUNT=10') }, { from: '1997-09-01', to: '1997-09-30' });
  assert.deepEqual(dates(result), ['02', '03', '04', '05', '06', '07', '08', '09', '10', '11'].map((d) => `1997-09-${d}`));
});

test('weekly with BYDAY=MO,WE,FR and INTERVAL=2 (RFC 5545 example, UNTIL as a UTC time)', async () => {
  const result = await merge({ a: series('DTSTART;TZID=America/New_York:19970901T090000', 'FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU;BYDAY=MO,WE,FR') }, { from: '1997-09-01', to: '1997-12-31' });
  assert.deepEqual(dates(result), [
    '1997-09-01', '1997-09-03', '1997-09-05', '1997-09-15', '1997-09-17', '1997-09-19', '1997-09-29',
    '1997-10-01', '1997-10-03', '1997-10-13', '1997-10-15', '1997-10-17', '1997-10-27', '1997-10-29', '1997-10-31',
    '1997-11-10', '1997-11-12', '1997-11-14', '1997-11-24', '1997-11-26', '1997-11-28',
    '1997-12-08', '1997-12-10', '1997-12-12', '1997-12-22',
  ]);
  assert.ok(result.occurrences.every((o) => o.start.local.slice(11, 19) === '09:00:00'));
});

test('monthly on BYMONTHDAY=31 skips short months; -1 is the last day of each month', async () => {
  const on31 = await merge({ a: series('DTSTART;VALUE=DATE:20260131', 'FREQ=MONTHLY;BYMONTHDAY=31').replace('DURATION:PT1H\r\n', '') }, { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(dates(on31), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31', '2026-08-31', '2026-10-31', '2026-12-31']);
  const last = await merge({ a: series('DTSTART;TZID=America/New_York:20260131T180000', 'FREQ=MONTHLY;BYMONTHDAY=-1') }, { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(dates(last), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31']);
});

test('monthly on 2TU and -1FR', async () => {
  const second = await merge({ a: series('DTSTART;TZID=America/New_York:20260113T190000', 'FREQ=MONTHLY;BYDAY=2TU') }, { from: '2026-01-01', to: '2026-06-30' });
  assert.deepEqual(dates(second), ['2026-01-13', '2026-02-10', '2026-03-10', '2026-04-14', '2026-05-12', '2026-06-09']);
  const lastFriday = await merge({ a: series('DTSTART;TZID=America/New_York:20260130T170000', 'FREQ=MONTHLY;BYDAY=-1FR') }, { from: '2026-01-01', to: '2026-06-30' });
  assert.deepEqual(dates(lastFriday), ['2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24', '2026-05-29', '2026-06-26']);
});

test('yearly on February 29 shows in leap years only', async () => {
  const text = cal(ev('UID:leap@test.example', 'SUMMARY:Leap day party', 'DTSTART;VALUE=DATE:20240229', 'RRULE:FREQ=YEARLY'));
  for (const year of ['2025', '2026', '2027']) {
    const result = await merge({ a: text }, { from: `${year}-01-01`, to: `${year}-12-31` });
    assert.deepEqual(dates(result), []);
  }
  const leap = await merge({ a: text }, { from: '2028-01-01', to: '2028-12-31' });
  assert.deepEqual(dates(leap), ['2028-02-29']);
});

test('BYSETPOS=-1 gives the last weekday of the month', async () => {
  const result = await merge({ a: series('DTSTART;TZID=America/New_York:20260130T160000', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1') }, { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(dates(result), ['2026-01-30', '2026-02-27', '2026-03-31', '2026-04-30', '2026-05-29', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-30', '2026-11-30', '2026-12-31']);
});

test('UNTIL as a date, a UTC time and a local time is inclusive', async () => {
  const start = 'DTSTART;TZID=America/New_York:20261102T090000';
  const range = { from: '2026-11-01', to: '2026-11-30' };
  const expected = ['2026-11-02', '2026-11-09', '2026-11-16'];
  assert.deepEqual(dates(await merge({ a: series(start, 'FREQ=WEEKLY;UNTIL=20261116') }, range)), expected);
  assert.deepEqual(dates(await merge({ a: series(start, 'FREQ=WEEKLY;UNTIL=20261116T140000Z') }, range)), expected);
  assert.deepEqual(dates(await merge({ a: series(start, 'FREQ=WEEKLY;UNTIL=20261116T135959Z') }, range)), expected.slice(0, 2));
  assert.deepEqual(dates(await merge({ a: series('DTSTART:20261102T090000', 'FREQ=WEEKLY;UNTIL=20261116T090000') }, range)), expected);
});

test('WKST=SU changes a two-weekly result (RFC 5545 example)', async () => {
  const range = { from: '1997-08-01', to: '1997-09-30' };
  const monday = await merge({ a: series('DTSTART;TZID=America/New_York:19970805T090000', 'FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO') }, range);
  assert.deepEqual(dates(monday), ['1997-08-05', '1997-08-10', '1997-08-19', '1997-08-24']);
  const sunday = await merge({ a: series('DTSTART;TZID=America/New_York:19970805T090000', 'FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU') }, range);
  assert.deepEqual(dates(sunday), ['1997-08-05', '1997-08-17', '1997-08-19', '1997-08-31']);
});
