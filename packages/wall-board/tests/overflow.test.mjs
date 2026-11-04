import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LINE_CAPS, renderBoard } from '../src/index.mjs';
import { allDay, board, person, task } from './helpers.mjs';

function busyBoard(size) {
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
      show: ['list:tl-bills'],
    })],
  });
}

function eventCount(html) {
  return html.split('<li class="event').length - 1;
}

describe('overflow', () => {
  it('cuts 40 events and 30 tasks, and 4k keeps more', () => {
    const small = renderBoard(busyBoard('1080p'));
    const large = renderBoard(busyBoard('4k'));
    const smallCaps = LINE_CAPS['1080p'];
    const largeCaps = LINE_CAPS['4k'];
    assert.deepEqual(
      {
        eventsShown: small.counts.people[0].eventsShown,
        eventsCut: small.counts.people[0].eventsCut,
        tasksShown: small.counts.people[0].tasksShown,
        tasksCut: small.counts.people[0].tasksCut,
      },
      {
        eventsShown: smallCaps.events,
        eventsCut: 40 - smallCaps.events,
        tasksShown: smallCaps.tasks,
        tasksCut: 30 - smallCaps.tasks,
      },
    );
    assert.equal(large.counts.people[0].eventsShown, largeCaps.events);
    assert.equal(large.counts.people[0].tasksShown, largeCaps.tasks);
    assert.ok(largeCaps.events > smallCaps.events);
    assert.ok(largeCaps.tasks > smallCaps.tasks);
    assert.ok(largeCaps.habits > smallCaps.habits);
    assert.match(small.html, new RegExp(`and ${40 - smallCaps.events} more`));
    assert.match(small.html, new RegExp(`and ${30 - smallCaps.tasks} more`));
    assert.match(large.html, new RegExp(`and ${40 - largeCaps.events} more`));
    assert.equal(eventCount(large.html) > eventCount(small.html), true);
    assert.match(small.html, /Event 00/);
    assert.equal(small.html.includes('Event 04'), false);
    assert.match(large.html, /Event 04/);
    assert.match(small.html, /Task 00/);
    assert.equal(small.html.includes('Task 05'), false);
    assert.match(large.html, /Task 05/);
    assert.equal(large.html.includes('Task 08'), false);
  });
});
