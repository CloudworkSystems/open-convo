import { HabitGrid, renderSvg } from '../../habit-grid/src/index.mjs';

const REQUEST_KINDS = Object.freeze(['productivity', 'category']);
const PRODUCTIVITY_TAGS = Object.freeze({
  '-2': 'distracting',
  '-1': 'distracting',
  '0': 'neutral',
  '1': 'productive',
  '2': 'productive',
});
const COLORS = Object.freeze({
  productive: 'coral',
  neutral: 'amber',
  distracting: 'magenta',
  total: 'coral',
});
const RESERVED_TAGS = new Set(['productive', 'neutral', 'distracting', 'total']);

const fail = message => { throw new Error(message); };
const own = (object, key) => Object.hasOwn(object, key);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addDays(value, amount) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}

function assertRange(start, end) {
  if (!validDate(start) || !validDate(end) || start > end) fail('Invalid date range.');
}

export function requestParameters({ start, end, kind }) {
  assertRange(start, end);
  if (!REQUEST_KINDS.includes(kind)) fail('Request kind must be productivity or category.');
  return Object.freeze({
    perspective: 'interval',
    resolution_time: 'day',
    format: 'json',
    restrict_begin: start,
    restrict_end: end,
    restrict_kind: kind,
  });
}

function normalizedHeader(value) {
  return String(value).trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, ' ').trim();
}

function columnIndex(headers, accepted) {
  const normalized = headers.map(normalizedHeader);
  return normalized.findIndex(header => accepted.includes(header));
}

function responseTable(response, kind) {
  if (Array.isArray(response) && response.length > 0 && Array.isArray(response[0])) {
    return { headers: response[0], rows: response.slice(1) };
  }
  if (response !== null && typeof response === 'object' &&
      Array.isArray(response.row_headers) && Array.isArray(response.rows)) {
    return { headers: response.row_headers, rows: response.rows };
  }
  fail(`RescueTime returned malformed ${kind} rows.`);
}

function rowDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00)?$/.exec(value);
  return match && validDate(match[1]) ? match[1] : null;
}

function parseRows(response, kind) {
  const { headers, rows } = responseTable(response, kind);
  if (!Array.isArray(headers)) {
    fail(`RescueTime returned malformed ${kind} rows.`);
  }
  const dateAt = columnIndex(headers, ['date']);
  const secondsAt = columnIndex(headers, ['time spent seconds', 'time spent']);
  const valueAt = columnIndex(headers, kind === 'productivity' ? ['productivity'] : ['category']);
  if (dateAt < 0 || secondsAt < 0 || valueAt < 0) fail(`RescueTime returned malformed ${kind} rows.`);

  return rows.map(row => {
    const date = Array.isArray(row) ? rowDate(row[dateAt]) : null;
    if (!date || typeof row[secondsAt] !== 'number' || !Number.isFinite(row[secondsAt]) || row[secondsAt] < 0) {
      fail(`RescueTime returned malformed ${kind} rows.`);
    }
    const value = row[valueAt];
    if (kind === 'productivity' && !own(PRODUCTIVITY_TAGS, String(value))) fail('RescueTime returned malformed productivity rows.');
    if (kind === 'category' && (typeof value !== 'string' || value.length === 0)) fail('RescueTime returned malformed category rows.');
    return { date, seconds: row[secondsAt], value };
  });
}

function addMinutes(totals, tag, date, seconds) {
  if (!totals.has(tag)) totals.set(tag, new Map());
  const days = totals.get(tag);
  days.set(date, (days.get(date) ?? 0) + seconds / 60);
}

function safeId(value) {
  const id = value.normalize('NFKD').replaceAll(/[^a-zA-Z0-9]+/g, '-').replaceAll(/^-|-$/g, '').toLowerCase();
  return id || 'tag';
}

function uniqueTagIds(tags) {
  const used = new Set();
  return new Map(tags.map(tag => {
    const stem = safeId(tag);
    let id = stem;
    for (let suffix = 2; used.has(id); suffix += 1) id = `${stem}-${suffix}`;
    used.add(id);
    return [tag, id];
  }));
}

function stamped(value, stamp) {
  return { value, stamp: { ...stamp } };
}

