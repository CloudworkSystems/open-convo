import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { activityWatchSource, awDays, checkSource, flood, fromSource, rescueTimeSource } from '../src/sources.mjs';

const buckets = {
  'aw-watcher-window_test': { type: 'currentwindow', hostname: 'test-mac' },
  'aw-watcher-afk_test': { type: 'afkstatus', hostname: 'test-mac' },
  'aw-watcher-web_test': { type: 'web.tab.current', hostname: 'test-mac' },
};

test('flood mirrors aw-core v0.5.17 gap attribution, merges, overlaps and zero leftovers', () => {
  const e = (start, end, value = 'A') => ({ start, end, value });
  assert.deepEqual(flood([e(0, 1000), e(6000, 7000, 'B')]), [e(0, 6000), e(6000, 7000, 'B')]);
  assert.deepEqual(flood([e(0, 1000), e(6001, 7001, 'B')]), [e(0, 1000), e(6001, 7001, 'B')]);
  assert.deepEqual(flood([e(0, 1000), e(5000, 15000, 'B')]), [e(0, 1000), e(1000, 15000, 'B')]);
  assert.deepEqual(flood([e(0, 2000), e(5000, 7000, 'B')]), [e(0, 5000), e(5000, 7000, 'B')]);
  assert.deepEqual(flood([e(5000, 15000), e(0, 1000)]), [e(0, 15000)]);
  assert.deepEqual(flood([e(0, 10000), e(14000, 15000)]), [e(0, 15000)]);
  assert.deepEqual(flood([e(0, 0), e(6000, 6000)]), []);
  assert.deepEqual(flood([e(0, 10000), e(5000, 15000)]), [e(0, 15000)]);
  assert.deepEqual(flood([e(0, 10000), e(5000, 15000, 'B')]), [e(0, 10000), e(5000, 15000, 'B')]);
  assert.deepEqual(flood([e(0, 1000), e(950, 2950, 'B')]), [e(0, 1000), e(1000, 2950, 'B')]);
});

function event(timestamp, duration, data) { return { timestamp, duration, data }; }

function inventedActivity({ windowEvents = [], idleEvents = [], calls = [] } = {}) {
  return async path => {
    calls.push(path);
    if (path === '/api/0/buckets/') return buckets;
    if (path.includes('aw-watcher-window_test')) return windowEvents;
    if (path.includes('aw-watcher-afk_test')) return idleEvents;
    throw new Error(`unexpected path ${path}`);
  };
}

test('ActivityWatch source drops titles and URLs, subtracts idle time, and builds the page', async () => {
  const marker = 'PRIVATE-MARKER';
  const calls = [];
  const fetchJson = inventedActivity({ calls,
    windowEvents: [
      event('2026-10-01T14:00:00Z', 3600, { app: 'Editor', title: marker, url: `https://${marker}` }),
      event('2026-10-01T14:30:00Z', 1200, { app: 'Overlap', title: marker }),
    ],
    idleEvents: [event('2026-10-01T14:00:00Z', 1800, { status: 'not-afk', title: marker }), event('2026-10-01T14:30:00Z', 1800, { status: 'afk' })],
  });
  const source = activityWatchSource({ host: 'test-mac', appTags: { Editor: 'coding' }, fetchJson });
  const result = await fromSource(source, { from: '2026-10-01', to: '2026-10-01', timeZone: 'UTC' });
  assert.equal(result.trackers.find(tracker => tracker.tag === 'coding').grid.squares.find(day => day.date === '2026-10-01').value, 30);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
  assert.equal(calls.length, 3);
  assert.equal(calls.some(path => path.includes('web')), false);
  assert.ok(calls.slice(1).every(path => /^\/api\/0\/buckets\/[^/]+\/events\?start=.+&end=.+$/.test(path)));
});

