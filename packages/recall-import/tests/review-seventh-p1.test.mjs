import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runImport } from '../src/import.mjs';
import { checkSource, recallSource, toNotes } from '../src/sources.mjs';

const keys = ['__proto__', 'constructor', 'toString'];
const importedAt = '2026-11-05T12:00:00.000Z';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-seventh-'));
  const input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  // Source keys are independent of export paths; use valid invented cards.
  for (const key of keys) fs.writeFileSync(path.join(input, key + '.md'), '# Invented original\n');
  const recall = recallSource();
  const source = { ...recall, id: 'invented', name: 'Invented', read(files) {
    const result = recall.read(files);
    result.items = result.items.map(item => ({ ...item, key: item.key.replace(/\.md$/, '') }));
    return result;
  } };
  const dir = path.join(atlas, 'sources/invented');
  const argv = ['--in', input, '--atlas', atlas, '--source', 'invented', '--write', '--imported-at', importedAt];
  return { input, atlas, dir, source, argv, run: options => runImport(argv, { sources: [source], ...options }), manifest: () => JSON.parse(fs.readFileSync(path.join(dir, '.import-manifest.json'), 'utf8')) };
}

test('Seventh P1: special source keys survive import and changed re-import', () => {
  const f = fixture(); f.run();
  for (const key of keys) {
    assert.ok(Object.hasOwn(f.manifest().entries, key), key);
    fs.writeFileSync(path.join(f.input, key + '.md'), '# Invented changed\n');
  }
  const report = f.run();
  assert.equal(report.messages.some(message => message.includes('kept, edited')), false);
  for (const key of keys) assert.match(fs.readFileSync(path.join(f.atlas, f.manifest().entries[key].path), 'utf8'), /Invented changed/);
  assert.deepEqual(f.manifest().pending, {});
});

test('Seventh P1: special source keys survive pending manifest recovery', () => {
  for (const key of keys) {
    const f = fixture();
    assert.throws(() => f.run({ afterRename({ note }) { if (note.key === key) throw Error('Interrupted'); } }), /Interrupted/);
    assert.ok(Object.hasOwn(f.manifest().pending, key), key);
    fs.writeFileSync(path.join(f.input, key + '.md'), '# Recovered changed\n');
    const report = f.run();
    assert.equal(report.messages.some(message => message.includes('kept, edited')), false);
    assert.ok(Object.hasOwn(f.manifest().entries, key));
    assert.match(fs.readFileSync(path.join(f.atlas, f.manifest().entries[key].path), 'utf8'), /Recovered changed/);
    assert.deepEqual(f.manifest().pending, {});
  }
});

test('Seventh P1: special source keys survive journal JSON replay', () => {
  for (const key of keys) {
    const f = fixture(), rename = fs.renameSync; let blockCheckpoint = false;
    fs.renameSync = (from, to) => { if (blockCheckpoint && to === path.join(f.dir, '.import-manifest.json')) throw Error('Checkpoint unavailable'); return rename(from, to); };
    try { assert.throws(() => f.run({ afterRename({ note }) { if (note.key === key) { blockCheckpoint = true; throw Error('Interrupted'); } } }), /Checkpoint unavailable/); }
    finally { fs.renameSync = rename; }
    const journal = fs.readFileSync(path.join(f.dir, '.import-journal.jsonl'), 'utf8');
    assert.ok(journal.split('\n').filter(Boolean).some(line => JSON.parse(line).key === key));
    fs.writeFileSync(path.join(f.input, key + '.md'), '# Journal recovered\n');
    const report = f.run();
    assert.equal(report.messages.some(message => message.includes('kept, edited')), false);
    assert.ok(Object.hasOwn(f.manifest().entries, key));
    assert.match(fs.readFileSync(path.join(f.atlas, f.manifest().entries[key].path), 'utf8'), /Journal recovered/);
  }
});

test('Seventh P1 sweep: toNotes ignores inherited manifest paths', () => {
  const source = recallSource();
  const items = keys.map(key => ({ key, title: 'Invented', body: '', url: null, tags: [], created: null, sourcePath: key + '.md' }));
  const inherited = Object.fromEntries(keys.map(key => [key, { path: 'sources/recall/inherited-' + key + '.md' }]));
  const { notes } = toNotes(items, { source, importedAt, manifest: Object.create(inherited) });
  assert.ok(notes.every(note => !note.path.includes('inherited-')));
});

test('Seventh P1 sweep: front-matter maps retain special field names as own data', () => {
  const source = recallSource();
  const text = '---\n__proto__: Invented prototype field\nconstructor: Invented constructor field\ntoString: Invented string field\n---\nBody\n';
  const { items } = checkSource(source, [{ path: 'one.md', text }]);
  for (const key of keys) assert.ok(Object.hasOwn(items[0].extra, key), key);
  const note = toNotes(items, { source, importedAt }).notes[0].text;
  assert.match(note, /  __proto__: Invented prototype field/);
  assert.match(note, /  constructor: Invented constructor field/);
  assert.match(note, /  toString: Invented string field/);
});
