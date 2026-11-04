import { buildAgenda } from '../../today-agenda/src/index.mjs';

export const DATE = '2026-11-03';
export const ZONE = 'America/New_York';
export const NOW = '2026-11-03T07:30:00-05:00';
export const GENERATED = '2026-11-03T07:25:00-05:00';

export function at(hour, minute = 0, second = 0, date = DATE) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const ss = String(second).padStart(2, '0');
  return `${date}T${hh}:${mm}:${ss}-05:00`;
}

export function agenda(overrides = {}) {
  return buildAgenda({
    schemaVersion: 1,
    date: DATE,
    timeZone: ZONE,
    now: NOW,
    events: [],
    tasks: [],
    habits: [],
    lists: [],
    ...overrides,
  });
}

export function timed(key, title, hour, endHour, calendar, extra = {}) {
  return {
    key,
    title,
    start: extra.start ?? at(hour, extra.minute ?? 0, extra.second ?? 0),
    end: extra.end ?? at(endHour, extra.endMinute ?? 0, extra.endSecond ?? 0),
    allDay: false,
    calendar,
    location: Object.hasOwn(extra, 'location') ? extra.location : null,
    status: extra.status ?? 'confirmed',
  };
}

export function allDay(key, title, calendar, extra = {}) {
  return {
    key,
    title,
    start: extra.start ?? DATE,
    end: extra.end ?? '2026-11-04',
    allDay: true,
    calendar,
    location: Object.hasOwn(extra, 'location') ? extra.location : null,
    status: extra.status ?? 'confirmed',
  };
}

export function task(id, title, extra = {}) {
  return {
    id,
    title,
    due: extra.due ?? DATE,
    priority: extra.priority,
    list: extra.list,
    dueTime: extra.dueTime,
  };
}

export function habit(id, name, state = 'open') {
  return { id, name, state };
}

let personSerial = 0;

export function person(spec = {}) {
  personSerial += 1;
  const built = spec.agenda ?? agenda({
    events: spec.events ?? [],
    tasks: spec.tasks ?? [],
    habits: spec.habits ?? [],
    lists: spec.agendaLists ?? [],
  });
  const calendarNames = [...new Set(built.timeline.map(event => event.calendar))];
  const listNames = [...new Set(built.tasks.map(row => row.list).filter(name => name !== null))];
  const calendars = spec.sources?.calendars ?? calendarNames.map(name => ({
    id: `cal-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
  }));
  const taskLists = spec.sources?.taskLists ?? listNames.map(name => ({
    id: `tl-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
  }));
  const body = {
    id: spec.id ?? `person-${personSerial}`,
    name: spec.name ?? 'Sam',
    color: spec.color ?? 'teal',
    calendars: spec.calendars ?? calendars.map(source => source.id),
    sources: { calendars, taskLists },
    agenda: built,
  };
  if (spec.show !== undefined) body.show = spec.show;
  return body;
}

export function board(overrides = {}) {
  return {
    schemaVersion: 1,
    title: 'The Maple family',
    date: DATE,
    timeZone: ZONE,
    now: NOW,
    generatedAt: GENERATED,
    layout: { size: '1080p', theme: 'light' },
    people: overrides.people ?? [person({ name: 'Sam', color: 'teal', id: 'sam' })],
    lists: overrides.lists ?? [],
    ...strip(overrides, ['people', 'lists']),
  };
}

function strip(overrides, keys) {
  const copy = { ...overrides };
  for (const key of keys) delete copy[key];
  return copy;
}

export function mapleBoard() {
  const samAgenda = agenda({
    events: [
      allDay('fair', 'Town fair', 'Family', { location: 'River park' }),
      timed('review', 'Design review', 14, 15, 'Family', { location: 'Studio' }),
      timed('tooth|2026-11-03T19:00:00Z', 'Tooth cleaning', 14, 14, 'Family', {
        endMinute: 30,
        location: 'Room 4',
      }),
      timed('quiet', 'Quiet rehearsal', 16, 16, 'Private', {
        endMinute: 45,
        location: 'Side room',
      }),
    ],
    tasks: [
      task('rent', 'Pay the studio rent', { due: '2026-10-20', priority: 'high', list: 'Bills' }),
      task('notes', 'File the notes', { list: 'Bills' }),
      task('milk', 'Order oat milk', { due: '2026-10-25' }),
    ],
    habits: [
      habit('read', 'Read a chapter'),
      habit('stretch', 'Stretch'),
    ],
    lists: [{ id: 'groceries', name: 'Groceries', open: 6 }],
  });
  const quinnAgenda = agenda({
    events: [
      timed('library', 'Library visit', 10, 11, 'Family', { endMinute: 30, location: 'Reading room' }),
    ],
    tasks: [task('glue', 'Buy glue', { list: 'Errands' })],
    habits: [habit('stretch', 'Stretch')],
  });
  return {
    schemaVersion: 1,
    title: 'The Maple family',
    date: DATE,
    timeZone: ZONE,
    now: NOW,
    generatedAt: GENERATED,
    layout: { size: '1080p', theme: 'light' },
    people: [
      {
        id: 'sam',
        name: 'Sam',
        color: 'teal',
        calendars: ['cal-family', 'cal-school'],
        sources: {
          calendars: [
            { id: 'cal-family', name: 'Family' },
            { id: 'cal-school', name: 'School' },
            { id: 'cal-private', name: 'Private' },
          ],
          taskLists: [
            { id: 'tl-bills', name: 'Bills' },
            { id: 'tl-errands', name: 'Errands' },
          ],
        },
        show: ['list:tl-bills', 'habit:read'],
        agenda: samAgenda,
      },
      {
        id: 'quinn',
        name: 'Quinn',
        color: 'coral',
        calendars: ['cal-family'],
        sources: {
          calendars: [{ id: 'cal-family', name: 'Family' }],
          taskLists: [{ id: 'tl-errands', name: 'Errands' }],
        },
        agenda: quinnAgenda,
      },
    ],
    lists: [
      { id: 'groceries', name: 'Groceries', items: ['Milk', 'Apples'], more: 4 },
      { id: 'hardware', name: 'Hardware', items: ['Nails'], more: 0 },
    ],
    private: [
      'key:tooth|2026-11-03T19:00:00Z',
      'key:next-week|2026-11-10T15:00:00Z',
    ],
  };
}
