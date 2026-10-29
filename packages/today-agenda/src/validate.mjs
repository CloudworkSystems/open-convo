import { DEFAULTS, LIMITS, SCHEMA_VERSION, fail } from './errors.mjs';
import {
  addCivilDays,
  civilDate,
  clockOnDate,
  isIanaTimeZone,
  parseCivilDate,
  parseClock,
  parseInstant,
  startOfCivilDay,
} from './time.mjs';

const EVENT_FIELDS = new Set(['key', 'title', 'start', 'end', 'allDay', 'calendar', 'location', 'status']);
const TASK_FIELDS = new Set(['id', 'title', 'due', 'dueTime', 'priority', 'list']);
const HABIT_FIELDS = new Set(['id', 'name', 'state']);
const LIST_FIELDS = new Set(['id', 'name', 'open']);
const SETTINGS_FIELDS = new Set(['dayStart', 'dayEnd', 'minFreeMinutes']);
const DAY_FIELDS = new Set(['schemaVersion', 'date', 'timeZone', 'now', 'settings', 'events', 'tasks', 'habits', 'lists']);
const STATUSES = new Set(['confirmed', 'tentative', 'cancelled']);
const STATES = new Set(['open', 'done', 'rest']);

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function quoted(value) {
  return JSON.stringify(value).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function rejectUnknown(object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(`${where}: unknown field ${quoted(key)}.`);
  }
}

