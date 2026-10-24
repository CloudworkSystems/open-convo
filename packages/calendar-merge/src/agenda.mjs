// A plain-text agenda from a merge result: one line per occurrence, grouped
// by day. Every value is printed on one line (control characters written out).

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function oneLine(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out;
}

function weekdayName(date) {
  const [y, m, d] = date.split('-').map(Number);
  // Zeller-style weekday from the civil date, without Date.
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const yy = m < 3 ? y - 1 : y;
  const index = (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[m - 1] + d) % 7;
  return WEEKDAY_NAMES[index];
}

function previousDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  if (d > 1) return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d - 1).padStart(2, '0')}`;
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  const dim = [31, (py % 4 === 0 && py % 100 !== 0) || py % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][pm - 1];
  return `${String(py).padStart(4, '0')}-${String(pm).padStart(2, '0')}-${String(dim).padStart(2, '0')}`;
}

function when(occurrence, day) {
  if (occurrence.allDay) {
    const last = previousDate(occurrence.end);
    return occurrence.start === last ? 'All day' : `All day (${occurrence.start} to ${last})`;
  }
  const [startDate, startClock] = occurrence.start.local.split('T');
  const [endDate, endClock] = occurrence.end.local.split('T');
  const start = startDate === day ? startClock.slice(0, 5) : `${startDate} ${startClock.slice(0, 5)}`;
  const end = endDate === startDate ? endClock.slice(0, 5) : `${endDate} ${endClock.slice(0, 5)}`;
  return `${start}-${end}`;
}

export function formatAgenda(result) {
  const fromDate = result.query.from.local.slice(0, 10);
  const lastDate = previousDate(result.query.to.local.slice(0, 10));
  const lines = [`Agenda ${fromDate} to ${lastDate} (${result.query.timeZone})`];
  let currentDay = null;
  for (const occurrence of result.occurrences) {
    let day;
    if (occurrence.allDay) day = occurrence.start < fromDate ? fromDate : occurrence.start;
    else day = occurrence.start.utc < result.query.from.utc ? fromDate : occurrence.start.local.slice(0, 10);
    if (day !== currentDay) {
      lines.push('', `${weekdayName(day)} ${day}`);
      currentDay = day;
    }
    const title = occurrence.title === '' ? '(No title)' : oneLine(occurrence.title);
    const place = occurrence.location ? ` @ ${oneLine(occurrence.location)}` : '';
    const notes = [];
    if (occurrence.status !== 'confirmed') notes.push(occurrence.status);
    if (occurrence.floating) notes.push('floating time');
    if (occurrence.repeatNotSupported) notes.push('repeat not supported');
    const from = occurrence.sources.map((s) => oneLine(s.name)).join(', ');
    lines.push(`  ${when(occurrence, day).padEnd(13)} ${title}${place}  [${from}]${notes.length ? ` (${notes.join(', ')})` : ''}`);
  }
  if (!result.occurrences.length) lines.push('', 'No events in this range.');
  if (result.problems.length) {
    lines.push('', 'Problems:');
    for (const problem of result.problems) lines.push(`  - ${oneLine(problem)}`);
  }
  return `${lines.join('\n')}\n`;
}
