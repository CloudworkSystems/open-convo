import { COLOR_NAMES, COLORS, PAGE } from './colors.mjs';
import { GEOMETRY, columnWidth, describeEvent } from './layout.mjs';
import { escapeHtml } from './text.mjs';

// The page is a fixed screen. Sizes, line heights and gaps come from
// GEOMETRY, which is also what decides how many rows fit. 4k type is
// larger, but not twice as large, so the same family fits more lines.
// Each entry is at most two lines tall. Long words wrap inside the column.

function css() {
  const person = [];
  for (const theme of ['light', 'dark']) {
    const page = PAGE[theme];
    person.push(`body[data-theme="${theme}"] {`);
    person.push(`  background: ${page.background};`);
    person.push(`  color: ${page.text};`);
    person.push(`  --warning: ${page.warning};`);
    person.push(`  --warning-bg: ${page.warningBackground};`);
    person.push('}');
    for (const name of COLOR_NAMES) {
      const swatch = COLORS[name][theme];
      person.push(`body[data-theme="${theme}"] .person-${name} { --fill: ${swatch.fill}; --ink: ${swatch.text}; }`);
    }
  }
  const sizes = [];
  for (const [name, size] of Object.entries(GEOMETRY)) {
    sizes.push(`body[data-size="${name}"] {`);
    sizes.push(`  width: ${size.width}px;`);
    sizes.push(`  height: ${size.height}px;`);
    sizes.push(`  --title: ${size.title}px;`);
    sizes.push(`  --title-line: ${size.titleLine}px;`);
    sizes.push(`  --text: ${size.text}px;`);
    sizes.push(`  --line: ${size.line}px;`);
    sizes.push('}');
  }
  const shared = GEOMETRY['1080p'];
  return `
html, body { margin: 0; padding: 0; }
* { box-sizing: border-box; }
body {
  overflow: hidden;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  grid-auto-rows: auto;
  gap: ${shared.gap}px;
  padding: ${shared.padTop}px ${shared.padX}px ${shared.padBottom}px;
  font-family: "Avenir Next", "Segoe UI", sans-serif;
}
h1, h2, h3, p, ul, ol { margin: 0; padding: 0; }
ul, ol { list-style: none; }
h1 {
  font-size: var(--title);
  line-height: var(--title-line);
  max-height: calc(var(--title-line) * 2);
  overflow: hidden;
  font-weight: 700;
  overflow-wrap: anywhere;
}
.date, .updated, .banner { font-size: var(--text); line-height: var(--line); }
.banner, .updated.stale {
  background: var(--warning-bg);
  color: var(--warning);
  font-weight: 700;
  padding: 0 10px;
}
header { display: grid; gap: ${shared.headerGap}px; min-width: 0; }
.people {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: ${shared.gap}px;
  min-height: 0;
  min-width: 0;
}
.person {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: ${shared.personGap}px;
}
.person h2 {
  flex: none;
  background: var(--fill);
  color: var(--ink);
  font-size: var(--text);
  line-height: var(--line);
  padding: ${shared.headingPad / 2}px 10px;
  max-height: calc(var(--line) * 2 + ${shared.headingPad}px);
  overflow: hidden;
  overflow-wrap: anywhere;
}
.rows { min-width: 0; min-height: 0; }
.event, .task {
  font-size: var(--text);
  line-height: var(--line);
  margin: 0 0 ${shared.margin}px;
  min-width: 0;
}
.event {
  background: var(--fill);
  color: var(--ink);
  padding: 0 10px;
}
.when, .markline {
  height: var(--line);
  line-height: var(--line);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.what {
  display: flex;
  align-items: baseline;
  gap: 0.4em;
  height: var(--line);
  line-height: var(--line);
  min-width: 0;
  overflow: hidden;
}
.mark { flex: none; font-weight: 700; white-space: nowrap; }
.markline { font-weight: 700; }
.title {
  flex: 1 1 auto;
  min-width: 3em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.where {
  flex: 0 1 40%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.habit, .more, .hidden, .empty {
  font-size: var(--text);
  line-height: var(--line);
  overflow-wrap: anywhere;
  max-height: calc(var(--line) * 2);
  overflow: hidden;
  margin: 0 0 ${shared.margin}px;
  min-width: 0;
}
.more, .hidden, .empty { font-weight: 700; }
.lists {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: ${shared.gap}px;
  min-width: 0;
}
.list { min-width: 0; }
.list h3 {
  font-size: var(--text);
  line-height: var(--line);
  max-height: calc(var(--line) * 2);
  overflow: hidden;
  overflow-wrap: anywhere;
  margin: 0 0 ${shared.margin}px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: ${shared.chipGap}px;
  margin: 0 0 ${shared.margin}px;
  min-width: 0;
}
.chip {
  flex: none;
  min-width: 0;
  max-width: 100%;
  padding: 0 ${shared.chipPadX}px;
  border: ${shared.chipBorder}px solid currentColor;
  border-radius: 999px;
  font-size: var(--text);
  line-height: var(--line);
  max-height: calc(var(--line) * 2 + ${shared.chipBorder * 2}px);
  overflow: hidden;
  overflow-wrap: anywhere;
}
${sizes.join('\n')}
${person.join('\n')}
`.trim();
}

