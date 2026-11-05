import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runImport } from '../src/import.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-dry-'));
  const input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  const argv = ['--in', input, '--atlas', atlas, '--imported-at', '2026-11-05T12:00:00.000Z'];
  return { input, atlas, argv, dir: path.join(atlas, 'sources/recall'), put: (name, text = '# Invented\n') => fs.writeFileSync(path.join(input, name), text) };
}

function dryWithoutWrites(f) {
  const mutations = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'linkSync', 'unlinkSync', 'rmSync', 'openSync'];
  const saved = Object.fromEntries(mutations.map(name => [name, fs[name]]));
  for (const name of mutations) fs[name] = name === 'openSync' ? (file, flags, ...rest) => {
    const readsOnly = typeof flags === 'number' ? !(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : flags === 'r';
    assert.ok(readsOnly, 'Dry run opened a file for writing');
    return saved.openSync(file, flags, ...rest);
  } : () => { throw Error(`Dry run attempted ${name}`); };
  try { return runImport(f.argv); } finally { for (const name of mutations) fs[name] = saved[name]; }
}

function matchesWrite(f, dry) {
  const written = runImport([...f.argv, '--write']);
  assert.ok(Array.isArray(dry.paths), 'Dry run must report planned paths');
  assert.ok(Array.isArray(dry.changes), 'Dry run must report planned changes');
  assert.deepEqual(dry.paths, written.paths);
  assert.deepEqual(dry.changes, written.changes);
  assert.deepEqual(dry.warnings, written.warnings);
  assert.deepEqual(dry.messages, written.messages);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.dir, '.import-manifest.json')));
  for (const { key, path: output } of written.paths) assert.equal(manifest.entries[key]?.path, output);
  return written;
}

test('Deferred P2: dry collision preview matches saved paths warnings and actual changes', () => {
  const f = fixture(); for (const name of ['a b.md', 'gone.md', 'edited.md', 'changed.md']) f.put(name);
  runImport([...f.argv, '--write']);
  f.put('a-b.md'); f.put('changed.md', '# Invented changed\n'); fs.unlinkSync(path.join(f.input, 'gone.md'));
  fs.appendFileSync(path.join(f.dir, 'edited.md'), 'Owner edit\n'); f.put('edited.md', '# Changed source\n');
  const manifest = fs.readFileSync(path.join(f.dir, '.import-manifest.json'), 'utf8');
  const dry = dryWithoutWrites(f);
  assert.equal(fs.readFileSync(path.join(f.dir, '.import-manifest.json'), 'utf8'), manifest);
  assert.equal(dry.warnings.length, 1, 'Only the new colliding card needs a suffix');
  const written = matchesWrite(f, dry);
  assert.equal(dry.paths.find(note => note.key === 'a b.md').path, 'sources/recall/a-b.md');
  for (const action of ['created', 'updated', 'unchanged', 'kept', 'removed']) assert.ok(written.changes.some(change => change.action === action), action);
});

test('Deferred P2: dry preview replays pending journal without changing or locking it', () => {
  const f = fixture(); f.put('a b.md');
  const rename = fs.renameSync; let interrupted = false;
  fs.renameSync = (from, to) => { if (interrupted && to === path.join(f.dir, '.import-manifest.json')) throw Error('Checkpoint unavailable'); return rename(from, to); };
  try { assert.throws(() => runImport([...f.argv, '--write'], { afterRename() { interrupted = true; throw Error('Interrupted'); } }), /Checkpoint unavailable/); }
  finally { fs.renameSync = rename; }
  f.put('a-b.md'); f.put('a b.md', '# Changed after interruption\n');
  const journal = path.join(f.dir, '.import-journal.jsonl');
  const before = fs.readFileSync(journal, 'utf8'), manifest = fs.readFileSync(path.join(f.dir, '.import-manifest.json'), 'utf8');
  const dry = dryWithoutWrites(f);
  assert.equal(fs.readFileSync(journal, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(f.dir, '.import-manifest.json'), 'utf8'), manifest);
  matchesWrite(f, dry);
  assert.equal(fs.existsSync(journal), false);
});

test('Deferred P2: empty dry re-import reports retained removals without changing manifest', () => {
  const f = fixture(); f.put('one.md'); runImport([...f.argv, '--write']); fs.unlinkSync(path.join(f.input, 'one.md'));
  const dry = dryWithoutWrites(f); matchesWrite(f, dry);
  assert.deepEqual(dry.changes, [{ key: 'one.md', path: 'sources/recall/one.md', action: 'removed' }]);
});
