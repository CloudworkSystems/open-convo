import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runImport } from '../src/import.mjs';
import { checkSource, sources } from '../src/sources.mjs';

const empty = () => ({ items: [], skipped: [], warnings: [] });
function runEmpty(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-guidance-'));
  const input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  if (source) sources.push(source);
  try {
    const report = runImport(['--in', input, '--atlas', atlas, '--source', source?.id || 'recall', '--write', '--imported-at', '2026-11-05T12:00:00.000Z']);
    assert.equal(fs.existsSync(atlas), false);
    return report;
  } finally { if (source) sources.pop(); }
}

test('Empty guidance P2: registered second source supplies its own guidance', () => {
  const emptyGuidance = 'No invented bookmarks found. Export bookmarks as Markdown and select that folder.';
  const report = runEmpty({ id: 'invented', name: 'Invented Bookmarks', read: empty, emptyGuidance });
  assert.deepEqual(report.messages, [emptyGuidance]);
  assert.doesNotMatch(JSON.stringify(report), /recall/i);
});

test('Empty guidance P2: a source without guidance gets neutral next steps', () => {
  const report = runEmpty({ id: 'invented', name: 'Invented Bookmarks', read: empty });
  assert.deepEqual(report.messages, ['This folder has no items for the selected source. Check that --in points to a readable folder in the format this source supports, then try again.']);
  assert.doesNotMatch(JSON.stringify(report), /recall/i);
});

test('Empty guidance P2: Recall keeps its existing export instructions', () => {
  assert.deepEqual(runEmpty().messages, ["This folder has no Recall cards. In Recall's web app, open Settings, choose Export, unzip the download, then run this again on that folder."]);
});

test('Empty guidance P2: checkSource rejects invalid optional guidance', () => {
  const source = { id: 'invented', name: 'Invented', read: empty };
  for (const emptyGuidance of [null, 42, {}, [], '', '   ']) assert.throws(() => checkSource({ ...source, emptyGuidance }, []), /emptyGuidance/);
  assert.doesNotThrow(() => checkSource(source, []));
  assert.doesNotThrow(() => checkSource({ ...source, emptyGuidance: 'Select an invented export folder.' }, []));
});
