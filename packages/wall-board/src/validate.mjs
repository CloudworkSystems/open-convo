import { COLOR_NAMES } from './colors.mjs';
import { LIMITS, SCHEMA_VERSION, STALE_MS, fail } from './errors.mjs';
import { fitPage } from './layout.mjs';
import {
  civilDate,
  eventWhen,
  formatUpdated,
  isIanaTimeZone,
  parseCivilDate,
  parseInstant,
  parseLocal,
  taskClock,
  writtenDate,
} from './time.mjs';

const BOARD_FIELDS = new Set([
  'schemaVersion', 'title', 'date', 'timeZone', 'now', 'generatedAt', 'layout', 'people', 'lists', 'private',
]);
const LAYOUT_FIELDS = new Set(['size', 'theme']);
const PERSON_FIELDS = new Set(['id', 'name', 'color', 'calendars', 'sources', 'agenda', 'show']);
const SOURCE_FIELDS = new Set(['calendars', 'taskLists']);
const SOURCE_ITEM_FIELDS = new Set(['id', 'name']);
const LIST_FIELDS = new Set(['id', 'name', 'items', 'more']);
const AGENDA_FIELDS = new Set([
  'schemaVersion', 'date', 'timeZone', 'summary', 'nextUp', 'timeline', 'clashes', 'freeTime', 'tasks', 'habits', 'lists', 'counts',
]);
const EVENT_FIELDS = new Set([
  'key', 'title', 'allDay', 'calendar', 'location', 'status', 'start', 'end', 'startInstant', 'endInstant', 'startsBefore', 'endsAfter', 'noLength',
]);
const NEXT_FIELDS = new Set([...EVENT_FIELDS, 'minutesUntil']);
const NEXT_UP_FIELDS = new Set(['inProgress', 'next']);
const CLASH_FIELDS = new Set(['keys', 'start', 'end', 'startInstant', 'endInstant', 'minutes', 'tentative']);
const TASK_FIELDS = new Set(['id', 'title', 'due', 'dueTime', 'dueTimeLocal', 'priority', 'list', 'group']);
const HABIT_FIELDS = new Set(['id', 'name']);
const AGENDA_LIST_FIELDS = new Set(['id', 'name', 'open']);
const COUNT_FIELDS = new Set(['cancelledEvents', 'tasksNoDue', 'tasksOtherDates', 'habitsDone', 'habitsRest']);
const FREE_FIELDS = new Set(['start', 'end', 'startInstant', 'endInstant', 'minutes']);
const STATUSES = new Set(['confirmed', 'tentative', 'cancelled']);
const SIZES = new Set(['1080p', '4k']);
const THEMES = new Set(['light', 'dark']);
const SHOW_KINDS = new Set(['list', 'task', 'habit']);

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function quoted(value) {
  if (value === undefined) return 'missing';
  return JSON.stringify(value).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function rejectUnknown(object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(`${where}: unknown field ${quoted(key)}.`);
  }
}

function whole(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  return typeof value === 'number' && Number.isInteger(value) && !Object.is(value, -0)
    && value >= min && value <= max;
}

function text(value, where, { min = 1, max = LIMITS.name } = {}) {
  if (value === undefined) fail(`${where} is missing.`);
  if (typeof value !== 'string') fail(`${where} must be text.`);
  if (value.length < min) fail(`${where} must be at least ${min} character.`);
  if (value.length > max) fail(`${where} must be at most ${max} characters.`);
  return value;
}

function item(section, index) {
  return `${section}, item ${index + 1}`;
}

function readObject(value, where) {
  if (!plainObject(value)) fail(`${where} must be an object.`);
  return value;
}

function readArray(value, where, { min = 0, max = Infinity } = {}) {
  if (!Array.isArray(value)) fail(`${where} must be a list.`);
  if (value.length < min) fail(`${where}: ${value.length} items; at least ${min} ${min === 1 ? 'is' : 'are'} required.`);
  if (value.length > max) fail(`${where}: ${value.length} items; the limit is ${max}.`);
  return value;
}