test('floods close heartbeats, leaves longer gaps, and counts malformed events', async () => {
  const fetchJson = inventedActivity({
    windowEvents: [
      event('2026-10-01T10:00:00Z', 0, { app: 'Editor' }),
      event('2026-10-01T10:00:04Z', 1, { app: 'Editor' }),
      event('2026-10-01T10:00:10Z', 1, { app: 'Editor' }),
      event('bad', 2, { app: 'Editor', title: 'SECRET' }),
    ],
    idleEvents: [event('2026-10-01T10:00:00Z', 4, { status: 'not-afk' }), event('2026-10-01T10:00:04Z', 6, { status: 'not-afk' })],
  });
  const result = await awDays({ from: '2026-10-01', to: '2026-10-01', timeZone: 'UTC', host: 'test-mac', appTags: { Editor: 'coding' }, fetchJson });
  assert.equal(result.skipped, 1);
  assert.ok(Math.abs(result.days['2026-10-01'].coding - 10 / 60) < 1e-12);
});

test('splits midnight and respects 23-hour and 25-hour civil days', async () => {
  const result = await awDays({
    from: '2026-10-31', to: '2026-11-01', timeZone: 'America/New_York', host: 'test-mac', appTags: {},
    fetchJson: inventedActivity({
      windowEvents: [event('2026-11-01T03:30:00Z', 7200, { app: 'Editor' })],
      idleEvents: [event('2026-11-01T03:30:00Z', 7200, { status: 'not-afk' })],
    }),
  });
  assert.equal(result.days['2026-10-31'].untagged, 30);
  assert.equal(result.days['2026-11-01'].untagged, 90);
  await assert.rejects(checkSource({ id: 'bad', name: 'Bad', days: async () => ({ days: { '2026-11-01': { x: 1501 } }, missing: [], skipped: 0 }) },
    { from: '2026-11-01', to: '2026-11-01', timeZone: 'America/New_York' }), /more minutes/);
  await checkSource({ id: 'good', name: 'Good', days: async () => ({ days: { '2026-11-01': { x: 1500 } }, missing: [], skipped: 0 }) },
    { from: '2026-11-01', to: '2026-11-01', timeZone: 'America/New_York' });
  await assert.rejects(checkSource({ id: 'spring', name: 'Spring', days: async () => ({ days: { '2026-03-08': { x: 1381 } }, missing: [], skipped: 0 }) },
    { from: '2026-03-08', to: '2026-03-08', timeZone: 'America/New_York' }), /more minutes/);
});

test('refuses missing or duplicate matching buckets with types and hostnames only', async () => {
  for (const replacement of [
    { other: { type: 'currentwindow', hostname: 'other-mac' }, idle: { type: 'afkstatus', hostname: 'test-mac' } },
    { one: { type: 'currentwindow', hostname: 'test-mac' }, two: { type: 'currentwindow', hostname: 'test-mac' }, idle: { type: 'afkstatus', hostname: 'test-mac' } },
  ]) {
    await assert.rejects(awDays({ from: '2026-10-01', to: '2026-10-01', timeZone: 'UTC', host: 'test-mac', fetchJson: async path => path === '/api/0/buckets/' ? replacement : [] }),
      error => /exactly one currentwindow bucket/.test(error.message) && /currentwindow on/.test(error.message));
  }
});

test('contract check rejects broken sources and RescueTime wrapper keeps slice 1 output', async () => {
  const broken = { id: 'broken', name: 'Broken', days: async () => ({ days: { '2026-10-01': { x: -1 } }, missing: [], skipped: 0 }) };
  await assert.rejects(checkSource(broken, { from: '2026-10-01', to: '2026-10-01', timeZone: 'UTC' }), /invalid minutes/);
  const headers = ['Date', 'Time Spent (seconds)', 'Productivity', 'Category'];
  const fetchRows = async parameters => parameters.restrict_kind === 'productivity'
    ? [headers, ['2026-10-01', 3600, 2, 'General']]
    : [headers, ['2026-10-01', 3600, 2, 'Software Development']];
  const source = rescueTimeSource({ fetchRows, categoryTags: { 'Software Development': 'coding' } });
  const checked = await checkSource(source, { from: '2026-10-01', to: '2026-10-01', timeZone: 'UTC' });
  assert.deepEqual(checked.days['2026-10-01'], { productive: 60, total: 60, coding: 60 });
  const page = await fromSource(source, { from: '2026-10-01', to: '2026-10-01', timeZone: 'UTC' });
  assert.match(page.html, /productive/);
});

