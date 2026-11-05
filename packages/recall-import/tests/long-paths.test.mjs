import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runImport } from '../src/import.mjs';
import { recallSource, toNotes } from '../src/sources.mjs';

const importedAt = '2026-11-05T12:00:00.000Z';
const item = key => ({ key, title: 'Invented', body: 'Invented body\n', url: null, tags: [], created: null, sourcePath: key });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-long-'));
  const input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  return { root, input, atlas, dir: path.join(atlas, 'sources/recall'), argv: ['--in', input, '--atlas', atlas, '--write', '--imported-at', importedAt] };
}
const shortComponents = file => { for (const component of file.split(path.sep)) assert.ok(Buffer.byteLength(component) <= 255, `Overlong component: ${Buffer.byteLength(component)} bytes`); };

test('Filename P1: a 255-byte filename writes and re-imports with short temporary paths', () => {
  const f = fixture(), name = 'a'.repeat(252) + '.md'; fs.writeFileSync(path.join(f.input, name), '# Invented\n');
  const write = fs.writeFileSync, append = fs.appendFileSync, mkdir = fs.mkdirSync, link = fs.linkSync, rename = fs.renameSync;
  const seen = [];
  const check = file => { if (typeof file === 'string') { shortComponents(file); seen.push(file); } };
  fs.writeFileSync = (file, ...args) => { check(file); return write(file, ...args); };
  fs.appendFileSync = (file, ...args) => { check(file); return append(file, ...args); };
  fs.mkdirSync = (file, ...args) => { check(file); return mkdir(file, ...args); };
  fs.linkSync = (from, to, ...args) => { check(from); check(to); return link(from, to, ...args); };
  fs.renameSync = (from, to, ...args) => { check(from); check(to); return rename(from, to, ...args); };
  try { runImport(f.argv); fs.writeFileSync(path.join(f.input, name), '# Changed invented\n'); runImport(f.argv); }
  finally { fs.writeFileSync = write; fs.appendFileSync = append; fs.mkdirSync = mkdir; fs.linkSync = link; fs.renameSync = rename; }
  assert.match(fs.readFileSync(path.join(f.dir, name), 'utf8'), /Changed invented/);
  assert.ok(seen.some(file => file.includes('.import-journal')));
  assert.equal(fs.readdirSync(f.dir).some(name => name.includes('-tmp-')), false);
});

test('Filename sweep: long collision suffixes and shared prefixes get distinct stable paths', () => {
  const source = recallSource();
  const keys = ['a'.repeat(251) + ' .md', 'a'.repeat(251) + '-.md', 'prefix/' + 'b'.repeat(300) + 'x.md', 'prefix/' + 'b'.repeat(300) + 'y.md', 'd'.repeat(300) + '/INDEX.md'];
  const first = toNotes(keys.map(item), { source, importedAt });
  for (const note of first.notes) shortComponents(note.path);
  assert.equal(new Set(first.notes.map(note => note.path.toLowerCase())).size, keys.length);
  const again = toNotes(keys.map(item), { source, importedAt });
  assert.deepEqual(first.notes.map(n => n.path), again.notes.map(n => n.path));
  const manifest = Object.fromEntries(first.notes.map(note => [note.key, { path: note.path }]));
  assert.deepEqual(toNotes(keys.map(item), { source, importedAt, manifest }).notes.map(n => n.path), first.notes.map(n => n.path));
});

test('Filename sweep: valid 255-byte UTF-8 manifest names keep their exact path', () => {
  const f = fixture(), name = 'é'.repeat(126) + '.md'; assert.equal(Buffer.byteLength(name), 255);
  fs.writeFileSync(path.join(f.input, 'one.md'), '# Updated invented\n'); fs.mkdirSync(f.dir, { recursive: true });
  const text = 'Existing invented note\n', key = 'one.md', notePath = 'sources/recall/' + name;
  fs.writeFileSync(path.join(f.dir, name), text);
  const entry = { path: notePath, fullHash: createHash('sha256').update(text).digest('hex'), sourceHash: '0'.repeat(64) };
  fs.writeFileSync(path.join(f.dir, '.import-manifest.json'), JSON.stringify({ version: 1, entries: { [key]: entry }, pending: {} }));
  const report = runImport(f.argv, { beforeRename({ temp }) { shortComponents(temp); } });
  assert.equal(report.paths[0].path, notePath); assert.match(fs.readFileSync(path.join(f.dir, name), 'utf8'), /Updated invented/);
  assert.equal(Buffer.from(name).toString('utf8'), name);
});

test('Filename sweep: multibyte export names and extended collision hashes stay within 255 bytes', () => {
  const f = fixture(); const name = '界'.repeat(84) + '.md'; assert.equal(Buffer.byteLength(name), 255);
  fs.writeFileSync(path.join(f.input, name), '# Invented Unicode\n'); const report = runImport(f.argv);
  for (const note of report.paths) { shortComponents(note.path); assert.ok(!note.path.includes('\ufffd')); }
  const source = recallSource();
  const keys = ['a'.repeat(250) + ' x.md', 'a'.repeat(250) + '-x.md', 'a'.repeat(250) + '?x.md'];
  const notes = toNotes(keys.map(item), { source, importedAt, hashKey: () => 'f'.repeat(64) }).notes;
  for (const note of notes) shortComponents(note.path);
  assert.equal(new Set(notes.map(n => n.path)).size, 3);
});

test('Filename sweep: shared-prefix 255-byte cards and reserved names write stable files', () => {
  const f = fixture();
  const keys = ['a'.repeat(251) + ' .md', 'a'.repeat(251) + '-.md', 'd'.repeat(255) + '/InDeX.md'];
  for (const key of keys) { fs.mkdirSync(path.dirname(path.join(f.input, key)), { recursive: true }); fs.writeFileSync(path.join(f.input, key), '# Invented long name\n'); }
  const first = runImport(f.argv);
  assert.equal(new Set(first.paths.map(note => note.path.toLowerCase())).size, keys.length);
  for (const note of first.paths) { shortComponents(note.path); assert.ok(fs.existsSync(path.join(f.atlas, note.path))); }
  const second = runImport(f.argv);
  assert.deepEqual(second.paths, first.paths);
  assert.ok(second.changes.every(change => change.action === 'unchanged'));
});
