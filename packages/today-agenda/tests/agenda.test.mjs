import './guard.mjs';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../src/agenda.mjs';
import { FILE_BYTES } from '../src/errors.mjs';
import { AgendaError, buildAgenda, formatAgenda } from '../src/index.mjs';
import { takeCalls } from './guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'full-day.json');
const expectedJson = join(here, 'expected', 'full-day.json');
const expectedText = join(here, 'expected', 'full-day.txt');

const DATE = '2026-06-15';
const ZONE = 'America/Chicago';

function day(overrides = {}) {
  return {
    schemaVersion: 1,
    date: DATE,
    timeZone: ZONE,
    now: '2026-06-15T10:00:00-05:00',
    events: [],
    tasks: [],
    habits: [],
    lists: [],
    ...overrides,
  };
}

function at(hour, minute = 0, second = 0, date = DATE) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const ss = String(second).padStart(2, '0');
  return `${date}T${hh}:${mm}:${ss}-05:00`;
}

function timed(overrides = {}) {
  return {
    key: 'meeting',
    title: 'Meeting',
    start: at(9),
    end: at(10),
    allDay: false,
    calendar: 'Work',
    ...overrides,
  };
}

function refusal(input) {
  let caught;
  assert.throws(() => buildAgenda(input), (error) => {
    caught = error;
    assert.ok(error instanceof AgendaError, error.message);
    return true;
  });
  return caught.message;
}

function capture() {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    io: {
      stdout: { write(text) { out.stdout += text; } },
      stderr: { write(text) { out.stderr += text; } },
    },
  };
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) freeze(value[key]);
  return value;
}

const BANNED = /\b(missed|failed|behind|score)\b/i;

function assertNoGrading(value) {
  if (typeof value === 'string') {
    assert.doesNotMatch(value, BANNED);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoGrading(entry);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) assertNoGrading(entry);
  }
}

describe('1. full invented day', () => {
  const raw = readFileSync(fixturePath, 'utf8');
  const fixture = JSON.parse(raw);

  it('matches the saved JSON and plain text exactly', () => {
    const agenda = buildAgenda(fixture);
    assert.equal(`${JSON.stringify(agenda, null, 2)}\n`, readFileSync(expectedJson, 'utf8'));
    assert.equal(formatAgenda(agenda), readFileSync(expectedText, 'utf8'));
    assertNoGrading(agenda);
    assertNoGrading(formatAgenda(agenda));
  });

  it('does not mutate the input', () => {
    const copy = freeze(structuredClone(fixture));
    buildAgenda(copy);
  });
});

describe('2. events for the day', () => {
  const input = day({
    events: [
      timed({ key: 'into-today', title: 'Into today', start: at(22, 0, 0, '2026-06-14'), end: at(1) }),
      timed({ key: 'into-tomorrow', title: 'Into tomorrow', start: at(23), end: at(2, 0, 0, '2026-06-16') }),
      timed({ key: 'spans', title: 'Spans', start: at(22, 0, 0, '2026-06-14'), end: at(2, 0, 0, '2026-06-16') }),
      { key: 'fair', title: 'Fair', start: '2026-06-14', end: '2026-06-17', allDay: true, calendar: 'Family' },
      { key: 'ended', title: 'Ended', start: '2026-06-14', end: '2026-06-15', allDay: true, calendar: 'Family' },
      { key: 'later-day', title: 'Later', start: '2026-06-16', end: '2026-06-17', allDay: true, calendar: 'Family' },
      timed({ key: 'cancelled', title: 'Cancelled', status: 'cancelled' }),
      timed({ key: 'cancelled-other', title: 'Other cancelled', start: at(9, 0, 0, '2026-06-16'), end: at(10, 0, 0, '2026-06-16'), status: 'cancelled' }),
      timed({ key: 'other', title: 'Other day', start: at(9, 0, 0, '2026-06-16'), end: at(10, 0, 0, '2026-06-16') }),
      timed({ key: 'ends-at-midnight', title: 'Ends at midnight', start: at(22, 0, 0, '2026-06-14'), end: at(0) }),
      timed({ key: 'bell', title: 'Bell', start: at(12), end: at(12) }),
      timed({ key: 'next-midnight', title: 'Next midnight', start: at(0, 0, 0, '2026-06-16'), end: at(0, 0, 0, '2026-06-16') }),
    ],
  });
  const agenda = buildAgenda(input);
  const byKey = Object.fromEntries(agenda.timeline.map(event => [event.key, event]));

  it('keeps overlaps, all-day ranges and a no-length event on the day', () => {
    assert.deepEqual(Object.keys(byKey), ['fair', 'into-today', 'spans', 'bell', 'into-tomorrow']);
    assert.equal(byKey['into-today'].startsBefore, true);
    assert.equal(byKey['into-today'].endsAfter, false);
    assert.equal(byKey['into-tomorrow'].startsBefore, false);
    assert.equal(byKey['into-tomorrow'].endsAfter, true);
    assert.equal(byKey.spans.startsBefore, true);
    assert.equal(byKey.spans.endsAfter, true);
    assert.equal(byKey.bell.noLength, true);
    assert.equal(agenda.counts.cancelledEvents, 1);
  });

  it('leaves a no-length event out of clashes and free time', () => {
    const without = buildAgenda(day({
      now: at(7),
      events: [timed({ key: 'morning', start: at(9), end: at(10) }), timed({ key: 'bell', start: at(12), end: at(12) })],
    }));
    const quiet = buildAgenda(day({
      now: at(7),
      events: [timed({ key: 'morning', start: at(9), end: at(10) })],
    }));
    assert.equal(without.clashes.length, 0);
    assert.deepEqual(without.freeTime, quiet.freeTime);
    assert.equal(without.timeline.some(event => event.key === 'bell'), true);
  });
});