export function readBoard(board) {
  if (!plainObject(board)) fail('board: the board must be a JSON object.');
  let encoded;
  try {
    encoded = JSON.stringify(board);
  } catch {
    fail('board: the board must be a JSON object.');
  }
  if (typeof encoded !== 'string') fail('board: the board must be a JSON object.');
  const bytes = Buffer.byteLength(encoded);
  if (bytes > LIMITS.fileBytes) {
    fail(`board: the board is ${bytes} bytes; the limit is ${LIMITS.fileBytes} bytes (2 MB).`);
  }
  rejectUnknown(board, BOARD_FIELDS, 'board');
  if (!Object.is(board.schemaVersion, SCHEMA_VERSION)) fail('board: schemaVersion must be 1.');
  const title = text(board.title, 'board: title', { max: LIMITS.title });
  const date = parseCivilDate(board.date);
  if (!date) fail('board: date must be a real YYYY-MM-DD date.');
  if (!isIanaTimeZone(board.timeZone)) fail('board: timeZone must be an IANA time zone.');
  const nowMs = parseInstant(board.now);
  if (nowMs === null) fail('board: now must be an RFC 3339 instant with an offset or Z.');
  const generatedMs = parseInstant(board.generatedAt);
  if (generatedMs === null) fail('board: generatedAt must be an RFC 3339 instant with an offset or Z.');
  const layout = readLayout(board.layout);
  const people = readPeople(board.people, date.text, board.timeZone);
  const lists = readLists(board.lists);
  const privateKeys = readPrivate(board.private, people);

  const age = nowMs - generatedMs;
  const stale = age > STALE_MS;
  const today = civilDate(nowMs, board.timeZone);
  const yesterday = today !== '' && today > date.text;
  const updatedClock = formatUpdated(generatedMs, board.timeZone);
  const warnings = [];
  if (stale) warnings.push(`Not updated since ${updatedClock}.`);
  for (const rule of privateKeys.unmatched) {
    warnings.push(`${item('private', rule.index)}: no event today has the key ${quoted(rule.key)}.`);
  }

  const projected = people.map(person => projectPerson(person, privateKeys.keys, date.text));
  const fitted = fitPage({
    size: layout.size,
    title,
    writtenDate: writtenDate(date.text),
    updatedClock,
    stale,
    yesterday,
    people: projected,
    lists,
  });
  return {
    title,
    writtenDate: writtenDate(date.text),
    updatedClock,
    stale,
    yesterday,
    size: layout.size,
    theme: layout.theme,
    people: fitted.people,
    lists: fitted.lists,
    warnings,
    counts: countsFor(fitted.people, fitted.lists, layout),
  };
}

function readLayout(layout) {
  if (layout === undefined) fail('board: layout is missing.');
  readObject(layout, 'layout');
  rejectUnknown(layout, LAYOUT_FIELDS, 'layout');
  if (!SIZES.has(layout.size)) fail('layout: size must be 1080p or 4k.');
  if (!THEMES.has(layout.theme)) fail('layout: theme must be light or dark.');
  return { size: layout.size, theme: layout.theme };
}

function readPeople(value, date, timeZone) {
  if (value === undefined) fail('board: people is missing.');
  const people = readArray(value, 'people', LIMITS.people);
  const ids = new Set();
  const colors = new Map();
  return people.map((person, index) => {
    const where = item('people', index);
    readObject(person, where);
    rejectUnknown(person, PERSON_FIELDS, where);
    const id = text(person.id, `${where}: id`, { max: LIMITS.id });
    if (ids.has(id)) fail(`${where}: repeated id ${quoted(id)}.`);
    ids.add(id);
    const name = text(person.name, `${where}: name`, { max: LIMITS.name });
    if (typeof person.color !== 'string' || !COLOR_NAMES.includes(person.color)) {
      fail(`${where}: color must be one of ${COLOR_NAMES.join(', ')}.`);
    }
    if (colors.has(person.color)) {
      const usedBy = colors.get(person.color).replace(/[\r\n\u2028\u2029]/g, ' ');
      fail(`${where}: the color ${person.color} is already used by ${usedBy}.`);
    }
    colors.set(person.color, name);
    const sources = readSources(person.sources, where);
    const calendars = readShare(person.calendars, sources.calendarIds, where);
    const agenda = readAgenda(person.agenda, date, timeZone, where);
    checkAgendaSources(agenda, sources, where);
    const show = readShow(person.show, sources, agenda, where);
    return { id, name, color: person.color, calendars, sources, agenda, show, date };
  });
}

