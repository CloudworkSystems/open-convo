import './guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  SCHEMA_VERSION, Tasks,   civilDate, compareStamps, deserializePerson, mergePeople,
  occurrenceDates, serializePerson, wallClock, wallToInstant,
} from '../src/index.mjs';
import { VIEW_NOW, VIEW_ZONE, viewFixture } from './views-fixture.mjs';

const ZONE = 'America/New_York';
const T0 = 1_700_000_000_000;
const BANNED = /\bfailed\b|\blate again\b|\bstreaks?\b|\bscores?\b/i;

function engine(device = 'phone-a', time = T0, zone = ZONE) {
  return new Tasks({ deviceId: device, id: 'maple-household', timeZone: zone, now: () => time });
}
function at(iso) {
  return Date.parse(iso);
}
function message(fn) {
  try { fn(); } catch (error) { return error.message; }
  assert.fail('expected a throw');
}
function rule(partial) {
  return { mode: 'onSchedule', weekdays: null, monthDay: null, weekday: null, which: null, endAfter: null, endOn: null, ...partial };
}
function texts(value, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) value.forEach(item => texts(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { found.push(key); texts(item, found); }
  }
  return found;
}
function assertClean(value) {
  for (const text of texts(value)) assert.equal(BANNED.test(text), false, text);
}
function fork(snapshot, device, time = T0) {
  const copy = new Tasks({ deviceId: device, id: snapshot.id, timeZone: 'UTC', now: () => time });
  copy.importPerson(snapshot);
  return copy;
}

test('1. add, edit, complete, reopen, drop, delete, restore, empty Trash and undo', () => {
  const desk = engine();
  const id = desk.addTask({ title: 'Renew registration', note: 'Glove box', list: 'Errands', priority: 'high', due: '2026-11-30' }, { taskId: 'renew' });
  assert.equal(desk.task(id).title, 'Renew registration');
  const beforeEdit = desk.task(id);
  desk.editTask(id, { title: 'Renew the registration', note: 'Folder' });
  assert.equal(desk.task(id).title, 'Renew the registration');
  desk.undo();
  assert.deepEqual(desk.task(id), beforeEdit);

  desk.complete(id, at('2026-11-30T15:00:00.000Z'), { recordId: 'done-1' });
  assert.equal(desk.task(id).status, 'done');
  desk.reopen(id);
  assert.equal(desk.task(id).status, 'open');
  desk.undo();
  assert.equal(desk.task(id).status, 'done');
  desk.undo();
  assert.equal(desk.task(id).status, 'open');
  assert.equal(desk.history(id)[0].undone, true);

  desk.drop(id, at('2026-11-01T15:00:00.000Z'), { recordId: 'drop-1' });
  assert.equal(desk.task(id).status, 'dropped');
  assert.equal(desk.history(id).some(row => row.type === 'drop'), true);
  desk.undo();
  assert.equal(desk.task(id).status, 'open');

  desk.deleteTask(id);
  assert.deepEqual(desk.tasks(), []);
  assert.deepEqual(desk.tasks({ trash: true }), [id]);
  desk.restoreTask(id);
  assert.deepEqual(desk.tasks(), [id]);
  desk.deleteTask(id);
  desk.emptyTrash();
  assert.deepEqual(desk.tasks({ trash: true }), []);
  assert.equal(desk.undo(), false);
  assert.equal(desk.save().includes('Renew registration'), false);

  const phone = engine('phone-b');
  const added = phone.addTask({ title: 'Call the dentist', due: '2026-05-04' }, { taskId: 'call' });
  const other = engine('phone-c');
  other.importPerson(phone.getPerson());
  phone.undo();
  other.importPerson(phone.getPerson());
  assert.equal(message(() => other.task(added)), 'Task was emptied from Trash.');
});

test('2. each repeat kind matches its dates across two years', () => {
  assert.deepEqual(occurrenceDates(rule({ kind: 'days', every: 3, start: '2024-01-01' }), 5), [
    '2024-01-01', '2024-01-04', '2024-01-07', '2024-01-10', '2024-01-13',
  ]);
  assert.deepEqual(occurrenceDates(rule({ kind: 'weeks', every: 2, start: '2024-01-01' }), 3), [
    '2024-01-01', '2024-01-15', '2024-01-29',
  ]);
  assert.deepEqual(occurrenceDates(rule({ kind: 'weekdays', every: 2, start: '2026-01-05', weekdays: ['thursday', 'monday'] }), 6), [
    '2026-01-05', '2026-01-08', '2026-01-19', '2026-01-22', '2026-02-02', '2026-02-05',
  ]);
  const patterns = engine('patterns');
  patterns.addTask({ title: 'Second Tuesday', due: '2026-01-13', repeat: { kind: 'monthWeekday', every: 1, mode: 'onSchedule', weekday: 'tuesday', which: 2 } }, { taskId: 'second' });
  patterns.addTask({ title: 'Last Friday', due: '2026-01-30', repeat: { kind: 'monthWeekday', every: 1, mode: 'onSchedule', weekday: 'friday', which: 'last' } }, { taskId: 'last' });
  patterns.addTask({ title: 'Monday and Thursday', due: '2026-01-05', repeat: { kind: 'weekdays', every: 2, mode: 'onSchedule', weekdays: ['thursday', 'monday'] } }, { taskId: 'both-days' });
  assert.equal(patterns.task('second').repeat.weekday, 'tuesday');
  assert.equal(patterns.task('second').repeat.which, 2);
  assert.equal(patterns.task('last').repeat.which, -1);
  assert.notDeepEqual(patterns.task('second').repeat, patterns.task('last').repeat);
  assert.deepEqual(patterns.task('both-days').repeat.weekdays, ['monday', 'thursday']);
  assert.deepEqual(occurrenceDates(rule({ kind: 'months', every: 1, start: '2024-01-31' }), 6), [
    '2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30', '2024-05-31', '2024-06-30',
  ]);
  assert.deepEqual(occurrenceDates(rule({ kind: 'monthDay', every: 1, start: '2026-01-31', monthDay: 31 }), 3), [
    '2026-01-31', '2026-02-28', '2026-03-31',
  ]);
  assert.deepEqual(occurrenceDates(rule({ kind: 'monthWeekday', every: 1, start: '2026-01-13', weekday: 'tuesday', which: 2 }), 4), [
    '2026-01-13', '2026-02-10', '2026-03-10', '2026-04-14',
  ]);
  assert.deepEqual(occurrenceDates(rule({ kind: 'monthWeekday', every: 1, start: '2026-01-30', weekday: 'friday', which: 'last' }), 4), [
    '2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24',
  ]);
  assert.deepEqual(occurrenceDates(rule({ kind: 'monthWeekday', every: 1, start: '2026-03-30', weekday: 'monday', which: 5 }), 4), [
    '2026-03-30', '2026-06-29', '2026-08-31', '2026-11-30',
  ]);
  assert.deepEqual(occurrenceDates(rule({ kind: 'years', every: 1, start: '2024-02-29' }), 5), [
    '2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29',
  ]);
  const twoYears = occurrenceDates(rule({ kind: 'days', every: 1, start: '2024-01-01' }), 731);
  assert.equal(twoYears.at(-1), '2025-12-31');
  assert.equal(twoYears.length, 731);
});

