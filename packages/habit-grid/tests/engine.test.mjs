import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HabitGrid, mergePeople, serializePerson, deserializePerson, viewPerson, buildGrid, renderSvg,
  compareStamps, contrastRatio, SCHEMA_VERSION, DAY_STATES, WEEK_STATUSES, RANGE_DAYS, EMBER,
} from '../src/index.mjs';

const TODAY = '2026-03-18';
const CLOCK = Date.UTC(2026, 2, 18);
const BANNED = /failed|broke|score|\bmiss(?:ed)?\b|streak lost|\bbadge\b/i;

function fixed(deviceId, time = CLOCK) {
  return new HabitGrid({ deviceId, now: () => time, timeZone: 'UTC' });
}
function at(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}
function square(grid, date) {
  const found = grid.squares.find(item => item.date === date);
  assert.ok(found, date);
  return found;
}
function columnDates(grid) {
  return grid.columns.map(column => column.squares.map(item => item.date));
}
function message(fn) {
  try { fn(); } catch (error) { return error.message; }
  assert.fail('expected a throw');
}
function converges(left, right) {
  const beforeLeft = structuredClone(left);
  const beforeRight = structuredClone(right);
  const merged = mergePeople(left, right);
  assert.deepEqual(merged, mergePeople(right, left));
  assert.deepEqual(mergePeople(merged, merged), merged);
  assert.deepEqual(left, beforeLeft);
  assert.deepEqual(right, beforeRight);
  return merged;
}
function walk(value, found) {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) value.forEach(item => walk(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      found.push(key);
      walk(item, found);
    }
  }
}
function assertClean(value) {
  const found = [];
  walk(value, found);
  for (const text of found) assert.equal(BANNED.test(text), false, text);
}

test('1. each kind shades none, partial and full, and a count without a target has no full level', () => {
  const engine = fixed('phone-a');
  const id = engine.createPerson('River', { id: 'river' });
  const span = { today: TODAY, start: '2026-03-01', end: '2026-03-08' };
  engine.addTracker(id, { name: 'Vitamins', kind: 'done', color: 'magenta', startedOn: '2026-03-01' }, { trackerId: 'vitamins' });
  engine.addTracker(id, { name: 'Water', kind: 'count', color: 'coral', target: 8, unit: 'glasses', startedOn: '2026-03-01' }, { trackerId: 'water' });
  engine.addTracker(id, { name: 'Pages', kind: 'count', color: 'amber', target: null, startedOn: '2026-03-01' }, { trackerId: 'pages' });
  engine.addTracker(id, { name: 'Exercise', kind: 'amount', color: 'coral', target: 30, unit: 'minutes', startedOn: '2026-03-01' }, { trackerId: 'exercise' });

  engine.logCheckIn(id, 'vitamins', { date: '2026-03-02', value: 0.5, checkInId: 'v-partial' });
  engine.logCheckIn(id, 'vitamins', { date: '2026-03-03', checkInId: 'v-full' });
  for (const [date, value, checkInId] of [
    ['2026-03-02', 2, 'w2'], ['2026-03-03', 4, 'w4'], ['2026-03-04', 6, 'w6'], ['2026-03-05', 8, 'w8'], ['2026-03-06', 9, 'w9'],
  ]) engine.logCheckIn(id, 'water', { date, value, checkInId });
  for (const [date, value, checkInId] of [
    ['2026-03-02', 2, 'p2'], ['2026-03-03', 4, 'p4'], ['2026-03-04', 6, 'p6'], ['2026-03-05', 8, 'p8'], ['2026-03-06', 3, 'p3'],
  ]) engine.logCheckIn(id, 'pages', { date, value, checkInId });
  engine.logCheckIn(id, 'exercise', { date: '2026-03-02', value: 10, checkInId: 'e10' });
  engine.logCheckIn(id, 'exercise', { date: '2026-03-02', value: 10, checkInId: 'e10b' });
  engine.logCheckIn(id, 'exercise', { date: '2026-03-03', value: 15, checkInId: 'e15' });
  engine.logCheckIn(id, 'exercise', { date: '2026-03-04', value: 30, checkInId: 'e30' });

  const vitamins = engine.grid(id, 'vitamins', span);
  assert.deepEqual([square(vitamins, '2026-03-01').state, square(vitamins, '2026-03-01').shade], ['empty', 0]);
  assert.deepEqual([square(vitamins, '2026-03-02').state, square(vitamins, '2026-03-02').shade], ['partial', 2]);
  assert.deepEqual([square(vitamins, '2026-03-03').state, square(vitamins, '2026-03-03').shade], ['full', 4]);

  const water = engine.grid(id, 'water', span);
  assert.equal(water.fullLevel, true);
  assert.deepEqual([square(water, '2026-03-01').state, square(water, '2026-03-01').shade], ['empty', 0]);
  assert.deepEqual([square(water, '2026-03-02').state, square(water, '2026-03-02').shade], ['partial', 1]);
  assert.deepEqual([square(water, '2026-03-03').state, square(water, '2026-03-03').shade], ['partial', 2]);
  assert.deepEqual([square(water, '2026-03-04').state, square(water, '2026-03-04').shade], ['partial', 3]);
  assert.deepEqual([square(water, '2026-03-05').state, square(water, '2026-03-05').shade], ['full', 4]);
  assert.equal(square(water, '2026-03-06').state, 'full');

  const exercise = engine.grid(id, 'exercise', span);
  assert.equal(square(exercise, '2026-03-01').state, 'empty');
  assert.equal(square(exercise, '2026-03-02').value, 20);
  assert.deepEqual([square(exercise, '2026-03-02').state, square(exercise, '2026-03-02').shade], ['partial', 3]);
  assert.deepEqual([square(exercise, '2026-03-03').state, square(exercise, '2026-03-03').shade], ['partial', 2]);
  assert.deepEqual([square(exercise, '2026-03-04').state, square(exercise, '2026-03-04').shade], ['full', 4]);

  const pages = engine.grid(id, 'pages', span);
  assert.equal(pages.fullLevel, false);
  assert.equal(pages.target, null);
  assert.deepEqual([square(pages, '2026-03-02').state, square(pages, '2026-03-02').shade], ['done', 1]);
  assert.deepEqual([square(pages, '2026-03-03').state, square(pages, '2026-03-03').shade], ['done', 2]);
  assert.deepEqual([square(pages, '2026-03-06').state, square(pages, '2026-03-06').shade], ['done', 2]);
  assert.deepEqual([square(pages, '2026-03-04').state, square(pages, '2026-03-04').shade], ['done', 3]);
  assert.deepEqual([square(pages, '2026-03-05').state, square(pages, '2026-03-05').shade], ['done', 4]);
  assert.equal(pages.squares.some(item => item.state === 'full'), false);
});

test('2. chosen days rest off-days, and times-per-week meets at three without judging the current week early', () => {
  const engine = fixed('phone-a');
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, {
    name: 'Stretch', kind: 'done', schedule: { type: 'days', days: ['friday', 'monday', 'wednesday'] }, startedOn: '2026-03-02',
  }, { trackerId: 'stretch' });
  for (const date of ['2026-03-02', '2026-03-04', '2026-03-06', '2026-03-09', '2026-03-13', '2026-03-16']) {
    engine.logCheckIn(id, 'stretch', { date, checkInId: `stretch-${date}` });
  }
  const chosen = engine.grid(id, 'stretch', { today: '2026-03-16', start: '2026-03-02', end: '2026-03-16' });
  assert.equal(square(chosen, '2026-03-03').state, 'rest');
  assert.equal(square(chosen, '2026-03-03').due, false);
  assert.equal(square(chosen, '2026-03-12').state, 'rest');
  assert.equal(square(chosen, '2026-03-11').state, 'empty');
  assert.equal(square(chosen, '2026-03-11').due, true);
  assert.equal(square(chosen, '2026-03-13').state, 'full');
  assert.deepEqual(chosen.streaks, { current: 2, longest: 4, unit: 'day' });
  assert.equal(chosen.squares.some(item => item.state === 'rest' && item.weekday !== 'monday' && item.weekday !== 'wednesday' && item.weekday !== 'friday' && item.date >= '2026-03-02' && item.date <= '2026-03-16' && item.state !== 'empty'), true);

  engine.addTracker(id, {
    name: 'Calls', kind: 'done', schedule: { type: 'timesPerWeek', times: 3 }, startedOn: '2026-02-22',
  }, { trackerId: 'calls' });
  for (const date of ['2026-02-23', '2026-02-25', '2026-03-02', '2026-03-04', '2026-03-06', '2026-03-09', '2026-03-11', '2026-03-13', '2026-03-16']) {
    engine.logCheckIn(id, 'calls', { date, checkInId: `calls-${date}` });
  }
  const weekly = engine.grid(id, 'calls', { today: '2026-03-18', start: '2026-02-22', end: '2026-03-21' });
  const weekOf = start => weekly.columns.find(column => column.weekStart === start);
  assert.equal(square(weekly, '2026-02-24').state, 'open');
  assert.equal(square(weekly, '2026-03-02').state, 'done');
  assert.equal(square(weekly, '2026-03-03').state, 'open');
  assert.equal(weekOf('2026-02-22').doneDays, 2);
  assert.equal(weekOf('2026-02-22').status, 'unmet');
  assert.equal(weekOf('2026-03-01').doneDays, 3);
  assert.equal(weekOf('2026-03-01').met, true);
  assert.equal(weekOf('2026-03-01').status, 'met');
  assert.equal(weekOf('2026-03-15').status, 'inProgress');
  assert.equal(weekOf('2026-03-15').met, false);
  assert.deepEqual(weekly.streaks, { current: 2, longest: 2, unit: 'week' });
  assert.notEqual(weekly.streaks.current, 6);

  const saturday = engine.grid(id, 'calls', { today: '2026-03-21', start: '2026-03-15', end: '2026-03-21' });
  assert.equal(saturday.columns[0].status, 'inProgress');
  const ended = engine.grid(id, 'calls', { today: '2026-03-22', start: '2026-02-22', end: '2026-03-22' });
  assert.equal(ended.columns.find(column => column.weekStart === '2026-03-15').status, 'unmet');
  assert.deepEqual(ended.streaks, { current: 0, longest: 2, unit: 'week' });

  engine.logCheckIn(id, 'calls', { date: '2026-03-17', checkInId: 'calls-17' });
  engine.logCheckIn(id, 'calls', { date: '2026-03-18', checkInId: 'calls-18' });
  const reached = engine.grid(id, 'calls', { today: '2026-03-18', start: '2026-03-15', end: '2026-03-21' });
  assert.equal(reached.columns[0].met, true);
  assert.equal(reached.columns[0].doneDays, 3);
  assert.equal(reached.columns[0].status, 'inProgress');
});

test('3. rest days do not end a streak, a missed due day does, across month and year boundaries', () => {
  const engine = fixed('phone-a', at('2026-01-06'));
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Vitamins', kind: 'done', startedOn: '2025-12-28' }, { trackerId: 'vitamins' });
  for (const date of ['2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-02', '2026-01-04', '2026-01-05', '2026-01-06']) {
    engine.logCheckIn(id, 'vitamins', { date, checkInId: `v-${date}` });
  }
  engine.markRest(id, '2026-01-01', { restId: 'new-year' });
  const grid = engine.grid(id, 'vitamins', { start: '2025-12-28', end: '2026-01-06' });
  assert.deepEqual(columnDates(grid)[0], ['2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03']);
  assert.equal(square(grid, '2026-01-01').state, 'rest');
  assert.equal(square(grid, '2026-01-01').due, false);
  assert.equal(square(grid, '2026-01-03').state, 'empty');
  assert.equal(square(grid, '2026-01-03').due, true);
  assert.equal(square(grid, '2025-12-31').state, 'full');
  assert.equal(square(grid, '2026-01-02').state, 'full');
  assert.deepEqual(grid.streaks, { current: 3, longest: 5, unit: 'day' });
  assert.deepEqual(engine.grid(id, 'vitamins', { start: '2026-01-04', end: '2026-01-06' }).streaks, grid.streaks);

  const today = fixed('phone-a');
  const other = today.createPerson('Quinn', { id: 'quinn' });
  today.addTracker(other, { name: 'Walk', kind: 'done', startedOn: '2026-03-16' }, { trackerId: 'walk' });
  today.logCheckIn(other, 'walk', { date: '2026-03-16', checkInId: 'walk-16' });
  today.logCheckIn(other, 'walk', { date: '2026-03-17', checkInId: 'walk-17' });
  assert.deepEqual(today.grid(other, 'walk', { start: '2026-03-16', end: TODAY }).streaks, { current: 2, longest: 2, unit: 'day' });
  today.deleteCheckIn(other, 'walk-17');
  assert.deepEqual(today.grid(other, 'walk', { start: '2026-03-16', end: TODAY }).streaks, { current: 0, longest: 1, unit: 'day' });
});