function readSources(value, where) {
  if (value === undefined) fail(`${where}: sources is missing.`);
  const sources = readObject(value, `${where}: sources`);
  rejectUnknown(sources, SOURCE_FIELDS, `${where}: sources`);
  const calendars = readSourceList(sources.calendars, `${where}: sources.calendars`);
  const taskLists = readSourceList(sources.taskLists, `${where}: sources.taskLists`);
  return {
    calendars,
    taskLists,
    calendarIds: new Map(calendars.map(source => [source.id, source])),
    calendarNames: new Map(calendars.map(source => [source.name, source])),
    taskListNames: new Map(taskLists.map(source => [source.name, source])),
    taskListIds: new Map(taskLists.map(source => [source.id, source])),
  };
}

function readSourceList(value, where) {
  if (value === undefined) fail(`${where} is missing.`);
  const list = readArray(value, where, { max: LIMITS.sources });
  const ids = new Set();
  const names = new Set();
  return list.map((source, index) => {
    const at = item(where, index);
    readObject(source, at);
    rejectUnknown(source, SOURCE_ITEM_FIELDS, at);
    const id = text(source.id, `${at}: id`, { max: LIMITS.id });
    const name = text(source.name, `${at}: name`, { max: LIMITS.name });
    if (ids.has(id)) fail(`${at}: repeated id ${quoted(id)}.`);
    if (names.has(name)) fail(`${at}: the name ${quoted(name)} is already used.`);
    ids.add(id);
    names.add(name);
    return { id, name };
  });
}

function readShare(value, knownIds, where) {
  if (value === undefined) fail(`${where}: calendars is missing.`);
  const list = readArray(value, `${where}: calendars`, { max: LIMITS.sources });
  const seen = new Set();
  return list.map((id, index) => {
    const at = `${where}: calendars, item ${index + 1}`;
    const token = text(id, at, { max: LIMITS.id });
    if (seen.has(token)) fail(`${at}: repeated id ${quoted(token)}.`);
    seen.add(token);
    if (!knownIds.has(token)) fail(`${at}: ${quoted(token)} is not a source calendar.`);
    return token;
  });
}

function readShow(value, sources, agenda, where) {
  if (value === undefined) return null;
  const list = readArray(value, `${where}: show`, { max: LIMITS.showRules });
  const seen = new Set();
  const taskIds = new Set(agenda.tasks.map(task => task.id));
  const habitIds = new Set(agenda.habits.map(habit => habit.id));
  const listIdsInUse = new Set();
  for (const task of agenda.tasks) {
    if (task.list === null) continue;
    const source = sources.taskListNames.get(task.list);
    if (source) listIdsInUse.add(source.id);
  }
  const rules = list.map((rule, index) => {
    const at = `${where}: show, item ${index + 1}`;
    const token = text(rule, at, { max: LIMITS.key });
    if (seen.has(token)) fail(`${at}: repeated rule ${quoted(token)}.`);
    seen.add(token);
    const split = splitRule(token, SHOW_KINDS, at);
    if (split.kind === 'list') {
      if (!sources.taskListIds.has(split.value) || !listIdsInUse.has(split.value)) {
        fail(`${at}: list ${quoted(split.value)} names nothing on this day.`);
      }
    } else if (split.kind === 'task') {
      if (!taskIds.has(split.value)) fail(`${at}: task ${quoted(split.value)} names nothing on this day.`);
    } else if (!habitIds.has(split.value)) {
      fail(`${at}: habit ${quoted(split.value)} names nothing on this day.`);
    }
    return split;
  });
  return rules;
}

function splitRule(token, kinds, where) {
  const mark = token.indexOf(':');
  if (mark < 1) fail(`${where}: expected list:, task: or habit:.`);
  const kind = token.slice(0, mark);
  const value = token.slice(mark + 1);
  if (!kinds.has(kind) || value.length === 0) fail(`${where}: expected list:, task: or habit:.`);
  return { kind, value };
}

