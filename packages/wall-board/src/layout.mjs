import { plain } from './text.mjs';

// One vertical budget for the whole screen. The CSS in render.mjs is built
// from these numbers, so a row the fitter keeps is a row the page can show.
// A character is charged a full em. The Linux fallback sans paints "W" a
// little under that, so a line is never counted shorter than it will be.

export const GEOMETRY = Object.freeze({
  '1080p': Object.freeze({
    width: 1920,
    height: 1080,
    padTop: 16,
    padBottom: 12,
    padX: 20,
    gap: 12,
    headerGap: 2,
    personGap: 8,
    text: 26,
    line: 32,
    title: 40,
    titleLine: 46,
    margin: 6,
    headingPad: 12,
    chipBorder: 2,
    chipPadX: 8,
    chipGap: 6,
  }),
  '4k': Object.freeze({
    width: 3840,
    height: 2160,
    padTop: 16,
    padBottom: 12,
    padX: 20,
    gap: 12,
    headerGap: 2,
    personGap: 8,
    text: 39,
    line: 48,
    title: 60,
    titleLine: 69,
    margin: 6,
    headingPad: 12,
    chipBorder: 2,
    chipPadX: 8,
    chipGap: 6,
  }),
});

const ENTRY_LINES = 2;
const MAX_TEXT_LINES = 2;
// The plan shows at most five shared tasks, then "and N more".
const TASK_CAP = 5;

function textWidth(text, fontSize) {
  return plain(text).length * fontSize;
}

function linesFor(text, width, fontSize) {
  const inner = Math.max(1, width);
  const needed = Math.ceil(textWidth(text, fontSize) / inner);
  return Math.min(MAX_TEXT_LINES, Math.max(1, needed));
}

function block(lines, line, extra = 0) {
  return lines * line + extra;
}

export function columnWidth(size, count) {
  const g = GEOMETRY[size];
  const inner = g.width - g.padX * 2;
  const gaps = g.gap * Math.max(0, count - 1);
  return Math.floor((inner - gaps) / Math.max(1, count));
}

function headerHeight(size, header) {
  const g = GEOMETRY[size];
  const width = g.width - g.padX * 2;
  const titleLines = linesFor(header.title, width, g.title);
  const updated = header.stale
    ? `Not updated since ${header.updatedClock}`
    : `Updated ${header.updatedClock}`;
  const body = [];
  if (header.yesterday) body.push(block(linesFor("This is yesterday's board", width, g.text), g.line));
  body.push(block(titleLines, g.titleLine));
  body.push(block(linesFor(header.writtenDate, width, g.text), g.line));
  body.push(block(linesFor(updated, width, g.text), g.line));
  return body.reduce((sum, height) => sum + height, 0) + g.headerGap * (body.length - 1);
}

function headingHeight(name, colW, g) {
  const inner = Math.max(1, colW - 20);
  const lines = linesFor(name, inner, g.text);
  return block(lines, g.line, g.headingPad);
}

function noteHeight(text, colW, g) {
  return block(linesFor(text, colW, g.text), g.line, g.margin);
}

function entryHeight(g) {
  return block(ENTRY_LINES, g.line, g.margin);
}

function markText(event) {
  const marks = [];
  if (event.overlaps) marks.push('Overlaps');
  if (event.tentative) marks.push('Tentative');
  if (event.cancelled) marks.push('Cancelled');
  return marks.join(' · ');
}

// Time is always one line. Marks stay fully in view: beside the title when
// they fit, otherwise on their own line. The title then cannot be covered
// by a wrapped time or a wrapped label.
export function describeEvent(event, colW, g) {
  const inner = Math.max(1, colW - 20);
  const marks = markText(event);
  const title = event.busy ? 'Busy' : event.title;
  const where = !event.busy && event.where ? event.where : '';
  let split = false;
  if (marks) {
    const gaps = where ? 2 : 1;
    const gapW = 0.4 * g.text * gaps;
    split = textWidth(marks, g.text) + gapW + 3 * g.text > inner;
  }
  return { marks, title, where, split };
}

function eventBlockHeight(event, colW, g) {
  const lines = describeEvent(event, colW, g).split ? 3 : 2;
  return block(lines, g.line, g.margin);
}

function habitHeight(name, colW, g) {
  return block(linesFor(name, colW, g.text), g.line, g.margin);
}

// Minimum the columns keep when a lists strip is also on the page.
// Two hidden-count lines, a more-line for events, tasks and habits, and
// one entry. Each of those lines may wrap to the two-line clamp.
function minimumMain(g) {
  const heading = block(MAX_TEXT_LINES, g.line, g.headingPad);
  const note = block(MAX_TEXT_LINES, g.line, g.margin);
  return heading + g.personGap + note * 5 + entryHeight(g);
}

function chipBox(text, colW, g) {
  const chrome = g.chipPadX * 2 + g.chipBorder * 2;
  const inner = Math.max(1, colW - chrome);
  const width = textWidth(text, g.text);
  const lines = linesFor(text, inner, g.text);
  const outer = Math.min(colW, width + chrome);
  return {
    outer: Math.max(1, outer),
    height: block(lines, g.line, g.chipBorder * 2),
  };
}

function chipsHeight(items, colW, g) {
  if (items.length === 0) return 0;
  const boxes = items.map(item => chipBox(item, colW, g));
  const rows = [];
  let row = [];
  let rowW = 0;
  for (const box of boxes) {
    const next = row.length === 0 ? box.outer : rowW + g.chipGap + box.outer;
    if (row.length > 0 && next > colW) {
      rows.push(row);
      row = [box];
      rowW = box.outer;
    } else {
      row.push(box);
      rowW = next;
    }
  }
  if (row.length > 0) rows.push(row);
  const heights = rows.map(line => Math.max(...line.map(box => box.height)));
  return heights.reduce((sum, height) => sum + height, 0) + g.chipGap * Math.max(0, heights.length - 1);
}

