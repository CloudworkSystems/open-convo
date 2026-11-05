import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../bin/creator-proof.mjs';
import { capture, tempDir } from './helpers.mjs';

const samples = fileURLToPath(new URL('../samples/river-lane/', import.meta.url));

test('the invented River Lane sample records, reports and writes a page', async () => {
  const { dir, remove } = tempDir();
  try {
    const ledger = join(dir, 'ledger.json');
    const pack = join(dir, 'pack.md');
    const page = join(dir, 'page.html');
    const theCase = JSON.parse(readFileSync(join(samples, 'case.json'), 'utf8'));
    const io = capture();
    const meadow = await main([
      'record', join(samples, 'meadow-morning.mov'),
      '--title', 'Meadow morning',
      '--ledger', ledger,
    ], { ...io, clock: () => '2026-01-15T00:00:00.000Z' });
    assert.equal(meadow, 0, io.errors());
    const entries = JSON.parse(readFileSync(ledger, 'utf8'));
    assert.equal(entries[0].originalId, theCase.originalIds[0]);
    const second = capture();
    const lantern = await main([
      'record', join(samples, 'lantern-talk.mov'),
      '--title', 'Lantern talk',
      '--ledger', ledger,
    ], { ...second, clock: () => '2026-02-15T00:00:00.000Z' });
    assert.equal(lantern, 0, second.errors());
    const both = JSON.parse(readFileSync(ledger, 'utf8'));
    assert.deepEqual(both.map((entry) => entry.originalId), theCase.originalIds);
    const reported = capture();
    const code = await main([
      'report', '--case', join(samples, 'case.json'), '--out', pack, '--ledger', ledger,
    ], reported);
    assert.equal(code, 0, reported.errors());
    assert.match(readFileSync(pack, 'utf8'), /Northwind Pay/);
    const linked = capture();
    const pageCode = await main([
      'links', '--links', join(samples, 'links.json'), '--out', page, '--ledger', ledger,
    ], linked);
    assert.equal(pageCode, 0, linked.errors());
    const html = readFileSync(page, 'utf8');
    assert.match(html, /These are the only real donation links for River Lane/);
    assert.match(html, /https:\/\/give\.example\/river-lane/);
  } finally {
    remove();
  }
});