describe('3. clashes', () => {
  it('clashes at one minute and not when events only touch', () => {
    const oneMinute = buildAgenda(day({
      events: [
        timed({ key: 'a', start: at(10), end: at(11) }),
        timed({ key: 'b', start: at(10, 59), end: at(12) }),
      ],
    }));
    assert.equal(oneMinute.clashes.length, 1);
    assert.equal(oneMinute.clashes[0].minutes, 1);
    assert.deepEqual(oneMinute.clashes[0].keys, ['a', 'b']);

    const touching = buildAgenda(day({
      events: [
        timed({ key: 'a', start: at(10), end: at(11) }),
        timed({ key: 'b', start: at(11), end: at(12) }),
      ],
    }));
    assert.equal(touching.clashes.length, 0);

    const short = buildAgenda(day({
      events: [
        timed({ key: 'a', start: at(10), end: at(11) }),
        timed({ key: 'b', start: at(10, 59, 1), end: at(12) }),
      ],
    }));
    assert.equal(short.clashes.length, 0);
  });

  it('marks a tentative event clashing with a confirmed one, and ignores two tentative events', () => {
    const mixed = buildAgenda(day({
      events: [
        timed({ key: 'firm', start: at(10), end: at(11) }),
        timed({ key: 'maybe', start: at(10, 30), end: at(11, 30), status: 'tentative' }),
      ],
    }));
    assert.equal(mixed.clashes.length, 1);
    assert.equal(mixed.clashes[0].tentative, true);
    assert.match(formatAgenda(mixed), /tentative, clash/);

    const both = buildAgenda(day({
      events: [
        timed({ key: 'a', start: at(10), end: at(11), status: 'tentative' }),
        timed({ key: 'b', start: at(10, 30), end: at(11, 30), status: 'tentative' }),
      ],
    }));
    assert.equal(both.clashes.length, 0);
  });

  it('gives three clashes for three mutually overlapping events', () => {
    const agenda = buildAgenda(day({
      events: [
        timed({ key: 'c', title: 'C', start: at(11), end: at(13) }),
        timed({ key: 'a', title: 'A', start: at(10), end: at(12) }),
        timed({ key: 'b', title: 'B', start: at(10, 30), end: at(12, 30) }),
      ],
    }));
    assert.deepEqual(agenda.clashes.map(clash => clash.keys), [['a', 'b'], ['a', 'c'], ['b', 'c']]);
    assert.match(agenda.summary[1], /^There are 3 overlaps, the first at 10:30/);
  });
});

describe('4. free time', () => {
  it('drops a gap shorter than minFreeMinutes and keeps the rest', () => {
    const agenda = buildAgenda(day({
      now: at(7),
      events: [
        timed({ key: 'a', start: at(9), end: at(10) }),
        timed({ key: 'b', start: at(10, 20), end: at(11) }),
      ],
    }));
    assert.deepEqual(agenda.freeTime.map(gap => [gap.start, gap.end, gap.minutes]), [
      ['08:00', '09:00', 60],
      ['11:00', '18:00', 420],
    ]);
  });

  it('uses custom bounds, ignores all-day events, and trims before now only on the agenda date', () => {
    const custom = buildAgenda(day({
      now: at(6),
      settings: { dayStart: '07:00', dayEnd: '15:00', minFreeMinutes: 30 },
    }));
    assert.deepEqual(custom.freeTime.map(gap => [gap.start, gap.end, gap.minutes]), [
      ['07:00', '15:00', 480],
    ]);

    const allDay = buildAgenda(day({
      now: at(7),
      events: [{ key: 'fair', title: 'Fair', start: DATE, end: '2026-06-16', allDay: true, calendar: 'Family' }],
    }));
    assert.deepEqual(allDay.freeTime.map(gap => gap.minutes), [600]);

    const onDate = buildAgenda(day({ now: at(10) }));
    assert.deepEqual(onDate.freeTime.map(gap => [gap.start, gap.end, gap.minutes]), [
      ['10:00', '18:00', 480],
    ]);
    const eveningBefore = buildAgenda(day({ now: '2026-06-14T22:00:00-05:00' }));
    assert.deepEqual(eveningBefore.freeTime.map(gap => [gap.start, gap.end]), [['08:00', '18:00']]);
    const dayAfter = buildAgenda(day({ now: '2026-06-16T10:00:00-05:00' }));
    assert.deepEqual(dayAfter.freeTime.map(gap => [gap.start, gap.end]), [['08:00', '18:00']]);

    const trimmedAway = buildAgenda(day({ now: at(17, 40) }));
    assert.deepEqual(trimmedAway.freeTime, []);
  });

  it('keeps the earlier stretch when two free stretches are equally long', () => {
    const agenda = buildAgenda(day({
      now: at(7),
      settings: { dayStart: '08:00', dayEnd: '12:00' },
      events: [
        timed({ key: 'a', start: at(9), end: at(10) }),
        timed({ key: 'b', start: at(11), end: at(11, 30) }),
      ],
    }));
    assert.equal(agenda.summary.find(sentence => sentence.startsWith('Your longest')), 'Your longest free stretch is 08:00 to 09:00.');
  });

  it('names the later stretch when it is longer only by seconds', () => {
    const agenda = buildAgenda(day({
      now: at(7),
      settings: { dayStart: '08:00', dayEnd: '10:00', minFreeMinutes: 30 },
      events: [
        timed({ key: 'a', start: at(8, 30), end: at(9) }),
        timed({ key: 'b', start: at(9, 30, 30), end: at(10) }),
      ],
    }));
    assert.deepEqual(agenda.freeTime.map(gap => [gap.start, gap.end, gap.minutes]), [
      ['08:00', '08:30', 30],
      ['09:00', '09:30:30', 30],
    ]);
    assert.equal(
      agenda.summary.find(sentence => sentence.startsWith('Your longest')),
      'Your longest free stretch is 09:00 to 09:30:30.',
    );
  });
});