function listHeight(list, shown, colW, g) {
  const nameH = block(linesFor(list.name, colW, g.text), g.line, g.margin);
  const chips = chipsHeight(shown, colW, g);
  const chipsBlock = shown.length > 0 ? chips + g.margin : 0;
  const more = list.more > 0 ? noteHeight(`and ${list.more} more`, colW, g) : 0;
  return nameH + chipsBlock + more;
}

function fitList(list, colW, maxStrip, g) {
  const pack = (count, more) => {
    const shown = list.items.slice(0, count);
    return listHeight({ name: list.name, more }, shown, colW, g);
  };
  const allMore = list.more;
  if (pack(list.items.length, allMore) <= maxStrip) {
    return { items: list.items.slice(), more: allMore, height: pack(list.items.length, allMore) };
  }
  let count = 0;
  while (count < list.items.length) {
    const more = allMore + (list.items.length - (count + 1));
    if (pack(count + 1, more) > maxStrip) break;
    count += 1;
  }
  const more = allMore + (list.items.length - count);
  const shown = list.items.slice(0, count);
  return { items: shown, more, height: pack(count, more) };
}

function fitColumn(person, colW, rowsBudget, g) {
  const hidden = [];
  if (person.tasksHidden > 0) {
    const word = person.tasksHidden === 1 ? 'task' : 'tasks';
    hidden.push(noteHeight(`${person.tasksHidden} more ${word}`, colW, g));
  }
  if (person.habitsHidden > 0) {
    const word = person.habitsHidden === 1 ? 'habit' : 'habits';
    hidden.push(noteHeight(`${person.habitsHidden} more ${word}`, colW, g));
  }
  if (person.empty) {
    return {
      ...person,
      events: [],
      eventsCut: 0,
      tasks: [],
      tasksCut: 0,
      habits: [],
      habitsCut: 0,
      used: noteHeight('Nothing on today', colW, g),
      limit: rowsBudget,
    };
  }

  const sections = [
    { key: 'events', noun: 'events', items: person.events, height: (event) => eventBlockHeight(event, colW, g) },
    { key: 'tasks', noun: 'tasks', items: person.tasks, height: () => entryHeight(g) },
    { key: 'habits', noun: 'habits', items: person.habits, height: (habit) => habitHeight(habit.name, colW, g) },
  ].filter(section => section.items.length > 0);

  let reserved = hidden.reduce((sum, height) => sum + height, 0);
  const moreHeights = new Map();
  for (const section of sections) {
    const moreH = noteHeight(`and ${section.items.length} more ${section.noun}`, colW, g);
    moreHeights.set(section.key, moreH);
    reserved += moreH;
  }
  let used = reserved;

  const taken = {};
  for (const section of sections) {
    const moreH = moreHeights.get(section.key);
    const heights = section.items.map(section.height);
    const cap = section.key === 'tasks' ? Math.min(TASK_CAP, section.items.length) : section.items.length;
    let count = 0;
    let sum = 0;
    while (count < cap && used + sum + heights[count] <= rowsBudget) {
      sum += heights[count];
      count += 1;
    }
    if (count === section.items.length) {
      used -= moreH;
      used += sum;
      taken[section.key] = { shown: section.items, cut: 0 };
    } else {
      used += sum;
      taken[section.key] = { shown: section.items.slice(0, count), cut: section.items.length - count };
    }
  }

  return {
    ...person,
    events: taken.events?.shown ?? [],
    eventsCut: taken.events?.cut ?? 0,
    tasks: taken.tasks?.shown ?? [],
    tasksCut: taken.tasks?.cut ?? 0,
    habits: taken.habits?.shown ?? [],
    habitsCut: taken.habits?.cut ?? 0,
    used,
    limit: rowsBudget,
  };
}

export function fitPage(input) {
  const g = GEOMETRY[input.size];
  const contentH = g.height - g.padTop - g.padBottom;
  const headerH = headerHeight(input.size, input);
  // The grid template is two tracks. A lists footer is an implicit third
  // row, so it adds a second gap. With no footer there is no third track.
  const gaps = input.lists.length > 0 ? g.gap * 2 : g.gap;
  const minMain = minimumMain(g);
  const maxStrip = input.lists.length > 0
    ? Math.max(0, contentH - headerH - gaps - minMain)
    : 0;
  const listW = columnWidth(input.size, Math.max(1, input.lists.length));
  const fittedLists = input.lists.map(list => {
    const fitted = fitList(list, listW, maxStrip, g);
    return { id: list.id, name: list.name, items: fitted.items, more: fitted.more, height: fitted.height };
  });
  const stripH = fittedLists.reduce((max, list) => Math.max(max, list.height), 0);
  const mainH = contentH - headerH - gaps - stripH;
  const colW = columnWidth(input.size, input.people.length);
  const people = input.people.map(person => {
    const heading = headingHeight(person.name, colW, g);
    const rowsBudget = mainH - heading - g.personGap;
    return fitColumn(person, colW, rowsBudget, g);
  });
  return {
    people,
    lists: fittedLists.map(({ height, ...list }) => list),
    budget: {
      strip: { used: stripH, limit: maxStrip },
      people: people.map(person => ({ id: person.id, used: person.used, limit: person.limit })),
    },
  };
}
