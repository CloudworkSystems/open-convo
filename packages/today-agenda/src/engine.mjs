import { SCHEMA_VERSION, fail } from './errors.mjs';
import { civilDate, formatInstant, localDateTime, startOfCivilDay, wallClock } from './time.mjs';
import { validateDay } from './validate.mjs';

function lex(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function displayTitle(title) {
  return title === '' ? '(No title)' : title;
}

// The same day always builds the same agenda. Nothing here reads the clock,
// the machine zone, a locale or a random source. Sections are sorted before
// they are turned into output.
export function buildAgenda(day) {
  const input = validateDay(day);
  const nowDate = civilDate(input.nowMs, input.timeZone);
  const timeline = buildTimeline(input);
  const clashes = buildClashes(timeline, input.timeZone);
  const freeTime = buildFreeTime(input, timeline);
  const tasks = buildTasks(input, nowDate);
  const habits = buildHabits(input);
  const lists = buildLists(input);
  const nextUp = buildNextUp(timeline, input.nowMs);
  const summary = [
    eventSentence(timeline),
    clashSentence(clashes),
    freeSentence(freeTime),
    taskSentence(tasks.rows),
    habitSentence(habits.open.length),
    listSentence(lists),
  ].filter(sentence => sentence !== null);

  return {
    schemaVersion: SCHEMA_VERSION,
    date: input.date,
    timeZone: input.timeZone,
    summary,
    nextUp,
    timeline: timeline.map(entry => entry.view),
    clashes: clashes.map(clash => clash.view),
    freeTime,
    tasks: tasks.rows,
    habits: habits.open,
    lists,
    counts: {
      cancelledEvents: timeline.cancelledEvents,
      tasksNoDue: tasks.tasksNoDue,
      tasksOtherDates: tasks.tasksOtherDates,
      habitsDone: habits.habitsDone,
      habitsRest: habits.habitsRest,
    },
  };
}

function buildTimeline(input) {
  let cancelledEvents = 0;
  const todays = [];
  for (const event of input.events) {
    const onDay = event.allDay
      ? event.startText <= input.date && input.date < event.endText
      : event.startMs === event.endMs
        ? event.startMs >= input.civilStartMs && event.startMs < input.civilEndMs
        : event.startMs < input.civilEndMs && event.endMs > input.civilStartMs;
    if (!onDay) continue;
    if (event.status === 'cancelled') {
      cancelledEvents += 1;
      continue;
    }
    todays.push(event);
  }

  const allDay = todays.filter(event => event.allDay)
    .sort((a, b) => lex(a.rawTitle, b.rawTitle) || lex(a.key, b.key));
  const timed = todays.filter(event => !event.allDay)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || lex(a.rawTitle, b.rawTitle) || lex(a.key, b.key));

  const entries = [...allDay, ...timed].map(event => toEntry(event, input));
  entries.cancelledEvents = cancelledEvents;
  return entries;
}

function toEntry(event, input) {
  const noLength = !event.allDay && event.startMs === event.endMs;
  const startsBefore = !event.allDay && event.startMs < input.civilStartMs;
  const endsAfter = !event.allDay && event.endMs > input.civilEndMs;
  const view = {
    key: event.key,
    title: displayTitle(event.rawTitle),
    allDay: event.allDay,
    calendar: event.calendar,
    location: event.location,
    status: event.status,
    start: event.allDay ? event.startText : localDateTime(event.startMs, input.timeZone),
    end: event.allDay ? event.endText : localDateTime(event.endMs, input.timeZone),
    startInstant: event.allDay ? null : event.startText,
    endInstant: event.allDay ? null : event.endText,
    startsBefore,
    endsAfter,
    noLength,
  };
  return { event, view, startsBefore };
}

