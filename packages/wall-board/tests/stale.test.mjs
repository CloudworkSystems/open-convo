import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderBoard } from '../src/index.mjs';
import { board, person } from './helpers.mjs';

function at(now) {
  return renderBoard(board({
    now,
    generatedAt: '2026-11-03T07:00:00-05:00',
    people: [person({ id: 'sam', name: 'Sam', color: 'teal' })],
  }));
}

describe('stale and yesterday', () => {
  it('stays quiet at 30 minutes and warns at 31', () => {
    const fresh = at('2026-11-03T07:30:00-05:00');
    const stale = at('2026-11-03T07:31:00-05:00');
    assert.match(fresh.html, /Updated 7:00 AM/);
    assert.equal(fresh.html.includes('Not updated since'), false);
    assert.deepEqual(fresh.warnings, []);
    assert.match(stale.html, /Not updated since 7:00 AM/);
    assert.match(stale.html, /class="updated stale"/);
    assert.deepEqual(stale.warnings, ['Not updated since 7:00 AM.']);
  });

  it('treats one extra millisecond as stale and a future stamp as fresh', () => {
    const barely = renderBoard(board({
      generatedAt: '2026-11-03T07:00:00.000-05:00',
      now: '2026-11-03T07:30:00.001-05:00',
      people: [person({ id: 'sam', name: 'Sam', color: 'teal' })],
    }));
    assert.match(barely.html, /Not updated since/);
    const early = at('2026-11-03T06:00:00-05:00');
    assert.equal(early.html.includes('Not updated since'), false);
  });

  it('shows yesterday when now falls on a later civil date', () => {
    const next = renderBoard(board({
      now: '2026-11-04T00:30:00-05:00',
      people: [person({ id: 'sam', name: 'Sam', color: 'teal' })],
    }));
    assert.match(next.html, /This is yesterday's board/);
    const later = renderBoard(board({
      now: '2026-11-06T12:00:00-05:00',
      people: [person({ id: 'sam', name: 'Sam', color: 'teal' })],
    }));
    assert.match(later.html, /This is yesterday's board/);
  });

  it('uses the board time zone for the civil date', () => {
    const stillToday = renderBoard(board({
      now: '2026-11-04T04:30:00Z',
      people: [person({ id: 'sam', name: 'Sam', color: 'teal' })],
    }));
    assert.equal(stillToday.html.includes("yesterday's board"), false);
    const nextDay = renderBoard(board({
      now: '2026-11-04T05:30:00Z',
      people: [person({ id: 'sam', name: 'Sam', color: 'teal' })],
    }));
    assert.match(nextDay.html, /This is yesterday's board/);
  });

  it('does not call an earlier date yesterday', () => {
    const earlier = renderBoard(board({
      now: '2026-11-02T12:00:00-05:00',
      people: [person({ id: 'sam', name: 'Sam', color: 'teal' })],
    }));
    assert.equal(earlier.html.includes("yesterday's board"), false);
    assert.equal(earlier.html.includes('Not updated since'), false);
  });
});
