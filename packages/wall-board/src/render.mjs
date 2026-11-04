import { COLOR_NAMES, COLORS, PAGE } from './colors.mjs';
import { escapeHtml } from './text.mjs';

// The page is a fixed screen. 4k type is larger, but not twice as large, so
// the same family fits more lines. Each entry is at most two lines tall.
// Long words wrap inside the column (overflow-wrap) and cannot widen it.

const SIZES = {
  '1080p': { width: 1920, height: 1080, title: 40, text: 26, line: 32, strip: 168 },
  '4k': { width: 3840, height: 2160, title: 60, text: 39, line: 48, strip: 250 },
};

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
  for (const [name, size] of Object.entries(SIZES)) {
    sizes.push(`body[data-size="${name}"] {`);
    sizes.push(`  width: ${size.width}px;`);
    sizes.push(`  height: ${size.height}px;`);
    sizes.push(`  --title: ${size.title}px;`);
    sizes.push(`  --text: ${size.text}px;`);
    sizes.push(`  --line: ${size.line}px;`);
    sizes.push(`  --strip: ${size.strip}px;`);
    sizes.push('}');
  }
  return `
html, body { margin: 0; padding: 0; }
* { box-sizing: border-box; }
body {
  overflow: hidden;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 12px;
  padding: 16px 20px 12px;
  font-family: "Avenir Next", "Segoe UI", sans-serif;
}
h1, h2, h3, p, ul, ol { margin: 0; padding: 0; }
ul, ol { list-style: none; }
h1 { font-size: var(--title); line-height: 1.15; font-weight: 700; overflow-wrap: anywhere; }
.date, .updated, .banner { font-size: var(--text); line-height: var(--line); }
.banner, .updated.stale {
  background: var(--warning-bg);
  color: var(--warning);
  font-weight: 700;
  padding: 2px 10px;
}
header { display: grid; gap: 2px; min-width: 0; }
.people {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: 12px;
  min-height: 0;
  min-width: 0;
}
.person {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.person h2 {
  flex: none;
  background: var(--fill);
  color: var(--ink);
  font-size: var(--text);
  line-height: var(--line);
  padding: 6px 10px;
  overflow-wrap: anywhere;
}
.rows { min-width: 0; min-height: 0; overflow: hidden; }
.event, .task, .habit, .more, .hidden, .empty {
  font-size: var(--text);
  line-height: var(--line);
  overflow-wrap: anywhere;
  max-height: calc(var(--line) * 2);
  overflow: hidden;
  margin: 0 0 6px;
  min-width: 0;
}
.event {
  background: var(--fill);
  color: var(--ink);
  padding: 4px 10px;
}
.task, .habit { padding: 0 2px; }
.more, .hidden, .empty { font-weight: 700; }
.mark { font-weight: 700; }
.lists {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: 12px;
  max-height: var(--strip);
  overflow: hidden;
  min-width: 0;
}
.list { min-width: 0; overflow: hidden; }
.list h3 { font-size: var(--text); line-height: var(--line); overflow-wrap: anywhere; }
.chips { min-width: 0; }
.chip {
  display: inline-block;
  max-width: 100%;
  margin: 0 6px 6px 0;
  padding: 0 8px;
  border: 2px solid currentColor;
  border-radius: 999px;
  font-size: var(--text);
  line-height: var(--line);
  overflow-wrap: anywhere;
  vertical-align: top;
}
${sizes.join('\n')}
${person.join('\n')}
`.trim();
}

function moreLine(count) {
  if (count <= 0) return '';
  return `<p class="more">and ${count} more</p>`;
}

function hiddenLine(count, singular, plural) {
  if (count <= 0) return '';
  const word = count === 1 ? singular : plural;
  return `<p class="hidden">${count} more ${word}</p>`;
}

function eventItem(event) {
  const classes = ['event'];
  if (event.busy) classes.push('busy');
  if (event.allDay) classes.push('all-day');
  if (event.overlaps) classes.push('clash');
  // Time on the first line. Title, place and marks share the second line so
  // the two-line clamp cannot hide a clash or a place.
  const detail = [];
  detail.push(event.busy ? 'Busy' : event.title);
  if (!event.busy && event.where) detail.push(event.where);
  if (event.cancelled) detail.push('Cancelled');
  if (event.tentative) detail.push('Tentative');
  if (event.overlaps) detail.push('Overlaps');
  return `<li class="${classes.join(' ')}"><p class="when">${escapeHtml(event.when)}</p><p class="what">${escapeHtml(detail.join(' · '))}</p></li>`;
}

function personSection(person) {
  const parts = [`<section class="person person-${person.color}">`, `<h2>${escapeHtml(person.name)}</h2>`, '<div class="rows">'];
  if (person.empty) {
    parts.push('<p class="empty">Nothing on today</p>');
  } else {
    if (person.events.length > 0) {
      parts.push(`<ol class="events">\n${person.events.map(eventItem).join('\n')}\n</ol>`);
      parts.push(moreLine(person.eventsCut));
    }
    if (person.tasks.length > 0) {
      const items = person.tasks.map(task =>
        `<li class="task"><p class="when">${escapeHtml(task.label)}</p><p class="what">${escapeHtml(task.title)}</p></li>`);
      parts.push(`<ul class="tasks">\n${items.join('\n')}\n</ul>`);
      parts.push(moreLine(person.tasksCut));
    }
    if (person.habits.length > 0) {
      const items = person.habits.map(habit =>
        `<li class="habit"><p class="what">${escapeHtml(habit.name)}</p></li>`);
      parts.push(`<ul class="habits">\n${items.join('\n')}\n</ul>`);
      parts.push(moreLine(person.habitsCut));
    }
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
    model.people.map(personSection).join('\n'),
    '</main>',
    lists,
    '</body>',
    '</html>',
    '',
  ].filter(part => part !== '').join('\n');
}