function whole(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function text(value, where, { min = 1, max = Infinity } = {}) {
  if (typeof value !== 'string') fail(`${where} must be text.`);
  if (value.length < min) fail(`${where} must be at least ${min} character.`);
  if (value.length > max) fail(`${where} must be at most ${max} characters.`);
  return value;
}

function item(section, index) {
  return `${section}, item ${index + 1}`;
}

export function validateDay(day) {
  if (!plainObject(day)) fail('day: the day must be a JSON object.');
  let encoded;
  try {
    encoded = JSON.stringify(day);
  } catch {
    fail('day: the day must be a JSON object.');
  }
  if (typeof encoded !== 'string') fail('day: the day must be a JSON object.');
  const bytes = Buffer.byteLength(encoded);
  if (bytes > LIMITS.fileBytes) {
    fail(`day: the day is ${bytes} bytes; the limit is ${LIMITS.fileBytes} bytes (2 MB).`);
  }
  rejectUnknown(day, DAY_FIELDS, 'day');
  if (!Object.is(day.schemaVersion, SCHEMA_VERSION)) fail('day: schemaVersion must be 1.');
  const date = parseCivilDate(day.date);
  if (!date) fail('day: date must be a real YYYY-MM-DD date.');
  if (!isIanaTimeZone(day.timeZone)) fail('day: timeZone must be an IANA time zone.');
  const nowMs = parseInstant(day.now);
  if (nowMs === null) fail('day: now must be an RFC 3339 instant with an offset or Z.');
  const nextDate = addCivilDays(date.text, 1);
  const civilStartMs = startOfCivilDay(date.text, day.timeZone);
  const civilEndMs = nextDate ? startOfCivilDay(nextDate, day.timeZone) : null;
  if (civilStartMs === null || civilEndMs === null) fail('day: date does not exist in this time zone.');

  const settings = readSettings(day.settings, date.text, day.timeZone);
  return {
    date: date.text,
    timeZone: day.timeZone,
    nowMs,
    civilStartMs,
    civilEndMs,
    ...settings,
    events: readEvents(day.events),
    tasks: readTasks(day.tasks, day.timeZone),
    habits: readHabits(day.habits),
    lists: readLists(day.lists),
  };
}

function readSettings(settings, date, timeZone) {
  if (settings === undefined) return placeSettings(DEFAULTS.dayStart, DEFAULTS.dayEnd, DEFAULTS.minFreeMinutes, date, timeZone);
  if (!plainObject(settings)) fail('settings: settings must be an object.');
  rejectUnknown(settings, SETTINGS_FIELDS, 'settings');
  const dayStart = settings.dayStart === undefined ? DEFAULTS.dayStart : settings.dayStart;
  const dayEnd = settings.dayEnd === undefined ? DEFAULTS.dayEnd : settings.dayEnd;
  const minFreeMinutes = settings.minFreeMinutes === undefined ? DEFAULTS.minFreeMinutes : settings.minFreeMinutes;
  if (parseClock(dayStart) === null) fail('settings: dayStart must be HH:MM in 24-hour time.');
  if (parseClock(dayEnd) === null) fail('settings: dayEnd must be HH:MM in 24-hour time.');
  if (dayStart >= dayEnd) fail('settings: dayStart must be earlier than dayEnd.');
  if (!whole(minFreeMinutes) || Object.is(minFreeMinutes, -0)
    || minFreeMinutes < LIMITS.minFreeMinutes.min || minFreeMinutes > LIMITS.minFreeMinutes.max) {
    fail(`settings: minFreeMinutes must be a whole number from ${LIMITS.minFreeMinutes.min} to ${LIMITS.minFreeMinutes.max}.`);
  }
  return placeSettings(dayStart, dayEnd, minFreeMinutes, date, timeZone);
}

function placeSettings(dayStart, dayEnd, minFreeMinutes, date, timeZone) {
  const dayStartMs = clockOnDate(date, dayStart, timeZone);
  const dayEndMs = clockOnDate(date, dayEnd, timeZone);
  if (dayStartMs === null || dayEndMs === null) fail('settings: dayStart or dayEnd does not exist in this time zone.');
  if (dayStartMs >= dayEndMs) fail('settings: dayStart is not before dayEnd after the local clock is applied.');
  return { dayStart, dayEnd, dayStartMs, dayEndMs, minFreeMinutes };
}

function readList(value, section, limit) {
  if (!Array.isArray(value)) fail(`day: ${section} must be a list.`);
  if (value.length > limit) fail(`${section}: ${value.length} items; the limit is ${limit}.`);
  return value;
}

function readEvents(value) {
  const events = readList(value, 'events', LIMITS.events);
  const seen = new Set();
  return events.map((event, index) => {
    const where = item('events', index);
    if (!plainObject(event)) fail(`${where}: expected an object.`);
    rejectUnknown(event, EVENT_FIELDS, where);
    const key = text(event.key, `${where}: key`);
    if (seen.has(key)) fail(`${where}: repeated key ${quoted(key)}.`);
    seen.add(key);
    // Event titles have no length cap. The 2 MB limit bounds them. Empty is
    // allowed: the calendar merge engine uses "" when an event has no SUMMARY.
    if (typeof event.title !== 'string') fail(`${where}: title must be text.`);
    if (typeof event.allDay !== 'boolean') fail(`${where}: allDay must be true or false.`);
    const calendar = text(event.calendar, `${where}: calendar`, { max: LIMITS.name });
    let location = null;
    if (event.location !== undefined && event.location !== null) {
      location = text(event.location, `${where}: location`, { max: LIMITS.name });
    }
    let status = 'confirmed';
    if (event.status !== undefined) {
      if (!STATUSES.has(event.status)) fail(`${where}: status must be confirmed, tentative or cancelled.`);
      status = event.status;
    }
    if (event.allDay) {
      const start = parseCivilDate(event.start);
      const end = parseCivilDate(event.end);
      if (!start) fail(`${where}: start must be a YYYY-MM-DD date.`);
      if (!end) fail(`${where}: end must be a YYYY-MM-DD date.`);
      if (end.text <= start.text) fail(`${where}: end must be after start.`);
      return {
        key, rawTitle: event.title, allDay: true, calendar, location, status,
        startText: start.text, endText: end.text, startMs: null, endMs: null,
      };
    }
    const startMs = parseInstant(event.start);
    const endMs = parseInstant(event.end);
    if (startMs === null) fail(`${where}: start must be an RFC 3339 instant with an offset or Z.`);
    if (endMs === null) fail(`${where}: end must be an RFC 3339 instant with an offset or Z.`);
    if (endMs < startMs) fail(`${where}: end must not be before start.`);
    return {
      key, rawTitle: event.title, allDay: false, calendar, location, status,
      startText: event.start, endText: event.end, startMs, endMs,
    };
  });
}

function readTasks(value, timeZone) {
  const tasks = readList(value, 'tasks', LIMITS.tasks);
  const seen = new Set();
  return tasks.map((task, index) => {
    const where = item('tasks', index);
    if (!plainObject(task)) fail(`${where}: expected an object.`);
    rejectUnknown(task, TASK_FIELDS, where);
    const id = text(task.id, `${where}: id`);
    if (seen.has(id)) fail(`${where}: repeated id ${quoted(id)}.`);
    seen.add(id);
    const title = text(task.title, `${where}: title`, { max: LIMITS.taskTitle });
    let due = null;
    if (task.due !== undefined) {
      const date = parseCivilDate(task.due);
      if (!date) fail(`${where}: due must be a real YYYY-MM-DD date.`);
      due = date.text;
    }
    let dueMs = null;
    let dueTime = null;
    if (task.dueTime !== undefined) {
      if (due === null) fail(`${where}: dueTime requires due.`);
      dueMs = parseInstant(task.dueTime);
      if (dueMs === null) fail(`${where}: dueTime must be an RFC 3339 instant with an offset or Z.`);
      const local = civilDate(dueMs, timeZone);
      if (local !== due) fail(`${where}: dueTime falls on ${local} in ${timeZone}, not ${due}.`);
      dueTime = task.dueTime;
    }
    let priority = null;
    if (task.priority !== undefined) {
      if (task.priority !== 'high') fail(`${where}: priority must be high.`);
      priority = 'high';
    }
    let list = null;
    if (task.list !== undefined) list = text(task.list, `${where}: list`, { max: LIMITS.name });
    return { id, title, due, dueTime, dueMs, priority, list };
  });
}

function readHabits(value) {
  const habits = readList(value, 'habits', LIMITS.habits);
  const seen = new Set();
  return habits.map((habit, index) => {
    const where = item('habits', index);
    if (!plainObject(habit)) fail(`${where}: expected an object.`);
    rejectUnknown(habit, HABIT_FIELDS, where);
    const id = text(habit.id, `${where}: id`);
    if (seen.has(id)) fail(`${where}: repeated id ${quoted(id)}.`);
    seen.add(id);
    const name = text(habit.name, `${where}: name`, { max: LIMITS.name });
    if (!STATES.has(habit.state)) fail(`${where}: state must be open, done or rest.`);
    return { id, name, state: habit.state };
  });
}

function readLists(value) {
  const lists = readList(value, 'lists', LIMITS.lists);
  const seen = new Set();
  return lists.map((list, index) => {
    const where = item('lists', index);
    if (!plainObject(list)) fail(`${where}: expected an object.`);
    rejectUnknown(list, LIST_FIELDS, where);
    const id = text(list.id, `${where}: id`);
    if (seen.has(id)) fail(`${where}: repeated id ${quoted(id)}.`);
    seen.add(id);
    const name = text(list.name, `${where}: name`, { max: LIMITS.name });
    if (!whole(list.open) || Object.is(list.open, -0) || list.open < LIMITS.listOpen.min || list.open > LIMITS.listOpen.max) {
      fail(`${where}: open must be a whole number from ${LIMITS.listOpen.min} to ${LIMITS.listOpen.max}.`);
    }
    return { id, name, open: list.open };
  });
}