function checkAgendaSources(agenda, sources, where) {
  agenda.timeline.forEach((event, index) => {
    if (!sources.calendarNames.has(event.calendar)) {
      fail(`${where}: agenda timeline, item ${index + 1}: calendar ${quoted(event.calendar)} is not in sources.`);
    }
  });
  agenda.tasks.forEach((task, index) => {
    if (task.list === null) return;
    if (!sources.taskListNames.has(task.list)) {
      fail(`${where}: agenda tasks, item ${index + 1}: list ${quoted(task.list)} is not in sources.`);
    }
  });
}

function readPrivate(value, people) {
  const keys = new Set();
  const unmatched = [];
  if (value === undefined) return { keys, unmatched };
  const list = readArray(value, 'private', { max: LIMITS.privateRules });
  const seen = new Set();
  const present = new Set();
  for (const person of people) {
    for (const event of person.agenda.timeline) present.add(event.key);
  }
  list.forEach((rule, index) => {
    const at = item('private', index);
    const token = text(rule, at, { max: LIMITS.key + 4 });
    if (!token.startsWith('key:')) fail(`${at}: expected a key: rule.`);
    const key = token.slice(4);
    if (key.length === 0) fail(`${at}: expected a key: rule.`);
    if (seen.has(key)) fail(`${at}: repeated key ${quoted(key)}.`);
    seen.add(key);
    keys.add(key);
    if (!present.has(key)) unmatched.push({ index, key });
  });
  return { keys, unmatched };
}

function readLists(value) {
  if (value === undefined) fail('board: lists is missing.');
  const lists = readArray(value, 'lists', { max: LIMITS.lists.max });
  const ids = new Set();
  return lists.map((list, index) => {
    const where = item('lists', index);
    readObject(list, where);
    rejectUnknown(list, LIST_FIELDS, where);
    const id = text(list.id, `${where}: id`, { max: LIMITS.id });
    if (ids.has(id)) fail(`${where}: repeated id ${quoted(id)}.`);
    ids.add(id);
    const name = text(list.name, `${where}: name`, { max: LIMITS.name });
    const items = readArray(list.items, `${where}: items`, { max: LIMITS.listItems });
    const shown = items.map((entry, itemIndex) => text(entry, `${where}: items, item ${itemIndex + 1}`, { max: LIMITS.item }));
    if (!whole(list.more, { max: LIMITS.more })) {
      fail(`${where}: more must be a whole number from 0 to ${LIMITS.more}.`);
    }
    return { id, name, items: shown, more: list.more };
  });
}

function readAgenda(value, date, timeZone, where) {
  if (value === undefined) fail(`${where}: agenda is missing.`);
  const agenda = readObject(value, `${where}: agenda`);
  rejectUnknown(agenda, AGENDA_FIELDS, `${where}: agenda`);
  if (!Object.is(agenda.schemaVersion, SCHEMA_VERSION)) fail(`${where}: agenda schemaVersion must be 1.`);
  if (agenda.date !== date) fail(`${where}: the agenda date is ${quoted(agenda.date)}, not ${date}.`);
  if (agenda.timeZone !== timeZone) fail(`${where}: the agenda time zone is ${quoted(agenda.timeZone)}, not ${timeZone}.`);
  readSummary(agenda.summary, where);
  readNextUp(agenda.nextUp, where);
  const timeline = readTimeline(agenda.timeline, where);
  const clashes = readClashes(agenda.clashes, timeline, where);
  readFreeTime(agenda.freeTime, where);
  const tasks = readTasks(agenda.tasks, where);
  const habits = readHabits(agenda.habits, where);
  readAgendaLists(agenda.lists, where);
  readCounts(agenda.counts, where);
  return { timeline, clashes, tasks, habits };
}

function readSummary(value, where) {
  const summary = readArray(value, `${where}: agenda summary`, { max: LIMITS.summary });
  summary.forEach((line, index) => {
    // One sentence can name every list, so the cap is the file, not a short line.
    text(line, `${where}: agenda summary, item ${index + 1}`, { min: 1, max: LIMITS.fileBytes });
  });
}

