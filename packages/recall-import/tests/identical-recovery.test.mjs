import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runImport } from '../src/import.mjs';
function fixture(count, stop) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-identical-')), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(input, `${i}.md`), '# Identical invented card\nSame body\n');
  const args = ['--in', input, '--atlas', atlas, '--imported-at', '2026-11-05T12:00:00Z'];
  const rename = fs.renameSync; let interrupted = false, temporary;
  fs.renameSync = (from, to) => { if (interrupted && String(to).endsWith('.import-manifest.json')) throw Error('Invented abrupt checkpoint failure'); return rename(from, to); };
  try { assert.throws(() => runImport([...args, '--write'], { beforeRename: ({ note, temp }) => { if (note.key === `${stop}.md`) { interrupted = true; temporary = temp; throw Error('Invented interruption'); } } }), /Invented/); }
  finally { fs.renameSync = rename; }
  return { args, atlas, dir: path.join(atlas, 'sources/recall'), temporary, count };
}
function snapshot(folder) { const saved = {}; function walk(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); saved[file] = item.isDirectory() ? 'directory' : fs.readFileSync(file).toString('base64'); if (item.isDirectory()) walk(file); } } walk(folder); return saved; }
function verify(f) {
  const report = runImport([...f.args, '--write']); assert.equal(report.notes, f.count); assert.equal(fs.existsSync(f.temporary), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.dir, '.import-manifest.json'))); assert.deepEqual(manifest.pending, {}); assert.equal(Object.keys(manifest.entries).length, f.count);
  const notes = Object.values(manifest.entries).map(entry => fs.readFileSync(path.join(f.atlas, entry.path), 'utf8')); assert.equal(new Set(notes).size, 1); assert.match(notes[0], /Same body/);
}
test('Identical recovery: two identical cards retry between renames completes both notes', () => verify(fixture(2, 1)));
test('Identical recovery: dry run writes nothing and subsequent recovery completes', () => {
  const f = fixture(2, 1), before = snapshot(f.atlas); assert.equal(runImport(f.args).notes, 2); assert.deepEqual(snapshot(f.atlas), before); verify(f);
});
for (const stop of [0, 1, 2]) test(`Identical recovery: three cards interrupted before rename ${stop + 1}`, () => verify(fixture(3, stop)));
test('Identical cleanup: a temporary file disappearing during cleanup is harmless', () => {
  const f = fixture(2, 1), unlink = fs.unlinkSync;
  fs.unlinkSync = file => { if (file === f.temporary && fs.existsSync(file)) { unlink(file); const error = Error('Already removed'); error.code = 'ENOENT'; throw error; } return unlink(file); };
  try { verify(f); } finally { fs.unlinkSync = unlink; }
});
test('Identical cleanup: anonymous matching-content leftovers are never claimed by hash', () => {
  const f = fixture(2, 1), unrelated = fs.mkdtempSync(path.join(f.dir, '.import-note-tmp-anonymous-')), file = path.join(unrelated, 'data');
  const bytes = fs.readFileSync(f.temporary); fs.writeFileSync(file, bytes); verify(f); assert.deepEqual(fs.readFileSync(file), bytes);
});
test('Identical cleanup: errors other than ENOENT still refuse recovery', () => {
  const f = fixture(2, 1), unlink = fs.unlinkSync;
  fs.unlinkSync = file => { if (file === f.temporary) { const error = Error('Invented permission failure'); error.code = 'EACCES'; throw error; } return unlink(file); };
  try { assert.throws(() => runImport([...f.args, '--write']), /Invented permission failure/); assert.ok(fs.existsSync(f.temporary)); }
  finally { fs.unlinkSync = unlink; }
});