describe('5. clock changes', () => {
  it('shows New York spring-forward local times and a shorter morning', () => {
    const agenda = buildAgenda({
      schemaVersion: 1,
      date: '2026-03-08',
      timeZone: 'America/New_York',
      now: '2026-03-07T21:00:00-05:00',
      settings: { dayStart: '01:00', dayEnd: '04:00', minFreeMinutes: 30 },
      events: [
        timed({
          key: 'morning',
          title: 'Morning',
          start: '2026-03-08T09:00:00-04:00',
          end: '2026-03-08T10:00:00-04:00',
          calendar: 'Work',
        }),
        timed({
          key: 'utc',
          title: 'From UTC',
          start: '2026-03-08T13:30:00Z',
          end: '2026-03-08T14:00:00Z',
          calendar: 'Work',
        }),
      ],
      tasks: [],
      habits: [],
      lists: [],
    });
    const morning = agenda.timeline.find(event => event.key === 'morning');
    const utc = agenda.timeline.find(event => event.key === 'utc');
    assert.equal(morning.start, '2026-03-08T09:00');
    assert.equal(morning.end, '2026-03-08T10:00');
    assert.equal(utc.start, '2026-03-08T09:30');
    assert.equal(utc.end, '2026-03-08T10:00');
    assert.deepEqual(agenda.freeTime, [{
      start: '01:00',
      end: '04:00',
      startInstant: '2026-03-08T06:00:00Z',
      endInstant: '2026-03-08T08:00:00Z',
      minutes: 120,
    }]);
  });

  it('reads a spring-forward gap with the offset from before it', () => {
    const placed = buildAgenda({
      schemaVersion: 1,
      date: '2026-03-08',
      timeZone: 'America/New_York',
      now: '2026-03-07T21:00:00-05:00',
      settings: { dayStart: '02:30', dayEnd: '04:00', minFreeMinutes: 30 },
      events: [],
      tasks: [],
      habits: [],
      lists: [],
    });
    assert.equal(placed.freeTime[0].start, '03:30');
    assert.equal(placed.freeTime[0].startInstant, '2026-03-08T07:30:00Z');
    assert.equal(placed.freeTime[0].minutes, 30);
    assert.match(
      refusal({
        schemaVersion: 1,
        date: '2026-03-08',
        timeZone: 'America/New_York',
        now: '2026-03-07T21:00:00-05:00',
        settings: { dayStart: '02:30', dayEnd: '03:00' },
        events: [],
        tasks: [],
        habits: [],
        lists: [],
      }),
      /settings: dayStart is not before dayEnd/,
    );
  });

  it('uses the earlier instant on a fall-back morning and counts the extra hour', () => {
    const agenda = buildAgenda({
      schemaVersion: 1,
      date: '2026-11-01',
      timeZone: 'America/New_York',
      now: '2026-10-31T21:00:00-04:00',
      settings: { dayStart: '01:00', dayEnd: '03:00', minFreeMinutes: 30 },
      events: [
        timed({
          key: 'first',
          title: 'First',
          start: '2026-11-01T01:30:00-04:00',
          end: '2026-11-01T01:45:00-04:00',
        }),
        timed({
          key: 'second',
          title: 'Second',
          start: '2026-11-01T01:30:00-05:00',
          end: '2026-11-01T01:45:00-05:00',
        }),
      ],
      tasks: [],
      habits: [],
      lists: [],
    });
    assert.deepEqual(agenda.timeline.map(event => event.key), ['first', 'second']);
    assert.equal(agenda.timeline[0].start, '2026-11-01T01:30');
    assert.equal(agenda.timeline[1].start, '2026-11-01T01:30');
    assert.equal(agenda.timeline[0].startInstant, '2026-11-01T01:30:00-04:00');
    assert.deepEqual(agenda.freeTime.map(gap => [gap.startInstant, gap.endInstant, gap.minutes]), [
      ['2026-11-01T05:00:00Z', '2026-11-01T05:30:00Z', 30],
      ['2026-11-01T05:45:00Z', '2026-11-01T06:30:00Z', 45],
      ['2026-11-01T06:45:00Z', '2026-11-01T08:00:00Z', 75],
    ]);
    // 01:00 through 03:00 is three real hours. The two events cover 15 minutes each.
    assert.equal(agenda.freeTime.reduce((sum, gap) => sum + gap.minutes, 0), 150);
  });

  it('uses the earlier instant when Antarctica/Casey rolls back three hours', () => {
    const agenda = buildAgenda({
      schemaVersion: 1,
      date: '2020-03-08',
      timeZone: 'Antarctica/Casey',
      now: '2020-03-07T12:00:00Z',
      settings: { dayStart: '00:30', dayEnd: '04:00', minFreeMinutes: 30 },
      events: [],
      tasks: [],
      habits: [],
      lists: [],
    });
    assert.equal(agenda.freeTime.length, 1);
    assert.equal(agenda.freeTime[0].start, '00:30');
    assert.equal(agenda.freeTime[0].end, '04:00');
    assert.equal(agenda.freeTime[0].startInstant, '2020-03-07T13:30:00Z');
    assert.equal(agenda.freeTime[0].endInstant, '2020-03-07T20:00:00Z');
    assert.equal(agenda.freeTime[0].minutes, 390);
  });

  it('keeps :00 when only the fraction of a second is nonzero', () => {
    const agenda = buildAgenda({
      schemaVersion: 1,
      date: '2026-06-15',
      timeZone: 'UTC',
      now: '2026-06-15T09:00:00.500Z',
      events: [timed({
        key: 'half',
        title: 'Half second',
        start: '2026-06-15T10:00:00.500Z',
        end: '2026-06-15T11:00:00Z',
      })],
      tasks: [],
      habits: [],
      lists: [],
    });
    assert.equal(agenda.timeline[0].start, '2026-06-15T10:00:00');
    assert.equal(agenda.timeline[0].end, '2026-06-15T11:00');
    assert.equal(agenda.timeline[0].startInstant, '2026-06-15T10:00:00.500Z');
    assert.match(agenda.summary[0], /starting at 10:00:00\./);
    const opening = agenda.freeTime.find(gap => gap.startInstant === '2026-06-15T09:00:00.500Z');
    assert.equal(opening.start, '09:00:00');
    assert.equal(opening.end, '10:00:00');
    const plain = formatAgenda(agenda);
    assert.match(plain, /10:00:00-11:00/);
    assert.match(plain, /09:00:00-10:00:00/);
  });
});

