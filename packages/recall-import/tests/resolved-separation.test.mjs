import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runImport } from '../src/import.mjs';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-separated-')), input = path.join(root, 'input'), atlas = path.join(root, 'output/atlas');
  fs.mkdirSync(input); fs.writeFileSync(path.join(input, 'one.md'), '# Invented');
  return { root, input, atlas, args: ['--in', input, '--atlas', atlas, '--write', '--imported-at', '2026-11-05T12:00:00Z'] };
}
test('Resolved separation P2: Atlas parent symlink into export refuses unchanged', () => {
  const f = fixture(); fs.symlinkSync(f.input, path.join(f.root, 'output'));
  assert.throws(() => runImport(f.args), /--atlas.*separate.*--in/);
  assert.deepEqual(fs.readdirSync(f.input), ['one.md']);
});
test('Resolved separation P2: export symlink to Atlas parent refuses before reading', () => {
  const f = fixture(); fs.mkdirSync(path.join(f.root, 'output')); fs.symlinkSync(path.join(f.root, 'output'), path.join(f.root, 'alias'));
  const args = [...f.args]; args[1] = path.join(f.root, 'alias');
  assert.throws(() => runImport(args), /--atlas.*separate.*--in/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'output')), []);
});
test('Resolved separation P2: parent swapped during source read is caught before first write', () => {
  const f = fixture(); fs.mkdirSync(path.join(f.root, 'output'));
  const source = { id: 'invented', name: 'Invented', read(files) {
    const parent = path.join(f.root, 'output');
    if (!fs.lstatSync(parent).isSymbolicLink()) { fs.rmdirSync(parent); fs.symlinkSync(f.input, parent); }
    return { items: [{ key: 'one.md', sourcePath: 'one.md', title: 'One', body: files[0].text, url: null, created: null, tags: [] }], skipped: [], warnings: [] };
  } };
  assert.throws(() => runImport([...f.args, '--source', 'invented'], { sources: [source] }), /--atlas.*separate.*--in/);
  assert.deepEqual(fs.readdirSync(f.input), ['one.md']);
});
test('Resolved separation P2: separate real folders still import', () => {
  const f = fixture(); fs.mkdirSync(path.join(f.root, 'output')); const report = runImport(f.args); assert.equal(report.notes, 1); assert.deepEqual(fs.readdirSync(f.input), ['one.md']);
});
