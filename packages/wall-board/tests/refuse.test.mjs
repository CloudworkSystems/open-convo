import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FILE_BYTES, WallBoardError, renderBoard } from '../src/index.mjs';
import { agenda, allDay, board, person } from './helpers.mjs';

function refuses(value, pattern) {
  assert.throws(() => renderBoard(value), (error) => {
    assert.ok(error instanceof WallBoardError);
    assert.match(error.message, pattern);
    assert.equal(error.message.includes('\n'), false);
    return true;
  });
}

describe('refusals', () => {
  it('names the section for a bad board', () => {
    const missing = board();
    delete missing.title;
    refuses(missing, /^board: title is missing\.$/);

    const extra = board();
    extra.note = 'no';
    refuses(extra, /^board: unknown field "note"\.$/);

    const version = board();
    version.schemaVersion = '1';
    refuses(version, /^board: schemaVersion must be 1\.$/);

    const date = board();
    date.date = '2026-02-31';
    refuses(date, /^board: date must be a real YYYY-MM-DD date\.$/);

    const zone = board();
    zone.timeZone = 'Not/AZone';
    refuses(zone, /^board: timeZone must be an IANA time zone\.$/);

    const now = board();
    now.now = 'Tuesday';
    refuses(now, /^board: now must be an RFC 3339 instant/);

    const layout = board();
    layout.layout = { size: 'phone', theme: 'light' };
    refuses(layout, /^layout: size must be 1080p or 4k\.$/);

    refuses(board({ people: [] }), /^people: 0 items; at least 1 is required\.$/);
    refuses(board({ people: Array.from({ length: 9 }, () => ({})) }), /^people: 9 items; the limit is 8\.$/);

    const lists = Array.from({ length: 7 }, (_, index) => ({
      id: `list-${index}`, name: `List ${index}`, items: [], more: 0,
    }));
    refuses(board({ lists }), /^lists: 7 items; the limit is 6\.$/);

    refuses(board({
      lists: [{ id: 'groceries', name: 'Groceries', items: Array.from({ length: 13 }, (_, i) => `Item ${i}`), more: 0 }],
    }), /lists, item 1: items: 13 items; the limit is 12/);

    const repeated = board();
    repeated.people = [
      person({ id: 'sam', name: 'Sam', color: 'teal' }),
      person({ id: 'sam', name: 'Quinn', color: 'coral' }),
    ];
    refuses(repeated, /^people, item 2: repeated id "sam"\.$/);

    const color = board();
    color.people = [
      person({ id: 'sam', name: 'Sam', color: 'teal' }),
      person({ id: 'quinn', name: 'Quinn', color: 'teal' }),
    ];
    refuses(color, /^people, item 2: the color teal is already used by Sam\.$/);
  });

  it('refuses an agenda whose date or time zone differs', () => {
    refuses(board({
      people: [person({
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        agenda: agenda({ date: '2026-11-04', now: '2026-11-04T07:30:00-05:00' }),
      })],
    }), /people, item 1: the agenda date is "2026-11-04", not 2026-11-03/);

    refuses(board({
      people: [person({
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        agenda: agenda({ timeZone: 'UTC', now: '2026-11-03T12:30:00Z' }),
      })],
    }), /people, item 1: the agenda time zone is "UTC", not America\/New_York/);
  });

  it('refuses a repeated event key and a show rule that names nothing', () => {
    const sam = person({
      id: 'sam',
      name: 'Sam',
      color: 'teal',
      events: [allDay('fair', 'Town fair', 'Family')],
    });
    sam.agenda.timeline.push({ ...sam.agenda.timeline[0] });
    refuses(board({ people: [sam] }), /repeated key "fair"/);

    refuses(board({
      people: [person({
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        show: ['habit:missing'],
      })],
    }), /habit "missing" names nothing on this day/);
  });

  it('refuses a board larger than 2 MB and does not return a page', () => {
    const value = board();
    value.padding = 'x'.repeat(FILE_BYTES);
    refuses(value, /the limit is 2097152 bytes \(2 MB\)/);
  });

  it('refuses a private rule that is not a key', () => {
    refuses(board({ private: ['list:bills'] }), /^private, item 1: expected a key: rule\.$/);
    refuses(board({ private: ['key:'] }), /^private, item 1: expected a key: rule\.$/);
    refuses(board({ private: ['key:same', 'key:same'] }), /repeated key "same"/);
  });
});
