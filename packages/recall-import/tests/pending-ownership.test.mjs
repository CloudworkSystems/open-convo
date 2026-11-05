import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runImport } from '../src/import.mjs';
function fixture(stage, storage) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-pending-')), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, 'a b.md'), '# Invented original');
  const args = ['--in', input, '--atlas', atlas, '--imported-at', '2026-11-05T12:00:00Z'];
  let temporary;
  assert.throws(() => runImport([...args, '--write'], { beforeRename: ({ temp }) => { temporary = temp; if (stage === 'before') throw Error('Invented interruption'); }, afterRename: () => { throw Error('Invented interruption'); } }), /Invented interruption/);
  const dir = path.join(atlas, 'sources/recall'), file = path.join(dir, '.import-manifest.json');
  const saved = JSON.parse(fs.readFileSync(file));
  if (storage === 'journal') {
    fs.writeFileSync(path.join(dir, '.import-journal.jsonl'), JSON.stringify({ key: 'a b.md', entry: saved.pending['a b.md'], previous: null }) + '\n');
    saved.pending = {}; fs.writeFileSync(file, JSON.stringify(saved));
  }
  return { input, atlas, args, dir, file, temporary };
}
for (const storage of ['pending manifest', 'journal']) for (const next of ['empty', 'all skipped', 'present']) test(`Pending ownership table: ${storage}, before rename, next export ${next}`, () => {
  const f = fixture('before', storage);
  if (next !== 'present') fs.unlinkSync(path.join(f.input, 'a b.md'));
  if (next === 'all skipped') fs.writeFileSync(path.join(f.input, 'ignored.txt'), 'Invented non-card');
  const before = fs.readFileSync(f.file, 'utf8');
  const dry = runImport(f.args); assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.ok(fs.existsSync(f.temporary));
  assert.ok(!dry.messages.some(message => /kept|no longer/.test(message)));
  const report = runImport([...f.args, '--write']);
  const saved = JSON.parse(fs.readFileSync(f.file)); assert.deepEqual(saved.pending, {});
  assert.equal(fs.existsSync(f.temporary), false); assert.equal(fs.existsSync(path.dirname(f.temporary)), false);
  if (next === 'present') { assert.ok(saved.entries['a b.md']); assert.ok(report.changes.some(change => change.action === 'created')); }
  else {
    assert.deepEqual(saved.entries, {}); assert.ok(!report.messages.some(message => /kept|no longer/.test(message)));
    fs.writeFileSync(path.join(f.input, 'a-b.md'), '# Invented later');
    const later = runImport([...f.args, '--write']); assert.equal(later.paths[0].path, 'sources/recall/a-b.md');
  }
});
for (const storage of ['pending manifest', 'journal']) test(`Pending ownership table: ${storage}, rename done retains verified ownership`, () => {
  const f = fixture('after', storage); fs.writeFileSync(path.join(f.input, 'a b.md'), '# Invented updated');
  const report = runImport([...f.args, '--write']); assert.ok(report.changes.some(change => change.action === 'updated')); assert.ok(!report.messages.some(message => message.includes('edited since')));
  assert.match(fs.readFileSync(path.join(f.dir, 'a-b.md'), 'utf8'), /Invented updated/);
});
for (const storage of ['pending manifest', 'journal']) test(`Pending ownership table: ${storage}, mismatched disk bytes stay unowned`, () => {
  const f = fixture('after', storage); const note = path.join(f.dir, 'a-b.md'); fs.appendFileSync(note, '\nInvented owner edit'); fs.unlinkSync(path.join(f.input, 'a b.md'));
  const before = fs.readFileSync(note); const report = runImport([...f.args, '--write']);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).entries, {}); assert.deepEqual(fs.readFileSync(note), before); assert.ok(report.messages.some(message => message.includes('edited since')));
});