test('3. on schedule and after done, early, late, twice, skip and a single overdue row', () => {
  const late = engine();
  late.addTask({ title: 'Monday meeting', due: '2026-01-05', repeat: { kind: 'weeks', every: 1, mode: 'onSchedule' } }, { taskId: 'mon' });
  late.complete('mon', at('2026-01-20T15:00:00.000Z'), { recordId: 'late' });
  assert.equal(late.task('mon').occurrence, '2026-01-12');
  assert.deepEqual(late.overdue(at('2026-01-21T15:00:00.000Z'), ZONE).map(row => row.occurrence), ['2026-01-12']);

  const early = engine('early');
  early.addTask({ title: 'Monday meeting', due: '2026-01-05', repeat: { kind: 'weeks', every: 1, mode: 'onSchedule' } }, { taskId: 'mon' });
  early.complete('mon', at('2026-01-01T15:00:00.000Z'), { recordId: 'early' });
  assert.equal(early.task('mon').occurrence, '2026-01-12');

  const twice = engine('twice');
  twice.addTask({ title: 'Monday meeting', due: '2026-01-05', repeat: { kind: 'weeks', every: 1, mode: 'onSchedule' } }, { taskId: 'mon' });
  twice.complete('mon', at('2026-01-06T15:00:00.000Z'), { recordId: 't1' });
  twice.complete('mon', at('2026-01-06T16:00:00.000Z'), { recordId: 't2' });
  assert.equal(twice.task('mon').occurrence, '2026-01-19');

  const watered = engine('water');
  watered.addTask({ title: 'Water the plants', due: '2026-01-10', repeat: { kind: 'days', every: 3, mode: 'afterDone' } }, { taskId: 'water' });
  watered.complete('water', at('2026-01-08T15:00:00.000Z'), { recordId: 'early-water' });
  assert.equal(watered.task('water').occurrence, '2026-01-11');
  watered.complete('water', at('2026-01-20T15:00:00.000Z'), { recordId: 'late-water' });
  assert.equal(watered.task('water').occurrence, '2026-01-23');
  watered.complete('water', at('2026-01-20T16:00:00.000Z'), { recordId: 'again' });
  assert.equal(watered.task('water').occurrence, '2026-01-26');

  const month = engine('month');
  month.addTask({ title: 'Water the plants', due: '2026-01-31', repeat: { kind: 'months', every: 1, mode: 'afterDone' } }, { taskId: 'water' });
  month.complete('water', at('2026-01-31T15:00:00.000Z'), { recordId: 'jan' });
  assert.equal(month.task('water').occurrence, '2026-02-28');
  month.complete('water', at('2026-02-28T15:00:00.000Z'), { recordId: 'feb' });
  assert.equal(month.task('water').occurrence, '2026-03-28');

  const skipped = engine('skip');
  skipped.addTask({ title: 'Water the fern', due: '2026-01-01', repeat: { kind: 'days', every: 3, mode: 'afterDone' } }, { taskId: 'fern' });
  skipped.skip('fern', at('2026-01-10T15:00:00.000Z'), { recordId: 'skip-1' });
  assert.equal(skipped.task('fern').occurrence, '2026-01-13');
  assert.deepEqual(skipped.history('fern').map(row => row.type), ['skip']);

  const night = engine('night');
  night.addTask({ title: 'Night note', due: '2026-01-15', repeat: { kind: 'days', every: 1, mode: 'afterDone' } }, { taskId: 'night' });
  night.complete('night', at('2026-01-16T04:30:00.000Z'), { recordId: 'ny' });
  assert.equal(night.history('night')[0].actionDate, '2026-01-15');
  assert.equal(night.history('night')[0].actionZone, ZONE);
  night.setTimeZone('Asia/Tokyo');
  assert.equal(night.history('night')[0].actionDate, '2026-01-15');
  assert.equal(night.task('night').occurrence, '2026-01-16');

  const piled = engine('piled');
  piled.addTask({ title: 'Daily stretch', due: '2026-01-01', repeat: { kind: 'days', every: 1, mode: 'onSchedule' } }, { taskId: 'daily' });
  const rows = piled.overdue(at('2026-01-10T15:00:00.000Z'), ZONE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].occurrence, '2026-01-01');

  const bad = engine('bad');
  assert.match(message(() => bad.addTask({ title: 'Nope', due: '2026-03-03', repeat: { kind: 'weekdays', every: 1, mode: 'onSchedule', weekdays: ['monday'] } })), /not one of the chosen days/);
  assert.match(message(() => bad.addTask({ title: 'Nope', repeat: { kind: 'days', every: 1, mode: 'onSchedule' } })), /needs a due date/);
  assert.match(message(() => bad.addTask({ title: 'Nope', due: '2026-03-02', repeat: { kind: 'weekdays', every: 1, mode: 'afterDone', weekdays: ['monday'] } })), /After done only works/);
});

test('4. a repeat ends after a count or on a date, and a closed occurrence counts once', () => {
  const desk = engine();
  desk.addTask({ title: 'Two days', due: '2026-04-01', repeat: { kind: 'days', every: 1, mode: 'onSchedule', endAfter: 2 } }, { taskId: 'two' });
  desk.complete('two', at('2026-04-01T15:00:00.000Z'), { recordId: 'a' });
  assert.equal(desk.task('two').status, 'open');
  assert.equal(desk.task('two').occurrence, '2026-04-02');
  desk.complete('two', at('2026-04-02T15:00:00.000Z'), { recordId: 'b' });
  assert.equal(desk.task('two').status, 'done');
  assert.equal(desk.task('two').due, null);

  const skips = engine('skips');
  skips.addTask({ title: 'Two skips', due: '2026-04-01', repeat: { kind: 'days', every: 1, mode: 'onSchedule', endAfter: 2 } }, { taskId: 'two' });
  skips.skip('two', at('2026-04-01T15:00:00.000Z'), { recordId: 's1' });
  skips.skip('two', at('2026-04-02T15:00:00.000Z'), { recordId: 's2' });
  assert.equal(skips.task('two').status, 'done');

  const left = engine('left', T0);
  const right = engine('right', T0 + 1);
  left.addTask({ title: 'Once', due: '2026-06-01', repeat: { kind: 'days', every: 1, mode: 'onSchedule', endAfter: 1 } }, { taskId: 'once' });
  right.importPerson(left.getPerson());
  left.complete('once', at('2026-06-01T15:00:00.000Z'), { recordId: 'left-done' });
  right.complete('once', at('2026-06-01T16:00:00.000Z'), { recordId: 'right-done' });
  const merged = fork(mergePeople(left.getPerson(), right.getPerson()), 'merged');
  assert.equal(merged.task('once').status, 'done');
  assert.equal(merged.history('once').length, 2);

  const until = engine('until');
  until.addTask({ title: 'Through Friday', due: '2026-04-01', repeat: { kind: 'days', every: 1, mode: 'onSchedule', endOn: '2026-04-03' } }, { taskId: 'until' });
  assert.deepEqual(until.upcoming(at('2026-04-01T12:00:00.000Z'), 30, ZONE).map(group => group.date), ['2026-04-01', '2026-04-02', '2026-04-03']);
  until.complete('until', at('2026-04-01T15:00:00.000Z'), { recordId: 'u1' });
  until.complete('until', at('2026-04-02T15:00:00.000Z'), { recordId: 'u2' });
  until.complete('until', at('2026-04-03T15:00:00.000Z'), { recordId: 'u3' });
  assert.equal(until.task('until').status, 'done');

  const plain = engine('plain-due');
  plain.addTask({ title: 'Daily', due: '2026-11-01', repeat: { kind: 'days', every: 1, mode: 'onSchedule' } }, { taskId: 'daily' });
  plain.editTask('daily', { due: '2026-11-10', repeat: null });
  assert.equal(plain.task('daily').repeat, null);
  assert.equal(plain.task('daily').due.date, '2026-11-10');
  plain.addTask({ title: 'Still repeating', due: '2026-11-01', repeat: { kind: 'days', every: 1, mode: 'onSchedule' } }, { taskId: 'kept' });
  plain.complete('kept', at('2026-11-03T15:00:00.000Z'), { recordId: 'moved-on' });
  const open = plain.task('kept').occurrence;
  plain.editTask('kept', { repeat: null });
  assert.equal(open, '2026-11-02');
  assert.equal(plain.task('kept').due.date, open);
});

