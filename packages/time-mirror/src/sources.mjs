import { buildTimeMirror, renderPage } from './index.mjs';
import { HabitGrid, renderSvg } from '../../habit-grid/src/index.mjs';

const RESERVED = new Set(['productive', 'neutral', 'distracting', 'total']);
const PULSE_MS = 5_000;
const HOUR_MS = 3_600_000;
const fail = message => { throw new Error(message); };
const own = (object, key) => Object.hasOwn(object, key);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function addDays(value, count) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + count)).toISOString().slice(0, 10);
}

function rangeDates(from, to) {
  if (!validDate(from) || !validDate(to) || from > to) fail('Invalid date range.');
  const dates = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    dates.push(date);
    if (dates.length > 400) fail('Activity sources accept at most 400 days.');
  }
  return dates;
}

function partsAt(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function civilStart(date, timeZone) {
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en', { timeZone }); formatter.format(0); } catch { fail(`Unknown time zone: ${timeZone}.`); }
  const [year, month, day] = date.split('-').map(Number);
  const wanted = Date.UTC(year, month - 1, day);
  let guess = wanted;
  for (let tries = 0; tries < 4; tries += 1) {
    const got = partsAt(guess, timeZone);
    const represented = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
    guess += wanted - represented;
  }
  return guess;
}

function dayLengthMinutes(date, timeZone) {
  return (civilStart(addDays(date, 1), timeZone) - civilStart(date, timeZone)) / 60_000;
}

function validateTags(tags, label) {
  if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) fail(`${label} must be an object.`);
  for (const tag of Object.values(tags)) {
    if (typeof tag !== 'string' || tag.length === 0) fail(`${label} values must be non-empty tag names.`);
    if (RESERVED.has(tag)) fail(`Tag ${tag} uses a reserved built-in summary name.`);
  }
}

function buildTimeMirrorFromDays({ start, end, days, missingDays }) {
  const summaries = ['productive', 'neutral', 'distracting', 'total'];
  const present = new Set(Object.values(days).flatMap(tags => Object.keys(tags)));
  const tags = [...summaries.filter(tag => present.has(tag)), ...[...present]
    .filter(tag => !summaries.includes(tag)).sort((left, right) => left.localeCompare(right))];
  const engine = new HabitGrid({ deviceId: 'time-mirror', now: () => 0, timeZone: 'UTC' });
  const personId = engine.createPerson('Time Mirror', { id: 'time-mirror' });
  const used = new Set();
  const trackers = tags.map(tag => {
    const stem = tag.normalize('NFKD').replaceAll(/[^a-zA-Z0-9]+/g, '-').replaceAll(/^-|-$/g, '').toLowerCase() || 'tag';
    let trackerId = stem;
    for (let suffix = 2; used.has(trackerId); suffix += 1) trackerId = `${stem}-${suffix}`;
    used.add(trackerId);
    engine.addTracker(personId, {
      name: tag, kind: 'count', target: null, unit: 'minutes',
      color: tag === 'neutral' ? 'amber' : tag === 'distracting' ? 'magenta' : 'coral', startedOn: start,
    }, { trackerId });
    engine.logCheckIns(personId, Object.entries(days)
      .filter(([, totals]) => totals[tag] > 0)
      .map(([date, totals]) => ({ trackerId, date, value: totals[tag], source: 'manual', checkInId: `${trackerId}-${date}` })));
    const grid = engine.grid(personId, trackerId, { start, end, today: end });
    return { tag, trackerId, grid, svg: renderSvg(grid) };
  });
  return { start, end, missingDays, trackers, html: renderPage({ start, end, trackers, missingDays }) };
}

export async function fromSource(source, options) {
  const checked = await checkSource(source, options);
  const result = buildTimeMirrorFromDays({ start: options.from, end: options.to, days: checked.days, missingDays: checked.missing });
  return { ...result, skipped: checked.skipped, source: { id: source.id, name: source.name } };
}

export function rescueTimeSource({ fetchRows, categoryTags = {} }) {
  return {
    id: 'rescuetime', name: 'RescueTime',
    async days({ from, to }) {
      const result = await buildTimeMirror({ start: from, end: to, fetchRows, categoryTags });
      const days = {};
      for (const tracker of result.trackers) for (const square of tracker.grid.squares) {
        if (square.inRange && square.value > 0) (days[square.date] ??= {})[tracker.tag] = square.value;
      }
      return { days, missing: result.missingDays, skipped: 0 };
    },
  };
}

export async function checkSource(source, { from, to, timeZone }) {
  if (!source || typeof source.id !== 'string' || !source.id || typeof source.name !== 'string' || !source.name || typeof source.days !== 'function') {
    fail('Activity source must have id, name, and a days function.');
  }
  const dates = rangeDates(from, to);
  civilStart(from, timeZone);
  const result = await source.days({ from, to, timeZone });
  if (!result || typeof result !== 'object' || !result.days || typeof result.days !== 'object' || Array.isArray(result.days) ||
      !Array.isArray(result.missing) || !Number.isInteger(result.skipped) || result.skipped < 0) fail('Activity source returned an invalid result shape.');
  const missing = new Set(result.missing);
  for (const date of missing) if (!dates.includes(date)) fail(`Activity source listed missing day outside the range: ${date}.`);
  for (const [date, tags] of Object.entries(result.days)) {
    if (!dates.includes(date)) fail(`Activity source returned day outside the range: ${date}.`);
    if (missing.has(date)) fail(`Activity source returned totals for missing day ${date}.`);
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) fail(`Activity source returned invalid tags for ${date}.`);
    for (const [tag, minutes] of Object.entries(tags)) {
      if (!tag || typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) fail(`Activity source returned invalid minutes for ${date}.`);
      if (minutes > dayLengthMinutes(date, timeZone) + 1e-9) fail(`Activity source returned more minutes than ${date} contains.`);
    }
  }
  return result;
}