describe('6. next up', () => {
  it('covers in progress, a gap, and after the last event', () => {
    const during = buildAgenda(day({
      now: at(9, 30),
      events: [timed({ start: at(9), end: at(10) }), timed({ key: 'later', start: at(11), end: at(12) })],
    }));
    assert.deepEqual(during.nextUp.inProgress.map(event => event.key), ['meeting']);
    assert.equal(during.nextUp.next.key, 'later');
    assert.equal(during.nextUp.next.minutesUntil, 90);

    const between = buildAgenda(day({
      now: at(10, 30),
      events: [timed({ start: at(9), end: at(10) }), timed({ key: 'later', start: at(11), end: at(12) })],
    }));
    assert.deepEqual(between.nextUp.inProgress, []);
    assert.equal(between.nextUp.next.key, 'later');
    assert.equal(between.nextUp.next.minutesUntil, 30);

    const after = buildAgenda(day({
      now: at(16),
      events: [timed({ start: at(9), end: at(10) })],
    }));
    assert.deepEqual(after.nextUp, { inProgress: [], next: null });

    const atStart = buildAgenda(day({ now: at(9), events: [timed({ start: at(9), end: at(10) })] }));
    assert.equal(atStart.nextUp.inProgress.length, 1);
    const atEnd = buildAgenda(day({ now: at(10), events: [timed({ start: at(9), end: at(10) })] }));
    assert.deepEqual(atEnd.nextUp.inProgress, []);
  });

  it('lists two overlapping events in timeline order and breaks a tied start the same way', () => {
    const events = [
      timed({ key: 'long', title: 'Alpha', start: at(9), end: at(12) }),
      timed({ key: 'short', title: 'Beta', start: at(9), end: at(11) }),
    ];
    const during = buildAgenda(day({ now: at(10), events }));
    assert.deepEqual(during.nextUp.inProgress.map(event => event.key), ['short', 'long']);
    const before = buildAgenda(day({ now: at(8), events }));
    assert.equal(before.nextUp.next.key, 'short');
    assert.equal(before.nextUp.next.minutesUntil, 60);
  });

  it('keeps an overnight event in progress the evening before, and is empty the day after', () => {
    const evening = buildAgenda(day({
      now: '2026-06-14T23:30:00-05:00',
      events: [
        timed({ key: 'night', title: 'Night', start: '2026-06-14T23:00:00-05:00', end: at(1) }),
        timed({ key: 'morning', title: 'Morning', start: at(9), end: at(10) }),
      ],
    }));
    assert.deepEqual(evening.nextUp.inProgress.map(event => event.key), ['night']);
    assert.equal(evening.nextUp.next.key, 'morning');
    assert.equal(evening.nextUp.next.minutesUntil, 570);

    const later = buildAgenda(day({
      now: '2026-06-16T10:00:00-05:00',
      events: [timed({ start: at(9), end: at(10) })],
    }));
    assert.deepEqual(later.nextUp, { inProgress: [], next: null });

    const stillRunning = buildAgenda(day({
      now: '2026-06-16T10:00:00-05:00',
      events: [timed({ key: 'late', start: at(22), end: '2026-06-16T11:00:00-05:00' })],
    }));
    assert.deepEqual(stillRunning.nextUp.inProgress.map(event => event.key), ['late']);
    assert.equal(stillRunning.nextUp.next, null);
    assert.equal(stillRunning.timeline[0].endsAfter, true);
  });

  it('can choose a no-length event as next and never calls it in progress', () => {
    const agenda = buildAgenda(day({
      now: at(11, 30),
      events: [timed({ key: 'bell', start: at(12), end: at(12) })],
    }));
    assert.deepEqual(agenda.nextUp.inProgress, []);
    assert.equal(agenda.nextUp.next.key, 'bell');
    assert.equal(agenda.nextUp.next.minutesUntil, 30);
    const onIt = buildAgenda(day({
      now: at(12),
      events: [timed({ key: 'bell', start: at(12), end: at(12) })],
    }));
    assert.deepEqual(onIt.nextUp, { inProgress: [], next: null });
  });
});