function moreLine(count, noun = '') {
  if (count <= 0) return '';
  const tail = noun ? ` ${noun}` : '';
  return `<p class="more">and ${count} more${tail}</p>`;
}

function hiddenLine(count, singular, plural) {
  if (count <= 0) return '';
  const word = count === 1 ? singular : plural;
  return `<p class="hidden">${count} more ${word}</p>`;
}

function eventItem(event, colW, size) {
  const classes = ['event'];
  if (event.busy) classes.push('busy');
  if (event.allDay) classes.push('all-day');
  if (event.overlaps) classes.push('clash');
  const detail = describeEvent(event, colW, GEOMETRY[size]);
  const where = detail.where ? `<span class="where">${escapeHtml(detail.where)}</span>` : '';
  const title = `<span class="title">${escapeHtml(detail.title)}</span>`;
  const body = detail.split
    ? `<p class="markline">${escapeHtml(detail.marks)}</p><p class="what">${title}${where}</p>`
    : `<p class="what">${detail.marks ? `<span class="mark">${escapeHtml(detail.marks)}</span>` : ''}${title}${where}</p>`;
  return `<li class="${classes.join(' ')}"><p class="when">${escapeHtml(event.when)}</p>${body}</li>`;
}

function personSection(person, colW, size) {
  const parts = [`<section class="person person-${person.color}">`, `<h2>${escapeHtml(person.name)}</h2>`, '<div class="rows">'];
  if (person.empty) {
    parts.push('<p class="empty">Nothing on today</p>');
  } else {
    if (person.events.length > 0) {
      parts.push(`<ol class="events">\n${person.events.map(event => eventItem(event, colW, size)).join('\n')}\n</ol>`);
    }
    parts.push(moreLine(person.eventsCut, person.events.length === 0 ? 'events' : ''));
    if (person.tasks.length > 0) {
      const items = person.tasks.map(task =>
        `<li class="task"><p class="what"><span class="title">${escapeHtml(task.title)}</span></p><p class="when">${escapeHtml(task.label)}</p></li>`);
      parts.push(`<ul class="tasks">\n${items.join('\n')}\n</ul>`);
    }
    parts.push(moreLine(person.tasksCut, person.tasks.length === 0 ? 'tasks' : ''));
    if (person.habits.length > 0) {
      const items = person.habits.map(habit =>
        `<li class="habit">${escapeHtml(habit.name)}</li>`);
      parts.push(`<ul class="habits">\n${items.join('\n')}\n</ul>`);
    }
    parts.push(moreLine(person.habitsCut, person.habits.length === 0 ? 'habits' : ''));
    parts.push(hiddenLine(person.tasksHidden, 'task', 'tasks'));
    parts.push(hiddenLine(person.habitsHidden, 'habit', 'habits'));
  }
  parts.push('</div>', '</section>');
  return parts.filter(Boolean).join('\n');
}

function listsStrip(lists) {
  if (lists.length === 0) return '';
  const sections = lists.map(list => {
    const chips = list.items.map(item => `<li class="chip">${escapeHtml(item)}</li>`).join('');
    const items = chips.length > 0 ? `<ul class="chips">${chips}</ul>` : '';
    return `<section class="list"><h3>${escapeHtml(list.name)}</h3>${items}${moreLine(list.more)}</section>`;
  });
  return `<footer class="lists">\n${sections.join('\n')}\n</footer>`;
}

export function renderPage(model) {
  const banner = model.yesterday ? '<p class="banner">This is yesterday\'s board</p>' : '';
  const updated = model.stale
    ? `<p class="updated stale">Not updated since ${escapeHtml(model.updatedClock)}</p>`
    : `<p class="updated">Updated ${escapeHtml(model.updatedClock)}</p>`;
  const lists = listsStrip(model.lists);
  const colW = columnWidth(model.size, model.people.length);
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(model.title)}</title>`,
    '<style>',
    css(),
    '</style>',
    '</head>',
    `<body data-size="${model.size}" data-theme="${model.theme}">`,
    '<header>',
    banner,
    `<h1>${escapeHtml(model.title)}</h1>`,
    `<p class="date">${escapeHtml(model.writtenDate)}</p>`,
    updated,
    '</header>',
    '<main class="people">',
    model.people.map(person => personSection(person, colW, model.size)).join('\n'),
    '</main>',
    lists,
    '</body>',
    '</html>',
    '',
  ].filter(part => part !== '').join('\n');
}
