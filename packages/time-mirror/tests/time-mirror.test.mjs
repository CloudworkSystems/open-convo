import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildTimeMirror, requestParameters } from '../src/index.mjs';

const HEADERS = ['Date', 'Time Spent (seconds)', 'Number of People', 'Productivity', 'Activity', 'Category'];
const productivityRows = [
  HEADERS,
  ['2026-10-01', 3600, 1, 2, 'Very Productive', 'General'],
  ['2026-10-01', 1800, 1, -1, 'Distracting', 'General'],
  ['2026-10-02', 900, 1, 0, 'Neutral', 'General'],
  ['2026-10-04', 0, 1, 1, 'Productive', 'General'],
];
const categoryRows = [
  HEADERS,
  ['2026-10-01', 3000, 1, 2, 'Editor', 'Software Development'],
  ['2026-10-02', 900, 1, 0, 'Reference', 'Unmapped Private Category'],
  ['2026-10-04', 0, 1, 1, 'Editor', 'Software Development'],
];

function inventedFetch(calls, replacements = {}) {
  return async parameters => {
    calls.push(parameters);
    return replacements[parameters.restrict_kind] ?? (parameters.restrict_kind === 'productivity' ? productivityRows : categoryRows);
  };
}

function isoDay(offset) {
  return new Date(Date.UTC(2025, 0, 1 + offset)).toISOString().slice(0, 10);
}

test('builds only the two allowed daily requests and never asks for site or app detail', async () => {
  const calls = [];
  await buildTimeMirror({ start: '2026-10-01', end: '2026-10-04', fetchRows: inventedFetch(calls) });
  assert.deepEqual(calls, ['productivity', 'category'].map(kind => ({
    perspective: 'interval', resolution_time: 'day', format: 'json',
    restrict_begin: '2026-10-01', restrict_end: '2026-10-04', restrict_kind: kind,
  })));
  assert.equal(JSON.stringify(calls).match(/site|app|activity/g), null);
  assert.throws(() => requestParameters({ start: '2026-10-01', end: '2026-10-04', kind: 'activity' }), /productivity or category/);
});

test('turns invented rows into targetless count trackers through HabitGrid and renders SVG', async () => {
  const result = await buildTimeMirror({
    start: '2026-10-01', end: '2026-10-04', fetchRows: inventedFetch([]),
    categoryTags: { 'Software Development': 'coding' },
  });
  assert.deepEqual(result.trackers.map(item => item.tag), ['productive', 'neutral', 'distracting', 'total', 'coding']);
  for (const { grid, svg } of result.trackers) {
    assert.equal(grid.kind, 'count');
    assert.equal(grid.target, null);
    assert.equal(grid.unit, 'minutes');
    assert.match(svg, /^<svg/);
  }
  const values = tag => result.trackers.find(item => item.tag === tag).grid.squares
    .filter(day => day.inRange).map(day => [day.date, day.value]);
  assert.deepEqual(values('productive'), [['2026-10-01', 60], ['2026-10-02', 0], ['2026-10-03', 0], ['2026-10-04', 0]]);
  assert.deepEqual(values('distracting')[0], ['2026-10-01', 30]);
  assert.deepEqual(values('total')[0], ['2026-10-01', 90]);
  assert.deepEqual(values('coding')[0], ['2026-10-01', 50]);
  assert.deepEqual(result.missingDays, ['2026-10-03']);
});

test('accepts RescueTime row_headers and rows with midnight timestamps', async () => {
  const envelope = rows => ({
    row_headers: rows[0],
    rows: rows.slice(1).map(row => [`${row[0]}T00:00:00`, ...row.slice(1)]),
  });
  const result = await buildTimeMirror({
    start: '2026-10-01',
    end: '2026-10-04',
    fetchRows: inventedFetch([], {
      productivity: envelope(productivityRows),
      category: envelope(categoryRows),
    }),
    categoryTags: { 'Software Development': 'coding' },
  });
  const productive = result.trackers.find(item => item.tag === 'productive');
  assert.equal(productive.grid.squares.find(day => day.date === '2026-10-01').value, 60);
  assert.deepEqual(result.missingDays, ['2026-10-03']);
});

