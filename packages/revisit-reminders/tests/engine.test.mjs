import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RevisitError, addReminder, dueOn, editReminder, formatSaved, listView, markDone,
  parseSaved, removeReminder, snoozeReminder,
} from '../src/index.mjs';
import { freeze, picture, reminder, sampleList } from './helpers.mjs';

const TODAY = '2026-11-02';

function refuses(run, field, pattern) {
  assert.throws(run, error => {
    assert.ok(error instanceof RevisitError);
    assert.equal(error.field, field);
    assert.match(error.message, new RegExp(`field ${field.replaceAll('.', '\\.')}`));
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test('due dates: a set day, month ends, leap years, and a snooze that wins', () => {
  const setDay = addReminder([], reminder({ when: { on: '2026-11-02' } })).reminders[0];
  assert.equal(dueOn(setDay), '2026-11-02');

  const monthEnd = addReminder([], reminder({
    when: { afterDays: 1, from: '2024-01-31' },
    createdOn: '2024-01-01',
  })).reminders[0];
  assert.equal(dueOn(monthEnd), '2024-02-01');

  const leap = addReminder([], reminder({
    when: { afterDays: 1, from: '2024-02-28' },
    createdOn: '2024-01-01',
  })).reminders[0];
  assert.equal(dueOn(leap), '2024-02-29');
  const afterLeap = addReminder([], reminder({
    id: 'after-leap',
    when: { afterDays: 1, from: '2024-02-29' },
    createdOn: '2024-01-01',
  })).reminders[0];
  assert.equal(dueOn(afterLeap), '2024-03-01');
  const common = addReminder([], reminder({
    when: { afterDays: 1, from: '2025-02-28' },
    createdOn: '2025-01-01',
  })).reminders[0];
  assert.equal(dueOn(common), '2025-03-01');

  const leapMonth = addReminder([], reminder({
    when: { afterDays: 30, from: '2024-01-31' },
    createdOn: '2024-01-01',
  })).reminders[0];
  assert.equal(dueOn(leapMonth), '2024-03-01');
  const commonMonth = addReminder([], reminder({
    when: { afterDays: 30, from: '2025-01-31' },
    createdOn: '2025-01-01',
  })).reminders[0];
  assert.equal(dueOn(commonMonth), '2025-03-02');

  assert.equal(dueOn(addReminder([], reminder({
    when: { afterDays: 1, from: '0100-02-28' },
    createdOn: '0100-01-01',
  })).reminders[0]), '0100-03-01');
  assert.equal(dueOn(addReminder([], reminder({
    when: { afterDays: 1, from: '0400-02-28' },
    createdOn: '0400-01-01',
  })).reminders[0]), '0400-02-29');
  assert.equal(dueOn(addReminder([], reminder({
    when: { afterDays: 1, from: '0001-01-01' },
    createdOn: '0001-01-01',
  })).reminders[0]), '0001-01-02');
  assert.equal(dueOn(addReminder([], reminder({
    when: { afterDays: 3650, from: '2026-01-01' },
  })).reminders[0]), '2035-12-30');

  const snoozed = addReminder([], reminder({
    when: { on: '2026-11-01' },
    snoozedUntil: '2026-11-08',
  })).reminders[0];
  assert.equal(dueOn(snoozed), '2026-11-08');
  const notLater = addReminder([], reminder({
    when: { on: '2026-11-10' },
    snoozedUntil: '2026-11-05',
  })).reminders[0];
  assert.equal(dueOn(notLater), '2026-11-10');
  const sameDay = addReminder([], reminder({
    when: { on: '2026-11-10' },
    snoozedUntil: '2026-11-10',
  })).reminders[0];
  assert.equal(dueOn(sameDay), '2026-11-10');
});

test('overdue, due today, coming up inside and outside the window, and done', () => {
  const view = listView(sampleList(), { today: TODAY });
  assert.deepEqual(view.overdue.map(row => row.id), ['garden-plan']);
  assert.equal(view.overdue[0].daysOverdue, 13);
  assert.equal(view.overdue[0].dueOn, '2026-10-20');
  assert.deepEqual(view.dueToday.map(row => row.id), ['fence-note', 'seed-list']);
  assert.equal(view.dueToday[0].daysOverdue, undefined);
  assert.equal(view.dueToday[0].dueOn, '2026-11-02');
  assert.deepEqual(view.comingUp.map(row => row.id), ['path-link']);
  assert.equal(view.comingUp[0].dueOn, '2026-11-16');
  assert.deepEqual(view.done.map(row => row.id), ['porch-done']);
  assert.equal(view.done[0].daysOverdue, undefined);
  assert.equal(view.done[0].dueOn, '2026-09-01');
  assert.deepEqual(view.missingItem, []);
  for (const row of [...view.overdue, ...view.dueToday, ...view.comingUp, ...view.done]) {
    assert.equal(row.id === 'shed-later', false);
  }
  const laterMissing = listView(sampleList(), { today: TODAY, knownItems: [] });
  assert.equal(laterMissing.missingItem.some(row => row.id === 'shed-later'), true);
  assert.equal(laterMissing.comingUp.some(row => row.id === 'shed-later'), false);
  assert.deepEqual(view.counts, {
    overdue: 1, dueToday: 2, comingUp: 1, missingItem: 0, done: 1,
  });

  const narrow = listView(sampleList(), { today: TODAY, days: 1 });
  assert.deepEqual(narrow.comingUp, []);
  const tomorrow = listView([
    reminder({ id: 'tomorrow', when: { on: '2026-11-03' } }),
    reminder({ id: 'day-after', when: { on: '2026-11-04' } }),
  ], { today: TODAY, days: 1 });
  assert.deepEqual(tomorrow.comingUp.map(row => row.id), ['tomorrow']);

  const edge = listView([
    reminder({ id: 'inside', when: { on: '2026-11-16' } }),
    reminder({ id: 'outside', when: { on: '2026-11-17' } }),
  ], { today: TODAY });
  assert.deepEqual(edge.comingUp.map(row => row.id), ['inside']);
  assert.deepEqual(listView(sampleList(), { today: TODAY, days: 14 }).comingUp, view.comingUp);
  assert.deepEqual(listView([reminder({ when: { on: '2026-11-03' } })], { today: TODAY, days: 0 }).comingUp, []);

  const oneDay = listView([reminder({ when: { on: '2026-11-01' } })], { today: TODAY });
  assert.equal(oneDay.overdue[0].daysOverdue, 1);

  const ordered = listView([
    reminder({ id: 'b', title: 'Beta', when: { on: '2026-10-02' } }),
    reminder({ id: 'a-late', title: 'Alpha', when: { on: '2026-10-02' } }),
    reminder({ id: 'c', title: 'Alpha', when: { on: '2026-10-01' } }),
    reminder({ id: 'z-title', title: 'Zeta', when: { on: '2026-10-02' } }),
    reminder({ id: 'A-title', title: 'alpha', when: { on: '2026-10-02' } }),
  ], { today: TODAY });
  assert.deepEqual(ordered.overdue.map(row => row.id), ['c', 'a-late', 'b', 'z-title', 'A-title']);

  const doneOrder = listView([
    reminder({ id: 'later-due', when: { on: '2026-10-20' }, doneOn: '2026-10-01' }),
    reminder({ id: 'earlier-due', when: { on: '2026-09-01' }, doneOn: '2026-10-15' }),
  ], { today: TODAY });
  assert.deepEqual(doneOrder.done.map(row => row.id), ['earlier-due', 'later-due']);
  const doneSnooze = listView([
    reminder({
      id: 'snoozed-done',
      when: { on: '2026-09-01' },
      snoozedUntil: '2026-11-20',
      doneOn: '2026-09-02',
    }),
  ], { today: TODAY });
  assert.equal(doneSnooze.done[0].dueOn, '2026-11-20');
  assert.equal(doneSnooze.done[0].daysOverdue, undefined);
  assert.deepEqual(doneSnooze.overdue, []);
});

test('snooze to a later date, snooze by days, and a refused snooze to today', () => {
  const start = [reminder({ when: { on: '2026-11-01' } })];
  const later = snoozeReminder(start, 'garden-plan', { until: '2026-11-08' }, TODAY);
  assert.equal(later.reminders[0].snoozedUntil, '2026-11-08');
  assert.equal(dueOn(later.reminders[0]), '2026-11-08');
  assert.deepEqual(later.warnings, []);

  const byDays = snoozeReminder(start, 'garden-plan', { days: 3 }, TODAY);
  assert.equal(byDays.reminders[0].snoozedUntil, '2026-11-05');
  assert.equal(start[0].snoozedUntil, undefined);

  const earlierThanWhen = snoozeReminder(
    [reminder({ when: { on: '2026-11-20' } })],
    'garden-plan',
    { until: '2026-11-05' },
    TODAY,
  );
  assert.equal(earlierThanWhen.reminders[0].snoozedUntil, '2026-11-05');
  assert.equal(dueOn(earlierThanWhen.reminders[0]), '2026-11-20');

  refuses(() => snoozeReminder(start, 'garden-plan', { until: TODAY }, TODAY), 'snoozedUntil');
  refuses(() => snoozeReminder(start, 'garden-plan', { until: '2026-10-01' }, TODAY), 'snoozedUntil');
  refuses(() => snoozeReminder(start, 'garden-plan', { days: 0 }, TODAY), 'days');
  refuses(() => snoozeReminder([reminder({ doneOn: '2026-11-01' })], 'garden-plan', { days: 2 }, TODAY), 'doneOn');
  refuses(() => snoozeReminder(start, 'missing', { days: 2 }, TODAY), 'id', /missing/);
});

test('add, edit, done and remove, with warnings only for the same open item and day', () => {
  refuses(() => addReminder([reminder({ id: 'garden-plan' })], reminder({ id: 'garden-plan' })), 'id', /garden-plan/);

  const session = addReminder([], reminder({
    id: 'session-one', itemKind: 'session', itemId: 'shared', when: { on: '2026-11-10' },
  }));
  const otherKind = addReminder(session.reminders, reminder({
    id: 'note-one', itemKind: 'note', itemId: 'shared', when: { on: '2026-11-10' },
  }));
  assert.deepEqual(otherKind.warnings, []);

  const same = addReminder(otherKind.reminders, reminder({
    id: 'note-two', itemKind: 'note', itemId: 'shared', title: 'Second note', when: { on: '2026-11-10' },
  }));
  assert.equal(same.warnings.length, 1);
  const both = addReminder(same.reminders, reminder({
    id: 'note-four', itemKind: 'note', itemId: 'shared', title: 'Fourth note', when: { on: '2026-11-10' },
  }));
  assert.deepEqual(both.warnings.map(warning => warning.existingId), ['note-one', 'note-two']);
  assert.equal(same.warnings[0].field, 'itemId');
  assert.equal(same.warnings[0].id, 'note-two');
  assert.equal(same.warnings[0].existingId, 'note-one');
  assert.match(same.warnings[0].message, /field itemId/);
  assert.equal(same.reminders.at(-1).id, 'note-two');

  const otherDay = addReminder(otherKind.reminders, reminder({
    id: 'note-later', itemKind: 'note', itemId: 'shared', when: { on: '2026-11-11' },
  }));
  assert.deepEqual(otherDay.warnings, []);

  const spanned = addReminder(session.reminders, reminder({
    id: 'session-span',
    itemKind: 'session',
    itemId: 'shared',
    when: { afterDays: 4, from: '2026-11-06' },
  }));
  assert.equal(dueOn(spanned.reminders.at(-1)), '2026-11-10');
  assert.equal(spanned.warnings.length, 1);

  const doneFirst = markDone(otherKind.reminders, 'note-one', TODAY);
  const afterDone = addReminder(doneFirst.reminders, reminder({
    id: 'note-three', itemKind: 'note', itemId: 'shared', when: { on: '2026-11-10' },
  }));
  assert.deepEqual(afterDone.warnings, []);

  const moved = snoozeReminder(session.reminders, 'session-one', { until: '2026-11-12' }, TODAY);
  const afterMove = addReminder(moved.reminders, reminder({
    id: 'session-two', itemKind: 'session', itemId: 'shared', when: { on: '2026-11-10' },
  }));
  assert.deepEqual(afterMove.warnings, []);
  const ontoSnooze = addReminder(moved.reminders, reminder({
    id: 'session-three', itemKind: 'session', itemId: 'shared', when: { on: '2026-11-12' },
  }));
  assert.equal(ontoSnooze.warnings[0].existingId, 'session-one');

  const edited = editReminder(session.reminders, 'session-one', {
    title: 'Come back to the revised garden plan',
    note: 'Bring the map.',
    when: { afterDays: 2, from: '2026-11-01' },
  });
  const kept = editReminder([reminder({ snoozedUntil: '2026-11-20', doneOn: '2026-11-01' })], 'garden-plan', {
    title: 'Come back to the revised garden plan',
  });
  assert.equal(kept.reminders[0].snoozedUntil, '2026-11-20');
  assert.equal(kept.reminders[0].doneOn, '2026-11-01');
  assert.equal(kept.reminders[0].createdOn, '2026-10-01');
  assert.deepEqual(kept.warnings, []);

  assert.equal(edited.reminders[0].title, 'Come back to the revised garden plan');
  assert.equal(edited.reminders[0].note, 'Bring the map.');
  assert.deepEqual(edited.reminders[0].when, { afterDays: 2, from: '2026-11-01' });
  assert.equal(session.reminders[0].title, 'Come back to the garden plan session');
  assert.deepEqual(edited.warnings, []);

  const cleared = editReminder([reminder({ note: 'Temporary.' })], 'garden-plan', { note: '' });
  assert.equal(Object.hasOwn(cleared.reminders[0], 'note'), false);
  const clearedNull = editReminder([reminder({ note: 'Temporary.' })], 'garden-plan', { note: null });
  assert.equal(Object.hasOwn(clearedNull.reminders[0], 'note'), false);

  const finished = markDone(session.reminders, 'session-one', TODAY);
  assert.equal(finished.reminders[0].doneOn, TODAY);
  refuses(() => markDone(finished.reminders, 'session-one', '2026-11-03'), 'doneOn');
  assert.equal(finished.reminders[0].doneOn, TODAY);

  const removed = removeReminder(same.reminders, 'note-one');
  assert.deepEqual(removed.reminders.map(row => row.id), ['session-one', 'note-two']);
  assert.equal(same.reminders.length, 3);

  refuses(() => editReminder(session.reminders, 'missing', { title: 'Nope' }), 'id', /missing/);
  refuses(() => markDone(session.reminders, 'missing', TODAY), 'id', /missing/);
  refuses(() => removeReminder(session.reminders, 'missing'), 'id', /missing/);
  refuses(() => editReminder(session.reminders, 'session-one', {}), 'title');
  refuses(() => editReminder(session.reminders, 'session-one', { itemId: 'other' }), 'itemId');
});

test('missingItem lists a gone item and deletes nothing, including a shared id', () => {
  const list = freeze([
    reminder({ id: 'session-old', itemId: 'shared', itemKind: 'session', title: 'Old session', when: { on: '2026-11-01' } }),
    reminder({ id: 'note-kept', itemId: 'shared', itemKind: 'note', title: 'Kept note', when: { on: '2026-11-01' } }),
    reminder({ id: 'finished', itemId: 'gone', itemKind: 'session', title: 'Finished', when: { on: '2026-10-01' }, doneOn: '2026-10-02' }),
  ]);
  const before = picture(list);
  const view = listView(list, {
    today: TODAY,
    knownItems: [{ itemKind: 'note', itemId: 'shared' }],
  });
  assert.deepEqual(view.missingItem.map(row => row.id), ['session-old']);
  assert.equal(view.missingItem[0].daysOverdue, 1);
  assert.equal(view.overdue.some(row => row.id === 'note-kept'), true);
  assert.equal(view.done[0].id, 'finished');
  assert.equal(view.missingItem.some(row => row.id === 'note-kept' || row.id === 'finished'), false);
  assert.equal(picture(list), before);
  assert.equal(list.length, 3);

  const noneKnown = listView(list, { today: TODAY, knownItems: [] });
  assert.deepEqual(noneKnown.missingItem.map(row => row.id), ['note-kept', 'session-old']);
  assert.equal(listView(list, { today: TODAY }).missingItem.length, 0);
});

test('the input list is unchanged after every function', () => {
  const list = freeze(sampleList());
  const before = picture(list);
  const added = addReminder(list, reminder({ id: 'extra', itemId: 'extra-item', title: 'Extra' }));
  editReminder(list, 'garden-plan', { title: 'Changed' });
  snoozeReminder(list, 'path-link', { days: 2 }, TODAY);
  markDone(list, 'shed-later', TODAY);
  removeReminder(list, 'fence-note');
  listView(list, { today: TODAY, knownItems: [] });
  formatSaved(list);
  assert.equal(picture(list), before);
  assert.notEqual(added.reminders, list);
  assert.notEqual(added.reminders[0], list[0]);
  assert.notEqual(added.reminders[0].when, list[0].when);
  added.reminders[0].title = 'Mutated result';
  assert.equal(picture(list), before);

  const refusals = [
    () => addReminder(list, reminder({ id: 'garden-plan' })),
    () => editReminder(list, 'nope', { title: 'No' }),
    () => snoozeReminder(list, 'garden-plan', { until: TODAY }, TODAY),
    () => markDone(list, 'porch-done', TODAY),
    () => removeReminder(list, 'nope'),
    () => listView(list, { today: '2026-02-30' }),
    () => formatSaved([...list, reminder({ id: 'bad', when: { on: '2026-02-30' } })]),
  ];
  for (const run of refusals) {
    assert.throws(run, error => error instanceof RevisitError);
    assert.equal(picture(list), before);
  }
});

test('saved form round-trips, and one bad field refuses the whole file', () => {
  const shuffled = [sampleList()[3], sampleList()[0], sampleList()[5], sampleList()[2], sampleList()[1], sampleList()[4]];
  const text = formatSaved(shuffled);
  assert.equal(formatSaved(sampleList()), text);
  assert.equal(formatSaved(parseSaved(text)), text);
  const parsed = parseSaved(text);
  assert.deepEqual(parsed.map(row => row.id), ['fence-note', 'garden-plan', 'path-link', 'porch-done', 'seed-list', 'shed-later']);
  assert.equal(parsed[1].note, 'Check the bean rows.');
  assert.deepEqual(parsed[4].when, { afterDays: 14, from: '2026-10-19' });
  assert.equal(parsed[0].snoozedUntil, '2026-11-02');
  assert.equal(parsed[3].doneOn, '2026-09-02');

  const rich = [reminder({
    id: 'quoted',
    note: 'Line one\nline\ttwo "quote" \\ path',
    when: { afterDays: 2, from: '2026-11-01' },
    snoozedUntil: '2026-11-20',
  })];
  const richText = formatSaved(rich);
  assert.equal(formatSaved(parseSaved(richText)), richText);
  assert.equal(parseSaved(richText)[0].note, rich[0].note);

  const crlf = text.replaceAll('\n', '\r\n');
  assert.deepEqual(parseSaved(crlf), parsed);
  assert.notEqual(formatSaved(parseSaved(crlf)), crlf);

  const bad = {
    version: 1,
    reminders: [reminder({ id: 'good' }), reminder({ id: 'bad-one', when: { on: '2026-02-30' } })],
  };
  let returned = 'untouched';
  try {
    returned = parseSaved(JSON.stringify(bad));
  } catch (error) {
    assert.ok(error instanceof RevisitError);
    assert.equal(error.field, 'when.on');
    assert.match(error.message, /reminder "bad-one"/);
    assert.match(error.message, /field when\.on/);
  }
  assert.equal(returned, 'untouched');

  refuses(() => parseSaved(JSON.stringify({ version: 2, reminders: [] })), 'version');
  refuses(() => parseSaved(JSON.stringify({ version: '1', reminders: [] })), 'version');
  refuses(() => parseSaved(JSON.stringify({ reminders: [] })), 'version');
  refuses(() => parseSaved(JSON.stringify({ version: 1, reminders: [], owner: 'Ada' })), 'owner');
  refuses(() => parseSaved('\uFEFF{"version":1,"reminders":[]}'), 'file');
  assert.deepEqual(parseSaved('{"version":2,"version":1,"reminders":[]}'), []);
  refuses(() => parseSaved('{"version":1,"version":2,"reminders":[]}'), 'version');
  refuses(() => parseSaved(''), 'file');
  refuses(() => parseSaved('['), 'file');
});

test('refusals name the field, including 2026-02-30', () => {
  const open = [reminder()];
  const cases = [
    [() => addReminder(open, reminder({ id: '' })), 'id'],
    [() => addReminder(open, reminder({ id: 'x'.repeat(65) })), 'id'],
    [() => addReminder(open, reminder({ id: 'has space' })), 'id'],
    [() => addReminder(open, reminder({ id: 'has.dot' })), 'id'],
    [() => addReminder([], { itemId: 'a', itemKind: 'note', title: 'T', when: { on: '2026-11-03' }, createdOn: '2026-11-01' }), 'id'],
    [() => addReminder(open, reminder({ itemId: '' })), 'itemId'],
    [() => addReminder(open, reminder({ itemId: 'a'.repeat(201) })), 'itemId'],
    [() => addReminder(open, reminder({ itemId: 'a\nb' })), 'itemId'],
    [() => addReminder(open, reminder({ itemKind: 'task' })), 'itemKind'],
    [() => addReminder(open, reminder({ title: '' })), 'title'],
    [() => addReminder(open, reminder({ title: 'a'.repeat(201) })), 'title'],
    [() => addReminder(open, reminder({ title: `${'a'.repeat(199)}🌱` })), 'title'],
    [() => addReminder([], reminder({ id: 'long-title', title: 'a'.repeat(200) })), null],
    [() => addReminder(open, reminder({ title: 'Line\nbreak' })), 'title'],
    [() => addReminder(open, reminder({ title: 'tab\there' })), 'title'],
    [() => addReminder(open, reminder({ title: 'line\u2028sep' })), 'title'],
    [() => addReminder(open, reminder({ note: 'a'.repeat(2001) })), 'note'],
    [() => addReminder([], reminder({ id: 'long-note', note: 'a'.repeat(2000) })), null],
    [() => addReminder([], reminder({ id: 'tab-note', note: 'ok\nline\tok' })), null],
    [() => addReminder(open, reminder({ note: 'carriage\rreturn' })), 'note'],
    [() => addReminder(open, reminder({ note: 'nul\u0000byte' })), 'note'],
    [() => addReminder(open, reminder({ note: 'c1\u0085next' })), 'note'],
    [() => addReminder(open, reminder({ note: 'sep\u2028arator' })), 'note'],
    [() => addReminder(open, reminder({ note: '' })), 'note'],
    [() => addReminder(open, reminder({ when: { on: '2026-02-30' } })), 'when.on'],
    [() => addReminder(open, reminder({ when: { on: '2025-02-29' } })), 'when.on'],
    [() => addReminder([], reminder({ id: 'leap-day', when: { on: '2024-02-29' }, createdOn: '2024-01-01' })), null],
    [() => addReminder(open, reminder({ when: { on: '1900-02-29' }, createdOn: '1900-01-01' })), 'when.on'],
    [() => addReminder([], reminder({ id: 'year-2000', when: { on: '2000-02-29' }, createdOn: '2000-01-01' })), null],
    [() => addReminder(open, reminder({ when: { on: '2026-2-28' } })), 'when.on'],
    [() => addReminder(open, reminder({ when: { from: '2026-02-30', afterDays: 1 } })), 'when.from'],
    [() => addReminder(open, reminder({ when: { on: '2026-11-03', afterDays: 1 } })), 'when'],
    [() => addReminder(open, reminder({ when: { on: '2026-11-03', extra: 1 } })), 'when.extra'],
    [() => addReminder(open, reminder({ when: { afterDays: 0, from: '2026-11-01' } })), 'when.afterDays'],
    [() => addReminder(open, reminder({ when: { afterDays: 3651, from: '2026-11-01' } })), 'when.afterDays'],
    [() => addReminder(open, reminder({ when: { afterDays: 1.5, from: '2026-11-01' } })), 'when.afterDays'],
    [() => addReminder(open, reminder({ when: { afterDays: '3', from: '2026-11-01' } })), 'when.afterDays'],
    [() => addReminder(open, reminder({ when: { afterDays: -0, from: '2026-11-01' } })), 'when.afterDays'],
    [() => addReminder(open, reminder({ when: { afterDays: 1, from: '9999-12-31' }, createdOn: '9999-12-31' })), 'when.afterDays'],
    [() => addReminder(open, reminder({ createdOn: '2026-02-30' })), 'createdOn'],
    [() => addReminder(open, reminder({ snoozedUntil: '2026-02-30' })), 'snoozedUntil'],
    [() => addReminder(open, reminder({ doneOn: '2026-02-30' })), 'doneOn'],
    [() => addReminder([], { ...reminder({ id: 'colored' }), color: 'green' }), 'color'],
    [() => addReminder(open, reminder({ itemId: 12 })), 'itemId'],
    [() => listView([reminder(), reminder()], { today: TODAY }), 'id'],
    [() => listView(open, { today: '2026-02-30' }), 'today'],
    [() => listView(open, {}), 'today'],
    [() => listView(open, { today: TODAY, days: -1 }), 'days'],
    [() => listView(open, { today: TODAY, days: 1.5 }), 'days'],
    [() => listView(open, { today: '9999-12-31', days: 1 }), 'days'],
    [() => listView(open, { today: TODAY, knownItems: {} }), 'knownItems'],
    [() => listView(open, { today: TODAY, knownItems: [{ itemKind: 'note' }] }), 'itemId'],
    [() => listView('nope', { today: TODAY }), 'reminders'],
    [() => snoozeReminder(open, 'garden-plan', { until: '2026-02-30' }, TODAY), 'snoozedUntil'],
    [() => snoozeReminder(open, 'garden-plan', { days: 2, until: '2026-11-04' }, TODAY), 'snoozedUntil'],
    [() => snoozeReminder(open, 'garden-plan', {}, TODAY), 'snoozedUntil'],
    [() => markDone(open, 'garden-plan', '2026-02-30'), 'today'],
    [() => editReminder(open, 'garden-plan', { when: { on: '2026-02-30' } }), 'when.on'],
    [() => editReminder(open, 'garden-plan', { title: 'Still here', extra: true }), 'extra'],
  ];
  for (const [run, field] of cases) {
    if (field === null) {
      assert.doesNotThrow(run);
    } else {
      refuses(run, field);
    }
  }
});

test('shuffled input gives byte-identical output', () => {
  const forward = sampleList();
  const backward = [...sampleList()].reverse();
  assert.equal(formatSaved(forward), formatSaved(backward));
  assert.equal(JSON.stringify(listView(forward, { today: TODAY })), JSON.stringify(listView(backward, { today: TODAY, days: 14 })));
  const middle = [forward[2], forward[5], forward[0], forward[4], forward[1], forward[3]];
  assert.equal(formatSaved(middle), formatSaved(forward));
  assert.equal(JSON.stringify(listView(middle, { today: TODAY })), JSON.stringify(listView(forward, { today: TODAY })));
});
