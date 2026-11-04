import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderBoard } from '../src/index.mjs';
import { mapleBoard } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = join(here, '..', 'samples', 'maple.json');
const expectedPath = join(here, 'expected', 'sample.html');

const HIDDEN = [
  'Tooth cleaning',
  'Room 4',
  'Quiet rehearsal',
  'Side room',
  'Order oat milk',
  'Buy glue',
  'Stretch',
];

describe('sample family', () => {
  it('renders the sample board to the expected page, byte for byte', () => {
    const fromHelper = renderBoard(mapleBoard());
    const fromFile = renderBoard(JSON.parse(readFileSync(samplePath, 'utf8')));
    const expected = readFileSync(expectedPath, 'utf8');
    assert.equal(fromHelper.html, expected);
    assert.equal(fromFile.html, expected);
    assert.deepEqual(fromFile.counts, fromHelper.counts);
    assert.deepEqual(fromFile.warnings, fromHelper.warnings);
  });

  it('has no network address, script, image or imported style', () => {
    const html = readFileSync(expectedPath, 'utf8');
    assert.equal(html.includes('http'), false);
    assert.equal(html.includes('src='), false);
    assert.equal(html.includes('<script'), false);
    assert.equal(html.includes('url('), false);
    assert.equal(html.includes('@import'), false);
    assert.equal(html.includes('http-equiv'), false);
  });

  it('shows the shared day and keeps private titles off the page', () => {
    const { html, warnings, counts } = renderBoard(mapleBoard());
    assert.match(html, /Tuesday, November 3/);
    assert.match(html, /Updated 7:25 AM/);
    assert.match(html, /Town fair/);
    assert.match(html, /River park/);
    assert.match(html, /Design review/);
    assert.match(html, /Studio/);
    assert.match(html, /Overlaps/);
    assert.match(html, /Library visit/);
    assert.match(html, /Reading room/);
    assert.match(html, /Pay the studio rent/);
    assert.match(html, /Read a chapter/);
    assert.match(html, />Busy</);
    assert.match(html, /1 more task/);
    assert.match(html, /1 more habit/);
    assert.match(html, /and 4 more/);
    for (const secret of HIDDEN) assert.equal(html.includes(secret), false, secret);
    assert.deepEqual(warnings, [
      'private, item 2: no event today has the key "next-week|2026-11-10T15:00:00Z".',
    ]);
    assert.equal(counts.people[0].busyShown, 2);
    assert.equal(counts.people[0].tasksHidden, 1);
    assert.equal(counts.people[1].tasksShown, 0);
  });
});