test('rejects owner tag names reserved for built-in summaries', async () => {
  for (const tag of ['productive', 'neutral', 'distracting', 'total']) {
    await assert.rejects(
      buildTimeMirror({
        start: '2026-10-01', end: '2026-10-04', fetchRows: inventedFetch([]),
        categoryTags: { 'Software Development': tag },
      }),
      /reserved built-in summary name/,
    );
  }
});

test('keeps gaps separate from zero and leaves unmapped category names out of output', async () => {
  const result = await buildTimeMirror({ start: '2026-10-01', end: '2026-10-04', fetchRows: inventedFetch([]) });
  assert.match(result.html, /Days with no data: 2026-10-03/);
  assert.doesNotMatch(result.html, /Unmapped Private Category|Software Development|Editor|Reference/);
  assert.equal(result.trackers.some(item => item.grid.squares.some(day => day.date === '2026-10-04' && day.value > 0)), false);
});

test('rejects malformed rows and surfaces injected fetch failures without their details', async () => {
  await assert.rejects(
    buildTimeMirror({ start: '2026-10-01', end: '2026-10-04', fetchRows: inventedFetch([], { productivity: [HEADERS, ['bad-date', 30, 1, 2, 'x', 'x']] }) }),
    /malformed productivity rows/,
  );
  await assert.rejects(
    buildTimeMirror({ start: '2026-10-01', end: '2026-10-04', fetchRows: async () => { throw new Error('private response detail'); } }),
    error => error.message === 'Could not fetch productivity rows.' && !error.message.includes('private response detail'),
  );
});

test('page is self-contained and contains no URL or outside resource', async () => {
  const result = await buildTimeMirror({ start: '2026-10-01', end: '2026-10-04', fetchRows: inventedFetch([]) });
  assert.doesNotMatch(result.html, /(?:src|href)=|<script|@import|url\s*\(/i);
  const withoutSvgNamespace = result.html.replaceAll('http://www.w3.org/2000/svg', '');
  assert.doesNotMatch(withoutSvgNamespace, /https?:/i);
  assert.equal((result.html.match(/http:\/\/www\.w3\.org\/2000\/svg/g) ?? []).length, result.trackers.length);
  assert.doesNotMatch(result.html, /Very Productive|Distracting|General/);
  assert.match(result.html, /productive/);
  assert.match(result.html, /2026-10-01 to 2026-10-04/);
});

test('builds a 365-day page with mapped tags in under two seconds', async t => {
  const productivity = [HEADERS];
  const categories = [HEADERS];
  for (let day = 0; day < 365; day += 1) {
    const date = isoDay(day);
    productivity.push([date, 3600, 1, day % 5 - 2, 'Summary', 'General']);
    categories.push([date, 1200, 1, 0, 'First', 'Category One']);
    categories.push([date, 900, 1, 0, 'Second', 'Category Two']);
    categories.push([date, 600, 1, 0, 'Third', 'Category Three']);
  }
  const started = performance.now();
  const result = await buildTimeMirror({
    start: isoDay(0),
    end: isoDay(364),
    fetchRows: inventedFetch([], { productivity, category: categories }),
    categoryTags: { 'Category One': 'coding', 'Category Two': 'reading', 'Category Three': 'planning' },
  });
  const elapsed = performance.now() - started;
  t.diagnostic(`365-day build: ${elapsed.toFixed(1)} ms`);
  assert.equal(result.trackers.length, 7);
  assert.ok(elapsed < 2000, `365-day build took ${elapsed.toFixed(1)} ms`);
});

test('library source has no forbidden import, fetch call, or clock read', async () => {
  const source = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"](?:node:)?(?:fs|child_process|http|https|net|dns)[/'"]/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /Date\.now\s*\(|new\s+Date\s*\(\s*\)/);
});