test('events only in the expansion after midnight do not mark the previous day present', async () => {
  const result = await awDays({
    from: '2026-10-01', to: '2026-10-01', timeZone: 'UTC', host: 'test-mac',
    fetchJson: inventedActivity({
      windowEvents: [event('2026-10-02T00:00:02Z', 1, { app: 'Editor' })],
      idleEvents: [event('2026-10-02T00:00:02Z', 1, { status: 'not-afk' })],
    }),
  });
  assert.deepEqual(result.missing, ['2026-10-01']);
  assert.deepEqual(result.days, {});
});

test('contract check requires each requested date exactly once in days or missing', async () => {
  const range = { from: '2026-10-01', to: '2026-10-02', timeZone: 'UTC' };
  const source = result => ({ id: 'example', name: 'Example', days: async () => ({ ...result, skipped: 0 }) });
  await assert.rejects(checkSource(source({ days: { '2026-10-01': {} }, missing: [] }), range),
    /omitted 2026-10-02.*totals or list it as missing/);
  await assert.rejects(checkSource(source({ days: { '2026-10-01': {} }, missing: ['2026-10-01', '2026-10-02'] }), range),
    /totals for missing day 2026-10-01/);
  await assert.rejects(checkSource(source({ days: { '2026-10-01': {} }, missing: ['2026-10-02', '2026-10-02'] }), range),
    /missing day more than once/);
  const complete = { days: { '2026-10-01': {} }, missing: ['2026-10-02'] };
  assert.deepEqual(await checkSource(source(complete), range), { ...complete, skipped: 0 });
});

test('source library has no disk, process, network, fetch, or clock access', async () => {
  const source = await readFile(new URL('../src/sources.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"](?:node:)?(?:fs|child_process|http|https|net|dns)[/'"]/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /Date\.now\s*\(|new\s+Date\s*\(\s*\)/);
});

test('reads 400 days one day at a time and splits capped chunks without changing totals', async () => {
  const calls = [];
  const fetchJson = async path => {
    calls.push(path);
    if (path === '/api/0/buckets/') return buckets;
    const parameters = new URLSearchParams(path.slice(path.indexOf('?') + 1));
    const start = Date.parse(parameters.get('start')) + 5_000;
    const end = Date.parse(parameters.get('end')) - 5_000;
    if (end - start > 12 * 60 * 60 * 1000 && new Date(start).toISOString().startsWith('2025-06-01')) return { truncated: true };
    const timestamp = new Date(start).toISOString();
    return path.includes('window')
      ? [event(timestamp, 60, { app: 'Editor', title: 'PRIVATE-MARKER' })]
      : [event(timestamp, 60, { status: 'not-afk' })];
  };
  const result = await awDays({ from: '2025-01-01', to: '2026-02-04', timeZone: 'UTC', host: 'test-mac', appTags: { Editor: 'coding' }, fetchJson });
  assert.equal(Object.keys(result.days).length, 400);
  assert.equal(result.days['2025-06-01'].coding, 2);
  assert.equal(calls.filter(path => path.includes('/events?')).length, 804);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-MARKER/);
});

test('flooding across a split edge gives the same result as an unsplit span', async () => {
  async function run(split) {
    let capped = split;
    return awDays({
      from: '2026-10-01', to: '2026-10-01', timeZone: 'UTC', host: 'test-mac', appTags: { Editor: 'coding' },
      fetchJson: async path => {
        if (path === '/api/0/buckets/') return buckets;
        const parameters = new URLSearchParams(path.slice(path.indexOf('?') + 1));
        const start = Date.parse(parameters.get('start')) + 5_000;
        const end = Date.parse(parameters.get('end')) - 5_000;
        if (capped && end - start === 24 * 60 * 60 * 1000) { capped = false; return { truncated: true }; }
        const events = path.includes('window')
          ? [event('2026-10-01T11:59:58Z', 0, { app: 'Editor' }), event('2026-10-01T12:00:02Z', 2, { app: 'Editor' })]
          : [event('2026-10-01T11:59:58Z', 4, { status: 'not-afk' }), event('2026-10-01T12:00:02Z', 2, { status: 'not-afk' })];
        return events.filter(item => Date.parse(item.timestamp) >= start - 5_000 && Date.parse(item.timestamp) <= end + 5_000);
      },
    });
  }
  const whole = await run(false);
  const split = await run(true);
  assert.deepEqual(split.days, whole.days);
  assert.equal(split.days['2026-10-01'].coding, 6 / 60);
});