function buildClashes(timeline, timeZone) {
  const timed = timeline.filter(entry => !entry.view.allDay && !entry.view.noLength);
  const clashes = [];
  for (let i = 0; i < timed.length; i += 1) {
    const left = timed[i];
    for (let j = i + 1; j < timed.length; j += 1) {
      const right = timed[j];
      if (right.event.startMs >= left.event.endMs) break;
      // Two tentative events are not a clash. A tentative event clashing
      // with a confirmed one is marked tentative.
      if (left.view.status === 'tentative' && right.view.status === 'tentative') continue;
      const start = Math.max(left.event.startMs, right.event.startMs);
      const end = Math.min(left.event.endMs, right.event.endMs);
      if (end - start < 60_000) continue;
      clashes.push({
        view: {
          keys: [left.view.key, right.view.key],
          start: localDateTime(start, timeZone),
          end: localDateTime(end, timeZone),
          startInstant: formatInstant(start),
          endInstant: formatInstant(end),
          minutes: Math.floor((end - start) / 60_000),
          tentative: left.view.status === 'tentative' || right.view.status === 'tentative',
        },
      });
    }
  }
  return clashes;
}

function buildFreeTime(input, timeline) {
  const nowOnDate = civilDate(input.nowMs, input.timeZone) === input.date;
  const windowStart = nowOnDate ? Math.max(input.dayStartMs, input.nowMs) : input.dayStartMs;
  const windowEnd = input.dayEndMs;
  if (windowStart >= windowEnd) return [];

  const intervals = [];
  for (const entry of timeline) {
    if (entry.view.allDay || entry.view.noLength) continue;
    const start = Math.max(entry.event.startMs, windowStart);
    const end = Math.min(entry.event.endMs, windowEnd);
    if (start < end) intervals.push({ start, end });
  }
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (!last || interval.start > last.end) merged.push({ start: interval.start, end: interval.end });
    else if (interval.end > last.end) last.end = interval.end;
  }

  const gaps = [];
  let cursor = windowStart;
  const minimum = input.minFreeMinutes * 60_000;
  for (const interval of merged) {
    if (interval.start - cursor >= minimum) gaps.push({ start: cursor, end: interval.start });
    if (interval.end > cursor) cursor = interval.end;
  }
  if (windowEnd - cursor >= minimum) gaps.push({ start: cursor, end: windowEnd });

  return gaps.map(gap => ({
    start: wallClock(gap.start, input.timeZone),
    end: wallClock(gap.end, input.timeZone),
    startInstant: formatInstant(gap.start),
    endInstant: formatInstant(gap.end),
    minutes: Math.floor((gap.end - gap.start) / 60_000),
  }));
}

function buildTasks(input, nowDate) {
  let tasksNoDue = 0;
  let tasksOtherDates = 0;
  const rows = [];
  for (const task of input.tasks) {
    if (task.due === null) {
      tasksNoDue += 1;
      continue;
    }
    const overdue = task.dueMs !== null ? task.dueMs < input.nowMs : task.due < nowDate;
    const dueToday = !overdue && task.due === input.date;
    if (!overdue && !dueToday) {
      tasksOtherDates += 1;
      continue;
    }
    const dueMoment = task.dueMs !== null ? task.dueMs : startOfCivilDay(task.due, input.timeZone);
    if (dueMoment === null) fail(`tasks: due date ${task.due} does not exist in ${input.timeZone}.`);
    rows.push({
      id: task.id,
      title: task.title,
      due: task.due,
      dueTime: task.dueTime,
      dueTimeLocal: task.dueMs === null ? null : wallClock(task.dueMs, input.timeZone),
      priority: task.priority,
      list: task.list,
      group: overdue ? 'overdue' : 'today',
      dueMoment,
    });
  }
  // Within a group the earlier due moment comes first. High priority is the
  // next key, then title, then id. Untimed tasks share the start of `date`.
  rows.sort((a, b) => {
    const group = groupRank(a) - groupRank(b);
    if (group) return group;
    if (a.dueMoment !== b.dueMoment) return a.dueMoment < b.dueMoment ? -1 : 1;
    const priority = priorityRank(a) - priorityRank(b);
    if (priority) return priority;
    return lex(a.title, b.title) || lex(a.id, b.id);
  });
  return {
    tasksNoDue,
    tasksOtherDates,
    rows: rows.map(task => ({
      id: task.id,
      title: task.title,
      due: task.due,
      dueTime: task.dueTime,
      dueTimeLocal: task.dueTimeLocal,
      priority: task.priority,
      list: task.list,
      group: task.group,
    })),
  };
}