test('5. wall times stay put across clock changes and convert when viewed elsewhere', () => {
  const desk = engine();
  desk.addTask({ title: 'Before', due: { dateTime: '2026-03-07T09:00', timeZone: ZONE } }, { taskId: 'before' });
  desk.addTask({ title: 'After', due: { dateTime: '2026-03-09T09:00', timeZone: ZONE } }, { taskId: 'after' });
  desk.addTask({ title: 'Gap', due: { dateTime: '2026-03-08T02:30', timeZone: ZONE } }, { taskId: 'gap' });
  desk.addTask({ title: 'Fold', due: { dateTime: '2026-11-01T01:30', timeZone: ZONE } }, { taskId: 'fold' });
  assert.equal(desk.task('before').due.resolved, '2026-03-07T09:00');
  assert.equal(desk.task('after').due.resolved, '2026-03-09T09:00');
  assert.equal(new Date(desk.task('before').due.instant).toISOString(), '2026-03-07T14:00:00.000Z');
  assert.equal(new Date(desk.task('after').due.instant).toISOString(), '2026-03-09T13:00:00.000Z');
  assert.equal(desk.task('gap').due.dateTime, '2026-03-08T02:30');
  assert.equal(desk.task('gap').due.resolved, '2026-03-08T03:30');
  assert.equal(new Date(desk.task('gap').due.instant).toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(new Date(desk.task('fold').due.instant).toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(new Date(wallToInstant('2026-10-25T01:30', 'Europe/London')).toISOString(), '2026-10-25T00:30:00.000Z');
  assert.equal(wallClock(wallToInstant('2026-10-04T02:30', 'Australia/Sydney'), 'Australia/Sydney'), '2026-10-04T03:30');
  assert.equal(wallClock(wallToInstant('2026-09-27T02:30', 'Pacific/Auckland'), 'Pacific/Auckland'), '2026-09-27T03:30');
  assert.equal(wallClock(wallToInstant('2026-10-04T02:15', 'Australia/Lord_Howe'), 'Australia/Lord_Howe'), '2026-10-04T02:45');

  desk.addTask({ title: 'Evening call', due: { dateTime: '2026-01-15T21:00', timeZone: ZONE } }, { taskId: 'evening' });
  desk.addTask({ title: 'Plain day', due: '2026-01-15' }, { taskId: 'plain' });
  const instant = desk.task('evening').due.instant;
  assert.equal(civilDate(instant, ZONE), '2026-01-15');
  assert.equal(civilDate(instant, 'Europe/London'), '2026-01-16');
  assert.equal(civilDate(instant, 'Asia/Tokyo'), '2026-01-16');
  for (const zone of [ZONE, 'Europe/London', 'Asia/Tokyo']) {
    const plain = desk.today(instant, zone).find(row => row.id === 'plain');
    const timed = desk.today(instant, zone).find(row => row.id === 'evening');
    assert.equal(plain.due.date, '2026-01-15');
    assert.equal(timed.due.dateTime, '2026-01-15T21:00');
  }
  assert.equal(desk.upcoming(instant, 1, 'Europe/London').some(group => group.date === '2026-01-16' && group.tasks.some(row => row.id === 'evening')), true);
  assert.equal(desk.upcoming(instant, 1, ZONE).some(group => group.date === '2026-01-15' && group.tasks.some(row => row.id === 'plain')), true);
});

test('6. today, upcoming and overdue match the saved view', () => {
  const desk = viewFixture();
  const expected = JSON.parse(readFileSync(new URL('./expected/views.json', import.meta.url), 'utf8'));
  const actual = {
    today: desk.today(VIEW_NOW, VIEW_ZONE),
    upcoming: desk.upcoming(VIEW_NOW, 7, VIEW_ZONE),
    overdue: desk.overdue(VIEW_NOW, VIEW_ZONE),
  };
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.today.map(row => row.id), ['reg', 'call', 'tickets', 'plants', 'book', 'stretch', 'letter']);
  const later = engine('later-reminder');
  later.addTask({
    title: 'Evening letter',
    due: '2026-03-20',
    reminders: [{ dateTime: '2026-03-10T17:00', timeZone: ZONE }],
  }, { taskId: 'evening' });
  const morning = at('2026-03-10T12:00:00.000Z');
  const fired = at('2026-03-10T21:00:00.000Z');
  assert.equal(later.today(morning, ZONE).some(row => row.id === 'evening'), false);
  assert.equal(later.today(fired, ZONE).some(row => row.id === 'evening'), true);
  assert.deepEqual(actual.overdue.map(row => row.id), ['reg', 'call']);
  assert.equal(actual.today.some(row => row.id === 'finished' || row.id === 'dropped'), false);
  assert.equal(actual.upcoming[1].tasks.find(row => row.id === 'fern').repeatsAfterDone, true);
});

test('7. reminders fire once, follow an open occurrence, and a fixed one stays behind', () => {
  const desk = engine();
  desk.addTask({ title: 'Spring', due: { dateTime: '2026-03-08T09:00', timeZone: ZONE }, reminders: [{ days: 1 }] }, { taskId: 'spring' });
  desk.addTask({ title: 'Same morning', due: { dateTime: '2026-03-08T09:00', timeZone: ZONE }, reminders: [{ days: 0 }] }, { taskId: 'morning' });
  const start = wallToInstant('2026-03-07T00:00', ZONE);
  const middle = wallToInstant('2026-03-08T00:00', ZONE);
  const end = wallToInstant('2026-03-09T00:00', ZONE);
  const first = desk.remindersDue(start, middle, ZONE);
  const second = desk.remindersDue(middle, end, ZONE);
  const whole = desk.remindersDue(start, end, ZONE);
  assert.deepEqual(first.map(row => row.taskId), ['spring']);
  assert.deepEqual(second.map(row => row.taskId), ['morning']);
  assert.deepEqual(whole.map(row => row.instant).sort(), [...first, ...second].map(row => row.instant).sort());
  assert.equal(new Date(first[0].instant).toISOString(), '2026-03-07T14:00:00.000Z');
  assert.equal(new Date(second[0].instant).toISOString(), '2026-03-08T13:00:00.000Z');

  const month = engine('month-end');
  month.addTask({ title: 'Month end', due: '2026-03-01', reminders: [{ days: 1 }] }, { taskId: 'month' });
  const feb = month.remindersDue(wallToInstant('2026-02-28T00:00', ZONE), wallToInstant('2026-03-01T00:00', ZONE), ZONE);
  const march = month.remindersDue(wallToInstant('2026-03-01T00:00', ZONE), wallToInstant('2026-03-02T00:00', ZONE), ZONE);
  assert.equal(feb.length, 1);
  assert.equal(feb[0].at, '2026-02-28T09:00');
  assert.equal(march.length, 0);

  month.setDayStart('08:30');
  const earlier = month.remindersDue(wallToInstant('2026-02-28T00:00', ZONE), wallToInstant('2026-03-01T00:00', ZONE), ZONE);
  assert.equal(earlier[0].at, '2026-02-28T08:30');

  const weekly = engine('weekly');
  weekly.addTask({
    title: 'Sunday call',
    due: '2026-03-01',
    repeat: { kind: 'weeks', every: 1, mode: 'onSchedule' },
    reminders: [
      { dateTime: '2026-03-01T09:00', timeZone: ZONE, occurrence: '2026-03-01' },
      { days: 0 },
    ],
  }, { taskId: 'sunday' });
  weekly.complete('sunday', at('2026-02-28T15:00:00.000Z'), { recordId: 'sat' });
  assert.deepEqual(weekly.remindersDue(wallToInstant('2026-03-01T00:00', ZONE), wallToInstant('2026-03-02T00:00', ZONE), ZONE), []);
  const next = weekly.remindersDue(wallToInstant('2026-03-08T00:00', ZONE), wallToInstant('2026-03-09T00:00', ZONE), ZONE);
  assert.equal(next.length, 1);
  assert.equal(next[0].occurrence, '2026-03-08');
  assert.equal(next[0].reminder.kind, 'offset');

  weekly.editTask('sunday', { reminders: [{ dateTime: '2026-03-08T09:00', timeZone: ZONE, occurrence: '2026-03-08' }] });
  assert.equal(weekly.remindersDue(wallToInstant('2026-03-08T00:00', ZONE), wallToInstant('2026-03-09T00:00', ZONE), ZONE)[0].reminder.kind, 'fixed');

  const moved = engine('moved-due');
  moved.addTask({
    title: 'Call the dentist',
    due: '2026-04-01',
    reminders: [{ dateTime: '2026-04-01T09:00', timeZone: ZONE, occurrence: '2026-04-01' }],
  }, { taskId: 'call' });
  const april = [wallToInstant('2026-04-01T00:00', ZONE), wallToInstant('2026-04-09T00:00', ZONE)];
  assert.equal(moved.remindersDue(april[0], april[1], ZONE).length, 1);
  moved.editTask('call', { due: '2026-04-08' });
  assert.deepEqual(moved.remindersDue(april[0], april[1], ZONE), []);
  moved.editTask('call', { reminders: [{ dateTime: '2026-04-08T09:00', timeZone: ZONE, occurrence: '2026-04-08' }] });
  assert.equal(moved.remindersDue(april[0], april[1], ZONE)[0].occurrence, '2026-04-08');

  const done = engine('done-reminder');
  done.addTask({ title: 'One reminder', due: { dateTime: '2026-04-02T09:00', timeZone: ZONE }, reminders: [{ days: 1 }] }, { taskId: 'one' });
  done.complete('one', at('2026-04-01T12:00:00.000Z'), { recordId: 'gone' });
  assert.deepEqual(done.remindersDue(wallToInstant('2026-04-01T00:00', ZONE), wallToInstant('2026-04-03T00:00', ZONE), ZONE), []);

  assert.match(message(() => desk.remindersDue(0, 32 * 24 * 60 * 60 * 1000, ZONE)), /at most 31 days/);
});

test('8. snooze presets, including next Monday on a Monday, leave the series put', () => {
  const desk = engine();
  desk.addTask({ title: 'Plan the week', due: { dateTime: '2026-03-02T09:00', timeZone: ZONE }, reminders: [{ hours: 0 }] }, { taskId: 'plan' });
  const monday = at('2026-03-02T15:00:00.000Z');
  desk.snooze('plan', { preset: 'nextMonday' }, monday, { recordId: 'monday' });
  assert.equal(desk.history('plan')[0].reminderAt.dateTime, '2026-03-09T09:00');
  assert.notEqual(desk.history('plan')[0].reminderAt.dateTime.slice(0, 10), '2026-03-02');

  const later = engine('later');
  later.addTask({ title: 'Plan the week', due: { dateTime: '2026-03-02T09:00', timeZone: ZONE } }, { taskId: 'plan' });
  later.snooze('plan', { preset: 'laterToday' }, monday, { recordId: 'later' });
  assert.equal(later.history('plan')[0].reminderAt.dateTime, '2026-03-02T13:00');

  const tomorrow = engine('tomorrow');
  tomorrow.addTask({ title: 'Plan the week', due: { dateTime: '2026-03-02T09:00', timeZone: ZONE }, reminders: [{ hours: 0 }] }, { taskId: 'plan' });
  tomorrow.snooze('plan', { preset: 'tomorrow' }, monday, { recordId: 'tomorrow' });
  assert.equal(tomorrow.history('plan')[0].reminderAt.dateTime, '2026-03-03T09:00');

  const sunday = engine('sunday');
  sunday.addTask({ title: 'Plan the week', due: { dateTime: '2026-03-01T09:00', timeZone: ZONE } }, { taskId: 'plan' });
  sunday.snooze('plan', { preset: 'nextMonday' }, at('2026-03-01T15:00:00.000Z'), { recordId: 'from-sunday' });
  assert.equal(sunday.history('plan')[0].reminderAt.dateTime, '2026-03-02T09:00');

  const series = engine('series');
  series.addTask({ title: 'Weekly', due: '2026-03-02', repeat: { kind: 'weeks', every: 1, mode: 'onSchedule' }, reminders: [{ days: 0 }] }, { taskId: 'weekly' });
  const before = series.task('weekly').occurrence;
  series.snooze('weekly', { preset: 'tomorrow', moveDue: true }, monday, { recordId: 'move' });
  assert.equal(series.task('weekly').occurrence, before);
  assert.equal(series.task('weekly').due.dateTime, '2026-03-03T09:00');
  series.complete('weekly', at('2026-03-02T18:00:00.000Z'), { recordId: 'done' });
  assert.equal(series.task('weekly').occurrence, '2026-03-09');

  const afterDone = engine('after');
  afterDone.addTask({ title: 'Every three', due: '2026-03-02', repeat: { kind: 'days', every: 3, mode: 'afterDone' } }, { taskId: 'three' });
  afterDone.snooze('three', { preset: 'tomorrow', moveDue: true }, monday, { recordId: 'snooze' });
  assert.equal(afterDone.task('three').occurrence, '2026-03-02');
  afterDone.complete('three', monday, { recordId: 'did' });
  assert.equal(afterDone.task('three').occurrence, '2026-03-05');

  const left = engine('snooze-a', T0 + 5);
  const right = engine('snooze-b', T0 + 1);
  left.addTask({ title: 'Shared', due: { dateTime: '2026-03-02T09:00', timeZone: ZONE } }, { taskId: 'shared' });
  right.importPerson(left.getPerson());
  left.snooze('shared', { at: { dateTime: '2026-03-02T15:00', timeZone: ZONE } }, monday, { recordId: 'high' });
  right.snooze('shared', { at: { dateTime: '2026-03-02T11:00', timeZone: ZONE } }, monday, { recordId: 'low' });
  const won = fork(mergePeople(left.getPerson(), right.getPerson()), 'won', T0 + 9);
  const moments = won.remindersDue(at('2026-03-02T00:00:00.000Z'), at('2026-03-03T00:00:00.000Z'), ZONE);
  assert.equal(moments.length, 1);
  assert.equal(moments[0].at, '2026-03-02T15:00');

  const stale = engine('stale');
  stale.addTask({ title: 'Weekly', due: '2026-03-02', repeat: { kind: 'weeks', every: 1, mode: 'onSchedule' } }, { taskId: 'weekly' });
  stale.snooze('weekly', { at: { dateTime: '2026-03-04T09:00', timeZone: ZONE }, moveDue: true }, monday, { recordId: 'old' });
  stale.complete('weekly', monday, { recordId: 'next' });
  assert.equal(stale.task('weekly').due.kind, 'date');
  assert.equal(stale.task('weekly').occurrence, '2026-03-09');

  const both = engine('both-reminders');
  both.addTask({
    title: 'Two reminders',
    due: '2026-03-10',
    reminders: [
      { dateTime: '2026-03-10T09:00', timeZone: ZONE, occurrence: '2026-03-10' },
      { dateTime: '2026-03-10T17:00', timeZone: ZONE, occurrence: '2026-03-10' },
    ],
  }, { taskId: 'two' });
  const noon = wallToInstant('2026-03-10T12:00', ZONE);
  both.snooze('two', { at: { dateTime: '2026-03-11T17:00', timeZone: ZONE } }, noon, { recordId: 'move-next' });
  const day = both.remindersDue(wallToInstant('2026-03-10T00:00', ZONE), wallToInstant('2026-03-12T00:00', ZONE), ZONE);
  assert.deepEqual(day.map(row => row.at), ['2026-03-10T09:00', '2026-03-11T17:00']);

  const again = engine('again', T0, 'UTC');
  again.addTask({
    title: 'One bell',
    due: '2026-04-01',
    reminders: [{ dateTime: '2026-04-01T09:00', timeZone: 'UTC', occurrence: '2026-04-01' }],
  }, { taskId: 'bell' });
  again.snooze('bell', { at: { dateTime: '2026-04-01T12:00', timeZone: 'UTC' } }, at('2026-04-01T08:00:00.000Z'), { recordId: 'first-snooze' });
  again.snooze('bell', { at: { dateTime: '2026-04-01T15:00', timeZone: 'UTC' } }, at('2026-04-01T10:00:00.000Z'), { recordId: 'second-snooze' });
  assert.deepEqual(
    again.remindersDue(at('2026-04-01T00:00:00.000Z'), at('2026-04-02T00:00:00.000Z'), 'UTC').map(row => row.at),
    ['2026-04-01T15:00'],
  );
  const chain = engine('chain', T0, 'UTC');
  chain.addTask({
    title: 'Morning and evening',
    due: '2026-04-03',
    reminders: [
      { dateTime: '2026-04-03T09:00', timeZone: 'UTC', occurrence: '2026-04-03' },
      { dateTime: '2026-04-03T17:00', timeZone: 'UTC', occurrence: '2026-04-03' },
    ],
  }, { taskId: 'pair' });
  chain.snooze('pair', { at: { dateTime: '2026-04-03T12:00', timeZone: 'UTC' } }, at('2026-04-03T08:00:00.000Z'), { recordId: 'morning' });
  chain.snooze('pair', { at: { dateTime: '2026-04-03T20:00', timeZone: 'UTC' } }, at('2026-04-03T13:00:00.000Z'), { recordId: 'evening' });
  assert.deepEqual(
    chain.remindersDue(at('2026-04-03T00:00:00.000Z'), at('2026-04-04T00:00:00.000Z'), 'UTC').map(row => row.at),
    ['2026-04-03T12:00', '2026-04-03T20:00'],
  );
  const twin = engine('twin-time', T0, 'UTC');
  twin.addTask({
    title: 'Same minute',
    due: { dateTime: '2026-04-04T09:00', timeZone: 'UTC' },
    reminders: [
      { dateTime: '2026-04-04T09:00', timeZone: 'UTC' },
      { hours: 0 },
    ],
  }, { taskId: 'twin' });
  twin.snooze('twin', { at: { dateTime: '2026-04-04T12:00', timeZone: 'UTC' } }, at('2026-04-04T08:00:00.000Z'), { recordId: 'first-twin' });
  twin.snooze('twin', { at: { dateTime: '2026-04-04T13:00', timeZone: 'UTC' } }, at('2026-04-04T08:30:00.000Z'), { recordId: 'second-twin' });
  assert.deepEqual(
    twin.remindersDue(at('2026-04-04T00:00:00.000Z'), at('2026-04-05T00:00:00.000Z'), 'UTC').map(row => row.at),
    ['2026-04-04T12:00', '2026-04-04T13:00'],
  );

  const winner = engine('snooze-win', T0 + 5, 'UTC');
  const loser = engine('snooze-lose', T0 + 1, 'UTC');
  winner.addTask({
    title: 'Two bells',
    due: '2026-04-02',
    reminders: [
      { dateTime: '2026-04-02T09:00', timeZone: 'UTC', occurrence: '2026-04-02' },
      { dateTime: '2026-04-02T10:00', timeZone: 'UTC', occurrence: '2026-04-02' },
    ],
  }, { taskId: 'bells' });
  loser.importPerson(winner.getPerson());
  const morning = at('2026-04-02T08:00:00.000Z');
  winner.snooze('bells', { at: { dateTime: '2026-04-02T12:00', timeZone: 'UTC' } }, morning, { recordId: 'win' });
  loser.snooze('bells', { at: { dateTime: '2026-04-02T07:00', timeZone: 'UTC' } }, morning, { recordId: 'lose' });
  const raced = fork(mergePeople(winner.getPerson(), loser.getPerson()), 'snooze-race', T0 + 9);
  assert.deepEqual(
    raced.remindersDue(at('2026-04-02T00:00:00.000Z'), at('2026-04-03T00:00:00.000Z'), 'UTC').map(row => row.at),
    ['2026-04-02T10:00', '2026-04-02T12:00'],
  );

  const home = engine('snooze-home', T0 + 6, 'UTC');
  const away = engine('snooze-away', T0 + 2, 'UTC');
  home.addTask({
    title: 'Two bells',
    due: '2026-04-02',
    reminders: [
      { dateTime: '2026-04-02T09:00', timeZone: 'UTC', occurrence: '2026-04-02' },
      { dateTime: '2026-04-02T10:00', timeZone: 'UTC', occurrence: '2026-04-02' },
    ],
  }, { taskId: 'shift' });
  away.importPerson(home.getPerson());
  home.snooze('shift', { at: { dateTime: '2026-04-02T12:00', timeZone: 'UTC' } }, morning, { recordId: 'move-nine' });
  away.editTask('shift', { reminders: [{ dateTime: '2026-04-02T10:00', timeZone: 'UTC', occurrence: '2026-04-02' }] });
  for (const [left, right] of [[home, away], [away, home]]) {
    const copy = fork(mergePeople(left.getPerson(), right.getPerson()), `shift-${left.deviceId}`, T0 + 8);
    assert.deepEqual(
      copy.remindersDue(at('2026-04-02T00:00:00.000Z'), at('2026-04-03T00:00:00.000Z'), 'UTC').map(row => row.at),
      ['2026-04-02T10:00'],
    );
  }
});

test('upcoming keeps only the occurrences a repeat still has', () => {
  const desk = engine('utc', T0, 'UTC');
  const now = at('2026-04-01T12:00:00.000Z');
  desk.addTask({ title: 'Daily', due: '2026-04-01', repeat: { kind: 'days', every: 1, mode: 'onSchedule', endAfter: 2 } }, { taskId: 'daily' });
  assert.deepEqual(desk.upcoming(now, 30, 'UTC').map(group => group.date), ['2026-04-01', '2026-04-02']);
  desk.addTask({ title: 'Until Wednesday', due: '2026-04-01', repeat: { kind: 'days', every: 1, mode: 'onSchedule', endOn: '2026-04-03' } }, { taskId: 'until' });
  const until = desk.upcoming(now, 30, 'UTC').filter(group => group.tasks.some(row => row.id === 'until')).map(group => group.date);
  assert.deepEqual(until, ['2026-04-01', '2026-04-02', '2026-04-03']);
  desk.addTask({ title: 'Already started', due: '2026-03-01', repeat: { kind: 'days', every: 1, mode: 'onSchedule', endAfter: 2 } }, { taskId: 'old' });
  assert.equal(desk.upcoming(now, 30, 'UTC').some(group => group.tasks.some(row => row.id === 'old')), false);
  desk.addTask({ title: 'After you do it', due: '2026-04-02', repeat: { kind: 'days', every: 3, mode: 'afterDone' } }, { taskId: 'after' });
  const marked = desk.upcoming(now, 30, 'UTC').flatMap(group => group.tasks).filter(row => row.id === 'after');
  assert.equal(marked.length, 1);
  assert.equal(marked[0].repeatsAfterDone, true);
  assert.equal(marked[0].occurrence, '2026-04-02');
});

test('9. merge keeps both edits, both completions, and a reopened occurrence', () => {
  const alpha = engine('alpha', T0 + 10);
  const beta = engine('beta', T0 + 20);
  alpha.addTask({ title: 'Milk', note: 'Earlier', due: '2026-05-01' }, { taskId: 'milk' });
  alpha.addTask({ title: 'Bread', due: '2026-05-02' }, { taskId: 'bread' });
  beta.importPerson(alpha.getPerson());
  alpha.editTask('milk', { note: 'Oat' });
  beta.editTask('bread', { note: 'Rye' });
  let merged = fork(mergePeople(alpha.getPerson(), beta.getPerson()), 'merged', T0 + 30);
  assert.equal(merged.task('milk').note, 'Oat');
  assert.equal(merged.task('bread').note, 'Rye');
  assert.deepEqual(mergePeople(alpha.getPerson(), beta.getPerson()), mergePeople(beta.getPerson(), alpha.getPerson()));

  const behind = engine('behind', T0 - 50_000);
  behind.importPerson(merged.getPerson());
  behind.editTask('milk', { note: 'Later' });
  merged.importPerson(behind.getPerson());
  assert.equal(merged.task('milk').note, 'Later');
  assert.equal(compareStamps({ counter: 2, time: 1, device: 'a' }, { counter: 1, time: 9, device: 'z' }), 1);

  const deleter = engine('deleter', T0 + 40);
  deleter.importPerson(merged.getPerson());
  deleter.deleteTask('bread');
  merged.importPerson(deleter.getPerson());
  assert.deepEqual(merged.tasks({ trash: true }), ['bread']);
  merged.editTask('bread', { note: 'Back' });
  deleter.importPerson(merged.getPerson());
  assert.equal(deleter.task('bread').note, 'Back');
  assert.equal(deleter.tasks().includes('bread'), true);

  const offline = engine('offline');
  const online = engine('online', T0 + 3);
  online.addTask({ title: 'Eggs', due: '2026-05-03' }, { taskId: 'eggs' });
  offline.importPerson(online.getPerson());
  online.deleteTask('eggs');
  online.emptyTrash();
  offline.importPerson(online.getPerson());
  assert.equal(offline.save().includes('Eggs'), false);
  assert.deepEqual(offline.tasks({ trash: true }), []);

  const made = new Tasks({ deviceId: 'origin', id: 'household', timeZone: 'UTC', now: () => T0 });
  made.addTask({ title: 'Old title', note: 'Old note', due: '2026-05-01' }, { taskId: 'task' });
  const base = made.getPerson();
  const version = (counter, device) => ({ counter, time: T0 + counter, device });
  const purged = structuredClone(base);
  const purgedTask = purged.tasks[0];
  purgedTask.life = { value: false, stamp: version(10, 'purger') };
  purgedTask.purge = version(10, 'purger');
  purgedTask.fields = {};
  purgedTask.records = [];
  const fields = structuredClone(base);
  fields.tasks[0].fields.title = { value: 'Newer title', stamp: version(30, 'editor') };
  const restore = structuredClone(base);
  restore.tasks[0].life = { value: true, stamp: version(20, 'restorer') };
  const copies = [purged, fields, restore];
  const folded = (i, j, k) => mergePeople(mergePeople(copies[i], copies[j]), copies[k]);
  const expected = folded(0, 1, 2);
  for (const [i, j, k] of [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    assert.deepEqual(folded(i, j, k), expected, `${i}${j}${k}`);
  }
  const broughtBack = expected.tasks.find(item => item.id === 'task');
  assert.equal(broughtBack.life.value, true);
  assert.equal(broughtBack.fields.title.value, 'Newer title');
  const held = mergePeople(purged, fields);
  assert.equal(held.tasks[0].life.value, false);
  assert.equal(held.tasks[0].fields.title.value, 'Newer title');
  const holder = new Tasks({ deviceId: 'holder', id: 'household', timeZone: 'UTC', now: () => T0 });
  holder.importPerson(held);
  assert.deepEqual(holder.tasks({ trash: true }), []);
  assert.throws(() => holder.task('task'), /emptied/);
  assert.throws(() => holder.restoreTask('task'), /emptied/);

  const reused = engine('reuse-a', T0);
  const staleCopy = engine('reuse-b', T0 + 1);
  reused.addTask({ title: 'Old round', due: '2026-06-01', repeat: { kind: 'days', every: 1, mode: 'onSchedule' } }, { taskId: 'again' });
  staleCopy.importPerson(reused.getPerson());
  for (let i = 0; i < 8; i += 1) staleCopy.addTask({ title: `Other ${i}` }, { taskId: `other-${i}` });
  staleCopy.complete('again', at('2026-06-01T15:00:00.000Z'), { recordId: 'old-done' });
  reused.deleteTask('again');
  reused.emptyTrash();
  reused.importPerson(staleCopy.getPerson());
  assert.throws(
    () => reused.addTask({ title: 'New round', due: '2026-06-01', repeat: { kind: 'days', every: 1, mode: 'onSchedule' } }, { taskId: 'again' }),
    /emptied/,
  );
  reused.addTask({ title: 'New round', due: '2026-06-01', repeat: { kind: 'days', every: 1, mode: 'onSchedule' } }, { taskId: 'fresh' });
  reused.importPerson(staleCopy.getPerson());
  assert.equal(reused.task('fresh').title, 'New round');
  assert.equal(reused.task('fresh').status, 'open');
  assert.equal(reused.task('fresh').occurrence, '2026-06-01');
  assert.equal(reused.history('fresh').some(row => row.id === 'old-done'), false);
  assert.throws(() => reused.task('again'), /emptied/);

  const editor = new Tasks({ deviceId: 'editor', id: 'household-repeat', timeZone: 'UTC', now: () => T0 });
  editor.addTask({ title: 'Sweep', due: '2026-06-01', repeat: { kind: 'days', every: 1, mode: 'onSchedule' } }, { taskId: 'sweep' });
  editor.editTask('sweep', { repeat: { kind: 'days', every: 2, mode: 'onSchedule' } });
  editor.undo();
  const revised = editor.getPerson();
  const dueStamp = revised.tasks[0].fields.due.stamp;
  const repeatStamp = revised.tasks[0].fields.repeat.stamp;
  assert.equal(compareStamps(repeatStamp, dueStamp) > 0, true);
  const cutoff = { counter: dueStamp.counter + 1, time: dueStamp.time, device: 'purger' };
  assert.equal(compareStamps(cutoff, dueStamp) > 0, true);
  assert.equal(compareStamps(repeatStamp, cutoff) > 0, true);
  const emptied = structuredClone(revised);
  const marker = emptied.tasks[0];
  marker.life = { value: false, stamp: cutoff };
  marker.purge = cutoff;
  marker.fields = {};
  marker.records = [];
  delete marker.pendingLife;
  const repeatMerge = mergePeople(revised, emptied);
  assert.deepEqual(repeatMerge, mergePeople(emptied, revised));
  const sweep = repeatMerge.tasks.find(item => item.id === 'sweep');
  assert.equal(sweep.fields.repeat.value.every, 1);
  assert.equal(sweep.fields.due, undefined);
  assert.equal(sweep.life.value, false);
  const reader = new Tasks({ deviceId: 'reader', id: 'household-repeat', timeZone: 'UTC', now: () => T0 });
  reader.importPerson(repeatMerge);
  assert.throws(() => reader.task('sweep'), /emptied/);
  const titled = structuredClone(revised);
  titled.tasks[0].fields.title = { value: 'Sweep', stamp: { counter: repeatStamp.counter + 2, time: T0, device: 'editor' } };
  titled.tasks[0].life = { value: true, stamp: { counter: repeatStamp.counter + 3, time: T0, device: 'editor' } };
  const heldRepeat = mergePeople(emptied, titled);
  assert.deepEqual(heldRepeat, mergePeople(titled, emptied));
  assert.equal(heldRepeat.tasks[0].fields.title.value, 'Sweep');
  assert.equal(heldRepeat.tasks[0].fields.repeat.value.every, 1);
  assert.equal(heldRepeat.tasks[0].fields.due, undefined);
  assert.equal(heldRepeat.tasks[0].life.value, false);
  assert.equal(heldRepeat.tasks[0].pendingLife.value, true);

  const monday = engine('monday-edit', T0 + 4);
  const thursday = engine('thursday-edit', T0 + 8);
  monday.addTask({ title: 'Meet', due: '2026-03-02', repeat: { kind: 'weeks', every: 1, mode: 'onSchedule' } }, { taskId: 'meet' });
  thursday.importPerson(monday.getPerson());
  monday.complete('meet', at('2026-03-02T15:00:00.000Z'), { recordId: 'monday-done' });
  thursday.editTask('meet', { repeat: { kind: 'weekdays', every: 1, mode: 'onSchedule', weekdays: ['thursday'] } });
  for (const [left, right] of [[monday, thursday], [thursday, monday]]) {
    const copy = fork(mergePeople(left.getPerson(), right.getPerson()), `copy-${left.deviceId}`);
    assert.equal(copy.history('meet').some(row => row.occurrence === '2026-03-02' && row.type === 'completion'), true);
    assert.equal(copy.task('meet').occurrence, '2026-03-05');
  }

  const yearly = engine('yearly', T0 + 6);
  yearly.addTask({ title: 'Renew', due: '2025-12-31', repeat: { kind: 'years', every: 1, mode: 'onSchedule' } }, { taskId: 'renew' });
  yearly.complete('renew', at('2025-12-31T15:00:00.000Z'), { recordId: 'last-year' });
  assert.equal(yearly.task('renew').occurrence, '2026-12-31');
  const daily = engine('daily', T0 + 7);
  daily.importPerson(yearly.getPerson());
  daily.editTask('renew', { repeat: { kind: 'days', every: 1, mode: 'onSchedule' } });
  assert.equal(daily.task('renew').occurrence, '2026-12-31');
  assert.equal(fork(mergePeople(yearly.getPerson(), daily.getPerson()), 'either').task('renew').occurrence, '2026-12-31');

  const one = engine('reopen-a', T0 + 11);
  const two = engine('reopen-b', T0 + 12);
  one.addTask({ title: 'Shared', due: '2026-05-04', repeat: { kind: 'weeks', every: 1, mode: 'onSchedule' } }, { taskId: 'shared' });
  two.importPerson(one.getPerson());
  one.complete('shared', at('2026-05-04T15:00:00.000Z'), { recordId: 'only' });
  two.importPerson(one.getPerson());
  two.reopen('shared', { recordId: 'reopen-both', now: at('2026-05-04T18:00:00.000Z') });
  assert.equal(two.history('shared').find(row => row.id === 'only').undone, true);
  const reopened = fork(mergePeople(one.getPerson(), two.getPerson()), 'reopened');
  assert.equal(reopened.task('shared').occurrence, '2026-05-04');
  assert.equal(reopened.history('shared').find(row => row.id === 'only').undone, true);
  two.undo();
  assert.equal(two.history('shared').find(row => row.id === 'only').undone, false);
  assert.equal(two.task('shared').occurrence, '2026-05-11');
  const skipped = engine('skip-reopen', T0 + 16);
  skipped.addTask({ title: 'Skip me', due: '2026-05-11', repeat: { kind: 'weeks', every: 1, mode: 'onSchedule' } }, { taskId: 'skip-me' });
  skipped.skip('skip-me', at('2026-05-11T15:00:00.000Z'), { recordId: 'skipped' });
  skipped.reopen('skip-me', { recordId: 'reopen-skip', now: at('2026-05-11T18:00:00.000Z') });
  assert.equal(skipped.history('skip-me').find(row => row.id === 'skipped').undone, true);

  const partialA = engine('partial-a', T0 + 13);
  const partialB = engine('partial-b', T0 - 100);
  partialA.addTask({ title: 'Shared', due: '2026-05-04', repeat: { kind: 'weeks', every: 1, mode: 'onSchedule' } }, { taskId: 'shared' });
  partialB.importPerson(partialA.getPerson());
  partialA.complete('shared', at('2026-05-04T15:00:00.000Z'), { recordId: 'a1' });
  partialB.complete('shared', at('2026-05-04T16:00:00.000Z'), { recordId: 'b1' });
  partialA.reopen('shared', { recordId: 'only-a', now: at('2026-05-04T18:00:00.000Z') });
  for (const [left, right] of [[partialA, partialB], [partialB, partialA]]) {
    const copy = fork(mergePeople(left.getPerson(), right.getPerson()), `part-${left.deviceId}`);
    assert.equal(copy.task('shared').occurrence, '2026-05-11');
    assert.equal(copy.history('shared').find(row => row.id === 'a1').undone, true);
    assert.equal(copy.history('shared').find(row => row.id === 'b1').undone, false);
  }
  const sawBoth = fork(partialA.getPerson(), 'saw-both', T0 + 14);
  sawBoth.importPerson(partialB.getPerson());
  sawBoth.reopen('shared', { recordId: 'saw-both-reopen', now: at('2026-05-04T19:00:00.000Z') });
  assert.deepEqual(sawBoth.history('shared').find(row => row.id === 'saw-both-reopen').seen, ['a1', 'b1']);
  assert.equal(sawBoth.task('shared').occurrence, '2026-05-04');

  sawBoth.complete('shared', at('2026-05-05T15:00:00.000Z'), { recordId: 'again' });
  assert.equal(sawBoth.task('shared').occurrence, '2026-05-11');

  const undone = engine('undo-reopen', T0 + 15);
  undone.importPerson(one.getPerson());
  undone.reopen('shared', { recordId: 'temp', now: at('2026-05-04T20:00:00.000Z') });
  assert.equal(undone.task('shared').occurrence, '2026-05-04');
  undone.undo();
  const restored = fork(mergePeople(undone.getPerson(), one.getPerson()), 'restored');
  assert.equal(restored.task('shared').occurrence, '2026-05-11');

  const withdrawn = engine('withdrawn');
  withdrawn.addTask({ title: 'Again', due: '2026-07-01', repeat: { kind: 'weeks', every: 1, mode: 'onSchedule' } }, { taskId: 'again' });
  withdrawn.complete('again', at('2026-07-01T15:00:00.000Z'), { recordId: 'first' });
  const other = engine('other-withdrawn');
  other.importPerson(withdrawn.getPerson());
  withdrawn.undo();
  withdrawn.complete('again', at('2026-07-01T16:00:00.000Z'), { recordId: 'second' });
  const beat = fork(mergePeople(withdrawn.getPerson(), other.getPerson()), 'beat');
  assert.equal(beat.history('again').find(row => row.id === 'first').undone, true);
  assert.equal(beat.history('again').find(row => row.id === 'second').undone, false);
  assert.equal(beat.task('again').occurrence, '2026-07-08');
});

test('merge is commutative, associative and idempotent on 500 invented histories', () => {
  let state = 261024;
  const rand = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < 500; i += 1) {
    const origin = new Tasks({ deviceId: 'origin', id: 'household', timeZone: 'UTC', now: () => T0 + i });
    origin.addTask({ title: 'Shared', due: '2026-01-05', repeat: { kind: 'weeks', every: 1, mode: 'onSchedule' } }, { taskId: 'shared' });
    origin.addTask({ title: 'Once', due: '2026-02-01' }, { taskId: 'once' });
    const devices = ['alpha', 'beta', 'gamma'].map((name, index) => fork(origin.getPerson(), name, T0 - index * 1000));
    for (const copy of devices) {
      const steps = 1 + Math.floor(rand() * 4);
      for (let step = 0; step < steps; step += 1) {
        const roll = rand();
        const stamp = `${copy.deviceId}-${i}-${step}`;
        try {
          if (roll < 0.18) copy.editTask('shared', { note: stamp });
          else if (roll < 0.32) copy.complete('shared', T0 + step, { recordId: `${stamp}-c` });
          else if (roll < 0.42) copy.skip('shared', T0 + step, { recordId: `${stamp}-s` });
          else if (roll < 0.52) copy.snooze('shared', { preset: 'tomorrow' }, T0 + step * 1000, { recordId: `${stamp}-z` });
          else if (roll < 0.62) copy.editTask('once', { title: `Once ${stamp}`, priority: roll < 0.57 ? 'high' : null });
          else if (roll < 0.7) copy.editTask('shared', { repeat: { kind: 'days', every: 2, mode: 'onSchedule' } });
          else if (roll < 0.78) copy.drop('once', T0, { recordId: `${stamp}-d` });
          else if (roll < 0.84) copy.deleteTask(roll < 0.81 ? 'once' : 'shared');
          else if (roll < 0.9) copy.restoreTask('once');
          else if (roll < 0.95) copy.reopen('shared', { recordId: `${stamp}-r`, now: T0 + step });
          else copy.emptyTrash();
        } catch {
          // That operation does not apply to this copy.
        }
      }
    }
    const snaps = devices.map(copy => copy.getPerson());
    const ab = mergePeople(snaps[0], snaps[1]);
    assert.deepEqual(ab, mergePeople(snaps[1], snaps[0]), `order ${i}`);
    assert.deepEqual(mergePeople(ab, ab), ab, `twice ${i}`);
    assert.deepEqual(mergePeople(snaps[0], snaps[0]), snaps[0], `self ${i}`);
    assert.deepEqual(
      mergePeople(mergePeople(snaps[0], snaps[1]), snaps[2]),
      mergePeople(snaps[0], mergePeople(snaps[1], snaps[2])),
      `group ${i}`,
    );
  }
});

test('10. engine text has no grading words', () => {
  const desk = viewFixture();
  assertClean(desk.today(VIEW_NOW, VIEW_ZONE));
  assertClean(desk.upcoming(VIEW_NOW, 7, VIEW_ZONE));
  assertClean(desk.overdue(VIEW_NOW, VIEW_ZONE));
  assertClean(desk.history('finished'));
  assertClean(desk.remindersDue(VIEW_NOW - 86_400_000, VIEW_NOW, VIEW_ZONE));
  const errors = [
    message(() => desk.editTask('reg', { priority: 'low' })),
    message(() => desk.complete('finished', VIEW_NOW)),
    message(() => desk.skip('reg', VIEW_NOW)),
    message(() => desk.addTask({ title: '' })),
    message(() => deserializePerson('{"schemaVersion":99}')),
    message(() => desk.setTimeZone('Not/AZone')),
  ];
  assertClean(errors);
});

test('11. saving and loading round-trips, and bad files are refused', () => {
  const desk = engine();
  desk.addTask({ title: 'Renew registration', note: 'Folder', due: { dateTime: '2026-11-02T09:00', timeZone: ZONE }, reminders: [{ days: 1, hours: 2 }] }, { taskId: 'renew' });
  const before = desk.getPerson();
  assert.equal(before.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(deserializePerson(serializePerson(before)), before);
  const other = engine('other');
  other.load(desk.save());
  assert.deepEqual(other.getPerson(), before);
  assert.equal(desk.save(), serializePerson(before));

  assert.match(message(() => deserializePerson('{"schemaVersion":99}')), /Unsupported schemaVersion; expected 1/);
  assert.match(message(() => deserializePerson('{')), /Invalid task JSON/);
  const extra = structuredClone(before);
  extra.nickname = 'nope';
  assert.match(message(() => deserializePerson(JSON.stringify(extra))), /Unknown field/);
  const badZone = structuredClone(before);
  badZone.fields.timeZone.value = 'Not/AZone';
  assert.match(message(() => deserializePerson(JSON.stringify(badZone))), /Unknown time zone/);
  const extraStamp = structuredClone(before);
  extraStamp.fields.timeZone.stamp.note = 'extra';
  assert.throws(() => deserializePerson(JSON.stringify(extraStamp)), /Invalid field or version stamp/);
  const extraLife = structuredClone(before);
  extraLife.tasks[0].life.extra = true;
  assert.throws(() => deserializePerson(JSON.stringify(extraLife)), /Unknown field/);
  const extraPending = structuredClone(before);
  const pendingTask = extraPending.tasks[0];
  pendingTask.purge = pendingTask.life.stamp;
  pendingTask.life = { value: false, stamp: pendingTask.life.stamp };
  pendingTask.pendingLife = { value: true, stamp: pendingTask.life.stamp, extra: true };
  pendingTask.fields = {};
  pendingTask.records = [];
  assert.throws(() => deserializePerson(JSON.stringify(extraPending)), /Unknown field/);
  assert.throws(() => new Tasks({ deviceId: 'phone-a', id: 'maple-household', timeZone: ZONE }), /clock function is required/);

  const conflict = structuredClone(before);
  const stamp = conflict.tasks[0].fields.title.stamp;
  conflict.tasks[0].fields.note = { value: 'Other', stamp };
  const twin = structuredClone(before);
  twin.tasks[0].fields.note = { value: 'Different', stamp };
  assert.match(message(() => mergePeople(conflict, twin)), /Conflicting values share a version stamp/);
  twin.tasks[0].fields.note = { value: 'Other', stamp };
  assert.equal(mergePeople(conflict, twin).tasks[0].fields.note.value, 'Other');
});

test('12. hostile text is stored unchanged', () => {
  const hostile = `${'" <script>alert(1)</script> & 🥕 \\ \n \u202Eשלום '}${'z'.repeat(450)}`;
  assert.ok(hostile.length <= 500);
  const desk = engine();
  desk.addTask({ title: hostile, note: `${hostile}${'n'.repeat(4000)}`, list: hostile.slice(0, 200) }, { taskId: 'hostile' });
  const other = engine('other');
  other.load(desk.save());
  assert.equal(other.task('hostile').title, hostile);
  assert.equal(other.task('hostile').note.length, hostile.length + 4000);
  assert.equal({}.polluted, undefined);
});

test('13. the engine reads no clock and writes no files', (t) => {
  const RealDate = Date;
  const boom = name => () => { throw new Error(`clock read: ${name}`); };
  const localMethods = [
    'getDate', 'getDay', 'getFullYear', 'getHours', 'getMilliseconds', 'getMinutes', 'getMonth', 'getSeconds',
    'getTimezoneOffset', 'getYear', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString',
  ];
  const saved = Object.fromEntries(localMethods.map(name => [name, RealDate.prototype[name]]));
  const savedNow = RealDate.now;
  function NoClockDate(...args) {
    if (args.length === 0) throw new Error('clock read: new Date()');
    return new.target ? Reflect.construct(RealDate, args, new.target) : RealDate(...args);
  }
  NoClockDate.prototype = RealDate.prototype;
  NoClockDate.UTC = RealDate.UTC;
  NoClockDate.parse = RealDate.parse;
  NoClockDate.now = boom('Date.now');
  t.after(() => {
    globalThis.Date = RealDate;
    RealDate.now = savedNow;
    for (const name of localMethods) RealDate.prototype[name] = saved[name];
  });
  globalThis.Date = NoClockDate;
  RealDate.now = boom('Date.now');
  for (const name of localMethods) RealDate.prototype[name] = boom(`Date.prototype.${name}`);

  const desk = new Tasks({ deviceId: 'phone-a', id: 'maple-household', timeZone: ZONE, now: () => T0 });
  desk.addTask({ title: 'Clockless', due: { dateTime: '2026-03-08T02:30', timeZone: ZONE }, repeat: { kind: 'days', every: 1, mode: 'onSchedule' }, reminders: [{ days: 1 }] }, { taskId: 'clock' });
  desk.complete('clock', at('2026-03-08T15:00:00.000Z'), { recordId: 'c' });
  desk.snooze('clock', { preset: 'nextMonday' }, at('2026-03-09T15:00:00.000Z'), { recordId: 's' });
  desk.today(at('2026-03-10T15:00:00.000Z'), ZONE);
  desk.upcoming(at('2026-03-10T15:00:00.000Z'), 7, ZONE);
  desk.overdue(at('2026-03-10T15:00:00.000Z'), ZONE);
  desk.remindersDue(at('2026-03-01T00:00:00.000Z'), at('2026-03-20T00:00:00.000Z'), ZONE);
  const savedJson = desk.save();
  const other = new Tasks({ deviceId: 'phone-b', id: 'maple-household', timeZone: 'UTC', now: () => T0 });
  other.load(savedJson);
  mergePeople(desk.getPerson(), other.getPerson());
  occurrenceDates(rule({ kind: 'months', every: 1, start: '2024-01-31' }), 14);
  desk.undo();
  assert.equal(typeof savedJson, 'string');
});

test('invalid changes are atomic and returned data is a copy', () => {
  const desk = engine();
  desk.addTask({ title: 'Milk', due: '2026-05-01' }, { taskId: 'milk' });
  const before = desk.getPerson();
  assert.throws(() => desk.editTask('milk', { title: '' }), /1 to 500/);
  assert.throws(() => desk.addTask({ title: 'Milk' }, { taskId: 'milk' }), /already exists/);
  assert.throws(() => desk.upcoming(T0, 61, ZONE), /1 to 60/);
  assert.deepEqual(desk.getPerson(), before);
  const copy = desk.getPerson();
  copy.tasks[0].fields.title.value = 'Changed';
  assert.equal(desk.task('milk').title, 'Milk');
  assert.throws(() => mergePeople(before, { ...before, id: 'other' }), /different person IDs/);
});