function readNextUp(value, where) {
  const nextUp = readObject(value, `${where}: agenda nextUp`);
  rejectUnknown(nextUp, NEXT_UP_FIELDS, `${where}: agenda nextUp`);
  const rows = readArray(nextUp.inProgress, `${where}: agenda nextUp inProgress`, { max: LIMITS.timeline });
  rows.forEach((event, index) => readEvent(event, `${where}: agenda nextUp inProgress, item ${index + 1}`, EVENT_FIELDS));
  if (nextUp.next === null) return;
  readEvent(nextUp.next, `${where}: agenda nextUp next`, NEXT_FIELDS);
  if (!whole(nextUp.next.minutesUntil, { max: Number.MAX_SAFE_INTEGER })) {
    fail(`${where}: agenda nextUp next minutesUntil must be a whole number.`);
  }
}

function readTimeline(value, where) {
  const rows = readArray(value, `${where}: agenda timeline`, { max: LIMITS.timeline });
  const seen = new Set();
  return rows.map((event, index) => {
    const at = `${where}: agenda timeline, item ${index + 1}`;
    const read = readEvent(event, at, EVENT_FIELDS);
    if (seen.has(read.key)) fail(`${at}: repeated key ${quoted(read.key)}.`);
    seen.add(read.key);
    if (read.allDay) {
      if (!parseCivilDate(read.start)) fail(`${at}: start must be a YYYY-MM-DD date.`);
      if (!parseCivilDate(read.end)) fail(`${at}: end must be a YYYY-MM-DD date.`);
    } else if (!parseLocal(read.start) || !parseLocal(read.end)) {
      fail(`${at}: start and end must be local date-times.`);
    }
    return read;
  });
}

function readEvent(event, where, allowed) {
  readObject(event, where);
  rejectUnknown(event, allowed, where);
  const key = text(event.key, `${where}: key`, { max: LIMITS.key });
  if (typeof event.title !== 'string') fail(`${where}: title must be text.`);
  if (typeof event.allDay !== 'boolean') fail(`${where}: allDay must be true or false.`);
  const calendar = text(event.calendar, `${where}: calendar`, { max: LIMITS.name });
  let location = null;
  if (event.location !== null) {
    location = text(event.location, `${where}: location`, { max: LIMITS.name });
  }
  if (!STATUSES.has(event.status)) fail(`${where}: status must be confirmed, tentative or cancelled.`);
  if (typeof event.start !== 'string' || typeof event.end !== 'string') fail(`${where}: start and end must be text.`);
  if (event.startInstant !== null && typeof event.startInstant !== 'string') fail(`${where}: startInstant must be text or null.`);
  if (event.endInstant !== null && typeof event.endInstant !== 'string') fail(`${where}: endInstant must be text or null.`);
  if (typeof event.startsBefore !== 'boolean' || typeof event.endsAfter !== 'boolean' || typeof event.noLength !== 'boolean') {
    fail(`${where}: startsBefore, endsAfter and noLength must be true or false.`);
  }
  return {
    key,
    title: event.title,
    allDay: event.allDay,
    calendar,
    location,
    status: event.status,
    start: event.start,
    end: event.end,
    startsBefore: event.startsBefore,
    endsAfter: event.endsAfter,
    noLength: event.noLength,
  };
}

function readClashes(value, timeline, where) {
  const rows = readArray(value, `${where}: agenda clashes`, { max: LIMITS.clashes });
  const keys = new Set(timeline.map(event => event.key));
  const marked = new Set();
  rows.forEach((clash, index) => {
    const at = `${where}: agenda clashes, item ${index + 1}`;
    readObject(clash, at);
    rejectUnknown(clash, CLASH_FIELDS, at);
    if (!Array.isArray(clash.keys) || clash.keys.length !== 2) fail(`${at}: keys must be two event keys.`);
    for (const key of clash.keys) {
      if (typeof key !== 'string' || !keys.has(key)) fail(`${at}: unknown event key ${quoted(key)}.`);
      marked.add(key);
    }
    if (typeof clash.start !== 'string' || typeof clash.end !== 'string') fail(`${at}: start and end must be text.`);
    if (typeof clash.startInstant !== 'string' || typeof clash.endInstant !== 'string') {
      fail(`${at}: startInstant and endInstant must be text.`);
    }
    if (!whole(clash.minutes, { min: 1 })) fail(`${at}: minutes must be a whole number of at least 1.`);
    if (typeof clash.tentative !== 'boolean') fail(`${at}: tentative must be true or false.`);
  });
  return marked;
}