function groupRank(task) {
  if (task.group === 'overdue') return 0;
  if (task.dueTime !== null) return 1;
  return 2;
}

function priorityRank(task) {
  return task.priority === 'high' ? 0 : 1;
}

function buildHabits(input) {
  let habitsDone = 0;
  let habitsRest = 0;
  const open = [];
  for (const habit of input.habits) {
    if (habit.state === 'done') habitsDone += 1;
    else if (habit.state === 'rest') habitsRest += 1;
    else open.push({ id: habit.id, name: habit.name });
  }
  open.sort((a, b) => lex(a.name, b.name) || lex(a.id, b.id));
  return { open, habitsDone, habitsRest };
}

function buildLists(input) {
  return input.lists
    .filter(list => list.open > 0)
    .sort((a, b) => b.open - a.open || lex(a.name, b.name) || lex(a.id, b.id))
    .map(list => ({ id: list.id, name: list.name, open: list.open }));
}

function buildNextUp(timeline, nowMs) {
  const timed = timeline.filter(entry => !entry.view.allDay);
  const inProgress = timed
    .filter(entry => !entry.view.noLength && entry.event.startMs <= nowMs && nowMs < entry.event.endMs)
    .map(entry => ({ ...entry.view }));
  const nextEntry = timed.find(entry => entry.event.startMs > nowMs) ?? null;
  return {
    inProgress,
    next: nextEntry === null ? null : {
      ...nextEntry.view,
      minutesUntil: Math.floor((nextEntry.event.startMs - nowMs) / 60_000),
    },
  };
}

function eventSentence(timeline) {
  if (timeline.length === 0) return null;
  const noun = timeline.length === 1 ? 'event' : 'events';
  const first = timeline.find(entry => !entry.view.allDay && !entry.startsBefore);
  if (!first) return `You have ${timeline.length} ${noun} today.`;
  return `You have ${timeline.length} ${noun} today, starting at ${first.view.start.slice(11)}.`;
}

function clashSentence(clashes) {
  if (clashes.length === 0) return null;
  const time = clashes[0].view.start.slice(11);
  if (clashes.length === 1) return `2 events overlap at ${time}.`;
  return `There are ${clashes.length} overlaps, the first at ${time}.`;
}

function freeSentence(freeTime) {
  if (freeTime.length === 0) return null;
  let best = freeTime[0];
  for (const gap of freeTime) {
    if (gap.minutes > best.minutes) best = gap;
  }
  return `Your longest free stretch is ${best.start} to ${best.end}.`;
}

function taskSentence(tasks) {
  const overdue = tasks.filter(task => task.group === 'overdue').length;
  const today = tasks.length - overdue;
  if (overdue === 0 && today === 0) return null;
  if (overdue > 0 && today > 0) {
    const overdueText = overdue === 1 ? '1 task is overdue' : `${overdue} tasks are overdue`;
    const todayText = today === 1 ? '1 is due today' : `${today} are due today`;
    return `${overdueText} and ${todayText}.`;
  }
  if (overdue === 1) return '1 task is overdue.';
  if (overdue > 1) return `${overdue} tasks are overdue.`;
  if (today === 1) return '1 task is due today.';
  return `${today} tasks are due today.`;
}

function habitSentence(count) {
  if (count === 0) return null;
  if (count === 1) return '1 habit is still open.';
  return `${count} habits are still open.`;
}

function listSentence(lists) {
  if (lists.length === 0) return null;
  const clauses = lists.map(list => `${list.name} has ${list.open} ${list.open === 1 ? 'item' : 'items'}`);
  if (clauses.length === 1) return `${clauses[0]}.`;
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}.`;
  return `${clauses.slice(0, -1).join(', ')} and ${clauses.at(-1)}.`;
}
