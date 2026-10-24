// Edge cases the plan doesn't name, decided by RFC 5545's defaults. Each one
// is listed in the README's "Edge cases" section under the same number.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, merge, sourceIds, titles } from './helpers.mjs';
import { formatAgenda } from '../src/index.mjs';
import { parseContentLine } from '../src/ics.mjs';
import { decodeIcs, run } from '../src/merge.mjs';

const NOV = { from: '2026-11-01', to: '2026-11-30' };
const NY = (time) => `DTSTART;TZID=America/New_York:${time}`;
const days = (result) => result.occurrences.map((o) => (o.allDay ? o.start : o.start.local.slice(0, 10)));

test('E1: DTSTART always counts as the first occurrence, even off the rule', async () => {
  // DTSTART is a Tuesday; the rule says Mondays.
  const result = await merge({ a: cal(ev('UID:e1@test.example', 'SUMMARY:E1', NY('20261103T090000'), 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3')) }, NOV);
  assert.deepEqual(days(result), ['2026-11-03', '2026-11-09', '2026-11-16']);
});

test('E2: a rule the standard does not allow is treated as not supported', async () => {
  for (const rule of ['FREQ=DAILY;COUNT=3;UNTIL=20261130T000000Z', 'FREQ=WEEKLY;BYMONTHDAY=3', 'FREQ=WEEKLY;BYDAY=1MO', 'FREQ=MONTHLY;BYSETPOS=1', 'FREQ=DAILY;X-FOO=1', 'FREQ=DAILY;INTERVAL=0']) {
    const result = await merge({ a: cal(ev('UID:e2@test.example', 'SUMMARY:E2', NY('20261103T090000'), `RRULE:${rule}`)) }, NOV);
    assert.deepEqual(result.occurrences.map((o) => [o.start.local, o.repeatNotSupported]), [['2026-11-03T09:00:00-05:00', true]], rule);
    assert.equal(result.problems.length, 1, rule);
  }
});

test('E3: only the first RRULE is used', async () => {
  const result = await merge({ a: cal(ev('UID:e3@test.example', 'SUMMARY:E3', NY('20261103T090000'), 'RRULE:FREQ=DAILY;COUNT=2', 'RRULE:FREQ=WEEKLY;COUNT=5')) }, NOV);
  assert.deepEqual(days(result), ['2026-11-03', '2026-11-04']);
});

test('E4: with both DTEND and DURATION, DTEND is used', async () => {
  const result = await merge({ a: cal(ev('UID:e4@test.example', 'SUMMARY:E4', NY('20261103T090000'), 'DTEND;TZID=America/New_York:20261103T093000', 'DURATION:PT2H')) }, NOV);
  assert.equal(result.occurrences[0].end.local, '2026-11-03T09:30:00-05:00');
});

test('E5: an all-day DTEND equal to DTSTART, or DURATION:P0D, lasts one day', async () => {
  const result = await merge({ a: cal(
    ev('UID:e5a@test.example', 'SUMMARY:E5a', 'DTSTART;VALUE=DATE:20261103', 'DTEND;VALUE=DATE:20261103'),
    ev('UID:e5b@test.example', 'SUMMARY:E5b', 'DTSTART;VALUE=DATE:20261104', 'DURATION:P0D'),
  ) }, NOV);
  assert.deepEqual(result.occurrences.map((o) => [o.start, o.end]), [['2026-11-03', '2026-11-04'], ['2026-11-04', '2026-11-05']]);
});

test('E6: mixed date types and part-day all-day durations are unreadable', async () => {
  const result = await merge({ a: cal(
    ev('UID:e6a@test.example', 'SUMMARY:E6a', 'DTSTART;VALUE=DATE:20261103', 'DTEND:20261104T120000Z'),
    ev('UID:e6b@test.example', 'SUMMARY:E6b', 'DTSTART;VALUE=DATE:20261103', 'DURATION:PT12H'),
  ) }, NOV);
  assert.deepEqual(result.occurrences, []);
  assert.deepEqual(result.problems.map((p) => p.replace(/^.*skipped: /, '')), ['DTEND and DTSTART are not both dates or both date-times.', 'the DURATION of an all-day event is not whole days.']);
});

test('E7: DURATION days follow local time, hours are exact; DTEND gives every occurrence the same exact length', async () => {
  const result = await merge({ a: cal(
    ev('UID:e7a@test.example', 'SUMMARY:Day', NY('20261031T090000'), 'DURATION:P1D'),
    ev('UID:e7b@test.example', 'SUMMARY:Hours', NY('20261031T090000'), 'DURATION:PT24H'),
    ev('UID:e7c@test.example', 'SUMMARY:Exact', NY('20261031T090000'), 'DTEND;TZID=America/New_York:20261101T090000', 'RRULE:FREQ=DAILY;COUNT=2'),
  ) }, { from: '2026-10-31', to: '2026-11-02' });
  const end = (title) => result.occurrences.filter((o) => o.title === title).map((o) => o.end.local);
  assert.deepEqual(end('Day'), ['2026-11-01T09:00:00-05:00']);
  assert.deepEqual(end('Hours'), ['2026-11-01T08:00:00-05:00']);
  // DTEND makes the first occurrence 25 hours long (the clocks went back), so every occurrence lasts 25 hours.
  assert.deepEqual(end('Exact'), ['2026-11-01T09:00:00-05:00', '2026-11-02T10:00:00-05:00']);
});

test('E8: an EXDATE written as a date removes that date\'s occurrences', async () => {
  const result = await merge({ a: cal(ev('UID:e8@test.example', 'SUMMARY:E8', NY('20261102T090000'), 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;VALUE=DATE:20261103')) }, NOV);
  assert.deepEqual(days(result), ['2026-11-02', '2026-11-04']);
});

test('E9: an RDATE of the wrong type is skipped with a problem; RDATE periods are read', async () => {
  const result = await merge({ a: cal(ev(
    'UID:e9@test.example', 'SUMMARY:E9', NY('20261102T090000'), 'DURATION:PT1H',
    'RDATE;VALUE=DATE:20261105',
    'RDATE;VALUE=PERIOD:20261106T150000Z/20261106T170000Z,20261107T150000Z/PT30M',
  )) }, NOV);
  assert.deepEqual(result.occurrences.map((o) => [o.start.utc, o.end.utc]), [
    ['2026-11-02T14:00:00Z', '2026-11-02T15:00:00Z'],
    ['2026-11-06T15:00:00Z', '2026-11-06T17:00:00Z'],
    ['2026-11-07T15:00:00Z', '2026-11-07T15:30:00Z'],
  ]);
  assert.deepEqual(result.problems, ['Source "a", line 4: RDATE "20261105" skipped: it is a date on a timed event.']);
});

test('E10: an EXDATE does not hide a changed copy of the same occurrence', async () => {
  const result = await merge({ a: cal(
    ev('UID:e10@test.example', 'SUMMARY:E10', NY('20261102T090000'), 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;TZID=America/New_York:20261103T090000'),
    ev('UID:e10@test.example', 'SUMMARY:E10 moved', 'RECURRENCE-ID;TZID=America/New_York:20261103T090000', NY('20261103T110000')),
  ) }, NOV);
  assert.deepEqual(titles(result), ['E10', 'E10 moved', 'E10']);
});

test('E11: a RECURRENCE-ID of another value type matches no occurrence and shows on its own', async () => {
  const result = await merge({ a: cal(
    ev('UID:e11@test.example', 'SUMMARY:E11', NY('20261102T090000'), 'RRULE:FREQ=DAILY;COUNT=2'),
    ev('UID:e11@test.example', 'SUMMARY:E11 changed', 'RECURRENCE-ID;VALUE=DATE:20261103', NY('20261103T110000')),
  ) }, NOV);
  assert.deepEqual(titles(result), ['E11', 'E11', 'E11 changed']);
});

test('E12: floating RECURRENCE-ID, EXDATE, RDATE and UNTIL are read in the event\'s own zone', async () => {
  const result = await merge({ a: cal(
    ev('UID:e12@test.example', 'SUMMARY:E12', 'DTSTART;TZID=Europe/Paris:20261102T090000', 'RRULE:FREQ=DAILY;UNTIL=20261106T090000', 'EXDATE:20261103T090000', 'RDATE:20261110T090000'),
    ev('UID:e12@test.example', 'SUMMARY:E12 moved', 'RECURRENCE-ID:20261104T090000', 'DTSTART;TZID=Europe/Paris:20261104T100000'),
  ) }, { ...NOV, timeZone: 'Europe/Paris' });
  assert.deepEqual(result.occurrences.map((o) => [o.title, o.start.local]), [
    ['E12', '2026-11-02T09:00:00+01:00'],
    ['E12 moved', '2026-11-04T10:00:00+01:00'],
    ['E12', '2026-11-05T09:00:00+01:00'],
    ['E12', '2026-11-06T09:00:00+01:00'],
    ['E12', '2026-11-10T09:00:00+01:00'],
  ]);
  const fromNy = await merge({ a: cal(ev('UID:e12@test.example', 'SUMMARY:E12', 'DTSTART;TZID=Europe/Paris:20261102T090000', 'RRULE:FREQ=DAILY;UNTIL=20261103T090000')) }, NOV);
  assert.equal(fromNy.occurrences.length, 2);
});

test('E13: UNTIL as a date includes that whole date in the event\'s zone; on an all-day series a date-time UNTIL counts by its written date', async () => {
  const timed = await merge({ a: cal(ev('UID:e13a@test.example', 'SUMMARY:E13a', NY('20261102T230000'), 'RRULE:FREQ=DAILY;UNTIL=20261103')) }, NOV);
  assert.deepEqual(days(timed), ['2026-11-02', '2026-11-03']);
  const allDay = await merge({ a: cal(ev('UID:e13b@test.example', 'SUMMARY:E13b', 'DTSTART;VALUE=DATE:20261102', 'RRULE:FREQ=DAILY;UNTIL=20261103T235959Z')) }, NOV);
  assert.deepEqual(days(allDay), ['2026-11-02', '2026-11-03']);
});

test('E14: STATUS values ignore case; an unknown STATUS is confirmed', async () => {
  const result = await merge({ a: cal(
    ev('UID:e14a@test.example', 'SUMMARY:E14a', NY('20261103T090000'), 'STATUS:tentative'),
    ev('UID:e14b@test.example', 'SUMMARY:E14b', NY('20261103T100000'), 'STATUS:X-MAYBE'),
    ev('UID:e14c@test.example', 'SUMMARY:E14c', NY('20261103T110000'), 'STATUS:Cancelled'),
  ) }, NOV);
  assert.deepEqual(result.occurrences.map((o) => [o.title, o.status]), [['E14a', 'tentative'], ['E14b', 'confirmed']]);
});

test('E15: lines that are not NAME:value are ignored; a leap second (:60) is read as :59', async () => {
  const result = await merge({ a: cal(ev('UID:e15@test.example', 'this line has no colon', 'SUMMARY:E15', 'DTSTART:20261103T235960Z')) }, NOV);
  assert.equal(result.occurrences[0].start.utc, '2026-11-03T23:59:59Z');
  assert.deepEqual(result.problems, []);
});

test('E16: the same UID twice in one source uses the usual order, and a full tie is decided by content, not file order', async () => {
  const one = ev('UID:e16@test.example', 'SUMMARY:Version one', NY('20261103T090000'));
  const two = ev('UID:e16@test.example', 'SUMMARY:Version two', NY('20261103T090000'));
  const forward = await merge({ a: cal(one, two) }, NOV);
  const backward = await merge({ a: cal(two, one) }, NOV);
  assert.equal(forward.occurrences.length, 1);
  assert.deepEqual(forward.occurrences, backward.occurrences);
  const newer = await merge({ a: cal(ev('UID:e16@test.example', 'SUMMARY:Newer', NY('20261103T090000'), 'SEQUENCE:5'), one) }, NOV);
  assert.deepEqual(titles(newer), ['Newer']);
});

test('E17: a cancellation for a date the series has no occurrence on is not a problem', async () => {
  const series = cal(ev('UID:e17@test.example', 'SUMMARY:E17', NY('20261102T090000'), 'RRULE:FREQ=WEEKLY;COUNT=2'));
  const record = cal(ev('UID:e17@test.example', 'RECURRENCE-ID;TZID=America/New_York:20261104T090000', 'STATUS:CANCELLED', 'SEQUENCE:1'));
  const result = await merge({ a: series, b: record }, NOV);
  assert.deepEqual(days(result), ['2026-11-02', '2026-11-09']);
  assert.deepEqual(result.problems, []);
});

test('E18: an occurrence that began before the range is listed under the range\'s first day', async () => {
  const result = await merge({ a: cal(
    ev('UID:e18a@test.example', 'SUMMARY:Camp', 'DTSTART;VALUE=DATE:20261029', 'DTEND;VALUE=DATE:20261103'),
    ev('UID:e18b@test.example', 'SUMMARY:Night shift', NY('20261031T220000'), 'DTEND;TZID=America/New_York:20261101T060000'),
    ev('UID:e18c@test.example', 'SUMMARY:Breakfast', NY('20261101T050000'), 'DURATION:PT30M'),
  ) }, NOV);
  assert.deepEqual(titles(result), ['Camp', 'Night shift', 'Breakfast']);
  assert.match(formatAgenda(result), /^Sunday 2026-11-01\n {2}All day \(2026-10-29 to 2026-11-02\) Camp/m);
});

test('E19: a query time zone must be a name, not an offset', async () => {
  await assert.rejects(merge({ a: cal() }, { ...NOV, timeZone: '+05:00' }), /is not a time zone name/);
});

test('E20: LAST-MODIFIED and DTSTAMP without Z are read as UTC (they only break ties)', async () => {
  const copy = (title, stamp) => cal(ev('UID:e20@test.example', `SUMMARY:${title}`, NY('20261103T090000'), `DTSTAMP:${stamp}`));
  const result = await merge({ a: copy('Earlier', '20261001T000000'), b: copy('Later', '20261001T000001Z') }, NOV);
  assert.deepEqual(titles(result), ['Later']);
});

test('E21: METHOD applies to its whole calendar wherever it is written, and a file may hold several calendars', async () => {
  const text = [
    'BEGIN:VCALENDAR', ...ev('UID:e21a@test.example', 'SUMMARY:Cancelled', NY('20261103T090000')), 'METHOD:CANCEL', 'END:VCALENDAR',
    'BEGIN:VCALENDAR', ...ev('UID:e21b@test.example', 'SUMMARY:Second calendar', NY('20261103T100000')), 'END:VCALENDAR',
  ].join('\r\n');
  const result = await merge({ a: text }, NOV);
  assert.deepEqual(titles(result), ['Second calendar']);
});

test('E22: a changed occurrence with no series in any source shows on its own', async () => {
  const result = await merge({ a: cal(ev('UID:e22@test.example', 'SUMMARY:Invited once', 'RECURRENCE-ID;TZID=America/New_York:20261103T090000', NY('20261103T090000'))) }, NOV);
  assert.deepEqual(result.occurrences.map((o) => [o.title, o.isChanged, o.isRepeat]), [['Invited once', true, true]]);
});

test('E23: a changed occurrence lists the sources of its series and of its changed copies', async () => {
  const series = cal(ev('UID:e23@test.example', 'SUMMARY:E23', NY('20261102T090000'), 'RRULE:FREQ=DAILY;COUNT=2'));
  const change = cal(ev('UID:e23@test.example', 'SUMMARY:E23 moved', 'RECURRENCE-ID;TZID=America/New_York:20261103T090000', NY('20261103T120000')));
  const result = await merge({ a: series, b: change }, NOV);
  assert.deepEqual(result.occurrences.map((o) => [o.title, sourceIds(o), o.matchedBy]), [['E23', ['a'], null], ['E23 moved', ['a', 'b'], 'uid']]);
});

test('E24: a calendar without a name is named by its id', async () => {
  const result = await merge([{ id: 'nameless', ics: cal(ev('UID:e24@test.example', 'SUMMARY:E24', NY('20261103T090000'))) }], NOV);
  assert.deepEqual(result.occurrences[0].sources, [{ id: 'nameless', name: 'nameless' }]);
});

test('E25: a missing END:VEVENT is listed as a problem, and the rest of the file still shows', async () => {
  const text = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:e25a@test.example', 'SUMMARY:Unclosed', NY('20261103T090000'),
    'BEGIN:VEVENT', 'UID:e25b@test.example', 'SUMMARY:Closed', NY('20261103T100000'), 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:e25c@test.example', 'SUMMARY:Unclosed at the end', NY('20261103T110000'),
    'END:VCALENDAR', '',
  ].join('\r\n');
  const result = await merge({ a: text }, NOV);
  assert.deepEqual(titles(result), ['Closed']);
  assert.deepEqual(result.problems, [
    'Source "a", line 3: event skipped: no END:VEVENT before the next BEGIN:VEVENT.',
    'Source "a", line 12: event skipped: no END:VEVENT before END:VCALENDAR.',
  ]);
});

test('E26: caret-encoded parameter values are decoded (RFC 6868)', async () => {
  assert.deepEqual(parseContentLine("ATTENDEE;CN=Juniper ^'June^' Ash^ngrove ^^1:mailto:j@test.example").params.CN, ['Juniper "June" Ash\ngrove ^1']);
  const result = await merge({ a: cal(ev('UID:e26@test.example', 'SUMMARY:E26', 'DTSTART;TZID="America/New^^York":20261103T090000')) }, NOV);
  assert.deepEqual(result.problems, ['Source "a", line 4: event "e26@test.example" skipped: unknown time zone "America/New^York".']);
});

test('E27: the command restores a multi-byte character that a fold split', async () => {
  const bytes = new TextEncoder().encode(cal(ev('UID:e27@test.example', 'SUMMARY:Café été', NY('20261103T090000'))));
  // Fold inside the first "é" (0xC3 0xA9), as RFC 5545 allows.
  const at = bytes.indexOf(0xa9);
  const folded = Uint8Array.from([...bytes.subarray(0, at), 0x0d, 0x0a, 0x20, ...bytes.subarray(at)]);
  let printed = '';
  const code = await run(['--from', '2026-11-03', '--to', '2026-11-03', '--tz', 'America/New_York', '--json', 'folded.ics'], {
    stdout: { write(chunk) { printed += chunk; return true; } },
    stderr: { write() { return true; } },
    readFile: () => folded,
    fileSize: () => folded.length,
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(printed).occurrences[0].title, 'Café été');
  assert.equal(decodeIcs(folded).split('\r\n').length, new TextDecoder().decode(folded).split('\r\n').length);
});