function readFreeTime(value, where) {
  const rows = readArray(value, `${where}: agenda freeTime`, { max: LIMITS.freeTime });
  rows.forEach((gap, index) => {
    const at = `${where}: agenda freeTime, item ${index + 1}`;
    readObject(gap, at);
    rejectUnknown(gap, FREE_FIELDS, at);
    if (typeof gap.start !== 'string' || typeof gap.end !== 'string') fail(`${at}: start and end must be text.`);
    if (typeof gap.startInstant !== 'string' || typeof gap.endInstant !== 'string') {
      fail(`${at}: startInstant and endInstant must be text.`);
    }
    if (!whole(gap.minutes)) fail(`${at}: minutes must be a whole number.`);
  });
}

function readTasks(value, where) {
  const rows = readArray(value, `${where}: agenda tasks`, { max: LIMITS.tasks });
  const seen = new Set();
  return rows.map((task, index) => {
    const at = `${where}: agenda tasks, item ${index + 1}`;
    readObject(task, at);
    rejectUnknown(task, TASK_FIELDS, at);
    const id = text(task.id, `${at}: id`, { max: LIMITS.id });
    if (seen.has(id)) fail(`${at}: repeated id ${quoted(id)}.`);
    seen.add(id);
    const title = text(task.title, `${at}: title`, { max: 500 });
    if (!parseCivilDate(task.due)) fail(`${at}: due must be a real YYYY-MM-DD date.`);
    if (task.dueTime !== null && typeof task.dueTime !== 'string') fail(`${at}: dueTime must be text or null.`);
    if (task.dueTimeLocal !== null && typeof task.dueTimeLocal !== 'string') fail(`${at}: dueTimeLocal must be text or null.`);
    if (task.dueTimeLocal !== null && taskClock(task.dueTimeLocal) === null) {
      fail(`${at}: dueTimeLocal must be HH:MM or HH:MM:SS.`);
    }
    if (task.priority !== null && task.priority !== 'high') fail(`${at}: priority must be high or null.`);
    let list = null;
    if (task.list !== null) list = text(task.list, `${at}: list`, { max: LIMITS.name });
    if (task.group !== 'overdue' && task.group !== 'today') fail(`${at}: group must be overdue or today.`);
    return { id, title, list, group: task.group, priority: task.priority, dueTimeLocal: task.dueTimeLocal };
  });
}

function readHabits(value, where) {
  const rows = readArray(value, `${where}: agenda habits`, { max: LIMITS.habits });
  const seen = new Set();
  return rows.map((habit, index) => {
    const at = `${where}: agenda habits, item ${index + 1}`;
    readObject(habit, at);
    rejectUnknown(habit, HABIT_FIELDS, at);
    const id = text(habit.id, `${at}: id`, { max: LIMITS.id });
    if (seen.has(id)) fail(`${at}: repeated id ${quoted(id)}.`);
    seen.add(id);
    const name = text(habit.name, `${at}: name`, { max: LIMITS.name });
    return { id, name };
  });
}

function readAgendaLists(value, where) {
  const rows = readArray(value, `${where}: agenda lists`, { max: LIMITS.agendaLists });
  rows.forEach((list, index) => {
    const at = `${where}: agenda lists, item ${index + 1}`;
    readObject(list, at);
    rejectUnknown(list, AGENDA_LIST_FIELDS, at);
    text(list.id, `${at}: id`, { max: LIMITS.id });
    text(list.name, `${at}: name`, { max: LIMITS.name });
    if (!whole(list.open, { max: 10000 })) fail(`${at}: open must be a whole number from 0 to 10000.`);
  });
}