describe('7. tasks, habits and lists', () => {
  it('sorts overdue by due moment, then priority, title and id', () => {
    const agenda = buildAgenda(day({
      now: at(10),
      tasks: [
        { id: 'late-high', title: 'Alpha', due: '2026-06-10', priority: 'high' },
        { id: 'early-low', title: 'Zulu', due: '2026-06-01' },
        { id: 'b', title: 'Same', due: '2026-06-01' },
        { id: 'a', title: 'Same', due: '2026-06-01', priority: 'high' },
        { id: 'timed-low', title: 'Zulu', due: DATE, dueTime: at(15) },
        { id: 'untimed-high', title: 'Alpha', due: DATE, priority: 'high' },
        { id: 'draft', title: 'Send the draft', due: DATE, dueTime: at(9) },
        { id: 'soon', title: 'Soon', due: DATE, dueTime: at(8) },
        { id: 'no-due', title: 'Someday' },
        { id: 'future', title: 'Future', due: '2026-06-20' },
      ],
    }));
    assert.deepEqual(agenda.tasks.map(task => task.id), [
      'a', 'b', 'early-low', 'late-high', 'soon', 'draft', 'timed-low', 'untimed-high',
    ]);
    assert.deepEqual(agenda.tasks.map(task => task.group), [
      'overdue', 'overdue', 'overdue', 'overdue', 'overdue', 'overdue', 'today', 'today',
    ]);
    assert.equal(agenda.counts.tasksNoDue, 1);
    assert.equal(agenda.counts.tasksOtherDates, 1);
  });

  it('treats a date-only task due yesterday as overdue, and a timed task by its instant', () => {
    const morning = buildAgenda(day({
      now: at(8),
      tasks: [
        { id: 'yesterday', title: 'Yesterday', due: '2026-06-14' },
        { id: 'at-nine', title: 'At nine', due: DATE, dueTime: at(9) },
      ],
    }));
    assert.deepEqual(morning.tasks.map(task => [task.id, task.group]), [
      ['yesterday', 'overdue'],
      ['at-nine', 'today'],
    ]);
    const after = buildAgenda(day({
      now: at(10),
      tasks: [{ id: 'at-nine', title: 'At nine', due: DATE, dueTime: at(9) }],
    }));
    assert.equal(after.tasks[0].group, 'overdue');
  });

  it('keeps a task due on the agenda date as due today when now is the evening before', () => {
    const agenda = buildAgenda(day({
      now: '2026-06-14T21:00:00-05:00',
      tasks: [
        { id: 'today', title: 'Today', due: DATE },
        { id: 'timed', title: 'Timed', due: DATE, dueTime: at(9) },
        { id: 'yesterday', title: 'Yesterday', due: '2026-06-14' },
        { id: 'older', title: 'Older', due: '2026-06-13' },
      ],
    }));
    assert.deepEqual(agenda.tasks.map(task => [task.id, task.group]), [
      ['older', 'overdue'],
      ['timed', 'today'],
      ['today', 'today'],
    ]);
    assert.equal(agenda.counts.tasksOtherDates, 1);
  });

  it('refuses a dueTime whose local date does not match due', () => {
    const message = refusal(day({
      tasks: [{ id: 'bad', title: 'Bad', due: DATE, dueTime: '2026-06-15T04:30:00Z' }],
    }));
    assert.match(message, /tasks, item 1: dueTime falls on 2026-06-14 in America\/Chicago, not 2026-06-15/);
    const accepted = buildAgenda(day({
      tasks: [{ id: 'ok', title: 'Ok', due: '2026-06-14', dueTime: '2026-06-15T04:30:00Z' }],
    }));
    assert.equal(accepted.tasks[0].dueTimeLocal, '23:30');
  });

  it('lists open habits by name and lists by how many items are open', () => {
    const agenda = buildAgenda(day({
      habits: [
        { id: 'run', name: 'Easy run', state: 'rest' },
        { id: 'water', name: 'Water the fern', state: 'done' },
        { id: 'stretch', name: 'Stretch', state: 'open' },
        { id: 'read', name: 'Read a chapter', state: 'open' },
      ],
      lists: [
        { id: 'packing', name: 'Packing', open: 0 },
        { id: 'hardware', name: 'Hardware', open: 5 },
        { id: 'garden', name: 'Garden', open: 5 },
        { id: 'groceries', name: 'Groceries', open: 2 },
      ],
    }));
    assert.deepEqual(agenda.habits.map(habit => habit.name), ['Read a chapter', 'Stretch']);
    assert.equal(agenda.counts.habitsDone, 1);
    assert.equal(agenda.counts.habitsRest, 1);
    assert.deepEqual(agenda.lists.map(list => list.id), ['garden', 'hardware', 'groceries']);
    assert.match(agenda.summary.at(-2), /2 habits are still open/);
    assert.doesNotMatch(agenda.summary.join(' '), BANNED);
  });
});

describe('8. summary wording', () => {
  it('uses singular and plural and leaves out empty sentences', () => {
    const one = buildAgenda(day({
      now: at(19),
      events: [timed()],
      tasks: [{ id: 'rent', title: 'Rent', due: '2026-06-01' }],
      habits: [{ id: 'read', name: 'Read', state: 'open' }],
      lists: [{ id: 'groceries', name: 'Groceries', open: 1 }],
    }));
    assert.deepEqual(one.summary, [
      'You have 1 event today, starting at 09:00.',
      '1 task is overdue.',
      '1 habit is still open.',
      'Groceries has 1 item.',
    ]);

    const mixed = buildAgenda(day({
      now: at(19),
      tasks: [
        { id: 'a', title: 'Old', due: '2026-06-01' },
        { id: 'b', title: 'Older', due: '2026-06-02' },
        { id: 'c', title: 'Today', due: DATE },
      ],
    }));
    assert.equal(mixed.summary[0], '2 tasks are overdue and 1 is due today.');

    const quiet = buildAgenda(day({ now: at(19) }));
    assert.deepEqual(quiet.summary, []);
    assert.match(formatAgenda(quiet), /Nothing on the timeline/);
    assertNoGrading(formatAgenda(one));
  });

  it('says two events overlap when there is one clash', () => {
    const agenda = buildAgenda(day({
      events: [
        timed({ key: 'a', start: at(14), end: at(15) }),
        timed({ key: 'b', start: at(14, 15), end: at(15, 15) }),
      ],
    }));
    assert.equal(agenda.summary[1], '2 events overlap at 14:15.');
  });
});

