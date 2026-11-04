import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderBoard } from '../src/index.mjs';
import { fitPage } from '../src/layout.mjs';
import { allDay, board, habit, person, task } from './helpers.mjs';

function busyBoard(size, extra = {}) {
  const events = [];
  for (let i = 0; i < 40; i += 1) {
    const n = String(i).padStart(2, '0');
    events.push(allDay(`e${n}`, `Event ${n}`, 'Family'));
  }
  const tasks = [];
  for (let i = 0; i < 30; i += 1) {
    const n = String(i).padStart(2, '0');
    tasks.push(task(`t${n}`, `Task ${n}`, { list: 'Bills' }));
  }
  return board({
    layout: { size, theme: 'light' },
    people: [person({
      id: 'sam',
      name: 'Sam',
      color: 'teal',
      events,
      tasks,
      habits: extra.habits ?? [],
      show: ['list:tl-bills', ...(extra.show ?? [])],
    })],
    lists: extra.lists ?? [],
  });
}

function count(html, marker) {
  return html.split(marker).length - 1;
}

describe('overflow', () => {
  it('cuts 40 events and 30 tasks, and 4k keeps more', () => {
    const small = renderBoard(busyBoard('1080p'));
    const large = renderBoard(busyBoard('4k'));
    const smallPerson = small.counts.people[0];
    const largePerson = large.counts.people[0];
    assert.equal(smallPerson.eventsShown + smallPerson.eventsCut, 40);
    assert.equal(smallPerson.tasksShown + smallPerson.tasksCut, 30);
    assert.ok(smallPerson.eventsCut > 0);
    assert.ok(smallPerson.tasksCut > 0);
    assert.ok(largePerson.eventsShown > smallPerson.eventsShown);
    assert.equal(count(small.html, '<li class="event'), smallPerson.eventsShown);
    assert.equal(count(small.html, '<li class="task'), smallPerson.tasksShown);
    assert.match(small.html, new RegExp(`and ${smallPerson.eventsCut} more`));
    assert.match(small.html, new RegExp(`and ${smallPerson.tasksCut} more`));
    if (smallPerson.tasksShown === 0) assert.match(small.html, new RegExp(`and ${smallPerson.tasksCut} more tasks`));
    assert.match(small.html, /Event 00/);
    assert.equal(small.html.includes(`Event ${String(smallPerson.eventsShown).padStart(2, '0')}`), false);
    assert.match(large.html, /Event 04/);
  });

  it('keeps a full column, including the lists strip, inside the screen budget', () => {
    const habits = [];
    for (let i = 0; i < 8; i += 1) habits.push(habit(`h${i}`, `Habit ${i}`));
    const lists = [{
      id: 'groceries',
      name: 'Groceries',
      items: ['Milk', 'Apples', 'Bread'],
      more: 2,
    }];
    const value = busyBoard('1080p', { habits, show: habits.map(item => `habit:${item.id}`), lists });
    const result = renderBoard(value);
    const personCounts = result.counts.people[0];
    assert.equal(personCounts.eventsShown + personCounts.eventsCut, 40);
    assert.equal(personCounts.tasksShown + personCounts.tasksCut, 30);
    assert.equal(personCounts.habitsShown + personCounts.habitsCut, 8);
    assert.equal(count(result.html, '<li class="event'), personCounts.eventsShown);
    assert.equal(count(result.html, '<li class="task'), personCounts.tasksShown);
    assert.equal(count(result.html, '<li class="habit'), personCounts.habitsShown);
    assert.equal(result.html.includes('.rows { min-width: 0; min-height: 0; overflow: hidden; }'), false);
    const fitted = fitPage({
      size: '1080p',
      title: 'The Maple family',
      writtenDate: 'Tuesday, November 3',
      updatedClock: '7:25 AM',
      stale: false,
      yesterday: false,
      people: [{
        id: 'sam',
        name: 'Sam',
        events: Array.from({ length: 40 }, (_, i) => ({ title: `Event ${i}` })),
        tasks: Array.from({ length: 30 }, (_, i) => ({ title: `Task ${i}`, label: 'Today' })),
        habits: habits.map(item => ({ name: item.name })),
        tasksHidden: 0,
        habitsHidden: 0,
        empty: false,
      }],
      lists,
    });
    assert.ok(fitted.budget.people[0].used <= fitted.budget.people[0].limit);
    assert.ok(fitted.budget.strip.used <= fitted.budget.strip.limit);
    assert.ok(fitted.people[0].eventsCut > 0);
  });

  it('cuts list chips that do not fit instead of clipping them', () => {
    const items = Array.from({ length: 12 }, (_, index) => `Item ${index} ${'W'.repeat(180)}`);
    const value = board({
      people: [person({ id: 'sam', name: 'Sam', color: 'teal' })],
      lists: [{ id: 'groceries', name: 'Groceries', items, more: 1 }],
    });
    const result = renderBoard(value);
    assert.ok(result.counts.listItemsShown < 12);
    assert.ok(result.counts.listItemsShown >= 1);
    assert.equal(result.counts.listItemsMore, 1 + (12 - result.counts.listItemsShown));
    assert.equal(count(result.html, '<li class="chip"'), result.counts.listItemsShown);
    assert.match(result.html, new RegExp(`and ${result.counts.listItemsMore} more`));
    assert.equal(result.html.includes(items[0]), true);
    assert.equal(result.html.includes(items[11]), false);
    assert.equal(result.html.includes('overflow: hidden;'), true);
    assert.equal(/\.lists \{[^}]*overflow:\s*hidden/.test(result.html), false);
  });
});