function readCounts(value, where) {
  const counts = readObject(value, `${where}: agenda counts`);
  rejectUnknown(counts, COUNT_FIELDS, `${where}: agenda counts`);
  for (const field of COUNT_FIELDS) {
    if (!whole(counts[field], { max: LIMITS.tasks })) {
      fail(`${where}: agenda counts ${field} must be a whole number.`);
    }
  }
}

function projectPerson(person, privateKeys, boardDate) {
  const share = new Set(person.calendars);
  const allDay = [];
  const timed = [];
  for (const event of person.agenda.timeline) {
    const source = person.sources.calendarNames.get(event.calendar);
    const hidden = privateKeys.has(event.key) || !share.has(source.id);
    // A hidden event keeps its time and drops the title and place here, so
    // the page builder never receives the private text.
    const view = {
      allDay: event.allDay,
      when: eventWhen(event, boardDate),
      overlaps: person.agenda.clashes.has(event.key),
      tentative: event.status === 'tentative',
      cancelled: event.status === 'cancelled',
      busy: hidden,
    };
    if (!hidden) {
      view.title = event.title;
      if (event.location) view.where = event.location;
    }
    if (event.allDay) allDay.push(view);
    else timed.push(view);
  }
  const dated = [...allDay, ...timed];
  const taskRules = taskRuleSets(person);
  const sharedTasks = [];
  let tasksHidden = 0;
  for (const task of person.agenda.tasks) {
    if (taskShown(task, person, taskRules)) {
      const label = taskLabel(task);
      sharedTasks.push({ title: task.title, label });
    } else {
      tasksHidden += 1;
    }
  }
  const habitRules = new Set(
    (person.show ?? []).filter(rule => rule.kind === 'habit').map(rule => rule.value),
  );
  const sharedHabits = [];
  let habitsHidden = 0;
  for (const habit of person.agenda.habits) {
    if (person.show !== null && habitRules.has(habit.id)) sharedHabits.push({ name: habit.name });
    else habitsHidden += 1;
  }
  const empty = person.agenda.timeline.length === 0
    && person.agenda.tasks.length === 0
    && person.agenda.habits.length === 0;
  return {
    id: person.id,
    name: person.name,
    color: person.color,
    events: dated,
    eventsCut: 0,
    tasks: sharedTasks,
    tasksCut: 0,
    habits: sharedHabits,
    habitsCut: 0,
    tasksHidden,
    habitsHidden,
    empty,
  };
}

function taskRuleSets(person) {
  const lists = new Set();
  const tasks = new Set();
  for (const rule of person.show ?? []) {
    if (rule.kind === 'list') lists.add(rule.value);
    else if (rule.kind === 'task') tasks.add(rule.value);
  }
  return { lists, tasks };
}

function taskShown(task, person, rules) {
  if (person.show === null) return false;
  if (rules.tasks.has(task.id)) return true;
  if (task.list === null) return false;
  const source = person.sources.taskListNames.get(task.list);
  return source !== undefined && rules.lists.has(source.id);
}

function taskLabel(task) {
  const parts = [task.group === 'overdue' ? 'Overdue' : 'Today'];
  const clock = taskClock(task.dueTimeLocal);
  if (clock) parts.push(clock);
  if (task.priority === 'high') parts.push('High');
  return parts.join(' · ');
}

function countsFor(people, lists, layout) {
  return {
    size: layout.size,
    theme: layout.theme,
    people: people.map(person => ({
      id: person.id,
      name: person.name,
      eventsShown: person.events.length,
      eventsCut: person.eventsCut,
      busyShown: person.events.filter(event => event.busy).length,
      tasksShown: person.tasks.length,
      tasksCut: person.tasksCut,
      tasksHidden: person.tasksHidden,
      habitsShown: person.habits.length,
      habitsCut: person.habitsCut,
      habitsHidden: person.habitsHidden,
    })),
    listsShown: lists.length,
    listItemsShown: lists.reduce((sum, list) => sum + list.items.length, 0),
    listItemsMore: lists.reduce((sum, list) => sum + list.more, 0),
  };
}