describe('9. input checks', () => {
  it('names the section and position for each refusal', () => {
    const cases = [
      [day({ date: '2026-02-31' }), /day: date/],
      [day({ timeZone: 'Not/AZone' }), /day: timeZone/],
      [day({ now: '2026-06-15T10:00:00' }), /day: now/],
      [day({ schemaVersion: '1' }), /day: schemaVersion/],
      [day({ notes: 'nope' }), /day: unknown field "notes"/],
      [day({ events: 'nope' }), /day: events must be a list/],
      [day({ settings: { minFreeMinutes: 4 } }), /settings: minFreeMinutes/],
      [day({ settings: { minFreeMinutes: 241 } }), /settings: minFreeMinutes/],
      [day({ settings: { dayStart: '8:00' } }), /settings: dayStart/],
      [day({ settings: { dayStart: '18:00', dayEnd: '08:00' } }), /settings: dayStart must be earlier/],
      [day({ events: [timed({ key: '' })] }), /events, item 1: key/],
      [day({ events: [timed(), timed()] }), /events, item 2: repeated key/],
      [day({ events: [timed({ uid: 'x' })] }), /events, item 1: unknown field "uid"/],
      [day({ events: [timed({ title: 4 })] }), /events, item 1: title must be text/],
      [day({ events: [timed({ allDay: 'yes' })] }), /events, item 1: allDay/],
      [day({ events: [timed({ location: '' })] }), /events, item 1: location/],
      [day({ events: [timed({ calendar: 'x'.repeat(201) })] }), /events, item 1: calendar must be at most 200/],
      [day({ events: [timed({ status: 'busy' })] }), /events, item 1: status/],
      [day({ events: [timed({ end: at(8) })] }), /events, item 1: end must not be before start/],
      [day({ events: [{ key: 'a', title: 'A', start: DATE, end: DATE, allDay: true, calendar: 'Work' }] }), /events, item 1: end must be after start/],
      [day({ tasks: [{ id: 'a', title: '' }] }), /tasks, item 1: title/],
      [day({ tasks: [{ id: 'a', title: 'A'.repeat(501) }] }), /tasks, item 1: title must be at most 500/],
      [day({ tasks: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }), /tasks, item 2: repeated id/],
      [day({ tasks: [{ id: 'a', title: 'A', dueTime: at(9) }] }), /tasks, item 1: dueTime requires due/],
      [day({ tasks: [{ id: 'a', title: 'A', priority: 'low' }] }), /tasks, item 1: priority/],
      [day({ tasks: [{ id: 'a', title: 'A', list: '' }] }), /tasks, item 1: list/],
      [day({ habits: [{ id: 'a', name: '', state: 'open' }] }), /habits, item 1: name/],
      [day({ habits: [{ id: 'a', name: 'N'.repeat(201), state: 'open' }] }), /habits, item 1: name must be at most 200/],
      [day({ habits: [{ id: 'a', name: 'A', state: 'closed' }] }), /habits, item 1: state/],
      [day({ habits: [{ id: 'a', name: 'A', state: 'open' }, { id: 'a', name: 'B', state: 'done' }] }), /habits, item 2: repeated id/],
      [day({ lists: [{ id: 'a', name: 'A', open: 1.5 }] }), /lists, item 1: open/],
      [day({ lists: [{ id: 'a', name: 'A', open: 10001 }] }), /lists, item 1: open/],
      [day({ lists: [{ id: 'a', name: '', open: 1 }] }), /lists, item 1: name/],
      [day({ events: Array.from({ length: 501 }, (_, index) => timed({ key: `e${index}` })) }), /events: 501 items/],
    ];
    for (const [input, pattern] of cases) assert.match(refusal(input), pattern);
  });

  it('names the section and position when a required field is left out', () => {
    const bare = timed();
    delete bare.calendar;
    assert.match(
      refusal(day({ events: [timed({ key: 'first' }), bare] })),
      /events, item 2: calendar must be text\./,
    );
    assert.match(
      refusal(day({ tasks: [{ title: 'Pay the studio rent' }] })),
      /tasks, item 1: id must be text\./,
    );
  });

  it('refuses a malformed event start or end and a malformed task due or dueTime', () => {
    assert.match(
      refusal(day({ events: [timed({ start: '2026-06-15T09:00:00' })] })),
      /events, item 1: start must be an RFC 3339 instant with an offset or Z\./,
    );
    assert.match(
      refusal(day({ events: [timed({ end: '2026-02-31T10:00:00-05:00' })] })),
      /events, item 1: end must be an RFC 3339 instant with an offset or Z\./,
    );
    assert.match(
      refusal(day({ tasks: [{ id: 'a', title: 'A note', due: '2026-06-31' }] })),
      /tasks, item 1: due must be a real YYYY-MM-DD date\./,
    );
    assert.match(
      refusal(day({ tasks: [{ id: 'a', title: 'A note', due: DATE, dueTime: '2026-06-15T09:00:00' }] })),
      /tasks, item 1: dueTime must be an RFC 3339 instant with an offset or Z\./,
    );
  });

  it('accepts an empty event title and a 5000-character event title, and refuses an empty task title', () => {
    const empty = buildAgenda(day({ events: [timed({ title: '' })] }));
    assert.equal(empty.timeline[0].title, '(No title)');
    assert.match(formatAgenda(empty), /\(No title\)/);

    const longTitle = 'e'.repeat(5000);
    const long = buildAgenda(day({ events: [timed({ title: longTitle })] }));
    assert.equal(long.timeline[0].title, longTitle);

    assert.match(refusal(day({ tasks: [{ id: 'a', title: '' }] })), /tasks, item 1/);
    const taskOk = buildAgenda(day({ tasks: [{ id: 'a', title: 't'.repeat(500), due: DATE }] }));
    assert.equal(taskOk.tasks[0].title.length, 500);
  });

  it('allows the same id in different sections and sorts an empty title first', () => {
    const agenda = buildAgenda(day({
      events: [
        timed({ key: 'shared', title: 'Beta' }),
        { key: 'blank', title: '', start: DATE, end: '2026-06-16', allDay: true, calendar: 'Family' },
        { key: 'alpha', title: 'Alpha', start: DATE, end: '2026-06-16', allDay: true, calendar: 'Family' },
      ],
      tasks: [{ id: 'shared', title: 'Shared task', due: DATE }],
      habits: [{ id: 'shared', name: 'Shared habit', state: 'open' }],
    }));
    assert.deepEqual(agenda.timeline.map(event => event.key), ['blank', 'alpha', 'shared']);
    assert.equal(agenda.tasks[0].id, 'shared');
    assert.equal(agenda.habits[0].id, 'shared');
  });

  it('accepts the edges of the numeric limits and a real leap day', () => {
    const agenda = buildAgenda(day({
      date: '2028-02-29',
      now: '2028-02-29T10:00:00-06:00',
      settings: { minFreeMinutes: 5 },
      lists: [{ id: 'a', name: 'A', open: 10000 }],
    }));
    assert.equal(agenda.date, '2028-02-29');
    assert.equal(agenda.lists[0].open, 10000);
    buildAgenda(day({ settings: { minFreeMinutes: 240 } }));
    assert.match(refusal(day({ date: '2026-02-29' })), /day: date/);
  });

  it('accepts years 0001 through 0099 for the agenda, an all-day event and a task due date', () => {
    const agenda = buildAgenda({
      schemaVersion: 1,
      date: '0099-06-15',
      timeZone: 'UTC',
      now: '0099-06-15T12:00:00Z',
      events: [
        { key: 'fair', title: 'Fair', start: '0099-06-15', end: '0099-06-16', allDay: true, calendar: 'Work' },
        {
          key: 'bell',
          title: 'Bell',
          start: '0099-06-15T09:00:00Z',
          end: '0099-06-15T09:30:00Z',
          allDay: false,
          calendar: 'Work',
        },
      ],
      tasks: [{ id: 'note', title: 'Note', due: '0099-06-14' }],
      habits: [],
      lists: [],
    });
    assert.equal(agenda.date, '0099-06-15');
    assert.equal(agenda.timeline.find(event => event.key === 'fair').start, '0099-06-15');
    assert.equal(agenda.timeline.find(event => event.key === 'bell').start, '0099-06-15T09:00');
    assert.equal(agenda.tasks[0].due, '0099-06-14');
    assert.equal(agenda.tasks[0].group, 'overdue');
    const first = buildAgenda({
      schemaVersion: 1,
      date: '0001-01-01',
      timeZone: 'UTC',
      now: '0001-01-01T00:00:00Z',
      events: [],
      tasks: [{ id: 'leap', title: 'Leap', due: '0004-02-29' }],
      habits: [],
      lists: [],
    });
    assert.equal(first.date, '0001-01-01');
    assert.equal(first.counts.tasksOtherDates, 1);
    assert.match(refusal(day({ date: '0000-01-01' })), /day: date/);
    assert.match(refusal(day({ date: '0099-02-29' })), /day: date/);
  });

  it('does not use year 1 BCE as the year 0001 clock in New York', () => {
    const agenda = buildAgenda({
      schemaVersion: 1,
      date: '0001-01-01',
      timeZone: 'America/New_York',
      now: '0001-01-01T00:00:00Z',
      settings: { dayStart: '00:00', dayEnd: '04:00', minFreeMinutes: 30 },
      events: [{
        key: 'bell',
        title: 'Bell',
        start: '0001-01-01T06:00:00Z',
        end: '0001-01-01T07:00:00Z',
        allDay: false,
        calendar: 'Work',
      }],
      tasks: [],
      habits: [],
      lists: [],
    });
    assert.deepEqual(agenda.freeTime.map(gap => [gap.start, gap.end, gap.startInstant, gap.endInstant, gap.minutes]), [
      ['00:00', '01:03:58', '0001-01-01T04:56:02Z', '0001-01-01T06:00:00Z', 63],
      ['02:03:58', '04:00', '0001-01-01T07:00:00Z', '0001-01-01T08:56:02Z', 116],
    ]);
  });
});

