import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WallBoardError, renderBoard } from '../src/index.mjs';
import { allDay, at, board, habit, person, task, timed } from './helpers.mjs';

function page(value) {
  return renderBoard(value).html;
}

describe('privacy', () => {
  it('hides a calendar that is not shared, including after a rename', () => {
    const value = board({
      people: [
        person({
          id: 'sam',
          name: 'Sam',
          color: 'teal',
          events: [
            timed('stand', 'Standup', 9, 10, 'Office', { location: 'Front desk' }),
            timed('secret', 'Secret interview', 11, 12, 'Work', { location: 'Clinic back room' }),
          ],
          tasks: [
            task('water', 'Water the plants', { list: 'Home' }),
            task('clinic', 'Call the clinic', { list: 'Errands' }),
          ],
          sources: {
            calendars: [
              { id: 'cal-office', name: 'Office' },
              { id: 'cal-private', name: 'Work' },
            ],
            taskLists: [
              { id: 'tl-shared', name: 'Home' },
              { id: 'tl-private', name: 'Errands' },
            ],
          },
          calendars: ['cal-office'],
          show: ['list:tl-shared'],
        }),
      ],
    });
    const html = page(value);
    assert.match(html, /Standup/);
    assert.match(html, /Front desk/);
    assert.match(html, /Water the plants/);
    assert.match(html, />Busy</);
    assert.match(html, /1 more task/);
    for (const secret of ['Secret interview', 'Clinic back room', 'Call the clinic']) {
      assert.equal(html.includes(secret), false, secret);
    }
  });

  it('refuses two sources that share a name', () => {
    const value = board({
      people: [
        person({
          id: 'sam',
          name: 'Sam',
          color: 'teal',
          sources: {
            calendars: [
              { id: 'cal-a', name: 'Work' },
              { id: 'cal-b', name: 'Work' },
            ],
            taskLists: [],
          },
          calendars: [],
        }),
      ],
    });
    assert.throws(() => renderBoard(value), (error) => {
      assert.ok(error instanceof WallBoardError);
      assert.match(error.message, /sources\.calendars, item 2: the name "Work" is already used/);
      return true;
    });
  });

  it('refuses two task lists that share a name', () => {
    const value = board({
      people: [
        person({
          id: 'sam',
          name: 'Sam',
          color: 'teal',
          sources: {
            calendars: [],
            taskLists: [
              { id: 'tl-a', name: 'Errands' },
              { id: 'tl-b', name: 'Errands' },
            ],
          },
          calendars: [],
        }),
      ],
    });
    assert.throws(() => renderBoard(value), /taskLists, item 2: the name "Errands" is already used/);
  });

  it('hides one event with a key rule and warns when the key matches nothing', () => {
    const value = board({
      people: [
        person({
          id: 'sam',
          name: 'Sam',
          color: 'teal',
          events: [
            timed('dentist|2026-11-03T19:00:00Z', 'Tooth cleaning', 14, 15, 'Family', { location: 'Room 4' }),
            timed('fair', 'Town fair visit', 16, 17, 'Family', { location: 'River park' }),
          ],
        }),
      ],
      private: ['key:dentist|2026-11-03T19:00:00Z', 'key:next-week|2026-11-10T15:00:00Z'],
    });
    const { html, warnings } = renderBoard(value);
    assert.equal(html.includes('Tooth cleaning'), false);
    assert.equal(html.includes('Room 4'), false);
    assert.match(html, /Town fair visit/);
    assert.match(html, /River park/);
    assert.match(html, />Busy</);
    assert.deepEqual(warnings, [
      'private, item 2: no event today has the key "next-week|2026-11-10T15:00:00Z".',
    ]);
  });

  it('shows only counts when there is no show list', () => {
    const value = board({
      people: [
        person({
          id: 'sam',
          name: 'Sam',
          color: 'teal',
          tasks: [task('rent', 'Pay the studio rent', { list: 'Bills' }), task('milk', 'Order oat milk')],
          habits: [habit('read', 'Read a chapter'), habit('stretch', 'Stretch')],
        }),
      ],
    });
    const html = page(value);
    assert.match(html, /2 more tasks/);
    assert.match(html, /2 more habits/);
    assert.equal(html.includes('Pay the studio rent'), false);
    assert.equal(html.includes('Order oat milk'), false);
    assert.equal(html.includes('Read a chapter'), false);
    assert.equal(html.includes('Stretch'), false);
    assert.equal(html.includes('Nothing on today'), false);
  });

  it('shows exactly the tasks and habits a show rule names', () => {
    const value = board({
      people: [
        person({
          id: 'sam',
          name: 'Sam',
          color: 'teal',
          tasks: [
            task('rent', 'Pay the studio rent', { list: 'Bills' }),
            task('milk', 'Order oat milk'),
            task('glue', 'Buy glue', { list: 'Errands' }),
          ],
          habits: [habit('read', 'Read a chapter'), habit('stretch', 'Stretch')],
          show: ['list:tl-bills', 'task:milk', 'habit:read'],
        }),
      ],
    });
    const html = page(value);
    assert.match(html, /Pay the studio rent/);
    assert.match(html, /Order oat milk/);
    assert.match(html, /Read a chapter/);
    assert.equal(html.includes('Buy glue'), false);
    assert.equal(html.includes('Stretch'), false);
    assert.match(html, /1 more task/);
    assert.match(html, /1 more habit/);
  });

  it('refuses a show rule that names nothing', () => {
    const value = board({
      people: [
        person({
          id: 'sam',
          name: 'Sam',
          color: 'teal',
          tasks: [task('rent', 'Pay the studio rent', { list: 'Bills' })],
          show: ['list:Bills'],
        }),
      ],
    });
    assert.throws(() => renderBoard(value), /show, item 1: list "Bills" names nothing on this day/);
  });

  it('does not match calendar or list names', () => {
    const named = board({
      people: [
        person({
          id: 'sam',
          name: 'Sam',
          color: 'teal',
          events: [allDay('fair', 'Town fair', 'Family')],
          calendars: ['Family'],
        }),
      ],
    });
    assert.throws(() => renderBoard(named), /calendars, item 1: "Family" is not a source calendar/);
  });

  it('keeps a task with no list hidden unless its own task rule names it', () => {
    const hidden = board({
      people: [person({
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        tasks: [task('milk', 'Order oat milk'), task('rent', 'Pay the studio rent', { list: 'Bills' })],
        show: ['list:tl-bills'],
      })],
    });
    assert.equal(page(hidden).includes('Order oat milk'), false);
    const shown = board({
      people: [person({
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        tasks: [task('milk', 'Order oat milk')],
        show: ['task:milk'],
      })],
    });
    assert.match(page(shown), /Order oat milk/);
  });

  it('shows a task once when a list rule and a task rule both name it', () => {
    const value = board({
      people: [person({
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        tasks: [task('rent', 'Pay the studio rent', { list: 'Bills' })],
        show: ['list:tl-bills', 'task:rent'],
      })],
    });
    const html = page(value);
    assert.equal(html.split('Pay the studio rent').length - 1, 1);
    assert.equal(renderBoard(value).counts.people[0].tasksShown, 1);
  });

  it('refuses a calendar name the agenda uses that sources do not list', () => {
    const value = board({
      people: [person({
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        events: [timed('club', 'Club night', 19, 20, 'Club')],
        sources: { calendars: [{ id: 'cal-family', name: 'Family' }], taskLists: [] },
        calendars: ['cal-family'],
      })],
    });
    assert.throws(() => renderBoard(value), /calendar "Club" is not in sources/);
  });

  it('treats a different case as a different name', () => {
    const value = board({
      people: [person({
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        events: [allDay('fair', 'Town fair', 'work')],
        sources: { calendars: [{ id: 'cal-work', name: 'Work' }], taskLists: [] },
        calendars: ['cal-work'],
      })],
    });
    assert.throws(() => renderBoard(value), /calendar "work" is not in sources/);
  });

  it('still shows the time of a busy event', () => {
    const value = board({
      people: [person({
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        events: [timed('secret', 'Secret interview', 11, 12, 'Work', { location: 'Clinic back room' })],
        sources: {
          calendars: [
            { id: 'cal-family', name: 'Family' },
            { id: 'cal-private', name: 'Work' },
          ],
          taskLists: [],
        },
        calendars: ['cal-family'],
      })],
    });
    const html = page(value);
    assert.match(html, /11:00 AM – 12:00 PM/);
    assert.match(html, />Busy</);
    assert.equal(html.includes('Secret interview'), false);
  });

  it('uses the caller clock for a cross-day event without moving it', () => {
    const value = board({
      people: [person({
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        events: [{
          key: 'bake',
          title: 'Overnight bake',
          start: at(23, 0, 0, '2026-11-02'),
          end: at(0, 30, 0, '2026-11-03'),
          allDay: false,
          calendar: 'Family',
          location: null,
          status: 'confirmed',
        }],
      })],
    });
    assert.match(page(value), /Nov 2, 11:00 PM – 12:30 AM/);
    assert.match(page(value), /Overnight bake/);
  });
});
