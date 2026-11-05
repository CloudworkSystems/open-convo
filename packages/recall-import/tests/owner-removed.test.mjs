import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runImport } from '../src/import.mjs';
const explanation = 'kept as you left it: you removed or moved this note';
test('Owner removal P2: dry and repeated write imports keep a missing owned note missing and reserve its path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-owner-removed-')), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, 'a b.md'), '# Original');
  const args = ['--in', input, '--atlas', atlas, '--imported-at', '2026-11-05T12:00:00Z'];
  runImport([...args, '--write']);
  const dir = path.join(atlas, 'sources/recall'), note = path.join(dir, 'a-b.md'), manifestFile = path.join(dir, '.import-manifest.json');
  const manifest = fs.readFileSync(manifestFile, 'utf8'), entry = JSON.parse(manifest).entries['a b.md']; fs.unlinkSync(note);
  for (const flags of [[], ['--write'], ['--write']]) {
    const report = runImport([...args, ...flags]);
    assert.equal(fs.existsSync(note), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile)).entries['a b.md'], entry);
    assert.ok(report.messages.some(message => message.includes(entry.path) && message.includes(explanation)));
    assert.equal(report.changes.find(change => change.key === 'a b.md').action, 'kept');
    if (!flags.length) { assert.equal(fs.readFileSync(manifestFile, 'utf8'), manifest); assert.deepEqual(fs.readdirSync(dir), ['.import-manifest.json']); }
  }
  fs.writeFileSync(path.join(input, 'a-b.md'), '# Later unrelated');
  const dry = runImport(args), written = runImport([...args, '--write']);
  for (const report of [dry, written]) assert.match(report.paths.find(item => item.key === 'a-b.md').path, /^sources\/recall\/a-b-[a-f0-9]{8}\.md$/);
  assert.equal(fs.existsSync(note), false); assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile)).entries['a b.md'], entry);
});