describe('10. hostile text', () => {
  it('returns the characters unchanged in JSON and escapes them on one plain-text line', () => {
    const title = 'Say "hi" <script>alert(1)</script>\nnext\tcol \\path \u202E\u202Dعربي 😀';
    const agenda = buildAgenda(day({
      events: [timed({ title, location: 'Line\n2', calendar: 'Work\tShop' })],
      lists: [{ id: 'list', name: 'Groceries\nlist', open: 2 }],
    }));
    assert.equal(agenda.timeline[0].title, title);
    assert.equal(agenda.timeline[0].location, 'Line\n2');
    assert.equal(JSON.parse(JSON.stringify(agenda)).timeline[0].title, title);
    const plain = formatAgenda(agenda);
    const line = plain.split('\n').find(entry => entry.includes('<script>'));
    assert.ok(line);
    assert.equal(line.includes('\t'), false);
    assert.equal(line.includes('\u202E'), false);
    assert.match(line, /\\n/);
    assert.match(line, /\\t/);
    assert.match(line, /\\u202e/);
    assert.match(line, /\\u202d/);
    assert.match(line, /عربي 😀/);
    assert.match(line, /\\\\path/);
    assert.equal(plain.split('\n').some(entry => entry.includes('Groceries\\nlist')), true);
    assert.equal(agenda.summary.at(-1).includes('\n'), true);
  });
});