test('4. Sunday and Monday week starts lay out leap day and daylight-saving weeks', () => {
  const engine = fixed('phone-a');
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Vitamins', kind: 'done', startedOn: '2024-02-01' }, { trackerId: 'vitamins' });
  const range = { start: '2024-02-26', end: '2024-03-11', today: '2024-03-20' };
  const sunday = engine.grid(id, 'vitamins', range);
  assert.deepEqual(sunday.rows, ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
  assert.equal(sunday.weekStartsOn, 'sunday');
  assert.deepEqual(columnDates(sunday), [
    ['2024-02-25', '2024-02-26', '2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02'],
    ['2024-03-03', '2024-03-04', '2024-03-05', '2024-03-06', '2024-03-07', '2024-03-08', '2024-03-09'],
    ['2024-03-10', '2024-03-11', '2024-03-12', '2024-03-13', '2024-03-14', '2024-03-15', '2024-03-16'],
  ]);
  assert.equal(square(sunday, '2024-02-29').weekday, 'thursday');
  assert.equal(square(sunday, '2024-03-10').weekday, 'sunday');

  engine.setWeekStartsOn(id, 'monday');
  const monday = engine.grid(id, 'vitamins', range);
  assert.deepEqual(monday.rows, ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
  assert.deepEqual(columnDates(monday), [
    ['2024-02-26', '2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02', '2024-03-03'],
    ['2024-03-04', '2024-03-05', '2024-03-06', '2024-03-07', '2024-03-08', '2024-03-09', '2024-03-10'],
    ['2024-03-11', '2024-03-12', '2024-03-13', '2024-03-14', '2024-03-15', '2024-03-16', '2024-03-17'],
  ]);
  assert.equal(square(monday, '2024-02-29').weekday, 'thursday');
  assert.equal(square(monday, '2024-03-10').weekday, 'sunday');
  assert.equal(square(monday, '2024-03-11').weekday, 'monday');

  engine.setWeekStartsOn(id, 'sunday');
  const fall = engine.grid(id, 'vitamins', { start: '2024-11-03', end: '2024-11-09', today: '2024-11-20' });
  assert.deepEqual(columnDates(fall), [['2024-11-03', '2024-11-04', '2024-11-05', '2024-11-06', '2024-11-07', '2024-11-08', '2024-11-09']]);
  engine.setWeekStartsOn(id, 'monday');
  const fallMonday = engine.grid(id, 'vitamins', { start: '2024-11-02', end: '2024-11-04', today: '2024-11-20' });
  assert.deepEqual(fallMonday.squares.map(item => item.date).filter(date => date >= '2024-11-02' && date <= '2024-11-04'), ['2024-11-02', '2024-11-03', '2024-11-04']);

  const phone = engine.grid(id, 'vitamins', { surface: 'phone', today: TODAY });
  const mac = engine.grid(id, 'vitamins', { surface: 'mac', today: TODAY });
  const wall = engine.grid(id, 'vitamins', { surface: 'wall', today: TODAY });
  assert.equal(phone.start, '2025-12-17');
  assert.equal(phone.end, TODAY);
  assert.equal(RANGE_DAYS.phone, 92);
  assert.equal(mac.start, '2025-09-17');
  assert.equal(mac.end, TODAY);
  assert.equal(RANGE_DAYS.mac, 183);
  assert.equal(wall.start, mac.start);
  assert.ok(phone.squares.some(item => item.date < phone.start && item.inRange === false));
  assert.equal(square(phone, phone.start).inRange, true);
});

test('5. checking a stack writes usual amounts only, and members can be logged alone', () => {
  const engine = fixed('phone-a');
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Vitamins', kind: 'done', usualAmount: 5, startedOn: '2026-03-01' }, { trackerId: 'vitamins' });
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses', startedOn: '2026-03-01' }, { trackerId: 'water' });
  engine.addTracker(id, { name: 'Stretch', kind: 'amount', target: 30, unit: 'minutes', usualAmount: 30, startedOn: '2026-03-01' }, { trackerId: 'stretch' });
  const stack = engine.addStack(id, { name: 'Morning', members: ['water', 'vitamins', 'stretch'] }, { stackId: 'morning' });
  const before = engine.getPerson(id);
  const checked = engine.checkStack(id, stack, { date: '2026-03-10' });
  assert.deepEqual(checked.needsValue, [{ trackerId: 'water', name: 'Water', kind: 'count' }]);
  assert.deepEqual(checked.written.map(item => [item.trackerId, item.value, item.kind]), [['stretch', 30, 'amount'], ['vitamins', 1, 'done']]);
  assert.equal(engine.view(id).checkIns.some(item => item.trackerId === 'water'), false);
  assert.equal(square(engine.grid(id, 'vitamins', { start: '2026-03-10', end: '2026-03-10' }), '2026-03-10').state, 'full');
  assert.deepEqual([square(engine.grid(id, 'stretch', { start: '2026-03-10', end: '2026-03-10' }), '2026-03-10').state, square(engine.grid(id, 'stretch', { start: '2026-03-10', end: '2026-03-10' }), '2026-03-10').value], ['full', 30]);
  assert.equal(square(engine.stackGrid(id, stack, { start: '2026-03-10', end: '2026-03-10' }), '2026-03-10').state, 'partial');
  assert.notDeepEqual(engine.getPerson(id).checkIns.length, before.checkIns.length);

  engine.logCheckIn(id, 'water', { date: '2026-03-10', value: 8, checkInId: 'water-alone' });
  engine.logCheckIn(id, 'vitamins', { date: '2026-03-11', checkInId: 'vitamins-alone' });
  assert.equal(square(engine.grid(id, 'water', { start: '2026-03-10', end: '2026-03-11' }), '2026-03-10').state, 'full');
  assert.equal(square(engine.grid(id, 'vitamins', { start: '2026-03-10', end: '2026-03-11' }), '2026-03-11').state, 'full');
  assert.equal(square(engine.stackGrid(id, stack, { start: '2026-03-10', end: '2026-03-10' }), '2026-03-10').state, 'full');
  const empty = engine.checkStack(id, stack, { date: '2026-03-12' });
  assert.equal(empty.needsValue[0].trackerId, 'water');
  assert.equal(engine.view(id).checkIns.filter(item => item.date === '2026-03-12' && item.trackerId === 'water').length, 0);
});

test('6. editing and removing check-ins, Trash and restore', () => {
  const engine = fixed('phone-a');
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses', startedOn: '2026-03-01' }, { trackerId: 'water' });
  engine.logCheckIn(id, 'water', { date: '2026-03-04', value: 1, checkInId: 'keep' });
  engine.logCheckIn(id, 'water', { date: '2026-03-04', value: 17.5, checkInId: 'drop' });
  assert.equal(square(engine.grid(id, 'water', { start: '2026-03-04', end: '2026-03-05' }), '2026-03-04').value, 18.5);
  engine.editCheckIn(id, 'drop', { value: 3, date: '2026-03-05' });
  assert.equal(square(engine.grid(id, 'water', { start: '2026-03-04', end: '2026-03-05' }), '2026-03-04').value, 1);
  assert.equal(square(engine.grid(id, 'water', { start: '2026-03-04', end: '2026-03-05' }), '2026-03-05').value, 3);
  engine.deleteCheckIn(id, 'drop');
  assert.equal(engine.view(id).checkIns.some(item => item.id === 'drop'), false);
  assert.equal(engine.view(id, { trash: true }).checkIns[0].id, 'drop');
  assert.equal(square(engine.grid(id, 'water', { start: '2026-03-04', end: '2026-03-05' }), '2026-03-05').value, 0);
  engine.restoreCheckIn(id, 'drop');
  assert.equal(engine.view(id).checkIns.find(item => item.id === 'drop').value, 3);
  engine.deleteCheckIn(id, 'drop');
  engine.emptyTrash(id);
  assert.equal(engine.view(id, { trash: true }).checkIns.length, 0);
  assert.deepEqual(engine.getPerson(id).checkIns.find(item => item.id === 'drop').fields, {});
  assert.throws(() => engine.restoreCheckIn(id, 'drop'), /emptied/);
  const offline = fixed('phone-b');
  offline.load(serializePerson({
    ...engine.getPerson(id),
    checkIns: engine.getPerson(id).checkIns.map(item => item.id === 'drop' ? {
      id: 'drop',
      life: { value: true, stamp: { counter: 1, time: 1, device: 'phone-b' } },
      purge: null,
      fields: {
        trackerId: { value: 'water', stamp: { counter: 1, time: 1, device: 'phone-b' } },
        date: { value: '2026-03-05', stamp: { counter: 1, time: 1, device: 'phone-b' } },
        value: { value: 17.5, stamp: { counter: 1, time: 1, device: 'phone-b' } },
        source: { value: 'manual', stamp: { counter: 1, time: 1, device: 'phone-b' } },
      },
    } : item),
  }));
  engine.importPerson(offline.getPerson(id));
  assert.equal(engine.view(id).checkIns.some(item => item.id === 'drop'), false);
  assert.ok(!engine.save(id).includes('17.5'));
});

test('7. engine text has no grading words', () => {
  const engine = fixed('phone-a');
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses', schedule: { type: 'timesPerWeek', times: 3 }, startedOn: '2026-03-01' }, { trackerId: 'water' });
  engine.addTracker(id, { name: 'Vitamins', kind: 'done', startedOn: '2026-03-01' }, { trackerId: 'vitamins' });
  engine.addStack(id, { name: 'Morning', members: ['vitamins'] }, { stackId: 'morning' });
  engine.logCheckIn(id, 'water', { date: '2026-03-02', value: 3, checkInId: 'w' });
  engine.markRest(id, '2026-03-03', { trackerId: 'vitamins', restId: 'rest' });
  const produced = [
    engine.view(id),
    engine.view(id, { trash: true }),
    engine.grid(id, 'water'),
    engine.grid(id, 'vitamins'),
    engine.stackGrid(id, 'morning'),
    engine.svg(id, 'water'),
    engine.stackSvg(id, 'morning'),
    engine.checkStack(id, 'morning'),
    engine.save(id),
    DAY_STATES.join(' '),
    WEEK_STATUSES.join(' '),
    message(() => deserializePerson('{"schemaVersion":99}')),
    message(() => engine.logCheckIn(id, 'water', { value: 1, source: 'voice' })),
    message(() => engine.addTracker(id, { name: 'Bad', kind: 'amount', unit: '' })),
    message(() => mergePeople(engine.getPerson(id), { ...engine.getPerson(id), id: 'other' })),
  ];
  for (const value of produced) assertClean(value);
});

test('8. SVG contrast and shapes distinguish rest and full days', () => {
  const engine = fixed('phone-a');
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Water <glasses> & more', kind: 'count', color: 'coral', target: 4, unit: 'glasses', startedOn: '2026-03-16' }, { trackerId: 'water' });
  engine.addTracker(id, { name: 'Pages', kind: 'count', color: 'magenta', startedOn: '2026-03-15' }, { trackerId: 'pages' });
  engine.logCheckIn(id, 'water', { date: '2026-03-17', value: 2, checkInId: 'partial' });
  engine.logCheckIn(id, 'water', { date: '2026-03-18', value: 4, checkInId: 'full' });
  engine.logCheckIn(id, 'pages', { date: '2026-03-15', value: 4, checkInId: 'top' });
  engine.logCheckIn(id, 'pages', { date: '2026-03-16', value: 1, checkInId: 'low' });
  engine.logCheckIn(id, 'pages', { date: '2026-03-17', value: 2, checkInId: 'mid' });
  engine.logCheckIn(id, 'pages', { date: '2026-03-18', value: 3, checkInId: 'high' });
  engine.logCheckIn(id, 'pages', { date: '2026-03-20', value: 4, checkInId: 'ahead' });
  engine.markRest(id, '2026-03-19', { restId: 'rest' });
  const span = { start: '2026-03-16', end: '2026-03-20' };
  const water = renderSvg(engine.grid(id, 'water', span));
  const pages = renderSvg(engine.grid(id, 'pages', { ...span, today: TODAY }));
  const pale = renderSvg({ ...engine.grid(id, 'water', span), color: '#15110f' });
  assert.equal(water.includes('href='), false);
  assert.equal(water.includes('url('), false);
  assert.match(water, /&lt;glasses&gt;/);
  assert.match(water, /&amp;/);
  for (const svg of [water, pages, pale]) auditSvg(svg);
  const full = group(water, 'check');
  const rest = group(water, 'rest');
  const open = group(water, 'dashed');
  const partial = group(water, 'bars');
  const empty = group(water, 'outline');
  const done = group(pages, 'diamond');
  const diamonds = [...pages.matchAll(/<g\b[^>]*data-shade="([1-4])"[^>]*data-shape="diamond"[\s\S]*?<\/g>/g)];
  const points = Object.fromEntries(diamonds.map(match => [match[1], /points="([^"]+)" fill="#/.exec(match[0])[1]]));
  assert.deepEqual(Object.keys(points).sort(), ['1', '2', '3', '4']);
  assert.match(pages, /data-date="2026-03-15" data-state="done" data-shade="4"/);
  assert.match(pages, /data-date="2026-03-20" data-state="open" data-shade="0"/);
  assert.equal(points['1'], '7,4 10,7 7,10 4,7');
  assert.equal(points['4'], '7,1 13,7 7,13 1,7');
  assert.notEqual(points['2'], points['3']);
  assert.match(full, /<path /);
  assert.match(rest, /<circle /);
  assert.match(rest, /<line /);
  assert.doesNotMatch(rest, /<path /);
  assert.match(open, /stroke-dasharray="2 2"/);
  assert.match(done, /<polygon /);
  assert.match(partial, /data-shade="2"/);
  assert.equal(partial.match(/fill="#[0-9a-f]{6}"/g).length, 2);
  assert.match(empty, /fill="none"/);
  assert.ok(contrastRatio('#ffffff', '#000000') > 20);
  assert.ok(contrastRatio(EMBER.coral, EMBER.background) > 4.5);
  assert.ok(contrastRatio(EMBER.magenta, EMBER.background) >= 3);
  assert.ok(contrastRatio(EMBER.text, EMBER.background) > 4.5);
});

function group(svg, shape) {
  const match = svg.match(new RegExp(`<g\\b[^>]*data-shape="${shape}"[\\s\\S]*?<\\/g>`));
  assert.ok(match, shape);
  return match[0];
}
function localContrast(foreground, background) {
  const lum = hex => {
    const channels = [1, 3, 5].map(offset => {
      const byte = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return byte <= 0.04045 ? byte / 12.92 : ((byte + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const lighter = Math.max(lum(foreground), lum(background));
  const darker = Math.min(lum(foreground), lum(background));
  return (lighter + 0.05) / (darker + 0.05);
}
function auditSvg(svg) {
  const tags = svg.match(/<(?:rect|circle|path|line|polygon|text)\b[^>]*>/g) ?? [];
  assert.ok(tags.length > 4);
  for (const tag of tags) {
    const role = /data-role="([^"]+)"/.exec(tag)?.[1];
    if (role === 'background' || !role) continue;
    const against = /data-against="(#[0-9a-f]{6})"/.exec(tag)?.[1];
    const fill = /fill="(#[0-9a-f]{6}|none)"/.exec(tag)?.[1];
    const stroke = /stroke="(#[0-9a-f]{6})"/ .exec(tag)?.[1];
    const color = fill && fill !== 'none' ? fill : stroke;
    assert.ok(color && against, tag);
    const minimum = role === 'text' ? 4.5 : 3;
    assert.ok(localContrast(color, against) >= minimum, `${color} on ${against}`);
  }
}

test('9. merge is commutative and keeps separate check-ins by ID', () => {
  const a = fixed('phone-a', 100);
  const b = fixed('phone-b', 100);
  const id = a.createPerson('River', { id: 'river' });
  a.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  a.addTracker(id, { name: 'Vitamins', kind: 'done' }, { trackerId: 'vitamins' });
  a.addStack(id, { name: 'Morning' }, { stackId: 'morning' });
  b.importPerson(a.getPerson(id));
  a.editTracker(id, 'water', { name: 'River water' });
  a.setWeekStartsOn(id, 'monday');
  a.setStackMember(id, 'morning', 'water', true);
  b.editTracker(id, 'vitamins', { color: 'amber' });
  b.renamePerson(id, 'Cedar');
  b.setStackMember(id, 'morning', 'vitamins', true);
  b.markRest(id, '2026-04-01', { restId: 'away' });
  let merged = converges(a.getPerson(id), b.getPerson(id));
  a.importPerson(merged);
  const view = a.view(id);
  assert.equal(view.name, 'Cedar');
  assert.equal(view.weekStartsOn, 'monday');
  assert.equal(view.trackers.find(item => item.id === 'water').name, 'River water');
  assert.equal(view.trackers.find(item => item.id === 'vitamins').color, 'amber');
  assert.deepEqual(view.stacks[0].members, ['vitamins', 'water']);
  assert.equal(view.restDays[0].date, '2026-04-01');

  const tie = fixed('phone-a', 100);
  const other = fixed('phone-b', 100);
  const tieId = tie.createPerson('River', { id: 'river' });
  tie.addTracker(tieId, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  other.importPerson(tie.getPerson(tieId));
  tie.editTracker(tieId, 'water', { name: 'A water' });
  other.editTracker(tieId, 'water', { name: 'B water' });
  tie.importPerson(converges(tie.getPerson(tieId), other.getPerson(tieId)));
  assert.equal(tie.view(tieId).trackers[0].name, 'B water');

  const early = fixed('phone-a', 100);
  const behind = fixed('behind', -10_000_000);
  const skew = early.createPerson('River', { id: 'river' });
  early.addTracker(skew, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  behind.importPerson(early.getPerson(skew));
  early.editTracker(skew, 'water', { name: 'Earlier' });
  behind.importPerson(early.getPerson(skew));
  behind.editTracker(skew, 'water', { name: 'Later' });
  early.importPerson(converges(early.getPerson(skew), behind.getPerson(skew)));
  assert.equal(early.view(skew).trackers[0].name, 'Later');
  assert.equal(compareStamps({ counter: 2, time: 1, device: 'a' }, { counter: 1, time: 9_000_000, device: 'z' }), 1);

  const left = fixed('phone-a', 100);
  const right = fixed('phone-b', 100);
  const shared = left.createPerson('River', { id: 'river' });
  left.addTracker(shared, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  left.logCheckIn(shared, 'water', { date: '2026-03-04', value: 2, checkInId: 'glass' });
  right.importPerson(left.getPerson(shared));
  left.editCheckIn(shared, 'glass', { value: 5 });
  right.importPerson(left.getPerson(shared));
  right.deleteCheckIn(shared, 'glass');
  left.importPerson(converges(left.getPerson(shared), right.getPerson(shared)));
  assert.equal(left.view(shared).checkIns.length, 0);
  left.restoreCheckIn(shared, 'glass');
  right.importPerson(converges(left.getPerson(shared), right.getPerson(shared)));
  assert.equal(right.view(shared).checkIns[0].value, 5);

  const home = fixed('phone-a', 100);
  const away = fixed('phone-b', 100);
  const person = home.createPerson('River', { id: 'river' });
  home.addTracker(person, { name: 'Old water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  home.logCheckIn(person, 'water', { date: '2026-03-04', value: 2, checkInId: 'glass' });
  away.importPerson(home.getPerson(person));
  home.deleteCheckIn(person, 'glass');
  home.emptyTrash(person);
  home.importPerson(converges(home.getPerson(person), away.getPerson(person)));
  assert.equal(home.view(person).checkIns.length, 0);
  assert.equal(home.view(person, { trash: true }).checkIns.length, 0);
  assert.deepEqual(home.getPerson(person).checkIns.find(item => item.id === 'glass').fields, {});
  const third = fixed('phone-c', 100);
  third.load(home.save(person));
  third.importPerson(away.getPerson(person));
  assert.deepEqual(third.view(person), home.view(person));

  home.deletePerson(person);
  home.emptyTrash(person);
  const wiped = home.getPerson(person);
  home.importPerson(converges(home.getPerson(person), away.getPerson(person)));
  assert.deepEqual(home.getPerson(person), wiped);
  home.renamePerson(person, 'New trackers');
  home.addTracker(person, { name: 'Fresh water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'fresh' });
  home.importPerson(away.getPerson(person));
  assert.equal(home.view(person).deleted, false);
  assert.deepEqual(home.view(person).trackers.map(item => item.id), ['fresh']);
  assert.ok(!home.save(person).includes('Old water'));

  const phone = fixed('phone-a', CLOCK);
  const tablet = fixed('tablet-b', CLOCK);
  const who = phone.createPerson('River', { id: 'river' });
  phone.addTracker(who, { name: 'Water', kind: 'count', target: 8, unit: 'glasses', startedOn: '2026-03-01' }, { trackerId: 'water' });
  tablet.importPerson(phone.getPerson(who));
  phone.logCheckIn(who, 'water', { date: '2026-03-04', value: 1, checkInId: 'from-phone' });
  tablet.logCheckIn(who, 'water', { date: '2026-03-04', value: 1, checkInId: 'from-tablet' });
  phone.editCheckIn(who, 'from-phone', { value: 3 });
  tablet.editCheckIn(who, 'from-tablet', { source: 'manual' });
  const both = converges(phone.getPerson(who), tablet.getPerson(who));
  const day = buildGrid(both, 'water', { today: TODAY, start: '2026-03-01', end: '2026-03-08' });
  assert.equal(square(day, '2026-03-04').value, 4);
  assert.equal(both.checkIns.filter(item => item.life.value).length, 2);
  assert.equal(JSON.stringify(both).includes('dayTotal'), false);
  const again = fixed('phone-c', CLOCK);
  const saved = serializePerson(both);
  again.load(saved);
  again.load(saved);
  assert.equal(again.getPerson(who).checkIns.length, 2);
  assert.equal(square(again.grid(who, 'water', { start: '2026-03-01', end: '2026-03-08' }), '2026-03-04').value, 4);

  const one = fixed('phone-a', 100);
  const two = fixed('phone-b', 100);
  const three = fixed('phone-c', 100);
  const groupId = one.createPerson('River', { id: 'river' });
  one.addTracker(groupId, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  two.importPerson(one.getPerson(groupId));
  three.importPerson(one.getPerson(groupId));
  one.editTracker(groupId, 'water', { name: 'From one' });
  two.logCheckIn(groupId, 'water', { date: '2026-03-04', value: 1, checkInId: 'from-two' });
  three.deleteTracker(groupId, 'water');
  three.emptyTrash(groupId);
  const snapshots = [one, two, three].map(device => device.getPerson(groupId));
  const reference = mergePeople(mergePeople(snapshots[0], snapshots[1]), snapshots[2]);
  for (const [i, j, k] of [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    assert.deepEqual(mergePeople(mergePeople(snapshots[i], snapshots[j]), snapshots[k]), reference);
  }
});

test('10. saving and loading round-trips, and an unknown schemaVersion is refused', () => {
  const engine = fixed('phone-a');
  const id = engine.createPerson('River', { id: 'river', weekStartsOn: 'monday' });
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses', schedule: { type: 'days', days: ['wednesday', 'monday'] }, startedOn: '2026-03-01' }, { trackerId: 'water' });
  engine.logCheckIn(id, 'water', { date: '2026-03-02', value: 2, checkInId: 'glass' });
  engine.addStack(id, { name: 'Morning', members: ['water'] }, { stackId: 'morning' });
  const before = engine.getPerson(id);
  assert.equal(before.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(deserializePerson(serializePerson(before)), before);
  const other = fixed('phone-b');
  other.load(engine.save(id));
  assert.deepEqual(other.getPerson(id), before);
  assert.throws(() => deserializePerson('{"schemaVersion":99}'), /Unsupported schemaVersion; expected 1\./);
  assert.throws(() => deserializePerson('{'), /Invalid person JSON/);
  assert.throws(() => deserializePerson('{"schemaVersion":1}'), /Invalid record/);
  const malformed = structuredClone(before);
  malformed.checkIns[0].fields.value.value = 'many';
  assert.throws(() => deserializePerson(JSON.stringify(malformed)), /Invalid field value/);
  const missingDate = structuredClone(before);
  delete missingDate.checkIns[0].fields.date;
  assert.throws(() => deserializePerson(JSON.stringify(missingDate)), /Incomplete record in person file/);
  assert.throws(() => engine.importPerson(missingDate), /Incomplete record in person file/);
  const missingKind = structuredClone(before);
  delete missingKind.trackers[0].fields.kind;
  assert.throws(() => deserializePerson(JSON.stringify(missingKind)), /Incomplete record in person file/);
  const impossible = structuredClone(before);
  impossible.trackers[0].fields.kind.value = 'amount';
  impossible.trackers[0].fields.target.value = null;
  impossible.trackers[0].fields.unit.value = 'minutes';
  assert.throws(() => deserializePerson(JSON.stringify(impossible)), /Invalid tracker shape in person file/);
  const purged = structuredClone(before);
  purged.checkIns[0].fields = {};
  purged.checkIns[0].life = { value: false, stamp: purged.checkIns[0].life.stamp };
  purged.checkIns[0].purge = purged.checkIns[0].life.stamp;
  assert.equal(deserializePerson(JSON.stringify(purged)).checkIns[0].fields.date, undefined);
  const voiced = structuredClone(before);
  voiced.checkIns[0].fields.source.value = 'voice';
  const loaded = deserializePerson(JSON.stringify(voiced));
  assert.equal(loaded.checkIns[0].fields.source.value, 'voice');
  assert.throws(() => engine.logCheckIn(id, 'water', { value: 1, source: 'automatic' }), /Only manual/);
});

test('people stay independent, invalid edits are atomic, and returned snapshots are copies', () => {
  const engine = fixed('phone-a');
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  const before = engine.getPerson(id);
  const other = engine.createPerson('Quinn', { id: 'quinn' });
  engine.addTracker(other, { name: 'Walk', kind: 'done' }, { trackerId: 'walk' });
  engine.deletePerson(other);
  assert.deepEqual(engine.getPerson(id), before);
  assert.deepEqual(engine.personIds(), [id]);
  assert.deepEqual(engine.personIds({ trash: true }), [other]);
  assert.throws(() => engine.editTracker(id, 'water', { target: 'eight' }), /Count target/);
  assert.throws(() => engine.addTracker(id, { name: 'Duplicate', kind: 'done' }, { trackerId: 'water' }), /already exists/);
  assert.throws(() => engine.setWeekStartsOn(id, 'friday'), /Unknown week start/);
  assert.throws(() => engine.addTracker(id, { name: 'Lift', kind: 'amount', target: 20 }), /need a unit/);
  assert.throws(() => engine.addTracker(id, { name: 'Done', kind: 'done', target: 2 }), /do not use a target/);
  assert.deepEqual(engine.getPerson(id), before);
  const copy = engine.getPerson(id);
  copy.fields.name.value = 'Mutated';
  assert.deepEqual(engine.getPerson(id), before);
  const grid = engine.grid(id, 'water', { start: '2026-03-01', end: '2026-03-07' });
  grid.squares[0].state = 'full';
  assert.equal(engine.grid(id, 'water', { start: '2026-03-01', end: '2026-03-07' }).squares[0].state, 'open');
});

test('prototype-like IDs, hostile text, purge re-add and stamp key order stay plain data', () => {
  const engine = fixed('phone-a');
  const hostile = '" <tag> & 🥕 \\ \n' + 'z'.repeat(10_000);
  const id = engine.createPerson(hostile, { id: 'river' });
  engine.addTracker(id, { name: hostile, kind: 'count', unit: hostile, color: '#F37A4A' }, { trackerId: '__proto__' });
  engine.logCheckIn(id, '__proto__', { date: '2026-03-04', value: 1, checkInId: 'constructor' });
  engine.addStack(id, { name: hostile }, { stackId: 'constructor' });
  engine.setStackMember(id, 'constructor', '__proto__', true);
  assert.equal({}.polluted, undefined);
  const other = fixed('phone-b');
  other.load(engine.save(id));
  assert.equal(other.view(id).name, hostile);
  assert.equal(other.view(id).trackers[0].name, hostile);
  assert.equal(other.view(id).trackers[0].color, '#f37a4a');
  assert.equal(other.view(id).stacks[0].members[0], '__proto__');
  const svg = other.svg(id, '__proto__', { start: '2026-03-01', end: '2026-03-07' });
  assert.match(svg, /&lt;tag&gt;/);
  assert.equal(svg.includes('<tag>'), false);

  const home = fixed('phone-a', 100);
  const away = fixed('phone-b', 100);
  const person = home.createPerson('River', { id: 'river' });
  home.addTracker(person, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  away.importPerson(home.getPerson(person));
  home.deleteTracker(person, 'water');
  home.emptyTrash(person);
  home.addTracker(person, { name: 'Fresh water', kind: 'count', target: 4, unit: 'cups' }, { trackerId: 'water' });
  home.importPerson(converges(home.getPerson(person), away.getPerson(person)));
  assert.equal(home.view(person).trackers[0].name, 'Fresh water');
  assert.equal(home.view(person).trackers[0].unit, 'cups');

  const original = home.getPerson(person);
  const reordered = JSON.parse(home.save(person), (key, value) => {
    if (value && typeof value === 'object' && Object.hasOwn(value, 'counter')) return { device: value.device, time: value.time, counter: value.counter };
    return value;
  });
  assert.deepEqual(mergePeople(original, reordered), original);
  const corrupt = structuredClone(original);
  corrupt.trackers[0].fields.name.value = 'Changed without a new stamp';
  assert.throws(() => mergePeople(original, corrupt), /Conflicting values/);
});

test('concurrent shape edits stay a real tracker, and a lone target change still merges by stamp', () => {
  const phone = fixed('phone-a', 100);
  const tablet = fixed('phone-b', 100);
  const id = phone.createPerson('River', { id: 'river' });
  phone.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  tablet.importPerson(phone.getPerson(id));
  phone.editTracker(id, 'water', { kind: 'amount', target: 30, unit: 'minutes' });
  tablet.editTracker(id, 'water', { target: null });
  const merged = converges(phone.getPerson(id), tablet.getPerson(id));
  const shape = merged.trackers[0].fields;
  assert.equal(shape.kind.value, 'count');
  assert.equal(shape.target.value, null);
  assert.equal(shape.unit.value, 'glasses');
  const editor = fixed('phone-c', 100);
  editor.importPerson(merged);
  editor.editTracker(id, 'water', { name: 'Still editable' });
  assert.equal(editor.view(id).trackers[0].name, 'Still editable');
  assert.equal(editor.view(id).trackers[0].kind, 'count');

  const rewritten = fixed('phone-a', 100);
  const clearing = fixed('phone-b', 100);
  const again = rewritten.createPerson('River', { id: 'river' });
  rewritten.addTracker(again, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  clearing.importPerson(rewritten.getPerson(again));
  clearing.editTracker(again, 'water', { target: null });
  rewritten.importPerson(clearing.getPerson(again));
  rewritten.editTracker(again, 'water', { kind: 'amount', target: 30, unit: 'minutes' });
  const newerShape = converges(rewritten.getPerson(again), clearing.getPerson(again));
  assert.equal(newerShape.trackers[0].fields.kind.value, 'amount');
  assert.equal(newerShape.trackers[0].fields.target.value, 30);
  assert.equal(newerShape.trackers[0].fields.unit.value, 'minutes');

  const later = fixed('phone-a', 100);
  const other = fixed('phone-b', 100);
  const plain = later.createPerson('River', { id: 'river' });
  later.addTracker(plain, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  other.importPerson(later.getPerson(plain));
  later.editTracker(plain, 'water', { target: 10 });
  other.editTracker(plain, 'water', { name: 'From tablet' });
  const fields = converges(later.getPerson(plain), other.getPerson(plain)).trackers[0].fields;
  assert.equal(fields.target.value, 10);
  assert.equal(fields.kind.value, 'count');
  assert.equal(fields.name.value, 'From tablet');

  const home = fixed('phone-a', 100);
  const away = fixed('phone-b', 100);
  const wiped = home.createPerson('River', { id: 'river' });
  home.addTracker(wiped, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  away.importPerson(home.getPerson(wiped));
  home.deleteTracker(wiped, 'water');
  home.emptyTrash(wiped);
  away.renamePerson(wiped, 'River two');
  away.renamePerson(wiped, 'River three');
  away.renamePerson(wiped, 'River four');
  away.editTracker(wiped, 'water', { target: null });
  const fenced = converges(home.getPerson(wiped), away.getPerson(wiped));
  const fencedTracker = fenced.trackers.find(item => item.id === 'water');
  assert.equal(fencedTracker.fields.kind.value, 'count');
  assert.equal(fencedTracker.fields.target.value, null);
  assert.equal(fencedTracker.fields.name, undefined);
  const fencedView = fixed('phone-c', 100);
  fencedView.importPerson(fenced);
  assert.equal(fencedView.view(wiped).trackers.length, 0);
  assert.equal(fencedView.save(wiped).includes('"kind"'), true);

  const kept = fixed('phone-a', 100);
  const partial = fixed('phone-b', 100);
  const person = kept.createPerson('River', { id: 'river' });
  kept.addTracker(person, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  partial.importPerson(kept.getPerson(person));
  kept.deleteTracker(person, 'water');
  kept.emptyTrash(person);
  kept.addTracker(person, { name: 'Fresh water', kind: 'amount', target: 30, unit: 'minutes' }, { trackerId: 'water' });
  partial.renamePerson(person, 'River two');
  partial.renamePerson(person, 'River three');
  partial.renamePerson(person, 'River four');
  partial.renamePerson(person, 'River five');
  partial.editTracker(person, 'water', { target: null });
  const replaced = converges(kept.getPerson(person), partial.getPerson(person));
  assert.equal(replaced.trackers[0].fields.kind.value, 'count');
  assert.equal(replaced.trackers[0].fields.target.value, null);
  assert.equal(replaced.trackers[0].fields.unit.value, 'glasses');
  assert.equal(replaced.trackers[0].fields.name.value, 'Fresh water');
  assert.equal(replaced.trackers[0].fields.kind.stamp.counter, replaced.trackers[0].fields.target.stamp.counter);
  assert.equal(replaced.trackers[0].fields.kind.stamp.counter, replaced.trackers[0].fields.unit.stamp.counter);

  const writers = ['phone-a', 'phone-b', 'phone-c'].map(deviceId => fixed(deviceId, 100));
  const shared = writers[0].createPerson('River', { id: 'river' });
  writers[0].addTracker(shared, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  writers[1].importPerson(writers[0].getPerson(shared));
  writers[2].importPerson(writers[0].getPerson(shared));
  writers[0].editTracker(shared, 'water', { kind: 'amount', target: 30, unit: 'minutes' });
  writers[1].editTracker(shared, 'water', { target: null });
  writers[2].editTracker(shared, 'water', { target: 10 });
  const copies = writers.map(device => device.getPerson(shared));
  const orders = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  const agreed = mergePeople(mergePeople(copies[0], copies[1]), copies[2]);
  for (const [i, j, k] of orders) {
    assert.deepEqual(mergePeople(mergePeople(copies[i], copies[j]), copies[k]), agreed);
  }
  assert.equal(agreed.trackers[0].fields.kind.value, 'count');
  assert.equal(agreed.trackers[0].fields.target.value, 10);
  assert.equal(agreed.trackers[0].fields.unit.value, 'glasses');
  const after = fixed('phone-d', 100);
  after.importPerson(agreed);
  after.editTracker(shared, 'water', { name: 'Agreed' });
  assert.equal(after.view(shared).trackers[0].name, 'Agreed');
  assert.equal(after.view(shared).trackers[0].target, 10);

  const homeLog = fixed('phone-a', 100);
  const awayLog = fixed('phone-b', 100);
  const logged = homeLog.createPerson('River', { id: 'river' });
  homeLog.addTracker(logged, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  homeLog.logCheckIn(logged, 'water', { date: '2026-03-04', value: 2, checkInId: 'glass' });
  awayLog.importPerson(homeLog.getPerson(logged));
  homeLog.deleteCheckIn(logged, 'glass');
  homeLog.emptyTrash(logged);
  awayLog.renamePerson(logged, 'River two');
  awayLog.renamePerson(logged, 'River three');
  awayLog.renamePerson(logged, 'River four');
  awayLog.editCheckIn(logged, 'glass', { value: 9 });
  const fencedLog = converges(homeLog.getPerson(logged), awayLog.getPerson(logged));
  const glass = fencedLog.checkIns.find(item => item.id === 'glass');
  assert.equal(glass.fields.value.value, 9);
  assert.equal(glass.fields.date, undefined);
  const reloaded = fixed('phone-c', 100);
  reloaded.load(serializePerson(fencedLog));
  assert.equal(reloaded.view(logged).checkIns.length, 0);
  assert.equal(reloaded.grid(logged, 'water', { start: '2026-03-01', end: '2026-03-08' }).squares.find(item => item.date === '2026-03-04').value, 0);

  const logs = ['phone-a', 'phone-b', 'phone-c'].map(deviceId => fixed(deviceId, 100));
  const personId = logs[0].createPerson('River', { id: 'river' });
  logs[0].addTracker(personId, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  logs[0].logCheckIn(personId, 'water', { date: '2026-03-04', value: 2, checkInId: 'glass' });
  logs[1].importPerson(logs[0].getPerson(personId));
  logs[2].importPerson(logs[0].getPerson(personId));
  logs[0].deleteCheckIn(personId, 'glass');
  logs[0].emptyTrash(personId);
  for (const device of [logs[1], logs[2]]) {
    device.renamePerson(personId, 'River two');
    device.renamePerson(personId, 'River three');
    device.renamePerson(personId, 'River four');
  }
  logs[1].editCheckIn(personId, 'glass', { value: 9, source: 'manual' });
  logs[2].editCheckIn(personId, 'glass', { date: '2026-03-05', trackerId: 'water' });
  const logCopies = logs.map(device => device.getPerson(personId));
  const joined = mergePeople(mergePeople(logCopies[0], logCopies[1]), logCopies[2]);
  for (const [i, j, k] of [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    assert.deepEqual(mergePeople(mergePeople(logCopies[i], logCopies[j]), logCopies[k]), joined);
  }
  const joinedGlass = joined.checkIns.find(item => item.id === 'glass');
  assert.equal(joinedGlass.fields.value.value, 9);
  assert.equal(joinedGlass.fields.date.value, '2026-03-05');
  assert.equal(joinedGlass.fields.trackerId.value, 'water');
  assert.equal(joinedGlass.fields.source.value, 'manual');
  const shown = fixed('phone-d', 100);
  shown.importPerson(joined);
  assert.equal(shown.view(personId).checkIns[0].value, 9);
  assert.equal(shown.grid(personId, 'water', { start: '2026-03-01', end: '2026-03-08' }).squares.find(item => item.date === '2026-03-05').value, 9);
});

test('a purge fragment is not an active tracker, and an impossible shape fragment is refused', () => {
  const home = fixed('phone-a', 100);
  const away = fixed('phone-b', 100);
  const id = home.createPerson('River', { id: 'river' });
  home.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  away.importPerson(home.getPerson(id));
  home.deleteTracker(id, 'water');
  home.emptyTrash(id);
  away.renamePerson(id, 'River two');
  away.renamePerson(id, 'River three');
  away.renamePerson(id, 'River four');
  away.editTracker(id, 'water', { name: 'Hidden water' });
  const hidden = fixed('phone-c', 100);
  hidden.importPerson(converges(home.getPerson(id), away.getPerson(id)));
  assert.equal(hidden.view(id).trackers.length, 0);
  assert.throws(() => hidden.logCheckIn(id, 'water', { date: '2026-03-04', value: 1 }), /Tracker not found/);
  assert.throws(() => hidden.markRest(id, '2026-03-04', { trackerId: 'water' }), /Tracker not found/);
  hidden.addTracker(id, { name: 'Fresh', kind: 'count', target: 4, unit: 'cups' }, { trackerId: 'water' });
  assert.equal(hidden.view(id).trackers[0].name, 'Fresh');
  assert.equal(hidden.view(id).trackers[0].unit, 'cups');
  hidden.logCheckIn(id, 'water', { date: '2026-03-04', value: 1, checkInId: 'cup' });
  assert.equal(hidden.grid(id, 'water', { start: '2026-03-01', end: '2026-03-08' }).squares.find(item => item.date === '2026-03-04').value, 1);

  const base = fixed('phone-a', 100);
  const person = base.createPerson('River', { id: 'shape' });
  base.addTracker(person, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  const snap = base.getPerson(person);
  const tracker = snap.trackers.find(item => item.id === 'water');
  const stamp = tracker.fields.kind.stamp;
  tracker.purge = { counter: 1, time: stamp.time, device: stamp.device };
  for (const key of ['name', 'color', 'usualAmount', 'schedule', 'startedOn']) delete tracker.fields[key];
  tracker.fields.kind.value = 'amount';
  tracker.fields.target.value = null;
  tracker.fields.unit.value = 'minutes';
  assert.throws(() => deserializePerson(JSON.stringify(snap)), /Invalid tracker shape/);
  tracker.fields.target.value = 30;
  const loaded = deserializePerson(JSON.stringify(snap));
  assert.equal(loaded.trackers.find(item => item.id === 'water').fields.kind.value, 'amount');
  assert.equal(viewPerson(loaded).trackers.length, 0);

  const split = structuredClone(snap);
  for (const key of Object.keys(split.trackers[0].fields)) {
    if (key !== 'kind') delete split.trackers[0].fields[key];
  }
  assert.throws(() => deserializePerson(JSON.stringify(split)), /Invalid tracker shape/);
  const otherHalf = structuredClone(snap);
  for (const key of Object.keys(otherHalf.trackers[0].fields)) {
    if (key !== 'target' && key !== 'unit') delete otherHalf.trackers[0].fields[key];
  }
  otherHalf.trackers[0].fields.target.value = null;
  assert.throws(() => deserializePerson(JSON.stringify(otherHalf)), /Invalid tracker shape/);

  const left = base.getPerson(person);
  const right = base.getPerson(person);
  const leftShape = left.trackers[0].fields;
  const rightShape = right.trackers[0].fields;
  const shapeStamp = { ...leftShape.kind.stamp };
  for (const key of ['kind', 'target', 'unit']) leftShape[key].stamp = { ...shapeStamp, counter: 5 };
  leftShape.kind.value = 'amount';
  leftShape.target.value = 30;
  leftShape.unit.value = 'minutes';
  rightShape.kind.stamp = { ...shapeStamp, counter: 4 };
  rightShape.target.value = null;
  rightShape.target.stamp = { ...shapeStamp, counter: 6 };
  rightShape.unit.stamp = { ...shapeStamp, counter: 4 };
  assert.throws(() => mergePeople(left, right), /Invalid tracker shape/);
  assert.throws(() => mergePeople(right, left), /Invalid tracker shape/);
});

test('three-device histories converge under every delivery order', () => {
  let seed = 261016;
  const next = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  for (let run = 0; run < 30; run += 1) {
    const devices = [fixed('phone-a', 100), fixed('phone-b', 100), fixed('phone-c', -100000)];
    const id = devices[0].createPerson('River', { id: 'river' });
    devices[0].addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
    devices[0].addTracker(id, { name: 'Vitamins', kind: 'done' }, { trackerId: 'vitamins' });
    devices[0].addStack(id, { name: 'Morning', members: ['water'] }, { stackId: 'morning' });
    devices[1].importPerson(devices[0].getPerson(id));
    devices[2].importPerson(devices[0].getPerson(id));
    for (let step = 0; step < 10; step += 1) {
      const device = devices[next(3)];
      const live = device.view(id);
      switch (next(8)) {
        case 0: device.renamePerson(id, `River ${run}-${step}`); break;
        case 1: device.setWeekStartsOn(id, next(2) ? 'monday' : 'sunday'); break;
        case 2: if (live.trackers.some(item => item.id === 'water')) device.editTracker(id, 'water', { name: `Water ${step}` }); break;
        case 3: device.logCheckIn(id, 'water', { date: `2026-03-${String((step % 27) + 1).padStart(2, '0')}`, value: 1, checkInId: `log-${run}-${step}` }); break;
        case 4: {
          const checkIn = live.checkIns[0];
          if (checkIn) device.deleteCheckIn(id, checkIn.id);
          break;
        }
        case 5: device.emptyTrash(id); break;
        case 6: device.markRest(id, `2026-04-${String((step % 27) + 1).padStart(2, '0')}`, { restId: `rest-${run}-${step}` }); break;
        case 7: device.importPerson(devices[next(3)].getPerson(id)); break;
        default: break;
      }
    }
    const snapshots = devices.map(device => device.getPerson(id));
    for (const copy of snapshots) assert.deepEqual(mergePeople(copy, copy), copy, `self merge run ${run}`);
    const expected = mergePeople(mergePeople(snapshots[0], snapshots[1]), snapshots[2]);
    for (const [i, j, k] of [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      assert.deepEqual(mergePeople(mergePeople(snapshots[i], snapshots[j]), snapshots[k]), expected, `delivery order run ${run}`);
    }
  }
});

test('a complete record cannot revive a field at or before its purge cutoff', () => {
  const engine = fixed('phone-a', 100);
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  const prior = engine.getPerson(id);
  engine.deleteTracker(id, 'water');
  engine.emptyTrash(id);
  const erased = engine.getPerson(id);
  const revived = structuredClone(erased);
  const cutoff = revived.trackers[0].purge;
  const fresh = { counter: cutoff.counter + 3, time: cutoff.time + 3, device: 'phone-b' };
  revived.trackers[0].life = { value: true, stamp: fresh };
  revived.trackers[0].fields = Object.fromEntries(Object.entries(prior.trackers[0].fields).map(([key, entry]) => [key, { value: entry.value, stamp: { ...fresh } }]));
  revived.trackers[0].fields.name.stamp = { counter: cutoff.counter, time: cutoff.time, device: cutoff.device };
  assert.throws(() => deserializePerson(JSON.stringify(revived)), /Field is older than its purge cutoff/);
  assert.throws(() => engine.importPerson(revived), /Field is older than its purge cutoff/);
  assert.throws(() => mergePeople(revived, revived), /Field is older than its purge cutoff/);
  assert.equal(engine.view(id).trackers.length, 0);

  revived.trackers[0].fields.name.stamp = { ...fresh };
  const loaded = deserializePerson(JSON.stringify(revived));
  assert.deepEqual(mergePeople(loaded, loaded), loaded);
  const reader = fixed('phone-c', 100);
  reader.importPerson(loaded);
  assert.equal(reader.view(id).trackers[0].name, 'Water');
  assert.equal(reader.view(id).trackers.length, 1);
});

test('a saved person without a purge cutoff must include name and week start', () => {
  const engine = fixed('phone-a', 100);
  const id = engine.createPerson('River', { id: 'river', weekStartsOn: 'monday' });
  const saved = engine.getPerson(id);
  const missingName = structuredClone(saved);
  delete missingName.fields.name;
  assert.throws(() => deserializePerson(JSON.stringify(missingName)), /Incomplete record in person file/);
  assert.throws(() => engine.importPerson(missingName), /Incomplete record in person file/);
  const missingWeek = structuredClone(saved);
  delete missingWeek.fields.weekStartsOn;
  assert.throws(() => deserializePerson(JSON.stringify(missingWeek)), /Incomplete record in person file/);
  const trashed = structuredClone(saved);
  trashed.life = { value: false, stamp: { counter: 9, time: 9, device: 'phone-a' } };
  delete trashed.fields.weekStartsOn;
  assert.throws(() => deserializePerson(JSON.stringify(trashed)), /Incomplete record in person file/);

  engine.deletePerson(id);
  engine.emptyTrash(id);
  const purged = deserializePerson(JSON.stringify(engine.getPerson(id)));
  assert.equal(purged.fields.name, undefined);
  assert.equal(purged.fields.weekStartsOn, undefined);
  const fragment = structuredClone(purged);
  const stamp = { counter: fragment.purge.counter + 1, time: fragment.purge.time + 1, device: 'phone-b' };
  fragment.life = { value: true, stamp };
  fragment.fields = { name: { value: 'River', stamp } };
  const kept = deserializePerson(JSON.stringify(fragment));
  assert.equal(kept.fields.name.value, 'River');
  assert.equal(kept.fields.weekStartsOn, undefined);
});

test('renderSvg escapes square date, state, and shade', () => {
  const svg = renderSvg({
    name: 'Water',
    color: 'coral',
    start: '2026-03-01',
    end: '2026-03-01',
    weekStartsOn: 'sunday',
    rows: ['sunday'],
    columns: [{ squares: [{ date: 'x" onmouseover="alert(1)', state: 'full" onclick="alert(1)', shade: '1"><script>' }] }],
  });
  assert.doesNotMatch(svg, /onmouseover="/);
  assert.doesNotMatch(svg, /onclick="/);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /data-date="x&quot; onmouseover=&quot;alert\(1\)"/);
  assert.match(svg, /data-state="full&quot; onclick=&quot;alert\(1\)"/);
  assert.match(svg, /data-shade="1&quot;&gt;&lt;script&gt;"/);
  const engine = fixed('phone-a');
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Water', kind: 'done', startedOn: '2026-03-18' }, { trackerId: 'water' });
  const plain = engine.svg(id, 'water', { start: '2026-03-18', end: '2026-03-18' });
  assert.match(plain, /data-date="2026-03-18"/);
  assert.match(plain, /data-state="open"/);
  assert.match(plain, /data-shade="0"/);
});

test('a person purge cutoff fences nested tracker fields and stack members', () => {
  const engine = fixed('phone-a', 100);
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  engine.addStack(id, { name: 'Morning', members: ['water'] }, { stackId: 'morning' });
  const prior = engine.getPerson(id);
  engine.deletePerson(id);
  engine.emptyTrash(id);
  const erased = engine.getPerson(id);
  const cutoff = erased.purge;
  const fresh = { counter: cutoff.counter + 4, time: cutoff.time + 4, device: 'phone-b' };
  const revived = structuredClone(erased);
  revived.life = { value: true, stamp: { ...fresh } };
  revived.fields = {
    name: { value: 'River', stamp: { ...fresh } },
    weekStartsOn: { value: 'sunday', stamp: { ...fresh } },
  };
  const tracker = structuredClone(prior.trackers[0]);
  tracker.purge = null;
  tracker.life = { value: true, stamp: { ...fresh } };
  revived.trackers = [tracker];
  assert.throws(() => deserializePerson(JSON.stringify(revived)), /Field is older than its purge cutoff/);
  assert.throws(() => mergePeople(revived, revived), /Field is older than its purge cutoff/);
  assert.equal(viewPerson(erased).trackers.length, 0);

  for (const entry of Object.values(tracker.fields)) entry.stamp = { ...fresh };
  const stack = structuredClone(prior.stacks[0]);
  stack.purge = null;
  stack.life = { value: true, stamp: { ...fresh } };
  stack.fields.name.stamp = { ...fresh };
  revived.stacks = [stack];
  assert.throws(() => deserializePerson(JSON.stringify(revived)), /Field is older than its purge cutoff/);

  for (const entry of Object.values(stack.members)) entry.stamp = { ...fresh };
  const loaded = deserializePerson(JSON.stringify(revived));
  const merged = mergePeople(loaded, loaded);
  assert.deepEqual(mergePeople(merged, merged), merged);
  assert.equal(merged.trackers[0].life.value, true);
  assert.equal(merged.trackers[0].fields.name.value, 'Water');
  assert.equal(viewPerson(loaded).trackers[0].name, 'Water');
  assert.deepEqual(viewPerson(merged).stacks[0].members, ['water']);
});

test('a true life register at or before its purge cutoff is refused', () => {
  const engine = fixed('phone-a', 100);
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  const prior = engine.getPerson(id);
  engine.deleteTracker(id, 'water');
  engine.emptyTrash(id);
  const revived = structuredClone(engine.getPerson(id));
  const cutoff = revived.trackers[0].purge;
  const fresh = { counter: cutoff.counter + 3, time: cutoff.time + 3, device: 'phone-b' };
  revived.trackers[0].life = { value: true, stamp: { counter: cutoff.counter, time: cutoff.time, device: cutoff.device } };
  revived.trackers[0].fields = Object.fromEntries(Object.entries(prior.trackers[0].fields).map(([key, entry]) => [key, { value: entry.value, stamp: { ...fresh } }]));
  assert.throws(() => deserializePerson(JSON.stringify(revived)), /Life is older than its purge cutoff/);
  assert.throws(() => mergePeople(revived, revived), /Life is older than its purge cutoff/);

  const personPurge = { counter: fresh.counter + 2, time: fresh.time + 2, device: 'phone-a' };
  const afterPerson = { counter: personPurge.counter + 2, time: personPurge.time + 2, device: 'phone-b' };
  const personCutoff = structuredClone(prior);
  personCutoff.purge = personPurge;
  personCutoff.life = { value: true, stamp: { ...afterPerson } };
  for (const entry of Object.values(personCutoff.fields)) entry.stamp = { ...afterPerson };
  personCutoff.trackers[0].purge = null;
  for (const entry of Object.values(personCutoff.trackers[0].fields)) entry.stamp = { ...afterPerson };
  personCutoff.trackers[0].life = { value: true, stamp: { ...personPurge } };
  assert.throws(() => deserializePerson(JSON.stringify(personCutoff)), /Life is older than its purge cutoff/);

  revived.trackers[0].life = { value: true, stamp: { ...fresh } };
  const loaded = deserializePerson(JSON.stringify(revived));
  assert.deepEqual(mergePeople(loaded, loaded), loaded);
  assert.equal(viewPerson(loaded).trackers[0].name, 'Water');
});

test('a child write on an emptied person is refused and leaves the file unchanged', () => {
  const engine = fixed('phone-a', 100);
  const id = engine.createPerson('River', { id: 'river', weekStartsOn: 'monday' });
  engine.deletePerson(id);
  engine.emptyTrash(id);
  const before = engine.getPerson(id);
  assert.throws(() => engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' }), /Incomplete record in person file/);
  assert.deepEqual(engine.getPerson(id), before);
  assert.throws(() => engine.addStack(id, { name: 'Morning' }, { stackId: 'morning' }), /Incomplete record in person file/);
  assert.deepEqual(engine.getPerson(id), before);
  assert.throws(() => engine.markRest(id, '2026-03-04', { restId: 'rest' }), /Incomplete record in person file/);
  assert.deepEqual(engine.getPerson(id), before);
  assert.equal(engine.view(id).deleted, true);
  assert.equal(engine.view(id).trackers.length, 0);
  assert.equal(engine.save(id).includes('Water'), false);

  engine.renamePerson(id, 'River');
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  assert.equal(engine.view(id).deleted, false);
  assert.equal(engine.view(id).name, 'River');
  assert.equal(engine.view(id).trackers[0].name, 'Water');
  assert.doesNotThrow(() => engine.save(id));
});

test('emptying a deleted tracker purges its check-ins, rest days, and stack membership', () => {
  const home = fixed('phone-a', 100);
  const away = fixed('phone-b', 100);
  const id = home.createPerson('River', { id: 'river' });
  home.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  home.addTracker(id, { name: 'Vitamins', kind: 'done' }, { trackerId: 'vitamins' });
  home.logCheckIn(id, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  home.markRest(id, '2026-03-05', { trackerId: 'water', restId: 'water-rest' });
  home.markRest(id, '2026-03-06', { restId: 'all-rest' });
  home.addStack(id, { name: 'Morning', members: ['water', 'vitamins'] }, { stackId: 'morning' });
  away.importPerson(home.getPerson(id));
  away.logCheckIn(id, 'water', { date: '2026-03-03', value: 1, checkInId: 'extra' });
  home.deleteTracker(id, 'water');
  home.emptyTrash(id);
  assert.equal(home.view(id).checkIns.length, 0);
  assert.equal(home.view(id, { trash: true }).checkIns.length, 0);
  assert.deepEqual(home.getPerson(id).checkIns.find(item => item.id === 'glass').fields, {});
  assert.equal(home.view(id).restDays.some(item => item.id === 'water-rest'), false);
  assert.equal(home.view(id).restDays.some(item => item.id === 'all-rest'), true);
  assert.deepEqual(home.view(id).stacks[0].members, ['vitamins']);
  home.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'water' });
  const span = { start: '2026-03-01', end: '2026-03-08' };
  assert.equal(square(home.grid(id, 'water', span), '2026-03-04').value, 0);
  const reader = fixed('phone-c', 100);
  reader.importPerson(converges(home.getPerson(id), away.getPerson(id)));
  assert.deepEqual(reader.getPerson(id).checkIns.find(item => item.id === 'glass').fields, {});
  assert.deepEqual(reader.getPerson(id).checkIns.find(item => item.id === 'extra').fields, {});
  assert.equal(reader.view(id).checkIns.length, 0);
  assert.equal(square(reader.grid(id, 'water', span), '2026-03-03').value, 0);
  assert.equal(square(reader.grid(id, 'water', span), '2026-03-04').value, 0);
});

test('a week that is entirely rest does not break a times-per-week streak', () => {
  const engine = fixed('phone-a');
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Calls', kind: 'done', schedule: { type: 'timesPerWeek', times: 3 }, startedOn: '2026-03-01' }, { trackerId: 'calls' });
  for (const date of ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-15', '2026-03-16', '2026-03-17']) {
    engine.logCheckIn(id, 'calls', { date, checkInId: `calls-${date}` });
  }
  for (let day = 8; day <= 14; day += 1) engine.markRest(id, `2026-03-${String(day).padStart(2, '0')}`, { trackerId: 'calls', restId: `rest-${day}` });
  const span = { today: '2026-03-22', start: '2026-03-01', end: '2026-03-21' };
  const grid = engine.grid(id, 'calls', span);
  const week = start => grid.columns.find(column => column.weekStart === start);
  assert.equal(week('2026-03-01').status, 'met');
  assert.equal(week('2026-03-08').status, 'rest');
  assert.equal(week('2026-03-15').status, 'met');
  assert.deepEqual(grid.streaks, { current: 2, longest: 2, unit: 'week' });
  engine.addStack(id, { name: 'Morning', members: ['calls'] }, { stackId: 'morning' });
  const stack = engine.stackGrid(id, 'morning', span);
  assert.equal(stack.columns.find(column => column.weekStart === '2026-03-08').status, 'rest');
  assert.deepEqual(stack.streaks, { current: 2, longest: 2, unit: 'week' });
});

test('an evening check-in uses the local date, not the next UTC date', () => {
  const instant = Date.parse('2026-03-19T01:00:00.000Z');
  const local = new HabitGrid({ deviceId: 'phone-a', timeZone: 'America/Chicago', now: () => instant });
  const utc = new HabitGrid({ deviceId: 'phone-b', timeZone: 'UTC', now: () => instant });
  const localId = local.createPerson('River', { id: 'river' });
  const utcId = utc.createPerson('River', { id: 'river' });
  local.addTracker(localId, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  utc.addTracker(utcId, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  local.logCheckIn(localId, 'water', { value: 1, checkInId: 'evening' });
  utc.logCheckIn(utcId, 'water', { value: 1, checkInId: 'evening' });
  assert.equal(local.view(localId).checkIns[0].date, '2026-03-18');
  assert.equal(local.view(localId).trackers[0].startedOn, '2026-03-18');
  assert.equal(utc.view(utcId).checkIns[0].date, '2026-03-19');
  assert.throws(() => new HabitGrid({ deviceId: 'phone-c', timeZone: 'Not/AZone' }), /Unknown time zone/);
});

test('checking a stack twice does not write a second check-in', () => {
  const engine = fixed('phone-a');
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses', usualAmount: 4, startedOn: '2026-03-01' }, { trackerId: 'water' });
  engine.addTracker(id, { name: 'Vitamins', kind: 'done', startedOn: '2026-03-01' }, { trackerId: 'vitamins' });
  const stack = engine.addStack(id, { name: 'Morning', members: ['water', 'vitamins'] }, { stackId: 'morning' });
  const first = engine.checkStack(id, stack, { date: '2026-03-10' });
  assert.deepEqual(first.written.map(item => item.trackerId), ['vitamins', 'water']);
  assert.deepEqual(first.alreadyLogged, []);
  const second = engine.checkStack(id, stack, { date: '2026-03-10' });
  assert.deepEqual(second.written, []);
  assert.deepEqual(second.alreadyLogged.map(item => item.trackerId), ['vitamins', 'water']);
  assert.equal(engine.view(id).checkIns.filter(item => item.date === '2026-03-10').length, 2);
  assert.equal(square(engine.grid(id, 'water', { start: '2026-03-10', end: '2026-03-10' }), '2026-03-10').value, 4);
  assert.equal(square(engine.grid(id, 'vitamins', { start: '2026-03-10', end: '2026-03-10' }), '2026-03-10').state, 'full');
});

test('svg title ids differ by grid', () => {
  const engine = fixed('phone-a');
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Water', kind: 'done', startedOn: '2026-03-18' }, { trackerId: 'water' });
  engine.addTracker(id, { name: 'Walk', kind: 'done', startedOn: '2026-03-18' }, { trackerId: 'walk' });
  const span = { start: '2026-03-18', end: '2026-03-18' };
  const water = engine.svg(id, 'water', span);
  const walk = engine.svg(id, 'walk', span);
  assert.match(water, /id="habit-7_tracker-5_river-5_water-10_2026-03-18-10_2026-03-18-title"/);
  assert.match(water, /aria-labelledby="habit-7_tracker-5_river-5_water-10_2026-03-18-10_2026-03-18-title habit-7_tracker-5_river-5_water-10_2026-03-18-10_2026-03-18-desc"/);
  assert.match(walk, /id="habit-7_tracker-5_river-4_walk-10_2026-03-18-10_2026-03-18-title"/);
  assert.equal(water.includes('id="habit-title"'), false);
  const other = fixed('phone-b');
  const glen = other.createPerson('Glen', { id: 'glen' });
  other.addTracker(glen, { name: 'Water', kind: 'done', startedOn: '2026-03-18' }, { trackerId: 'water' });
  other.addStack(glen, { name: 'Morning', members: ['water'] }, { stackId: 'morning' });
  engine.addStack(id, { name: 'Morning', members: ['water'] }, { stackId: 'morning' });
  const glenWater = other.svg(glen, 'water', span);
  assert.match(glenWater, /id="habit-7_tracker-4_glen-5_water-10_2026-03-18-10_2026-03-18-title"/);
  assert.equal(water.includes('habit-7_tracker-4_glen-5_water-10_2026-03-18-10_2026-03-18-title'), false);
  assert.match(engine.stackSvg(id, 'morning', span), /id="habit-5_stack-5_river-7_morning-10_2026-03-18-10_2026-03-18-title"/);
  assert.match(other.stackSvg(glen, 'morning', span), /id="habit-5_stack-4_glen-7_morning-10_2026-03-18-10_2026-03-18-title"/);
  engine.addStack(id, { name: 'Water stack', members: ['water'] }, { stackId: 'water' });
  const waterStack = engine.stackSvg(id, 'water', span);
  assert.match(waterStack, /id="habit-5_stack-5_river-5_water-10_2026-03-18-10_2026-03-18-title"/);
  assert.equal(water.includes('id="habit-5_stack-5_river-5_water-10_2026-03-18-10_2026-03-18-title"'), false);
  assert.equal(waterStack.includes('id="habit-7_tracker-5_river-5_water-10_2026-03-18-10_2026-03-18-title"'), false);
  const longer = { start: '2026-03-18', end: '2026-03-25' };
  const waterLonger = engine.svg(id, 'water', longer);
  const stackLonger = engine.stackSvg(id, 'water', longer);
  assert.match(waterLonger, /id="habit-7_tracker-5_river-5_water-10_2026-03-18-10_2026-03-25-title"/);
  assert.match(stackLonger, /id="habit-5_stack-5_river-5_water-10_2026-03-18-10_2026-03-25-title"/);
  assert.equal(water.includes('id="habit-7_tracker-5_river-5_water-10_2026-03-18-10_2026-03-25-title"'), false);
  assert.equal(waterStack.includes('id="habit-5_stack-5_river-5_water-10_2026-03-18-10_2026-03-25-title"'), false);
  const base = engine.grid(id, 'water', span);
  const titleId = (personId, gridId) => {
    const svg = renderSvg({ ...base, personId, id: gridId });
    const found = svg.match(/id="(habit-[A-Za-z0-9_-]+)-title"/);
    assert.ok(found, personId);
    assert.equal(svg.includes('onload="'), false);
    return found[1];
  };
  assert.notEqual(titleId('ab', 'water'), titleId('a.b', 'water'));
  assert.notEqual(titleId('a-b', 'c'), titleId('a', 'b-c'));
  const hostile = renderSvg({ ...base, id: 'x" onload="alert(1)', personId: 'y" onload="alert(2)' });
  assert.equal(hostile.includes('onload="'), false);
  assert.match(hostile, /id="habit-[A-Za-z0-9_-]+-title"/);
});

test('tracker fencing keeps a post-cutoff check-in fragment until another replica completes it', () => {
  const origin = fixed('phone-a', 100);
  const id = origin.createPerson('River', { id: 'river' });
  origin.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  const base = origin.getPerson(id);
  origin.deleteTracker(id, 'water');
  origin.emptyTrash(id);
  const purger = origin.getPerson(id);
  const cutoff = purger.trackers.find(item => item.id === 'water').purge;
  const oldStamp = { counter: 1, time: 50, device: 'phone-b' };
  const stampA = { counter: cutoff.counter + 1, time: cutoff.time + 1, device: 'phone-b' };
  const stampB = { counter: cutoff.counter + 2, time: cutoff.time + 2, device: 'phone-c' };
  const editorA = structuredClone(base);
  const editorB = structuredClone(base);
  editorA.checkIns.push({
    id: 'glass',
    life: { value: true, stamp: stampA },
    purge: null,
    fields: {
      trackerId: { value: 'water', stamp: oldStamp },
      date: { value: '2026-03-09', stamp: stampA },
      value: { value: 7, stamp: stampA },
      source: { value: 'manual', stamp: oldStamp },
    },
  });
  editorB.checkIns.push({
    id: 'glass',
    life: { value: true, stamp: stampB },
    purge: null,
    fields: {
      trackerId: { value: 'water', stamp: stampB },
      date: { value: '2026-03-04', stamp: oldStamp },
      value: { value: 5, stamp: oldStamp },
      source: { value: 'manual', stamp: stampB },
    },
  });
  editorA.restDays.push({
    id: 'water-rest',
    life: { value: true, stamp: stampA },
    purge: null,
    fields: {
      date: { value: '2026-03-11', stamp: stampA },
      trackerId: { value: 'water', stamp: oldStamp },
    },
  });
  editorB.restDays.push({
    id: 'water-rest',
    life: { value: true, stamp: stampB },
    purge: null,
    fields: {
      date: { value: '2026-03-05', stamp: oldStamp },
      trackerId: { value: 'water', stamp: stampB },
    },
  });

  const partial = mergePeople(purger, editorA);
  const kept = partial.checkIns.find(item => item.id === 'glass');
  assert.equal(kept.fields.value.value, 7);
  assert.equal(kept.fields.date.value, '2026-03-09');
  assert.equal(kept.fields.trackerId, undefined);
  assert.equal(kept.fields.source, undefined);
  assert.equal(kept.life.value, true);
  assert.equal(viewPerson(partial).checkIns.length, 0);
  assert.equal(viewPerson(partial).restDays.length, 0);
  assert.equal(partial.restDays.find(item => item.id === 'water-rest').fields.date.value, '2026-03-11');

  const copies = [purger, editorA, editorB];
  const joined = mergePeople(mergePeople(copies[0], copies[1]), copies[2]);
  for (const [i, j, k] of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    assert.deepEqual(mergePeople(mergePeople(copies[i], copies[j]), copies[k]), joined);
  }
  const glass = joined.checkIns.find(item => item.id === 'glass');
  assert.equal(glass.fields.value.value, 7);
  assert.equal(glass.fields.date.value, '2026-03-09');
  assert.equal(glass.fields.trackerId.value, 'water');
  assert.equal(glass.fields.source.value, 'manual');
  assert.equal(joined.restDays.find(item => item.id === 'water-rest').fields.date.value, '2026-03-11');
  assert.equal(viewPerson(joined).checkIns.length, 1);
  assert.equal(viewPerson(joined).restDays[0].date, '2026-03-11');
  assert.deepEqual(mergePeople(joined, joined), joined);

  const reader = fixed('phone-d', 100);
  reader.importPerson(joined);
  reader.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'water' });
  assert.equal(square(reader.grid(id, 'water', { start: '2026-03-01', end: '2026-03-12' }), '2026-03-09').value, 7);
  assert.equal(square(reader.grid(id, 'water', { start: '2026-03-01', end: '2026-03-12' }), '2026-03-04').value, 0);
});

test('a child stamped before its tracker purge is refused at load', () => {
  const engine = fixed('phone-a', 100);
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  engine.addStack(id, { name: 'Morning', members: ['water'] }, { stackId: 'morning' });
  engine.deleteTracker(id, 'water');
  engine.emptyTrash(id);
  const purged = engine.getPerson(id);
  const cutoff = purged.trackers.find(item => item.id === 'water').purge;
  const old = { counter: cutoff.counter, time: cutoff.time, device: cutoff.device };
  const fresh = { counter: cutoff.counter + 3, time: cutoff.time + 3, device: 'phone-b' };
  const stale = structuredClone(purged);
  stale.checkIns = [{
    id: 'glass',
    life: { value: true, stamp: { counter: old.counter + 1, time: old.time + 1, device: 'phone-b' } },
    purge: null,
    fields: {
      trackerId: { value: 'water', stamp: { ...old } },
      date: { value: '2026-03-04', stamp: { ...old } },
      value: { value: 5, stamp: { ...old } },
      source: { value: 'manual', stamp: { ...old } },
    },
  }];
  assert.throws(() => deserializePerson(JSON.stringify(stale)), /Field is older than its purge cutoff/);
  assert.throws(() => mergePeople(stale, stale), /Field is older than its purge cutoff/);
  assert.throws(() => viewPerson(stale), /Field is older than its purge cutoff/);

  const lifeStale = structuredClone(stale);
  for (const entry of Object.values(lifeStale.checkIns[0].fields)) entry.stamp = { ...fresh };
  lifeStale.checkIns[0].life = { value: true, stamp: { ...old } };
  assert.throws(() => deserializePerson(JSON.stringify(lifeStale)), /Life is older than its purge cutoff/);

  const rest = structuredClone(purged);
  rest.restDays = [{
    id: 'water-rest',
    life: { value: true, stamp: { ...fresh } },
    purge: null,
    fields: {
      date: { value: '2026-03-05', stamp: { ...old } },
      trackerId: { value: 'water', stamp: { ...old } },
    },
  }];
  assert.throws(() => deserializePerson(JSON.stringify(rest)), /Field is older than its purge cutoff/);
  assert.throws(() => mergePeople(rest, rest), /Field is older than its purge cutoff/);

  const stack = structuredClone(purged);
  stack.stacks[0].members.water = { value: true, stamp: { ...old } };
  assert.throws(() => deserializePerson(JSON.stringify(stack)), /Field is older than its purge cutoff/);
  assert.throws(() => mergePeople(stack, stack), /Field is older than its purge cutoff/);

  const fragment = structuredClone(purged);
  fragment.checkIns = [{
    id: 'glass',
    life: { value: true, stamp: { ...fresh } },
    purge: { ...cutoff },
    fenced: { ...cutoff },
    fields: {
      trackerId: { value: 'water', stamp: { ...fresh } },
      date: { value: '2026-03-09', stamp: { ...fresh } },
      value: { value: 7, stamp: { ...fresh } },
    },
  }];
  const loaded = deserializePerson(JSON.stringify(fragment));
  assert.equal(viewPerson(loaded).checkIns.length, 0);
  assert.equal(loaded.checkIns[0].fields.value.value, 7);
  const reader = fixed('phone-c', 100);
  reader.importPerson(loaded);
  const stored = reader.getPerson(id);
  assert.deepEqual(mergePeople(stored, stored), stored);
  assert.equal(stored.checkIns[0].fields.value.value, 7);
  assert.equal(reader.view(id).checkIns.length, 0);

  const later = structuredClone(purged);
  later.checkIns = [{
    id: 'later',
    life: { value: true, stamp: { ...fresh } },
    purge: null,
    fields: {
      trackerId: { value: 'water', stamp: { ...fresh } },
      date: { value: '2026-03-10', stamp: { ...fresh } },
      value: { value: 2, stamp: { ...fresh } },
      source: { value: 'manual', stamp: { ...fresh } },
    },
  }];
  later.stacks[0].members.water = { value: true, stamp: { ...fresh } };
  const accepted = deserializePerson(JSON.stringify(later));
  assert.equal(viewPerson(accepted).checkIns[0].value, 2);
  assert.deepEqual(viewPerson(accepted).stacks[0].members, ['water']);
  const keeper = fixed('phone-d', 100);
  keeper.importPerson(accepted);
  const absorbed = mergePeople(keeper.getPerson(id), keeper.getPerson(id));
  assert.deepEqual(mergePeople(absorbed, absorbed), absorbed);
  assert.equal(absorbed.checkIns.find(item => item.id === 'later').fields.value.value, 2);
  assert.equal(absorbed.checkIns.find(item => item.id === 'later').purge.counter, cutoff.counter);
  assert.equal(viewPerson(absorbed).checkIns[0].value, 2);
});

test('moving a check-in to a live tracker does not restore fields purged with the old tracker', () => {
  const home = fixed('phone-a', 100);
  const away = fixed('phone-b', 100);
  const id = home.createPerson('River', { id: 'river' });
  home.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  home.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  away.importPerson(home.getPerson(id));
  away.logCheckIn(id, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  const original = away.getPerson(id);
  home.deleteTracker(id, 'water');
  home.emptyTrash(id);
  away.renamePerson(id, 'River two');
  away.renamePerson(id, 'River');
  away.editCheckIn(id, 'glass', { trackerId: 'steps' });
  const moved = away.getPerson(id);
  assert.equal(moved.checkIns.find(item => item.id === 'glass').formerTrackers.water.value, true);
  assert.equal(moved.checkIns.find(item => item.id === 'glass').fields.trackerId.value, 'steps');
  const purger = home.getPerson(id);
  const span = { start: '2026-03-01', end: '2026-03-08' };
  const hidden = snapshot => {
    const reader = fixed('phone-c', 100);
    reader.importPerson(snapshot);
    assert.equal(reader.view(id).checkIns.length, 0);
    assert.equal(square(reader.grid(id, 'steps', span), '2026-03-04').value, 0);
    const glass = reader.getPerson(id).checkIns.find(item => item.id === 'glass');
    assert.equal(glass.fields.date, undefined);
    assert.equal(glass.fields.value, undefined);
    assert.equal(glass.fields.source, undefined);
    return reader;
  };
  hidden(converges(purger, moved));

  const hand = structuredClone(original);
  const handGlass = hand.checkIns.find(item => item.id === 'glass');
  handGlass.fields.trackerId = { value: 'steps', stamp: { ...moved.checkIns.find(item => item.id === 'glass').fields.trackerId.stamp } };
  handGlass.life = structuredClone(moved.checkIns.find(item => item.id === 'glass').life);
  const copies = [purger, original, hand];
  const joined = mergePeople(mergePeople(copies[0], copies[1]), copies[2]);
  for (const [i, j, k] of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    assert.deepEqual(mergePeople(mergePeople(copies[i], copies[j]), copies[k]), joined);
  }
  hidden(joined);
  readerAddsWater(hidden(joined));
  function readerAddsWater(reader) {
    reader.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
    assert.equal(square(reader.grid(id, 'water', span), '2026-03-04').value, 0);
  }
});

test('a check-in moved across three trackers keeps a purged middle tracker from restoring old fields', () => {
  const home = fixed('phone-a', 100);
  const away = fixed('phone-b', 100);
  const id = home.createPerson('River', { id: 'river' });
  home.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  home.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  home.addTracker(id, { name: 'Pages', kind: 'count', target: 8, unit: 'pages' }, { trackerId: 'pages' });
  away.importPerson(home.getPerson(id));
  away.logCheckIn(id, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  home.deleteTracker(id, 'steps');
  home.emptyTrash(id);
  away.editCheckIn(id, 'glass', { trackerId: 'steps' });
  away.editCheckIn(id, 'glass', { trackerId: 'pages' });
  const moved = away.getPerson(id);
  const span = { start: '2026-03-01', end: '2026-03-08' };
  const reader = fixed('phone-c', 100);
  reader.importPerson(converges(home.getPerson(id), moved));
  assert.equal(reader.view(id).checkIns.length, 0);
  assert.equal(square(reader.grid(id, 'pages', span), '2026-03-04').value, 0);
  const stored = reader.getPerson(id).checkIns.find(item => item.id === 'glass');
  assert.equal(stored.fields.date, undefined);
  assert.equal(stored.fields.value, undefined);
  assert.equal(stored.fields.source, undefined);
  const glass = moved.checkIns.find(item => item.id === 'glass');
  assert.equal(glass.fields.trackerId.value, 'pages');
  assert.equal(glass.fields.value.value, 5);
  assert.equal(glass.formerTrackers.water.value, true);
  assert.equal(glass.formerTrackers.steps.value, true);
  assert.equal(stored.formerTrackers.water.value, true);
  assert.equal(stored.formerTrackers.steps.value, true);
  const leaked = structuredClone(moved);
  const purgedSteps = structuredClone(home.getPerson(id).trackers.find(item => item.id === 'steps'));
  leaked.trackers = leaked.trackers.map(item => item.id === 'steps' ? purgedSteps : item);
  assert.throws(() => deserializePerson(JSON.stringify(leaked)), /Field is older than its purge cutoff/);
  reader.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  assert.equal(square(reader.grid(id, 'steps', span), '2026-03-04').value, 0);
  assert.equal(square(reader.grid(id, 'pages', span), '2026-03-04').value, 0);
});

test('emptying Trash fences a check-in that already moved off the deleted tracker', () => {
  const engine = fixed('phone-a', 100);
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  engine.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  engine.logCheckIn(id, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  engine.editCheckIn(id, 'glass', { trackerId: 'steps' });
  engine.deleteTracker(id, 'water');
  engine.emptyTrash(id);
  const span = { start: '2026-03-01', end: '2026-03-08' };
  assert.equal(engine.view(id).checkIns.length, 0);
  assert.equal(engine.view(id, { trash: true }).checkIns.length, 0);
  assert.equal(square(engine.grid(id, 'steps', span), '2026-03-04').value, 0);
  const glass = engine.getPerson(id).checkIns.find(item => item.id === 'glass');
  assert.equal(glass.fields.date, undefined);
  assert.equal(glass.fields.value, undefined);
  assert.equal(glass.fields.source, undefined);
  assert.equal(glass.formerTrackers.water.value, true);
  assert.doesNotThrow(() => engine.save(id));
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  assert.equal(square(engine.grid(id, 'water', span), '2026-03-04').value, 0);
  assert.equal(square(engine.grid(id, 'steps', span), '2026-03-04').value, 0);
});

test('a purged tracker in one history does not resurrect a newer deletion from another replica', () => {
  const origin = fixed('phone-o', 100);
  const id = origin.createPerson('River', { id: 'river' });
  origin.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  origin.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  const mover = fixed('phone-m', 100);
  const editor = fixed('phone-e', 100);
  const deleter = fixed('phone-d', 100);
  const purger = fixed('phone-p', 100);
  mover.importPerson(origin.getPerson(id));
  purger.importPerson(origin.getPerson(id));
  mover.logCheckIn(id, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  const logged = mover.getPerson(id);
  editor.importPerson(logged);
  deleter.importPerson(logged);
  mover.editCheckIn(id, 'glass', { trackerId: 'steps' });
  mover.editCheckIn(id, 'glass', { trackerId: 'water' });
  purger.deleteTracker(id, 'steps');
  purger.emptyTrash(id);
  mover.importPerson(purger.getPerson(id));
  editor.renamePerson(id, 'River two');
  editor.editCheckIn(id, 'glass', { value: 9 });
  deleter.renamePerson(id, 'River two');
  deleter.renamePerson(id, 'River three');
  deleter.renamePerson(id, 'River four');
  deleter.deleteCheckIn(id, 'glass');
  const copies = [mover, editor, deleter].map(device => device.getPerson(id));
  const joined = mergePeople(mergePeople(copies[1], copies[0]), copies[2]);
  for (const [i, j, k] of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const merged = mergePeople(mergePeople(copies[i], copies[j]), copies[k]);
    assert.equal(merged.checkIns.find(item => item.id === 'glass').life.value, false);
    assert.equal(viewPerson(merged).checkIns.length, 0);
    assert.deepEqual(merged, joined);
  }
  assert.deepEqual(mergePeople(joined, joined), joined);
});

test('emptying Trash again does not renew an already emptied tracker cutoff', () => {
  const home = fixed('phone-a', 100);
  const away = fixed('phone-b', 100);
  const id = home.createPerson('River', { id: 'river' });
  home.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  home.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  away.importPerson(home.getPerson(id));
  home.deleteTracker(id, 'water');
  home.emptyTrash(id);
  const cutoff = home.getPerson(id).trackers.find(item => item.id === 'water').purge;
  away.renamePerson(id, 'River two');
  away.renamePerson(id, 'River three');
  away.renamePerson(id, 'River four');
  away.logCheckIn(id, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  away.editCheckIn(id, 'glass', { trackerId: 'steps' });
  away.addStack(id, { name: 'Morning', members: ['water', 'steps'] }, { stackId: 'morning' });
  home.importPerson(away.getPerson(id));
  const span = { start: '2026-03-01', end: '2026-03-08' };
  assert.equal(home.view(id).checkIns[0].value, 5);
  assert.equal(home.view(id, { trash: true }).trackers.length, 0);
  const marker = home.getPerson(id).trackers.find(item => item.id === 'water');
  assert.deepEqual(marker.purge, cutoff);
  home.emptyTrash(id);
  const glass = home.getPerson(id).checkIns.find(item => item.id === 'glass');
  assert.equal(glass.life.value, true);
  assert.equal(glass.fields.value.value, 5);
  assert.equal(glass.fields.date.value, '2026-03-04');
  assert.equal(glass.formerTrackers.water.value, true);
  assert.equal(square(home.grid(id, 'steps', span), '2026-03-04').value, 5);
  assert.deepEqual(home.getPerson(id).trackers.find(item => item.id === 'water'), marker);
  assert.deepEqual(home.view(id).stacks[0].members, ['steps', 'water']);
});

test('restoring a hidden purge fragment is refused and leaves the file unchanged', () => {
  const home = fixed('phone-a', 100);
  const away = fixed('phone-b', 100);
  const id = home.createPerson('River', { id: 'river' });
  home.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  away.importPerson(home.getPerson(id));
  home.deleteTracker(id, 'water');
  home.emptyTrash(id);
  away.renamePerson(id, 'River two');
  away.renamePerson(id, 'River three');
  away.renamePerson(id, 'River four');
  away.editTracker(id, 'water', { name: 'Hidden water' });
  const hidden = fixed('phone-c', 100);
  hidden.importPerson(converges(home.getPerson(id), away.getPerson(id)));
  assert.equal(hidden.view(id).trackers.length, 0);
  assert.equal(hidden.getPerson(id).trackers.find(item => item.id === 'water').fields.name.value, 'Hidden water');
  const before = hidden.getPerson(id);
  assert.throws(() => hidden.restoreTracker(id, 'water'), /Tracker not found/);
  assert.deepEqual(hidden.getPerson(id), before);
  assert.throws(() => hidden.logCheckIn(id, 'water', { date: '2026-03-04', value: 1 }), /Tracker not found/);
  hidden.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  hidden.deleteTracker(id, 'steps');
  hidden.restoreTracker(id, 'steps');
  assert.deepEqual(hidden.view(id).trackers.map(item => item.name), ['Steps']);
});

test('an unknown edit field does not revive a deleted tracker or check-in', () => {
  const engine = fixed('phone-a', 100);
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  engine.logCheckIn(id, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  engine.deleteCheckIn(id, 'glass');
  const beforeCheckIn = engine.getPerson(id);
  assert.equal(engine.view(id).checkIns.length, 0);
  assert.throws(() => engine.editCheckIn(id, 'glass', { trackerID: 'steps' }), /Unknown check-in field/);
  assert.deepEqual(engine.getPerson(id), beforeCheckIn);
  assert.equal(engine.view(id).checkIns.length, 0);
  assert.throws(() => engine.editCheckIn(id, 'glass', { value: 9, trackerID: 'steps' }), /Unknown check-in field/);
  assert.deepEqual(engine.getPerson(id), beforeCheckIn);

  engine.deleteTracker(id, 'water');
  const beforeTracker = engine.getPerson(id);
  assert.equal(engine.view(id).trackers.length, 0);
  assert.throws(() => engine.editTracker(id, 'water', { namee: 'Nope' }), /Unknown tracker field/);
  assert.deepEqual(engine.getPerson(id), beforeTracker);
  assert.equal(engine.view(id).trackers.length, 0);

  engine.editCheckIn(id, 'glass', { value: 9 });
  assert.equal(engine.view(id).checkIns.find(item => item.id === 'glass').value, 9);
  engine.editTracker(id, 'water', { name: 'Fresh water' });
  assert.equal(engine.view(id).trackers[0].name, 'Fresh water');
});

test('a due day after today stays open when a check-in is already stored', () => {
  const engine = fixed('phone-a');
  const id = engine.createPerson('River', { id: 'river' });
  const span = { start: '2026-03-16', end: '2026-03-20', today: '2026-03-18' };
  const shown = (grid, date) => {
    const item = square(grid, date);
    return { state: item.state, shade: item.shade, due: item.due, value: item.value };
  };
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses', startedOn: '2026-03-16' }, { trackerId: 'water' });
  engine.logCheckIn(id, 'water', { date: '2026-03-17', value: 8, checkInId: 'water-past' });
  engine.logCheckIn(id, 'water', { date: '2026-03-18', value: 3, checkInId: 'water-today' });
  engine.logCheckIn(id, 'water', { date: '2026-03-19', value: 2, checkInId: 'water-partial' });
  engine.logCheckIn(id, 'water', { date: '2026-03-20', value: 8, checkInId: 'water-ahead' });
  const water = engine.grid(id, 'water', span);
  assert.deepEqual(shown(water, '2026-03-16'), { state: 'empty', shade: 0, due: true, value: 0 });
  assert.deepEqual(shown(water, '2026-03-17'), { state: 'full', shade: 4, due: true, value: 8 });
  assert.deepEqual(shown(water, '2026-03-18'), { state: 'partial', shade: 2, due: true, value: 3 });
  assert.deepEqual(shown(water, '2026-03-19'), { state: 'open', shade: 0, due: true, value: 2 });
  assert.deepEqual(shown(water, '2026-03-20'), { state: 'open', shade: 0, due: true, value: 8 });
  assert.deepEqual(water.streaks, { current: 1, longest: 1, unit: 'day' });
  assert.equal(engine.view(id).checkIns.find(item => item.id === 'water-ahead').value, 8);

  engine.addTracker(id, {
    name: 'Stretch', kind: 'done', schedule: { type: 'days', days: ['monday', 'wednesday', 'friday'] }, startedOn: '2026-03-16',
  }, { trackerId: 'stretch' });
  engine.logCheckIn(id, 'stretch', { date: '2026-03-16', checkInId: 'stretch-past' });
  engine.logCheckIn(id, 'stretch', { date: '2026-03-18', checkInId: 'stretch-today' });
  engine.logCheckIn(id, 'stretch', { date: '2026-03-19', checkInId: 'stretch-off' });
  engine.logCheckIn(id, 'stretch', { date: '2026-03-20', checkInId: 'stretch-ahead' });
  const stretch = engine.grid(id, 'stretch', span);
  assert.deepEqual(shown(stretch, '2026-03-16'), { state: 'full', shade: 4, due: true, value: 1 });
  assert.deepEqual(shown(stretch, '2026-03-17'), { state: 'rest', shade: 0, due: false, value: 0 });
  assert.deepEqual(shown(stretch, '2026-03-18'), { state: 'full', shade: 4, due: true, value: 1 });
  assert.deepEqual(shown(stretch, '2026-03-19'), { state: 'rest', shade: 0, due: false, value: 1 });
  assert.deepEqual(shown(stretch, '2026-03-20'), { state: 'open', shade: 0, due: true, value: 1 });

  engine.addTracker(id, { name: 'Pages', kind: 'count', target: null, startedOn: '2026-03-16' }, { trackerId: 'pages' });
  engine.logCheckIn(id, 'pages', { date: '2026-03-17', value: 2, checkInId: 'pages-past' });
  engine.logCheckIn(id, 'pages', { date: '2026-03-20', value: 4, checkInId: 'pages-ahead' });
  const pages = engine.grid(id, 'pages', span);
  assert.equal(pages.fullLevel, false);
  assert.deepEqual(shown(pages, '2026-03-17'), { state: 'done', shade: 2, due: true, value: 2 });
  assert.deepEqual(shown(pages, '2026-03-20'), { state: 'open', shade: 0, due: true, value: 4 });

  engine.addTracker(id, {
    name: 'Calls', kind: 'done', schedule: { type: 'timesPerWeek', times: 3 }, startedOn: '2026-03-01',
  }, { trackerId: 'calls' });
  engine.logCheckIn(id, 'calls', { date: '2026-03-20', checkInId: 'calls-ahead' });
  const calls = engine.grid(id, 'calls', span);
  assert.deepEqual(shown(calls, '2026-03-18'), { state: 'open', shade: 0, due: false, value: 0 });
  assert.deepEqual(shown(calls, '2026-03-20'), { state: 'done', shade: 4, due: false, value: 1 });

  engine.addStack(id, { name: 'Morning', members: ['water'] }, { stackId: 'morning' });
  const morning = engine.stackGrid(id, 'morning', span);
  assert.deepEqual(shown(morning, '2026-03-17'), { state: 'full', shade: 4, due: true, value: 1 });
  assert.deepEqual(shown(morning, '2026-03-18'), { state: 'partial', shade: 1, due: true, value: 0 });
  assert.deepEqual(shown(morning, '2026-03-20'), { state: 'open', shade: 0, due: false, value: 0 });
});

test('a tracker fence does not erase another tracker from check-in history', () => {
  const mover = fixed('phone-m', 100);
  const purgerA = fixed('phone-a', 100);
  const purgerB = fixed('phone-b', 100);
  const id = mover.createPerson('River', { id: 'river' });
  mover.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  mover.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  mover.addTracker(id, { name: 'Pages', kind: 'count', target: 8, unit: 'pages' }, { trackerId: 'pages' });
  purgerA.importPerson(mover.getPerson(id));
  purgerB.importPerson(mover.getPerson(id));
  mover.logCheckIn(id, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  mover.editCheckIn(id, 'glass', { trackerId: 'steps' });
  mover.editCheckIn(id, 'glass', { trackerId: 'pages' });
  for (const name of ['River two', 'River three', 'River four', 'River five']) purgerA.renamePerson(id, name);
  purgerA.deleteTracker(id, 'water');
  purgerA.emptyTrash(id);
  for (const name of ['River two', 'River three', 'River four', 'River five', 'River six', 'River seven']) mover.renamePerson(id, name);
  mover.editCheckIn(id, 'glass', { trackerId: 'pages', date: '2026-03-05', value: 9, source: 'manual' });
  for (const name of ['Glen two', 'Glen three', 'Glen four', 'Glen five', 'Glen six', 'Glen seven', 'Glen eight', 'Glen nine', 'Glen ten', 'Glen eleven']) purgerB.renamePerson(id, name);
  purgerB.deleteTracker(id, 'steps');
  purgerB.emptyTrash(id);
  const copies = [mover, purgerA, purgerB].map(device => device.getPerson(id));
  const joined = mergePeople(mergePeople(copies[0], copies[1]), copies[2]);
  for (const [i, j, k] of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const merged = mergePeople(mergePeople(copies[i], copies[j]), copies[k]);
    const glass = merged.checkIns.find(item => item.id === 'glass');
    assert.equal(glass.life.value, false);
    assert.equal(glass.formerTrackers.steps.value, true);
    assert.equal(viewPerson(merged).checkIns.length, 0);
    assert.deepEqual(merged, joined);
  }
  assert.deepEqual(mergePeople(joined, joined), joined);
});

test('a tracker fence purge does not erase history another replica kept', () => {
  const kept = fixed('phone-m', 100);
  const plain = fixed('phone-p', 100);
  const fence = fixed('phone-c', 100);
  const later = fixed('phone-a', 100);
  const id = kept.createPerson('River', { id: 'river' });
  kept.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  kept.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  kept.addTracker(id, { name: 'Pages', kind: 'count', target: 8, unit: 'pages' }, { trackerId: 'pages' });
  plain.importPerson(kept.getPerson(id));
  fence.importPerson(kept.getPerson(id));
  later.importPerson(kept.getPerson(id));
  plain.logCheckIn(id, 'pages', { date: '2026-03-04', value: 1, checkInId: 'glass' });
  kept.logCheckIn(id, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  kept.editCheckIn(id, 'glass', { trackerId: 'steps' });
  kept.editCheckIn(id, 'glass', { trackerId: 'pages' });
  for (const name of ['River two', 'River three', 'River four', 'River five']) fence.renamePerson(id, name);
  fence.deleteTracker(id, 'pages');
  fence.emptyTrash(id);
  for (const name of ['River two', 'River three', 'River four', 'River five', 'River six', 'River seven']) {
    plain.renamePerson(id, name);
    kept.renamePerson(id, name);
  }
  plain.editCheckIn(id, 'glass', { trackerId: 'pages', date: '2026-03-05', value: 4, source: 'manual' });
  kept.editCheckIn(id, 'glass', { trackerId: 'pages', date: '2026-03-05', value: 9, source: 'manual' });
  const fenced = mergePeople(plain.getPerson(id), fence.getPerson(id));
  for (const name of ['Glen two', 'Glen three', 'Glen four', 'Glen five', 'Glen six', 'Glen seven', 'Glen eight', 'Glen nine', 'Glen ten', 'Glen eleven', 'Glen twelve']) later.renamePerson(id, name);
  later.deleteTracker(id, 'water');
  later.emptyTrash(id);
  const copies = [kept.getPerson(id), fenced, later.getPerson(id)];
  const joined = mergePeople(mergePeople(copies[0], copies[1]), copies[2]);
  for (const [i, j, k] of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const merged = mergePeople(mergePeople(copies[i], copies[j]), copies[k]);
    const glass = merged.checkIns.find(item => item.id === 'glass');
    assert.equal(glass.life.value, false);
    assert.equal(glass.formerTrackers.water.value, true);
    assert.equal(viewPerson(merged).checkIns.length, 0);
    assert.deepEqual(merged, joined);
  }
  assert.deepEqual(mergePeople(joined, joined), joined);
});

test('emptying Trash again does not renew an already emptied person cutoff', () => {
  const home = fixed('phone-a', 100);
  const away = fixed('phone-b', 100);
  const id = home.createPerson('River', { id: 'river' });
  home.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  away.importPerson(home.getPerson(id));
  home.deletePerson(id);
  home.emptyTrash(id);
  away.renamePerson(id, 'River two');
  away.renamePerson(id, 'Glen');
  const revived = converges(home.getPerson(id), away.getPerson(id));
  assert.equal(viewPerson(revived).name, 'Glen');
  assert.equal(revived.life.value, true);
  const marker = home.getPerson(id);
  home.emptyTrash(id);
  const kept = converges(home.getPerson(id), away.getPerson(id));
  assert.equal(viewPerson(kept).name, 'Glen');
  assert.equal(kept.life.value, true);
  assert.deepEqual(kept, revived);
  assert.deepEqual(home.getPerson(id), marker);
  assert.equal(viewPerson(kept).trackers.length, 0);
});

test('a reused check-in does not keep former trackers erased by its purge', () => {
  const home = fixed('phone-a', 100);
  const away = fixed('phone-b', 100);
  const id = home.createPerson('River', { id: 'river' });
  home.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  home.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  away.importPerson(home.getPerson(id));
  home.logCheckIn(id, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  home.editCheckIn(id, 'glass', { trackerId: 'steps' });
  away.importPerson(home.getPerson(id));
  home.deleteCheckIn(id, 'glass');
  home.emptyTrash(id);
  home.logCheckIn(id, 'steps', { date: '2026-03-05', value: 9, checkInId: 'glass' });
  const joined = converges(home.getPerson(id), away.getPerson(id));
  const glass = joined.checkIns.find(item => item.id === 'glass');
  assert.equal(glass.fields.trackerId.value, 'steps');
  assert.equal(glass.fields.value.value, 9);
  assert.equal(glass.formerTrackers, undefined);
  const later = fixed('phone-c', 100);
  later.importPerson(joined);
  later.deleteTracker(id, 'water');
  later.emptyTrash(id);
  const kept = later.getPerson(id).checkIns.find(item => item.id === 'glass');
  assert.equal(kept.life.value, true);
  assert.equal(kept.fields.value.value, 9);
  assert.equal(later.view(id).checkIns.find(item => item.id === 'glass').value, 9);

  const older = fixed('phone-d', 100);
  const fresh = fixed('phone-e', 100);
  const again = older.createPerson('River', { id: 'river' });
  older.addTracker(again, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  older.addTracker(again, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  fresh.importPerson(older.getPerson(again));
  older.logCheckIn(again, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  fresh.importPerson(older.getPerson(again));
  older.editCheckIn(again, 'glass', { trackerId: 'steps' });
  older.deleteCheckIn(again, 'glass');
  older.emptyTrash(again);
  older.logCheckIn(again, 'steps', { date: '2026-03-05', value: 9, checkInId: 'glass' });
  const moved = converges(older.getPerson(again), fresh.getPerson(again));
  assert.equal(moved.checkIns.find(item => item.id === 'glass').formerTrackers, undefined);
  const purged = fixed('phone-m', 100);
  purged.importPerson(moved);
  purged.deleteTracker(again, 'water');
  purged.emptyTrash(again);
  assert.equal(purged.view(again).checkIns.find(item => item.id === 'glass').value, 9);
});

test('a check-in emptied with its former tracker does not lose the reused check-in', () => {
  const home = fixed('phone-a', 100);
  const away = fixed('phone-b', 100);
  const id = home.createPerson('River', { id: 'river' });
  home.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  home.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  away.importPerson(home.getPerson(id));
  home.logCheckIn(id, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  home.editCheckIn(id, 'glass', { trackerId: 'steps' });
  away.importPerson(home.getPerson(id));
  home.deleteCheckIn(id, 'glass');
  home.deleteTracker(id, 'water');
  home.emptyTrash(id);
  const emptied = home.getPerson(id);
  const glassPurge = emptied.checkIns.find(item => item.id === 'glass').purge;
  const waterPurge = emptied.trackers.find(item => item.id === 'water').purge;
  assert.equal(compareStamps(glassPurge, waterPurge), 0);
  home.logCheckIn(id, 'steps', { date: '2026-03-05', value: 9, checkInId: 'glass' });
  const joined = converges(home.getPerson(id), away.getPerson(id));
  const glass = joined.checkIns.find(item => item.id === 'glass');
  assert.equal(glass.life.value, true);
  assert.equal(glass.fields.trackerId.value, 'steps');
  assert.equal(glass.fields.value.value, 9);
  assert.equal(glass.formerTrackers, undefined);
  assert.equal(compareStamps(glass.emptied, glassPurge), 0);
  const revived = fixed('phone-c', 100);
  revived.importPerson(joined);
  revived.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  revived.deleteTracker(id, 'water');
  revived.emptyTrash(id);
  const kept = revived.getPerson(id).checkIns.find(item => item.id === 'glass');
  assert.equal(kept.life.value, true);
  assert.equal(kept.fields.value.value, 9);
  assert.equal(kept.formerTrackers, undefined);
  assert.equal(revived.view(id).checkIns.find(item => item.id === 'glass').value, 9);

  const older = fixed('phone-d', 100);
  const fresh = fixed('phone-e', 100);
  const again = older.createPerson('River', { id: 'river' });
  older.addTracker(again, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  older.addTracker(again, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  fresh.importPerson(older.getPerson(again));
  older.logCheckIn(again, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  fresh.importPerson(older.getPerson(again));
  older.editCheckIn(again, 'glass', { trackerId: 'steps' });
  older.deleteCheckIn(again, 'glass');
  older.deleteTracker(again, 'water');
  older.emptyTrash(again);
  older.logCheckIn(again, 'steps', { date: '2026-03-05', value: 9, checkInId: 'glass' });
  const moved = converges(older.getPerson(again), fresh.getPerson(again));
  assert.equal(moved.checkIns.find(item => item.id === 'glass').formerTrackers, undefined);
  assert.equal(moved.checkIns.find(item => item.id === 'glass').fields.value.value, 9);
  const purged = fixed('phone-m', 100);
  purged.importPerson(moved);
  purged.addTracker(again, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  purged.deleteTracker(again, 'water');
  purged.emptyTrash(again);
  assert.equal(purged.view(again).checkIns.find(item => item.id === 'glass').value, 9);
});

test('a legacy check-in purge still erases history saved before the empty was recorded', () => {
  const home = fixed('phone-a', 100);
  const away = fixed('phone-b', 100);
  const id = home.createPerson('River', { id: 'river' });
  home.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  home.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  away.importPerson(home.getPerson(id));
  home.logCheckIn(id, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  home.editCheckIn(id, 'glass', { trackerId: 'steps' });
  away.importPerson(home.getPerson(id));
  home.deleteCheckIn(id, 'glass');
  home.emptyTrash(id);
  const glassPurge = home.getPerson(id).checkIns.find(item => item.id === 'glass').purge;
  home.logCheckIn(id, 'steps', { date: '2026-03-05', value: 9, checkInId: 'glass' });
  const legacy = home.getPerson(id);
  delete legacy.checkIns.find(item => item.id === 'glass').emptied;
  const joined = converges(legacy, away.getPerson(id));
  const glass = joined.checkIns.find(item => item.id === 'glass');
  assert.equal(glass.life.value, true);
  assert.equal(glass.fields.value.value, 9);
  assert.equal(glass.formerTrackers, undefined);
  assert.equal(compareStamps(glass.emptied, glassPurge), 0);
  const revived = fixed('phone-c', 100);
  revived.importPerson(joined);
  revived.deleteTracker(id, 'water');
  revived.emptyTrash(id);
  assert.equal(revived.view(id).checkIns.find(item => item.id === 'glass').value, 9);
});

test('an empty stamp that disagrees with the check-in purge is refused', () => {
  const engine = fixed('phone-a', 100);
  const id = engine.createPerson('River', { id: 'river' });
  engine.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  engine.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  engine.logCheckIn(id, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  engine.editCheckIn(id, 'glass', { trackerId: 'steps' });
  const olderHistory = engine.getPerson(id);
  const glass = olderHistory.checkIns.find(item => item.id === 'glass');
  glass.purge = null;
  glass.emptied = { counter: 1, time: 100, device: 'phone-a' };
  glass.formerTrackers.water.stamp = { counter: 1, time: 100, device: 'phone-a' };
  assert.throws(() => deserializePerson(JSON.stringify(olderHistory)), /Invalid check-in empty stamp/);
  assert.throws(() => mergePeople(olderHistory, olderHistory), /Invalid check-in empty stamp/);

  const ahead = engine.getPerson(id);
  const moved = ahead.checkIns.find(item => item.id === 'glass');
  moved.purge = { counter: 1, time: 100, device: 'phone-a' };
  moved.emptied = { counter: 2, time: 100, device: 'phone-a' };
  delete moved.formerTrackers;
  assert.throws(() => deserializePerson(JSON.stringify(ahead)), /Invalid check-in empty stamp/);

  const staleHistory = engine.getPerson(id);
  const kept = staleHistory.checkIns.find(item => item.id === 'glass');
  kept.purge = { counter: 1, time: 100, device: 'phone-a' };
  kept.emptied = { counter: 1, time: 100, device: 'phone-a' };
  kept.formerTrackers.water.stamp = { counter: 1, time: 100, device: 'phone-a' };
  assert.throws(() => deserializePerson(JSON.stringify(staleHistory)), /Check-in history is older than its empty stamp/);
  assert.throws(() => mergePeople(staleHistory, staleHistory), /Check-in history is older than its empty stamp/);
});

test('reusing a check-in fenced by one tracker keeps a move to another', () => {
  const home = fixed('phone-a', 100);
  const away = fixed('phone-b', 100);
  const id = home.createPerson('River', { id: 'river' });
  home.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  home.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  home.addTracker(id, { name: 'Pages', kind: 'count', target: 8, unit: 'pages' }, { trackerId: 'pages' });
  away.importPerson(home.getPerson(id));
  home.logCheckIn(id, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  away.importPerson(home.getPerson(id));
  away.editCheckIn(id, 'glass', { trackerId: 'steps' });
  home.deleteTracker(id, 'water');
  home.emptyTrash(id);
  home.logCheckIn(id, 'pages', { date: '2026-03-05', value: 9, checkInId: 'glass' });
  const reused = home.getPerson(id);
  const moved = away.getPerson(id);
  const joined = converges(reused, moved);
  const glass = joined.checkIns.find(item => item.id === 'glass');
  assert.equal(glass.life.value, true);
  assert.equal(glass.fields.trackerId.value, 'pages');
  assert.equal(glass.fields.value.value, 9);
  assert.equal(glass.formerTrackers.steps.value, true);
  assert.equal(glass.emptied, undefined);
  assert.equal(compareStamps(glass.fenced, reused.trackers.find(item => item.id === 'water').purge), 0);
  const later = fixed('phone-c', 100);
  later.importPerson(joined);
  later.deleteTracker(id, 'steps');
  later.emptyTrash(id);
  assert.equal(later.getPerson(id).checkIns.find(item => item.id === 'glass').life.value, false);
  assert.equal(later.view(id).checkIns.length, 0);
  for (const name of ['Glen two', 'Glen three', 'Glen four', 'Glen five', 'Glen six']) away.renamePerson(id, name);
  away.deleteTracker(id, 'steps');
  away.emptyTrash(id);
  const purged = converges(reused, away.getPerson(id));
  assert.equal(purged.checkIns.find(item => item.id === 'glass').life.value, false);
  assert.equal(viewPerson(purged).checkIns.length, 0);
});

test('a legacy check-in empty that shares a tracker cutoff is refused', () => {
  const home = fixed('phone-a', 100);
  const away = fixed('phone-b', 100);
  const id = home.createPerson('River', { id: 'river' });
  home.addTracker(id, { name: 'Water', kind: 'count', target: 8, unit: 'glasses' }, { trackerId: 'water' });
  home.addTracker(id, { name: 'Steps', kind: 'count', target: 8, unit: 'steps' }, { trackerId: 'steps' });
  away.importPerson(home.getPerson(id));
  home.logCheckIn(id, 'water', { date: '2026-03-04', value: 5, checkInId: 'glass' });
  home.editCheckIn(id, 'glass', { trackerId: 'steps' });
  away.importPerson(home.getPerson(id));
  home.deleteCheckIn(id, 'glass');
  home.deleteTracker(id, 'water');
  home.emptyTrash(id);
  home.logCheckIn(id, 'steps', { date: '2026-03-05', value: 9, checkInId: 'glass' });
  const legacy = home.getPerson(id);
  const glass = legacy.checkIns.find(item => item.id === 'glass');
  delete glass.emptied;
  delete glass.fenced;
  assert.equal(compareStamps(glass.purge, legacy.trackers.find(item => item.id === 'water').purge), 0);
  assert.throws(() => deserializePerson(JSON.stringify(legacy)), /Invalid check-in purge provenance/);
  assert.throws(() => mergePeople(legacy, legacy), /Invalid check-in purge provenance/);
  assert.throws(() => mergePeople(legacy, away.getPerson(id)), /Invalid check-in purge provenance/);
});
