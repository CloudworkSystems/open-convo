import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderBoard } from '../src/index.mjs';
import { allDay, board, habit, person, task, timed } from './helpers.mjs';

describe('edge cases', () => {
  it('says nothing on today and leaves the lists strip out', () => {
    const html = renderBoard(board({
      people: [person({ id: 'sam', name: 'Sam', color: 'teal' })],
      lists: [],
    })).html;
    assert.match(html, /Nothing on today/);
    assert.equal(html.includes('<footer'), false);
    assert.equal(html.includes('more task'), false);
  });

  it('keeps an empty show list as counts only', () => {
    const html = renderBoard(board({
      people: [person({
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        tasks: [task('rent', 'Pay the studio rent', { list: 'Bills' })],
        show: [],
      })],
    })).html;
    assert.match(html, /1 more task/);
    assert.equal(html.includes('Pay the studio rent'), false);
  });

  it('omits and 0 more when a list has nothing further', () => {
    const html = renderBoard(board({
      lists: [{ id: 'hardware', name: 'Hardware', items: ['Nails'], more: 0 }],
    })).html;
    assert.match(html, /Hardware/);
    assert.match(html, /Nails/);
    assert.equal(html.includes('and 0 more'), false);
  });

  it('marks tentative events and keeps all-day events ahead of timed ones', () => {
    const sam = person({
      id: 'sam',
      name: 'Sam',
      color: 'teal',
      events: [
        timed('review', 'Design review', 14, 15, 'Family', { status: 'tentative' }),
        allDay('fair', 'Town fair', 'Family'),
      ],
    });
    sam.agenda.timeline.reverse();
    const html = renderBoard(board({ people: [sam] })).html;
    assert.ok(html.indexOf('Town fair') < html.indexOf('Design review'));
    assert.match(html, /Tentative/);
  });

  it('does not re-sort timed events', () => {
    const sam = person({
      id: 'sam',
      name: 'Sam',
      color: 'teal',
      events: [
        timed('early', 'Morning bell', 9, 10, 'Family'),
        timed('late', 'Evening bell', 18, 19, 'Family'),
      ],
    });
    sam.agenda.timeline.reverse();
    const html = renderBoard(board({ people: [sam] })).html;
    assert.ok(html.indexOf('Evening bell') < html.indexOf('Morning bell'));
  });

  it('shows a cancelled timeline entry instead of dropping it', () => {
    const sam = person({
      id: 'sam',
      name: 'Sam',
      color: 'teal',
      events: [timed('bell', 'Noon bell', 12, 13, 'Family')],
    });
    sam.agenda.timeline[0].status = 'cancelled';
    const html = renderBoard(board({ people: [sam] })).html;
    assert.match(html, /Cancelled/);
    assert.match(html, /Noon bell/);
  });

  it('writes seconds and a fraction on the updated clock', () => {
    const seconds = renderBoard(board({
      generatedAt: '2026-11-03T07:25:30-05:00',
    })).html;
    assert.match(seconds, /Updated 7:25:30 AM/);
    const fraction = renderBoard(board({
      generatedAt: '2026-11-03T07:25:00.500-05:00',
    })).html;
    assert.match(fraction, /Updated 7:25:00\.500 AM/);
  });

  it('does not change the board and repeats the same page', () => {
    const value = board({
      people: [person({
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        events: [allDay('fair', 'Town fair', 'Family', { location: 'River park' })],
        tasks: [task('rent', 'Pay the studio rent', { list: 'Bills', priority: 'high' })],
        habits: [habit('read', 'Read a chapter')],
        show: ['task:rent', 'habit:read'],
      })],
    });
    const before = JSON.stringify(value);
    const first = renderBoard(value);
    const second = renderBoard(value);
    assert.equal(JSON.stringify(value), before);
    assert.equal(first.html, second.html);
    assert.match(first.html, /High/);
  });

  it('leaves a long word whole for the page to wrap', () => {
    const word = 'Supercalifragilistic'.repeat(8);
    const html = renderBoard(board({
      people: [person({
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        events: [allDay('long', word, 'Family')],
      })],
    })).html;
    assert.equal(html.includes(word), true);
    assert.match(html, /overflow-wrap: anywhere/);
    assert.match(html, /max-height: calc\(var\(--line\) \* 2\)/);
  });

  it('uses singular counts for one hidden task or habit', () => {
    const html = renderBoard(board({
      people: [person({
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        tasks: [task('milk', 'Order oat milk')],
        habits: [habit('stretch', 'Stretch')],
      })],
    })).html;
    assert.match(html, /1 more task/);
    assert.equal(html.includes('1 more tasks'), false);
    assert.match(html, /1 more habit/);
    assert.equal(html.includes('1 more habits'), false);
  });
});