function importDailyTotals(engine, personId, tags, ids, totals) {
  const snapshot = engine.getPerson(personId);
  const stamp = { counter: tags.length + 2, time: 0, device: 'time-mirror' };
  for (const tag of tags) {
    const trackerId = ids.get(tag);
    for (const [date, minutes] of totals.get(tag)) {
      if (minutes <= 0) continue;
      snapshot.checkIns.push({
        id: `${trackerId}-${date}`,
        life: stamped(true, stamp),
        purge: null,
        fields: {
          trackerId: stamped(trackerId, stamp),
          date: stamped(date, stamp),
          value: stamped(minutes, stamp),
          source: stamped('manual', stamp),
        },
      });
    }
  }
  snapshot.life = stamped(true, stamp);
  const imported = new HabitGrid({ deviceId: 'time-mirror-render', now: () => 0, timeZone: 'UTC' });
  imported.importPerson(snapshot);
  return imported;
}

function buildTrackers(totals, start, end) {
  const orderedTags = ['productive', 'neutral', 'distracting', 'total', ...[...totals.keys()]
    .filter(tag => !['productive', 'neutral', 'distracting', 'total'].includes(tag))
    .sort((left, right) => left.localeCompare(right))];
  const tags = orderedTags.filter(tag => totals.has(tag));
  const ids = uniqueTagIds(tags);
  const engine = new HabitGrid({ deviceId: 'time-mirror', now: () => 0, timeZone: 'UTC' });
  const personId = engine.createPerson('Time Mirror', { id: 'time-mirror' });

  for (const tag of tags) {
    const trackerId = ids.get(tag);
    engine.addTracker(personId, {
      name: tag,
      kind: 'count',
      target: null,
      unit: 'minutes',
      color: COLORS[tag] ?? 'coral',
      startedOn: start,
    }, { trackerId });
  }
  const imported = importDailyTotals(engine, personId, tags, ids, totals);
  return tags.map(tag => {
    const trackerId = ids.get(tag);
    const grid = imported.grid(personId, trackerId, { start, end, today: end });
    return { tag, trackerId, grid, svg: renderSvg(grid) };
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderPage({ start, end, trackers, missingDays }) {
  assertRange(start, end);
  const sections = trackers.map(({ tag, svg }) => `<section><h2>${escapeHtml(tag)}</h2>${svg}</section>`).join('\n');
  const gaps = missingDays.length === 0
    ? '<p>Days with no data: none</p>'
    : `<p>Days with no data: ${missingDays.map(escapeHtml).join(', ')}</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Time Mirror</title><style>body{background:#15110f;color:#f7f2ee;font:16px system-ui,sans-serif;margin:2rem;max-width:80rem}h1,h2{font-weight:600}section{margin:2rem 0;overflow-x:auto}svg{display:block;max-width:100%;height:auto}</style></head>
<body><main><h1>Time Mirror</h1><p>${escapeHtml(start)} to ${escapeHtml(end)}</p>${gaps}${sections}</main></body></html>`;
}

export async function buildTimeMirror({ start, end, fetchRows, categoryTags = {} }) {
  assertRange(start, end);
  if (typeof fetchRows !== 'function') fail('fetchRows must be a function.');
  if (categoryTags === null || typeof categoryTags !== 'object' || Array.isArray(categoryTags)) fail('categoryTags must be an object.');
  for (const tag of Object.values(categoryTags)) {
    if (RESERVED_TAGS.has(tag)) fail(`Owner tag ${tag} uses a reserved built-in summary name.`);
  }

  const responses = {};
  for (const kind of REQUEST_KINDS) {
    try {
      responses[kind] = await fetchRows(requestParameters({ start, end, kind }));
    } catch {
      fail(`Could not fetch ${kind} rows.`);
    }
  }

  const productivity = parseRows(responses.productivity, 'productivity');
  const categories = parseRows(responses.category, 'category');
  const totals = new Map();
  const observed = new Set();
  for (const row of productivity) {
    observed.add(row.date);
    addMinutes(totals, PRODUCTIVITY_TAGS[String(row.value)], row.date, row.seconds);
    addMinutes(totals, 'total', row.date, row.seconds);
  }
  for (const row of categories) {
    observed.add(row.date);
    if (own(categoryTags, row.value) && typeof categoryTags[row.value] === 'string' && categoryTags[row.value].length > 0) {
      addMinutes(totals, categoryTags[row.value], row.date, row.seconds);
    }
  }

  const missingDays = [];
  for (let date = start; date <= end; date = addDays(date, 1)) if (!observed.has(date)) missingDays.push(date);
  const trackers = buildTrackers(totals, start, end);
  return { start, end, missingDays, trackers, html: renderPage({ start, end, trackers, missingDays }) };
}

export { REQUEST_KINDS };
