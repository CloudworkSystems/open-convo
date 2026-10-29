// Plain text for the command. Text that came from the day file is forced onto
// one line: a backslash is doubled, line breaks are written as \n, tabs as
// \t, and bidirectional controls (and the other ASCII controls) as \uXXXX.
// The JSON agenda keeps those characters unchanged.

const LINE_BREAK = /\r\n|\n|\r|\u2028|\u2029/g;
const BIDI_OR_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function oneLine(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(LINE_BREAK, '\\n')
    .replace(/\t/g, '\\t')
    .replace(BIDI_OR_CONTROL, (ch) => `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`);
}

function span(event, date) {
  const startOn = event.start.startsWith(`${date}T`);
  const endOn = event.end.startsWith(`${date}T`);
  if (event.noLength) return startOn ? event.start.slice(date.length + 1) : event.start;
  if (!startOn || !endOn) return `${event.start}-${event.end}`;
  return `${event.start.slice(date.length + 1)}-${event.end.slice(date.length + 1)}`;
}

function formatEvent(event, date, clashKeys) {
  const title = oneLine(event.title);
  const calendar = oneLine(event.calendar);
  const where = event.location ? `  @ ${oneLine(event.location)}` : '';
  const marks = [];
  if (event.status === 'tentative') marks.push('tentative');
  if (event.noLength) marks.push('no length');
  if (event.startsBefore) marks.push('started earlier');
  if (event.endsAfter) marks.push('ends later');
  if (clashKeys.has(event.key)) marks.push('clash');
  const mark = marks.length > 0 ? `  [${marks.join(', ')}]` : '';
  const when = event.allDay ? 'All day' : span(event, date);
  return `${when}  ${title}  (${calendar})${where}${mark}`;
}

function formatTask(task) {
  const when = task.group === 'overdue' ? 'Overdue' : 'Today';
  const list = task.list ? `  (${oneLine(task.list)})` : '';
  const time = task.dueTimeLocal ? ` ${task.dueTimeLocal}` : '';
  const high = task.priority === 'high' ? '  [high]' : '';
  return `${when}  ${oneLine(task.title)}${list}  due ${task.due}${time}${high}`;
}

function section(lines, title, rows, empty) {
  lines.push(title);
  if (rows.length === 0) lines.push(empty);
  else lines.push(...rows);
  lines.push('');
}

export function formatAgenda(agenda) {
  const lines = [];
  for (const sentence of agenda.summary) lines.push(oneLine(sentence));
  if (agenda.summary.length > 0) lines.push('');
  const clashKeys = new Set(agenda.clashes.flatMap(clash => clash.keys));
  section(
    lines,
    'Timeline',
    agenda.timeline.map(event => formatEvent(event, agenda.date, clashKeys)),
    'Nothing on the timeline.',
  );
  section(
    lines,
    'Free time',
    agenda.freeTime.map(gap => `${gap.start}-${gap.end}  (${gap.minutes} min)`),
    'None.',
  );
  section(lines, 'Tasks', agenda.tasks.map(formatTask), 'None.');
  section(lines, 'Habits', agenda.habits.map(habit => oneLine(habit.name)), 'None still open.');
  section(
    lines,
    'Lists',
    agenda.lists.map(list => `${oneLine(list.name)}  ${list.open} open`),
    'None.',
  );
  return `${lines.join('\n')}\n`;
}