describe('11. determinism and no clock', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

  it('gives byte-identical JSON when each section is reversed', () => {
    const shuffled = structuredClone(fixture);
    shuffled.events.reverse();
    shuffled.tasks.reverse();
    shuffled.habits.reverse();
    shuffled.lists.reverse();
    const first = `${JSON.stringify(buildAgenda(fixture))}\n`;
    const second = `${JSON.stringify(buildAgenda(shuffled))}\n`;
    assert.equal(first, second);
  });

  it('runs with Date.now, an argument-less Date and local Date methods stubbed', () => {
    const RealDate = globalThis.Date;
    const thrown = [];
    const localNames = [
      'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds',
      'getMilliseconds', 'getTimezoneOffset', 'setFullYear', 'setMonth', 'setDate', 'setHours',
      'toString', 'toDateString', 'toTimeString', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString',
    ];
    const originals = new Map(localNames.map(name => [name, RealDate.prototype[name]]));
    for (const name of localNames) {
      RealDate.prototype[name] = function stubbed() {
        thrown.push(name);
        throw new Error(name);
      };
    }
    const originalNow = RealDate.now;
    RealDate.now = () => {
      thrown.push('now');
      throw new Error('now');
    };
    function WrappedDate(...args) {
      if (!new.target || args.length === 0) {
        thrown.push('Date');
        throw new Error('Date');
      }
      return new RealDate(...args);
    }
    WrappedDate.prototype = RealDate.prototype;
    WrappedDate.now = RealDate.now;
    WrappedDate.UTC = RealDate.UTC;
    WrappedDate.parse = RealDate.parse;
    const calls = [];
    const originalsConsole = { log: console.log, error: console.error, warn: console.warn, exit: process.exit };
    console.log = () => calls.push('log');
    console.error = () => calls.push('error');
    console.warn = () => calls.push('warn');
    process.exit = () => {
      calls.push('exit');
      throw new Error('exit');
    };
    globalThis.Date = WrappedDate;
    try {
      const agenda = buildAgenda(fixture);
      assert.equal(agenda.summary.length, 6);
      assert.deepEqual(thrown, []);
      assert.deepEqual(calls, []);
    } finally {
      globalThis.Date = RealDate;
      RealDate.now = originalNow;
      for (const [name, fn] of originals) RealDate.prototype[name] = fn;
      console.log = originalsConsole.log;
      console.error = originalsConsole.error;
      console.warn = originalsConsole.warn;
      process.exit = originalsConsole.exit;
    }
  });
});

describe('12. no network and nothing written', () => {
  it('makes a network entry point throw', () => {
    assert.throws(() => globalThis.fetch('http://example.test'), /Blocked in tests: fetch/);
    assert.deepEqual(takeCalls(), ['fetch']);
  });

  it('reads a day file and writes nothing', () => {
    const cap = capture();
    assert.equal(main(['--day', fixturePath, '--json'], cap.io), 0);
    assert.equal(cap.out.stdout, readFileSync(expectedJson, 'utf8'));
    assert.equal(cap.out.stderr, '');
    const plain = capture();
    assert.equal(main(['--day', fixturePath], plain.io), 0);
    assert.equal(plain.out.stdout, readFileSync(expectedText, 'utf8'));
  });
});

describe('command', () => {
  it('refuses a missing file, bad JSON, a bad day and a file over 2 MB without printing an agenda', () => {
    const missing = capture();
    assert.equal(main(['--day', join(here, 'no-such.json')], missing.io), 1);
    assert.equal(missing.out.stdout, '');
    assert.match(missing.out.stderr, /Couldn't open the day file/);

    const dir = mkdtempSync(join(tmpdir(), 'today-agenda-'));
    try {
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{');
      const parsed = capture();
      assert.equal(main(['--day', bad], parsed.io), 1);
      assert.equal(parsed.out.stdout, '');
      assert.match(parsed.out.stderr, /day: the file is not valid JSON/);

      const wrong = join(dir, 'wrong.json');
      writeFileSync(wrong, '{"schemaVersion":1}\n');
      const refused = capture();
      assert.equal(main(['--day', wrong], refused.io), 1);
      assert.equal(refused.out.stdout, '');
      assert.match(refused.out.stderr, /day: missing|day: date/);

      const big = join(dir, 'big.json');
      writeFileSync(big, Buffer.alloc(FILE_BYTES + 1, 0x20));
      const over = capture();
      assert.equal(main(['--day', big], over.io), 1);
      assert.equal(over.out.stdout, '');
      assert.match(over.out.stderr, new RegExp(String(FILE_BYTES)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a value the library measures as over 2 MB', () => {
    const huge = day({ events: [timed({ title: 'x'.repeat(FILE_BYTES) })] });
    assert.match(refusal(huge), /day: the day is \d+ bytes/);
  });

  it('refuses bad options', () => {
    for (const argv of [[], ['--json'], ['--day'], ['--day', fixturePath, '--day', fixturePath], ['--day', fixturePath, '--json', '--json'], ['--day', fixturePath, '--nope']]) {
      const cap = capture();
      assert.equal(main(argv, cap.io), 1);
      assert.equal(cap.out.stdout, '');
      assert.match(cap.out.stderr, /today-agenda:/);
    }
  });
});