function bucketList(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value).map(([id, bucket]) => ({ id, ...bucket }));
  if (Array.isArray(value)) return value;
  fail('ActivityWatch returned a malformed bucket list.');
}

function chooseBucket(buckets, type, host) {
  const matches = buckets.filter(bucket => bucket.type === type && bucket.hostname === host);
  if (matches.length !== 1) {
    const found = buckets.map(bucket => `${String(bucket.type)} on ${String(bucket.hostname)}`).join(', ') || 'none';
    fail(`ActivityWatch needs exactly one ${type} bucket for host ${host}; found ${matches.length}. Available buckets: ${found}. Check --host.`);
  }
  return matches[0].id;
}

function parseEvents(value, kind) {
  if (!Array.isArray(value)) fail(`ActivityWatch returned malformed ${kind} events.`);
  const events = [];
  let skipped = 0;
  for (const raw of value) {
    const start = typeof raw?.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
    const duration = raw?.duration;
    const datum = raw?.data;
    const wanted = kind === 'window' ? datum?.app : datum?.status;
    if (!Number.isFinite(start) || typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 ||
        typeof wanted !== 'string' || (kind === 'idle' && !['afk', 'not-afk'].includes(wanted))) { skipped += 1; continue; }
    events.push({ start, end: start + duration * 1000, value: wanted });
  }
  return { events, skipped };
}

function flood(events) {
  const sorted = events.toSorted((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const event of sorted) {
    const current = { ...event };
    const previous = out.at(-1);
    if (previous) {
      if (current.start < previous.end) previous.end = current.start;
      else if (current.start - previous.end < PULSE_MS) previous.end = current.start;
      if (previous.end <= previous.start) out.pop();
    }
    out.push(current);
  }
  return out;
}

function activeSegments(windows, idle, start, end) {
  const active = idle.filter(event => event.value === 'not-afk');
  const segments = [];
  for (const window of windows) for (const status of active) {
    const left = Math.max(window.start, status.start, start);
    const right = Math.min(window.end, status.end, end);
    if (right > left) segments.push({ start: left, end: right, app: window.value });
  }
  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  const result = [];
  for (const segment of segments) {
    const previous = result.at(-1);
    if (previous && segment.start < previous.end) {
      if (segment.end > previous.end) result.push({ ...segment, start: previous.end });
    } else result.push(segment);
  }
  return result;
}

function eventPath(bucket, start, end) {
  return `/api/0/buckets/${encodeURIComponent(bucket)}/events?start=${encodeURIComponent(new Date(start).toISOString())}&end=${encodeURIComponent(new Date(end).toISOString())}`;
}

async function readSpan(fetchJson, buckets, start, end, minimum = HOUR_MS) {
  const expandedStart = start - PULSE_MS;
  const expandedEnd = end + PULSE_MS;
  const responses = await Promise.all(buckets.map(bucket => fetchJson(eventPath(bucket, expandedStart, expandedEnd))));
  if (responses.some(response => response?.truncated === true)) {
    if (end - start <= minimum) fail(`ActivityWatch returned more than 2 MB for the hour starting ${new Date(start).toISOString()}. Narrow the range or reduce ActivityWatch data.`);
    const middle = start + Math.floor((end - start) / 2);
    return [...await readSpan(fetchJson, buckets, start, middle, minimum), ...await readSpan(fetchJson, buckets, middle, end, minimum)];
  }
  return [{ start, end, responses }];
}

export async function awDays({ from, to, timeZone, appTags = {}, host, fetchJson, collectApps = false }) {
  const dates = rangeDates(from, to);
  validateTags(appTags, 'appTags');
  if (typeof host !== 'string' || !host) fail('host must be a non-empty name.');
  if (typeof fetchJson !== 'function') fail('fetchJson must be a function.');
  const buckets = bucketList(await fetchJson('/api/0/buckets/'));
  const windowBucket = chooseBucket(buckets, 'currentwindow', host);
  const idleBucket = chooseBucket(buckets, 'afkstatus', host);
  const days = {};
  const missing = [];
  let skipped = 0;
  const apps = {};
  for (const date of dates) {
    const start = civilStart(date, timeZone);
    const end = civilStart(addDays(date, 1), timeZone);
    const spans = await readSpan(fetchJson, [windowBucket, idleBucket], start, end);
    let sawValid = false;
    const totals = {};
    for (const span of spans) {
      const windows = parseEvents(span.responses[0], 'window');
      const idle = parseEvents(span.responses[1], 'idle');
      skipped += windows.skipped + idle.skipped;
      if (windows.events.length || idle.events.length) sawValid = true;
      for (const segment of activeSegments(flood(windows.events), flood(idle.events), span.start, span.end)) {
        if (collectApps) apps[segment.app] = (apps[segment.app] ?? 0) + (segment.end - segment.start) / 60_000;
        const tag = own(appTags, segment.app) ? appTags[segment.app] : 'untagged';
        totals[tag] = (totals[tag] ?? 0) + (segment.end - segment.start) / 60_000;
      }
    }
    if (!sawValid) missing.push(date);
    else days[date] = totals;
  }
  return collectApps ? { days, missing, skipped, apps } : { days, missing, skipped };
}

export function activityWatchSource(options) {
  return { id: 'activitywatch', name: 'ActivityWatch', days: range => awDays({ ...options, ...range }) };
}

export { PULSE_MS };
